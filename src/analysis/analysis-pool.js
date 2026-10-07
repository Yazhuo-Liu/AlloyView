import { CSP_SUMMARY_FIELDS } from './centrosymmetry.js';
import { MAX_BONDS } from './bonds.js';
import { mergeBondStatisticsPartials } from './bond-statistics.js';
import { VORONOI_FIELDS, mergeVoronoiPartials } from './voronoi.js';
import { prepareVoronoiSelection, expandVoronoiResult, mapVoronoiGeometry,
  compactVoronoiAtomIndices } from './voronoi-selection.js';
import { finalizeRdf } from './rdf.js';
import { modalCoordination, shearInvariant } from './local-shear.js';
import { REFERENCE_STRAIN_FIELDS } from './reference-strain.js';
import { GpuAnalysisClient } from './gpu/client.js';
import { validateReferences } from './lattice.js';
import { validatePtmParameters, validatePreparedPtmNeighbors } from './ptm.js';
import { CpuBudget, cpuWorkerLimit } from './cpu-budget.js';
import { yieldToMain } from '../task-yield.js';
import { analyzeDxaStagePool, DXA_STAGE_KINDS } from './dxa-cpu-pool.js';

const PTM_INITIAL_HEAP_BYTES = 16 * 1024 ** 2;
const VORONOI_INITIAL_HEAP_BYTES = 16 * 1024 ** 2;
const VORONOI_RESIDENT_KINDS = ['voronoi', 'voronoiGeometry', 'voronoiGeometryBatch', 'voronoiPrepare'];
const CPU_MODULES = ['voronoi', 'ptm', 'dxa'];
const COPY_CHUNK_BYTES = 4 * 1024 ** 2;
const PTM_OUTPUT_FIELDS = { structures: [Uint8Array, 1], rmsd: [Float32Array, 1], scales: [Float64Array, 1],
  deformation: [Float64Array, 9], distances: [Float32Array, 1] };
const PTM_NEIGHBOR_FIELDS = ['counts', 'indices', 'vectors'];
// GPU PTM neighbors order candidates in emulated binary64 on one device queue,
// while CPU workers search neighbors in parallel within the fit. On NiGB the
// GPU takes about 5 µs per atom and a CPU worker about 27 µs, so the GPU stage
// only shortens PTM for pools of at most three workers.
export const GPU_PTM_NEIGHBOR_MAX_WORKERS = 3;
const STRAIN_OUTPUT_FIELDS = Object.fromEntries(['atomicShearStrain', 'atomicHydrostaticStrain', 'atomicVolumeChange',
  'strainE11', 'strainE22', 'strainE33', 'strainE12', 'strainE13', 'strainE23'].map((name) => [name, [Float32Array, 1]]));
const INPUT_ARRAY_FIELDS = ['structureInput', 'types', 'referenceFractional', 'referenceMapping', 'metricInput', 'currentPositions', 'referencePositions'];
const EXTRA_OUTPUT_FIELDS = {
  bonds: { coordination: [Uint32Array, 1] },
  bondStatistics: { coordination: [Uint32Array, 1], q4: [Float32Array, 1], q6: [Float32Array, 1] },
  voronoi: VORONOI_FIELDS,
  rdf: {},
  localShearCoordination: { coordination: [Uint32Array, 1] },
  localShearMetrics: { metrics: [Float64Array, 6] },
  localShearFinalize: { localShear: [Float32Array, 1] },
  referenceStrain: Object.fromEntries(REFERENCE_STRAIN_FIELDS.map((name) => [name, [Float32Array, 1]])),
  displacement: { vectors: [Float32Array, 3], magnitudes: [Float64Array, 1] },
};

/** `coordinateBytes` is held by every worker. `sharedBytes` does not grow
 * with the worker count, e.g. disjoint output ranges and their merged result. */
export function chooseWorkerCount(atomCount, coordinateBytes, environment = globalThis, targetAtoms = 50_000, { sharedBytes = 0 } = {}) {
  let count = Math.min(Math.max(1, Math.ceil(atomCount / targetAtoms)), cpuWorkerLimit(environment));
  const heapLimit = Number(environment.performance?.memory?.jsHeapSizeLimit);
  const copyBudget = Number.isFinite(heapLimit) ? heapLimit * 0.15 : 256 * 1024 ** 2;
  while (count > 1 && coordinateBytes * count + sharedBytes > copyBudget) count -= 1;
  return count;
}

/** One concurrency budget across all analyses, with cancellation and bounded
 * coordinate copies. Every task owns a disjoint central-atom range.
 */
export class AnalysisPool {
  /** `ptmNeighborBackend: 'gpu'` always prepares PTM neighbors on the GPU when
   * it is enabled; `'auto'` does so only for small CPU pools. */
  constructor({ environment = globalThis, gpuBackend, cpuBudget, ptmNeighborBackend = 'auto', workerFactory = () => new Worker(
    new URL('../workers/analysis-worker.js', import.meta.url), { type: 'module' },
  ) } = {}) {
    if (!['auto', 'gpu'].includes(ptmNeighborBackend)) throw new Error('PTM neighbors must use the auto or gpu backend.');
    this.environment = environment;
    this.ptmNeighborBackend = ptmNeighborBackend;
    this.workerFactory = workerFactory;
    this.cpuBudget = cpuBudget ?? new CpuBudget({ environment });
    this.limit = this.cpuBudget.limit;
    this.active = new Set();
    this.idle = [];
    this.controllers = new Set();
    this.queue = [];
    this.nextId = 1;
    this.slots = new Set();
    this.dxaStages = new Map();
    this.slotWaiters = new Set();
    this.cpuWarmup = null;
    this.cpuFramePreparation = null;
    this.voronoiSnapshot = null;
    this.voronoiSnapshotPending = null;
    this.voronoiSnapshotGeneration = 0;
    this.nextVoronoiFrameKey = 1;
    this.closed = false;
    this.gpuEnabled = false;
    this.gpuBackend = gpuBackend ?? new GpuAnalysisClient({ environment });
  }

  setGpuEnabled(enabled) { this.gpuEnabled = Boolean(enabled); if (this.gpuEnabled) this.gpuBackend.resume?.(); }
  releaseGpuResources(options) { return this.gpuBackend.release?.(options); }
  warmupGpu(options) { return this.gpuBackend.warmup?.(options) ?? Promise.resolve(this.gpuCacheStatus); }
  configureGpuCache(options) { return this.gpuBackend.configureCache?.(options) ?? Promise.resolve(this.gpuCacheStatus); }
  prepareGpuFrame(frame, options) { return this.gpuBackend.prepareFrame?.(frame, options) ?? Promise.resolve(this.gpuCacheStatus); }
  associateGpuFrame(frame, frameIndex) { return this.gpuBackend.associateFrame?.(frame, frameIndex); }
  clearGpuFrames() { return this.gpuBackend.clearFrames?.() ?? Promise.resolve(this.gpuCacheStatus); }
  clearVoronoiFrames() {
    this.cpuFramePreparation?.controller.abort();
    this.voronoiSnapshot = null;
    this.voronoiSnapshotGeneration++;
    for (const slot of this.slots) {
      if (slot.task) slot.voronoiReleasePending = true;
      else this.releaseVoronoiFrame(slot);
    }
  }

  releaseVoronoiFrame(slot) {
    if (!slot.terminated) slot.worker.postMessage({ kind: 'voronoiRelease' });
    delete slot.voronoiFrameKey;
    slot.voronoiReleasePending = false;
    slot.residentInputBytes = 0;
  }

  analyzeDxaLocal(input, options) { return analyzeDxaStagePool(this, 'local', input, options); }
  analyzeDxaTetrahedra(input, options) { return analyzeDxaStagePool(this, 'tetrahedra', input, options); }

  reserveDxaStage(key, workerCount) {
    this.dxaStages.set(key, { workerCount, slots: new Set(), activeWorkers: 0, peakWorkers: 0 });
  }

  releaseDxaStage(key) {
    const stage = this.dxaStages.get(key);
    for (const slot of stage?.slots ?? []) if (slot.dxaReservedKey === key) delete slot.dxaReservedKey;
    this.dxaStages.delete(key);
    this.releaseDxaStageFrames(key);
    this.notifyWorkerSlots();
  }

  releaseDxaStageFrames(key) {
    for (const slot of this.slots) if (slot.dxaResidentKey === key) {
      if (slot.task) slot.dxaReleasePending = key;
      else {
        slot.worker.postMessage({ kind: 'dxaRelease', dxaResidentKey: key });
        delete slot.dxaResidentKey;
      }
    }
  }
  get gpuCacheStatus() { return this.gpuBackend.cacheStatus ?? null; }

  get cpuWarmupStatus() {
    const readyModules = Object.fromEntries(CPU_MODULES.map(module => [module,
      [...this.slots].filter(slot => slot[`${module}Warmed`]).length]));
    return { readyWorkers: readyModules.ptm, readyModules,
      preparedVoronoiWorkers: this.voronoiSnapshot ? [...this.slots]
        .filter(slot => slot.voronoiFrameKey === this.voronoiSnapshot.key).length : 0,
      preparedVoronoiFrameKey: this.voronoiSnapshot?.key ?? null,
      workerCount: this.slots.size, targetWorkers: this.cpuWarmup?.target ?? 0, maximumWorkers: this.limit };
  }

  cpuModuleStatus(modules, targetWorkers) {
    return { ...this.cpuWarmupStatus, modules: [...modules], targetWorkers,
      readyWorkers: [...this.slots].filter(slot => modules.every(module => slot[`${module}Warmed`])).length };
  }

  cpuModuleWorkerCount(atomCount, coordinateBytes, modules) {
    const sharedMemory = Boolean(this.environment.crossOriginIsolated && typeof SharedArrayBuffer === 'function');
    const bytes = (sharedMemory ? 0 : coordinateBytes) + (modules.includes('ptm') ? atomCount * 48 + PTM_INITIAL_HEAP_BYTES : 0)
      + (modules.includes('voronoi') ? VORONOI_INITIAL_HEAP_BYTES : 0) + (modules.includes('dxa') ? 32 * 1024 ** 2 : 0);
    return Math.min(this.limit, chooseWorkerCount(atomCount, bytes, this.environment, 4_096));
  }

  /** Preheat the heavy-analysis pool while a source is loading or expanding.
   * Multiple callers share a growing request; initialized modules survive it.
   * Cancelling one caller leaves the others' warmup intact.
   */
  warmupCpu({ atomCount, coordinateBytes = atomCount * 3 * Float64Array.BYTES_PER_ELEMENT,
    modules = ['ptm'], signal, onProgress = () => {} } = {}) {
    if (this.closed) return Promise.reject(new Error('The analysis pool is closed.'));
    if (signal?.aborted) return Promise.reject(abortError());
    if (!Number.isInteger(atomCount) || atomCount < 1 || !Number.isFinite(coordinateBytes) || coordinateBytes < 0) {
      return Promise.reject(new Error('CPU warmup requires a positive atom count and valid coordinate size.'));
    }
    if (!Array.isArray(modules) || !modules.length || modules.some(module => !CPU_MODULES.includes(module))) {
      return Promise.reject(new Error('CPU warmup modules must include ptm, voronoi or dxa.'));
    }
    modules = CPU_MODULES.filter(module => modules.includes(module));
    const target = this.cpuModuleWorkerCount(atomCount, coordinateBytes, modules);
    if (this.cpuModuleStatus(modules, target).readyWorkers >= target) {
      const status = this.cpuModuleStatus(modules, target);
      return Promise.resolve().then(() => { if (signal?.aborted) throw abortError(); onProgress(status); return status; });
    }
    let session = this.cpuWarmup;
    if (!session || session.controller.signal.aborted) {
      const controller = new AbortController();
      session = { controller, target, atomCount, coordinateBytes, modules, subscribers: new Set(), promise: null };
      this.cpuWarmup = session;
      this.controllers.add(controller);
      session.promise = Promise.resolve().then(() => this.prepareCpuWorkers(session)).finally(() => {
        this.controllers.delete(controller);
        if (this.cpuWarmup === session) this.cpuWarmup = null;
      });
    }
    session.atomCount = Math.max(session.atomCount, atomCount);
    session.coordinateBytes = Math.max(session.coordinateBytes, coordinateBytes);
    session.modules = CPU_MODULES.filter(module => session.modules.includes(module) || modules.includes(module));
    session.target = this.cpuModuleWorkerCount(session.atomCount, session.coordinateBytes, session.modules);
    return new Promise((resolve, reject) => {
      const subscriber = { target, atomCount, coordinateBytes, modules, onProgress };
      session.subscribers.add(subscriber);
      let settled = false;
      const finish = (error, status) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        session.subscribers.delete(subscriber);
        if (!session.subscribers.size) session.controller.abort();
        else {
          session.atomCount = Math.max(...[...session.subscribers].map(item => item.atomCount));
          session.coordinateBytes = Math.max(...[...session.subscribers].map(item => item.coordinateBytes));
          session.target = this.cpuModuleWorkerCount(session.atomCount, session.coordinateBytes, session.modules);
        }
        if (error) reject(error); else resolve(status);
      };
      const abort = () => finish(abortError());
      signal?.addEventListener('abort', abort, { once: true });
      session.promise.then(status => finish(null, status), error => finish(error));
      try { onProgress(this.cpuModuleStatus(modules, target)); }
      catch (error) { finish(error); }
    });
  }

  async prepareCpuWorkers(session) {
    const { signal } = session.controller;
    const report = () => {
      const status = this.cpuModuleStatus(session.modules, session.target);
      for (const subscriber of session.subscribers) subscriber.onProgress(this.cpuModuleStatus(subscriber.modules, session.target));
      return status;
    };
    try {
      while (this.cpuModuleStatus(session.modules, session.target).readyWorkers < session.target) {
        if (signal.aborted || this.closed) throw abortError();
        const missing = Math.min(2, session.target - this.cpuModuleStatus(session.modules, session.target).readyWorkers);
        await Promise.all(Array.from({ length: missing }, () => this.runTask({ kind: 'warmup', modules: session.modules }, signal,
          signal, () => {}, true).then(report)));
        // An already warm idle slot may stand in while all other resident
        // slots are busy. Wait for them instead of creating extra modules.
        if (this.cpuModuleStatus(session.modules, session.target).readyWorkers < session.target) await waitForCpuResources();
      }
      if (signal.aborted || this.closed) throw abortError();
      return report();
    } catch (error) { session.controller.abort(); throw error; }
  }

  voronoiWorkerCount(frame, workCount = frame.fractional.length / 3, targetAtoms = 512) {
    const atomCount = frame.fractional.length / 3;
    const sharedMemory = Boolean(this.environment.crossOriginIsolated && typeof SharedArrayBuffer === 'function');
    // Both heavy native modules can share these resident slots. Account for
    // their actual 16 MiB initial heaps, normalized coordinates and linked bins.
    const workerBytes = frame.fractional.byteLength * (sharedMemory ? 1 : 2) + atomCount * 20
      + VORONOI_INITIAL_HEAP_BYTES + PTM_INITIAL_HEAP_BYTES;
    return Math.min(this.limit, chooseWorkerCount(workCount, workerBytes, this.environment, targetAtoms));
  }

  /** Snapshot coordinates and build the resident Voronoi index in background
   * jobs, independently of PTM preheating. This never computes atomic cells. */
  async prepareCpuFrame(sourceFrame, { kind = 'voronoi', selectedTypes = null, signal, onProgress = () => {} } = {}) {
    if (this.closed) throw new Error('The analysis pool is closed.');
    if (signal?.aborted) throw abortError();
    if (kind !== 'voronoi') throw new Error('CPU frame preparation supports voronoi.');
    const selection = prepareVoronoiSelection(sourceFrame, selectedTypes), frame = selection.frame;
    const atomCount = frame.fractional.length / 3;
    if (!Number.isInteger(atomCount) || atomCount < 1) throw new Error('Analysis requires at least one atom.');
    const sharedMemory = Boolean(this.environment.crossOriginIsolated && typeof SharedArrayBuffer === 'function');
    const target = this.voronoiWorkerCount(frame), snapshot = await this.prepareVoronoiSnapshot(frame, sharedMemory, signal);
    if (signal?.aborted || this.closed) throw abortError();
    const status = (phase = 'ready') => ({ kind, atomCount, sharedMemory, phase, frameKey: snapshot.key,
      targetWorkers: target, readyWorkers: [...this.slots].filter(slot => slot.voronoiFrameKey === snapshot.key).length,
      readyModules: this.cpuWarmupStatus.readyModules });
    if (status().readyWorkers >= target) { const ready = status(); onProgress(ready); return ready; }
    let session = this.cpuFramePreparation;
    if (!session || session.snapshot.key !== snapshot.key || session.controller.signal.aborted) {
      session?.controller.abort();
      const controller = new AbortController();
      session = { controller, snapshot, target, subscribers: new Set(), promise: null };
      this.cpuFramePreparation = session; this.controllers.add(controller);
      session.promise = Promise.resolve().then(async () => {
        const report = (phase = 'preparing') => {
          const progress = status(phase);
          for (const subscriber of session.subscribers) subscriber.onProgress(progress);
          return progress;
        };
        try {
          while (status().readyWorkers < target) {
            if (controller.signal.aborted || this.closed) throw abortError();
            const missing = Math.min(2, target - status().readyWorkers);
            await Promise.all(Array.from({ length: missing }, () => this.runTask({ kind: 'voronoiPrepare',
              fractional: snapshot.coordinates, cell: snapshot.cell, residentFrameKey: snapshot.key },
            controller.signal, undefined, phase => report(phase), sharedMemory).then(() => report())));
            if (status().readyWorkers < target) await waitForCpuResources();
          }
          if (controller.signal.aborted || this.closed) throw abortError();
          return report('ready');
        } catch (error) { controller.abort(); throw error; }
      }).finally(() => {
        this.controllers.delete(controller);
        if (this.cpuFramePreparation === session) this.cpuFramePreparation = null;
      });
    }
    return new Promise((resolve, reject) => {
      const subscriber = { onProgress }; session.subscribers.add(subscriber);
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; signal?.removeEventListener('abort', abort); session.subscribers.delete(subscriber);
        if (!session.subscribers.size) session.controller.abort();
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(abortError());
      signal?.addEventListener('abort', abort, { once: true });
      session.promise.then(value => finish(null, value), error => finish(error));
      try { onProgress(status('preparing')); } catch (error) { finish(error); }
    });
  }

  async analyze(frame, parameters, { onProgress = () => {}, signal, frameIndex } = {}) {
    if (this.closed) throw new Error('The analysis pool is closed.');
    if (signal?.aborted) throw abortError();
    const analysisStartedAt = performance.now();
    const gpuRequested = this.gpuEnabled;
    if (gpuRequested && parameters.kind === 'ptm') {
      return this.analyzePtmWithGpu(frame, parameters, { onProgress, signal, frameIndex });
    }
    if (gpuRequested && parameters.kind === 'strain' && this.gpuBackend.supports('strain')) {
      return this.analyzeStrainWithGpu(frame, parameters, { onProgress, signal, frameIndex });
    }
    let fallbackReason;
    if (gpuRequested) {
      if (!this.gpuBackend.supports(parameters.kind)) fallbackReason = `The ${parameters.kind} analysis uses CPU workers; no GPU kernel is available.`;
      else {
        try {
          const result = await this.gpuBackend.analyze(frame, parameters, { onProgress, signal, frameIndex });
          if (signal?.aborted || this.closed) throw abortError();
          return { ...result, backend: 'gpu', gpuRequested: true, elapsedMs: performance.now() - analysisStartedAt };
        } catch (error) {
          if (error.name === 'AbortError' || signal?.aborted || this.closed) throw abortError();
          fallbackReason = error.message || 'The GPU calculation failed; using CPU workers.';
        }
      }
    }
    const result = await this.analyzeCPU(frame, parameters, { signal,
      onProgress: (update) => onProgress({ ...update, backend: 'cpu', ...(fallbackReason ? { fallbackReason } : {}) }) });
    return { ...result, backend: 'cpu', gpuRequested, elapsedMs: performance.now() - analysisStartedAt,
      ...(fallbackReason ? { fallbackReason } : {}) };
  }

  /** GPU prepares geometry; the resident CPU pool remains the PTM fitter. */
  async analyzePtmWithGpu(frame, parameters, { onProgress, signal, frameIndex }) {
    const startedAt = performance.now(), atomCount = frame.fractional.length / 3;
    if (!Number.isInteger(atomCount) || atomCount < 1) throw new Error('Analysis requires at least one atom.');
    validatePtmParameters(parameters);
    const suppliedNeighbors = parameters.preparedNeighbors !== undefined;
    const prepareNeighbors = !suppliedNeighbors && this.gpuPtmNeighbors();
    const stages = prepareNeighbors ? 2 : 1;
    const progress = (backend, stage, offset = 0) => update => onProgress({ ...update, backend, stage,
      completedAtoms: offset + (update.completedAtoms ?? 0), totalAtoms: atomCount * stages });
    let neighbors, preparedNeighbors = parameters.preparedNeighbors, neighborFallbackReason, neighborElapsedMs = 0;
    if (prepareNeighbors) {
      ({ neighbors, preparedNeighbors, neighborFallbackReason, neighborElapsedMs } = await this.preparePtmNeighborsWithGpu(
        frame, parameters, { signal, frameIndex, onProgress: progress('gpu', 'ptm-neighbors') }));
    } else if (!suppliedNeighbors && !this.gpuBackend.supports('ptmNeighbors')) {
      neighborFallbackReason = 'The ptm analysis uses CPU workers; no GPU kernel is available for PTM neighbors.';
    }
    const ptm = await this.analyzeCPU(frame, { ...parameters, ...(preparedNeighbors ? { preparedNeighbors } : {}) },
      { signal, onProgress: update => progress('cpu', 'ptm-fit', prepareNeighbors ? atomCount : 0)({ ...update,
        ...(neighborFallbackReason ? { fallbackReason: neighborFallbackReason, neighborFallbackReason } : {}) }) });
    if (signal?.aborted || this.closed) throw abortError();
    return { ...ptm, backend: neighbors ? 'hybrid' : 'cpu', gpuRequested: true, ptmBackend: 'cpu', ptmEngine: ptm.engine,
      neighborBackend: neighbors ? 'gpu' : suppliedNeighbors ? 'prepared' : 'cpu', neighborElapsedMs,
      ptmWorkerCount: ptm.workerCount, ptmElapsedMs: ptm.elapsedMs, elapsedMs: performance.now() - startedAt,
      engine: [neighbors ? neighbors.engine ?? 'webgpu-ptm-neighbors' : null, ptm.engine].filter(Boolean).join('+'),
      ...(neighborFallbackReason ? { neighborFallbackReason, fallbackReason: neighborFallbackReason } : {}) };
  }

  gpuPtmNeighbors() {
    return this.gpuBackend.supports('ptmNeighbors')
      && (this.ptmNeighborBackend === 'gpu' || this.limit <= GPU_PTM_NEIGHBOR_MAX_WORKERS);
  }

  /** Schema preflight stays on the main thread; value validation stays in the
   * fitting workers. Strip GPU result metadata without copying its tables.
   */
  async preparePtmNeighborsWithGpu(frame, parameters, { onProgress, signal, frameIndex }) {
    const startedAt = performance.now();
    let neighbors, neighborFallbackReason;
    try {
      neighbors = await this.gpuBackend.analyze(frame, { kind: 'ptmNeighbors' }, { signal, frameIndex, onProgress });
      if (signal?.aborted || this.closed) throw abortError();
      validatePreparedPtmNeighbors(frame, neighbors, { flags: parameters.flags, validateValues: false });
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted || this.closed) throw abortError();
      neighborFallbackReason = `GPU PTM neighbors: ${error.message || 'Preparation failed.'}`;
      neighbors = null;
    }
    const preparedNeighbors = neighbors ? Object.fromEntries([
      ...PTM_NEIGHBOR_FIELDS, 'maxNeighbors', 'startAtom', 'endAtom', 'sourceAtomCount',
    ].filter(field => neighbors[field] !== undefined).map(field => [field, neighbors[field]])) : null;
    return { neighbors, preparedNeighbors, neighborFallbackReason, neighborElapsedMs: performance.now() - startedAt };
  }

  /** Prepare exact neighbors on GPU, fit PTM topology once in CPU workers,
   * then apply the ideal reference and elastic tensor on GPU. Cached fits skip
   * both geometry stages; failed GPU stages retain independent CPU fallbacks.
   */
  async analyzeStrainWithGpu(frame, parameters, { onProgress, signal, frameIndex }) {
    const startedAt = performance.now(), atomCount = frame.fractional.length / 3;
    if (!ArrayBuffer.isView(frame.types) || frame.types.length !== atomCount) throw new Error('Analysis requires one element type per atom.');
    validateReferences(parameters.references, frame.types);
    const fresh = !parameters.ptmInput;
    if (fresh) validatePtmParameters(parameters);
    const prepareNeighbors = fresh && this.gpuPtmNeighbors();
    const stages = fresh ? prepareNeighbors ? 3 : 2 : 1;
    const progress = (backend, stage, offset = 0) => update => onProgress({ ...update, backend, stage,
      completedAtoms: offset + (update.completedAtoms ?? 0), totalAtoms: atomCount * stages });
    let neighbors, preparedNeighbors, neighborFallbackReason, neighborElapsedMs = 0;
    if (prepareNeighbors) {
      ({ neighbors, preparedNeighbors, neighborFallbackReason, neighborElapsedMs } = await this.preparePtmNeighborsWithGpu(
        frame, parameters, { signal, frameIndex, onProgress: progress('gpu', 'ptm-neighbors') }));
    }
    const ptm = fresh ? await this.analyzeCPU(frame, { ...parameters, kind: 'ptm',
      ...(preparedNeighbors ? { preparedNeighbors } : {}) }, { signal,
      onProgress: progress('cpu', 'ptm-fit', prepareNeighbors ? atomCount : 0) }) : null;
    if (signal?.aborted || this.closed) throw abortError();
    const tensorParameters = { ...parameters, ptmInput: parameters.ptmInput ?? ptm };
    const report = backend => progress(backend, 'strain-tensor', fresh ? atomCount * (stages - 1) : 0);
    let tensor, fallbackReason;
    const tensorStartedAt = performance.now();
    try {
      tensor = await this.gpuBackend.analyze(frame, tensorParameters, { onProgress: report('gpu'), signal, frameIndex });
      if (signal?.aborted || this.closed) throw abortError();
    } catch (error) {
      if (error.name === 'AbortError' || signal?.aborted || this.closed) throw abortError();
      fallbackReason = error.message || 'The GPU strain tensor failed; using CPU workers.';
      tensor = await this.analyzeCPU(frame, tensorParameters, { signal,
        onProgress: update => report('cpu')({ ...update, fallbackReason }) });
    }
    const tensorBackend = fallbackReason ? 'cpu' : 'gpu';
    const fallbacks = [neighborFallbackReason, fallbackReason].filter(Boolean);
    return { ...(ptm ?? {}), ...tensor, backend: tensorBackend, gpuRequested: true, tensorBackend,
      referenceBackend: tensor.referenceBackend ?? tensorBackend,
      engine: [neighbors ? neighbors.engine ?? 'webgpu-ptm-neighbors' : null, ptm?.engine, tensor.engine].filter(Boolean).join('+'),
      ...(ptm ? { ptmBackend: 'cpu', ptmEngine: ptm.engine, ptmWorkerCount: ptm.workerCount, ptmElapsedMs: ptm.elapsedMs,
        neighborBackend: neighbors ? 'gpu' : 'cpu', neighborElapsedMs,
        ...(neighborFallbackReason ? { neighborFallbackReason } : {}) } : {}),
      tensorElapsedMs: performance.now() - tensorStartedAt, elapsedMs: performance.now() - startedAt,
      warning: null, ...(fallbacks.length ? { fallbackReason: fallbacks.join('; ') } : {}) };
  }

  async analyzeCPU(frame, parameters, { onProgress = () => {}, signal, onGeometryChunk, retainCells = true } = {}) {
    if (this.closed) throw new Error('The analysis pool is closed.');
    if (signal?.aborted) throw abortError();
    // Queued preparation yields immediately to foreground work. Posted native
    // initialization/index jobs return their reusable resident state on ACK.
    this.cpuFramePreparation?.controller.abort();
    if (parameters.kind === 'localShear') return this.analyzeLocalShear(frame, parameters, { onProgress, signal });
    if (['voronoi', 'voronoiGeometry', 'voronoiGeometryBatch'].includes(parameters.kind)) {
      return this.analyzeVoronoiCPU(frame, parameters, { onProgress, signal, onGeometryChunk, retainCells });
    }
    const startedAt = performance.now();
    const atomCount = frame.fractional.length / 3;
    if (!Number.isInteger(atomCount) || atomCount < 1) throw new Error('Analysis requires at least one atom.');
    const sharedMemory = Boolean(this.environment.crossOriginIsolated && typeof SharedArrayBuffer === 'function');
    let extraBytes = 0;
    const inputs = { ...parameters };
    // GPU residency metadata is not scientific input. Sending a complete
    // reference frame to every CPU worker would duplicate its cached arrays.
    delete inputs.referenceFrame;
    delete inputs.referenceFrameIndex;
    // Prepared displacement uses authoritative Cartesian arrays and the
    // current metric; reference fractions/cell only identify the GPU cache.
    if (parameters.kind === 'displacement') { delete inputs.referenceFractional; delete inputs.referenceCell; }
    const autoCentrosymmetry = parameters.kind === 'centrosymmetry' && parameters.mode === 'auto';
    if (parameters.structureInput !== undefined) {
      if (!autoCentrosymmetry || !(parameters.structureInput instanceof Uint8Array)
          || parameters.structureInput.length !== atomCount || parameters.structureInput.some((type) => type > 4)) {
        throw new Error('Auto central symmetry requires complete adaptive CNA structure IDs.');
      }
      extraBytes += parameters.structureInput.byteLength;
    }
    if (['strain', 'bonds', 'rdf', 'bondStatistics'].includes(parameters.kind)) {
      inputs.types = frame.types;
      if (!ArrayBuffer.isView(frame.types) || frame.types.length !== atomCount) throw new Error('Analysis requires one element type per atom.');
      extraBytes += frame.types.byteLength;
    }
    for (const name of ['referenceFractional', 'referenceMapping', 'metricInput', 'currentPositions', 'referencePositions']) {
      if (inputs[name]) {
        if (!ArrayBuffer.isView(inputs[name])) throw new Error(`Analysis ${name} must be a typed array.`);
        extraBytes += inputs[name].byteLength;
      }
    }
    if (parameters.kind === 'strain') {
      if (parameters.ptmInput) {
        inputs.ptmInput = Object.fromEntries(Object.keys(PTM_OUTPUT_FIELDS).map((name) => {
          extraBytes += parameters.ptmInput[name].byteLength;
          return [name, parameters.ptmInput[name]];
        }));
      }
    }
    let neighborBytes = 0;
    const sharedNeighborTable = parameters.preparedNeighbors;
    const fullNeighborTable = Boolean((parameters.flags ?? 31) & 224);
    if (sharedNeighborTable) {
      if (!['ptm', 'strain'].includes(parameters.kind)) throw new Error('Prepared PTM neighbors require a template analysis.');
      // Check transport shapes here; CPU workers validate scientific values
      // before fitting, keeping a large nearest-18 scan off the UI thread.
      validatePreparedPtmNeighbors(frame, sharedNeighborTable, { flags: parameters.flags, validateValues: false });
      neighborBytes = PTM_NEIGHBOR_FIELDS.reduce((bytes, field) => bytes + sharedNeighborTable[field].byteLength, 0);
      if (fullNeighborTable) extraBytes += neighborBytes;
    }
    const outputFields = EXTRA_OUTPUT_FIELDS[parameters.kind] ?? (parameters.kind === 'ptm' ? PTM_OUTPUT_FIELDS
      : parameters.kind === 'strain' ? { ...STRAIN_OUTPUT_FIELDS, ...(parameters.ptmInput ? {} : PTM_OUTPUT_FIELDS) }
        : autoCentrosymmetry ? { centrosymmetry: [Float32Array, 1], cspStructureTypes: [Uint8Array, 1], cspNeighborCounts: [Uint8Array, 1] }
          : { values: [parameters.kind === 'cna' ? Uint8Array : Float32Array, 1] });
    const outputBytesPerAtom = Object.values(outputFields).reduce((sum, [Type, stride]) => sum + Type.BYTES_PER_ELEMENT * stride, 0);
    // Every worker holds its coordinates and a full-frame neighbor index; each
    // writes only its own atom range, merged once into full output arrays.
    const copyBytes = (sharedMemory ? 0 : frame.fractional.byteLength + extraBytes) + atomCount * 48
      + (parameters.kind === 'ptm' || (parameters.kind === 'strain' && !parameters.ptmInput) ? PTM_INITIAL_HEAP_BYTES : 0);
    const outputBytes = 2 * atomCount * outputBytesPerAtom;
    let workerCount = Math.min(this.limit, chooseWorkerCount(atomCount,
      copyBytes, this.environment,
      parameters.kind === 'voronoi' ? 512
        : ['coordination', 'displacement'].includes(parameters.kind) || (parameters.kind === 'strain' && parameters.ptmInput) ? 50_000 : 4_096, { sharedBytes: outputBytes }));
    // Common PTM phases need only their central-atom rows. Their aggregate
    // private tables occupy one table, while multishell templates need a full
    // source table in each worker for neighbors-of-neighbors callbacks.
    if (!sharedMemory && sharedNeighborTable && !fullNeighborTable) {
      const heapLimit = Number(this.environment.performance?.memory?.jsHeapSizeLimit);
      const copyBudget = Number.isFinite(heapLimit) ? heapLimit * .15 : 256 * 1024 ** 2;
      while (workerCount > 1 && copyBytes * workerCount + outputBytes + neighborBytes > copyBudget) workerCount--;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let completed = 0;
    const phases = new Array(workerCount).fill('queued');
    const atomProgress = new Array(workerCount).fill(0);
    const report = (index, phase, progress) => {
      if (controller.signal.aborted) return;
      if (index !== null) phases[index] = phase;
      if (index !== null) {
        const rangeCount = Math.floor(atomCount * (index + 1) / workerCount) - Math.floor(atomCount * index / workerCount);
        if (phase === 'complete') atomProgress[index] = rangeCount;
        else if (Number.isFinite(progress?.processedAtoms)) atomProgress[index] = Math.max(atomProgress[index],
          Math.max(0, Math.min(rangeCount, Math.floor(progress.processedAtoms))));
      }
      const prepared = phases.filter((value) => ['prepared', 'initializing', 'indexing', 'analyzing', 'complete'].includes(value)).length;
      const initialized = phases.filter((value) => ['indexing', 'analyzing', 'complete'].includes(value)).length;
      const currentPhase = completed === workerCount ? 'complete'
        : phases.some((value) => value === 'analyzing' || value === 'complete') ? 'analyzing'
          : phases.includes('indexing') ? 'indexing'
            : phases.some((value) => value === 'initializing' || value === 'prepared') ? 'initializing'
              : phases.includes('preparing') ? 'preparing' : index === null ? phase : 'queued';
      onProgress({ completed, total: workerCount, workerCount, phase: currentPhase, prepared, initialized,
        completedAtoms: atomProgress.reduce((sum, count) => sum + count, 0), totalAtoms: atomCount });
    };
    try {
      report(null, sharedMemory ? 'preparing' : 'queued');
      let coordinates = frame.fractional;
      if (sharedMemory) {
        coordinates = await copyCoordinates(frame.fractional, controller.signal, true);
        for (const name of INPUT_ARRAY_FIELDS) if (inputs[name]) inputs[name] = await copyCoordinates(inputs[name], controller.signal, true);
        if (inputs.ptmInput) {
          inputs.ptmInput = await copyFields(inputs.ptmInput, controller.signal, true);
        }
        if (inputs.preparedNeighbors) inputs.preparedNeighbors = await copyPtmNeighbors(inputs.preparedNeighbors, controller.signal, true);
      }
      if (controller.signal.aborted) throw abortError();
      const partials = await Promise.all(Array.from({ length: workerCount }, (_, index) => {
        const startAtom = Math.floor(atomCount * index / workerCount);
        const endAtom = Math.floor(atomCount * (index + 1) / workerCount);
        return this.runTask({ fractional: coordinates, cell: frame.cell, ...inputs, startAtom, endAtom },
          controller.signal, signal, (phase, progress) => report(index, phase, progress), sharedMemory)
          .then((partial) => {
            completed += 1;
            report(index, 'complete');
            return partial;
          });
      }));
      if (controller.signal.aborted) throw abortError();
      const metadata = { elapsedMs: performance.now() - startedAt, workerCount, sharedMemory,
        engine: `${parameters.kind === 'voronoi' ? 'voro++-wasm'
          : parameters.kind === 'ptm' || (parameters.kind === 'strain' && !parameters.ptmInput) ? 'ptm-wasm' : 'js'}-worker${workerCount === 1 ? '' : `-pool×${workerCount}`}` };
      if (parameters.kind === 'ptm' || (parameters.kind === 'strain' && !parameters.ptmInput)) {
        metadata.kernelInitializations = partials.filter((partial) => !partial.kernelReused).length;
      }
      if (parameters.kind === 'coordination') {
        const coordination = new Uint32Array(atomCount);
        let candidatePairs = 0, acceptedPairs = 0;
        for (const partial of partials) {
          for (let atom = 0; atom < atomCount; atom += 1) {
            coordination[atom] += partial.coordination[atom];
            if (atom && atom % 65_536 === 0) { await yieldToMain(); if (controller.signal.aborted) throw abortError(); }
          }
          candidatePairs += partial.candidatePairs;
          acceptedPairs += partial.acceptedPairs;
        }
        return { ...metadata, coordination, ...await coordinationStatistics(coordination, controller.signal), candidatePairs, acceptedPairs, bins: partials[0]?.bins,
          warning: partials.find((partial) => partial.warning)?.warning ?? null };
      }
      if (EXTRA_OUTPUT_FIELDS[parameters.kind]) {
        if (parameters.kind === 'voronoi') {
          return { ...metadata, ...mergeVoronoiPartials(partials, atomCount, { bins: parameters.bins ?? 50 }) };
        }
        const fields = EXTRA_OUTPUT_FIELDS[parameters.kind];
        const values = Object.fromEntries(Object.entries(fields).map(([name, [Type, stride]]) => [name, new Type(atomCount * stride)]));
        for (const partial of partials) {
          for (const [name, [, stride]] of Object.entries(fields)) values[name].set(partial[name], partial.startAtom * stride);
          if (atomCount > 65_536) { await yieldToMain(); if (controller.signal.aborted) throw abortError(); }
        }
        if (parameters.kind === 'rdf') {
          const counts = new Float64Array(parameters.bins ?? 100);
          for (const partial of partials) for (let bin = 0; bin < counts.length; bin += 1) counts[bin] += partial.counts[bin];
          return { ...metadata, ...finalizeRdf(counts, partials[0].normalization) };
        }
        if (parameters.kind === 'bondStatistics') {
          return { ...metadata, ...mergeBondStatisticsPartials(partials, values) };
        }
        if (parameters.kind === 'bonds') {
          const count = partials.reduce((sum, partial) => sum + partial.count, 0), maxBonds = parameters.maxBonds ?? MAX_BONDS;
          if (count > maxBonds) throw new Error(`Bond output exceeds ${maxBonds.toLocaleString('en-US')} edges; reduce the cutoff.`);
          const indices = new Uint32Array(count * 2), vectors = new Float32Array(count * 3), shifts = new Int32Array(count * 3);
          let offset = 0;
          for (const partial of partials) {
            indices.set(partial.indices, offset * 2); vectors.set(partial.vectors, offset * 3); shifts.set(partial.shifts, offset * 3);
            offset += partial.count;
            await yieldToMain(); if (controller.signal.aborted) throw abortError();
          }
          return { ...metadata, ...values, indices, vectors, shifts, count, ...await coordinationStatistics(values.coordination, controller.signal), warning: null };
        }
        if (parameters.kind === 'localShearCoordination') {
          const histogram = [];
          for (const partial of partials) for (let index = 0; index < partial.histogram.length; index += 1) {
            histogram[index] = (histogram[index] ?? 0) + partial.histogram[index];
          }
          return { ...metadata, ...values, histogram, coordinationSum: partials.reduce((sum, partial) => sum + partial.coordinationSum, 0) };
        }
        if (parameters.kind === 'localShearMetrics') {
          const metricSum = new Array(6).fill(0);
          for (const partial of partials) for (let component = 0; component < 6; component += 1) metricSum[component] += partial.metricSum[component];
          return { ...metadata, ...values, metricSum, normalizationSum: partials.reduce((sum, partial) => sum + partial.normalizationSum, 0),
            normalizationParticipants: partials.reduce((sum, partial) => sum + partial.normalizationParticipants, 0) };
        }
        if (parameters.kind === 'displacement') {
          const matched = partials.reduce((sum, partial) => sum + partial.matched, 0);
          return { ...metadata, ...values, matched, unmatched: atomCount - matched,
            referenceMapping: parameters.referenceMapping, mappingMode: parameters.mappingMode,
            minimumImage: parameters.minimumImage, warning: null };
        }
        return { ...metadata, ...values, incomplete: partials.reduce((sum, partial) => sum + (partial.incomplete ?? 0), 0), warning: null };
      }
      if (parameters.kind === 'ptm' || parameters.kind === 'strain') {
        const fields = parameters.kind === 'ptm' ? PTM_OUTPUT_FIELDS
          : { ...STRAIN_OUTPUT_FIELDS, ...(parameters.ptmInput ? {} : PTM_OUTPUT_FIELDS) };
        const values = Object.fromEntries(Object.entries(fields).map(([name, [Type, stride]]) => [name, new Type(atomCount * stride)]));
        let incomplete = 0;
        for (const partial of partials) {
          for (const [name, [, stride]] of Object.entries(fields)) values[name].set(partial[name], partial.startAtom * stride);
          incomplete += partial.incomplete ?? 0;
        }
        return { ...metadata, ...values, incomplete, warning: null };
      }
      const field = parameters.kind === 'cna' ? 'structures' : 'centrosymmetry';
      const values = parameters.kind === 'cna' ? new Uint8Array(atomCount) : new Float32Array(atomCount);
      const cspStructureTypes = autoCentrosymmetry ? new Uint8Array(atomCount) : null;
      const cspNeighborCounts = autoCentrosymmetry ? new Uint8Array(atomCount) : null;
      const cspSummary = autoCentrosymmetry ? Object.fromEntries(CSP_SUMMARY_FIELDS.map((name) => [name, 0])) : null;
      let incomplete = 0;
      for (const partial of partials) {
        values.set(partial[field], partial.startAtom);
        if (autoCentrosymmetry) {
          cspStructureTypes.set(partial.cspStructureTypes, partial.startAtom);
          cspNeighborCounts.set(partial.cspNeighborCounts, partial.startAtom);
          for (const name of CSP_SUMMARY_FIELDS) cspSummary[name] += partial.cspSummary[name];
        }
        incomplete += partial.incomplete ?? 0;
      }
      return { ...metadata, [field]: values, ...(autoCentrosymmetry ? { cspStructureTypes, cspNeighborCounts, cspSummary } : {}), incomplete,
        warning: incomplete ? `${incomplete} atoms have insufficient neighbors or zero-length environments; central symmetry is undefined (NaN) for them.` : null };
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.controllers.delete(controller);
    }
  }

  /** Independent cells have very different costs near voids and defects. A
   * shared queue gives each available Worker another bounded central-atom
   * chunk, without rebuilding its source index or Wasm module. The final CSR
   * merge and histogram scans also run in a Worker, keeping the UI responsive.
   */
  async analyzeVoronoiCPU(sourceFrame, parameters, { onProgress = () => {}, signal, onGeometryChunk, retainCells = true } = {}) {
    const startedAt = performance.now(), selection = prepareVoronoiSelection(sourceFrame, parameters.selectedTypes),
      frame = selection.frame, atomCount = frame.fractional.length / 3;
    if (!Number.isInteger(atomCount) || atomCount < 1) throw new Error('Analysis requires at least one atom.');
    const geometryOnly = parameters.kind === 'voronoiGeometry';
    const geometryBatch = parameters.kind === 'voronoiGeometryBatch';
    const geometryIndices = geometryOnly || geometryBatch
      ? compactVoronoiAtomIndices(selection, geometryOnly ? [parameters.atomIndex] : parameters.atomIndices) : null;
    const workCount = geometryIndices?.length ?? atomCount;
    const sharedMemory = Boolean(this.environment.crossOriginIsolated && typeof SharedArrayBuffer === 'function');
    // Coordinate snapshot, linked index, per-worker output, and resident Wasm
    // buffers. Face CSR is streamed in bounded chunks rather than a full
    // frame-sized private output in each Worker.
    const workerCount = geometryOnly ? 1 : this.voronoiWorkerCount(frame, workCount, geometryBatch ? 256 : 512);
    const chunkSize = geometryOnly ? 1 : Math.max(32, Math.min(geometryBatch ? 128 : 256, Math.ceil(workCount / (workerCount * 8))));
    const chunkCount = Math.ceil(workCount / chunkSize);
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let nextChunk = 0, completedChunks = 0, completedAtoms = 0, lastReportAt = -Infinity, lastPhase;
    const phases = new Array(workerCount).fill('queued'), processed = new Array(workerCount).fill(0);
    const report = (index, phase, progress, force = false) => {
      if (controller.signal.aborted) return;
      if (index !== null) {
        phases[index] = phase;
        if (Number.isFinite(progress?.processedAtoms)) processed[index] = Math.max(processed[index], progress.processedAtoms);
      }
      const currentPhase = completedChunks === chunkCount ? phase === 'finalizing' ? 'finalizing' : 'complete'
        : phases.some(value => value === 'analyzing' || value === 'complete') ? 'analyzing'
          : phases.includes('indexing') ? 'indexing'
            : phases.some(value => value === 'initializing' || value === 'prepared') ? 'initializing' : phase;
      const now = performance.now();
      if (!force && currentPhase === lastPhase && now - lastReportAt < 80) return;
      lastReportAt = now; lastPhase = currentPhase;
      onProgress({ completed: completedChunks === chunkCount ? workerCount : 0, total: workerCount, workerCount,
        phase: currentPhase, prepared: phases.filter(value => !['queued', 'preparing'].includes(value)).length,
        initialized: phases.filter(value => ['indexing', 'analyzing', 'complete'].includes(value)).length,
        completedAtoms: Math.min(workCount, completedAtoms + processed.reduce((sum, count) => sum + count, 0)),
        totalAtoms: workCount, completedChunks, totalChunks: chunkCount });
    };
    try {
      report(null, 'preparing', undefined, true);
      const snapshot = await this.prepareVoronoiSnapshot(frame, sharedMemory, controller.signal);
      if (controller.signal.aborted) throw abortError();
      const partials = new Array(chunkCount);
      const runners = Array.from({ length: workerCount }, (_, index) => (async () => {
        while (nextChunk < chunkCount) {
          if (controller.signal.aborted) throw abortError();
          const chunk = nextChunk++;
          const startAtom = geometryOnly ? geometryIndices[0] : chunk * chunkSize,
            endAtom = geometryOnly ? startAtom + 1 : Math.min(workCount, startAtom + chunkSize);
          processed[index] = 0;
          const partial = await this.runTask({ ...parameters, selectedTypes: null, fractional: snapshot.coordinates, cell: snapshot.cell,
            residentFrameKey: snapshot.key, startAtom, endAtom,
            ...(geometryOnly ? { atomIndex: geometryIndices[0] } : geometryBatch
              ? { atomIndices: Array.from(geometryIndices.subarray(startAtom, endAtom)) } : { skipStatistics: true }) },
          controller.signal, signal, (phase, progress) => report(index, phase, progress), sharedMemory);
          if (controller.signal.aborted) throw abortError();
          completedChunks++; completedAtoms += endAtom - startAtom; processed[index] = 0;
          if (geometryBatch) {
            const cells = partial.cells.map(cell => mapVoronoiGeometry(cell, selection));
            if (onGeometryChunk) await onGeometryChunk(cells, { completedAtoms, totalAtoms: workCount, chunkIndex: chunk });
            if (controller.signal.aborted) throw abortError();
            partials[chunk] = { ...partial, cells: retainCells ? cells : [] };
          } else partials[chunk] = partial;
          report(index, 'complete', undefined, completedChunks === chunkCount);
        }
      })());
      await Promise.all(runners);
      if (controller.signal.aborted) throw abortError();
      let output;
      if (geometryOnly) output = { ...mapVoronoiGeometry(partials[0], selection), selectedTypes: selection.selectedTypes };
      else if (geometryBatch) output = { cells: retainCells ? partials.flatMap(partial => partial.cells) : [],
        analyzedAtomIndices: Uint32Array.from(geometryIndices, index => selection.isAll ? index : selection.atomIndices[index]),
        selectedTypes: selection.selectedTypes, kernelInitializations: partials.filter(partial => !partial.kernelReused).length,
        indexBuilds: partials.filter(partial => !partial.indexReused).length, frameUploads: partials.filter(partial => partial.frameUploaded).length };
      else {
        report(null, 'finalizing', undefined, true);
        output = await this.runTask({ kind: 'voronoiFinalize', partials, atomCount, bins: parameters.bins ?? 50 },
          controller.signal, signal, phase => report(null, phase), true);
        output = expandVoronoiResult(output, selection);
      }
      if (controller.signal.aborted) throw abortError();
      report(null, 'complete', undefined, true);
      return { ...output, workerCount, sharedMemory, chunkCount, chunkSize, scheduling: 'dynamic',
        engine: `voro++-wasm-worker${workerCount === 1 ? '' : `-pool×${workerCount}`}${geometryOnly ? '-geometry' : geometryBatch ? '-geometry-batch' : ''}`,
        elapsedMs: performance.now() - startedAt };
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.controllers.delete(controller);
    }
  }

  /** Compare the one retained snapshot exactly, so callers mutating an input
   * typed array or cell cannot reuse stale geometry. Reuse spans chunks and
   * repeated analyses; changing frames retains only one pool-side snapshot.
   */
  async prepareVoronoiSnapshot(frame, sharedMemory, signal) {
    // Foreground analysis can overtake frame preparation without making a
    // second complete snapshot. After joining a copy, check mutable inputs
    // exactly before using its coordinates/index identity.
    while (this.voronoiSnapshotPending) {
      try { await this.voronoiSnapshotPending; } catch (error) {
        if (signal?.aborted || this.closed) throw abortError();
      }
      if (signal?.aborted || this.closed) throw abortError();
    }
    const pending = this.createVoronoiSnapshot(frame, sharedMemory, signal);
    this.voronoiSnapshotPending = pending;
    try { return await pending; }
    finally { if (this.voronoiSnapshotPending === pending) this.voronoiSnapshotPending = null; }
  }

  async createVoronoiSnapshot(frame, sharedMemory, signal) {
    const generation = this.voronoiSnapshotGeneration;
    const cellKey = JSON.stringify([Array.from(frame.cell.vectors), Array.from(frame.cell.pbc), Array.from(frame.cell.origin ?? [0, 0, 0])]);
    const previous = this.voronoiSnapshot;
    let identical = previous?.source === frame.fractional && previous.cellKey === cellKey && previous.sharedMemory === sharedMemory;
    if (identical) {
      for (let index = 0; index < frame.fractional.length; index++) {
        if (!Object.is(frame.fractional[index], previous.coordinates[index])) { identical = false; break; }
        if (index && index % 262_144 === 0) { await yieldToMain(); if (signal?.aborted) throw abortError(); }
      }
    }
    if (generation !== this.voronoiSnapshotGeneration || signal?.aborted || this.closed) throw abortError();
    if (identical) return previous;
    const coordinates = await copyCoordinates(frame.fractional, signal, sharedMemory),
      cell = { ...frame.cell, vectors: frame.cell.vectors.slice(), pbc: Array.from(frame.cell.pbc), origin: Float64Array.from(frame.cell.origin ?? [0, 0, 0]) };
    const snapshot = { source: frame.fractional, coordinates, cell, cellKey, sharedMemory, key: this.nextVoronoiFrameKey++ };
    if (generation !== this.voronoiSnapshotGeneration || signal?.aborted || this.closed) throw abortError();
    this.voronoiSnapshot = snapshot;
    return snapshot;
  }

  async analyzeLocalShear(frame, parameters, { onProgress, signal }) {
    const startedAt = performance.now(), atomCount = frame.fractional.length / 3;
    const controller = new AbortController(), abort = () => controller.abort();
    this.controllers.add(controller);
    signal?.addEventListener('abort', abort, { once: true });
    const progress = (stage) => (update) => onProgress({ ...update, stage,
      completedAtoms: atomCount * stage + update.completedAtoms, totalAtoms: atomCount * 3 });
    try {
      const coordination = await this.analyzeCPU(frame, { ...parameters, kind: 'localShearCoordination' }, {
        signal: controller.signal, onProgress: progress(0),
      });
      const coordinationMode = modalCoordination(coordination.histogram);
      const metrics = await this.analyzeCPU(frame, { ...parameters, kind: 'localShearMetrics', coordinationMode }, {
        signal: controller.signal, onProgress: progress(1),
      });
      const normalization = metrics.normalizationParticipants ? metrics.normalizationSum / metrics.normalizationParticipants / 3 : NaN;
      const meanMetric = metrics.metricSum.map((value) => value / atomCount / normalization);
      const result = await this.analyzeCPU(frame, { ...parameters, kind: 'localShearFinalize', metricInput: metrics.metrics,
        normalization, meanMetric }, { signal: controller.signal, onProgress: progress(2) });
      return { ...result, elapsedMs: performance.now() - startedAt, coordination: coordination.coordination,
        coordinationMode, normalization, meanMetric, averageCoordination: coordination.coordinationSum / atomCount,
        averageShear: shearInvariant(meanMetric), warning: null };
    } finally {
      signal?.removeEventListener('abort', abort);
      this.controllers.delete(controller);
    }
  }

  runTask(payload, signal, sourceSignal, onPhase = () => {}, sharedMemory = false) {
    return new Promise((resolve, reject) => {
      const task = { id: this.nextId++, payload, signal, sourceSignal, resolve, reject, onPhase,
        sharedMemory, worker: null, slot: null, done: false, lease: null, posted: false };
      task.abort = () => {
        if (task.payload.kind === 'voronoiPrepare' && !task.posted && task.slot && !this.closed) {
          // Coordinate copying/yielding is main-thread work. Cancelling it
          // leaves the idle Worker's previously warmed modules untouched.
          task.cancelledVoronoi = true; task.reject(abortError());
          this.finish(task, null, { preparationCancelled: true });
          return;
        }
        if (task.payload.kind === 'warmup' && task.posted && !this.closed) {
          // Module initialization is asynchronous. Let its ACK return the
          // useful module to the pool even when this subscriber went away.
          if (!task.cancelledWarmup) { task.cancelledWarmup = true; task.reject(abortError()); }
          return;
        }
        if (task.payload.kind.startsWith('voronoi') && task.posted && !this.closed) {
          // Bounded chunks finish cooperatively. Reject the caller immediately
          // but retain the busy slot/lease until its ACK, preserving the native
          // module, coordinate snapshot, and index for the next calculation.
          if (!task.cancelledVoronoi) { task.cancelledVoronoi = true; task.reject(abortError()); }
          return;
        }
        this.finish(task, abortError());
      };
      signal.addEventListener('abort', task.abort, { once: true });
      this.queue.push(task);
      if (signal.aborted) task.abort();
      else this.pump();
    });
  }

  pump() {
    // Admission belongs to the shared budget. Keeping warmup lease waiters
    // behind a separate local limit would prevent foreground jobs from ever
    // entering its priority queue.
    while (!this.closed && this.queue.length) {
      const task = this.queue.shift();
      if (task.done) continue;
      // A caller's abort listeners run one at a time. Its original signal may
      // already be aborted before another job's internal controller sees it.
      if (task.signal.aborted || task.sourceSignal?.aborted) { this.finish(task, abortError()); continue; }
      this.active.add(task);
      void this.startTask(task);
    }
  }

  async startTask(task) {
    try {
      let slot;
      while (!slot) {
        // Resident DXA inputs have a bounded set of slots. Wait for an eligible
        // slot before entering the global budget, so a blocked admission never
        // prevents that slot's current owner from obtaining its own permit.
        if (!this.hasWorkerSlot(task)) await this.waitForWorkerSlot(task);
        const lease = await this.cpuBudget.acquire(1, { signal: task.signal,
          priority: task.payload.kind === 'warmup' ? -1 : task.payload.kind === 'voronoiPrepare' ? -0.5 : 0 });
        if (task.done || task.signal.aborted || task.sourceSignal?.aborted || this.closed) {
          lease.release(); this.finish(task, abortError()); return;
        }
        task.lease = lease;
        slot = this.selectWorkerSlot(task);
        if (!slot) {
          // Another admission may have claimed the eligible slot while this
          // task awaited its permit. Release it and wait for a real vacancy.
          lease.release(); task.lease = null;
        }
      }
      // Warm each resident slot once, then grow the pool. Repeated prefetches
      // must never reinstantiate a kernel already available in another slot.
      slot.task = task;
      task.slot = slot;
      task.worker = slot.worker;
      if (task.payload.kind === 'warmup' && (task.payload.modules ?? ['ptm']).every(module => slot[`${module}Warmed`])) {
        this.finish(task, null, { warmed: true, kernelReused: true, modules: task.payload.modules ?? ['ptm'] });
        return;
      }
      if (task.payload.kind === 'voronoiPrepare' && slot.voronoiFrameKey === task.payload.residentFrameKey) {
        this.finish(task, null, { warmed: true, kernelReused: true, indexReused: true, frameUploaded: false });
        return;
      }
      task.onPhase('preparing');
      void this.dispatch(task);
    } catch (error) { this.finish(task, error); }
  }

  slotEligible(task, slot) {
    if (!DXA_STAGE_KINDS.includes(task.payload.kind)) return slot.dxaReservedKey === undefined;
    const key = task.payload.dxaResidentKey, stage = this.dxaStages.get(key);
    if (!stage) return false;
    return slot.dxaReservedKey === key || (slot.dxaReservedKey === undefined && stage.slots.size < stage.workerCount);
  }

  canCreateTaskSlot(task) {
    if (this.slots.size >= this.limit) return false;
    if (!DXA_STAGE_KINDS.includes(task.payload.kind)) return true;
    const stage = this.dxaStages.get(task.payload.dxaResidentKey);
    return Boolean(stage && stage.slots.size < stage.workerCount);
  }

  async waitForWorkerSlot(task) {
    while (!this.hasWorkerSlot(task)) {
      if (task.done || task.signal.aborted || task.sourceSignal?.aborted || this.closed) throw abortError();
      await new Promise((resolve, reject) => {
        const finish = error => {
          this.slotWaiters.delete(wake); task.signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve();
        };
        const wake = () => finish(), abort = () => finish(abortError());
        this.slotWaiters.add(wake); task.signal.addEventListener('abort', abort, { once: true });
        if (task.signal.aborted || task.done || this.closed) abort();
      });
    }
  }

  hasWorkerSlot(task) { return this.idle.some(slot => this.slotEligible(task, slot)) || this.canCreateTaskSlot(task); }

  notifyWorkerSlots() { for (const wake of [...this.slotWaiters]) wake(); }

  selectWorkerSlot(task) {
    const eligible = slot => this.slotEligible(task, slot);
    let index = -1;
    if (task.payload.kind === 'warmup') {
      const modules = task.payload.modules ?? ['ptm'];
      index = this.idle.findIndex(slot => eligible(slot) && modules.some(module => !slot[`${module}Warmed`]));
    } else if (VORONOI_RESIDENT_KINDS.includes(task.payload.kind)) {
      index = this.idle.findIndex(slot => eligible(slot) && (task.payload.kind === 'voronoiPrepare'
        ? slot.voronoiFrameKey !== task.payload.residentFrameKey : slot.voronoiFrameKey === task.payload.residentFrameKey));
    } else if (DXA_STAGE_KINDS.includes(task.payload.kind)) {
      index = this.idle.findIndex(slot => eligible(slot) && slot.dxaReservedKey === task.payload.dxaResidentKey);
    }
    let slot;
    if (index >= 0) slot = this.idle.splice(index, 1)[0];
    else if (['warmup', 'voronoiPrepare'].includes(task.payload.kind) && this.canCreateTaskSlot(task)) slot = this.createWorker();
    else {
      for (let i = this.idle.length - 1; i >= 0; i--) if (eligible(this.idle[i])) {
        slot = this.idle.splice(i, 1)[0]; break;
      }
      if (!slot && this.canCreateTaskSlot(task)) slot = this.createWorker();
    }
    if (slot && DXA_STAGE_KINDS.includes(task.payload.kind)) {
      const key = task.payload.dxaResidentKey, stage = this.dxaStages.get(key);
      slot.dxaReservedKey = key; stage.slots.add(slot);
      stage.activeWorkers++; stage.peakWorkers = Math.max(stage.peakWorkers, stage.activeWorkers);
    }
    return slot;
  }

  createWorker() {
    const slot = { worker: this.workerFactory(), task: null, terminated: false, ptmWarmed: false, voronoiWarmed: false };
    this.slots.add(slot);
    slot.worker.addEventListener('message', ({ data }) => {
      const task = slot.task;
      if (!task || task.done || data.id !== task.id) return;
      if (data.phase && !task.cancelledWarmup && !task.cancelledVoronoi) {
        try { task.onPhase(data.phase, data); }
        catch (error) { this.finish(task, error); }
      }
      else if (data.phase) return;
      else this.finish(task, data.ok ? null : new Error(data.error), data.result);
    });
    const fail = (error) => {
      if (slot.task) this.finish(slot.task, error);
      else this.terminateWorker(slot);
    };
    slot.worker.addEventListener('error', (event) => fail(new Error(event.message || 'An analysis Worker failed.')));
    slot.worker.addEventListener('messageerror', () => fail(new Error('An analysis Worker returned unreadable data.')));
    return slot;
  }

  async dispatch(task) {
    try {
      // Give the status text and Cancel button a paint before copying large
      // inputs. Transfer private copies instead of synchronously cloning the
      // complete frame in each of six consecutive postMessage calls.
      const residentChunk = VORONOI_RESIDENT_KINDS.includes(task.payload.kind)
        && task.payload.residentFrameKey !== undefined && task.slot.voronoiFrameKey === task.payload.residentFrameKey;
      if (!residentChunk) await yieldToMain();
      if (task.done) return;
      let payload = task.payload;
      const transferables = [];
      if (DXA_STAGE_KINDS.includes(payload.kind)) {
        payload = { ...payload };
        if (task.slot.dxaResidentKey === payload.dxaResidentKey) delete payload.dxaStageInput;
        else {
          const source = payload.dxaStageInput, fields = payload.kind === 'dxaLocal' ? ['coordinates'] : ['vertices', 'tetrahedra', 'edges', 'transitions'];
          payload.dxaStageInput = { ...source };
          for (const name of fields) {
            payload.dxaStageInput[name] = await copyCoordinates(source[name], task.signal);
            transferables.push(payload.dxaStageInput[name].buffer);
          }
        }
      } else if (payload.kind === 'voronoiFinalize') {
        for (const partial of payload.partials) for (const value of Object.values(partial)) {
          if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) transferables.push(value.buffer);
        }
      } else if (VORONOI_RESIDENT_KINDS.includes(payload.kind)
          && payload.residentFrameKey !== undefined
          && task.slot.voronoiFrameKey === payload.residentFrameKey) {
        payload = { ...payload };
        delete payload.fractional; delete payload.cell;
      } else if (!task.sharedMemory && payload.kind !== 'warmup') {
        payload = { ...payload, fractional: await copyCoordinates(payload.fractional, task.signal) };
        transferables.push(payload.fractional.buffer);
        for (const name of INPUT_ARRAY_FIELDS) if (payload[name]) {
          const source = name === 'metricInput' ? payload[name].subarray(payload.startAtom * 6, payload.endAtom * 6) : payload[name];
          payload[name] = await copyCoordinates(source, task.signal);
          transferables.push(payload[name].buffer);
          if (name === 'metricInput') payload.metricStartAtom = payload.startAtom;
        }
        if (payload.ptmInput) {
          payload.ptmInput = await copyFields(payload.ptmInput, task.signal);
          transferables.push(...Object.values(payload.ptmInput).map((values) => values.buffer));
        }
        if (payload.preparedNeighbors) {
          payload.preparedNeighbors = await copyPtmNeighbors(payload.preparedNeighbors, task.signal, false,
            (payload.flags ?? 31) & 224 ? {} : { startAtom: payload.startAtom, endAtom: payload.endAtom });
          transferables.push(...PTM_NEIGHBOR_FIELDS.map(field => payload.preparedNeighbors[field].buffer));
        }
      }
      if (task.done || task.signal.aborted || task.sourceSignal?.aborted) return;
      task.posted = true;
      task.worker.postMessage({ id: task.id, ...payload }, [...new Set(transferables)]);
      if (!task.done) task.onPhase('prepared');
    } catch (error) { this.finish(task, error); }
  }

  terminateWorker(slot) {
    if (slot.terminated) return;
    slot.terminated = true;
    slot.worker.terminate();
    this.slots.delete(slot);
    this.dxaStages.get(slot.dxaReservedKey)?.slots.delete(slot);
    const index = this.idle.indexOf(slot);
    if (index >= 0) this.idle.splice(index, 1);
    this.notifyWorkerSlots();
  }

  finish(task, error, result) {
    if (task.done) return;
    task.done = true;
    task.signal.removeEventListener('abort', task.abort);
    if (task.slot) {
      if (DXA_STAGE_KINDS.includes(task.payload.kind)) {
        const stage = this.dxaStages.get(task.payload.dxaResidentKey);
        if (stage) stage.activeWorkers--;
      }
      task.slot.task = null;
      if (error || this.closed) this.terminateWorker(task.slot);
      else {
        if (result?.nativeHeapBytes) {
          task.slot.moduleHeapBytes ??= {};
          for (const module of CPU_MODULES) {
            const bytes = result.nativeHeapBytes[module];
            if (Number.isSafeInteger(bytes) && bytes >= 0) task.slot.moduleHeapBytes[module] = Math.max(task.slot.moduleHeapBytes[module] ?? 0, bytes);
          }
          task.slot.dxaHeapBytes = task.slot.moduleHeapBytes.dxa ?? task.slot.dxaHeapBytes;
        }
        if (Number.isSafeInteger(result?.residentInputBytes) && result.residentInputBytes >= 0) task.slot.residentInputBytes = result.residentInputBytes;
        if (task.payload.kind === 'warmup') {
          for (const module of result?.modules ?? task.payload.modules ?? ['ptm']) task.slot[`${module}Warmed`] = true;
          const dxaHeap = result?.initializedModules?.dxa?.wasmMemoryBytes;
          if (Number.isFinite(dxaHeap)) task.slot.dxaHeapBytes = Math.max(task.slot.dxaHeapBytes ?? 0, dxaHeap);
        }
        if (task.payload.kind === 'ptm'
          || (task.payload.kind === 'strain' && !task.payload.ptmInput)) task.slot.ptmWarmed = true;
        if (DXA_STAGE_KINDS.includes(task.payload.kind)) {
          task.slot.dxaWarmed = true;
          task.slot.dxaResidentKey = task.payload.dxaResidentKey;
          if (Number.isFinite(result?.wasmMemoryBytes)) task.slot.dxaHeapBytes = Math.max(task.slot.dxaHeapBytes ?? 0, result.wasmMemoryBytes);
        }
        if (VORONOI_RESIDENT_KINDS.includes(task.payload.kind) && !result?.preparationCancelled) {
          task.slot.voronoiWarmed = true;
          task.slot.voronoiFrameKey = task.payload.residentFrameKey;
        }
        if (task.slot.voronoiReleasePending) this.releaseVoronoiFrame(task.slot);
        if (task.slot.dxaReleasePending) {
          task.slot.worker.postMessage({ kind: 'dxaRelease', dxaResidentKey: task.slot.dxaReleasePending });
          if (task.slot.dxaResidentKey === task.slot.dxaReleasePending) delete task.slot.dxaResidentKey;
          delete task.slot.dxaReleasePending;
        }
        this.idle.push(task.slot);
      }
    }
    task.lease?.release();
    task.lease = null;
    this.active.delete(task);
    this.notifyWorkerSlots();
    const queued = this.queue.indexOf(task);
    if (queued >= 0) this.queue.splice(queued, 1);
    if (!task.cancelledWarmup && !task.cancelledVoronoi) {
      if (error) task.reject(error);
      else task.resolve(result);
    }
    this.pump();
  }

  close() {
    this.closed = true;
    this.voronoiSnapshot = null;
    this.voronoiSnapshotGeneration++;
    this.gpuBackend.close();
    for (const controller of this.controllers) controller.abort();
    for (const task of [...this.active, ...this.queue]) this.finish(task, abortError());
    for (const slot of [...this.idle]) this.terminateWorker(slot);
  }
}

async function copyCoordinates(source, signal, sharedMemory = false) {
  if (signal?.aborted) throw abortError();
  const copy = sharedMemory ? new source.constructor(new SharedArrayBuffer(source.byteLength)) : new source.constructor(source.length);
  const chunkLength = Math.max(1, Math.floor(COPY_CHUNK_BYTES / source.BYTES_PER_ELEMENT));
  for (let offset = 0; offset < source.length; offset += chunkLength) {
    if (signal?.aborted) throw abortError();
    copy.set(source.subarray(offset, Math.min(source.length, offset + chunkLength)), offset);
    if (offset + chunkLength < source.length) await yieldToMain();
  }
  return copy;
}

async function copyPtmNeighbors(table, signal, sharedMemory, range = {}) {
  const tableStart = table.startAtom ?? 0;
  const startAtom = range.startAtom ?? tableStart;
  const endAtom = range.endAtom ?? tableStart + table.counts.length;
  const count = endAtom - startAtom, offset = startAtom - tableStart;
  const sources = { counts: table.counts.subarray(offset, offset + count),
    indices: table.indices.subarray(offset * table.maxNeighbors, (offset + count) * table.maxNeighbors),
    vectors: table.vectors.subarray(offset * table.maxNeighbors * 3, (offset + count) * table.maxNeighbors * 3) };
  return { maxNeighbors: table.maxNeighbors, sourceAtomCount: table.sourceAtomCount ?? tableStart + table.counts.length,
    startAtom, endAtom, ...await copyFields(sources, signal, sharedMemory) };
}

async function copyFields(fields, signal, sharedMemory = false) {
  const copies = {};
  // Sequential fields avoid five large synchronous first chunks accumulating
  // for every preparing Worker before the next browser paint.
  for (const [name, source] of Object.entries(fields)) copies[name] = await copyCoordinates(source, signal, sharedMemory);
  return copies;
}


function waitForCpuResources() {
  // scheduler.yield() promotes its continuation ahead of ordinary Worker
  // message tasks. Repeated no-op preparation retries must allow those ACKs
  // to run, otherwise the very resources being awaited can remain busy forever.
  return new Promise(resolve => setTimeout(resolve, 4));
}

function abortError() {
  return new DOMException('Analysis cancelled.', 'AbortError');
}

async function coordinationStatistics(values, signal) {
  const counts = new Map();
  let sum = 0;
  for (let atom = 0; atom < values.length; atom += 1) {
    const value = values[atom]; counts.set(value, (counts.get(value) ?? 0) + 1); sum += value;
    if (atom && atom % 65_536 === 0) { await yieldToMain(); if (signal.aborted) throw abortError(); }
  }
  return { histogram: [...counts].sort((a, b) => a[0] - b[0]).map(([coordination, count]) => ({ coordination, count })),
    meanCoordination: sum / values.length };
}
