import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDxaTools } from '../src/dxa-tools.js';
import { createConfiguration, parseConfiguration } from '../src/configuration.js';

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = new Map();
    this.style = {}; this.value = ''; this.checked = false; this.hidden = false;
    this.textContent = ''; this.disabled = false;
    this.classList = { toggle() {} };
  }
  get valueAsNumber() { return Number(this.value); }
  setAttribute(name, value) { this[name] = String(value); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(selector === 'input' && child.tagName === 'INPUT' ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  dispatch(name) { this.listeners.get(name)?.({ target: this }); }
}

function harness(t) {
  const previousDocument = globalThis.document;
  const ids = ['dxa-lattice', 'dxa-trial-length', 'dxa-stretchability', 'dxa-smoothing',
    'dxa-point-interval', 'dxa-perfect-only', 'dxa-line-radius', 'run-dxa', 'cancel-dxa',
    'dxa-families', 'dxa-state', 'dxa-results', 'dxa-summary', 'dxa-status'];
  const fields = Object.fromEntries(ids.map(id => [id, new Element()]));
  globalThis.document = { getElementById: id => fields[id], createElement: tag => new Element(tag) };
  t.after(() => { globalThis.document = previousDocument; });
  let frame = { ids: new Uint32Array([1, 2, 3, 4]), properties: [{ name: 'coordination', data: new Uint8Array([12, 12, 12, 12]) }] };
  let version = 'source:0', gpuEnabled = true;
  const pending = [], enabledTools = new Set(), draws = [], notifications = [];
  const client = {
    releases: 0,
    analyze(inputFrame, parameters, options) {
      return new Promise((resolve, reject) => pending.push({ inputFrame, parameters, options, resolve, reject }));
    },
    release() { this.releases++; },
  };
  const renderer = { atomColors: new Uint8Array([10, 20, 30]),
    setDislocationNetwork(network, settings) { this.network = network; this.settings = settings; draws.push({ network, settings }); } };
  const tools = initializeDxaTools({ renderer, client,
    tools: { setToolEnabled(name, enabled) { if (enabled) enabledTools.add(name); else enabledTools.delete(name); } },
    getFrame: () => frame, getSourceVersion: () => version, getGpuEnabled: () => gpuEnabled,
    notify: message => notifications.push(message),
  });
  tools.setEnabled(true);
  return { tools, client, pending, enabledTools, draws, renderer, fields, notifications,
    getFrame: () => frame,
    setGpuEnabled(value) { gpuEnabled = value; },
    setFrame(value, sourceVersion = version) { frame = value; version = sourceVersion; },
  };
}

function network(length = 4) {
  return { segments: [{ id: 0, familyId: 'perfect', points: new Float64Array([0, 0, 0, length, 0, 0]) }],
    counts: { perfect: 1 }, totalLength: length, density: length / 1000, elapsedMs: 16, engine: 'Wasm CPU',
    backend: 'cpu', gpuFallback: true };
}

test('DXA Cancel aborts and releases work, rejects late networks, and preserves atom analyses', async t => {
  const h = harness(t), originalProperties = h.getFrame().properties, atomColors = h.renderer.atomColors;
  const task = h.tools.run();
  assert.equal(h.enabledTools.has('dxa'), true);
  assert.equal(h.fields['dxa-state'].textContent, 'Calculating…');
  const releases = h.client.releases;
  h.tools.cancel();
  assert.equal(h.pending[0].options.signal.aborted, true);
  assert.equal(h.client.releases, releases + 1);
  assert.equal(h.enabledTools.has('dxa'), false);
  assert.equal(h.renderer.network, null);
  assert.equal(h.fields['dxa-results'].hidden, true);
  // Model a Worker reply already queued on the main thread when Cancel ran.
  h.pending[0].resolve(network());
  assert.equal(await task, false);
  assert.equal(h.renderer.network, null);
  assert.equal(h.fields['dxa-state'].textContent, 'Not calculated');
  assert.equal(h.getFrame().properties, originalProperties);
  assert.equal(h.renderer.atomColors, atomColors);
});

for (const [change, version] of [['source', 'new-source:0'], ['physical replication', 'source:1']]) {
  test(`${change} changes discard old DXA results and automatically analyze the new frame`, async t => {
    const h = harness(t), old = h.tools.run(), first = h.pending[0];
    const replacement = { ids: new Uint32Array([1, 2, 3, 4, 5, 6, 7, 8]), properties: [] };
    h.setFrame(replacement, version);
    const updated = h.tools.onFrame();
    assert.equal(first.options.signal.aborted, true);
    assert.equal(h.pending[1].inputFrame, replacement);
    first.options.onProgress({ phase: 'obsolete', completedStages: 11, totalStages: 12 });
    assert.doesNotMatch(h.fields['dxa-status'].textContent, /obsolete/);
    first.resolve(network(20));
    assert.equal(await old, false);
    assert.equal(h.renderer.network, null);
    const accepted = network(7);
    h.pending[1].resolve(accepted); await updated;
    assert.equal(h.renderer.network, accepted);
    assert.equal(h.fields['dxa-state'].textContent, 'Calculated');
  });
}

test('line family visibility, colors, and radius redraw without changing atom colors or recalculating', async t => {
  const h = harness(t), task = h.tools.run(), accepted = network();
  const atomColors = h.renderer.atomColors;
  h.pending[0].resolve(accepted); await task;
  const [visibility, color] = h.fields['dxa-families'].children[0].children;
  visibility.checked = false; visibility.dispatch('change');
  assert.equal(h.renderer.settings.visibleFamilies.includes('perfect'), false);
  color.value = '#123456'; color.dispatch('input');
  assert.equal(h.renderer.settings.familyColors.perfect, '#123456');
  h.fields['dxa-line-radius'].value = '0.5'; h.fields['dxa-line-radius'].dispatch('change');
  assert.equal(h.renderer.settings.radius, .5);
  assert.equal(h.renderer.network, accepted);
  assert.equal(h.renderer.atomColors, atomColors);
  assert.equal(h.pending.length, 1);
  assert.match(h.fields['dxa-summary'].textContent, /1 segments.*4\.0000 Å/);
  assert.match(h.fields['dxa-status'].textContent, /Wasm CPU.*CPU fallback/);
});

test('same-frame results can be reused, while Cancel removes all cached DXA networks', async t => {
  const h = harness(t), first = h.tools.run();
  h.pending[0].resolve(network()); await first;
  assert.equal(await h.tools.run(), true);
  assert.equal(h.pending.length, 1);
  h.tools.cancel();
  const repeated = h.tools.run();
  assert.equal(h.pending.length, 2);
  h.pending[1].resolve(network(8)); await repeated;
  assert.equal(h.renderer.network.totalLength, 8);
});

test('DXA displays the actual GPU stage and mixed backend without claiming CPU fallback', async t => {
  const h = harness(t), task = h.tools.run();
  h.pending[0].options.onProgress({ phase: 'dxa-local-neighbors', backend: 'gpu', workerCount: 1,
    completedStages: 0, totalStages: 11, completedAtoms: 0, processedAtoms: 2048, totalAtoms: 4096 });
  assert.match(h.fields['dxa-status'].textContent, /GPU.*2,048 \/ 4,096 atoms/);
  h.pending[0].options.onProgress({ phase: 'tetrahedron-alpha', backend: 'gpu', workerCount: 4,
    completedStages: 7, totalStages: 11, completedTetrahedra: 400, totalTetrahedra: 1200 });
  assert.match(h.fields['dxa-status'].textContent, /GPU.*400 \/ 1,200 tetrahedra/);
  assert.doesNotMatch(h.fields['dxa-status'].textContent, /CPU|threads/);
  h.pending[0].resolve({ ...network(), backend: 'hybrid', engine: 'Wasm CPU + WebGPU',
    gpuFallback: false, gpuStages: ['tetrahedron-alpha', 'elastic-compatibility'],
    stageFallbacks: [{ stage: 'local', reason: 'GPU local precision limit' }] });
  await task;
  assert.match(h.fields['dxa-status'].textContent, /Wasm CPU \+ WebGPU/);
  assert.doesNotMatch(h.fields['dxa-status'].textContent, /fallback/);
  assert.match(h.fields['dxa-status'].title, /elastic-compatibility/);
  assert.match(h.fields['dxa-status'].title, /local CPU fallback: GPU local precision limit/);
});

test('changing GPU preference reruns DXA on the same frame instead of reusing the other backend', async t => {
  const h = harness(t), initial = h.tools.run();
  h.pending[0].resolve(network()); await initial;
  h.setGpuEnabled(false);
  const cpu = h.tools.run();
  assert.equal(h.pending.length, 2);
  assert.equal(h.pending[1].parameters.gpuEnabled, false);
  h.pending[1].resolve({ ...network(), gpuFallback: false }); await cpu;
  assert.doesNotMatch(h.fields['dxa-status'].textContent, /fallback/);
  assert.equal(await h.tools.run(), true);
  assert.equal(h.pending.length, 2);
});

test('DXA retains only the latest result rather than caching line graphs across a trajectory', async t => {
  const h = harness(t), firstFrame = h.getFrame(), first = h.tools.run();
  h.pending[0].resolve(network()); await first;
  h.setFrame({ ids: new Uint32Array([1, 2, 3, 4]), properties: [] });
  const second = h.tools.onFrame();
  h.pending[1].resolve(network(5)); await second;
  h.setFrame(firstFrame);
  const revisited = h.tools.onFrame();
  assert.equal(h.pending.length, 3);
  h.pending[2].resolve(network()); await revisited;
  assert.equal(h.renderer.network.totalLength, 4);
});

test('portable DXA recipes restore settings and replay calculation without storing a computed network', async t => {
  const h = harness(t);
  const recipe = createConfiguration({ settings: { activeTool: 'dxa', extensions: { dxa: {
    enabled: true, lattice: 'bcc', trialCircuitLength: 18, circuitStretchability: 7,
    lineSmoothingIterations: 2, linePointInterval: 3.5, onlyPerfectDislocations: true,
    radius: .35, visibleFamilies: ['half111'], familyColors: [{ family: 'half111', color: '#778899' }],
  } } } });
  const text = JSON.stringify(recipe);
  assert.doesNotMatch(text, /segments|burgersVector|atomStructureTypes/);
  const saved = parseConfiguration(text).settings.extensions.dxa;
  const restored = h.tools.restore(saved);
  assert.equal(h.pending.length, 1);
  assert.equal(h.pending[0].parameters.lattice, 'bcc');
  assert.equal(h.pending[0].parameters.trialCircuitLength, 18);
  const accepted = network(); accepted.segments[0].familyId = 'half111'; accepted.counts = { half111: 1 };
  h.pending[0].resolve(accepted); await restored;
  assert.deepEqual(h.renderer.settings.visibleFamilies, ['half111']);
  assert.equal(h.renderer.settings.radius, .35);
  assert.equal(h.renderer.settings.familyColors.half111, '#778899');
  assert.deepEqual(h.tools.serialize(), saved);
  h.tools.reset();
  assert.equal(h.enabledTools.has('dxa'), false);
  assert.equal(h.renderer.network, null);
  assert.equal(h.tools.serialize().lattice, 'fcc');
});

test('invalid settings and analysis failure clear obsolete lines and leave Cancel available', async t => {
  const h = harness(t), first = h.tools.run();
  h.pending[0].resolve(network()); await first;
  h.fields['dxa-trial-length'].value = '2';
  assert.equal(await h.tools.run(), false);
  assert.equal(h.renderer.network, null);
  assert.equal(h.fields['dxa-state'].textContent, 'Failed');
  assert.equal(h.fields['cancel-dxa'].disabled, false);
  h.fields['dxa-trial-length'].value = '14';
  const retried = h.tools.run();
  // Change a valid setting to request a fresh computation rather than cache.
  await retried;
  h.fields['dxa-stretchability'].value = '10';
  const failed = h.tools.run();
  h.pending.at(-1).reject(new Error('Simulation box is too short.'));
  assert.equal(await failed, false);
  assert.equal(h.renderer.network, null);
  assert.match(h.fields['dxa-status'].textContent, /too short/);
  h.tools.cancel();
  assert.equal(h.tools.failed(), false);
});
