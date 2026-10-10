import assert from 'node:assert/strict';
import test from 'node:test';
import { GRAIN_COLORS, GRAIN_LEGEND_LIMIT, GRAIN_NONE_COLOR, displayedGrainThreshold, grainCategories, grainColor, grainVolumes,
  initializeGrainTools } from '../src/grain-tools.js';
import { GRAIN_DEFAULT_MST_THRESHOLD, calculateGrains, quaternionBungeEuler } from '../src/analysis/grains.js';
import { calculatePtm } from '../src/analysis/ptm.js';
import { createConfiguration, parseConfiguration } from '../src/configuration.js';
import { createAttributeRegistry } from '../src/global-attributes.js';
import { GrainSegmentationClient } from '../src/grains-client.js';
import { BUILTIN_COLOR_MODES, BUILTIN_SCALAR_COLOR_MODES, initialColorQuantities } from '../src/render/color-quantities.js';
import { GRAIN_CHART_MAX_POINTS, grainChartPoints, renderGrainMergeChart } from '../src/render/grain-merge-chart.js';
import { GRAIN_ORIENTATION_COLOR_MODES, ORIENTATION_COLOR_MODES, OrientationColorResolver, UNDEFINED_ORIENTATION_COLOR,
  grainOrientationSource, ipfColor, rodriguesColor } from '../src/render/orientation-colors.js';
import { DISTINCT_CATEGORY_COLORS, colorsByCategory, visibilityByCategory, UNLISTED_CATEGORY_ID } from '../src/render/palette.js';
import { STATISTICS_EXPORT_BUTTONS } from '../src/statistics-export-controls.js';
import { STATISTICS_TABLES, buildStatisticsTable } from '../src/statistics-export.js';
import { BUILTIN_TOOLS } from '../src/tool-registry.js';
import { GRAIN_FIXTURES } from './helpers/grain-fixtures.js';
import { axisAngleQuaternion } from './helpers/polycrystal.js';

class Element {
  constructor(value = '') {
    this.value = String(value); this.textContent = ''; this.hidden = false; this.checked = false; this.title = ''; this.placeholder = '';
    this.disabled = false; this.listeners = new Map(); this.attributes = new Map(); this.style = {}; this.className = '';
    this.classList = { toggle() {} };
    this.children = [];
  }
  get valueAsNumber() { return this.value.trim() === '' ? NaN : Number(this.value); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  dispatch(name, event = {}) { this.listeners.get(name)?.({ target: this, ...event }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  all(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...(child.all?.(tag) ?? [])]); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 360, height: 200 }; }
}

// One real PTM fit and its real grains serve every controller test.
const frameTemplate = GRAIN_FIXTURES.bicrystal();
const ptmTemplate = await calculatePtm(frameTemplate, { flags: 7, neighborLists: true });
function bicrystal() {
  return { ...frameTemplate, properties: [], atomeyeResults: undefined, ptm: undefined, frameIndex: 0 };
}

function harness(t, { frame = bicrystal(), client = new GrainSegmentationClient({ createWorker: null }) } = {}) {
  const previousDocument = globalThis.document;
  const fields = {};
  for (const id of ['grains-state', 'grains-status', 'grains-backend', 'grains-progress', 'grains-results', 'grains-summary', 'run-grains',
    'cancel-grains', 'grains-threshold-label', 'grains-threshold-unit', 'grains-table-body', 'grains-table-caption', 'grains-show-more',
    'grains-chart', 'grains-chart-caption', 'grains-color-id', 'grains-color-ipf', 'grains-color-rodrigues']) fields[id] = new Element();
  fields['grains-algorithm'] = new Element('automatic');
  fields['grains-threshold'] = new Element('');
  fields['grains-min-size'] = new Element('100');
  fields['grains-orphans'] = new Element(); fields['grains-orphans'].checked = true;
  fields['grains-interfaces'] = new Element(); fields['grains-interfaces'].checked = true;
  const root = { getElementById: id => fields[id] ?? null,
    createElement(tag) { const element = new Element(); element.ownerDocument = root; element.tagName = tag; return element; },
    createElementNS(_, tag) { return root.createElement(tag); } };
  globalThis.document = root;
  for (const element of Object.values(fields)) element.ownerDocument = root;
  t.after(() => { globalThis.document = previousDocument; client.dispose(); });
  let currentFrame = frame, version = 'a', colorVersion = 0, ptmParameters = { flags: 7, rmsdCutoff: .1 }, failPtm = null;
  const selected = [], modes = [], changes = [], notifications = [], toolFlags = new Map(), frames = new Set([frame]), fits = [], released = [];
  const tools = initializeGrainTools({ client, tools: { setToolEnabled: (name, enabled) => toolFlags.set(name, enabled) },
    getFrame: () => currentFrame, getFrames: () => frames, getSourceVersion: () => version, getFrameIndex: () => 0,
    getPtmParameters: () => { if (!ptmParameters.flags) throw new Error('Select at least one PTM template.'); return ptmParameters; },
    ensurePtm: async (target, { signal, onProgress }) => {
      fits.push({ target, parameters: ptmParameters });
      onProgress({ phase: 'analyzing', stage: 'ptm-fit', workerCount: 2, completedAtoms: 10, totalAtoms: 20 });
      await Promise.resolve();
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
      if (failPtm) throw new Error(failPtm);
      const key = JSON.stringify(ptmParameters), reused = target.ptm?.key === key;
      if (!reused) target.ptm = { ...ptmTemplate, key };
      return { ptm: target.ptm, reused, engine: 'ptm-wasm-worker-pool×2' };
    },
    releasePtm: () => { released.push(true); for (const item of frames) delete item.ptm; },
    getColorChoiceVersion: () => colorVersion, chooseProperty: name => selected.push(name), chooseColorMode: mode => modes.push(mode),
    onResultsChange: change => changes.push(change), notify: message => notifications.push(message) });
  tools.setEnabled(true);
  const settle = async () => { for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setImmediate(resolve)); };
  return { tools, fields, selected, modes, changes, notifications, toolFlags, fits, released, frames, settle,
    setFrame(next) { currentFrame = next; if (next) frames.add(next); }, setVersion(next) { version = next; },
    setPtm(next) { ptmParameters = next; }, failPtmWith(message) { failPtm = message; }, bumpColor() { colorVersion += 1; },
    property: () => currentFrame.properties.find(property => property.name === 'grainId') };
}

test('the Grains tool is registered and its colors cycle through distinct hues', () => {
  const tool = BUILTIN_TOOLS.find(entry => entry.id === 'grains');
  assert.deepEqual({ label: tool.label, analysis: tool.analysis, category: tool.category }, { label: 'Grains', analysis: true, category: 'visualization' });
  assert.equal(GRAIN_COLORS, DISTINCT_CATEGORY_COLORS);
  assert.deepEqual(grainColor(0), GRAIN_NONE_COLOR);
  assert.deepEqual(grainColor(1), GRAIN_COLORS[0]);
  assert.deepEqual(grainColor(GRAIN_COLORS.length + 2), GRAIN_COLORS[1]);
  assert.ok(GRAIN_COLORS.every(color => !(color[0] === color[1] && color[1] === color[2])), 'no grain shares the neutral gray');
  // The shown automatic threshold never falls below the exact one.
  for (const value of [10.17424379127682, 13.3922, 13.39220000001, -2.00005, 0]) {
    const shown = displayedGrainThreshold(value);
    assert.ok(shown >= value - 1e-12 && shown - value < 1.0001e-4, `${value} → ${shown}`);
    assert.equal(shown, Number(shown.toFixed(4)));
  }
  assert.ok(Number.isNaN(displayedGrainThreshold(null)));
});

test('a calculation publishes grain IDs, a table, a merge plot and the automatic threshold', async t => {
  const h = harness(t), frame = h.frames.values().next().value;
  assert.equal(h.fields['grains-state'].textContent, 'Not calculated');
  assert.equal(h.fields['grains-threshold'].disabled, true, 'the automatic threshold is an output');
  assert.equal(h.fields['run-grains'].disabled, false);
  assert.equal(h.fields['cancel-grains'].disabled, true);
  const expected = calculateGrains({ ...ptmTemplate, fractional: frame.fractional, cell: frame.cell });
  h.fields['run-grains'].dispatch('click');
  assert.equal(h.fields['grains-state'].textContent, 'Calculating…');
  assert.equal(h.fields['run-grains'].disabled, true);
  assert.deepEqual(h.tools.pendingKinds(), ['grains']);
  assert.deepEqual(h.tools.pendingColorProperties(), [{ name: 'grainId', label: 'Grain ID' }]);
  assert.deepEqual(h.tools.pendingColorModes().map(mode => mode.value), GRAIN_ORIENTATION_COLOR_MODES);
  await h.settle();
  assert.equal(h.fields['grains-state'].textContent, 'Calculated');
  const property = h.property();
  assert.deepEqual(Array.from(property.data), Array.from(expected.grainId));
  assert.equal(property.analysisKind, 'grains');
  assert.deepEqual(property.categories.map(category => category.label), ['Grain 1', 'Grain 2']);
  assert.equal(property.unlistedCategories.colors, GRAIN_COLORS);
  assert.equal(frame.atomeyeResults.grains.result.grainId, property.data, 'the result and the property share one array');
  assert.deepEqual(h.selected, ['grainId'], 'a manual run colors by grain');
  assert.equal(h.toolFlags.get('grains'), true);
  assert.equal(h.tools.getPropertyKind('grainId'), 'grains'); assert.equal(h.tools.getPropertyKind('clusterId'), null);
  assert.deepEqual(h.tools.pendingKinds(), []);
  assert.equal(h.fields['grains-results'].hidden, false);
  assert.match(h.fields['grains-summary'].textContent, /^2 grains · mean 896 atoms · largest [\d,]+ · every atom in a grain · [\d,]+ orphan atoms adopted · threshold [\d.]+$/);
  assert.match(h.fields['grains-status'].textContent, /^ptm-wasm-worker-pool×2 \+ CPU · main thread · [\d.]+ s$/);
  assert.equal(h.fields['grains-backend'].textContent, 'ptm-wasm-worker-pool×2 + CPU · main thread');
  // The read-only threshold field shows the automatic value, rounded up.
  assert.equal(Number(h.fields['grains-threshold'].value), displayedGrainThreshold(expected.mergeThreshold));
  // Table: ID with its swatch, atoms, structure, axis–angle; the quaternion as a tooltip.
  const rows = h.fields['grains-table-body'].children;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].children.slice(1, 3).map(cell => cell.textContent), [expected.sizes[0].toLocaleString('en-US'), 'FCC']);
  assert.equal(rows[0].children[0].children[0].style.background, `rgb(${GRAIN_COLORS[0].join(' ')})`);
  assert.match(rows[1].children[3].textContent, /° about \[/);
  assert.match(rows[0].title, /^Mean orientation quaternion \(w, x, y, z\): /);
  assert.match(h.fields['grains-table-caption'].textContent, /^Showing 2 of 2 grains, largest first/);
  // Chart: applied merges, the threshold line and a readout.
  const chart = h.fields['grains-chart'];
  assert.equal(chart.all('path').filter(path => path.attributes.get('class') === 'chart-threshold').length, 1);
  assert.match(h.fields['grains-chart-caption'].textContent, /threshold is the largest distance still on that line/);
  // Volumes: every atom is in a grain of a periodic cell, so they add up to the cell.
  const { volumes, volumeSource } = frame.atomeyeResults.grains.result;
  assert.equal(volumeSource, 'mean');
  assert.ok(Math.abs(volumes[0] + volumes[1] - 38 * 23 * 23) < 1e-6);
  // The same request again is answered from the frame.
  const fits = h.fits.length;
  h.fields['run-grains'].dispatch('click'); await h.settle();
  assert.equal(h.fits.length, fits, 'no further PTM request');
  assert.equal(h.property().data, property.data);
});

test('settings recalculate automatically, reuse the PTM fit and follow the algorithm', async t => {
  const h = harness(t), frame = h.frames.values().next().value;
  h.fields['run-grains'].dispatch('click'); await h.settle();
  const automatic = frame.atomeyeResults.grains.result;
  assert.equal(automatic.ptmReused, false); assert.equal(automatic.modelReused, false);
  // Without orphan adoption, atoms outside grains get the neutral legend entry.
  h.fields['grains-orphans'].checked = false; h.fields['grains-orphans'].dispatch('change'); await h.settle();
  const strict = frame.atomeyeResults.grains.result;
  assert.ok(strict.unassignedAtoms > 0); assert.equal(strict.ptmReused, true); assert.equal(strict.modelReused, true);
  assert.match(h.fields['grains-status'].textContent, /reused the PTM fit · reused the merge sequence$/);
  assert.deepEqual(h.property().categories.map(category => category.label), ['No grain', 'Grain 1', 'Grain 2']);
  assert.deepEqual(h.property().categories[0].color, GRAIN_NONE_COLOR);
  assert.match(h.fields['grains-summary'].textContent, /atoms in no grain/);
  assert.deepEqual(h.selected, ['grainId'], 'automatic recalculation does not change the color choice');
  // A minimum size above every grain leaves none, and says what to do.
  h.fields['grains-min-size'].value = '5000'; h.fields['grains-min-size'].dispatch('change'); await h.settle();
  assert.equal(frame.atomeyeResults.grains.result.grainCount, 0);
  assert.match(h.fields['grains-table-caption'].textContent, /No grain reaches the minimum size/);
  assert.match(h.fields['grains-summary'].textContent, /^0 grains · /);
  h.fields['grains-min-size'].value = '100'; h.fields['grains-min-size'].dispatch('change'); await h.settle();
  // Manual: the field becomes editable and starts from the automatic value.
  h.fields['grains-algorithm'].value = 'manual'; h.fields['grains-algorithm'].dispatch('change');
  assert.equal(h.fields['grains-threshold'].disabled, false);
  assert.equal(h.fields['grains-threshold-label'].textContent, 'Merge threshold (log distance)');
  assert.equal(Number(h.fields['grains-threshold'].value), displayedGrainThreshold(automatic.mergeThreshold));
  await h.settle();
  const manual = frame.atomeyeResults.grains.result;
  assert.equal(manual.algorithm, 'manual'); assert.equal(manual.grainCount, 2);
  assert.deepEqual(Array.from(manual.grainId), Array.from(strict.grainId), 'the displayed automatic value reproduces the automatic grains');
  assert.equal(manual.modelReused, true, 'manual and automatic share one merge sequence');
  assert.match(h.fields['grains-chart-caption'].textContent, /Click the plot to set the threshold; the automatic value is/);
  // Clicking the plot sets the threshold and recalculates.
  h.fields['grains-chart'].all('svg')[0].dispatch('click', { clientX: 60, clientY: 100 });
  await h.settle();
  const clicked = frame.atomeyeResults.grains.result;
  assert.equal(clicked.mergeThreshold, Number(h.fields['grains-threshold'].value));
  assert.ok(clicked.mergeThreshold < manual.mergeThreshold && clicked.appliedMerges < manual.appliedMerges);
  // Minimum spanning tree: degrees, its own default and its own merge sequence.
  h.fields['grains-algorithm'].value = 'mst'; h.fields['grains-algorithm'].dispatch('change');
  assert.equal(h.fields['grains-threshold-unit'].textContent, '°');
  assert.equal(h.fields['grains-threshold'].value, String(GRAIN_DEFAULT_MST_THRESHOLD));
  await h.settle();
  const tree = frame.atomeyeResults.grains.result;
  assert.equal(tree.algorithm, 'mst'); assert.equal(tree.mergeThreshold, 2); assert.equal(tree.modelReused, false);
  assert.match(h.fields['grains-summary'].textContent, /threshold 2°$/);
  // Back to automatic: the field is an output again and the manual value is remembered.
  h.fields['grains-algorithm'].value = 'automatic'; h.fields['grains-algorithm'].dispatch('change'); await h.settle();
  assert.equal(h.fields['grains-threshold'].disabled, true);
  assert.equal(h.tools.serialize().mergeThreshold, clicked.mergeThreshold);
  assert.equal(h.tools.serialize().mstThreshold, 2);
  // New PTM settings mean a new fit.
  const fits = h.fits.length;
  h.setPtm({ flags: 3, rmsdCutoff: .12 });
  await h.tools.refreshPtmParameters();
  assert.equal(h.fits.length, fits + 1);
  assert.equal(frame.atomeyeResults.grains.result.ptmReused, false);
  assert.match(frame.atomeyeResults.grains.key, /"flags":3,"rmsdCutoff":0\.12/);
});

test('invalid settings and failures are reported without stale results', async t => {
  const h = harness(t), frame = h.frames.values().next().value;
  h.fields['run-grains'].dispatch('click'); await h.settle();
  h.fields['grains-min-size'].value = '0'; h.fields['grains-min-size'].dispatch('change'); await h.settle();
  assert.equal(h.fields['grains-state'].textContent, 'Failed');
  assert.match(h.fields['grains-status'].textContent, /minimum grain size/);
  assert.equal(h.property(), undefined, 'the previous grains are withdrawn');
  assert.equal(frame.atomeyeResults.grains, undefined);
  assert.deepEqual(h.tools.failed(), ['grains']); assert.deepEqual(h.tools.pendingKinds(), []);
  assert.deepEqual(h.notifications, [], 'an automatic recalculation does not raise a toast');
  h.fields['run-grains'].dispatch('click'); await h.settle();
  assert.equal(h.notifications.length, 1);
  h.fields['grains-min-size'].value = '100';
  // The PTM panel has no template selected.
  h.setPtm({ flags: 0, rmsdCutoff: .1 });
  h.fields['run-grains'].dispatch('click'); await h.settle();
  assert.match(h.fields['grains-status'].textContent, /at least one PTM template/);
  h.setPtm({ flags: 7, rmsdCutoff: .1 });
  // The PTM fit or the clustering fails.
  h.failPtmWith('PTM failed for atom 3 (code 1).');
  h.fields['run-grains'].dispatch('click'); await h.settle();
  assert.equal(h.fields['grains-state'].textContent, 'Failed');
  assert.equal(h.fields['grains-status'].textContent, 'PTM failed for atom 3 (code 1).');
  assert.equal(h.fields['run-grains'].disabled, false);
  h.failPtmWith(null);
  h.fields['run-grains'].dispatch('click'); await h.settle();
  assert.equal(h.fields['grains-state'].textContent, 'Calculated');
  assert.deepEqual(h.tools.failed(), []);
  // A manual threshold must be a number.
  h.fields['grains-algorithm'].value = 'manual'; h.fields['grains-algorithm'].dispatch('change'); await h.settle();
  h.fields['grains-threshold'].value = ''; h.fields['grains-threshold'].dispatch('change'); await h.settle();
  assert.match(h.fields['grains-status'].textContent, /merge threshold must be a finite number/);
  assert.ok(Number.isFinite(h.tools.serialize().mergeThreshold), 'a recipe keeps the last valid threshold');
});

test('frame changes recalculate, cancelling clears everything and stale jobs are dropped', async t => {
  const h = harness(t), first = h.frames.values().next().value;
  assert.equal(await h.tools.onFrame(), false, 'a disabled tool does nothing on a new frame');
  h.fields['run-grains'].dispatch('click'); await h.settle();
  const second = bicrystal();
  h.setFrame(second);
  const pending = h.tools.onFrame();
  assert.equal(h.fields['grains-results'].hidden, true, 'the previous table is hidden while the new frame is calculated');
  assert.equal(await pending, true);
  assert.equal(second.atomeyeResults.grains.result.grainCount, 2);
  assert.ok(first.atomeyeResults.grains, 'the earlier frame keeps its cached result');
  // Returning to the first frame reuses its result without any PTM request.
  const fits = h.fits.length;
  h.setFrame(first); await h.tools.onFrame();
  assert.equal(h.fits.length, fits);
  // A job overtaken by a new source is discarded.
  const third = bicrystal();
  h.setFrame(third);
  const overtaken = h.tools.onFrame();
  h.setVersion('b');
  assert.equal(await overtaken, false);
  assert.equal(third.atomeyeResults?.grains, undefined);
  h.setVersion('a');
  // Cancelling while calculating, then closing the tool.
  const running = h.tools.run({ automatic: true });
  h.fields['cancel-grains'].dispatch('click');
  assert.equal(await running, false);
  assert.equal(h.fields['grains-state'].textContent, 'Not calculated');
  for (const frame of h.frames) { assert.equal(frame.atomeyeResults?.grains, undefined); assert.ok(!frame.properties.some(property => property.name === 'grainId')); }
  assert.equal(h.released.length > 0, true, 'the PTM fit is released with the tool');
  assert.equal(h.toolFlags.get('grains'), false);
  assert.equal(h.tools.isEnabled(), false);
  assert.deepEqual(h.tools.pendingColorModes(), []);
  assert.equal(h.fields['grains-threshold'].value, '', 'no automatic threshold without a result');
  // No structure: the controls are disabled.
  h.setFrame(null); h.tools.setEnabled(true);
  assert.equal(h.fields['run-grains'].disabled, true);
  assert.equal(await h.tools.run(), false);
});

test('color buttons choose the grain ID and the two orientation modes', async t => {
  const h = harness(t);
  assert.equal(h.fields['grains-color-ipf'].disabled, true);
  h.bumpColor();
  h.fields['run-grains'].dispatch('click'); await h.settle();
  h.fields['grains-color-ipf'].dispatch('click'); h.fields['grains-color-rodrigues'].dispatch('click'); h.fields['grains-color-id'].dispatch('click');
  assert.deepEqual(h.modes, ['builtin:grains:ipf', 'builtin:grains:quaternion']);
  assert.deepEqual(h.selected, ['grainId', 'grainId']);
  assert.equal(h.fields['grains-color-ipf'].disabled, false);
});

test('settings serialize, restore and reject invalid recipes', async t => {
  const h = harness(t);
  assert.deepEqual(h.tools.serialize(), { enabled: false, algorithm: 'automatic', mergeThreshold: 0, mstThreshold: 2, minGrainSize: 100,
    adoptOrphans: true, handleCoherentInterfaces: true });
  const saved = createConfiguration({ settings: { activeTool: 'grains', display: { colorMode: 'builtin:grains:ipf' }, extensions: { grains: {
    enabled: true, algorithm: 'manual', mergeThreshold: 9.5, mstThreshold: 1.5, minGrainSize: 20, adoptOrphans: false, handleCoherentInterfaces: false } } } });
  const restoredRecipe = parseConfiguration(JSON.stringify(saved));
  assert.deepEqual(restoredRecipe, saved);
  assert.equal(restoredRecipe.settings.activeTool, 'grains');
  assert.equal(await h.tools.restore(restoredRecipe.settings.extensions.grains), true);
  assert.deepEqual(h.tools.serialize(), restoredRecipe.settings.extensions.grains);
  assert.deepEqual([h.fields['grains-algorithm'].value, h.fields['grains-threshold'].value, h.fields['grains-min-size'].value,
    h.fields['grains-orphans'].checked, h.fields['grains-interfaces'].checked], ['manual', '9.5', '20', false, false]);
  const frame = h.frames.values().next().value, result = frame.atomeyeResults.grains.result;
  assert.equal(result.algorithm, 'manual'); assert.equal(result.mergeThreshold, 9.5); assert.equal(result.minGrainSize, 20);
  assert.deepEqual(h.selected, [], 'a restored recipe keeps its own color choice');
  // Older recipes have no grain settings and leave the tool off.
  assert.equal(createConfiguration({}).settings.extensions.grains, undefined);
  assert.equal(await h.tools.restore(undefined), false);
  assert.equal(h.tools.isEnabled(), false);
  assert.deepEqual(h.tools.serialize(), { enabled: false, algorithm: 'automatic', mergeThreshold: 0, mstThreshold: 2, minGrainSize: 100,
    adoptOrphans: true, handleCoherentInterfaces: true });
  // Defaults fill a partial recipe; everything else is validated before any state changes.
  assert.deepEqual(createConfiguration({ settings: { extensions: { grains: { enabled: true } } } }).settings.extensions.grains,
    { enabled: true, algorithm: 'automatic', mergeThreshold: 0, mstThreshold: 2, minGrainSize: 100, adoptOrphans: true, handleCoherentInterfaces: true });
  for (const [grains, message] of [[{ algorithm: 'kmeans' }, /grains\.algorithm is unsupported/], [{ minGrainSize: 0 }, /grains\.minGrainSize/],
    [{ minGrainSize: 1.5 }, /grains\.minGrainSize/], [{ minGrainSize: '100' }, /grains\.minGrainSize/], [{ mergeThreshold: 'auto' }, /grains\.mergeThreshold/],
    [{ mergeThreshold: 1e7 }, /grains\.mergeThreshold/], [{ mstThreshold: -1 }, /grains\.mstThreshold/], [{ adoptOrphans: 'yes' }, /grains\.adoptOrphans/],
    [{ handleCoherentInterfaces: 1 }, /grains\.handleCoherentInterfaces/], [{ enabled: 'true' }, /grains\.enabled/], [{ script: 'alert(1)' }, /grains\.script/],
    [[], /grains/], ['manual', /grains/]]) {
    assert.throws(() => createConfiguration({ settings: { extensions: { grains } } }), message);
    assert.throws(() => parseConfiguration(JSON.stringify({ ...saved, settings: { ...saved.settings, extensions: { ...saved.settings.extensions, grains } } })), message);
  }
  assert.throws(() => parseConfiguration(JSON.stringify(saved).replace('"minGrainSize":20', '"minGrainSize":20,"__proto__":{"x":1}')), /Invalid AlloyView configuration/);
});

class ChartElement {
  constructor(root, tag) { this.ownerDocument = root; this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = new Map(); this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  dispatch(name, event = {}) { this.listeners.get(name)?.({ target: this, ...event }); }
  all(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.all(tag)]); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 360, height: 200 }; }
}
function chartContainer() {
  const root = { createElement: tag => new ChartElement(root, tag), createElementNS: (_, tag) => new ChartElement(root, tag) };
  return root.createElement('div');
}

test('the merge plot separates applied merges at the threshold and reports single merges', () => {
  const plot = { distance: Float64Array.of(8, 9, 10, 11, 14, 15), size: Uint32Array.of(20, 40, 200, 900, 60, 2000), unit: 'log' };
  const chart = chartContainer(), picked = [];
  renderGrainMergeChart(chart, plot, { threshold: 11, onSelect: value => picked.push(value) });
  const paths = chart.all('path'), classes = paths.map(path => path.attributes.class);
  const dots = path => path.attributes.d.match(/M/g).length;
  assert.equal(dots(paths[classes.indexOf('chart-points')]), 4, 'merges at or below the threshold');
  assert.equal(dots(paths[classes.indexOf('chart-points chart-points-rejected')]), 2);
  assert.equal(classes.filter(name => name === 'chart-threshold').length, 1);
  const texts = chart.all('text').map(text => text.textContent);
  for (const label of ['Merge size (atoms)', 'Log merge distance', 'Threshold 11', '10', '100', '1,000', '10,000']) assert.ok(texts.includes(label), label);
  // Two series: a legend names both; text is never the only carrier of the split.
  const legend = chart.all('p').find(node => node.className === 'chart-legend');
  assert.deepEqual(legend.children.map(entry => entry.children[1].textContent), ['Merged into grains (4)', 'Not merged (2)']);
  assert.deepEqual(legend.children.map(entry => entry.children[0].className), ['chart-key', 'chart-key chart-key-rejected']);
  const svg = chart.all('svg')[0], output = chart.all('output')[0];
  assert.match(svg.attributes['aria-label'], /6 merges; threshold 11/);
  assert.equal(output.textContent, 'Log merge distance 11 · merge size 900 atoms · merged', 'inspection starts at the last applied merge');
  // Keyboard steps through merges; the pointer picks the nearest point.
  svg.dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.equal(output.textContent, 'Log merge distance 14 · merge size 60 atoms · not merged');
  svg.dispatch('keydown', { key: 'Home', preventDefault() {} });
  assert.match(output.textContent, /^Log merge distance 8 · merge size 20 atoms/);
  svg.dispatch('keydown', { key: 'End', preventDefault() {} });
  assert.match(output.textContent, /merge size 2,000 atoms · not merged$/);
  svg.dispatch('pointermove', { clientX: 44, clientY: 150, pointerType: 'mouse' });
  assert.match(output.textContent, /^Log merge distance 8 /);
  svg.dispatch('pointermove', { clientX: 344, clientY: 20, pointerType: 'touch' });
  assert.match(output.textContent, /^Log merge distance 8 /, 'touch scrolling does not scrub');
  svg.dispatch('pointerdown', { clientX: 344, clientY: 20, pointerType: 'touch' });
  assert.match(output.textContent, /^Log merge distance 15 /);
  svg.dispatch('pointermove', { clientX: 10, clientY: 20, pointerType: 'mouse' });
  assert.match(output.textContent, /^Log merge distance 15 /, 'the axis margin is ignored');
  // A click reports the distance under the pointer.
  svg.dispatch('click', { clientX: 194, clientY: 80 });
  assert.equal(picked.length, 1);
  assert.ok(picked[0] > 11 && picked[0] < 12, String(picked[0]));
  // Degrees for the minimum spanning tree; no click handler for the automatic algorithm.
  const tree = chartContainer();
  renderGrainMergeChart(tree, { ...plot, distance: Float64Array.of(.2, .5, .9, 1.5, 2.5, 3.5), unit: 'degrees' }, { threshold: 1 });
  assert.match(tree.all('output')[0].textContent, /^Disorientation 0\.9° · merge size 200 atoms · merged$/);
  assert.ok(tree.all('text').some(text => text.textContent === 'Threshold 1°'));
  assert.equal(tree.all('svg')[0].listeners.has('click'), false);
  // No threshold: one series, no legend.
  const bare = chartContainer();
  renderGrainMergeChart(bare, plot);
  assert.equal(bare.all('p').length, 0);
  assert.equal(bare.all('path').filter(path => path.attributes.class === 'chart-threshold').length, 0);
  // No merges: an explanation instead of an empty frame.
  const empty = chartContainer();
  renderGrainMergeChart(empty, { distance: new Float64Array(0), size: new Uint32Array(0), unit: 'log' }, { threshold: 0 });
  assert.match(empty.all('p')[0].textContent, /No merges of clusters with at least 20 atoms/);
  renderGrainMergeChart(null, plot);
});

test('large merge plots are thinned but keep every merge near the grain boundaries', () => {
  assert.deepEqual(Array.from(grainChartPoints(5)), [0, 1, 2, 3, 4]);
  const kept = grainChartPoints(100_000);
  assert.equal(kept.length, GRAIN_CHART_MAX_POINTS);
  assert.ok(kept.every((index, slot) => slot === 0 || index > kept[slot - 1]), 'ascending and distinct');
  assert.deepEqual(Array.from(kept.subarray(kept.length - 2000)), Array.from({ length: 2000 }, (_, i) => 98_000 + i), 'the largest distances are all drawn');
  assert.equal(kept[0], 0);
  const count = 30_000, plot = { distance: Float64Array.from({ length: count }, (_, i) => 5 + i / 3000), size: Uint32Array.from({ length: count }, (_, i) => 20 + i), unit: 'log' };
  const chart = chartContainer();
  renderGrainMergeChart(chart, plot, { threshold: 14 });
  assert.match(chart.all('output')[0].textContent, /showing 12,000 of 30,000 merges$/);
  assert.match(chart.all('p')[0].children[0].children[1].textContent, /^Merged into grains \(27,001\)$/, 'the legend counts every merge');
});

function grainFrame() {
  // Six atoms: grains 1 (cubic, 10° about z), 2 (hexagonal, 20° about x), and two atoms of no grain.
  const grainId = Uint32Array.of(1, 1, 2, 0, 2, 0);
  const result = { grainId, grainCount: 2, sizes: Uint32Array.of(2, 2), structureTypes: Uint8Array.of(1, 2), rootStructureTypes: Uint8Array.of(1, 2),
    orientations: Float64Array.of(...axisAngleQuaternion([0, 0, 1], 10), ...axisAngleQuaternion([1, 0, 0], 20)), unassignedAtoms: 2, assignedAtoms: 4,
    adoptedAtoms: 0, meanSize: 2, largestSize: 2, mergeThreshold: 11.5, suggestedThreshold: 11.5, algorithm: 'automatic', minGrainSize: 2,
    adoptOrphans: false, handleCoherentInterfaces: true, plot: { distance: Float64Array.of(9, 11.5, 13), size: Uint32Array.of(25, 60, 30), unit: 'log' },
    elapsedMs: 3, engine: 'PTM + CPU · 1 Worker' };
  return { ids: Uint32Array.of(11, 12, 13, 14, 15, 16), types: new Uint16Array(6), typeLabels: ['Ni'], positions: new Float32Array(18), frameIndex: 0, timestep: 500,
    cell: { vectors: [10, 0, 0, 0, 10, 0, 0, 0, 12], origin: [0, 0, 0], pbc: [true, true, true] },
    properties: [{ name: 'grainId', displayName: 'Grain ID', unit: '', data: grainId, analysisKind: 'grains', analysisKey: 'k',
      categories: grainCategories(result), unlistedCategories: { label: 'Grain', legendLabel: 'Other grains', colors: GRAIN_COLORS } }],
    atomeyeResults: { grains: { key: 'k', result } } };
}

test('grain IDs color categorically with a neutral entry and one shared entry beyond the legend limit', () => {
  const frame = grainFrame(), property = frame.properties[0];
  assert.deepEqual(property.categories.map(category => [category.id, category.label, category.description]),
    [[0, 'No grain', 'Atoms that belong to no grain'], [1, 'Grain 1', '2 atoms, FCC'], [2, 'Grain 2', '2 atoms, HCP']]);
  const palette = colorsByCategory(property);
  assert.deepEqual(Array.from(palette.colors.subarray(0, 3)), GRAIN_COLORS[0]);
  assert.deepEqual(Array.from(palette.colors.subarray(6, 9)), GRAIN_COLORS[1]);
  assert.deepEqual(Array.from(palette.colors.subarray(9, 12)), GRAIN_NONE_COLOR);
  assert.deepEqual(palette.legend.items.map(item => [item.label, item.count]), [['No grain', 2], ['Grain 1', 2], ['Grain 2', 2]]);
  assert.deepEqual(Array.from(visibilityByCategory(property, new Set([0]))), [255, 255, 255, 0, 255, 0], 'atoms of no grain can be hidden');
  // Many grains: the first twenty are listed, the rest cycle colors under one entry.
  const many = { grainCount: 50, sizes: Uint32Array.from({ length: 50 }, (_, index) => 500 - index), structureTypes: new Uint8Array(50).fill(3), unassignedAtoms: 0 };
  const categories = grainCategories(many);
  assert.equal(categories.length, GRAIN_LEGEND_LIMIT);
  assert.equal(categories[0].description, '500 atoms, BCC');
  const ids = Uint32Array.from({ length: 50 }, (_, index) => index + 1);
  const crowded = colorsByCategory({ name: 'grainId', data: ids, categories, unlistedCategories: { label: 'Grain', legendLabel: 'Other grains', colors: GRAIN_COLORS } });
  assert.deepEqual(Array.from(crowded.colors.subarray(29 * 3, 30 * 3)), grainColor(30));
  assert.equal(crowded.legend.items.at(-1).id, UNLISTED_CATEGORY_ID);
  assert.equal(crowded.legend.items.at(-1).label, 'Other grains (30)');
  assert.deepEqual(grainCategories({ ...many, grainCount: 0, unassignedAtoms: 9 }).map(category => category.label), ['No grain']);
});

test('grain orientation colors give every atom the color of its grain mean', () => {
  const frame = grainFrame(), result = frame.atomeyeResults.grains.result, resolver = new OrientationColorResolver();
  assert.deepEqual(GRAIN_ORIENTATION_COLOR_MODES, ['builtin:grains:ipf', 'builtin:grains:quaternion']);
  assert.deepEqual(ORIENTATION_COLOR_MODES.slice(0, 2), ['builtin:ptm:ipf', 'builtin:ptm:quaternion'], 'the PTM modes keep their place');
  assert.ok(GRAIN_ORIENTATION_COLOR_MODES.every(mode => BUILTIN_COLOR_MODES.includes(mode) && !BUILTIN_SCALAR_COLOR_MODES.includes(mode)));
  const options = initialColorQuantities(frame).map(option => option.value);
  assert.ok(GRAIN_ORIENTATION_COLOR_MODES.every(mode => options.includes(mode)));
  assert.ok(!options.includes('builtin:ptm:ipf'), 'no PTM orientation without a PTM result');
  const ipf = resolver.resolve(frame, 'builtin:grains:ipf');
  const cubic = ipfColor(result.orientations.subarray(0, 4), 1, [0, 0, 1]), hexagonal = ipfColor(result.orientations.subarray(4, 8), 2, [0, 0, 1]);
  assert.deepEqual(Array.from(ipf.colors), [...cubic, ...cubic, ...hexagonal, ...UNDEFINED_ORIENTATION_COLOR, ...hexagonal, ...UNDEFINED_ORIENTATION_COLOR]);
  assert.deepEqual(cubic, [255, 0, 0], 'a rotation about z keeps [001] along z');
  assert.deepEqual({ kind: ipf.legend.kind, mode: ipf.legend.mode, title: ipf.legend.title, undefinedCount: ipf.legend.undefinedCount, atomCount: ipf.legend.atomCount },
    { kind: 'orientation', mode: 'ipf', title: 'Grain inverse pole figure · Z', undefinedCount: 2, atomCount: 6 });
  assert.deepEqual(ipf.legend.keys.map(key => key.family), ['cubic', 'hexagonal']);
  assert.equal(resolver.resolve(frame, 'builtin:grains:ipf'), ipf, 'the palette is retained');
  const along = resolver.resolve(frame, 'builtin:grains:ipf', { direction: 'x', custom: [0, 0, 1] });
  assert.notEqual(along, ipf);
  assert.deepEqual(Array.from(along.colors.subarray(0, 3)), ipfColor(result.orientations.subarray(0, 4), 1, [1, 0, 0]));
  const rodrigues = resolver.resolve(frame, 'builtin:grains:quaternion');
  assert.equal(rodrigues.legend.title, 'Grain orientation · Rodrigues RGB'); assert.deepEqual(rodrigues.legend.keys, []);
  assert.deepEqual(Array.from(rodrigues.colors.subarray(0, 3)), rodriguesColor(result.orientations.subarray(0, 4), 1));
  assert.deepEqual(Array.from(rodrigues.colors.subarray(6, 9)), rodriguesColor(result.orientations.subarray(4, 8), 2));
  assert.deepEqual(Array.from(rodrigues.colors.subarray(9, 12)), UNDEFINED_ORIENTATION_COLOR);
  // A stale or foreign result is not a color source.
  assert.equal(grainOrientationSource({ ...frame, properties: [] }), null);
  assert.equal(grainOrientationSource({ ...frame, properties: [{ ...frame.properties[0], data: Uint32Array.from(result.grainId) }] }), null, 'the property must be this result');
  assert.equal(grainOrientationSource({ ...frame, atomeyeResults: {} }), null);
  assert.equal(new OrientationColorResolver().resolve({ ...frame, properties: [] }, 'builtin:grains:ipf'), null);
  assert.equal(resolver.resolve(frame, 'builtin:ptm:ipf'), null, 'PTM modes need a PTM result');
  // The recipe accepts the modes for coloring but not for binning.
  assert.equal(createConfiguration({ settings: { display: { colorMode: 'builtin:grains:quaternion' } } }).settings.display.colorMode, 'builtin:grains:quaternion');
  assert.throws(() => createConfiguration({ settings: { extensions: { binning: { quantity: 'property', property: 'builtin:grains:ipf' } } } }), /built-in scalar quantity/);
});

test('grain volumes come from Voronoi atomic volumes, or from the mean atomic volume of a periodic cell', () => {
  const frame = grainFrame(), result = frame.atomeyeResults.grains.result;
  const mean = grainVolumes(frame, result);
  assert.equal(mean.source, 'mean');
  assert.deepEqual(Array.from(mean.volumes), [400, 400], '2 atoms × 1200 Å³ / 6 atoms');
  frame.properties.push({ name: 'atomicVolume', data: Float32Array.of(10, 11, 12, 13, 14, 15) });
  const voronoi = grainVolumes(frame, result);
  assert.equal(voronoi.source, 'voronoi');
  assert.deepEqual(Array.from(voronoi.volumes), [21, 26]);
  // An incomplete Voronoi result falls back; an open cell has no mean atomic volume.
  frame.properties.at(-1).data[2] = NaN;
  assert.equal(grainVolumes(frame, result).source, 'mean');
  frame.cell = { ...frame.cell, pbc: [true, true, false] };
  assert.equal(grainVolumes(frame, result), null);
});

test('grain tables, the merge plot and summary rows export as CSV', () => {
  assert.ok(STATISTICS_TABLES.includes('grains') && STATISTICS_TABLES.includes('grains-merge'));
  assert.equal(STATISTICS_EXPORT_BUTTONS['export-grain-table'], 'grains');
  assert.equal(STATISTICS_EXPORT_BUTTONS['export-grain-merges'], 'grains-merge');
  const frame = grainFrame(), result = frame.atomeyeResults.grains.result;
  Object.assign(result, { volumes: Float64Array.of(400, 400), volumeSource: 'mean' });
  const snapshot = { frame, fileName: 'poly crystal.dump', frameIndex: 0 };
  const table = buildStatisticsTable(snapshot, 'grains'), rows = [...table.rows];
  assert.equal(table.filename, 'poly crystal-frame-1-grains.csv');
  assert.deepEqual(table.columns, ['source_file', 'frame_number', 'timestep', 'grain_id', 'atom_count', 'atom_fraction', 'structure_type', 'structure_type_id',
    'orientation_w', 'orientation_x', 'orientation_y', 'orientation_z', 'euler_phi1 [°]', 'euler_Phi [°]', 'euler_phi2 [°]', 'axis_x', 'axis_y', 'axis_z', 'angle [°]',
    'volume [Å³]', 'volume_source']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].slice(0, 8), ['poly crystal.dump', 1, 500, 1, 2, 2 / 6, 'FCC', 1]);
  assert.deepEqual(rows[0].slice(8, 12), Array.from(result.orientations.subarray(0, 4)));
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
  // 10° about z: φ1 = 10, Φ = φ2 = 0; axis z.
  [10, 0, 0].forEach((angle, index) => close(rows[0][12 + index], angle));
  [0, 0, 1, 10].forEach((value, index) => close(rows[0][15 + index], value));
  assert.deepEqual(rows[0].slice(19), [400, 'atoms × mean atomic volume']);
  // 20° about x: Φ = 20.
  assert.deepEqual(rows[1].slice(3, 8), [2, 2, 2 / 6, 'HCP', 2]);
  quaternionBungeEuler(result.orientations, 4).forEach((angle, index) => close(rows[1][12 + index], angle));
  close(rows[1][13], 20); close(rows[1][15], 1); close(rows[1][18], 20);
  // Voronoi volumes are labeled as such; without volumes the cells are empty.
  result.volumeSource = 'voronoi';
  assert.equal([...buildStatisticsTable(snapshot, 'grains').rows][0].at(-1), 'Voronoi atomic volumes');
  delete result.volumes;
  assert.deepEqual([...buildStatisticsTable(snapshot, 'grains').rows][0].slice(19), ['', '']);
  const merges = buildStatisticsTable(snapshot, 'grains-merge');
  assert.equal(merges.filename, 'poly crystal-frame-1-grains-merge.csv');
  assert.deepEqual(merges.columns.slice(3), ['log_merge_distance', 'merge_size [atoms]', 'merged', 'threshold']);
  assert.deepEqual([...merges.rows].map(row => row.slice(3)), [[9, 25, true, 11.5], [11.5, 60, true, 11.5], [13, 30, false, 11.5]]);
  result.plot.unit = 'degrees'; result.algorithm = 'mst';
  assert.deepEqual(buildStatisticsTable(snapshot, 'grains-merge').columns.slice(3), ['disorientation [°]', 'merge_size [atoms]', 'merged', 'threshold [°]']);
  // The summary also counts the atoms of each listed grain, as for any categorical property.
  const summary = [...buildStatisticsTable(snapshot, 'summary').rows].filter(row => row[3] === 'grains' && !row[4].startsWith('grainId.')).map(row => row.slice(4));
  assert.deepEqual(summary.slice(0, 7), [['grain_count', '', 2, ''], ['mean_size', '', 2, 'atoms'], ['largest_size', '', 2, 'atoms'], ['assigned_atoms', '', 4, ''],
    ['unassigned_atoms', '', 2, ''], ['adopted_atoms', '', 0, ''], ['merge_threshold', '', 11.5, '°']]);
  assert.ok(summary.some(row => row[0] === 'algorithm' && row[2] === 'mst'));
  // Without a result the tables ask for the analysis.
  const bare = { frame: { ...frame, properties: [], atomeyeResults: {} }, fileName: 'a.dump' };
  assert.throws(() => buildStatisticsTable(bare, 'grains'), /Find grains before exporting the grain table/);
  assert.throws(() => buildStatisticsTable(bare, 'grains-merge'), /Find grains before exporting the merge distances/);
  assert.ok(![...buildStatisticsTable(bare, 'summary').rows].some(row => row[3] === 'grains'));
});

test('grain count and mean size are global attributes that match the summary CSV', () => {
  const frame = grainFrame(), registry = createAttributeRegistry({ frame, frameIndex: 0, frameCount: 3 });
  const names = registry.list().map(entry => entry.name).filter(name => name.startsWith('Grains.'));
  assert.deepEqual(names, ['Grains.grain_count', 'Grains.mean_size', 'Grains.largest_size', 'Grains.unassigned_atoms', 'Grains.merge_threshold']);
  assert.equal(registry.get('Grains.grain_count').value, 2);
  assert.equal(registry.get('Grains.mean_size').value, 2);
  assert.equal(registry.get('grains.GRAIN_COUNT').value, 2, 'names are matched without case');
  assert.deepEqual({ kind: registry.get('Grains.mean_size').kind, unit: registry.get('Grains.mean_size').unit, group: registry.get('Grains.mean_size').group },
    { kind: 'analysis', unit: 'atoms', group: 'Grains' });
  assert.equal(registry.get('Grains.merge_threshold').value, 11.5);
  // Every attribute names the summary row it equals.
  const summary = [...buildStatisticsTable({ frame, fileName: 'a.dump', frameIndex: 0 }, 'summary').rows];
  for (const name of names) {
    const entry = registry.get(name), [analysis, metric, label] = entry.csv;
    const row = summary.find(candidate => candidate[3] === analysis && candidate[4] === metric && candidate[5] === label);
    assert.ok(row, `${name} has a summary row`);
    assert.equal(row[6], entry.value, name);
  }
  // The per-grain atom counts come with the categorical property.
  assert.equal(registry.get('grainId.Grain_1.count').value, 2);
  assert.equal(registry.get('grainId.No_grain.fraction').value, 2 / 6);
  // No grain result, or file-only attributes: nothing.
  assert.equal(createAttributeRegistry({ frame: { ...frame, atomeyeResults: {} }, frameIndex: 0 }).has('Grains.grain_count'), false);
  assert.equal(createAttributeRegistry({ frame, frameIndex: 0, fileOnly: true }).has('Grains.grain_count'), false);
});
