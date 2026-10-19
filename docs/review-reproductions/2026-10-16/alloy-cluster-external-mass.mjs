// Archived review evidence for baseline 77b24ad; see docs/REPOSITORY_REVIEW_2026-10-16.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeClusterTools, clusterCategories, clusterColor, CLUSTER_COLORS, CLUSTER_LEGEND_LIMIT } from '../../../src/ui/analysis/cluster-tools.js';
import { calculateClusters } from '../../../src/analysis/clusters.js';
import { colorsByCategory, visibilityByCategory, UNLISTED_CATEGORY_ID } from '../../../src/render/palette.js';
import { buildStatisticsTable } from '../../../src/io/statistics-export.js';
import { createConfiguration, parseConfiguration } from '../../../src/application/configuration.js';
import { createCell, fractionalToCartesian } from '../../../src/data/model.js';

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


async function refreshExternalProperties({ restoring = false, reason, oldName, name } = {}) {
  if (!externalProperties || !state.frame) return;
  if (!restoring) interruptConfigurationRestore('an external attribute edit');
  const version = state.sourceVersion;
  const frames = new Set([state.frame, ...cache.frames.values()]);
  for (const frame of [...frames]) frames.add(sourceFrame(frame));
  if (reason === 'rename') {
    if (state.colorMode === `property:${oldName}`) state.colorMode = `property:${name}`;
    for (const preferences of [scalarColorRanges, scalarColorSchemes, scalarHideOutside, scalarColorModes, hiddenCategories]) {
      const oldKey = colorPropertyKey(oldName), key = colorPropertyKey(name);
      if (!preferences.has(oldKey)) continue;
      preferences.set(key, preferences.get(oldKey));
      preferences.delete(oldKey);
    }
  }
  let renamedDisplay = false;
  for (const frame of frames) {
    await externalProperties.applyToFrame(frame, { sourceFrame: sourceFrame(frame) });
    if (version !== state.sourceVersion) return;
    if (reason === 'rename' && frame === state.frame) {
      // The displayed field and its selected quantity become observable
      // together, before awaiting attachment to other cached frames.
      atomEyeTools?.renameProperty(oldName, name);
      refreshColorOptions(); applyColors(); displayRefresh.flush();
      renamedDisplay = true;
    }
  }
  if (reason === 'rename' && !renamedDisplay) atomEyeTools?.renameProperty(oldName, name);
  externalProperties.refresh();
  toolPanels.setToolEnabled('externalProperties', externalProperties.getState().files.length > 0);
  refreshColorOptions();
  applyColors();
  restoreSelection();
  atomEyeTools?.refreshProperties();
  reassessFrameCache(state.frame);
  updateMemoryMetric();
  displayRefresh.flush();
  if (externalProperties.getPendingFiles().length) elements['configuration-status'].textContent =
    `Reselect external property files in Modification → External properties: ${externalProperties.getPendingFiles().map(file => file.name).join(', ')}. Their values have not been restored.`;
  else if (!restoring && /external property files/i.test(elements['configuration-status'].textContent)) {
    elements['configuration-status'].textContent = 'External property data restored. Saved property and vector settings are ready.';
  }
}



import { initializeExternalPropertyControls } from '../../../src/ui/properties/external-property-controls.js';
const h = harness({after() {}}), frame = h.getFrame();
frame.idSource = 'explicit'; frame.frameIndex = 0;
let listener, nextId = 0; const replies = new Map();
globalThis.self = {
  addEventListener(type, callback) { assert.equal(type, 'message'); listener = callback; },
  postMessage(message) { replies.set(message.id, message); },
};
await import('../../../src/workers/external-property-worker.js');
const client = {
  async request(type, payload) {
    const id = ++nextId;
    await listener({data: {id, type, payload}});
    const reply = replies.get(id); replies.delete(id);
    if (!reply.ok) throw new Error(reply.error);
    return reply.result;
  }, reset() { return this.request('reset', {}); },
};
// The actual app.refreshExternalProperties body, with display-only dependencies stubbed.
const state = {frame, sourceVersion: 1, processingRevision: 0};
const cache = {frames: new Map()};
const sourceFrame = frame => frame;
const interruptConfigurationRestore = () => {}; // No configuration restore is active.
const atomEyeTools = { refreshProperties() {} };
const toolPanels = {setToolEnabled() {}};
const refreshColorOptions = () => {}, applyColors = () => {}, restoreSelection = () => {};
const reassessFrameCache = () => {}, updateMemoryMetric = () => {};
const displayRefresh = {flush() {}};
const elements = {'configuration-status': {textContent: ''}};
const externalProperties = initializeExternalPropertyControls({getFrame: () => frame,
  getSourceVersion: () => state.sourceVersion, workerClient: client,
  onImported: refreshExternalProperties, onRemoved: refreshExternalProperties});
function csv(name, firstMass) {
  return new File(['id,mass\n' + [...frame.ids].map((id, index) => `${id},${index === 0 ? firstMass : 1}`).join('\n')], name);
}
const first = await externalProperties.importFile(csv('mass-old.csv', 1));
let run = h.tools.run(); h.settle(); await run;
const initial = frame.atomeyeResults.clusters;
const oldData = frame.properties.find(property => property.name === 'mass').data;
await externalProperties.remove(first.id);
assert.equal(frame.properties.some(property => property.name === 'mass'), false);
assert.equal(frame.atomeyeResults.clusters, initial);
assert.match(h.fields['clusters-summary'].textContent, /mass-weighted/);
const removedButDisplayed = {massPropertyExists:false, displayedWeighting:initial.result.weighting,
  displayedCenterX:initial.result.centers[0]};
await externalProperties.importFile(csv('mass-new.csv', 100));
const newData = frame.properties.find(property => property.name === 'mass').data;
assert.notEqual(newData, oldData);
assert.equal(newData[0], 100);
assert.equal(frame.atomeyeResults.clusters, initial);
assert.equal(await h.tools.run(), true);
assert.equal(h.pending.length, 1, 'second Run incorrectly skips the worker');
const actual = frame.atomeyeResults.clusters.result;
const expected = calculateClusters(frame, {...h.pending[0].settings, clusterMasses: newData});
assert.notEqual(actual.centers[0], expected.centers[0]);
assert.notEqual(actual.radiiOfGyration[0], expected.radiiOfGyration[0]);
console.log(JSON.stringify({
  removedButDisplayed,
  afterReplacementAndRun: {massFirstAtom:newData[0], analyzeCalls:h.pending.length,
    expectedAnalyzeCalls:2, actualCenterX:actual.centers[0], expectedCenterX:expected.centers[0],
    actualRg:actual.radiiOfGyration[0], expectedRg:expected.radiiOfGyration[0],
    sourceVersion:state.sourceVersion, processingRevision:state.processingRevision,
    actualTableRow:h.fields['clusters-table-body'].children[0].children.slice(1).map(cell=>cell.textContent)}
}, null, 2));
