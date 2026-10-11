import { cpuWorkerLimit } from '../analysis/cpu-budget.js';
import { parseFrameDescriptor } from '../workers/frame-parser.js';

const aborted = () => new DOMException('Frame parsing cancelled.', 'AbortError');

/** One foreground lane is never consumed by speculative parsing. A bounded
 * background pool retains modules between frames. Cancelling a numeric parse
 * rejects its caller immediately; the slot and CPU permit stay occupied until
 * the Worker acknowledges completion, then its result is discarded. */
export class FrameParserPool {
  constructor({ environment = globalThis, backgroundCount, acquire, promote, workerFactory } = {}) {
    this.backgroundCount = backgroundCount ?? Math.max(1, Math.min(4, cpuWorkerLimit(environment) - 1));
    this.maximumBackgroundCount = this.backgroundCount;
    this.acquire = acquire;
    this.promoteAcquire = promote;
    this.workerFactory = workerFactory ?? (typeof environment.Worker === 'function'
      ? () => new environment.Worker(new URL('../workers/frame-parser-worker.js', import.meta.url), { type: 'module' }) : null);
    this.slots = [];
    this.queue = [];
    this.nextId = 1;
    this.closed = false;
    this.promotedSignals = new WeakMap();
  }

  setAtomCount(count) {
    // Keep speculative decoded frames below approximately 128 MiB, excluding
    // the foreground frame and the app's explicit cache budget.
    this.backgroundCount = Math.max(1, Math.min(this.maximumBackgroundCount,
      Math.floor(128 * 1024 ** 2 / Math.max(1, count * 64))));
  }

  parse(descriptor, { background = false, signal, priority = background ? -20 : 20 } = {}) {
    if (this.closed || signal?.aborted) return Promise.reject(aborted());
    // Smoothing/unwrapping can enqueue more reads after a foreground join.
    // Keep their parallel background lanes but retain the promoted admission
    // priority throughout that request's lifetime.
    if (signal && this.promotedSignals.has(signal)) priority = Math.max(priority, this.promotedSignals.get(signal));
    return new Promise((resolve, reject) => {
      const task = { id: this.nextId++, descriptor, background, signal, priority, resolve, reject, controller: new AbortController() };
      task.abort = () => this.cancel(task);
      signal?.addEventListener('abort', task.abort, { once: true });
      this.queue.push(task);
      this.pump();
    });
  }

  /** A displayed-frame consumer joined an existing speculative parse. Move
   * queued work into the foreground lane, or promote its pending CPU permit;
   * never restart a parser which is already processing the frame. */
  promote(signal, priority = 20) {
    if (signal) this.promotedSignals.set(signal, Math.max(this.promotedSignals.get(signal) ?? -Infinity, priority));
    for (const task of this.queue) if (task.signal === signal) {
      task.background = false; task.priority = Math.max(task.priority, priority);
    }
    for (const slot of this.slots) {
      const task = slot.task;
      if (task?.signal !== signal) continue;
      task.background = false; task.priority = Math.max(task.priority, priority);
      if (!task.started) this.promoteAcquire?.({ signal: task.controller.signal, priority: task.priority });
    }
    this.queue.sort((first, second) => second.priority - first.priority);
    this.pump();
  }

  pump() {
    if (this.closed) return;
    for (const background of [false, true]) {
      const capacity = background ? this.backgroundCount : 1;
      while (this.queue.some(task => task.background === background)) {
        if (this.slots.filter(current => current.background === background && current.task).length >= capacity) break;
        let slot = this.slots.find(current => current.background === background && !current.task);
        if (!slot) {
          if (this.slots.filter(current => current.background === background).length >= capacity) break;
          slot = { background, worker: null, task: null };
          this.slots.push(slot);
        }
        const index = this.queue.findIndex(task => task.background === background);
        const [task] = this.queue.splice(index, 1);
        slot.task = task;
        task.slot = slot;
        void this.run(slot, task);
      }
    }
  }

  async run(slot, task) {
    try {
      task.lease = await this.acquire?.({ background: task.background, signal: task.controller.signal, priority: task.priority });
      if (task.controller.signal.aborted || slot.task !== task) { task.lease?.release(); return; }
      if (!this.workerFactory) {
        const frame = await parseFrameDescriptor(task.descriptor);
        this.finish(slot, task, null, frame);
        return;
      }
      if (!slot.worker) {
        const worker = this.workerFactory();
        slot.worker = worker;
        worker.addEventListener('message', ({ data }) => {
          const current = slot.task;
          if (worker !== slot.worker || !current || data.id !== current.id) return;
          const error = data.ok ? null : Object.assign(new Error(data.error), { name: data.name ?? 'Error' });
          this.finish(slot, current, error, data.frame);
        });
        worker.addEventListener('error', event => {
          if (worker !== slot.worker) return;
          worker.terminate(); slot.worker = null;
          if (slot.task) this.finish(slot, slot.task, new Error(event.message || 'Frame parser failed.'));
        });
      }
      task.started = true;
      slot.worker.postMessage({ id: task.id, descriptor: task.descriptor });
    } catch (error) {
      if (slot.task === task) this.finish(slot, task, error);
    }
  }

  finish(slot, task, error, frame) {
    if (slot.task !== task) return;
    slot.task = null;
    task.signal?.removeEventListener('abort', task.abort);
    task.lease?.release();
    if (!task.cancelled) {
      if (error) task.reject(error); else task.resolve(frame);
    }
    this.pump();
  }

  cancel(task) {
    task.controller.abort();
    const queued = this.queue.indexOf(task);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      task.signal?.removeEventListener('abort', task.abort);
      task.reject(aborted());
      return;
    }
    const slot = task.slot;
    if (slot?.task !== task) return;
    if (task.started && slot.worker) {
      // Keep the reusable Worker and its permit: releasing a permit before
      // the synchronous parse finishes would oversubscribe the CPU budget.
      task.cancelled = true;
      task.signal?.removeEventListener('abort', task.abort);
      task.reject(aborted());
      slot.worker.postMessage({ id: task.id, type: 'cancel-parser' });
      return;
    }
    this.finish(slot, task, aborted());
  }

  close() {
    this.closed = true;
    for (const task of [...this.queue]) this.cancel(task);
    for (const slot of this.slots) {
      if (slot.task) {
        const task = slot.task;
        this.cancel(task);
        if (slot.task === task) this.finish(slot, task, aborted());
      }
      slot.worker?.terminate();
    }
    this.slots = [];
  }
}
