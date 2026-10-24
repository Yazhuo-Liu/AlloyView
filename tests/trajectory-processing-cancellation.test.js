import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { smoothTrajectoryFrame } from '../src/data/trajectory-tools.js';
import { TrajectoryProcessor } from '../src/workers/trajectory-processor.js';

function fixture(count, options = {}) {
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
  const frames = Array.from({ length: count }, (_, frameIndex) => {
    const x = .9 + .23 * frameIndex;
    const fractional = Float64Array.of(x - Math.floor(x), .2, .3);
    return { frameIndex, ids: Float64Array.of(1), idSource: 'explicit', fractional,
      positions: fractionalToCartesian(fractional, cell), cell, types: Uint16Array.of(0), typeLabels: ['Fe'], properties: [] };
  });
  let reads = 0;
  const processor = new TrajectoryProcessor({ readFrame: async index => { reads++; return structuredClone(frames[index]); },
    getFrameCount: () => count, ...options });
  for (let index = 0; index < count; index++) processor.remember(index, frames[index], { copy: true });
  return { processor, frames, getReads: () => reads };
}

// Timer delivery is the assertion: aborting synchronously in onProgress would
// also pass a microtask-only loop and fail to model incoming Worker messages.
async function interrupt(operation, maximum) {
  const controller = new AbortController();
  let progress = 0, delivered = false;
  const timer = setTimeout(() => { delivered = true; controller.abort(); }, 0);
  try {
    await assert.rejects(operation(controller.signal, () => {
      progress++;
      // A progress consumer may do real work. Ensure this cached scan exceeds
      // a time slice without depending on the host's parsing/CPU speed.
      const end = performance.now() + .15;
      while (performance.now() < end) { /* intentional bounded test workload */ }
    }), { name: 'AbortError' });
  } finally { clearTimeout(timer); }
  assert.equal(delivered, true);
  assert.ok(progress > 0 && progress < maximum, `${progress} of ${maximum} frames completed before timer delivery`);
}

test('cached ordered integration admits timed cancellation and resumes the same crossing history', async () => {
  const { processor, getReads } = fixture(300);
  await interrupt((signal, onProgress) => processor.integrateTo(299, { signal }, onProgress), 300);
  assert.ok(processor.unwrapper.frontier >= 0 && processor.unwrapper.frontier < 299);
  assert.equal((await processor.coordinates(0)).ids[0], 1, 'ordinary cached frame reads remain usable');
  await processor.integrateTo(299);
  assert.deepEqual(Array.from(await processor.imageFlagsAt(299, Float64Array.of(1))), [Math.floor(.9 + .23 * 299), 0, 0]);
  assert.equal(getReads(), 0);
});

test('cached crossing-log replay admits timed cancellation without corrupting a later request', async () => {
  const { processor, getReads } = fixture(300, { eventBudgetBytes: 0 });
  await processor.integrateTo(299);
  assert.equal(processor.unwrapper.canReconstruct(119), false);
  await interrupt((signal, onProgress) => processor.imageFlagsAt(119, Float64Array.of(1), { signal }, onProgress), 120);
  assert.deepEqual(Array.from(await processor.imageFlagsAt(119, Float64Array.of(1))), [Math.floor(.9 + .23 * 119), 0, 0]);
  assert.equal(getReads(), 0);
});

test('cached smoothing admits timed cancellation and leaves the target geometry ready for a clean retry', async () => {
  const { processor, frames, getReads } = fixture(101);
  const target = structuredClone(frames[50]);
  const original = target.positions.slice();
  await interrupt((signal, onProgress) => processor.prepare(target, 50, { smoothing: 50, signal, onProgress }), 100);
  assert.deepEqual(target.positions, original);
  assert.equal(processor.windows.size, 0);
  await processor.prepare(target, 50, { smoothing: 50 });
  const expected = smoothTrajectoryFrame(frames[50], frames.filter((_, index) => index !== 50));
  assert.deepEqual(target.positions, expected.positions);
  assert.deepEqual(target.fractional, expected.fractional);
  assert.equal(getReads(), 0);
});

test('cached line generation admits timed cancellation and a subsequent generation has the complete path', async () => {
  const { processor, getReads } = fixture(300);
  const request = { ids: [1], first: 0, last: 299, stride: 1 };
  await interrupt((signal, onProgress) => processor.lines(request, { signal, onProgress }), 300);
  const result = await processor.lines(request);
  assert.equal(result.vertexCount, 300);
  assert.equal(result.lineCount, 1);
  assert.ok(Math.abs(result.vertices[0] - 9) < 1e-5);
  assert.ok(Math.abs(result.vertices[299 * 4] - 10 * (.9 + .23 * 299)) < 1e-4);
  assert.equal(getReads(), 0);
});
