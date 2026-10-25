import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { calculateCoordinationPolyhedra } from '../src/analysis/coordination-polyhedra.js';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { createCell, cartesianToFractional } from '../src/data/model.js';
import { createVoronoiCellMesh } from '../src/render/voronoi-cell-layer.js';
import { crystalFrame } from './helpers/crystals.js';

function shell(points, vectors = [12, 0, 0, 0, 12, 0, 0, 0, 12]) {
  const cell = createCell({ vectors, pbc: [false, false, false] });
  const positions = Float64Array.from([[0, 0, 0], ...points].flatMap(point => point.map(value => value + 4)));
  return { cell, positions, fractional: cartesianToFractional(positions, cell, new Float64Array(positions.length)),
    types: Uint16Array.from([0, ...points.map(() => 1)]) };
}
function close(actual, expected, tolerance = 1e-11) {
  assert.ok(Math.abs(actual - expected) < tolerance * Math.max(1, Math.abs(expected)), `${actual} ≠ ${expected}`);
}
function topology(cell) {
  const edges = new Map();
  for (let face = 0; face + 1 < cell.faceOffsets.length; face++) {
    const ids = cell.faceVertices.subarray(cell.faceOffsets[face], cell.faceOffsets[face + 1]);
    for (let corner = 0; corner < ids.length; corner++) {
      const first = ids[corner], second = ids[(corner + 1) % ids.length], key = [first, second].sort((a, b) => a - b).join(':');
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  assert.ok([...edges.values()].every(count => count === 2), 'each hull edge bounds two polygons');
  assert.equal(cell.vertices.length / 3 - edges.size + cell.faceOffsets.length - 1, 2, 'Euler characteristic');
  return { faces: cell.faceOffsets.length - 1, edges: edges.size };
}

for (const [name, points, expected] of [
  ['tetrahedron', [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]], { faces: 4, edges: 6, volume: 8 / 3, area: 8 * Math.sqrt(3) }],
  ['octahedron', [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], { faces: 8, edges: 12, volume: 4 / 3, area: 4 * Math.sqrt(3) }],
  ['cube', [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => [x, y, z]))), { faces: 6, edges: 12, volume: 8, area: 24 }],
]) {
  test(`coordination ${name} retains exact polygon faces, physical volume and surface area`, () => {
    const frame = shell(points), source = frame.fractional.slice();
    const result = calculateCoordinationPolyhedra(frame, { cutoff: 2, centerTypes: [0], neighborTypes: [1] });
    assert.equal(result.cells.length, 1); assert.equal(result.coordination[0], points.length);
    const cell = result.cells[0];
    assert.equal(cell.atomIndex, 0); assert.equal(cell.vertices.length / 3, points.length);
    assert.deepEqual(topology(cell), { faces: expected.faces, edges: expected.edges });
    close(cell.volume, expected.volume); close(cell.surfaceArea, expected.area);
    assert.equal(createVoronoiCellMesh(cell).edges.length, expected.edges, 'render edges have no triangulation diagonals');
    assert.equal(result.summary.selected, 1); assert.equal(result.summary.skipped, 0);
    assert.ok(result.volumes.slice(1).every(Number.isNaN));
    assert.deepEqual(frame.fractional, source);
  });
}

test('primitive periodic shells keep repeated atom images and are coordination hulls, not Voronoi cells', () => {
  const sc = calculateCoordinationPolyhedra(crystalFrame('sc', 1), { cutoff: 4.01 });
  assert.equal(sc.coordination[0], 6); assert.equal(sc.cells[0].faceOffsets.length - 1, 8);
  close(sc.cells[0].volume, 4 ** 3 * 4 / 3);
  const bcc = calculateCoordinationPolyhedra(crystalFrame('bcc', 1), { cutoff: 3.5 });
  assert.equal(bcc.cells.length, 2);
  for (const cell of bcc.cells) { assert.equal(cell.coordination, 8); close(cell.volume, 64); assert.deepEqual(topology(cell), { faces: 6, edges: 12 }); }
});

test('skew cells, reordered points, rotations and scaling retain the physical hull', () => {
  const points = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
  const angle = .73, scale = 3.2;
  const transformed = points.slice().reverse().map(([x, y, z]) => [(x * Math.cos(angle) - y * Math.sin(angle)) * scale,
    (x * Math.sin(angle) + y * Math.cos(angle)) * scale, z * scale]);
  const result = calculateCoordinationPolyhedra(shell(transformed, [12, 2, 1, 3, 15, -2, 1, 4, 16]),
    { cutoff: 2 * scale, centerTypes: [0], neighborTypes: [1] });
  close(result.cells[0].volume, 8 / 3 * scale ** 3); close(result.cells[0].surfaceArea, 8 * Math.sqrt(3) * scale ** 2);
  assert.deepEqual(topology(result.cells[0]), { faces: 4, edges: 6 });
  const primitive = crystalFrame('sc', 1);
  primitive.cell = createCell({ vectors: [4, 0, 0, 4, 4, 0, 0, 0, 4] });
  const periodic = calculateCoordinationPolyhedra(primitive, { cutoff: 4.01 });
  assert.equal(periodic.coordination[0], 6); close(periodic.cells[0].volume, 256 / 3);
});

test('excluded neighbors, empty filters and degenerate environments report unavailable hulls explicitly', () => {
  const plane = shell([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]);
  const planar = calculateCoordinationPolyhedra(plane, { cutoff: 2, centerTypes: [0] });
  assert.equal(planar.summary.coplanar, 1); assert.equal(planar.summary.skipped, 1); assert.equal(planar.coordination[0], 4);
  assert.ok(Number.isNaN(planar.volumes[0])); assert.equal(planar.cells.length, 0);
  const empty = calculateCoordinationPolyhedra(plane, { cutoff: 2, centerTypes: [0], neighborTypes: [] });
  assert.equal(empty.summary.undercoordinated, 1); assert.equal(empty.coordination[0], 0);
  assert.equal(calculateCoordinationPolyhedra(plane, { cutoff: 2, centerTypes: [] }).summary.selected, 0);
  const duplicate = calculateCoordinationPolyhedra(shell([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 1, 0]]), { cutoff: 2, centerTypes: [0] });
  assert.equal(duplicate.summary.undercoordinated, 1); assert.equal(duplicate.coordination[0], 4);
});

test('bond statistics include interior selected neighbors rather than just convex-hull vertices', () => {
  const points = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => [x, y, z])));
  points.push([.5, 0, 0]);
  const result = calculateCoordinationPolyhedra(shell(points), { cutoff: 2, centerTypes: [0], neighborTypes: [1] });
  const cell = result.cells[0];
  assert.equal(cell.coordination, 9); assert.equal(cell.vertices.length / 3, 8);
  close(cell.bondLengthMin, .5); close(cell.bondLengthMax, Math.sqrt(3));
  close(cell.bondLengthMean, (8 * Math.sqrt(3) + .5) / 9); close(cell.volume, 8);
});

test('shell/output budgets reject rather than silently truncating scientific geometry', () => {
  const frame = crystalFrame('sc', 1);
  for (const parameters of [{ cutoff: Infinity }, { cutoff: 1e200 }, { cutoff: 4, centerTypes: [0, 0] }, { cutoff: 4, neighborTypes: [-1] }]) {
    assert.throws(() => calculateCoordinationPolyhedra(frame, parameters));
  }
  assert.throws(() => calculateCoordinationPolyhedra(frame, { cutoff: 20 }), /more than 64 neighbors/);
  assert.throws(() => calculateCoordinationPolyhedra(frame, { cutoff: 1e20 }), /thin|neighbor search/);
  assert.throws(() => calculateCoordinationPolyhedra(crystalFrame('bcc', 1), { cutoff: 3.5, maxCells: 1 }), /Too many/);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => calculateCoordinationPolyhedra(frame, { cutoff: 4.01, signal: controller.signal }), { name: 'AbortError' });
});

test('finite nearly planar hulls reject unreliable volumes while resolvable thin cells and planar skips remain valid', () => {
  const base = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
  for (const thickness of [1e-9, 1e-10, 1e-11, 1e-12]) {
    const frame = shell(base.map(([x, y, z]) => [x, y, z * thickness]));
    assert.throws(() => calculateCoordinationPolyhedra(frame, { cutoff: 2, centerTypes: [0] }), /thickness.*reliable volume/);
  }
  const resolved = calculateCoordinationPolyhedra(shell(base.map(([x, y, z]) => [x, y, z * 1e-5])), { cutoff: 2, centerTypes: [0] });
  close(resolved.cells[0].volume / 1e-5, 8 / 3, 1e-9);
  const planar = calculateCoordinationPolyhedra(shell(base.map(([x, y]) => [x, y, 0])), { cutoff: 2, centerTypes: [0] });
  assert.equal(planar.summary.coplanar, 1);
});

test('skew dilute searches reject excessive examined images before collect despite few accepted neighbors', () => {
  const cell = createCell({ vectors: [1000, 0, 0, 1e6, 1, 0, 0, 0, 1000] });
  const count = 200, fractional = new Float64Array(count * 3), types = new Uint16Array(count).fill(1);
  types[0] = 0;
  for (let atom = 1; atom < count; atom++) fractional[atom * 3 + 2] = (2 + atom / count * 18) / 1000;
  const frame = { cell, fractional, types }, search = new NeighborSearch(frame);
  let queries = 0;
  const collect = search.collect.bind(search);
  search.collect = (...args) => { queries++; return collect(...args); };
  frame.neighborSearch = search;
  assert.ok(search.imageBudget(1) < 100_000, 'the ordinary per-ID image guard alone permits this search');
  assert.throws(() => calculateCoordinationPolyhedra(frame, { cutoff: 1, centerTypes: [0] }), /candidate work budget/);
  assert.equal(queries, 0, 'no Cartesian image enumeration starts');
  const empty = calculateCoordinationPolyhedra(frame, { cutoff: 1, centerTypes: [0], neighborTypes: [] });
  assert.equal(empty.summary.undercoordinated, 1); assert.equal(queries, 0);
});

function nodeFactory(stats) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url)); stats.created++;
    return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfers) { worker.postMessage(data, transfers); }, terminate() { worker.terminate(); } };
  };
}
for (const shared of [false, true]) test(`parallel hulls reuse existing workers and indices, with Worker-packed geometry (${shared ? 'shared' : 'private'})`, async () => {
  const stats = { created: 0 }, frame = crystalFrame('bcc', 9), source = frame.fractional.slice();
  const pool = new AnalysisPool({ environment: { crossOriginIsolated: shared, navigator: { hardwareConcurrency: 4 } }, workerFactory: nodeFactory(stats) });
  try {
    const parameters = { kind: 'coordinationPolyhedra', cutoff: 3.5 };
    const direct = calculateCoordinationPolyhedra(frame, parameters), first = await pool.analyze(frame, parameters), created = stats.created;
    const result = await pool.analyze(frame, parameters);
    assert.equal(result.workerCount, 2); assert.equal(stats.created, created); assert.equal(result.indexBuilds, 0);
    assert.equal(result.frameUploads, 0); assert.equal(result.sharedMemory, shared);
    for (const key of ['coordination', 'volumes', 'surfaceAreas', 'cells']) assert.deepEqual(result[key], direct[key], key);
    assert.equal(result.summary.selected, direct.summary.selected); close(result.summary.volumeSum, direct.summary.volumeSum);
    assert.equal(result.geometry.cellCount, frame.types.length); assert.ok(result.geometry.chunks.length > 2);
    assert.equal(result.geometry.chunks.reduce((sum, chunk) => sum + chunk.cellCount, 0), direct.cells.length);
    assert.deepEqual(first.geometry, result.geometry); assert.deepEqual(frame.fractional, source);
  } finally { pool.close(); }
});

test('global output rejection, GPU preference and cancellation retain the reusable CPU pool', async () => {
  const stats = { created: 0 }, frame = crystalFrame('bcc', 9), controller = new AbortController();
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 3 } }, workerFactory: nodeFactory(stats) });
  pool.setGpuEnabled(true);
  try {
    await assert.rejects(pool.analyze(frame, { kind: 'coordinationPolyhedra', cutoff: 3.5, maxCells: 200 }), /geometry limit/);
    await assert.rejects(pool.analyze(frame, { kind: 'coordinationPolyhedra', cutoff: 3.5 }, { signal: controller.signal,
      onProgress(update) { if (update.completedAtoms > 0 && update.completedAtoms < update.totalAtoms) controller.abort(); } }), { name: 'AbortError' });
    const result = await pool.analyze(crystalFrame('sc', 1), { kind: 'coordinationPolyhedra', cutoff: 4.01 });
    assert.equal(result.backend, 'cpu'); assert.equal(result.gpuRequested, true); assert.match(result.fallbackReason, /no GPU kernel/);
    assert.equal(stats.created, 1); assert.equal(result.cells.length, 1);
  } finally { pool.close(); }
});

test('Worker refuses finite scientific coordinates outside Float32 rendering range and remains reusable', async () => {
  const points = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]].map(point => point.map(value => value * 1e39));
  const frame = shell(points, [1e40, 0, 0, 0, 1e40, 0, 0, 0, 1e40]);
  const parameters = { kind: 'coordinationPolyhedra', cutoff: 2e39, centerTypes: [0] };
  assert.ok(Number.isFinite(calculateCoordinationPolyhedra(frame, parameters).cells[0].volume));
  const stats = { created: 0 }, pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 3 } }, workerFactory: nodeFactory(stats) });
  try {
    await assert.rejects(pool.analyze(frame, parameters), /Float32 rendering range/);
    const result = await pool.analyze(crystalFrame('sc', 1), { kind: 'coordinationPolyhedra', cutoff: 4.01 });
    assert.equal(result.cells.length, 1); assert.equal(stats.created, 1);
  } finally { pool.close(); }
});
