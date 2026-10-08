import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeExportResolutionControls } from '../src/export-resolution-controls.js';

function fixture() {
  const nodes = Object.fromEntries(['export-resolution', 'export-width', 'export-height', 'export-aspect-lock',
    'export-custom-size', 'export-size-status'].map(id => [id, {
    value: id === 'export-resolution' ? 'current' : id === 'export-width' ? '1920' : '1080', checked: true,
    classList: { add() {}, remove() {} }, listeners: new Map(),
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
    addEventListener(name, callback) { this.listeners.set(name, callback); }, removeEventListener() {},
  }]));
  const oldDocument = globalThis.document;
  globalThis.document = { getElementById: id => nodes[id] };
  const renderer = { canvas: { width: 800, height: 600 } }, notifications = [];
  const controls = initializeExportResolutionControls({ renderer, notify: message => notifications.push(message) });
  controls.setEnabled(true);
  const change = (id, value) => {
    const node = nodes[id]; if (typeof value === 'boolean') node.checked = value; else node.value = String(value);
    node.listeners.get('change')({ target: node });
  };
  const restore = () => { controls.dispose(); if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; };
  return { nodes, renderer, notifications, controls, change, restore };
}

test('custom aspect lock follows the current view, including after preset selection and screen resize', () => {
  const f = fixture();
  try {
    f.change('export-resolution', '4k'); f.change('export-resolution', 'custom');
    assert.deepEqual(f.controls.getState(), { mode: 'custom', width: 3840, height: 2880, lockAspect: true });
    f.change('export-width', '1600'); assert.equal(f.nodes['export-height'].value, '1200');
    f.renderer.canvas.width = 600; f.renderer.canvas.height = 600;
    f.change('export-height', '900'); assert.equal(f.nodes['export-width'].value, '900');
    f.change('export-aspect-lock', false); f.change('export-width', '640');
    assert.equal(f.nodes['export-height'].value, '900');
    f.change('export-aspect-lock', true); assert.equal(f.nodes['export-height'].value, '640');
  } finally { f.restore(); }
});

test('an unfinished custom dimension cannot block a preset and an invalid lock ratio recovers', () => {
  const f = fixture();
  try {
    f.change('export-resolution', 'custom'); f.change('export-width', '');
    assert.throws(() => f.controls.getOptions(), /whole numbers/);
    f.change('export-resolution', '4k');
    assert.equal(f.controls.getOptions().resolution.mode, '4k');
    assert.ok(Number.isFinite(f.nodes['export-width'].valueAsNumber));
    f.change('export-resolution', 'custom'); f.change('export-width', '');
    f.change('export-aspect-lock', false); f.change('export-aspect-lock', true); f.change('export-width', '1000');
    assert.deepEqual(f.controls.getState(), { mode: 'custom', width: 1000, height: 750, lockAspect: true });
  } finally { f.restore(); }
});

test('restoring a recipe preserves its exact custom dimensions until a manual edit', () => {
  const f = fixture();
  try {
    const state = { mode: 'custom', width: 1234, height: 700, lockAspect: true };
    f.controls.restore(state); assert.deepEqual(f.controls.getState(), state);
    f.change('export-width', '800'); assert.equal(f.controls.getState().height, 600);
    f.controls.setEnabled(false);
    assert.equal(f.nodes['export-width'].disabled, true); assert.equal(f.nodes['export-resolution'].disabled, true);
  } finally { f.restore(); }
});

test('current viewport keeps legacy dimensions even above the chosen-resolution pixel budget', () => {
  const f = fixture();
  try {
    f.renderer.canvas.width = 8000; f.renderer.canvas.height = 5000; f.controls.refresh();
    assert.match(f.nodes['export-size-status'].textContent, /40\.00 MP/);
    assert.equal(f.controls.getOptions().resolution.mode, 'current');
    f.change('export-resolution', '2x');
    assert.match(f.nodes['export-size-status'].textContent, /32 megapixels/);
    f.renderer.canvas.width = 18000; f.renderer.canvas.height = 1000; f.change('export-resolution', 'current');
    assert.match(f.nodes['export-size-status'].textContent, /18\.00 MP/);
    assert.equal(f.controls.getOptions().resolution.mode, 'current');
  } finally { f.restore(); }
});
