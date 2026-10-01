import assert from 'node:assert/strict';
import test from 'node:test';

import { recommendCoordinationCutoff } from '../src/analysis/cutoff.js';

test('coordination cutoff recommendation uses known metallic element labels', () => {
  const result = recommendCoordinationCutoff({ typeLabels: ['Ni'] });
  assert.equal(result.value, 2.85);
  assert.equal(result.method, 'metallic-radii');
});

test('coordination cutoff recommendation covers the largest type in an alloy', () => {
  assert.equal(recommendCoordinationCutoff({ typeLabels: ['Ni', 'Al'] }).value, 3.3);
});

test('coordination cutoff recommendation is explicit about numeric type fallback', () => {
  const result = recommendCoordinationCutoff({ typeLabels: ['Type 1'] });
  assert.equal(result.value, 3);
  assert.equal(result.method, 'fallback');
});
