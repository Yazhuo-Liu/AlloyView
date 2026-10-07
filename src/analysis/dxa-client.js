import { dxaWorkerCount, preflightDxaMemory, validateDxaFrame, validateDxaParameters } from './dxa.js';
import { CpuBudget } from './cpu-budget.js';

const COPY_CHUNK_VALUES = 512 * 1024;
const DEFAULT_PRIVATE_STAGE_MAX_WORKERS = 4;
const abortError = () => new DOMException('The DXA calculation was cancelled.', 'AbortError');

/** One coordinator and one growable Wasm heap per client. Shared-memory jobs
 * cancel cooperatively and keep their pool; static-host jobs must terminate
 * synchronous native work. Warmups prepare modules without copying a frame.
 */
export class DxaClient {
  constructor({ workerFactory = () => new Worker(new URL('../workers/dxa-worker.js', import.meta.url), { type: 'module' }),
    memoryBudgetBytes, workerCount, environment = globalThis, cpuBudget,
    cpuStageBackend, cpuStageTaskTimeoutMs,
    yieldToMain = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
    this.workerFactory = workerFactory;
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
    if (this.worker && this.ready && this.ready.poolSize >= count - 1) {
      return Promise.resolve({ ...this.ready, workerCount: count });
    }
    const prepared = [this.current, ...this.queue].find(task => task?.type === 'warmup' && !task.settled && task.workerCount >= count);
    if (prepared && prepared.signal === signal) return prepared.promise;
    return this.enqueue({ type: 'warmup', count: atomCount, workerCount: count, signal, onProgress });
  }

  analyze(frame, parameters = {}, { signal, onProgress = () => {}, workerCount = this.workerCount } = {}) {
    if (signal?.aborted || this.closed) return Promise.reject(abortError());
    let settings, count, workers;
    try {
      settings = validateDxaParameters(parameters);
      count = validateDxaFrame(frame, { validateCoordinates: false });
      preflightDxaMemory(count, this.memoryBudgetBytes);
      workers = this.requestedWorkers(count, workerCount);
    } catch (error) { return Promise.reject(error); }
    // Private Workers duplicate the full stage geometry. Growing too many
    // local-recognition heaps can leave no room for the later tetrahedron
    // snapshot, even after their local inputs are released. Keep automatic
    // degree modest; explicit requests still use the per-stage memory caps.
    const stageWorkerCount = Math.min(this.cpuBudget.limit,
      workerCount ?? Math.min(DEFAULT_PRIVATE_STAGE_MAX_WORKERS, Math.ceil(count / 4096)));
    const cpuOffload = this.environment.crossOriginIsolated !== true && count >= 8192 && stageWorkerCount > 1
      && typeof this.cpuStageBackend?.analyzeDxaLocal === 'function' && typeof this.cpuStageBackend?.analyzeDxaTetrahedra === 'function';
    return this.enqueue({ type: 'analyze', frame, parameters: settings, count, workerCount: workers,
      stageWorkerCount, cpuOffload, signal, onProgress });
  }

  enqueue(values) {
    const task = { id: this.nextId++, ...values, controller: new AbortController(), settled: false, dispatched: false };
    task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
    task.abort = () => this.cancel(task);
    task.signal?.addEventListener('abort', task.abort, { once: true });
    this.pending.set(task.id, task); this.queue.push(task);
    if (task.type === 'analyze' && this.current?.type === 'warmup' && !this.current.settled) this.cancel(this.current);
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
          else if (task.type === 'analyze' && !task.cpuStageWaiting) { this.terminateWorker(); this.retire(task); }
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
        const { workerCount, poolSize, kernelGeneration, wasmMemoryBytes, threadingFallback, sharedMemory } = data.result;
        if (threadingFallback || sharedMemory === false) this.singleThreadOnly = true;
        const threaded = data.result.threaded ?? data.result.sharedMemory;
        if (Number.isInteger(poolSize)) this.ready = { workerCount, poolSize, kernelGeneration, wasmMemoryBytes, threaded, sharedMemory, threadingFallback };
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
    const foreground = this.queue.findIndex(task => task.type === 'analyze');
    const task = this.queue.splice(foreground < 0 ? 0 : foreground, 1)[0];
    if (!task) return;
    if (task.settled) { this.pump(); return; }
    this.current = task;
    void this.dispatch(task);
  }

  async dispatch(task) {
    try {
      task.workerCount = this.requestedWorkers(task.count, task.workerCount);
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
      if (task.type === 'analyze') {
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
      const worker = this.ensureWorker();
      // Only the host clears the retained cancellation word. Resetting it in
      // the receiving Worker could erase an abort that raced with delivery.
      this.setCancellation(0);
      worker.postMessage({ id: task.id, type: task.type, frame, atomCount: task.count,
        parameters: task.parameters, memoryBudgetBytes: this.memoryBudgetBytes, workerCount: task.workerCount,
        cpuOffload: Boolean(task.cpuOffload) }, transfer);
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
      result = await method.call(this.cpuStageBackend, input, { signal: task.controller.signal,
        workerCount: task.stageWorkerCount, memoryBudgetBytes: this.memoryBudgetBytes, taskTimeoutMs: this.cpuStageTaskTimeoutMs,
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
    task.settled = true; task.signal?.removeEventListener('abort', task.abort); this.pending.delete(task.id);
    task.frame = null;
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
