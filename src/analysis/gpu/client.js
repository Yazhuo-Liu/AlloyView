import { analysisValidationError } from '../errors.js';
import { gpuFrameSnapshot, sameGpuFrameMetadata, sameGpuFrameArrays } from './frame-revision.js';

const SUPPORTED_KINDS = new Set(['coordination', 'rdf', 'localShear', 'bonds', 'bondStatistics', 'voronoi', 'strain', 'cna', 'referenceStrain', 'centrosymmetry', 'displacement', 'ptmNeighbors']);
const REFERENCE_KINDS = new Set(['referenceStrain', 'displacement']);
const COPY_CHUNK_BYTES = 4 * 1024 ** 2;
// One running task plus one posted behind it. A task is posted early only
// when its inputs are already resident, so it carries no frame payload; the
// worker retains those inputs for received tasks even if the running task
// evicts their GPU buffers.
const MAX_TASKS_IN_FLIGHT = 2;
const EMPTY_CACHE = { capacity: 0, cachedFrameIds: [], cachedFrameIndexes: [], fullTrajectory: false,
  frameCount: 0, currentIndex: 0, budgetBytes: 0, allocatedBytes: 0, residentBytes: 0, frameBytes: 0, workspaceBytes: 0,
  preparedVoronoiFrameIds: [], preparedVoronoiFrameIndexes: [], voronoiWorkspaceAtoms: 0,
  kernelFailures: [],
  neighborIndexCount: 0, neighborIndexBuildCount: 0, voronoiKernelWarmupCount: 0, bufferLimitBytes: 0, exactPairs: null };

/** Keep one worker/device alive, and copy only the task currently being sent.
 * Results arrive in posting order because the worker runs tasks serially. */
export class GpuAnalysisClient {
  constructor({ environment = globalThis, workerFactory = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }) } = {}) {
    this.environment = environment;
    this.workerFactory = workerFactory;
    this.worker = null;
    this.pending = new Map();
    this.queue = [];
    this.active = [];
    this.nextId = 1;
    this.frameIds = new WeakMap();
    this.frameIndexes = new WeakMap();
    this.indexedFrames = new WeakSet();
    this.referenceFrames = new WeakMap();
    this.indexFrameIds = new Map();
    this.nextFrameId = 1;
    this.frameSnapshots = new WeakMap();
    this.frameMetadata = new Map();
    this.invalidatedFrameIds = new Set();
    this.derivedFrameIds = new Map();
    this.cachedFrameIds = new Set();
    this.cachedCartesianFrames = new Map();
    this.positionSources = new Map();
    this.ptmSources = new Map();
    this.cachedPtmFits = new Map();
    this.nextPtmFitId = 1;
    this._cacheStatus = { ...EMPTY_CACHE };
    this.generation = 0;
    // Routing refusals cannot outlive a source barrier or a replaced device.
    this.fallbackGeneration = 0;
    this.warmedUp = false;
    this.deviceWarmed = false;
    this.warmedAnalysisKinds = new Set();
    this.releaseWhenIdle = false;
    this.closed = false;
  }

  supports(kind) { return SUPPORTED_KINDS.has(kind); }
  /** The oldest task that was taken from the queue and has not finished. */
  get current() { return this.active[0] ?? null; }
  get cacheStatus() {
    const frameIndexes = ids => [...new Set([...ids].map(id => {
      const index = this.frameMetadata.get(id)?.frameIndex;
      return this.indexFrameIds.get(index) === id ? index : undefined;
    }).filter(Number.isInteger))].sort((a, b) => a - b);
    const cachedFrameIndexes = frameIndexes(this.cachedFrameIds);
    const preparedVoronoiFrameIds = (this._cacheStatus.preparedVoronoiFrameIds ?? []).filter(id => this.frameMetadata.has(id) && !this.invalidatedFrameIds.has(id));
    return { ...this._cacheStatus, cachedFrameIds: [...this.cachedFrameIds], cachedFrameIndexes,
      fullyCached: this._cacheStatus.frameCount > 0 && cachedFrameIndexes.length === this._cacheStatus.frameCount
        && cachedFrameIndexes[0] === 0 && cachedFrameIndexes.at(-1) === this._cacheStatus.frameCount - 1,
      cachedPtmFits: [...this.cachedPtmFits].map(([frameId, fitId]) => ({ frameId, fitId })),
      preparedVoronoiFrameIds, preparedVoronoiFrameIndexes: frameIndexes(preparedVoronoiFrameIds),
      kernelFailures: (this._cacheStatus.kernelFailures ?? []).map(failure => ({ ...failure })) };
  }


  associateFrame(frame, frameIndex) { return this.frameRevision(frame, { frameIndex }); }

  /** A cheap GPU-input revision token, also suitable for scoped routing caches. */
  frameRevision(frame, { frameIndex } = {}) {
    const snapshot = gpuFrameSnapshot(frame);
    if (frameIndex !== undefined) {
      if (!Number.isInteger(frameIndex) || frameIndex < 0) throw validationError('The GPU frame index must be a nonnegative integer.');
      this.frameIndexes.set(frame, frameIndex);
      this.indexedFrames.add(frame);
    }
    const index = this.frameIndexes.get(frame);
    const ownId = this.frameIds.get(frame), indexedId = index === undefined || !this.indexedFrames.has(frame) ? undefined : this.indexFrameIds.get(index);
    const previous = this.frameSnapshots.get(frame);
    // An already-seen object from a preceding revision is not a new immutable
    // parser result. Keep it private so it cannot borrow another alias's edited
    // coordinates or replace the current canonical trajectory input.
    if (indexedId !== undefined && (previous && previous.id !== indexedId
        || snapshot.values[0] < (this.frameMetadata.get(indexedId)?.values[0] ?? 0))) this.indexedFrames.delete(frame);
    let id = this.indexedFrames.has(frame) ? indexedId ?? ownId : ownId;
    const metadata = this.frameMetadata.get(id);
    if (metadata && (!sameGpuFrameMetadata(metadata, snapshot)
        || (previous?.id === id && !sameGpuFrameArrays(previous.snapshot, snapshot)))) {
      this.retireFrame(id);
      id = undefined;
    }
    if (!this.frameMetadata.has(id)) id = this.nextFrameId++;
    this.frameIds.set(frame, id);
    if (index !== undefined && this.indexedFrames.has(frame)) this.indexFrameIds.set(index, id);
    this.frameSnapshots.set(frame, { id, snapshot });
    // Store scalar metadata only: no strong references to source arrays or cell.
    this.frameMetadata.set(id, { values: snapshot.values, frameIndex: index });
    return id;
  }

  /** Mark an in-place geometry/type edit. The old input stays leased until its
   * cancelled jobs acknowledge; its buffers are then freed without replacing
   * the Worker, device, pipelines, or unrelated resident frames. */
  invalidateFrame(frame, { frameIndex } = {}) {
    if (frameIndex !== undefined && (!Number.isInteger(frameIndex) || frameIndex < 0)) throw validationError('The GPU frame index must be a nonnegative integer.');
    const snapshot = gpuFrameSnapshot(frame), index = frameIndex ?? this.frameIndexes.get(frame);
    const ownId = this.frameIds.get(frame), canonicalId = index === undefined ? undefined : this.indexFrameIds.get(index);
    const canonicalMetadata = this.frameMetadata.get(canonicalId);
    // A known older/private alias marks its own input only. An unseen immutable
    // alias may identify the canonical input by matching its scalar revision.
    const id = ownId ?? (canonicalMetadata && sameGpuFrameMetadata(canonicalMetadata, snapshot) ? canonicalId : undefined);
    const revision = Math.max(snapshot.values[0], canonicalMetadata?.values[0] ?? 0);
    if (revision === Number.MAX_SAFE_INTEGER) throw validationError('GPU geometryRevision cannot be incremented beyond a safe integer.');
    try { frame.geometryRevision = revision + 1; }
    catch { throw validationError('GPU frame invalidation requires a writable geometryRevision marker; use a new frame identity for frozen frames.'); }
    if (frame.geometryRevision !== revision + 1) throw validationError('GPU frame invalidation requires a writable geometryRevision marker; use a new frame identity for frozen frames.');
    if (index !== undefined) this.frameIndexes.set(frame, index);
    if (canonicalId === undefined || canonicalId === id) this.indexedFrames.add(frame);
    else this.indexedFrames.delete(frame);
    const barrier = id === undefined ? Promise.resolve(this.cacheStatus) : this.retireFrame(id);
    this.frameIds.delete(frame);
    if (index !== undefined && this.indexFrameIds.get(index) === id) this.indexFrameIds.delete(index);
    this.frameSnapshots.delete(frame);
    this.frameRevision(frame);
    return barrier;
  }

  retireFrame(id) {
    if (this.invalidatedFrameIds.has(id)) return Promise.resolve(this.cacheStatus);
    this.invalidatedFrameIds.add(id);
    this.frameMetadata.delete(id);
    for (const derivedId of this.derivedFrameIds.get(id) ?? []) this.retireFrame(derivedId);
    this.derivedFrameIds.delete(id);
    this.cachedFrameIds.delete(id); this.cachedCartesianFrames.delete(id);
    this.positionSources.delete(id); this.ptmSources.delete(id); this.cachedPtmFits.delete(id);
    for (const task of [...this.pending.values()]) {
      if (task.frameDependencies?.includes(id)) this.cancel(task);
    }
    if (!this.worker || this.closed) { this.invalidatedFrameIds.delete(id); return Promise.resolve(this.cacheStatus); }
    const barrier = this.enqueue('release-frame', { releasedFrameId: id }, 0, { resume: false });
    // Automatic metadata changes have no caller awaiting this housekeeping.
    // Cancellation/source barriers may reject it; no unhandled rejection.
    barrier.catch(() => {});
    return barrier;
  }

  analyze(frame, parameters, { signal, onProgress = () => {}, frameIndex } = {}) {
    if (!this.supports(parameters.kind)) return Promise.reject(new Error(`The ${parameters.kind} analysis uses CPU workers.`));
    try { if (frameIndex !== undefined) this.associateFrame(frame, frameIndex); } catch (error) { return Promise.reject(error); }
    // A user calculation takes the next slot, even when prefetch is uploading.
    this.preemptPreparation();
    if (parameters.kind === 'voronoi' && parameters.selectedTypes != null) {
      try {
        const selection = prepareVoronoiSelection(frame, parameters.selectedTypes), compactFrame = selection.frame,
          range = voronoiSelectionRange(selection, parameters), index = this.frameIndexes.get(frame);
        // A type subset has independent coordinates/index buffers. Keep its own
        // input ID; sharing the trajectory's source ID would reuse wrong sites.
        if (index !== undefined) this.frameIndexes.set(compactFrame, index);
        const radii = compactVoronoiRadii(parameters.radii, selection);
        return this.enqueue('analyze', { frame: compactFrame, sourceFrame: frame,
          parameters: { ...parameters, ...range, selectedTypes: null, ...(radii ? { radii } : {}) }, signal, onProgress }, 1)
          .then(result => expandVoronoiResult(result, selection));
      } catch (error) { return Promise.reject(error); }
    }
    return this.enqueue('analyze', { frame, parameters, signal, onProgress }, 1);
  }

  warmup({ signal, analysisKinds, onProgress = () => {} } = {}) {
    if (signal?.aborted || this.closed) return Promise.reject(abortError());
    let kinds;
    try { kinds = gpuPreparationKinds(analysisKinds); } catch (error) { return Promise.reject(error); }
    this.resume();
    // General warmup leaves the targeted (Voronoi) pipelines alone, so each
    // request is answered from its own record. An empty list asks for the
    // device, which any completed warmup has initialized.
    if (kinds ? this.deviceWarmed && kinds.every(kind => this.warmedAnalysisKinds.has(kind)) : this.warmedUp) return Promise.resolve(this.cacheStatus);
    return this.enqueue('warmup', { signal, onProgress, options:{analysisKinds:kinds} }, 2);
  }

  prepareFrame(frame, { frameIndex, signal, analysisKinds, selectedTypes = null, onProgress = () => {} } = {}) {
    try {
      if (frameIndex !== undefined) this.associateFrame(frame, frameIndex);
      const kinds = gpuPreparationKinds(analysisKinds);
      const sourceFrame = frame;
      if (kinds?.includes('voronoi') && selectedTypes != null) {
        const selection = prepareVoronoiSelection(frame, selectedTypes), index = this.frameIndexes.get(frame);
        if (index !== undefined) this.frameIndexes.set(selection.frame,index);
        frame = selection.frame;
      }
      return this.enqueue('prepare-frame', { frame, sourceFrame, signal, onProgress, options:{analysisKinds:kinds} }, 2);
    } catch (error) { return Promise.reject(error); }
  }

  preemptPreparation() {
    for (const task of [...this.active]) if (['prepare-frame','warmup'].includes(task.type)) this.cancel(task);
  }

  configureCache(options = {}) { return this.enqueue('configure-cache', { options }, 0); }

  /** Free the Voronoi cell workspace behind running work; compiled pipelines
   * stay. An unused GPU is not started for it. */
  releaseVoronoi() {
    if (!this.worker || this.closed) return Promise.resolve(this.cacheStatus);
    return this.enqueue('release-voronoi', {}, 0, { resume: false });
  }

  /** A source barrier: invalidate old uploads before accepting the new source. */
  clearFrames() {
    this.generation++;
    this.fallbackGeneration++;
    for (const task of this.pending.values()) this.cancel(task);
    this.queue.length = 0;
    this.frameIds = new WeakMap(); this.frameIndexes = new WeakMap(); this.indexedFrames = new WeakSet(); this.indexFrameIds.clear();
    this.frameSnapshots = new WeakMap(); this.frameMetadata.clear(); this.invalidatedFrameIds.clear(); this.derivedFrameIds.clear();
    this.referenceFrames = new WeakMap();
    this.cachedFrameIds.clear(); this.cachedCartesianFrames.clear(); this.positionSources.clear(); this._cacheStatus = { ...EMPTY_CACHE };
    this.ptmSources.clear(); this.cachedPtmFits.clear();
    if (!this.worker || this.closed) return Promise.resolve(this.cacheStatus);
    return this.enqueue('clear-frames', {}, 0, { resume: false });
  }

  resume() { this.releaseWhenIdle = false; }

  enqueue(type, details, priority, { resume = true } = {}) {
    if (details.signal?.aborted || this.closed) return Promise.reject(abortError());
    if (!this.environment.navigator?.gpu) return Promise.reject(new Error('WebGPU is unavailable in this browser or context.'));
    let frameDependencies, frameSources;
    try {
      frameSources = details.frame ? [details.frame] : [];
      const sourceId = details.sourceFrame && details.sourceFrame !== details.frame ? this.frameRevision(details.sourceFrame) : undefined;
      frameDependencies = details.frame ? [this.frameRevision(details.frame)] : [];
      if (type === 'analyze' && REFERENCE_KINDS.has(details.parameters?.kind)) {
        const reference = this.referenceFrame(details.parameters);
        this.validateReference(details.frame, details.parameters, reference);
        frameSources.push(reference);
        frameDependencies.push(this.frameRevision(reference, { frameIndex: details.parameters.referenceFrameIndex }));
      }
      if (details.sourceFrame && details.sourceFrame !== details.frame) {
        frameSources.push(details.sourceFrame);
        frameDependencies.push(sourceId);
        let derived = this.derivedFrameIds.get(sourceId);
        if (!derived) { derived = new Set(); this.derivedFrameIds.set(sourceId, derived); }
        derived.add(frameDependencies[0]);
      }
      // Associating a newer reference revision can retire an earlier current
      // alias before this task is registered. Capture their final identities,
      // so invalidating either actual posted input cancels this task.
      frameDependencies = [...new Set(frameSources.map(source => this.frameRevision(source)))];
      if (sourceId !== undefined) this.derivedFrameIds.get(sourceId)?.add(frameDependencies[0]);
    } catch (error) { return Promise.reject(error); }
    if (resume) this.resume();
    return new Promise((resolve, reject) => {
      const task = { id: this.nextId++, type, priority, generation: this.generation, onProgress: () => {},
        ...details, frameDependencies, frameSources, resolve, reject, settled: false, dispatched: false };
      task.abort = () => this.cancel(task);
      task.signal?.addEventListener('abort', task.abort, { once: true });
      this.pending.set(task.id, task);
      const next = this.queue.findIndex(queued => queued.priority > priority);
      if (next < 0) this.queue.push(task); else this.queue.splice(next, 0, task);
      this.pump();
    });
  }

  cancel(task, error = abortError()) {
    this.settle(task, error);
    // A cancelled upload cannot acknowledge its provisional source identity.
    // Preserve earlier acknowledged fits; a later task's replacement is
    // removed only when it still owns the current descriptor.
    const fit = task.ptmSource;
    if (fit && this.ptmSources.get(fit.frameId) === fit.source && this.cachedPtmFits.get(fit.frameId) !== fit.source.id) {
      this.ptmSources.delete(fit.frameId);
    }
    for (const { id, variant, source, uploaded } of task.positionSources ?? []) {
      const variants = this.positionSources.get(id);
      if (uploaded && variants?.get(variant) === source) variants.delete(variant);
      if (variants && !variants.size) this.positionSources.delete(id);
    }
    if (this.active.includes(task)) {
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
      if (data.type === 'device-lost' || data.gpuDeviceLost === true) {
        fail({ message: data.error || 'The WebGPU device was lost.', name: 'GpuDeviceLostError', gpuDeviceLost: true });
        return;
      }
      const task = this.pending.get(data.id) ?? this.active.find(active => active.id === data.id) ?? null;
      if (!task) return;
      if (data.progress) {
        if (!task.settled) {
          try { task.onProgress({ ...data.progress, backend: 'gpu', workerCount: 1 }); }
          catch (error) { this.cancel(task, error); }
        }
        return;
      }
      // A caller may mark geometry while a dispatch is in flight without
      // immediately starting another analysis. Do not publish that old result.
      if (!task.settled) {
        try { for (const source of task.frameSources ?? []) this.frameRevision(source); }
        catch (error) { this.cancel(task, error); }
      }
      // Sparse CPU corrections also retain Wasm inside this Worker. A native
      // trap cannot leave that module cached for another GPU calculation.
      if (data.fatal === true) { fail({ message: data.error || 'The GPU analysis Worker failed.' }); return; }
      if (task.generation === this.generation) {
        this.cachedFrameIds = new Set((data.cachedFrameIds ?? data.cacheStatus?.cachedFrameIds ?? []).filter(id => !this.invalidatedFrameIds.has(id)));
        this.cachedCartesianFrames = new Map((data.cachedCartesianFrames ?? []).filter(({ frameId }) => !this.invalidatedFrameIds.has(frameId)).map(({ frameId, variants }) => [frameId, new Set(variants)]));
        this.cachedPtmFits = new Map((data.cachedPtmFits ?? []).filter(({ frameId }) => !this.invalidatedFrameIds.has(frameId)).map(({ frameId, fitId }) => [frameId, fitId]));
        // Replies describe the worker state before later posted tasks run.
        // Keep their provisional source identities until their own ACK: an
        // earlier cancelled warmup must not discard a raw fit already sent
        // by the foreground analysis behind it. Residency still requires an
        // actual ACK before any future task may omit its input payload.
        const awaiting = this.active.filter(active => active !== task && active.dispatched
          && !active.settled && active.generation === this.generation);
        for (const [frameId, variants] of this.positionSources) {
          for (const [variant, source] of variants) {
            const acknowledged = this.cachedFrameIds.has(frameId) && this.cachedCartesianFrames.get(frameId)?.has(variant);
            const posted = awaiting.some(active => active.positionSources?.some(pending =>
              pending.id === frameId && pending.variant === variant && pending.source === source));
            if (!acknowledged && !posted) variants.delete(variant);
          }
          if (!variants.size) this.positionSources.delete(frameId);
        }
        for (const [frameId, fit] of this.ptmSources) {
          const acknowledged = this.cachedFrameIds.has(frameId) && this.cachedPtmFits.get(frameId) === fit.id;
          const posted = awaiting.some(active => active.ptmSource?.frameId === frameId && active.ptmSource.source === fit);
          if (!acknowledged && !posted) this.ptmSources.delete(frameId);
        }
        if (data.cacheStatus) this._cacheStatus = { ...data.cacheStatus,
          preparedVoronoiFrameIds: (data.cacheStatus.preparedVoronoiFrameIds ?? []).filter(id => !this.invalidatedFrameIds.has(id)) };
        if (task.type === 'release-frame') this.invalidatedFrameIds.delete(task.releasedFrameId);
        if (data.ok && task.type === 'warmup') {
          this.deviceWarmed = true;
          if (task.options?.analysisKinds) for (const kind of task.options.analysisKinds) this.warmedAnalysisKinds.add(kind);
          else this.warmedUp = true;
        }
      }
      if (data.ok) this.settle(task, null, task.type === 'analyze' ? data.result : this.cacheStatus);
      else { const error = new Error(data.error || 'GPU analysis failed.'); error.name = data.name || 'Error';
        error.analysisErrorKind = data.errorKind;
        error.gpuDeviceUnavailable = Boolean(data.gpuDeviceUnavailable);
        error.gpuAnalysisKind = data.gpuAnalysisKind;
        error.gpuUnsupportedScope = data.gpuUnsupportedScope;
        error.gpuUnsupportedCode = data.gpuUnsupportedCode;
        error.gpuOutOfMemory = Boolean(data.gpuOutOfMemory);
        this.settle(task, error); }
      this.finishDispatch(task);
    });
    const fail = (event) => {
      if (this.worker !== worker) return;
      this.fallbackGeneration++;
      const error = new Error(event.message || 'The GPU analysis worker failed.');
      if (event.name) error.name = event.name;
      if (event.gpuDeviceLost) error.gpuDeviceLost = true;
      for (const task of this.active) this.settle(task, error);
      // GPU-off keeps accepted analyses alive for CPU fallback, but it must
      // not start a replacement device merely to run their queued GPU jobs.
      if (this.releaseWhenIdle) for (const task of this.queue) this.settle(task, error);
      this.worker?.terminate(); this.worker = null; this.active = [];
      this.cachedFrameIds.clear(); this.cachedCartesianFrames.clear(); this.positionSources.clear();
      this.ptmSources.clear(); this.cachedPtmFits.clear();
      this._cacheStatus = { ...EMPTY_CACHE }; this.warmedUp = this.deviceWarmed = false; this.warmedAnalysisKinds.clear(); this.pump();
    };
    this.worker.addEventListener('error', fail);
    this.worker.addEventListener('messageerror', fail);
  }

  pump() {
    if (this.closed) return;
    for (;;) {
      while (this.queue[0]?.settled) this.queue.shift();
      const task = this.queue[0];
      if (!task) { if (!this.active.length && this.releaseWhenIdle) this.release(); return; }
      if (this.active.length && !this.canPipeline(task)) return;
      this.queue.shift();
      this.active.push(task);
      void this.dispatch(task);
    }
  }

  /** Post the next analysis behind running work only when its frame (and
   * reference frame) are resident and every earlier task has been posted, so
   * the worker still receives and runs tasks in queue order. */
  canPipeline(task) {
    if (this.active.length >= MAX_TASKS_IN_FLIGHT || task.type !== 'analyze' || task.generation !== this.generation) return false;
    if (this.active.some(active => !active.dispatched || ['clear-frames', 'release-frame'].includes(active.type))) return false;
    const resident = frame => { const id = this.frameIds.get(frame); return id !== undefined && this.cachedFrameIds.has(id); };
    if (!task.frame || !resident(task.frame)) return false;
    if (REFERENCE_KINDS.has(task.parameters?.kind)) {
      try { if (!resident(this.referenceFrame(task.parameters))) return false; } catch { return false; }
    }
    return true;
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
      if (task.type === 'analyze' && REFERENCE_KINDS.has(parameters?.kind)) {
        referenceSource = this.referenceFrame(parameters);
        this.validateReference(task.frame, parameters, referenceSource);
        if (parameters.referenceFrameIndex !== undefined) this.associateFrame(referenceSource, parameters.referenceFrameIndex);
      }
      const transfer = [];
      const preparedIds = new Set();
      const prepareFramePayload = async (source) => {
        const id = this.frameRevision(source);
        const index = this.frameIndexes.get(source);
        let payload;
        if (!this.cachedFrameIds.has(id) && !preparedIds.has(id)) {
          const fractional = await copyArray(source.fractional, task);
          const types = source.types ? await copyArray(source.types, task) : undefined;
          payload = { fractional, types, typeLabels: source.typeLabels, cell: source.cell, gpuFrameId: id,
            // Subsets retain their trajectory index for foreground routing,
            // but only the complete current frame is permanently pinned.
            gpuDerivedFrame: source === task.frame && Boolean(task.sourceFrame && task.sourceFrame !== source) };
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
      if (task.type === 'analyze' && REFERENCE_KINDS.has(parameters?.kind)) {
        const reference = await prepareFramePayload(referenceSource);
        referenceFrameId = reference.id; referenceFrameIndex = reference.index; referenceFrame = reference.payload;
        if (frameId === referenceFrameId && frameIndex !== undefined && referenceFrameIndex !== frameIndex) {
          throw validationError('The same GPU frame cannot have different current and reference indexes.');
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
      const positionSources = [];
      if (task.type === 'analyze' && parameters?.kind === 'displacement') {
        const variant = parameters.minimumImage === false ? 'unwrapped-cartesian' : 'cartesian';
        const positions = {};
        const prepared = new Map();
        for (const [name, id] of [['currentPositions', frameId], ['referencePositions', referenceFrameId]]) {
          const source = parameters[name];
          if (!ArrayBuffer.isView(source) || source instanceof DataView) throw validationError(`GPU displacement requires typed ${name} coordinates.`);
          const prior = prepared.get(id);
          if (prior) {
            if (prior.source !== source) throw validationError('The same GPU frame requires the same current and reference displacement coordinates.');
            positions[name] = prior.payload; continue;
          }
          const unacknowledged = this.active.some(active => active !== task && active.dispatched
            && active.generation === this.generation && active.positionSources?.some(pending =>
              pending.uploaded && pending.id === id && pending.variant === variant && pending.source === source));
          const reused = !unacknowledged && this.cachedCartesianFrames.get(id)?.has(variant)
            && this.positionSources.get(id)?.get(variant) === source;
          if (!reused) {
            positions[name] = await copyArray(source, task); transfer.push(positions[name].buffer);
          } else positions[name] = undefined;
          positionSources.push({ id, variant, source, uploaded: !reused });
          prepared.set(id, { source, payload: positions[name] });
        }
        parameters = { ...parameters, ...positions };
      }
      if (task.type === 'analyze' && parameters?.kind === 'centrosymmetry' && parameters.structureInput !== undefined) {
        if (parameters.mode !== 'auto' || !(parameters.structureInput instanceof Uint8Array)
            || parameters.structureInput.length !== task.frame.fractional.length / 3 || parameters.structureInput.some(type => type > 4)) {
          throw validationError('GPU Auto central symmetry requires complete typed adaptive CNA structure IDs.');
        }
        const structureInput = await copyArray(parameters.structureInput, task); transfer.push(structureInput.buffer);
        parameters = { ...parameters, structureInput };
      }
      let ptmSource;
      if (task.type === 'analyze' && parameters?.kind === 'strain' && parameters.ptmInput) {
        const source = parameters.ptmInput, previous = this.ptmSources.get(frameId);
        const unchanged = previous && previous.structures === source.structures && previous.scales === source.scales
          && previous.deformation === source.deformation && previous.types === task.frame.types && previous.revision === source.revision;
        const id = unchanged ? previous.id : this.nextPtmFitId++;
        const reused = unchanged && this.cachedPtmFits.get(frameId) === id;
        const ptmInput = reused ? undefined : {};
        for (const name of ['structures', 'scales', 'deformation']) {
          const array = source[name];
          if (!ArrayBuffer.isView(array) || array instanceof DataView) throw validationError(`GPU strain requires a typed PTM ${name} array.`);
          if (!reused) { ptmInput[name] = await copyArray(array, task); transfer.push(ptmInput[name].buffer); }
        }
        let ptmTypes;
        if (!reused) {
          if (!ArrayBuffer.isView(task.frame.types) || task.frame.types instanceof DataView) throw validationError('GPU strain requires typed element IDs.');
          ptmTypes = await copyArray(task.frame.types, task); transfer.push(ptmTypes.buffer);
        }
        ptmSource = { id, structures: source.structures, scales: source.scales, deformation: source.deformation,
          types: task.frame.types, revision: source.revision };
        parameters = { ...parameters, ptmInput, ptmTypes, ptmFitId: id, ptmRevision: source.revision };
      }
      for (const source of [task.frame, referenceSource, task.sourceFrame]) if (source) this.frameRevision(source);
      if (task.settled) { this.finishDispatch(task); return; }
      if (this.worker !== worker) throw abortError();
      task.dispatched = true;
      worker.postMessage({ type: task.type, id: task.id, frameId, frameIndex, frame,
        referenceFrameId, referenceFrameIndex, referenceFrame, parameters, options: task.options, releasedFrameId: task.releasedFrameId }, transfer);
      if (ptmSource) {
        task.ptmSource = { frameId, source: ptmSource };
        this.ptmSources.set(frameId, ptmSource);
      }
      task.positionSources = positionSources;
      for (const { id, variant, source } of positionSources) {
        let variants = this.positionSources.get(id);
        if (!variants) { variants = new Map(); this.positionSources.set(id, variants); }
        variants.set(variant, source);
      }
      // A resident next task may now be posted behind this one.
      this.pump();
    } catch (error) { this.settle(task, error); this.finishDispatch(task); }
  }

  finishDispatch(task) {
    const index = this.active.indexOf(task);
    if (index >= 0) { this.active.splice(index, 1); this.pump(); }
  }

  validateReference(frame, parameters, reference) {
    const mapping = parameters.referenceMapping;
    if (!ArrayBuffer.isView(mapping) || mapping instanceof DataView) throw validationError('GPU reference strain requires a typed referenceMapping array.');
    const currentIndex = this.frameIndexes.get(frame);
    const requestedIndex = parameters.referenceFrameIndex ?? this.frameIndexes.get(reference);
    if (reference === frame && requestedIndex !== undefined && currentIndex !== undefined && requestedIndex !== currentIndex) {
      throw validationError('The same GPU frame cannot have different current and reference indexes.');
    }
    if (requestedIndex !== undefined && currentIndex === requestedIndex
        && (reference.fractional !== frame.fractional || reference.cell !== frame.cell)) {
      throw validationError('GPU current and reference frames with the same index must identify the same coordinates and cell.');
    }
  }

  referenceFrame(parameters) {
    // Legacy coordinate-only references have no species array. They may cache
    // privately, but must not claim a trajectory index whose real frame can
    // later be used for element-filtered RDF or bonds.
    if (parameters.referenceFrameIndex !== undefined && parameters.referenceFrame === undefined) {
      throw validationError('GPU reference frame indexes require an actual referenceFrame.');
    }
    const fractional = parameters.referenceFractional;
    if (!ArrayBuffer.isView(fractional) || fractional instanceof DataView) throw validationError('GPU reference strain requires typed referenceFractional coordinates.');
    const cell = parameters.referenceCell;
    if (!cell || typeof cell !== 'object') throw validationError('GPU reference strain requires a reference cell.');
    if (parameters.referenceFrame !== undefined) {
      const frame = parameters.referenceFrame;
      if (frame?.fractional !== fractional || frame.cell !== cell) throw validationError('GPU reference frame metadata must identify the supplied reference coordinates and cell.');
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
    this.fallbackGeneration++;
    for (const task of this.pending.values()) this.settle(task, abortError());
    this.queue.length = 0; this.worker?.terminate(); this.worker = null; this.active = [];
    this.cachedFrameIds.clear(); this.cachedCartesianFrames.clear(); this.positionSources.clear();
    this.ptmSources.clear(); this.cachedPtmFits.clear();
    this._cacheStatus = { ...EMPTY_CACHE }; this.warmedUp = this.deviceWarmed = false; this.warmedAnalysisKinds.clear();
    this.frameIds = new WeakMap(); this.frameIndexes = new WeakMap(); this.indexedFrames = new WeakSet(); this.indexFrameIds.clear();
    this.frameSnapshots = new WeakMap(); this.frameMetadata.clear(); this.invalidatedFrameIds.clear(); this.derivedFrameIds.clear();
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
function abortError() { return new DOMException('Analysis cancelled.', 'AbortError'); }
import { prepareVoronoiSelection, voronoiSelectionRange, expandVoronoiResult, compactVoronoiRadii } from '../voronoi-selection.js';
import { gpuPreparationKinds } from './preparation.js';
import { yieldToMain } from '../../task-yield.js';

const validationError = message => analysisValidationError(new Error(message));
