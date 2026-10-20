import { ImageArchiveBuilder } from '../io/export-archive.js';
import { PngFrameEncoder, PNG_ENCODE_QUEUE } from './png-frame-encoder.js';

const cancelled = () => new DOMException('The image export was cancelled.', 'AbortError');

/** A two-frame pipeline shared by trajectory images and movie PNG sequences.
 * Encoding may finish out of order; ZIP records always follow capture order.
 * Await add() before capturing another image, then await finish(). */
export class PngArchiveQueue {
  constructor({ signal = null, encode = null, release = canvas => { canvas.width = canvas.height = 1; },
    checkCurrent = () => {}, onEncoded = () => {}, maxBytes } = {}) {
    this.archive = new ImageArchiveBuilder(maxBytes === undefined ? {} : { maxBytes });
    this.controller = new AbortController(); this.signal = this.controller.signal;
    this.parentSignal = signal; this.abort = () => this.controller.abort();
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
    this.release = release; this.checkCurrent = checkCurrent; this.onEncoded = onEncoded;
    this.encoder = encode ? null : new PngFrameEncoder({ signal: this.signal });
    this.encode = encode ?? (canvas => this.encoder.encode(canvas));
    this.pending = []; this.bytes = 0; this.disposed = false;
  }

  get count() { return this.archive.count; }

  check() {
    if (this.disposed || this.signal?.aborted) throw cancelled();
    this.checkCurrent();
  }

  async add(canvas, name) {
    let released = false;
    const release = () => { if (!released) { released = true; this.release(canvas); } };
    try {
      this.check();
      if (this.pending.length >= PNG_ENCODE_QUEUE) throw new Error('Await the PNG encoding queue before capturing another image.');
    } catch (error) { release(); throw error; }
    // Consume both fulfillment and rejection immediately: a later frame can
    // fail before the oldest has completed without an unhandled rejection.
    const completion = Promise.resolve().then(() => { this.check(); return this.encode(canvas, { signal: this.signal }); })
      .then(value => ({ value }), error => ({ error })).finally(release);
    this.pending.push({ name, completion, release });
    if (this.pending.length >= PNG_ENCODE_QUEUE) await this.commitNext();
  }

  async commitNext() {
    this.check();
    const job = this.pending[0];
    let stop;
    try {
      const aborted = new Promise((resolve, reject) => {
        stop = () => reject(cancelled());
        this.signal?.addEventListener('abort', stop, { once: true });
      });
      const { value, error } = await Promise.race([job.completion, aborted]);
      this.check();
      if (error) throw error;
      const entry = value instanceof Uint8Array ? { bytes: value } : value;
      this.archive.add({ ...entry, name: job.name }, { signal: this.signal });
      this.bytes += entry.blob?.size ?? entry.bytes.length;
      this.pending.shift();
      this.onEncoded({ count: this.count, bytes: this.bytes });
    } finally { this.signal?.removeEventListener('abort', stop); }
  }

  async finish() {
    while (this.pending.length) await this.commitNext();
    this.check();
    return this.archive.finish({ signal: this.signal });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.controller.abort(); this.encoder?.dispose();
    this.parentSignal?.removeEventListener('abort', this.abort);
    for (const job of this.pending) job.release();
    this.pending.length = 0;
    this.archive.clear();
  }
}
