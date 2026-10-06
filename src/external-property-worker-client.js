/** One Worker retains local files' parsed columns for the current structure. */
export class ExternalPropertyWorkerClient {
  constructor() { this.worker = null; this.pending = new Map(); this.nextId = 1; }

  request(type, payload) {
    if (!this.worker) {
      const worker = new Worker(new URL('./workers/external-property-worker.js', import.meta.url), { type: 'module' });
      this.worker = worker;
      worker.addEventListener('message', event => {
        if (this.worker !== worker) return;
        const pending = this.pending.get(event.data.id);
        if (!pending) return;
        this.pending.delete(event.data.id);
        if (event.data.ok) pending.resolve(event.data.result);
        else pending.reject(new Error(event.data.error));
      });
      worker.addEventListener('error', event => {
        if (this.worker !== worker) return;
        for (const pending of this.pending.values()) pending.reject(new Error(event.message || 'External attribute Worker failed.'));
        this.pending.clear(); worker.terminate(); this.worker = null;
      });
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // The frame IDs are cloned, never transferred or detached. Structure and
      // analysis Workers can continue using their existing coordinate arrays.
      try { this.worker.postMessage({ id, type, payload }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  reset() {
    this.worker?.terminate(); this.worker = null;
    for (const pending of this.pending.values()) pending.reject(new DOMException('External attributes closed.', 'AbortError'));
    this.pending.clear();
  }
}
