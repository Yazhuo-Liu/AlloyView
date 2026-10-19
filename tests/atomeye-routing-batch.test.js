import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeAtomEyeTools } from '../src/ui/view/atomeye-tools.js';
import { createCell } from '../src/data/model.js';

class Element {
  constructor(root) {
    this.ownerDocument = root; this.value = '1'; this.checked = false; this.disabled = false;
    this.hidden = false; this.children = []; this.listeners = new Map(); this.attributes = new Map();
    this.dataset = {}; this.style = {}; this.classList = { toggle() {} };
  }
  get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, action) { this.listeners.set(name, action); }
  dispatch(name) { return this.listeners.get(name)?.({ target: this }); }
}

function fixture(t, { prepareExport = async () => {}, showFrame = null } = {}) {
  const previous = globalThis.document, fields = new Map();
  const document = { createElement: () => new Element(document), createElementNS: () => new Element(document),
    querySelectorAll: () => [], getElementById: id => {
      if (!fields.has(id)) fields.set(id, new Element(document));
      return fields.get(id);
    } };
  globalThis.document = document;
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const frame = { ids: Uint32Array.of(1, 2), types: Uint16Array.of(0, 1), typeLabels: ['Ni', 'Fe'],
    properties: [], fractional: Float64Array.of(.2, .2, .2, .4, .4, .4),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }) };
  const state = { source: 'source', index: 1, shown: [], routing: 0, starts: 0, releases: 0, captures: 0, notifications: [], analyses: [], checks: [] };
  const renderer = { frame, atomCount: 2, projectionMode: 'perspective', yaw: .3, pan: [1, 2, 3],
    setSelectedAtoms() {}, setVectorFields() {}, setBonds() {}, setProjection() {}, requestRender() {},
    captureImage() { state.captures++; throw new Error('Test image unavailable'); } };
  let pinned = null;
  const pool = { gpuEnabled: true,
    beginRoutingBatch() { state.starts++; state.routing++; let released = false; return () => {
      assert.equal(released, false); released = true; state.routing--; state.releases++;
    }; },
    canReuseRoutingResult(input, parameters, result) {
      state.checks.push({ input, parameters, result });
      return !pinned || result?.backend === pinned || Boolean(result?.fallbackReason);
    },
    async analyze(input, parameters) {
      state.analyses.push({ input, parameters });
      const base = { backend: pinned ?? 'gpu', gpuRequested: true, elapsedMs: 1, engine: 'test' };
      return parameters.kind === 'rdf' ? { ...base, radii: [.5], values: [1], counts: [2] }
        : { ...base, count: 1, coordination: Uint32Array.of(1, 1) };
    } };
  const controls = initializeAtomEyeTools({ renderer, pool, tools: { setToolEnabled() {}, isToolEnabled: () => false },
    getFrame: () => frame, getFrames: () => [frame], getFrameIndex: () => state.index, getFrameCount: () => 3,
    getSelectedIndex: () => -1, getSourceVersion: () => state.source, getColorMode: () => 'type', refresh() {}, chooseProperty() {},
    stopPlayback() {}, getExportOptions: () => ({}), getFileStem: () => 'sample', prepareExport,
    showFrame: async index => { state.shown.push(index); if (showFrame) await showFrame(index, state, renderer); state.index = index; return true; },
    notify: message => state.notifications.push(message) });
  const field = id => document.getElementById(id);
  field('export-series-first').value = '1'; field('export-series-last').value = '3'; field('export-series-step').value = '1';
  return { controls, state, renderer, field, pin: backend => { pinned = backend; } };
}

async function waitFor(check) {
  for (let i = 0; i < 100 && !check(); i++) await delay(2);
  assert.ok(check(), 'the owned lifecycle settles');
}

test('frame ZIP cancellation retains routing through preparation and restoration, then allows another export', async t => {
  let finishPreparation, entered = false;
  const preparing = new Promise(resolve => { finishPreparation = resolve; });
  const h = fixture(t, { prepareExport: () => { entered = true; return preparing; }, showFrame: (index, state) => {
    assert.equal(state.routing, 1, 'original-frame analyses use the same pinned batch');
  } });
  h.field('export-frame-series').dispatch('click'); await waitFor(() => entered);
  h.field('cancel-frame-series').dispatch('click');
  assert.equal(h.state.routing, 1); assert.equal(h.field('export-frame-series').disabled, true);
  finishPreparation(); await waitFor(() => h.state.releases === 1);
  assert.deepEqual(h.state.shown, [1]); assert.equal(h.state.captures, 0);
  assert.equal(h.state.routing, 0); assert.equal(h.field('cancel-frame-series').disabled, true);
  assert.equal(h.field('export-frame-series').disabled, false);
  h.field('export-frame-series').dispatch('click'); await waitFor(() => h.state.releases === 2);
  assert.equal(h.state.starts, 2); assert.equal(h.state.routing, 0);
  await waitFor(() => h.state.notifications.length === 1);
  assert.match(h.state.notifications[0], /Test image unavailable/);
});

test('frame ZIP restoration failure clears batch state, restores camera and permits a subsequent export', async t => {
  let failure = true;
  const h = fixture(t, { showFrame: (index, state, renderer) => {
    assert.equal(state.routing, 1);
    renderer.yaw = 2;
    if (index === 1 && failure) { failure = false; throw new Error('Original frame unavailable'); }
  } });
  h.field('export-frame-series').dispatch('click'); await waitFor(() => h.state.releases === 1);
  await waitFor(() => h.state.notifications.length === 1);
  assert.deepEqual(h.state.shown, [0, 1]); assert.equal(h.state.routing, 0);
  assert.equal(h.renderer.yaw, .3); assert.equal(h.field('export-frame-series').disabled, false);
  assert.match(h.field('export-series-status').textContent, /Original frame unavailable/);
  h.field('export-frame-series').dispatch('click'); await waitFor(() => h.state.releases === 2);
  assert.equal(h.state.starts, 2); assert.equal(h.state.routing, 0);
});

test('bond and RDF cache checks honor batch backend and use the same normalized type parameters as dispatch', async t => {
  const h = fixture(t);
  h.field('rdf-first-type').value = 'Ni'; h.field('rdf-second-type').value = 'Fe';
  for (const kind of ['bonds', 'rdf']) {
    h.pin(null); await h.controls.run(kind); assert.equal(h.state.analyses.at(-1).parameters.kind, kind);
    const calls = h.state.analyses.length;
    await h.controls.run(kind); assert.equal(h.state.analyses.length, calls, 'ordinary reruns retain the completed result');
    h.pin('cpu'); await h.controls.run(kind, { automatic: true });
    assert.equal(h.state.analyses.length, calls + 1, 'a GPU cache does not bypass the pinned CPU route');
    const check = h.state.checks.at(-1).parameters, dispatch = h.state.analyses.at(-1).parameters;
    assert.deepEqual(check, dispatch);
    if (kind === 'rdf') assert.deepEqual([check.firstType, check.secondType], [0, 1]);
    await h.controls.run(kind, { automatic: true }); assert.equal(h.state.analyses.length, calls + 1);
  }
  assert.deepEqual(h.state.notifications, []);
});

test('frame ZIP does not restore a stale camera if the source changes during original-frame restoration', async t => {
  let finishRestoration, entered = false;
  const pending = new Promise(resolve => { finishRestoration = resolve; });
  const h = fixture(t, { showFrame: async index => {
    if (index === 1) { entered = true; await pending; }
  } });
  h.field('export-frame-series').dispatch('click'); await waitFor(() => entered);
  h.state.source = 'replacement'; h.renderer.yaw = 8;
  h.controls.cancelBatch({ restore: false }); finishRestoration();
  await waitFor(() => h.state.releases === 1);
  assert.equal(h.renderer.yaw, 8, 'a late restoration completion preserves the replacement camera');
  assert.equal(h.state.routing, 0);
  assert.equal(h.field('export-frame-series').disabled, false);
});
