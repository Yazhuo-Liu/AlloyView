import assert from 'node:assert/strict';
import test from 'node:test';

import { colorsByProperty, colorsByType } from '../src/render/palette.js';

test('default atom palette uses warm restrained colors instead of saturated blue', () => {
  const known = colorsByType({
    types: new Uint16Array([0, 1]),
    typeLabels: ['Ni', 'Al'],
  });
  assert.deepEqual([...known.colors], [205, 170, 112, 190, 194, 194]);

  const generic = colorsByType({ types: new Uint16Array([0]), typeLabels: ['Type 1'] });
  assert.deepEqual([...generic.colors], [214, 157, 92]);
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
