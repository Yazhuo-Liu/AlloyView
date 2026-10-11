import { parentPort } from 'node:worker_threads';
globalThis.self = {
  addEventListener: (name, listener) => parentPort.on(name, data => listener({ data })),
  postMessage: (data, transfer) => parentPort.postMessage(data, transfer),
};
await import('../../src/workers/surface-geometry-worker.js');
