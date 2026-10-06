import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { calculateVoronoi, mergeVoronoiPartials } from '../src/analysis/voronoi.js';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { createCell, determinant3 } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

function input(points, vectors, pbc = [true, true, true]) {
  return { fractional: Float64Array.from(points.flat()), cell: createCell({ vectors, pbc, triclinic: true }) };
}

function near(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} ≈ ${expected}`);
}

test('unimodular changes of primitive cubic basis retain the same Wigner–Seitz cell', async () => {
  // This lattice is exactly Z^3, although its b and c basis vectors are long
  // and neighboring sites require periodic shifts well beyond +/-1.
  const frame = input([[.213, .497, .781]], [1, 0, 0, 15, 1, 0, 3, 2, 1]);
  const result = await calculateVoronoi(frame);
  near(result.atomicVolume[0], 1);
  near(result.voronoiSurfaceArea[0], 6);
  assert.equal(result.voronoiCoordination[0], 6);
  assert.equal(result.voronoiIndices[0], '<0,6,0,0>');
  assert.equal(result.voronoiBoundaryFaces[0], 0);
});

test('thin one-site orthogonal periodic cells preserve their exact rectangular volume and surface', async () => {
  const result = await calculateVoronoi(input([[.241, .583, .819]], [6, 0, 0, 0, .08, 0, 0, 0, .05]));
  near(result.atomicVolume[0], 6 * .08 * .05);
  near(result.voronoiSurfaceArea[0], 2 * (6 * .08 + 6 * .05 + .08 * .05));
  assert.equal(result.voronoiCoordination[0], 6);
  assert.ok(result.faceNeighbors.every(neighbor => neighbor === 0));
  assert.equal(result.summary.volumeError < 1e-9, true);
});

test('real atom replication leaves local Voronoi geometry unchanged in a thin skewed periodic lattice', async () => {
  const vectors = [1.8, 0, 0, .65, .55, 0, .3, .15, .25];
  const points = [[.12, .07, .14], [.38, .53, .73], [.81, .91, .37]];
  const original = await calculateVoronoi(input(points, vectors));
  const repetitions = [3, 1, 2], repeated = [];
  for (let a = 0; a < repetitions[0]; a++) for (let b = 0; b < repetitions[1]; b++) for (let c = 0; c < repetitions[2]; c++) {
    for (const point of points) repeated.push(point.map((value, axis) => (value + [a, b, c][axis]) / repetitions[axis]));
  }
  const repeatedVectors = vectors.map((value, index) => value * repetitions[Math.floor(index / 3)]);
  const copies = await calculateVoronoi(input(repeated, repeatedVectors));
  for (let atom = 0; atom < repeated.length; atom++) {
    const source = atom % points.length;
    near(copies.atomicVolume[atom], original.atomicVolume[source]);
    near(copies.voronoiSurfaceArea[atom], original.voronoiSurfaceArea[source]);
    assert.equal(copies.voronoiCoordination[atom], original.voronoiCoordination[source]);
    assert.equal(copies.voronoiIndices[atom], original.voronoiIndices[source]);
  }
  near(copies.summary.totalVolume, original.summary.totalVolume * repetitions.reduce((product, count) => product * count, 1));
  near(copies.summary.volumeError, 0);
});

test('irregular skewed cells conserve domain volume and each directed atomic interface has reciprocal area', async () => {
  const vectors = [1.7, .2, .1, 1.1, 1.3, .1, .7, .5, 1.9];
  const points = [[.021, .093, .714], [.348, .712, .027], [.639, .372, .538], [.915, .844, .227], [.083, .543, .819], [.726, .173, .942]];
  for (const pbc of [[true, true, true], [false, true, false], [true, false, true], [false, false, false]]) {
    const frame = input(points, vectors, pbc), result = await calculateVoronoi(frame);
    near(result.summary.totalVolume, Math.abs(determinant3(frame.cell.vectors)));
    const interfaceArea = new Map();
    for (let atom = 0; atom < points.length; atom++) {
      for (let face = result.faceOffsets[atom]; face < result.faceOffsets[atom + 1]; face++) {
        if (result.faceBoundary[face]) continue;
        const other = result.faceNeighbors[face], key = `${atom}:${other}`;
        interfaceArea.set(key, (interfaceArea.get(key) ?? 0) + result.faceAreas[face]);
      }
    }
    for (const [key, area] of interfaceArea) {
      const [first, second] = key.split(':');
      near(area, interfaceArea.get(`${second}:${first}`));
    }
    const filtered = await calculateVoronoi(frame, { faceAreaThreshold: 1e8, relativeFaceAreaThreshold: .999 });
    assert.deepEqual(filtered.atomicVolume, result.atomicVolume);
    assert.deepEqual(filtered.voronoiSurfaceArea, result.voronoiSurfaceArea);
    assert.deepEqual(filtered.faceAreas, result.faceAreas);
    assert.ok(filtered.voronoiCoordination.every(value => value === 0));
    assert.deepEqual(filtered.voronoiBoundaryFaces, result.voronoiBoundaryFaces);
  }
});

test('atoms exactly on open faces are valid distinct sites and left-handed orientation preserves geometry', async () => {
  for (const sign of [1, -1]) {
    const result = await calculateVoronoi(input([[0, .5, .5], [1, .5, .5]], [sign, 0, 0, 0, 1, 0, 0, 0, 1], [false, true, true]));
    near(result.atomicVolume[0], .5);
    near(result.atomicVolume[1], .5);
    near(result.summary.volumeError, 0);
    assert.deepEqual([...result.voronoiBoundaryFaces], [1, 1]);
    assert.deepEqual([...result.voronoiCoordination], [5, 5]);
  }
});

test('unequal chunk boundaries preserve complete atomic cells and filtered face CSR metadata', async () => {
  const frame = input([[.11, .22, .73], [.37, .69, .12], [.88, .54, .43], [.52, .34, .99], [.23, .85, .67]], [1.4, 0, 0, .8, 1.1, 0, .3, .2, .7]);
  const parameters = { relativeFaceAreaThreshold: .025, bins: 11 };
  const complete = await calculateVoronoi(frame, parameters);
  const first = await calculateVoronoi(frame, { ...parameters, endAtom: 1 });
  const middle = await calculateVoronoi(frame, { ...parameters, startAtom: 1, endAtom: 4 });
  const last = await calculateVoronoi(frame, { ...parameters, startAtom: 4 });
  const merged = mergeVoronoiPartials([last, first, middle], 5, { bins: 11 });
  for (const name of ['atomicVolume', 'faceOffsets', 'faceAreas', 'faceOrders', 'faceNeighbors', 'faceBoundary', 'faceAccepted', 'voronoiIndices', 'summary', 'indexCounts']) {
    assert.deepEqual(merged[name], complete[name], name);
  }
});

test('cancelling an initialized Voronoi worker settles every promise and later jobs recover and reuse Wasm', async () => {
  const stats = { created: 0 }, controller = new AbortController();
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 2 } }, workerFactory: () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    stats.created++;
    return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfers) { worker.postMessage(data, transfers); }, terminate() { worker.terminate(); } };
  } });
  let cancelledAfterInitialization = false;
  const first = pool.analyze(crystalFrame('fcc', 10), { kind: 'voronoi' }, { signal: controller.signal,
    onProgress(progress) {
      if (progress.phase === 'analyzing' && progress.completedAtoms < progress.totalAtoms) {
        cancelledAfterInitialization = true; controller.abort();
      }
    } });
  const queued = pool.analyze(crystalFrame('bcc', 2), { kind: 'voronoi' });
  try {
    const outcomes = await Promise.allSettled([first, queued]);
    assert.equal(cancelledAfterInitialization, true);
    assert.equal(outcomes[0].status, 'rejected');
    assert.equal(outcomes[0].reason.name, 'AbortError');
    assert.equal(outcomes[1].status, 'fulfilled');
    assert.ok(outcomes[1].value.voronoiCoordination.every(value => value === 14));
    assert.equal(stats.created, 2, 'only the cancelled Worker is replaced');
    const third = await pool.analyze(crystalFrame('fcc', 2), { kind: 'voronoi' });
    assert.equal(third.kernelInitializations, 0);
    assert.equal(stats.created, 2);
    assert.equal(pool.active.size, 0);
    assert.equal(pool.queue.length, 0);
    assert.equal(pool.controllers.size, 0);
    assert.equal(pool.idle.length, 1);
  } finally { pool.close(); }
});
