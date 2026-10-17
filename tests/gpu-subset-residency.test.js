import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';
import { exactPairExpected } from '../src/analysis/gpu/exact-pairs.js';
import { crystalFrame } from './helpers/crystals.js';
import { fakeGpu } from './helpers/fake-gpu.js';

// Exercise the actual client -> Worker -> runtime protocol. Only WebGPU is
// replaced: preparation discards its warmup cell, so no scientific shader
// result is fabricated. The device's exact-pair probe gets its expected words.
const expectedPairs = exactPairExpected();
const fake = fakeGpu({ execute(buffers) {
  if (buffers.length === 2 && buffers[1].size === expectedPairs.byteLength) {
    buffers[1].data.set(new Uint8Array(expectedPairs.buffer));
  }
} });
Object.defineProperty(globalThis, 'navigator', { value: { gpu: fake.gpu }, configurable: true });
let deliver;
const listeners = new Map(), messages = [];
const worker = {
  terminated: false,
  addEventListener(type, listener) { listeners.set(type, listener); },
  postMessage(data, transfer = []) {
    const message = structuredClone(data, { transfer }); messages.push(message);
    queueMicrotask(() => deliver({ data: message }));
  },
  terminate() { this.terminated = true; },
};
globalThis.self = {
  addEventListener(type, listener) { if (type === 'message') deliver = listener; },
  postMessage(data, transfer = []) {
    const reply = structuredClone(data, { transfer });
    queueMicrotask(() => listeners.get('message')({ data: reply }));
  },
};
await import('../src/analysis/gpu/worker.js');

test('alternating indexed Voronoi subsets stay bounded without replacing the Worker, warmed kernels or complete source', async () => {
  const client = new GpuAnalysisClient({ workerFactory: () => worker });
  const source = crystalFrame('fcc', 2);
  source.typeLabels = ['A', 'B']; source.types.fill(1, source.types.length / 2);
  const sourceBytes = source.types.length * 36;
  try {
    await client.warmup();
    await client.warmup({ analysisKinds: ['voronoi'] });
    await client.configureCache({ frameCount: 1, currentIndex: 0, budgetBytes: 32 * 1024 ** 2 + sourceBytes * 2.6 });
    const initial = await client.prepareFrame(source, { frameIndex: 0 });
    const sourceId = initial.cachedFrameIds[0], pipelineCount = initial.pipelineCount;
    let workspaceAtoms;
    for (let index = 0; index < 8; index++) {
      const status = await client.prepareFrame(source,
        { frameIndex: 0, analysisKinds: ['voronoi'], selectedTypes: [index % 2 ? 'B' : 'A'] });
      assert.equal(status.capacity, 1);
      assert.deepEqual(status.cachedFrameIds, [sourceId], 'idle subsets must not defeat the resident frame limit');
      assert.equal(status.residentBytes, sourceBytes);
      assert.equal(status.pipelineCount, pipelineCount, 'subset eviction retains the compiled kernels');
      assert.ok(status.voronoiWorkspaceAtoms > 0);
      workspaceAtoms ??= status.voronoiWorkspaceAtoms;
      assert.equal(status.voronoiWorkspaceAtoms, workspaceAtoms, 'the reusable cell workspace stays warm');
      assert.equal(client.worker, worker); assert.equal(worker.terminated, false);
    }
    const before = messages.length;
    await client.warmup(); await client.warmup({ analysisKinds: ['voronoi'] });
    assert.equal(messages.length, before, 'device/pipeline readiness is not reset by subset eviction');
    const uploads = client.cacheStatus.uploadCount;
    await client.prepareFrame(source, { frameIndex: 0 });
    assert.equal(client.cacheStatus.uploadCount, uploads, 'the original full frame requires no reupload');
    assert.equal(messages.at(-1).frame, undefined, 'the original full frame also keeps its acknowledged host input');
  } finally { client.close(); }
});
