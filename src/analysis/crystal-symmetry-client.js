import { validateCrystalSymmetryInput } from './crystal-symmetry.js';

const abortError = () => new DOMException('Crystal symmetry cancelled.', 'AbortError');
const defaultWorkerFactory = () => new Worker(new URL('../workers/crystal-symmetry-worker.js', import.meta.url), { type: 'module' });

/** Global symmetry runs in one retained native Worker sharing the CPU budget.
 * Cancellation settles immediately, but native work keeps its lease until ACK.
 * No source geometry or transferred typed array is ever detached. */
export class CrystalSymmetryClient {
  constructor({ cpuBudget = null, workerFactory = defaultWorkerFactory, timeoutMs = 120_000 } = {}) {
    this.cpuBudget = cpuBudget; this.workerFactory = workerFactory; this.timeoutMs = timeoutMs;
    this.worker = null; this.queue = []; this.active = null; this.nextId = 1; this.closed = false; this.warming = null;
  }
  warm() {
    if (!this.warming) this.warming = this.enqueue('warm', {}).catch(error => { this.warming = null; throw error; });
    return this.warming;
  }
  analyze(frame, options = {}, { signal } = {}) {
    try { validateCrystalSymmetryInput(frame, options); } catch (error) { return Promise.reject(error); }
    return this.enqueue('analyze', { frame, options: { symprec: options.symprec ?? 1e-4 } }, signal);
  }
  enqueue(type, input, signal) {
    if (this.closed || signal?.aborted) return Promise.reject(abortError());
    if (this.queue.length >= 4) return Promise.reject(new Error('Too many queued crystal symmetry requests.'));
    return new Promise((resolve, reject) => {
      const task = { id: this.nextId++, type, ...input, signal, resolve, reject, controller: new AbortController(), settled: false, posted: false };
      task.abort = () => this.cancel(task);
      signal?.addEventListener('abort', task.abort, { once: true });
      this.queue.push(task); this.pump();
    });
  }
  settle(task, error, result) {
    if (task.settled) return;
    task.settled = true; task.signal?.removeEventListener('abort', task.abort);
    if (error) task.reject(error); else task.resolve(result);
  }
  cancel(task) {
    if (!task || task.settled) return;
    task.controller.abort(); this.settle(task, abortError());
    const index = this.queue.indexOf(task);
    if (index >= 0) this.queue.splice(index, 1);
  }
  clear() {
    for (const task of [...this.queue]) this.cancel(task);
    this.cancel(this.active);
  }
  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.workerFactory(); this.worker = worker;
    worker.addEventListener('message', ({ data }) => {
      if (worker !== this.worker || data.id !== this.active?.id) return;
      const task = this.active;
      this.settle(task, data.ok ? null : new Error(data.error || 'Crystal symmetry failed.'), data.result);
      this.finish(task);
    });
    worker.addEventListener('error', event => this.failed(worker, new Error(event.message || 'Crystal symmetry Worker failed.')));
    worker.addEventListener('messageerror', () => this.failed(worker, new Error('Unreadable crystal symmetry Worker reply.')));
    return worker;
  }
  failed(worker, error) {
    if (worker !== this.worker) return;
    this.worker?.terminate(); this.worker = null; this.warming = null;
    if (this.active) { const task = this.active; this.settle(task, error); this.finish(task); }
  }
  finish(task) {
    clearTimeout(task.timer); task.permit?.release(); task.frame = null;
    if (this.active === task) { this.active = null; this.pump(); }
  }
  async pump() {
    if (this.active || this.closed || !this.queue.length) return;
    const task = this.queue.shift(); this.active = task;
    try {
      task.permit = await this.cpuBudget?.acquire(1, { signal: task.controller.signal, priority: task.type === 'warm' ? -1 : 0 });
      if (task.controller.signal.aborted || this.closed) throw abortError();
      const worker = this.ensureWorker();
      const frame = task.frame;
      if (frame) validateCrystalSymmetryInput(frame, task.options);
      // Bounded unit-cell snapshots omit render arrays, properties and caches.
      const snapshot = frame ? { fractional: new Float64Array(frame.fractional), types: new Uint32Array(frame.types),
        typeLabels: [...frame.typeLabels], title: frame.title,
        cell: { vectors: new Float64Array(frame.cell.vectors), pbc: [...frame.cell.pbc] } } : undefined;
      task.posted = true;
      task.timer = setTimeout(() => this.failed(worker, new Error('Crystal symmetry exceeded its time limit. Reduce the cell or adjust the tolerance.')), this.timeoutMs);
      worker.postMessage({ id: task.id, type: task.type, frame: snapshot, options: task.options },
        snapshot ? [snapshot.fractional.buffer, snapshot.types.buffer, snapshot.cell.vectors.buffer] : []);
    } catch (error) { this.settle(task, error); this.finish(task); }
  }
  dispose() {
    this.closed = true; this.clear(); this.worker?.terminate(); this.worker = null; this.warming = null;
    if (this.active) this.finish(this.active);
  }
}
