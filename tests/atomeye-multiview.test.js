import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeAtomEyeTools } from '../src/ui/view/atomeye-tools.js';

class Element {
  constructor(root) {
    this.ownerDocument = root; this.value = '1'; this.checked = false; this.disabled = false;
    this.children = []; this.listeners = new Map(); this.attributes = new Map();
    this.dataset = {}; this.style = {}; this.classList = { toggle() {} };
  }
  get valueAsNumber() { return Number(this.value); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, action) { this.listeners.set(name, action); }
  dispatch(name) { return this.listeners.get(name)?.({ target: this }); }
  remove() {}
}

function fixture(t, { capture = async () => {}, encode = callback => callback(new Blob(['png'])), prepare = async () => {} } = {}) {
  const previous = globalThis.document, fields = new Map();
  const state = { frame: {}, source: 1, captures: 0, downloads: [], notifications: [], stops: 0, preparations: 0 };
  const document = {
    createElement(tag) {
      const element = new Element(document);
      if (tag === 'canvas') {
        element.getContext = () => ({ drawImage() {}, fillRect() {}, fillText() {} });
        element.toBlob = encode;
      }
      if (tag === 'a') element.click = () => state.downloads.push(element.download);
      return element;
    },
    createElementNS: () => new Element(document), querySelectorAll: () => [],
    getElementById(id) { if (!fields.has(id)) fields.set(id, new Element(document)); return fields.get(id); },
  };
  document.body = new Element(document);
  globalThis.document = document;
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  // Download URL cleanup must not leave a ten-second timer in this DOM harness.
  t.mock.method(globalThis, 'setTimeout', action => { action(); return 0; });
  const renderer = { canvas: { width: 64, height: 64, clientWidth: 64 }, yaw: .3,
    projectionMode: 'perspective', pan: [0, 0, 0], setProjection() {}, requestRender() {},
    setView() { this.yaw++; },
    async captureImage() { state.captures++; await capture(state, renderer); return { width: 64, height: 64 }; },
  };
  const controls = initializeAtomEyeTools({ renderer, pool: {}, tools: {},
    getFrame: () => state.frame, getSourceVersion: () => state.source,
    getFrameIndex: () => 0, getFrameCount: () => 1, getSelectedIndex: () => -1,
    getExportOptions: () => ({}), getFileStem: () => `source-${state.source}`,
    prepareExport: async options => { state.preparations++; await prepare(options); },
    stopPlayback: () => state.stops++, notify: message => state.notifications.push(message),
  });
  return { state, renderer, controls, field: id => document.getElementById(id) };
}

async function waitFor(check) {
  for (let i = 0; i < 100 && !check(); i++) await delay(2);
  assert.ok(check(), 'the export reaches the expected lifecycle state');
}

test('six-view export discards an old source while an image capture is pending', async t => {
  let finishCapture;
  const pending = new Promise(resolve => { finishCapture = resolve; });
  const h = fixture(t, { capture: () => pending });
  h.field('export-multiview').dispatch('click'); await waitFor(() => h.state.captures === 1);
  h.state.source++; h.state.frame = {}; h.renderer.yaw = 8;
  h.controls.cancelBatch({ restore: false }); finishCapture();
  await waitFor(() => !h.field('export-multiview').disabled);
  await delay(5);
  assert.equal(h.state.captures, 1); assert.deepEqual(h.state.downloads, []);
  assert.equal(h.renderer.yaw, 8, 'the replacement source keeps its camera');
  assert.deepEqual(h.state.notifications, []);
});

test('six-view export discards an encoded sheet after a camera edit', async t => {
  let finishEncoding;
  const h = fixture(t, { encode: callback => { finishEncoding = callback; } });
  h.field('export-multiview').dispatch('click'); await waitFor(() => finishEncoding);
  h.renderer.yaw = 9; h.controls.cancelBatch({ restore: false }); finishEncoding(new Blob(['png']));
  await waitFor(() => !h.field('export-multiview').disabled); await delay(5);
  assert.deepEqual(h.state.downloads, []); assert.equal(h.renderer.yaw, 9);
});

test('six-view preparation excludes duplicate and frame-series exports and restores the camera on success', async t => {
  let finishPreparation;
  const pending = new Promise(resolve => { finishPreparation = resolve; });
  const h = fixture(t, { prepare: () => pending });
  h.field('export-multiview').dispatch('click'); await waitFor(() => h.state.preparations === 1);
  h.field('export-multiview').dispatch('click'); h.field('export-frame-series').dispatch('click');
  assert.equal(h.state.preparations, 1); assert.equal(h.state.captures, 0);
  assert.equal(h.state.stops, 1);
  finishPreparation(); await waitFor(() => h.state.downloads.length === 1);
  assert.equal(h.state.captures, 6); assert.equal(h.renderer.yaw, .3);
  assert.deepEqual(h.state.downloads, ['source-1-six-views.png']);
  assert.deepEqual(h.state.notifications, []);
  assert.equal(h.field('export-multiview').disabled, false);
});
