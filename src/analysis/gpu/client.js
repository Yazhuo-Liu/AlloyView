const SUPPORTED_KINDS = new Set(['coordination', 'rdf', 'localShear']);
const COPY_CHUNK_BYTES = 4 * 1024 ** 2;

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
    this.nextFrameId = 1;
    this.cachedFrameIds = new Set();
    this.closed = false;
  }

  supports(kind) { return SUPPORTED_KINDS.has(kind); }

  analyze(frame, parameters, { signal, onProgress = () => {} } = {}) {
    if (signal?.aborted || this.closed) return Promise.reject(abortError());
    if (!this.environment.navigator?.gpu) return Promise.reject(new Error('WebGPU is unavailable in this browser or context.'));
    if (!this.supports(parameters.kind)) return Promise.reject(new Error(`The ${parameters.kind} analysis uses CPU workers.`));
    return new Promise((resolve, reject) => {
      const task = { id: this.nextId++, frame, parameters, signal, onProgress, resolve, reject, settled: false };
      task.abort = () => {
        this.settle(task, abortError());
        if (this.current === task) this.worker?.postMessage({ type: 'cancel', id: task.id });
        else { const index = this.queue.indexOf(task); if (index >= 0) this.queue.splice(index, 1); }
      };
      signal?.addEventListener('abort', task.abort, { once: true });
      this.pending.set(task.id, task); this.queue.push(task); this.pump();
    });
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
      this.cachedFrameIds = new Set(data.cachedFrameIds ?? []);
      if (data.ok) this.settle(task, null, data.result);
      else { const error = new Error(data.error || 'GPU analysis failed.'); error.name = data.name || 'Error'; this.settle(task, error); }
      if (this.current === task) { this.current = null; this.pump(); }
    });
    const fail = (event) => {
      if (this.worker !== worker) return;
      const error = new Error(event.message || 'The GPU analysis worker failed.');
      if (this.current) this.settle(this.current, error);
      this.worker?.terminate(); this.worker = null; this.current = null; this.cachedFrameIds.clear(); this.pump();
    };
    this.worker.addEventListener('error', fail);
    this.worker.addEventListener('messageerror', fail);
  }

  pump() {
    if (this.current || this.closed) return;
    const task = this.queue.shift();
    if (!task) return;
    if (task.settled) { this.pump(); return; }
    this.current = task;
    void this.dispatch(task);
  }

  async dispatch(task) {
    try {
      this.ensureWorker();
      const worker = this.worker;
      task.onProgress({ backend: 'gpu', phase: 'preparing', completedAtoms: 0, totalAtoms: task.frame.fractional.length / 3, workerCount: 1 });
      await yieldToMain();
      if (task.settled) { if (this.current === task) { this.current = null; this.pump(); } return; }
      let frameId = this.frameIds.get(task.frame);
      if (!frameId) { frameId = this.nextFrameId++; this.frameIds.set(task.frame, frameId); }
      let frame;
      const transfer = [];
      if (!this.cachedFrameIds.has(frameId)) {
        const fractional = await copyArray(task.frame.fractional, task);
        const types = task.frame.types ? await copyArray(task.frame.types, task) : undefined;
        frame = { fractional, types, cell: task.frame.cell, gpuFrameId: frameId };
        transfer.push(fractional.buffer);
        if (types) transfer.push(types.buffer);
      }
      if (task.settled) { if (this.current === task) { this.current = null; this.pump(); } return; }
      if (this.worker !== worker) throw abortError();
      worker.postMessage({ type: 'analyze', id: task.id, frameId, frame, parameters: task.parameters }, transfer);
    } catch (error) { this.settle(task, error); if (this.current === task) { this.current = null; this.pump(); } }
  }

  settle(task, error, result) {
    if (task.settled) return;
    task.settled = true; task.signal?.removeEventListener('abort', task.abort); this.pending.delete(task.id);
    if (error) task.reject(error); else task.resolve(result);
  }

  release() {
    for (const task of this.pending.values()) this.settle(task, abortError());
    this.queue.length = 0; this.worker?.terminate(); this.worker = null; this.current = null; this.cachedFrameIds.clear();
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
function yieldToMain() { return new Promise((resolve) => setTimeout(resolve, 0)); }
function abortError() { return new DOMException('Analysis cancelled.', 'AbortError'); }
