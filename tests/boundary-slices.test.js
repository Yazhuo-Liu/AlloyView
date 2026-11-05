import assert from 'node:assert/strict';
import test from 'node:test';
import { cellVertices, createCell, fractionalToCartesian } from '../src/data/model.js';
import { boundarySliceAxes, createBoundarySlices } from '../src/render/boundary-slices.js';
import { MIN_SLICE_LENGTH, millerPlane, pointVisible, validateSlices } from '../src/render/slicing.js';

const box = createCell({ origin: [10, -5, 3], vectors: [20, 0, 0, 0, 30, 0, 0, 0, 40] });
const geometry = { cell: box, positions: Float64Array.of(14, 0, 10, 26, 20, 30) };
const aOnly = [true, false, false];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('boundary trim follows atom surfaces inside vacuum instead of the cell box', () => {
  const atoms = validateSlices(createBoundarySlices(geometry, { thickness: 2, axes: aOnly }));
  const cell = validateSlices(createBoundarySlices(geometry, { thickness: 2, axes: aOnly, reference: 'cell' }));
  assert.deepEqual([atoms[0].position, atoms[0].thickness], [20, 8]);
  assert.deepEqual([cell[0].position, cell[0].thickness], [20, 16]);
  assert.equal(pointVisible([14, 10, 20], atoms), false);
  assert.equal(pointVisible([14, 10, 20], cell), true);
  assert.equal(pointVisible([16, 10, 20], atoms, 0), true, 'exact lower trim face is retained');
  assert.equal(pointVisible([24, 10, 20], atoms, 0), true, 'exact upper trim face is retained');
  assert.equal(pointVisible([16 - .001, 10, 20], atoms), false);
  assert.equal(pointVisible([24 + .001, 10, 20], atoms), false);
});

test('skew and left-handed cell trimming measures perpendicular angstroms from shifted faces', () => {
  for (const vectors of [[10, 0, 0, 6, 8, 0, 1, 2, 12], [-10, 0, 0, 6, 8, 0, 1, 2, 12]]) {
    const cell = createCell({ origin: [100, -20, 7], vectors, triclinic: true });
    const slices = validateSlices(createBoundarySlices({ cell }, { reference: 'cell', thickness: 1 }));
    const middle = fractionalToCartesian([.5, .5, .5], cell, new Float64Array(3));
    assert.equal(pointVisible(middle, slices), true);
    for (let axis = 0; axis < 3; axis++) {
      const { spacing, normal } = millerPlane([0, 1, 2].map(index => Number(index === axis)), cell.vectors);
      close(slices[axis].thickness, spacing - 2);
      slices[axis].normal.forEach((value, index) => close(value, normal[index]));
      const near = [.5, .5, .5]; near[axis] = .9 / spacing;
      assert.equal(pointVisible(fractionalToCartesian(near, cell, new Float64Array(3)), slices), false);
      near[axis] = 1.1 / spacing;
      assert.equal(pointVisible(fractionalToCartesian(near, cell, new Float64Array(3)), slices), true);
    }
    const atomSlices = createBoundarySlices({ cell, positions: cellVertices(cell) }, { thickness: 1 });
    for (let axis = 0; axis < 3; axis++) {
      close(atomSlices[axis].thickness, slices[axis].thickness);
      close(atomSlices[axis].position, slices[axis].position);
    }
  }
});

test('display replicas trim only outer faces and preserve atoms at internal cell seams', () => {
  const replicated = { ...geometry, repetitions: [3, 1, 1] };
  const atomSlices = validateSlices(createBoundarySlices(replicated, { thickness: 2, axes: aOnly }));
  const cellSlices = validateSlices(createBoundarySlices(replicated, { thickness: 2, axes: aOnly, reference: 'cell' }));
  assert.deepEqual([atomSlices[0].position, atomSlices[0].thickness], [40, 48]);
  assert.deepEqual([cellSlices[0].position, cellSlices[0].thickness], [40, 56]);
  for (const x of [26, 34, 46, 54]) assert.equal(pointVisible([x, 10, 20], atomSlices), true);
  assert.equal(pointVisible([14, 10, 20], atomSlices), false);
  assert.equal(pointVisible([66, 10, 20], atomSlices), false);
  const cell = createCell({ origin: [7, 9, 11], vectors: [-10, 0, 0, 6, 8, 0, 1, 2, 12] });
  const positions = cellVertices(cell), repetitions = [2, 3, 1];
  const source = createBoundarySlices({ cell, positions, repetitions }, { thickness: 1 });
  const reference = createBoundarySlices({ cell, repetitions }, { thickness: 1, reference: 'cell' });
  for (let axis = 0; axis < 3; axis++) {
    close(source[axis].position, reference[axis].position);
    close(source[axis].thickness, reference[axis].thickness);
  }
});

test('boundary directions prefer free surfaces, and construction leaves inputs immutable', () => {
  assert.deepEqual(boundarySliceAxes({ pbc: [true, false, true] }), [false, true, false]);
  assert.deepEqual(boundarySliceAxes({ pbc: [false, true, false] }), [true, false, true]);
  assert.deepEqual(boundarySliceAxes(box), [true, true, true]);
  assert.deepEqual(boundarySliceAxes(null), [true, true, true]);
  const input = structuredClone(geometry), settings = { thickness: 2, axes: [true, true, false] };
  const before = structuredClone({ input, settings });
  const slices = createBoundarySlices(input, settings);
  assert.equal(slices.length, 2);
  assert.ok(slices.every(slice => slice.slab && slice.side === 'negative' && slice.showGizmo === false));
  assert.deepEqual({ input, settings }, before);
  slices[0].normal[0] = 17;
  assert.deepEqual({ input, settings }, before);
});

test('invalid or excessive trims fail atomically without publishing partial slices', () => {
  for (const thickness of [0, -1, NaN, Infinity, '2', 6, 1e16]) {
    assert.throws(() => createBoundarySlices(geometry, { thickness, axes: aOnly }), /thickness|no slab/);
  }
  for (const axes of [[], [true, false], [false, false, false], [1, false, false], [true, true, null]]) {
    assert.throws(() => createBoundarySlices(geometry, { thickness: 1, axes }), /direction/);
  }
  for (const repetitions of [[0, 1, 1], [1.5, 1, 1], [1, 1], [1, 1, Infinity], ['2', 1, 1]]) {
    assert.throws(() => createBoundarySlices({ ...geometry, repetitions }, { thickness: 1 }), /repeat/);
  }
  for (const positions of [undefined, [], [1, 2], [1, 2, NaN], [1, 2, Infinity]]) {
    assert.throws(() => createBoundarySlices({ ...geometry, positions }, { thickness: 1 }), /coordinates/);
  }
  for (const cell of [null, { ...box, vectors: new Float64Array(9) }, { ...box, origin: [NaN, 0, 0] }]) {
    assert.throws(() => createBoundarySlices({ ...geometry, cell }, { thickness: 1 }), /cell/i);
  }
  assert.throws(() => createBoundarySlices(geometry, { thickness: 1, reference: 'visible' }), /bounds|faces/);
  const flat = { ...geometry, positions: Float64Array.of(0, 0, 0, 10, 0, 10) };
  const before = structuredClone(flat);
  assert.throws(() => createBoundarySlices(flat, { thickness: 1 }), /direction b/);
  assert.deepEqual(flat, before, 'failure in the second axis cannot alter input');
  const narrow = { ...geometry, positions: Float64Array.of(0, 0, 0, 2 + MIN_SLICE_LENGTH * 2, 0, 0) };
  assert.ok(createBoundarySlices(narrow, { thickness: 1, axes: aOnly })[0].thickness >= MIN_SLICE_LENGTH);
});
