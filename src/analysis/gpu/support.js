import { yieldToEventLoop as yieldWorker } from '../../shared/task-yield.js';

/** Helpers every GPU kernel shares with the runtime: cancellation checks,
 * the unavailability errors that route an analysis to CPU Workers, batched
 * buffer reads and Worker yielding. Kernels import these rather than
 * runtime.js, so the runtime can load kernels lazily without a cycle. */

export { yieldWorker };

export function gpuInputUnsupported(message, code) {
  const error = new GpuUnavailableError(message);
  error.gpuUnsupportedScope = 'input-revision'; error.gpuUnsupportedCode = code;
  return error;
}

export class GpuUnavailableError extends Error {
  constructor(message, unsupportedCode) {
    super(message); this.name = 'GpuUnavailableError';
    if (unsupportedCode) { this.gpuUnsupportedCode = unsupportedCode; this.gpuUnsupportedScope = 'cell-cutoff'; }
  }
}

export class GpuDeviceLostError extends GpuUnavailableError {
  constructor(message) { super(message); this.name = 'GpuDeviceLostError'; this.gpuDeviceLost = true; }
}

export function checkSignal(signal) {
  if (signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
}

/** Read several `{ buffer, Type, length, offset }` ranges with one staging
 * mapping. Runtimes that only implement `read` are read sequentially. */
export async function readGpuBuffers(runtime, requests, options = {}) {
  if (typeof runtime.readMany === 'function') return runtime.readMany(requests, options);
  const values = [];
  for (const { buffer, Type, length, offset = 0 } of requests) {
    values.push(await runtime.read(buffer, Type, length, offset ? { ...options, offset } : options));
  }
  return values;
}

// Frame identities for GPU residency: positive serials are assigned by the
// runtime when a frame is keyed, negative ones by Voronoi for frames it
// prepares without an upload. One counter keeps them distinct.
let frameSerial = 0;
export function nextGpuFrameSerial() { return ++frameSerial; }
