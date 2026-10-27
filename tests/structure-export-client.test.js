import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { StructureExportClient } from '../src/io/structure-export-client.js';
import { createStructureExport } from '../src/io/structure-export.js';
import { parsePoscar } from '../src/io/poscar.js';
import { CpuBudget } from '../src/shared/cpu-budget.js';

const frame = () => parsePoscar('crystal\n1\n4 0 0\n0 4 0\n0 0 4\nFe O\n1 1\nDirect\n0 0 0\n0.123456789012345 0.5 0.5\n');
const budget = () => new CpuBudget({ environment: { navigator: { hardwareConcurrency: 3 } } });
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a Worker state.');
    await new Promise(resolve => setImmediate(resolve));
  }
}

class FakeWorker {
  constructor() { this.listeners = new Map(); this.messages = []; this.terminated = false; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  postMessage(message, transfer) {
    if (this.throwPost) throw new Error('post failed');
    this.messages.push(structuredClone(message, { transfer }));
  }
  emit(type, value) { for (const callback of this.listeners.get(type) ?? []) callback(value); }
  reply(message = this.messages.findLast(entry => entry.type !== 'cancel'), result = { blob: new Blob(['export']), filename: 'crystal.cif', format: 'cif', atomCount: 2 }) {
    this.emit('message', { data: { id: message.id, ok: true, snapshotId: message.snapshotId, result } });
  }
  terminate() { this.terminated = true; }
}

function realFactory(instances) {
  return () => {
    const worker = new NodeWorker(new URL('./helpers/node-structure-export-worker.mjs', import.meta.url), { type: 'module' });
    const instance = { worker, posts: [], terminate: () => worker.terminate(),
      addEventListener(type, callback) {
        worker.on(type, value => callback(type === 'message' ? { data: value } : value));
      },
      postMessage(message, transfer) {
        this.posts.push({ type: message.type, id: message.id, snapshot: !!message.snapshot,
          properties: message.snapshot?.properties.map(property => property.name), transferCount: transfer?.length ?? 0 });
        worker.postMessage(message, transfer);
      } };
    instances.push(instance); return instance;
  };
}

test('real structure formatter Worker preserves source buffers, caches only minimal data and survives source clearing', async t => {
  const instances = [], cpuBudget = budget();
  const client = new StructureExportClient({ cpuBudget, workerFactory: realFactory(instances) });
  t.after(() => client.dispose());
  const source = frame(), before = structuredClone(source);
  source.properties.push({ name: 'irrelevantAnalysis', get data() { throw new Error('Analysis buffers must not be inspected.'); } });
  Object.defineProperty(source, 'analysisCache', { get() { throw new Error('A full frame cannot be cloned.'); }, enumerable: true });
  for (const format of ['cif', 'poscar']) {
    const exported = await client.export(source, { format, stem: 'test' });
    const expected = createStructureExport(source, { format, stem: 'test' });
    assert.equal(await exported.blob.text(), await expected.blob.text());
    assert.equal(exported.atomCount, 2);
  }
  assert.deepEqual(source.fractional, before.fractional);
  assert.deepEqual(source.positions, before.positions);
  assert.deepEqual(source.types, before.types);
  assert.equal(cpuBudget.active, 0);
  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0].posts.map(post => post.snapshot), [true, false]);
  assert.deepEqual(instances[0].posts[0].properties, []);
  assert.ok(!client.cached.key.includes(source), 'The cache key must not retain the full analysis frame.');
  await client.clearSnapshot();
  await client.export(source);
  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0].posts.map(post => post.type), ['export', 'export', 'clear', 'export']);
  assert.equal(instances[0].posts.at(-1).snapshot, true);
});

test('shared source arrays are privately copied and transfer errors release admission before retry', async t => {
  const cpuBudget = budget(), workers = [];
  const client = new StructureExportClient({ cpuBudget, workerFactory: () => {
    const worker = new FakeWorker(); if (!workers.length) worker.throwPost = true;
    workers.push(worker); return worker;
  } });
  t.after(() => client.dispose());
  const source = frame(), original = source.fractional;
  source.fractional = new Float64Array(new SharedArrayBuffer(original.byteLength)); source.fractional.set(original);
  await assert.rejects(client.export(source), /post failed/);
  assert.equal(cpuBudget.active, 0); assert.equal(workers[0].terminated, true);
  const next = client.export(source);
  await until(() => workers[1]?.messages.length === 1);
  assert.ok(workers[1].messages[0].snapshot.fractional.buffer instanceof ArrayBuffer);
  assert.deepEqual(workers[1].messages[0].snapshot.fractional, source.fractional);
  assert.deepEqual(source.fractional, original);
  workers[1].reply(); await next;
  assert.equal(cpuBudget.active, 0);
});

test('constructor failure and failed source cleanup do not strand reservations or subsequent exports', async t => {
  const cpuBudget = budget(), worker = new FakeWorker();
  let attempts = 0;
  const client = new StructureExportClient({ cpuBudget, workerFactory: () => {
    if (!attempts++) throw new Error('constructor failed'); return worker;
  } });
  t.after(() => client.dispose());
  await assert.rejects(client.export(frame()), /constructor failed/);
  assert.equal(cpuBudget.active, 0);
  const next = client.export(frame()); await until(() => worker.messages.length === 1);
  worker.reply(); await next;
  const clear = client.clearSnapshot();
  worker.emit('error', { message: 'formatter Worker failed during cleanup' });
  await clear;
  assert.equal(cpuBudget.active, 0); assert.equal(worker.terminated, true);
});

test('snapshot revisions, replaced property data and edited cell values invalidate retained inputs', async t => {
  const instances = [], client = new StructureExportClient({ workerFactory: realFactory(instances) });
  t.after(() => client.dispose());
  const source = frame();
  source.properties.push({ name: 'occupancy', data: new Float64Array([1, 1]) });
  await client.export(source);
  source.fractional[0] = 0.125; source.geometryRevision = 1;
  assert.match(await (await client.export(source)).blob.text(), /Fe1 Fe 0.125 0 0 1/);
  source.properties[0].data = new Float64Array([0.5, 1]);
  assert.match(await (await client.export(source)).blob.text(), /Fe1 Fe 0.125 0 0 0.5/);
  source.cell.vectors[0] = 8;
  assert.match(await (await client.export(source)).blob.text(), /_cell_length_a 8\n/);
  assert.ok(instances[0].posts.every(post => post.snapshot));
  await assert.rejects(client.export(source, { format: 'poscar' }), /partial or unknown occupancy/);
  await client.export(source, { format: 'cif' });
  assert.equal(instances[0].posts.at(-1).snapshot, false);
});

test('posted cancellation retains its CPU lease until ACK and does not dispatch queued downloads early', async t => {
  const worker = new FakeWorker(), cpuBudget = budget();
  const client = new StructureExportClient({ cpuBudget, workerFactory: () => worker });
  t.after(() => client.dispose());
  const abort = new AbortController(), first = client.export(frame(), {}, { signal: abort.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await until(() => worker.messages.length === 1);
  const second = client.export(frame());
  abort.abort(); await rejected;
  assert.equal(cpuBudget.active, 1);
  assert.deepEqual(worker.messages.map(message => message.type), ['export', 'cancel']);
  worker.reply(worker.messages[0]);
  await until(() => worker.messages.filter(message => message.type === 'export').length === 2);
  assert.equal(cpuBudget.active, 1);
  worker.reply(); await second;
  assert.equal(cpuBudget.active, 0);
  assert.equal(worker.terminated, false);
});

test('queued aborts and canceled budget admission allocate no Worker or snapshot', async t => {
  const cpuBudget = budget(), lease = await cpuBudget.acquire(1);
  let constructions = 0;
  const client = new StructureExportClient({ cpuBudget, workerFactory: () => { constructions++; return new FakeWorker(); } });
  t.after(() => { lease.release(); client.dispose(); });
  const firstAbort = new AbortController(), secondAbort = new AbortController();
  const first = client.export(frame(), {}, { signal: firstAbort.signal });
  const second = client.export(frame(), {}, { signal: secondAbort.signal });
  const firstRejected = assert.rejects(first, { name: 'AbortError' }), secondRejected = assert.rejects(second, { name: 'AbortError' });
  secondAbort.abort(); firstAbort.abort();
  await Promise.all([firstRejected, secondRejected]);
  await until(() => !client.active);
  assert.equal(constructions, 0);
  assert.equal(cpuBudget.queue.length, 0);
  assert.equal(cpuBudget.active, 1);
  lease.release();
});

test('source reset rejects obsolete active/queued exports, orders its clear barrier and keeps the warmed Worker', async t => {
  const worker = new FakeWorker(), cpuBudget = budget();
  const client = new StructureExportClient({ cpuBudget, workerFactory: () => worker });
  t.after(() => client.dispose());
  const first = client.export(frame()), rejectedFirst = assert.rejects(first, { name: 'AbortError' });
  await until(() => worker.messages.length === 1);
  const second = client.export(frame()), rejectedSecond = assert.rejects(second, { name: 'AbortError' });
  const cleared = client.clearSnapshot(), next = client.export(frame());
  await Promise.all([rejectedFirst, rejectedSecond]);
  assert.equal(cpuBudget.active, 1);
  worker.reply(worker.messages[0]);
  await until(() => worker.messages.at(-1).type === 'clear');
  assert.equal(cpuBudget.active, 0);
  worker.reply(); await cleared;
  await until(() => worker.messages.at(-1).type === 'export');
  assert.ok(worker.messages.at(-1).snapshot);
  worker.reply(); await next;
  assert.equal(worker.terminated, false);
  assert.equal(cpuBudget.active, 0);
});

for (const event of ['error', 'messageerror', 'malformed']) test(`${event} retires the damaged formatter, frees its lease and permits queued recovery`, async t => {
  const workers = [], cpuBudget = budget();
  const client = new StructureExportClient({ cpuBudget, workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  t.after(() => client.dispose());
  const first = client.export(frame()), rejected = assert.rejects(first, /formatter Worker/);
  await until(() => workers[0]?.messages.length === 1);
  const next = client.export(frame());
  if (event === 'malformed') workers[0].emit('message', { data: { id: workers[0].messages[0].id, ok: true, result: {} } });
  else workers[0].emit(event, { message: 'formatter Worker crashed' });
  await rejected;
  await until(() => workers[1]?.messages.length === 1);
  assert.equal(workers[0].terminated, true);
  workers[0].reply(); // A late result from the retired Worker cannot settle the new task.
  assert.equal(cpuBudget.active, 1);
  workers[1].reply(); await next;
  assert.equal(cpuBudget.active, 0);
});

test('disposal releases active and queued work, and a stalled Worker is bounded by a deadline', async () => {
  const cpuBudget = budget(), worker = new FakeWorker();
  const client = new StructureExportClient({ cpuBudget, workerFactory: () => worker });
  const first = client.export(frame()), firstRejected = assert.rejects(first, { name: 'AbortError' });
  await until(() => worker.messages.length === 1);
  const second = client.export(frame()), secondRejected = assert.rejects(second, { name: 'AbortError' });
  client.dispose(); await Promise.all([firstRejected, secondRejected]);
  assert.equal(cpuBudget.active, 0); assert.equal(worker.terminated, true);
  await assert.rejects(client.export(frame()), { name: 'AbortError' });
  const stalled = new FakeWorker(), timeoutClient = new StructureExportClient({ cpuBudget, workerFactory: () => stalled, timeoutMs: 10 });
  await assert.rejects(timeoutClient.export(frame()), /timed out/);
  assert.equal(cpuBudget.active, 0); assert.equal(stalled.terminated, true);
  timeoutClient.dispose();
});

test('polyhedra CSV exports complete-precision scalar rows without copying hull geometry', async t => {
  const instances = [], client = new StructureExportClient({ workerFactory: realFactory(instances) });
  t.after(() => client.dispose());
  const source = frame(); source.ids = ['atom,"a"\n', 'b'];
  const cell = { atomIndex: 0, coordination: 6, volume: 12.123456789012345, surfaceArea: 25.987654321,
    bondLengthMin: 1.1, bondLengthMax: 2.2, bondLengthMean: 1.23456789012345,
    get vertices() { throw new Error('Do not copy hull geometry.'); } };
  const result = await client.exportPolyhedra(source, { cells: [cell], get geometry() { throw new Error('Do not clone the analysis result.'); } }, { stem: 'test' });
  assert.equal(result.filename, 'test-polyhedra.csv'); assert.equal(result.cellCount, 1);
  const csv = await result.blob.text();
  assert.match(csv, /volume_A3,surface_area_A2,bond_length_min_A,bond_length_max_A,bond_length_mean_A/);
  assert.ok(csv.includes('0,"atom,""a""\n",Fe,6,12.123456789012344,25.987654321,1.1,2.2,1.23456789012345\r\n'));
  await assert.rejects(client.exportPolyhedra(source, { cells: [cell] }, { maxBytes: 20 }), /text budget/);
  assert.equal(instances.length, 1);
});

test('a large real formatter yields to cancellation and the same Worker serves the following export', async t => {
  const instances = [], cpuBudget = budget();
  const client = new StructureExportClient({ cpuBudget, workerFactory: realFactory(instances) });
  t.after(() => client.dispose());
  await client.export(frame());
  const large = frame(), count = 200_000;
  large.types = new Uint32Array(count); large.positions = new Float64Array(count * 3);
  large.fractional = new Float64Array(count * 3);
  const abort = new AbortController();
  const pending = client.export(large, {}, { signal: abort.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await until(() => instances[0].posts.length === 2);
  abort.abort(); await rejected;
  const next = await client.export(frame(), { format: 'poscar' });
  assert.equal(next.format, 'poscar'); assert.equal(instances.length, 1);
  assert.equal(cpuBudget.active, 0);
});
