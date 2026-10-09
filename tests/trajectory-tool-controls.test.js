import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeTrajectoryToolControls } from '../src/trajectory-tool-controls.js';

class Element {
  constructor(value = '') {
    this.value = String(value); this.textContent = ''; this.hidden = false; this.checked = false; this.disabled = false;
    this.listeners = new Map(); this.dataset = {}; this.children = []; this.options = [];
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name) { return this.listeners.get(name)?.({ target: this }); }
  replaceChildren(...children) { this.children = children; this.options = children; }
}

function harness(t, { frameCount = 12, frame = { ids: Float64Array.from([1, 2, 3]), frameIndex: 0 }, groups = [] } = {}) {
  const previousDocument = globalThis.document;
  const fields = {};
  for (const id of ['trajectory-unwrap-status', 'cancel-trajectory-unwrap', 'trajectory-smooth-status', 'trajectory-lines-ids-field',
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
  let mode = 'wrapped';
  const worker = {
    trajectoryLines: async (request, { onProgress }) => {
      calls.lines.push(request);
      onProgress({ loaded: 1, total: 2 });
      return { vertices: new Float32Array(8), vertexCount: 2, lineCount: 1, lineAtomIds: [request.ids[0]], lineOffsets: Uint32Array.from([0, 2]),
        frames: Int32Array.from([0, 1]), missingAtomIds: [], missingCount: 0, bounds: { minimum: [0, 0, 0], maximum: [1, 1, 1] } };
    },
    trajectoryUnwrap: async (index, options) => {
      calls.unwrap.push({ index, smoothing: options.smoothing });
      return { inferredUnwrap: { imageFlags: new Int32Array(frame.ids.length * 3), unwrappedPositions: new Float32Array(frame.ids.length * 3) } };
    },
  };
  const renderer = { setTrajectoryLines: (lines, options) => calls.rendered.push({ lines, options }) };
  const tools = initializeTrajectoryToolControls({ tools: { setToolEnabled: (name, enabled) => { calls.enabled = enabled; } }, renderer, worker,
    getFrame: () => frame, getFrameIndex: () => 3, getFrameCount: () => frameCount, getSourceVersion: () => 1,
    getSelectionGroups: () => groups, getCoordinateMode: () => mode, canInferUnwrap: () => frameCount > 1,
    onSmoothingChange: async settings => { calls.smoothing.push(settings); }, onEdit: () => { calls.edits++; }, notify: message => calls.notes.push(message) });
  tools.setEnabled(true);
  const change = (id, value, checkbox = false) => {
    if (checkbox) fields[id].checked = value; else fields[id].value = String(value);
    return fields[id].dispatch(id === 'trajectory-lines-color' ? 'input' : 'change');
  };
  return { tools, fields, calls, change, setMode: value => { mode = value; }, frame };
}

test('with every option off, frame requests are unchanged and nothing is enabled', t => {
  const { tools, fields, setMode } = harness(t);
  assert.equal(tools.frameRequestOptions(), null);
  assert.equal(tools.smoothingWindow(), 0);
  assert.equal(fields['trajectory-smooth-enabled'].disabled, false);
  setMode('unwrapped');
  assert.deepEqual(tools.frameRequestOptions(), { unwrap: true, smoothing: 0 });
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
  assert.deepEqual(calls.lines.at(-1), { ids: [7, 8, 'X1'], first: 0, last: 11, stride: 5 });
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
  frame.smoothing = { window: 2 };
  assert.equal(tools.needsInferredUnwrap(frame), true);
  const [first, second] = await Promise.all([tools.ensureInferredUnwrap(frame, 3), tools.ensureInferredUnwrap(frame, 3)]);
  assert.equal(first && second, true);
  assert.deepEqual(calls.unwrap, [{ index: 3, smoothing: 2 }]);
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
  assert.deepEqual(tools.serialize(), { smoothing: { enabled: false, window: 2 }, lines: { enabled: false, source: 'ids', selectionGroupId: null,
    atomIds: [], firstFrame: 0, lastFrame: null, stride: 1, visible: true, color: '#ff9f1c', width: 2, colorByTime: false, colorScheme: 'viridis' } });
});
