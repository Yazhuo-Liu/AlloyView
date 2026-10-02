import assert from 'node:assert/strict';
import test from 'node:test';
import { STRUCTURE_TYPES } from '../src/analysis/cna.js';
import { colorsByCategory, visibilityByCategory } from '../src/render/palette.js';

test('crystal colors and counts retain OVITO type IDs and zero-count classes', () => {
  const property = { name: 'structureType', categories: STRUCTURE_TYPES, data: new Uint8Array([1, 0, 3, 1, 2, 4]) };
  const palette = colorsByCategory(property, new Set([1]));
  assert.deepEqual([...palette.colors.slice(0, 3)], [102, 255, 102]);
  assert.deepEqual(palette.legend.items.map((item) => item.count), [1, 2, 1, 1, 1]);
  assert.equal(palette.legend.items[1].visible, false);
  assert.deepEqual([...visibilityByCategory(property, new Set([1, 3]))], [0, 255, 0, 0, 255, 255]);
  assert.equal(visibilityByCategory(property, new Set()), null);
  property.data.fill(0);
  assert.equal(colorsByCategory(property).legend.items.length, 5);
});
