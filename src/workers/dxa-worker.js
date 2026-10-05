import { calculateDxa, warmupDxa } from '../analysis/dxa.js';

// Deliberately separate from the reusable atom-range worker pool. A native
// topology calculation is synchronous. Isolated clients cancel through the
// module's shared atomic word and keep its heap/pthread pool for the next job.
// Static hosts without shared memory retain termination as their fallback.
let requests = Promise.resolve();
async function handleRequest(data) {
  const { id, frame, parameters, memoryBudgetBytes, workerCount, type } = data;
  try {
    const options = {
      memoryBudgetBytes,
      workerCount,
      // The client clears its known word immediately before posting a new
      // request. Clearing here could erase a concurrent cancellation request.
      resetCancellation: false,
      onControl: control => self.postMessage({ id, control }),
      onProgress: progress => self.postMessage({ id, progress }),
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
  }
}
self.addEventListener('message', ({ data }) => {
  requests = requests.then(() => handleRequest(data));
});
