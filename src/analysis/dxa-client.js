import { preflightDxaMemory, validateDxaFrame, validateDxaParameters } from './dxa.js';

const COPY_CHUNK_VALUES = 512 * 1024;
const abortError = () => new DOMException('The DXA calculation was cancelled.', 'AbortError');

/** DXA is a whole-frame topology calculation, rather than atom-range work.
 * Its synchronous Wasm call cannot receive a cancel message while executing.
 * Terminating this dedicated Worker makes cancellation immediate and releases
 * its global graph workspace; the next request creates a fresh Worker.
 */
export class DxaClient {
  constructor({ workerFactory = () => new Worker(new URL('../workers/dxa-worker.js', import.meta.url), { type: 'module' }),
    memoryBudgetBytes, workerCount, yieldToMain = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
    this.workerFactory = workerFactory;
    this.memoryBudgetBytes = memoryBudgetBytes;
    this.workerCount = workerCount;
    this.yieldToMain = yieldToMain;
    this.worker = null;
    this.pending = new Map();
    this.queue = [];
    this.current = null;
    this.nextId = 1;
    this.closed = false;
  }

  analyze(frame, parameters = {}, { signal, onProgress = () => {} } = {}) {
    if (signal?.aborted || this.closed) return Promise.reject(abortError());
    let settings, count;
    try {
      settings = validateDxaParameters(parameters);
      count = validateDxaFrame(frame, { validateCoordinates: false });
      preflightDxaMemory(count, this.memoryBudgetBytes);
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const task = { id: this.nextId++, frame, parameters: settings, count, signal, onProgress, resolve, reject, settled: false };
      task.abort = () => this.cancel(task);
      signal?.addEventListener('abort', task.abort, { once: true });
      this.pending.set(task.id, task); this.queue.push(task); this.pump();
    });
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    this.worker = worker;
    worker.addEventListener('message', ({ data }) => {
      if (this.worker !== worker) return;
      const task = this.current;
      if (!task || task.id !== data.id || task.settled) return;
      if (data.progress) {
        try { task.onProgress({ backend: 'cpu', workerCount: 1, ...data.progress }); }
        catch (error) { this.settle(task, error); this.terminateWorker(); this.current = null; this.pump(); }
        return;
      }
      if (data.ok) this.settle(task, null, data.result);
      else { const error = new Error(data.error || 'DXA calculation failed.'); error.name = data.name || 'Error'; this.settle(task, error); }
      if (data.fatal) this.terminateWorker();
      this.current = null; this.pump();
    });
    const fail = event => {
      if (this.worker !== worker) return;
      const error = new Error(event.message || 'The DXA worker failed.');
      if (this.current) this.settle(this.current, error);
      this.terminateWorker(); this.current = null; this.pump();
    };
    worker.addEventListener('error', fail); worker.addEventListener('messageerror', fail);
    return worker;
  }

  pump() {
    if (this.current || this.closed) return;
    const task = this.queue.shift();
    if (!task) return;
    if (task.settled) { this.pump(); return; }
    this.current = task;
    void this.dispatch(task);
  }

  async dispatch(task) {
    try {
      task.onProgress({ phase: 'preparing', completedAtoms: 0, totalAtoms: task.count, backend: 'cpu', workerCount: 1 });
      await this.yieldToMain();
      if (task.settled || this.current !== task) return;
      const source = task.frame.fractional ?? task.frame.positions;
      const coordinates = new Float64Array(source.length);
      for (let offset = 0; offset < source.length; offset += COPY_CHUNK_VALUES) {
        coordinates.set(source.subarray ? source.subarray(offset, offset + COPY_CHUNK_VALUES) : source.slice(offset, offset + COPY_CHUNK_VALUES), offset);
        if (offset + COPY_CHUNK_VALUES < source.length) {
          await this.yieldToMain();
          if (task.settled || this.current !== task) return;
        }
      }
      const frame = { [task.frame.fractional ? 'fractional' : 'positions']: coordinates,
        cell: { vectors: Float64Array.from(task.frame.cell.vectors), origin: Float64Array.from(task.frame.cell.origin), pbc: Array.from(task.frame.cell.pbc, Boolean) } };
      const worker = this.ensureWorker();
      if (task.settled || this.current !== task) return;
      worker.postMessage({ id: task.id, frame, parameters: task.parameters, memoryBudgetBytes: this.memoryBudgetBytes, workerCount: this.workerCount },
        [coordinates.buffer, frame.cell.vectors.buffer, frame.cell.origin.buffer]);
      task.dispatched = true;
    } catch (error) {
      if (task.settled || this.current !== task) return;
      this.settle(task, error); this.current = null; this.pump();
    }
  }

  settle(task, error, result) {
    if (task.settled) return;
    task.settled = true; task.signal?.removeEventListener('abort', task.abort); this.pending.delete(task.id);
    task.frame = null;
    if (error) task.reject(error); else task.resolve(result);
  }

  cancel(task = this.current) {
    if (!task || task.settled) return;
    this.settle(task, abortError());
    if (this.current === task) {
      this.terminateWorker(); this.current = null; this.pump();
    } else {
      const index = this.queue.indexOf(task); if (index >= 0) this.queue.splice(index, 1);
    }
  }

  terminateWorker() { this.worker?.terminate(); this.worker = null; }

  clearFrames() {
    // A source reset aborts queued work as well as the running source before a
    // new structure can be accepted. Do not accidentally pump the old queue.
    const tasks = [...this.pending.values()]; this.queue.length = 0;
    for (const task of tasks) this.settle(task, abortError());
    this.current = null; this.terminateWorker();
    return Promise.resolve();
  }

  reset() { return this.clearFrames(); }
  release() { return this.clearFrames(); }
  close() { this.closed = true; return this.clearFrames(); }
}
