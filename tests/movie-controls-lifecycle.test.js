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
  const root = new EventTarget(); root.nodes = new Map(); root.activeElement = null;
  const animations = new Map(); let nextAnimation = 0;
  root.defaultView = { Event, requestAnimationFrame: callback => { const id = ++nextAnimation; animations.set(id, callback); return id; },
    cancelAnimationFrame: id => animations.delete(id) };
  root.createElement = tag => new Element(tag, root);
  root.getElementById = id => root.nodes.get(id) ?? null;
  root.head = root.createElement('head'); root.body = root.createElement('body'); root.application = root.createElement('div');
  root.application.inert = inert; root.querySelector = selector => selector === '.app-shell' ? root.application : null;
  for (const id of ['movie-state', 'movie-status', 'movie-summary', 'movie-format', 'export-movie', 'preview-movie', 'movie-resolution', 'export-resolution']) {
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
  return { controls, root, fields, renderer, state, lock, animations, tick(now) {
    const [id, callback] = animations.entries().next().value ?? [];
    assert.equal(typeof callback, 'function', 'a preview animation is pending');
    animations.delete(id); callback(now);
  } };
}

// The real app's navigation supersedes a previous request immediately, while
// parser responses may arrive later. Keep those separate in the race fixtures.
function delayedNavigation(getFixture) {
  const requests = []; let generation = 0;
  return { requests, showFrame(index) {
    const f = getFixture(), source = f.state.source, request = ++generation, gate = deferred();
    requests.push({ index, ...gate }); f.state.shown.push(index);
    return gate.promise.then(() => {
      if (request !== generation || source !== f.state.source) return false;
      f.state.frame = index; return true;
    });
  } };
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

test('stopping a slow preview cancels its pending navigation even while its starting frame is displayed', async t => {
  let f; const navigation = delayedNavigation(() => f);
  f = fixture(t, { showFrame: navigation.showFrame });
  const original = camera();
  f.controls.startPreview(); f.tick(0); f.tick(200);
  assert.equal(f.state.frame, 3); assert.deepEqual(f.state.shown, [0]);
  assert.notEqual(f.renderer.yaw, original.yaw);
  const stopped = f.controls.stopPreview();
  assert.deepEqual(f.state.shown, [0, 3], 'the unchanged displayed frame still supersedes the pending load');
  assert.equal(f.fields['movie-state'].textContent, 'Restoring'); assert.equal(f.controls.isBusy(), true);
  assert.equal(f.lock.owner(), 'movie'); assert.equal(f.fields['preview-movie'].disabled, true);
  assert.deepEqual(Object.fromEntries(Object.keys(original).map(key => [key, f.renderer[key]])), original);
  navigation.requests[0].resolve(); await delay(0);
  assert.equal(f.state.frame, 3, 'the late parser response cannot display its abandoned frame');
  assert.equal(f.lock.owner(), 'movie', 'restoration retains ownership until its navigation settles');
  navigation.requests[1].resolve(); await stopped;
  assert.equal(f.controls.isBusy(), false); assert.equal(f.lock.owner(), null);
  assert.equal(f.fields['movie-state'].textContent, 'Idle'); assert.equal(f.fields['preview-movie'].textContent, 'Preview');
});

test('natural preview completion restores a slow pending frame and a quick restart cannot overlap its cleanup', async t => {
  let f; const navigation = delayedNavigation(() => f);
  f = fixture(t, { showFrame: navigation.showFrame });
  f.controls.startPreview(); f.tick(0); f.tick(1000);
  assert.deepEqual(f.state.shown, [0, 3]); assert.equal(f.animations.size, 0);
  f.controls.startPreview(); assert.equal(f.animations.size, 0, 'restart waits for the owned restoration');
  const stopping = f.controls.stopPreview();
  navigation.requests[1].resolve(); await stopping;
  f.controls.startPreview(); f.tick(2000);
  assert.deepEqual(f.state.shown, [0, 3, 0]); assert.equal(f.lock.owner(), 'movie');
  navigation.requests[0].resolve(); await delay(0);
  assert.equal(f.controls.isBusy(), true); assert.equal(f.lock.owner(), 'movie', 'old cleanup cannot release a new preview');
  navigation.requests[2].resolve(); await delay(0);
  assert.equal(f.state.frame, 0);
  const finalStop = f.controls.stopPreview(); navigation.requests[3].resolve(); await finalStop;
  assert.equal(f.state.frame, 3); assert.equal(f.lock.owner(), null);
});

test('a viewport gesture stops at the user camera and cancels an unshown preview frame', async t => {
  let f; const navigation = delayedNavigation(() => f);
  f = fixture(t, { showFrame: navigation.showFrame });
  f.controls.startPreview(); f.tick(0); f.tick(300);
  f.renderer.yaw = 2; f.renderer.pan = [4, 5, 6];
  f.renderer.canvas.dispatchEvent(new Event('pointerdown'));
  assert.deepEqual(f.state.shown, [0, 3]);
  assert.equal(f.renderer.yaw, 2); assert.deepEqual(f.renderer.pan, [4, 5, 6]);
  navigation.requests[1].resolve(); await f.controls.stopPreview();
  navigation.requests[0].resolve(); await delay(0);
  assert.equal(f.state.frame, 3); assert.equal(f.renderer.yaw, 2);
  assert.match(f.fields['movie-status'].textContent, /Preview stopped at this pose/);
  assert.equal(f.lock.owner(), null);
});

test('a source change discards a pending preview without restoring old frames or camera', async t => {
  let f; const navigation = delayedNavigation(() => f);
  f = fixture(t, { showFrame: navigation.showFrame });
  f.controls.startPreview(); f.tick(0);
  f.state.source = 'b'; f.state.frame = 1; f.renderer.yaw = 5;
  f.controls.reset();
  assert.deepEqual(f.state.shown, [0]); assert.equal(f.lock.owner(), null);
  navigation.requests[0].resolve(); await delay(0);
  assert.equal(f.state.frame, 1); assert.equal(f.renderer.yaw, 5);
  assert.equal(f.controls.hasKeyframes(), false);
});

test('a source replacement during preview restoration keeps its new frame, pose and settings', async t => {
  let f; const navigation = delayedNavigation(() => f);
  f = fixture(t, { showFrame: navigation.showFrame });
  f.controls.startPreview(); f.tick(0);
  const stopping = f.controls.stopPreview();
  f.state.source = 'b'; f.state.frame = 1; f.renderer.yaw = 5;
  f.controls.reset();
  const fresh = { path: { keyframes: [{ time: 0, camera: { ...camera(), yaw: 5 }, frame: null },
    { time: 2, camera: { ...camera(), yaw: 6 }, frame: null }], frames: { mode: 'current' } } };
  f.controls.restore(fresh);
  navigation.requests[1].reject(new Error('Obsolete restore failed')); await stopping;
  navigation.requests[0].resolve(); await delay(0);
  assert.equal(f.state.frame, 1); assert.equal(f.renderer.yaw, 5); assert.deepEqual(f.state.notices, []);
  assert.deepEqual(f.controls.getState().path.keyframes.map(row => [row.time, row.camera.yaw]), [[0, 5], [2, 6]]);
  assert.equal(f.lock.owner(), null); assert.equal(f.controls.isBusy(), false);
});

test('restoration failures and disposal settle preview ownership without publishing stale callbacks', async t => {
  for (const action of ['reject', 'dispose']) {
    let f; const navigation = delayedNavigation(() => f);
    f = fixture(t, { showFrame: navigation.showFrame });
    f.controls.startPreview(); f.tick(0);
    const stopping = f.controls.stopPreview();
    if (action === 'dispose') {
      f.controls.dispose(); f.controls.startPreview(); assert.equal(f.animations.size, 0);
      f.fields['movie-state'].textContent = 'Disposed';
    }
    navigation.requests[1].reject(new Error('Restore read failed')); await stopping;
    navigation.requests[0].resolve(); await delay(0);
    assert.equal(f.lock.owner(), null); assert.equal(f.controls.isBusy(), false); assert.equal(f.state.frame, 3);
    assert.deepEqual(f.state.notices, action === 'reject' ? ['Restore read failed'] : []);
    assert.equal(f.fields['movie-state'].textContent, action === 'reject' ? 'Idle' : 'Disposed');
  }
});

test('a camera-only preview restores immediately without dispatching any frame navigation', async t => {
  const f = fixture(t), saved = f.controls.getState();
  saved.path.frames.mode = 'current'; f.controls.restore(saved);
  f.controls.startPreview(); f.tick(0); f.tick(300);
  assert.notEqual(f.renderer.yaw, camera().yaw);
  f.controls.stopPreview();
  assert.equal(f.renderer.yaw, camera().yaw); assert.deepEqual(f.state.shown, []);
  assert.equal(f.controls.isBusy(), false); assert.equal(f.lock.owner(), null);
});
