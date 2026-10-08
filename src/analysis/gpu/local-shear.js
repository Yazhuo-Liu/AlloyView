import { NeighborSearch, atomRange } from '../neighbors.js';
import { MAX_NEIGHBORS_PER_ATOM } from '../bonds.js';
import { modalCoordination, shearInvariant } from '../local-shear.js';
import { makeShearCoordinationShader, makeShearMetricsShader, SHEAR_REDUCTION_SHADER, SHEAR_FINALIZE_SHADER,
  SHEAR_CORRECTION_SHADER, SHEAR_WORKGROUP_SIZE } from './local-shear-shaders.js';
import { readGpuBuffers, yieldWorker } from './runtime.js';

export const MAX_GPU_SHEAR_COORDINATION = 64;

/** Reuse the device's linked-cell index, including distinct periodic images. */
export async function analyzeGpuLocalShear(runtime, frame, parameters = {}, { signal, onProgress = () => {} } = {}) {
  const { cutoff, subtractMean = false } = parameters;
  if (!Number.isFinite(cutoff) || cutoff <= 0) throw new Error('Geometric shear cutoff must be positive and finite.');
  checkAbort(signal);
  const context = await runtime.prepareNeighbors(frame, cutoff, { signal });
  const count = context.atomCount;
  const { startAtom, endAtom } = atomRange(count, parameters);
  const buffers = [];
  const create = (bytes) => { const buffer = runtime.createBuffer(bytes); buffers.push(buffer); return buffer; };
  const upload = (array) => { const buffer = runtime.storageBuffer(array); buffers.push(buffer); return buffer; };
  const progress = (phase, completedAtoms = 0) => onProgress({ phase, workerCount: 1, total: 1, completed: phase === 'complete' ? 1 : 0,
    prepared: 1, initialized: 1, completedAtoms, totalAtoms: count });
  try {
    progress('indexing');
    const coordinationBuffer = create(count * Uint32Array.BYTES_PER_ELEMENT);
    const correctionFlagsBuffer = create(count * Uint32Array.BYTES_PER_ELEMENT);
    await runtime.run(makeShearCoordinationShader(), runtime.neighborBindings(context, [coordinationBuffer, correctionFlagsBuffer]), count, { signal, wait: false });
    const [coordination, cutoffFlags] = await readGpuBuffers(runtime, [{ buffer: coordinationBuffer, Type: Uint32Array, length: count },
      { buffer: correctionFlagsBuffer, Type: Uint32Array, length: count }], { signal });
    checkAbort(signal);
    let search;
    const cachedNeighbors = new Map();
    const neighborsFor = (atom) => {
      if (cachedNeighbors.has(atom)) return cachedNeighbors.get(atom);
      search ??= new NeighborSearch(frame);
      const neighbors = search.within(atom, cutoff, MAX_NEIGHBORS_PER_ATOM + 1);
      if (neighbors.length > MAX_NEIGHBORS_PER_ATOM) throw new Error('Too many geometric shear neighbors; reduce the cutoff.');
      if (cachedNeighbors.size < 1024) cachedNeighbors.set(atom, neighbors);
      return neighbors;
    };
    let countCorrections = 0;
    for (let atom = 0; atom < count; atom += 1) if (cutoffFlags[atom]) {
      coordination[atom] = neighborsFor(atom).length;
      countCorrections += 1;
      if (countCorrections % 256 === 0) { await yieldWorker(); checkAbort(signal); }
    }
    const { histogram, coordinationSum } = shearCoordinationStatistics(coordination);
    const mode = modalCoordination(histogram);
    if (mode > MAX_GPU_SHEAR_COORDINATION) throw gpuUnsupported(`GPU geometric shear supports modal coordination up to ${MAX_GPU_SHEAR_COORDINATION}.`);
    if (mode === 0) {
      const localShear = new Float32Array(endAtom - startAtom).fill(NaN);
      progress('complete', count);
      return { startAtom, endAtom, localShear, coordination: coordination.slice(startAtom, endAtom), coordinationMode: 0,
        normalization: NaN, meanMetric: new Array(6).fill(NaN), averageCoordination: coordinationSum / count,
        averageShear: NaN, gpuCorrectionAtoms: countCorrections, warning: null };
    }
    progress('analyzing');
    const metrics = create(count * 6 * Float32Array.BYTES_PER_ELEMENT);
    const normalizationSums = create(count * Float32Array.BYTES_PER_ELEMENT);
    const normalizationCounts = create(count * Uint32Array.BYTES_PER_ELEMENT);
    await runtime.run(makeShearMetricsShader(mode), runtime.neighborBindings(context, [metrics, normalizationSums, normalizationCounts, correctionFlagsBuffer]), count, { signal, wait: false });
    // The workgroup reduction overwrites every partial. Run it before knowing
    // whether sparse corrections exist, so the usual uncorrected case reads
    // flags and partials in one mapping; corrections simply reduce again.
    const groups = Math.ceil(count / SHEAR_WORKGROUP_SIZE);
    const partialsBuffer = create(groups * 8 * Float32Array.BYTES_PER_ELEMENT);
    const countBuffer = upload(new Uint32Array([count, 0, 0, 0]));
    const reduce = () => runtime.run(SHEAR_REDUCTION_SHADER, [countBuffer, metrics, normalizationSums, normalizationCounts, partialsBuffer],
      groups * SHEAR_WORKGROUP_SIZE, { signal, batchSize: 0, wait: false });
    await reduce();
    let [correctionFlags, partials] = await readGpuBuffers(runtime, [{ buffer: correctionFlagsBuffer, Type: Uint32Array, length: count },
      { buffer: partialsBuffer, Type: Float32Array, length: groups * 8 }], { signal });
    const correctedAtoms = [];
    for (let atom = 0; atom < count; atom += 1) if (correctionFlags[atom]) correctedAtoms.push(atom);
    if (correctedAtoms.length) {
      const correctedMoments = new Float32Array(correctedAtoms.length * 8);
      for (let index = 0; index < correctedAtoms.length; index += 1) {
        correctedMoments.set(shearNeighborMoments(neighborsFor(correctedAtoms[index]), mode), index * 8);
        if (index && index % 256 === 0) { await yieldWorker(); checkAbort(signal); }
      }
      const correctedCountBuffer = upload(new Uint32Array([correctedAtoms.length, 0, 0, 0]));
      const correctedAtomBuffer = upload(Uint32Array.from(correctedAtoms));
      const correctedMomentBuffer = upload(correctedMoments);
      await runtime.run(SHEAR_CORRECTION_SHADER, [correctedCountBuffer, correctedAtomBuffer, correctedMomentBuffer,
        metrics, normalizationSums, normalizationCounts], correctedAtoms.length, { signal, batchSize: 0, wait: false });
      await reduce();
      partials = await runtime.read(partialsBuffer, Float32Array, groups * 8, { signal });
    }
    checkAbort(signal);
    const { normalization, meanMetric } = reduceShearMoments(partials, count);
    if (!(Math.fround(normalization) > 0) || !Number.isFinite(Math.fround(normalization))
      || meanMetric.some(value => !Number.isFinite(Math.fround(value)))) {
      throw gpuUnsupported('Geometric shear normalization exceeds the GPU floating-point range.');
    }
    const finalizeParameters = new Uint32Array(12);
    const floatParameters = new Float32Array(finalizeParameters.buffer);
    finalizeParameters[0] = count;
    finalizeParameters[1] = subtractMean ? 1 : 0;
    finalizeParameters[3] = 0x7fc00000;
    floatParameters[2] = normalization;
    floatParameters.set(meanMetric, 4);
    const finalizeBuffer = upload(finalizeParameters);
    const output = create(count * Float32Array.BYTES_PER_ELEMENT);
    await runtime.run(SHEAR_FINALIZE_SHADER, [finalizeBuffer, metrics, output], count, { signal, batchSize: 0, wait: false });
    const values = await runtime.read(output, Float32Array, count, { signal });
    checkAbort(signal);
    progress('complete', count);
    return { startAtom, endAtom, localShear: values.slice(startAtom, endAtom), coordination: coordination.slice(startAtom, endAtom),
      coordinationMode: mode, normalization, meanMetric, averageCoordination: coordinationSum / count,
      averageShear: shearInvariant(meanMetric), gpuCorrectionAtoms: correctedAtoms.length, warning: null };
  } finally {
    runtime.disposeBuffers(buffers);
  }
}

export function shearCoordinationStatistics(coordination) {
  const histogram = [];
  let coordinationSum = 0;
  for (const value of coordination) {
    if (value > MAX_NEIGHBORS_PER_ATOM) throw new Error('Too many geometric shear neighbors; reduce the cutoff.');
    histogram[value] = (histogram[value] ?? 0) + 1;
    coordinationSum += value;
  }
  return { histogram: Array.from(histogram, value => value ?? 0), coordinationSum };
}

/** Small workgroup totals are accumulated in Float64 on the Worker. */
export function reduceShearMoments(partials, atomCount) {
  if (!Number.isInteger(atomCount) || atomCount < 1 || partials.length % 8 !== 0) throw new Error('Invalid GPU geometric shear reduction.');
  const sums = new Float64Array(8);
  for (let offset = 0; offset < partials.length; offset += 8) {
    for (let component = 0; component < 8; component += 1) {
      const value = partials[offset + component];
      if (!Number.isFinite(value)) throw gpuUnsupported('Geometric shear reduction exceeds the GPU floating-point range.');
      sums[component] += value;
    }
  }
  const normalization = sums[7] > 0 ? sums[6] / sums[7] / 3 : NaN;
  const meanMetric = Array.from(sums.subarray(0, 6), value => value / atomCount / normalization);
  return { normalization, meanMetric };
}

/** Match the double-precision CPU cutoff and distance/id/vector tie ordering
 * for only those atoms whose f32 shell selection could change the tensor.
 */
export function shearNeighborMoments(neighbors, mode) {
  neighbors.sort((a, b) => a.distanceSquared - b.distanceSquared || a.atom - b.atom || a.x - b.x || a.y - b.y || a.z - b.z);
  const participants = Math.min(mode, neighbors.length), moments = new Float64Array(8);
  for (let index = 0; index < participants; index += 1) {
    const { x, y, z, distanceSquared } = neighbors[index];
    moments[0] += x * x; moments[1] += x * y; moments[2] += x * z;
    moments[3] += y * y; moments[4] += y * z; moments[5] += z * z;
    if (participants === mode) moments[6] += distanceSquared;
  }
  if (participants) for (let component = 0; component < 6; component += 1) moments[component] /= participants;
  moments[7] = participants === mode ? participants : 0;
  return moments;
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
}
function gpuUnsupported(message) {
  const error = new Error(message);
  error.name = 'GpuUnsupportedError';
  return error;
}
