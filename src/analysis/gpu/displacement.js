import { cellFaceHeights } from '../../data/model.js';
import { calculatePreparedDisplacements, prepareDisplacementCalculation } from '../displacement.js';
import { checkSignal, GpuUnavailableError, yieldWorker } from './runtime.js';
import { DISPLACEMENT_SHADER } from './displacement-shaders.js';

export const MAX_GPU_DISPLACEMENT_CORRECTION_ATOMS = 16_384;
const BATCH_ATOMS = 16_384;

/** CPU-prepared stable correspondences feed GPU Cartesian subtraction,
 * current-cell image selection and scalar magnitudes. Exact CPU correction is
 * limited to numerically ambiguous or unusually expensive image decisions.
 */
export async function analyzeGpuDisplacement(runtime, frame, parameters = {}, { signal, onProgress = () => {} } = {}) {
  checkSignal(signal);
  const prepared = prepareGpuDisplacementParameters(frame, parameters);
  const { referenceFrame, startAtom, endAtom, settings, context } = prepared;
  const count = endAtom - startAtom;
  const report = (phase, completedAtoms = 0) => onProgress({ phase, backend: 'gpu', workerCount: 1,
    prepared: 1, initialized: 1, completedAtoms, totalAtoms: count });
  if (!count) return { vectors: new Float32Array(), magnitudes: new Float64Array(), matched: 0, unmatched: 0,
    referenceMapping: parameters.referenceMapping, minimumImage: context.minimumImage, mappingMode: context.mappingMode,
    startAtom, endAtom, gpuCorrectionAtoms: 0, correctedAtoms: 0, warning: null };
  const releasePins = runtime.pinFrames?.([frame, referenceFrame]);
  const buffers = [], own = buffer => { buffers.push(buffer); return buffer; };
  try {
    report('indexing');
    const variant = context.minimumImage ? 'cartesian' : 'unwrapped-cartesian';
    const current = await runtime.prepareCartesianFrame(frame, parameters.currentPositions, { signal, variant });
    const reference = await runtime.prepareCartesianFrame(referenceFrame, parameters.referencePositions,
      { signal, variant, frameIndex: parameters.referenceFrameIndex });
    const floats = new Float32Array(settings);
    for (let axis = 0; axis < 3; axis += 1) {
      const change = current.anchor[axis] - reference.anchor[axis];
      encodeDouble(floats, 52 + axis * 2, change, 'The displacement origin exceeds the GPU precision range.');
    }
    const settingsBuffer = own(runtime.storageBuffer(new Uint8Array(settings)));
    const mappingBuffer = own(runtime.storageBuffer(parameters.referenceMapping));
    const vectorsBuffer = own(runtime.createBuffer(count * 3 * Float32Array.BYTES_PER_ELEMENT));
    const magnitudesBuffer = own(runtime.createBuffer(count * 4 * Float32Array.BYTES_PER_ELEMENT));
    const flagsBuffer = own(runtime.createBuffer(count * Uint32Array.BYTES_PER_ELEMENT));
    const bindings = [settingsBuffer, mappingBuffer, current.positionsBuffer, reference.positionsBuffer,
      vectorsBuffer, magnitudesBuffer, flagsBuffer];
    report('analyzing');
    for (let start = startAtom; start < endAtom; start += BATCH_ATOMS) {
      checkSignal(signal);
      const end = Math.min(start + BATCH_ATOMS, endAtom);
      runtime.write(settingsBuffer, new Uint32Array([start, end]), 40);
      await runtime.run(DISPLACEMENT_SHADER, bindings, end - start, { signal, batchSize: 0 });
      report('analyzing', end - startAtom);
      checkSignal(signal);
      if (end < endAtom) await yieldWorker();
    }
    const vectors = await runtime.read(vectorsBuffer, Float32Array, count * 3, { signal });
    const packedMagnitudes = await runtime.read(magnitudesBuffer, Float32Array, count * 4, { signal });
    const flags = await runtime.read(flagsBuffer, Uint32Array, count, { signal });
    const magnitudes = new Float64Array(count);
    let matched = 0, correctedAtoms = 0, lastYieldAt = performance.now();
    for (let index = 0; index < count; index += 1) {
      const atom = startAtom + index;
      if (parameters.referenceMapping[atom] >= 0) matched += 1;
      if (flags[index] === 2) {
        if (correctedAtoms >= MAX_GPU_DISPLACEMENT_CORRECTION_ATOMS) {
          throw new GpuUnavailableError('Too many displacement images need exact numerical correction for this GPU kernel.');
        }
        const correction = calculatePreparedDisplacements(frame, { ...parameters, preparedContext: context,
          startAtom: atom, endAtom: atom + 1 }, { signal });
        vectors.set(correction.vectors, index * 3); magnitudes[index] = correction.magnitudes[0];
        correctedAtoms += 1;
        if (correctedAtoms % 128 === 0 || performance.now() - lastYieldAt >= 24) {
          await yieldWorker(); checkSignal(signal); lastYieldAt = performance.now();
        }
      } else if (flags[index] === 0) {
        magnitudes[index] = NaN;
      } else {
        const offset = index * 4;
        magnitudes[index] = (packedMagnitudes[offset] + packedMagnitudes[offset + 1]) * packedMagnitudes[offset + 2];
      }
      if (index && index % 16_384 === 0) { await yieldWorker(); checkSignal(signal); lastYieldAt = performance.now(); }
    }
    checkSignal(signal);
    report('complete', count);
    return { vectors, magnitudes, matched, unmatched: count - matched, referenceMapping: parameters.referenceMapping,
      minimumImage: context.minimumImage, mappingMode: context.mappingMode, startAtom, endAtom,
      correctedAtoms, gpuCorrectionAtoms: correctedAtoms, warning: null };
  } finally {
    runtime.disposeBuffers(buffers);
    releasePins?.();
  }
}

export function prepareGpuDisplacementParameters(frame, parameters = {}) {
  const context = prepareDisplacementCalculation(frame, parameters);
  const count = parameters.referenceMapping.length, referenceCount = parameters.referencePositions.length / 3;
  if (count > 4_000_000 || referenceCount > 4_000_000) {
    throw new GpuUnavailableError('The current or reference frame exceeds the GPU displacement atom budget.');
  }
  if (![parameters.currentPositions, parameters.referencePositions].every(array => array instanceof Float32Array || array instanceof Float64Array)) {
    throw new GpuUnavailableError('GPU displacement requires the original typed Cartesian coordinates.');
  }
  const startAtom = parameters.startAtom ?? 0, endAtom = parameters.endAtom ?? count;
  if (!Number.isInteger(startAtom) || !Number.isInteger(endAtom) || startAtom < 0 || endAtom > count || endAtom < startAtom) {
    throw new Error('The displacement atom range is invalid.');
  }
  const referenceFrame = parameters.referenceFrame ?? { fractional: parameters.referenceFractional, cell: parameters.referenceCell };
  if (referenceFrame.fractional?.length !== referenceCount * 3 || !referenceFrame.cell) {
    throw new Error('The displacement reference frame is incomplete.');
  }
  if ((parameters.referenceFractional && parameters.referenceFractional !== referenceFrame.fractional)
    || (parameters.referenceCell && parameters.referenceCell !== referenceFrame.cell)) {
    throw new Error('The reference GPU frame must match the displacement inputs.');
  }
  const settings = new ArrayBuffer(240), integers = new Uint32Array(settings), floats = new Float32Array(settings);
  integers.set([count, startAtom, endAtom, 0x7fc00000]);
  integers.set(frame.cell.pbc.map(Boolean).map(Number), 4);
  integers[7] = Number(parameters.currentPositions === parameters.referencePositions);
  integers.set([Number(context.minimumImage), Number(context.orthogonal), startAtom, endAtom], 8);
  if (context.minimumImage && frame.cell.pbc.some(Boolean)) {
    const heights = context.heights ?? cellFaceHeights(frame.cell);
    const vectors = frame.cell.vectors, scale = Math.max(...Array.from(vectors, Math.abs));
    if (heights.some(height => !Number.isFinite(height) || height <= 0) || !Number.isFinite(scale)
      || scale / Math.min(...heights) > 1e6) {
      throw new GpuUnavailableError('The current cell exceeds the GPU displacement image precision range.');
    }
    floats.set(heights, 12);
    for (let component = 0; component < 18; component += 1) {
      const value = component < 9 ? vectors[component] : context.inverse[component - 9];
      encodeDouble(floats, 16 + component * 2, value, 'A cell matrix exceeds the GPU displacement floating-point range.');
    }
  }
  return { context, referenceFrame, startAtom, endAtom, settings };
}

function encodeDouble(array, offset, value, message) {
  const high = Math.fround(value), low = Math.fround(value - high);
  if (!Number.isFinite(high) || !Number.isFinite(low) || (value !== 0 && Math.abs(high) < 1e-30)) {
    throw new GpuUnavailableError(message);
  }
  array[offset] = high; array[offset + 1] = low;
}
