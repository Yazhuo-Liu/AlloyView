import { parentPort } from 'node:worker_threads';

globalThis.self = {
  addEventListener: (name, listener) => parentPort.on(name, (data) => listener({ data })),
  postMessage: (data, transferables) => parentPort.postMessage(data, transferables),
};
await import('../../src/workers/binning-worker.js');
