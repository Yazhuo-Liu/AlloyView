import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { DisjointSet, GRAIN_DEFAULTS, GRAIN_MIN_PLOT_SIZE, buildGrainDendrogram, calculateGrains, fitMergeDistances, grainEdgeWeight,
  quaternionAxisAngle, quaternionBungeEuler, segmentGrains, stableAscendingOrder, suggestMergeThreshold, validateGrainParameters } from '../src/analysis/grains.js';
import { latticeDisorientation } from '../src/analysis/disorientation.js';
import { calculatePtm } from '../src/analysis/ptm.js';
import { GrainSegmentationClient } from '../src/grains-client.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';
import { GRAIN_FIXTURES, loadGrainFixture, ovitoGrainInput } from './helpers/grain-fixtures.js';
import { adjustedRandIndex, axisAngleQuaternion, mulberry32, polycrystalFrame, quaternionMultiply, randomQuaternion, stackedLayersFrame } from './helpers/polycrystal.js';

const FCC = 1, HCP = 2, BCC = 3;
function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≈ ${expected}`);
}
function assertIdentical(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let index = 0; index < expected.length; index += 1) {
    if (!Object.is(actual[index], expected[index])) assert.fail(`${label}[${index}]: ${actual[index]} !== ${expected[index]}`);
  }
}

/** A hand-made structure: atoms on a line in an open cell, each with a
 * structure type, a tilt in degrees about z, and an explicit neighbor list. */
function handMade(atoms, { box = 200, pbc = [false, false, false] } = {}) {
  const count = atoms.length, structures = new Uint8Array(count), orientations = new Float64Array(count * 4).fill(NaN);
  const neighborCounts = new Uint8Array(count), neighborIndices = new Uint32Array(count * 16), fractional = new Float64Array(count * 3);
  atoms.forEach(({ type = FCC, tilt = 0, x = 0, y = 0, neighbors = [] }, atom) => {
    structures[atom] = type;
    if (type) orientations.set(axisAngleQuaternion([0, 0, 1], tilt), atom * 4);
    neighborCounts[atom] = neighbors.length;
    neighborIndices.set(neighbors, atom * 16);
    fractional[atom * 3] = x / box; fractional[atom * 3 + 1] = y / box; fractional[atom * 3 + 2] = .5;
  });
  return { structures, orientations, neighborCounts, neighborIndices, neighborSpan: new Float64Array(3), fractional,
    cell: createCell({ vectors: [box, 0, 0, 0, box, 0, 0, 0, box], pbc }) };
}
/** Weight of the bond between two tilts, as the engine sees them in single precision. */
function weight(tiltA, tiltB) {
  const a = Float64Array.from(Float32Array.from(axisAngleQuaternion([0, 0, 1], tiltA)));
  const b = Float64Array.from(Float32Array.from(axisAngleQuaternion([0, 0, 1], tiltB)));
  return grainEdgeWeight(latticeDisorientation(FCC, FCC, a, 0, b, 0));
}
const grainInput = (frame, ptm) => ({ ...ptm, fractional: frame.fractional, cell: frame.cell });
/** Share of atoms whose grain is the majority grain of their constructed grain. */
function purity(grainId, truth) {
  const tallies = new Map();
  for (let atom = 0; atom < grainId.length; atom += 1) {
    if (!tallies.has(truth[atom])) tallies.set(truth[atom], new Map());
    const tally = tallies.get(truth[atom]);
    tally.set(grainId[atom], (tally.get(grainId[atom]) ?? 0) + 1);
  }
  let agreeing = 0;
  const majority = new Map();
  for (const [grain, tally] of tallies) { const [id, count] = [...tally].sort((a, b) => b[1] - a[1])[0]; agreeing += count; majority.set(grain, id); }
  return { purity: agreeing / grainId.length, majority };
}

test('the disjoint set joins by size and keeps the first root on ties', () => {
  const sets = new DisjointSet(6);
  assert.equal(sets.merge(3, 1), 3, 'equal sizes: the first argument survives');
  assert.equal(sets.merge(0, 1), 3, 'the larger set survives');
  assert.equal(sets.merge(4, 5), 4);
  assert.equal(sets.merge(5, 0), 3);
  assert.equal(sets.merge(0, 4), 3, 'already joined');
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(atom => sets.find(atom)), [3, 3, 2, 3, 3, 3]);
  assert.equal(sets.size(3), 5); assert.equal(sets.size(2), 1);
  sets.clear();
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(atom => sets.find(atom)), [0, 1, 2, 3, 4, 5]);
});

test('stable ordering sorts non-negative doubles and keeps ties in place', () => {
  const random = mulberry32(8), keys = new Float64Array(5000);
  for (let index = 0; index < keys.length; index += 1) keys[index] = [0, 1e-300, Number.MAX_VALUE, Infinity, 3.5, 3.5][index % 11] ?? random() * 10 ** Math.floor(random() * 40 - 20);
  const reference = Array.from(keys.keys()).sort((a, b) => keys[a] - keys[b] || a - b);
  assertIdentical(stableAscendingOrder(keys), Uint32Array.from(reference), 'order');
  assertIdentical(stableAscendingOrder(keys, 100), Uint32Array.from(Array.from({ length: 100 }, (_, i) => i).sort((a, b) => keys[a] - keys[b] || a - b)), 'prefix');
  // Negative values, −0 and NaN take the comparison path and still give a total order.
  const mixed = Float64Array.of(2, -1, 0, -0, 5, -1, 2);
  assert.deepEqual(Array.from(stableAscendingOrder(mixed)), [1, 5, 2, 3, 0, 6, 4]);
  assert.deepEqual(Array.from(stableAscendingOrder(new Float64Array(0))), []);
  assert.deepEqual(Array.from(stableAscendingOrder(Float64Array.of(7))), [0]);
});

test('edge weights and parameter validation follow the upstream definitions', () => {
  assert.equal(grainEdgeWeight(0), 1);
  assert.equal(grainEdgeWeight(9.9e-6), 1, 'below 10⁻⁵° counts as no disorientation');
  assert.equal(grainEdgeWeight(1e-5), Math.exp(-1 / 3 * 1e-5 * 1e-5));
  close(grainEdgeWeight(3), Math.exp(-3), 1e-15);
  assert.deepEqual(validateGrainParameters(), { algorithm: 'automatic', mergeThreshold: 0, minGrainSize: 100, adoptOrphans: true, handleCoherentInterfaces: true });
  assert.deepEqual(validateGrainParameters(), { ...GRAIN_DEFAULTS });
  for (const [options, message] of [[{ algorithm: 'kmeans' }, /grain algorithm/], [{ mergeThreshold: NaN }, /merge threshold/],
    [{ mergeThreshold: '3' }, /merge threshold/], [{ algorithm: 'mst', mergeThreshold: -1 }, /cannot be negative/],
    [{ minGrainSize: 0 }, /minimum grain size/], [{ minGrainSize: 2.5 }, /minimum grain size/], [{ minGrainSize: 2 ** 31 }, /minimum grain size/],
    [{ adoptOrphans: 1 }, /on or off/], [{ handleCoherentInterfaces: 'yes' }, /on or off/]]) {
    assert.throws(() => validateGrainParameters(options), message);
  }
  assert.equal(validateGrainParameters({ algorithm: 'manual', mergeThreshold: -3 }).mergeThreshold, -3, 'a log distance may be negative');
});

test('bonds follow the neighbor list of the lower-indexed atom', () => {
  // 0 lists 1 and 2; 1 lists nothing; 2 lists 0 and 3; 3 lists 1.
  const input = handMade([{ x: 0, neighbors: [1, 2] }, { x: 3, neighbors: [] }, { x: 7, neighbors: [0, 3] }, { x: 12, neighbors: [1] }]);
  const model = buildGrainDendrogram(input, { algorithm: 'mst' });
  // Bond (1, 3) is missing: only the list of atom 3 names it.
  assert.deepEqual([Array.from(model.bonds.a), Array.from(model.bonds.b)], [[0, 0, 2], [1, 2, 3]]);
  [3, 7, 5].forEach((length, bond) => close(model.bonds.lengths[bond], length, 1e-12));
  assert.equal(model.bonds.count, 3); assert.equal(model.crystallineAtoms, 4);
});

test('bond lengths use the nearest periodic image and unmatched atoms offer eight neighbors', () => {
  const periodic = handMade([{ x: 1, neighbors: [1] }, { x: 19, neighbors: [0] }], { box: 20, pbc: [true, false, false] });
  close(buildGrainDendrogram(periodic, { algorithm: 'mst' }).bonds.lengths[0], 2, 1e-12);
  const open = handMade([{ x: 1, neighbors: [1] }, { x: 19, neighbors: [0] }], { box: 20 });
  close(buildGrainDendrogram(open, { algorithm: 'mst' }).bonds.lengths[0], 18, 1e-12);
  // An unmatched atom contributes at most its nearest eight.
  const many = handMade([{ type: 0, x: 0, neighbors: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, ...Array.from({ length: 10 }, (_, i) => ({ x: i + 1, neighbors: [] }))]);
  const model = buildGrainDendrogram(many, { algorithm: 'mst' });
  assert.deepEqual(Array.from(model.bonds.b), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(model.crystallineAtoms, 10);
  // A triclinic cell: the image is chosen in fractional coordinates.
  const skewed = handMade([{ x: 0, neighbors: [1] }, { x: 0, neighbors: [] }], { box: 10, pbc: [true, true, true] });
  skewed.cell = createCell({ vectors: [10, 0, 0, 4, 10, 0, 0, 0, 10], triclinic: true });
  skewed.fractional.set([.05, .1, .5, .95, .9, .5]);
  // Δf = (−0.1, −0.2, 0) after wrapping → (−0.1·10 − 0.2·4, −0.2·10, 0).
  close(buildGrainDendrogram(skewed, { algorithm: 'mst' }).bonds.lengths[0], Math.hypot(-1.8, -2), 1e-12);
});

test('cells too short for unambiguous neighbors are refused with the axis to replicate', async () => {
  const atoms = [{ x: 1, neighbors: [1] }, { x: 3, neighbors: [0] }];
  const spanned = handMade(atoms, { box: 4, pbc: [true, true, true] });
  spanned.neighborSpan = Float64Array.of(.2, .5 + 1e-9, .1);
  assert.throws(() => buildGrainDendrogram(spanned), /too short along cell vector B .* Replicate the structure along B first/);
  spanned.neighborSpan = Float64Array.of(.2, .5, .1);
  assert.ok(buildGrainDendrogram(spanned), 'exactly half a cell is still unambiguous');
  // Open directions are never too short.
  const open = handMade(atoms, { box: 4 });
  open.neighborSpan = Float64Array.of(.9, .9, .9);
  assert.ok(buildGrainDendrogram(open));
  // The same neighbor twice, or the atom itself: two images share one list.
  const twice = handMade([{ x: 1, neighbors: [1, 1] }, { x: 3, neighbors: [] }], { box: 4, pbc: [true, false, false] });
  assert.throws(() => buildGrainDendrogram(twice), /too short along cell vector A/);
  const self = handMade([{ x: 1, neighbors: [0] }, { x: 3, neighbors: [] }], { box: 4, pbc: [false, false, true] });
  assert.throws(() => buildGrainDendrogram(self), /too short along cell vector C/);
  // One FCC unit cell: every atom neighbors images of the other three.
  const frame = crystalFrame('fcc', 1, 3.6);
  const ptm = await calculatePtm(frame, { flags: 7, neighborLists: true });
  assert.ok(ptm.neighborSpan.every(span => span >= .5 - 1e-12));
  assert.throws(() => calculateGrains(grainInput(frame, ptm)), /too short along cell vector/);
});

test('inconsistent inputs are rejected before any work', () => {
  const good = () => handMade([{ x: 0, neighbors: [1] }, { x: 1, neighbors: [0] }]);
  for (const [corrupt, message] of [
    [input => { input.structures = Array.from(input.structures); }, /PTM structure types/],
    [input => { input.orientations = input.orientations.subarray(0, 4); }, /PTM orientations/],
    [input => { input.neighborIndices = new Uint32Array(8); }, /PTM neighbor lists/],
    [input => { input.neighborCounts = new Uint8Array(3); }, /PTM neighbor lists/],
    [input => { input.fractional = new Float64Array(3); }, /coordinates/],
    [input => { input.fractional = Array.from(input.fractional); }, /coordinates/],
    [input => { input.neighborSpan = [0, 0]; }, /neighbor span/],
    [input => { input.cell = { vectors: [1, 0, 0], pbc: [true, true, true] }; }, /simulation cell/],
    [input => { input.structures[0] = 9; }, /unknown PTM structure type/],
    [input => { input.neighborIndices[0] = 7; }, /outside the structure/],
    [input => { input.neighborCounts[0] = 17; }, /invalid PTM neighbor list/],
  ]) {
    const input = good();
    corrupt(input);
    assert.throws(() => buildGrainDendrogram(input), message);
  }
  assert.throws(() => buildGrainDendrogram({ structures: new Uint8Array(0) }), /requires PTM structure types/);
  const single = handMade([{ x: 0 }, { x: 1 }]);
  single.fractional = Float32Array.from(single.fractional);
  assert.equal(calculateGrains(single, { minGrainSize: 1 }).grainCount, 2, 'single-precision coordinates are accepted');
});

test('node pair sampling merges a path of three equal atoms at distances 2 and 3', () => {
  const input = handMade([{ x: 0, neighbors: [1] }, { x: 1, neighbors: [2] }, { x: 2, neighbors: [] }]);
  const model = buildGrainDendrogram(input, { includeRegression: true });
  // Weights are 1, node weights 1, 2, 1. d(0, 1) = d(1, 2) = 2: the lower
  // index wins the tie, and the pair joins the third atom at (1 + 2)·1/1 = 3.
  // The node with more neighbors survives a merge, the first of the pair on a tie.
  assert.equal(model.graphEdges, 2);
  assertIdentical(model.dendrogram.distance, Float64Array.of(2, 3), 'merge distance');
  assert.deepEqual([Array.from(model.dendrogram.a), Array.from(model.dendrogram.b)], [[1, 2], [0, 1]]);
  assertIdentical(model.dendrogram.size, Uint32Array.of(1, 1), 'smaller cluster');
  assertIdentical(model.dendrogram.mergeSize, Float64Array.of(1, 2 / (1 / 2 + 1)), 'harmonic mean size');
  assertIdentical(model.regression.logDistance, Float64Array.of(Math.log(2), Math.log(3)), 'log distance');
  // The orientation sum of a merged cluster has its size as norm.
  close(Math.hypot(...model.dendrogram.orientation.subarray(0, 4)), 2, 1e-6);
  close(Math.hypot(...model.dendrogram.orientation.subarray(4, 8)), 3, 1e-6);
  assert.equal(segmentGrains(model, { algorithm: 'manual', mergeThreshold: Math.log(2), minGrainSize: 1 }).grainCount, 2);
  assert.equal(segmentGrains(model, { algorithm: 'manual', mergeThreshold: Math.log(3), minGrainSize: 1 }).grainCount, 1);
  assert.equal(segmentGrains(model, { algorithm: 'manual', mergeThreshold: 0, minGrainSize: 1 }).grainCount, 3);
});

test('node pair sampling follows the weighted distance w(a) w(b) / w(a, b)', () => {
  // A path 0 – 1 – 2 with a strong and a weak bond.
  const input = handMade([{ x: 0, tilt: 0, neighbors: [1] }, { x: 1, tilt: .5, neighbors: [2] }, { x: 2, tilt: 3, neighbors: [] }]);
  const strong = weight(0, .5), weak = weight(.5, 3);
  assert.ok(weak < strong && strong < 1);
  const model = buildGrainDendrogram(input);
  // Atom 1 is nearest to 0: w(0)/strong = 1 < w(2)/weak = 1. Equal, so the
  // tie goes to atom 0; the first distance is w(0) w(1) / strong.
  close(model.dendrogram.distance[0], strong * (strong + weak) / strong, 1e-15);
  // The pair, of weight 2·strong + weak, then joins atom 2 over the weak bond.
  close(model.dendrogram.distance[1], (2 * strong + weak) * weak / weak, 1e-15);
  assert.deepEqual([model.dendrogram.a[0], model.dendrogram.b[0]].sort(), [0, 1]);
});

test('two cliques joined by one weak bond separate at the last merge', () => {
  // Atoms 0–3 and 4–7 are complete graphs; bond 3–4 crosses a 3.5° boundary.
  const clique = (first, tilt) => Array.from({ length: 4 }, (_, i) => ({ x: first + i, tilt: tilt + i * .01,
    neighbors: Array.from({ length: 4 }, (_, j) => first + j).filter(other => other !== first + i) }));
  const atoms = [...clique(0, 0), ...clique(4, 3.5)];
  atoms[3].neighbors.push(4);
  const model = buildGrainDendrogram(handMade(atoms));
  assert.equal(model.graphEdges, 13); assert.equal(model.dendrogram.count, 7);
  const last = model.dendrogram.count - 1;
  assert.ok(model.dendrogram.distance[last] > 20 * model.dendrogram.distance[last - 1], 'the bridge is far above the cliques');
  for (let index = 1; index < model.dendrogram.count; index += 1) assert.ok(model.dendrogram.distance[index] >= model.dendrogram.distance[index - 1]);
  const below = segmentGrains(model, { algorithm: 'manual', mergeThreshold: Math.log(model.dendrogram.distance[last - 1]), minGrainSize: 1 });
  assert.deepEqual(Array.from(below.grainId), [1, 1, 1, 1, 2, 2, 2, 2]);
  assert.deepEqual(Array.from(below.sizes), [4, 4]);
  close(quaternionAxisAngle(below.orientations, 0).angle, .015, 1e-4);
  close(quaternionAxisAngle(below.orientations, 4).angle, 3.515, 1e-4);
  const above = segmentGrains(model, { algorithm: 'manual', mergeThreshold: Math.log(model.dendrogram.distance[last]), minGrainSize: 1 });
  assert.deepEqual(Array.from(above.sizes), [8]);
  // A bond of 4° or more never enters the graph.
  atoms.slice(4).forEach(atom => { atom.tilt += .6; });
  const apart = buildGrainDendrogram(handMade(atoms));
  assert.equal(apart.graphEdges, 12); assert.equal(apart.dendrogram.count, 6);
  assert.equal(segmentGrains(apart, { algorithm: 'manual', mergeThreshold: 100, minGrainSize: 1 }).grainCount, 2);
});

test('the minimum spanning tree joins along bonds of increasing disorientation', () => {
  // A chain with tilts 0, 0.5, 2.5, 3; bonds of 0.5°, 2° and 0.5°.
  const input = handMade([{ x: 0, tilt: 0, neighbors: [1] }, { x: 1, tilt: .5, neighbors: [2] }, { x: 2, tilt: 2.5, neighbors: [3] }, { x: 3, tilt: 3, neighbors: [] }]);
  const model = buildGrainDendrogram(input, { algorithm: 'mst' });
  assert.equal(model.graphClustering, false); assert.equal(model.suggestedThreshold, null); assert.equal(model.regression, null);
  assert.equal(model.dendrogram.count, 3);
  // Single-precision orientations limit a small disorientation to about 10⁻³ degrees.
  for (const [index, expected] of [[0, .5], [1, .5], [2, 2]]) close(model.dendrogram.distance[index], expected, 2e-3);
  assert.equal(model.plot.unit, 'degrees');
  const one = segmentGrains(model, { algorithm: 'mst', mergeThreshold: 1, minGrainSize: 1 });
  assert.deepEqual(Array.from(one.grainId), [1, 1, 2, 2]);
  assert.equal(one.mergeThreshold, 1);
  assert.deepEqual(Array.from(segmentGrains(model, { algorithm: 'mst', mergeThreshold: 2.1, minGrainSize: 1 }).grainId), [1, 1, 1, 1]);
  assert.equal(segmentGrains(model, { algorithm: 'mst', mergeThreshold: .1, minGrainSize: 1 }).grainCount, 4);
  assert.equal(segmentGrains(model, { algorithm: 'mst', mergeThreshold: 0, minGrainSize: 1 }).grainCount, 4, 'log 0 admits no merge');
  // A model answers only the kind of algorithm it was built for.
  assert.throws(() => segmentGrains(model, { algorithm: 'manual' }), /another grain algorithm/);
  assert.throws(() => segmentGrains(buildGrainDendrogram(input), { algorithm: 'mst', mergeThreshold: 1 }), /another grain algorithm/);
  assert.equal(segmentGrains(buildGrainDendrogram(input), { algorithm: 'manual', mergeThreshold: 50, minGrainSize: 1 }).algorithm, 'manual');
});

test('the automatic threshold is the largest merge distance on the fitted line', () => {
  // Inliers on log d = 2 + 1.5 log s exactly, and three merges far above it.
  const sizes = [], distances = [];
  for (let step = 0; step < 60; step += 1) { const size = 1 + step * 1.7; sizes.push(size); distances.push(Math.exp(2 + 1.5 * Math.log(size))); }
  const largestInlier = Math.log(distances.at(-1));
  for (const [size, lift] of [[40, 3], [70, 2.5], [95, 4]]) { sizes.push(size); distances.push(Math.exp(2 + 1.5 * Math.log(size) + lift)); }
  const fit = fitMergeDistances(Float64Array.from(sizes), Float64Array.from(distances));
  close(fit.gradient, 1.5, 1e-4); close(fit.intercept, 2, 1e-3);
  assert.ok(fit.deviation < 1e-3, 'the median residual of an exact line vanishes');
  assert.ok(suggestMergeThreshold(fit) < largestInlier + 1e-9 && suggestMergeThreshold(fit) > largestInlier - .2, 'outliers above the line are excluded');
  // With scatter, every inlier within 1.5 median deviations counts.
  const random = mulberry32(4), noisy = distances.map((distance, index) => index < 60 ? distance * Math.exp((random() - .5) * .2) : distance);
  const scattered = fitMergeDistances(Float64Array.from(sizes), Float64Array.from(noisy));
  const threshold = suggestMergeThreshold(scattered);
  assert.ok(threshold > 2 + 1.5 * Math.log(60) && threshold < largestInlier + .15, String(threshold));
  assert.ok(noisy.slice(60).every(distance => Math.log(distance) > threshold));
  assert.ok(noisy.some(distance => Math.log(distance) === threshold), 'the threshold is the distance of one merge');
  // A wider cutoff admits more of the scatter.
  assert.ok(suggestMergeThreshold(scattered, 50) >= threshold);
  // No merges, and merges of one size (no slope), give the upstream fallback of zero.
  assert.equal(suggestMergeThreshold(fitMergeDistances(new Float64Array(0), new Float64Array(0))), 0);
  const flat = fitMergeDistances(Float64Array.of(1, 1, 1), Float64Array.of(2, 3, 4));
  assert.ok(Number.isNaN(flat.gradient));
  assert.equal(suggestMergeThreshold(flat), 0);
  // Distances below one have negative logarithms and never raise the threshold above zero.
  assert.equal(suggestMergeThreshold(fitMergeDistances(Float64Array.of(1, 2, 4, 8), Float64Array.of(.1, .2, .4, .8))), 0);
});

test('orphan atoms join the grain reached by the shortest chain of bonds', () => {
  // grain A: 0, 1 · orphans 2, 3 · grain B: 4, 5 (tilted 20°).
  const chain = (gap23, gap34) => handMade([
    { x: 0, neighbors: [1] }, { x: 1, neighbors: [2] }, { type: 0, x: 2.2, neighbors: [3] },
    { type: 0, x: 2.2 + gap23, neighbors: [4] }, { tilt: 20, x: 2.2 + gap23 + gap34, neighbors: [5] }, { tilt: 20, x: 3.2 + gap23 + gap34, neighbors: [] }]);
  const options = { minGrainSize: 2, algorithm: 'mst', mergeThreshold: 1 };
  const without = calculateGrains(chain(.9, 1.4), { ...options, adoptOrphans: false });
  assert.deepEqual(Array.from(without.grainId), [1, 1, 0, 0, 2, 2]);
  assert.equal(without.unassignedAtoms, 2); assert.equal(without.adoptedAtoms, 0);
  // Atom 2 is 1.2 from A; atom 3 is 1.4 from B but 1.2 + 0.9 from A.
  const near = calculateGrains(chain(.9, 1.4), options);
  assert.deepEqual(Array.from(near.grainId), [1, 1, 1, 2, 2, 2]);
  assert.deepEqual(Array.from(near.sizes), [3, 3]); assert.equal(near.adoptedAtoms, 2); assert.equal(near.unassignedAtoms, 0);
  // With atom 3 far from B, the chain through atom 2 is shorter.
  const through = calculateGrains(chain(.9, 2.5), options);
  assert.deepEqual(Array.from(through.grainId), [1, 1, 1, 1, 2, 2]);
  assert.deepEqual(Array.from(through.sizes), [4, 2]);
  // Orphans without any bond to a grain stay unassigned.
  const island = handMade([{ x: 0, neighbors: [1] }, { x: 1, neighbors: [] }, { type: 0, x: 5, neighbors: [3] }, { type: 0, x: 6, neighbors: [] }]);
  const isolated = calculateGrains(island, options);
  assert.deepEqual(Array.from(isolated.grainId), [1, 1, 0, 0]);
  assert.equal(isolated.unassignedAtoms, 2);
  // Equal path lengths: the bond listed first decides, the same way every time.
  const tie = calculateGrains(chain(1.2, 1.2), options);
  assert.deepEqual(Array.from(tie.grainId), Array.from(calculateGrains(chain(1.2, 1.2), options).grainId));
});

test('grains are numbered by final size and small clusters are dissolved', () => {
  // Three clusters of 4, 3 and 2 atoms in increasing atom order of their tilt.
  const cluster = (first, size, tilt) => Array.from({ length: size }, (_, i) => ({ x: first + i, tilt, neighbors: i + 1 < size ? [first + i + 1] : [] }));
  const atoms = [...cluster(0, 2, 0), ...cluster(2, 4, 10), ...cluster(6, 3, 20)];
  const options = { algorithm: 'mst', mergeThreshold: 1, adoptOrphans: false };
  const all = calculateGrains(handMade(atoms), { ...options, minGrainSize: 1 });
  assert.deepEqual(Array.from(all.grainId), [3, 3, 1, 1, 1, 1, 2, 2, 2]);
  assert.deepEqual(Array.from(all.sizes), [4, 3, 2]);
  assert.equal(all.largestSize, 4); assert.equal(all.meanSize, 3); assert.equal(all.assignedAtoms, 9);
  for (const [grain, tilt] of [[0, 10], [1, 20], [2, 0]]) close(quaternionAxisAngle(all.orientations, grain * 4).angle, tilt, 1e-4);
  const three = calculateGrains(handMade(atoms), { ...options, minGrainSize: 3 });
  assert.deepEqual(Array.from(three.grainId), [0, 0, 1, 1, 1, 1, 2, 2, 2]);
  assert.equal(three.unassignedAtoms, 2);
  assert.equal(calculateGrains(handMade(atoms), { ...options, minGrainSize: 5 }).grainCount, 0);
  // Equal sizes keep the order of their first atoms.
  const equal = calculateGrains(handMade([...cluster(0, 2, 30), ...cluster(2, 2, 0), ...cluster(4, 2, 15)]), { ...options, minGrainSize: 1 });
  assert.deepEqual(Array.from(equal.grainId), [1, 1, 2, 2, 3, 3]);
  // Adoption can change the ranking: the smaller grain adopts three orphans.
  const grown = handMade([...cluster(0, 3, 0), { tilt: 10, x: 10, neighbors: [4] }, { tilt: 10, x: 11, neighbors: [5] },
    { type: 0, x: 12, neighbors: [6] }, { type: 0, x: 13, neighbors: [7] }, { type: 0, x: 14, neighbors: [] }]);
  const before = calculateGrains(grown, { ...options, minGrainSize: 2 });
  assert.deepEqual(Array.from(before.grainId), [1, 1, 1, 2, 2, 0, 0, 0]);
  const after = calculateGrains(grown, { ...options, minGrainSize: 2, adoptOrphans: true });
  assert.deepEqual(Array.from(after.grainId), [2, 2, 2, 1, 1, 1, 1, 1]);
  assert.deepEqual(Array.from(after.sizes), [5, 3]);
  close(quaternionAxisAngle(after.orientations, 0).angle, 10, 1e-4);
  // Unmatched and icosahedral atoms never form a grain, whatever the minimum size.
  const other = calculateGrains(handMade([{ type: 0, x: 0, neighbors: [1] }, { type: 0, x: 1, neighbors: [] }, { type: 4, x: 5, neighbors: [3] }, { type: 4, x: 6, neighbors: [] }]),
    { ...options, minGrainSize: 1 });
  assert.deepEqual(Array.from(other.grainId), [0, 0, 1, 2], 'as upstream, a lone icosahedral atom is its own cluster');
});

test('orientations convert to axis–angle and Bunge Euler angles', () => {
  assert.deepEqual(quaternionAxisAngle([1, 0, 0, 0]), { angle: 0, axis: [0, 0, 1] });
  const turn = quaternionAxisAngle(axisAngleQuaternion([1, 2, 2], 50));
  close(turn.angle, 50, 1e-9);
  [1 / 3, 2 / 3, 2 / 3].forEach((component, axis) => close(turn.axis[axis], component, 1e-12));
  // −q is the same rotation.
  const negative = quaternionAxisAngle(axisAngleQuaternion([0, 0, 1], 30).map(value => -value));
  close(negative.angle, 30, 1e-9); close(negative.axis[2], 1, 1e-12);
  assert.deepEqual(quaternionBungeEuler([1, 0, 0, 0]), [0, 0, 0]);
  const euler = (phi1, Phi, phi2) => quaternionBungeEuler(quaternionMultiply(quaternionMultiply(
    axisAngleQuaternion([0, 0, 1], phi1), axisAngleQuaternion([1, 0, 0], Phi)), axisAngleQuaternion([0, 0, 1], phi2)));
  for (const angles of [[20, 35, 50], [200, 100, 310], [0, 40, 0], [359, 179, 1], [90, 90, 90]]) {
    euler(...angles).forEach((value, index) => close(value, angles[index], 1e-9));
  }
  // Φ = 0: only φ1 + φ2 is defined and is reported as φ1.
  euler(25, 0, 40).forEach((value, index) => close(value, [65, 0, 0][index], 1e-9));
  const offset = [9, 9, ...axisAngleQuaternion([0, 0, 1], 12)];
  close(quaternionAxisAngle(offset, 2).angle, 12, 1e-9); close(quaternionBungeEuler(offset, 2)[0], 12, 1e-9);
});

test('a bicrystal and polycrystals of each lattice give their constructed grains', async () => {
  const random = mulberry32(17);
  const cases = [
    ['fcc bicrystal', { lattice: 'fcc', a: 3.52, box: [38, 23, 23], seeds: [[9.5, 11.5, 11.5], [28.5, 11.5, 11.5]],
      orientations: [axisAngleQuaternion([0, 0, 1], 0), axisAngleQuaternion([0, 0, 1], 28)], noise: .05, seed: 3 }, FCC],
    ['fcc', { lattice: 'fcc', a: 3.52, box: [44, 44, 30], seeds: [[11, 11, 15], [33, 11, 15], [11, 33, 15], [33, 33, 15]],
      orientations: Array.from({ length: 4 }, () => randomQuaternion(random)), noise: .04, seed: 5 }, FCC],
    ['bcc', { lattice: 'bcc', a: 2.87, box: [40, 40, 28], seeds: [[10, 10, 14], [30, 10, 14], [20, 30, 14]],
      orientations: Array.from({ length: 3 }, () => randomQuaternion(random)), noise: .04, seed: 7 }, BCC],
    ['hcp', { lattice: 'hcp', a: 3.2, box: [46, 46, 32], seeds: [[11.5, 11.5, 16], [34.5, 11.5, 16], [23, 34.5, 16]],
      orientations: Array.from({ length: 3 }, () => randomQuaternion(random)), noise: .04, seed: 9 }, HCP],
  ];
  for (const [name, specification, structure] of cases) {
    const frame = polycrystalFrame(specification), grains = specification.seeds.length;
    const ptm = await calculatePtm(frame, { flags: 7, neighborLists: true });
    for (const algorithm of ['automatic', 'mst']) {
      const result = calculateGrains(grainInput(frame, ptm), { algorithm, mergeThreshold: algorithm === 'mst' ? 2 : 0 });
      assert.equal(result.grainCount, grains, `${name} ${algorithm}: grain count`);
      assert.equal(result.unassignedAtoms, 0);
      assert.equal(result.assignedAtoms, frame.ids.length);
      assertIdentical(result.structureTypes, new Uint8Array(grains).fill(structure), `${name} structure`);
      for (let grain = 1; grain < grains; grain += 1) assert.ok(result.sizes[grain] <= result.sizes[grain - 1]);
      const { purity: share, majority } = purity(result.grainId, frame.grainOf);
      assert.ok(share > .95, `${name} ${algorithm}: ${share}`);
      assert.equal(new Set(majority.values()).size, grains);
      // Each mean orientation is the constructed one, up to crystal symmetry.
      for (const [constructed, id] of majority) {
        const angle = latticeDisorientation(structure, structure, Float64Array.from(frame.orientations[constructed]), 0, result.orientations, (id - 1) * 4);
        assert.ok(angle < .5, `${name} grain ${id}: ${angle}°`);
        close(Math.hypot(...result.orientations.subarray((id - 1) * 4, id * 4)), 1, 1e-12);
      }
      // Without adoption, the atoms left out lie in the boundaries.
      const strict = calculateGrains(grainInput(frame, ptm), { algorithm, mergeThreshold: algorithm === 'mst' ? 2 : 0, adoptOrphans: false });
      assert.equal(strict.grainCount, grains);
      assert.ok(strict.unassignedAtoms > 0 && strict.unassignedAtoms < frame.ids.length);
      assert.equal(strict.assignedAtoms + strict.unassignedAtoms, frame.ids.length);
      for (let atom = 0; atom < frame.ids.length; atom += 1) if (strict.grainId[atom]) assert.equal(result.grainId[atom] > 0, true);
    }
    // The automatic threshold lies on the merge plot, and the plot leaves out small merges.
    const automatic = calculateGrains(grainInput(frame, ptm));
    assert.equal(automatic.mergeThreshold, automatic.suggestedThreshold);
    assert.ok(Array.from(automatic.plot.size).every(size => size >= GRAIN_MIN_PLOT_SIZE));
    assert.ok(Array.from(automatic.plot.distance).every((distance, index, all) => index === 0 || distance >= all[index - 1]));
    assert.equal(automatic.plot.unit, 'log');
  }
});

test('different lattices are separate grains with their own structure types', async () => {
  const frame = polycrystalFrame({ lattice: ['fcc', 'bcc', 'hcp'], a: 3.3, box: [48, 44, 30], seeds: [[12, 11, 15], [36, 11, 15], [24, 33, 15]],
    orientations: [[1, 0, 0, 0], axisAngleQuaternion([1, 0, 0], 15), axisAngleQuaternion([0, 1, 0], 20)], noise: .03, seed: 17 });
  const result = calculateGrains(grainInput(frame, await calculatePtm(frame, { flags: 7, neighborLists: true })));
  assert.equal(result.grainCount, 3);
  const { majority } = purity(result.grainId, frame.grainOf);
  assert.deepEqual([0, 1, 2].map(grain => result.structureTypes[majority.get(grain) - 1]), [FCC, BCC, HCP]);
});

test('structures without crystalline atoms or without bonds give no grains', async () => {
  // A dilute random gas: PTM matches nothing.
  const random = mulberry32(6), count = 300;
  const gas = { fractional: Float64Array.from({ length: count * 3 }, () => random()), cell: createCell({ vectors: [60, 0, 0, 0, 60, 0, 0, 0, 60] }) };
  const ptm = await calculatePtm(gas, { flags: 7, neighborLists: true });
  assert.ok(ptm.structures.every(type => type === 0));
  for (const options of [{}, { algorithm: 'manual', mergeThreshold: 20 }, { algorithm: 'mst', mergeThreshold: 3 }, { minGrainSize: 1 }]) {
    const result = calculateGrains(grainInput(gas, ptm), options);
    assert.equal(result.grainCount, 0);
    assert.ok(result.grainId.every(id => id === 0));
    assert.deepEqual([result.unassignedAtoms, result.assignedAtoms, result.adoptedAtoms, result.largestSize, result.meanSize, result.mergeCount], [count, 0, 0, 0, 0, 0]);
    assert.equal(result.plot.distance.length, 0);
    assert.equal(result.sizes.length + result.orientations.length + result.structureTypes.length, 0);
    if (!options.algorithm) assert.equal(result.mergeThreshold, 0, 'no merges: the upstream fallback threshold');
  }
  // One atom, and crystalline atoms that list no neighbors.
  const one = handMade([{ x: 1 }]);
  assert.deepEqual(Array.from(calculateGrains(one, { minGrainSize: 1 }).grainId), [1]);
  assert.equal(calculateGrains(one).grainCount, 0);
  const apart = calculateGrains(handMade([{ x: 0 }, { x: 5 }, { x: 9 }]), { minGrainSize: 1 });
  assert.deepEqual(Array.from(apart.grainId), [1, 2, 3]);
  assert.equal(apart.bondCount, 0);
});

test('an ideal single crystal is one grain', async () => {
  for (const [kind, structure] of [['fcc', FCC], ['bcc', BCC], ['hcp', HCP]]) {
    const frame = crystalFrame(kind, 5, 3.6);
    const result = calculateGrains(grainInput(frame, await calculatePtm(frame, { flags: 7, neighborLists: true })));
    assert.equal(result.grainCount, 1, kind);
    assert.deepEqual(Array.from(result.sizes), [frame.ids.length]);
    assert.equal(result.structureTypes[0], structure);
    assert.ok(result.grainId.every(id => id === 1));
    assert.ok(quaternionAxisAngle(result.orientations, 0).angle < 1e-3);
    assert.equal(result.appliedMerges, frame.ids.length - 1);
  }
});

test('stacking faults and twin boundaries join their parent grains when coherent interfaces are handled', async () => {
  // FCC matrix with an intrinsic stacking fault (two HCP layers), a twin lamella, matrix again.
  const frame = stackedLayersFrame({ steps: [...Array(8).fill(1), -1, ...Array(7).fill(1), ...Array(8).fill(-1), ...Array(6).fill(1)],
    nearest: 2.49, nx: 8, ny: 5, noise: .02, seed: 21 });
  const layer = frame.atomsPerLayer, layerOf = atom => Math.floor(atom / layer);
  const ptm = await calculatePtm(frame, { flags: 7, neighborLists: true });
  const hcpLayers = new Set();
  for (let atom = 0; atom < frame.ids.length; atom += 1) if (ptm.structures[atom] === HCP) hcpLayers.add(layerOf(atom));
  assert.deepEqual([...hcpLayers].sort((a, b) => a - b), [8, 9, 16, 24], 'two fault layers and the two twin boundaries');
  const tree = { algorithm: 'mst', mergeThreshold: 2, adoptOrphans: false };
  const handled = calculateGrains(grainInput(frame, ptm), tree);
  assert.equal(handled.grainCount, 2, 'matrix and twin');
  assert.equal(handled.unassignedAtoms, 0);
  assert.equal(handled.convertedAtoms, 4 * layer, 'every HCP atom became FCC');
  assertIdentical(handled.structureTypes, Uint8Array.of(FCC, FCC), 'parent phase');
  // The fault lies inside the matrix; the twin is the Σ3 orientation, 60° about <111>.
  const matrix = handled.grainId[0];
  for (let atom = 0; atom < frame.ids.length; atom += 1) {
    const inTwin = layerOf(atom) > 16 && layerOf(atom) < 24;
    if (layerOf(atom) !== 16 && layerOf(atom) !== 24) assert.equal(handled.grainId[atom] === matrix, !inTwin, `layer ${layerOf(atom)}`);
  }
  close(latticeDisorientation(FCC, FCC, handled.orientations, 0, handled.orientations, 4), 60, .05);
  // Without the handling the HCP layers separate the FCC slabs and form grains of their own.
  // Three FCC slabs and the two-layer fault; a single twin-boundary layer is below the minimum size.
  const plain = calculateGrains(grainInput(frame, ptm), { ...tree, handleCoherentInterfaces: false });
  assert.equal(plain.convertedAtoms, 0);
  assert.deepEqual(Array.from(plain.sizes), [13 * layer, 7 * layer, 6 * layer, 2 * layer]);
  assertIdentical(plain.structureTypes, Uint8Array.of(FCC, FCC, FCC, HCP), 'slabs and fault');
  assert.equal(plain.unassignedAtoms, 2 * layer);
  for (let atom = 0; atom < frame.ids.length; atom += 1) {
    if (plain.grainId[atom]) assert.equal(plain.structureTypes[plain.grainId[atom] - 1], ptm.structures[atom], 'a grain holds one structure type');
  }
  // HCP is the parent when it is the majority: an FCC slab joins the HCP crystal.
  const hexagonal = stackedLayersFrame({ steps: [...Array(10).fill(0).flatMap(() => [1, -1]), ...Array(6).fill(1)], nearest: 2.95, nx: 8, ny: 5, noise: .02, seed: 23 });
  const hexagonalPtm = await calculatePtm(hexagonal, { flags: 7, neighborLists: true });
  const joined = calculateGrains(grainInput(hexagonal, hexagonalPtm));
  assert.equal(joined.grainCount, 1);
  assertIdentical(joined.structureTypes, Uint8Array.of(HCP), 'hexagonal parent');
  assert.ok(joined.convertedAtoms > 0);
  const separate = calculateGrains(grainInput(hexagonal, hexagonalPtm), { ...tree, handleCoherentInterfaces: false });
  assert.deepEqual(Array.from(separate.sizes), [20 * hexagonal.atomsPerLayer, 6 * hexagonal.atomsPerLayer]);
  assertIdentical(separate.structureTypes, Uint8Array.of(HCP, FCC), 'crystal and slab');
});

test('results are deterministic and the two stages can be repeated independently', async () => {
  const frame = GRAIN_FIXTURES.bicrystal();
  const ptm = await calculatePtm(frame, { flags: 7, neighborLists: true });
  const first = calculateGrains(grainInput(frame, ptm)), second = calculateGrains(grainInput(frame, ptm));
  for (const name of ['grainId', 'sizes', 'structureTypes', 'rootStructureTypes', 'orientations']) assertIdentical(second[name], first[name], name);
  assertIdentical(second.plot.distance, first.plot.distance, 'plot distance');
  assert.equal(Object.is(second.mergeThreshold, first.mergeThreshold), true);
  // One model answers every second-stage setting, without changing.
  const model = buildGrainDendrogram(grainInput(frame, ptm));
  const snapshot = Float64Array.from(model.dendrogram.distance);
  const strict = segmentGrains(model, { adoptOrphans: false, minGrainSize: 300 });
  assertIdentical(segmentGrains(model, {}).grainId, first.grainId, 'same model, default settings');
  assertIdentical(segmentGrains(model, { adoptOrphans: false, minGrainSize: 300 }).grainId, strict.grainId, 'repeatable');
  assertIdentical(model.dendrogram.distance, snapshot, 'the model is not modified');
  // The manual algorithm at the automatic threshold is the automatic result.
  assertIdentical(segmentGrains(model, { algorithm: 'manual', mergeThreshold: model.suggestedThreshold }).grainId, first.grainId, 'manual at the automatic threshold');
  // Inputs are not modified, and progress reports each stage in order.
  const structures = Uint8Array.from(ptm.structures), orientations = Float64Array.from(ptm.orientations), stages = [];
  calculateGrains(grainInput(frame, ptm), { onProgress: stage => { if (stages.at(-1) !== stage) stages.push(stage); } });
  assertIdentical(ptm.structures, structures, 'structures'); assertIdentical(ptm.orientations, orientations, 'orientations');
  assert.deepEqual(stages, ['bonds', 'interfaces', 'disorientation', 'merging', 'threshold']);
});

for (const name of ['bicrystal', 'twinFault']) {
  test(`OVITO 3.9.4 reference: ${name} grains from OVITO's own PTM output`, async () => {
    const fixture = await loadGrainFixture(name), frame = GRAIN_FIXTURES[name]();
    assert.equal(frame.ids.length, fixture.atoms);
    const input = ovitoGrainInput(fixture, frame);
    for (const [variant, expected] of Object.entries(fixture.variants)) {
      const model = buildGrainDendrogram(input, { ...expected.options, includeRegression: true });
      const result = segmentGrains(model, expected.options);
      assert.equal(result.grainCount, expected.grainCount, `${variant}: grain count`);
      // The automatic threshold is identical to the last bit.
      if (expected.autoThreshold !== null) assert.equal(Object.is(result.mergeThreshold, expected.autoThreshold), true, `${variant}: ${result.mergeThreshold} vs ${expected.autoThreshold}`);
      // The same atoms share grains. OVITO numbers grains before orphan adoption.
      assert.equal(adjustedRandIndex(result.grainId, expected.grain), 1, `${variant}: partition`);
      const upstream = expected.options.adoptOrphans ? segmentGrains(model, { ...expected.options, adoptOrphans: false }) : result;
      const mapping = new Map();
      for (let atom = 0; atom < fixture.atoms; atom += 1) {
        if (upstream.grainId[atom]) assert.equal(upstream.grainId[atom], expected.grain[atom], `${variant}: grain of atom ${atom} in upstream order`);
        if (!mapping.has(expected.grain[atom])) mapping.set(expected.grain[atom], result.grainId[atom]);
        else assert.equal(mapping.get(expected.grain[atom]), result.grainId[atom]);
      }
      assert.equal(mapping.get(0) ?? 0, 0);
      for (const [theirs, mine] of mapping) {
        if (!theirs) continue;
        assert.equal(result.sizes[mine - 1], expected.sizes[theirs - 1], `${variant}: size of grain ${theirs}`);
        // OVITO lists the PTM type of the grain's root atom.
        assert.equal(result.rootStructureTypes[mine - 1], expected.structureTypes[theirs - 1], `${variant}: listed type of grain ${theirs}`);
        const type = result.structureTypes[mine - 1], q = expected.orientations.slice((theirs - 1) * 4, theirs * 4);
        const angle = latticeDisorientation(type, type, Float64Array.of(q[3], q[0], q[1], q[2]), 0, result.orientations, (mine - 1) * 4);
        assert.ok(angle < 1e-5, `${variant}: orientation of grain ${theirs} differs by ${angle}°`);
      }
      // Every merge distance agrees to a few units in the last place.
      if (expected.logDistance) {
        const mine = Array.from(model.regression.logDistance).filter(value => value > 0);
        assert.equal(mine.length, expected.logDistance.length, `${variant}: merges`);
        for (let index = 0; index < mine.length; index += 1) close(mine[index], expected.logDistance[index], 1e-13);
      }
      assert.equal(model.plot.distance.length, expected.plotDistance.length, `${variant}: plot points`);
      for (let index = 0; index < expected.plotDistance.length; index += 1) {
        close(model.plot.distance[index], expected.plotDistance[index], 1e-13);
        assert.equal(model.plot.size[index], expected.plotSize[index]);
      }
    }
  });
}

test('with stacking faults, AlloyView names the parent phase where OVITO names the root atom', async () => {
  const fixture = await loadGrainFixture('twinFault'), frame = GRAIN_FIXTURES.twinFault();
  const result = calculateGrains(ovitoGrainInput(fixture, frame));
  assert.deepEqual(fixture.variants.default.structureTypes.slice().sort(), [1, 1, 2], 'OVITO lists one FCC grain as HCP');
  assertIdentical(result.structureTypes, Uint8Array.of(FCC, FCC, FCC), 'the lattice each grain was merged in');
  assert.deepEqual(Array.from(result.rootStructureTypes).sort(), [1, 1, 2]);
});

test('AlloyView PTM reproduces the OVITO reference partition end to end', async () => {
  const fixture = await loadGrainFixture('bicrystal'), frame = GRAIN_FIXTURES.bicrystal();
  const ptm = await calculatePtm(frame, { flags: 7, rmsdCutoff: fixture.rmsd, neighborLists: true });
  assertIdentical(ptm.structures, fixture.ptm.structure, 'PTM structure type');
  const result = calculateGrains(grainInput(frame, ptm));
  assert.equal(adjustedRandIndex(result.grainId, fixture.variants.default.grain), 1);
  close(result.mergeThreshold, fixture.variants.default.autoThreshold, 1e-9);
  assert.deepEqual(Array.from(result.sizes), fixture.variants.default.sizes);
});

function nodeWorkerFactory(created, dispatched) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-grains-worker.mjs', import.meta.url));
    created.push(worker);
    return {
      addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfer) { dispatched.push(data); worker.postMessage(data, transfer); },
      terminate() { void worker.terminate(); },
    };
  };
}

test('a real Worker returns the direct result and keeps the merge sequence', async t => {
  const created = [], dispatched = [];
  const client = new GrainSegmentationClient({ createWorker: nodeWorkerFactory(created, dispatched) });
  t.after(() => client.dispose());
  const frame = GRAIN_FIXTURES.bicrystal(), ptm = await calculatePtm(frame, { flags: 7, neighborLists: true });
  const source = { ptm, fractional: frame.fractional, cell: frame.cell }, stages = [];
  client.warm();
  const remote = await client.segment(source, {}, { onProgress: stage => { if (stages.at(-1) !== stage) stages.push(stage); } });
  const direct = calculateGrains(grainInput(frame, ptm));
  for (const field of ['grainId', 'sizes', 'structureTypes', 'rootStructureTypes', 'orientations']) assertIdentical(remote[field], direct[field], `Worker ${field}`);
  assertIdentical(remote.plot.distance, direct.plot.distance, 'Worker plot distance'); assertIdentical(remote.plot.size, direct.plot.size, 'Worker plot size');
  for (const field of ['grainCount', 'mergeThreshold', 'suggestedThreshold', 'unassignedAtoms', 'adoptedAtoms', 'meanSize', 'largestSize', 'mergeCount', 'algorithm']) {
    assert.equal(Object.is(remote[field], direct[field]), true, field);
  }
  assert.equal(remote.worker, true); assert.equal(remote.modelReused, false);
  assert.deepEqual(stages, ['bonds', 'interfaces', 'disorientation', 'merging', 'threshold', 'grains']);
  assert.equal(created.length, 1, 'the prewarmed Worker serves the request');
  assert.equal(ptm.structures.length, frame.ids.length, 'source arrays are copied, not transferred');
  // Another minimum size, orphan setting or manual threshold sends no arrays again.
  const before = dispatched.length;
  const strict = await client.segment(source, { adoptOrphans: false, minGrainSize: 300 });
  const manual = await client.segment(source, { algorithm: 'manual', mergeThreshold: 9.5, minGrainSize: 20, adoptOrphans: false });
  assert.equal(strict.modelReused, true); assert.equal(manual.modelReused, true);
  assert.ok(dispatched.slice(before).every(message => message.input === undefined));
  const model = buildGrainDendrogram(grainInput(frame, ptm));
  assertIdentical(strict.grainId, segmentGrains(model, { adoptOrphans: false, minGrainSize: 300 }).grainId, 'second stage only');
  assertIdentical(manual.grainId, segmentGrains(model, { algorithm: 'manual', mergeThreshold: 9.5, minGrainSize: 20, adoptOrphans: false }).grainId, 'manual');
  // The minimum spanning tree and the other interface setting are other models.
  const tree = await client.segment(source, { algorithm: 'mst', mergeThreshold: 2 });
  assert.equal(tree.modelReused, false); assert.ok(dispatched.at(-1).input);
  assertIdentical(tree.grainId, calculateGrains(grainInput(frame, ptm), { algorithm: 'mst', mergeThreshold: 2 }).grainId, 'minimum spanning tree');
  // Errors arrive as rejections and do not poison the Worker.
  const thin = crystalFrame('fcc', 1, 3.6), thinPtm = await calculatePtm(thin, { flags: 7, neighborLists: true });
  await assert.rejects(client.segment({ ptm: thinPtm, fractional: thin.fractional, cell: thin.cell }), /too short along cell vector/);
  await assert.rejects(client.segment(source, { minGrainSize: 0 }), /minimum grain size/);
  await assert.rejects(client.segment({ ptm: { structures: ptm.structures }, fractional: frame.fractional, cell: frame.cell }), /PTM result with neighbor lists/);
  assertIdentical((await client.segment(source)).grainId, direct.grainId, 'after an error');
  // Releasing drops the merge sequence but keeps the Worker.
  assert.equal((await client.segment(source, { minGrainSize: 40 })).modelReused, true);
  client.release();
  assert.equal(dispatched.at(-1).type, 'release');
  const afterRelease = await client.segment(source);
  assert.equal(afterRelease.modelReused, false); assert.ok(dispatched.at(-1).input);
  assertIdentical(afterRelease.grainId, direct.grainId, 'after releasing');
  assert.equal(created.length, 1);
});

test('cancelling terminates the Worker and prewarms a new one', async t => {
  const created = [], dispatched = [];
  const client = new GrainSegmentationClient({ createWorker: nodeWorkerFactory(created, dispatched) });
  t.after(() => client.dispose());
  const frame = GRAIN_FIXTURES.bicrystal(), ptm = await calculatePtm(frame, { flags: 7, neighborLists: true });
  const source = { ptm, fractional: frame.fractional, cell: frame.cell };
  const controller = new AbortController();
  const pending = client.segment(source, {}, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(created.length, 2, 'a replacement Worker is started at once');
  assert.equal(dispatched.at(-1).type, 'warm');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(client.segment(source, {}, { signal: aborted.signal }), error => error.name === 'AbortError');
  const result = await client.segment(source);
  assert.equal(result.modelReused, false, 'the new Worker starts from the arrays');
  assertIdentical(result.grainId, calculateGrains(grainInput(frame, ptm)).grainId, 'after cancelling');
  assert.equal(created.length, 2);
});

test('without Worker support the client runs the same kernel on the calling thread', async () => {
  const permits = [];
  const cpuBudget = { acquire: async count => { permits.push(count); return { release: () => permits.push('released') }; } };
  const client = new GrainSegmentationClient({ createWorker: null, cpuBudget });
  const frame = GRAIN_FIXTURES.bicrystal(), ptm = await calculatePtm(frame, { flags: 7, neighborLists: true });
  const source = { ptm, fractional: frame.fractional, cell: frame.cell };
  client.warm();
  const local = await client.segment(source), direct = calculateGrains(grainInput(frame, ptm));
  assertIdentical(local.grainId, direct.grainId, 'local grain'); assertIdentical(local.orientations, direct.orientations, 'local orientation');
  assert.equal(local.worker, false); assert.equal(local.modelReused, false);
  assert.equal((await client.segment(source, { minGrainSize: 50 })).modelReused, true);
  assert.deepEqual(permits, [1, 'released', 1, 'released'], 'each job holds one CPU permit');
  client.dispose();
});
