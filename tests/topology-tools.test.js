import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeTopologyTools } from '../src/topology-tools.js';
import { distributionRows } from '../src/render/distribution-chart.js';
import { createAnalysisDependencies } from '../src/analysis-dependencies.js';
import { initializeExpressionControls } from '../src/expression-controls.js';
import { estimateFrameBytes } from '../src/data/cache-policy.js';
import { clearAnalysisResults, replaceAnalysisProperty } from '../src/analysis/results.js';

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

function harness(t, { getPropertyDependency = () => null, onPropertiesChange = () => {} } = {}) {
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
    'voronoi-radius-property-field', 'voronoi-radical-summary', 'voronoi-radical-controls',
    'voronoi-gpu-kernel', 'voronoi-gpu-kernel-summary']) fields[id] = new Element();
  globalThis.document = { getElementById: id => fields[id] ?? null,
    createElement() { const element = new Element(); element.ownerDocument = this; return element; } };
  for (const element of Object.values(fields)) element.ownerDocument = globalThis.document;
  t.after(() => { globalThis.document = previousDocument; });
  let currentFrame = frame(), version = 'source-a', frameIndex = 0, bondCutoff = 3, graphEnabled = false, colorVersion = 0;
  const frames = new Set([currentFrame]), pending = [], changes = [], pendingSnapshots = [], selected = [], notifications = [], beforeClear = [], toolFlags = new Map();
  const preparation = [];
  const pool = {
    gpuEnabled: false, gpuVoronoi: false,
    setGpuVoronoi(enabled) { this.gpuVoronoi = enabled; },
    analyze(inputFrame, settings, options) {
      return new Promise((resolve, reject) => pending.push({ frame: inputFrame, settings, options, resolve, reject }));
    },
  };
  const tools = initializeTopologyTools({ pool,
    tools: { setToolEnabled: (name, enabled) => toolFlags.set(name, enabled) },
    getFrame: () => currentFrame, getFrames: () => frames, getSourceVersion: () => version,
    getFrameIndex: () => frameIndex, getBondParameters: () => ({ cutoff: bondCutoff, pairCutoffs: [] }),
    getPropertyDependency,
    getBondEnabled: () => graphEnabled, getColorChoiceVersion: () => colorVersion,
    chooseProperty: name => selected.push(name), onResultsChange: change => {
      changes.push(change); pendingSnapshots.push([...tools.pendingKinds()]);
      onPropertiesChange(change);
    },
    onBeforeClear: (kind, options) => beforeClear.push({ kind, options,
      enabled: tools.isEnabled(kind),
      properties: currentFrame.properties.filter(property => property.analysisKind === kind) }),
    notify: message => notifications.push(message),
    onGpuPreparationChange: kinds => preparation.push(kinds),
  });
  tools.setEnabled(true);
  return { tools, fields, pool, preparation, pending, changes, pendingSnapshots, selected, notifications, beforeClear, toolFlags, frames,
    getFrame: () => currentFrame,
    setFrame(next, index = frameIndex + 1) { currentFrame = next; frameIndex = index; frames.add(next); },
    setSourceVersion(next) { version = next; },
    setCutoff(next) { bondCutoff = next; },
    setGraphEnabled(next) { graphEnabled = next; },
    changeColor() { colorVersion++; },
  };
}

function radicalDependencyHarness(t) {
  let dependencies, expressions, h;
  const producers = new Map();
  h = harness(t, {
    getPropertyDependency: (name, current) => dependencies?.getPropertyDependency(name, current,
      { waitForProducers: true, consumerKind: 'voronoi' }),
    onPropertiesChange: () => {
      expressions?.sync(h.getFrame());
      if (h) void h.tools.refreshProperties();
    },
  });
  expressions = initializeExpressionControls({ getFrame: h.getFrame, documentRoot: null });
  dependencies = createAnalysisDependencies({ getFrame: h.getFrame,
    getExpressionStatus: name => expressions.getPropertyStatus(name),
    getExpressionReferences: name => expressions.getPropertyReferences(name),
    getProducer: name => {
      if (h.tools.pendingKinds().includes('voronoi') && ['atomicVolume', 'voronoiCoordination', 'voronoiSurfaceArea'].includes(name)) {
        return { name: 'Voronoi', kind: 'voronoi', state: 'pending' };
      }
      return producers.get(name);
    },
  });
  const nextFrame = (properties = []) => ({ ...frame(), properties,
    types: Uint8Array.of(0, 0, 0), typeLabels: ['Ni'], positions: new Float64Array(9),
    fractional: new Float64Array(9), cell: { vectors: Float64Array.of(3, 0, 0, 0, 3, 0, 0, 0, 3) } });
  const refresh = () => { expressions.sync(h.getFrame()); return h.tools.refreshProperties(); };
  const configure = (name = 'radii', extras = {}) => h.tools.restore({ voronoi:
    { enabled: true, radical: true, radiusSource: 'property', radiusProperty: name, ...extras } });
  return { ...h, expressions, producers, nextFrame, refresh, configure };
}

test('radical radii wait only for transitive current-frame inputs, keep the selected option, then route complete radii to CPU or GPU', async t => {
  for (const gpu of [false, true]) await t.test(gpu ? 'GPU' : 'CPU', async t => {
    const h = radicalDependencyHarness(t);
    h.pool.gpuEnabled = gpu;
    h.setFrame(h.nextFrame());
    h.expressions.setState({ properties: [
      { name: 'base', unit: '', expression: 'CSP + 1' },
      { name: 'radii', unit: 'Å', expression: 'base / 2' },
    ] });
    h.producers.set('centralSymmetry', { name: 'Central symmetry', state: 'pending' });
    h.producers.set('ptmStructureType', { name: 'PTM', state: 'pending' });
    h.expressions.sync(h.getFrame());
    const request = h.configure('radii', { gpuKernel: gpu });
    assert.equal(h.pending.length, 0, 'no CPU/GPU job is allocated before the radius inputs exist');
    assert.equal(h.fields['voronoi-state'].textContent, 'Waiting');
    assert.match(h.fields['voronoi-status'].textContent, /Waiting for Central symmetry/);
    assert.doesNotMatch(h.fields['voronoi-status'].textContent, /PTM/);
    assert.deepEqual(h.tools.failed(), []);
    assert.deepEqual(h.tools.pendingKinds(), ['voronoi']);
    assert.equal(h.fields['voronoi-radius-property'].value, 'radii');
    assert.match(h.fields['voronoi-radius-property'].children.at(-1).textContent, /radii \(waiting for data/);
    assert.equal(h.fields['voronoi-radius-property'].disabled, false);
    const independent = h.tools.run('bondStatistics');
    assert.equal(h.pending[0].settings.kind, 'bondStatistics', 'an unrelated calculation can run while Voronoi is waiting');
    h.pending[0].resolve(bondResult()); await independent;
    assert.equal(h.pending.length, 1, 'unrelated completion does not dispatch the dependent request');
    h.producers.delete('centralSymmetry');
    h.getFrame().properties.push({ name: 'centralSymmetry', data: Float64Array.of(1, 2, 3), analysisKind: 'centrosymmetry', analysisKey: 'CSP' });
    await h.refresh(); await Promise.resolve();
    assert.equal(h.pending.length, 2);
    assert.deepEqual(h.pending[1].settings.radii, Float64Array.of(1, 1.5, 2));
    assert.equal('radiusProperty' in h.pending[1].settings, false);
    assert.equal('gpuKernel' in h.pending[1].settings, false);
    const result = { ...voronoiResult(), ...(gpu ? { backend: 'gpu', engine: 'webgpu-voronoi' } : {}) };
    h.pending[1].resolve(result); await request;
    assert.equal(h.tools.getResult('voronoi').radicalRadii, h.pending[1].settings.radii);
    assert.equal(h.fields['voronoi-state'].textContent, 'Calculated');
    assert.deepEqual(h.tools.failed(), []);
    assert.deepEqual(h.notifications, []);

    // Changing frames repeats the dependency gate even if the old frame had a
    // valid radius column, rather than reporting it as an invalid property.
    h.setFrame(h.nextFrame());
    h.producers.set('centralSymmetry', { name: 'Central symmetry', state: 'pending' });
    h.expressions.sync(h.getFrame());
    const navigation = h.tools.onFrame();
    assert.equal(h.pending.length, 3, 'enabled independent bonds run; Voronoi keeps waiting');
    assert.equal(h.pending[2].settings.kind, 'bondStatistics');
    h.pending[2].resolve(bondResult());
    assert.equal(h.fields['voronoi-state'].textContent, 'Waiting');
    h.changeColor();
    h.getFrame().properties.push({ name: 'centralSymmetry', data: Float64Array.of(3, 5, 7), analysisKind: 'centrosymmetry', analysisKey: 'CSP' });
    h.producers.delete('centralSymmetry'); await h.refresh(); await Promise.resolve();
    assert.deepEqual(h.pending[3].settings.radii, Float64Array.of(2, 3, 4));
    h.pending[3].resolve(voronoiResult()); await navigation;
    assert.equal(h.fields['voronoi-state'].textContent, 'Calculated');
    assert.deepEqual(h.selected, ['bondQ6'], 'automatic dependency replay does not change the chosen color');
  });
});

test('waiting radical radius requests cancel, change frames, reset sources and reject stale results without polling', async t => {
  const h = radicalDependencyHarness(t);
  h.setFrame(h.nextFrame());
  h.expressions.setState({ properties: [{ name: 'radii', expression: 'CSP + 1', unit: 'Å' }] });
  h.producers.set('centralSymmetry', { name: 'Central symmetry', state: 'pending' });
  h.expressions.sync(h.getFrame());
  const canceled = h.configure(); h.tools.cancel('voronoi');
  await canceled;
  assert.equal(h.pending.length, 0); assert.deepEqual(h.tools.pendingKinds(), []);
  h.getFrame().properties.push({ name: 'centralSymmetry', data: Float64Array.of(0, 1, 2) });
  h.producers.clear(); await h.refresh();
  assert.equal(h.pending.length, 0, 'late inputs cannot reenable canceled Voronoi');

  h.setFrame(h.nextFrame()); h.producers.set('centralSymmetry', { name: 'Central symmetry', state: 'pending' });
  h.expressions.sync(h.getFrame());
  const previous = h.configure();
  h.setFrame(h.nextFrame([{ name: 'centralSymmetry', data: Float64Array.of(2, 4, 6) }]));
  h.producers.clear(); h.expressions.sync(h.getFrame());
  const next = h.tools.onFrame(); await previous;
  assert.equal(h.pending.length, 1); assert.equal(h.pending[0].frame, h.getFrame());
  h.pending[0].resolve(voronoiResult()); await next;
  h.setFrame(h.nextFrame()); h.producers.set('centralSymmetry', { name: 'Central symmetry', state: 'pending' });
  h.expressions.sync(h.getFrame());
  const source = h.tools.onFrame(); h.setSourceVersion('source-b'); h.tools.reset(); await source;
  assert.equal(h.pending.length, 1); assert.equal(h.tools.isEnabled('voronoi'), false);
  assert.equal(h.tools.getResult('voronoi'), null);
});

test('failed and unknown radius dependencies are terminal, while later valid values retry an enabled analysis', async t => {
  const h = radicalDependencyHarness(t);
  h.setFrame(h.nextFrame());
  h.expressions.setState({ properties: [{ name: 'radii', expression: 'CSP + 1', unit: 'Å' }] });
  h.producers.set('centralSymmetry', { name: 'Central symmetry', state: 'pending' });
  h.expressions.sync(h.getFrame());
  const waiting = h.configure();
  h.producers.set('centralSymmetry', { state: 'unavailable', message: 'The central symmetry calculation failed.' });
  await h.refresh(); await waiting;
  assert.equal(h.fields['voronoi-state'].textContent, 'Failed');
  assert.match(h.fields['voronoi-status'].textContent, /central symmetry calculation failed/);
  assert.equal(h.pending.length, 0); assert.deepEqual(h.tools.pendingKinds(), []);
  assert.deepEqual(h.tools.failed(), ['voronoi']);
  h.producers.clear();
  h.getFrame().properties.push({ name: 'centralSymmetry', data: Float64Array.of(0, 0, 0) });
  const retry = h.refresh(); assert.equal(h.pending.length, 1);
  h.pending[0].resolve(voronoiResult()); await retry;
  assert.deepEqual(h.tools.failed(), []);
  h.expressions.setState({ properties: [{ name: 'radii', expression: 'missingRadiusInput + 1', unit: 'Å' }] });
  await h.refresh();
  assert.match(h.fields['voronoi-status'].textContent, /missingRadiusInput/);
  assert.equal(h.fields['voronoi-state'].textContent, 'Failed');
  assert.equal(h.pending.length, 1);
  for (const value of ['-1', '0/0', '1/0']) {
    h.expressions.setState({ properties: [{ name: 'radii', expression: String(value), unit: 'Å' }] });
    await h.refresh();
    assert.match(h.fields['voronoi-status'].textContent, /atom 1 must be finite and at least 0/);
    assert.equal(h.pending.length, 1);
  }
});

test('editing radii during an active analysis cancels its request and caches the updated expression values', async t => {
  const h = radicalDependencyHarness(t);
  h.setFrame(h.nextFrame());
  h.expressions.setState({ properties: [{ name: 'radii', expression: '1', unit: 'Å' }] });
  h.expressions.sync(h.getFrame());
  const first = h.configure();
  assert.deepEqual(h.pending[0].settings.radii, Float64Array.of(1, 1, 1));
  h.expressions.setState({ properties: [{ name: 'radii', expression: '2', unit: 'Å' }] });
  const edited = h.refresh();
  assert.equal(h.pending[0].options.signal.aborted, true);
  assert.deepEqual(h.pending[1].settings.radii, Float64Array.of(2, 2, 2));
  h.pending[1].resolve(voronoiResult()); await edited;
  h.pending[0].resolve(voronoiResult()); await first;
  assert.deepEqual(h.tools.getResult('voronoi').radicalRadii, Float64Array.of(2, 2, 2));
  assert.equal(await h.refresh(), false); assert.equal(h.pending.length, 2, 'unchanged display refreshes do not recalculate');
});

test('an existing radical result stays private during a radius dependency wait and is reused for identical completed radii', async t => {
  const h = radicalDependencyHarness(t);
  h.setFrame(h.nextFrame([{ name: 'centralSymmetry', data: Float64Array.of(0, 0, 0) }]));
  h.expressions.setState({ properties: [{ name: 'radii', expression: '1 + CSP', unit: 'Å' }] });
  h.expressions.sync(h.getFrame());
  const initial = h.configure(); const result = { ...voronoiResult(), faces: new Float64Array(10_000) };
  h.pending[0].resolve(result); await initial;
  h.producers.set('centralSymmetry', { name: 'Central symmetry', state: 'pending' });
  const rerun = h.refresh();
  assert.equal(h.fields['voronoi-state'].textContent, 'Waiting');
  assert.equal(h.tools.getResult('voronoi'), null);
  assert.equal(h.getFrame().atomeyeResults.voronoi, undefined);
  const frame = h.getFrame(), retained = frame.voronoiInputCache;
  assert.equal(retained.cached.result, result);
  const accounted = estimateFrameBytes(frame);
  delete frame.voronoiInputCache;
  assert.ok(accounted - estimateFrameBytes(frame) >= result.faces.byteLength, 'every private retained face buffer remains counted in the frame budget');
  frame.voronoiInputCache = retained;
  assert.equal(h.pending.length, 1);
  h.producers.clear();
  h.getFrame().properties.find(property => property.name === 'centralSymmetry').data = Float64Array.of(0, 0, 0);
  await h.refresh(); await rerun;
  assert.equal(h.pending.length, 1, 'completed identical radii reuse the cached scientific tessellation');
  assert.equal(h.tools.getResult('voronoi'), result);
  assert.equal(h.getFrame().atomeyeResults.voronoi.result, result);
  assert.equal(frame.voronoiInputCache, undefined);
  assert.equal(h.fields['voronoi-state'].textContent, 'Calculated');
  h.producers.set('centralSymmetry', { name: 'Central symmetry', state: 'pending' });
  const canceled = h.refresh(); assert.ok(frame.voronoiInputCache);
  h.tools.cancel('voronoi'); await canceled;
  assert.equal(frame.voronoiInputCache, undefined, 'cancel releases the private cache before publishing cleared state');
});

test('failed same-frame radius producers cannot supply stale owned arrays, but cleared imports under the same name stay usable', async t => {
  const h = radicalDependencyHarness(t), imported = { name: 'centralSymmetry', data: Float64Array.of(1, 2, 3) };
  h.setFrame(h.nextFrame([imported]));
  replaceAnalysisProperty(h.getFrame(), { name: 'centralSymmetry', data: Float64Array.of(0, 0, 0), analysisKind: 'centrosymmetry' });
  h.expressions.setState({ properties: [{ name: 'radii', expression: '1 + CSP', unit: 'Å' }] });
  h.expressions.sync(h.getFrame());
  const initial = h.configure(); h.pending[0].resolve(voronoiResult()); await initial;
  h.producers.set('centralSymmetry', { name: 'Central symmetry', state: 'pending' });
  const waiting = h.refresh();
  assert.equal(h.fields['voronoi-state'].textContent, 'Waiting');
  assert.ok(h.getFrame().voronoiInputCache);
  h.producers.set('centralSymmetry', { state: 'unavailable', failed: true, message: 'The central symmetry calculation failed.' });
  await h.refresh(); await waiting;
  assert.match(h.fields['voronoi-status'].textContent, /calculation failed/);
  assert.equal(h.fields['voronoi-state'].textContent, 'Failed');
  assert.equal(h.getFrame().voronoiInputCache, undefined, 'failure frees retained output buffers');
  assert.equal(h.pending.length, 1, 'stale owned values cannot restart Voronoi');
  clearAnalysisResults(h.getFrame(), 'centrosymmetry');
  assert.equal(h.getFrame().properties.find(property => property.name === 'centralSymmetry'), imported);
  const restored = h.refresh();
  assert.deepEqual(h.pending[1].settings.radii, Float64Array.of(2, 3, 4), 'the restored source column remains a valid input despite the failed producer');
  h.pending[1].resolve(voronoiResult()); await restored;
  assert.equal(h.fields['voronoi-state'].textContent, 'Calculated');
});

test('radical radius expressions cannot wait for their own Voronoi output, and restored imported columns remain valid', async t => {
  const h = radicalDependencyHarness(t);
  h.setFrame(h.nextFrame());
  h.expressions.setState({ properties: [{ name: 'radii', expression: 'atomicVolume / 10', unit: 'Å' }] });
  h.expressions.sync(h.getFrame());
  await h.configure();
  assert.equal(h.pending.length, 0);
  assert.match(h.fields['voronoi-status'].textContent, /cyclic dependency.*voronoi/);
  assert.deepEqual(h.tools.pendingKinds(), []);
  const imported = { name: 'atomicVolume', data: Float64Array.of(10, 12, 14) };
  h.getFrame().properties.push(imported); h.expressions.sync(h.getFrame());
  const standard = h.tools.restore({ voronoi: { enabled: true } });
  h.pending[0].resolve(voronoiResult()); await standard;
  assert.equal(h.getFrame().analysisOriginalProperties.get('atomicVolume'), imported);
  const radical = h.configure();
  assert.deepEqual(h.pending[1].settings.radii, Float64Array.of(1, 1.2, 1.4));
  h.pending[1].resolve(voronoiResult()); await radical;
  assert.equal(h.pending.length, 2, 'publishing a result does not recursively consume its own new output');
  assert.equal(await h.refresh(), false);
  assert.equal(await h.tools.run('voronoi'), true, 'a repeat restores imported input then reuses matching radii');
  assert.equal(h.pending.length, 2);
});

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

test('a pinned bond-statistics backend invalidates only incompatible cached results and retains normal cache reuse', async t => {
  const h = harness(t); h.pool.gpuEnabled = true;
  let pinned = null; const inspected = [];
  h.pool.canReuseRoutingResult = (frame, input, result) => {
    inspected.push({ frame, input, result });
    return !pinned || result?.backend === pinned || Boolean(result?.fallbackReason);
  };
  const gpu = h.tools.run('bondStatistics');
  h.pending[0].resolve({ ...bondResult(), backend: 'gpu', gpuRequested: true }); await gpu;
  assert.equal(await h.tools.run('bondStatistics'), true); assert.equal(h.pending.length, 1);
  pinned = 'cpu'; const cpu = h.tools.run('bondStatistics', { automatic: true });
  assert.equal(h.pending.length, 2, 'the prior GPU result cannot bypass the CPU batch route');
  assert.equal(inspected.at(-1).input.kind, 'bondStatistics'); assert.equal(inspected.at(-1).input.cutoff, 3);
  h.pending[1].resolve({ ...bondResult(), gpuRequested: true }); await cpu;
  assert.equal(await h.tools.run('bondStatistics', { automatic: true }), true);
  assert.equal(h.pending.length, 2, 'the matching CPU result is retained');
  pinned = null; assert.equal(await h.tools.run('bondStatistics'), true); assert.equal(h.pending.length, 2);
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

test('invalid bond-statistics reruns clear stale scientific results and notify after terminal state', async t => {
  const h = harness(t), f = h.getFrame(), graph = { name: 'bondCoordination', analysisKind: 'bonds', data: new Uint32Array(3).fill(2) };
  f.properties.push(graph);
  const completed = h.tools.run('bondStatistics'); h.pending[0].resolve(bondResult()); await completed;
  assert.ok(f.atomeyeResults.bondStatistics);
  const changes = h.changes.length;
  h.fields['bond-statistics-length-bins'].value = '0';
  assert.equal(await h.tools.run('bondStatistics', { automatic: true }), false);
  assert.equal(h.fields['bond-statistics-state'].textContent, 'Failed');
  assert.equal(h.tools.getResult('bondStatistics'), null);
  assert.equal(f.atomeyeResults.bondStatistics, undefined);
  assert.deepEqual(f.properties, [graph]);
  assert.deepEqual(h.tools.pendingKinds(), []);
  assert.equal(h.changes.length, changes + 1, 'automatic validation failures also notify consumers without a toast');
  assert.deepEqual(h.changes.at(-1), { kind: 'bondStatistics', frame: f, clearSettings: false });
  assert.equal(h.notifications.length, 0);
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

test('the WebGPU Voronoi kernel is an explicit request: off by default, usable only with GPU acceleration, keyed, saved and reset', async t => {
  const h = harness(t), option = h.fields['voronoi-gpu-kernel'], summary = h.fields['voronoi-gpu-kernel-summary'];
  const structure = { ...frame(), fractional: new Float64Array(9), types: Uint16Array.from([0, 1, 0]), typeLabels: ['Ni', 'Al'], properties: [] };
  h.setFrame(structure); h.tools.setEnabled(true);
  assert.equal(option.checked, false); assert.equal(option.disabled, true, 'the option needs GPU acceleration');
  assert.equal(summary.textContent, 'CPU Workers'); assert.deepEqual(h.tools.gpuPreparationKinds(), []);
  assert.equal(h.tools.serialize().voronoi.gpuKernel, undefined, 'recipes without the request keep their previous shape');
  h.pool.gpuEnabled = true; h.tools.syncGpuAcceleration();
  assert.equal(option.disabled, false); assert.equal(h.pool.gpuVoronoi, false);
  const routed = h.tools.run('voronoi');
  assert.equal('gpuKernel' in h.pending[0].settings, false, 'the request is not an analysis parameter');
  h.pending[0].resolve({ ...voronoiResult(), engine: 'voro++-wasm-worker-pool×6', workerCount: 6, gpuRequested: true, fallbackReason: undefined,
    routeReason: 'Voronoi runs on CPU Workers.' }); await routed;
  assert.equal(h.fields['voronoi-backend'].textContent, 'CPU · 6 Workers', 'the CPU is named without calling it a fallback');
  assert.equal(h.fields['voronoi-status'].title, 'voro++-wasm-worker-pool×6 · Voronoi runs on CPU Workers.');
  assert.equal(await h.tools.run('voronoi'), true); assert.equal(h.pending.length, 1, 'the routed result is cached');

  option.checked = true; option.dispatch('change');
  assert.equal(h.pool.gpuVoronoi, true); assert.deepEqual(h.preparation.at(-1), ['voronoi']);
  assert.equal(summary.textContent, 'WebGPU kernel');
  assert.equal(h.pending.length, 2, 'the calculated analysis is repeated with the requested kernel');
  assert.equal('gpuKernel' in h.pending[1].settings, false);
  h.pending[1].resolve({ ...voronoiResult(), backend: 'gpu', engine: 'webgpu-voronoi', fallbackReason: undefined, gpuRequested: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.fields['voronoi-backend'].textContent, 'WebGPU');
  assert.equal(h.tools.serialize().voronoi.gpuKernel, true);
  h.fields['voronoi-radical'].checked = true; h.fields['voronoi-radical'].dispatch('change');
  assert.deepEqual(h.preparation.at(-1), ['voronoi', 'voronoiRadical'], 'radical radii add the radical clip kernel');
  assert.deepEqual(h.tools.gpuPreparationKinds(), ['voronoi', 'voronoiRadical']);
  h.pending[2].resolve({ ...voronoiResult(), backend: 'gpu', engine: 'webgpu-voronoi', fallbackReason: undefined }); await new Promise(resolve => setImmediate(resolve));
  h.fields['voronoi-radical'].checked = false; h.fields['voronoi-radical'].dispatch('change');
  assert.deepEqual(h.preparation.at(-1), ['voronoi']);
  h.pending[3].resolve({ ...voronoiResult(), backend: 'gpu', engine: 'webgpu-voronoi', fallbackReason: undefined }); await new Promise(resolve => setImmediate(resolve));

  // Without GPU acceleration the request is kept but cannot run or change.
  h.pool.gpuEnabled = false; h.tools.syncGpuAcceleration();
  assert.equal(option.checked, true); assert.equal(option.disabled, true);
  assert.equal(summary.textContent, 'CPU Workers · GPU acceleration is off');
  const cpu = h.tools.run('voronoi');
  assert.equal(h.pending.length, 5, 'a CPU run does not reuse the GPU kernel result');
  h.pending[4].resolve({ ...voronoiResult(), fallbackReason: undefined }); await cpu;

  const saved = h.tools.serialize().voronoi;
  h.tools.reset();
  assert.equal(option.checked, false); assert.equal(h.pool.gpuVoronoi, false); assert.deepEqual(h.preparation.at(-1), []);
  assert.equal(h.tools.serialize().voronoi.gpuKernel, undefined);
  h.pool.gpuEnabled = true;
  const restored = h.tools.restore({ voronoi: saved });
  assert.equal(option.checked, true); assert.equal(option.disabled, false);
  assert.equal(h.pool.gpuVoronoi, true, 'the pool is told before the restored analysis starts');
  assert.deepEqual(h.preparation.at(-1), ['voronoi']);
  h.pending.at(-1).resolve({ ...voronoiResult(), backend: 'gpu', engine: 'webgpu-voronoi', fallbackReason: undefined }); await restored;
  // An older recipe has no key and restores with CPU Workers.
  const older = { ...saved }; delete older.gpuKernel;
  const legacy = h.tools.restore({ voronoi: older });
  assert.equal(option.checked, false); assert.equal(h.pool.gpuVoronoi, false); assert.deepEqual(h.preparation.at(-1), []);
  h.pending.at(-1).resolve({ ...voronoiResult(), fallbackReason: undefined }); await legacy;
});
