import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseFrameCachePolicy, estimateFrameBytes } from '../src/data/cache-policy.js';

test('small trajectories are eligible for lazy all-frame caching', () => {
  const frame = sampleFrame(100);
  const policy = chooseFrameCachePolicy(frame, 40, { heapLimit: 1024 ** 3, deviceMemoryGiB: 8 });
  assert.equal(policy.limit, 40);
  assert.equal(policy.fullTrajectory, true);
  assert.ok(policy.estimatedFrameBytes >= estimateFrameBytes(frame));
});

test('large trajectories use a bounded adaptive cache', () => {
  const frame = sampleFrame(1_000_000);
  const policy = chooseFrameCachePolicy(frame, 500, { heapLimit: 512 * 1024 ** 2, deviceMemoryGiB: 2 });
  assert.ok(policy.limit >= 3);
  assert.ok(policy.limit < 500);
  assert.equal(policy.fullTrajectory, false);
});

test('PTM deformation cache is counted once including shared property buffers', () => {
  const frame = sampleFrame(100), initial = estimateFrameBytes(frame);
  frame.ptm = { structures: new Uint8Array(100), rmsd: new Float32Array(100),
    scales: new Float64Array(100), deformation: new Float64Array(900), distances: new Float32Array(100), key: 'test' };
  frame.properties.push({ data: frame.ptm.structures }, { data: frame.ptm.rmsd });
  assert.equal(estimateFrameBytes(frame), initial + 8900);
});

test('nested AtomEye caches count bond buffers and local coordination exactly once', () => {
  const frame = sampleFrame(100), initial = estimateFrameBytes(frame);
  const indices = new Uint32Array(200), vectors = new Float32Array(300), shifts = new Int32Array(300);
  const coordination = new Uint32Array(100), localShear = new Float32Array(100);
  frame.atomeyeResults = { bonds: { result: { indices, vectors, shifts, coordination } },
    localShear: { result: { localShear, coordination }, reusedCoordinates: frame.fractional } };
  frame.properties.push({ data: coordination }, { data: localShear });
  frame.analysisOriginalProperties = new Map([['localShear', { data: localShear.subarray(10, 20) }]]);
  assert.equal(estimateFrameBytes(frame), initial + 4000);
});

test('memory accounting handles cyclic metadata, Maps, Sets, views and raw shared buffers', () => {
  const frame = sampleFrame(10), initial = estimateFrameBytes(frame);
  const buffer = new ArrayBuffer(1000), shared = new SharedArrayBuffer(64);
  const cache = { full: buffer, view: new DataView(buffer, 100, 20), short: new Float32Array(buffer, 0, 2),
    shared, sharedView: new Uint8Array(shared), map: new Map(), set: new Set() };
  cache.map.set(cache, new Uint8Array(buffer));
  cache.set.add(cache.map); cache.set.add(frame);
  cache.self = cache;
  frame.atomeyeResults = cache;
  assert.equal(estimateFrameBytes(frame), initial + 1064);
});

test('retained analysis buffers reduce trajectory cache capacity under the same budget', () => {
  const frame = sampleFrame(10), environment = { heapLimit: 128 * 1024 ** 2, deviceMemoryGiB: 2 };
  const before = chooseFrameCachePolicy(frame, 500, environment);
  frame.atomeyeResults = { bonds: { result: { vectors: new Float32Array(2_000_000) } } };
  const after = chooseFrameCachePolicy(frame, 500, environment);
  assert.equal(before.limit, 500);
  assert.equal(after.fullTrajectory, false);
  assert.equal(after.estimatedFrameBytes, Math.ceil(estimateFrameBytes(frame) * 1.35));
  assert.equal(after.limit, Math.max(3, Math.floor(after.budgetBytes / after.estimatedFrameBytes)));
  assert.ok(after.limit < before.limit);
});

function sampleFrame(atomCount) {
  return {
    ids: new Float64Array(atomCount),
    types: new Uint16Array(atomCount),
    positions: new Float32Array(atomCount * 3),
    fractional: new Float32Array(atomCount * 3),
    properties: [],
    cell: { origin: new Float64Array(3), vectors: new Float64Array(9) },
  };
}
