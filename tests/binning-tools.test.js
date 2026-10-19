import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeBinningTools, binningQuantityOptions, BINNING_DEFAULTS } from '../src/ui/analysis/binning-tools.js';
import { calculateSpatialBins } from '../src/analysis/spatial-binning.js';
import { buildStatisticsTable, serializeCsv } from '../src/io/statistics-export.js';
import { createConfiguration, parseConfiguration } from '../src/application/configuration.js';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { describeBin, niceRange, binningMapColors } from '../src/render/binning-chart.js';
import { compileScript, runScript } from '../src/application/command-script.js';
import { createScriptHost, waitUntilSettled } from '../src/ui/automation/script-controls.js';

class Element {
  constructor(value = '') {
    this.value = String(value); this.textContent = ''; this.hidden = false; this.checked = false; this.title = '';
    this.disabled = false; this.listeners = new Map(); this.attributes = new Map(); this.style = {}; this.className = '';
    this.classList = { toggle() {} }; this.children = [];
  }
  get valueAsNumber() { return this.value.trim() === '' ? NaN : Number(this.value); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  dispatch(name) { this.listeners.get(name)?.({ target: this }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

/** Two atoms per layer in eight layers along c, with an energy column. */
function layeredFrame({ shift = 0, energy = layer => -layer, frameIndex = 0 } = {}) {
  const cell = createCell({ vectors: [4, 0, 0, 0, 4, 0, 0, 0, 16] });
  const count = 16, fractional = new Float64Array(count * 3), data = new Float64Array(count);
  for (let atom = 0; atom < count; atom++) {
    const layer = atom >> 1;
    fractional.set([(atom & 1) * 0.5, 0.25, (layer + 0.5 + shift) / 8], atom * 3);
    data[atom] = energy(layer);
  }
  return { fractional, cell, positions: fractionalToCartesian(fractional, cell, new Float64Array(count * 3)), frameIndex, timestep: frameIndex * 10,
    ids: Uint32Array.from({ length: count }, (_, atom) => 101 + atom), types: new Uint16Array(count), typeLabels: ['Fe'],
    properties: [{ name: 'pe', unit: 'eV', data }, { name: 'structureType', data: new Uint8Array(count), categories: [{ id: 0, label: 'Other' }] }] };
}

function harness(t, { frames = [layeredFrame()], groups = [], readFrame = null } = {}) {
  const previousDocument = globalThis.document;
  const fields = {};
  for (const id of ['binning-state', 'binning-status', 'binning-backend', 'binning-progress', 'binning-results', 'binning-summary',
    'binning-geometry', 'binning-chart', 'binning-chart-title', 'run-binning', 'cancel-binning', 'export-binning', 'binning-second-axis',
    'binning-reduction-field', 'binning-scheme-field', 'binning-average-field', 'binning-selection', 'binning-color-scheme']) fields[id] = new Element();
  Object.assign(fields, { 'binning-mode': new Element('1d'), 'binning-axis-1': new Element('c'), 'binning-axis-2': new Element('a'),
    'binning-bins-1': new Element('8'), 'binning-bins-2': new Element('2'), 'binning-quantity': new Element('density'),
    'binning-reduction': new Element('mean'), 'binning-average-frames': new Element() });
  globalThis.document = { getElementById: id => fields[id] ?? null,
    createElement() { const element = new Element(); element.ownerDocument = this; return element; } };
  for (const element of Object.values(fields)) element.ownerDocument = globalThis.document;
  t.after(() => { globalThis.document = previousDocument; });
  let index = 0, version = 'a';
  let dependency = null;
  const charts = [], notifications = [], toolFlags = new Map(), loaded = [];
  const tools = initializeBinningTools({ tools: { setToolEnabled: (name, enabled) => toolFlags.set(name, enabled) },
    getFrame: () => frames[index], getFrameAt: async (frameIndex, options) => {
      loaded.push(frameIndex); return readFrame ? readFrame(frameIndex, options) : frames[frameIndex];
    },
    getFrameCount: () => frames.length, getSourceVersion: () => version, getFrameIndex: () => index,
    getSelectionGroups: () => groups, notify: message => notifications.push(message),
    getPropertyDependency: () => dependency,
    renderChart: (container, result, options) => charts.push({ container, result, options }) });
  tools.setEnabled(true);
  const change = (id, value) => {
    if (id === 'binning-average-frames') fields[id].checked = value; else fields[id].value = String(value);
    fields[id].dispatch('change');
  };
  return { tools, fields, charts, notifications, toolFlags, loaded, change, frames,
    setFrame(next) { index = next; }, setVersion(next) { version = next; }, setGroups(next) { groups = next; },
    setDependency(next) { dependency = next; } };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('quantity choices are the numeric Color by quantities', () => {
  const values = binningQuantityOptions(layeredFrame()).map(option => option.value);
  assert.deepEqual(values, ['builtin:position:x', 'builtin:position:y', 'builtin:position:z', 'property:pe']);
});

test('binning excludes orientation RGB color modes but retains scalar quaternion components', () => {
  const frame = layeredFrame();
  const structures = new Uint8Array(frame.ids.length).fill(1);
  frame.ptm = { structures, orientations: new Float64Array(frame.ids.length * 4) };
  frame.properties.push({ name: 'ptmStructureType', data: structures, categories: [{ id: 1, label: 'FCC' }] },
    { name: 'ptmOrientationW', data: new Float32Array(frame.ids.length).fill(1) });
  const values = binningQuantityOptions(frame).map(option => option.value);
  assert.ok(values.includes('property:ptmOrientationW'));
  assert.ok(!values.includes('property:ptmStructureType'));
  assert.ok(!values.includes('builtin:ptm:ipf'));
  assert.ok(!values.includes('builtin:ptm:quaternion'));
});

test('binning recipes reject orientation colors as scalar quantities', () => {
  for (const property of ['builtin:ptm:ipf', 'builtin:ptm:quaternion']) {
    assert.throws(() => createConfiguration({ settings: {
      extensions: { binning: { quantity: 'property', property } },
    } }), /built-in scalar quantity/);
  }
  assert.equal(createConfiguration({ settings: {
    extensions: { binning: { quantity: 'property', property: 'property:ptmOrientationW' } },
  } }).settings.extensions.binning.property, 'property:ptmOrientationW');
});

test('a profile follows the displayed frame and exports a CSV of every bin', async t => {
  const h = harness(t, { frames: [layeredFrame(), layeredFrame({ shift: 1, frameIndex: 1 })] });
  assert.equal(await h.tools.run(), true);
  assert.equal(h.fields['binning-state'].textContent, 'Calculated');
  assert.equal(h.toolFlags.get('binning'), true);
  const result = h.tools.getResult();
  assert.deepEqual([...result.values], Array(8).fill(2 / 32));
  assert.equal(result.valueLabel, 'Number density');
  assert.equal(result.unit, 'Å⁻³');
  assert.match(h.fields['binning-summary'].textContent, /8 bins along c · 16 atoms binned · frame 1/);
  assert.match(h.fields['binning-geometry'].textContent, /slab parallel to a and b, 2 Å wide along c/);
  assert.equal(h.charts.at(-1).result, result);

  const snapshot = { fileName: 'layers.xyz', frameIndex: 0, frame: { atomCount: 16, timestep: 0 }, results: h.tools.exportResults() };
  const csv = serializeCsv(buildStatisticsTable(snapshot, 'binning')).trim().split('\r\n');
  assert.equal(csv[0], 'source_file,frame_number,timestep,c_bin,c_lower_fraction,c_upper_fraction,c_lower [Å],c_upper [Å],c_center [Å],number_density [Å⁻³],atom_count,skipped_non_finite');
  assert.equal(csv.length, 9);
  assert.equal(csv[1], 'layers.xyz,1,0,1,0,0.125,0,2,1,0.0625,2,0');
  assert.equal(csv[8], 'layers.xyz,1,0,8,0.875,1,14,16,15,0.0625,2,0');
  assert.equal(buildStatisticsTable(snapshot, 'binning').filename, 'layers-frame-1-binning.csv');

  // Property means with the same settings on the next frame.
  h.change('binning-quantity', 'property:pe');
  await settle();
  assert.deepEqual([...h.tools.getResult().values], [0, -1, -2, -3, -4, -5, -6, -7]);
  assert.equal(h.tools.getResult().csvName, 'mean(pe)');
  h.setFrame(1);
  await h.tools.onFrame();
  // Shifted by one layer: layer 7 wraps into the first bin.
  assert.deepEqual([...h.tools.getResult().values], [-7, 0, -1, -2, -3, -4, -5, -6]);
  assert.equal(h.tools.getResult().frameIndex, 1);
  assert.deepEqual(h.tools.exportResults().binning.values, h.tools.getResult().values);
  h.setFrame(0);
  assert.deepEqual(h.tools.exportResults(), {}, 'a result is exported only for its own frame');
});

test('maps, reductions and selections; a missing property waits and recalculates when it appears', async t => {
  const frame = layeredFrame();
  const h = harness(t, { frames: [frame], groups: [{ id: 'top', name: 'Top', atomIds: [113, 114, 115, 116] }] });
  h.change('binning-mode', '2d');
  assert.equal(h.fields['binning-second-axis'].hidden, false);
  assert.equal(h.fields['binning-scheme-field'].hidden, false);
  await h.tools.run();
  const map = h.tools.getResult();
  assert.deepEqual(map.bins, [8, 2]);
  assert.equal(map.binVolume, 256 / 16);
  assert.deepEqual([...map.counts], Array(16).fill(1));
  h.change('binning-selection', 'top');
  await settle();
  assert.equal(h.tools.getResult().totals.binned, 4);
  assert.equal(h.tools.getResult().totals.excluded, 12);
  assert.match(h.fields['binning-summary'].textContent, /12 outside Top/);

  h.change('binning-mode', '1d');
  h.change('binning-selection', '');
  h.fields['binning-reduction'].value = 'stddev';
  h.setDependency({ name: 'Central symmetry', state: 'pending' });
  h.change('binning-quantity', 'property:csp');
  await settle();
  assert.equal(h.fields['binning-state'].textContent, 'Waiting');
  assert.deepEqual(h.tools.pendingKinds(), ['binning']);
  assert.equal(h.tools.getAutomationError(), null);
  assert.equal(h.tools.getResult(), null);
  // Refreshing without new data does not recalculate.
  const before = h.charts.length;
  await h.tools.refresh();
  assert.equal(h.charts.length, before);
  assert.equal(h.fields['binning-state'].textContent, 'Waiting');
  assert.ok(h.fields['binning-quantity'].children.some(option => option.value === 'property:csp' && /waiting/.test(option.textContent)));
  frame.properties.push({ name: 'csp', unit: '', data: Float64Array.from({ length: 16 }, (_, atom) => atom % 2 ? 3 : 1) });
  await h.tools.refresh();
  assert.equal(h.fields['binning-state'].textContent, 'Calculated');
  assert.deepEqual(h.tools.pendingKinds(), []);
  assert.deepEqual([...h.tools.getResult().values], Array(8).fill(1));
  assert.equal(h.tools.getResult().valueLabel, 'Standard deviation csp');
  await h.tools.refresh();
  assert.equal(h.charts.length, before + 1, 'an unchanged frame is not recalculated');

  h.change('binning-quantity', 'property:structureType');
  await settle();
  assert.equal(h.fields['binning-state'].textContent, 'Failed');
  assert.match(h.fields['binning-status'].textContent, /categorical/);
  h.change('binning-bins-1', '0');
  h.change('binning-quantity', 'count');
  await settle();
  assert.match(h.fields['binning-status'].textContent, /1–4,096 bins/);
  h.fields['cancel-binning'].dispatch('click');
  assert.equal(h.fields['binning-state'].textContent, 'Not calculated');
  assert.equal(h.toolFlags.get('binning'), false);
});

test('a trajectory average reads every frame once and survives frame changes', async t => {
  const frames = [0, 1, 2].map(index => layeredFrame({ shift: index, energy: layer => layer + index, frameIndex: index }));
  const h = harness(t, { frames });
  assert.equal(h.fields['binning-average-field'].hidden, false);
  h.change('binning-quantity', 'property:pe');
  h.change('binning-average-frames', true);
  await h.tools.run();
  assert.deepEqual(h.loaded, [0, 1, 2]);
  const average = h.tools.getResult();
  assert.equal(average.frames, 3);
  assert.equal(average.averaged, true);
  const pooled = { fractional: Float64Array.from(frames.flatMap(frame => [...frame.fractional])), cell: frames[0].cell };
  const expected = calculateSpatialBins(pooled, { axes: [2], bins: [8], quantity: 'property', reduction: 'mean',
    values: Float64Array.from(frames.flatMap(frame => [...frame.properties[0].data])) });
  for (let bin = 0; bin < 8; bin++) assert.ok(Math.abs(average.values[bin] - expected.values[bin]) < 1e-12);
  assert.match(h.fields['binning-summary'].textContent, /averaged over 3 frames/);
  h.setFrame(2);
  await h.tools.onFrame();
  await settle();
  assert.deepEqual(h.loaded, [0, 1, 2], 'changing the displayed frame reuses the average');
  assert.equal(h.tools.getResult().values, average.values);
  assert.ok(h.tools.exportResults().binning);
  const table = buildStatisticsTable({ fileName: 'run.dump', frameIndex: 2, frame: { atomCount: 16 }, results: h.tools.exportResults() }, 'binning');
  const rows = serializeCsv(table).trim().split('\r\n');
  assert.ok(rows[0].endsWith('mean(pe) [eV],atom_count,skipped_non_finite,frames_averaged'));
  assert.ok(rows[1].startsWith('run.dump,1-3,,1,'));
  assert.ok(rows[1].endsWith(',2,0,3'));
  assert.equal(table.filename, 'run-all-frames-binning.csv');
  // A new source version recalculates.
  h.setVersion('b');
  await h.tools.refresh();
  assert.deepEqual(h.loaded, [0, 1, 2, 0, 1, 2]);
  // Analysis outputs exist only in the displayed frame and cannot be averaged.
  frames[2].properties.push({ name: 'shear', data: new Float64Array(16) });
  h.change('binning-quantity', 'property:shear');
  await settle(); await settle();
  assert.equal(h.fields['binning-state'].textContent, 'Failed');
  assert.match(h.fields['binning-status'].textContent, /not available in frame 1/);
});

test('property edits invalidate completed averages before the updated values are attached', async t => {
  const frames = [layeredFrame({ energy: () => 1 }), layeredFrame({ frameIndex: 1, energy: () => 3 })];
  const h = harness(t, { frames });
  h.change('binning-quantity', 'property:pe');
  h.change('binning-average-frames', true);
  await h.tools.run();
  const first = h.tools.getResult();
  assert.deepEqual([...first.values], Array(8).fill(2));
  assert.equal(h.tools.invalidateProperties(['unrelated']), false);
  await h.tools.refresh();
  assert.equal(h.tools.getResult(), first);
  assert.deepEqual(h.loaded, [0, 1], 'unrelated imports preserve the cached average');

  assert.equal(h.tools.invalidateProperties(['property:PE']), true);
  assert.equal(h.tools.getResult(), null);
  assert.deepEqual(h.tools.exportResults(), {});
  assert.deepEqual(h.loaded, [0, 1], 'invalidation does not read partially reattached inputs');
  for (const frame of frames) frame.properties[0] = { ...frame.properties[0],
    externalImportId: 'replacement', externalPropertyVersion: 2, data: new Float64Array(16).fill(10) };
  await h.tools.refresh();
  assert.deepEqual([...h.tools.getResult().values], Array(8).fill(10));
  assert.deepEqual(h.loaded, [0, 1, 0, 1]);
  await h.tools.run();
  assert.deepEqual(h.loaded, [0, 1, 0, 1], 'manual reruns still reuse the new complete average');

  h.tools.invalidateProperties(['pe']);
  for (const frame of frames) frame.properties = frame.properties.filter(property => property.name !== 'pe');
  await h.tools.refresh();
  assert.equal(h.fields['binning-state'].textContent, 'Failed');
  assert.equal(h.tools.getResult(), null);
  assert.deepEqual(h.tools.exportResults(), {}, 'removing the averaged column cannot export its previous values');
});

test('property invalidation cancels an average and rejects late partials from its old column', async t => {
  const frames = [layeredFrame({ energy: () => 1 }), layeredFrame({ frameIndex: 1, energy: () => 3 })];
  let release, oldSignal, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(t, { frames, readFrame: async (index, { signal }) => {
    if (index === 1 && !held) { held = true; oldSignal = signal; await gate; }
    return frames[index];
  } });
  h.change('binning-quantity', 'property:pe');
  h.change('binning-average-frames', true);
  const original = h.tools.run();
  await settle();
  assert.deepEqual(h.loaded, [0, 1]);
  assert.equal(h.tools.invalidateProperties(['unrelated']), false);
  await h.tools.refresh();
  assert.equal(oldSignal.aborted, false);
  assert.deepEqual(h.loaded, [0, 1], 'unrelated edits also preserve ongoing work');

  assert.equal(h.tools.invalidateProperties(['pe']), true);
  assert.equal(oldSignal.aborted, true);
  frames.forEach((frame, index) => { frame.properties[0] = { ...frame.properties[0], data: new Float64Array(16).fill((index + 1) * 10) }; });
  await h.tools.refresh();
  const result = h.tools.getResult();
  assert.deepEqual([...result.values], Array(8).fill(15));
  release();
  assert.equal(await original, false);
  assert.equal(h.tools.getResult(), result, 'a reader ignoring cancellation cannot publish old or mixed partials');
  assert.equal(h.charts.length, 1);
  assert.deepEqual(h.tools.pendingKinds(), []);
});

test('column invalidation preserves density, counts and coordinate averages', async t => {
  const h = harness(t, { frames: [layeredFrame(), layeredFrame({ frameIndex: 1 })] });
  h.change('binning-average-frames', true);
  for (const quantity of ['density', 'count', 'builtin:position:z']) {
    h.change('binning-quantity', quantity);
    await h.tools.run();
    const result = h.tools.getResult(), reads = h.loaded.length;
    assert.equal(h.tools.invalidateProperties(), false);
    await h.tools.refresh();
    assert.equal(h.tools.getResult(), result);
    assert.equal(h.loaded.length, reads);
  }
});

test('speed averages refresh after imported velocity components change or disappear', async t => {
  const frames = [layeredFrame(), layeredFrame({ frameIndex: 1 })];
  frames.forEach((frame, index) => frame.properties.push(...['vx', 'vy', 'vz'].map((name, axis) => ({
    name, data: new Float64Array(frame.ids.length).fill(axis ? 0 : index + 1), externalImportId: 'velocity', externalPropertyVersion: 1,
  }))));
  const h = harness(t, { frames });
  h.change('binning-quantity', 'builtin:velocity:magnitude');
  h.change('binning-average-frames', true);
  await h.tools.run();
  assert.deepEqual([...h.tools.getResult().values], Array(8).fill(1.5));
  assert.equal(h.tools.invalidateProperties([]), false, 'an empty change list preserves the average');
  assert.equal(h.tools.invalidateProperties(['vx']), true);
  assert.equal(h.tools.getResult(), null);
  frames.forEach((frame, index) => {
    const property = frame.properties.find(property => property.name === 'vx');
    property.data = new Float64Array(frame.ids.length).fill((index + 1) * 10);
    property.externalPropertyVersion++;
  });
  await h.tools.refresh();
  assert.deepEqual([...h.tools.getResult().values], Array(8).fill(15));
  for (const frame of frames) frame.properties = frame.properties.filter(property => property.name !== 'vx');
  assert.equal(h.tools.invalidateProperties(['vx']), true, 'removal still invalidates after the velocity family disappears');
  await h.tools.refresh();
  assert.equal(h.tools.getResult(), null);
  assert.deepEqual(h.tools.exportResults(), {});
  assert.equal(h.fields['binning-state'].textContent, 'Failed');
});

for (const kind of ['expression', 'centrosymmetry']) {
  test(`trajectory averages reject cached ${kind} columns while single-frame binning remains available`, async t => {
    const frames = [layeredFrame({ energy: () => 1 }), layeredFrame({ frameIndex: 1, energy: () => 3 })];
    Object.assign(frames[1].properties[0], { analysisKind: kind, analysisKey: 'cached-result' });
    const h = harness(t, { frames });
    h.setFrame(1);
    h.change('binning-quantity', 'property:pe');
    assert.equal(await h.tools.run(), true);
    assert.deepEqual([...h.tools.getResult().values], Array(8).fill(3));
    h.setFrame(0); await h.tools.onFrame();
    h.change('binning-average-frames', true);
    assert.equal(await h.tools.run(), false, 'a cached result on another frame is not an authoritative trajectory column');
    assert.equal(h.tools.getResult(), null);
    assert.deepEqual(h.tools.exportResults(), {});
    assert.equal(h.fields['binning-state'].textContent, 'Failed');
    assert.match(h.fields['binning-status'].textContent, /analysis|expression/);
  });
}

test('editing group members replaces an in-flight average without publishing old partials', async t => {
  const frames = [layeredFrame(), layeredFrame({ frameIndex: 1 })];
  let release, firstSignal, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(t, { frames, groups: [{ id: 'top', name: 'Top', atomIds: [101] }],
    readFrame: async (index, { signal }) => {
      if (reads++ === 0) { firstSignal = signal; await gate; }
      return frames[index];
    } });
  h.change('binning-selection', 'top');
  h.change('binning-quantity', 'count');
  h.change('binning-average-frames', true);
  const original = h.tools.run();
  await settle();
  assert.deepEqual(h.loaded, [0]);
  await h.tools.refresh();
  assert.equal(firstSignal.aborted, false, 'an unchanged refresh keeps the pending frame read');
  assert.deepEqual(h.loaded, [0]);

  h.setGroups([{ id: 'top', name: 'Top', atomIds: [113, 114, 115, 116] }]);
  const replacement = h.tools.refresh();
  assert.equal(firstSignal.aborted, true, 'membership changes cancel the old average');
  assert.equal(await replacement, true);
  const result = h.tools.getResult();
  assert.equal(result.totals.binned, 8);
  assert.deepEqual([...result.counts], [0, 0, 0, 0, 0, 0, 2, 2]);
  assert.equal(h.tools.exportResults().binning.totals.binned, 8);
  release();
  assert.equal(await original, false, 'even a reader that ignores cancellation cannot publish old work');
  assert.equal(h.tools.getResult(), result);
  assert.equal(h.charts.length, 1);
  assert.deepEqual(h.tools.pendingKinds(), []);
});

test('removing the selected group cancels averaging and clears exportable results', async t => {
  const frames = [layeredFrame(), layeredFrame({ frameIndex: 1 })];
  let release, firstSignal;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(t, { frames, groups: [{ id: 'top', name: 'Top', atomIds: [101] }],
    readFrame: async (index, { signal }) => { firstSignal = signal; await gate; return frames[index]; } });
  h.change('binning-selection', 'top');
  h.change('binning-average-frames', true);
  const original = h.tools.run();
  await settle();
  h.setGroups([]);
  assert.equal(await h.tools.refresh(), false);
  assert.equal(firstSignal.aborted, true);
  assert.equal(h.fields['binning-state'].textContent, 'Failed');
  assert.match(h.fields['binning-status'].textContent, /group no longer exists/);
  assert.equal(h.tools.getResult(), null);
  assert.deepEqual(h.tools.exportResults(), {});
  release();
  assert.equal(await original, false);
  assert.equal(h.charts.length, 0);
  assert.deepEqual(h.tools.pendingKinds(), []);
});

test('settings serialize, validate and restore through configurations', async t => {
  const h = harness(t, { groups: [{ id: 'top', name: 'Top', atomIds: [113] }] });
  assert.deepEqual(h.tools.serialize(), { enabled: false, mode: '1d', axes: ['c', 'a'], bins: [8, 2], quantity: 'density', property: null,
    reduction: 'mean', selectionGroupId: null, averageFrames: false, colorScheme: 'viridis' });
  const saved = { enabled: true, mode: '2d', axes: ['b', 'c'], bins: [4, 3], quantity: 'property', property: 'builtin:position:z',
    reduction: 'max', selectionGroupId: 'top', averageFrames: false, colorScheme: 'magma' };
  const selectionGroups = { groups: [{ id: 'top', name: 'Top', color: '#22c1c3', visible: true, atomIds: [113] }], selectedGroupId: null };
  const configuration = createConfiguration({ settings: { selectionGroups, extensions: { binning: saved } } });
  assert.deepEqual(configuration.settings.extensions.binning, saved);
  const parsed = parseConfiguration(JSON.stringify(configuration));
  assert.deepEqual(parsed.settings.extensions.binning, saved);
  assert.equal(parsed.settings.activeTool, 'display');
  assert.equal(parseConfiguration(JSON.stringify({ ...configuration, settings: { ...configuration.settings, activeTool: 'binning' } })).settings.activeTool, 'binning');
  // Older recipes have no binning entry and gain none.
  const legacy = createConfiguration({ settings: {} });
  assert.equal('binning' in legacy.settings.extensions, false);
  assert.equal('binning' in parseConfiguration(JSON.stringify(legacy)).settings.extensions, false);
  const invalid = changes => () => parseConfiguration(JSON.stringify({ ...configuration, settings: { ...configuration.settings,
    extensions: { ...configuration.settings.extensions, binning: { ...saved, ...changes } } } }));
  assert.throws(invalid({ axes: ['a', 'a'] }), /two different cell vectors/);
  assert.throws(invalid({ axes: ['x', 'a'] }), /axes\[0\] is unsupported/);
  assert.throws(invalid({ bins: [0, 3] }), /bins\[0\]/);
  assert.throws(invalid({ bins: [4096, 4096] }), /must not exceed/);
  assert.throws(invalid({ quantity: 'mass' }), /quantity is unsupported/);
  assert.throws(invalid({ property: null }), /property is required/);
  assert.throws(invalid({ property: 'eval(1)' }), /property must be a property: key/);
  assert.throws(invalid({ property: 'property:__proto__' }), /reserved/);
  assert.throws(invalid({ reduction: 'median' }), /reduction is unsupported/);
  assert.throws(invalid({ selectionGroupId: 'gone' }), /must identify a saved selection group/);
  assert.throws(invalid({ colorScheme: 'jet' }), /colorScheme is unsupported/);
  assert.throws(invalid({ extra: 1 }), /extra is not a supported setting/);

  await h.tools.restore(parsed.settings.extensions.binning);
  assert.equal(h.fields['binning-mode'].value, '2d');
  assert.equal(h.fields['binning-axis-1'].value, 'b');
  assert.equal(h.fields['binning-bins-2'].value, '3');
  assert.equal(h.fields['binning-color-scheme'].value, 'magma');
  assert.equal(h.fields['binning-selection'].value, 'top');
  assert.equal(h.fields['binning-state'].textContent, 'Calculated');
  const result = h.tools.getResult();
  assert.equal(result.valueLabel, 'Maximum Position Z (wrapped)');
  assert.equal(result.totals.binned, 1);
  assert.deepEqual(h.tools.serialize(), saved);
  h.tools.reset();
  assert.deepEqual(h.tools.serialize(), { enabled: false, ...BINNING_DEFAULTS, axes: ['a', 'b'], bins: [50, 50] });
});

test('chart helpers format bins, nice limits and palette colors', () => {
  assert.deepEqual(niceRange(0.03, 0.97), [0, 1]);
  assert.deepEqual(niceRange(2, 2, { zero: true }), [0, 2]);
  const [low, high] = niceRange(5, 5);
  assert.ok(Math.abs(low - 4.6) < 1e-12 && Math.abs(high - 5.4) < 1e-12, 'a constant profile is centered in a padded range');
  assert.deepEqual(niceRange(-3.2, 1.1), [-4, 2]);
  assert.deepEqual(niceRange(0, 0, { zero: true }), [0, 1]);
  const result = calculateSpatialBins(layeredFrame(), { axes: [2, 0], bins: [4, 2], quantity: 'count' });
  assert.equal(result.values.length, 8);
  const { text } = describeBin(result, 3, { valueLabel: 'Atom count' });
  assert.equal(text, 'c bin 2 of 4: 4–8 Å · a bin 2 of 2: 2–4 Å · Atom count 2 · 2 atoms');
  const { colors, legend } = binningMapColors(Float64Array.from([0, 1, NaN]), 'grayscale');
  assert.deepEqual([...colors], [32, 35, 38, 244, 244, 240, 130, 130, 130]);
  assert.equal(legend.minimum, 0);
  assert.equal(binningMapColors(Float64Array.from([NaN])).legend, null);
});

test('missing quantities without a producer become terminal and fail automation with a useful reason', async t => {
  const h = harness(t);
  await h.tools.restore({ ...BINNING_DEFAULTS, enabled: true, quantity: 'property', property: 'property:does_not_exist' });
  assert.equal(h.fields['binning-state'].textContent, 'Unavailable');
  assert.match(h.fields['binning-status'].textContent, /does_not_exist.*No active calculation will produce it/);
  assert.deepEqual(h.tools.pendingKinds(), []);
  assert.deepEqual(h.tools.failed(), ['binning']);
  assert.equal(h.tools.getResult(), null);
  assert.deepEqual(h.tools.exportResults(), {});
  assert.equal(h.fields['run-binning'].disabled, false, 'the missing input can be retried');
  let polls = 0, slept = 0;
  const analysesSettled = () => { polls++; return { settled: true, error: h.tools.getAutomationError() }; };
  await assert.rejects(waitUntilSettled(analysesSettled, { sleep: async () => { slept++; } }), /Binning: does_not_exist.*No active calculation/);
  assert.equal(polls, 1); assert.equal(slept, 0, 'an impossible dependency never starts an indefinite wait');
  const host = createScriptHost({ analysesSettled, sleep: async () => { slept++; } });
  const { program, problems } = compileScript('wait 0\nwait-analyses\nexport png');
  assert.deepEqual(problems, []);
  await assert.rejects(runScript(program, host, { sleep: async () => {} }), { name: 'ScriptError', line: 2, message: /Binning: does_not_exist/ });
  h.tools.cancel();
  assert.equal(h.tools.getAutomationError(), null);
  await waitUntilSettled(analysesSettled, { sleep: async () => {} });
});

test('producer cancellation wakes missing-quantity status, and later properties or frames retry without polling', async t => {
  const h = harness(t, { frames: [layeredFrame(), layeredFrame({ frameIndex: 1 })] });
  h.setDependency({ state: 'pending', name: 'Central symmetry' });
  await h.tools.restore({ ...BINNING_DEFAULTS, enabled: true, quantity: 'property', property: 'property:csp' });
  assert.equal(h.fields['binning-state'].textContent, 'Waiting');
  assert.deepEqual(h.tools.pendingKinds(), ['binning']);
  assert.equal(h.tools.getAutomationError(), null);
  h.setDependency({ state: 'unavailable', name: 'Central symmetry', message: 'Central symmetry was cancelled.' });
  await h.tools.refresh();
  assert.equal(h.fields['binning-state'].textContent, 'Unavailable');
  assert.deepEqual(h.tools.pendingKinds(), []);
  assert.match(h.tools.getAutomationError(), /Central symmetry was cancelled/);
  h.frames[0].properties.push({ name: 'csp', data: new Float64Array(16).fill(7) });
  await h.tools.refresh();
  assert.equal(h.fields['binning-state'].textContent, 'Calculated');
  assert.equal(h.tools.getAutomationError(), null);
  assert.ok([...h.tools.getResult().values].filter(Number.isFinite).every(value => value === 7));
  assert.equal(h.tools.getResult().totals.binned, 16);
  h.setFrame(1); h.setDependency(null);
  await h.tools.onFrame();
  assert.equal(h.fields['binning-state'].textContent, 'Unavailable');
  assert.equal(h.tools.getResult(), null, 'a result from the old frame cannot satisfy a missing input');
  h.tools.cancel();
  h.setDependency({ state: 'pending', name: 'Central symmetry' });
  await h.tools.refresh();
  assert.equal(h.fields['binning-state'].textContent, 'Not calculated', 'dependency notifications cannot revive a cancelled binning tool');
});
