import { normalizeLocalFiles } from './io/local-files.js';

export class StructureWorkerClient {
  constructor(onProgress = () => {}) {
    this.worker = new Worker(new URL('./workers/structure-worker.js', import.meta.url), { type: 'module' });
    this.onProgress = onProgress;
    this.nextId = 1;
    this.pending = new Map();
    this.worker.addEventListener('message', (event) => this.handleMessage(event.data));
    this.worker.addEventListener('error', (event) => {
      for (const { reject } of this.pending.values()) reject(new Error(event.message || 'The Worker failed.'));
      this.pending.clear();
    });
  }

  request(type, payload, { reportProgress = true } = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, reportProgress });
      try {
        this.worker.postMessage({ id, type, payload });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  load(input) {
    const files = normalizeLocalFiles(input);
    // Retain the single-file field for a previously cached Worker version.
    return this.request('load', { files, file: files.length === 1 ? files[0] : undefined });
  }
  frame(index, { reportProgress = true } = {}) {
    return this.request('frame', { index }, { reportProgress });
  }
  coordination(frame, cutoff) {
    return this.request('analyze-coordination', {
      fractional: frame.fractional,
      cell: frame.cell,
      cutoff,
    });
  }

  handleMessage(message) {
    if (message.event === 'progress') {
      const pending = this.pending.get(message.id);
      if (pending?.reportProgress) this.onProgress(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error));
  }

  close() {
    this.worker.terminate();
    this.pending.clear();
  }
}
