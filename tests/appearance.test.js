import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAppearance } from '../src/appearance.js';

test('appearance follows IDs after reordering and combines visibility filters', () => {
  const frame = { ids: [42, 9, 10], types: [1, 0, 0], typeLabels: ['Fe', 'C'] };
  const colors = new Uint8Array(9).fill(128);
  const visibility = Uint8Array.from([255, 0, 255]);
  const appearance = { elements: [{ label: 'Fe', color: '#112233', radius: 1.5, visible: true }],
    atoms: [{ id: 42, color: '#abcdef', radius: 0.8, visible: false }] };
  const result = applyAppearance(frame, colors, visibility, appearance);
  assert.deepEqual([...result.colors], [171, 205, 239, 17, 34, 51, 17, 34, 51]);
  assert.deepEqual([...result.visibility], [0, 0, 255]);
  assert.ok(Math.abs(result.radii[0] - .8) < 1e-6);
  assert.equal(result.radii[1], 1.5);
  assert.deepEqual([...colors], new Array(9).fill(128));
  assert.deepEqual([...visibility], [255, 0, 255]);
});

test('scalar coloring preserves scalar colors and applies individual overrides', () => {
  const frame = { ids: [1, 2], types: [0, 0], typeLabels: ['Fe'] };
  const result = applyAppearance(frame, Uint8Array.from([1, 2, 3, 4, 5, 6]), null,
    { elements: [{ label: 'Fe', color: '#ffffff', visible: false }], atoms: [{ id: 2, color: '#ff0000' }] },
    { elementColors: false });
  assert.deepEqual([...result.colors], [1, 2, 3, 255, 0, 0]);
  assert.deepEqual([...result.visibility], [0, 0]);
});
