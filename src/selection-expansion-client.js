import { expandSelection, normalizeExpansionOptions } from './analysis/expand-selection.js';
import { yieldToMain } from './task-yield.js';

const abortError = () => new DOMException('Selection expansion was cancelled.', 'AbortError');
const frameKeys = new WeakMap();
let nextFrameKey = 1;

const defaultWorkerFactory = typeof Worker === 'function'
  ? () => new Worker(new URL('./workers/selection-worker.js', import.meta.url), { type: 'module' }) : null;

/** Expand selections in a dedicated Worker so large frames never block input.
 * It holds one CPU budget permit while working. Without Worker support the
 * same algorithm runs on the main thread and yields between blocks. Cancelling
 * terminates the Worker; the next request starts a new one. */
export class SelectionExpansionClient {
  constructor({ cpuBudget = null, createWorker = defaultWorkerFactory } = {}) {
    this.cpuBudget = cpuBudget; this.createWorker = createWorker;
    this.worker = null; this.residentKey = null; this.pending = new Map(); this.nextId = 1;
  }

  async expand(frame, mask, options, { signal, onProgress = () => {} } = {}) {
    const normalized = normalizeExpansionOptions(options);
    if (signal?.aborted) throw abortError();
    const permit = await this.cpuBudget?.acquire(1, { signal });
    try {
      if (signal?.aborted) throw abortError();
      if (!this.createWorker) return await expandSelection(frame, mask, normalized, { signal, pause: yieldToMain, onProgress });
      return await this.request(frame, mask, normalized, { signal, onProgress });
    } finally { permit?.release(); }
  }

  request(frame, mask, options, { signal, onProgress }) {
    const worker = this.ensureWorker();
    let key = frameKeys.get(frame.fractional);
    if (key === undefined) frameKeys.set(frame.fractional, key = nextFrameKey++);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => this.terminate(abortError());
      const settle = callback => value => { signal?.removeEventListener('abort', abort); callback(value); };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject), onProgress });
      signal?.addEventListener('abort', abort, { once: true });
      // Coordinates are copied, never transferred: the frame keeps them.
      const message = { id, type: 'expand', frameKey: key, mask: Uint8Array.from(mask), options };
      if (this.residentKey !== key) Object.assign(message, { fractional: frame.fractional, cell: frame.cell });
      try {
        worker.postMessage(message, [message.mask.buffer]);
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
      if (data.progress) { pending.onProgress(data.progress); return; }
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data.result);
      else { this.residentKey = null; pending.reject(new Error(data.error)); }
    });
    worker.addEventListener('error', event => {
      if (this.worker === worker) this.terminate(new Error(event.message || 'The selection Worker failed.'));
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
}
