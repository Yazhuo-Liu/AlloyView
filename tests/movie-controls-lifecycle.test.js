import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeMovieControls } from '../src/movie-controls.js';
import { createAutomationLock } from '../src/script-controls.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const camera = () => ({ yaw: 0.2, pitch: 0.3, roll: 0, fov: 0.7, constrainUp: true, target: [1, 2, 3], pan: [0, 0, 0], distance: 20,
  orthographicScale: 8, projectionMode: 'perspective' });

class Element extends EventTarget {
  constructor(tag, root) {
    super(); this.tag = tag; this.root = root; this.children = []; this.options = []; this.dataset = {}; this.style = {};
    this.value = ''; this.hidden = false; this.disabled = false; this.open = false; this.inert = false; this.isConnected = true;
    this.attributes = new Map(); this.classList = { toggle() {} };
  }
  set id(id) { this.name = id; this.root.nodes.set(id, this); }
  get id() { return this.name; }
  get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
  get ownerDocument() { return this.root; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.options = children.filter(child => child.tag === 'option'); }
  closest(selector) { return selector === '.app-shell' ? this.root.application : null; }
  focus() { this.root.activeElement = this; }
  showModal() { if (this.modalFailure) throw new Error('Modal unavailable'); this.open = true; }
  show() { if (this.showFailure) throw new Error('Dialog unavailable'); this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
  remove() { this.isConnected = false; this.open = false; }
}

function fixture(t, { prepareExport = async () => {}, showFrame = null, captureImage = null, VideoEncoderClass = null, inert = false } = {}) {
  const root = new EventTarget(); root.nodes = new Map(); root.defaultView = { Event }; root.activeElement = null;
  root.createElement = tag => new Element(tag, root);
  root.getElementById = id => root.nodes.get(id) ?? null;
  root.head = root.createElement('head'); root.body = root.createElement('body'); root.application = root.createElement('div');
  root.application.inert = inert; root.querySelector = selector => selector === '.app-shell' ? root.application : null;
  for (const id of ['movie-state', 'movie-status', 'movie-summary', 'movie-format', 'export-movie', 'movie-resolution', 'export-resolution']) {
    const node = root.createElement(id.includes('resolution') || id === 'movie-format' ? 'select' : 'button'); node.id = id;
  }
  root.nodes.get('export-resolution').value = 'current';
  const canvas = root.createElement('canvas'); canvas.width = 320; canvas.height = 240;
  const renderer = { ...camera(), frame: {}, canvas, setProjection(value) { this.projectionMode = value; }, requestRender() {},
    captureImage: captureImage ?? (() => { throw new Error('Test capture failed'); }) };
  const state = { frame: 3, source: 'a', shown: [], notices: [], releases: 0 };
  const lock = createAutomationLock();
  const controls = initializeMovieControls({ renderer, lock, documentRoot: root, getFrameIndex: () => state.frame,
    getFrameCount: () => 5, getSourceVersion: () => state.source,
    prepareExport, showFrame: showFrame ?? (async index => { state.shown.push(index); state.frame = index; return true; }),
    notify: message => state.notices.push(message), VideoEncoderClass, VideoFrameClass: null });
  controls.setEnabled(true);
  controls.restore({ path: { keyframes: [{ time: 0, camera: camera(), frame: null }, { time: 1, camera: { ...camera(), yaw: 1 }, frame: null }],
    frames: { mode: 'fit', first: 0, last: 4, step: 1, rate: 10 } }, output: { format: 'png-zip', fps: 2 } });
  t.after(() => controls.dispose());
  const fields = Object.fromEntries(root.nodes);
  return { controls, root, fields, renderer, state, lock };
}

async function waitFor(check) {
  for (let step = 0; step < 100; step++) { if (check()) return; await delay(5); }
  assert.ok(check(), 'The lifecycle reaches its expected phase');
}

test('Escape cancels before preparation finishes and preserves the dialog and inert lock until cleanup', async t => {
  const preparing = deferred(); let signal;
  const f = fixture(t, { prepareExport: options => { signal = options.signal; return preparing.promise; } });
  const pending = f.controls.exportMovie();
  assert.equal(f.fields['movie-export-dialog'].open, true, 'the progress window appears before codec and frame preparation');
  assert.equal(f.root.application.inert, true);
  assert.equal(f.fields['cancel-movie'].inert, false, 'Cancel is outside the inert application');
  await waitFor(() => signal);
  const escape = new Event('keydown', { cancelable: true }); escape.key = 'Escape';
  f.root.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true); assert.equal(signal.aborted, true);
  assert.equal(f.fields['movie-export-dialog'].open, true);
  assert.equal(f.lock.owner(), 'movie'); assert.equal(f.root.application.inert, true);
  preparing.resolve(); await pending;
  assert.equal(f.lock.owner(), null); assert.equal(f.root.application.inert, false);
  assert.equal(f.fields['movie-export-dialog'].open, false); assert.equal(f.fields['movie-state'].textContent, 'Cancelled');
  assert.deepEqual(f.state.shown, []);
});

test('a dialog close aborts, reopens reachable progress and keeps the application blocked through frame restoration', async t => {
  const capturing = deferred(), restoring = deferred(); let original = true;
  const canvas = { width: 320, height: 240 };
  const f = fixture(t, { captureImage: () => capturing.promise, showFrame: async index => {
    f.state.shown.push(index);
    if (index === 3 && !original) await restoring.promise;
    f.state.frame = index; original = false; return true;
  } });
  const pending = f.controls.exportMovie();
  await waitFor(() => f.state.frame === 0);
  f.fields['movie-export-dialog'].close();
  assert.equal(f.fields['movie-export-dialog'].open, true, 'unexpected close cannot remove Cancel');
  assert.equal(f.fields['movie-progress-text'].textContent, 'Cancelling…');
  assert.equal(f.root.application.inert, true); assert.equal(f.lock.owner(), 'movie');
  capturing.resolve(canvas);
  await waitFor(() => f.state.shown.length === 2);
  assert.equal(f.fields['movie-export-dialog'].open, true); assert.equal(f.root.application.inert, true);
  assert.deepEqual([canvas.width, canvas.height], [1, 1], 'an asynchronously captured cancelled image is released');
  restoring.resolve(); await pending;
  assert.deepEqual(f.state.shown, [0, 3]); assert.equal(f.state.frame, 3);
  assert.equal(f.fields['movie-state'].textContent, 'Cancelled'); assert.equal(f.lock.owner(), null); assert.equal(f.root.application.inert, false);
});

test('native dialog cancellation and button cancellation share one abort lifecycle', async t => {
  for (const action of ['cancel', 'click']) {
    const preparing = deferred(); let signal;
    const f = fixture(t, { prepareExport: options => { signal = options.signal; return preparing.promise; } });
    const pending = f.controls.exportMovie(); await waitFor(() => signal);
    const event = new Event(action, { cancelable: true });
    f.fields[action === 'cancel' ? 'movie-export-dialog' : 'cancel-movie'].dispatchEvent(event);
    assert.equal(signal.aborted, true);
    if (action === 'cancel') assert.equal(event.defaultPrevented, true);
    preparing.resolve(); await pending;
    assert.equal(f.fields['movie-state'].textContent, 'Cancelled'); assert.equal(f.lock.owner(), null);
    f.controls.dispose();
  }
});

test('a stalled codec support query cancels promptly and its eventual response cannot revive the old task', async t => {
  const query = deferred(); let queries = 0;
  class Encoder { static isConfigSupported() { queries++; return query.promise; } }
  const f = fixture(t, { VideoEncoderClass: Encoder });
  const pending = f.controls.exportMovie(); await waitFor(() => queries > 0);
  f.fields['cancel-movie'].dispatchEvent(new Event('click'));
  await Promise.race([pending, delay(200).then(() => { throw new Error('A stalled codec query stranded cancellation'); })]);
  assert.equal(f.lock.owner(), null); assert.equal(f.root.application.inert, false); assert.equal(f.controls.isBusy(), false);
  f.controls.dispose(); query.resolve({ supported: false }); await delay(10);
  assert.equal(f.fields['movie-state'].textContent, 'Cancelled'); assert.equal(queries, 1, 'the abandoned probe cannot submit another query');
});

test('export failures, nonmodal fallback and disposal restore existing inert state and release ownership', async t => {
  for (const inert of [false, true]) {
    const f = fixture(t, { inert }); f.fields['movie-export-dialog'].modalFailure = true;
    await f.controls.exportMovie();
    assert.equal(f.fields['movie-state'].textContent, 'Failed'); assert.match(f.state.notices[0], /Test capture failed/);
    assert.equal(f.root.application.inert, inert); assert.equal(f.lock.owner(), null); assert.equal(f.fields['movie-export-dialog'].open, false);
    assert.deepEqual(f.state.shown, [0, 3]);
  }
  const preparing = deferred(); let entered = false;
  const f = fixture(t, { prepareExport: () => { entered = true; return preparing.promise; } });
  const pending = f.controls.exportMovie(); await waitFor(() => entered);
  f.controls.dispose(); assert.equal(f.lock.owner(), 'movie', 'pending owned work is still acknowledged before release');
  preparing.resolve(); await pending;
  assert.equal(f.root.application.inert, false); assert.equal(f.lock.owner(), null);
});

test('an unavailable progress window fails before preparation and still releases the application lock', async t => {
  let prepares = 0;
  const f = fixture(t, { prepareExport: async () => { prepares++; } });
  const dialog = f.fields['movie-export-dialog']; dialog.modalFailure = true; dialog.showFailure = true;
  await f.controls.exportMovie();
  assert.equal(prepares, 0); assert.equal(f.fields['movie-state'].textContent, 'Failed');
  assert.equal(f.lock.owner(), null); assert.equal(f.root.application.inert, false);
});

test('saved export resolution refreshes the Movie mirror without a user-change event', async t => {
  const f = fixture(t);
  const source = f.fields['export-resolution'];
  source.value = '1080p'; source.dispatchEvent(new Event('export-resolution-restored'));
  assert.equal(f.fields['movie-resolution'].value, '1080p');
  f.controls.dispose(); source.value = '4k'; source.dispatchEvent(new Event('export-resolution-restored'));
  assert.equal(f.fields['movie-resolution'].value, '1080p', 'disposing removes the cross-panel notification listener');
});

test('configuration restoration owns the automation lock and is named when movie or preview is refused', async t => {
  const f = fixture(t), release = f.lock.acquire('configuration');
  f.controls.startPreview(); await f.controls.exportMovie();
  assert.deepEqual(f.state.notices, ['Wait for the configuration restore to finish first.', 'Wait for the configuration restore to finish first.']);
  assert.equal(f.lock.owner(), 'configuration'); assert.equal(f.controls.isBusy(), false);
  assert.equal(f.root.application.inert, false); assert.equal(f.fields['movie-export-dialog'].open, false);
  release();
  await f.controls.exportMovie();
  assert.equal(f.fields['movie-state'].textContent, 'Failed', 'releasing the configuration lock admits the next movie');
  assert.equal(f.lock.owner(), null);
});
