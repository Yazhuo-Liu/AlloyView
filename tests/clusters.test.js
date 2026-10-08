import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { calculateClusterEdges, calculateClusters, finalizeClusters } from '../src/analysis/clusters.js';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

function frameFrom(cartesian, vectors, pbc = [true, true, true], { origin = [0, 0, 0], types } = {}) {
  const cell = createCell({ vectors, pbc, origin });
  const count = cartesian.length;
  const fractional = new Float64Array(count * 3);
  // Solve x = origin + a·A + b·B + c·C for the row-vector cell matrix.
  const [a0, a1, a2, b0, b1, b2, c0, c1, c2] = vectors;
  const det = a0 * (b1 * c2 - b2 * c1) - a1 * (b0 * c2 - b2 * c0) + a2 * (b0 * c1 - b1 * c0);
  for (let atom = 0; atom < count; atom += 1) {
    const x = cartesian[atom][0] - origin[0], y = cartesian[atom][1] - origin[1], z = cartesian[atom][2] - origin[2];
    fractional[atom * 3] = (x * (b1 * c2 - b2 * c1) - y * (b0 * c2 - b2 * c0) + z * (b0 * c1 - b1 * c0)) / det;
    fractional[atom * 3 + 1] = -(x * (a1 * c2 - a2 * c1) - y * (a0 * c2 - a2 * c0) + z * (a0 * c1 - a1 * c0)) / det;
    fractional[atom * 3 + 2] = (x * (a1 * b2 - a2 * b1) - y * (a0 * b2 - a2 * b0) + z * (a0 * b1 - a1 * b0)) / det;
  }
  return { fractional, cell, ids: Uint32Array.from({ length: count }, (_, index) => index + 1),
    positions: fractionalToCartesian(fractional, cell), types: types ? Uint16Array.from(types) : new Uint16Array(count),
    typeLabels: ['A', 'B'], properties: [] };
}

const box = (length = 10) => [length, 0, 0, 0, length, 0, 0, 0, length];
const close = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≈ ${expected}`);
const RESULT_ARRAYS = ['clusterId', 'clusterSize', 'sizes', 'totalWeights', 'centers', 'radiiOfGyration', 'gyrationTensors', 'percolating', 'firstAtoms'];

function assertIdentical(actual, expected, label = '') {
  for (const name of RESULT_ARRAYS) {
    assert.equal(actual[name].constructor, expected[name].constructor, `${label}${name} type`);
    assert.equal(actual[name].length, expected[name].length, `${label}${name} length`);
    for (let index = 0; index < expected[name].length; index += 1) {
      assert.ok(Object.is(actual[name][index], expected[name][index]), `${label}${name}[${index}]: ${actual[name][index]} vs ${expected[name][index]}`);
    }
  }
  for (const name of ['clusterCount', 'includedAtoms', 'excludedAtoms', 'largestSize', 'percolatingCount', 'weighting', 'sorted']) {
    assert.equal(actual[name], expected[name], `${label}${name}`);
  }
}

test('separated groups become clusters sorted by size with exact centers and radii of gyration', () => {
  const frame = frameFrom([[1, 5, 5], [6, 5, 5], [2, 5, 5], [7, 5, 5], [8, 5, 5], [3, 5, 5], [4.2, 5, 5]], box(20), [false, false, false]);
  const result = calculateClusters(frame, { cutoff: 1.05 });
  // Atoms 0, 2, 5 form x = 1, 2, 3; atoms 1, 3, 4 form 6, 7, 8; atom 6 is alone.
  assert.deepEqual([...result.clusterId], [1, 2, 1, 2, 2, 1, 3]);
  assert.deepEqual([...result.clusterSize], [3, 3, 3, 3, 3, 3, 1]);
  assert.deepEqual([...result.sizes], [3, 3, 1]);
  assert.deepEqual([...result.firstAtoms], [0, 1, 6]);
  assert.deepEqual([...result.centers], [2, 5, 5, 7, 5, 5, 4.2, 5, 5]);
  close(result.radiiOfGyration[0], Math.sqrt(2 / 3));
  close(result.gyrationTensors[0], 2 / 3);
  assert.deepEqual([...result.gyrationTensors.subarray(1, 6)], [0, 0, 0, 0, 0]);
  assert.equal(result.radiiOfGyration[2], 0);
  assert.deepEqual([...result.percolating], [0, 0, 0]);
  assert.equal(result.clusterCount, 3);
  assert.equal(result.largestSize, 3);
  assert.equal(result.weighting, 'uniform');
  assert.equal(result.excludedAtoms, 0);
});

test('a chain across a periodic boundary is unwrapped from its smallest-index atom', () => {
  const frame = frameFrom([[9.5, 5, 5], [0.5, 5, 5], [1.5, 5, 5]], box(10));
  const result = calculateClusters(frame, { cutoff: 1.05 });
  assert.deepEqual([...result.clusterId], [1, 1, 1]);
  assert.equal(result.percolating[0], 0);
  close(result.centers[0], 10.5); close(result.centers[1], 5); close(result.centers[2], 5);
  close(result.radiiOfGyration[0], Math.sqrt(2 / 3));
  // The anchor is the smallest atom index, independent of union-find roots.
  const reordered = calculateClusters(frameFrom([[0.5, 5, 5], [9.5, 5, 5], [1.5, 5, 5]], box(10)), { cutoff: 1.05 });
  close(reordered.centers[0], 0.5);
  close(reordered.radiiOfGyration[0], Math.sqrt(2 / 3));
  // Open boundaries do not connect the same coordinates.
  const open = calculateClusters(frameFrom([[9.5, 5, 5], [0.5, 5, 5], [1.5, 5, 5]], box(10), [false, true, true]), { cutoff: 1.05 });
  assert.deepEqual([...open.clusterId], [2, 1, 1]);
  assert.deepEqual([...open.centers], [1, 5, 5, 9.5, 5, 5]);
});

test('triclinic cells unwrap through tilted periodic images and include the cell origin', () => {
  const vectors = [8, 0, 0, 3, 8, 0, 1, 2, 9], origin = [-2, 1, 4];
  // Neighbors 1 Å apart along y, crossing the b face of the tilted cell.
  const points = [[3, 7.5 + 1, 6], [3, 8.5 + 1, 6], [3, 9.5 + 1, 6]];
  const frame = frameFrom(points, vectors, [true, true, true], { origin });
  for (let atom = 0; atom < 3; atom += 1) frame.fractional[atom * 3 + 1] -= Math.floor(frame.fractional[atom * 3 + 1]);
  const result = calculateClusters(frame, { cutoff: 1.01 });
  assert.equal(result.clusterCount, 1);
  assert.equal(result.percolating[0], 0);
  // The first atom stays at its wrapped position; the others follow it.
  const wrapped = fractionalToCartesian(frame.fractional, frame.cell, new Float64Array(9));
  close(result.centers[0], wrapped[0], 1e-9); close(result.centers[1], wrapped[1] + 1, 1e-9); close(result.centers[2], wrapped[2], 1e-9);
  close(result.radiiOfGyration[0], Math.sqrt(2 / 3), 1e-9);
  close(result.gyrationTensors[1], 2 / 3, 1e-9);
});

test('loops through periodic images flag percolating clusters with undefined centers', () => {
  const ring = calculateClusters(frameFrom([[0, 5, 5], [1, 5, 5], [2, 5, 5]], [3, 0, 0, 0, 10, 0, 0, 0, 10]), { cutoff: 1.05 });
  assert.deepEqual([...ring.percolating], [1]);
  assert.equal(ring.percolatingCount, 1);
  assert.ok(ring.centers.every(Number.isNaN));
  assert.ok(Number.isNaN(ring.radiiOfGyration[0]));
  assert.ok(ring.gyrationTensors.every(Number.isNaN));
  assert.equal(ring.totalWeights[0], 3);
  // An atom bonded to its own periodic image percolates by itself.
  const self = calculateClusters(frameFrom([[0.5, 0.5, 0.5]], [1, 0, 0, 0, 5, 0, 0, 0, 5]), { cutoff: 1.01 });
  assert.deepEqual([...self.percolating], [1]);
  // Two images of one neighbor close a loop as well; a finite cluster nearby is unaffected.
  const pair = calculateClusters(frameFrom([[0.5, 1, 1], [1.5, 1, 1], [0.5, 5, 5]], [2, 0, 0, 0, 10, 0, 0, 0, 10]), { cutoff: 1.01 });
  assert.deepEqual([...pair.sizes], [2, 1]);
  assert.deepEqual([...pair.percolating], [1, 0]);
  assert.deepEqual([...pair.centers.subarray(3)], [0.5, 5, 5]);
  // A large crystal percolates in every periodic direction.
  const crystal = calculateClusters(crystalFrame('fcc', 3), { cutoff: 3 });
  assert.equal(crystal.clusterCount, 1);
  assert.equal(crystal.percolating[0], 1);
});

test('selection restriction excludes atoms from clusters and connections', () => {
  const frame = frameFrom([[1, 5, 5], [2, 5, 5], [3, 5, 5], [4, 5, 5]], box(20), [false, false, false]);
  const result = calculateClusters(frame, { cutoff: 1.05, clusterSelection: Uint8Array.from([1, 0, 1, 1]) });
  assert.deepEqual([...result.clusterId], [2, 0, 1, 1]);
  assert.ok(Number.isNaN(result.clusterSize[1]));
  assert.deepEqual([...result.clusterSize].filter(Number.isFinite), [1, 2, 2]);
  assert.equal(result.excludedAtoms, 1);
  assert.equal(result.includedAtoms, 3);
  const none = calculateClusters(frame, { cutoff: 1.05, clusterSelection: new Uint8Array(4) });
  assert.equal(none.clusterCount, 0);
  assert.deepEqual([...none.clusterId], [0, 0, 0, 0]);
  assert.ok(none.clusterSize.every(Number.isNaN));
  assert.throws(() => calculateClusters(frame, { cutoff: 1.05, clusterSelection: new Uint8Array(3) }), /one flag per atom/);
});

test('size sorting breaks ties by smallest atom index and can be disabled', () => {
  // Clusters in atom order: {0}, {1, 2}, {3, 6}, {4, 5, 7}.
  const points = [[1, 1, 1], [5, 1, 1], [6, 1, 1], [10, 1, 1], [15, 1, 1], [16, 1, 1], [11, 1, 1], [17, 1, 1]];
  const frame = frameFrom(points, box(40), [false, false, false]);
  const sorted = calculateClusters(frame, { cutoff: 1.05 });
  assert.deepEqual([...sorted.clusterId], [4, 2, 2, 3, 1, 1, 3, 1]);
  assert.deepEqual([...sorted.sizes], [3, 2, 2, 1]);
  assert.deepEqual([...sorted.firstAtoms], [4, 1, 3, 0]);
  const unsorted = calculateClusters(frame, { cutoff: 1.05, sortBySize: false });
  assert.deepEqual([...unsorted.clusterId], [1, 2, 2, 3, 4, 4, 3, 4]);
  assert.deepEqual([...unsorted.sizes], [1, 2, 2, 3]);
  assert.equal(unsorted.sorted, false);
});

test('mass weighting moves centers; invalid masses fall back to equal weights with a warning', () => {
  const frame = frameFrom([[1, 5, 5], [2, 5, 5]], box(20), [false, false, false]);
  const weighted = calculateClusters(frame, { cutoff: 1.05, clusterMasses: Float32Array.from([1, 3]) });
  assert.equal(weighted.weighting, 'mass');
  assert.equal(weighted.centers[0], 1.75);
  assert.equal(weighted.totalWeights[0], 4);
  close(weighted.radiiOfGyration[0], Math.sqrt((1 * 0.75 ** 2 + 3 * 0.25 ** 2) / 4));
  const invalid = calculateClusters(frame, { cutoff: 1.05, clusterMasses: Float64Array.from([1, 0]) });
  assert.equal(invalid.weighting, 'uniform');
  assert.equal(invalid.centers[0], 1.5);
  assert.match(invalid.warning, /equal atom weights/);
  // Excluded atoms need no valid mass.
  const restricted = calculateClusters(frame, { cutoff: 1.05, clusterMasses: Float64Array.from([2, NaN]), clusterSelection: Uint8Array.from([1, 0]) });
  assert.equal(restricted.weighting, 'mass');
  assert.equal(restricted.totalWeights[0], 2);
});

test('single atoms and coincident atoms follow cutoff and bond conventions', () => {
  const one = calculateClusters(frameFrom([[1, 2, 3]], box(20), [false, false, false]), { cutoff: 2 });
  assert.deepEqual([...one.clusterId], [1]);
  assert.deepEqual([...one.centers], [1, 2, 3]);
  assert.equal(one.radiiOfGyration[0], 0);
  const twin = frameFrom([[1, 1, 1], [1, 1, 1]], box(20), [false, false, false]);
  assert.equal(calculateClusters(twin, { cutoff: 1 }).clusterCount, 1);
  assert.equal(calculateClusters(twin, { cutoff: 1, neighborMode: 'bonds' }).clusterCount, 2);
  assert.throws(() => calculateClusters(twin, { cutoff: 0 }), /positive and finite/);
  assert.throws(() => calculateClusters(twin, { cutoff: 1, neighborMode: 'voronoi' }), /cutoff/);
});

test('element-pair cutoffs reuse bond semantics, including zero to disconnect a pair', () => {
  // A–B–A–B chain, 1.2 Å apart; A–A next-nearest atoms are 2.4 Å apart.
  const frame = frameFrom([[1, 5, 5], [2.2, 5, 5], [3.4, 5, 5], [4.6, 5, 5]], box(20), [false, false, false], { types: [0, 1, 0, 1] });
  assert.equal(calculateClusters(frame, { cutoff: 1, neighborMode: 'bonds' }).clusterCount, 4);
  const pairs = calculateClusters(frame, { cutoff: 1, neighborMode: 'bonds', pairCutoffs: [{ first: 0, second: 1, cutoff: 1.3 }] });
  assert.equal(pairs.clusterCount, 1);
  const longer = calculateClusters(frame, { cutoff: 1.3, neighborMode: 'bonds', pairCutoffs: [{ first: 1, second: 0, cutoff: 0 }, { first: 0, second: 0, cutoff: 2.5 }] });
  assert.deepEqual([...longer.clusterId], [1, 2, 1, 3]);
  assert.throws(() => calculateClusters(frame, { cutoff: 1, pairCutoffs: [{ first: 0, second: 1, cutoff: 1 }, { first: 1, second: 0, cutoff: 2 }] }), /only one cutoff/);
});

test('edge ranges and edge order do not change any output', () => {
  const frame = crystalFrame('bcc', 5, 2.87);
  // Remove a slab so finite and percolating clusters coexist.
  const selection = new Uint8Array(frame.types.length);
  for (let atom = 0; atom < selection.length; atom += 1) {
    const [a, b] = [frame.fractional[atom * 3], frame.fractional[atom * 3 + 1]];
    selection[atom] = (a < 0.35 || (a > 0.55 && a < 0.65 && b < 0.3) || ((atom * 7919) % 13 === 0)) ? 1 : 0;
  }
  const masses = Float64Array.from({ length: selection.length }, (_, atom) => 50 + (atom % 7));
  const options = { cutoff: 2.6, clusterSelection: selection, clusterMasses: masses };
  const direct = calculateClusters(frame, options);
  assert.ok(direct.clusterCount > 3);
  assert.ok(direct.percolatingCount >= 1 && direct.percolatingCount < direct.clusterCount);
  const count = frame.types.length;
  for (const boundaries of [[0, 17, 101, 102, count], [0, 1, 2, 3, count], [0, Math.floor(count / 2), count]]) {
    const ranges = boundaries.slice(1).map((end, index) => calculateClusterEdges(frame, { ...options, startAtom: boundaries[index], endAtom: end }));
    const edgeCount = ranges.reduce((sum, range) => sum + range.edgeCount, 0);
    const edgePairs = new Int32Array(edgeCount * 2), edgeShifts = new Int32Array(edgeCount * 3);
    // Reverse range order as well: union order must not matter.
    let offset = 0;
    for (const range of ranges.reverse()) { edgePairs.set(range.pairs, offset * 2); edgeShifts.set(range.shifts, offset * 3); offset += range.edgeCount; }
    assertIdentical(finalizeClusters(frame, { ...options, edgePairs, edgeShifts }), direct, `${boundaries}: `);
  }
});

function nodeFactory(stats) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    stats.created += 1;
    return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transferables) { worker.postMessage(data, transferables); },
      terminate() { worker.terminate(); } };
  };
}

function clusterFixture() {
  const frame = crystalFrame('bcc', 14, 2.87);
  const selection = new Uint8Array(frame.types.length);
  for (let atom = 0; atom < selection.length; atom += 1) selection[atom] = frame.fractional[atom * 3 + 2] < 0.4 || (atom % 11 === 0) ? 1 : 0;
  frame.types = Uint16Array.from(frame.types, (_, atom) => atom % 3 === 0 ? 1 : 0);
  frame.typeLabels = ['Fe', 'Cr'];
  return { frame, options: { cutoff: 2.6, clusterSelection: selection, clusterMasses: Float32Array.from(frame.types, type => type ? 52 : 55.845),
    sortBySize: true } };
}

test('Worker pool clusters equal the direct calculation, privately and with shared memory', async () => {
  const { frame, options } = clusterFixture();
  const direct = calculateClusters(frame, options);
  assert.equal(direct.weighting, 'mass');
  assert.ok(direct.percolatingCount >= 1 && direct.clusterCount > 100);
  assert.ok(direct.sizes.some((size, index) => size > 1 && !direct.percolating[index]), 'finite multi-atom clusters have centers');
  const original = { fractional: frame.fractional.slice(), selection: options.clusterSelection.slice() };
  for (const environment of [{ navigator: { hardwareConcurrency: 4 } }, { crossOriginIsolated: true, navigator: { hardwareConcurrency: 4 } }]) {
    const pool = new AnalysisPool({ environment, workerFactory: nodeFactory({ created: 0 }) });
    pool.setGpuEnabled(true);
    try {
      const progress = [];
      const result = await pool.analyze(frame, { kind: 'clusters', ...options }, { onProgress: update => progress.push(update) });
      assert.ok(result.workerCount > 1);
      assert.ok(result.chunkCount > result.workerCount);
      assert.equal(result.backend, 'cpu');
      assert.equal(result.gpuRequested, true);
      assert.equal(result.fallbackReason, undefined);
      assert.equal(result.acceptedEdges, direct.acceptedEdges);
      assertIdentical(result, direct, `${result.sharedMemory ? 'shared' : 'private'}: `);
      assert.equal(progress.at(-1).stage, 'cluster-labels');
      const bonds = await pool.analyze(frame, { kind: 'clusters', ...options, neighborMode: 'bonds', pairCutoffs: [{ first: 0, second: 1, cutoff: 0 }] });
      assertIdentical(bonds, calculateClusters(frame, { ...options, neighborMode: 'bonds', pairCutoffs: [{ first: 0, second: 1, cutoff: 0 }] }), 'pairs: ');
    } finally { pool.close(); }
  }
  assert.deepEqual(frame.fractional, original.fractional, 'transfers keep source coordinates');
  assert.deepEqual(options.clusterSelection, original.selection, 'transfers keep the selection mask');
});

test('cancelling cluster edges rejects promptly and keeps the Worker pool usable', async () => {
  const stats = { created: 0 }, controller = new AbortController();
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 2 } }, workerFactory: nodeFactory(stats) });
  try {
    const frame = crystalFrame('fcc', 14);
    const pending = pool.analyze(frame, { kind: 'clusters', cutoff: 3 }, { signal: controller.signal, onProgress(progress) {
      if (progress.completedAtoms > 0) controller.abort();
    } });
    await assert.rejects(pending, { name: 'AbortError' });
    const small = crystalFrame('sc', 3);
    const result = await pool.analyze(small, { kind: 'clusters', cutoff: 1.5 });
    assertIdentical(result, calculateClusters(small, { cutoff: 1.5 }));
  } finally { pool.close(); }
});
