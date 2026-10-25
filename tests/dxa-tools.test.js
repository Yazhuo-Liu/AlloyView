import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDxaTools, DXA_STRUCTURE_PROPERTY, DXA_STRUCTURE_TYPES } from '../src/ui/analysis/dxa-tools.js';
import { createConfiguration, parseConfiguration } from '../src/application/configuration.js';
import { colorsByCategory, combineVisibilityMasks, visibilityByCategory, visibilityByType } from '../src/render/palette.js';
import { DxaClient } from '../src/analysis/dxa-client.js';
import { createCell } from '../src/data/model.js';

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

function harness(t, { gpuPreference, client: providedClient, initialFrame, resultCacheBytes, resultCacheLimit, automaticDelayMs = 0 } = {}) {
  const previousDocument = globalThis.document;
  const ids = ['dxa-lattice', 'dxa-trial-length', 'dxa-stretchability', 'dxa-smoothing',
    'dxa-point-interval', 'dxa-perfect-only', 'dxa-line-radius', 'run-dxa', 'cancel-dxa',
    'dxa-families', 'dxa-state', 'dxa-results', 'dxa-summary', 'dxa-status'];
  const fields = Object.fromEntries(ids.map(id => [id, new Element()]));
  globalThis.document = { getElementById: id => fields[id], createElement: tag => new Element(tag) };
  t.after(() => { globalThis.document = previousDocument; });
  let frame = initialFrame ?? { ids: new Uint32Array([1, 2, 3, 4]), properties: [{ name: 'coordination', data: new Uint8Array([12, 12, 12, 12]) }] };
  let version = 'source:0', colorMode = 'type', colorChoiceVersion = 0;
  const pending = [], enabledTools = new Set(), draws = [], notifications = [], resultChanges = [];
  const client = providedClient ?? {
    releases: 0,
    analyze(inputFrame, parameters, options) {
      return new Promise((resolve, reject) => pending.push({ inputFrame, parameters, options, resolve, reject }));
    },
    release() { this.releases++; },
  };
  const renderer = { atomColors: new Uint8Array([10, 20, 30]),
    setDislocationNetwork(network, settings) { this.network = network; this.settings = settings; draws.push({ network, settings }); } };
  const tools = initializeDxaTools({ renderer, client,
    automaticDelayMs,
    ...(resultCacheBytes === undefined ? {} : { resultCacheBytes }),
    ...(resultCacheLimit === undefined ? {} : { resultCacheLimit }),
    tools: { setToolEnabled(name, enabled) { if (enabled) enabledTools.add(name); else enabledTools.delete(name); } },
    getFrame: () => frame, getSourceVersion: () => version,
    // An obsolete preference callback must never affect the CPU-only tool.
    ...(gpuPreference ? { getGpuEnabled: gpuPreference } : {}),
    getColorMode: () => colorMode, getColorChoiceVersion: () => colorChoiceVersion,
    onResultsChange(change) {
      resultChanges.push(change);
      if (change.selectProperty) colorMode = `property:${change.selectProperty}`;
    },
    notify: message => notifications.push(message),
  });
  tools.setEnabled(true);
  return { tools, client, pending, enabledTools, draws, renderer, fields, notifications, resultChanges,
    getFrame: () => frame,
    getColorMode: () => colorMode,
    setColorMode(value) { colorMode = value; colorChoiceVersion++; },
    setFrame(value, sourceVersion = version) { frame = value; version = sourceVersion; },
  };
}

function network(length = 4) {
  return { segments: [{ id: 0, familyId: 'perfect', points: new Float64Array([0, 0, 0, length, 0, 0]) }],
    counts: { perfect: 1 }, totalLength: length, density: length / 1000, elapsedMs: 16, engine: 'Wasm CPU',
    backend: 'cpu', workerCount: 1 };
}

function structureNetwork(values = [0, 1, 2, 3], segments = []) {
  return { ...network(), atomStructureTypes: new Uint8Array(values), segments };
}

for (const order of ['surface-first', 'dxa-first']) {
  test(`DXA tool Cancel leaves the shared coordinator's independent surface intact (${order})`, async t => {
    class Worker {
      constructor() { this.listeners = new Map(); this.messages = []; this.terminated = false; }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      postMessage(message, transfer = []) { this.messages.push(structuredClone(message, { transfer })); }
      terminate() { this.terminated = true; }
      emit(data) { this.listeners.get('message')({ data }); }
    }
    const workers = [];
    const client = new DxaClient({
      environment: { navigator: { hardwareConcurrency: 8 }, crossOriginIsolated: true, SharedArrayBuffer },
      workerFactory: () => { const worker = new Worker(); workers.push(worker); return worker; }, yieldToMain: async () => {},
    });
    t.after(() => client.close());
    const frame = { ids: new Uint32Array([1, 2, 3, 4]), properties: [],
      fractional: new Float64Array([0, 0, 0, .5, .5, 0, .5, 0, .5, 0, .5, .5]),
      cell: createCell({ vectors: [4, 0, 0, 0, 4, 0, 0, 0, 4] }) };
    const h = harness(t, { client, initialFrame: frame });
    const startSurface = () => client.surface(frame, { radius: 2, smoothingLevel: 0 });
    let surface, dxa;
    if (order === 'surface-first') { surface = startSurface(); dxa = h.tools.run(); }
    else { dxa = h.tools.run(); surface = startSurface(); }
    const flush = () => new Promise(resolve => setImmediate(resolve));
    await flush();
    const worker = workers[0], first = worker.messages[0];
    const control = { cancelBuffer: new SharedArrayBuffer(64), cancelPointer: 0 };
    worker.emit({ id: first.id, control });
    h.tools.cancel();
    assert.equal(await dxa, false);
    assert.equal(worker.terminated, false, 'a tool cancellation preserves the shared Worker and Wasm heap');
    if (order === 'dxa-first') {
      assert.equal(Atomics.load(new Int32Array(control.cancelBuffer), 0), 1);
      assert.equal(worker.messages.filter(message => message.type === 'surface').length, 0, 'queued surface waits for native cancellation ACK');
      worker.emit({ id: first.id, ok: false, name: 'AbortError', error: 'Cancelled' });
      await flush();
      assert.equal(Atomics.load(new Int32Array(control.cancelBuffer), 0), 0);
    } else assert.equal(Atomics.load(new Int32Array(control.cancelBuffer), 0), 0, 'cancelling queued DXA never signals the active surface');
    const request = worker.messages.find(message => message.type === 'surface');
    assert.ok(request);
    worker.emit({ id: request.id, ok: true, result: { surfaceArea: 12 } });
    assert.equal((await surface).surfaceArea, 12);
    assert.equal(workers.length, 1);
    assert.equal(client.cpuBudget.active, 0);
  });
}

test('DXA exposes native crystal classes without copying atom structures or requiring dislocation lines', async t => {
  const h = harness(t), frame = h.getFrame(), originalProperty = frame.properties[0];
  frame.types = new Uint8Array([0, 0, 1, 0]); frame.typeLabels = ['Type 1', 'Fe'];
  const task = h.tools.run(), accepted = structureNetwork();
  assert.deepEqual(h.tools.pendingColorProperties(), [{ name: DXA_STRUCTURE_PROPERTY, label: 'Crystal structure (DXA)' }]);
  h.pending[0].resolve(accepted); await task;
  const property = frame.properties.find(item => item.name === DXA_STRUCTURE_PROPERTY);
  assert.equal(property.data, accepted.atomStructureTypes);
  assert.equal(property.analysisKind, 'dxa');
  assert.equal(property.displayName, 'Crystal structure (DXA)');
  assert.equal(frame.properties[0], originalProperty);
  assert.equal(h.getColorMode(), 'property:dxaStructureType');
  assert.deepEqual(DXA_STRUCTURE_TYPES.map(item => [item.id, item.label]), [
    [0, 'Other'], [1, 'FCC'], [2, 'HCP'], [3, 'BCC'], [4, 'Cubic diamond'], [5, 'Hexagonal diamond'],
  ]);
  const hidden = new Set([3]), palette = colorsByCategory(property, hidden);
  assert.deepEqual(palette.legend.items.map(item => item.count), [1, 1, 1, 1, 0, 0]);
  assert.equal(palette.legend.items[3].visible, false);
  assert.deepEqual([...visibilityByCategory(property, hidden)], [255, 255, 255, 0]);
  assert.deepEqual([...combineVisibilityMasks(visibilityByCategory(property, hidden),
    visibilityByType(frame, new Set(['Fe'])))], [255, 255, 0, 0]);
  assert.equal(h.renderer.network, accepted);
  assert.match(h.fields['dxa-summary'].textContent, /^0 segments/);
  assert.equal(h.pending.length, 1);
});

test('DXA default crystal color respects other choices, edits during calculation, reruns and automatic frames', async t => {
  const h = harness(t);
  const first = h.tools.run();
  h.setColorMode('type'); // A user change during the job must win, even to the same value.
  h.pending[0].resolve(structureNetwork()); await first;
  assert.equal(h.getColorMode(), 'type');
  assert.equal(await h.tools.run(), true);
  assert.equal(h.getColorMode(), 'type');
  h.setColorMode('property:coordination');
  assert.equal(await h.tools.run(), true);
  assert.equal(h.getColorMode(), 'property:coordination');
  h.setFrame({ ids: new Uint32Array([1, 2, 3, 4]), properties: [] });
  const next = h.tools.onFrame();
  h.pending[1].resolve(structureNetwork()); await next;
  assert.equal(h.getColorMode(), 'property:coordination');
  h.tools.cancel();
  const restarted = h.tools.run();
  h.pending[2].resolve(structureNetwork()); await restarted;
  assert.equal(h.getColorMode(), 'property:coordination');
});

test('DXA frame invalidation and Cancel remove only its own crystal result and reject late atom outputs', async t => {
  const h = harness(t), oldFrame = h.getFrame();
  const cna = { name: 'structureType', analysisKind: 'cna', data: new Uint8Array([1, 1, 1, 1]) };
  oldFrame.properties.push(cna);
  const first = h.tools.run();
  h.pending[0].resolve(structureNetwork()); await first;
  const replacement = { ids: new Uint32Array([1, 2, 3, 4]), properties: [cna] };
  h.setFrame(replacement);
  const obsolete = h.tools.onFrame();
  assert.equal(oldFrame.properties.some(item => item.analysisKind === 'dxa'), false);
  assert.equal(oldFrame.properties.includes(cna), true);
  h.tools.cancel();
  h.pending[1].resolve(structureNetwork());
  assert.equal(await obsolete, undefined);
  assert.deepEqual(replacement.properties, [cna]);
  assert.deepEqual(h.tools.pendingColorProperties(), []);
  const restarted = h.tools.run();
  h.pending[2].resolve(structureNetwork()); await restarted;
  h.tools.cancel();
  assert.deepEqual(replacement.properties, [cna]);
  assert.equal(h.resultChanges.at(-1).clearSettings, true);
});

test('DXA cancellation restores an imported property with the same output name', async t => {
  const h = harness(t), frame = h.getFrame();
  const imported = { name: DXA_STRUCTURE_PROPERTY, data: new Uint8Array([3, 3, 3, 3]) };
  frame.properties.push(imported);
  const task = h.tools.run();
  h.pending[0].resolve(structureNetwork()); await task;
  assert.notEqual(frame.properties.find(item => item.name === DXA_STRUCTURE_PROPERTY), imported);
  h.tools.cancel();
  assert.equal(frame.properties.find(item => item.name === DXA_STRUCTURE_PROPERTY), imported);
});

test('DXA Cancel aborts only its own work, rejects late networks, and preserves atom analyses', async t => {
  const h = harness(t), originalProperties = h.getFrame().properties, atomColors = h.renderer.atomColors;
  const task = h.tools.run();
  assert.equal(h.enabledTools.has('dxa'), true);
  assert.equal(h.fields['dxa-state'].textContent, 'Calculating…');
  const releases = h.client.releases;
  h.tools.cancel();
  assert.equal(h.pending[0].options.signal.aborted, true);
  assert.equal(h.client.releases, releases, 'the shared coordinator keeps unrelated surface and warm-up requests');
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
    first.options.onProgress({ phase: 'obsolete', completedStages: 11, totalStages: 11 });
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
  assert.match(h.fields['dxa-status'].textContent, /Wasm CPU.*1 thread/);
  assert.doesNotMatch(h.fields['dxa-status'].textContent, /fallback/);
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

test('DXA reports automatic CPU thread counts and eleven native stages', async t => {
  const h = harness(t), task = h.tools.run();
  assert.match(h.fields['dxa-status'].textContent, /Preparing CPU DXA/);
  assert.equal('gpuEnabled' in h.pending[0].parameters, false);
  h.pending[0].options.onProgress({ phase: 'local-structures', backend: 'cpu', workerCount: 4, completedStages: 2 });
  assert.match(h.fields['dxa-status'].textContent, /local structures.*CPU.*4 threads.*2 \/ 11 stages/);
  h.pending[0].options.onProgress({ phase: 'collecting', backend: 'cpu', workerCount: 4, completedStages: 11, totalStages: 11 });
  assert.match(h.fields['dxa-status'].textContent, /CPU.*4 threads.*11 \/ 11 stages/);
  h.pending[0].resolve({ ...network(), workerCount: 4, engine: 'Wasm CPU · 4 threads',
    stageTimings: [{ phase: 'local-structures', elapsedMs: 80 }, { phase: 'tracing', elapsedMs: 120 }] });
  await task;
  assert.match(h.fields['dxa-status'].textContent, /Wasm CPU.*4 threads/);
  assert.doesNotMatch(h.fields['dxa-status'].textContent, /fallback/);
  assert.match(h.fields['dxa-status'].title, /local-structures: 80 ms/);
  assert.match(h.fields['dxa-status'].title, /tracing: 120 ms/);
});

test('thread startup fallback reports one CPU thread and exposes the concrete reason in the status tooltip', async t => {
  const h = harness(t), task = h.tools.run();
  const reason = 'SharedArrayBuffer is unavailable because this page is not cross-origin isolated.';
  h.pending[0].options.onProgress({ phase: 'warming', backend: 'cpu', workerCount: 1, threadingFallback: reason });
  assert.match(h.fields['dxa-status'].textContent, /CPU.*1 thread.*0 \/ 11 stages/);
  assert.match(h.fields['dxa-status'].title, /SharedArrayBuffer/);
  h.pending[0].resolve({ ...network(), threadingFallback: reason });
  await task;
  assert.match(h.fields['dxa-status'].textContent, /Wasm CPU.*1 thread.*single-thread fallback/);
  assert.equal(h.fields['dxa-status'].title, `CPU threading fallback: ${reason}`);
});

test('private CPU stage workers are distinguished from global extraction threads and report stage fallbacks', async t => {
  const h = harness(t), task = h.tools.run();
  h.pending[0].options.onProgress({ phase: 'CPU local crystal recognition', cpuStage: 'local',
    backend: 'cpu', workerCount: 3, nativeWorkerCount: 1, completedStages: 0 });
  assert.match(h.fields['dxa-status'].textContent, /CPU local crystal recognition.*3 Workers.*global 1 thread/);
  assert.doesNotMatch(h.fields['dxa-status'].textContent, /3 threads/);
  const result = { ...structureNetwork(), workerCount: 3, nativeWorkerCount: 1,
    cpuOffloadUsed: true, cpuStageWorkerCounts: { local: 3, tetrahedra: 2 },
    cpuStageFallbacks: [{ stage: 'tetrahedra', reason: 'Worker startup was denied; remaining cells used the native CPU kernel.' }],
    cpuStageTimings: [{ stage: 'local', elapsedMs: 100, workerCount: 3,
      copiedBytes: 3 * 1024 ** 2, kernelInitializations: 3 }],
    stageTimings: [{ phase: 'Identify local crystal structures', elapsedMs: 120 }] };
  h.pending[0].resolve(result); await task;
  assert.match(h.fields['dxa-status'].textContent, /global 1 thread.*local stages up to 3 Workers/);
  assert.doesNotMatch(h.fields['dxa-status'].textContent, /3 threads/);
  assert.match(h.fields['dxa-status'].textContent, /local-stage fallback/);
  assert.match(h.fields['dxa-status'].title, /Global extraction: 1 CPU thread/);
  assert.match(h.fields['dxa-status'].title, /Local crystal identification: 3 CPU Workers/);
  assert.match(h.fields['dxa-status'].title, /Tetrahedron classification: 2 CPU Workers/);
  assert.match(h.fields['dxa-status'].title, /CPU tetrahedra fallback: Worker startup was denied/);
  assert.match(h.fields['dxa-status'].title, /CPU local offload: 100 ms.*3 Workers.*3\.00 MiB copied.*3 kernel initializations/);
  assert.match(h.fields['dxa-status'].title, /Identify local crystal structures: 120 ms/);
  assert.equal(h.getFrame().properties.find(property => property.name === DXA_STRUCTURE_PROPERTY).analysisWorkerCount, 3);
});

test('global GPU preference changes reuse the same CPU DXA result without reading the obsolete callback', async t => {
  let globalGpuEnabled = true, reads = 0;
  const h = harness(t, { gpuPreference: () => { reads++; return globalGpuEnabled; } }), initial = h.tools.run();
  const accepted = structureNetwork();
  assert.equal('gpuEnabled' in h.pending[0].parameters, false);
  h.pending[0].resolve(accepted); await initial;
  globalGpuEnabled = false;
  assert.equal(await h.tools.run(), true);
  globalGpuEnabled = true;
  assert.equal(await h.tools.run(), true);
  assert.equal(h.pending.length, 1);
  assert.equal(h.renderer.network, accepted);
  assert.equal(reads, 0);
  const property = h.getFrame().properties.find(item => item.name === DXA_STRUCTURE_PROPERTY);
  assert.equal('analysisGpuRequested' in property, false);
  assert.equal(property.analysisWorkerCount, 1);
});

test('DXA reuses recent frame graphs under a separate bounded cache', async t => {
  const h = harness(t), firstFrame = h.getFrame(), first = h.tools.run();
  h.pending[0].resolve(network()); await first;
  h.setFrame({ ids: new Uint32Array([1, 2, 3, 4]), properties: [] });
  const second = h.tools.onFrame();
  h.pending[1].resolve(network(5)); await second;
  h.setFrame(firstFrame);
  const revisited = h.tools.onFrame();
  await revisited;
  assert.equal(h.pending.length, 2);
  assert.equal(h.renderer.network.totalLength, 4);
  assert.equal(h.tools.cacheStatus().size, 2);
});

test('DXA LRU limits and source changes reject obsolete cached graphs', async t => {
  const h = harness(t, { resultCacheLimit: 2 }), frames = [h.getFrame(),
    { ids: Uint32Array.of(1, 2, 3, 4), properties: [] }, { ids: Uint32Array.of(1, 2, 3, 4), properties: [] }];
  for (let index = 0; index < frames.length; index++) {
    h.setFrame(frames[index]); const task = index ? h.tools.onFrame() : h.tools.run();
    h.pending[index].resolve(network(index + 1)); await task;
  }
  assert.equal(h.tools.cacheStatus().size, 2);
  h.setFrame(frames[0]); const missed = h.tools.onFrame();
  assert.equal(h.pending.length, 4, 'oldest graph was evicted');
  h.pending[3].resolve(network(4)); await missed;
  h.setFrame(frames[0], 'replacement-source'); const replaced = h.tools.onFrame();
  assert.equal(h.pending.length, 5, 'source version invalidates even the same frame object');
  h.pending[4].resolve(network(5)); await replaced;
  assert.equal(h.tools.cacheStatus().size, 1);
});

test('DXA byte budget includes retained source geometry and evicts it after navigation', async t => {
  const frame = { ids: Uint32Array.of(1, 2, 3, 4), properties: [], positions: new Float64Array(3000) };
  const h = harness(t, { initialFrame: frame, resultCacheBytes: 1024 });
  const first = h.tools.run(); h.pending[0].resolve(network()); await first;
  assert.ok(h.tools.cacheStatus().bytes > 1024, 'only the currently displayed graph may exceed the budget');
  h.setFrame({ ids: Uint32Array.of(1, 2, 3, 4), properties: [] });
  const second = h.tools.onFrame(); h.pending[1].resolve(network(5)); await second;
  assert.equal(h.tools.cacheStatus().size, 1);
  h.setFrame(frame); const revisited = h.tools.onFrame();
  assert.equal(h.pending.length, 3, 'oversized departed frame was not retained');
  h.pending[2].resolve(network()); await revisited;
});

test('rapid automatic frame changes compute only the settled target; manual Calculate remains immediate', async t => {
  const h = harness(t, { automaticDelayMs: 40 }), first = h.tools.run();
  assert.equal(h.pending.length, 1, 'manual calculation starts immediately');
  h.pending[0].resolve(network()); await first;
  const obsoleteFrame = { ids: Uint32Array.of(1, 2, 3, 4), properties: [] };
  const targetFrame = { ids: Uint32Array.of(1, 2, 3, 4), properties: [] };
  h.setFrame(obsoleteFrame); const obsolete = h.tools.onFrame();
  assert.equal(h.pending.length, 1);
  assert.equal(h.fields['dxa-state'].textContent, 'Queued');
  h.setFrame(targetFrame); const target = h.tools.onFrame();
  await obsolete;
  assert.equal(h.pending.length, 1, 'superseded debounce never starts a native job');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(h.pending.length, 2);
  assert.equal(h.pending[1].inputFrame, targetFrame);
  h.pending[1].resolve(network(7)); await target;
  h.setFrame(obsoleteFrame); const waiting = h.tools.onFrame();
  const manual = h.tools.run();
  assert.equal(h.pending.length, 3, 'manual Calculate bypasses the pending navigation delay');
  h.pending[2].resolve(network(8)); await manual; await waiting;
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
  const priorChanges = h.resultChanges.length;
  const restored = h.tools.restore(saved);
  assert.equal(h.pending.length, 1);
  assert.equal(h.pending[0].parameters.lattice, 'bcc');
  assert.equal(h.pending[0].parameters.trialCircuitLength, 18);
  const accepted = structureNetwork([3, 3, 0, 3], network().segments); accepted.segments[0].familyId = 'half111'; accepted.counts = { half111: 1 };
  h.pending[0].resolve(accepted); await restored;
  assert.deepEqual(h.renderer.settings.visibleFamilies, ['half111']);
  assert.equal(h.renderer.settings.radius, .35);
  assert.equal(h.renderer.settings.familyColors.half111, '#778899');
  assert.equal(h.getFrame().properties.find(item => item.name === DXA_STRUCTURE_PROPERTY).data, accepted.atomStructureTypes);
  assert.equal(h.getColorMode(), 'type');
  assert.equal(h.resultChanges.slice(priorChanges).some(change => change.clearSettings), false);
  assert.deepEqual(h.tools.serialize(), saved);
  h.tools.reset();
  assert.equal(h.enabledTools.has('dxa'), false);
  assert.equal(h.renderer.network, null);
  assert.equal(h.getFrame().properties.some(item => item.analysisKind === 'dxa'), false);
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
