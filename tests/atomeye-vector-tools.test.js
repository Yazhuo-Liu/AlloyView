import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeAtomEyeTools } from '../src/atomeye-tools.js';

function withVectorControls(run) {
  const oldDocument = globalThis.document, elements = new Map(), draws = [];
  const makeElement = () => ({
    value: '1', checked: false, hidden: false, children: [], listeners: {},
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
    classList: { toggle() {} }, dataset: {}, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
    append(...children) { this.children.push(...children); }, prepend(...children) { this.children.unshift(...children); }, replaceChildren(...children) { this.children = children; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
  });
  globalThis.document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
    querySelectorAll: () => [], createElement: makeElement,
  };
  const frameFor = count => ({ ids: Uint32Array.from({ length: count }, (_, index) => index + 1),
    properties: ['fx', 'fy', 'fz'].map((name, axis) => ({ name, data: Float32Array.from({ length: count }, (_, atom) => atom + axis + 1) })) });
  let frame = frameFor(2);
  const renderer = { frame, atomCount: frame.ids.length, setSelectedAtoms() {},
    setVectorFields(fields) {
      for (const field of fields) assert.equal(field.vectors.length, this.atomCount * 3, 'uploads must match the displayed structure');
      this.atomVectorFields = fields; draws.push(fields);
    },
  };
  try {
    const controls = initializeAtomEyeTools({ renderer, pool: {}, tools: { setToolEnabled() {}, isToolEnabled: () => false },
      getFrame: () => frame, getFrames: () => frame ? [frame] : [], getFrameIndex: () => 0, getFrameCount: () => 1,
      getSelectedIndex: () => -1, getSourceVersion: () => 1, refresh() {}, chooseProperty() {}, onEdit() {},
    });
    const change = (id, value) => {
      const element = elements.get(id);
      if (typeof value === 'boolean') element.checked = value; else element.value = String(value);
      element.listeners.change();
    };
    run({ controls, elements, renderer, draws, change, frameFor, getFrame: () => frame, setFrame: value => { frame = value; } });
  } finally {
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
  }
}

test('vectors wait for a changed atom count to finish uploading and clear safely when the frame closes', () => {
  withVectorControls(({ controls, renderer, draws, change, frameFor, setFrame }) => {
    change('vector-mode', 'force'); change('show-vectors', true);
    assert.equal(renderer.atomVectorFields[0].vectors.length, 6);
    const expanded = frameFor(4), previousDrawCount = draws.length;
    setFrame(expanded);
    assert.doesNotThrow(() => controls.updateVectors());
    assert.equal(draws.length, previousDrawCount, 'pre-upload property refresh cannot draw new atoms against old buffers');
    renderer.frame = expanded; renderer.atomCount = 4;
    controls.updateVectors();
    assert.equal(renderer.atomVectorFields[0].vectors.length, 12, 'post-upload refresh resumes the same field');
    setFrame(null);
    controls.updateVectors();
    assert.deepEqual(renderer.atomVectorFields, []);
  });
});

test('renaming a preset component updates the field editor and preserves the rendered vectors and style', () => {
  withVectorControls(({ controls, elements, renderer, change, getFrame }) => {
    change('vector-mode', 'force'); change('show-vectors', true); change('vector-scale', 3); change('vector-anchor', 'head');
    const before = renderer.atomVectorFields[0];
    getFrame().properties[0] = { ...getFrame().properties[0], name: 'appliedForceX' };
    controls.renameProperty('fx', 'appliedForceX');
    assert.equal(elements.get('vector-mode').value, 'generic');
    assert.deepEqual(['x', 'y', 'z'].map(axis => elements.get(`vector-${axis}`).value), ['appliedForceX', 'fy', 'fz']);
    assert.deepEqual(renderer.atomVectorFields[0].vectors, before.vectors);
    assert.deepEqual(renderer.atomVectorFields[0].options, before.options);
    assert.equal(elements.get('show-vectors').checked, true);
  });
});

test('cancelling one calculated XYZ field preserves another imported vector group', () => {
  withVectorControls(({ controls, elements, renderer, change, getFrame }) => {
    getFrame().properties.push(...['X', 'Y', 'Z'].map((axis, index) => ({ name: `displacement${axis}`, analysisKind: 'displacement', data: Float32Array.of(index + 4, index + 5) })));
    change('vector-mode', 'force'); change('show-vectors', true);
    elements.get('add-vector-field').listeners.click();
    for (const axis of ['x', 'y', 'z']) change(`vector-${axis}`, `displacement${axis.toUpperCase()}`);
    change('show-vectors', true);
    assert.equal(renderer.atomVectorFields.length, 2);
    controls.cancelVectorDependency('displacement');
    assert.equal(renderer.atomVectorFields.length, 1);
    assert.deepEqual([...renderer.atomVectorFields[0].vectors], [1, 2, 3, 2, 3, 4]);
    assert.equal(elements.get('show-vectors').checked, false);
    change('vector-field-list', 'vector-1');
    assert.equal(elements.get('show-vectors').checked, true);
    assert.equal(elements.get('vector-mode').value, 'force');
  });
});
