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


test('background GPU uploads shed host payloads immediately and a foreground return restores only CPU input', async () => {
  const frame = crystalFrame('fcc', 4);
  post({ type: 'configure-cache', id: 20, options: { frameCount: 160, currentIndex: 80, budgetBytes: 2 * 1024 ** 3 } });
  await reply(20);
  for (const [offset, index] of [80, 81, 79, 82, 78].entries()) {
    post({ type: 'prepare-frame', id: 21 + offset, frameId: 1000 + index, frameIndex: index, frame: payload(frame, 1000 + index) });
    const response = await reply(21 + offset);
    assert.equal(response.ok, true, response.error);
    assert.deepEqual(response.cacheStatus.hostFrameIds, [1080]);
    assert.deepEqual(response.cachedInputFrameIds, [1080]);
  }
  const prepared = await reply(25);
  assert.equal(prepared.cachedFrameIds.length, 5);
  assert.equal(prepared.cacheStatus.capacity, 5);
  assert.equal(prepared.cacheStatus.hostInputBytes, frame.fractional.byteLength + frame.types.byteLength + frame.cell.vectors.byteLength + frame.cell.origin.byteLength);
  post({ type: 'analyze', id: 26, frameId: 1081, frameIndex: 81, frame: payload(frame, 1081), parameters: { kind: 'coordination', cutoff: 3 } });
  const analyzed = await reply(26);
  assert.equal(analyzed.ok, true, analyzed.error);
  assert.equal(analyzed.result.inputReused, false);
  assert.equal(analyzed.result.gpuInputReused, true);
  assert.deepEqual(analyzed.cacheStatus.hostFrameIds, [1081]);
  assert.equal(analyzed.cacheStatus.uploadCount, prepared.cacheStatus.uploadCount);
  // A same-input task can have been posted by the client before the ACK but
  // reach the Worker afterwards. Its foreground lease survives that gap.
  await new Promise(resolve => setTimeout(resolve, 10));
  post({ type: 'analyze', id: 28, frameId: 1081, frameIndex: 81, parameters: { kind: 'coordination', cutoff: 3 } });
  const late = await reply(28);
  assert.equal(late.ok, true, late.error);
  assert.equal(late.result.inputReused, true); assert.equal(late.result.gpuInputReused, true);
  post({ type: 'clear-frames', id: 27 });
  assert.deepEqual((await reply(27)).cacheStatus.hostFrameIds, []);
});
