import { classify, classifyAdaptiveEnvironment } from '../cna.js';
import { NeighborSearch, atomRange } from '../neighbors.js';
import { determinant3 } from '../../data/model.js';
import { checkSignal, GpuUnavailableError, yieldWorker } from './runtime.js';
import { CNA_FIXED_SHADER, CNA_ADAPTIVE_SHADER, CNA_RESULT_WORDS, CNA_FLAG_PRECISION, CNA_FLAG_BUDGET,
  CNA_FLAG_CP_GRAPH, CNA_FLAG_BCC_GRAPH, CNA_FLAG_SHELL12, CNA_FLAG_SHELL14 } from './cna-shaders.js';

export const MAX_GPU_CNA_CORRECTIONS = 16_384;
export const MAX_GPU_CNA_RADIUS_ATTEMPTS = 24;

/** GPU selection and graph classification, with bounded exact correction of
 * atoms whose shell membership or graph edges lie at an f32 decision boundary.
 * Neither adaptive shells nor ordinary CNA graphs are computed on the CPU. */
export async function analyzeGpuCna(runtime, frame, parameters = {}, { signal, onProgress = () => {} } = {}) {
  const startedAt = performance.now();
  const { mode = 'adaptive', cutoff = 3 } = parameters;
  if (!['adaptive', 'fixed'].includes(mode)) throw new Error('Unknown CNA mode.');
  if (mode === 'fixed' && (!Number.isFinite(cutoff) || cutoff <= 0)) throw new Error('CNA cutoff must be positive and finite.');
  const count = frame.fractional.length / 3;
  if (!Number.isInteger(count) || count < 1) throw new Error('Analysis requires at least one atom.');
  const { startAtom, endAtom } = atomRange(count, parameters);
  checkSignal(signal);
  const progress = (phase, completedAtoms = 0) => onProgress({ phase, completedAtoms, totalAtoms: count, workerCount: 1 });
  progress('preparing');
  checkSignal(signal);
  const owned = [];
  const own = (buffer) => { owned.push(buffer); return buffer; };
  try {
    const needed = frame.cell.pbc.some(Boolean) ? 14 : Math.min(14, count - 1);
    let radius = mode === 'fixed' ? cutoff : adaptiveCnaInitialRadius(frame);
    let context = await runtime.prepareNeighbors(frame, radius, { signal });
    const resultBuffer = own(runtime.createBuffer(count * CNA_RESULT_WORDS * 4));
    const settingsBuffer = own(runtime.storageBuffer(new Uint32Array([needed, 0, 0, 0])));
    let data, radiusAttempts = 0, unresolved = 0;
    for (; radiusAttempts < MAX_GPU_CNA_RADIUS_ATTEMPTS; radiusAttempts++) {
      checkSignal(signal);
      if (radiusAttempts) context = await runtime.prepareNeighbors(frame, radius, { signal });
      progress('indexing');
      await runtime.run(mode === 'fixed' ? CNA_FIXED_SHADER : CNA_ADAPTIVE_SHADER,
        runtime.neighborBindings(context, [resultBuffer, settingsBuffer]), count,
        { signal, startAtom, endAtom, onProgress: value => onProgress({ ...value, phase: 'analyzing', workerCount: 1 }) });
      data = await runtime.read(resultBuffer, Uint32Array, count * CNA_RESULT_WORDS, { signal });
      unresolved = 0;
      for (let atom = startAtom; atom < endAtom; atom++) {
        const offset = atom * CNA_RESULT_WORDS;
        if (data[offset + 1] & CNA_FLAG_BUDGET) throw new GpuUnavailableError('The CNA candidate search exceeds the GPU per-atom budget.');
        if (!data[offset + 2]) unresolved++;
      }
      if (!unresolved) { radiusAttempts++; break; }
      if (mode === 'fixed') throw new GpuUnavailableError('The GPU CNA cutoff search could not be completed.');
      radius *= 1.6;
      await yieldWorker();
    }
    if (unresolved) {
      throw new GpuUnavailableError('The adaptive CNA GPU search could not resolve this cell geometry.');
    }
    const structures = new Uint8Array(endAtom - startAtom), correctionAtoms = [];
    const gpuCorrectionReasons = { closePackedGraph: 0, bccGraph: 0, shell12: 0, shell14: 0 };
    for (let atom = startAtom; atom < endAtom; atom++) {
      const offset = atom * CNA_RESULT_WORDS;
      structures[atom - startAtom] = data[offset];
      if (data[offset + 1] & CNA_FLAG_PRECISION) correctionAtoms.push(atom);
      if (data[offset + 1] & CNA_FLAG_CP_GRAPH) gpuCorrectionReasons.closePackedGraph++;
      if (data[offset + 1] & CNA_FLAG_BCC_GRAPH) gpuCorrectionReasons.bccGraph++;
      if (data[offset + 1] & CNA_FLAG_SHELL12) gpuCorrectionReasons.shell12++;
      if (data[offset + 1] & CNA_FLAG_SHELL14) gpuCorrectionReasons.shell14++;
      if (atom && atom % 65_536 === 0) { await yieldWorker(); checkSignal(signal); }
    }
    if (correctionAtoms.length > MAX_GPU_CNA_CORRECTIONS) {
      throw new GpuUnavailableError(`More than ${MAX_GPU_CNA_CORRECTIONS} CNA environments are near a GPU precision boundary; using CPU workers.`);
    }
    if (correctionAtoms.length) {
      const search = new NeighborSearch(frame);
      for (let index = 0; index < correctionAtoms.length; index++) {
        const atom = correctionAtoms[index];
        structures[atom - startAtom] = correctGpuCnaAtom(search, atom, { mode, cutoff });
        if ((index + 1) % 128 === 0) { await yieldWorker(); checkSignal(signal); }
      }
    }
    checkSignal(signal); progress('complete', count);
    return { structures, startAtom, endAtom, elapsedMs: performance.now() - startedAt,
      gpuCorrectionAtoms: correctionAtoms.length, gpuCorrectionReasons, gpuRadiusAttempts: radiusAttempts };
  } finally { runtime.disposeBuffers(owned); }
}

/** Same initial nearest-neighbor sphere as NeighborSearch, without building
 * its CPU index. Nonperiodic source spans retain the CPU radius definition. */
export function adaptiveCnaInitialRadius(frame) {
  const count = frame.fractional.length / 3;
  let spanProduct = 1;
  for (let axis = 0; axis < 3; axis++) {
    if (frame.cell.pbc[axis]) continue;
    let minimum = Infinity, maximum = -Infinity;
    for (let atom = 0; atom < count; atom++) {
      const coordinate = frame.fractional[atom * 3 + axis];
      if (!Number.isFinite(coordinate)) throw new Error(`Atom ${atom + 1} has a non-finite coordinate.`);
      minimum = Math.min(minimum, coordinate); maximum = Math.max(maximum, coordinate);
    }
    spanProduct *= Math.max(1, maximum - minimum + 1e-10);
  }
  return 1.6 * Math.cbrt(Math.abs(determinant3(frame.cell.vectors)) * spanProduct / count);
}

export function correctGpuCnaAtom(search, atom, { mode, cutoff }) {
  return mode === 'fixed' ? classify(search.within(atom, cutoff, 15), cutoff)
    : classifyAdaptiveEnvironment(search.nearest(atom, 14));
}
