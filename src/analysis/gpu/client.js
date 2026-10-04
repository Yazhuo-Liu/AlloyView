const SUPPORTED_KINDS = new Set(['coordination', 'rdf', 'localShear', 'bonds', 'strain', 'cna', 'referenceStrain']);
const COPY_CHUNK_BYTES = 4 * 1024 ** 2;
const EMPTY_CACHE = { capacity: 0, cachedFrameIds: [], cachedFrameIndexes: [], fullTrajectory: false,
  frameCount: 0, currentIndex: 0, budgetBytes: 0, allocatedBytes: 0, residentBytes: 0, frameBytes: 0, workspaceBytes: 0 };

/** Keep one worker/device alive, and copy only the task currently being sent. */
export class GpuAnalysisClient {
  constructor({ environment = globalThis, workerFactory = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }) } = {}) {
    this.environment = environment;
    this.workerFactory = workerFactory;
    this.worker = null;
    this.pending = new Map();
    this.queue = [];
    this.current = null;
    this.nextId = 1;
    this.frameIds = new WeakMap();
    this.frameIndexes = new WeakMap();
    this.referenceFrames = new WeakMap();
    this.indexFrameIds = new Map();
    this.nextFrameId = 1;
    this.cachedFrameIds = new Set();
    this._cacheStatus = { ...EMPTY_CACHE };
    this.generation = 0;
    this.warmedUp = false;
    this.releaseWhenIdle = false;
    this.closed = false;
  }

  supports(kind) { return SUPPORTED_KINDS.has(kind); }
  get cacheStatus() { return { ...this._cacheStatus, cachedFrameIds: [...this.cachedFrameIds],
    cachedFrameIndexes: [...(this._cacheStatus.cachedFrameIndexes ?? [])] }; }

  associateFrame(frame, frameIndex) {
    if (!Number.isInteger(frameIndex) || frameIndex < 0) throw new Error('The GPU frame index must be a nonnegative integer.');
    const frameId = this.indexFrameIds.get(frameIndex) ?? this.frameIds.get(frame) ?? this.nextFrameId++;
    this.indexFrameIds.set(frameIndex, frameId);
    this.frameIds.set(frame, frameId);
    this.frameIndexes.set(frame, frameIndex);
    return frameId;
  }

  analyze(frame, parameters, { signal, onProgress = () => {}, frameIndex } = {}) {
    if (!this.supports(parameters.kind)) return Promise.reject(new Error(`The ${parameters.kind} analysis uses CPU workers.`));
    if (frameIndex !== undefined) this.associateFrame(frame, frameIndex);
    // A user calculation takes the next slot, even when prefetch is uploading.
    if (this.current?.type === 'prepare-frame') this.cancel(this.current);
    return this.enqueue('analyze', { frame, parameters, signal, onProgress }, 1);
  }

  warmup({ signal, onProgress = () => {} } = {}) {
    if (signal?.aborted || this.closed) return Promise.reject(abortError());
    this.resume();
    if (this.warmedUp) return Promise.resolve(this.cacheStatus);
    return this.enqueue('warmup', { signal, onProgress }, 1);
  }

  prepareFrame(frame, { frameIndex, signal, onProgress = () => {} } = {}) {
    if (frameIndex !== undefined) this.associateFrame(frame, frameIndex);
    return this.enqueue('prepare-frame', { frame, signal, onProgress }, 2);
  }

  configureCache(options = {}) { return this.enqueue('configure-cache', { options }, 0); }

  /** A source barrier: invalidate old uploads before accepting the new source. */
  clearFrames() {
    this.generation++;
    for (const task of this.pending.values()) this.cancel(task);
    this.queue.length = 0;
    this.frameIds = new WeakMap(); this.frameIndexes = new WeakMap(); this.indexFrameIds.clear();
    this.referenceFrames = new WeakMap();
    this.cachedFrameIds.clear(); this._cacheStatus = { ...EMPTY_CACHE };
    if (!this.worker || this.closed) return Promise.resolve(this.cacheStatus);
    return this.enqueue('clear-frames', {}, 0, { resume: false });
  }

  resume() { this.releaseWhenIdle = false; }

  enqueue(type, details, priority, { resume = true } = {}) {
    if (details.signal?.aborted || this.closed) return Promise.reject(abortError());
    if (!this.environment.navigator?.gpu) return Promise.reject(new Error('WebGPU is unavailable in this browser or context.'));
    if (resume) this.resume();
    return new Promise((resolve, reject) => {
      const task = { id: this.nextId++, type, priority, generation: this.generation, onProgress: () => {},
        ...details, resolve, reject, settled: false, dispatched: false };
      task.abort = () => this.cancel(task);
      task.signal?.addEventListener('abort', task.abort, { once: true });
      this.pending.set(task.id, task);
      const next = this.queue.findIndex(queued => queued.priority > priority);
      if (next < 0) this.queue.push(task); else this.queue.splice(next, 0, task);
      this.pump();
    });
  }

  cancel(task) {
    this.settle(task, abortError());
    if (this.current === task) {
      if (task.dispatched) this.worker?.postMessage({ type: 'cancel', id: task.id });
    } else {
      const index = this.queue.indexOf(task); if (index >= 0) this.queue.splice(index, 1);
    }
  }

  ensureWorker() {
    if (this.worker) return;
    this.worker = this.workerFactory();
    const worker = this.worker;
    this.worker.addEventListener('message', ({ data }) => {
      if (this.worker !== worker) return;
      const task = this.pending.get(data.id) ?? (this.current?.id === data.id ? this.current : null);
      if (!task) return;
      if (data.progress) { if (!task.settled) task.onProgress({ ...data.progress, backend: 'gpu', workerCount: 1 }); return; }
      if (task.generation === this.generation) {
        this.cachedFrameIds = new Set(data.cachedFrameIds ?? data.cacheStatus?.cachedFrameIds ?? []);
        if (data.cacheStatus) this._cacheStatus = { ...data.cacheStatus };
        if (data.ok && task.type === 'warmup') this.warmedUp = true;
      }
      if (data.ok) this.settle(task, null, task.type === 'analyze' ? data.result : this.cacheStatus);
      else { const error = new Error(data.error || 'GPU analysis failed.'); error.name = data.name || 'Error'; this.settle(task, error); }
      if (this.current === task) { this.current = null; this.pump(); }
    });
    const fail = (event) => {
      if (this.worker !== worker) return;
      const error = new Error(event.message || 'The GPU analysis worker failed.');
      if (this.current) this.settle(this.current, error);
      this.worker?.terminate(); this.worker = null; this.current = null;
      this.cachedFrameIds.clear(); this._cacheStatus = { ...EMPTY_CACHE }; this.warmedUp = false; this.pump();
    };
    this.worker.addEventListener('error', fail);
    this.worker.addEventListener('messageerror', fail);
  }

  pump() {
    if (this.current || this.closed) return;
    const task = this.queue.shift();
    if (!task) { if (this.releaseWhenIdle) this.release(); return; }
    if (task.settled) { this.pump(); return; }
    this.current = task;
    void this.dispatch(task);
  }

  async dispatch(task) {
    try {
      this.ensureWorker();
      const worker = this.worker;
      if (task.frame) task.onProgress({ backend: 'gpu', phase: 'preparing', completedAtoms: 0,
        totalAtoms: task.frame.fractional.length / 3, workerCount: 1 });
      await yieldToMain();
      if (task.settled) { this.finishDispatch(task); return; }
      let frameId, frameIndex, frame, referenceFrameId, referenceFrameIndex, referenceFrame;
      let parameters = task.parameters;
      let referenceSource;
      if (task.type === 'analyze' && parameters?.kind === 'referenceStrain') {
        referenceSource = this.referenceFrame(parameters);
        const mapping = parameters.referenceMapping;
        if (!ArrayBuffer.isView(mapping) || mapping instanceof DataView) throw new Error('GPU reference strain requires a typed referenceMapping array.');
        const currentIndex = this.frameIndexes.get(task.frame);
        const requestedIndex = parameters.referenceFrameIndex ?? this.frameIndexes.get(referenceSource);
        if (referenceSource === task.frame && requestedIndex !== undefined && currentIndex !== undefined && requestedIndex !== currentIndex) {
          throw new Error('The same GPU frame cannot have different current and reference indexes.');
        }
        if (requestedIndex !== undefined && currentIndex === requestedIndex
            && (referenceSource.fractional !== task.frame.fractional || referenceSource.cell !== task.frame.cell)) {
          throw new Error('GPU current and reference frames with the same index must identify the same coordinates and cell.');
        }
        if (parameters.referenceFrameIndex !== undefined) this.associateFrame(referenceSource, parameters.referenceFrameIndex);
      }
      const transfer = [];
      const preparedIds = new Set();
      const prepareFramePayload = async (source) => {
        let id = this.frameIds.get(source);
        if (!id) { id = this.nextFrameId++; this.frameIds.set(source, id); }
        const index = this.frameIndexes.get(source);
        let payload;
        if (!this.cachedFrameIds.has(id) && !preparedIds.has(id)) {
          const fractional = await copyArray(source.fractional, task);
          const types = source.types ? await copyArray(source.types, task) : undefined;
          payload = { fractional, types, cell: source.cell, gpuFrameId: id };
          transfer.push(fractional.buffer);
          if (types) transfer.push(types.buffer);
          preparedIds.add(id);
        }
        return { id, index, payload };
      };
      if (task.frame) {
        const current = await prepareFramePayload(task.frame);
        frameId = current.id; frameIndex = current.index; frame = current.payload;
      }
      if (task.type === 'analyze' && parameters?.kind === 'referenceStrain') {
        const reference = await prepareFramePayload(referenceSource);
        referenceFrameId = reference.id; referenceFrameIndex = reference.index; referenceFrame = reference.payload;
        if (frameId === referenceFrameId && frameIndex !== undefined && referenceFrameIndex !== frameIndex) {
          throw new Error('The same GPU frame cannot have different current and reference indexes.');
        }
        const mapping = parameters.referenceMapping;
        const referenceMapping = await copyArray(mapping, task);
        transfer.push(referenceMapping.buffer);
        parameters = { ...parameters, referenceMapping };
        // Reference coordinates travel in their private frame payload, or are
        // already resident. Never clone the complete application frame or
        // transfer cached CPU coordinates/mappings directly to the worker.
        delete parameters.referenceFrame;
        delete parameters.referenceFractional;
        delete parameters.referenceCell;
      }
      if (task.type === 'analyze' && parameters?.kind === 'strain' && parameters.ptmInput) {
        const ptmInput = {};
        for (const name of ['structures', 'scales', 'deformation']) {
          const source = parameters.ptmInput[name];
          if (!ArrayBuffer.isView(source) || source instanceof DataView) throw new Error(`GPU strain requires a typed PTM ${name} array.`);
          ptmInput[name] = await copyArray(source, task);
          transfer.push(ptmInput[name].buffer);
        }
        parameters = { ...parameters, ptmInput };
      }
      if (task.settled) { this.finishDispatch(task); return; }
      if (this.worker !== worker) throw abortError();
      task.dispatched = true;
      worker.postMessage({ type: task.type, id: task.id, frameId, frameIndex, frame,
        referenceFrameId, referenceFrameIndex, referenceFrame, parameters, options: task.options }, transfer);
    } catch (error) { this.settle(task, error); this.finishDispatch(task); }
  }

  finishDispatch(task) { if (this.current === task) { this.current = null; this.pump(); } }

  referenceFrame(parameters) {
    // Legacy coordinate-only references have no species array. They may cache
    // privately, but must not claim a trajectory index whose real frame can
    // later be used for element-filtered RDF or bonds.
    if (parameters.referenceFrameIndex !== undefined && parameters.referenceFrame === undefined) {
      throw new Error('GPU reference frame indexes require an actual referenceFrame.');
    }
    const fractional = parameters.referenceFractional;
    if (!ArrayBuffer.isView(fractional) || fractional instanceof DataView) throw new Error('GPU reference strain requires typed referenceFractional coordinates.');
    const cell = parameters.referenceCell;
    if (!cell || typeof cell !== 'object') throw new Error('GPU reference strain requires a reference cell.');
    if (parameters.referenceFrame !== undefined) {
      const frame = parameters.referenceFrame;
      if (frame?.fractional !== fractional || frame.cell !== cell) throw new Error('GPU reference frame metadata must identify the supplied reference coordinates and cell.');
      return frame;
    }
    let cells = this.referenceFrames.get(fractional);
    if (!cells) { cells = new WeakMap(); this.referenceFrames.set(fractional, cells); }
    let frame = cells.get(cell);
    if (!frame) { frame = { fractional, cell }; cells.set(cell, frame); }
    return frame;
  }

  settle(task, error, result) {
    if (task.settled) return;
    task.settled = true; task.signal?.removeEventListener('abort', task.abort); this.pending.delete(task.id);
    if (error) task.reject(error); else task.resolve(result);
  }

  release({ keepDevice = false, whenIdle = false } = {}) {
    if (keepDevice) { this.resume(); return this.clearFrames(); }
    if (whenIdle) {
      this.releaseWhenIdle = true;
      for (const task of this.pending.values()) if (task.type !== 'analyze') this.cancel(task);
      this.pump();
      return;
    }
    this.releaseWhenIdle = false;
    this.generation++;
    for (const task of this.pending.values()) this.settle(task, abortError());
    this.queue.length = 0; this.worker?.terminate(); this.worker = null; this.current = null;
    this.cachedFrameIds.clear(); this._cacheStatus = { ...EMPTY_CACHE }; this.warmedUp = false;
    this.frameIds = new WeakMap(); this.frameIndexes = new WeakMap(); this.indexFrameIds.clear();
    this.referenceFrames = new WeakMap();
  }

  close() { this.closed = true; this.release(); }
}

async function copyArray(source, task) {
  const result = new source.constructor(source.length), length = Math.max(1, Math.floor(COPY_CHUNK_BYTES / source.BYTES_PER_ELEMENT));
  for (let offset = 0; offset < source.length; offset += length) {
    if (task.settled || task.signal?.aborted) throw abortError();
    result.set(source.subarray(offset, offset + length), offset);
    if (offset + length < source.length) await yieldToMain();
  }
  return result;
}
function yieldToMain() { return new Promise((resolve) => setTimeout(resolve, 0)); }
function abortError() { return new DOMException('Analysis cancelled.', 'AbortError'); }
