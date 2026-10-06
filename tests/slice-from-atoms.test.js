import assert from 'node:assert/strict';
import test from 'node:test';
import { sliceBetweenAtoms, sliceThroughAtoms, sliceThroughAtom } from '../src/slice-from-atoms.js';
import { pointVisible } from '../src/render/slicing.js';

function close(actual, expected, epsilon = 1e-10) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < epsilon,
    `${actual} differs from ${expected}`));
}

test('a two-atom slice bisects their separation and keeps the second picked atom', () => {
  const first = [-2, 3, 5], second = [4, 3, 5];
  const slice = { ...sliceBetweenAtoms(first, second), enabled: true };
  close(slice.normal, [1, 0, 0]);
  assert.equal(slice.position, 1);
  assert.equal(pointVisible(first, [slice]), false);
  assert.equal(pointVisible(second, [slice]), true);
  assert.equal(pointVisible([1, 100, -20], [slice]), true);
  const reversed = { ...sliceBetweenAtoms(second, first), enabled: true };
  assert.equal(pointVisible(first, [reversed]), true);
  assert.equal(pointVisible(second, [reversed]), false);
});

test('a three-atom plane contains translated non-axis-aligned points and follows pick order', () => {
  const points = [[10, -4, 7], [12, -2, 7], [10, -3, 9]];
  const slice = sliceThroughAtoms(...points);
  assert.ok(Math.abs(Math.hypot(...slice.normal) - 1) < 1e-12);
  for (const point of points) {
    const distance = point.reduce((sum, value, axis) => sum + value * slice.normal[axis], 0);
    assert.ok(Math.abs(distance - slice.position) < 1e-12);
  }
  const reversed = sliceThroughAtoms(points[0], points[2], points[1]);
  close(reversed.normal, slice.normal.map(value => -value));
  assert.ok(Math.abs(reversed.position + slice.position) < 1e-12);
});

test('coincident, collinear and missing atom coordinates cannot define a plane', () => {
  assert.throws(() => sliceBetweenAtoms([1, 2, 3], [1, 2, 3]), /distinct/);
  assert.throws(() => sliceBetweenAtoms([0, 0, 0], [Infinity, 2, 3]), /finite/);
  assert.throws(() => sliceThroughAtoms([0, 0, 0], [1, 2, 3], [2, 4, 6]), /collinear/);
  assert.throws(() => sliceThroughAtoms([0, 0, 0], [1, 0, 0], [1, 0, 0]), /collinear/);
  assert.throws(() => sliceThroughAtoms([0, 0, 0], [1, 0, 0], null), /finite/);
});

test('moving a slice to an atom preserves its identity, side and display settings', () => {
  const slice = { id: 'saved-plane', name: 'Defect', normal: [0, 3, 4], position: -12,
    side: 'negative', enabled: false, showGizmo: false };
  const moved = sliceThroughAtom(slice, new Float64Array([8, -5, 10]));
  assert.equal(moved.position, 5);
  close(moved.normal, [0, 0.6, 0.8]);
  for (const property of ['id', 'name', 'side', 'enabled', 'showGizmo']) assert.equal(moved[property], slice[property]);
  assert.equal(slice.position, -12);
  assert.throws(() => sliceThroughAtom(slice, [NaN, 0, 0]), /finite/);
});
