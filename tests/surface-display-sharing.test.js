import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { CpuBudget } from '../src/shared/cpu-budget.js';
import { createCell } from '../src/data/model.js';
import { SurfaceGeometryClient } from '../src/render/surface-geometry-client.js';
import { SurfaceMeshLayer } from '../src/render/surface-mesh-layer.js';
import { buildSurfaceDisplayMesh } from '../src/render/surface-mesh-geometry.js';

const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
function crossingBox() {
  return { vertices: Float64Array.from([8,3,4, 2,3,4, 8,7,4, 2,7,4, 8,3,6, 2,3,6, 8,7,6, 2,7,6]),
    triangles: Uint32Array.from([[0,4,6,2],[1,3,7,5],[0,1,5,4],[2,6,7,3],[0,2,3,1],[4,5,7,6]]
      .flatMap(([a,b,c,d]) => [a,b,c,a,c,d])) };
}
function context() {
  const uploads = [];
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, ARRAY_BUFFER: 3, ELEMENT_ARRAY_BUFFER: 4, STATIC_DRAW: 5, FLOAT: 6,
    COMPILE_STATUS: 7, LINK_STATUS: 8,
    createProgram: () => ({}), createShader: () => ({}), shaderSource() {}, compileShader() {},
    getShaderParameter: () => true, attachShader() {}, deleteShader() {}, linkProgram() {}, getProgramParameter: () => true,
    getUniformLocation: () => ({}), createVertexArray: () => ({}), createBuffer: () => ({}), bindVertexArray() {},
    bindBuffer() {}, bufferData(target, values) { uploads.push({ target, values }); },
    enableVertexAttribArray() {}, vertexAttribPointer() {},
  };
  return { gl, uploads };
}
function clientFor(t) {
  const messages = [], workers = [], cpuBudget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 3 } } });
  const client = new SurfaceGeometryClient({ cpuBudget, workerFactory() {
    const worker = new Worker(new URL('./helpers/node-surface-geometry-worker.mjs', import.meta.url));
    const adapter = { postMessage(data, transfer) { messages.push(data); worker.postMessage(data, transfer); },
      terminate: () => worker.terminate() };
    worker.on('message', data => adapter.onmessage?.({ data }));
    worker.on('error', error => adapter.onerror?.(error));
    workers.push(adapter); return adapter;
  } });
  t.after(() => client.close());
  return { client, messages, workers, cpuBudget };
}
function view(client) {
  const { gl, uploads } = context(), layer = new SurfaceMeshLayer(gl, { geometryClient: client });
  const renderer = { frame: { cell }, periodicOrigin: [0,0,0], coordinateMode: 'wrapped', surfaceMeshLayer: layer,
    updateSceneBounds() {}, requestRender() {} };
  return { renderer, layer, uploads };
}

test('real geometry Worker shares exact Surface and DXA meshes and packed uploads between separate GL views', async t => {
  const { client, messages, workers, cpuBudget } = clientFor(t), main = view(client), second = view(client);
  const meshes = [['surface', crossingBox()], ['dxaDefect', { ...crossingBox(), reverse: true }]];
  for (const [id, mesh] of meshes) {
    const first = main.layer.setMesh(main.renderer, id, mesh), other = second.layer.setMesh(second.renderer, id, mesh);
    await Promise.all([main.layer.ready(), second.layer.ready()]);
    assert.equal(first.display, other.display, 'the complete CPU display mesh is shared');
    assert.deepEqual(first.display, buildSurfaceDisplayMesh(mesh, cell, { reverse: Boolean(mesh.reverse) }));
    assert.equal(main.uploads.at(-2).values, second.uploads.at(-2).values, 'one packed Float32 allocation feeds both uploads');
    assert.equal(main.uploads.at(-1).values, second.uploads.at(-1).values, 'one immutable topology feeds both uploads');
    assert.notEqual(first.buffer, other.buffer, 'GL contexts retain independent device storage');
    assert.notEqual(first.indexBuffer, other.indexBuffer);
    assert.equal(mesh.vertices.byteLength, 192, 'canonical source arrays remain owned by the analysis');
  }
  assert.equal(messages.filter(message => message.type === 'prepare').length, 2, 'one geometry preparation per source');
  assert.equal(messages.filter(message => message.mesh).length, 2, 'one private upload per source');
  assert.equal(workers.length, 1);
  assert.equal(cpuBudget.active, 0);
  for (const [id, mesh] of meshes) {
    main.layer.setMesh(main.renderer, id, mesh, { color: '#e1a345', opacity: .5, visible: false });
    second.layer.setMesh(second.renderer, id, mesh, { color: '#10baca' });
  }
  assert.equal(messages.filter(message => message.type === 'prepare').length, 2, 'appearance edits use the shared existing mesh');
  main.renderer.periodicOrigin = second.renderer.periodicOrigin = [.17,.2,.3];
  main.layer.refresh(main.renderer); second.layer.refresh(second.renderer);
  await Promise.all([main.layer.ready(), second.layer.ready()]);
  assert.equal(messages.filter(message => message.type === 'prepare').length, 4, 'a new recipe is prepared once per mesh');
  assert.equal(messages.filter(message => message.mesh).length, 2, 'origin edits reuse private source uploads');
  for (const [id, mesh] of meshes) {
    const first = main.layer.entries.get(id), other = second.layer.entries.get(id);
    assert.equal(first.display, other.display);
    assert.deepEqual(first.display, buildSurfaceDisplayMesh(mesh, cell, { origin: [.17,.2,.3], reverse: Boolean(mesh.reverse) }));
  }
  // A replaced GL layer can adopt the completed snapshot without a new Worker
  // message or source upload; its own GL buffers still have to be restored.
  second.layer.detach();
  const restored = view(client); restored.renderer.periodicOrigin = [.17,.2,.3];
  for (const [id, mesh] of meshes) restored.layer.setMesh(restored.renderer, id, mesh);
  await restored.layer.ready();
  assert.equal(messages.filter(message => message.type === 'prepare').length, 4);
  assert.equal(restored.uploads.length, 4);
  assert.equal(restored.layer.entries.get('surface').display, main.layer.entries.get('surface').display);
});

test('clearing one pending GL view suppresses its upload while another view completes the shared job', async t => {
  const { client, messages, cpuBudget } = clientFor(t), mesh = crossingBox(), main = view(client), second = view(client);
  const first = main.layer.setMesh(main.renderer, 'surface', mesh), other = second.layer.setMesh(second.renderer, 'surface', mesh);
  main.layer.clear(); const clears = main.uploads.length;
  await second.layer.ready(); await first.ready;
  assert.equal(first.display, null);
  assert.equal(main.uploads.length, clears, 'a late result cannot upload into a cleared GL layer');
  assert.deepEqual(other.display, buildSurfaceDisplayMesh(mesh, cell));
  assert.equal(second.uploads.length, 2);
  assert.equal(messages.filter(message => message.type === 'prepare').length, 1);
  assert.equal(messages.filter(message => message.type === 'cancel').length, 0);
  assert.equal(cpuBudget.active, 0);
});

test('geometry retention counts full backing allocations and analysis metadata once across mesh/cell recipes', t => {
  const { client } = clientFor(t), mesh = crossingBox();
  const storage = new ArrayBuffer(8192), vertices = new Float64Array(storage, 0, mesh.vertices.length);
  vertices.set(mesh.vertices); mesh.vertices = vertices;
  const metadata = new ArrayBuffer(4096);
  mesh.vertexAtoms = new Uint32Array(metadata, 0, 8);
  mesh.faceRegions = new Uint32Array(metadata, 32, 12);
  mesh.metadata = new Map([['again', new Set([mesh.vertexAtoms, mesh.faceRegions, mesh])]]);
  const secondCell = createCell({ vectors: cell.vectors });
  const releaseMain = client.retainSource(mesh, cell), releaseSecond = client.retainSource(mesh, secondCell);
  const source = [...client.sources.values()][0];
  const meshBytes = storage.byteLength + metadata.byteLength + mesh.triangles.buffer.byteLength;
  const cellBytes = cell.origin.buffer.byteLength + cell.vectors.buffer.byteLength;
  assert.equal(client.sourceBytes(source), meshBytes + cellBytes);
  assert.equal(client.retainedBytes(), meshBytes + cellBytes * 2, 'the same mesh and metadata allocations are shared by both source descriptors');
  client.retainedByteBudget = 2048;
  releaseMain();
  assert.equal(client.sources.size, 1, 'one active view remains protected');
  assert.equal(client.retainedBytes(), meshBytes + cellBytes);
  releaseSecond();
  assert.equal(client.sources.size, 0, 'unowned geometry cannot bypass the byte budget using sliced buffers or nested analysis metadata');
  assert.equal(client.retainedBytes(), 0);
});

test('explicit mesh revisions, array replacement and small cell edits invalidate shared preparation without vertex scans', async t => {
  const { client, messages, workers } = clientFor(t), mesh = crossingBox(), main = view(client), second = view(client);
  const localCell = createCell({ vectors: cell.vectors });
  main.renderer.frame.cell = second.renderer.frame.cell = localCell;
  const show = async () => {
    const first = main.layer.setMesh(main.renderer, 'surface', mesh), other = second.layer.setMesh(second.renderer, 'surface', mesh);
    await Promise.all([main.layer.ready(), second.layer.ready()]);
    assert.equal(first.display, other.display);
    assert.deepEqual(first.display, buildSurfaceDisplayMesh(mesh, localCell, { reverse: Boolean(mesh.reverse) }));
    return first.display;
  };
  const initial = await show();
  for (let i = 0; i < mesh.vertices.length; i += 3) mesh.vertices[i + 1] += .25;
  mesh.geometryRevision = 1;
  const edited = await show();
  assert.notDeepEqual(edited.positions, initial.positions);
  assert.equal(messages.filter(message => message.mesh).length, 2);
  mesh.reverse = true;
  await show();
  assert.equal(messages.filter(message => message.mesh).length, 2, 'a recipe flag reuses its original private geometry inputs');
  mesh.vertices = mesh.vertices.slice();
  await show();
  assert.equal(messages.filter(message => message.mesh).length, 3, 'array replacement needs no explicit revision');
  localCell.vectors[4] = 11;
  await show();
  assert.equal(messages.filter(message => message.mesh).length, 4, 'in-place cell changes invalidate geometry using its small numeric descriptor');
  assert.equal(messages.filter(message => message.type === 'prepare').length, 5);
  assert.equal(workers.length, 1);
  for (const geometryRevision of [-1, .5, Infinity, NaN]) {
    assert.throws(() => main.layer.setMesh(main.renderer, 'surface', { ...mesh, geometryRevision }), /geometryRevision/);
  }
});

test('an obsolete posted mesh revision cannot publish or cache and its ACK admits a fresh revision on the same Worker', async t => {
  const messages = [], cpuBudget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 3 } } });
  let adapter, dispatched;
  let posted = new Promise(resolve => { dispatched = resolve; });
  const client = new SurfaceGeometryClient({ cpuBudget, workerFactory() {
    return adapter = { postMessage(data) { messages.push(data); if (data.type === 'prepare') dispatched(data); }, terminate() {} };
  } });
  t.after(() => client.close());
  const mesh = crossingBox(), obsolete = client.prepare(mesh, cell);
  const first = await posted;
  const rejection = assert.rejects(obsolete, { name: 'AbortError' });
  mesh.vertices[1] += .25; mesh.geometryRevision = 1;
  posted = new Promise(resolve => { dispatched = resolve; });
  const current = client.prepare(mesh, cell);
  assert.equal(cpuBudget.active, 1);
  const oldDisplay = buildSurfaceDisplayMesh(first.mesh, cell);
  adapter.onmessage({ data: { id: first.id, ok: true, sourceReady: true,
    result: { display: oldDisplay, values: new Float32Array(oldDisplay.vertexCount * 6) } } });
  await rejection;
  const fresh = await posted;
  assert.notEqual(fresh.sourceId, first.sourceId);
  assert.ok(fresh.mesh, 'a new revision uploads a fresh private source');
  assert.equal(fresh.mesh.vertices[1], mesh.vertices[1]);
  const display = buildSurfaceDisplayMesh(fresh.mesh, cell), result = { display, values: new Float32Array(display.vertexCount * 6) };
  adapter.onmessage({ data: { id: fresh.id, ok: true, sourceReady: true, result } });
  assert.equal(await current, result);
  assert.equal(cpuBudget.active, 0);
  assert.equal([...client.sources.values()].find(source => source.id === first.sourceId).cache.size, 0);
  assert.equal(await client.prepare(mesh, cell), result);
  assert.equal(messages.filter(message => message.type === 'prepare').length, 2);
});

test('repeated appearance edits and retained-byte reads do not revisit mesh metadata', async t => {
  const { client } = clientFor(t), mesh = crossingBox(), main = view(client);
  let metadataReads = 0;
  const metadata = new Uint8Array(4096);
  Object.defineProperty(mesh, 'metadata', { enumerable: true, get() { metadataReads++; return metadata; } });
  main.layer.setMesh(main.renderer, 'surface', mesh); await main.layer.ready();
  const reads = metadataReads, retained = client.retainedBytes(), source = [...client.sources.values()][0];
  assert.ok(reads > 0);
  for (let i = 0; i < 200; i++) {
    main.layer.setMesh(main.renderer, 'surface', mesh, { opacity: (i % 10) / 10 });
    assert.equal(client.retainedBytes(), retained);
    assert.ok(client.sourceBytes(source) >= metadata.byteLength);
    assert.equal(await client.prepare(mesh, cell), source.cache.values().next().value);
  }
  assert.equal(metadataReads, reads, 'hot appearance/cache-hit paths read cached resource accounting');
  main.layer.setMesh(main.renderer, 'surface', mesh, { caps: false }); await main.layer.ready();
  assert.equal(metadataReads, reads + 1, 'one cache-content update refreshes accounting once');
});
