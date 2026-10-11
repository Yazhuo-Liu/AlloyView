import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { SurfaceGeometryClient } from '../src/render/surface-geometry-client.js';
import { CpuBudget } from '../src/analysis/cpu-budget.js';
import { createCell } from '../src/data/model.js';
import { buildSurfaceDisplayMesh, displayMeshOpenEdges, displayMeshVolume } from '../src/render/surface-mesh-geometry.js';
import { createMeshExport } from '../src/io/mesh-export.js';
import { calculateSurfaceMesh } from '../src/analysis/surface-mesh.js';
import { fccBlock, periodicDistance, subsetFrame } from './helpers/surfaces.js';

const delay = () => new Promise(resolve => setTimeout(resolve, 0));
function box() {
  return { vertices: Float64Array.from([8,3,4, 2,3,4, 8,7,4, 2,7,4, 8,3,6, 2,3,6, 8,7,6, 2,7,6]),
    triangles: Uint32Array.from([[0,4,6,2],[1,3,7,5],[0,1,5,4],[2,6,7,3],[0,2,3,1],[4,5,7,6]].flatMap(([a,b,c,d]) => [a,b,c,a,c,d])) };
}
const cell = createCell({ vectors: [10,0,0,0,10,0,0,0,10] });
function factory(created, messages) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-surface-geometry-worker.mjs', import.meta.url));
    const adapter = {
      postMessage(data, transfer) { messages.push({ ...data, uploaded: Boolean(data.mesh), transfers: transfer?.length ?? 0 }); worker.postMessage(data, transfer); },
      terminate() { return worker.terminate(); },
    };
    worker.on('message', data => adapter.onmessage?.({ data }));
    worker.on('error', error => adapter.onerror?.(error));
    created.push(adapter); return adapter;
  };
}
function clientFor(t, { isolated = false } = {}) {
  const created = [], messages = [], cpuBudget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 3 } } });
  const client = new SurfaceGeometryClient({ cpuBudget, workerFactory: factory(created, messages),
    environment: { crossOriginIsolated: isolated, SharedArrayBuffer } });
  t.after(() => client.close()); return { client, created, messages, cpuBudget };
}

test('one retained geometry Worker prepares exact cuts, shares view results and exports without recopying source arrays', async t => {
  const { client, created, messages, cpuBudget } = clientFor(t), mesh = box();
  const original = mesh.vertices.slice(), topology = mesh.triangles.slice();
  const [first, second] = await Promise.all([client.prepare(mesh, cell), client.prepare(mesh, cell)]);
  assert.equal(first, second, 'main and second views share one completed result');
  assert.deepEqual(first.display, buildSurfaceDisplayMesh(mesh, cell));
  assert.equal(displayMeshOpenEdges(first.display), 0);
  assert.ok(Math.abs(displayMeshVolume(first.display) - 32) < 1e-10);
  for (let vertex = 0; vertex < first.display.vertexCount; vertex++) {
    assert.deepEqual(first.values.subarray(vertex * 6, vertex * 6 + 3), Float32Array.from(first.display.positions.subarray(vertex * 3, vertex * 3 + 3)));
    assert.deepEqual(first.values.subarray(vertex * 6 + 3, vertex * 6 + 6), first.display.normals.subarray(vertex * 3, vertex * 3 + 3));
  }
  for (const origin of [[.17,.2,.3], [.5,0,.5]]) {
    const actual = await client.prepare(mesh, cell, { origin });
    assert.deepEqual(actual.display, buildSurfaceDisplayMesh(mesh, cell, { origin }));
  }
  const options = { stem: 'worker-test', title: 'exact mesh', translation: [1,2,3] }, origin = [.17,.2,.3];
  for (const format of ['stl','ply','obj']) {
    const actual = await client.export(mesh, cell, { origin }, format, options);
    const expected = createMeshExport(buildSurfaceDisplayMesh(mesh, cell, { origin }), format, options);
    assert.equal(actual.filename, expected.filename);
    assert.deepEqual(new Uint8Array(await actual.blob.arrayBuffer()), new Uint8Array(await expected.blob.arrayBuffer()));
    assert.equal(actual.positions, undefined, 'only finished files and small metadata cross back for export');
  }
  assert.deepEqual(mesh.vertices, original); assert.deepEqual(mesh.triangles, topology);
  assert.equal(created.length, 1); assert.equal(messages.filter(data => data.uploaded).length, 1);
  assert.equal(cpuBudget.active, 0);
});

test('background warmup joins one retained module startup, allocates no source and cancelled closure cannot restart it', async t => {
  const { client, created, messages, cpuBudget } = clientFor(t);
  assert.equal(await client.warm(), true);
  assert.equal(await client.warm(), true);
  assert.equal(created.length, 1); assert.equal(client.sources.size, 0); assert.equal(messages.length, 0);
  await client.prepare(box(), cell); assert.equal(created.length, 1); assert.equal(cpuBudget.active, 0);
  const busy = await cpuBudget.acquire(1), waitingClient = new SurfaceGeometryClient({ cpuBudget, workerFactory: () => assert.fail('closed warmup must never allocate') });
  const pending = waitingClient.warm(); waitingClient.close();
  assert.equal(await pending, false); busy.release();
  assert.equal(cpuBudget.active, 0);
});

test('native FCC void geometry remains bit-identical and closed through Worker cap preparation and STL export', async t => {
  const { client } = clientFor(t);
  for (const repeat of [6,7]) {
    const block = fccBlock(repeat, 4), length = repeat * 4, center = [0,length / 2,0];
    const frame = subsetFrame(block, point => periodicDistance(point, center, length) > 6);
    const mesh = await calculateSurfaceMesh(frame, { radius: 3.5, smoothingLevel: 0 });
    const vertices = mesh.vertices.slice(), triangles = mesh.triangles.slice();
    for (const origin of [[0,0,0], [1 / repeat,2 / repeat,0], [.013,.017,.019]]) {
      const actual = await client.prepare(mesh, frame.cell, { origin });
      assert.deepEqual(actual.display, buildSurfaceDisplayMesh(mesh, frame.cell, { origin }));
      assert.equal(displayMeshOpenEdges(actual.display), 0);
      assert.ok(Math.abs(displayMeshVolume(actual.display) - mesh.filledVolume) < mesh.filledVolume * 1e-8);
      const file = await client.export(mesh, frame.cell, { origin }, 'stl', {}), bytes = await file.blob.arrayBuffer();
      const view = new DataView(bytes), count = view.getUint32(80, true), positions = new Float64Array(count * 9);
      for (let face = 0; face < count; face++) for (let component = 0; component < 9; component++) {
        positions[face * 9 + component] = view.getFloat32(84 + face * 50 + 12 + component * 4, true);
      }
      const exported = { positions, indices: Uint32Array.from({ length: count * 3 }, (_, i) => i), vertexCount: count * 3, surfaceIndexCount: count * 3 };
      assert.equal(displayMeshOpenEdges(exported), 0);
    }
    assert.deepEqual(mesh.vertices, vertices); assert.deepEqual(mesh.triangles, triangles);
  }
});

test('aborted queued geometry allocates nothing; posted cancellation retains its lease and reusable Worker until acknowledgement', async t => {
  const { client, created, messages, cpuBudget } = clientFor(t), mesh = box();
  const occupied = await cpuBudget.acquire(1);
  const queued = new AbortController(), request = client.prepare(mesh, cell, {}, { signal: queued.signal });
  queued.abort(); await assert.rejects(request, { name: 'AbortError' });
  assert.equal(created.length, 0); occupied.release();
  while (client.running) await delay();
  let resolveDispatch;
  const dispatched = new Promise(resolve => { resolveDispatch = resolve; });
  client.workerFactory = () => {
    const worker = { postMessage(data) { messages.push(data); if (data.type === 'prepare') resolveDispatch(data); }, terminate() {} };
    created.push(worker); return worker;
  };
  const controller = new AbortController(), active = client.prepare(mesh, cell, {}, { signal: controller.signal });
  const posted = await dispatched;
  controller.abort(); await assert.rejects(active, { name: 'AbortError' });
  assert.equal(cpuBudget.active, 1, 'permit is retained until the actual Worker finishes');
  const next = client.prepare(mesh, cell, { origin: [.1,0,0] });
  assert.equal(messages.filter(message => message.type === 'prepare').length, 1, 'one posted task gives backpressure');
  created[0].onmessage({ data: { id: posted.id, ok: true, sourceReady: true, result: {} } });
  while (messages.filter(message => message.type === 'prepare').length < 2) await delay();
  const second = messages.filter(message => message.type === 'prepare')[1];
  assert.equal(second.mesh, null, 'the cancelled job retained its uploaded source');
  const result = { display: buildSurfaceDisplayMesh(mesh, cell, { origin: [.1,0,0] }), values: new Float32Array() };
  created[0].onmessage({ data: { id: second.id, ok: true, sourceReady: true, result } });
  assert.equal(await next, result); assert.equal(cpuBudget.active, 0); assert.equal(created.length, 1);
});

test('one cancelled subscriber cannot abort the same recipe needed by another view', async t => {
  const { client, created, messages } = clientFor(t), mesh = box(), controller = new AbortController();
  const first = client.prepare(mesh, cell, {}, { signal: controller.signal }), second = client.prepare(mesh, cell);
  controller.abort(); await assert.rejects(first, { name: 'AbortError' });
  assert.deepEqual((await second).display, buildSurfaceDisplayMesh(mesh, cell));
  assert.equal(created.length, 1); assert.equal(messages.filter(message => message.type === 'prepare').length, 1);
});

test('source eviction is bounded while owned view meshes remain resident', async t => {
  const { client, messages } = clientFor(t), pinned = box(), release = client.retainSource(pinned, cell);
  await client.prepare(pinned, cell);
  for (let i = 0; i < 5; i++) await client.prepare(box(), cell);
  assert.equal(client.sources.size, 3, 'one displayed source and two recent unowned sources');
  assert.equal(messages.filter(message => message.type === 'drop').length, 3);
  const before = messages.filter(message => message.uploaded).length;
  await client.prepare(pinned, cell, { caps: false });
  assert.equal(messages.filter(message => message.uploaded).length, before);
  release(); assert.equal(client.sources.size, 2);
});

test('export-only geometry counts retained Worker buffers and the byte budget retires idle sources', async t => {
  const { client, messages } = clientFor(t), mesh = box(), release = client.retainSource(mesh, cell);
  client.retainedByteBudget = 1;
  await client.export(mesh, cell, {}, 'stl', {});
  const source = [...client.sources.values()][0];
  assert.ok(source.workerBytes > mesh.vertices.byteLength + mesh.triangles.byteLength, 'export preparation is included in actual retained bytes');
  assert.equal(client.sources.size, 1, 'an active view remains protected');
  release(); assert.equal(client.sources.size, 0);
  assert.equal(messages.at(-1).type, 'drop');
  await client.prepare(mesh, cell);
  assert.equal(messages.filter(message => message.uploaded).length, 2, 'a retired source is privately uploaded again');
  assert.equal(client.sources.size, 0, 'completed unowned geometry is retired under the small budget');
});

test('rapid obsolete edits remove queued jobs immediately rather than accumulating behind an active Worker', async t => {
  const { client, cpuBudget } = clientFor(t), mesh = box();
  const busy = await cpuBudget.acquire(1), first = new AbortController();
  const active = client.prepare(mesh, cell, {}, { signal: first.signal });
  for (let i = 0; i < 100; i++) {
    const controller = new AbortController(), pending = client.prepare(mesh, cell, { origin: [i / 101, .1, 0] }, { signal: controller.signal });
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(client.queue.length, 0, 'only the admitted task may remain');
  }
  first.abort(); await assert.rejects(active, { name: 'AbortError' }); busy.release();
  while (client.running) await delay();
  assert.equal(client.jobs.size, 0); assert.equal([...client.sources.values()][0].pending, 0);
});

test('shared-word cancellation interrupts topology and permits the same Worker to prepare the next recipe', async t => {
  const { client, created, messages } = clientFor(t, { isolated: true }), mesh = box();
  const controller = new AbortController();
  const makeWorker = client.workerFactory;
  client.workerFactory = () => {
    const worker = makeWorker(), post = worker.postMessage;
    worker.postMessage = (data, transfer) => { post(data, transfer); if (data.type === 'prepare') controller.abort(); };
    return worker;
  };
  await assert.rejects(client.prepare(mesh, cell, {}, { signal: controller.signal }), { name: 'AbortError' });
  client.workerFactory = makeWorker;
  const prepared = await client.prepare(mesh, cell, { origin: [.2,0,0] });
  assert.deepEqual(prepared.display, buildSurfaceDisplayMesh(mesh, cell, { origin: [.2,0,0] }));
  assert.equal(created.length, 1); assert.equal(messages.filter(message => message.uploaded).length, 1);
  assert.equal(Atomics.load(messages.find(message => message.cancelWord).cancelWord, 0), 1);
});
