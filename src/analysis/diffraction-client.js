import { CpuBudget } from '../shared/cpu-budget.js';
import { DIFFRACTION_LIMITS, prepareDiffractionSteps, calculateDiffractionRangeSteps,
  finalizeDiffractionSteps, diffractionCsvSteps } from './diffraction.js';
import { runCooperativeStepsAsync } from '../shared/cooperative-steps.js';

const abortError = () => new DOMException('Diffraction calculation cancelled.', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
const defaultFactory = typeof Worker === 'function' ? () => new Worker(
  new URL('../workers/diffraction-worker.js', import.meta.url), { type: 'module' }) : null;
const PROPERTY_NAMES = new Set(['occupancy', 'Uiso', 'uiso', 'U_iso_or_equiv', 'Biso', 'biso', 'bfactor', 'B_iso_or_equiv',
  ...['xx', 'yy', 'zz', 'xy', 'xz', 'yz'].map(axis => `displacementU${axis}`)]);
const same = (a, b) => a?.length === b.length && b.every((value, index) => Object.is(value, a[index]));

function frameKey(frame) {
  const count = frame?.types?.length;
  if (!Number.isSafeInteger(count) || count < 1 || count > DIFFRACTION_LIMITS.maxAtoms
      || frame.fractional?.length !== count * 3 || !ArrayBuffer.isView(frame.fractional)
      || !ArrayBuffer.isView(frame.types)) throw new Error('Diffraction needs a bounded periodic atom frame.');
  const properties = (frame.properties ?? []).filter(property => PROPERTY_NAMES.has(property.name));
  if (properties.some(property => !ArrayBuffer.isView(property.data) || property.data.length !== count)) {
    throw new Error('Diffraction found an incomplete occupancy or displacement property.');
  }
  return [frame.fractional, frame.types, frame.geometryRevision ?? 0, frame.revision ?? 0,
    frame.propertyRevision ?? 0, frame.typesRevision ?? 0,
    ...(frame.cell?.vectors ?? []), ...(frame.cell?.pbc ?? []), ...(frame.typeLabels ?? []),
    ...properties.flatMap(property => [property.name, property.data, property.revision ?? 0])];
}

function* snapshotSteps(frame) {
  const copy = function* (source) {
    const target = new source.constructor(source.length);
    for (let start = 0; start < source.length; start += 65536) { yield; target.set(source.subarray(start, start + 65536), start); }
    return target;
  };
  const fractional = yield* copy(frame.fractional), types = yield* copy(frame.types), properties = [];
  for (const property of frame.properties ?? []) if (PROPERTY_NAMES.has(property.name)) {
    properties.push({ name: property.name, data: yield* copy(property.data) });
  }
  return { fractional, types, properties, typeLabels: [...frame.typeLabels], title: frame.title,
    cell: { vectors: new Float64Array(frame.cell.vectors), pbc: [...frame.cell.pbc] } };
}

function buffers(object, output = new Set(), seen = new Set()) {
  if (!object || typeof object !== 'object' || seen.has(object)) return output;
  seen.add(object);
  if (ArrayBuffer.isView(object)) { if (object.buffer instanceof ArrayBuffer) output.add(object.buffer); }
  else for (const value of Object.values(object)) buffers(value, output, seen);
  return output;
}

/** One retained coordinator owns scientific preparation/finalization. Its
 * immutable prepared inputs travel directly to retained range Workers through
 * MessagePorts, without large scientific arrays visiting the page thread.
 * Cancellation settles promptly; occupied CPU leases remain until Worker ACK. */
export class DiffractionClient {
  constructor({ cpuBudget = null, environment = globalThis, createWorker = defaultFactory, workerFactory = createWorker,
    createMessageChannel = () => new MessageChannel(), interactionsPerWorker = 500000,
    chunkInteractions = 200000, requestTimeoutMs = 120000 } = {}) {
    this.cpuBudget = cpuBudget ?? new CpuBudget({ environment }); this.environment = environment;
    this.createWorker = workerFactory; this.createMessageChannel = createMessageChannel;
    this.interactionsPerWorker = Math.max(1, interactionsPerWorker); this.chunkInteractions = Math.max(1, chunkInteractions);
    this.requestTimeoutMs = requestTimeoutMs; this.slots = []; this.tasks = new Set(); this.tail = Promise.resolve();
    this.closed = false; this.nextId = 1; this.sourceId = 0; this.sourceIdentity = null;
  }
  get sharedMemory() { return Boolean(this.environment.crossOriginIsolated && typeof SharedArrayBuffer === 'function'); }
  sourceKey(frame) {
    const key = frameKey(frame);
    if (!same(this.sourceIdentity, key)) { this.sourceIdentity = key; this.sourceId++; }
    return this.sourceId;
  }
  workerCount(metadata) {
    const work = metadata.atomCount * metadata.reflectionCount;
    const copies = Math.max(1, Math.floor(256 * 1024 ** 2 / Math.max(1, metadata.preparedBytes * 2)));
    return Math.max(1, Math.min(this.cpuBudget.limit, this.sharedMemory ? this.cpuBudget.limit : copies,
      Math.ceil(work / this.interactionsPerWorker), Math.max(1, metadata.reflectionCount)));
  }
  enqueue(operation, { signal, background = false } = {}) {
    if (this.closed) return Promise.reject(new Error('The diffraction client is closed.'));
    if (signal?.aborted) return Promise.reject(abortError());
    if (!background) for (const task of this.tasks) if (task.background) task.controller.abort();
    const task = { controller: new AbortController(), background, settled: false };
    let resolvePublic, rejectPublic;
    const promise = new Promise((resolve, reject) => { resolvePublic = resolve; rejectPublic = reject; });
    const settle = (error, value) => {
      if (task.settled) return;
      task.settled = true; if (error) rejectPublic(error); else resolvePublic(value);
    };
    const abort = () => task.controller.abort(), cancelled = () => settle(abortError());
    signal?.addEventListener('abort', abort, { once: true });
    task.controller.signal.addEventListener('abort', cancelled, { once: true }); this.tasks.add(task);
    const completion = this.tail.then(() => { checkAbort(task.controller.signal); return operation(task.controller.signal); })
      .then(value => settle(null, value), error => settle(error)).finally(() => {
        signal?.removeEventListener('abort', abort); task.controller.signal.removeEventListener('abort', cancelled); this.tasks.delete(task);
      });
    this.tail = completion.catch(() => {});
    return promise;
  }
  slot(index) {
    if (this.slots[index]?.worker) return this.slots[index];
    const slot = { worker: null, pending: null, sourceKey: null, preparedKey: null }; this.slots[index] = slot;
    const worker = this.createWorker(); slot.worker = worker;
    worker.addEventListener('message', ({ data }) => {
      if (slot.worker !== worker || slot.pending?.id !== data.id) return;
      const pending = slot.pending;
      if (data.cpu) { this.cpuRequest(slot, pending, data.cpu); return; }
      if (data.progress) {
        try { pending.onProgress?.(data.progress); } catch (error) {
          pending.callbackError = error;
          for (const request of pending.cpuRequests.values()) request.controller.abort();
          try { worker.postMessage({ type: 'cancel', id: data.id }); } catch (failure) { this.failSlot(slot, failure); }
        }
        return;
      }
      slot.sourceKey = data.sourceKey ?? null; slot.preparedKey = data.preparedKey ?? null;
      if (pending.callbackError) pending.reject(pending.callbackError);
      else if (pending.signal?.aborted) pending.reject(abortError());
      else if (data.ok) pending.resolve(data.result);
      else { const error = new Error(data.error || 'Diffraction Worker failed.'); error.name = data.name || 'Error'; error.gpuUnavailable = Boolean(data.gpuUnavailable); pending.reject(error); }
    });
    const failed = event => { if (slot.worker === worker) this.failSlot(slot, new Error(event.message || 'Diffraction Worker failed.')); };
    worker.addEventListener('error', failed); worker.addEventListener('messageerror', failed);
    return slot;
  }
  failSlot(slot, error) {
    slot.worker?.terminate(); slot.worker = null; slot.sourceKey = null; slot.preparedKey = null; slot.pending?.reject(error);
  }
  cpuRequest(slot, pending, { action, token }) {
    if (!Number.isSafeInteger(token) || token < 1) { this.failSlot(slot, new Error('Invalid diffraction CPU stage token.')); return; }
    if (action === 'release') {
      const request = pending.cpuRequests.get(token);
      if (request) { request.controller.abort(); request.lease?.release(); pending.cpuRequests.delete(token); }
      return;
    }
    if (action !== 'acquire' || pending.cpuRequests.has(token)) {
      this.failSlot(slot, new Error('Invalid diffraction CPU stage request.')); return;
    }
    const request = { controller: new AbortController(), lease: null }; pending.cpuRequests.set(token, request);
    if (pending.signal?.aborted || pending.callbackError) request.controller.abort();
    const reply = error => {
      if (slot.pending !== pending || pending.cpuRequests.get(token) !== request) return;
      try { slot.worker.postMessage({ type: 'cpu-permit', id: pending.id, token,
        ok: !error, error: error?.message, name: error?.name }); }
      catch (failure) { this.failSlot(slot, failure); }
    };
    void this.cpuBudget.acquire(1, { signal: request.controller.signal, owner: this }).then(lease => {
      if (slot.pending !== pending || pending.cpuRequests.get(token) !== request || request.controller.signal.aborted) {
        lease.release(); reply(abortError()); return;
      }
      request.lease = lease; reply();
    }, reply);
  }
  request(slot, message, { signal, transfer = [], onProgress } = {}) {
    checkAbort(signal);
    if (slot.pending) return Promise.reject(new Error('A diffraction Worker already has pending work.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer;
      const cpuRequests = new Map();
      const abort = () => {
        for (const request of cpuRequests.values()) request.controller.abort();
        try { slot.worker?.postMessage({ type: 'cancel', id }); } catch (error) { this.failSlot(slot, error); }
      };
      const finish = callback => value => {
        if (slot.pending?.id !== id) return;
        // An ACK or a terminated Worker is the ownership boundary. A user's
        // earlier cancellation cannot release CPU work that is still running.
        for (const request of cpuRequests.values()) { request.controller.abort(); request.lease?.release(); }
        cpuRequests.clear();
        slot.pending = null; clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value);
      };
      slot.pending = { id, signal, onProgress, cpuRequests, resolve: finish(resolve), reject: finish(reject) };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => this.failSlot(slot, new Error('The diffraction Worker stopped responding.')), this.requestTimeoutMs);
      try { slot.worker.postMessage({ ...message, id }, transfer); } catch (error) { this.failSlot(slot, error); }
    });
  }
  async withPermit(signal, background, operation) {
    const lease = await this.cpuBudget.acquire(1, { signal, priority: background ? -1 : 0, owner: this });
    try { checkAbort(signal); return await operation(); } finally { lease.release(); }
  }
  async ensureSlot(index, signal, background = false) {
    if (this.slots[index]?.worker) return this.slots[index];
    return this.withPermit(signal, background, async () => {
      const slot = this.slot(index);
      // Module loading and startup also consume CPU. Idle initialized Workers
      // retain their modules but no lease; cancelled startup waits for its ACK.
      await this.request(slot, { type: 'warm' }, { signal });
      return slot;
    });
  }
  async prepareSource(slot, frame, key, signal, background = false) {
    if (slot.sourceKey === key) return false;
    await this.withPermit(signal, background, async () => {
      const snapshot = await runCooperativeStepsAsync(snapshotSteps(frame), { signal }); checkAbort(signal);
      await this.request(slot, { type: 'source', key, frame: snapshot }, { signal, transfer: [...buffers(snapshot)] });
    });
    if (slot === this.slots[0]) await this.releaseRangeInputs(signal);
    return true;
  }
  async releaseRangeInputs(signal, keepCount = 1) {
    const unused = this.slots.slice(keepCount).filter(slot => slot.worker && slot.preparedKey !== null);
    // Retain Worker modules, but not obsolete private source copies on slots
    // left unused by a smaller frame or a subsequent GPU calculation.
    await Promise.allSettled(unused.map(slot => this.request(slot, { type: 'clear' }, { signal })));
    checkAbort(signal);
  }
  warm({ useGpu = false, signal } = {}) {
    return this.enqueue(async activeSignal => {
      if (!this.createWorker) return { workerCount: 0, gpuReady: false };
      const slot = await this.ensureSlot(0, activeSignal, true);
      if (!useGpu) return { workerCount: 1, gpuReady: false };
      try { return await this.request(slot, { type: 'warm-gpu' }, { signal: activeSignal }); }
      catch (error) { if (error.name === 'AbortError') throw error; return { workerCount: 1, gpuReady: false, fallbackReason: error.message }; }
    }, { signal, background: true });
  }
  prepare(frame, { useGpu = false, signal } = {}) {
    return this.enqueue(async activeSignal => {
      const key = this.sourceKey(frame);
      if (!this.createWorker) return { workerCount: 0, gpuReady: false };
      const slot = await this.ensureSlot(0, activeSignal, true), sourceUploaded = await this.prepareSource(slot, frame, key, activeSignal, true);
      if (!useGpu) return { workerCount: 1, sourceUploaded, gpuReady: false };
      try { return { sourceUploaded, ...await this.request(slot, { type: 'warm-gpu' }, { signal: activeSignal }) }; }
      catch (error) { if (error.name === 'AbortError') throw error; return { workerCount: 1, sourceUploaded, gpuReady: false, fallbackReason: error.message }; }
    }, { signal, background: true });
  }
  async distribute(coordinator, metadata, count, signal) {
    checkAbort(signal);
    const controllers = new AbortController(), abort = () => controllers.abort();
    signal.addEventListener('abort', abort, { once: true });
    const waiting = [], ports = [];
    try {
      let startupFailure = null;
      await Promise.allSettled(Array.from({ length: count - 1 }, (_, offset) =>
        this.ensureSlot(offset + 1, controllers.signal).catch(error => {
          startupFailure ??= error; controllers.abort(); throw error;
        })));
      if (startupFailure) throw startupFailure;
      for (let index = 1; index < count; index++) {
        const slot = this.slots[index];
        if (slot.preparedKey === metadata.key) continue;
        const channel = this.createMessageChannel(); ports.push(channel.port1);
        const pending = this.request(slot, { type: 'receive', key: metadata.key, port: channel.port2 },
          { signal: controllers.signal, transfer: [channel.port2] });
        pending.catch(() => controllers.abort()); waiting.push(pending);
      }
      if (ports.length) await this.withPermit(controllers.signal, false, () => this.request(coordinator,
        { type: 'publish', key: metadata.key, ports }, { signal: controllers.signal, transfer: ports }));
      const results = await Promise.allSettled(waiting);
      const failure = results.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
    } catch (error) {
      controllers.abort(); await Promise.allSettled(waiting); throw error;
    } finally { signal.removeEventListener('abort', abort); for (const port of ports) port.close(); }
  }
  analyze(frame, parameters = {}, { signal, onProgress, useGpu = false } = {}) {
    return this.enqueue(async activeSignal => {
      const started = performance.now(), progress = value => { checkAbort(activeSignal); onProgress?.(value); checkAbort(activeSignal); };
      const key = this.sourceKey(frame);
      if (!this.createWorker) return this.withPermit(activeSignal, false, async () => {
        const prepared = await runCooperativeStepsAsync(prepareDiffractionSteps(frame, parameters), { signal: activeSignal });
        const part = await runCooperativeStepsAsync(calculateDiffractionRangeSteps(prepared, { start: 0, end: prepared.reflectionCount }, { onProgress: progress }), { signal: activeSignal });
        const result = await runCooperativeStepsAsync(finalizeDiffractionSteps(prepared, [part]), { signal: activeSignal });
        return { ...result, backend: 'cpu', workerCount: 1, elapsedMs: performance.now() - started,
          fallbackReason: useGpu ? 'Workers are unavailable; using the CPU implementation.' : null };
      });
      const coordinator = await this.ensureSlot(0, activeSignal), sourceUploaded = await this.prepareSource(coordinator, frame, key, activeSignal);
      progress({ phase: 'preparing', backend: 'cpu' });
      const metadata = await this.withPermit(activeSignal, false, () => this.request(coordinator,
        { type: 'prepare', key, parameters, shared: this.sharedMemory }, { signal: activeSignal, onProgress: progress }));
      let parts, backend = 'cpu', workerCount = 1, fallbackReason = null, gpuDetails = {};
      if (useGpu && metadata.reflectionCount) {
        await this.releaseRangeInputs(activeSignal);
        try {
          const part = await this.request(coordinator, { type: 'gpu', key: metadata.key }, { signal: activeSignal, onProgress: progress });
          parts = [part]; backend = 'gpu';
          gpuDetails = { correctedReflections: part.correctedReflections ?? 0, inputReused: Boolean(part.inputReused) };
        } catch (error) {
          if (error.name === 'AbortError' || activeSignal.aborted || !error.gpuUnavailable) throw error;
          fallbackReason = error.message; progress({ phase: 'cpu-fallback', backend: 'cpu', reason: fallbackReason });
        }
      }
      if (!parts) {
        checkAbort(activeSignal);
        workerCount = this.workerCount(metadata);
        await this.releaseRangeInputs(activeSignal, workerCount);
        await this.distribute(coordinator, metadata, workerCount, activeSignal);
        checkAbort(activeSignal);
        parts = []; let next = 0, completed = 0, failure = null;
        const controller = new AbortController(), abort = () => controller.abort();
        activeSignal.addEventListener('abort', abort, { once: true });
        const chunk = Math.max(1, Math.min(4096, Math.floor(this.chunkInteractions / metadata.atomCount)));
        try {
          await Promise.all(Array.from({ length: workerCount }, async (_, index) => {
            try {
              while (next < metadata.reflectionCount) {
                checkAbort(controller.signal);
                const start = next, end = Math.min(metadata.reflectionCount, start + chunk); next = end;
                const part = await this.withPermit(controller.signal, false, () => this.request(this.slots[index],
                  { type: 'range', key: metadata.key, start, end }, { signal: controller.signal }));
                parts.push(part); completed += end - start;
                progress({ phase: 'structure-factors', backend: 'cpu', workerCount,
                  completed, total: metadata.reflectionCount, completedReflections: completed, totalReflections: metadata.reflectionCount });
              }
            } catch (error) { failure ??= error; controller.abort(); }
          }));
          if (failure) throw failure;
        } finally { activeSignal.removeEventListener('abort', abort); }
      }
      progress({ phase: 'profile', backend: 'cpu', computeBackend: backend });
      const result = await this.withPermit(activeSignal, false, () => this.request(coordinator,
        { type: 'finalize', key: metadata.key, parts }, { signal: activeSignal, transfer: [...buffers(parts)] }));
      progress({ phase: 'complete', backend, completed: metadata.reflectionCount, total: metadata.reflectionCount });
      return { ...result, backend, workerCount, sourceUploaded, sharedMemory: this.sharedMemory, fallbackReason,
        elapsedMs: performance.now() - started, ...gpuDetails };
    }, { signal });
  }
  export(result, kind, { stem = 'diffraction' } = {}, { signal } = {}) {
    return this.enqueue(activeSignal => this.withPermit(activeSignal, false, async () => {
      if (!['peaks', 'profile'].includes(kind)) throw new Error('Choose a diffraction peak or profile CSV.');
      const copy = { ...result }; delete copy.reflections;
      if (kind === 'peaks') delete copy.profile; else delete copy.peaks;
      if (!this.createWorker) return runCooperativeStepsAsync(diffractionCsvSteps(copy, { kind, stem }), { signal: activeSignal });
      return this.request(this.slot(0), { type: 'csv', result: copy, options: { kind, stem } }, { signal: activeSignal });
    }), { signal });
  }
  abortAll() { for (const task of this.tasks) task.controller.abort(); }
  releaseGpuResources() {
    return this.enqueue(signal => this.slots[0]?.worker
      ? this.request(this.slots[0], { type: 'release-gpu' }, { signal }) : { gpuReady: false });
  }
  clear() {
    this.abortAll(); this.sourceIdentity = null;
    return this.enqueue(async signal => {
      const results = await Promise.allSettled(this.slots.filter(slot => slot.worker).map(slot => this.request(slot, { type: 'clear' }, { signal })));
      return { cleared: true, failures: results.filter(result => result.status === 'rejected').length };
    });
  }
  whenIdle() { return this.tail; }
  dispose() {
    if (this.closed) return;
    this.closed = true; this.abortAll(); this.sourceIdentity = null;
    for (const slot of this.slots) this.failSlot(slot, abortError());
  }
}
