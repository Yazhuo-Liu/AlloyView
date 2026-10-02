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
