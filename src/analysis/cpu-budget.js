const abortError = () => new DOMException('CPU preparation or calculation was cancelled.', 'AbortError');

/** hardwareConcurrency is the browser's available logical processor count.
 * This limits application concurrency; it does not pin or reserve OS cores.
 */
export function cpuWorkerLimit(environment = globalThis) {
  const reported = Number(environment.navigator?.hardwareConcurrency);
  const cores = Number.isFinite(reported) && reported >= 1 ? Math.floor(reported) : 2;
  return Math.max(1, cores - 2);
}

/** A single weighted budget for ordinary atom-range Workers and whole-frame
 * DXA threads. Idle prewarmed Workers hold no permit. Foreground jobs precede
 * queued background warmups; equal-priority requests keep FIFO ordering.
 */
export class CpuBudget {
  constructor({ environment = globalThis } = {}) {
    this.limit = cpuWorkerLimit(environment);
    this.active = 0;
    this.queue = [];
    this.backgroundDeferrals = new Set();
  }

  /** Foreground input preparation must enter admission before its asynchronous
   * snapshot copy finishes. A deferral consumes no computation permit and
   * only holds queued background jobs; other foreground work can proceed. */
  deferBackground({ signal } = {}) {
    const token = {};
    let released = false;
    const release = () => {
      if (released) return;
      released = true; signal?.removeEventListener('abort', release);
      this.backgroundDeferrals.delete(token); this.pump();
    };
    if (signal?.aborted) { released = true; return release; }
    this.backgroundDeferrals.add(token); signal?.addEventListener('abort', release, { once: true });
    return release;
  }

  /** A foreground subscriber can join a shared index preparation which was
   * originally queued by prefetch. Promote that useful dependency instead of
   * blocking behind its own background deferral or building a second index. */
  promote(signal, priority = 0) {
    for (const request of this.queue) if (request.signal === signal) request.priority = Math.max(request.priority, priority);
    this.queue.sort((first, second) => second.priority - first.priority);
    this.pump();
  }

  acquire(count = 1, { signal, priority = 0 } = {}) {
    if (!Number.isInteger(count) || count < 1 || count > this.limit) {
      return Promise.reject(new Error(`CPU work must request between 1 and ${this.limit} computation threads.`));
    }
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const request = { count, signal, priority, resolve, reject };
      request.abort = () => {
        const index = this.queue.indexOf(request);
        if (index < 0) return;
        this.queue.splice(index, 1);
        signal.removeEventListener('abort', request.abort);
        reject(abortError());
        this.pump();
      };
      signal?.addEventListener('abort', request.abort, { once: true });
      const index = this.queue.findIndex(queued => queued.priority < priority);
      if (index < 0) this.queue.push(request); else this.queue.splice(index, 0, request);
      this.pump();
    });
  }

  pump() {
    while (this.queue.length) {
      const request = this.queue[0];
      if (request.priority < 0 && this.backgroundDeferrals.size) break;
      // Do not let a stream of one-thread jobs starve a waiting DXA batch.
      if (this.active + request.count > this.limit) break;
      this.queue.shift();
      request.signal?.removeEventListener('abort', request.abort);
      this.active += request.count;
      let released = false;
      request.resolve({ count: request.count, release: () => {
        if (released) return;
        released = true;
        this.active -= request.count;
        this.pump();
      } });
    }
  }
}
