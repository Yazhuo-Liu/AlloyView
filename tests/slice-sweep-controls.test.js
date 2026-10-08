import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { millerPlane } from '../src/render/slicing.js';
import { initializeSliceControls } from '../src/slice-controls.js';

// A minimal DOM: every element keeps all of its listeners so a test can
// dispatch the same events the browser would.
function withControls(options, run) {
  const oldDocument = globalThis.document;
  const elements = new Map();
  const makeElement = () => ({
    dataset: {}, classList: { toggle() {} }, children: [], listeners: {}, attributes: {},
    value: '', checked: false, disabled: false, textContent: '',
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    setCustomValidity(message) { this.validationMessage = message; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); },
    dispatch(name, values = {}) {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
      for (const listener of this.listeners[name] ?? []) listener(event);
      return event;
    },
  });
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  };
  globalThis.document = { getElementById: element, querySelectorAll: () => [], createElement: makeElement };
  try {
    const controls = initializeSliceControls(options);
    controls.setEnabled(true);
    run(controls, element);
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
}

const first = (controls) => controls.getState().slices[0];

function setInput(input, value, event = 'input') {
  input.value = value;
  input.dispatch(event);
}

test('step buttons and arrow keys sweep the selected plane by its own step', () => {
  let changes = 0;
  withControls({ onChange: () => changes++ }, (controls, element) => {
    controls.setState({ slices: [{ id: 'a', name: 'A', normal: [0, 0, 1], position: 2, side: 'positive' }], selectedId: 'a' });
    assert.equal(first(controls).step, 1, 'new and older planes default to 1 Å steps');
    element('slice-step-forward').dispatch('click', { detail: 0 });
    assert.equal(first(controls).position, 3, 'keyboard activation steps once');
    element('slice-step-back').dispatch('click', { detail: 1 });
    assert.equal(first(controls).position, 3, 'a pointer click already stepped on pointerdown');
    setInput(element('slice-step'), '0.25');
    assert.equal(first(controls).step, 0.25);
    element('slice-step-back').dispatch('click', { detail: 0 });
    assert.equal(first(controls).position, 2.75);
    assert.equal(element('slice-offset').value, '2.75', 'the position field follows each step');
    const key = element('slice-offset').dispatch('keydown', { key: 'ArrowUp' });
    assert.equal(key.defaultPrevented, true);
    element('slice-offset').dispatch('keydown', { key: 'ArrowDown' });
    element('slice-offset').dispatch('keydown', { key: 'ArrowDown' });
    assert.equal(first(controls).position, 2.5);
    element('slice-offset').dispatch('keydown', { key: 'ArrowUp', ctrlKey: true });
    element('slice-offset').dispatch('keydown', { key: 'Enter' });
    assert.equal(first(controls).position, 2.5);
    const { normal, side, name } = first(controls);
    assert.deepEqual([normal, side, name], [[0, 0, 1], 'positive', 'A'], 'steps change only the position');
    const before = changes;
    setInput(element('slice-step'), '0');
    assert.equal(element('slice-step').attributes['aria-invalid'], 'true');
    assert.equal(first(controls).step, 0.25, 'an invalid step keeps the last valid step');
    element('slice-step').dispatch('change');
    assert.equal(element('slice-step').value, '0.25');
    assert.equal(element('slice-step').attributes['aria-invalid'], undefined);
    assert.equal(changes, before, 'step edits alone do not redraw');
    controls.setEnabled(false);
    assert.equal(controls.stepSelected(1), false);
    assert.equal(first(controls).position, 2.5);
  });
});

test('holding a step button repeats smoothly until it is released', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    withControls({}, (controls, element) => {
      controls.setState({ slices: [{ id: 'a', normal: [1, 0, 0], position: 0, step: 0.5 }], selectedId: 'a' });
      const button = element('slice-step-forward');
      button.dispatch('pointerdown', { button: 0 });
      assert.equal(first(controls).position, 0.5);
      mock.timers.tick(399);
      assert.equal(first(controls).position, 0.5, 'a short press is a single step');
      mock.timers.tick(1);
      assert.equal(first(controls).position, 1);
      for (let repeat = 0; repeat < 3; repeat += 1) mock.timers.tick(80);
      assert.equal(first(controls).position, 2.5);
      button.dispatch('pointerup');
      button.dispatch('click', { detail: 1 });
      mock.timers.tick(1000);
      assert.equal(first(controls).position, 2.5);
      button.dispatch('pointerdown', { button: 2 });
      assert.equal(first(controls).position, 2.5, 'only the primary button steps');
      element('slice-step-back').dispatch('pointerdown', { button: 0 });
      mock.timers.tick(400);
      element('slice-step-back').dispatch('pointerleave');
      mock.timers.tick(1000);
      assert.equal(first(controls).position, 1.5, 'leaving the button stops the sweep');
      button.dispatch('pointerdown', { button: 0 });
      controls.setEnabled(false);
      mock.timers.tick(2000);
      assert.equal(first(controls).position, 2, 'unloading the structure stops a held sweep');
    });
  } finally {
    mock.timers.reset();
  }
});

test('flip swaps the kept side, and a slab disables side choices while keeping its thickness', () => {
  const sides = [];
  withControls({ onChange: (slices) => sides.push(slices[0].side) }, (controls, element) => {
    controls.setState({ slices: [{ id: 'a', normal: [0, 0, 1], position: 1 }], selectedId: 'a' });
    assert.equal(element('slice-thickness').disabled, true, 'thickness applies only to slabs');
    element('slice-flip').dispatch('click');
    assert.equal(first(controls).side, 'positive');
    assert.equal(element('slice-side').value, 'positive');
    element('slice-flip').dispatch('click');
    assert.deepEqual(sides, ['positive', 'negative']);
    element('slice-slab').checked = true;
    element('slice-slab').dispatch('change');
    assert.equal(first(controls).slab, true);
    assert.deepEqual([element('slice-side').disabled, element('slice-flip').disabled, element('slice-thickness').disabled],
      [true, true, false]);
    assert.equal(element('slice-list').children[0].children[2].textContent, 'Slab');
    assert.equal(controls.flipSelected(), null, 'a slab has no side to flip');
    setInput(element('slice-thickness'), '0.5');
    assert.equal(first(controls).thickness, 0.5);
    setInput(element('slice-thickness'), '-1');
    assert.equal(element('slice-thickness').attributes['aria-invalid'], 'true');
    assert.equal(first(controls).thickness, 0.5);
    element('slice-thickness').dispatch('change');
    assert.equal(element('slice-thickness').value, '0.5');
    element('slice-slab').checked = false;
    element('slice-slab').dispatch('change');
    assert.deepEqual([first(controls).slab, first(controls).thickness, first(controls).side], [false, 0.5, 'negative']);
    assert.equal(element('slice-flip').disabled, false);
  });
});

test('Miller indices set the normal, lattice-plane position, step and slab thickness from the current cell', () => {
  const a = 3.6;
  let cell = { origin: [0, 0, 0], vectors: [4 * a, 0, 0, 0, 4 * a, 0, 0, 0, 4 * a] };
  withControls({ getCell: () => cell }, (controls, element) => {
    controls.setState({ slices: [{ id: 'a', normal: [0, 0, 1], position: 7.5 }], selectedId: 'a' });
    const inputs = ['h', 'k', 'l'].map((index) => element(`slice-miller-${index}`));
    assert.deepEqual(inputs.map((input) => input.value), ['', '', '']);
    assert.equal(element('slice-apply-miller').disabled, true);
    inputs.forEach((input) => { input.value = '4'; });
    inputs[2].dispatch('input');
    assert.equal(element('slice-miller-result').textContent, 'n = (0.57735, 0.57735, 0.57735) · d = 2.07846 Å');
    assert.equal(first(controls).miller, null, 'typing previews without changing the plane');
    element('slice-apply-miller').dispatch('click');
    const plane = millerPlane([4, 4, 4], cell.vectors), applied = first(controls);
    assert.deepEqual(applied.normal, plane.normal);
    assert.deepEqual(applied.miller, [4, 4, 4]);
    assert.deepEqual([applied.step, applied.thickness], [plane.spacing, plane.spacing]);
    // The old plane's point nearest the cell center is (7.2, 7.2, 7.5).
    const order = applied.position / plane.spacing;
    assert.ok(Math.abs(order - Math.round(order)) < 1e-9, 'the plane lies on an (h k l) lattice plane');
    assert.ok(Math.abs(applied.position - (7.2 + 7.2 + 7.5) / Math.sqrt(3)) <= plane.spacing / 2);
    assert.equal(element('slice-normal-x').value, '0.57735027');
    assert.equal(element('slice-step').value, '2.078461');
    element('slice-step').dispatch('change');
    element('slice-thickness').dispatch('change');
    assert.deepEqual([first(controls).step, first(controls).thickness], [plane.spacing, plane.spacing],
      'committing an unedited rounded field keeps the exact spacing');

    setInput(element('slice-offset'), '12');
    assert.deepEqual(first(controls).normal, plane.normal, 'a position edit keeps the exact normal');
    assert.deepEqual(first(controls).miller, [4, 4, 4]);
    element('slice-step-forward').dispatch('click', { detail: 0 });
    assert.equal(first(controls).position, 12 + plane.spacing);

    setInput(element('slice-normal-x'), '1');
    element('slice-normal-x').dispatch('change');
    assert.equal(first(controls).miller, null, 'editing a normal component discards the indices');
    assert.deepEqual(inputs.map((input) => input.value), ['', '', '']);

    inputs.forEach((input) => { input.value = '4'; });
    const enter = inputs[0].dispatch('keydown', { key: 'Enter' });
    assert.equal(enter.defaultPrevented, true);
    assert.deepEqual(first(controls).miller, [4, 4, 4]);
    cell = { origin: [0, 0, 0], vectors: [4 * a, 0, 0, 0, 4 * a, 0, 0, 0, 4.4 * a] };
    controls.refreshPickedAtoms();
    assert.match(element('slice-miller-result').textContent, /apply again/);
    assert.deepEqual(first(controls).normal, plane.normal, 'a new frame does not move the plane by itself');
    element('slice-apply-miller').dispatch('click');
    assert.deepEqual(first(controls).normal, millerPlane([4, 4, 4], cell.vectors).normal);

    setInput(inputs[0], '1.5');
    assert.match(element('slice-miller-result').textContent, /integers/);
    assert.equal(inputs[0].attributes['aria-invalid'], 'true');
    assert.equal(element('slice-apply-miller').disabled, true);
    inputs.forEach((input) => { input.value = '0'; });
    inputs[0].dispatch('input');
    assert.match(element('slice-miller-result').textContent, /cannot all be zero/);
    assert.equal(controls.applyMiller(), null);
    inputs[0].value = '1';
    cell = null;
    controls.refreshPickedAtoms();
    assert.match(element('slice-miller-result').textContent, /Load a structure/);
    assert.equal(element('slice-apply-miller').disabled, true);
  });
});

test('outline choices are global, validated and kept across a source reset', () => {
  let changes = 0;
  withControls({ onChange: () => changes++ }, (controls, element) => {
    assert.deepEqual([controls.getState().showOutlines, controls.getState().exportOutlines], [false, true]);
    assert.equal(element('slice-export-outlines').disabled, true, 'export follows the shown outlines');
    element('slice-show-outlines').checked = true;
    element('slice-show-outlines').dispatch('change');
    assert.equal(controls.getState().showOutlines, true);
    assert.equal(changes, 1);
    assert.equal(element('slice-export-outlines').disabled, false);
    element('slice-export-outlines').checked = false;
    element('slice-export-outlines').dispatch('change');
    controls.reset();
    assert.deepEqual([controls.getState().showOutlines, controls.getState().exportOutlines], [true, false]);
    controls.setState({ slices: [], selectedId: null, showOutlines: false });
    assert.deepEqual([controls.getState().showOutlines, controls.getState().exportOutlines], [false, false]);
    assert.throws(() => controls.setState({ slices: [], showOutlines: 'yes' }), /true or false/);
    for (const invalid of [{ step: 0 }, { step: -1 }, { thickness: Infinity }, { miller: [0, 0, 0] },
      { miller: [1.5, 0, 0] }, { miller: [1, 0] }, { slab: 'on' }]) {
      assert.throws(() => controls.setState({ slices: [{ id: 'a', normal: [1, 0, 0], position: 0, ...invalid }] }));
    }
    controls.setState({ slices: [{ id: 'a', normal: [1, 0, 0], position: 0, miller: [1, 0, 0] }], selectedId: 'a' });
    const state = controls.getState();
    state.slices[0].miller[0] = 9;
    assert.deepEqual(first(controls).miller, [1, 0, 0], 'observers receive detached indices');
  });
});
