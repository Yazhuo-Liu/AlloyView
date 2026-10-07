const SUPPORTED_KINDS = new Set(['coordination', 'rdf', 'localShear', 'bonds', 'bondStatistics', 'voronoi', 'strain', 'cna', 'referenceStrain', 'centrosymmetry', 'displacement', 'ptmNeighbors', 'dxaLocal']);
const REFERENCE_KINDS = new Set(['referenceStrain', 'displacement']);
const COPY_CHUNK_BYTES = 4 * 1024 ** 2;
const EMPTY_CACHE = { capacity: 0, cachedFrameIds: [], cachedFrameIndexes: [], fullTrajectory: false,
  frameCount: 0, currentIndex: 0, budgetBytes: 0, allocatedBytes: 0, residentBytes: 0, frameBytes: 0, workspaceBytes: 0,
  preparedVoronoiFrameIds: [], preparedVoronoiFrameIndexes: [], voronoiWorkspaceAtoms: 0,
  neighborIndexCount: 0, neighborIndexBuildCount: 0, voronoiKernelWarmupCount: 0, bufferLimitBytes: 0 };

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
    this.cachedCartesianFrames = new Map();
    this.positionSources = new Map();
    this.ptmSources = new Map();
    this.cachedPtmFits = new Map();
    this.nextPtmFitId = 1;
    this._cacheStatus = { ...EMPTY_CACHE };
    this.generation = 0;
    this.warmedUp = false;
    this.warmedAnalysisKinds = new Set();
    this.releaseWhenIdle = false;
    this.closed = false;
  }

  supports(kind) { return SUPPORTED_KINDS.has(kind); }
  get cacheStatus() { return { ...this._cacheStatus, cachedFrameIds: [...this.cachedFrameIds],
    cachedPtmFits: [...this.cachedPtmFits].map(([frameId, fitId]) => ({ frameId, fitId })),
    cachedFrameIndexes: [...(this._cacheStatus.cachedFrameIndexes ?? [])],
    preparedVoronoiFrameIds: [...(this._cacheStatus.preparedVoronoiFrameIds ?? [])],
    preparedVoronoiFrameIndexes: [...(this._cacheStatus.preparedVoronoiFrameIndexes ?? [])] }; }

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
    this.preemptPreparation();
    if (parameters.kind === 'voronoi' && parameters.selectedTypes != null) {
      try {
        const selection = prepareVoronoiSelection(frame, parameters.selectedTypes), compactFrame = selection.frame,
          range = voronoiSelectionRange(selection, parameters), index = this.frameIndexes.get(frame);
        // A type subset has independent coordinates/index buffers. Keep its own
        // input ID; sharing the trajectory's source ID would reuse wrong sites.
        if (index !== undefined) this.frameIndexes.set(compactFrame, index);
        return this.enqueue('analyze', { frame: compactFrame,
          parameters: { ...parameters, ...range, selectedTypes: null }, signal, onProgress }, 1)
          .then(result => expandVoronoiResult(result, selection));
      } catch (error) { return Promise.reject(error); }
    }
    return this.enqueue('analyze', { frame, parameters, signal, onProgress }, 1);
  }

  /** Transfer an owned native DXA snapshot through the existing device queue.
   * These tables are temporary exports, never application frame coordinates.
   */
  classifyDxa(snapshot, { signal, onProgress = () => {} } = {}) {
    this.preemptPreparation();
    return this.enqueue('classify-dxa', { snapshot, signal, onProgress }, 1);
  }

  identifyDxa(frame, input, options = {}) {
    return this.analyze(frame, { ...input, kind: 'dxaLocal' }, options);
  }

  warmup({ signal, analysisKinds, onProgress = () => {} } = {}) {
    if (signal?.aborted || this.closed) return Promise.reject(abortError());
    let kinds;
    try { kinds = gpuPreparationKinds(analysisKinds); } catch (error) { return Promise.reject(error); }
    this.resume();
    if (this.warmedUp || kinds?.every(kind => this.warmedAnalysisKinds.has(kind))) return Promise.resolve(this.cacheStatus);
    return this.enqueue('warmup', { signal, onProgress, options:{analysisKinds:kinds} }, 2);
  }

  prepareFrame(frame, { frameIndex, signal, analysisKinds, selectedTypes = null, onProgress = () => {} } = {}) {
    if (frameIndex !== undefined) this.associateFrame(frame, frameIndex);
    try {
      const kinds = gpuPreparationKinds(analysisKinds);
      if (kinds?.includes('voronoi') && selectedTypes != null) {
        const selection = prepareVoronoiSelection(frame, selectedTypes), index = this.frameIndexes.get(frame);
        if (index !== undefined) this.frameIndexes.set(selection.frame,index);
        frame = selection.frame;
      }
      return this.enqueue('prepare-frame', { frame, signal, onProgress, options:{analysisKinds:kinds} }, 2);
    } catch (error) { return Promise.reject(error); }
  }

  preemptPreparation() {
    if (['prepare-frame','warmup'].includes(this.current?.type)) this.cancel(this.current);
  }

  configureCache(options = {}) { return this.enqueue('configure-cache', { options }, 0); }

  /** A source barrier: invalidate old uploads before accepting the new source. */
  clearFrames() {
    this.generation++;
    for (const task of this.pending.values()) this.cancel(task);
    this.queue.length = 0;
    this.frameIds = new WeakMap(); this.frameIndexes = new WeakMap(); this.indexFrameIds.clear();
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
        this.cachedCartesianFrames = new Map((data.cachedCartesianFrames ?? []).map(({ frameId, variants }) => [frameId, new Set(variants)]));
        this.cachedPtmFits = new Map((data.cachedPtmFits ?? []).map(({ frameId, fitId }) => [frameId, fitId]));
        for (const frameId of this.positionSources.keys()) if (!this.cachedFrameIds.has(frameId)) this.positionSources.delete(frameId);
        for (const [frameId, fit] of this.ptmSources) if (!this.cachedFrameIds.has(frameId) || this.cachedPtmFits.get(frameId) !== fit.id) this.ptmSources.delete(frameId);
        if (data.cacheStatus) this._cacheStatus = { ...data.cacheStatus };
        if (data.ok && task.type === 'warmup') {
          if (task.options?.analysisKinds) for (const kind of task.options.analysisKinds) this.warmedAnalysisKinds.add(kind);
          else { this.warmedUp = true; this.warmedAnalysisKinds.add('voronoi'); }
        }
      }
      if (data.ok) this.settle(task, null, ['analyze', 'classify-dxa'].includes(task.type) ? data.result : this.cacheStatus);
      else { const error = new Error(data.error || 'GPU analysis failed.'); error.name = data.name || 'Error'; this.settle(task, error); }
      if (this.current === task) { this.current = null; this.pump(); }
    });
    const fail = (event) => {
      if (this.worker !== worker) return;
      const error = new Error(event.message || 'The GPU analysis worker failed.');
      if (this.current) this.settle(this.current, error);
      this.worker?.terminate(); this.worker = null; this.current = null;
      this.cachedFrameIds.clear(); this.cachedCartesianFrames.clear(); this.positionSources.clear();
      this.ptmSources.clear(); this.cachedPtmFits.clear();
      this._cacheStatus = { ...EMPTY_CACHE }; this.warmedUp = false; this.warmedAnalysisKinds.clear(); this.pump();
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
      if (task.type === 'classify-dxa') {
        const { validateGpuDxaSnapshot } = await import('./dxa.js');
        validateGpuDxaSnapshot(task.snapshot, { validateValues: false });
        const transfer = [...new Set(['vertices', 'tetrahedra', 'edges', 'transitions'].map(name => task.snapshot[name].buffer))];
        if (task.settled) { this.finishDispatch(task); return; }
        if (this.worker !== worker) throw abortError();
        task.dispatched = true;
        worker.postMessage({ type: task.type, id: task.id, snapshot: task.snapshot }, transfer);
        return;
      }
      let frameId, frameIndex, frame, referenceFrameId, referenceFrameIndex, referenceFrame;
      let parameters = task.parameters;
      let referenceSource;
      if (task.type === 'analyze' && REFERENCE_KINDS.has(parameters?.kind)) {
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
          payload = { fractional, types, typeLabels: source.typeLabels, cell: source.cell, gpuFrameId: id };
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
      const positionSources = [];
      if (task.type === 'analyze' && parameters?.kind === 'dxaLocal') {
        const { validateGpuDxaLocalInput } = await import('./dxa-local.js');
        validateGpuDxaLocalInput(task.frame, parameters);
        const input = {};
        for (const name of ['coordinates', 'templates', 'inverse']) {
          input[name] = await copyArray(parameters[name], task);
          transfer.push(input[name].buffer);
        }
        parameters = { ...parameters, ...input };
      }
      if (task.type === 'analyze' && parameters?.kind === 'displacement') {
        const variant = parameters.minimumImage === false ? 'unwrapped-cartesian' : 'cartesian';
        const positions = {};
        const prepared = new Map();
        for (const [name, id] of [['currentPositions', frameId], ['referencePositions', referenceFrameId]]) {
          const source = parameters[name];
          if (!ArrayBuffer.isView(source) || source instanceof DataView) throw new Error(`GPU displacement requires typed ${name} coordinates.`);
          const prior = prepared.get(id);
          if (prior) {
            if (prior.source !== source) throw new Error('The same GPU frame requires the same current and reference displacement coordinates.');
            positions[name] = prior.payload; continue;
          }
          const reused = this.cachedCartesianFrames.get(id)?.has(variant) && this.positionSources.get(id)?.get(variant) === source;
          if (!reused) {
            positions[name] = await copyArray(source, task); transfer.push(positions[name].buffer);
            positionSources.push({ id, variant, source });
          } else positions[name] = undefined;
          prepared.set(id, { source, payload: positions[name] });
        }
        parameters = { ...parameters, ...positions };
      }
      if (task.type === 'analyze' && parameters?.kind === 'centrosymmetry' && parameters.structureInput !== undefined) {
        if (parameters.mode !== 'auto' || !(parameters.structureInput instanceof Uint8Array)
            || parameters.structureInput.length !== task.frame.fractional.length / 3 || parameters.structureInput.some(type => type > 4)) {
          throw new Error('GPU Auto central symmetry requires complete typed adaptive CNA structure IDs.');
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
          if (!ArrayBuffer.isView(array) || array instanceof DataView) throw new Error(`GPU strain requires a typed PTM ${name} array.`);
          if (!reused) { ptmInput[name] = await copyArray(array, task); transfer.push(ptmInput[name].buffer); }
        }
        let ptmTypes;
        if (!reused) {
          if (!ArrayBuffer.isView(task.frame.types) || task.frame.types instanceof DataView) throw new Error('GPU strain requires typed element IDs.');
          ptmTypes = await copyArray(task.frame.types, task); transfer.push(ptmTypes.buffer);
        }
        ptmSource = { id, structures: source.structures, scales: source.scales, deformation: source.deformation,
          types: task.frame.types, revision: source.revision };
        parameters = { ...parameters, ptmInput, ptmTypes, ptmFitId: id, ptmRevision: source.revision };
      }
      if (task.settled) { this.finishDispatch(task); return; }
      if (this.worker !== worker) throw abortError();
      task.dispatched = true;
      worker.postMessage({ type: task.type, id: task.id, frameId, frameIndex, frame,
        referenceFrameId, referenceFrameIndex, referenceFrame, parameters, options: task.options }, transfer);
      if (ptmSource) this.ptmSources.set(frameId, ptmSource);
      for (const { id, variant, source } of positionSources) {
        let variants = this.positionSources.get(id);
        if (!variants) { variants = new Map(); this.positionSources.set(id, variants); }
        variants.set(variant, source);
      }
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
      for (const task of this.pending.values()) if (!['analyze', 'classify-dxa'].includes(task.type)) this.cancel(task);
      this.pump();
      return;
    }
    this.releaseWhenIdle = false;
    this.generation++;
    for (const task of this.pending.values()) this.settle(task, abortError());
    this.queue.length = 0; this.worker?.terminate(); this.worker = null; this.current = null;
    this.cachedFrameIds.clear(); this.cachedCartesianFrames.clear(); this.positionSources.clear();
    this.ptmSources.clear(); this.cachedPtmFits.clear();
    this._cacheStatus = { ...EMPTY_CACHE }; this.warmedUp = false; this.warmedAnalysisKinds.clear();
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
function abortError() { return new DOMException('Analysis cancelled.', 'AbortError'); }
import { prepareVoronoiSelection, voronoiSelectionRange, expandVoronoiResult } from '../voronoi-selection.js';
import { gpuPreparationKinds } from './preparation.js';
import { yieldToMain } from '../../task-yield.js';
