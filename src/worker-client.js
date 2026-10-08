import { normalizeLocalFiles } from './io/local-files.js';
import { cpuWorkerLimit } from './analysis/cpu-budget.js';

const cancelled = () => new DOMException('Structure request cancelled.', 'AbortError');

export class StructureWorkerClient {
  constructor(onProgress = () => {}, { cpuBudget, onSourceInfo = () => {} } = {}) {
    this.onProgress = onProgress;
    this.onSourceInfo = onSourceInfo;
    this.cpuBudget = cpuBudget;
    this.cpuLeases = new Map();
    this.nextId = 1;
    this.pending = new Map();
    this.sourceInfo = null;
    this.loadId = null;
    this.sourceGeneration = 0;
    this.replicationControllers = new Set();
    this.createWorker();
  }

  attachWorker(worker) {
    worker.addEventListener('message', (event) => {
      if (worker === this.worker || worker === this.replicationWorker) this.handleMessage(event.data, worker);
    });
    worker.addEventListener('error', (event) => {
      if (worker !== this.worker && worker !== this.replicationWorker) return;
      for (const [id, pending] of this.pending) {
        if (pending.worker !== worker) continue;
        this.pending.delete(id);
        this.cleanup(pending);
        pending.reject(new Error(event.message || 'The Worker failed.'));
      }
      if (worker === this.worker) this.clearCpuLeases();
    });
  }

  createWorker() {
    this.worker = new Worker(new URL('./workers/structure-worker.js', import.meta.url), { type: 'module' });
    this.attachWorker(this.worker);
  }

  request(type, payload, { reportProgress = true, background = false, signal, worker, onProgress, lease } = {}) {
    if (signal?.aborted) { lease?.release(); return Promise.reject(cancelled()); }
    if (!worker && !this.worker) this.createWorker();
    const target = worker ?? this.worker;
    const id = this.nextId++;
    if (type === 'load') this.loadId = id;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, reportProgress, background, signal, worker: target, onProgress, lease };
      pending.abort = () => {
        if (pending.aborted || !this.pending.has(id)) return;
        pending.aborted = true;
        pending.signal?.removeEventListener?.('abort', pending.abort);
        // Replication yields cooperatively. Keep its CPU permit until the
        // cancellation ACK; rejecting the caller does not stop the current
        // numeric chunk or source-ID validation loop immediately.
        if (!pending.lease) { this.pending.delete(id); this.cleanup(pending); }
        target.postMessage({ type: 'cancel-frame', payload: { id } });
        reject(cancelled());
      };
      this.pending.set(id, pending);
      signal?.addEventListener?.('abort', pending.abort, { once: true });
      try { target.postMessage({ id, type, payload }); }
      catch (error) { this.pending.delete(id); this.cleanup(pending); reject(error); }
    });
  }

  load(input) {
    this.sourceGeneration++;
    for (const controller of this.replicationControllers) controller.abort();
    const files = normalizeLocalFiles(input);
    this.sourceInfo = null;
    // Retain the single-file field for a previously cached Worker version.
    return this.request('load', { files, file: files.length === 1 ? files[0] : undefined,
      incremental: true, cpuBudget: Boolean(this.cpuBudget),
      parserConcurrency: Math.max(1, Math.min(4, (this.cpuBudget?.limit ?? cpuWorkerLimit()) - 1)) });
  }

  frame(index, { reportProgress = true, background = !reportProgress, signal } = {}) {
    return this.request('frame', { index, background }, { reportProgress, background, signal });
  }

  waitForIndex({ signal } = {}) { return this.request('index-complete', {}, { reportProgress: false, signal }); }

  cancelPrefetch() {
    this.worker?.postMessage({ type: 'cancel-prefetch' });
    for (const pending of [...this.pending.values()]) if (pending.background) pending.abort();
  }

  async replicate(frame, repetitions, { signal, onProgress, background = false } = {}) {
    const controller = new AbortController();
    const generation = this.sourceGeneration;
    this.replicationControllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener?.('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    let lease;
    try {
      lease = await this.cpuBudget?.acquire(1, { signal: controller.signal, priority: background ? -20 : 20 });
      if (controller.signal.aborted || signal?.aborted || generation !== this.sourceGeneration) throw cancelled();
      if (!this.replicationWorker) {
        this.replicationWorker = new Worker(new URL('./workers/replication-worker.js', import.meta.url), { type: 'module' });
        this.attachWorker(this.replicationWorker);
      }
      const ownedLease = lease;
      lease = null;
      const result = await this.request('replicate', { frame, repetitions }, {
        worker: this.replicationWorker, signal: controller.signal, onProgress, background, reportProgress: false, lease: ownedLease,
      });
      if (signal?.aborted) throw cancelled();
      return result.frame;
    } finally {
      lease?.release();
      this.replicationControllers.delete(controller);
      signal?.removeEventListener?.('abort', abort);
    }
  }

  coordination(frame, cutoff) {
    return this.request('analyze-coordination', { fractional: frame.fractional, cell: frame.cell, cutoff });
  }

  cleanup(pending) {
    pending.signal?.removeEventListener?.('abort', pending.abort);
    pending.lease?.release();
  }

  async acquireCpu(message, worker) {
    const controller = new AbortController();
    const request = { controller, lease: null };
    this.cpuLeases.set(message.leaseId, request);
    try {
      request.lease = await this.cpuBudget.acquire(1, { signal: controller.signal, priority: message.priority ?? (message.background ? -20 : 20) });
      if (worker !== this.worker || controller.signal.aborted) { request.lease.release(); return; }
      worker.postMessage({ type: 'cpu-granted', payload: { leaseId: message.leaseId } });
    } catch (error) {
      if (worker === this.worker) worker.postMessage({ type: 'cpu-denied', payload: { leaseId: message.leaseId, error: error.message, name: error.name } });
    }
  }

  clearCpuLeases() {
    for (const request of this.cpuLeases.values()) { request.controller.abort(); request.lease?.release(); }
    this.cpuLeases.clear();
  }

  handleMessage(message, worker = this.worker) {
    if (message.event === 'cpu-acquire') {
      if (this.cpuBudget) void this.acquireCpu(message, worker);
      return;
    }
    if (message.event === 'cpu-cancel' || message.event === 'cpu-release') {
      const request = this.cpuLeases.get(message.leaseId);
      if (request) { request.controller.abort(); request.lease?.release(); this.cpuLeases.delete(message.leaseId); }
      return;
    }
    if (message.event === 'source-info') {
      if (message.loadId !== this.loadId) return;
      this.sourceInfo = message.result;
      this.onSourceInfo(message.result);
      return;
    }
    const pending = this.pending.get(message.id);
    if (message.event === 'progress' || message.event === 'replication-progress') {
      if (pending?.aborted) return;
      if (pending?.onProgress) pending.onProgress(message);
      else if (pending?.reportProgress) this.onProgress(message);
      return;
    }
    if (!pending) return;
    this.pending.delete(message.id);
    this.cleanup(pending);
    if (pending.aborted) return;
    if (message.ok) pending.resolve(message.result);
    else pending.reject(Object.assign(new Error(message.error), { name: message.name ?? 'Error' }));
  }

  reset() {
    this.sourceGeneration++;
    for (const controller of this.replicationControllers) controller.abort();
    this.replicationControllers.clear();
    this.worker?.terminate();
    this.replicationWorker?.terminate();
    this.worker = null;
    this.replicationWorker = null;
    this.loadId = null;
    this.sourceInfo = null;
    this.clearCpuLeases();
    for (const pending of this.pending.values()) { this.cleanup(pending); pending.reject(cancelled()); }
    this.pending.clear();
  }

  close() { this.reset(); }
}
