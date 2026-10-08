import { cellFaceHeights } from '../../data/model.js';
import { atomRange } from '../neighbors.js';
import { REFERENCE_STRAIN_FIELDS, calculateReferenceStrain, prepareReferenceStrainContext } from '../reference-strain.js';
import { checkSignal, GpuUnavailableError, readGpuBuffers, yieldWorker } from './runtime.js';
import { REFERENCE_STRAIN_SHADER, REFERENCE_STRAIN_CLEAR_SHADER } from './reference-strain-shaders.js';

export const MAX_GPU_REFERENCE_CORRECTION_ATOMS = 16_384;

/** Fit both covariance matrices on GPU, using reference-neighbor images and
 * stable CPU-prepared correspondences. Only uncertain numerical decisions
 * receive a bounded exact CPU correction; no PTM is involved.
 */
export async function analyzeGpuReferenceStrain(runtime, frame, parameters = {}, { signal, onProgress = () => {} } = {}) {
  const prepared = prepareGpuReferenceParameters(frame, parameters);
  checkSignal(signal);
  const { referenceFrame, startAtom, endAtom, inverseMapping, settings } = prepared;
  const count = endAtom - startAtom;
  const releasePins = runtime.pinFrames?.([frame, referenceFrame]);
  const buffers = [], own = buffer => { buffers.push(buffer); return buffer; };
  const report = (phase, completedAtoms = 0) => onProgress({ phase, backend: 'gpu', workerCount: 1,
    prepared: 1, initialized: 1, completedAtoms, totalAtoms: count });
  try {
    report('indexing');
    const current = await runtime.prepareFrameBuffers(frame, { signal });
    const reference = await runtime.prepareNeighbors(referenceFrame, parameters.cutoff, { signal });
    const mappingBuffer = own(runtime.storageBuffer(inverseMapping));
    const settingsBuffer = own(runtime.storageBuffer(new Uint8Array(settings)));
    const outputBuffer = own(runtime.createBuffer(count * REFERENCE_STRAIN_FIELDS.length * Float32Array.BYTES_PER_ELEMENT));
    const flagsBuffer = own(runtime.createBuffer(frame.fractional.length / 3 * Uint32Array.BYTES_PER_ELEMENT));
    const clearParameters = own(runtime.storageBuffer(new Uint32Array([count, 0x7fc00000, 0, 0])));
    await runtime.run(REFERENCE_STRAIN_CLEAR_SHADER, [clearParameters, outputBuffer], count, { signal, batchSize: 0, wait: false });
    report('analyzing');
    await runtime.run(REFERENCE_STRAIN_SHADER, [reference.configBuffer, reference.positionsBuffer, reference.headsBuffer,
      reference.nextBuffer, current.positionsBuffer, mappingBuffer, settingsBuffer, outputBuffer, flagsBuffer], reference.atomCount,
    { signal, onProgress: update => report('analyzing', Math.min(count, Math.floor(update.completedAtoms / reference.atomCount * count))) });
    const [flags, values] = await readGpuBuffers(runtime, [{ buffer: flagsBuffer, Type: Uint32Array, length: frame.fractional.length / 3 },
      { buffer: outputBuffer, Type: Float32Array, length: count * REFERENCE_STRAIN_FIELDS.length }], { signal });
    checkSignal(signal);
    const result = Object.fromEntries(REFERENCE_STRAIN_FIELDS.map((field, index) => [field, values.subarray(index * count, (index + 1) * count)]));
    let correctedAtoms = 0, incomplete = 0, context;
    for (let atom = startAtom; atom < endAtom; atom += 1) {
      const index = atom - startAtom;
      if (flags[atom] === 2) {
        if (correctedAtoms >= MAX_GPU_REFERENCE_CORRECTION_ATOMS) {
          throw new GpuUnavailableError('Too many reference environments need exact numerical correction for this GPU kernel.');
        }
        context ??= prepareReferenceStrainContext(frame, parameters);
        const correction = calculateReferenceStrain(frame, { ...parameters, preparedContext: context, startAtom: atom, endAtom: atom + 1 });
        for (const field of REFERENCE_STRAIN_FIELDS) result[field][index] = correction[field][0];
        correctedAtoms += 1;
        if (correctedAtoms % 128 === 0) { await yieldWorker(); checkSignal(signal); }
      }
      if (Number.isNaN(result.referenceShearStrain[index])) incomplete += 1;
      if (index && index % 65_536 === 0) { await yieldWorker(); checkSignal(signal); }
    }
    report('complete', count);
    return { ...result, startAtom, endAtom, incomplete, correctedAtoms, gpuCorrectionAtoms: correctedAtoms, warning: null };
  } finally {
    runtime.disposeBuffers(buffers);
    releasePins?.();
  }
}

export function prepareGpuReferenceParameters(frame, parameters = {}) {
  const { referenceFractional, referenceCell, referenceMapping, cutoff } = parameters;
  if (!Number.isFinite(cutoff) || cutoff <= 0) throw new Error('Reference-strain cutoff must be positive and finite.');
  const atomCount = frame.fractional.length / 3, referenceCount = referenceFractional?.length / 3;
  const { startAtom, endAtom } = atomRange(atomCount, parameters);
  if (!Number.isInteger(referenceCount) || referenceCount < 1 || !(referenceMapping instanceof Int32Array) || referenceMapping.length !== atomCount) {
    throw new Error('Reference-strain coordinates or atom mapping are incomplete.');
  }
  if (atomCount > 4_000_000 || referenceCount > 4_000_000) {
    throw new GpuUnavailableError('The current or reference frame exceeds the GPU reference-strain atom budget.');
  }
  if (!referenceCell?.pbc || referenceCell.pbc.some((periodic, axis) => periodic !== frame.cell.pbc[axis])) {
    throw new Error('Reference and current frames must use the same periodic boundary axes.');
  }
  const inverseMapping = new Int32Array(referenceCount).fill(-1);
  for (let atom = 0; atom < atomCount; atom += 1) {
    const reference = referenceMapping[atom];
    if (reference < -1 || reference >= referenceCount || (reference >= 0 && inverseMapping[reference] >= 0)) {
      throw new Error('Reference-strain atom mapping must be one-to-one and within the reference frame.');
    }
    if (reference >= 0) inverseMapping[reference] = atom;
  }
  const heights = Array.from(cellFaceHeights(frame.cell));
  const vectors = Array.from(frame.cell.vectors);
  const scale = Math.max(...vectors.map(Math.abs));
  if (heights.some(value => !Number.isFinite(value) || value <= 0) || !Number.isFinite(scale)
    || scale / Math.min(...heights) > 1e6) {
    throw new GpuUnavailableError('The current cell exceeds the GPU reference-image precision range.');
  }
  const settings = new ArrayBuffer(240), integers = new Uint32Array(settings), floats = new Float32Array(settings);
  integers.set([atomCount, startAtom, endAtom, 0x7fc00000]);
  integers.set(frame.cell.pbc.map(Boolean).map(Number), 4);
  floats.set(heights, 8);
  for (let axis = 0; axis < 3; axis += 1) floats.set(vectors.slice(axis * 3, axis * 3 + 3), 12 + axis * 4);
  for (let component = 0; component < 18; component += 1) {
    const value = component < 9 ? referenceCell.vectors[component] : vectors[component - 9];
    const high = Math.fround(value), low = Math.fround(value - high);
    if (!Number.isFinite(high) || !Number.isFinite(low) || (value !== 0 && high === 0)) {
      throw new GpuUnavailableError('A cell vector exceeds the GPU reference-strain floating-point range.');
    }
    floats[24 + component * 2] = high; floats[25 + component * 2] = low;
  }
  const referenceFrame = parameters.referenceFrame ?? { fractional: referenceFractional, cell: referenceCell };
  if (referenceFrame.fractional !== referenceFractional || referenceFrame.cell !== referenceCell) {
    throw new Error('The reference GPU frame must match the reference-strain inputs.');
  }
  return { atomCount, referenceCount, startAtom, endAtom, inverseMapping, settings, referenceFrame };
}
