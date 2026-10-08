import { PTM_MAX_NEIGHBORS } from '../ptm.js';
import { adaptiveCnaInitialRadius, MAX_GPU_CNA_RADIUS_ATTEMPTS } from './cna.js';
import { exactCoordinateWords } from './centrosymmetry.js';
import { checkSignal, GpuUnavailableError, yieldWorker } from './runtime.js';
import { PTM_NEIGHBORS_SHADER, PTM_NEIGHBOR_ROW_WORDS } from './ptm-neighbors-shaders.js';

export const MAX_GPU_PTM_NEIGHBOR_BYTES = 256 * 1024 ** 2;
export const GPU_PTM_NEIGHBOR_BATCH_ATOMS = 16_384;
const TABLE_BYTES_PER_ATOM = 1 + PTM_MAX_NEIGHBORS * (Uint32Array.BYTES_PER_ELEMENT + 3 * Float64Array.BYTES_PER_ELEMENT);

/** Generate a complete immutable graph for CPU PTM callbacks. Batch storage
 * bounds GPU/readback memory while exact ordering stays entirely on the GPU.
 */
export async function analyzeGpuPtmNeighbors(runtime, frame, parameters = {}, { signal, onProgress = () => {} } = {}) {
  checkSignal(signal);
  const startedAt = performance.now(), count = frame.fractional.length / 3;
  if (!Number.isInteger(count) || count < 1) throw new Error('Analysis requires at least one atom.');
  if ((parameters.startAtom !== undefined && parameters.startAtom !== 0)
      || (parameters.endAtom !== undefined && parameters.endAtom !== count)) {
    throw new Error('GPU PTM neighbors require the complete source frame, including neighbors of neighbors.');
  }
  if (count * TABLE_BYTES_PER_ATOM > MAX_GPU_PTM_NEIGHBOR_BYTES) {
    throw new GpuUnavailableError('The prepared PTM neighbor table exceeds the GPU readback memory budget.');
  }
  const releasePins = runtime.pinFrames?.([frame]);
  const owned = [], own = buffer => { owned.push(buffer); return buffer; };
  const progress = (phase, completedAtoms = 0) => onProgress({ phase, stage: 'ptm-neighbors', completedAtoms, totalAtoms: count, workerCount: 1 });
  try {
    progress('preparing'); checkSignal(signal);
    const required = frame.cell.pbc.some(Boolean) ? PTM_MAX_NEIGHBORS : Math.min(PTM_MAX_NEIGHBORS, count - 1);
    let radius = adaptiveCnaInitialRadius(frame), context = await runtime.prepareNeighbors(frame, radius, { signal });
    const counts = new Uint8Array(count), indices = new Uint32Array(count * PTM_MAX_NEIGHBORS), vectors = new Float64Array(count * PTM_MAX_NEIGHBORS * 3);
    const complete = new Uint8Array(count), batchAtoms = Math.min(GPU_PTM_NEIGHBOR_BATCH_ATOMS, count);
    // Two bounded row slots: the next batch runs while this one is decoded.
    const rowSlots = Array.from({ length: count > batchAtoms ? 2 : 1 },
      () => own(runtime.createBuffer(batchAtoms * PTM_NEIGHBOR_ROW_WORDS * Uint32Array.BYTES_PER_ELEMENT)));
    const sourceBuffer = own(runtime.storageBuffer(await exactCoordinateWords(runtime, frame, { signal })));
    const settings = preparePtmNeighborSettings(frame, required), settingsBuffer = own(runtime.storageBuffer(settings));
    const resolvedBuffer = own(runtime.createBuffer(count * Uint32Array.BYTES_PER_ELEMENT));
    let completed = 0, radiusAttempts = 0;
    for (; radiusAttempts < MAX_GPU_CNA_RADIUS_ATTEMPTS; radiusAttempts++) {
      if (radiusAttempts) context = await runtime.prepareNeighbors(frame, radius, { signal });
      const starts = [];
      for (let start = 0; start < count; start += batchAtoms) {
        if (!complete.subarray(start, Math.min(start + batchAtoms, count)).every(Boolean)) starts.push(start);
      }
      // Batch bounds reach the shader through queue-ordered settings writes.
      const launch = async index => {
        checkSignal(signal);
        const start = starts[index], end = Math.min(start + batchAtoms, count), rowsBuffer = rowSlots[index % rowSlots.length];
        runtime.write(settingsBuffer, new Uint32Array([start, end - start]), 4);
        await runtime.run(PTM_NEIGHBORS_SHADER, runtime.neighborBindings(context, [rowsBuffer, sourceBuffer, settingsBuffer, resolvedBuffer]), end - start,
          { signal, startAtom: start, endAtom: end, batchSize: 0, wait: false });
        const readback = runtime.read(rowsBuffer, Uint32Array, (end - start) * PTM_NEIGHBOR_ROW_WORDS, { signal });
        readback.catch(() => {});
        return { start, end, readback };
      };
      let pending = starts.length ? await launch(0) : null;
      for (let index = 1; pending; index++) {
        const following = index < starts.length ? await launch(index) : null;
        const { start, end } = pending, data = await pending.readback;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let atom = start; atom < end; atom++) {
          const row = (atom - start) * PTM_NEIGHBOR_ROW_WORDS;
          if (data[row + 1]) throw new GpuUnavailableError('The PTM neighbor candidate search exceeds the GPU per-atom budget.');
          if (complete[atom] || data[row + 2] !== 1) continue;
          const length = data[row];
          if (length !== 0 && length !== required) throw new GpuUnavailableError('The GPU PTM neighbor table contains an incomplete row.');
          complete[atom] = 1; completed++; counts[atom] = length;
          for (let neighbor = 0; neighbor < length; neighbor++) {
            const source = row + 4 + neighbor * 7, target = atom * PTM_MAX_NEIGHBORS + neighbor;
            indices[target] = data[source];
            for (let axis = 0; axis < 3; axis++) vectors[target * 3 + axis] = view.getFloat64((source + 1 + axis * 2) * 4, true);
          }
        }
        progress('analyzing', completed); checkSignal(signal);
        pending = following;
        if (pending) await yieldWorker();
      }
      if (completed === count) { radiusAttempts++; break; }
      radius *= 1.6; await yieldWorker(); checkSignal(signal);
    }
    if (completed !== count) throw new GpuUnavailableError('The GPU PTM neighbor search could not resolve this cell geometry.');
    checkSignal(signal); progress('complete', count);
    return { counts, indices, vectors, maxNeighbors: PTM_MAX_NEIGHBORS, startAtom: 0, endAtom: count,
      gpuCorrectionAtoms: 0, gpuRadiusAttempts: radiusAttempts, gpuArithmetic: 'ieee754-f64-ordering', elapsedMs: performance.now() - startedAt };
  } finally { runtime.disposeBuffers(owned); releasePins?.(); }
}

export function preparePtmNeighborSettings(frame, required) {
  const words = new Uint32Array(24), view = new DataView(words.buffer);
  words.set([required, 0, 0, 0]);
  for (let component = 0; component < 9; component++) view.setFloat64(16 + component * 8, frame.cell.vectors[component], true);
  view.setFloat64(88, 1e-20, true);
  return words;
}
