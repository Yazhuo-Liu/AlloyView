/** A persistent serializer Worker. Its last snapshot is reused across table
 * exports, so successive distribution/summary downloads do not clone the atom
 * arrays again. Source arrays are never transferred or detached. */
export class StatisticsExportClient {
  constructor({ workerFactory = () => new Worker(new URL('./workers/statistics-export-worker.js', import.meta.url), { type: 'module' }) } = {}) {
    this.workerFactory = workerFactory; this.worker = null; this.nextId = 1;
    this.pending = new Map(); this.snapshotKey = null; this.queue = Promise.resolve();
  }

  export(snapshot, snapshotKey, kind) {
    const task = this.queue.then(() => this.request('export', { kind,
      ...(this.snapshotKey === snapshotKey ? {} : { snapshot }) }, snapshotKey));
    this.queue = task.catch(() => {});
    return task;
  }

  request(type, payload, snapshotKey) {
    if (!this.worker) {
      const worker = this.workerFactory(); this.worker = worker;
      worker.addEventListener('message', event => {
        if (this.worker !== worker) return;
        const pending = this.pending.get(event.data.id);
        if (!pending) return;
        this.pending.delete(event.data.id);
        if (event.data.ok) { this.snapshotKey = pending.snapshotKey; pending.resolve(event.data.result); }
        else { this.snapshotKey = null; pending.reject(new Error(event.data.error || 'CSV export failed.')); }
      });
      worker.addEventListener('error', event => {
        if (this.worker !== worker) return;
        this.dispose(new Error(event.message || 'The statistics export Worker failed.'));
      });
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, snapshotKey });
      try { this.worker.postMessage({ id, type, payload }); }
      catch (error) { this.pending.delete(id); this.snapshotKey = null; reject(error); }
    });
  }

  /** Release copied data when the structure changes, retaining the Worker. */
  clearSnapshot() {
    const task = this.queue.then(() => {
      this.snapshotKey = null;
      return this.worker ? this.request('clear', {}, null) : null;
    });
    this.queue = task.catch(() => {});
    return task;
  }

  dispose(reason = new DOMException('Statistics export closed.', 'AbortError')) {
    this.worker?.terminate(); this.worker = null; this.snapshotKey = null;
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }
}
