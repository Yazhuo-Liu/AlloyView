import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { CpuBudget } from '../src/shared/cpu-budget.js';
import { FrameParserPool } from '../src/data/frame-parser-pool.js';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { smoothTrajectoryFrame, smoothingWindow } from '../src/data/trajectory-tools.js';
import { MAX_TRAJECTORY_COORDINATE_BYTES, TRAJECTORY_COORDINATE_BYTES, TrajectoryProcessor, trajectoryCoordinateBudgetLimit } from '../src/workers/trajectory-processor.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function makeFrame(index, { atoms = 128, shuffled = false, images = false } = {}) {
  const ids = Float64Array.from({ length: atoms }, (_, atom) => atom + 1);
  if (shuffled) ids.reverse();
  const fractional = new Float64Array(atoms * 3);
  for (let atom = 0; atom < atoms; atom++) {
    fractional[atom * 3] = ((ids[atom] * 0.071 + index * 0.037) % 1);
    fractional[atom * 3 + 1] = ((ids[atom] * 0.053 + index * 0.013) % 1);
    fractional[atom * 3 + 2] = ids[atom] * 0.002;
  }
  const cell = createCell({ origin: [index * 1e-5, 0, 0], vectors: [10, 0, 0, 2, 11, 0, 1, 3, 12], pbc: [true, true, false] });
  const frame = { frameIndex: index, ids, fractional, positions: fractionalToCartesian(fractional, cell), cell, idSource: 'explicit', properties: [] };
  if (images) { frame.unwrappedPositions = Float64Array.from(frame.positions); frame.imageFlags = new Int32Array(atoms * 3); }
  return frame;
}
function source({ count = 50, atoms = 128, ...options } = {}) {
  const reads = [];
  const processor = new TrajectoryProcessor({ readFrame: async index => { reads.push(index); return makeFrame(index, { atoms }); },
    getFrameCount: async () => count, ...options });
  return { processor, reads, count, atoms };
}
function assertSmoothed(frame, index, window, count, options) {
  const { first, last } = smoothingWindow(index, window, count);
  const others = [];
  for (let neighbor = first; neighbor <= last; neighbor++) if (neighbor !== index) others.push(makeFrame(neighbor, options));
  const expected = smoothTrajectoryFrame(makeFrame(index, options), others);
  for (const name of ['fractional', 'positions']) assert.deepEqual(frame[name], expected[name], `frame ${index} ${name}`);
  assert.deepEqual(frame.cell, expected.cell);
}

test('default coordinate hard limits reserve CPU memory on small devices and never exceed 768 MiB', () => {
  const MiB = 1024 ** 2;
  const lowDevice = { navigator: { hardwareConcurrency: 32, deviceMemory: 0.5 } };
  const lowHeap = { navigator: { hardwareConcurrency: 32 }, performance: { memory: { jsHeapSizeLimit: 128 * MiB } } };
  const desktop = { navigator: { hardwareConcurrency: 16, deviceMemory: 8 }, performance: { memory: { jsHeapSizeLimit: 4 * 1024 ** 3 } } };
  assert.equal(trajectoryCoordinateBudgetLimit(lowDevice), 64 * MiB);
  assert.equal(trajectoryCoordinateBudgetLimit(lowHeap), 32 * MiB);
  assert.equal(trajectoryCoordinateBudgetLimit(desktop), 512 * MiB);
  assert.equal(trajectoryCoordinateBudgetLimit({ navigator: { hardwareConcurrency: 64, deviceMemory: 32 } }), 768 * MiB);
  assert.equal(trajectoryCoordinateBudgetLimit({}), 128 * MiB);
  const small = source({ environment: lowDevice }).processor;
  assert.equal(small.coordinateBudgetLimitBytes, 64 * MiB);
  assert.equal(small.coordinateBudgetBytes, 64 * MiB);
  const explicit = source({ environment: lowHeap, coordinateBudgetBytes: 5000, coordinateBudgetLimitBytes: 10_000 }).processor;
  assert.equal(explicit.coordinateBudgetLimitBytes, 10_000, 'tests and explicit policies retain their chosen smaller limit');
  assert.equal(source({ coordinateBudgetLimitBytes: 1024 * MiB }).processor.coordinateBudgetLimitBytes, 768 * MiB);
});

test('window-sized coordinate caches reuse every overlapping frame with exact ordered smoothing', async () => {
  const base = 12_000;
  const grown = source({ coordinateBudgetBytes: base, coordinateBudgetLimitBytes: 1024 ** 2 });
  const limited = source({ coordinateBudgetBytes: base, coordinateBudgetLimitBytes: base });
  for (const fixture of [grown, limited]) {
    for (let index = 10; index <= 17; index++) {
      const frame = makeFrame(index);
      await fixture.processor.prepare(frame, index, { smoothing: 5 });
      assertSmoothed(frame, index, 5, 50);
      assert.ok(fixture.processor.storeBytes <= fixture.processor.coordinateBudgetBytes);
    }
  }
  assert.equal(grown.reads.length, 17, 'ten initial neighbor reads, then one new neighbor per forward step');
  assert.ok(limited.reads.length >= 65, `a deliberately capped cache needs more reads: ${limited.reads.length}`);
  assert.ok(grown.processor.coordinateBudgetBytes > base);
  assert.ok(grown.processor.coordinateBudgetBytes < 1024 ** 2);
  assert.equal(grown.processor.idArrays.size, 1);
  assert.equal(grown.processor.windows.size, 0);
  assert.equal(grown.processor.reading.size, 0);
  assert.equal(TRAJECTORY_COORDINATE_BYTES, 192 * 1024 ** 2);
  assert.equal(MAX_TRAJECTORY_COORDINATE_BYTES, 768 * 1024 ** 2);
});

test('cache accounting shares exact IDs and counts actual backing buffers without detaching outgoing frames', () => {
  const { processor } = source();
  const first = makeFrame(0), second = makeFrame(1);
  const originalIds = first.ids;
  const firstSnapshot = processor.remember(0, first, { copy: true });
  const secondSnapshot = processor.remember(1, second, { copy: true });
  assert.notEqual(firstSnapshot.ids, originalIds);
  assert.equal(firstSnapshot.ids, secondSnapshot.ids);
  const expected = firstSnapshot.ids.buffer.byteLength + 2 * (256 + firstSnapshot.fractional.buffer.byteLength + 96);
  assert.equal(processor.storeBytes, expected);
  structuredClone(first, { transfer: [first.ids.buffer, first.fractional.buffer, first.cell.origin.buffer, first.cell.vectors.buffer] });
  assert.equal(originalIds.byteLength, 0);
  assert.equal(firstSnapshot.ids[0], 1);
  assert.equal(secondSnapshot.ids[127], 128);
  assert.equal(firstSnapshot.fractional.length, 384);

  const reordered = processor.remember(2, makeFrame(2, { shuffled: true }));
  assert.notEqual(reordered.ids, firstSnapshot.ids);
  assert.equal(reordered.ids[0], 128);
  const subset = processor.remember(3, makeFrame(3, { atoms: 7 }));
  assert.notEqual(subset.ids, firstSnapshot.ids);
  const longBacking = new Float64Array(8192);
  const tiny = makeFrame(4, { atoms: 2 }); tiny.fractional = longBacking.subarray(3, 9);
  processor.remember(4, tiny);
  assert.equal(processor.references.get(longBacking.buffer).bytes, longBacking.byteLength);
  processor.close();
  assert.equal(processor.storeBytes, 0);
  assert.equal(processor.references.size, 0);
  assert.equal(processor.idArrays.size, 0);
});

test('hard caps retain no oversized exception and report limited windows without changing their coordinates', async () => {
  const { processor } = source({ coordinateBudgetBytes: 500, coordinateBudgetLimitBytes: 500 });
  const frame = makeFrame(10);
  await processor.prepare(frame, 10, { smoothing: 2 });
  assertSmoothed(frame, 10, 2, 50);
  assert.equal(processor.store.size, 0, 'a snapshot bigger than the hard cap is used but not retained');
  assert.equal(processor.storeBytes, 0);
  assert.equal(frame.smoothing.cacheLimited.budgetBytes, 500);
  assert.ok(frame.smoothing.cacheLimited.requestedBytes > 500);
  assert.equal(processor.references.size, 0);
  const withImages = makeFrame(10, { images: true });
  const bigger = source({ coordinateBudgetBytes: 10_000, coordinateBudgetLimitBytes: 100_000 }).processor;
  await bigger.prepare(withImages, 10, { smoothing: 3 });
  assert.ok(bigger.store.get(10).coordinateBytes >= 256 + 128 * 3 * 8 * 2 + 96, 'file unwrapped coordinates count in the target snapshot size');
  for (const bad of [0, Infinity, -1, 1.5]) {
    assert.throws(() => source({ coordinateBudgetLimitBytes: bad }), /positive safe integers/);
  }
});

test('a smaller current window releases historical large snapshots instead of keeping their inflated budget', async () => {
  const processor = new TrajectoryProcessor({ coordinateBudgetBytes: 5000, coordinateBudgetLimitBytes: 120_000,
    getFrameCount: async () => 50, readFrame: async index => makeFrame(index, { atoms: index < 20 ? 512 : 8 }) });
  const large = makeFrame(10, { atoms: 512 });
  await processor.prepare(large, 10, { smoothing: 5 });
  assert.ok(large.smoothing.cacheLimited);
  const small = makeFrame(35, { atoms: 8 });
  await processor.prepare(small, 35, { smoothing: 1 });
  assert.equal(small.smoothing.cacheLimited, undefined);
  assert.equal(processor.coordinateBudgetBytes, 5000);
  assert.ok([...processor.store.keys()].every(index => index >= 20));
  assert.ok(processor.storeBytes <= 5000);
});

test('window-distance eviction discards unrelated new reads instead of useful older coordinates', () => {
  const { processor } = source({ coordinateBudgetBytes: 8000, coordinateBudgetLimitBytes: 8000 });
  const scope = processor.beginWindow(15, 2, 50, false);
  const middle = processor.remember(15, makeFrame(15));
  processor.remember(14, makeFrame(14));
  processor.remember(0, makeFrame(0));
  assert.equal(processor.store.get(15).snapshot, middle);
  assert.equal(processor.store.has(0), false, 'far read loses even though it arrived last');
  processor.remember(49, makeFrame(49));
  assert.equal(processor.store.has(49), false);
  processor.windows.delete(scope);
  const next = processor.beginWindow(40, 2, 50, false);
  processor.remember(40, makeFrame(40));
  processor.remember(41, makeFrame(41));
  assert.equal(processor.store.has(40), true);
  assert.equal(processor.store.has(15), false, 'moving the window releases the old useful neighborhood');
  processor.windows.delete(next);
});

test('ordered frame metadata evicts a farthest frame across disjoint windows and compacts a long forward stream', () => {
  const { processor } = source({ coordinateBudgetBytes: 25_000, coordinateBudgetLimitBytes: 25_000, atoms: 1 });
  const first = processor.beginWindow(30, 3, 2000, false);
  const second = processor.beginWindow(1600, 3, 2000, true);
  const distance = index => Math.min(index < 27 ? 27 - index : Math.max(0, index - 37), index < 1597 ? 1597 - index : Math.max(0, index - 1607));
  let state = 17;
  for (let attempt = 0; attempt < 300; attempt++) {
    state = (state * 48271) % 2147483647;
    const index = state % 2000, previous = new Set([...processor.store.keys(), index]);
    processor.remember(index, makeFrame(index, { atoms: 1 }));
    const removed = [...previous].filter(value => !processor.store.has(value));
    for (const victim of removed) {
      assert.equal(distance(victim), Math.max(...[...previous].map(distance)));
      previous.delete(victim);
    }
    assert.deepEqual(processor.sortedIndices.slice(processor.indexStart), [...processor.store.keys()].sort((a, b) => a - b));
    assert.ok(processor.storeBytes <= 25_000);
  }
  processor.windows.delete(first); processor.windows.delete(second); processor.lastWindow = null; processor.resizeCache();
  for (let index = 2000; index < 7000; index++) processor.remember(index, makeFrame(index, { atoms: 1 }));
  assert.ok(processor.sortedIndices.length < 1200, 'discarded leading keys compact instead of growing with the whole trajectory');
  assert.deepEqual(processor.sortedIndices.slice(processor.indexStart), [...processor.store.keys()].sort((a, b) => a - b));
  assert.ok(processor.store.has(6999));
});

test('long tiny-frame trajectories keep their complete small raw cache and smooth without reparsing it', async () => {
  const { processor, reads } = source({ coordinateBudgetBytes: 8 * 1024 ** 2, coordinateBudgetLimitBytes: 8 * 1024 ** 2, atoms: 1, count: 10_000 });
  for (let index = 0; index < 10_000; index++) processor.remember(index, makeFrame(index, { atoms: 1 }));
  assert.equal(processor.store.size, 10_000);
  assert.ok(processor.storeBytes < 8 * 1024 ** 2);
  const frame = makeFrame(5000, { atoms: 1 });
  await processor.prepare(frame, 5000, { smoothing: 3 });
  assertSmoothed(frame, 5000, 3, 10_000, { atoms: 1 });
  assert.deepEqual(reads, []);
  assert.equal(processor.store.size, 10_000);
  processor.close();
  const changing = source({ coordinateBudgetBytes: 8 * 1024 ** 2, coordinateBudgetLimitBytes: 8 * 1024 ** 2, atoms: 1, count: 10_000 }).processor;
  for (let index = 0; index < 10_000; index++) {
    const value = makeFrame(index, { atoms: 1 }); value.ids[0] = index + 1;
    changing.remember(index, value);
  }
  assert.equal(changing.idArrays.size, 10_000);
  assert.equal(changing.idCandidates.length, 4, 'changing identities never build or scan an unbounded intern table');
  assert.equal(changing.store.size, 10_000);
  changing.close();
});

test('cancelled subscribers release their window promptly while joined coordinate reads remain useful', async () => {
  let finishRead;
  const processor = new TrajectoryProcessor({ readFrame: async index => { await new Promise(resolve => { finishRead = resolve; }); return makeFrame(index); },
    getFrameCount: async () => 50 });
  const shared = processor.coordinates(8);
  await tick();
  const controller = new AbortController();
  const joined = processor.coordinates(8, { signal: controller.signal });
  const rejected = assert.rejects(joined, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.equal(processor.reading.size, 1);
  finishRead();
  assert.equal((await shared).frameIndex, 8);
  assert.equal(processor.store.has(8), true);

  const signal = new AbortController();
  const cancelled = processor.prepare(makeFrame(15), 15, { smoothing: 4, signal: signal.signal });
  const failure = assert.rejects(cancelled, { name: 'AbortError' });
  await tick();
  signal.abort();
  await failure;
  assert.equal(processor.windows.size, 0, 'a cancelled prepare does not leave its range pinned');
  processor.close();
  finishRead();
});

test('concurrent disjoint windows and changed atom ordering preserve every direct result within the cap', async () => {
  const processor = new TrajectoryProcessor({ coordinateBudgetBytes: 5000, coordinateBudgetLimitBytes: 100_000,
    readFrame: async index => { await tick(); return makeFrame(index, { shuffled: index % 2 === 1 }); }, getFrameCount: async () => 50 });
  for (const indices of [[35, 8, 20], [49, 0, 21], [8, 36, 20]]) {
    const values = await Promise.all(indices.map(async index => {
      const frame = makeFrame(index, { shuffled: index % 2 === 1 });
      await processor.prepare(frame, index, { smoothing: 3, background: index !== indices[0] });
      const { first, last } = smoothingWindow(index, 3, 50);
      const others = [];
      for (let neighbor = first; neighbor <= last; neighbor++) if (neighbor !== index) others.push(makeFrame(neighbor, { shuffled: neighbor % 2 === 1 }));
      return { frame, expected: smoothTrajectoryFrame(makeFrame(index, { shuffled: index % 2 === 1 }), others) };
    }));
    for (const { frame, expected } of values) {
      assert.deepEqual(frame.fractional, expected.fractional);
      assert.deepEqual(frame.positions, expected.positions);
      assert.deepEqual(frame.cell, expected.cell);
    }
    assert.equal(processor.windows.size, 0);
    assert.ok(processor.storeBytes <= 100_000);
  }
});

function parserFixture(t, { limit = 1024 ** 2 } = {}) {
  const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 5 } } });
  const files = Array.from({ length: 40 }, (_, index) => {
    const rows = Array.from({ length: 64 }, (_, atom) => `Fe ${(atom * 0.079 + index * 0.017) % 1} ${(atom * 0.051) % 1} ${(atom * 0.033) % 1} ${atom + 1}`).join('\n');
    return new File([`64\nLattice="1 0 0 0 1 0 0 0 1" Properties=species:S:1:pos:R:3:id:I:1 pbc="T T T"\n${rows}\n`], `frame.${index}.xyz`);
  });
  const reads = [], workers = [];
  const pool = new FrameParserPool({ backgroundCount: 2,
    acquire: ({ signal, priority }) => budget.acquire(1, { signal, priority }),
    promote: ({ signal, priority }) => budget.promote(signal, priority),
    workerFactory: () => {
      const worker = new Worker(new URL('./helpers/node-frame-parser-worker.mjs', import.meta.url));
      const adapter = {
        addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
        postMessage(message) { if (message.descriptor) reads.push(message.descriptor.index); worker.postMessage(message); },
        terminate() { worker.terminate(); },
      };
      workers.push(adapter); return adapter;
    } });
  const read = (index, options) => pool.parse({ format: 'xyz', file: files[index], index }, options);
  const processor = new TrajectoryProcessor({ readFrame: read, promoteRead: ({ signal, priority }) => pool.promote(signal, priority), getFrameCount: async () => files.length,
    coordinateBudgetBytes: 5000, coordinateBudgetLimitBytes: limit });
  t.after(() => { processor.close(); pool.close(); });
  return { processor, pool, budget, reads, workers, read };
}

test('real warm parser Workers read one new neighbor per sliding frame instead of reparsing a capped window', async t => {
  const grown = parserFixture(t);
  const capped = parserFixture(t, { limit: 5000 });
  const results = [];
  for (const fixture of [grown, capped]) {
    const frames = [];
    for (let index = 10; index <= 15; index++) {
      const frame = await fixture.read(index, { background: false });
      await fixture.processor.prepare(frame, index, { smoothing: 5 });
      // Exercise a real transferable send after preparation, as the structure
      // Worker does. Internal shared IDs survive every outgoing frame.
      frames.push(structuredClone(frame, { transfer: [frame.ids.buffer, frame.fractional.buffer, frame.positions.buffer] }));
    }
    results.push(frames);
    assert.equal(fixture.budget.active, 0);
    assert.equal(fixture.budget.queue.length, 0);
    assert.ok(fixture.workers.length <= 3);
    assert.equal(fixture.processor.reading.size, 0);
    assert.equal(fixture.processor.windows.size, 0);
  }
  assert.equal(grown.reads.length, 21, 'six foreground frames plus ten initial and five new neighbors');
  assert.ok(capped.reads.length >= 50, `fixed-cap reference reads ${capped.reads.length} frames`);
  assert.deepEqual(results[0].map(frame => frame.fractional), results[1].map(frame => frame.fractional));
  assert.deepEqual(results[0].map(frame => frame.positions), results[1].map(frame => frame.positions));
  assert.equal(grown.processor.idArrays.size, 1);
  const warmed = grown.workers.slice();
  const frame = await grown.read(14, { background: false });
  await grown.processor.prepare(frame, 14, { smoothing: 5 });
  assert.deepEqual(grown.workers, warmed, 'reverse navigation reuses all parser Workers');
});

test('real concurrent parser-backed smoothing cancels independently and leaves the shared CPU budget reusable', async t => {
  const fixture = parserFixture(t);
  const controller = new AbortController();
  const first = fixture.processor.prepare(makeFrame(10, { atoms: 64 }), 10, { smoothing: 5, signal: controller.signal });
  const failed = assert.rejects(first, { name: 'AbortError' });
  await tick(); controller.abort();
  const current = await fixture.read(22, { background: false });
  await fixture.processor.prepare(current, 22, { smoothing: 3 });
  await failed;
  while (fixture.budget.active || fixture.pool.queue.length) await tick();
  assert.equal(fixture.processor.windows.size, 0);
  assert.equal(fixture.budget.queue.length, 0);
  assert.ok(fixture.workers.length <= 3);
  const next = await fixture.read(23, { background: false });
  await fixture.processor.prepare(next, 23, { smoothing: 3 });
  assert.equal(fixture.budget.active, 0);
  assert.equal(next.fractional.length, 192);
});

test('joining a speculative coordinate read promotes its existing parser CPU reservation without duplicate parsing', async t => {
  const fixture = parserFixture(t);
  const held = await fixture.budget.acquire(3);
  const owner = new AbortController(), foreground = new AbortController();
  const shared = fixture.processor.coordinates(12, { signal: owner.signal, background: true, priority: -20 });
  await tick();
  assert.equal(fixture.budget.queue.length, 1);
  assert.equal(fixture.budget.queue[0].priority, -20);
  const joined = fixture.processor.coordinates(12, { signal: foreground.signal, background: true, priority: 20 });
  assert.equal(fixture.budget.queue[0].priority, 20);
  held.release();
  const [first, second] = await Promise.all([shared, joined]);
  assert.equal(first, second);
  assert.deepEqual(fixture.reads, [12]);
  assert.equal(fixture.budget.active, 0);
  assert.equal(fixture.budget.queue.length, 0);
});
