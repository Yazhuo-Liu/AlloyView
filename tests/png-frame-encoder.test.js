import test from 'node:test';
import assert from 'node:assert/strict';
import { PngFrameEncoder } from '../src/video/png-frame-encoder.js';
import { PngArchiveQueue } from '../src/video/png-archive-queue.js';
import { createImageArchive, crc32, ImageArchiveBuilder } from '../src/io/export-archive.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());
const canvasFor = (bytes = Uint8Array.of(1, 2, 3)) => ({ width: 10, height: 12, calls: 0,
  toBlob(callback) { this.calls++; callback(new Blob([bytes], { type: 'image/png' })); } });
function workerFixture(options = {}) {
  const workers = [], bitmaps = [];
  const encoder = new PngFrameEncoder({ offscreenAvailable: true,
    createWorker() {
      const worker = { sent: [], terminated: false,
        postMessage(data, transfer) { this.sent.push({ data, transfer }); }, terminate() { this.terminated = true; } };
      workers.push(worker); return worker;
    },
    createBitmap: async canvas => { const bitmap = { canvas, close() { this.closed = true; } }; bitmaps.push(bitmap); return bitmap; },
    ...options,
  });
  return { encoder, workers, bitmaps };
}

test('Worker PNG replies reuse immutable Blobs and preserve exact ZIP bytes without reading them on the page', async () => {
  const bytes = Uint8Array.from({ length: 731 }, (_, i) => i & 255), blob = new Blob([bytes]);
  blob.arrayBuffer = () => { throw new Error('Do not read prepared bytes on the page'); };
  const { encoder, workers, bitmaps } = workerFixture(), canvas = canvasFor(bytes);
  const pending = encoder.encode(canvas); await tick();
  const worker = workers[0], [{ data, transfer }] = worker.sent;
  assert.equal(transfer[0], bitmaps[0]);
  worker.onmessage({ data: { id: data.id, blob, crc: crc32(bytes) } });
  const result = await pending, builder = new ImageArchiveBuilder();
  builder.add({ name: '第二张.png', ...result });
  assert.deepEqual(await bytesOf(builder.finish()), await bytesOf(createImageArchive([{ name: '第二张.png', bytes }])));
  assert.equal(canvas.calls, 0);
  encoder.dispose(); assert.equal(worker.terminated, true);
});

test('unsupported and failed Workers retry both retained snapshots once and keep subsequent encoding on the page', async () => {
  for (const failure of ['construct', 'error', 'messageerror', 'encode', 'transfer']) {
    const fixture = workerFixture(failure === 'construct' ? { createWorker() { throw new Error('CSP'); } } : {});
    const first = canvasFor(Uint8Array.of(1)), second = canvasFor(Uint8Array.of(2));
    const a = fixture.encoder.encode(first), b = fixture.encoder.encode(second);
    if (failure === 'transfer') fixture.workers[0].postMessage = () => { throw new Error('Cannot transfer'); };
    await tick();
    const worker = fixture.workers[0];
    if (failure === 'error') worker.onerror({ preventDefault() {} });
    if (failure === 'messageerror') worker.onmessageerror();
    if (failure === 'encode') worker.onmessage({ data: { id: worker.sent[0].data.id, error: 'convertToBlob unsupported' } });
    const results = await Promise.all([a, b]);
    assert.deepEqual(await Promise.all(results.map(value => bytesOf(value.blob))), [Uint8Array.of(1), Uint8Array.of(2)], failure);
    assert.deepEqual([first.calls, second.calls], [1, 1]);
    const third = canvasFor(Uint8Array.of(3)); await fixture.encoder.encode(third);
    assert.equal(third.calls, 1); assert.equal(fixture.encoder.pending.size, 0);
    if (worker) assert.equal(worker.terminated, true);
    fixture.encoder.dispose();
  }
  const encoder = new PngFrameEncoder({ offscreenAvailable: false }), canvas = canvasFor();
  await encoder.encode(canvas); assert.equal(canvas.calls, 1); encoder.dispose();
});

test('abort releases Worker requests immediately and closes a bitmap that resolves after disposal', async () => {
  let finishBitmap;
  const controller = new AbortController();
  const { encoder, workers } = workerFixture({ signal: controller.signal,
    createBitmap: () => new Promise(resolve => { finishBitmap = resolve; }) });
  const pending = encoder.encode(canvasFor()), rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); await rejected;
  const bitmap = { close() { this.closed = true; } }; finishBitmap(bitmap); await tick();
  assert.equal(bitmap.closed, true); assert.equal(workers[0].terminated, true);
  assert.equal(encoder.pending.size, 0); assert.equal(workers[0].sent.length, 0);
  await assert.rejects(encoder.encode(canvasFor()), { name: 'AbortError' });
});

test('the encoder rejects a third image while two snapshots are pending', async () => {
  const { encoder } = workerFixture({ createBitmap: () => new Promise(() => {}) });
  const first = encoder.encode(canvasFor()), second = encoder.encode(canvasFor());
  const failures = [assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })];
  await assert.rejects(encoder.encode(canvasFor()), /queue is full/);
  assert.equal(encoder.pending.size, 2); encoder.dispose(); await Promise.all(failures);
});

test('two PNGs may encode concurrently but archive records, progress and backpressure keep capture order', async () => {
  const resolvers = [], released = [], progress = [];
  const queue = new PngArchiveQueue({ encode: canvas => new Promise(resolve => { resolvers[canvas.index] = resolve; }),
    release: canvas => released.push(canvas.index), onEncoded: value => progress.push(value.count) });
  const entries = [1, 2, 3].map(index => ({ name: `${index}.png`, bytes: Uint8Array.of(index) }));
  await queue.add({ index: 0 }, entries[0].name);
  let admitted = false;
  const second = queue.add({ index: 1 }, entries[1].name).then(() => { admitted = true; });
  await tick(); resolvers[1](entries[1].bytes); await tick();
  assert.equal(admitted, false); assert.equal(queue.count, 0); assert.deepEqual(released, [1]);
  resolvers[0](entries[0].bytes); await second;
  assert.equal(queue.count, 1);
  const third = queue.add({ index: 2 }, entries[2].name); await tick(); await third;
  resolvers[2](entries[2].bytes);
  assert.deepEqual(await bytesOf(await queue.finish()), await bytesOf(createImageArchive(entries)));
  assert.deepEqual(progress, [1, 2, 3]); assert.equal(queue.bytes, 3);
  queue.dispose(); assert.deepEqual(released.sort(), [0, 1, 2]);
});

test('cancellation and disposal break a stalled encode wait without publishing and release every canvas once', async () => {
  for (const mode of ['abort', 'dispose']) {
    const controller = new AbortController(), released = [];
    const queue = new PngArchiveQueue({ signal: controller.signal, encode: () => new Promise(() => {}), release: canvas => released.push(canvas) });
    await queue.add(1, '1.png');
    const pending = queue.add(2, '2.png'), rejection = assert.rejects(pending, { name: 'AbortError' });
    if (mode === 'abort') controller.abort(); else queue.dispose();
    await rejection;
    assert.equal(queue.count, 0); queue.dispose(); assert.deepEqual(released.sort(), [1, 2]);
  }
});

test('a source replaced during the last PNG encode cannot publish its archive', async () => {
  let current = true, resolve, released = 0;
  const queue = new PngArchiveQueue({ encode: () => new Promise(done => { resolve = done; }), release: () => released++,
    checkCurrent: () => { if (!current) throw new DOMException('New source', 'AbortError'); } });
  await queue.add({}, '1.png');
  const finished = queue.finish(), rejection = assert.rejects(finished, { name: 'AbortError' });
  current = false; resolve(Uint8Array.of(4)); await rejection;
  assert.equal(queue.count, 0); queue.dispose(); assert.equal(released, 1);
});

test('a later failed encode is consumed before ordered commit and archive admission enforces the byte budget', async () => {
  let resolve;
  const queue = new PngArchiveQueue({ encode: canvas => canvas === 1 ? new Promise(done => { resolve = done; }) : Promise.reject(new Error('broken PNG')), release() {} });
  await queue.add(1, '1.png'); const second = queue.add(2, '2.png');
  await tick(); resolve(Uint8Array.of(1)); await second;
  await assert.rejects(queue.finish(), /broken PNG/); queue.dispose();
  const bounded = new PngArchiveQueue({ maxBytes: 110, encode: async () => ({ blob: new Blob([new Uint8Array(50)]), crc: 0 }), release() {} });
  await bounded.add({}, '1.png'); await assert.rejects(bounded.finish(), /exceeds 256 MiB/); bounded.dispose();
});
