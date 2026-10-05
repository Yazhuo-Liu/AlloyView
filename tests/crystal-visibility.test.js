import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrystalVisibilityState } from '../src/crystal-visibility-controls.js';
import { combineVisibilityMasks, visibilityByProperty, visibilityByType } from '../src/render/palette.js';

const categories = labels => labels.map(([id, label]) => ({ id, label, color: [id, 100, 200] }));
const dxa = categories([[0, 'Other'], [1, 'FCC'], [3, 'BCC'], [4, 'Diamond'], [5, 'Hex. diamond']]);
const ptm = categories([[0, 'Other'], [1, 'FCC'], [3, 'BCC'], [4, 'ICO'], [6, 'Diamond'], [7, 'Hex. diamond']]);

function property(name, data, vocabulary) {
  return { name, data: Uint8Array.from(data), categories: vocabulary };
}

function frame(properties) {
  const count = properties[0]?.data.length ?? 5;
  return { ids: Uint32Array.from({ length: count }, (_, index) => index + 1),
    types: new Uint8Array(count), typeLabels: ['Fe'], properties };
}

test('structure filters remain active with scalar colors and intersect chemical and scalar filters', () => {
  const structure = property('dxaStructureType', [3, 0, 3, 1, 4], dxa);
  const scalar = { name: 'centralSymmetry', data: Float32Array.from([1, 2, 3, 4, 5]) };
  const input = frame([structure, scalar]);
  input.types[3] = 1;
  input.typeLabels.push('Cu');
  const changes = [];
  const state = createCrystalVisibilityState({ getFrame: () => input,
    getColorMode: () => scalar.name, onChange: reason => changes.push(reason) });
  state.refresh();
  state.setCategoryVisible(3, false);
  assert.deepEqual([...state.getMask()], [0, 255, 0, 255, 255]);
  const combined = combineVisibilityMasks(state.getMask(), visibilityByType(input, new Set(['Cu'])),
    visibilityByProperty(scalar, { minimum: 1, maximum: 4 }));
  assert.deepEqual([...combined], [0, 255, 0, 0, 0]);
  assert.equal(input.properties[0], structure);
  assert.deepEqual([...structure.data], [3, 0, 3, 1, 4]);
  assert.deepEqual(changes, ['category']);
});

test('classification vocabularies and hidden choices stay independent even when numeric IDs differ', () => {
  const input = frame([
    property('dxaStructureType', [4, 3, 5, 4, 0], dxa),
    property('ptmStructureType', [6, 3, 7, 4, 0], ptm),
  ]);
  const state = createCrystalVisibilityState({ getFrame: () => input, getColorMode: () => 'dxaStructureType' });
  state.refresh();
  assert.equal(state.getSummary().source, 'dxaStructureType');
  state.setCategoryVisible(4, false);
  assert.deepEqual([...state.getMask()], [0, 255, 255, 0, 255]);
  assert.equal(state.getSummary().items.find(item => item.id === 4).label, 'Diamond');
  state.setSource('ptmStructureType');
  assert.equal(state.getMask(), null);
  assert.equal(state.getSummary().items.find(item => item.id === 4).label, 'ICO');
  state.setCategoryVisible(6, false);
  assert.deepEqual([...state.getMask()], [0, 255, 255, 255, 255]);
  state.setSource('dxaStructureType');
  assert.deepEqual([...state.getMask()], [0, 255, 255, 0, 255]);
  assert.deepEqual(state.serialize(), { source: 'dxaStructureType',
    hiddenBySource: { ptmStructureType: [6], dxaStructureType: [4] } });
});

test('a chosen source waits for its results across frames without applying another classification', () => {
  let current = frame([property('dxaStructureType', [3, 0, 3, 1, 4], dxa)]);
  const state = createCrystalVisibilityState({ getFrame: () => current });
  state.refresh();
  state.setCategoryVisible(3, false);
  current = frame([property('ptmStructureType', [3, 0, 3, 1, 6], ptm)]);
  state.refresh();
  assert.equal(state.getSummary().source, 'dxaStructureType');
  assert.equal(state.getSummary().available, false);
  assert.equal(state.getMask(), null);
  assert.deepEqual(state.getSources().map(item => [item.name, item.available]),
    [['ptmStructureType', true], ['dxaStructureType', false]]);
  current.properties.push(property('dxaStructureType', [0, 3, 1, 3, 5], dxa));
  state.refresh();
  assert.deepEqual([...state.getMask()], [255, 0, 255, 0, 255]);
  // A result for a different physical atom count must not filter this frame.
  current.properties[1] = property('dxaStructureType', [3, 3], dxa);
  assert.equal(state.getMask(), null);
});

test('shared category legend edits invalidate cached masks, while unchanged masks reuse their allocation', () => {
  const input = frame([property('structureType', [0, 1, 3, 1, 3], dxa)]);
  const hidden = new Set([3]);
  const state = createCrystalVisibilityState({ getFrame: () => input, getHiddenCategories: () => hidden });
  state.refresh();
  const first = state.getMask();
  assert.equal(state.getMask(), first);
  state.refresh();
  assert.equal(state.getMask(), first);
  hidden.add(1);
  assert.notEqual(state.getMask(), first);
  assert.deepEqual([...state.getMask()], [255, 0, 0, 0, 0]);
  hidden.clear();
  assert.equal(state.getMask(), null);
});

test('restoring only the source preserves shared hidden categories, and restored sources may be pending', () => {
  let current = frame([property('structureType', [0, 1, 3, 1, 3], dxa)]);
  const hidden = new Map([['dxaStructureType', new Set([3])]]), changes = [];
  const state = createCrystalVisibilityState({ getFrame: () => current,
    getHiddenCategories(name) { if (!hidden.has(name)) hidden.set(name, new Set()); return hidden.get(name); },
    onChange: reason => changes.push(reason) });
  state.restore({ source: 'dxaStructureType' });
  assert.deepEqual([...hidden.get('dxaStructureType')], [3]);
  assert.equal(state.getMask(), null);
  assert.equal(state.getSummary().source, 'dxaStructureType');
  current = frame([property('dxaStructureType', [0, 3, 1, 3, 5], dxa)]);
  assert.deepEqual([...state.getMask()], [255, 0, 255, 0, 255]);
  state.restore({ source: 'dxaStructureType', hiddenBySource: { dxaStructureType: [1, 5] } });
  assert.deepEqual([...state.getMask()], [255, 255, 0, 255, 0]);
  assert.deepEqual(changes, []);
  state.reset();
  assert.deepEqual(state.serialize(), { source: null, hiddenBySource: {} });
});

test('select all and unselect all operate on the selected property categories only', () => {
  const input = frame([property('idealStrainStructureType', [1, 3, 6, 7, 0], ptm)]);
  const state = createCrystalVisibilityState({ getFrame: () => input, getColorMode: () => 'atomicShearStrain' });
  state.refresh();
  assert.equal(state.getSummary().source, 'idealStrainStructureType');
  const summary = state.getSummary();
  assert.deepEqual(summary.items.filter(item => item.count).map(item => [item.label, item.count]),
    [['Other', 1], ['FCC', 1], ['BCC', 1], ['Diamond', 1], ['Hex. diamond', 1]]);
  state.setAllVisible(false);
  assert.deepEqual([...state.getMask()], [0, 0, 0, 0, 0]);
  state.setAllVisible(true);
  assert.equal(state.getMask(), null);
  assert.equal(state.setCategoryVisible(99, false), false);
});

test('explicit source removal clears its pending choice and falls back without changing category Sets or notifying', () => {
  let current = frame([
    property('dxaStructureType', [3, 0, 3, 1, 4], dxa),
    property('ptmStructureType', [3, 0, 3, 1, 6], ptm),
  ]);
  const changes = [];
  const state = createCrystalVisibilityState({ getFrame: () => current,
    getColorMode: () => 'dxaStructureType', onChange: reason => changes.push(reason) });
  state.refresh();
  state.setCategoryVisible(3, false);
  const hidden = state.getHidden('dxaStructureType');
  current = frame([property('ptmStructureType', [3, 0, 3, 1, 6], ptm)]);
  // A normal frame with missing results preserves the selected source.
  state.refresh();
  assert.equal(state.getSummary().source, 'dxaStructureType');
  assert.equal(state.getSummary().available, false);
  assert.equal(state.getMask(), null);
  // An explicit cancellation forgets the unavailable source instead.
  assert.equal(state.forgetSource('dxaStructureType'), true);
  assert.equal(state.getSummary().source, 'ptmStructureType');
  assert.deepEqual(state.getSources().map(item => item.name), ['ptmStructureType']);
  assert.equal(state.getHidden('dxaStructureType'), hidden);
  assert.deepEqual([...hidden], [3]);
  assert.deepEqual(changes, ['category']);
  current = frame([]);
  assert.equal(state.forgetSource('ptmStructureType'), true);
  assert.equal(state.getSummary(), null);
  assert.deepEqual(state.getSources(), []);
  assert.equal(state.forgetSource('ptmStructureType'), false);
});

test('forgetting a computed source rediscovers an imported classification restored under the same name', () => {
  const input = frame([property('dxaStructureType', [3, 0, 3, 1, 4], dxa)]);
  const state = createCrystalVisibilityState({ getFrame: () => input });
  state.refresh();
  const imported = property('dxaStructureType', [0, 1, 0, 3, 5], dxa);
  input.properties = [imported];
  state.forgetSource('dxaStructureType');
  assert.equal(state.getSummary().source, 'dxaStructureType');
  assert.equal(state.getSummary().property, imported);
  assert.equal(state.getSummary().available, true);
});
