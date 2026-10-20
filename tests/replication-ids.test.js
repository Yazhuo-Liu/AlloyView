import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker as NodeWorker } from 'node:worker_threads';
import { physicalReplicationPlan, replicateFrame } from '../src/data/replicate.js';
import { ReplicationIdCache, ReplicationIdsReceiver } from '../src/data/replication-ids.js';
import { estimateFrameBytes } from '../src/data/cache-policy.js';
import { StructureWorkerClient } from '../src/data/structure-worker-client.js';
import { crystalFrame } from './helpers/crystals.js';

test('exact source identities reuse frozen compound IDs but observe row order, type and in-place edits', async () => {
  const frame = crystalFrame('bcc', 2, 3), idCache = new ReplicationIdCache();
  const first = await replicateFrame(frame, [2, 2, 1], { idCache });
  const nextFrame = { ...frame, ids: frame.ids.slice(), positions: frame.positions.slice(), fractional: frame.fractional.slice() };
  nextFrame.fractional[0] += .01;
  const next = await replicateFrame(nextFrame, [2, 2, 1], { idCache });
  const independent = await replicateFrame(nextFrame, [2, 2, 1]);
  assert.equal(next.ids, first.ids);
  assert.deepEqual(next.positions, independent.positions);
  assert.deepEqual(next.fractional, independent.fractional);
  assert.deepEqual(next.ids, independent.ids);
  assert.ok(Object.isFrozen(first.ids));
  assert.throws(() => { first.ids[0] = 'changed'; }, TypeError);
  const initialId = frame.ids[0];
  frame.ids[0] = 9001;
  const edited = await replicateFrame(frame, [2, 2, 1], { idCache });
  assert.notEqual(edited.ids, first.ids); assert.equal(first.ids[0], initialId); assert.equal(edited.ids[0], 9001);
  const typed = await replicateFrame({ ...frame, ids: Array.from(frame.ids, String) }, [2, 2, 1], { idCache });
  assert.equal(typeof typed.ids[0], 'string'); assert.notEqual(typed.ids, edited.ids);
  const ordered = { ...frame, ids: frame.ids.slice().reverse() };
  const reordered = await replicateFrame(ordered, [2, 2, 1], { idCache });
  assert.deepEqual(reordered.ids, (await replicateFrame(ordered, [2, 2, 1])).ids);
  const differentCopies = await replicateFrame(ordered, [1, 2, 2], { idCache });
  assert.notDeepEqual(differentCopies.ids, reordered.ids);
  assert.deepEqual(differentCopies.ids, (await replicateFrame(ordered, [1, 2, 2])).ids);
});

test('ID reuse still rejects duplicate identities and does not cache cancelled partial layouts', async () => {
  const frame = crystalFrame('bcc', 3, 3), idCache = new ReplicationIdCache();
  const first = await replicateFrame(frame, [2, 1, 1], { idCache }), retained = idCache.current;
  const duplicate = { ...frame, ids: frame.ids.slice() }; duplicate.ids[1] = duplicate.ids[0];
  await assert.rejects(replicateFrame(duplicate, [2, 1, 1], { idCache }), /unique/);
  assert.equal(idCache.current, retained);
  const controller = new AbortController();
  await assert.rejects(replicateFrame(frame, [128, 4, 1], { idCache, signal: controller.signal,
    onProgress: ({ completedAtoms }) => { if (completedAtoms >= 16_384) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(idCache.current, retained);
  assert.equal((await replicateFrame(frame, [2, 1, 1], { idCache })).ids, first.ids);
  idCache.clear();
  assert.notEqual((await replicateFrame(frame, [2, 1, 1], { idCache })).ids, first.ids);
  let replaced = false;
  await replicateFrame(frame, [3, 1, 1], { idCache, onProgress: () => {
    if (!replaced) { replaced = true; idCache.clear(); }
  } });
  assert.equal(idCache.current, null, 'a completed old-generation request cannot restore a replaced source layout');
});

test('immutable replicated IDs retain exact byte accounting while arbitrary mutable IDs are rescanned', async () => {
  const frame = await replicateFrame(crystalFrame('bcc', 2, 3), [2, 1, 1]);
  const expected = estimateFrameBytes({ ...frame, ids: [...frame.ids] });
  assert.equal(estimateFrameBytes(frame), expected);
  assert.equal(estimateFrameBytes(frame), expected);
  const mutable = { ...frame, ids: [...frame.ids] }, before = estimateFrameBytes(mutable);
  mutable.ids[0] = 'longer native string ID';
  assert.equal(estimateFrameBytes(mutable) - before, mutable.ids[0].length * 2 - 8);
});

test('near the allocation cap a changed layout releases only the old cache owner, including native string storage', async () => {
  const original = crystalFrame('bcc', 2, 3), frame = { ...original, ids: Array.from(original.ids, id => `native/${id}`) };
  const idCache = new ReplicationIdCache();
  const first = await replicateFrame(frame, [2, 1, 1], { idCache });
  const previous = idCache.current;
  assert.equal(previous.sourceBytes, frame.ids.reduce((sum, id) => sum + 16 + id.length * 2, 0));
  const controller = new AbortController();
  const maxBytes = physicalReplicationPlan(frame, [3, 1, 1]).estimatedBytes;
  await assert.rejects(replicateFrame(frame, [3, 1, 1], { idCache, maxBytes, signal: controller.signal,
    onProgress: () => controller.abort() }), { name: 'AbortError' });
  assert.equal(idCache.current, null, 'cancelling after pressure eviction does not restore the extra retained layout');
  assert.equal(previous.ids, first.ids, 'in-flight/page references remain intact');
  assert.ok(Object.isFrozen(first.ids));
  const next = await replicateFrame(frame, [3, 1, 1], { idCache, maxBytes });
  assert.deepEqual(next.ids, (await replicateFrame(frame, [3, 1, 1])).ids);
  assert.equal(idCache.current.ids, next.ids);
});

test('oversized native string IDs stop incremental encoding before reading the remaining IDs or changing the cache', async () => {
  const frame = crystalFrame('bcc', 2, 3), idCache = new ReplicationIdCache();
  await replicateFrame(frame, [2, 1, 1], { idCache });
  const previous = idCache.current, reads = [], ids = new Array(frame.ids.length);
  for (let atom = 0; atom < ids.length; atom++) Object.defineProperty(ids, atom, {
    get() { reads.push(atom); return `${'☃'.repeat(50)}-${atom}`; },
  });
  const repetitions = [3, 1, 1], maxBytes = physicalReplicationPlan(frame, repetitions).estimatedBytes;
  const oversized = { ...frame, ids };
  let expectedMessage;
  assert.throws(() => physicalReplicationPlan(oversized, repetitions, { maxBytes }), error => {
    expectedMessage = error.message; return /memory limit/.test(error.message);
  });
  reads.length = 0;
  await assert.rejects(replicateFrame(oversized, repetitions, { idCache, maxBytes }), { message: expectedMessage });
  assert.deepEqual(reads, [0], 'the first over-budget encoded ID rejects before the remaining string keys are retained');
  assert.equal(idCache.current, previous, 'a rejected preflight cannot evict or commit over the valid prior layout');
});

test('request-local ID references survive overlapping layouts and reject unknown tokens', () => {
  const receiver = new ReplicationIdsReceiver();
  const one = receiver.restore({ frame: { ids: [1, 'copy1'] }, idsToken: 1, idsBytes: 50 });
  const known = receiver.current;
  receiver.restore({ frame: { ids: [2, 'copy2'] }, idsToken: 2, idsBytes: 50 });
  const late = receiver.restore({ frame: {}, idsToken: 1, idsBytes: 50 }, known);
  assert.equal(late.ids, one.ids);
  assert.throws(() => receiver.restore({ frame: {}, idsToken: 3, idsBytes: 50 }, known), /unknown atom IDs/);
  receiver.clear(); assert.equal(receiver.current, null);
});

class BrowserWorker {
  constructor(url) {
    this.listeners = new Map(); this.messages = []; this.replies = [];
    if (String(url).endsWith('/replication-worker.js')) {
      this.worker = new NodeWorker(new URL('./helpers/node-replication-worker.mjs', import.meta.url));
      this.worker.on('message', data => { this.replies.push(data); this.listeners.get('message')?.({ data }); });
      this.worker.on('error', error => this.listeners.get('error')?.({ message: error.message }));
    }
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  postMessage(message) { this.messages.push(message); this.worker?.postMessage(message); }
  terminate() { return this.worker?.terminate(); }
}

test('real replication Worker sends IDs once, reuses the page array, and starts a fresh protocol after reset', async () => {
  const previous = globalThis.Worker; globalThis.Worker = BrowserWorker;
  const client = new StructureWorkerClient();
  try {
    const frame = crystalFrame('fcc', 3, 4);
    const first = await client.replicate(frame, [2, 2, 2]);
    const worker = client.replicationWorker;
    const second = await client.replicate({ ...frame, ids: frame.ids.slice() }, [2, 2, 2]);
    const replies = worker.replies.filter(reply => reply.ok);
    assert.equal(client.replicationWorker, worker);
    assert.ok(Array.isArray(replies[0].result.frame.ids));
    assert.equal(replies[1].result.frame.ids, second.ids, 'client restores IDs on the received frame');
    // The receiver mutates the reply, so observe absence before dispatch below.
    let wireIds;
    const listener = worker.listeners.get('message');
    worker.listeners.set('message', event => {
      if (event.data.ok) wireIds = event.data.result.frame.ids;
      listener(event);
    });
    const third = await client.replicate(frame, [2, 2, 2]);
    assert.equal(wireIds, undefined, 'subsequent Worker replies omit the million-entry ID payload');
    assert.equal(first.ids, second.ids); assert.equal(first.ids, third.ids);
    assert.ok(Object.isFrozen(third.ids), 'structured-cloned arrays are frozen again on the page');
    assert.deepEqual(third.positions, first.positions);
    // Force the valid late-cancellation ordering: the Worker completes and
    // commits its one retained layout before the page receives progress and
    // cancels. An AbortError must hide that result, but cannot undo a commit
    // that happened before the cancellation message reached the Worker.
    const observedListener = worker.listeners.get('message'), delayed = [];
    worker.listeners.set('message', event => {
      delayed.push(event);
      if (typeof event.data.ok === 'boolean') {
        worker.listeners.set('message', observedListener);
        for (const reply of delayed) observedListener(reply);
      }
    });
    const controller = new AbortController();
    await assert.rejects(client.replicate(frame, [128, 4, 1], { signal: controller.signal,
      onProgress: ({ completedAtoms }) => { if (completedAtoms >= 16_384) controller.abort(); } }), { name: 'AbortError' });
    const afterCancel = await client.replicate(frame, [2, 2, 2]);
    assert.deepEqual(afterCancel.ids, first.ids);
    assert.notEqual(afterCancel.ids, first.ids, 'the completed cancelled layout legitimately replaced the single cache entry');
    assert.equal(wireIds.length, afterCancel.ids.length, 'returning to the evicted layout sends its full IDs once');
    const afterCancelWarm = await client.replicate(frame, [2, 2, 2]);
    assert.equal(afterCancelWarm.ids, afterCancel.ids, 'the restored layout immediately resumes page-array reuse');
    assert.equal(wireIds, undefined, 'the next hot request again omits IDs on the wire');
    const nativeStrings = { ...frame, ids: Array.from(frame.ids, id => id % 2 ? `@AlloyView:copy:1:0:0:${id}` : `atom/${id}`) };
    const changed = await client.replicate(nativeStrings, [2, 2, 2]);
    assert.equal(wireIds.length, changed.ids.length, 'different native IDs require the complete new layout');
    assert.deepEqual(changed.ids, (await replicateFrame(nativeStrings, [2, 2, 2])).ids);
    assert.equal((await client.replicate(nativeStrings, [2, 2, 2])).ids, changed.ids);
    assert.equal(wireIds, undefined);
    client.reset();
    const reset = await client.replicate(frame, [2, 2, 2]);
    assert.notEqual(client.replicationWorker, worker);
    assert.notEqual(reset.ids, first.ids);
    assert.deepEqual(reset.ids, first.ids);
  } finally { client.close(); globalThis.Worker = previous; }
});
