const cancelled = () => new DOMException('Frame request cancelled.', 'AbortError');

/** Share an in-flight read/processing operation, not its callers' lifetime.
 * Each consumer owns its own AbortSignal. The immutable request identity must
 * include the source and every setting which changes the returned frame. */
export class SharedFrameRequests {
  constructor() { this.entries = new Map(); }

  join(key, { signal, background = false, speculative = false, cacheFrame = false } = {}, start) {
    if (signal?.aborted) return Promise.reject(cancelled());
    let entry = this.entries.get(key);
    const fresh = !entry;
    if (fresh) {
      entry = { key, controller: new AbortController(), consumers: new Set(), background,
        cacheFrame, promote: null, settled: false };
      this.entries.set(key, entry);
    }
    entry.cacheFrame ||= cacheFrame;
    const foregroundJoin = entry.background && !background;
    if (foregroundJoin) entry.background = false;
    const result = new Promise((resolve, reject) => {
      const consumer = { signal, speculative, resolve, reject };
      consumer.abort = () => this.cancelConsumer(entry, consumer);
      entry.consumers.add(consumer);
      signal?.addEventListener('abort', consumer.abort, { once: true });
    });
    if (fresh) {
      // Start only after the first consumer is registered: synchronous startup
      // failures and aborts must settle that consumer as well.
      try { Promise.resolve(start(entry)).then(value => this.finish(entry, null, value), error => this.finish(entry, error)); }
      catch (error) { this.finish(entry, error); }
    } else if (foregroundJoin) entry.promote?.();
    return result;
  }

  cancelConsumer(entry, consumer) {
    if (!entry.consumers.delete(consumer)) return;
    consumer.signal?.removeEventListener('abort', consumer.abort);
    consumer.reject(cancelled());
    if (!entry.consumers.size && !entry.settled) {
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      entry.controller.abort();
    }
  }

  finish(entry, error, value) {
    entry.settled = true;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    for (const consumer of entry.consumers) {
      consumer.signal?.removeEventListener('abort', consumer.abort);
      if (error) consumer.reject(error); else consumer.resolve(value);
    }
    entry.consumers.clear();
  }

  cancelSpeculative({ keepKeys = new Set() } = {}) {
    for (const entry of this.entries.values()) {
      if (keepKeys.has(entry.key)) continue;
      for (const consumer of [...entry.consumers]) if (consumer.speculative) this.cancelConsumer(entry, consumer);
    }
  }

  clear() {
    for (const entry of [...this.entries.values()]) {
      for (const consumer of [...entry.consumers]) this.cancelConsumer(entry, consumer);
    }
  }
}
