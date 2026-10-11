import { CpuBudget } from '../analysis/cpu-budget.js';

const aborted = () => new DOMException('Surface geometry preparation was cancelled.', 'AbortError');
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
const COPY_CHUNK = 65536;
const defaults = new WeakMap();
let defaultClient;

/** Main and second views share source snapshots, prepared geometry and a single
 * retained Worker. A snapshot is a private copy: analysis arrays stay owned by
 * their original frame. No device or WebGPU backend is started here. */
export function sharedSurfaceGeometryClient(cpuBudget = null) {
  if (!cpuBudget) return defaultClient ??= new SurfaceGeometryClient();
  if (!defaults.has(cpuBudget)) defaults.set(cpuBudget, new SurfaceGeometryClient({ cpuBudget }));
  return defaults.get(cpuBudget);
}

export class SurfaceGeometryClient {
  constructor({ cpuBudget = new CpuBudget(), workerFactory = null, environment = globalThis, retainedByteBudget = 128 * 1024 ** 2 } = {}) {
    this.cpuBudget = cpuBudget;
    this.workerFactory = workerFactory ?? (typeof environment.Worker === 'function'
      ? () => new environment.Worker(new URL('../workers/surface-geometry-worker.js', import.meta.url), { type: 'module' }) : null);
    this.environment = environment;
    this.retainedByteBudget = retainedByteBudget;
    this.worker = null; this.workerReady = null; this.warming = null;
    this.closed = false; this.warmController = null;
    this.sources = new Map(); this.identities = new WeakMap(); this.jobs = new Map();
    this.queue = []; this.running = null; this.sequence = 0; this.sourceSequence = 0; this.clock = 0;
  }

  get available() { return Boolean(this.workerFactory); }

  /** Module startup overlaps structure loading at background priority, with no
   * frame payload or scientific calculation. Later edits reuse this Worker. */
  warm() {
    if (!this.available || this.closed) return Promise.resolve(false);
    if (this.workerReady?.ready) return Promise.resolve(true);
    if (this.warming) return this.warming;
    const controller = new AbortController(); this.warmController = controller;
    this.warming = (async () => {
      let lease;
      try {
        lease = await this.cpuBudget.acquire(1, { priority: -1, signal: controller.signal });
        if (this.closed) return false;
        this.ensureWorker(); await this.workerReady.promise; return true;
      }
      catch { return false; }
      finally { lease?.release(); this.warming = null; this.warmController = null; }
    })();
    return this.warming;
  }

  source(mesh, cell) {
    let cells = this.identities.get(mesh);
    if (!cells) { cells = new WeakMap(); this.identities.set(mesh, cells); }
    let source = cells.get(cell);
    if (!source) {
      source = { id: ++this.sourceSequence, mesh, cell, owners: 0, pending: 0, uploaded: false, cache: new Map() };
      cells.set(cell, source);
    }
    source.used = ++this.clock; this.sources.set(source.id, source);
    return source;
  }

  retainSource(mesh, cell) {
    const source = this.source(mesh, cell); source.owners++;
    let released = false;
    return () => { if (!released) { released = true; source.owners--; this.sweep(); } };
  }

  sweep() {
    // Keep two recent unowned sources for context restoration and a quick
    // frame revisit; current views and active requests are never evicted.
    const idle = [...this.sources.values()].filter(source => !source.owners && !source.pending).sort((a, b) => b.used - a.used);
    let bytes = [...this.sources.values()].reduce((sum, source) => sum + this.sourceBytes(source), 0);
    for (const source of idle.toReversed()) {
      if (idle.length <= 2 && bytes <= this.retainedByteBudget) break;
      bytes -= this.sourceBytes(source); idle.splice(idle.indexOf(source), 1);
      this.sources.delete(source.id); source.cache.clear(); source.uploaded = false; source.workerBytes = 0;
      this.worker?.postMessage({ type: 'drop', sourceId: source.id });
    }
  }

  sourceBytes(source) {
    // Source descriptors held by this client, actual Worker-side retained
    // buffers (including export-only preparation), and page-side recipe caches.
    let bytes = source.mesh.vertices.byteLength + source.mesh.triangles.byteLength + (source.workerBytes ?? 0);
    for (const result of source.cache.values()) bytes += result.display.positions.byteLength + result.display.normals.byteLength
      + result.display.indices.byteLength + result.values.byteLength;
    return bytes;
  }

  prepare(mesh, cell, options = {}, { signal } = {}) {
    if (signal?.aborted || this.closed) return Promise.reject(aborted());
    const source = this.source(mesh, cell), settings = this.settings(mesh, options), key = JSON.stringify(settings);
    const cached = source.cache.get(key);
    if (signal?.aborted || this.closed) return Promise.reject(aborted());
    if (cached) { source.cache.delete(key); source.cache.set(key, cached); return Promise.resolve(cached); }
    return this.request(source, 'prepare', settings, { signal, key: `${source.id}:${key}`, cacheKey: key });
  }

  export(mesh, cell, options, format, exportOptions, { signal } = {}) {
    if (signal?.aborted || this.closed) return Promise.reject(aborted());
    const source = this.source(mesh, cell);
    return this.request(source, 'export', this.settings(mesh, options), { signal, format, exportOptions });
  }

  settings(mesh, options) {
    return { origin: Array.from(options.origin ?? [0, 0, 0]), caps: options.caps ?? true,
      reverse: Boolean(mesh.reverse), spaceFilling: Boolean(mesh.spaceFilling) };
  }

  request(source, type, settings, { signal, key = null, cacheKey, format, exportOptions } = {}) {
    if (!this.available) return Promise.reject(new Error('Surface geometry Workers are unavailable.'));
    if (signal?.aborted || this.closed) return Promise.reject(aborted());
    let job = key && this.jobs.get(key);
    if (!job || job.controller.signal.aborted) {
      job = { id: ++this.sequence, source, type, settings, key, cacheKey, format, exportOptions,
        controller: new AbortController(), listeners: new Set(), posted: false, lease: null, cancelWord: null };
      source.pending++;
      if (key) this.jobs.set(key, job);
      this.queue.push(job);
    }
    const promise = new Promise((resolve, reject) => {
      const listener = { resolve, reject, signal };
      listener.abort = () => {
        if (!job.listeners.delete(listener)) return;
        signal?.removeEventListener('abort', listener.abort); reject(aborted());
        if (!job.listeners.size) {
          job.controller.abort();
          if (job.cancelWord) Atomics.store(job.cancelWord, 0, 1);
          if (job.posted) this.worker?.postMessage({ type: 'cancel', id: job.id });
          else {
            const queued = this.queue.indexOf(job);
            if (queued >= 0) { this.queue.splice(queued, 1); this.finish(job, null, aborted()); }
          }
        }
      };
      job.listeners.add(listener); signal?.addEventListener('abort', listener.abort, { once: true });
    });
    this.pump();
    return promise;
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.workerFactory(); this.worker = worker;
    const ready = { ready: false };
    ready.promise = new Promise((resolve, reject) => { ready.resolve = resolve; ready.reject = reject; });
    // Ordinary requests can be posted before startup ACK (Worker queues them).
    // Only optional prewarming subscribes to the startup promise.
    ready.promise.catch(() => {}); this.workerReady = ready;
    worker.onmessage = event => { if (worker === this.worker) this.receive(event.data); };
    worker.onerror = event => { if (worker === this.worker) this.failWorker(new Error(event.message || 'Surface geometry Worker failed.')); };
    worker.onmessageerror = () => { if (worker === this.worker) this.failWorker(new Error('Surface geometry Worker returned an unreadable result.')); };
    return worker;
  }

  async snapshot(source, signal) {
    const arrays = {};
    for (const name of ['vertices', 'triangles']) {
      const input = source.mesh[name];
      if (!ArrayBuffer.isView(input) || input instanceof DataView) throw new Error('Surface mesh arrays must be typed arrays.');
      const copy = new input.constructor(input.length);
      for (let first = 0; first < input.length; first += COPY_CHUNK) {
        if (signal.aborted) throw aborted();
        copy.set(input.subarray(first, first + COPY_CHUNK), first);
        if (first + COPY_CHUNK < input.length) await yieldTask();
      }
      arrays[name] = copy;
    }
    if (signal.aborted) throw aborted();
    return arrays;
  }

  async pump() {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) { this.sweep(); return; }
    this.running = job;
    try {
      if (job.controller.signal.aborted) throw aborted();
      job.lease = await this.cpuBudget.acquire(1, { signal: job.controller.signal });
      if (job.finished) { job.lease.release(); return; }
      const worker = this.ensureWorker(), source = job.source;
      const mesh = source.uploaded ? null : await this.snapshot(source, job.controller.signal);
      if (job.controller.signal.aborted) throw aborted();
      // Shared cancellation is checked inside the synchronous topology loops.
      // Without isolation, abort still suppresses publication promptly; the
      // permit remains held until the Worker acknowledges its finished work.
      if (this.environment.crossOriginIsolated && typeof this.environment.SharedArrayBuffer === 'function') {
        job.cancelWord = new Int32Array(new this.environment.SharedArrayBuffer(4));
      }
      job.posted = true;
      worker.postMessage({ id: job.id, type: job.type, sourceId: source.id, mesh, cell: mesh ? source.cell : null,
        settings: job.settings, cancelWord: job.cancelWord, format: job.format, exportOptions: job.exportOptions },
      mesh ? [mesh.vertices.buffer, mesh.triangles.buffer] : []);
    } catch (error) { this.finish(job, null, error); }
  }

  receive(message) {
    if (message.type === 'ready') {
      if (this.workerReady) { this.workerReady.ready = true; this.workerReady.resolve(); }
      return;
    }
    const job = this.running;
    if (!job || message.id !== job.id) return;
    if (message.sourceReady) job.source.uploaded = true;
    if (Number.isFinite(message.residentBytes)) job.source.workerBytes = message.residentBytes;
    if (message.ok && !job.controller.signal.aborted && job.cacheKey) {
      job.source.cache.set(job.cacheKey, message.result);
      while (job.source.cache.size > 2) job.source.cache.delete(job.source.cache.keys().next().value);
    }
    this.finish(job, message.result, message.ok ? null : Object.assign(new Error(message.error?.message || 'Surface geometry preparation failed.'),
      { name: message.error?.name || 'Error' }));
  }

  finish(job, result, error) {
    if (job.finished) return;
    job.finished = true;
    for (const listener of job.listeners) {
      listener.signal?.removeEventListener('abort', listener.abort);
      if (error) listener.reject(error); else listener.resolve(result);
    }
    job.listeners.clear(); job.lease?.release(); job.source.pending--;
    if (job.key && this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    if (this.running === job) this.running = null;
    this.sweep(); void this.pump();
  }

  failWorker(error) {
    this.workerReady?.reject(error); this.workerReady = null;
    this.worker?.terminate(); this.worker = null;
    for (const source of this.sources.values()) { source.uploaded = false; source.workerBytes = 0; source.cache.clear(); }
    if (this.running) this.finish(this.running, null, error);
  }

  close() {
    this.closed = true; this.warmController?.abort();
    this.workerReady?.reject(aborted()); this.workerReady = null;
    this.worker?.terminate(); this.worker = null;
    for (const job of [this.running, ...this.queue].filter(Boolean)) {
      job.finished = true;
      job.controller.abort();
      for (const listener of job.listeners) { listener.signal?.removeEventListener('abort', listener.abort); listener.reject(aborted()); }
      job.listeners.clear(); job.lease?.release(); job.source.pending--;
    }
    this.running = null; this.queue = []; this.jobs.clear();
    for (const source of this.sources.values()) { source.uploaded = false; source.workerBytes = 0; source.cache.clear(); }
    this.sources.clear();
  }
}
