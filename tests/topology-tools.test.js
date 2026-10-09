import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeTopologyTools } from '../src/topology-tools.js';
import { distributionRows } from '../src/render/distribution-chart.js';

class Element {
  constructor(value = '') {
    this.value = String(value); this.textContent = ''; this.hidden = false;
    this.disabled = false; this.listeners = new Map(); this.attributes = new Map();
    this.classList = { toggle() {} };
    this.children = [];
  }
  get valueAsNumber() { return this.value.trim() === '' ? NaN : Number(this.value); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  dispatch(name) { this.listeners.get(name)?.({ target: this }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

function frame(count = 3) {
  return { ids: Uint32Array.from({ length: count }, (_, i) => i + 1), properties: [] };
}

function bondResult(count = 3, q = .5) {
  return { q4: new Float32Array(count).fill(.2), q6: new Float32Array(count).fill(q),
    coordination: new Uint32Array(count).fill(2), backend: 'cpu', engine: '2 CPU Workers', elapsedMs: 50,
    statistics: { length: { count: 3, mean: 1 }, angle: { count: 3, mean: 60 },
      q4: { count, mean: .2 }, q6: { count, mean: q } } };
}

function voronoiResult(count = 3) {
  return { atomicVolume: new Float64Array(count).fill(8), voronoiSurfaceArea: new Float64Array(count).fill(24),
    voronoiCoordination: new Uint32Array(count).fill(6), voronoiBoundaryFaces: new Uint8Array(count),
    voronoiMaxFaceOrder: new Uint32Array(count).fill(4), voronoiIndices: Array(count).fill('<0,6,0,0>'),
    summary: { atomCount: count, meanVolume: 8, meanCoordination: 6 }, backend: 'cpu',
    engine: '3 CPU Workers / Voro++ Wasm', fallbackReason: 'GPU Voronoi is unavailable.', elapsedMs: 100 };
}

function harness(t) {
  const previousDocument = globalThis.document;
  const fields = {};
  for (const prefix of ['bond-statistics', 'voronoi']) {
    for (const suffix of ['state', 'status', 'backend', 'progress', 'results', 'summary']) fields[`${prefix}-${suffix}`] = new Element();
    fields[`run-${prefix}`] = new Element(); fields[`cancel-${prefix}`] = new Element();
  }
  for (const [id, value] of Object.entries({ 'bond-statistics-length-bins': 100, 'bond-statistics-angle-bins': 180,
    'voronoi-face-area-threshold': 0, 'voronoi-relative-face-area-threshold': 0 })) fields[id] = new Element(value);
  for (const id of ['voronoi-type-options', 'voronoi-type-summary', 'voronoi-select-all-types', 'voronoi-clear-types',
    'voronoi-radical', 'voronoi-radius-source', 'voronoi-type-radii', 'voronoi-reset-radii', 'voronoi-radius-property',
    'voronoi-radius-property-field', 'voronoi-radical-summary', 'voronoi-radical-controls']) fields[id] = new Element();
  globalThis.document = { getElementById: id => fields[id] ?? null,
    createElement() { const element = new Element(); element.ownerDocument = this; return element; } };
  for (const element of Object.values(fields)) element.ownerDocument = globalThis.document;
  t.after(() => { globalThis.document = previousDocument; });
  let currentFrame = frame(), version = 'source-a', frameIndex = 0, bondCutoff = 3, graphEnabled = false, colorVersion = 0;
  const frames = new Set([currentFrame]), pending = [], changes = [], pendingSnapshots = [], selected = [], notifications = [], beforeClear = [], toolFlags = new Map();
  const pool = {
    gpuEnabled: false,
    analyze(inputFrame, settings, options) {
      return new Promise((resolve, reject) => pending.push({ frame: inputFrame, settings, options, resolve, reject }));
    },
  };
  const tools = initializeTopologyTools({ pool,
    tools: { setToolEnabled: (name, enabled) => toolFlags.set(name, enabled) },
    getFrame: () => currentFrame, getFrames: () => frames, getSourceVersion: () => version,
    getFrameIndex: () => frameIndex, getBondParameters: () => ({ cutoff: bondCutoff, pairCutoffs: [] }),
    getBondEnabled: () => graphEnabled, getColorChoiceVersion: () => colorVersion,
    chooseProperty: name => selected.push(name), onResultsChange: change => {
      changes.push(change); pendingSnapshots.push([...tools.pendingKinds()]);
    },
    onBeforeClear: (kind, options) => beforeClear.push({ kind, options,
      enabled: tools.isEnabled(kind),
      properties: currentFrame.properties.filter(property => property.analysisKind === kind) }),
    notify: message => notifications.push(message),
  });
  tools.setEnabled(true);
  return { tools, fields, pool, pending, changes, pendingSnapshots, selected, notifications, beforeClear, toolFlags, frames,
    getFrame: () => currentFrame,
    setFrame(next, index = frameIndex + 1) { currentFrame = next; frameIndex = index; frames.add(next); },
    setSourceVersion(next) { version = next; },
    setCutoff(next) { bondCutoff = next; },
    setGraphEnabled(next) { graphEnabled = next; },
    changeColor() { colorVersion++; },
  };
}

test('bond metrics own separate properties, cache and cancellation while graph results remain enabled', async t => {
  const h = harness(t), f = h.getFrame();
  const imported = { name: 'bondQ6', data: new Float32Array(3).fill(9) };
  const graph = { name: 'bondCoordination', analysisKind: 'bonds', data: new Uint32Array(3).fill(4) };
  f.properties.push(imported, graph); f.atomeyeResults = { bonds: { key: 'graph', result: { count: 6 } } };
  h.setGraphEnabled(true);
  const task = h.tools.run('bondStatistics');
  assert.equal(h.pending[0].settings.kind, 'bondStatistics');
  assert.equal(h.pending[0].settings.lengthBins, 100);
  assert.equal(h.fields['run-bond-statistics'].disabled, true);
  assert.deepEqual(h.tools.pendingKinds(), ['bondStatistics']);
  const result = bondResult(); h.pending[0].resolve(result);
  assert.equal(await task, true);
  assert.equal(h.tools.getResult('bondStatistics'), result);
  assert.equal(f.atomeyeResults.bondStatistics.result, result);
  assert.equal(f.properties.find(prop => prop.name === 'bondQ6').data, result.q6);
  assert.equal(f.properties.find(prop => prop.name === 'bondStatisticsCoordination').data, result.coordination);
  assert.deepEqual(h.selected, ['bondQ6']);
  assert.equal(h.fields['bond-statistics-results'].hidden, false);
  assert.deepEqual(h.tools.pendingKinds(), []);
  assert.equal(h.tools.isEnabled('bondStatistics'), true);
  h.tools.cancel('bondStatistics');
  assert.equal(h.beforeClear.at(-1).properties.some(property => property.name === 'bondQ6'), true);
  assert.equal(h.tools.getPropertyKind('bondQ6'), null);
  assert.equal(h.toolFlags.get('bonds'), true);
  assert.equal(f.properties.find(prop => prop.name === 'bondQ6'), imported);
  assert.equal(f.properties.includes(graph), true);
  assert.equal(f.atomeyeResults.bonds.result.count, 6);
  assert.equal(f.atomeyeResults.bondStatistics, undefined);
  assert.equal(h.fields['bond-statistics-results'].hidden, true);
});

test('a newer request wins even if the canceled worker replies later', async t => {
  const h = harness(t), first = h.tools.run('bondStatistics');
  h.fields['bond-statistics-length-bins'].value = '40';
  const second = h.tools.run('bondStatistics');
  assert.equal(h.pending[0].options.signal.aborted, true);
  const accepted = bondResult(3, .7);
  h.pending[1].resolve(accepted); assert.equal(await second, true);
  h.pending[0].resolve(bondResult(3, .1)); assert.equal(await first, false);
  assert.equal(h.tools.getResult('bondStatistics'), accepted);
  assert.equal(h.getFrame().atomeyeResults.bondStatistics.result, accepted);
  assert.equal(h.fields['bond-statistics-state'].textContent, 'Calculated');
});

test('frame changes and source changes discard in-flight results without coloring the new frame', async t => {
  const h = harness(t), previous = h.getFrame(), oldTask = h.tools.run('voronoi');
  const next = frame(2); h.setFrame(next);
  const onFrame = h.tools.onFrame();
  h.pending[0].resolve(voronoiResult(3)); assert.equal(await oldTask, false);
  assert.equal(previous.atomeyeResults?.voronoi, undefined);
  h.pending[1].resolve(voronoiResult(2)); await onFrame;
  assert.equal(next.properties.find(prop => prop.name === 'atomicVolume').data.length, 2);
  assert.deepEqual(h.selected, []);
  const sourceTask = h.tools.run('voronoi'); // Cached on this source.
  assert.equal(await sourceTask, true);
  h.setSourceVersion('source-b');
  const switched = h.tools.onFrame();
  assert.equal(h.pending.length, 3);
  h.setSourceVersion('source-c');
  h.pending[2].resolve(voronoiResult(2)); await switched;
  assert.equal(h.tools.getResult('voronoi'), null);
  assert.equal(next.atomeyeResults?.voronoi, undefined);
});

test('compatible frame caches are reused and changed cutoffs or GPU preference recompute', async t => {
  const h = harness(t), firstFrame = h.getFrame(), task = h.tools.run('bondStatistics');
  h.pending[0].resolve(bondResult()); await task;
  assert.equal(await h.tools.run('bondStatistics'), true);
  assert.equal(h.pending.length, 1);
  h.setFrame(frame()); const nextTask = h.tools.onFrame();
  h.pending[1].resolve(bondResult()); await nextTask;
  h.setFrame(firstFrame); await h.tools.onFrame();
  assert.equal(h.pending.length, 2);
  h.setCutoff(4); const parametersTask = h.tools.refreshBondParameters();
  assert.equal(h.pending[2].settings.cutoff, 4);
  h.pending[2].resolve(bondResult()); await parametersTask;
  h.pool.gpuEnabled = true; const gpuTask = h.tools.run('bondStatistics');
  assert.equal(h.pending.length, 4);
  h.pending[3].resolve({ ...bondResult(), backend: 'gpu', engine: 'WebGPU', gpuRequested: true }); await gpuTask;
  assert.equal(h.fields['bond-statistics-backend'].textContent, 'WebGPU');
});

test('concurrent analyses cancel independently and protect a user color change', async t => {
  const h = harness(t), bondTask = h.tools.run('bondStatistics'), voronoiTask = h.tools.run('voronoi');
  assert.equal(h.tools.getPropertyKind('atomicVolume'), 'voronoi');
  assert.equal(h.tools.getPropertyKind('bondQ6'), 'bondStatistics');
  assert.equal(h.tools.getPropertyKind('bondCoordination'), null);
  h.changeColor();
  h.pending[1].resolve(voronoiResult()); await voronoiTask;
  assert.deepEqual(h.selected, []);
  assert.match(h.fields['voronoi-backend'].textContent, /CPU fallback/);
  h.tools.cancel('bondStatistics');
  h.pending[0].resolve(bondResult()); assert.equal(await bondTask, false);
  assert.equal(h.tools.getResult('voronoi').atomicVolume.length, 3);
  assert.equal(h.toolFlags.get('voronoi'), true);
  assert.equal(h.getFrame().properties.some(prop => prop.analysisKind === 'voronoi'), true);
  assert.deepEqual(h.tools.pendingKinds(), []);
  assert.equal(h.tools.isEnabled('voronoi'), true);
});

test('GPU Voronoi publishes display precision bounds without changing scientific values or integer fields', async t => {
  const h = harness(t), pending = h.tools.run('voronoi');
  const result = { ...voronoiResult(), backend: 'gpu', engine: 'WebGPU', fallbackReason: null, gpuCorrectionAtoms: 1,
    autoRangeRelativeTolerance: { atomicVolume: 32 * 2 ** -23, voronoiSurfaceArea: 32 * 2 ** -23 } };
  result.atomicVolume[1] += 1e-6;
  h.pending[0].resolve(result); await pending;
  const property = h.getFrame().properties.find(value => value.name === 'atomicVolume');
  assert.equal(property.data, result.atomicVolume);
  assert.equal(property.data[1], 8.000001);
  assert.equal(property.autoRangeRelativeTolerance, 32 * 2 ** -23);
  assert.match(h.fields['voronoi-backend'].textContent, /WebGPU · 1 cell corrected on CPU/);
  assert.equal(Object.hasOwn(h.getFrame().properties.find(value => value.name === 'voronoiCoordination'), 'autoRangeRelativeTolerance'), false);
});

test('Voronoi type checkboxes follow labels across frames, invalidate old requests and clear empty selections', async t => {
  const h = harness(t), first = { ...frame(), types: Uint16Array.from([0, 1, 0]), typeLabels: ['Ni', 'Cu'] };
  h.setFrame(first); h.tools.setEnabled(true);
  const choices = () => h.fields['voronoi-type-options'].children.map(row => row.children[0]);
  const choice = label => choices().find(input => input.attributes.get('data-voronoi-type') === label);
  assert.ok(choices().every(input => input.checked));
  choice('Cu').checked = false; choice('Cu').dispatch('change');
  const oldRequest = h.tools.run('voronoi');
  assert.deepEqual(h.pending[0].settings.selectedTypes, ['Ni']);
  const next = { ...frame(), types: Uint16Array.from([1, 0, 1]), typeLabels: ['Cu', 'Ni'] };
  h.setFrame(next); const newRequest = h.tools.onFrame();
  assert.equal(h.pending[0].options.signal.aborted, true);
  assert.deepEqual(h.pending[1].settings.selectedTypes, ['Ni']);
  assert.equal(choice('Ni').checked, true); assert.equal(choice('Cu').checked, false);
  h.pending[0].resolve(voronoiResult()); assert.equal(await oldRequest, false);
  const subset = voronoiResult(); subset.atomicVolume = Float64Array.from([16, NaN, 16]);
  h.pending[1].resolve(subset); await newRequest;
  assert.equal(first.atomeyeResults?.voronoi, undefined);
  assert.equal(next.properties.find(property => property.name === 'atomicVolume').data, subset.atomicVolume);
  assert.deepEqual(h.tools.serialize().voronoi.selectedTypes, ['Ni']);
  h.fields['voronoi-select-all-types'].dispatch('click');
  assert.equal(h.pending[2].settings.selectedTypes, null);
  h.pending[2].resolve(voronoiResult()); await new Promise(resolve => setImmediate(resolve));
  assert.ok(choices().every(input => input.checked));
  h.fields['voronoi-clear-types'].dispatch('click');
  assert.equal(h.pending.length, 3, 'an empty selection never reaches CPU or GPU workers');
  assert.equal(h.tools.getResult('voronoi'), null);
  assert.equal(next.properties.some(property => property.analysisKind === 'voronoi'), false);
  assert.match(h.fields['voronoi-status'].textContent, /Select at least one element type/);
});

test('restore honors settings and its freshness guard while avoiding automatic color selection', async t => {
  const h = harness(t);
  let current = true;
  const restored = h.tools.restore({ bondStatistics: { enabled: true, lengthBins: 30, angleBins: 60 },
    voronoi: { enabled: true, faceAreaThreshold: .2, relativeFaceAreaThreshold: .03, bins: 20 } }, { isCurrent: () => current });
  assert.equal(h.pending[0].settings.lengthBins, 30);
  assert.equal(h.pending[1].settings.faceAreaThreshold, .2);
  assert.equal(h.pending[1].settings.bins, 20);
  current = false;
  h.pending[0].resolve(bondResult()); h.pending[1].resolve(voronoiResult()); await restored;
  assert.equal(h.getFrame().atomeyeResults?.voronoi, undefined);
  assert.equal(h.getFrame().atomeyeResults?.bondStatistics, undefined);
  assert.deepEqual(h.selected, []);
  assert.equal(h.tools.serialize().voronoi.bins, 20);
  h.tools.reset();
  assert.deepEqual(h.tools.serialize(), { bondStatistics: { enabled: false, lengthBins: 100, angleBins: 180 },
    voronoi: { enabled: false, faceAreaThreshold: 0, relativeFaceAreaThreshold: 0, bins: 50, selectedTypes: null } });
});

test('invalid input keeps valid saved parameters and failures cannot publish malformed atom arrays', async t => {
  const h = harness(t);
  h.fields['bond-statistics-length-bins'].value = '0';
  assert.equal(await h.tools.run('bondStatistics'), false);
  assert.equal(h.pending.length, 0);
  assert.equal(h.tools.serialize().bondStatistics.lengthBins, 100);
  h.fields['bond-statistics-length-bins'].value = '20';
  const task = h.tools.run('bondStatistics');
  h.pending[0].resolve(bondResult(2)); assert.equal(await task, false);
  assert.deepEqual(h.tools.failed(), ['bondStatistics']);
  assert.deepEqual(h.tools.pendingKinds(), []);
  assert.equal(h.tools.getPropertyKind('bondQ6'), null);
  assert.equal(h.getFrame().atomeyeResults?.bondStatistics, undefined);
  assert.equal(h.getFrame().properties.length, 0);
  const retry = h.tools.run('bondStatistics');
  h.pending[1].resolve(bondResult()); assert.equal(await retry, true);
  assert.deepEqual(h.tools.failed(), []);
  assert.equal(h.fields['run-bond-statistics'].disabled, false);
});

test('progress follows the current job and aborting suppresses stale updates', async t => {
  const h = harness(t), task = h.tools.run('bondStatistics');
  h.pending[0].options.onProgress({ backend: 'cpu', phase: 'analyzing', completedAtoms: 1, totalAtoms: 3, workerCount: 2 });
  assert.equal(h.fields['bond-statistics-progress'].hidden, false);
  assert.equal(h.fields['bond-statistics-progress'].value, 1 / 3);
  assert.match(h.fields['bond-statistics-backend'].textContent, /2 Workers/);
  h.tools.abortJobs();
  const status = h.fields['bond-statistics-status'].textContent;
  h.pending[0].options.onProgress({ backend: 'gpu', phase: 'analyzing', completedAtoms: 3, totalAtoms: 3 });
  assert.equal(h.fields['bond-statistics-status'].textContent, status);
  h.pending[0].resolve(bondResult()); assert.equal(await task, false);
  assert.equal(h.fields['bond-statistics-progress'].hidden, true);
});

test('pending kinds distinguish queued and active work from enabled completed or failed analyses', async t => {
  const h = harness(t), bond = h.tools.run('bondStatistics'), voronoi = h.tools.run('voronoi');
  assert.deepEqual(h.tools.pendingKinds(), ['bondStatistics', 'voronoi']);
  h.pending[0].resolve(bondResult()); h.pending[1].resolve(voronoiResult());
  await Promise.all([bond, voronoi]);
  assert.deepEqual(h.tools.pendingKinds(), []);
  assert.equal(h.tools.isEnabled('bondStatistics'), true);
  assert.equal(h.tools.isEnabled('voronoi'), true);
  h.setFrame(frame()); h.pendingSnapshots.length = 0;
  const followingFrame = h.tools.onFrame();
  // The first job's notification also sees the other job queued, before its
  // analyze call starts. This preserves saved color/vector choices.
  assert.deepEqual(h.pendingSnapshots[0], ['bondStatistics', 'voronoi']);
  h.pending[2].resolve(bondResult());
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(h.tools.pendingKinds(), ['voronoi']);
  h.pending[3].reject(new Error('Degenerate Voronoi sites.')); await followingFrame;
  assert.deepEqual(h.tools.pendingKinds(), []);
  assert.deepEqual(h.tools.failed(), ['voronoi']);
  assert.equal(h.tools.getPropertyKind('atomicVolume'), null);
});

test('pre-clear callbacks inspect owned properties before cancellation and preserve restore context', async t => {
  const h = harness(t), imported = { name: 'bondQ6', data: new Float32Array(3).fill(9) };
  h.getFrame().properties.push(imported);
  const task = h.tools.run('bondStatistics'); h.pending[0].resolve(bondResult()); await task;
  h.tools.cancel('bondStatistics', { silent: true });
  const canceled = h.beforeClear.at(-1);
  assert.equal(canceled.kind, 'bondStatistics');
  assert.equal(canceled.enabled, true);
  assert.equal(canceled.options.clearSettings, true);
  assert.equal(canceled.properties.find(property => property.name === 'bondQ6').analysisKind, 'bondStatistics');
  assert.equal(h.getFrame().properties.find(property => property.name === 'bondQ6'), imported);
  h.beforeClear.length = 0;
  await h.tools.restore({ bondStatistics: { enabled: false, lengthBins: 20, angleBins: 90 },
    voronoi: { enabled: false, faceAreaThreshold: 0, relativeFaceAreaThreshold: 0 } });
  assert.deepEqual(h.beforeClear.map(entry => [entry.kind, entry.options.clearSettings]), [
    ['bondStatistics', false], ['voronoi', false],
  ]);
  h.beforeClear.length = 0; h.tools.reset();
  assert.deepEqual(h.beforeClear.map(entry => [entry.kind, entry.options.clearSettings]), [
    ['bondStatistics', true], ['voronoi', true],
  ]);
});

test('histogram adapters retain physical edges, empty bins and normalized populations', () => {
  assert.deepEqual(distributionRows({ edges: new Float64Array([0, 1, 2]), centers: new Float64Array([.5, 1.5]),
    counts: new Uint32Array([2, 0]), total: 2 }), [
    { lower: 0, upper: 1, center: .5, count: 2, probability: 1, density: 1 },
    { lower: 1, upper: 2, center: 1.5, count: 0, probability: 0, density: 0 },
  ]);
  assert.deepEqual(distributionRows([{ lower: 8, upper: 8, count: 3, fraction: 1 }]), [
    { lower: 8, upper: 8, center: 8, count: 3, probability: 1, density: null },
  ]);
  assert.deepEqual(distributionRows([{ value: 6, count: 1 }, { value: 12, count: 3 }]).map(row => row.probability), [.25, .75]);
});

test('radical Voronoi sends validated per-atom radii under a distinct cache key and round-trips its settings', async t => {
  const h = harness(t), structure = { ...frame(), fractional: new Float64Array(9), types: Uint16Array.from([0, 1, 0]), typeLabels: ['Ni', 'Al'],
    properties: [{ name: 'radius', data: Float64Array.of(1.1, 1.4, 1.2) },
      { name: 'atomicVolume', analysisKind: 'voronoi', data: new Float64Array(3) }, { name: 'phase', categories: ['a'], data: new Uint8Array(3) }] };
  h.setFrame(structure); h.tools.setEnabled(true);
  const standard = h.tools.run('voronoi');
  assert.equal('radii' in h.pending[0].settings, false); assert.equal('radical' in h.pending[0].settings, false);
  h.pending[0].resolve(voronoiResult()); await standard;
  assert.equal(h.fields['voronoi-radical-summary'].textContent, 'Standard Voronoi');
  const radiusInput = label => h.fields['voronoi-type-radii'].children.map(row => row.children[1].children[0])
    .find(input => input.attributes.get('data-voronoi-radius-type') === label);
  assert.equal(radiusInput('Al').value, '1.43', 'type radii start from the atomic radii'); assert.equal(radiusInput('Al').disabled, true);
  h.fields['voronoi-radical'].checked = true; h.fields['voronoi-radical'].dispatch('change');
  assert.equal(h.pending.length, 2, 'switching to radical cells recomputes');
  assert.deepEqual(h.pending[1].settings.radii, Float64Array.of(1.24, 1.43, 1.24));
  assert.equal(radiusInput('Al').disabled, false);
  const radical = voronoiResult(); radical.summary = { ...radical.summary, tessellation: 'radical', emptyCellCount: 1 };
  h.pending[1].resolve(radical); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.tools.getResult('voronoi').radicalRadii, h.pending[1].settings.radii, 'cell displays reuse the analyzed radii');
  assert.match(h.fields['voronoi-summary'].textContent, /radical \(radius-weighted\) · 1 empty cell$/);
  radiusInput('Al').value = '1.5'; radiusInput('Al').dispatch('change');
  assert.deepEqual(h.pending[2].settings.radii, Float64Array.of(1.24, 1.5, 1.24));
  h.pending[2].resolve(voronoiResult()); await new Promise(resolve => setImmediate(resolve));
  for (const value of ['-1', '', 'x']) { radiusInput('Ni').value = value; radiusInput('Ni').dispatch('change'); }
  assert.equal(h.pending.length, 3, 'invalid radii never reach the workers');
  assert.equal(h.notifications.length, 3); assert.equal(radiusInput('Ni').value, '1.24', 'the table restores the valid radius');
  h.fields['voronoi-radius-source'].value = 'property'; h.fields['voronoi-radius-source'].dispatch('change');
  assert.deepEqual(h.fields['voronoi-radius-property'].children.map(option => option.value), ['radius'], 'only source numeric properties');
  assert.deepEqual(h.pending[3].settings.radii, Float64Array.of(1.1, 1.4, 1.2));
  assert.equal(h.fields['voronoi-radical-summary'].textContent, 'Radical · radius');
  h.pending[3].resolve(voronoiResult()); await new Promise(resolve => setImmediate(resolve));
  const saved = h.tools.serialize().voronoi;
  assert.deepEqual({ radical: saved.radical, radiusSource: saved.radiusSource, typeRadii: saved.typeRadii, radiusProperty: saved.radiusProperty },
    { radical: true, radiusSource: 'property', typeRadii: [{ label: 'Al', radius: 1.5 }], radiusProperty: 'radius' });
  structure.properties[0].data[1] = -2;
  assert.equal(await h.tools.run('voronoi'), false);
  assert.match(h.fields['voronoi-status'].textContent, /Radius property radius of atom 2 must be finite and at least 0/);
  structure.properties[0].data[1] = 1.4;
  h.tools.reset();
  assert.equal(h.tools.serialize().voronoi.radical, undefined, 'standard recipes keep their previous shape');
  const restored = h.tools.restore({ voronoi: { enabled: true, faceAreaThreshold: 0, relativeFaceAreaThreshold: 0, bins: 50, selectedTypes: null, ...saved,
    radiusSource: 'types' } });
  assert.deepEqual(h.pending.at(-1).settings.radii, Float64Array.of(1.24, 1.5, 1.24));
  assert.equal(h.fields['voronoi-radical'].checked, true);
  h.pending.at(-1).resolve(voronoiResult()); await restored;
  h.fields['voronoi-radical'].checked = false; h.fields['voronoi-radical'].dispatch('change');
  assert.equal('radii' in h.pending.at(-1).settings, false);
});
