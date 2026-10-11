import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAppearance } from '../src/appearance.js';
import { normalizeSelectionGroups } from '../src/selection-groups.js';

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

test('selection colors follow stable IDs and override scalar colors beneath individual atom colors', () => {
  const groups = normalizeSelectionGroups({ groups: [
    { id: 'left', name: 'Left', color: '#112233', visible: true, atomIds: [42, 9] },
    { id: 'boundary', name: 'Boundary', color: '#abcdef', visible: true, atomIds: [9] },
  ] }).groups;
  const frame = { ids: [9, 10, 42], types: [0, 0, 0], typeLabels: ['Fe'] };
  const colors = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const result = applyAppearance(frame, colors, null,
    { atoms: [{ id: '42', color: '#ff0000' }], elements: [{ label: 'Fe', color: '#ffffff' }] },
    { elementColors: false, selectionGroups: groups });
  assert.deepEqual([...result.colors], [171, 205, 239, 4, 5, 6, 255, 0, 0]);
  assert.deepEqual([...colors], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('hidden selections combine with existing visibility filters and cannot reveal filtered atoms', () => {
  const groups = normalizeSelectionGroups({ groups: [
    { id: 'hidden', name: 'Hidden', color: '#112233', visible: false, atomIds: [1, 2] },
    { id: 'visible', name: 'Visible', color: '#abcdef', visible: true, atomIds: [2, 3] },
  ] }).groups;
  const frame = { ids: [1, 2, 3, 4], types: [0, 0, 0, 0], typeLabels: ['Fe'] };
  const visibility = Uint8Array.from([255, 255, 0, 255]);
  const result = applyAppearance(frame, new Uint8Array(12), visibility, {}, { selectionGroups: groups });
  assert.deepEqual([...result.visibility], [0, 0, 0, 255]);
  assert.deepEqual([...visibility], [255, 255, 0, 255]);
});

test('unstyled display retains palette, visibility and default radii identities while style resolution never mutates them', () => {
  const frame = { ids: Uint32Array.of(1, 2), types: Uint32Array.of(0, 0), typeLabels: ['Fe'] };
  const colors = Uint8Array.of(1, 2, 3, 4, 5, 6), visibility = Uint8Array.of(255, 0), radii = Float32Array.of(1.26, 1.26);
  const fast = applyAppearance(frame, colors, visibility, {}, { identity: true, baseRadii: radii });
  assert.equal(fast.colors, colors); assert.equal(fast.visibility, visibility); assert.equal(fast.radii, radii);
  const styled = applyAppearance(frame, colors, visibility, { atoms: [{ id: 1, color: '#ff0000', radius: 2 }] }, { identity: true, baseRadii: radii });
  assert.notEqual(styled.colors, colors); assert.notEqual(styled.radii, radii);
  assert.deepEqual([...colors], [1, 2, 3, 4, 5, 6]);
  assert.equal(radii[0], Math.fround(1.26));
  assert.equal(styled.radii[0], 2);
});
