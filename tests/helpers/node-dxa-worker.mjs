import { parentPort } from 'node:worker_threads';

// Runs the browser DXA Worker (dislocations and surface meshes) in a Node thread.
globalThis.self = {
  addEventListener: (name, listener) => parentPort.on(name, (data) => listener({ data })),
  postMessage: (data, transferables) => parentPort.postMessage(data, transferables),
};
await import('../../src/workers/dxa-worker.js');
