import { estimateFrameBytes } from '../data/cache-policy.js';

const DEFAULT_BUDGET = 64 * 1024 ** 2;
const SUPPORTED_KINDS = new Set(['coordination', 'cna', 'centrosymmetry', 'ptm', 'strain']);
const abortError = () => new DOMException('Predicted analysis was cancelled.', 'AbortError');

/** Predict just the next visible analysis, after ordinary preparation is idle.
 * Results stay separate from frame.properties until a real foreground caller
 * consumes them through analyze(). No source, display or scientific UI changes
 * are performed by this scheduler.
 */
export class AnalysisPrefetchScheduler {
  constructor({ pool, byteBudget = DEFAULT_BUDGET, maxEntries = 4, settleMs = 120, retryMs = 40,
    schedule = (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancelSchedule = handle => clearTimeout(handle), isIdle, onStatus = () => {} } = {}) {
    if (!pool || typeof pool.analyze !== 'function') throw new Error('Analysis prefetch requires an analysis pool.');
    Object.assign(this, { pool, settleMs, retryMs, scheduleTimer: schedule, cancelTimer: cancelSchedule, onStatus });
    this.isIdle = isIdle ?? (() => !pool.closed && !pool.active?.size && !pool.queue?.length
      && !pool.cpuFramePreparation && !pool.cpuBudget?.active && !pool.cpuBudget?.queue?.length
      && (typeof pool.routingIdle !== 'function' || pool.routingIdle()));
    this.byteBudget = positiveInteger(byteBudget, DEFAULT_BUDGET);
    this.maxEntries = positiveInteger(maxEntries, 4);
    this.sourceKey = null;
    this.cache = new Map();
    this.pending = new Map();
    // A foreground subscriber may reject immediately on cancellation while a
    // backend wrapper is still unwinding. Recipe transactions can explicitly
    // await these raw lifetimes without making ordinary navigation wait.
    this.foregroundLifetimes = new Set();
    this.foregroundScopes = new Set();
    this.cacheBytes = 0;
    this.generation = 0;
    this.intent = null;
    this.timer = null;
    this.planController = null;
    this.identities = new WeakMap();
    this.nextIdentity = 1;
    this.stats = { predicted: 0, cacheHits: 0, joined: 0, cancelled: 0, evicted: 0, reusedFrameResults: 0 };
  }

  configure({ byteBudget = this.byteBudget, maxEntries = this.maxEntries } = {}) {
    this.byteBudget = positiveInteger(byteBudget, this.byteBudget);
    this.maxEntries = positiveInteger(maxEntries, this.maxEntries);
    this.trim();
  }

  setSourceKey(sourceKey) {
    if (Object.is(sourceKey, this.sourceKey)) return;
    this.clearSource();
    this.sourceKey = sourceKey;
  }

  /** requests may be built after reading the target frame. A request's
   * parameters may depend on preceding raw results, e.g. CNA -> Auto CSP.
   * Returning no requests is a cheap way to disable prediction for a view.
   */
  schedule({ sourceKey = this.sourceKey, frameIndex, getFrame, requests } = {}) {
    this.setSourceKey(sourceKey);
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || typeof getFrame !== 'function' || !requests) {
      this.cancel();
      return;
    }
    if (this.intent?.frameIndex === frameIndex && this.intent.requests === requests
        && this.intent.getFrame === getFrame && this.intent.sourceKey === sourceKey) return;
    this.cancel({ keepFrameIndex: frameIndex });
    this.intent = { sourceKey, frameIndex, getFrame, requests, generation: this.generation };
    this.onStatus({ phase: 'waiting', frameIndex });
    this.arm(this.settleMs);
  }

  arm(milliseconds) {
    if (this.timer !== null) this.cancelTimer(this.timer);
    this.timer = this.scheduleTimer(() => {
      this.timer = null;
      if (!this.intent) return;
      if (!this.isIdle()) { this.arm(this.retryMs); return; }
      const intent = this.intent;
      const controller = new AbortController();
      this.planController = controller;
      this.runPlan(intent, controller).catch(error => {
        if (error.name !== 'AbortError' && this.isCurrent(intent)) this.onStatus({ phase: 'unavailable', frameIndex: intent.frameIndex, error: error.message });
      }).finally(() => {
        if (this.planController === controller) this.planController = null;
      });
    }, milliseconds);
  }

  isCurrent(intent) {
    return this.intent === intent && intent.generation === this.generation && Object.is(intent.sourceKey, this.sourceKey);
  }

  async runPlan(intent, controller) {
    const current = () => this.isCurrent(intent) && !controller.signal.aborted;
    const frame = await intent.getFrame(intent.frameIndex, { signal: controller.signal, background: true, speculative: true });
    if (!frame || !current()) return;
    const requests = typeof intent.requests === 'function' ? await intent.requests(frame) : intent.requests;
    if (!current() || !Array.isArray(requests) || !requests.length) return;
    const results = [];
    for (const request of requests) {
      if (!current()) return;
      const parameters = typeof request.parameters === 'function'
        ? await request.parameters(results, frame) : request.parameters ?? request;
      if (!current()) return;
      if (!SUPPORTED_KINDS.has(parameters?.kind)) continue;
      const residentResult = typeof request.cachedResult === 'function'
        ? request.cachedResult(results, frame, parameters) : request.cachedResult;
      if (residentResult !== undefined) {
        this.stats.reusedFrameResults++; results.push(residentResult); continue;
      }
      // A preceding stage or source read may have allowed foreground work to
      // start. Wait again instead of adding a fresh speculative calculation.
      while (!this.isIdle()) {
        await this.delay(this.retryMs, controller.signal);
        if (!current()) return;
      }
      const cached = this.lookup(frame, parameters);
      if (cached) { results.push(cached); continue; }
      const key = this.key(frame, parameters);
      let entry = this.pending.get(key);
      if (!entry || entry.controller.signal.aborted) entry = this.start(frame, parameters, { frameIndex: intent.frameIndex, background: true });
      this.onStatus({ phase: 'calculating', frameIndex: intent.frameIndex, kind: parameters.kind });
      const stop = () => {
        entry.backgroundWanted = false;
        if (!entry.consumers.size) entry.controller.abort();
      };
      controller.signal.addEventListener('abort', stop, { once: true });
      try { results.push(await entry.promise); }
      finally { controller.signal.removeEventListener('abort', stop); }
    }
    if (current()) this.onStatus({ phase: 'ready', frameIndex: intent.frameIndex });
  }

  /** Foreground controllers retain their existing publication/validation path.
   * They receive exactly the same raw backend result as an ordinary analyze.
   */
  analyze(frame, parameters, options = {}) {
    if (options.signal?.aborted) return Promise.reject(abortError());
    if (!SUPPORTED_KINDS.has(parameters?.kind)) return this.trackDelegatedForeground(this.pool.analyze(frame, parameters, options));
    const key = this.key(frame, parameters);
    const cached = this.lookup(frame, parameters, key);
    if (cached) {
      this.pool.cancelBackgroundAnalyses?.();
      this.stats.cacheHits++;
      try {
        options.onProgress?.({ backend: cached.backend, phase: 'complete', completed: cached.workerCount ?? 1,
          total: cached.workerCount ?? 1, workerCount: cached.workerCount ?? 1,
          completedAtoms: frame.ids?.length ?? frame.fractional.length / 3, totalAtoms: frame.ids?.length ?? frame.fractional.length / 3 });
      } catch (error) { return Promise.reject(error); }
      if (options.signal?.aborted) return Promise.reject(abortError());
      return Promise.resolve(cached);
    }
    let entry = this.pending.get(key);
    if (entry && !entry.controller.signal.aborted) {
      this.stats.joined++;
      this.pool.cancelBackgroundAnalyses?.({ exceptSignal: entry.controller.signal });
      this.pool.promoteAnalysis?.(entry.controller.signal);
      entry.promoted = true;
      this.trackForegroundEntry(entry);
    } else {
      this.pool.cancelBackgroundAnalyses?.();
      entry = this.start(frame, parameters, { frameIndex: options.frameIndex, background: false });
    }
    this.trackForegroundEntry(entry);
    return this.join(entry, options);
  }

  /** Records only foreground calls made while a serialized transaction owns
   * this scope. Closing it excludes unrelated later user work; source clearing
   * cannot discard raw requests which the transaction already dispatched.
   */
  createForegroundScope() {
    const scope = { promises: new Set() };
    this.foregroundScopes.add(scope);
    let settlement;
    return { settle: () => {
      if (!settlement) {
        this.foregroundScopes.delete(scope);
        settlement = Promise.allSettled([...scope.promises]).finally(() => scope.promises.clear());
      }
      return settlement;
    } };
  }

  /** Barrier for serialized recipe/restore transactions only. Snapshot raw
   * dispatched foreground owners, including cancelled/source-cleared entries.
   * Pure predictions and work started after the snapshot do not hold it.
   */
  settleForeground() {
    return Promise.allSettled([...this.foregroundLifetimes]);
  }

  trackForegroundEntry(entry) {
    if (!entry.promoted) return;
    if (entry.dispatched) this.foregroundLifetimes.add(entry.promise);
    // Capture at the foreground call as well as backend dispatch. A scope can
    // close before the dispatch microtask runs and must still own that call.
    for (const scope of this.foregroundScopes) scope.promises.add(entry.promise);
  }

  trackDelegatedForeground(raw) {
    const promise = Promise.resolve(raw).finally(() => this.foregroundLifetimes.delete(promise));
    this.foregroundLifetimes.add(promise);
    for (const scope of this.foregroundScopes) scope.promises.add(promise);
    promise.catch(() => {});
    return promise;
  }

  start(frame, parameters, { frameIndex, background }) {
    const key = this.key(frame, parameters), sourceKey = this.sourceKey;
    const controller = new AbortController();
    const entry = { key, frame, parameters, frameIndex, sourceKey, controller, consumers: new Set(),
      backgroundWanted: background, promoted: !background, scope: this.backendScope() };
    this.pending.set(key, entry);
    if (background) this.stats.predicted++;
    entry.promise = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw abortError();
      entry.dispatched = true;
      this.trackForegroundEntry(entry);
      return this.pool.analyze(frame, parameters, { signal: controller.signal, frameIndex, background: background && !entry.promoted,
        onProgress: progress => {
          for (const consumer of [...entry.consumers]) {
            try { consumer.onProgress?.(progress); }
            catch (error) { consumer.finish(error); }
          }
        } });
    }).then(result => {
      if (controller.signal.aborted) throw abortError();
      if (Object.is(sourceKey, this.sourceKey) && entry.scope === this.backendScope()
          && this.key(frame, parameters) === key) this.remember(entry, result);
      return result;
    }).finally(() => {
      if (this.pending.get(key) === entry) this.pending.delete(key);
      this.foregroundLifetimes.delete(entry.promise);
    });
    // A user may cancel the plan before a foreground caller joins it.
    entry.promise.catch(() => {});
    return entry;
  }

  join(entry, { signal, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const consumer = { onProgress, done: false };
      const abort = () => consumer.finish(abortError());
      consumer.finish = (error, value) => {
        if (consumer.done) return;
        consumer.done = true;
        signal?.removeEventListener('abort', abort);
        entry.consumers.delete(consumer);
        if (!entry.consumers.size && !entry.backgroundWanted) entry.controller.abort();
        if (error) reject(error); else resolve(value);
      };
      entry.consumers.add(consumer);
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(value => consumer.finish(null, value), error => consumer.finish(error));
      if (signal?.aborted) abort();
    });
  }

  lookup(frame, parameters, key = this.key(frame, parameters)) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (this.pool.canReuseRoutingResult?.(frame, parameters, entry.result) === false) {
      this.removeCached(key); return null;
    }
    this.cache.delete(key); this.cache.set(key, entry);
    return entry.result;
  }

  remember(entry, result) {
    // Keys use weak identities; completed predictions do not retain a source
    // frame after the structure cache evicts it. The retained value is just
    // the result; count its actual backing buffers, including aliases once.
    const bytes = estimateFrameBytes({ result });
    if (bytes > this.byteBudget) return;
    this.removeCached(entry.key);
    this.cache.set(entry.key, { result, bytes, sourceKey: entry.sourceKey, frameIndex: entry.frameIndex });
    this.cacheBytes += bytes;
    this.trim();
  }

  removeCached(key) {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key); this.cacheBytes -= entry.bytes;
  }

  trim() {
    while (this.cache.size > this.maxEntries || this.cacheBytes > this.byteBudget) {
      this.removeCached(this.cache.keys().next().value); this.stats.evicted++;
    }
  }

  /** Keep a useful target prediction during navigation. Foreground consumers
   * own promoted work independently; aborting speculation cannot cancel them.
   */
  cancel({ keepFrameIndex } = {}) {
    const keepPlan = keepFrameIndex !== undefined && this.intent?.frameIndex === keepFrameIndex;
    this.generation++;
    if (this.timer !== null) this.cancelTimer(this.timer);
    this.timer = null; this.intent = null;
    const plan = this.planController;
    this.planController = null;
    if (!keepPlan) plan?.abort();
    for (const entry of this.pending.values()) {
      if (entry.frameIndex === keepFrameIndex) continue;
      entry.backgroundWanted = false;
      if (!entry.consumers.size) { entry.controller.abort(); this.stats.cancelled++; }
    }
  }

  clearSource() {
    this.cancel();
    for (const entry of this.pending.values()) entry.controller.abort();
    this.pending.clear(); this.cache.clear(); this.cacheBytes = 0;
    this.sourceKey = null; this.onStatus(null);
  }

  backendScope() {
    return JSON.stringify([Boolean(this.pool.gpuEnabled), Boolean(this.pool.gpuVoronoi), this.pool.ptmNeighborBackend,
      this.pool.gpuBackend?.fallbackGeneration ?? 0]);
  }

  key(frame, parameters) {
    const cell = frame.cell;
    // Strain consumes these fitted fields; storePtmResult() decorates the same
    // arrays with UI key/orientation/neighbor metadata. That decoration must
    // neither invalidate a useful tensor prediction nor become tensor input.
    const scientificParameters = parameters?.kind === 'strain' && parameters.ptmInput
      ? { ...parameters, ptmInput: Object.fromEntries(['structures', 'rmsd', 'scales', 'deformation', 'distances']
        .map(name => [name, parameters.ptmInput[name]])) } : parameters;
    return JSON.stringify([this.token(this.sourceKey), this.backendScope(), this.token(frame), frame.geometryRevision ?? 0,
      this.token(frame.fractional), this.token(frame.positions), this.token(frame.types), this.token(frame.ids),
      cell ? [Array.from(cell.vectors), Array.from(cell.pbc), Array.from(cell.origin ?? [0, 0, 0])] : null,
      this.parameterToken(scientificParameters)]);
  }

  token(value) {
    if (value === null || typeof value !== 'object' && typeof value !== 'function') return `${typeof value}:${String(value)}`;
    if (!this.identities.has(value)) this.identities.set(value, this.nextIdentity++);
    return this.identities.get(value);
  }

  parameterToken(value, seen = new Set()) {
    if (value === null || typeof value !== 'object') return this.token(value);
    if (ArrayBuffer.isView(value)) return [value.constructor.name, this.token(value), this.token(value.buffer), value.byteOffset, value.byteLength];
    if (value instanceof ArrayBuffer || typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer) return ['buffer', this.token(value), value.byteLength];
    if (seen.has(value)) throw new Error('Analysis prediction parameters cannot be cyclic.');
    seen.add(value);
    const token = Array.isArray(value) ? value.map(item => this.parameterToken(item, seen))
      : Object.keys(value).sort().map(key => [key, this.parameterToken(value[key], seen)]);
    seen.delete(value);
    return token;
  }

  delay(milliseconds, signal) {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const abort = () => { this.cancelTimer(handle); signal.removeEventListener('abort', abort); reject(abortError()); };
      const handle = this.scheduleTimer(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}

function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}
