import { parentPort } from 'node:worker_threads';

globalThis.self = {
  addEventListener(type, listener) {
    if (type === 'message') parentPort.on('message', data => listener({ data }));
  },
  postMessage(message, transfer) { parentPort.postMessage(message, transfer); },
};
await import('../../src/workers/structure-export-worker.js');
