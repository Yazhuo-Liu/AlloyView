import test from 'node:test';
import assert from 'node:assert/strict';
import { crystalFrame } from './helpers/crystals.js';
import { fakeGpu } from './helpers/fake-gpu.js';

// The GPU worker module registers its message listener on `self` at import.
const replies = [];
let deliver;
const fake = fakeGpu();
Object.defineProperty(globalThis, 'navigator', { value: { gpu: fake.gpu }, configurable: true });
globalThis.self = { addEventListener(type, listener) { if (type === 'message') deliver = listener; }, postMessage(data) { replies.push(data); } };
await import('../src/analysis/gpu/worker.js');

const post = data => deliver({ data });
async function reply(id) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const found = replies.find(message => message.id === id && !message.progress);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(`No GPU worker reply for task ${id}.`);
}
const payload = (frame, gpuFrameId) => ({ fractional: frame.fractional.slice(), types: frame.types.slice(), typeLabels: frame.typeLabels,
  cell: frame.cell, gpuFrameId });

test('a task posted behind running work keeps its resident input when the running task evicts it', async () => {
  const first = crystalFrame('fcc', 4), second = crystalFrame('fcc', 4, 4.1), frameBytes = first.types.length * 36;
  // Room for one resident frame beside the 32 MiB calculation reserve.
  post({ type: 'configure-cache', id: 1, options: { frameCount: 2, currentIndex: 0, budgetBytes: 32 * 1024 ** 2 + frameBytes * 1.5 } });
  post({ type: 'analyze', id: 2, frameId: 11, frameIndex: 0, frame: payload(first, 11), parameters: { kind: 'coordination', cutoff: 3 } });
  assert.equal((await reply(2)).ok, true);
  assert.deepEqual((await reply(2)).cachedFrameIds, [11]);
  // The client posts the third task without a payload while the second runs.
  post({ type: 'analyze', id: 3, frameId: 12, frameIndex: 1, frame: payload(second, 12), parameters: { kind: 'coordination', cutoff: 3 } });
  post({ type: 'analyze', id: 4, frameId: 11, frameIndex: 0, parameters: { kind: 'coordination', cutoff: 3 } });
  const evicting = await reply(3), resident = await reply(4);
  assert.equal(evicting.ok, true); assert.deepEqual(evicting.cachedFrameIds, [12], 'the second upload evicted the first frame');
  assert.equal(resident.ok, true, resident.error);
  assert.equal(resident.result.inputReused, true); assert.equal(resident.result.gpuInputReused, false, 'the retained input was uploaded again');
  assert.deepEqual(resident.cachedFrameIds, [11]);
  // An evicted input that no received task references is released when the
  // next task starts; a later payload-free request must then be retried.
  post({ type: 'configure-cache', id: 5, options: { currentIndex: 0 } });
  assert.deepEqual((await reply(5)).cachedFrameIds, [11]);
  post({ type: 'analyze', id: 6, frameId: 12, frameIndex: 1, parameters: { kind: 'coordination', cutoff: 3 } });
  const released = await reply(6);
  assert.equal(released.ok, false); assert.match(released.error, /frame cache was released/);
  post({ type: 'clear-frames', id: 7 });
  assert.deepEqual((await reply(7)).cachedFrameIds, []);
});
