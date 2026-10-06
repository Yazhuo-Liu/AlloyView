import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeSliceControls, MAX_SLICES } from '../src/slice-controls.js';

function withControls(options, run) {
  const oldDocument = globalThis.document;
  const elements = new Map();
  const makeElement = () => ({
    dataset: {}, classList: { toggle() {} }, children: [], listeners: {}, attributes: {}, value: '',
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    setCustomValidity() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
  });
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    querySelectorAll: () => [], createElement: makeElement,
  };
  try {
    const controls = initializeSliceControls(options);
    controls.setEnabled(true);
    run(controls, elements);
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
}

test('invalid selected atom planes preserve existing slices, names and current selection', () => {
  let points = [{ id: 1, position: [0, 0, 0] }, { id: 2, position: [1, 0, 0] },
    { id: 3, position: [2, 0, 0] }];
  let changed = 0;
  withControls({ getPickedPoints: () => points, onChange: () => changed++ }, (controls, elements) => {
    controls.setState({ slices: [{ id: 'custom', name: 'Defect plane', normal: [0, 0, 1], position: 7,
      side: 'negative', showGizmo: false }], selectedId: 'custom' });
    const before = controls.getState();
    assert.equal(controls.createFromPickedAtoms(3), null);
    assert.deepEqual(controls.getState(), before);
    assert.equal(changed, 0);
    assert.match(elements.get('slice-status').textContent, /collinear/);
    points = [points[0], points[0]];
    assert.equal(controls.createFromPickedAtoms(2), null);
    assert.deepEqual(controls.getState(), before);
    points = [{ id: 1, position: [0, 0, 0] }, { id: 2, position: [2, 0, 0] }];
    assert.equal(controls.createFromPickedAtoms(2).position, 1);
    assert.equal(controls.getState().slices[0].name, 'Defect plane');
    assert.equal(changed, 1);
  });
});

test('ordered slice picks resolve stable IDs against current display coordinates', () => {
  const positions = new Map([[7, [1, 2, 3]], [11, [5, 2, 3]], [42, [1, 6, 3]]]);
  const pickingChanges = [];
  withControls({ resolveAtomPoint: (id) => positions.get(id) ?? null,
    onPickModeChange: (active) => pickingChanges.push(active) }, (controls, elements) => {
    controls.setPicking(true);
    assert.equal(controls.addPickedAtom({ id: 7, position: positions.get(7) }), true);
    assert.equal(controls.addPickedAtom({ id: 7, position: positions.get(7) }), false);
    assert.equal(controls.addPickedAtom({ id: 11, position: positions.get(11) }), true);
    assert.deepEqual(controls.getPickedAtomIds(), [7, 11]);
    positions.set(7, [11, 2, 3]);
    positions.set(11, [15, 2, 3]);
    controls.refreshPickedAtoms();
    assert.equal(controls.createFromPickedAtoms(2).position, 13);
    assert.equal(controls.isPicking(), false);
    assert.deepEqual(pickingChanges, [true, false]);
    positions.delete(11);
    controls.refreshPickedAtoms();
    assert.equal(elements.get('slice-from-two').disabled, true);
    assert.match(elements.get('slice-pick-help').textContent, /absent/);
    const before = controls.getState();
    assert.equal(controls.createFromPickedAtoms(2), null);
    assert.deepEqual(controls.getState(), before);
    controls.reset();
    assert.deepEqual(controls.getPickedAtomIds(), []);
  });
});

test('three picks finish picking and can move a renamed selected slice without replacing it', () => {
  const points = [{ id: 1, position: [0, 0, 2] }, { id: 2, position: [1, 0, 2] },
    { id: 3, position: [0, 1, 2] }];
  withControls({}, (controls) => {
    controls.setPicking(true);
    for (const point of points) assert.equal(controls.addPickedAtom(point), true);
    assert.equal(controls.isPicking(), false);
    const created = controls.createFromPickedAtoms(3);
    assert.equal(created.position, 2);
    controls.setState({ slices: [{ ...created, name: 'Renamed', enabled: false, showGizmo: false }],
      selectedId: created.id });
    controls.clearPickedAtoms();
    controls.setPicking(true);
    controls.addPickedAtom({ id: 8, position: [10, 0, -4] });
    const moved = controls.moveToPickedAtom();
    assert.equal(moved.position, -4);
    assert.equal(moved.id, created.id);
    assert.equal(moved.name, 'Renamed');
    assert.equal(moved.enabled, false);
    assert.equal(moved.showGizmo, false);
    assert.equal(controls.isPicking(), false);
  });
});

test('slice picks preserve the clicked replica while refreshing the same stable atom IDs', () => {
  let positions = new Map([[7, [1, 2, 3]], [11, [5, 2, 3]]]);
  withControls({ resolveAtomPoint: (id, atom) => positions.get(id)?.map((value, axis) =>
    value + 10 * (atom.replicaIndices?.[axis] ?? 0)) ?? null }, (controls) => {
    controls.setPicking(true);
    const replicaIndices = [1, 0, 0];
    controls.addPickedAtom({ id: 7, position: [11, 2, 3], replicaIndices });
    replicaIndices[0] = 0;
    controls.addPickedAtom({ id: 11, position: [15, 2, 3], replicaIndices: [1, 0, 0] });
    assert.equal(controls.createFromPickedAtoms(2).position, 13);
    positions = new Map([[7, [3, 2, 3]], [11, [7, 2, 3]]]);
    controls.refreshPickedAtoms();
    assert.equal(controls.createFromPickedAtoms(2).position, 15);
    assert.equal(controls.moveToPickedAtom().position, 17);
    controls.setPicking(true);
    assert.equal(controls.addPickedAtom({ id: 7, position: [3, 2, 3], replicaIndices: [0, 0, 0] }), false,
      'the same atom in a different cell copy cannot masquerade as another atom');
  });
});

test('a later ordinary atom selection supersedes the slice pick while preserving same-ID replica anchors', () => {
  let selectedId = 7, selectedPoint = [1, 2, 3];
  withControls({ getSelectedAtomId: () => selectedId, getSelectedPoint: () => selectedPoint }, (controls) => {
    controls.addSlice(); controls.setPicking(true);
    controls.addPickedAtom({ id: 7, position: [11, 2, 3], replicaIndices: [1, 0, 0] });
    assert.equal(controls.moveToPickedAtom().position, 3);
    const saved = controls.getState();
    controls.setState({ ...saved, slices: saved.slices.map(slice => ({ ...slice, normal: [1, 0, 0] })) });
    assert.equal(controls.moveToPickedAtom().position, 11, 'the same selected atom keeps the actual picked cell copy');
    selectedId = 11; selectedPoint = [5, 7, 9];
    assert.equal(controls.moveToPickedAtom().position, 5, 'a later main selection replaces the older slice pick anchor');
    selectedId = 99; selectedPoint = null;
    const before = controls.getState();
    assert.equal(controls.moveToPickedAtom(), null);
    assert.deepEqual(controls.getState(), before, 'a missing ordinary selection cannot silently move to an older pick');
  });
});

test('restoring sixteen planes prevents atom-based creation without changing the restored state', () => {
  withControls({ getPickedPoints: () => [{ id: 1, position: [0, 0, 0] }, { id: 2, position: [2, 0, 0] }] },
    (controls, elements) => {
      const slices = Array.from({ length: MAX_SLICES }, (_, index) => ({
        id: `slice-${index}`, name: `Saved ${index}`, normal: [0, 0, 1], position: index,
      }));
      controls.setState({ slices, selectedId: 'slice-9' });
      const before = controls.getState();
      assert.equal(controls.createFromPickedAtoms(2), null);
      assert.deepEqual(controls.getState(), before);
      assert.equal(elements.get('slice-from-two').disabled, true);
      assert.match(elements.get('slice-status').textContent, /Maximum of 16/);
      controls.setState({ slices: slices.slice(0, 15), selectedId: 'slice-9' });
      assert.equal(controls.createFromPickedAtoms(2).id, 'slice-16');
    });
});
