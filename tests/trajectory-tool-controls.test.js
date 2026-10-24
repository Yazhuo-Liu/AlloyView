import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeTrajectoryToolControls } from '../src/ui/selection/trajectory-tool-controls.js';

class Element {
  constructor(value = '') {
    this.value = String(value); this.textContent = ''; this.hidden = false; this.checked = false; this.disabled = false;
    this.listeners = new Map(); this.dataset = {}; this.children = []; this.options = [];
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name) { return this.listeners.get(name)?.({ target: this }); }
  replaceChildren(...children) { this.children = children; this.options = children; }
}

function harness(t, { frameCount = 12, frame = { ids: Float64Array.from([1, 2, 3]), frameIndex: 0 }, groups = [], canInferUnwrap = () => frameCount > 1 } = {}) {
  const previousDocument = globalThis.document;
  const fields = {};
  for (const id of ['trajectory-unwrap-enabled', 'trajectory-infer-unwrap', 'trajectory-unwrap-status', 'cancel-trajectory-unwrap', 'trajectory-smooth-status', 'trajectory-lines-ids-field',
    'trajectory-lines-scheme-field', 'trajectory-lines-color-field', 'generate-trajectory-lines', 'cancel-trajectory-lines', 'clear-trajectory-lines',
    'trajectory-lines-status', 'trajectory-lines-scheme', 'trajectory-lines-source']) fields[id] = new Element();
  Object.assign(fields, { 'trajectory-smooth-enabled': new Element(), 'trajectory-smooth-window': new Element('2'),
    'trajectory-lines-ids': new Element(''), 'trajectory-lines-first': new Element('1'), 'trajectory-lines-last': new Element(String(frameCount)),
    'trajectory-lines-stride': new Element('1'), 'trajectory-lines-color': new Element('#ff9f1c'), 'trajectory-lines-width': new Element('2'),
    'trajectory-lines-time': new Element(), 'trajectory-lines-visible': new Element() });
  fields['trajectory-lines-visible'].checked = true;
  globalThis.document = { getElementById: id => fields[id] ?? null, activeElement: null,
    createElement() { const element = new Element(); element.ownerDocument = this; return element; } };
  for (const element of Object.values(fields)) element.ownerDocument = globalThis.document;
  t.after(() => { globalThis.document = previousDocument; });
  const calls = { smoothing: [], lines: [], unwrap: [], edits: 0, notes: [], rendered: [] };
  let mode = 'file';
  const worker = {
    trajectoryLines: async (request, { onProgress }) => {
      calls.lines.push(request);
      onProgress({ loaded: 1, total: 2 });
      return { vertices: new Float32Array(8), vertexCount: 2, lineCount: 1, lineAtomIds: [request.ids[0]], lineOffsets: Uint32Array.from([0, 2]),
        frames: Int32Array.from([0, 1]), missingAtomIds: [], missingCount: 0, bounds: { minimum: [0, 0, 0], maximum: [1, 1, 1] } };
    },
    trajectoryUnwrap: async (index, options) => {
      calls.unwrap.push({ index, smoothing: options.smoothing, infer: options.infer });
      return { inferredUnwrap: { imageFlags: new Int32Array(frame.ids.length * 3), unwrappedPositions: new Float32Array(frame.ids.length * 3) } };
    },
  };
  const renderer = { setTrajectoryLines: (lines, options) => calls.rendered.push({ lines, options }) };
  const tools = initializeTrajectoryToolControls({ tools: { setToolEnabled: (name, enabled) => { calls.enabled = enabled; } }, renderer, worker,
    getFrame: () => frame, getFrameIndex: () => 3, getFrameCount: () => frameCount, getSourceVersion: () => 1,
    getSelectionGroups: () => groups, getCoordinateMode: () => mode, canInferUnwrap,
    onUnwrapChange: async enabled => { mode = enabled ? 'unwrapped' : 'file'; calls.unwrapToggle = enabled; },
    onInferenceChange: async enabled => { calls.inferenceToggle = enabled; },
    onSmoothingChange: async settings => { calls.smoothing.push(settings); }, onEdit: () => { calls.edits++; }, notify: message => calls.notes.push(message) });
  tools.setEnabled(true);
  const change = (id, value, checkbox = false) => {
    if (checkbox) fields[id].checked = value; else fields[id].value = String(value);
    return fields[id].dispatch(id === 'trajectory-lines-color' ? 'input' : 'change');
  };
  return { tools, fields, calls, worker, change, setMode: value => { mode = value; }, frame };
}

test('cancelled inference cannot attach late data or remove the replacement request for the same frame', async t => {
  const { tools, frame, worker } = harness(t);
  tools.setInferenceEnabled(true);
  const pending = [];
  worker.trajectoryUnwrap = () => new Promise(resolve => pending.push(resolve));
  const previous = tools.ensureInferredUnwrap(frame, 3);
  tools.cancelUnwrap();
  const replacement = tools.ensureInferredUnwrap(frame, 3, { showProgress: false, background: true });
  const result = () => ({ inferredUnwrap: { imageFlags: new Int32Array(9), unwrappedPositions: new Float32Array(9) } });
  pending[0](result());
  assert.equal(await previous, false);
  assert.equal(frame.inferredUnwrap, undefined);
  const joined = tools.ensureInferredUnwrap(frame, 3);
  assert.equal(pending.length, 2, 'late completion cannot erase the live shared request');
  pending[1](result());
  assert.equal(await replacement, true);
  assert.equal(await joined, true);
  assert.equal(tools.needsInferredUnwrap(frame), false);
});

test('with every option off, frame requests are unchanged and nothing is enabled', t => {
  const { tools, fields, setMode } = harness(t);
  assert.equal(tools.frameRequestOptions(), null);
  assert.equal(tools.smoothingWindow(), 0);
  assert.equal(tools.inferenceEnabled(), false);
  assert.equal(fields['trajectory-unwrap-enabled'].checked, false);
  assert.equal(fields['trajectory-infer-unwrap'].checked, false);
  assert.equal(fields['trajectory-smooth-enabled'].disabled, false);
  setMode('unwrapped');
  assert.equal(tools.frameRequestOptions(), null, 'display inference never delays ordinary reads or prefetch');
  assert.deepEqual(tools.serialize().smoothing, { enabled: false, window: 2 });
});

test('smoothing edits validate the window and apply through the page', async t => {
  const { tools, fields, calls, change } = harness(t);
  await change('trajectory-smooth-window', '60');
  assert.match(calls.notes.at(-1), /1 to 50/);
  assert.equal(fields['trajectory-smooth-window'].value, '2');
  await change('trajectory-smooth-window', '3');
  assert.equal(calls.smoothing.length, 0, 'a window edit while off is only remembered');
  await change('trajectory-smooth-enabled', true, true);
  assert.deepEqual(calls.smoothing, [{ enabled: true, window: 3 }]);
  assert.deepEqual(tools.frameRequestOptions(), { unwrap: false, smoothing: 3 });
  assert.equal(calls.enabled, true);
  await change('trajectory-smooth-window', '5');
  assert.deepEqual(calls.smoothing.at(-1), { enabled: true, window: 5 });
  assert.equal(tools.setSmoothing({ enabled: true, window: 5 }), false);
  assert.equal(tools.setSmoothing({ enabled: false }), true);
  assert.equal(tools.frameRequestOptions(), null);
});

test('limited smoothing caches explain possible rereads without changing saved settings', t => {
  const { tools, fields, frame } = harness(t);
  frame.smoothing = { window: 5, firstFrame: 0, lastFrame: 8, frameCount: 9,
    cacheLimited: { budgetBytes: 768 * 1024 ** 2, requestedBytes: 900 * 1024 ** 2 } };
  tools.setSmoothing({ enabled: true, window: 5 });
  assert.match(fields['trajectory-smooth-status'].textContent, /limited to 768 MiB.*may reread frames/);
  assert.deepEqual(tools.serialize().smoothing, { enabled: true, window: 5 });
  delete frame.smoothing.cacheLimited;
  tools.onFrame();
  assert.doesNotMatch(fields['trajectory-smooth-status'].textContent, /reread|limited/);
});

test('lines read IDs or groups, enforce the point limit before reading, and round-trip settings', async t => {
  const groups = [{ id: 'g', name: 'Solutes', atomIds: [4, 9] }, { id: 'big', name: 'All', atomIds: Array.from({ length: 200_000 }, (_, index) => index + 1) }];
  const { tools, fields, calls, change } = harness(t, { groups });
  fields['trajectory-lines-ids'].value = '';
  fields['generate-trajectory-lines'].dispatch('click');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(fields['trajectory-lines-status'].textContent, /at least one atom ID/);
  fields['trajectory-lines-ids'].value = '7, 8 X1';
  fields['trajectory-lines-stride'].value = '5';
  assert.equal(await tools.generateLines(), true);
  assert.deepEqual(calls.lines.at(-1), { ids: [7, 8, 'X1'], first: 0, last: 11, stride: 5, inferMissingImages: false });
  assert.match(fields['trajectory-lines-status'].textContent, /^1 path · 2 points · frames 1–12, every 5 frames\./);
  assert.ok(calls.rendered.at(-1).lines);
  await change('trajectory-lines-width', '4');
  assert.equal(calls.rendered.at(-1).options.width, 4);
  assert.equal(calls.lines.length, 1, 'appearance edits never recompute paths');
  await change('trajectory-lines-source', 'group:g');
  assert.equal(fields['trajectory-lines-ids-field'].hidden, true);
  fields['trajectory-lines-ids'].value = Array.from({ length: 100_001 }, (_, index) => index + 1).join(' ');
  await change('trajectory-lines-source', 'ids');
  assert.match(calls.notes.at(-1), /at most 100,000 atom IDs/);
  await change('trajectory-lines-source', 'group:big');
  fields['trajectory-lines-stride'].value = '1';
  assert.equal(await tools.generateLines(), false);
  assert.match(fields['trajectory-lines-status'].textContent, /200,000 atoms × 12 frames = 2,400,000 points; the limit is 2,000,000/);
  assert.equal(calls.lines.length, 1);
  await change('trajectory-lines-source', 'group:g');
  assert.equal(await tools.generateLines(), true);
  assert.deepEqual(calls.lines.at(-1).ids, [4, 9]);
  const saved = tools.serialize().lines;
  assert.deepEqual(saved, { enabled: true, source: 'group', selectionGroupId: 'g', atomIds: [], firstFrame: 0, lastFrame: null, stride: 1,
    visible: true, color: '#ff9f1c', width: 4, colorByTime: false, colorScheme: 'viridis' });
  tools.clearLines();
  assert.equal(calls.rendered.at(-1).lines, null);
  assert.equal(tools.serialize().lines.enabled, false);
  assert.equal(await tools.restoreLines(saved), true);
  assert.deepEqual(calls.lines.at(-1).ids, [4, 9]);
  assert.equal(calls.rendered.at(-1).options.width, 4);
});

test('inferred unwrapping is requested once per delivered frame and follows its smoothing', async t => {
  const { tools, calls, frame } = harness(t);
  tools.setInferenceEnabled(true);
  frame.smoothing = { window: 2 };
  assert.equal(tools.needsInferredUnwrap(frame), true);
  const [first, second] = await Promise.all([tools.ensureInferredUnwrap(frame, 3), tools.ensureInferredUnwrap(frame, 3)]);
  assert.equal(first && second, true);
  assert.deepEqual(calls.unwrap, [{ index: 3, smoothing: 2, infer: true }]);
  assert.ok(frame.inferredUnwrap.imageFlags instanceof Int32Array);
  assert.equal(tools.needsInferredUnwrap(frame), false);
  const fileFrame = { ids: [1], unwrappedPositions: new Float32Array(3) };
  assert.equal(await tools.ensureInferredUnwrap(fileFrame, 0), true);
  assert.equal(calls.unwrap.length, 1);
});

test('closing the tool removes lines and turns smoothing off; reset restores defaults', async t => {
  const { tools, fields, calls, change } = harness(t);
  fields['trajectory-lines-ids'].value = '1';
  await tools.generateLines();
  await change('trajectory-smooth-enabled', true, true);
  await tools.deactivate();
  assert.deepEqual(calls.smoothing.at(-1), { enabled: false, window: 2 });
  assert.equal(calls.rendered.at(-1).lines, null);
  assert.equal(calls.enabled, false);
  tools.reset();
  assert.deepEqual(tools.serialize(), { unwrap: { inferFromFrames: false }, smoothing: { enabled: false, window: 2 }, lines: { enabled: false, source: 'ids', selectionGroupId: null,
    atomIds: [], firstFrame: 0, lastFrame: null, stride: 1, visible: true, color: '#ff9f1c', width: 2, colorByTime: false, colorScheme: 'viridis' } });
});

test('turning on Unwrap alone never requests missing crossing history', async t => {
  const { tools, fields, calls, change, frame } = harness(t);
  await change('trajectory-unwrap-enabled', true, true);
  assert.equal(calls.unwrapToggle, true);
  assert.equal(fields['trajectory-unwrap-enabled'].checked, true);
  assert.equal(tools.needsUnwrap(frame), false);
  assert.equal(tools.needsInferredUnwrap(frame), false);
  assert.equal(await tools.ensureUnwrap(frame, 8), false);
  assert.deepEqual(calls.unwrap, []);
  assert.match(fields['trajectory-unwrap-status'].textContent, /Showing file coordinates/);
  await change('trajectory-infer-unwrap', true, true);
  assert.equal(calls.inferenceToggle, true);
  assert.equal(tools.needsInferredUnwrap(frame), true);
  assert.equal(await tools.ensureUnwrap(frame, 8), true);
  assert.equal(calls.unwrap[0].infer, true);
  await change('trajectory-infer-unwrap', false, true);
  assert.equal(tools.inferenceEnabled(), false);
  assert.equal(await tools.ensureUnwrap(frame, 8), false, 'cached inferred coordinates require continuing explicit consent');
  await change('trajectory-unwrap-enabled', false, true);
  assert.equal(calls.unwrapToggle, false);
  assert.equal(fields['trajectory-unwrap-enabled'].checked, false);
});

test('file image counts use a single-frame request even when trajectory inference is enabled', async t => {
  const { tools, worker, frame, calls } = harness(t);
  frame.imageFlags = Int32Array.of(3, -1, 2, 0, 0, 0, 1, 0, 0);
  frame.unwrapSource = 'ix/iy/iz';
  worker.trajectoryUnwrap = async (index, options) => {
    calls.unwrap.push({ index, infer: options.infer });
    return { imageFlags: frame.imageFlags, unwrappedPositions: Float32Array.of(30.2, -8, 23, 1, 2, 3, 12, 2, 3), unwrapSource: 'ix/iy/iz' };
  };
  tools.setInferenceEnabled(true);
  assert.equal(tools.needsInferredUnwrap(frame), false);
  assert.equal(tools.needsUnwrap(frame), true);
  assert.equal(await tools.ensureUnwrap(frame, 164), true);
  assert.deepEqual(calls.unwrap, [{ index: 164, infer: false }]);
  assert.equal(frame.unwrapSource, 'ix/iy/iz');
  assert.ok(Math.abs(frame.unwrappedPositions[0] - 30.2) < 1e-5);
  assert.equal(tools.needsUnwrap(frame), false);
});

test('source inference consent stays editable on file-image frames and physical copies', t => {
  const { tools, fields, frame } = harness(t, { canInferUnwrap: () => false });
  frame.imageFlags = new Int32Array(frame.ids.length * 3);
  frame.physicalReplication = { repetitions: [2, 1, 1] };
  tools.setInferenceEnabled(true);
  assert.equal(fields['trajectory-infer-unwrap'].disabled, false);
  tools.setInferenceEnabled(false);
  assert.equal(fields['trajectory-infer-unwrap'].checked, false);
});

test('generated paths follow the inference checkbox and changing it invalidates the old convention', async t => {
  const { tools, fields, calls, change } = harness(t);
  fields['trajectory-lines-ids'].value = '1';
  await tools.generateLines();
  assert.equal(calls.lines.at(-1).inferMissingImages, false);
  assert.match(fields['trajectory-lines-status'].textContent, /missing image counts were not inferred/);
  await change('trajectory-infer-unwrap', true, true);
  assert.equal(calls.rendered.at(-1).lines, null);
  await tools.generateLines();
  assert.equal(calls.lines.at(-1).inferMissingImages, true);
});

test('deactivating Trajectory revokes inference for dependent calculations too', async t => {
  const { tools, calls } = harness(t);
  tools.setInferenceEnabled(true);
  await tools.deactivate();
  assert.equal(tools.inferenceEnabled(), false);
  assert.equal(calls.inferenceToggle, false);
});
