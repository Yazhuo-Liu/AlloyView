import { calculateDxa, warmupDxa } from '../analysis/dxa.js';

// Deliberately separate from the reusable atom-range worker pool. A native
// topology calculation is synchronous. Isolated clients cancel through the
// module's shared atomic word and keep its heap/pthread pool for the next job.
// Static hosts without shared memory retain termination as their fallback.
let requests = Promise.resolve();
const controllers = new Map();
const gpuRequests = new Map();
let nextGpuRequestId = 1;

function requestGpuStage(id, stage, payload, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(new DOMException('The DXA calculation was cancelled.', 'AbortError'));
  const requestId = nextGpuRequestId++;
  return new Promise((resolve, reject) => {
    const abort = () => {
      gpuRequests.delete(requestId);
      reject(new DOMException('The DXA calculation was cancelled.', 'AbortError'));
    };
    const finish = (error, result) => {
      gpuRequests.delete(requestId);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    gpuRequests.set(requestId, { id, finish });
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const keys = stage === 'local' ? ['coordinates', 'templates', 'inverse'] : ['vertices', 'tetrahedra', 'edges', 'transitions'];
      const transfer = keys.map(key => payload[key].buffer);
      const data = stage === 'local' ? { input: payload } : { snapshot: payload };
      self.postMessage({ id, gpuRequest: { requestId, stage, ...data } }, [...new Set(transfer)]);
    } catch (error) { finish(error); }
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
      gpuSnapshotBudgetBytes: data.gpuSnapshotBudgetBytes,
      gpuBufferLimitBytes: data.gpuBufferLimitBytes,
      // The client clears its known word immediately before posting a new
      // request. Clearing here could erase a concurrent cancellation request.
      resetCancellation: false,
      onControl: control => self.postMessage({ id, control }),
      onProgress: progress => self.postMessage({ id, progress }),
      signal: controller.signal,
      classifyDxa: data.gpuAvailable ? (snapshot, options) => requestGpuStage(id, 'tetrahedra', snapshot, options) : undefined,
      identifyDxa: data.gpuLocalAvailable ? (input, options) => requestGpuStage(id, 'local', input, options) : undefined,
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
  // Replies and cancellation must bypass the serialized analysis queue: the
  // active request is awaiting this reply while retaining its native session.
  if (data.type === 'gpu-result') {
    const pending = gpuRequests.get(data.requestId);
    if (!pending || pending.id !== data.id) return;
    let error;
    if (!data.ok) { error = new Error(data.error || 'WebGPU DXA failed.'); error.name = data.name || 'Error'; }
    pending.finish(error, data.result);
    return;
  }
  if (data.type === 'cancel') { controllers.get(data.id)?.abort(); return; }
  requests = requests.then(() => handleRequest(data));
});
