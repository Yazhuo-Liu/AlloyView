import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVoronoi, mergeVoronoiPartials, validateVoronoiParameters } from '../src/analysis/voronoi.js';
import { createCell } from '../src/data/model.js';

function frame(points, { vectors = [1, 0, 0, 0, 1, 0, 0, 0, 1], pbc = [true, true, true], origin } = {}) {
  return { fractional: Float64Array.from(points.flat()), cell: createCell({ vectors, pbc, origin }) };
}

function near(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} ≈ ${expected}`);
}

const crystals = [
  { name: 'SC', points: [[0, 0, 0]], coordination: 6, index: '<0,6,0,0>', volume: 1 },
  { name: 'FCC', points: [[0, 0, 0], [0, .5, .5], [.5, 0, .5], [.5, .5, 0]], coordination: 12, index: '<0,12,0,0>', volume: .25 },
  { name: 'BCC', points: [[0, 0, 0], [.5, .5, .5]], coordination: 14, index: '<0,6,0,8>', volume: .5 },
];

for (const crystal of crystals) test(`Voro++ produces the exact ${crystal.name} cell, including same-ID periodic faces`, async () => {
  const result = await calculateVoronoi(frame(crystal.points));
  assert.deepEqual([...result.voronoiCoordination], crystal.points.map(() => crystal.coordination));
  assert.deepEqual(result.voronoiIndices, crystal.points.map(() => crystal.index));
  for (const volume of result.atomicVolume) near(volume, crystal.volume);
  near(result.summary.totalVolume, 1);
  near(result.summary.volumeError, 0);
  assert.equal(result.summary.boundaryAtomCount, 0);
  assert.ok(result.faceOrders.every(order => order >= 3));
  assert.equal(result.faceOffsets.at(-1), result.faceAreas.length);
  assert.equal(result.faceAreaHistogram.reduce((sum, bin) => sum + bin.count, 0), crystal.points.length * crystal.coordination);
});

test('single-atom thin-cell tessellation retains both faces of each periodic self image', async () => {
  const result = await calculateVoronoi(frame([[.37, .18, .92]], { vectors: [10, 0, 0, 0, 1, 0, 0, 0, .2] }));
  near(result.atomicVolume[0], 2);
  near(result.voronoiSurfaceArea[0], 2 * (10 + 2 + .2));
  assert.equal(result.voronoiCoordination[0], 6);
  assert.ok(result.faceNeighbors.every(neighbor => neighbor === 0));
  assert.equal(result.voronoiIndices[0], '<0,6,0,0>');
});

test('strongly tilted primitive cell gives the same simple-cubic Wigner–Seitz cell', async () => {
  const result = await calculateVoronoi(frame([[.123, .789, .32]], { vectors: [1, 0, 0, 4, 1, 0, 0, 0, 1] }));
  near(result.atomicVolume[0], 1);
  near(result.voronoiSurfaceArea[0], 6);
  assert.equal(result.voronoiCoordination[0], 6);
  assert.equal(result.voronoiIndices[0], '<0,6,0,0>');
  assert.equal(result.voronoiBoundaryFaces[0], 0);
});

test('an icosahedral neighbor shell produces the twelve pentagonal faces of a dodecahedral cell', async () => {
  const golden = (1 + Math.sqrt(5)) / 2, points = [[.5, .5, .5]];
  for (const first of [-1, 1]) for (const second of [-1, 1]) {
    for (const offset of [[0, first, second * golden], [first, second * golden, 0], [second * golden, 0, first]]) {
      points.push(offset.map(value => .5 + value / 10));
    }
  }
  const result = await calculateVoronoi(frame(points, { vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10],
    pbc: [false, false, false] }), { endAtom: 1 });
  assert.equal(result.voronoiCoordination[0], 12);
  assert.equal(result.voronoiIndices[0], '<0,0,12,0>');
  assert.ok(result.faceOrders.every(order => order === 5));
  assert.equal(result.voronoiBoundaryFaces[0], 0);
  assert.equal(result.summary.volumeError, null);
});

test('open directions clip to the finite simulation-cell domain and flag boundary faces', async () => {
  const result = await calculateVoronoi(frame([[.25, .5, .5], [.75, .5, .5]], { pbc: [false, false, false] }));
  assert.deepEqual([...result.voronoiCoordination], [1, 1]);
  assert.deepEqual([...result.voronoiBoundaryFaces], [5, 5]);
  for (const volume of result.atomicVolume) near(volume, .5);
  near(result.summary.totalVolume, 1);
  assert.equal(result.summary.boundaryMode, 'finite-cell');
  assert.equal(result.summary.boundaryAtomCount, 2);
  assert.deepEqual(result.voronoiIndices, ['<0,1,0,0>', '<0,1,0,0>']);
  assert.equal(result.faceAreaHistogram.reduce((sum, bin) => sum + bin.count, 0), 2);
});

test('mixed periodic tilted cells conserve finite-domain volume for irregular positions', async () => {
  const points = [[.08, .11, .13], [.21, .57, .92], [.75, .3, .45], [.91, .83, .15], [.39, .78, .56]];
  for (const pbc of [[true, false, true], [false, true, false], [false, false, false], [true, true, true]]) {
    const result = await calculateVoronoi(frame(points, { vectors: [2, 0, 0, 1.3, 1.1, 0, .8, .3, 1.7], pbc }));
    near(result.summary.totalVolume, 2 * 1.1 * 1.7);
    near(result.summary.volumeError, 0);
    assert.equal(result.summary.boundaryAtomCount > 0, !pbc.every(Boolean));
    assert.ok(result.atomicVolume.every(volume => volume > 0));
    assert.ok(result.voronoiSurfaceArea.every(area => area > 0));
  }
});

test('face thresholds filter coordination and topology while preserving every physical cell and face', async () => {
  const input = frame(crystals[2].points);
  const original = await calculateVoronoi(input), filtered = await calculateVoronoi(input, { relativeFaceAreaThreshold: .07 });
  assert.deepEqual(filtered.atomicVolume, original.atomicVolume);
  assert.deepEqual(filtered.voronoiSurfaceArea, original.voronoiSurfaceArea);
  assert.deepEqual(filtered.faceAreas, original.faceAreas);
  assert.deepEqual([...filtered.voronoiCoordination], [8, 8]);
  assert.deepEqual(filtered.voronoiIndices, ['<0,0,0,8>', '<0,0,0,8>']);
  assert.equal(filtered.summary.acceptedFaceCount, 16);
  const empty = await calculateVoronoi(input, { faceAreaThreshold: 1 });
  assert.deepEqual([...empty.voronoiCoordination], [0, 0]);
  assert.deepEqual(empty.atomicVolume, original.atomicVolume);
  assert.deepEqual(empty.voronoiIndices, ['<0,0,0,0>', '<0,0,0,0>']);
});

test('periodic translation and origin never change volumes, topology or source coordinates', async () => {
  const points = [[.03, .09, .12], [.54, .19, .22], [.22, .83, .65], [.77, .71, .9]];
  const input = frame(points), saved = new Uint8Array(input.fractional.buffer).slice();
  const first = await calculateVoronoi(input);
  const shifted = await calculateVoronoi(frame(points.map(point => point.map((value, axis) => value + [5.3, -7.17, 3.62][axis])), { origin: [100, -20, 73] }));
  for (let atom = 0; atom < points.length; atom++) {
    near(shifted.atomicVolume[atom], first.atomicVolume[atom]);
    near(shifted.voronoiSurfaceArea[atom], first.voronoiSurfaceArea[atom]);
  }
  assert.deepEqual(shifted.voronoiIndices, first.voronoiIndices);
  assert.deepEqual(new Uint8Array(input.fractional.buffer), saved);
});

test('disjoint Worker ranges merge scalar properties, every face, indices and distribution statistics', async () => {
  const input = frame([[.11, .09, .31], [.58, .23, .16], [.26, .78, .54], [.82, .71, .88]]);
  const full = await calculateVoronoi(input, { bins: 7 });
  const left = await calculateVoronoi(input, { endAtom: 2, bins: 7 }), right = await calculateVoronoi(input, { startAtom: 2, bins: 7 });
  assert.equal(left.summary.volumeError, null);
  assert.equal(right.summary.volumeError, null);
  const merged = mergeVoronoiPartials([right, left], 4, { bins: 7 });
  for (const name of ['atomicVolume', 'voronoiSurfaceArea', 'voronoiCoordination', 'voronoiBoundaryFaces', 'voronoiMaxFaceOrder',
    'faceOffsets', 'faceAreas', 'faceOrders', 'faceNeighbors', 'faceBoundary', 'faceAccepted', 'voronoiIndices',
    'summary', 'volumeHistogram', 'coordinationHistogram', 'faceAreaHistogram', 'indexCounts']) assert.deepEqual(merged[name], full[name], name);
  assert.equal(merged.volumeHistogram.length, 7);
  assert.throws(() => mergeVoronoiPartials([left], 4), /incomplete/);
  assert.throws(() => mergeVoronoiPartials([left, left], 4), /exactly once/);
});

test('the resident Voro++ module, cell and growing heap are reused across frames', async () => {
  const first = await calculateVoronoi(frame(crystals[1].points));
  const second = await calculateVoronoi(frame(crystals[0].points));
  assert.equal(first.kernelReused, true);
  assert.equal(second.kernelReused, true);
  assert.equal(second.engine, 'voro++-wasm');
  near(second.atomicVolume[0], 1);
});

test('invalid thresholds, coincident atoms and nonperiodic outside-domain atoms fail explicitly', async () => {
  assert.throws(() => validateVoronoiParameters({ faceAreaThreshold: -1 }), /threshold/);
  assert.throws(() => validateVoronoiParameters({ relativeFaceAreaThreshold: 1.1 }), /between/);
  assert.throws(() => validateVoronoiParameters({ bins: 0 }), /histogram bins/);
  await assert.rejects(calculateVoronoi(frame([[.2, .2, .2], [1.2, .2, .2]])), /coincident/);
  await assert.rejects(calculateVoronoi(frame([[-.01, .5, .5]], { pbc: [false, true, true] })), /inside the simulation cell/);
});
