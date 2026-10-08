import { accumulateSpatialBins } from './analysis/spatial-binning.js';

/** Frames with more atoms bin in a Worker; smaller ones finish on the main
 * thread in about a millisecond, faster than copying them to a Worker. */
export const BINNING_WORKER_MIN_ATOMS = 250_000;

const abortError = () => new DOMException('Spatial binning was cancelled.', 'AbortError');
const frameKeys = new WeakMap();
let nextFrameKey = 1;

const defaultWorkerFactory = typeof Worker === 'function'
  ? () => new Worker(new URL('./workers/binning-worker.js', import.meta.url), { type: 'module' }) : null;

/** One dedicated Worker that keeps the last frame's reduced coordinates. Both
 * paths run the same kernel on the same inputs in the same order, so their
 * results are identical. A large job holds one CPU budget permit; cancelling
 * terminates the Worker and the next request starts a new one. Source arrays
 * are copied, never transferred. */
export class SpatialBinningClient {
  constructor({ cpuBudget = null, createWorker = defaultWorkerFactory, workerMinAtoms = BINNING_WORKER_MIN_ATOMS } = {}) {
    this.cpuBudget = cpuBudget; this.createWorker = createWorker; this.workerMinAtoms = workerMinAtoms;
    this.worker = null; this.residentKey = null; this.pending = new Map(); this.nextId = 1;
  }

  /** Start the Worker before the first large request (prewarming). */
  warm() { if (this.createWorker) this.ensureWorker(); }

  usesWorker(frame) { return Boolean(this.createWorker) && (frame?.fractional?.length ?? 0) / 3 >= this.workerMinAtoms; }

  async accumulate(frame, request, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    if (!this.usesWorker(frame)) return accumulateSpatialBins(frame, request);
    const permit = await this.cpuBudget?.acquire(1, { signal });
    try {
      if (signal?.aborted) throw abortError();
      return await this.request(frame, request, { signal });
    }
    finally { permit?.release(); }
  }

  request(frame, request, { signal }) {
    const worker = this.ensureWorker();
    let key = frameKeys.get(frame.fractional);
    if (key === undefined) frameKeys.set(frame.fractional, key = nextFrameKey++);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => this.terminate(abortError());
      const settle = callback => value => { signal?.removeEventListener('abort', abort); callback(value); };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      signal?.addEventListener('abort', abort, { once: true });
      const message = { id, type: 'bin', frameKey: key, request };
      if (this.residentKey !== key) Object.assign(message, { fractional: frame.fractional, cell: { vectors: frame.cell.vectors, pbc: frame.cell.pbc } });
      try {
        worker.postMessage(message);
        this.residentKey = key;
      } catch (error) { this.pending.get(id)?.reject(error); this.pending.delete(id); }
    });
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.worker = worker;
    worker.addEventListener('message', ({ data }) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data.result);
      else { this.residentKey = null; pending.reject(new Error(data.error)); }
    });
    worker.addEventListener('error', event => {
      if (this.worker === worker) this.terminate(new Error(event.message || 'The binning Worker failed.'));
    });
    return worker;
  }

  terminate(reason = abortError()) {
    this.worker?.terminate();
    this.worker = null; this.residentKey = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.reject(reason);
  }

  dispose() { this.terminate(); }
}
