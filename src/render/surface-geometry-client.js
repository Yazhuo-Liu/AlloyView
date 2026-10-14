import { CpuBudget } from '../analysis/cpu-budget.js';

const aborted = () => new DOMException('Surface geometry preparation was cancelled.', 'AbortError');
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
const COPY_CHUNK = 65536;
const defaults = new WeakMap();
let defaultClient;

/** Analysis meshes are immutable. Public callers editing their arrays in place
 * increment geometryRevision before setting the mesh again; array replacement
 * and cell edits are detected without scanning vertex/triangle values. */
export function surfaceGeometrySourceKey(mesh, cell) {
  const revision = mesh.geometryRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Surface geometryRevision must be a nonnegative safe integer.');
  return JSON.stringify([revision, Array.from(cell.origin), Array.from(cell.vectors), Array.from(cell.pbc)]);
}

// Walk retained containers only when a source/cache changes. Typed views are
// leaves: their full allocations count, without enumerating atom/mesh values.
function retainedBuffers(roots) {
  const buffers = new Set(), visited = new Set(), pending = [roots];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    if (ArrayBuffer.isView(value)) { buffers.add(value.buffer); continue; }
    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer)) {
      buffers.add(value); continue;
    }
    if (value instanceof Map) for (const [key, entry] of value) pending.push(key, entry);
    else if (value instanceof Set || Array.isArray(value)) for (const entry of value) pending.push(entry);
    else for (const entry of Object.values(value)) pending.push(entry);
  }
  return buffers;
}

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
    this.bufferOwners = new Map(); this.pageBytes = 0;
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
    const sourceKey = surfaceGeometrySourceKey(mesh, cell);
    let cells = this.identities.get(mesh);
    if (!cells) { cells = new WeakMap(); this.identities.set(mesh, cells); }
    let source = cells.get(cell);
    if (!source || source.sourceKey !== sourceKey || source.vertices !== mesh.vertices || source.triangles !== mesh.triangles) {
      source = { id: ++this.sourceSequence, mesh, cell, sourceKey, vertices: mesh.vertices, triangles: mesh.triangles,
        owners: 0, pending: 0, uploaded: false, cache: new Map() };
      cells.set(cell, source);
    }
    source.used = ++this.clock;
    if (!this.sources.has(source.id)) { this.sources.set(source.id, source); this.refreshRetainedBuffers(source); }
    return source;
  }

  sourceCurrent(source) {
    return source.sourceKey === surfaceGeometrySourceKey(source.mesh, source.cell)
      && source.vertices === source.mesh.vertices && source.triangles === source.mesh.triangles;
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
    let bytes = this.retainedBytes();
    for (const source of idle.toReversed()) {
      if (idle.length <= 2 && bytes <= this.retainedByteBudget) break;
      idle.splice(idle.indexOf(source), 1);
      this.sources.delete(source.id); source.cache.clear(); source.uploaded = false; source.workerBytes = 0;
      this.refreshRetainedBuffers(source, false);
      this.worker?.postMessage({ type: 'drop', sourceId: source.id });
      bytes = this.retainedBytes();
    }
  }

  sourceBytes(source) {
    // Source descriptors held by this client, actual Worker-side retained
    // buffers (including export-only preparation), and page-side recipe caches.
    return (source.pageBytes ?? 0) + (source.workerBytes ?? 0);
  }

  retainedBytes() {
    // Views and recipes can refer to the same mesh, cells or backing buffers.
    // Count each page allocation once, including analysis metadata retained by
    // the mesh object and the complete allocations behind sliced views. The
    // Worker's private allocations are independent of those page buffers.
    return this.pageBytes + [...this.sources.values()].reduce((sum, source) => sum + (source.workerBytes ?? 0), 0);
  }

  refreshRetainedBuffers(source, retained = true) {
    const previous = source.buffers ?? new Set(), next = retained
      ? retainedBuffers([source.mesh, source.cell, source.cache, source.vertices, source.triangles]) : new Set();
    for (const buffer of previous) if (!next.has(buffer)) {
      const record = this.bufferOwners.get(buffer);
      if (--record.owners === 0) { this.bufferOwners.delete(buffer); this.pageBytes -= record.bytes; }
    }
    for (const buffer of next) if (!previous.has(buffer)) {
      let record = this.bufferOwners.get(buffer);
      if (!record) {
        record = { owners: 0, bytes: buffer.byteLength }; this.bufferOwners.set(buffer, record); this.pageBytes += record.bytes;
      }
      record.owners++;
    }
    source.buffers = next;
    source.pageBytes = [...next].reduce((sum, buffer) => sum + buffer.byteLength, 0);
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
      if (!this.sourceCurrent(source)) throw aborted();
      const mesh = source.uploaded ? null : await this.snapshot(source, job.controller.signal);
      if (job.controller.signal.aborted || !this.sourceCurrent(source)) throw aborted();
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
    let stale = false;
    try { stale = !this.sourceCurrent(job.source); } catch { stale = true; }
    if (message.ok && !job.controller.signal.aborted && !stale && job.cacheKey) {
      job.source.cache.set(job.cacheKey, message.result);
      while (job.source.cache.size > 2) job.source.cache.delete(job.source.cache.keys().next().value);
      this.refreshRetainedBuffers(job.source);
    }
    this.finish(job, message.result, stale ? aborted() : message.ok ? null : Object.assign(new Error(message.error?.message || 'Surface geometry preparation failed.'),
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
    for (const source of this.sources.values()) {
      source.uploaded = false; source.workerBytes = 0; source.cache.clear(); this.refreshRetainedBuffers(source);
    }
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
    for (const source of this.sources.values()) {
      source.uploaded = false; source.workerBytes = 0; source.cache.clear(); this.refreshRetainedBuffers(source, false);
    }
    this.sources.clear();
  }
}
