import { CSP_SUMMARY_FIELDS } from '../centrosymmetry.js';
import { atomRange } from '../neighbors.js';
import { analyzeGpuCna, adaptiveCnaInitialRadius, MAX_GPU_CNA_RADIUS_ATTEMPTS } from './cna.js';
import { checkSignal, GpuUnavailableError, yieldWorker } from './runtime.js';
import { CSP_SHADER, CSP_RESULT_WORDS } from './centrosymmetry-shaders.js';

const TYPE_NAMES = ['other', 'fcc', 'hcp', 'bcc', 'ico'];

/** Exact double-distance ordering on the GPU preserves AtomEye's normalized
 * greedy, disjoint opposite pairing without correcting whole tied crystals. */
export async function analyzeGpuCentrosymmetry(runtime, frame, parameters = {}, { signal, onProgress = () => {} } = {}) {
  const startedAt = performance.now();
  const { mode = 'manual', neighbors = 12, structureInput } = parameters;
  if (!['manual', 'auto'].includes(mode)) throw new Error('Unknown central-symmetry mode.');
  if (mode === 'manual' && (!Number.isInteger(neighbors) || neighbors < 2 || neighbors > 32 || neighbors % 2 !== 0)) {
    throw new Error('Central symmetry requires an even neighbor count between 2 and 32.');
  }
  const count = frame.fractional.length / 3;
  if (!Number.isInteger(count) || count < 1) throw new Error('Analysis requires at least one atom.');
  const { startAtom, endAtom } = atomRange(count, parameters);
  if (structureInput !== undefined && (!(structureInput instanceof Uint8Array)
      || structureInput.length !== count || structureInput.some(type => type > 4))) {
    throw new Error('Auto central symmetry requires complete adaptive CNA structure IDs.');
  }
  checkSignal(signal);
  const progress = (phase, completedAtoms = 0) => onProgress({ phase, completedAtoms, totalAtoms: count, workerCount: 1 });
  progress('preparing'); checkSignal(signal);
  let classifications, cnaResult, gpuCnaReused = false;
  if (mode === 'auto') {
    classifications = structureInput ?? runtime.getAdaptiveCna?.(frame);
    gpuCnaReused = Boolean(classifications);
    if (!classifications) {
      cnaResult = await analyzeGpuCna(runtime, frame, { mode: 'adaptive' }, { signal,
        onProgress: value => onProgress({ ...value, stage: 'classifying' }) });
      checkSignal(signal);
      classifications = cnaResult.structures;
      runtime.cacheAdaptiveCna?.(frame, classifications);
    }
  }
  const requiredCount = mode === 'auto' ? 14 : neighbors;
  const required = frame.cell.pbc.some(Boolean) ? requiredCount : Math.min(requiredCount, count - 1);
  let radius = adaptiveCnaInitialRadius(frame), context = await runtime.prepareNeighbors(frame, radius, { signal });
  const owned = [], own = buffer => { owned.push(buffer); return buffer; };
  try {
    const resultBuffer = own(runtime.createBuffer(count * CSP_RESULT_WORDS * 4));
    const source = await exactCoordinateWords(runtime, frame, { signal });
    const sourceBuffer = own(runtime.storageBuffer(source));
    const settingsBuffer = own(runtime.storageBuffer(prepareCspSettings(frame, { required, neighbors, mode })));
    const labelsBuffer = own(runtime.storageBuffer(classifications ? Uint32Array.from(classifications) : new Uint32Array(1)));
    let data, unresolved = 0, radiusAttempts = 0;
    for (; radiusAttempts < MAX_GPU_CNA_RADIUS_ATTEMPTS; radiusAttempts++) {
      checkSignal(signal);
      if (radiusAttempts) context = await runtime.prepareNeighbors(frame, radius, { signal });
      progress('indexing');
      // Emulated binary64 pairing is the heaviest neighbor kernel; its batches
      // start at the former 16k atoms and grow only after measured dispatches.
      await runtime.run(CSP_SHADER, runtime.neighborBindings(context, [resultBuffer, sourceBuffer, settingsBuffer, labelsBuffer]), count,
        { signal, startAtom, endAtom, initialBatchSize: 16_384, onProgress: value => onProgress({ ...value, phase: 'analyzing', stage: 'pairing', workerCount: 1 }) });
      data = await runtime.read(resultBuffer, Uint32Array, count * CSP_RESULT_WORDS, { signal });
      unresolved = 0;
      for (let atom = startAtom; atom < endAtom; atom++) {
        const base = atom * CSP_RESULT_WORDS;
        if (data[base + 1]) throw new GpuUnavailableError(data[base + 1] === 1
          ? 'The central-symmetry candidate search exceeds the GPU budget.' : 'The central-symmetry GPU arithmetic could not resolve this environment.');
        if (!data[base + 2]) unresolved++;
      }
      if (!unresolved) { radiusAttempts++; break; }
      radius *= 1.6; await yieldWorker();
    }
    if (unresolved) throw new GpuUnavailableError('The central-symmetry GPU search could not resolve this cell geometry.');
    const values = new Float32Array(data.buffer), centrosymmetry = new Float32Array(endAtom - startAtom);
    const auto = mode === 'auto', cspStructureTypes = auto ? new Uint8Array(endAtom - startAtom) : null;
    const cspNeighborCounts = auto ? new Uint8Array(endAtom - startAtom) : null;
    const cspSummary = auto ? Object.fromEntries(CSP_SUMMARY_FIELDS.map(name => [name, 0])) : null;
    let incomplete = 0;
    for (let atom = startAtom; atom < endAtom; atom++) {
      const base = atom * CSP_RESULT_WORDS, index = atom - startAtom;
      centrosymmetry[index] = values[base]; incomplete += data[base + 7];
      if (auto) {
        const type = data[base + 4]; cspStructureTypes[index] = type; cspNeighborCounts[index] = data[base + 5];
        cspSummary[TYPE_NAMES[type]]++; cspSummary.inferred += data[base + 6];
        if (!Number.isFinite(centrosymmetry[index])) cspSummary.unresolved++;
      }
      if (atom && atom % 65_536 === 0) { await yieldWorker(); checkSignal(signal); }
    }
    checkSignal(signal); progress('complete', count);
    return { centrosymmetry, ...(auto ? { cspStructureTypes, cspNeighborCounts, cspSummary } : {}),
      incomplete, startAtom, endAtom, elapsedMs: performance.now() - startedAt, gpuRadiusAttempts: radiusAttempts,
      warning: incomplete ? `${incomplete} atoms have insufficient neighbors or zero-length environments; central symmetry is undefined (NaN) for them.` : null,
      gpuCorrectionAtoms: 0, gpuCnaReused, gpuCnaCorrectionAtoms: cnaResult?.gpuCorrectionAtoms ?? 0,
      gpuCnaCorrectionReasons: cnaResult?.gpuCorrectionReasons ?? null, gpuArithmetic: 'ieee754-f64-ordering' };
  } finally { runtime.disposeBuffers(owned); }
}

/** Encoded words for one immutable frame input are shared by central
 * symmetry and PTM-neighbor preparation. Runtimes without a cache (tests,
 * direct callers) encode on every call. */
export async function exactCoordinateWords(runtime, frame, { signal } = {}) {
  const cache = runtime?.exactCoordinateCache, pbc = Array.from(frame.cell.pbc, Boolean).join();
  const cached = cache?.get(frame.fractional);
  if (cached && cached.cell === frame.cell && cached.pbc === pbc) { checkSignal(signal); return cached.words; }
  const words = await prepareCspCoordinates(frame, { signal });
  cache?.set(frame.fractional, { cell: frame.cell, pbc, words });
  return words;
}

/** Upload original CPU-wrapped IEEE64 values; this is input preparation, not
 * neighbor search. The resident linked-cell grid still supplies candidates. */
export async function prepareCspCoordinates(frame, { signal } = {}) {
  const data = new ArrayBuffer(frame.fractional.length * 8), view = new DataView(data);
  for (let index = 0; index < frame.fractional.length; index++) {
    let value = frame.fractional[index];
    if (!Number.isFinite(value)) throw new Error(`Atom ${Math.floor(index / 3) + 1} has a non-finite coordinate.`);
    if (frame.cell.pbc[index % 3]) value -= Math.floor(value);
    view.setFloat64(index * 8, value, true);
    if (index && index % 196_608 === 0) { await yieldWorker(); checkSignal(signal); }
  }
  checkSignal(signal); return new Uint32Array(data);
}

export function prepareCspSettings(frame, { required, neighbors, mode }) {
  const settings = new Uint32Array(22), view = new DataView(settings.buffer);
  settings.set([required, neighbors, mode === 'auto' ? 1 : 0, 0x7fc00000]);
  for (let component = 0; component < 9; component++) view.setFloat64(16 + component * 8, frame.cell.vectors[component], true);
  return settings;
}
