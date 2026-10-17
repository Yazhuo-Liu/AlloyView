const abort = () => new DOMException('Grain preparation cancelled.', 'AbortError');
import { yieldToMain as pause } from './task-yield.js';
const defaultFactory = typeof Worker === 'function'
  ? () => new Worker(new URL('./workers/grains-stage-worker.js', import.meta.url), { type: 'module' }) : null;
const STAGE_MEMORY_BUDGET = 256 * 1024 ** 2;
const STAGE_FIELDS = {
  bonds: ['atomCount', 'structures', 'neighborCounts', 'neighborIndices', 'neighborSpan', 'fractional', 'cell'],
  disorientation: ['a', 'b', 'types', 'orientations'],
};

/** Persistent, bounded stage workers. A stage's enclosing weighted CPU lease
 * remains held until every posted range acknowledges, including after abort. */
export class GrainStagePool {
  constructor({ createWorker = defaultFactory, environment = globalThis } = {}) {
    this.createWorker = createWorker; this.environment = environment; this.slots = []; this.sequence = 0; this.pending = new Set(); this.warming = null;
    this.warmTarget = 0; this.deferredWarm = null; this.disposed = false; this.running = false;
  }
  prewarm(degree, budget) {
    if (this.disposed || !this.createWorker || degree < 3 || !budget) return;
    this.warmTarget = Math.max(this.warmTarget, degree - 1);
    // Snapshot copying yields to the UI. Reopening the panel during that
    // interval must not claim a slot that this stage is about to use.
    if (this.running) { this.deferredWarm = budget; return; }
    if (this.warming) return;
    const controller = new AbortController(), job = { controller, promise: null }; this.warming = job;
    job.promise = (async () => {
      for (let index = 0; index < this.warmTarget; index++) {
        const permit = await budget.acquire(1, { priority: -1, signal: controller.signal });
        try {
          if (controller.signal.aborted) break;
          const slot = this.slot(index); if (slot.warmed || slot.job) continue;
          const id = ++this.sequence;
          let timer;
          try {
            await new Promise((resolve, reject) => {
              slot.job = { id, resolve, reject };
              timer = setTimeout(() => {
                if (slot.job?.id !== id) return;
                slot.job = null; slot.worker.terminate(); this.slots[index] = null;
                reject(new Error('Grain stage warmup timed out.'));
              }, 5000);
              slot.worker.postMessage({ id, warm: true });
            });
            slot.warmed = true;
          } finally { clearTimeout(timer); if (slot.job?.id === id) slot.job = null; }
        } finally { permit.release(); }
      }
    })().catch(() => {}).finally(() => { if (this.warming === job) this.warming = null; });
  }
  async stopWarm() { const job = this.warming; job?.controller.abort(); await job?.promise; }
  degree(count, limit) {
    if (this.disposed || !this.createWorker || !Number.isSafeInteger(count) || !Number.isSafeInteger(limit) || limit < 3 || count < 65536) return 1;
    const shared = this.environment.crossOriginIsolated && typeof SharedArrayBuffer === 'function';
    // Includes private frame copies and the worst sixteen-neighbor output,
    // including ranges retained while the merged output is allocated.
    const outputBytes = count * 16 * 16 * 2;
    const memoryDegree = outputBytes >= STAGE_MEMORY_BUDGET ? 1
      : shared ? limit : 1 + Math.floor((STAGE_MEMORY_BUDGET - outputBytes - count * 160) / (count * 160));
    const degree = Math.max(1, Math.min(limit, 1 + Math.ceil(count / 16384), memoryDegree));
    return degree > 2 ? degree : 1;
  }
  slot(index) {
    if (this.disposed) throw abort();
    if (this.slots[index]) return this.slots[index];
    const worker = this.createWorker(), slot = { worker, job: null };
    worker.addEventListener('message', ({ data }) => {
      if (slot.job?.id !== data.id) return;
      const job = slot.job; slot.job = null;
      if (data.ok) slot.warmed = true;
      data.ok ? job.resolve(data.result) : job.reject(new Error(data.error));
    });
    const failed = event => {
      if (this.slots[index] !== slot) return;
      slot.job?.reject(new Error(event.message || 'Grain stage Worker failed.')); slot.job = null;
      worker.terminate(); this.slots[index] = null;
    };
    worker.addEventListener('error', failed); worker.addEventListener('messageerror', failed);
    return this.slots[index] = slot;
  }
  async snapshot(input, signal) {
    const shared = this.environment.crossOriginIsolated && typeof SharedArrayBuffer === 'function';
    const copy = { ...input };
    let sliceStartedAt = performance.now();
    for (const [key, values] of Object.entries(input)) {
      if (!ArrayBuffer.isView(values)) continue;
      if (shared && values.buffer instanceof SharedArrayBuffer) continue;
      const target = shared ? new values.constructor(new SharedArrayBuffer(values.byteLength)) : new values.constructor(values.length);
      for (let first = 0; first < values.length; first += 65536) {
        if (signal?.aborted) throw abort();
        target.set(values.subarray(first, first + 65536), first);
        // Yield by elapsed work, not every small typed-array copy. The latter
        // spends most of private preparation waiting for clamped timers.
        if (performance.now() - sliceStartedAt >= 4) {
          await pause(); sliceStartedAt = performance.now();
        }
      }
      copy[key] = target;
    }
    return copy;
  }
  run(...args) {
    const operation = this.runStage(...args); this.pending.add(operation);
    operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }
  async runStage(stage, input, length, degree, signal) {
    if (this.disposed || signal?.aborted) throw abort();
    if (!STAGE_FIELDS[stage] || !Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(degree) || degree < 3) throw new Error('Invalid parallel grain stage.');
    if (this.running) throw new Error('A parallel grain stage is already running.');
    // Claim the stage before awaiting existing warmup, so another prewarm
    // cannot start between that acknowledgement and the snapshot copy.
    this.running = true;
    try {
      await this.stopWarm();
      if (this.disposed || signal?.aborted) throw abort();
      return await this.runRanges(stage, input, length, degree, signal);
    } finally {
      this.running = false;
      const budget = this.deferredWarm; this.deferredWarm = null;
      if (budget) this.prewarm(this.warmTarget + 1, budget);
    }
  }
  async runRanges(stage, input, length, degree, signal) {
    const snapshot = await this.snapshot(Object.fromEntries(STAGE_FIELDS[stage].map(key => [key, input[key]])), signal), ranges = [], posted = [];
    if (signal?.aborted) throw abort();
    const cancel = () => { for (const slot of posted) if (slot.job) {
      try { slot.worker.postMessage({ id: slot.job.id, cancel: true }); }
      catch (error) { slot.worker.terminate(); slot.job.reject(error); slot.job = null; this.slots[this.slots.indexOf(slot)] = null; }
    } };
    signal?.addEventListener('abort', cancel, { once: true });
    const count = Math.min(degree - 1, Math.max(1, Math.ceil(length / 16384)));
    try { for (let index = 0; index < count; index++) {
      const first = Math.floor(length * index / count), end = Math.floor(length * (index + 1) / count);
      const slot = this.slot(index), id = ++this.sequence;
      if (slot.job) throw new Error('A grain stage Worker is already running.');
      posted.push(slot);
      const promise = new Promise((resolve, reject) => {
        slot.job = { id, resolve, reject };
        try { slot.worker.postMessage({ id, stage, input: snapshot, first, end }); }
        catch (error) { slot.job = null; reject(error); }
      });
      promise.catch(cancel);
      ranges.push(promise); this.pending.add(promise); promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    }
    } catch (error) { cancel(); await Promise.allSettled(ranges); signal?.removeEventListener('abort', cancel); throw error; }
    const settled = await Promise.allSettled(ranges);
    signal?.removeEventListener('abort', cancel);
    if (signal?.aborted) throw abort();
    const failed = settled.find(row => row.status === 'rejected'); if (failed) throw failed.reason;
    const partials = settled.map(row => row.value);
    if (stage === 'disorientation') {
      const values = new Float64Array(length); let offset = 0;
      for (let index = 0; index < partials.length; index++) {
        const part = partials[index], expected = Math.floor(length * (index + 1) / count) - Math.floor(length * index / count);
        if (!(part instanceof Float64Array) || part.length !== expected) throw new Error('Invalid grain disorientation range output.');
        values.set(part, offset); offset += part.length;
      }
      return { ...input, values };
    }
    const total = partials.reduce((sum, part) => sum + part.count, 0);
    for (const part of partials) if (!Number.isSafeInteger(part.count) || part.count < 0
      || !(part.a instanceof Uint32Array) || !(part.b instanceof Uint32Array) || !(part.lengths instanceof Float64Array)
      || part.a.length !== part.count || part.b.length !== part.count || part.lengths.length !== part.count) throw new Error('Invalid grain bond range output.');
    const result = { a: new Uint32Array(total), b: new Uint32Array(total), lengths: new Float64Array(total), count: total };
    let offset = 0;
    for (const part of partials) { for (const key of ['a', 'b', 'lengths']) result[key].set(part[key], offset); offset += part.count; }
    return result;
  }
  async drain() { await Promise.allSettled([...this.pending]); }
  dispose() { this.disposed = true; this.deferredWarm = null; this.warming?.controller.abort(); for (const slot of this.slots) { slot?.worker.terminate(); slot?.job?.reject(abort()); } this.slots = []; }
}
