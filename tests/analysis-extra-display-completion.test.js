import assert from 'node:assert/strict';
import test from 'node:test';
import { createDisplayRefresh } from '../src/display-refresh.js';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { initializeTopologyTools } from '../src/topology-tools.js';
import { initializeClusterTools } from '../src/cluster-tools.js';
import { calculateClusters } from '../src/analysis/clusters.js';
import { initializeDxaTools, DXA_STRUCTURE_PROPERTY } from '../src/dxa-tools.js';
import { initializeGrainTools } from '../src/grain-tools.js';
import { initializeWignerSeitzTools } from '../src/wigner-seitz-tools.js';
import { calculateWignerSeitz } from '../src/analysis/wigner-seitz.js';

class Element {
  constructor(value = '') {
    this.value = String(value); this.checked = false; this.textContent = ''; this.children = [];
    this.hidden = false; this.disabled = false; this.style = {}; this.listeners = new Map();
    this.attributes = new Map(); this.classes = new Set();
    this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  }
  get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => typeof child === 'object'
      ? [...(selector === 'input' && child.tagName === 'INPUT' ? [child] : []), ...child.querySelectorAll(selector)] : []);
  }
}

function atomFrame({ reference = false } = {}) {
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] });
  const ids = reference ? Uint32Array.of(1, 2, 3, 4) : Uint32Array.of(1, 2, 4);
  const fractional = reference ? Float64Array.of(.1, .5, .5, .2, .5, .5, .4, .5, .5, .6, .5, .5)
    : Float64Array.of(.1, .5, .5, .2, .5, .5, .6, .5, .5);
  return { frameIndex: reference ? 0 : 1, idSource: 'explicit', ids, fractional, cell, properties: [],
    positions: fractionalToCartesian(fractional, cell), types: new Uint16Array(ids.length), typeLabels: ['Fe'] };
}

const CASES = [
  { kind: 'bondStatistics', prefix: 'bond-statistics', property: 'bondQ6', family: 'topology' },
  { kind: 'voronoi', prefix: 'voronoi', property: 'atomicVolume', family: 'topology' },
  { kind: 'clusters', prefix: 'clusters', property: 'clusterId', family: 'clusters' },
  { kind: 'dxa', prefix: 'dxa', property: DXA_STRUCTURE_PROPERTY, family: 'dxa' },
  { kind: 'grains', prefix: 'grains', property: 'grainId', family: 'grains' },
  { kind: 'wignerSeitz', prefix: 'wigner-seitz', property: 'wsDefectClass', family: 'wignerSeitz' },
];

function harness(t, spec) {
  const previousDocument = globalThis.document, fields = new Map();
  const add = (id, value = '') => fields.set(id, new Element(value));
  const prefixes = spec.family === 'topology' ? ['bond-statistics', 'voronoi'] : [spec.prefix];
  for (const prefix of prefixes) {
    for (const suffix of ['state', 'status', 'backend', 'progress', 'results', 'summary', 'table-body', 'table-caption', 'show-more']) add(`${prefix}-${suffix}`);
    add(`run-${prefix}`); add(`cancel-${prefix}`);
  }
  for (const [id, value] of Object.entries({
    'bond-statistics-length-bins': 100, 'bond-statistics-angle-bins': 180,
    'voronoi-face-area-threshold': 0, 'voronoi-relative-face-area-threshold': 0,
    'clusters-neighbor-mode': 'cutoff', 'clusters-cutoff': 1.05,
    'grains-algorithm': 'automatic', 'grains-threshold': '', 'grains-min-size': 100,
    'wigner-seitz-reference-frame': 1, 'wigner-seitz-markers': 'vacancies', 'wigner-seitz-marker-radius': .25,
    'dxa-lattice': 'fcc', 'dxa-trial-length': 14, 'dxa-stretchability': 9, 'dxa-smoothing': 0,
    'dxa-point-interval': 2.5, 'dxa-line-radius': .25,
  })) add(id, value);
  for (const id of ['clusters-sort', 'grains-orphans', 'grains-interfaces', 'wigner-seitz-show-markers']) { add(id); fields.get(id).checked = true; }
  for (const id of ['wigner-seitz-affine', 'dxa-perfect-only', 'dxa-families']) add(id);
  const root = { getElementById: id => fields.get(id) ?? null,
    createElement(tag) { const element = new Element(); element.tagName = tag.toUpperCase(); element.ownerDocument = root; return element; },
    createTextNode: value => String(value) };
  for (const element of fields.values()) element.ownerDocument = root;
  globalThis.document = root;
  t.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });

  const reference = atomFrame({ reference: true });
  let frame = atomFrame(), source = 0, colorMode = 'type';
  const frames = new Set([reference, frame]), pending = [], painted = [], completions = [], notifications = [];
  const pill = fields.get(`${spec.prefix}-state`);
  const display = createDisplayRefresh({
    apply: flags => { if (flags.colors) painted.push({ mode: colorMode, frame,
      property: frame.properties.find(property => `property:${property.name}` === colorMode) }); },
    schedule: () => 1, cancel() {},
  });
  const onResultsChange = change => {
    if (change.selectProperty) colorMode = `property:${change.selectProperty}`;
    display.request({ colors: true });
  };
  const common = { tools: { setToolEnabled() {} }, getFrame: () => frame, getFrames: () => frames,
    getSourceVersion: () => source, getFrameIndex: () => 1, getFrameCount: () => 2, getFrameAt: async () => reference,
    getColorMode: () => colorMode, chooseProperty: name => { colorMode = `property:${name}`; display.request({ colors: true }); },
    onResultsChange, notify: message => notifications.push(message),
    afterDisplayRefresh: callback => display.afterFlush(() => {
      callback();
      if (pill.textContent === 'Calculated') completions.push({ mode: colorMode, painted: painted.at(-1), frame });
    }),
  };
  const enqueue = (target, settings, options) => new Promise((resolve, reject) => pending.push({ frame: target, settings, options, resolve, reject }));
  const pool = { gpuEnabled: false, analyze: enqueue };
  const renderer = { frame, siteMarkers: null, network: null,
    setSiteMarkers(markers) { this.siteMarkers = markers; }, setDislocationNetwork(network) { this.network = network; } };
  let controls;
  if (spec.family === 'topology') controls = initializeTopologyTools({ ...common, pool, getBondParameters: () => ({ cutoff: 1.05, pairCutoffs: [] }) });
  else if (spec.family === 'clusters') controls = initializeClusterTools({ ...common, pool });
  else if (spec.family === 'dxa') controls = initializeDxaTools({ ...common, renderer, client: { analyze: enqueue, release() {} } });
  else if (spec.family === 'wignerSeitz') controls = initializeWignerSeitzTools({ ...common, renderer, pool });
  else controls = initializeGrainTools({ ...common,
    ensurePtm: async target => ({ ptm: { key: 'fit', structureTypes: new Uint8Array(target.ids.length),
      orientations: new Float32Array(target.ids.length * 4), neighbors: [] }, reused: false, engine: 'CPU PTM' }),
    client: { segment: enqueue } });
  controls.setEnabled(true);
  // DXA initializes by clearing its view, which is a display request without a scientific result.
  display.flush(); painted.length = 0; completions.length = 0;

  function resultFor(job) {
    const count = frame.ids.length;
    let result;
    if (spec.kind === 'bondStatistics') result = { q4: new Float32Array(count).fill(.2), q6: new Float32Array(count).fill(.5), coordination: new Uint32Array(count).fill(1),
      statistics: { length: { count: 1, mean: 1 }, angle: { count: 0, mean: NaN } } };
    else if (spec.kind === 'voronoi') result = { atomicVolume: new Float64Array(count).fill(8), voronoiSurfaceArea: new Float64Array(count).fill(24),
      voronoiCoordination: new Uint32Array(count).fill(6), voronoiBoundaryFaces: new Uint8Array(count), voronoiMaxFaceOrder: new Uint32Array(count).fill(4),
      voronoiIndices: Array(count).fill('<0,6,0,0>'), summary: { atomCount: count, meanVolume: 8, meanCoordination: 6 } };
    else if (spec.kind === 'clusters') { const { kind: ignored, ...settings } = job.settings; result = calculateClusters(job.frame, settings); }
    else if (spec.kind === 'dxa') result = { atomStructureTypes: Uint8Array.of(1, 1, 0),
      segments: [{ id: 0, familyId: 'perfect', points: Float64Array.of(1, 5, 5, 2, 5, 5) }], counts: { perfect: 1 }, totalLength: 1, density: .001 };
    else if (spec.kind === 'wignerSeitz') result = calculateWignerSeitz(job.frame, reference, { affineMapping: job.settings.affineMapping });
    else result = { grainId: new Uint32Array(count), grainCount: 0, unassignedAtoms: count, sizes: new Uint32Array(0),
      structureTypes: new Uint8Array(0), orientations: new Float32Array(0), algorithm: 'automatic', mergeThreshold: 0,
      suggestedThreshold: 0, meanSize: NaN, largestSize: 0, plot: { unit: 'log d', x: [], y: [] }, worker: true };
    return { ...result, elapsedMs: 2, workerCount: 1, backend: 'cpu', engine: 'CPU test backend' };
  }
  const run = options => spec.family === 'topology' ? controls.run(spec.kind, options) : controls.run(options);
  const cancel = () => spec.family === 'topology' ? controls.cancel(spec.kind) : controls.cancel();
  async function waitForBackend(count) {
    for (let turn = 0; pending.length < count && turn < 20; turn++) await Promise.resolve();
    assert.equal(pending.length, count, 'the new calculation reaches its backend');
  }
  async function complete(options) {
    const before = pending.length, task = run(options);
    for (let turn = 0; pending.length === before && turn < 10; turn++) await Promise.resolve();
    if (pending.length > before) pending.at(-1).resolve(resultFor(pending.at(-1)));
    assert.equal(await task, true);
    assert.deepEqual(notifications, []);
  }
  return { controls, fields, pill, display, pending, painted, completions, renderer, run, cancel, complete, waitForBackend,
    resolveLatest() { const latest = pending.at(-1); latest.resolve(resultFor(latest)); }, getFrame: () => frame,
    replaceSource() { frame = atomFrame(); source++; frames.add(frame); renderer.frame = frame; return controls.onFrame(); } };
}

for (const spec of CASES) {
  test(`${spec.kind} publishes scientific results before the display and waits on cached reruns`, async t => {
    const h = harness(t, spec);
    await h.complete();
    const property = h.getFrame().properties.find(field => field.name === spec.property);
    assert.ok(property?.data, 'scientific values are immediately available');
    assert.equal(h.fields.get(`${spec.prefix}-results`).hidden, false, 'the statistical results are already published');
    if (spec.family === 'dxa') assert.ok(h.renderer.network?.segments.length, 'line geometry is already available');
    if (spec.family === 'wignerSeitz') assert.equal(h.renderer.siteMarkers?.sites.length, 1, 'vacancy geometry is already available');
    assert.equal(h.pill.textContent, 'Updating display…');
    assert.equal(h.pill.classes.has('ready'), false);
    assert.equal(h.fields.get(`cancel-${spec.prefix}`).disabled, false, 'display completion remains cancellable');
    assert.deepEqual(h.painted, []);
    h.display.flush();
    assert.equal(h.pill.textContent, 'Calculated');
    assert.equal(h.pill.classes.has('ready'), true);
    assert.equal(h.completions.at(-1).painted.mode, `property:${spec.property}`, 'the selected legend is painted before completion');
    assert.equal(h.completions.at(-1).painted.property.data, property.data);
    const backendCalls = h.pending.length;
    await h.complete();
    assert.equal(h.pending.length, backendCalls, 'cached reruns retain the backend result');
    assert.equal(h.pill.textContent, 'Updating display…', 'cached publications also clear the previous ready label');
    assert.equal(h.getFrame().properties.find(field => field.name === spec.property).data, property.data);
    h.display.flush();
    assert.equal(h.pill.textContent, 'Calculated');
    assert.equal(h.completions.at(-1).painted.property.data, property.data);
  });

  test(`${spec.kind} cancellation after publication cannot be undone by a queued display completion`, async t => {
    const h = harness(t, spec);
    await h.complete();
    h.cancel(); h.display.flush();
    assert.equal(h.pill.textContent, 'Not calculated');
    assert.equal(h.pill.classes.has('ready'), false);
    assert.equal(h.getFrame().properties.some(field => field.analysisKind === spec.kind), false);
    assert.deepEqual(h.completions, []);
  });

  test(`${spec.kind} a new source prevents an older completion from marking the new frame ready`, async t => {
    const h = harness(t, spec);
    await h.complete();
    const oldProperty = h.getFrame().properties.find(field => field.name === spec.property);
    const task = h.replaceSource();
    await h.waitForBackend(2);
    h.display.flush();
    assert.notEqual(h.pill.textContent, 'Calculated');
    assert.equal(h.pill.classes.has('ready'), false);
    assert.deepEqual(h.completions, []);
    assert.equal(h.getFrame().properties.some(field => field.name === spec.property), false);
    h.resolveLatest(); await task;
    const property = h.getFrame().properties.find(field => field.name === spec.property);
    assert.ok(property); assert.notEqual(property.data, oldProperty.data);
    h.display.flush();
    assert.equal(h.pill.textContent, 'Calculated');
    assert.equal(h.completions.at(-1).painted.frame, h.getFrame());
    assert.equal(h.completions.at(-1).painted.property.data, property.data);
  });
}

test('DXA display completion honors a withdrawn external request guard', async t => {
  const h = harness(t, CASES.find(spec => spec.kind === 'dxa'));
  let current = true;
  await h.complete({ isCurrent: () => current });
  current = false;
  h.display.flush();
  assert.notEqual(h.pill.textContent, 'Calculated');
  assert.equal(h.pill.classes.has('ready'), false);
  assert.deepEqual(h.completions, []);
});

test('DXA restoration forwards its external guard to the queued display completion', async t => {
  const h = harness(t, CASES.find(spec => spec.kind === 'dxa'));
  let current = true;
  const task = h.controls.restore({ ...h.controls.serialize(), enabled: true }, { isCurrent: () => current });
  await h.waitForBackend(1);
  h.resolveLatest(); await task;
  assert.ok(h.getFrame().properties.find(field => field.name === DXA_STRUCTURE_PROPERTY));
  current = false;
  h.display.flush();
  assert.notEqual(h.pill.textContent, 'Calculated');
  assert.equal(h.pill.classes.has('ready'), false);
  assert.deepEqual(h.completions, []);
});
