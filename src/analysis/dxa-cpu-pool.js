import { estimateDxaMemory } from './dxa.js';
import { validateDxaLocalInput, validateDxaSnapshot } from './dxa-cpu-stages.js';
import { yieldToMain } from '../task-yield.js';

export const DXA_STAGE_KINDS = Object.freeze(['dxaLocal', 'dxaTetrahedra']);
const DXA_INITIAL_HEAP_BYTES = 32 * 1024 ** 2;
const STAGE_CHUNKS = { local: 2048, tetrahedra: 8192 };
const abortError = () => new DOMException('CPU DXA stage cancelled.', 'AbortError');

export function dxaStageInputBytes(stage, input) {
  return stage === 'local' ? input.coordinates.byteLength + 12 * 8
    : ['vertices', 'tetrahedra', 'edges', 'transitions'].reduce((sum, field) => sum + input[field].byteLength, 0);
}

export function chooseDxaStageWorkers(pool, stage, input, { workerCount, memoryBudgetBytes } = {}) {
  const workCount = stage === 'local' ? validateDxaLocalInput(input).atomCount : validateDxaSnapshot(input);
  const atomCount = input.atomCount ?? input.vertexCount;
  const inputBytes = dxaStageInputBytes(stage, input);
  const outputBytes = stage === 'local' ? atomCount * (1 + validateDxaLocalInput(input).neighborWidth) * 4 : workCount * 4;
  const coordinatorBytes = estimateDxaMemory(atomCount);
  const budget = memoryBudgetBytes ?? 1.5 * 1024 ** 3;
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('CPU DXA stage memory budget must be positive and finite.');
  if (workerCount !== undefined && (!Number.isSafeInteger(workerCount) || workerCount < 1)) throw new Error('CPU DXA stage worker count must be a positive integer.');
  // A slot may already have PTM/Voronoi heaps. Account for those, the serial
  // DXA heap/index, private JS transport copies, and merged output together.
  const nativeBytes = stage === 'local' ? atomCount * 128 : inputBytes;
  const slots = [...(pool.slots ?? [])];
  const dxaHeapBytes = slot => slot.moduleHeapBytes?.dxa ?? slot.dxaHeapBytes ?? (slot.dxaWarmed ? DXA_INITIAL_HEAP_BYTES : 0);
  const retainedHeapBytes = slots.reduce((sum, slot) => sum + dxaHeapBytes(slot)
    + (slot.moduleHeapBytes?.ptm ?? (slot.ptmWarmed ? 16 * 1024 ** 2 : 0))
    + (slot.moduleHeapBytes?.voronoi ?? (slot.voronoiWarmed ? 16 * 1024 ** 2 : 0))
    + (slot.residentInputBytes ?? 0), 0);
  // Existing module heaps remain resident and are counted once above. Only
  // new DXA capacity and private transport copies grow with stage degree.
  // Assume the most expensive eligible slots may be assigned after other
  // analyses release them; actual slot affinity then bounds copies to degree.
  const requiredDxaBytes = DXA_INITIAL_HEAP_BYTES + nativeBytes + (stage === 'local' ? inputBytes : 0);
  const incrementalCopies = slots.filter(slot => slot.dxaReservedKey === undefined)
    .map(slot => Math.max(0, requiredDxaBytes - dxaHeapBytes(slot)) + inputBytes);
  for (let i = slots.length; i < pool.limit; i++) incrementalCopies.push(requiredDxaBytes + inputBytes);
  incrementalCopies.sort((a, b) => b - a);
  let count = Math.min(pool.limit, workerCount ?? pool.limit, Math.max(1, Math.ceil(workCount / 4096)),
    Math.ceil(workCount / STAGE_CHUNKS[stage]));
  const heapLimit = Number(pool.environment.performance?.memory?.jsHeapSizeLimit);
  const transportBudget = Number.isFinite(heapLimit) ? heapLimit * .15 : 256 * 1024 ** 2;
  count = Math.min(count, incrementalCopies.length);
  const memoryEstimate = degree => retainedHeapBytes + coordinatorBytes + inputBytes + outputBytes * 2
    + incrementalCopies.slice(0, degree).reduce((sum, value) => sum + value, 0);
  while (count > 1 && (memoryEstimate(count) > budget
    || inputBytes * count + outputBytes * 2 > transportBudget)) count--;
  if (count < 2) throw new Error('The CPU DXA stage cannot fit two parallel Worker copies in its memory/concurrency budget; using the native CPU stage.');
  return { workerCount: count, workCount, inputBytes, outputBytes,
    memoryEstimateBytes: memoryEstimate(count) };
}

/** Use existing resident analysis slots and their shared CPU budget. Each slot
 * gets one complete immutable input, then runs disjoint bounded output chunks.
 */
export async function analyzeDxaStagePool(pool, stage, input, {
  signal, onProgress = () => {}, workerCount, memoryBudgetBytes, taskTimeoutMs = 30_000,
} = {}) {
  if (pool.closed) throw new Error('The analysis pool is closed.');
  if (signal?.aborted) throw abortError();
  if (!Number.isSafeInteger(taskTimeoutMs) || taskTimeoutMs < 1) throw new Error('CPU DXA task timeout must be a positive millisecond count.');
  const selection = chooseDxaStageWorkers(pool, stage, input, { workerCount, memoryBudgetBytes });
  const { workCount, inputBytes } = selection, count = selection.workerCount;
  const kind = stage === 'local' ? 'dxaLocal' : 'dxaTetrahedra';
  const key = `dxa-${stage}-${pool.nextDxaStageKey = (pool.nextDxaStageKey ?? 0) + 1}`;
  const chunkSize = STAGE_CHUNKS[stage], chunkCount = Math.ceil(workCount / chunkSize);
  let nextChunk = 0, completed = 0, completedChunks = 0, copiedBytes = 0, kernelInitializations = 0;
  const startedAt = performance.now(), progress = new Array(count).fill(0);
  const structures = stage === 'local' ? new Int32Array(workCount) : null;
  const neighborWidth = stage === 'local' ? validateDxaLocalInput(input).neighborWidth : 0;
  const neighbors = stage === 'local' ? new Int32Array(workCount * neighborWidth).fill(-1) : null;
  const regions = stage === 'tetrahedra' ? new Int32Array(workCount).fill(-1) : null;
  let maxNeighborDistance = 0;
  // Allocation can throw before any jobs exist. Register cancellation and
  // resident-slot ownership only after all merged outputs are available.
  if (signal?.aborted) throw abortError();
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  pool.controllers.add(controller);
  pool.reserveDxaStage(key, count);
  const report = (index, phase, data) => {
    if (controller.signal.aborted) return;
    if (Number.isFinite(data?.processedAtoms)) progress[index] = data.processedAtoms;
    onProgress({ phase, workerCount: count, completedAtoms: completed + progress.reduce((sum, value) => sum + value, 0),
      totalAtoms: workCount, completedChunks, chunkCount, stage });
  };
  const runners = Array.from({ length: count }, (_, index) => (async () => {
    while (nextChunk < chunkCount) {
      if (controller.signal.aborted) throw abortError();
      const chunk = nextChunk++, startAtom = chunk * chunkSize, endAtom = Math.min(workCount, startAtom + chunkSize);
      let timer;
      const deadline = new AbortController(), cancelChunk = () => deadline.abort();
      controller.signal.addEventListener('abort', cancelChunk, { once: true });
      let timedOut = false;
      try {
        timer = setTimeout(() => { timedOut = true; deadline.abort(); }, taskTimeoutMs);
        const result = await pool.runTask({ kind, dxaStageInput: input, dxaResidentKey: key, startAtom, endAtom },
          deadline.signal, controller.signal, (phase, data) => report(index, phase, data));
        if (controller.signal.aborted) throw abortError();
        if (result.startAtom !== startAtom || result.endAtom !== endAtom) throw new Error('CPU DXA returned an incomplete output range.');
        const length = endAtom - startAtom;
        if (stage === 'local') {
          if (!(result.structures instanceof Int32Array) || result.structures.length !== length
            || !(result.neighbors instanceof Int32Array) || result.neighbors.length !== length * neighborWidth
            || result.neighborWidth !== neighborWidth || !Number.isFinite(result.maxNeighborDistance) || result.maxNeighborDistance < 0
            || result.structures.some(type => type < 0 || type > 5)
            || result.neighbors.some(atom => atom < -1 || atom >= workCount)) throw new Error('CPU DXA returned invalid local crystal rows.');
          structures.set(result.structures, startAtom); neighbors.set(result.neighbors, startAtom * neighborWidth);
          maxNeighborDistance = Math.max(maxNeighborDistance, result.maxNeighborDistance);
        } else {
          if (!(result.regions instanceof Int32Array) || result.regions.length !== length || result.regions.some(value => value !== -1 && value !== 0)) {
            throw new Error('CPU DXA returned invalid interface labels.');
          }
          regions.set(result.regions, startAtom);
        }
        if (result.frameUploaded) copiedBytes += inputBytes;
        if (!result.kernelReused) kernelInitializations++;
        completed += length; completedChunks++; progress[index] = 0;
        report(index, 'complete');
        if (completedChunks % 16 === 0) await yieldToMain();
      } catch (error) {
        if (timedOut) throw new Error(`The CPU DXA ${stage} Worker did not finish its task within ${taskTimeoutMs} ms.`);
        throw error;
      } finally {
        clearTimeout(timer); controller.signal.removeEventListener('abort', cancelChunk);
      }
    }
  })());
  try {
    await Promise.all(runners);
    if (controller.signal.aborted) throw abortError();
    return { ...(stage === 'local' ? { structures, neighbors, neighborWidth, maxNeighborDistance } : { regions }),
      workerCount: pool.dxaStages.get(key)?.peakWorkers || 1,
      elapsedMs: performance.now() - startedAt, inputBytes, copiedBytes, chunkCount, kernelInitializations,
      memoryEstimateBytes: selection.memoryEstimateBytes, backend: 'cpu' };
  } catch (error) {
    controller.abort();
    await Promise.allSettled(runners);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort); pool.controllers.delete(controller);
    pool.releaseDxaStage(key);
  }
}
