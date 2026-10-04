import test from 'node:test';
import assert from 'node:assert/strict';
import { replicateFrame, physicalReplicationPlan } from '../src/data/replicate.js';
import { createCell, fractionalToCartesian, frameTransferables } from '../src/data/model.js';
import { calculateCoordination } from '../src/analysis/coordination.js';
import { createReferenceMapping, createReferenceMappingAsync, calculateReferenceStrain } from '../src/analysis/reference-strain.js';
import { computeDisplacements } from '../src/analysis/displacement.js';
import { crystalFrame } from './helpers/crystals.js';

function near(actual, expected, tolerance = 2e-6) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < tolerance, `${value} != ${expected[index]}`));
}

function skewFrame() {
  const cell = createCell({ origin: [3, -2, 1], vectors: [4, 1, 0, -2, 3, 1, 1, -1, 5], pbc: [true, true, true], triclinic: true });
  const fractional = Float32Array.from([.25, .2, .3, .75, .6, .8]);
  return { cell, fractional, positions: fractionalToCartesian(fractional, cell), ids: Float64Array.from([42, 9]),
    idSource: 'explicit', types: Uint16Array.from([0, 1]), typeLabels: ['Ni', 'Fe'], properties: [], title: 'tilted.cfg', sourceFormat: 'cfg' };
}

test('physical repetition enlarges tilted cell rows and atom arrays without changing the input frame', async () => {
  const frame = skewFrame();
  const result = await replicateFrame(frame, [2, 3, 2]);
  assert.equal(result.ids.length, 24);
  assert.deepEqual([...result.cell.vectors], [8, 2, 0, -6, 9, 3, 2, -2, 10]);
  assert.deepEqual([...result.cell.origin], [3, -2, 1]);
  assert.deepEqual(result.cell.pbc, frame.cell.pbc);
  assert.deepEqual(result.physicalReplication, { repetitions: [2, 3, 2], sourceAtomCount: 2 });
  near([...result.positions.slice(0, 6)], [...frame.positions]);
  near([...result.positions.slice(-6)], [...frame.positions].map((value, axis) => value + [1, 6, 7][axis % 3]));
  near([...result.fractional.slice(-6)], [.625, .7333333333, .65, .875, .8666666667, .9]);
  assert.deepEqual([...frame.cell.vectors], [4, 1, 0, -2, 3, 1, 1, -1, 5]);
  assert.equal(frame.ids.length, 2);
  assert.ok(result.fractional instanceof Float64Array);
  assert.ok(result.positions instanceof Float32Array);
});

test('physical fractional coordinates preserve sub-f32 source offsets through unit and nonbinary repeats', async () => {
  const frame = skewFrame();
  frame.fractional = Float64Array.from([.5 + 2 ** -30, .2, .3, .75, .6, .8]);
  frame.positions = fractionalToCartesian(frame.fractional, frame.cell, new Float64Array(frame.fractional.length));
  frame.unwrappedPositions = frame.positions.slice();
  const unchanged = await replicateFrame(frame, [1, 1, 1]);
  assert.deepEqual(unchanged.fractional, frame.fractional);
  assert.deepEqual(unchanged.positions, frame.positions);
  assert.deepEqual(unchanged.unwrappedPositions, frame.unwrappedPositions);
  const repeated = await replicateFrame(frame, [3, 1, 1]);
  assert.ok(repeated.positions instanceof Float64Array);
  assert.ok(repeated.unwrappedPositions instanceof Float64Array);
  assert.equal(repeated.fractional[0], frame.fractional[0] / 3);
  assert.equal(repeated.fractional[6], (frame.fractional[0] + 1) / 3);
  assert.notEqual(repeated.fractional[0], Math.fround(frame.fractional[0] / 3));
});

test('physical copies retain imported scalar/category/vector metadata and restore overwritten imports', async () => {
  const frame = skewFrame();
  const original = { name: 'coordination', data: Uint16Array.from([4, 5]), unit: 'neighbors', categorical: true,
    categories: [{ id: 4, label: 'grain', color: [1, 2, 3] }], metadata: { source: 'import' } };
  frame.properties = [
    { name: 'coordination', data: Uint32Array.from([12, 12]), analysisKind: 'coordination' },
    { name: 'force_x', data: Float64Array.from([1.2, 2.3]), unit: 'eV/Å', vectorFamily: 'force', component: 0 },
    { name: 'label', data: ['a', 'b'], categories: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    { name: 'ptmStructureType', data: Uint8Array.from([1, 1]), analysisKind: 'ptm' },
  ];
  frame.analysisOriginalProperties = new Map([['coordination', original]]);
  frame.ptm = { structures: Uint8Array.from([1, 1]) };
  frame.atomeyeResults = { localShear: { localShear: new Float32Array(2) } };
  const result = await replicateFrame(frame, [2, 1, 1]);
  assert.deepEqual(result.properties.map(({ name }) => name), ['coordination', 'force_x', 'label']);
  assert.ok(result.properties[0].data instanceof Uint16Array);
  assert.ok(result.properties[1].data instanceof Float64Array);
  assert.deepEqual([...result.properties[0].data], [4, 5, 4, 5]);
  assert.deepEqual([...result.properties[1].data], [1.2, 2.3, 1.2, 2.3]);
  assert.deepEqual(result.properties[2].data, ['a', 'b', 'a', 'b']);
  assert.deepEqual(result.properties[0].categories, original.categories);
  assert.equal(result.properties[1].vectorFamily, 'force');
  assert.equal(result.ptm, undefined);
  assert.equal(result.atomeyeResults, undefined);
  result.properties[0].categories[0].color[0] = 255;
  assert.equal(original.categories[0].color[0], 1);
  assert.equal(frame.properties[0].analysisKind, 'coordination');
});

test('replica IDs remain stable after row reordering and arbitrary source strings cannot collide', async () => {
  const first = skewFrame();
  const second = { ...first, ids: Float64Array.from([9, 42]), types: Uint16Array.from([1, 0]),
    fractional: Float32Array.from([...first.fractional.slice(3), ...first.fractional.slice(0, 3)]),
    positions: Float32Array.from([...first.positions.slice(3), ...first.positions.slice(0, 3)]) };
  const reference = await replicateFrame(first, [2, 1, 1]), current = await replicateFrame(second, [2, 1, 1]);
  assert.deepEqual([...createReferenceMapping(current, reference)], [1, 0, 3, 2]);
  assert.deepEqual([...await createReferenceMappingAsync(current, reference)], [1, 0, 3, 2]);
  assert.deepEqual(reference.ids.slice(0, 2), [42, 9]);
  const labels = { ...first, ids: ['label, with spaces', '@AlloyView:copy:1:0:0:label%2C%20with%20spaces'] };
  const labeled = await replicateFrame(labels, [2, 1, 1]);
  assert.equal(new Set(labeled.ids.map(String)).size, 4);
  assert.ok(labeled.ids[1].startsWith('@AlloyView:base:'));
  assert.ok(labeled.ids.slice(2).every((id) => !/[\s,;]/.test(id)));
  const transferred = frameTransferables(labeled);
  assert.ok(transferred.every((buffer) => buffer instanceof ArrayBuffer));
  assert.equal(new Set(transferred).size, transferred.length);
});

test('replicating a primitive simple-cubic cell changes unique-ID coordination before analysis', async () => {
  const frame = crystalFrame('sc', 1, 1);
  const source = calculateCoordination(frame, 1.01);
  const expanded = await replicateFrame(frame, [3, 3, 3]);
  const analyzed = calculateCoordination(expanded, 1.01);
  assert.deepEqual([...source.coordination], [0]);
  assert.deepEqual([...analyzed.coordination], new Array(27).fill(6));
  assert.equal(analyzed.acceptedPairs, 81);
});

test('physical trajectories rewrap old images in the expanded cell and retain continuous displacement', async () => {
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
  const source = (fraction, image) => ({ cell, ids: Float64Array.from([1]), idSource: 'explicit',
    fractional: Float32Array.from([fraction, .2, .3]), positions: Float32Array.from([fraction * 10, 2, 3]),
    unwrappedPositions: Float32Array.from([(fraction + image) * 10, 2, 3]), imageFlags: Int32Array.from([image, 0, 0]),
    types: new Uint16Array(1), typeLabels: ['Ni'], properties: [] });
  const reference = await replicateFrame(source(.95, 0), [2, 1, 1]);
  const current = await replicateFrame(source(.05, 1), [2, 1, 1]);
  near([...reference.positions], [9.5, 2, 3, 19.5, 2, 3]);
  near([...current.positions], [10.5, 2, 3, .5, 2, 3]);
  near([...current.unwrappedPositions], [10.5, 2, 3, 20.5, 2, 3]);
  assert.deepEqual([...current.imageFlags], [0, 0, 0, 1, 0, 0]);
  const result = await computeDisplacements(current, reference);
  near([...result.vectors], [1, 0, 0, 1, 0, 0]);
  const withoutFlags = source(.05, 1);
  delete withoutFlags.imageFlags;
  const inferred = await replicateFrame(withoutFlags, [2, 1, 1]);
  near([...inferred.positions], [...current.positions]);
  assert.deepEqual([...inferred.imageFlags], [...current.imageFlags]);
  const withoutUnwrapped = source(.05, 1);
  delete withoutUnwrapped.unwrappedPositions;
  const reconstructed = await replicateFrame(withoutUnwrapped, [2, 1, 1]);
  near([...reconstructed.unwrappedPositions], [...current.unwrappedPositions]);
});

test('reference strain accepts replicated IDs and remains zero for an unchanged expanded crystal', async () => {
  const source = { ...crystalFrame('fcc', 1, 4), idSource: 'explicit' };
  const reference = await replicateFrame(source, [3, 3, 3]), current = await replicateFrame(source, [3, 3, 3]);
  const result = calculateReferenceStrain(current, { referenceFractional: reference.fractional, referenceCell: reference.cell,
    referenceMapping: createReferenceMapping(current, reference), cutoff: 3.1 });
  assert.equal(result.incomplete, 0);
  near([...result.referenceShearStrain], new Array(current.ids.length).fill(0));
});

test('physical replication rejects nonperiodic repeats, malformed properties and resource limits before changing source', async () => {
  const frame = skewFrame();
  frame.cell.pbc[1] = false;
  await assert.rejects(replicateFrame(frame, [2, 2, 1]), /periodic cell directions/);
  assert.equal((await replicateFrame(frame, [2, 1, 1])).ids.length, 4);
  assert.throws(() => physicalReplicationPlan(frame, [2, 1, 1], { maxAtoms: 3 }), /limit is 3/);
  assert.throws(() => physicalReplicationPlan(frame, [2, 1, 1], { maxBytes: 1 }), /memory limit/);
  frame.properties.push({ name: 'bad', data: new Float32Array(1) });
  await assert.rejects(replicateFrame(frame, [2, 1, 1]), /invalid property/);
  assert.equal(frame.ids.length, 2);
});

test('physical replication yields to cancellation and never returns a partially expanded frame', async () => {
  const frame = crystalFrame('sc', 4, 1), controller = new AbortController();
  await assert.rejects(replicateFrame(frame, [512, 1, 1], { signal: controller.signal,
    onProgress: ({ completedAtoms, totalAtoms }) => { if (completedAtoms < totalAtoms) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(frame.ids.length, 64);
  await assert.rejects(replicateFrame(frame, [1, 1, 1], { signal: controller.signal }), { name: 'AbortError' });
});
