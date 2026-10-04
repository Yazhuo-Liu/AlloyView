import { CSP_SUMMARY_FIELDS } from './centrosymmetry.js';
import { MAX_BONDS } from './bonds.js';
import { finalizeRdf } from './rdf.js';
import { modalCoordination, shearInvariant } from './local-shear.js';
import { REFERENCE_STRAIN_FIELDS } from './reference-strain.js';
import { GpuAnalysisClient } from './gpu/client.js';
import { validateReferences } from './lattice.js';

const MAX_WORKERS = 6;
const COPY_CHUNK_BYTES = 4 * 1024 ** 2;
const PTM_OUTPUT_FIELDS = { structures: [Uint8Array, 1], rmsd: [Float32Array, 1], scales: [Float64Array, 1],
  deformation: [Float64Array, 9], distances: [Float32Array, 1] };
const STRAIN_OUTPUT_FIELDS = Object.fromEntries(['atomicShearStrain', 'atomicHydrostaticStrain', 'atomicVolumeChange',
  'strainE11', 'strainE22', 'strainE33', 'strainE12', 'strainE13', 'strainE23'].map((name) => [name, [Float32Array, 1]]));
const INPUT_ARRAY_FIELDS = ['structureInput', 'types', 'referenceFractional', 'referenceMapping', 'metricInput'];
const EXTRA_OUTPUT_FIELDS = {
  bonds: { coordination: [Uint32Array, 1] },
  rdf: {},
  localShearCoordination: { coordination: [Uint32Array, 1] },
  localShearMetrics: { metrics: [Float64Array, 6] },
  localShearFinalize: { localShear: [Float32Array, 1] },
  referenceStrain: Object.fromEntries(REFERENCE_STRAIN_FIELDS.map((name) => [name, [Float32Array, 1]])),
};

export function chooseWorkerCount(atomCount, coordinateBytes, environment = globalThis, targetAtoms = 50_000) {
  const hardware = Math.max(1, Number(environment.navigator?.hardwareConcurrency) || 2);
  let count = Math.min(Math.max(1, Math.ceil(atomCount / targetAtoms)), Math.max(1, hardware - 1), MAX_WORKERS);
  const heapLimit = Number(environment.performance?.memory?.jsHeapSizeLimit);
  const copyBudget = Number.isFinite(heapLimit) ? heapLimit * 0.15 : 256 * 1024 ** 2;
  while (count > 1 && coordinateBytes * count > copyBudget) count -= 1;
  return count;
}

/** One concurrency budget across all analyses, with cancellation and bounded
 * coordinate copies. Every task owns a disjoint central-atom range.
 */
export class AnalysisPool {
  constructor({ environment = globalThis, gpuBackend, workerFactory = () => new Worker(
    new URL('../workers/analysis-worker.js', import.meta.url), { type: 'module' },
  ) } = {}) {
    this.environment = environment;
    this.workerFactory = workerFactory;
    this.limit = Math.min(MAX_WORKERS, Math.max(1, (Number(environment.navigator?.hardwareConcurrency) || 2) - 1));
    this.active = new Set();
    this.idle = [];
    this.controllers = new Set();
    this.queue = [];
    this.nextId = 1;
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
  get gpuCacheStatus() { return this.gpuBackend.cacheStatus ?? null; }

  async analyze(frame, parameters, { onProgress = () => {}, signal, frameIndex } = {}) {
    if (this.closed) throw new Error('The analysis pool is closed.');
    if (signal?.aborted) throw abortError();
    const analysisStartedAt = performance.now();
    const gpuRequested = this.gpuEnabled;
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

  /** PTM correspondence fitting remains a CPU algorithm. When necessary, fit
   * once, then route the elastic tensor stage to GPU or its cached-PTM CPU
   * fallback without repeating the expensive template analysis.
   */
  async analyzeStrainWithGpu(frame, parameters, { onProgress, signal, frameIndex }) {
    const startedAt = performance.now(), atomCount = frame.fractional.length / 3;
    if (!ArrayBuffer.isView(frame.types) || frame.types.length !== atomCount) throw new Error('Analysis requires one element type per atom.');
    validateReferences(parameters.references, frame.types);
    const fresh = !parameters.ptmInput;
    const ptm = fresh ? await this.analyzeCPU(frame, { ...parameters, kind: 'ptm' }, { signal,
      onProgress: update => onProgress({ ...update, backend: 'cpu', stage: 'ptm-fit', totalAtoms: atomCount * 2 }) }) : null;
    if (signal?.aborted || this.closed) throw abortError();
    const tensorParameters = { ...parameters, ptmInput: parameters.ptmInput ?? ptm };
    const report = backend => update => onProgress({ ...update, backend, stage: 'strain-tensor',
      completedAtoms: (fresh ? atomCount : 0) + (update.completedAtoms ?? 0), totalAtoms: atomCount * (fresh ? 2 : 1) });
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
    return { ...(ptm ?? {}), ...tensor, backend: tensorBackend, gpuRequested: true, tensorBackend,
      engine: ptm ? `${ptm.engine}+${tensor.engine}` : tensor.engine,
      ...(ptm ? { ptmBackend: 'cpu', ptmWorkerCount: ptm.workerCount, ptmElapsedMs: ptm.elapsedMs } : {}),
      tensorElapsedMs: performance.now() - tensorStartedAt, elapsedMs: performance.now() - startedAt,
      warning: null, ...(fallbackReason ? { fallbackReason } : {}) };
  }

  async analyzeCPU(frame, parameters, { onProgress = () => {}, signal } = {}) {
    if (this.closed) throw new Error('The analysis pool is closed.');
    if (signal?.aborted) throw abortError();
    if (parameters.kind === 'localShear') return this.analyzeLocalShear(frame, parameters, { onProgress, signal });
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
    const autoCentrosymmetry = parameters.kind === 'centrosymmetry' && parameters.mode === 'auto';
    if (parameters.structureInput !== undefined) {
      if (!autoCentrosymmetry || !(parameters.structureInput instanceof Uint8Array)
          || parameters.structureInput.length !== atomCount || parameters.structureInput.some((type) => type > 4)) {
        throw new Error('Auto central symmetry requires complete adaptive CNA structure IDs.');
      }
      extraBytes += parameters.structureInput.byteLength;
    }
    if (['strain', 'bonds', 'rdf'].includes(parameters.kind)) {
      inputs.types = frame.types;
      if (!ArrayBuffer.isView(frame.types) || frame.types.length !== atomCount) throw new Error('Analysis requires one element type per atom.');
      extraBytes += frame.types.byteLength;
    }
    for (const name of ['referenceFractional', 'referenceMapping', 'metricInput']) {
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
    const outputFields = EXTRA_OUTPUT_FIELDS[parameters.kind] ?? (parameters.kind === 'ptm' ? PTM_OUTPUT_FIELDS
      : parameters.kind === 'strain' ? { ...STRAIN_OUTPUT_FIELDS, ...(parameters.ptmInput ? {} : PTM_OUTPUT_FIELDS) }
        : autoCentrosymmetry ? { centrosymmetry: [Float32Array, 1], cspStructureTypes: [Uint8Array, 1], cspNeighborCounts: [Uint8Array, 1] }
          : { values: [parameters.kind === 'cna' ? Uint8Array : Float32Array, 1] });
    const outputBytesPerAtom = Object.values(outputFields).reduce((sum, [Type, stride]) => sum + Type.BYTES_PER_ELEMENT * stride, 0);
    const workerCount = Math.min(this.limit, chooseWorkerCount(atomCount,
      (sharedMemory ? 0 : frame.fractional.byteLength + extraBytes) + atomCount * (48 + outputBytesPerAtom), this.environment,
      parameters.kind === 'coordination' || (parameters.kind === 'strain' && parameters.ptmInput) ? 50_000 : 4_096));
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
        engine: `${parameters.kind === 'ptm' || (parameters.kind === 'strain' && !parameters.ptmInput) ? 'ptm-wasm' : 'js'}-worker${workerCount === 1 ? '' : `-pool×${workerCount}`}` };
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
        sharedMemory, worker: null, slot: null, done: false };
      task.abort = () => this.finish(task, abortError());
      signal.addEventListener('abort', task.abort, { once: true });
      this.queue.push(task);
      if (signal.aborted) task.abort();
      else this.pump();
    });
  }

  pump() {
    while (!this.closed && this.active.size < this.limit && this.queue.length) {
      const task = this.queue.shift();
      if (task.done) continue;
      // A caller's abort listeners run one at a time. Its original signal may
      // already be aborted before another job's internal controller sees it.
      if (task.signal.aborted || task.sourceSignal?.aborted) { this.finish(task, abortError()); continue; }
      this.active.add(task);
      try {
        const slot = this.idle.pop() ?? this.createWorker();
        slot.task = task;
        task.slot = slot;
        task.worker = slot.worker;
        task.onPhase('preparing');
        void this.dispatch(task);
      } catch (error) { this.finish(task, error); }
    }
  }

  createWorker() {
    const slot = { worker: this.workerFactory(), task: null, terminated: false };
    slot.worker.addEventListener('message', ({ data }) => {
      const task = slot.task;
      if (!task || task.done || data.id !== task.id) return;
      if (data.phase) task.onPhase(data.phase, data);
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
      await yieldToMain();
      if (task.done) return;
      let payload = task.payload;
      const transferables = [];
      if (!task.sharedMemory) {
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
      }
      if (task.done || task.signal.aborted || task.sourceSignal?.aborted) return;
      task.worker.postMessage({ id: task.id, ...payload }, transferables);
      if (!task.done) task.onPhase('prepared');
    } catch (error) { this.finish(task, error); }
  }

  terminateWorker(slot) {
    if (slot.terminated) return;
    slot.terminated = true;
    slot.worker.terminate();
    const index = this.idle.indexOf(slot);
    if (index >= 0) this.idle.splice(index, 1);
  }

  finish(task, error, result) {
    if (task.done) return;
    task.done = true;
    task.signal.removeEventListener('abort', task.abort);
    if (task.slot) {
      task.slot.task = null;
      if (error || this.closed) this.terminateWorker(task.slot);
      else this.idle.push(task.slot);
    }
    this.active.delete(task);
    const queued = this.queue.indexOf(task);
    if (queued >= 0) this.queue.splice(queued, 1);
    if (error) task.reject(error);
    else task.resolve(result);
    this.pump();
  }

  close() {
    this.closed = true;
    this.gpuBackend.close();
    for (const controller of this.controllers) controller.abort();
    for (const task of [...this.active, ...this.queue]) this.finish(task, abortError());
    for (const slot of [...this.idle]) this.terminateWorker(slot);
  }
}

async function copyCoordinates(source, signal, sharedMemory = false) {
  if (signal.aborted) throw abortError();
  const copy = sharedMemory ? new source.constructor(new SharedArrayBuffer(source.byteLength)) : new source.constructor(source.length);
  const chunkLength = Math.max(1, Math.floor(COPY_CHUNK_BYTES / source.BYTES_PER_ELEMENT));
  for (let offset = 0; offset < source.length; offset += chunkLength) {
    if (signal.aborted) throw abortError();
    copy.set(source.subarray(offset, Math.min(source.length, offset + chunkLength)), offset);
    if (offset + chunkLength < source.length) await yieldToMain();
  }
  return copy;
}

async function copyFields(fields, signal, sharedMemory = false) {
  const copies = {};
  // Sequential fields avoid five large synchronous first chunks accumulating
  // for every preparing Worker before the next browser paint.
  for (const [name, source] of Object.entries(fields)) copies[name] = await copyCoordinates(source, signal, sharedMemory);
  return copies;
}

function yieldToMain() {
  return typeof globalThis.scheduler?.yield === 'function' ? globalThis.scheduler.yield()
    : new Promise((resolve) => setTimeout(resolve, 0));
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
