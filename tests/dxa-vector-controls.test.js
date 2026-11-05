import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeDxaTools } from '../src/ui/analysis/dxa-tools.js';
import { createConfiguration, parseConfiguration } from '../src/application/configuration.js';
import { dislocationSegmentSignature } from '../src/render/dislocation-vector-state.js';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map();
    this.value = ''; this.checked = false; this.hidden = false; this.disabled = false; this.textContent = '';
    this.style = {}; this.classList = { toggle() {} };
  }
  get valueAsNumber() { return Number(this.value); }
  setAttribute(name, value) { this[name] = String(value); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(selector === 'input' && child.tagName === 'INPUT' ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  dispatch(name) { this.listeners.get(name)?.({ target: this }); }
}

function network(id = 3, length = 4) {
  return { segments: [{ id, familyId: 'perfect', points: Float64Array.of(0, 0, 0, 0, 0, length),
    burgersVector: [.5, .5, 0], spatialBurgersVector: [0, 0, 2], closed: false, isInfinite: false }],
  counts: { perfect: 1 }, totalLength: length, density: length / 1000, elapsedMs: 10,
  engine: 'Wasm CPU', backend: 'cpu', workerCount: 1 };
}

function harness(t) {
  const previous = globalThis.document;
  const ids = ['dxa-lattice', 'dxa-trial-length', 'dxa-stretchability', 'dxa-smoothing', 'dxa-point-interval',
    'dxa-perfect-only', 'dxa-line-radius', 'run-dxa', 'cancel-dxa', 'dxa-families', 'dxa-state', 'dxa-results',
    'dxa-summary', 'dxa-status', 'dxa-show-line-directions', 'dxa-show-burgers-vectors', 'dxa-burgers-scale',
    'dxa-vector-selection', 'dxa-vector-position', 'dxa-vector-flip', 'dxa-vector-clear', 'dxa-vector-selected', 'dxa-vector-position-value'];
  const fields = Object.fromEntries(ids.map(id => [id, new Element()]));
  globalThis.document = { getElementById: id => fields[id], createElement: tag => new Element(tag) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const frame = { ids: Uint32Array.of(1, 2, 3, 4), properties: [] };
  const h = { fields, next: network(), analyses: 0, edits: 0, notifications: [] };
  h.renderer = { setDislocationNetwork(result, options) { this.network = result; this.options = options; } };
  h.tools = initializeDxaTools({ renderer: h.renderer, tools: { setToolEnabled() {} },
    client: { async analyze() { h.analyses++; return h.next; } }, getFrame: () => frame, getSourceVersion: () => 'same-source',
    onEdit: () => h.edits++, notify: value => h.notifications.push(value), automaticDelayMs: 0 });
  h.tools.setEnabled(true);
  h.change = (id, value) => { if (typeof value === 'boolean') fields[id].checked = value; else fields[id].value = String(value); fields[id].dispatch('change'); };
  return h;
}

test('DXA vector appearance defaults to 0.75 Å and edits never recalculate or mutate the extracted network', async t => {
  const h = harness(t);
  assert.equal(h.tools.serialize().radius, .75); assert.equal(h.fields['dxa-line-radius'].value, '0.75');
  assert.equal(h.fields['dxa-show-line-directions'].checked, false);
  assert.equal(h.fields['dxa-show-burgers-vectors'].checked, false);
  await h.tools.run();
  const raw = structuredClone(h.renderer.network), analyses = h.analyses;
  assert.equal(h.tools.selectVector(3), false, 'hidden Burgers vectors cannot be selected');
  h.change('dxa-show-line-directions', true); h.change('dxa-show-burgers-vectors', true);
  assert.equal(h.renderer.options.showLineDirections, true); assert.equal(h.renderer.options.showBurgersVectors, true);
  assert.equal(h.tools.selectVector(3), true);
  assert.equal(h.fields['dxa-vector-selection'].hidden, false);
  assert.equal(h.tools.moveVector(3, { position: .2 }), true);
  assert.equal(h.fields['dxa-vector-position'].value, '20');
  h.fields['dxa-vector-flip'].dispatch('click');
  const annotation = h.tools.serialize().vectorAnnotations[0];
  assert.deepEqual(annotation, { segmentId: 3, position: .2, flipped: true, signature: dislocationSegmentSignature(raw.segments[0]) });
  assert.match(h.fields['dxa-vector-selected'].textContent, /-0\.5/);
  for (const position of [NaN, Infinity, -.1, 1.1]) assert.equal(h.tools.moveVector(3, { position }), false);
  assert.equal(h.tools.moveVector(99, { position: .5 }), false);
  assert.deepEqual(h.renderer.network, raw);
  assert.equal(h.analyses, analyses);
  h.change('dxa-burgers-scale', 3); assert.equal(h.renderer.options.burgersVectorScale, 3);
  h.change('dxa-burgers-scale', 0); assert.equal(h.renderer.options.burgersVectorScale, 3);
  assert.ok(h.notifications.length);
  h.change('dxa-show-burgers-vectors', false);
  assert.equal(h.fields['dxa-vector-selection'].hidden, true); assert.equal(h.tools.flipVector(3), false);
  h.tools.reset();
  assert.equal(h.tools.serialize().radius, .75);
  assert.equal(h.tools.serialize().vectorAnnotations, undefined);
});

test('DXA vector recipes round-trip and remap annotations by extracted curve signature rather than numeric ID', async t => {
  const h = harness(t); await h.tools.run();
  h.change('dxa-show-burgers-vectors', true); h.change('dxa-show-line-directions', true);
  h.tools.selectVector(3); h.tools.moveVector(3, { position: .75 }); h.tools.flipVector();
  const saved = parseConfiguration(JSON.stringify(createConfiguration({ settings: { extensions: { dxa: h.tools.serialize() } } }))).settings.extensions.dxa;
  h.next = network(77);
  await h.tools.restore(saved);
  assert.equal(h.tools.serialize().vectorAnnotations[0].segmentId, 77);
  assert.equal(h.tools.serialize().vectorAnnotations[0].position, .75);
  assert.equal(h.tools.serialize().vectorAnnotations[0].flipped, true);
  h.next = network(3, 8);
  await h.tools.restore(saved);
  assert.deepEqual(h.tools.serialize().vectorAnnotations, [], 'a reused ID on a different curve must not restore old edits');
});

test('DXA configuration validates vector settings and preserves legacy explicit radii', () => {
  const config = dxa => createConfiguration({ settings: { extensions: { dxa } } });
  assert.equal(config({}).settings.extensions.dxa.radius, .75);
  assert.equal(config({ radius: .35 }).settings.extensions.dxa.radius, .35);
  assert.equal(config({}).settings.extensions.dxa.vectorAnnotations, undefined);
  const entry = { segmentId: 3, position: .4, flipped: true, signature: '0123456789abcdef' };
  const valid = config({ showLineDirections: true, showBurgersVectors: true, burgersVectorScale: 2.5, vectorAnnotations: [entry] });
  assert.deepEqual(parseConfiguration(JSON.stringify(valid)), valid);
  for (const invalid of [
    { showLineDirections: 'yes' }, { showBurgersVectors: 1 }, { burgersVectorScale: 0 }, { burgersVectorScale: Infinity },
    { burgersVectorScale: 1e6 + 1 },
    ...[{ position: -1 }, { position: 2 }, { segmentId: 1.5 }, { segmentId: -1 }, { flipped: 'true' },
      { signature: 'not-a-signature' }].map(fields => ({ vectorAnnotations: [{ ...entry, ...fields }] })),
    { vectorAnnotations: [entry, entry] },
  ]) assert.throws(() => config(invalid), /settings\.extensions\.dxa/);
});
