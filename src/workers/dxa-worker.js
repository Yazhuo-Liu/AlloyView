import { calculateDxa } from '../analysis/dxa.js';

// Deliberately separate from the reusable atom-range worker pool. A native
// topology calculation is synchronous, so its client cancels by terminating
// this Worker instead of queuing an unreadable cancellation message.
self.addEventListener('message', async ({ data }) => {
  const { id, frame, parameters, memoryBudgetBytes } = data;
  try {
    const result = await calculateDxa(frame, parameters, {
      memoryBudgetBytes,
      onProgress: progress => self.postMessage({ id, progress }),
    });
    const buffers = result.segments.map(segment => segment.points.buffer);
    if (result.atomStructureTypes) buffers.push(result.atomStructureTypes.buffer);
    buffers.push(result.cell.vectors.buffer, result.cell.origin.buffer);
    self.postMessage({ id, ok: true, result }, [...new Set(buffers)]);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error), name: error?.name ?? 'Error',
      fatal: error instanceof WebAssembly.RuntimeError });
  }
});
