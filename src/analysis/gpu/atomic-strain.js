import { STRAIN_FIELDS } from '../atomic-strain.js';
import { validateReferences } from '../lattice.js';
import { atomRange } from '../neighbors.js';
import { GpuUnavailableError, checkSignal, readGpuBuffers, yieldWorker } from './runtime.js';
import { ATOMIC_STRAIN_SHADER } from './atomic-strain-shaders.js';

export const PTM_SCALE_INVALID = 1;
export const PTM_DEFORMATION_INVALID = 2;
export const PTM_SCALE_ENCODING_UNSUPPORTED = 4;
export const PTM_DEFORMATION_ENCODING_UNSUPPORTED = 8;
export const PTM_ENCODING_UNSUPPORTED = 12;
const F32_MIN_NORMAL = 2 ** -126;

/** The GPU selects the element reference, validates each PTM phase, restores
 * its absolute lattice scale and evaluates E=(FᵀF-I)/2. PTM topology/fitting
 * and source-array encoding remain separate stages.
 */
export async function analyzeGpuAtomicStrain(runtime, frame, parameters = {}, { signal, onProgress = () => {} } = {}) {
  const atomCount = frame.fractional.length / 3;
  const { startAtom, endAtom } = atomRange(atomCount, parameters);
  const count = endAtom - startAtom;
  checkSignal(signal);
  validateGpuPtmInput(frame, parameters);
  onProgress({ backend: 'gpu', stage: 'strain-reference', phase: 'preparing', completedAtoms: 0, totalAtoms: count });
  const referenceTable = prepareGpuReferenceTable(frame, parameters.references);
  await runtime.initialize(signal);
  const buffers = [];
  const own = buffer => { buffers.push(buffer); return buffer; };
  const releasePins = runtime.pinFrames?.([frame]);
  try {
    let ptm;
    if (runtime.preparePtmBuffers) {
      ptm = await runtime.preparePtmBuffers(frame, parameters.ptmInput, prepareGpuPtmInput, { signal });
    } else {
      const inputs = await prepareGpuPtmInput(frame, parameters.ptmInput, { signal });
      ptm = { typesBuffer: own(runtime.storageBuffer(inputs.types)), metadataBuffer: own(runtime.storageBuffer(inputs.metadata)),
        scalesBuffer: own(runtime.storageBuffer(inputs.scales)), deformationBuffer: own(runtime.storageBuffer(inputs.deformation)), reused: false };
    }
    checkSignal(signal);
    const config = own(runtime.storageBuffer(new Uint32Array([count, startAtom, 0x7fc00000, referenceTable.length / 8])));
    const references = own(runtime.storageBuffer(referenceTable));
    const output = own(runtime.createBuffer(count * STRAIN_FIELDS.length * Float32Array.BYTES_PER_ELEMENT));
    const diagnostics = own(runtime.createBuffer(8));
    onProgress({ backend: 'gpu', stage: 'strain-reference', phase: 'analyzing', completedAtoms: 0, totalAtoms: count });
    await runtime.run(ATOMIC_STRAIN_SHADER,
      [config, ptm.typesBuffer, ptm.metadataBuffer, ptm.scalesBuffer, ptm.deformationBuffer, references, output, diagnostics],
      count, { signal, batchSize: 0, wait: false });
    const [values, status] = await readGpuBuffers(runtime, [{ buffer: output, Type: Float32Array, length: count * STRAIN_FIELDS.length },
      { buffer: diagnostics, Type: Uint32Array, length: 2 }], { signal });
    checkSignal(signal);
    if (status[1]) throw new GpuUnavailableError('The ideal lattice reference or PTM tensor exceeds the GPU floating-point precision range.');
    onProgress({ backend: 'gpu', stage: 'strain-reference', phase: 'complete', completedAtoms: count, totalAtoms: count });
    return { ...Object.fromEntries(STRAIN_FIELDS.map((field, index) => [field, values.subarray(index * count, (index + 1) * count)])),
      startAtom, endAtom, incomplete: status[0], warning: null, referenceBackend: 'gpu', tensorBackend: 'gpu', gpuPtmInputReused: Boolean(ptm.reused) };
  } finally { runtime.disposeBuffers(buffers); releasePins?.(); }
}

/** Validate scientific configuration before fitting/uploading any PTM data. */
function validateGpuPtmInput(frame, { references, ptmInput }) {
  const count = frame.fractional.length / 3;
  if (!ArrayBuffer.isView(frame.types) || frame.types instanceof DataView || frame.types.length !== count) {
    throw new Error('Strain requires one element type per atom.');
  }
  validateReferences(references, frame.types);
  validatePtmArrays(ptmInput, count);
}

function validatePtmArrays(ptmInput, count) {
  if (!ptmInput || !(ptmInput.structures instanceof Uint8Array) || ptmInput.structures.length !== count
    || !(ptmInput.scales instanceof Float64Array) || ptmInput.scales.length !== count
    || !(ptmInput.deformation instanceof Float64Array) || ptmInput.deformation.length !== count * 9) {
    throw new Error('GPU atomic strain requires complete cached PTM correspondences, scales, and deformation.');
  }
}

/** Pack immutable PTM sources only. Phase matching, reference selection, scale
 * factors and absolute F are deliberately absent from this CPU upload step.
 * Encoding flags let the shader distinguish undefined fits from valid inputs
 * which require a CPU numeric-range fallback; original arrays stay intact.
 */
export async function prepareGpuPtmInput(frame, ptmInput, { signal } = {}) {
  const count = frame.fractional.length / 3;
  validatePtmArrays(ptmInput, count);
  if (!ArrayBuffer.isView(frame.types) || frame.types instanceof DataView || frame.types.length !== count) {
    throw new Error('Strain requires one element type per atom.');
  }
  checkSignal(signal);
  const types = new Uint32Array(count), metadata = new Uint32Array(count * 2);
  const scales = new Float32Array(count * 2), deformation = new Float32Array(count * 18);
  for (let atom = 0; atom < count; atom += 1) {
    if (atom && atom % 16_384 === 0) { await yieldWorker(); checkSignal(signal); }
    const element = frame.types[atom];
    if (!Number.isInteger(element) || element < 0 || element > 0xffff_ffff) {
      throw new GpuUnavailableError('The strain element types cannot be represented exactly on this GPU backend.');
    }
    types[atom] = element;
    metadata[atom * 2] = ptmInput.structures[atom];
    let flags = encodeDouble(ptmInput.scales[atom], scales, atom * 2, PTM_SCALE_INVALID, PTM_SCALE_ENCODING_UNSUPPORTED);
    for (let component = 0; component < 9; component += 1) {
      flags |= encodeDouble(ptmInput.deformation[atom * 9 + component], deformation, (atom * 9 + component) * 2, PTM_DEFORMATION_INVALID, PTM_DEFORMATION_ENCODING_UNSUPPORTED);
    }
    metadata[atom * 2 + 1] = flags;
  }
  checkSignal(signal);
  return { types, metadata, scales, deformation, bytes: types.byteLength + metadata.byteLength + scales.byteLength + deformation.byteLength };
}

/** Backward-compatible preparation entry point, now raw uploads plus a small
 * per-element table rather than CPU-computed per-atom factors/validity masks.
 */
export async function prepareGpuStrainInput(frame, parameters = {}, options = {}) {
  validateGpuPtmInput(frame, parameters);
  return { ...await prepareGpuPtmInput(frame, parameters.ptmInput, options), referenceTable: prepareGpuReferenceTable(frame, parameters.references) };
}

/** Eight u32 words per entry: element, phase, encoding flags, padding, a high/
 * low and c high/low. Sorted element IDs permit GPU binary reference lookup.
 */
export function prepareGpuReferenceTable(frame, references) {
  const elements = [...new Set(frame.types)].sort((a, b) => a - b);
  const table = new Uint32Array(elements.length * 8), floats = new Float32Array(table.buffer);
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index], reference = references[element], offset = index * 8;
    if (!Number.isInteger(element) || element < 0 || element > 0xffff_ffff) {
      throw new GpuUnavailableError('The strain element types cannot be represented exactly on this GPU backend.');
    }
    table[offset] = element; table[offset + 1] = reference.structure;
    table[offset + 2] = encodeDouble(reference.a, floats, offset + 4, PTM_SCALE_INVALID);
    const hexagonal = reference.structure === 2 || reference.structure === 7;
    table[offset + 2] |= encodeDouble(hexagonal ? reference.c : 1, floats, offset + 6, PTM_SCALE_INVALID);
  }
  return table;
}

function encodeDouble(value, destination, offset, invalidFlag, unsupportedFlag = PTM_SCALE_ENCODING_UNSUPPORTED) {
  if (!Number.isFinite(value)) return invalidFlag;
  const high = Math.fround(value), low = Math.fround(value - high);
  // Portable WGSL may flush f32 subnormals. Mark them unsupported instead of
  // turning a finite CPU environment into an artificial zero/undefined fit.
  if (!Number.isFinite(high) || !Number.isFinite(low) || (value !== 0 && Math.abs(high) < F32_MIN_NORMAL)) {
    return unsupportedFlag;
  }
  destination[offset] = high; destination[offset + 1] = low;
  return 0;
}
