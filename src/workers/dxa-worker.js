import { calculateDxa, warmupDxa } from '../analysis/dxa.js';

// Deliberately separate from the reusable atom-range worker pool. A native
// topology calculation is synchronous. Isolated clients cancel through the
// module's shared atomic word and keep its heap/pthread pool for the next job.
// Static hosts without shared memory retain termination as their fallback.
let requests = Promise.resolve();
const controllers = new Map();
const cpuStageRequests = new Map();
let nextCpuStageId = 1;

function requestCpuStage(id, stage, input, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(new DOMException('CPU DXA stage cancelled.', 'AbortError'));
  const requestId = nextCpuStageId++;
  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      cpuStageRequests.delete(requestId); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new DOMException('CPU DXA stage cancelled.', 'AbortError'));
    cpuStageRequests.set(requestId, { id, finish });
    signal?.addEventListener('abort', abort, { once: true });
    const fields = stage === 'local' ? ['coordinates'] : ['vertices', 'tetrahedra', 'edges', 'transitions'];
    try { self.postMessage({ id, cpuStageRequest: { requestId, stage, input } }, fields.map(field => input[field].buffer)); }
    catch (error) { finish(error); }
  });
}

async function handleRequest(data) {
  const { id, frame, parameters, memoryBudgetBytes, workerCount, type } = data;
  const controller = new AbortController();
  controllers.set(id, controller);
  try {
    const options = {
      memoryBudgetBytes,
      workerCount,
      // The client clears its known word immediately before posting a new
      // request. Clearing here could erase a concurrent cancellation request.
      resetCancellation: false,
      onControl: control => self.postMessage({ id, control }),
      onProgress: progress => self.postMessage({ id, progress }),
      signal: controller.signal,
      runCpuStage: data.cpuOffload ? (stage, input, options) => requestCpuStage(id, stage, input, options) : undefined,
    };
    if (type === 'warmup') {
      const result = await warmupDxa({ ...options, atomCount: data.atomCount });
      self.postMessage({ id, ok: true, result });
      return;
    }
    const result = await calculateDxa(frame, parameters, options);
    const buffers = result.segments.map(segment => segment.points.buffer);
    if (result.atomStructureTypes) buffers.push(result.atomStructureTypes.buffer);
    buffers.push(result.cell.vectors.buffer, result.cell.origin.buffer);
    self.postMessage({ id, ok: true, result }, [...new Set(buffers)]);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error), name: error?.name ?? 'Error',
      fatal: error instanceof WebAssembly.RuntimeError });
  } finally {
    controllers.delete(id);
  }
}
self.addEventListener('message', ({ data }) => {
  if (data.type === 'cpu-stage-result') {
    const request = cpuStageRequests.get(data.requestId);
    if (!request || request.id !== data.id) return;
    let error;
    if (!data.ok) { error = new Error(data.error || 'CPU DXA stage failed.'); error.name = data.name || 'Error'; }
    request.finish(error, data.result);
    return;
  }
  // Cancellation bypasses the queue while startup/pool preparation is awaiting
  // asynchronous work. Native calculations use the client's atomic control.
  if (data.type === 'cancel') { controllers.get(data.id)?.abort(); return; }
  if (data.type !== 'warmup' && data.type !== 'analyze') return;
  requests = requests.then(() => handleRequest(data));
});
