import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { calculateIsosurface, calculateVolumeSlice, calculateIsosurfaceAsync, volumeSliceCsvSteps } from '../src/analysis/volumetric.js';
import { VolumetricClient } from '../src/analysis/volumetric-client.js';
import { CpuBudget } from '../src/analysis/cpu-budget.js';
import { runParserSteps } from '../src/io/cooperative-parser.js';

function grid(dimensions = [3, 3, 3], fn = x => x, extras = {}) {
  const [nx, ny, nz] = dimensions, values = new Float64Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) values[x + nx * (y + ny * z)] = fn(x, y, z);
  return { dimensions, values, origin: new Float64Array([0, 0, 0]), steps: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), periodic: [false, false, false], unit: 'e/Å³', ...extras };
}
const close = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function factory(created, onDispatch = () => {}) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-volumetric-worker.mjs', import.meta.url)); created.push(worker);
    return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfer) { worker.postMessage(data, transfer); onDispatch(data); }, terminate() { return worker.terminate(); } };
  };
}

test('marching tetrahedra extracts an exact plane with outward normals and no spurious constant-field surfaces', () => {
  for (const level of [0.25, 1, 1.75, 2]) {
    const result = calculateIsosurface(grid(), { level }); close(result.statistics.surfaceArea, 4);
    for (let offset = 0; offset < result.vertices.length; offset += 9) {
      const v = result.vertices; close(v[offset], level); close(v[offset + 3], level); close(v[offset + 6], level);
      const nx = (v[offset + 4] - v[offset + 1]) * (v[offset + 8] - v[offset + 2]) - (v[offset + 5] - v[offset + 2]) * (v[offset + 7] - v[offset + 1]);
      assert.ok(nx < 0);
    }
  }
  assert.equal(calculateIsosurface(grid(), { level: 0 }).triangleCount, 0, 'all samples at or above level are inside');
  for (const level of [-1, 0, 1]) assert.equal(calculateIsosurface(grid([2, 2, 2], () => 0), { level }).triangleCount, 0);
});

test('periodic final voxels wrap values while retaining their unwrapped physical coordinates', () => {
  const source = grid([2, 2, 2], x => x, { periodic: [true, false, false] });
  const result = calculateIsosurface(source, { level: 0.5 }); close(result.statistics.surfaceArea, 2);
  assert.deepEqual([...new Set(Array.from(result.vertices).filter((_, i) => i % 3 === 0))].sort(), [0.5, 1.5]);
  assert.equal(calculateIsosurface(grid([1, 3, 3]), { level: 0 }).triangleCount, 0);
});

test('skew steps, reversed handedness, translations and disjoint ranges preserve geometry and surface area', () => {
  const source = grid([4, 3, 3], x => x, { origin: new Float64Array([1e7, -10, 4]), steps: new Float64Array([-2, 0, 0, 0.4, 3, 0, 0.2, 0.5, 4]) });
  const all = calculateIsosurface(source, { level: 1.25 });
  close(all.statistics.surfaceArea, 4 * Math.hypot(12, -1.6, -0.4), 1e-8);
  const first = calculateIsosurface(source, { level: 1.25, startCell: 0, endCell: 5 });
  const last = calculateIsosurface(source, { level: 1.25, startCell: 5 });
  assert.deepEqual(Array.from(all.vertices), [...first.vertices, ...last.vertices]);
  close(all.statistics.surfaceArea, first.statistics.surfaceArea + last.statistics.surfaceArea);
});

test('slices interpolate in fractional grid coordinates and preserve exact physical CSV coordinates', async () => {
  const source = grid([3, 4, 2], (x, y, z) => x + 2 * y + 10 * z, { periodic: [true, false, false], origin: [3, 5, 7], steps: [1, 0, 0, 1, 2, 0, 0, 0, 3] });
  const slice = calculateVolumeSlice(source, { axis: 0, index: 1.5 });
  assert.deepEqual(slice.axes, [1, 2]); assert.equal(slice.width, 4); assert.equal(slice.height, 2);
  assert.deepEqual([...slice.values], [1.5, 3.5, 5.5, 7.5, 11.5, 13.5, 15.5, 17.5]); close(slice.statistics.mean, 9.5);
  assert.deepEqual([...slice.origin], [4.5, 5, 7]);
  const seam = calculateVolumeSlice(source, { axis: 0, index: 3 }); assert.equal(seam.values[0], 0); assert.equal(seam.origin[0], 6);
  assert.throws(() => calculateVolumeSlice(source, { axis: 1, index: 4 }), /within/);
  const csv = runParserSteps(volumeSliceCsvSteps(slice, { stem: '../charge density' }));
  assert.equal(csv.filename, 'charge_density-slice.csv');
  assert.match(await csv.blob.text(), /1,0,5.5,7,7,3.5,"e\/Å³"/);
});

test('invalid grids, finite precision limits and triangle budgets reject before returning incomplete surfaces', () => {
  const source = grid(); source.values[2] = NaN;
  assert.throws(() => calculateIsosurface(source, { level: 0.5 }), /finite/);
  assert.throws(() => calculateIsosurface(grid(), { level: 0.5, maxTriangles: 1 }), /triangle budget/);
  assert.throws(() => calculateIsosurface(grid(), { level: Infinity }), /finite/);
  assert.throws(() => calculateIsosurface(grid(), { level: 0.5, endCell: 100 }), /range/);
});

test('CPU async kernels yield for cancellation without returning partial geometry', async () => {
  const controller = new AbortController();
  const pending = calculateIsosurfaceAsync(grid([50, 50, 50], (x, y, z) => x + y + z), { level: 60 }, { signal: controller.signal, budgetMs: 0 });
  setImmediate(() => controller.abort()); await assert.rejects(pending, { name: 'AbortError' });
});

for (const shared of [false, true]) test(`retained parallel volume Workers equal the direct kernel and reuse ${shared ? 'shared' : 'private'} grids`, async t => {
  const created = [], environment = { navigator: { hardwareConcurrency: 6 }, crossOriginIsolated: shared };
  const budget = new CpuBudget({ environment });
  const client = new VolumetricClient({ environment, cpuBudget: budget, createWorker: factory(created), cellsPerWorker: 1000, chunkCells: 300 });
  t.after(() => client.dispose());
  const source = grid([18, 17, 16], (x, y, z) => x + 0.3 * y + 0.2 * z);
  await client.prepare(source); assert.equal(created.length, 4); assert.equal(budget.active, 0);
  const result = await client.analyze(source, { level: 10 });
  const direct = calculateIsosurface(source, { level: 10 });
  assert.deepEqual(result.vertices, direct.vertices); assert.deepEqual(result.triangles, direct.triangles);
  close(result.statistics.surfaceArea, direct.statistics.surfaceArea, 1e-8);
  assert.equal(result.workerCount, 4); assert.equal(result.gridUploads, 0); assert.equal(result.sharedMemory, shared);
  assert.equal(result.renderGeometry.positions.length, result.vertices.length); assert.ok(result.renderGeometry.normals.every(Number.isFinite));
  assert.equal(source.values.length, 18 * 17 * 16);
  const slice = await client.analyze(source, { kind: 'slice', axis: 2, index: 3.5 });
  assert.deepEqual(slice.values, calculateVolumeSlice(source, { axis: 2, index: 3.5 }).values);
  const csv = await client.exportSliceCsv(slice, { stem: 'charge' }); assert.equal((await csv.blob.text()).split('\r\n').length, slice.values.length + 2);
  await client.clear(); assert.equal(created.length, 4); assert.equal(budget.active, 0);
  const again = await client.analyze(source, { level: 10 }); assert.equal(again.gridUploads, 4); assert.equal(created.length, 4);
});

test('running cancellation retains the Workers and releases CPU permits only after acknowledgement', async t => {
  let resolveDispatch; const dispatched = new Promise(resolve => { resolveDispatch = resolve; });
  const created = [], environment = { navigator: { hardwareConcurrency: 4 } }, budget = new CpuBudget({ environment });
  const client = new VolumetricClient({ environment, cpuBudget: budget, cellsPerWorker: 1000,
    createWorker: factory(created, data => { if (data.type === 'analyze') resolveDispatch(); }) });
  t.after(() => client.dispose());
  const source = grid([36, 36, 36], (x, y, z) => x + y + z); await client.prepare(source);
  const controller = new AbortController(), pending = client.analyze(source, { level: 40 }, { signal: controller.signal });
  await dispatched; controller.abort(); assert.ok(budget.active > 0);
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(budget.active, 0);
  const count = created.length, result = await client.analyze(source, { kind: 'slice', axis: 2, index: 4 });
  assert.equal(result.values[0], 4); assert.equal(created.length, count);
});

test('GPU unavailability falls back to pure CPU and no-Worker mode remains functional', async t => {
  const created = [], client = new VolumetricClient({ createWorker: factory(created) }); t.after(() => client.dispose());
  const source = grid(); const result = await client.analyze(source, { level: 1 }, { useGpu: true });
  assert.equal(result.backend, 'cpu'); assert.match(result.fallbackReason, /GPU|navigator|WebGPU/i); close(result.statistics.surfaceArea, 4);
  const plain = new VolumetricClient({ createWorker: null }); t.after(() => plain.dispose());
  assert.deepEqual((await plain.analyze(source, { level: 1 })).vertices, result.vertices);
});

test('source invalidation cancels obsolete jobs, retains warm Workers and accepts a revised grid', async t => {
  const created = [], client = new VolumetricClient({ createWorker: factory(created), cellsPerWorker: 1000 });
  t.after(() => client.dispose());
  const source = grid([30, 30, 30], (x, y, z) => x + y + z); await client.prepare(source);
  const pending = client.analyze(source, { level: 40 }); const cleared = client.clear();
  await assert.rejects(pending, { name: 'AbortError' }); await cleared;
  const createdCount = created.length;
  source.values.fill(3); source.revision = 1;
  const result = await client.analyze(source, { kind: 'slice', axis: 0, index: 0 });
  assert.equal(result.statistics.min, 3); assert.equal(result.statistics.max, 3); assert.equal(created.length, createdCount);
  source.values.fill(4); source.revision++;
  const revised = await client.analyze(source, { kind: 'slice', axis: 0, index: 0 }); assert.equal(revised.statistics.min, 4); assert.equal(revised.gridUploads, 1);
});

test('global mesh caps and throwing progress callbacks drain every CPU lease before subsequent jobs', async t => {
  const created = [], environment = { navigator: { hardwareConcurrency: 6 } }, budget = new CpuBudget({ environment });
  const client = new VolumetricClient({ createWorker: factory(created), cpuBudget: budget, cellsPerWorker: 10, chunkCells: 10 }); t.after(() => client.dispose());
  const source = grid([7, 7, 7], (x, y, z) => (x + y + z) % 2);
  await assert.rejects(client.analyze(source, { level: 0.5, maxTriangles: 200 }), /triangle budget/);
  assert.equal(budget.active, 0);
  await assert.rejects(client.analyze(source, { level: 0.5 }, { onProgress() { throw new Error('Consumer stopped'); } }), /Consumer stopped/);
  assert.equal(budget.active, 0);
  const result = await client.analyze(source, { kind: 'slice' }); assert.ok(result.values.length > 0); assert.equal(budget.active, 0);
});

test('partial Worker startup failure settles preparations and a later retry reuses healthy slots', async t => {
  const created = [], environment = { navigator: { hardwareConcurrency: 6 } }, budget = new CpuBudget({ environment });
  const realFactory = factory(created); let attempts = 0;
  const client = new VolumetricClient({ environment, cpuBudget: budget, cellsPerWorker: 10, createWorker() {
    if (++attempts === 2) throw new Error('Worker startup denied'); return realFactory();
  } }); t.after(() => client.dispose());
  const source = grid([6, 6, 6]); await assert.rejects(client.prepare(source), /startup denied/); assert.equal(budget.active, 0);
  const successful = created.length; const result = await client.analyze(source, { level: 2.5 });
  assert.ok(result.triangleCount > 0); assert.equal(created.length, successful + 1); assert.equal(budget.active, 0);
});

test('GPU preference teardown waits for accepted work and preserves CPU snapshots and Workers', async t => {
  let resolveDispatch; const dispatched = new Promise(resolve => { resolveDispatch = resolve; });
  const messages = [], created = [];
  const client = new VolumetricClient({ createWorker: factory(created, data => { messages.push(data.type); if (data.type === 'analyze') resolveDispatch(); }) });
  t.after(() => client.dispose()); const source = grid([30, 30, 30]); await client.prepare(source);
  const pending = client.analyze(source, { level: 10.5 }); await dispatched;
  const released = client.releaseGpuResources({ whenIdle: true }); assert.ok((await pending).triangleCount > 0); await released;
  const result = await client.analyze(source, { kind: 'slice' }); assert.equal(result.gridUploads, 0); assert.equal(created.length, 1);
  assert.ok(messages.lastIndexOf('release-gpu') > messages.indexOf('analyze'));
});

test('shared grids still bound worst-case concurrent output memory instead of blindly using every core', () => {
  const environment = { navigator: { hardwareConcurrency: 128 }, crossOriginIsolated: true };
  const client = new VolumetricClient({ environment, createWorker: null, cellsPerWorker: 1 });
  const count = client.workerCount(grid([50, 50, 50])); assert.ok(count < 126); assert.ok(count * client.chunkCells * 12 * 156 <= 256 * 1024 ** 2);
  client.dispose();
});

test('closed sampled spheres have shared tetrahedron seams, consistent outward orientation and spherical topology', () => {
  for (const radiusSquared of [4, 4.84]) {
    const result = calculateIsosurface(grid([7, 7, 7], (x, y, z) => radiusSquared - (x - 3) ** 2 - (y - 3) ** 2 - (z - 3) ** 2), { level: 0 });
    const vertices = new Set(), edges = new Map();
    for (let offset = 0; offset < result.vertices.length; offset += 9) {
      const points = [0, 3, 6].map(start => Array.from(result.vertices.subarray(offset + start, offset + start + 3)));
      const keys = points.map(point => point.join(','));
      for (const key of keys) vertices.add(key);
      for (let corner = 0; corner < 3; corner++) {
        const key = [keys[corner], keys[(corner + 1) % 3]].sort().join('|'); edges.set(key, (edges.get(key) ?? 0) + 1);
      }
      const [a, b, c] = points, u = b.map((value, i) => value - a[i]), v = c.map((value, i) => value - a[i]);
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      assert.ok(n.reduce((sum, value, i) => sum + value * ((a[i] + b[i] + c[i]) / 3 - 3), 0) > 0);
    }
    assert.ok([...edges.values()].every(count => count === 2), 'every geometric edge belongs to exactly two triangles');
    assert.equal(vertices.size - edges.size + result.triangleCount, 2, 'closed sphere Euler characteristic');
  }
});
