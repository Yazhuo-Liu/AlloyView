import { CpuBudget } from './cpu-budget.js';
import { validateVolumetricDataset, volumetricCellDimensions, volumetricDatasetMetadata } from '../data/volumetric-grid.js';
import { validateVolumetricParameters, isosurfaceSteps, volumeSliceSteps, prepareVolumetricRenderGeometrySteps, volumeSliceCsvSteps } from './volumetric.js';
import { runParserStepsAsync } from '../io/cooperative-parser.js';

const abortError = () => new DOMException('Volumetric analysis was cancelled.', 'AbortError');
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
const defaultWorkerFactory = typeof Worker === 'function'
  ? () => new Worker(new URL('../workers/volumetric-worker.js', import.meta.url), { type: 'module' }) : null;
const COPY_ELEMENTS = 131072;

function* copyValues(source, shared = false) {
  const values = shared ? new source.constructor(new SharedArrayBuffer(source.byteLength)) : new source.constructor(source.length);
  for (let start = 0; start < source.length; start += COPY_ELEMENTS) { yield; values.set(source.subarray(start, start + COPY_ELEMENTS), start); }
  return values;
}

function* mergeSurfaces(parts, dataset, parameters) {
  parts.sort((a, b) => a.startCell - b.startCell);
  const triangleCount = parts.reduce((sum, part) => sum + part.triangleCount, 0);
  if (triangleCount > parameters.maxTriangles) throw new Error('The isosurface exceeds its triangle budget; choose a different level or a smaller grid.');
  const vertices = new Float64Array(triangleCount * 9), triangles = new Uint32Array(triangleCount * 3);
  const positions = new Float32Array(vertices.length), normals = new Float32Array(vertices.length);
  const bounds = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  let offset = 0, surfaceArea = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    for (let start = 0; start < part.vertices.length; start += COPY_ELEMENTS) {
      yield;
      vertices.set(part.vertices.subarray(start, start + COPY_ELEMENTS), offset + start);
      positions.set(part.renderGeometry.positions.subarray(start, start + COPY_ELEMENTS), offset + start);
      normals.set(part.renderGeometry.normals.subarray(start, start + COPY_ELEMENTS), offset + start);
    }
    if (part.triangleCount) for (let axis = 0; axis < 3; axis++) {
      bounds[axis] = Math.min(bounds[axis], part.renderGeometry.bounds[axis]);
      bounds[axis + 3] = Math.max(bounds[axis + 3], part.renderGeometry.bounds[axis + 3]);
    }
    offset += part.vertices.length; surfaceArea += part.statistics.surfaceArea; parts[index] = null;
  }
  for (let index = 0; index < triangles.length; index++) { if ((index & 8191) === 0) yield; triangles[index] = index; }
  if (!triangleCount) bounds.fill(0);
  return { kind: 'isosurface', vertices, triangles, triangleCount, level: parameters.level,
    startCell: parameters.startCell, endCell: parameters.endCell, totalCells: parameters.totalCells,
    statistics: { surfaceArea }, renderGeometry: { positions, normals, bounds },
    grid: { origin: [...dataset.origin], steps: [...dataset.steps], dimensions: [...dataset.dimensions], periodic: [...dataset.periodic] } };
}

/** Retained Workers own immutable grid snapshots. CPU extraction shares the
 * application's CPU budget in bounded chunks; GPU requests use one retained
 * runtime and do not reserve CPU cores while awaiting device work. */
export class VolumetricClient {
  constructor({ cpuBudget = null, environment = globalThis, createWorker = defaultWorkerFactory,
    workerFactory = createWorker, cellsPerWorker = 32768, chunkCells = 8192, requestTimeoutMs = 120000 } = {}) {
    this.cpuBudget = cpuBudget ?? new CpuBudget({ environment }); this.environment = environment;
    this.createWorker = workerFactory; this.cellsPerWorker = Math.max(1, Math.floor(cellsPerWorker)); this.chunkCells = Math.max(1, Math.min(16384, Math.floor(chunkCells)));
    this.requestTimeoutMs = requestTimeoutMs; this.slots = []; this.tasks = new Set(); this.tail = Promise.resolve();
    this.keys = new WeakMap(); this.nextKey = 1; this.nextId = 1; this.snapshot = null; this.closed = false;
  }

  get sharedMemory() { return Boolean(this.environment.crossOriginIsolated && typeof SharedArrayBuffer === 'function'); }
  workerCount(dataset) {
    const cells = volumetricCellDimensions(dataset).reduce((a, b) => a * b, 1);
    // Private coordinate copies are bounded separately from output geometry.
    const memoryCount = this.sharedMemory ? this.cpuBudget.limit : Math.max(1, Math.floor(256 * 1024 ** 2 / dataset.values.byteLength));
    // Six tetrahedra emit at most twelve triangles per voxel. Each triangle
    // retains 72 bytes of f64 positions, 12 of indices, and 72 of render data.
    // Even shared grids cannot remove this per-running-chunk output cost.
    const stagingCount = Math.max(1, Math.floor(256 * 1024 ** 2 / (this.chunkCells * 12 * 156)));
    return Math.max(1, Math.min(this.cpuBudget.limit, memoryCount, stagingCount, Math.ceil(cells / this.cellsPerWorker)));
  }

  key(dataset) {
    validateVolumetricDataset(dataset);
    const signature = JSON.stringify([dataset.revision ?? 0, dataset.dimensions, Array.from(dataset.origin), Array.from(dataset.steps), dataset.periodic,
      dataset.name, dataset.unit, dataset.id]);
    let entry = this.keys.get(dataset.values);
    if (!entry || entry.signature !== signature) { entry = { signature, key: this.nextKey++ }; this.keys.set(dataset.values, entry); }
    return entry.key;
  }

  enqueue(operation, { signal, background = false } = {}) {
    if (this.closed) return Promise.reject(new Error('The volumetric client is closed.'));
    if (signal?.aborted) return Promise.reject(abortError());
    // Foreground interaction must not wait for unnecessary background growth.
    if (!background) for (const task of this.tasks) if (task.background) task.controller.abort();
    const task = { controller: new AbortController(), background };
    const abort = () => task.controller.abort(); signal?.addEventListener('abort', abort, { once: true }); this.tasks.add(task);
    const result = this.tail.then(() => { checkAbort(task.controller.signal); return operation(task.controller.signal, task); });
    this.tail = result.catch(() => {});
    return result.finally(() => { this.tasks.delete(task); signal?.removeEventListener('abort', abort); });
  }

  slot(index) {
    let slot = this.slots[index];
    if (slot?.worker) return slot;
    slot = { worker: null, pending: null, residentKey: null }; this.slots[index] = slot;
    const worker = this.createWorker(); slot.worker = worker;
    worker.addEventListener('message', ({ data }) => {
      if (slot.worker !== worker || slot.pending?.id !== data.id) return;
      const pending = slot.pending;
      if (data.progress) {
        try { pending.onProgress?.(data.progress); } catch (error) {
          pending.callbackError = error;
          try { worker.postMessage({ type: 'cancel', id: data.id }); } catch (failure) { this.failSlot(slot, failure); }
        }
        return;
      }
      slot.residentKey = data.residentKey ?? null;
      if (pending.callbackError) pending.reject(pending.callbackError);
      else if (pending.signal?.aborted) pending.reject(abortError());
      else if (data.ok) pending.resolve(data.result);
      else { const error = new Error(data.error || 'Volumetric analysis failed.'); error.name = data.name || 'Error'; error.gpuUnavailable = Boolean(data.gpuUnavailable); pending.reject(error); }
    });
    const fail = event => { if (slot.worker === worker) this.failSlot(slot, new Error(event.message || 'The volumetric Worker failed.')); };
    worker.addEventListener('error', fail); worker.addEventListener('messageerror', fail);
    return slot;
  }

  failSlot(slot, error) {
    slot.worker?.terminate(); slot.worker = null; slot.residentKey = null; slot.pending?.reject(error);
  }

  request(slot, message, { signal, onProgress, transfer = [] } = {}) {
    checkAbort(signal);
    if (slot.pending) return Promise.reject(new Error('A volumetric Worker already has a pending request.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer;
      const abort = () => { try { slot.worker?.postMessage({ type: 'cancel', id }); } catch (error) { this.failSlot(slot, error); } };
      const finish = callback => value => {
        if (slot.pending?.id !== id) return;
        slot.pending = null; clearTimeout(timer); signal?.removeEventListener('abort', abort); callback(value);
      };
      slot.pending = { id, resolve: finish(resolve), reject: finish(reject), signal, onProgress };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => this.failSlot(slot, new Error('The volumetric Worker stopped responding.')), this.requestTimeoutMs);
      try { slot.worker.postMessage({ ...message, id }, transfer); } catch (error) { this.failSlot(slot, error); }
    });
  }

  async withPermit(signal, background, operation) {
    const lease = await this.cpuBudget.acquire(1, { signal, priority: background ? -1 : 0, owner: this });
    try { checkAbort(signal); return await operation(); } finally { lease.release(); }
  }

  async prepareSlot(slot, dataset, key, signal, background) {
    if (slot.residentKey === key) return false;
    await this.withPermit(signal, background, async () => {
      let values;
      if (this.sharedMemory) {
        if (this.snapshot?.key !== key) {
          const pending = runParserStepsAsync(copyValues(dataset.values, true), { signal });
          this.snapshot = { key, pending };
        }
        try { values = await this.snapshot.pending; } catch (error) { if (this.snapshot?.key === key) this.snapshot = null; throw error; }
      } else values = await runParserStepsAsync(copyValues(dataset.values), { signal });
      checkAbort(signal);
      const copy = { ...volumetricDatasetMetadata(dataset), revision: dataset.revision ?? 0, values };
      await this.request(slot, { type: 'prepare', key, dataset: copy }, { signal,
        transfer: values.buffer instanceof ArrayBuffer ? [values.buffer] : [] });
    });
    return true;
  }

  warm({ useGpu = false, signal } = {}) {
    return this.enqueue(async activeSignal => {
      if (!this.createWorker) return { workerCount: 0, gpuReady: false };
      const slot = this.slot(0);
      if (!useGpu) return { workerCount: 1, gpuReady: false };
      try { return { workerCount: 1, ...await this.request(slot, { type: 'warm-gpu' }, { signal: activeSignal }) }; }
      catch (error) { if (error.name === 'AbortError') throw error; return { workerCount: 1, gpuReady: false, fallbackReason: error.message }; }
    }, { signal, background: true });
  }

  prepare(dataset, { useGpu = false, signal } = {}) {
    return this.enqueue(async activeSignal => {
      const key = this.key(dataset);
      if (!this.createWorker) return { workerCount: 0, gpuReady: false };
      const count = this.workerCount(dataset);
      const results = await Promise.allSettled(Array.from({ length: count }, async (_, index) => this.prepareSlot(this.slot(index), dataset, key, activeSignal, true)));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      let gpu = { gpuReady: false };
      if (useGpu) try { gpu = await this.request(this.slots[0], { type: 'warm-gpu', key }, { signal: activeSignal }); }
      catch (error) { if (error.name === 'AbortError') throw error; gpu.fallbackReason = error.message; }
      return { workerCount: count, gridUploads: results.filter(result => result.value).length, sharedMemory: this.sharedMemory, ...gpu };
    }, { signal, background: true });
  }

  analyze(dataset, parameters, { signal, onProgress, useGpu = false } = {}) {
    return this.enqueue(async activeSignal => {
      const startedAt = performance.now(), options = validateVolumetricParameters(dataset, parameters), key = this.key(dataset);
      let fallbackReason = null, gridUploads = 0;
      const progress = update => { checkAbort(activeSignal); onProgress?.(update); };
      if (!this.createWorker) {
        if (useGpu && options.kind === 'isosurface') fallbackReason = 'Workers are unavailable; using the CPU implementation.';
        const result = await this.withPermit(activeSignal, false, async () => {
          const steps = options.kind === 'slice' ? volumeSliceSteps(dataset, options) : isosurfaceSteps(dataset, { ...options, onProgress: progress });
          let result = await runParserStepsAsync(steps, { signal: activeSignal });
          if (result.kind === 'isosurface') result = await runParserStepsAsync(prepareVolumetricRenderGeometrySteps(result, dataset), { signal: activeSignal });
          return result;
        });
        return { ...result, backend: 'cpu', workerCount: 1, elapsedMs: performance.now() - startedAt, fallbackReason };
      }
      if (useGpu && options.kind === 'isosurface') {
        const slot = this.slot(0); gridUploads += Number(await this.prepareSlot(slot, dataset, key, activeSignal, false));
        try {
          const result = await this.request(slot, { type: 'analyze', key, parameters: options, useGpu: true }, { signal: activeSignal, onProgress: progress });
          return { ...result, backend: 'gpu', workerCount: 1, gridUploads, elapsedMs: performance.now() - startedAt };
        } catch (error) {
          if (error.name === 'AbortError' || activeSignal.aborted || !error.gpuUnavailable) throw error;
          fallbackReason = error.message; progress({ phase: 'cpu-fallback', backend: 'cpu', reason: fallbackReason });
        }
      }
      const count = options.kind === 'slice' ? 1 : this.workerCount(dataset);
      const prepare = await Promise.allSettled(Array.from({ length: count }, async (_, index) => this.prepareSlot(this.slot(index), dataset, key, activeSignal, false)));
      for (const result of prepare) { if (result.status === 'rejected') throw result.reason; gridUploads += Number(result.value); }
      if (options.kind === 'slice') {
        const result = await this.withPermit(activeSignal, false, () => this.request(this.slots[0], { type: 'analyze', key, parameters: options }, { signal: activeSignal }));
        return { ...result, workerCount: 1, gridUploads, sharedMemory: this.sharedMemory, elapsedMs: performance.now() - startedAt };
      }
      const ranges = [], controller = new AbortController(), abort = () => controller.abort();
      activeSignal.addEventListener('abort', abort, { once: true });
      let nextCell = options.startCell, triangleCount = 0, completedCells = 0, failure = null;
      try {
        await Promise.all(Array.from({ length: count }, async (_, index) => {
          try {
            while (nextCell < options.endCell) {
              checkAbort(controller.signal);
              const startCell = nextCell, endCell = Math.min(options.endCell, startCell + this.chunkCells); nextCell = endCell;
              const result = await this.withPermit(controller.signal, false, () => this.request(this.slots[index],
                { type: 'analyze', key, parameters: { ...options, startCell, endCell } }, { signal: controller.signal }));
              ranges.push(result); triangleCount += result.triangleCount; completedCells += endCell - startCell;
              if (triangleCount > options.maxTriangles) throw new Error('The isosurface exceeds its triangle budget; choose a different level or a smaller grid.');
              progress({ phase: 'analyzing', backend: 'cpu', workerCount: count, completedCells, totalCells: options.endCell - options.startCell });
            }
          } catch (error) { failure ??= error; controller.abort(); }
        }));
        if (failure) throw failure;
        const result = await runParserStepsAsync(mergeSurfaces(ranges, dataset, options), { signal: activeSignal });
        progress({ phase: 'complete', backend: 'cpu', workerCount: count, completedCells, totalCells: options.endCell - options.startCell });
        return { ...result, backend: 'cpu', workerCount: count, gridUploads, sharedMemory: this.sharedMemory, fallbackReason, elapsedMs: performance.now() - startedAt };
      } finally { activeSignal.removeEventListener('abort', abort); }
    }, { signal });
  }

  exportSliceCsv(result, options = {}, { signal } = {}) {
    return this.enqueue(activeSignal => this.withPermit(activeSignal, false, async () => {
      if (!this.createWorker) return runParserStepsAsync(volumeSliceCsvSteps(result, options), { signal: activeSignal });
      const values = await runParserStepsAsync(copyValues(result.values), { signal: activeSignal });
      const copy = { kind: result.kind, values, width: result.width, height: result.height,
        origin: result.origin, steps: result.steps, unit: result.unit };
      return this.request(this.slot(0), { type: 'csv', result: copy, options }, { signal: activeSignal, transfer: [values.buffer] });
    }), { signal });
  }

  abortAll() { for (const task of this.tasks) task.controller.abort(); }
  /** GPU preference changes retire the device only after accepted foreground
   * work acknowledges completion, retaining all CPU Workers and snapshots. */
  releaseGpuResources() {
    return this.enqueue(async signal => {
      const slot = this.slots[0];
      return slot?.worker ? this.request(slot, { type: 'release-gpu' }, { signal }) : { gpuReady: false };
    });
  }
  clear() {
    this.abortAll(); this.snapshot = null;
    return this.enqueue(async signal => {
      const results = await Promise.allSettled(this.slots.filter(slot => slot.worker).map(slot => this.request(slot, { type: 'clear' }, { signal })));
      for (const slot of this.slots) slot.residentKey = null;
      return { cleared: true, failures: results.filter(result => result.status === 'rejected').length };
    });
  }
  clearSnapshot() { return this.clear(); }
  dispose() {
    if (this.closed) return;
    this.closed = true; this.abortAll(); this.snapshot = null;
    for (const slot of this.slots) this.failSlot(slot, abortError());
  }
}
