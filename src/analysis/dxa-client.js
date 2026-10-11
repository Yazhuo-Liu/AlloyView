import { DXA_CODE_WARMUP_MIN_ATOMS, dxaWorkerCount, normalizeDefectMeshRequest, preflightDxaMemory, validateDxaFrame, validateDxaParameters } from './dxa.js';
import { validateSurfaceMask, validateSurfaceMeshParameters } from './surface-mesh.js';
import { CpuBudget } from './cpu-budget.js';
import { createAnalysisProgressReporter } from './progress.js';

const COPY_CHUNK_VALUES = 512 * 1024;
// Automatic private-stage Workers on hosts without shared memory, one per
// 4,096 atoms up to these caps and the CPU budget.
const DEFAULT_STAGE_WORKER_LIMITS = Object.freeze({ local: 8, tetrahedra: 4 });
const abortError = () => new DOMException('The DXA calculation was cancelled.', 'AbortError');
// Warmups are background tasks; DXA and surface jobs run in the foreground.
const foreground = task => task.type !== 'warmup';

/** One coordinator and one growable Wasm heap per client. Shared-memory jobs
 * cancel cooperatively and keep their pool; static-host jobs must terminate
 * synchronous native work. Warmups prepare modules without copying a frame.
 */
export class DxaClient {
  constructor({ workerFactory = () => new Worker(new URL('../workers/dxa-worker.js', import.meta.url), { type: 'module' }),
    memoryBudgetBytes, workerCount, environment = globalThis, cpuBudget,
    cpuStageBackend, cpuStageTaskTimeoutMs, codeWarmupMinAtoms = DXA_CODE_WARMUP_MIN_ATOMS,
    stageWorkerLimits = DEFAULT_STAGE_WORKER_LIMITS,
    yieldToMain = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
    this.workerFactory = workerFactory;
    this.codeWarmupMinAtoms = codeWarmupMinAtoms;
    this.stageWorkerLimits = { ...DEFAULT_STAGE_WORKER_LIMITS, ...stageWorkerLimits };
    this.memoryBudgetBytes = memoryBudgetBytes;
    this.workerCount = workerCount;
    this.environment = environment;
    this.cpuBudget = cpuBudget ?? new CpuBudget({ environment });
    this.cpuStageBackend = cpuStageBackend;
    this.cpuStageTaskTimeoutMs = cpuStageTaskTimeoutMs;
    this.yieldToMain = yieldToMain;
    this.worker = null;
    this.control = null;
    this.ready = null;
    this.singleThreadOnly = false;
    this.pending = new Map();
    this.queue = [];
    this.current = null;
    this.nextId = 1;
    this.closed = false;
  }

  get cpuWarmupStatus() { return this.ready; }

  requestedWorkers(count, requested) {
    const workers = Math.min(this.cpuBudget.limit, dxaWorkerCount(count, requested, this.environment));
    return this.singleThreadOnly || this.ready?.threadingFallback ? 1 : workers;
  }

  warmup({ atomCount = 1, workerCount = this.workerCount, signal, onProgress = () => {} } = {}) {
    if (signal?.aborted || this.closed) return Promise.reject(abortError());
    let count;
    try {
      if (!Number.isSafeInteger(atomCount) || atomCount < 1) throw new Error('DXA warmup requires a positive atom count.');
      preflightDxaMemory(atomCount, this.memoryBudgetBytes);
      count = this.requestedWorkers(atomCount, workerCount);
    } catch (error) { return Promise.reject(error); }
    const pool = this.preparePool(atomCount, count, signal, onProgress);
    return atomCount < this.codeWarmupMinAtoms ? pool
      : pool.then(ready => this.warmCode(ready, { atomCount, signal, onProgress }));
  }

  preparePool(atomCount, count, signal, onProgress) {
    if (this.worker && this.ready && this.ready.poolSize >= count - 1) {
      return Promise.resolve({ ...this.ready, workerCount: count });
    }
    const prepared = [this.current, ...this.queue].find(task => task?.type === 'warmup' && !task.warmCode
      && !task.settled && task.workerCount >= count);
    if (prepared && prepared.signal === signal) return prepared.promise;
    return this.enqueue({ type: 'warmup', count: atomCount, workerCount: count, signal, onProgress });
  }

  codeWarmed(workerCount) {
    return Boolean(this.ready?.warmedKernelPaths?.includes(workerCount > 1 ? 'parallel' : 'serial'));
  }

  /** After the pool is ready, run one small extraction on at most two of its
   * threads, so the first real analysis does not run cold Wasm code. It is a
   * separate low-priority task: it holds only the permits it uses, and a
   * foreground analysis preempts it like any other warmup. */
  warmCode(ready, { atomCount, signal, onProgress }) {
    const workerCount = Math.min(2, ready.workerCount);
    if (this.codeWarmed(workerCount)) return ready;
    if (signal?.aborted || this.closed) return Promise.reject(abortError());
    const result = () => ({ ...this.ready, workerCount: ready.workerCount });
    const pending = [this.current, ...this.queue].find(task => task?.warmCode && !task.settled);
    if (pending && pending.signal === signal) return pending.promise.then(result);
    return this.enqueue({ type: 'warmup', warmCode: true, count: atomCount, workerCount, signal, onProgress }).then(result);
  }

  analyze(frame, parameters = {}, { signal, onProgress = () => {}, workerCount = this.workerCount, defectMesh } = {}) {
    if (signal?.aborted || this.closed) return Promise.reject(abortError());
    let settings, count, workers, defectMeshRequest;
    try {
      settings = validateDxaParameters(parameters);
      defectMeshRequest = normalizeDefectMeshRequest(defectMesh);
      count = validateDxaFrame(frame, { validateCoordinates: false });
      preflightDxaMemory(count, this.memoryBudgetBytes);
      workers = this.requestedWorkers(count, workerCount);
    } catch (error) { return Promise.reject(error); }
    // Each private Worker holds a complete copy of its stage input. Local
    // recognition needs 24 bytes per atom plus its own neighbor index, while
    // a tetrahedron-table copy needs about 850 bytes per atom (23 MiB for
    // 28,800 atoms), so each stage has its own automatic cap. Explicit
    // requests apply to both; the per-stage memory checks still limit them.
    const stageWorkerCounts = Object.fromEntries(Object.entries(this.stageWorkerLimits).map(([stage, maximum]) =>
      [stage, Math.min(this.cpuBudget.limit, workerCount ?? Math.min(maximum, Math.ceil(count / 4096)))]));
    const cpuOffload = this.environment.crossOriginIsolated !== true && count >= 8192
      && Math.max(...Object.values(stageWorkerCounts)) > 1
      && typeof this.cpuStageBackend?.analyzeDxaLocal === 'function' && typeof this.cpuStageBackend?.analyzeDxaTetrahedra === 'function';
    return this.enqueue({ type: 'analyze', frame, parameters: settings, count, workerCount: workers,
      stageWorkerCounts, cpuOffload, signal, onProgress, defectMesh: defectMeshRequest });
  }

  /** Alpha-shape surface construction in the same Worker, heap and pthread
   * pool as DXA. `mask` restricts the tessellation to nonzero atoms. Jobs of
   * both kinds run one after the other. */
  surface(frame, parameters = {}, { mask, signal, onProgress = () => {}, workerCount = this.workerCount } = {}) {
    if (signal?.aborted || this.closed) return Promise.reject(abortError());
    let settings, count, workers, selection;
    try {
      settings = validateSurfaceMeshParameters(parameters);
      count = validateDxaFrame(frame, { validateCoordinates: false });
      selection = validateSurfaceMask(mask, count);
      preflightDxaMemory(count, this.memoryBudgetBytes);
      workers = this.requestedWorkers(count, workerCount);
    } catch (error) { return Promise.reject(error); }
    return this.enqueue({ type: 'surface', frame, mask: selection, parameters: settings, count, workerCount: workers, signal, onProgress });
  }

  enqueue(values) {
    const task = { id: this.nextId++, ...values, controller: new AbortController(), settled: false, dispatched: false };
    task.progressReporter = createAnalysisProgressReporter(values.onProgress ?? (() => {}), { environment: this.environment, signal: values.signal });
    task.onProgress = task.progressReporter.report;
    task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
    task.abort = () => this.cancel(task);
    task.signal?.addEventListener('abort', task.abort, { once: true });
    this.pending.set(task.id, task); this.queue.push(task);
    if (foreground(task) && this.current?.type === 'warmup' && !this.current.settled) this.cancel(this.current);
    this.pump();
    return task.promise;
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = this.workerFactory();
    this.worker = worker;
    worker.addEventListener('message', ({ data }) => {
      if (this.worker !== worker) return;
      const task = this.current;
      if (!task || task.id !== data.id) return;
      if (Object.hasOwn(data, 'control')) {
        this.control = data.control;
        task.sharedMemory = Boolean(data.control);
        if (!data.control) this.singleThreadOnly = true;
        if (task.settled) {
          if (data.control) this.setCancellation(1);
          else if (foreground(task) && !task.cpuStageWaiting) { this.terminateWorker(); this.retire(task); }
        }
        return;
      }
      if (data.progress) {
        if (data.progress.awaitingCpuStage) task.cpuStageWaiting = true;
        if (data.progress.threadingFallback) {
          this.singleThreadOnly = true;
          if (this.ready) this.ready = { ...this.ready, workerCount: 1, threadingFallback: data.progress.threadingFallback };
        }
        if (task.settled) return;
        try { task.onProgress({ backend: 'cpu', workerCount: task.workerCount, ...data.progress }); }
        catch (error) { this.cancel(task, error); }
        return;
      }
      if (data.cpuStageRequest) {
        void this.dispatchCpuStage(task, worker, data.cpuStageRequest);
        return;
      }
      if (data.ok) {
        const { workerCount, poolSize, kernelGeneration, wasmMemoryBytes, threadingFallback, sharedMemory, warmedKernelPaths } = data.result;
        if (threadingFallback || sharedMemory === false) this.singleThreadOnly = true;
        const threaded = data.result.threaded ?? data.result.sharedMemory;
        if (Number.isInteger(poolSize)) {
          this.ready = { workerCount: task.warmCode ? this.ready?.workerCount ?? workerCount : workerCount,
            poolSize, kernelGeneration, wasmMemoryBytes, threaded, sharedMemory, threadingFallback, warmedKernelPaths };
        }
        this.settle(task, null, data.result);
      } else {
        const error = new Error(data.error || 'DXA calculation failed.'); error.name = data.name || 'Error';
        this.settle(task, error);
      }
      if (data.fatal) { task.controller.abort(); this.terminateWorker(); }
      if (task.cpuStageRequestId !== undefined) {
        // A cancelled coordinator can acknowledge before its private CPU
        // jobs finish joining. Do not dispatch another frame until both sides
        // have released their permits and stopped using that stage snapshot.
        task.cpuStageAcknowledged = true;
        return;
      }
      this.retire(task);
    });
    const fail = event => {
      if (this.worker !== worker) return;
      const error = new Error(event.message || 'The DXA worker failed.');
      const task = this.current;
      if (task) { task.controller.abort(); this.settle(task, error); }
      this.terminateWorker();
      if (task?.cpuStageRequestId !== undefined) task.cpuStageAcknowledged = true;
      else if (task) this.retire(task);
    };
    worker.addEventListener('error', fail); worker.addEventListener('messageerror', fail);
    return worker;
  }

  pump() {
    if (this.current || this.closed) return;
    const first = this.queue.findIndex(foreground);
    const task = this.queue.splice(first < 0 ? 0 : first, 1)[0];
    if (!task) return;
    if (task.settled) { this.pump(); return; }
    this.current = task;
    void this.dispatch(task);
  }

  async dispatch(task) {
    try {
      task.workerCount = this.requestedWorkers(task.count, task.workerCount);
      if (task.warmCode && (this.codeWarmed(task.workerCount) || !this.worker)) {
        // A completed analysis or an earlier warm-up already ran this code.
        // A replaced coordinator is prepared again by the next warmup request.
        this.settle(task, null, { ...this.ready });
        this.retire(task);
        return;
      }
      task.lease = await this.cpuBudget.acquire(task.workerCount, {
        signal: task.controller.signal, priority: task.type === 'warmup' ? -1 : 0,
      });
      if (task.settled || this.current !== task) { task.lease.release(); return; }
      task.onProgress({ phase: task.type === 'warmup' ? 'initializing' : 'preparing',
        completedAtoms: 0, totalAtoms: task.count, backend: 'cpu', workerCount: task.workerCount });
      await this.yieldToMain();
      if (task.settled || this.current !== task) { this.retire(task); return; }
      let frame;
      const transfer = [];
      if (foreground(task)) {
        const source = task.frame.fractional ?? task.frame.positions;
        const coordinates = new Float64Array(source.length);
        for (let offset = 0; offset < source.length; offset += COPY_CHUNK_VALUES) {
          coordinates.set(source.subarray ? source.subarray(offset, offset + COPY_CHUNK_VALUES) : source.slice(offset, offset + COPY_CHUNK_VALUES), offset);
          if (offset + COPY_CHUNK_VALUES < source.length) {
            await this.yieldToMain();
            if (task.settled || this.current !== task) { this.retire(task); return; }
          }
        }
        frame = { [task.frame.fractional ? 'fractional' : 'positions']: coordinates,
          cell: { vectors: Float64Array.from(task.frame.cell.vectors), origin: Float64Array.from(task.frame.cell.origin), pbc: Array.from(task.frame.cell.pbc, Boolean) } };
        transfer.push(coordinates.buffer, frame.cell.vectors.buffer, frame.cell.origin.buffer);
      }
      const mask = task.mask ? task.mask.slice() : undefined;
      if (mask) transfer.push(mask.buffer);
      const worker = this.ensureWorker();
      // Only the host clears the retained cancellation word. Resetting it in
      // the receiving Worker could erase an abort that raced with delivery.
      this.setCancellation(0);
      worker.postMessage({ id: task.id, type: task.type, frame, atomCount: task.count,
        parameters: task.parameters, memoryBudgetBytes: this.memoryBudgetBytes, workerCount: task.workerCount,
        cpuOffload: Boolean(task.cpuOffload), warmCode: Boolean(task.warmCode),
        ...(task.defectMesh ? { defectMesh: task.defectMesh } : {}), ...(mask ? { mask } : {}) }, transfer);
      task.dispatched = true;
    } catch (error) {
      if (!task.settled) this.settle(task, error);
      this.retire(task);
    }
  }

  async dispatchCpuStage(task, worker, { requestId, stage, input }) {
    if (!task.cpuOffload || task.cpuStageRequestId !== undefined) {
      task.controller.abort();
      this.settle(task, new Error('The DXA Worker sent an unexpected CPU stage request.'));
      this.terminateWorker();
      if (task.cpuStageRequestId !== undefined) task.cpuStageAcknowledged = true;
      else this.retire(task);
      return;
    }
    task.cpuStageWaiting = true;
    task.cpuStageRequestId = requestId;
    // The native coordinator is now awaiting this reply, not computing. Its
    // permit must be released before pooled jobs enter the same CPU budget.
    task.lease?.release(); task.lease = null;
    let result, error;
    try {
      if (task.settled || task.controller.signal.aborted) throw abortError();
      const method = stage === 'local' ? this.cpuStageBackend?.analyzeDxaLocal
        : stage === 'tetrahedra' ? this.cpuStageBackend?.analyzeDxaTetrahedra : undefined;
      if (typeof method !== 'function') throw new Error('The requested CPU DXA stage is unavailable.');
      // Forward one end of each stage Worker's channel to the coordinator,
      // which owns the input arrays. Nothing large passes through this thread.
      const deliverInput = port => {
        if (this.worker !== worker || task.settled) { port.close(); throw abortError(); }
        worker.postMessage({ type: 'cpu-stage-input', id: task.id, requestId, port }, [port]);
      };
      result = await method.call(this.cpuStageBackend, input, { signal: task.controller.signal, deliverInput,
        workerCount: task.stageWorkerCounts[stage], memoryBudgetBytes: this.memoryBudgetBytes, taskTimeoutMs: this.cpuStageTaskTimeoutMs,
        onProgress: progress => {
          if (task.settled) return;
          try { task.onProgress({ ...progress, backend: 'cpu', cpuStage: stage, nativeWorkerCount: task.workerCount,
            phase: stage === 'local' ? 'CPU local crystal recognition' : 'CPU interface tetrahedron classification' }); }
          catch (callbackError) { this.cancel(task, callbackError); }
        } });
      if (task.settled || task.controller.signal.aborted) throw abortError();
    } catch (caught) { error = caught; }
    if (this.worker !== worker || this.current !== task) {
      // A failed coordinator is terminated immediately, but its private jobs
      // can still be joining. Only their completion releases this frame and
      // permits the next queued frame to allocate/copy another workspace.
      task.cpuStageWaiting = false; task.cpuStageRequestId = undefined;
      this.retire(task);
      return;
    }
    if (task.cpuStageAcknowledged) {
      task.cpuStageWaiting = false; task.cpuStageRequestId = undefined;
      this.retire(task);
      return;
    }
    if (!task.settled && !task.controller.signal.aborted) {
      try {
        // Both successful import and native-stage fallback resume synchronous
        // global work only after reacquiring its computation permit.
        task.lease = await this.cpuBudget.acquire(task.workerCount, { signal: task.controller.signal });
      } catch (caught) { error = caught; }
    }
    if (this.worker !== worker || this.current !== task) {
      task.cpuStageWaiting = false; task.cpuStageRequestId = undefined;
      this.retire(task);
      return;
    }
    if (task.settled || task.controller.signal.aborted) error = abortError();
    const arrays = stage === 'local' ? [result?.structures, result?.neighbors] : [result?.regions];
    try {
      worker.postMessage({ type: 'cpu-stage-result', id: task.id, requestId,
        ...(error ? { ok: false, error: error.message || String(error), name: error.name || 'Error' } : { ok: true, result }) },
      error ? [] : [...new Set(arrays.filter(ArrayBuffer.isView).map(array => array.buffer))]);
      task.cpuStageWaiting = false;
      task.cpuStageRequestId = undefined;
    } catch (replyError) {
      task.controller.abort(); this.settle(task, replyError);
      this.terminateWorker(); this.retire(task);
    }
  }

  setCancellation(value) {
    const buffer = this.control?.cancelBuffer;
    if (!buffer || Object.prototype.toString.call(buffer) !== '[object SharedArrayBuffer]') return false;
    Atomics.store(new Int32Array(buffer, this.control.cancelPointer, 1), 0, value);
    return true;
  }

  settle(task, error, result) {
    if (task.settled) return;
    if (!error) {
      try { task.progressReporter.flush(); } catch (progressError) { error = progressError; }
      // The final progress callback can cancel this very task.
      if (task.settled) return;
    }
    task.progressReporter.close();
    task.settled = true; task.signal?.removeEventListener('abort', task.abort); this.pending.delete(task.id);
    task.frame = task.mask = null;
    if (error) task.reject(error); else task.resolve(result);
  }

  retire(task) {
    task.lease?.release(); task.lease = null;
    if (this.current === task) { this.current = null; this.pump(); }
  }

  cancel(task = this.current, error = abortError()) {
    if (!task || task.settled) return;
    this.settle(task, error); task.controller.abort();
    if (this.current === task) {
      if (!task.dispatched) { this.retire(task); return; }
      const shared = this.setCancellation(1);
      const awaitingControl = task.sharedMemory === undefined
        && this.environment.crossOriginIsolated === true && typeof this.environment.SharedArrayBuffer === 'function';
      if (task.type === 'warmup' || shared || awaitingControl || task.cpuStageWaiting) {
        if (task.type === 'warmup' || awaitingControl || task.cpuStageWaiting) this.worker?.postMessage({ type: 'cancel', id: task.id });
        // Reject/clear the UI immediately, but retain the lease until native
        // work acknowledges cancellation and every pthread has joined. If
        // initialization falls back to serial, its null control announcement
        // instead terminates the synchronous job and releases this lease.
        return;
      }
      this.terminateWorker(); this.retire(task);
    } else {
      const index = this.queue.indexOf(task); if (index >= 0) this.queue.splice(index, 1);
    }
  }

  terminateWorker() { this.worker?.terminate(); this.worker = null; this.control = null; this.ready = null; this.singleThreadOnly = false; }

  clearFrames() {
    const tasks = [...this.pending.values()]; this.queue.length = 0;
    for (const task of tasks) this.cancel(task);
    return Promise.resolve();
  }

  reset() { return this.clearFrames(); }
  release() { return this.clearFrames(); }
  close() {
    this.closed = true;
    this.clearFrames();
    this.terminateWorker();
    if (this.current) this.retire(this.current);
    return Promise.resolve();
  }
}
