import { dxaWorkerCount, preflightDxaMemory, validateDxaFrame, validateDxaParameters } from './dxa.js';
import { CpuBudget } from './cpu-budget.js';

const COPY_CHUNK_VALUES = 512 * 1024;
const abortError = () => new DOMException('The DXA calculation was cancelled.', 'AbortError');

/** One coordinator and one growable Wasm heap per client. Shared-memory jobs
 * cancel cooperatively and keep their pool; static-host jobs must terminate
 * synchronous native work. Warmups prepare modules without copying a frame.
 */
export class DxaClient {
  constructor({ workerFactory = () => new Worker(new URL('../workers/dxa-worker.js', import.meta.url), { type: 'module' }),
    memoryBudgetBytes, workerCount, environment = globalThis, cpuBudget,
    yieldToMain = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
    this.workerFactory = workerFactory;
    this.memoryBudgetBytes = memoryBudgetBytes;
    this.workerCount = workerCount;
    this.environment = environment;
    this.cpuBudget = cpuBudget ?? new CpuBudget({ environment });
    this.yieldToMain = yieldToMain;
    this.worker = null;
    this.control = null;
    this.ready = null;
    this.pending = new Map();
    this.queue = [];
    this.current = null;
    this.nextId = 1;
    this.closed = false;
  }

  get cpuWarmupStatus() { return this.ready; }

  requestedWorkers(count, requested) {
    return Math.min(this.cpuBudget.limit, dxaWorkerCount(count, requested, this.environment));
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
    return this.enqueue({ type: 'analyze', frame, parameters: settings, count, workerCount: workers, signal, onProgress });
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
      if (data.control) {
        this.control = data.control;
        if (task.settled) this.setCancellation(1);
        return;
      }
      if (data.progress) {
        if (task.settled) return;
        try { task.onProgress({ backend: 'cpu', workerCount: task.workerCount, ...data.progress }); }
        catch (error) { this.cancel(task, error); }
        return;
      }
      if (data.ok) {
        const { workerCount, poolSize, kernelGeneration, wasmMemoryBytes } = data.result;
        const threaded = data.result.threaded ?? data.result.sharedMemory;
        if (Number.isInteger(poolSize)) this.ready = { workerCount, poolSize, kernelGeneration, wasmMemoryBytes, threaded };
        this.settle(task, null, data.result);
      } else {
        const error = new Error(data.error || 'DXA calculation failed.'); error.name = data.name || 'Error';
        this.settle(task, error);
      }
      if (data.fatal) this.terminateWorker();
      this.retire(task);
    });
    const fail = event => {
      if (this.worker !== worker) return;
      const error = new Error(event.message || 'The DXA worker failed.');
      if (this.current) this.settle(this.current, error);
      this.terminateWorker();
      if (this.current) this.retire(this.current);
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
        parameters: task.parameters, memoryBudgetBytes: this.memoryBudgetBytes, workerCount: task.workerCount }, transfer);
      task.dispatched = true;
    } catch (error) {
      if (!task.settled) this.settle(task, error);
      this.retire(task);
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
      if (task.type === 'warmup' || shared || (this.environment.crossOriginIsolated && typeof this.environment.SharedArrayBuffer === 'function')) {
        // Reject/clear the UI immediately, but retain the lease until native
        // work acknowledges cancellation and every pthread has joined.
        return;
      }
      this.terminateWorker(); this.retire(task);
    } else {
      const index = this.queue.indexOf(task); if (index >= 0) this.queue.splice(index, 1);
    }
  }

  terminateWorker() { this.worker?.terminate(); this.worker = null; this.control = null; this.ready = null; }

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
