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

  request(type, payload) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  load(file) { return this.request('load', { file }); }
  frame(index) { return this.request('frame', { index }); }
  coordination(frame, cutoff) {
    return this.request('analyze-coordination', {
      fractional: frame.fractional,
      cell: frame.cell,
      cutoff,
    });
  }

  handleMessage(message) {
    if (message.event === 'progress') {
      this.onProgress(message);
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
