import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeClusterTools, clusterCategories, clusterColor, CLUSTER_COLORS, CLUSTER_LEGEND_LIMIT } from '../src/cluster-tools.js';
import { calculateClusters } from '../src/analysis/clusters.js';
import { colorsByCategory, visibilityByCategory, UNLISTED_CATEGORY_ID } from '../src/render/palette.js';
import { buildStatisticsTable } from '../src/statistics-export.js';
import { createConfiguration, parseConfiguration } from '../src/configuration.js';
import { createCell, fractionalToCartesian } from '../src/data/model.js';

class Element {
  constructor(value = '') {
    this.value = String(value); this.textContent = ''; this.hidden = false; this.checked = false; this.title = '';
    this.disabled = false; this.listeners = new Map(); this.attributes = new Map(); this.style = {}; this.className = '';
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

/** Ten atoms on a line, 1 Å apart except for a gap after the sixth. */
function lineFrame({ mass = false } = {}) {
  const count = 10, cell = createCell({ vectors: [40, 0, 0, 0, 40, 0, 0, 0, 40], pbc: [false, false, false] });
  const fractional = new Float64Array(count * 3);
  for (let atom = 0; atom < count; atom += 1) {
    fractional[atom * 3] = (1 + atom + (atom >= 6 ? 4 : 0)) / 40; fractional[atom * 3 + 1] = 0.5; fractional[atom * 3 + 2] = 0.5;
  }
  return { fractional, cell, ids: Uint32Array.from({ length: count }, (_, atom) => 101 + atom), types: new Uint16Array(count),
    typeLabels: ['Fe'], positions: fractionalToCartesian(fractional, cell),
    properties: mass ? [{ name: 'mass', unit: 'amu', data: new Float32Array(count).fill(55.845) }] : [] };
}

function harness(t, { groups = [], frame = lineFrame() } = {}) {
  const previousDocument = globalThis.document;
  const fields = {};
  for (const id of ['clusters-state', 'clusters-status', 'clusters-backend', 'clusters-progress', 'clusters-results', 'clusters-summary',
    'run-clusters', 'cancel-clusters', 'clusters-cutoff-field', 'clusters-bond-help', 'clusters-selection', 'clusters-table-body',
    'clusters-table-caption', 'clusters-show-more', 'clusters-color-id', 'clusters-color-size']) fields[id] = new Element();
  fields['clusters-neighbor-mode'] = new Element('cutoff');
  fields['clusters-cutoff'] = new Element('1.05');
  fields['clusters-sort'] = new Element(); fields['clusters-sort'].checked = true;
  globalThis.document = { getElementById: id => fields[id] ?? null,
    createElement() { const element = new Element(); element.ownerDocument = this; return element; } };
  for (const element of Object.values(fields)) element.ownerDocument = globalThis.document;
  t.after(() => { globalThis.document = previousDocument; });
  let currentFrame = frame, version = 'a', colorVersion = 0, bonds = { cutoff: 1.05, pairCutoffs: [] };
  const pending = [], selected = [], changes = [], notifications = [], toolFlags = new Map(), frames = new Set([frame]);
  const pool = { gpuEnabled: true, analyze(inputFrame, settings, options) {
    return new Promise((resolve, reject) => pending.push({ frame: inputFrame, settings, options, resolve, reject }));
  } };
  const tools = initializeClusterTools({ pool, tools: { setToolEnabled: (name, enabled) => toolFlags.set(name, enabled) },
    getFrame: () => currentFrame, getFrames: () => frames, getSourceVersion: () => version, getFrameIndex: () => 0,
    getBondParameters: () => bonds, getSelectionGroups: () => groups, getColorChoiceVersion: () => colorVersion,
    chooseProperty: name => selected.push(name), onResultsChange: change => changes.push(change), notify: message => notifications.push(message) });
  tools.setEnabled(true);
  // Resolve a pending request with the real kernel for its exact inputs.
  const settle = (index = pending.length - 1) => {
    const { frame: input, settings } = pending[index];
    const { kind: _kind, ...options } = settings;
    pending[index].resolve({ ...calculateClusters(input, options), workerCount: 2, backend: 'cpu', engine: 'js-worker-pool×2' });
  };
  return { tools, fields, pending, selected, changes, notifications, toolFlags, settle,
    getFrame: () => currentFrame, setFrame(next) { currentFrame = next; frames.add(next); }, setBonds(next) { bonds = next; },
    setGroups(next) { groups = next; }, changeColor() { colorVersion++; } };
}

test('calculation publishes categorical IDs, sizes, a size table and Color by choice', async t => {
  const h = harness(t), frame = h.getFrame();
  const task = h.tools.run();
  assert.equal(h.pending.length, 1);
  const { settings } = h.pending[0];
  assert.deepEqual({ ...settings, clusterSelection: undefined }, { kind: 'clusters', neighborMode: 'cutoff', cutoff: 1.05, pairCutoffs: [],
    sortBySize: true, clusterSelection: undefined, clusterMasses: null });
  assert.equal(settings.clusterSelection, null);
  assert.deepEqual(h.tools.pendingKinds(), ['clusters']);
  assert.equal(h.fields['run-clusters'].disabled, true);
  h.settle();
  assert.equal(await task, true);
  const id = frame.properties.find(property => property.name === 'clusterId');
  const size = frame.properties.find(property => property.name === 'clusterSize');
  assert.deepEqual([...id.data], [1, 1, 1, 1, 1, 1, 2, 2, 2, 2]);
  assert.deepEqual([...size.data], [6, 6, 6, 6, 6, 6, 4, 4, 4, 4]);
  assert.equal(id.analysisKind, 'clusters'); assert.equal(size.analysisKind, 'clusters');
  assert.equal(id.analysisGpuRequested, undefined, 'no GPU request is recorded for a CPU-only analysis');
  assert.deepEqual(id.categories.map(item => item.label), ['Cluster 1', 'Cluster 2']);
  assert.equal(id.unlistedCategories.colors, CLUSTER_COLORS);
  assert.deepEqual(h.selected, ['clusterId']);
  assert.equal(h.toolFlags.get('clusters'), true);
  assert.equal(h.fields['clusters-results'].hidden, false);
  assert.match(h.fields['clusters-summary'].textContent, /2 clusters · largest 6 atoms · all atoms analyzed · equal atom weights/);
  assert.equal(h.fields['clusters-table-body'].children.length, 2);
  assert.equal(h.fields['clusters-table-body'].children[0].children[1].textContent, '6');
  assert.equal(h.fields['clusters-show-more'].hidden, true);
  assert.equal(h.fields['clusters-state'].textContent, 'Calculated');
  assert.equal(h.tools.getPropertyKind('clusterSize'), 'clusters');
  // Unchanged settings reuse the per-frame result.
  assert.equal(await h.tools.run(), true);
  assert.equal(h.pending.length, 1);
  assert.deepEqual(h.tools.serialize(), { enabled: true, neighborMode: 'cutoff', cutoff: 1.05, selectionGroupId: null, sortBySize: true });
  h.tools.cancel();
  assert.equal(frame.properties.some(property => property.analysisKind === 'clusters'), false);
  assert.equal(frame.atomeyeResults.clusters, undefined);
  assert.equal(h.toolFlags.get('clusters'), false);
  assert.equal(h.tools.getPropertyKind('clusterId'), null);
});

test('selection groups, bond cutoffs and masses become exact kernel inputs', async t => {
  const groups = [{ id: 'core', name: 'Core', atomIds: [101, 102, 103, 107, '108'] }];
  const h = harness(t, { groups, frame: lineFrame({ mass: true }) });
  h.fields['clusters-selection'].value = 'core';
  h.fields['clusters-neighbor-mode'].value = 'bonds';
  h.setBonds({ cutoff: 1.05, pairCutoffs: [{ first: 0, second: 0, cutoff: 1.1 }] });
  const task = h.tools.run();
  const { settings } = h.pending[0];
  assert.deepEqual([...settings.clusterSelection], [1, 1, 1, 0, 0, 0, 1, 1, 0, 0]);
  assert.equal(settings.neighborMode, 'bonds');
  assert.deepEqual(settings.pairCutoffs, [{ first: 0, second: 0, cutoff: 1.1 }]);
  assert.equal(settings.clusterMasses, h.getFrame().properties[0].data);
  h.settle();
  assert.equal(await task, true);
  const id = h.getFrame().properties.find(property => property.name === 'clusterId');
  assert.deepEqual([...id.data], [1, 1, 1, 0, 0, 0, 2, 2, 0, 0]);
  assert.equal(id.categories[0].id, 0);
  assert.match(h.fields['clusters-summary'].textContent, /5 of 10 atoms analyzed · mass-weighted centers/);
  assert.deepEqual(h.tools.serialize(), { enabled: true, neighborMode: 'bonds', cutoff: 1.05, selectionGroupId: 'core', sortBySize: true });
  // Bond edits recalculate only in bond mode.
  h.setBonds({ cutoff: 2.5, pairCutoffs: [] });
  const refreshed = h.tools.refreshBondParameters();
  assert.equal(h.pending.length, 2);
  assert.equal(h.pending[1].settings.cutoff, 2.5);
  h.settle(); assert.equal(await refreshed, true);
  // A removed group fails clearly instead of analyzing every atom.
  h.setGroups([]);
  assert.equal(await h.tools.refreshSelectionGroups(), false);
  assert.equal(h.fields['clusters-state'].textContent, 'Failed');
  assert.match(h.fields['clusters-status'].textContent, /no longer exists/);
  assert.deepEqual(h.tools.failed(), ['clusters']);
  assert.equal(h.fields['clusters-selection'].children.at(-1).textContent, 'Missing group (core)');
});

test('frame changes recalculate enabled clusters and restore replays saved settings', async t => {
  const h = harness(t);
  const first = h.tools.run(); h.settle(); await first;
  const next = lineFrame(); h.setFrame(next);
  const update = h.tools.onFrame({ suggestedCutoff: 2.85 });
  assert.equal(h.fields['clusters-cutoff'].value, '1.05', 'an analyzed radius is kept');
  assert.equal(h.pending.length, 2);
  h.settle(); assert.equal(await update, true);
  assert.equal(next.properties.find(property => property.name === 'clusterId').data.length, 10);
  assert.deepEqual(h.selected, ['clusterId'], 'automatic updates keep the chosen color');
  h.tools.reset();
  assert.equal(h.tools.isEnabled(), false);
  await h.tools.onFrame({ suggestedCutoff: 2.85 });
  assert.equal(h.fields['clusters-cutoff'].value, '2.85', 'a fresh source starts from the element estimate');
  const restored = h.tools.restore({ enabled: true, neighborMode: 'cutoff', cutoff: 5.5, selectionGroupId: null, sortBySize: false });
  assert.equal(h.fields['clusters-cutoff'].value, '5.5');
  assert.equal(h.fields['clusters-sort'].checked, false);
  assert.equal(h.pending.at(-1).settings.sortBySize, false);
  h.settle(); assert.equal(await restored, true);
  assert.deepEqual([...next.properties.find(property => property.name === 'clusterId').data], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
});

test('large results page the table and keep the legend bounded', async t => {
  const frame = lineFrame();
  frame.fractional = new Float64Array(150 * 3);
  for (let atom = 0; atom < 150; atom += 1) frame.fractional.set([atom / 150, 0.5, 0.5], atom * 3);
  frame.ids = Uint32Array.from({ length: 150 }, (_, atom) => atom + 1); frame.types = new Uint16Array(150);
  frame.cell = createCell({ vectors: [400, 0, 0, 0, 40, 0, 0, 0, 40], pbc: [false, false, false] });
  const h = harness(t, { frame });
  const task = h.tools.run(); h.settle(); await task;
  assert.equal(h.fields['clusters-table-body'].children.length, 10);
  assert.equal(h.fields['clusters-show-more'].hidden, false);
  assert.equal(h.fields['clusters-show-more'].textContent, 'Show 100 more of 140');
  h.fields['clusters-show-more'].dispatch('click');
  assert.equal(h.fields['clusters-table-body'].children.length, 110);
  h.fields['clusters-show-more'].dispatch('click');
  assert.equal(h.fields['clusters-table-body'].children.length, 150);
  assert.equal(h.fields['clusters-show-more'].hidden, true);
  const property = frame.properties.find(item => item.name === 'clusterId');
  assert.equal(property.categories.length, CLUSTER_LEGEND_LIMIT);
  const { legend } = colorsByCategory(property);
  assert.equal(legend.items.length, CLUSTER_LEGEND_LIMIT + 1);
  assert.equal(legend.items.at(-1).id, UNLISTED_CATEGORY_ID);
  assert.equal(legend.items.at(-1).count, 130);
  assert.equal(legend.items.at(-1).label, 'Other clusters (130)');
});

test('open-ended categories cycle colors and hide unlisted IDs together without changing ordinary categories', () => {
  const data = Uint32Array.from([0, 1, 2, 21, 22, 300, 301, 2]);
  const result = { clusterCount: 301, excludedAtoms: 1, sizes: new Uint32Array(301).fill(1), percolating: new Uint8Array(301) };
  const property = { name: 'clusterId', data, categories: clusterCategories(result), unlistedCategories: { label: 'Cluster', legendLabel: 'Other clusters', colors: CLUSTER_COLORS } };
  const { colors, legend } = colorsByCategory(property);
  const rgb = atom => Array.from(colors.subarray(atom * 3, atom * 3 + 3));
  assert.deepEqual(rgb(0), [128, 128, 128]);
  assert.deepEqual(rgb(1), [...clusterColor(1)]);
  assert.deepEqual(rgb(3), [...CLUSTER_COLORS[20 % CLUSTER_COLORS.length]]);
  assert.deepEqual(rgb(5), [...CLUSTER_COLORS[299 % CLUSTER_COLORS.length]]);
  assert.notDeepEqual(rgb(5), rgb(6));
  assert.deepEqual(legend.items.at(-1), { id: 'other', label: 'Other clusters (4)', color: [200, 200, 200],
    description: '4 more cluster IDs, each in its own cyclic color; show or hide them together', count: 4, visible: true });
  assert.deepEqual([...visibilityByCategory(property, new Set([UNLISTED_CATEGORY_ID]))], [255, 255, 255, 0, 0, 0, 0, 255]);
  assert.deepEqual([...visibilityByCategory(property, new Set([2, 0]))], [0, 255, 0, 255, 255, 255, 255, 0]);
  // Without the open-ended descriptor, unknown IDs keep the neutral fallback and no aggregate entry.
  const ordinary = colorsByCategory({ name: 'structureType', data, categories: property.categories });
  assert.deepEqual(Array.from(ordinary.colors.subarray(9, 12)), [242, 242, 242]);
  assert.equal(ordinary.legend.items.length, property.categories.length);
  assert.deepEqual([...visibilityByCategory({ data, categories: property.categories }, new Set([UNLISTED_CATEGORY_ID]))], [255, 255, 255, 255, 255, 255, 255, 255]);
});

test('cluster table and category CSV rows cover every cluster with exact values', () => {
  const frame = lineFrame();
  const result = calculateClusters(frame, { cutoff: 1.05 });
  const property = { name: 'clusterId', data: result.clusterId, analysisKind: 'clusters',
    categories: clusterCategories(result, 1), unlistedCategories: { label: 'Cluster', legendLabel: 'Other clusters', colors: CLUSTER_COLORS } };
  const snapshot = { fileName: 'line.xyz', frameIndex: 0, frame: { ...frame, properties: [property] }, results: { clusters: result } };
  const table = buildStatisticsTable(snapshot, 'clusters');
  const rows = [...table.rows];
  assert.equal(table.filename, 'line-frame-1-clusters.csv');
  assert.deepEqual(table.columns.slice(3, 6), ['cluster_id', 'atom_count', 'total_weight [atoms]']);
  assert.deepEqual(rows.map(row => row.slice(3, 6)), [[1, 6, 6], [2, 4, 4]]);
  assert.deepEqual(rows[0].slice(6, 9), [Array.from(result.centers.subarray(0, 3))].flat());
  assert.equal(rows[1].at(-2), false);
  assert.equal(rows[1].at(-1), 107);
  const categories = [...buildStatisticsTable(snapshot, 'categories').rows].filter(row => row[3] === 'clusters');
  assert.deepEqual(categories.map(row => row.slice(4, 8)), [['clusterId', 1, 'Cluster 1', 6], ['clusterId', 2, 'Cluster', 4]]);
  const summary = [...buildStatisticsTable(snapshot, 'summary').rows].filter(row => row[3] === 'clusters' && row[4] === 'cluster_count');
  assert.equal(summary[0][6], 2);
});

test('cluster configuration round-trips and rejects incomplete or unknown settings', () => {
  const selectionGroups = { groups: [{ id: 'solute', name: 'Solute', color: '#112233', visible: true, atomIds: [1, 2] }], selectedGroupId: null };
  const clusters = { enabled: true, neighborMode: 'cutoff', cutoff: 3.2, selectionGroupId: 'solute', sortBySize: false };
  const recipe = createConfiguration({ settings: { selectionGroups, activeTool: 'clusters', extensions: { clusters } } });
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.deepEqual(restored.settings.extensions.clusters, clusters);
  assert.equal(restored.settings.activeTool, 'clusters');
  assert.deepEqual(restored, recipe);
  assert.equal(createConfiguration({}).settings.extensions.clusters, undefined, 'older recipes leave clusters off');
  assert.deepEqual(createConfiguration({ settings: { extensions: { clusters: {} } } }).settings.extensions.clusters,
    { enabled: false, neighborMode: 'cutoff', cutoff: null, selectionGroupId: null, sortBySize: true });
  const bondMode = { settings: { extensions: { bonds: { cutoff: 2.9 }, clusters: { enabled: true, neighborMode: 'bonds' } } } };
  assert.equal(createConfiguration(bondMode).settings.extensions.clusters.cutoff, null);
  const invalid = [
    [{ clusters: { enabled: true, neighborMode: 'cutoff' } }, /clusters\.cutoff is required/],
    [{ clusters: { enabled: true, neighborMode: 'bonds' } }, /bonds\.cutoff is required for enabled clusters/],
    [{ clusters: { neighborMode: 'voronoi' } }, /neighborMode is unsupported/],
    [{ clusters: { cutoff: -1 } }, /clusters\.cutoff must be/],
    [{ clusters: { selectionGroupId: 'missing' } }, /must identify a saved selection group/],
    [{ clusters: { selectionGroupId: '__proto__' } }, /reserved/],
    [{ clusters: { sortBySize: 'yes' } }, /sortBySize must be true or false/],
    [{ clusters: { clusterId: [1, 2] } }, /clusterId is not a supported setting/],
  ];
  for (const [extensions, message] of invalid) {
    assert.throws(() => parseConfiguration(JSON.stringify({ ...recipe, settings: { ...recipe.settings, extensions: { ...recipe.settings.extensions, ...extensions } } })), message);
  }
});
