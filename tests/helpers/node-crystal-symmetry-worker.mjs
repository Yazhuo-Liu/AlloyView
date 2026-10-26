import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { warmCrystalSymmetry } from '../../src/analysis/crystal-symmetry.js';

await warmCrystalSymmetry({ wasmBinary: readFileSync(new URL('../../src/crystal/vendor/moyo/moyo_wasm_bg.wasm', import.meta.url)) });
globalThis.self = {
  addEventListener(type, listener) { if (type === 'message') parentPort.on('message', data => listener({ data })); },
  postMessage(message, transfer) { parentPort.postMessage(message, transfer); },
};
await import('../../src/workers/crystal-symmetry-worker.js');
