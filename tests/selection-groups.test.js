import test from 'node:test';
import assert from 'node:assert/strict';
import { addSelectionGroup, normalizeSelectionGroups, updateSelectionGroup, removeSelectionGroup,
  selectSelectionGroup, setSelectionGroupMembers, selectionGroupStyles, summarizeSelectionGroups,
  selectionGroupVisibility, parseSelectionAtomIds, MAX_SELECTION_GROUPS, MAX_SELECTION_ATOM_IDS } from '../src/selection-groups.js';
import { initializeSelectionGroupControls } from '../src/selection-group-controls.js';
import { replicateFrame } from '../src/data/replicate.js';
import { crystalFrame } from './helpers/crystals.js';

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

test('selection visibility follows source IDs and hidden membership dominates visible overlaps', () => {
  const selections = normalizeSelectionGroups({ groups: [
    group('hidden', [42, '9', '9007199254740993', 'absent'], { visible: false }),
    group('shown', [9, 10], { visible: true }),
  ] });
  const first = { ids: [9, 42, 10, '9007199254740993'] };
  const second = { ids: [10, 9, '9007199254740993', 42] };
  assert.deepEqual([...selectionGroupVisibility(first, selections.groups)], [0, 0, 255, 0]);
  assert.deepEqual([...selectionGroupVisibility(second, selections.groups)], [255, 0, 0, 0]);
  assert.deepEqual(first.ids, [9, 42, 10, '9007199254740993']);
  assert.deepEqual(selections.groups[0].atomIds, [42, '9', '9007199254740993', 'absent']);
});

test('selection visibility avoids allocating a mask when no current-frame atom is hidden', () => {
  const frame = { ids: [1, 2, 3] };
  const visible = normalizeSelectionGroups({ groups: [group('shown', [1, 2])] });
  const absent = normalizeSelectionGroups({ groups: [group('missing', [99], { visible: false })] });
  assert.equal(selectionGroupVisibility(frame), null);
  assert.equal(selectionGroupVisibility(frame, visible.groups), null);
  assert.equal(selectionGroupVisibility(frame, absent.groups), null);
  assert.equal(selectionGroupVisibility(null, absent.groups), null);
  assert.equal(selectionGroupVisibility({ ids: [] }, absent.groups), null);
});

test('selection visibility reuses immutable group and ID masks and refreshes after edits', () => {
  const frame = { ids: new Uint32Array([1, 2, 3]) };
  const initial = normalizeSelectionGroups({ groups: [group('hidden', [2], { visible: false })] });
  const mask = selectionGroupVisibility(frame, initial.groups);
  assert.equal(selectionGroupVisibility(frame, initial.groups), mask);
  assert.equal(selectionGroupVisibility({ ...frame, properties: [] }, initial.groups), mask);
  assert.equal(selectionGroupVisibility(frame, selectSelectionGroup(initial, 'hidden').groups), mask);
  const amended = setSelectionGroupMembers(initial, 'hidden', [3], { operation: 'add' });
  assert.deepEqual([...selectionGroupVisibility(frame, amended.groups)], [255, 0, 0]);
  assert.deepEqual([...mask], [255, 0, 255]);
  const shown = updateSelectionGroup(amended, 'hidden', { visible: true });
  assert.equal(selectionGroupVisibility(frame, shown.groups), null);
  frame.ids = new Uint32Array([2, 3, 1]);
  const reorderedMask = selectionGroupVisibility(frame, initial.groups);
  assert.notEqual(reorderedMask, mask);
  assert.deepEqual([...reorderedMask], [0, 255, 255]);
});

test('selection visibility does not reuse stale masks for mutable caller groups', () => {
  const frame = { ids: [1, 2] }, groups = [group('editable', [1], { visible: false })];
  assert.deepEqual([...selectionGroupVisibility(frame, groups)], [0, 255]);
  groups[0].visible = true;
  assert.equal(selectionGroupVisibility(frame, groups), null);
  groups[0].visible = false;
  groups[0].atomIds = [2];
  assert.deepEqual([...selectionGroupVisibility(frame, groups)], [255, 0]);
});

test('selection visibility addresses physical copies independently and survives their row reordering', async () => {
  const source = { ...crystalFrame('sc', 1, 1), idSource: 'explicit' };
  const replicated = await replicateFrame(source, [3, 1, 1]);
  const selections = normalizeSelectionGroups({ groups: [group('copy', [replicated.ids[1]], { visible: false })] });
  assert.deepEqual([...selectionGroupVisibility(replicated, selections.groups)], [255, 0, 255]);
  assert.deepEqual([...selectionGroupVisibility({ ...replicated, ids: [replicated.ids[1], replicated.ids[0], replicated.ids[2]] }, selections.groups)], [0, 255, 255]);
  assert.equal(selectionGroupVisibility(source, selections.groups), null);
  assert.equal(source.ids.length, 1);
  assert.equal(replicated.ids.length, 3);
});

function withSelectionControls(options, run) {
  const oldDocument = globalThis.document;
  const elements = new Map();
  const makeElement = () => ({
    dataset: {}, children: [], listeners: {}, attributes: {}, style: { setProperty() {} }, value: '',
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    setCustomValidity() {}, append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
  });
  globalThis.document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
    createElement: makeElement,
  };
  try { run(initializeSelectionGroupControls(options), elements); }
  finally { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; }
}

test('hide/show selected atoms shares checkbox state and requires current-frame members', () => {
  let frame = { ids: [1, 2] };
  const changes = [];
  withSelectionControls({ getFrame: () => frame, onChange: (state, { reason }) => changes.push({ state, reason }) }, (controls, elements) => {
    const button = elements.get('toggle-selection-group-visibility');
    const checkbox = elements.get('selection-group-visible');
    assert.equal(button.disabled, true);
    controls.setEnabled(true);
    controls.selectAtoms([1]);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'Hide selected atoms');
    button.listeners.click();
    assert.equal(controls.getState().groups[0].visible, false);
    assert.equal(checkbox.checked, false);
    assert.equal(button.textContent, 'Show selected atoms');
    assert.equal(changes.at(-1).reason, 'appearance');
    button.listeners.click();
    assert.equal(controls.getState().groups[0].visible, true);
    assert.equal(checkbox.checked, true);
    checkbox.checked = false;
    checkbox.listeners.change();
    assert.equal(button.textContent, 'Show selected atoms');
    const before = controls.getState();
    frame = { ids: [2, 3] };
    controls.refresh();
    assert.equal(button.disabled, true);
    button.listeners.click();
    assert.deepEqual(controls.getState(), before);
    frame = null;
    controls.refresh();
    assert.equal(button.disabled, true);
    frame = { ids: [1, 2] };
    controls.refresh();
    assert.equal(button.disabled, false);
    controls.setEnabled(false);
    assert.equal(button.disabled, true);
  });
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
