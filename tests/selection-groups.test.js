import test from 'node:test';
import assert from 'node:assert/strict';
import { addSelectionGroup, normalizeSelectionGroups, updateSelectionGroup, removeSelectionGroup,
  selectSelectionGroup, setSelectionGroupMembers, selectionGroupStyles, summarizeSelectionGroups,
  parseSelectionAtomIds, MAX_SELECTION_GROUPS, MAX_SELECTION_ATOM_IDS } from '../src/selection-groups.js';

function group(id, atomIds, extra = {}) {
  return { id, name: id, color: '#22c1c3', visible: true, atomIds, ...extra };
}

test('named selections can be added, edited and amended without changing earlier states', () => {
  const empty = normalizeSelectionGroups();
  const first = addSelectionGroup(empty, { atomIds: Uint32Array.from([42, 9, 42]) });
  assert.equal(first.groups[0].name, 'Selection 1');
  assert.deepEqual(first.groups[0].atomIds, [42, 9]);
  const edited = updateSelectionGroup(first, first.selectedGroupId, { name: 'Grain boundary', color: '#ABCDEF', visible: false });
  const expanded = setSelectionGroupMembers(edited, edited.selectedGroupId, [9, '9', 12], { operation: 'add' });
  const removed = setSelectionGroupMembers(expanded, expanded.selectedGroupId, ['42'], { operation: 'remove' });
  assert.deepEqual(removed.groups[0].atomIds, [9, 12]);
  assert.equal(removed.groups[0].color, '#abcdef');
  assert.equal(removed.groups[0].visible, false);
  assert.deepEqual(first.groups[0].atomIds, [42, 9]);
  assert.equal(first.groups[0].visible, true);
  assert.deepEqual(empty.groups, []);
  assert.throws(() => removed.groups[0].atomIds.push(1), TypeError);
});

test('selections retain missing source IDs across changing frames and reordered atom rows', () => {
  const selections = normalizeSelectionGroups({ groups: [group('grain', [42, '9', 1000])], selectedGroupId: 'grain' });
  assert.deepEqual(summarizeSelectionGroups({ ids: [9, 42, 10] }, selections), [{ id: 'grain', totalCount: 3, matchedCount: 2 }]);
  assert.deepEqual(summarizeSelectionGroups({ ids: [1000, 10, 42] }, selections), [{ id: 'grain', totalCount: 3, matchedCount: 2 }]);
  assert.deepEqual(selections.groups[0].atomIds, [42, '9', 1000]);
});

test('overlapping selections use the last color and preserve hiding from any group', () => {
  const selections = normalizeSelectionGroups({ groups: [
    group('first', [1, 2], { color: '#112233', visible: false }),
    group('second', [2, 3], { color: '#abcdef' }),
  ] });
  const styles = selectionGroupStyles(selections.groups);
  assert.deepEqual(styles.get('2'), { color: '#abcdef', rgb: [171, 205, 239], visible: false });
  assert.equal(styles.get('1').visible, false);
  assert.equal(styles.get('3').visible, true);
  const shown = updateSelectionGroup(selections, 'first', { visible: true });
  assert.equal(selectionGroupStyles(shown.groups).get('2').visible, true);
  assert.equal(styles.get('2').visible, false);
});

test('deleting a selected group selects a remaining group and preserves unrelated memberships', () => {
  let selections = normalizeSelectionGroups({ groups: [group('a', [1]), group('b', [2]), group('c', [3])], selectedGroupId: 'b' });
  selections = removeSelectionGroup(selections, 'b');
  assert.equal(selections.selectedGroupId, 'c');
  selections = selectSelectionGroup(selections, 'a');
  const withoutLast = removeSelectionGroup(selections, 'c');
  assert.equal(withoutLast.selectedGroupId, 'a');
  assert.deepEqual(withoutLast.groups[0].atomIds, [1]);
  assert.deepEqual(removeSelectionGroup(withoutLast, 'a'), { groups: [], selectedGroupId: null });
});

test('manual atom ID editing deduplicates replica hits and preserves exact large labels', () => {
  assert.deepEqual(parseSelectionAtomIds('42, 0042; 9\nlabel-A 9007199254740993'), [42, 9, 'label-A', '9007199254740993']);
  const state = addSelectionGroup(normalizeSelectionGroups(), { atomIds: ['9007199254740993'] });
  assert.equal(selectionGroupStyles(state.groups).has('9007199254740993'), true);
});

test('selection import rejects malformed identifiers, canonical duplicates and unknown settings', () => {
  for (const invalid of [
    { groups: [group('a', [42, '42'])] },
    { groups: [group('a', [NaN])] },
    { groups: [group('a', [Number.MAX_SAFE_INTEGER + 1])] },
    { groups: [group('a', [1.5])] },
    { groups: [group('__proto__', [])] },
    { groups: [group('a', [])], selectedGroupId: 'missing' },
    { groups: [group('a', [], { color: '#fff' })] },
    { groups: [group('a', [], { visible: 'false' })] },
    { groups: [group('a', [], { name: '   ' })] },
    { groups: [group('a', [], { positions: [] })] },
    { groups: [group('a', []), group('a', [])] },
    { groups: [], enabled: true },
  ]) assert.throws(() => normalizeSelectionGroups(invalid), /Invalid selection groups/);
  const polluted = JSON.parse('{"groups":[],"__proto__":{"polluted":true}}');
  assert.throws(() => normalizeSelectionGroups(polluted), /__proto__/);
  assert.equal({}.polluted, undefined);
  const state = addSelectionGroup(normalizeSelectionGroups());
  assert.throws(() => setSelectionGroupMembers(state, state.selectedGroupId, [1], { operation: 'toggle' }), /operation/);
  assert.throws(() => updateSelectionGroup(state, state.selectedGroupId, { atomIds: [1] }), /atomIds/);
});

test('selection storage budgets bound both group count and total repeated memberships', () => {
  assert.throws(() => normalizeSelectionGroups({ groups: Array.from({ length: MAX_SELECTION_GROUPS + 1 }, (_, i) => group(`g${i}`, [])) }), /at most/);
  const ids = Array.from({ length: MAX_SELECTION_ATOM_IDS / 25 }, (_, i) => i + 1);
  const state = normalizeSelectionGroups({ groups: Array.from({ length: 25 }, (_, i) => group(`g${i}`, ids)) });
  assert.throws(() => addSelectionGroup(state, { atomIds: [99999] }), /stored atom IDs/);
  assert.throws(() => setSelectionGroupMembers(state, 'g0', [99999], { operation: 'add' }), /stored atom IDs/);
});
