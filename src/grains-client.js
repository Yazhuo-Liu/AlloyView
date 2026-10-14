import { GrainStagePool } from './grain-stage-pool.js';
import { buildGrainDendrogram, segmentGrains, validateGrainParameters } from './analysis/grains.js';

const abortError = () => new DOMException('Grain segmentation was cancelled.', 'AbortError');
const modelKeys = new WeakMap();
let nextModelKey = 1;

const defaultWorkerFactory = typeof Worker === 'function'
  ? () => new Worker(new URL('./workers/grains-worker.js', import.meta.url), { type: 'module' }) : null;
const INPUT_FIELDS = ['structures', 'orientations', 'neighborCounts', 'neighborIndices'];

/** One dedicated Worker for the graph clustering. It keeps the merge sequence
 * of the last structure, so a new threshold, minimum size or orphan setting
 * repeats only the second stage. Geometry and disorientation ranges share the
 * CPU budget; ordered clustering returns to one permit. Cancelling
 * terminates the Worker and starts a fresh one in the background, so the next
 * request does not wait for a cold start. PTM and coordinate arrays are
 * copied, never transferred. Without Worker support the same kernel runs on
 * the calling thread; both paths return identical arrays. */
export class GrainSegmentationClient {
  constructor({ cpuBudget = null, createWorker = defaultWorkerFactory, createStageWorker, environment = globalThis } = {}) {
    this.cpuBudget = cpuBudget; this.createWorker = createWorker;
    this.stages = new GrainStagePool({ createWorker: createStageWorker, environment }); this.tail = Promise.resolve();
    this.worker = null; this.residentKey = null; this.pending = new Map(); this.nextId = 1;
    this.localModel = null;
    this.disposed = false; this.requests = new Set();
  }

  /** Start the Worker and load its modules before the first request. */
  warm(count = 0) {
    if (this.disposed) return;
    this.stages.prewarm(this.stages.degree(count, this.cpuBudget?.limit ?? 1), this.cpuBudget);
    if (!this.createWorker || this.worker) return;
    try { this.ensureWorker().postMessage({ id: 0, type: 'warm' }); }
    catch { this.terminate(); }
  }

  /** ptm: a calculatePtm result with neighbor lists. The first-stage model is
   * identified by these arrays and the two settings that shape it. */
  async segment(input, options = {}, request = {}) {
    if (this.disposed) throw abortError();
    const controller = new AbortController(), sourceSignal = request.signal;
    const cancel = () => controller.abort();
    if (sourceSignal?.aborted) cancel();
    else sourceSignal?.addEventListener('abort', cancel, { once: true });
    this.requests.add(controller);
    const previous = this.tail; let unlock;
    const done = new Promise(resolve => { unlock = resolve; });
    this.tail = previous.catch(() => {}).then(() => done);
    const signal = controller.signal;
    let listener;
    try {
      if (signal?.aborted) throw abortError();
      await Promise.race([previous, new Promise((_, reject) => {
        listener = () => reject(abortError()); signal?.addEventListener('abort', listener, { once: true });
      })]);
      if (signal.aborted || this.disposed) throw abortError();
      return await this.segmentJob(input, options, { ...request, signal });
    } finally {
      signal.removeEventListener('abort', listener); sourceSignal?.removeEventListener('abort', cancel);
      this.requests.delete(controller); unlock();
    }
  }

  async segmentJob({ ptm, fractional, cell, geometryRevision = 0 }, options = {}, { signal, onProgress = () => {} } = {}) {
    if (signal?.aborted) throw abortError();
    const parameters = validateGrainParameters(options);
    for (const field of INPUT_FIELDS) if (!ArrayBuffer.isView(ptm?.[field])) throw new Error('Grain segmentation requires a PTM result with neighbor lists.');
    let keys = modelKeys.get(ptm.neighborIndices);
    if (!keys) modelKeys.set(ptm.neighborIndices, keys = new Map());
    const variant = `${parameters.algorithm === 'mst' ? 'mst' : 'graph'}:${parameters.handleCoherentInterfaces}`;
    if (!Number.isSafeInteger(geometryRevision) || geometryRevision < 0
      || !Number.isSafeInteger(ptm.geometryRevision ?? 0) || (ptm.geometryRevision ?? 0) < 0) throw new Error('Invalid grain geometry revision.');
    const arrays = [ptm.structures, ptm.orientations, ptm.neighborCounts, fractional];
    const values = [geometryRevision, ptm.geometryRevision ?? 0, ...cell.vectors, ...cell.pbc, ...(ptm.neighborSpan ?? [])];
    const previous = keys.get(variant);
    if (!previous || arrays.some((array, i) => array !== previous.arrays[i])
      || values.length !== previous.values.length || values.some((value, i) => !Object.is(value, previous.values[i]))) {
      keys.set(variant, { id: nextModelKey++, arrays, values });
    }
    const modelKey = keys.get(variant).id;
    const input = () => ({ structures: ptm.structures, orientations: ptm.orientations, neighborCounts: ptm.neighborCounts,
      neighborIndices: ptm.neighborIndices, neighborSpan: ptm.neighborSpan ?? null, fractional,
      cell: { vectors: [...cell.vectors], pbc: [...cell.pbc] } });
    await this.stages.stopWarm();
    const degree = this.residentKey === modelKey ? 1 : this.createWorker ? this.stages.degree(ptm.structures.length, this.cpuBudget?.limit ?? 1) : 1;
    let permit = await this.cpuBudget?.acquire(degree, { signal });
    const serial = async (stageSignal = signal) => {
      permit?.release(); permit = null;
      permit = await this.cpuBudget?.acquire(1, { signal: stageSignal });
      if (stageSignal?.aborted) throw abortError();
    };
    try {
      if (signal?.aborted) throw abortError();
      if (!this.createWorker) return this.segmentLocally(modelKey, input, parameters, onProgress);
      return await this.request(modelKey, input, parameters, { signal, onProgress, degree, serial });
    } finally { await this.stages.drain(); permit?.release(); }
  }

  segmentLocally(modelKey, input, parameters, onProgress) {
    const startedAt = performance.now(), modelReused = this.localModel?.key === modelKey;
    if (!modelReused) {
      this.localModel = null;
      this.localModel = { key: modelKey, model: buildGrainDendrogram(input(), { ...parameters, onProgress }) };
    }
    const modelMs = performance.now() - startedAt, result = segmentGrains(this.localModel.model, parameters);
    return { ...result, plot: { distance: result.plot.distance.slice(), size: result.plot.size.slice(), unit: result.plot.unit },
      modelReused, modelMs, elapsedMs: performance.now() - startedAt, worker: false };
  }

  async request(modelKey, input, parameters, { signal, onProgress, degree, serial }) {
    const worker = this.ensureWorker(), id = this.nextId++;
    const operations = new Set();
    try { return await new Promise((resolve, reject) => {
      const abort = () => { this.terminate(abortError()); this.warm(); };
      const settle = callback => value => { signal?.removeEventListener('abort', abort); callback(value); };
      const stages = new AbortController();
      this.pending.set(id, { resolve: settle(result => resolve({ ...result, worker: true })), reject: settle(reject), onProgress, degree,
        signal: stages.signal, stages, serial, input, operations });
      signal?.addEventListener('abort', abort, { once: true });
      const message = { id, type: 'grains', modelKey, parameters,
        model: { algorithm: parameters.algorithm, handleCoherentInterfaces: parameters.handleCoherentInterfaces }, parallel: degree > 2, workerCount: degree };
      if (this.residentKey !== modelKey) message.input = input();
      try {
        worker.postMessage(message);
        this.residentKey = modelKey;
      } catch (error) { this.pending.get(id)?.reject(error); this.pending.delete(id); }
    }); } finally { await Promise.allSettled([...operations]); }
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.worker = worker;
    worker.addEventListener('message', ({ data }) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(data.id);
      if (!pending) return;
      if (data.stageRequest) {
        const { stage, input, length, requestId } = data.stageRequest;
        const operation = stage === 'serial' ? pending.serial(pending.signal)
          : this.stages.run(stage, stage === 'bonds' ? { ...pending.input(), atomCount: length } : input, length, pending.degree, pending.signal);
        pending.operations.add(operation);
        operation.then(() => pending.operations.delete(operation), () => pending.operations.delete(operation));
        const reply = message => {
          if (this.worker !== worker || !this.pending.has(data.id)) return;
          try {
            const transfers = message.result ? [...new Set(Object.values(message.result).filter(ArrayBuffer.isView).map(values => values.buffer))]
              .filter(buffer => !(typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer)) : [];
            worker.postMessage({ type: 'stage-result', requestId, ...message }, transfers);
          } catch (error) { this.terminate(error); }
        };
        operation.then(result => reply({ result }), error => reply({ error: error.message }));
        return;
      }
      if (data.progress) {
        try { pending.onProgress(data.progress.stage, data.progress.fraction); }
        catch (error) { this.terminate(error); }
        return;
      }
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data.result);
      else { this.residentKey = null; pending.reject(new Error(data.error)); }
    });
    const failed = event => {
      if (this.worker === worker) this.terminate(new Error(event.message || 'The grain segmentation Worker failed.'));
    };
    worker.addEventListener('error', failed); worker.addEventListener('messageerror', failed);
    return worker;
  }

  /** Drop the retained merge sequence; the Worker itself stays warm. */
  release() {
    this.localModel = null;
    if (!this.worker || this.pending.size) return;
    this.residentKey = null;
    try { this.worker.postMessage({ id: 0, type: 'release' }); } catch { this.terminate(); }
  }

  terminate(reason = abortError()) {
    this.worker?.terminate();
    this.worker = null; this.residentKey = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) { entry.stages.abort(); entry.reject(reason); }
  }

  dispose() {
    this.disposed = true;
    for (const controller of this.requests) controller.abort();
    this.terminate(); this.stages.dispose(); this.localModel = null;
  }
}
