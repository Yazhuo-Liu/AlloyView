import { crc32 } from '../io/export-archive.js';

export const PNG_ENCODE_QUEUE = 2;
const cancelled = () => new DOMException('The image export was cancelled.', 'AbortError');

/** Export-scoped encoder. Retain at most two original canvases until their
 * results arrive so a blocked/unsupported/crashed Worker can retry the exact
 * snapshot on the page. dispose() releases the Worker on every exit path. */
export class PngFrameEncoder {
  constructor({ signal = null,
    createWorker = typeof Worker === 'function' ? () => new Worker(new URL('../workers/png-encoder-worker.js', import.meta.url), { type: 'module' }) : null,
    createBitmap = globalThis.createImageBitmap?.bind(globalThis),
    offscreenAvailable = typeof OffscreenCanvas === 'function' && typeof OffscreenCanvas.prototype.convertToBlob === 'function',
  } = {}) {
    this.createWorker = offscreenAvailable && createBitmap ? createWorker : null;
    this.createBitmap = createBitmap;
    this.signal = signal; this.worker = null; this.pending = new Map(); this.nextId = 0; this.disposed = false;
    this.abort = () => this.dispose();
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.dispose();
  }

  encode(canvas) {
    if (this.disposed) return Promise.reject(cancelled());
    if (this.pending.size >= PNG_ENCODE_QUEUE) return Promise.reject(new Error('The PNG encoding queue is full.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const job = { id, canvas, resolve, reject, fallback: false };
      this.pending.set(id, job);
      if (!this.createWorker) { void this.encodeFallback(job); return; }
      try {
        if (!this.worker) {
          const worker = this.worker = this.createWorker();
          worker.onmessage = ({ data }) => {
            if (this.worker !== worker || !this.pending.has(data.id)) return;
            if (data.error || !(data.blob instanceof Blob) || !Number.isInteger(data.crc) || data.crc < 0 || data.crc > 0xffffffff) {
              this.disableWorker(); return;
            }
            this.finish(this.pending.get(data.id), { blob: data.blob, crc: data.crc });
          };
          worker.onerror = event => { event?.preventDefault?.(); if (this.worker === worker) this.disableWorker(); };
          worker.onmessageerror = () => { if (this.worker === worker) this.disableWorker(); };
        }
        const worker = this.worker;
        Promise.resolve(this.createBitmap(canvas)).then(bitmap => {
          if (this.disposed || this.worker !== worker || !this.pending.has(id)) { bitmap.close(); return; }
          try { worker.postMessage({ id, bitmap }, [bitmap]); }
          catch { bitmap.close(); this.disableWorker(); }
        }, () => { if (this.pending.has(id)) this.disableWorker(); });
      } catch { this.disableWorker(); }
    });
  }

  finish(job, result, error = null) {
    if (!this.pending.delete(job.id)) return;
    job.canvas = null;
    if (error) job.reject(error); else job.resolve(result);
  }

  disableWorker() {
    this.createWorker = null;
    this.stopWorker();
    for (const job of this.pending.values()) void this.encodeFallback(job);
  }

  async encodeFallback(job) {
    if (job.fallback || !this.pending.has(job.id)) return;
    job.fallback = true;
    try {
      const blob = await new Promise((resolve, reject) => job.canvas.toBlob(
        value => value ? resolve(value) : reject(new Error('Could not encode the image.')), 'image/png'));
      if (!this.pending.has(job.id)) return;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!this.pending.has(job.id)) return;
      this.finish(job, { blob, crc: crc32(bytes) });
    } catch (error) { this.finish(job, null, error); }
  }

  stopWorker() {
    const worker = this.worker; this.worker = null;
    if (worker) { worker.onmessage = worker.onerror = worker.onmessageerror = null; worker.terminate(); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.signal?.removeEventListener('abort', this.abort);
    this.stopWorker();
    for (const job of this.pending.values()) this.finish(job, null, cancelled());
  }
}
