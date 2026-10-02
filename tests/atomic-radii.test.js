import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeRadiusPercent, radiiByType } from '../src/render/atomic-radii.js';

test('atom radii follow element labels and retain a generic fallback', () => {
  const radii = radiiByType({
    types: new Uint16Array([0, 1, 2, 0]),
    typeLabels: ['Ni', 'Al', 'Type 3'],
  });
  assert.deepEqual([...radii].map((value) => Number(value.toFixed(2))), [1.24, 1.43, 1.25, 1.24]);
});

test('radius slider stays at 20–200% while direct input supports 5–500%', () => {
  assert.equal(normalizeRadiusPercent(''), null);
  assert.deepEqual(normalizeRadiusPercent(5), { percentage: 5, sliderPercentage: 20 });
  assert.deepEqual(normalizeRadiusPercent(500), { percentage: 500, sliderPercentage: 200 });
  assert.deepEqual(normalizeRadiusPercent(5, { source: 'slider' }), { percentage: 20, sliderPercentage: 20 });
  assert.deepEqual(normalizeRadiusPercent(500, { source: 'slider' }), { percentage: 200, sliderPercentage: 200 });
});
