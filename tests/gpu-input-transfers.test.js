import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';
import { crystalFrame } from './helpers/crystals.js';

class WorkerFixture {
  constructor() { this.listeners = new Map(); this.messages = []; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  postMessage(data, transfer = []) { this.messages.push(structuredClone(data, { transfer })); }
  terminate() {}
  answer(message) { this.listeners.get('message')({ data: { id: message.id, ok: true, result: { engine: 'webgpu' }, cachedFrameIds: [message.frameId] } }); }
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error('GPU task was not dispatched.');
}

test('cached GPU strain transfers private PTM tensor inputs while retaining frame and complete CPU fit caches', async () => {
  const worker = new WorkerFixture(), client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  const frame = crystalFrame('fcc', 2), count = frame.types.length;
  const ptmInput = { structures: new Uint8Array(count).fill(1), scales: new Float64Array(count).fill(2.823456789),
    deformation: Float64Array.from({ length: count * 9 }, (_, index) => index % 4 ? .00000000314159 : 1),
    rmsd: new Float32Array(count).fill(.01), distances: new Float32Array(count).fill(2.8) };
  const originals = Object.fromEntries(Object.entries(ptmInput).map(([name, values]) => [name, values.slice()]));
  const fractional = frame.fractional.slice();
  try {
    const warm = client.analyze(frame, { kind: 'bonds', cutoff: 3.1 });
    await until(() => worker.messages.length === 1); worker.answer(worker.messages[0]); await warm;
    const strain = client.analyze(frame, { kind: 'strain', ptmInput });
    await until(() => worker.messages.length === 2);
    const message = worker.messages[1];
    assert.equal(message.frame, undefined, 'the GPU frame upload is reused');
    assert.deepEqual(Object.keys(message.parameters.ptmInput), ['structures', 'scales', 'deformation']);
    for (const name of ['structures', 'scales', 'deformation']) {
      assert.equal(message.parameters.ptmInput[name].constructor, ptmInput[name].constructor);
      assert.deepEqual(message.parameters.ptmInput[name], originals[name]);
    }
    for (const [name, values] of Object.entries(ptmInput)) assert.deepEqual(values, originals[name], `${name} is retained for CPU reuse`);
    assert.deepEqual(frame.fractional, fractional);
    worker.answer(message); await strain;
  } finally { client.close(); }
});

test('invalid cached GPU tensor inputs fail dispatch without sending a partial job or detaching the frame', async () => {
  const worker = new WorkerFixture(), client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  const frame = crystalFrame('fcc', 1), original = frame.fractional.slice();
  try {
    await assert.rejects(client.analyze(frame, { kind: 'strain', ptmInput: { structures: new Uint8Array(4), scales: [2, 2, 2, 2] } }), /typed PTM scales/);
    assert.equal(worker.messages.length, 0); assert.deepEqual(frame.fractional, original);
  } finally { client.close(); }
});
