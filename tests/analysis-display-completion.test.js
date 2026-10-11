import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeAtomEyeTools } from '../src/atomeye-tools.js';
import { createDisplayRefresh } from '../src/display-refresh.js';
import { createCell } from '../src/data/model.js';

async function withDisplayControls(run) {
  const oldDocument = globalThis.document, elements = new Map(), notifications = [], painted = [];
  const element = () => ({ value: '1', checked: false, children: [], listeners: {}, dataset: {},
    get valueAsNumber() { return Number(this.value); }, classList: { toggle() {} }, setAttribute() {}, removeAttribute() {},
    append(...items) { this.children.push(...items); }, prepend(...items) { this.children.unshift(...items); },
    replaceChildren(...items) { this.children = items; }, addEventListener(name, listener) { this.listeners[name] = listener; } });
  globalThis.document = { querySelectorAll: () => [], createElement: element,
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } };
  const frame = { frameIndex: 0, idSource: 'explicit', ids: Uint32Array.of(1, 2), types: Uint16Array.of(0, 0),
    typeLabels: ['Fe'], properties: [], fractional: Float64Array.of(.1, .1, .1, .2, .2, .2), positions: Float64Array.of(1, 1, 1, 2, 2, 2),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }) };
  let colorMode = 'type', scheduled;
  const display = createDisplayRefresh({ apply: flags => { if (flags.colors) painted.push(colorMode); },
    schedule: callback => { scheduled = callback; return 1; }, cancel: () => { scheduled = null; } });
  try {
    const controls = initializeAtomEyeTools({ renderer: { frame, atomCount: 2, setSelectedAtoms() {}, setVectorFields() {} },
      pool: { gpuEnabled: true, async analyze(target, parameters) {
        return { elapsedMs: 1, engine: 'webgpu', gpuRequested: true, ...(parameters.kind === 'localShear'
          ? { localShear: Float32Array.of(1, 2) } : { vectors: Float32Array.of(1, 2, 3, 4, 5, 6) }) };
      } }, tools: { setToolEnabled() {}, isToolEnabled: () => false }, getFrame: () => frame, getFrames: () => [frame],
      getFrameAt: async () => frame, getFrameIndex: () => 0, getFrameCount: () => 1, getSelectedIndex: () => -1, getSourceVersion: () => 1,
      getColorMode: () => colorMode, refresh: () => display.request({ colors: true }),
      chooseProperty: name => { colorMode = `property:${name}`; display.request({ colors: true }); },
      requestDisplayRefresh: flags => display.request(flags), afterDisplayRefresh: callback => display.afterFlush(callback),
      notify: message => notifications.push(message) });
    for (const axis of ['a', 'b', 'c']) globalThis.document.getElementById(`displacement-tiles-${axis}`).value = '0';
    await run({ controls, frame, elements, painted, display, tick: () => { const callback = scheduled; scheduled = null; callback?.(); } });
    assert.deepEqual(notifications, []);
  } finally {
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
  }
}

for (const kind of ['localShear', 'displacement']) {
  test(`${kind} publishes scientific values immediately and reports Calculated after the color legend`, async () => {
    await withDisplayControls(async ({ controls, frame, elements, painted, tick }) => {
      if (kind === 'localShear') await controls.run(kind); else await controls.runDisplacement();
      const property = kind === 'localShear' ? 'localShear' : 'displacementMagnitude';
      const state = elements.get(kind === 'localShear' ? 'local-shear-state' : 'displacement-state');
      assert.ok(frame.properties.find(field => field.name === property));
      assert.equal(state.textContent, 'Calculating…');
      assert.deepEqual(painted, []);
      tick();
      assert.deepEqual(painted, [`property:${property}`]);
      assert.equal(state.textContent, 'Calculated');
      const cached = frame.atomeyeResults[kind].result;
      if (kind === 'localShear') await controls.run(kind); else await controls.runDisplacement();
      assert.equal(frame.atomeyeResults[kind].result, cached, 'cached scientific results remain resident');
      assert.equal(state.textContent, 'Calculating…', 'cached reruns also wait for their display flush');
      tick();
      assert.equal(state.textContent, 'Calculated');
      assert.deepEqual(painted, [`property:${property}`, `property:${property}`]);
    });
  });
}

test('cancelling after publication prevents a queued completion from reviving an analysis', async () => {
  await withDisplayControls(async ({ controls, elements, display }) => {
    await controls.run('localShear');
    controls.cancel('localShear');
    display.flush();
    assert.equal(elements.get('local-shear-state').textContent, 'Not calculated');
  });
});
