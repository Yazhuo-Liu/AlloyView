import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeFrameNavigationControls } from '../src/ui/view/frame-navigation-controls.js';

class Element {
  constructor(value = '') { this.value = String(value); this.listeners = new Map(); this.attributes = {}; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  setAttribute(name, value) { this.attributes[name] = value; }
  emit(type, properties = {}) {
    const event = { preventDefault() { this.prevented = true; }, ...properties };
    for (const callback of this.listeners.get(type) ?? []) callback(event);
    return event;
  }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ navigate } = {}) {
  const slider = new Element('0'), input = new Element('1'), go = new Element(), label = new Element();
  const documentRoot = new Element();
  const current = { index: 0, count: 165, indexComplete: true, enabled: true };
  const timers = new Map(), calls = [], intents = [], previews = [], notes = [];
  let nextTimer = 0;
  const controls = initializeFrameNavigationControls({ slider, input, go, label, documentRoot,
    getState: () => current,
    onIntent: index => intents.push(index),
    onNavigate: index => { calls.push(index); return navigate ? navigate(index) : (current.index = index, true); },
    onPreview: index => previews.push(index), notify: message => notes.push(message),
    setTimer(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  return { controls, slider, input, go, label, documentRoot, current, calls, intents, previews, notes,
    async flushTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); await tick(); },
    async jump(value, event = 'click') { input.value = String(value); (event === 'keydown' ? input : go).emit(event, { key: 'Enter' }); await tick(); },
  };
}

test('timeline Go and Enter use one-based frame numbers and synchronize accessible bounds', async () => {
  const h = harness();
  assert.equal(h.input.min, '1'); assert.equal(h.input.max, '165');
  await h.jump(165);
  assert.deepEqual(h.calls, [164]); assert.equal(h.slider.value, '164');
  assert.equal(h.label.textContent, '165 / 165');
  assert.equal(h.slider.attributes['aria-valuetext'], 'Frame 165 of 165');
  await h.jump(2, 'keydown');
  assert.deepEqual(h.calls, [164, 1]); assert.equal(h.input.value, '2');
  h.controls.dispose();
});

test('numeric jumps reject missing, fractional and unavailable frames without changing the structure', async () => {
  const h = harness();
  for (const value of ['', 0, -2, 166, 2.5, 'NaN']) await h.jump(value);
  assert.deepEqual(h.calls, []); assert.equal(h.current.index, 0);
  assert.equal(h.notes.length, 6);
  assert.ok(h.notes.every(note => note === 'Enter a frame number from 1 to 165.'));
});

test('pointer scrubbing previews arbitrary skips and decodes only the final selected frame', async () => {
  const h = harness();
  h.slider.emit('pointerdown');
  for (const index of [1, 12, 80, 9, 164]) { h.slider.value = String(index); h.slider.emit('input'); }
  await h.flushTimers();
  assert.deepEqual(h.calls, []);
  assert.equal(h.label.textContent, '165 / 165');
  assert.deepEqual(h.intents, [1, 12, 80, 9, 164], 'old reads can be cancelled immediately at each new desired frame');
  h.slider.emit('pointerup'); h.documentRoot.emit('pointerup'); h.slider.emit('change');
  await tick();
  assert.deepEqual(h.calls, [164]);
});

test('keyboard range input and its per-step change events debounce to the latest selection', async () => {
  const h = harness();
  for (const index of [1, 2, 3, 30]) {
    h.slider.value = String(index); h.slider.emit('input'); h.slider.emit('change');
  }
  await tick(); assert.deepEqual(h.calls, []);
  await h.flushTimers();
  assert.deepEqual(h.calls, [30]);
});

test('a newer jump supersedes an older promise and late completion cannot reset the selected input', async () => {
  const pending = new Map();
  const h = harness({ navigate: index => new Promise(resolve => pending.set(index, resolve)) });
  await h.jump(3); await h.jump(150);
  assert.deepEqual(h.calls, [2, 149]);
  pending.get(2)(false); await tick();
  assert.equal(h.input.value, '150'); assert.equal(h.slider.value, '149');
  h.current.index = 149; pending.get(149)(true); await tick();
  assert.equal(h.input.value, '150');
});

test('a failed navigation restores the actual frame and Go can retry the same target', async () => {
  let fail = true;
  const h = harness({ navigate: () => fail ? Promise.reject(new Error('Malformed frame')) : true });
  await h.jump(10);
  assert.equal(h.input.value, '1'); assert.deepEqual(h.notes, ['Malformed frame']);
  assert.equal(h.slider.value, '0'); assert.equal(h.label.textContent, '1 / 165');
  fail = false; await h.jump(10);
  assert.deepEqual(h.calls, [9, 9]);
});

test('source close cancels queued navigation and disables the jump controls', async () => {
  const h = harness();
  h.slider.value = '100'; h.slider.emit('input');
  h.current.count = 0; h.current.enabled = false; h.controls.reset();
  await h.flushTimers();
  assert.deepEqual(h.calls, []);
  assert.equal(h.input.value, '');
  assert.equal(h.label.textContent, '0 / 0');
  for (const element of [h.input, h.go, h.slider]) assert.equal(element.disabled, true);
  h.controls.dispose(); h.go.emit('click'); await tick();
  assert.deepEqual(h.calls, []);
});

test('progressive indexing updates the available jump range without discarding a typed frame number', async () => {
  const h = harness();
  h.current.count = 20; h.current.indexComplete = false; h.controls.refresh();
  await h.jump(50);
  assert.match(h.notes[0], /More frames are still being indexed/);
  h.documentRoot.activeElement = h.input;
  h.input.value = '150'; h.current.count = 165; h.controls.refresh();
  assert.equal(h.input.value, '150'); assert.equal(h.input.max, '165');
  await h.jump(150);
  assert.equal(h.label.textContent, '150 / 165+');
  h.input.value = '1'; const event = h.input.emit('keydown', { key: 'Escape' });
  assert.equal(event.prevented, true); assert.equal(h.input.value, '150');
});

test('finishing an earlier jump preserves the newer frame number being typed', async () => {
  let release;
  const h = harness({ navigate: () => new Promise(resolve => { release = resolve; }) });
  await h.jump(165);
  h.documentRoot.activeElement = h.input;
  h.input.value = '12';
  h.current.index = 164;
  release(true); await tick();
  assert.equal(h.input.value, '12', 'the new draft survives completion of frame 165');
  assert.equal(h.label.textContent, '165 / 165');
  assert.equal(h.slider.value, '164');
});

test('cancelling a scrub restores all controls to the displayed frame without decoding', async () => {
  const h = harness();
  h.slider.emit('pointerdown'); h.slider.value = '120'; h.slider.emit('input');
  h.slider.emit('pointercancel'); await h.flushTimers();
  assert.equal(h.input.value, '1'); assert.equal(h.slider.value, '0');
  assert.equal(h.label.textContent, '1 / 165'); assert.deepEqual(h.calls, []);
});
