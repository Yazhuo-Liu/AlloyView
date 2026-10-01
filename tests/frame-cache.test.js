import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameCache } from '../src/data/frame-cache.js';

test('frame cache enforces its limit and uses LRU ordering', () => {
  const cache = new FrameCache(3);
  cache.set(0, { id: 0 });
  cache.set(1, { id: 1 });
  cache.set(2, { id: 2 });
  assert.equal(cache.get(0).id, 0);
  cache.set(3, { id: 3 });
  assert.equal(cache.size, 3);
  assert.equal(cache.has(1), false);
  assert.deepEqual(cache.keys(), [2, 0, 3]);
});
