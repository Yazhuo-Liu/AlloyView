import { STRAIN_FIELDS, referenceFactors } from '../atomic-strain.js';
import { validateReferences } from '../lattice.js';
import { atomRange } from '../neighbors.js';
import { GpuUnavailableError, checkSignal, yieldWorker } from './runtime.js';
import { ATOMIC_STRAIN_SHADER } from './atomic-strain-shaders.js';

/** GPU elastic tensor evaluation from CPU PTM correspondences. PTM fitting
 * remains in the CPU worker pool; this kernel restores absolute lattice scale
 * and calculates E=(FᵀF-I)/2 plus its nine displayed fields.
 */
export async function analyzeGpuAtomicStrain(runtime, frame, parameters = {}, { signal, onProgress = () => {} } = {}) {
  const atomCount = frame.fractional.length / 3;
  const { startAtom, endAtom } = atomRange(atomCount, parameters);
  const count = endAtom - startAtom;
  checkSignal(signal);
  onProgress({ backend: 'gpu', stage: 'strain-tensor', phase: 'preparing', completedAtoms: 0, totalAtoms: count });
  const inputs = await prepareGpuStrainInput(frame, parameters, { signal });
  await runtime.initialize(signal);
  const buffers = [];
  const own = buffer => { buffers.push(buffer); return buffer; };
  try {
    const config = own(runtime.storageBuffer(new Uint32Array([count, startAtom, 0x7fc00000, 0])));
    const valid = own(runtime.storageBuffer(inputs.valid));
    const factors = own(runtime.storageBuffer(inputs.factors));
    const deformation = own(runtime.storageBuffer(inputs.deformation));
    const output = own(runtime.createBuffer(count * STRAIN_FIELDS.length * Float32Array.BYTES_PER_ELEMENT));
    const diagnostics = own(runtime.createBuffer(8));
    onProgress({ backend: 'gpu', stage: 'strain-tensor', phase: 'analyzing', completedAtoms: 0, totalAtoms: count });
    await runtime.run(ATOMIC_STRAIN_SHADER, [config, valid, factors, deformation, output, diagnostics], count, { signal, batchSize: 0 });
    const values = await runtime.read(output, Float32Array, count * STRAIN_FIELDS.length, { signal });
    const status = await runtime.read(diagnostics, Uint32Array, 2, { signal });
    checkSignal(signal);
    if (status[1]) throw new GpuUnavailableError('The strain tensor exceeds the GPU floating-point range.');
    onProgress({ backend: 'gpu', stage: 'strain-tensor', phase: 'complete', completedAtoms: count, totalAtoms: count });
    return { ...Object.fromEntries(STRAIN_FIELDS.map((field, index) => [field, values.subarray(index * count, (index + 1) * count)])),
      startAtom, endAtom, incomplete: status[0], warning: null, tensorBackend: 'gpu' };
  } finally { runtime.disposeBuffers(buffers); }
}

/** Reference conversion is identical to the CPU kernel. Encode, rather than
 * round away, Float64 residuals before doing the tensor arithmetic on GPU.
 */
export async function prepareGpuStrainInput(frame, { references, ptmInput } = {}, { signal } = {}) {
  const count = frame.fractional.length / 3;
  if (!ArrayBuffer.isView(frame.types) || frame.types.length !== count) throw new Error('Strain requires one element type per atom.');
  validateReferences(references, frame.types);
  if (!ptmInput || !(ptmInput.structures instanceof Uint8Array) || ptmInput.structures.length !== count
    || !(ptmInput.scales instanceof Float64Array) || ptmInput.scales.length !== count
    || !(ptmInput.deformation instanceof Float64Array) || ptmInput.deformation.length !== count * 9) {
    throw new Error('GPU atomic strain requires complete cached PTM correspondences, scales, and deformation.');
  }
  const valid = new Uint32Array(count), factors = new Float32Array(count * 4), deformation = new Float32Array(count * 18);
  for (let atom = 0; atom < count; atom += 1) {
    checkSignal(signal);
    if (atom && atom % 16_384 === 0) { await yieldWorker(); checkSignal(signal); }
    const structure = ptmInput.structures[atom], reference = references[frame.types[atom]], scale = ptmInput.scales[atom];
    if (structure !== reference.structure || !Number.isFinite(scale) || scale === 0) continue;
    const matrix = ptmInput.deformation.subarray(atom * 9, atom * 9 + 9);
    if (matrix.some(value => !Number.isFinite(value))) continue;
    const atomFactors = referenceFactors(structure, reference, scale);
    // Bounded double-single arithmetic must not turn otherwise finite CPU
    // tensors into a silently undefined GPU result.
    for (let component = 0; component < 9; component += 1) {
      const value = matrix[component] * atomFactors[component % 3];
      if (!Number.isFinite(value) || Math.abs(value) > 1e8) {
        throw new GpuUnavailableError('This PTM deformation exceeds the GPU strain precision range.');
      }
      encodeDouble(matrix[component], deformation, (atom * 9 + component) * 2);
    }
    encodeDouble(atomFactors[0], factors, atom * 4);
    encodeDouble(atomFactors[2], factors, atom * 4 + 2);
    valid[atom] = 1;
  }
  return { valid, factors, deformation };
}

function encodeDouble(value, destination, offset) {
  const high = Math.fround(value), low = Math.fround(value - high);
  if (!Number.isFinite(high) || !Number.isFinite(low) || (value !== 0 && high === 0)) {
    throw new GpuUnavailableError('This PTM input exceeds the GPU floating-point range.');
  }
  destination[offset] = high; destination[offset + 1] = low;
}
