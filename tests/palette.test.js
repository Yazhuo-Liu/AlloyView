import assert from 'node:assert/strict';
import test from 'node:test';

import {
  colorsByProperty,
  colorsByType,
  coupleScalarRange,
  SCALAR_COLOR_SCHEMES,
  visibilityByProperty,
} from '../src/render/palette.js';

test('single-species default is AtomEye-style beige and alloys remain distinguishable', () => {
  const generic = colorsByType({ types: new Uint16Array([0]), typeLabels: ['Type 1'] });
  const nickel = colorsByType({ types: new Uint16Array([0]), typeLabels: ['Ni'] });
  assert.deepEqual([...generic.colors], [218, 201, 164]);
  assert.deepEqual([...nickel.colors], [218, 201, 164]);

  const alloy = colorsByType({ types: new Uint16Array([0, 1]), typeLabels: ['Ni', 'Al'] });
  assert.notDeepEqual([...alloy.colors.slice(0, 3)], [...alloy.colors.slice(3, 6)]);
});

test('scalar coloring follows AtomEye-style jet endpoints', () => {
  const palette = colorsByProperty({ name: 'coordination', unit: '', data: new Float32Array([0, 1]) });
  assert.deepEqual([...palette.colors], [0, 0, 128, 128, 0, 0]);
  assert.equal(palette.legend.scheme, 'atomeye');
  assert.match(palette.legend.gradient, /^linear-gradient/);
});

test('scalar color schemes expose stable labels and change both colors and legend stops', () => {
  assert.deepEqual(SCALAR_COLOR_SCHEMES.map(({ value }) => value), [
    'atomeye', 'viridis', 'plasma', 'coolwarm', 'grayscale',
  ]);
  const palette = colorsByProperty(
    { name: 'coordination', unit: '', data: new Float32Array([0, 1]) },
    null,
    'viridis',
  );
  assert.deepEqual([...palette.colors], [68, 1, 84, 253, 231, 37]);
  assert.equal(palette.legend.schemeLabel, 'Viridis');
  assert.deepEqual(palette.legend.colorStops[0], [0, 68, 1, 84]);
  assert.throws(
    () => colorsByProperty({ name: 'value', data: new Float32Array([1]) }, null, 'missing'),
    /Unknown scalar color scheme/,
  );
});

test('custom scalar legend range controls color normalization and clamps outliers', () => {
  const property = { name: 'coordination', unit: '', data: new Uint32Array([4, 8, 12, 16]) };
  const palette = colorsByProperty(property, { minimum: 8, maximum: 12 });
  assert.equal(palette.legend.minimum, 8);
  assert.equal(palette.legend.maximum, 12);
  assert.equal(palette.legend.dataMinimum, 4);
  assert.equal(palette.legend.dataMaximum, 16);
  assert.equal(palette.legend.customRange, true);
  assert.deepEqual([...palette.colors.slice(0, 3)], [...palette.colors.slice(3, 6)]);
  assert.deepEqual([...palette.colors.slice(6, 9)], [...palette.colors.slice(9, 12)]);
  assert.notDeepEqual([...palette.colors.slice(3, 6)], [...palette.colors.slice(6, 9)]);
});

test('scalar legend rejects an inverted custom range', () => {
  assert.throws(
    () => colorsByProperty({ name: 'value', data: new Float32Array([1, 2]) }, { minimum: 2, maximum: 1 }),
    /maximum must be greater/,
  );
});

test('entirely NaN strain is gray with a NaN key instead of a numeric range or error', () => {
  const property = { name: 'atomicShearStrain', displayName: 'Atomic shear strain', data: new Float32Array([NaN, NaN]) };
  const { colors, legend } = colorsByProperty(property, { minimum: 0, maximum: 1 });
  assert.deepEqual([...colors], [130, 130, 130, 130, 130, 130]);
  assert.equal(legend.title, 'Atomic shear strain');
  assert.equal(legend.kind, 'types');
  assert.deepEqual(legend.items, [{ label: 'NaN', color: [130, 130, 130] }]);
});

test('AtomEye-style scalar thresholds hide only values outside the inclusive range', () => {
  const property = { data: new Float32Array([7, 8, 10, 12, 13, Number.NaN]) };
  assert.deepEqual(
    [...visibilityByProperty(property, { minimum: 8, maximum: 12 })],
    [0, 255, 255, 255, 0, 0],
  );
  assert.equal(visibilityByProperty(property, { minimum: 8, maximum: 12 }, false), null);
  assert.equal(visibilityByProperty(property, null), null);
});

test('live scalar limits push the opposite bound and always stay ordered', () => {
  assert.deepEqual(coupleScalarRange(12, 12, 'minimum', 1), { minimum: 12, maximum: 13 });
  assert.deepEqual(coupleScalarRange(8, 8, 'maximum', 1), { minimum: 7, maximum: 8 });
  assert.deepEqual(coupleScalarRange(4, 9, 'minimum', 1), { minimum: 4, maximum: 9 });
});
