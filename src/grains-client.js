import { buildGrainDendrogram, segmentGrains, validateGrainParameters } from './analysis/grains.js';

const abortError = () => new DOMException('Grain segmentation was cancelled.', 'AbortError');
const modelKeys = new WeakMap();
let nextModelKey = 1;

const defaultWorkerFactory = typeof Worker === 'function'
  ? () => new Worker(new URL('./workers/grains-worker.js', import.meta.url), { type: 'module' }) : null;
const INPUT_FIELDS = ['structures', 'orientations', 'neighborCounts', 'neighborIndices'];

/** One dedicated Worker for the graph clustering. It keeps the merge sequence
 * of the last structure, so a new threshold, minimum size or orphan setting
 * repeats only the second stage. A job holds one CPU budget permit. Cancelling
 * terminates the Worker and starts a fresh one in the background, so the next
 * request does not wait for a cold start. PTM and coordinate arrays are
 * copied, never transferred. Without Worker support the same kernel runs on
 * the calling thread; both paths return identical arrays. */
export class GrainSegmentationClient {
  constructor({ cpuBudget = null, createWorker = defaultWorkerFactory } = {}) {
    this.cpuBudget = cpuBudget; this.createWorker = createWorker;
    this.worker = null; this.residentKey = null; this.pending = new Map(); this.nextId = 1;
    this.localModel = null;
  }

  /** Start the Worker and load its modules before the first request. */
  warm() {
    if (!this.createWorker || this.worker) return;
    try { this.ensureWorker().postMessage({ id: 0, type: 'warm' }); }
    catch { this.terminate(); }
  }

  /** ptm: a calculatePtm result with neighbor lists. The first-stage model is
   * identified by these arrays and the two settings that shape it. */
  async segment({ ptm, fractional, cell }, options = {}, { signal, onProgress = () => {} } = {}) {
    if (signal?.aborted) throw abortError();
    const parameters = validateGrainParameters(options);
    for (const field of INPUT_FIELDS) if (!ArrayBuffer.isView(ptm?.[field])) throw new Error('Grain segmentation requires a PTM result with neighbor lists.');
    let keys = modelKeys.get(ptm.neighborIndices);
    if (!keys) modelKeys.set(ptm.neighborIndices, keys = new Map());
    const variant = `${parameters.algorithm === 'mst' ? 'mst' : 'graph'}:${parameters.handleCoherentInterfaces}`;
    if (!keys.has(variant)) keys.set(variant, nextModelKey++);
    const modelKey = keys.get(variant);
    const input = () => ({ structures: ptm.structures, orientations: ptm.orientations, neighborCounts: ptm.neighborCounts,
      neighborIndices: ptm.neighborIndices, neighborSpan: ptm.neighborSpan ?? null, fractional,
      cell: { vectors: cell.vectors, pbc: cell.pbc } });
    const permit = await this.cpuBudget?.acquire(1, { signal });
    try {
      if (signal?.aborted) throw abortError();
      if (!this.createWorker) return this.segmentLocally(modelKey, input, parameters, onProgress);
      return await this.request(modelKey, input, parameters, { signal, onProgress });
    } finally { permit?.release(); }
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

  request(modelKey, input, parameters, { signal, onProgress }) {
    const worker = this.ensureWorker(), id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => { this.terminate(abortError()); this.warm(); };
      const settle = callback => value => { signal?.removeEventListener('abort', abort); callback(value); };
      this.pending.set(id, { resolve: settle(result => resolve({ ...result, worker: true })), reject: settle(reject), onProgress });
      signal?.addEventListener('abort', abort, { once: true });
      const message = { id, type: 'grains', modelKey, parameters,
        model: { algorithm: parameters.algorithm, handleCoherentInterfaces: parameters.handleCoherentInterfaces } };
      if (this.residentKey !== modelKey) message.input = input();
      try {
        worker.postMessage(message);
        this.residentKey = modelKey;
      } catch (error) { this.pending.get(id)?.reject(error); this.pending.delete(id); }
    });
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    this.worker = worker;
    worker.addEventListener('message', ({ data }) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(data.id);
      if (!pending) return;
      if (data.progress) { pending.onProgress(data.progress.stage, data.progress.fraction); return; }
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data.result);
      else { this.residentKey = null; pending.reject(new Error(data.error)); }
    });
    worker.addEventListener('error', event => {
      if (this.worker === worker) this.terminate(new Error(event.message || 'The grain segmentation Worker failed.'));
    });
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
    for (const entry of pending) entry.reject(reason);
  }

  dispose() { this.terminate(); this.localModel = null; }
}
