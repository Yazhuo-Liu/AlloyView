import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameCache } from '../src/data/frame-cache.js';
import { retainReplicatedIds } from '../src/data/replication-ids.js';

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

test('frame cache limit can grow and shrink without losing newest frames', () => {
  const cache = new FrameCache(4);
  for (let index = 0; index < 4; index += 1) cache.set(index, { id: index });
  cache.setLimit(2);
  assert.deepEqual(cache.keys(), [2, 3]);
  cache.setLimit(5);
  cache.set(4, { id: 4 });
  assert.deepEqual(cache.keys(), [2, 3, 4]);
});

test('byte-budget eviction follows the real sizes of variable frames and pins the display', () => {
  const cache = new FrameCache(10, { byteBudget: 100 });
  cache.pin(0);
  cache.set(0, { positions: new Uint8Array(8) });
  cache.set(1, { positions: new Uint8Array(80) });
  assert.equal(cache.bytes, 88);
  cache.set(2, { positions: new Uint8Array(32) });
  assert.deepEqual(cache.keys(), [0, 2]);
  assert.equal(cache.bytes, 40);
  cache.setByteBudget(20);
  assert.deepEqual(cache.keys(), [0]);
  assert.equal(cache.bytes, 8);
});

test('aliased backing buffers are charged once across properties and cached frames', () => {
  const shared = new ArrayBuffer(100), other = new ArrayBuffer(24);
  const cache = new FrameCache(4, { byteBudget: 124 });
  cache.set(0, { positions: new Uint8Array(shared), properties: [{ data: new DataView(shared, 10, 8) }] });
  cache.set(1, { positions: new Float32Array(shared), scalar: new Uint8Array(other) });
  assert.equal(cache.bytes, 124);
  cache.delete(0);
  assert.equal(cache.bytes, 124, 'the remaining frame still owns the entire shared buffer');
  cache.delete(1);
  assert.equal(cache.bytes, 0);
});

test('shared immutable physical-copy IDs are charged once across cached frames', () => {
  const ids = retainReplicatedIds(['1', '@AlloyView:copy:1:0:0:1'], 120);
  const cache = new FrameCache(4, { byteBudget: 160 });
  cache.set(0, { ids, positions: new Uint8Array(20) });
  cache.set(1, { ids, positions: new Uint8Array(20) });
  assert.equal(cache.bytes, 160);
  assert.equal(cache.size, 2);
  cache.delete(0);
  assert.equal(cache.bytes, 140);
});

test('reassessing attached analysis arrays evicts neighbours but retains an oversized displayed frame', () => {
  const cache = new FrameCache(4, { byteBudget: 100 }), frame = { positions: new Uint8Array(40) };
  cache.pin(0); cache.set(0, frame);
  cache.set(1, { positions: new Uint8Array(40) });
  frame.analysis = new Uint8Array(80);
  cache.reassess(0);
  assert.deepEqual(cache.keys(), [0]);
  assert.equal(cache.bytes, 120);
  cache.pin(2);
  assert.equal(cache.size, 0, 'an oversized old display is evictable when navigation commits another index');
  cache.set(2, { positions: new Uint8Array(20) });
  assert.equal(cache.bytes, 20);
  cache.clear();
  assert.equal(cache.bytes, 0);
  assert.equal(cache.pinnedIndex, null);
});
