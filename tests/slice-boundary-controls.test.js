import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeSliceControls, MAX_SLICES } from '../src/ui/view/slice-controls.js';
import { pointVisible } from '../src/render/slicing.js';
import { createConfiguration, parseConfiguration } from '../src/application/configuration.js';

function fixture() {
  const cell = { origin: [0, 0, 0], vectors: [10, 0, 0, 0, 20, 0, 0, 0, 30], pbc: [true, true, false] };
  const positions = [];
  for (const x of [2, 5, 8]) for (const y of [4, 10, 16]) for (const z of [8, 12, 16, 20, 24]) positions.push(x, y, z);
  return { cell, positions: Float64Array.from(positions), repetitions: [1, 1, 1] };
}

function withControls(options, run) {
  const previous = globalThis.document, elements = new Map();
  const makeElement = () => ({
    dataset: {}, classList: { toggle() {} }, children: [], listeners: {}, attributes: {},
    value: '', checked: false, disabled: false, textContent: '',
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    setCustomValidity(value) { this.validationMessage = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); },
    dispatch(name, values = {}) {
      const event = { preventDefault() {}, ...values };
      for (const listener of this.listeners[name] ?? []) listener(event);
    },
  });
  const element = id => {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  };
  globalThis.document = { getElementById: element, querySelectorAll: () => [], createElement: makeElement };
  try {
    const geometry = fixture();
    const controls = initializeSliceControls({ getCell: () => geometry.cell,
      getBoundaryGeometry: () => geometry, getDefaultSlice: () => ({ normal: [0, 0, 1], position: 16 }), ...options });
    controls.setEnabled(true);
    run(controls, element, geometry);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

const chooseAxes = (element, axes) => ['a', 'b', 'c'].forEach((axis, index) => {
  element(`slice-boundary-${axis}`).checked = axes[index];
  element(`slice-boundary-${axis}`).dispatch('change');
});
const visibleCount = (positions, slices) => {
  let count = 0;
  for (let offset = 0; offset < positions.length; offset += 3) count += pointVisible(positions.subarray(offset, offset + 3), slices);
  return count;
};

test('Add slab creates an editable slab immediately and preserves source coordinates', () => {
  withControls({}, (controls, element, geometry) => {
    const before = geometry.positions.slice();
    element('add-slab').dispatch('click');
    const slice = controls.getState().slices[0];
    assert.equal(slice.slab, true); assert.equal(slice.position, 16); assert.equal(slice.thickness, 2);
    assert.equal(element('slice-thickness').disabled, false);
    assert.equal(visibleCount(geometry.positions, [slice]), 9);
    element('slice-thickness').value = '8'; element('slice-thickness').dispatch('input');
    assert.equal(visibleCount(geometry.positions, controls.getState().slices), 27);
    assert.deepEqual(geometry.positions, before);
    controls.setEnabled(false);
    assert.equal(element('add-slab').disabled, true);
    assert.equal(controls.addSlab(), null);
  });
});

test('boundary controls default to open directions and trim atom bounds through vacuum', () => {
  let changes = 0;
  withControls({ onChange: () => changes++ }, (controls, element, geometry) => {
    assert.deepEqual(['a', 'b', 'c'].map(axis => element(`slice-boundary-${axis}`).checked), [false, false, true]);
    assert.equal(element('slice-boundary-reference').value, 'atoms');
    controls.addSlice({ normal: [1, 0, 0], position: 7 });
    const existing = structuredClone(controls.getState().slices[0]);
    const before = changes;
    element('slice-boundary-thickness').value = '4';
    element('slice-boundary-apply').dispatch('click');
    const state = controls.getState();
    assert.equal(state.slices.length, 2);
    assert.deepEqual(state.slices[0], existing);
    assert.equal(state.slices[1].position, 16); assert.equal(state.slices[1].thickness, 8);
    assert.equal(state.slices[1].slab, true);
    assert.equal(visibleCount(geometry.positions, state.slices), 18);
    assert.equal(changes - before, 1, 'the whole preset is one committed edit');
    const saved = parseConfiguration(JSON.stringify(createConfiguration({ settings: { slices: {
      items: state.slices, selectedId: state.selectedId, showOutlines: true,
    } } })));
    controls.setState({ slices: saved.settings.slices.items, selectedId: saved.settings.slices.selectedId });
    assert.deepEqual(controls.getState().slices, state.slices, 'ordinary slab fields round-trip without a separate clipping format');
  });
});

test('cell-boundary presets use the box faces and all-periodic inputs default to all axes', () => {
  const geometry = fixture(); geometry.cell.pbc = [true, true, true];
  withControls({ getCell: () => geometry.cell, getBoundaryGeometry: () => geometry }, (controls, element) => {
    assert.deepEqual(['a', 'b', 'c'].map(axis => element(`slice-boundary-${axis}`).checked), [true, true, true]);
    chooseAxes(element, [false, false, true]);
    element('slice-boundary-reference').value = 'cell';
    element('slice-boundary-thickness').value = '4';
    const created = controls.addBoundarySlices();
    assert.equal(created.length, 1);
    assert.equal(created[0].position, 15); assert.equal(created[0].thickness, 22);
    assert.equal(visibleCount(geometry.positions, controls.getState().slices), 45);
  });
});

test('invalid or oversized boundary presets leave all slices and selection intact', () => {
  let changes = 0;
  withControls({ onChange: () => changes++ }, (controls, element) => {
    controls.addSlab();
    const before = controls.getState(), count = changes;
    for (const value of ['', '0', '-2', 'Infinity', '8', '100']) {
      element('slice-boundary-thickness').value = value;
      assert.equal(controls.addBoundarySlices(), null, value);
      assert.deepEqual(controls.getState(), before);
      assert.equal(changes, count);
      assert.ok(element('slice-boundary-status').textContent.length > 0);
    }
    element('slice-boundary-thickness').value = '1';
    chooseAxes(element, [false, false, false]);
    assert.equal(controls.addBoundarySlices(), null);
    assert.deepEqual(controls.getState(), before);

    controls.setState({ slices: Array.from({ length: MAX_SLICES - 1 }, (_, index) => ({
      id: `existing-${index}`, normal: [0, 0, 1], position: index,
    })), selectedId: 'existing-5' });
    chooseAxes(element, [true, true, false]);
    const full = controls.getState();
    assert.equal(controls.addBoundarySlices(), null, 'two cuts must not partially fill one available slot');
    assert.deepEqual(controls.getState(), full);
    controls.setEnabled(false);
    assert.equal(element('slice-boundary-apply').disabled, true);
    assert.equal(controls.addBoundarySlices(), null);
  });
});
