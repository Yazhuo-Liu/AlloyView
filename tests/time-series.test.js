import assert from 'node:assert/strict';
import test from 'node:test';
import { collectFileSeries, MAX_TIME_SERIES, normalizeTimeSeriesState, recordRegistry, seriesAxis, seriesFrames, timeSeriesTable,
  TimeSeriesStore } from '../src/time-series.js';
import { initializeTimeSeries } from '../src/time-series-controls.js';
import { createGlobalAttributeSource } from '../src/global-attribute-source.js';
import { createAttributeRegistry } from '../src/global-attributes.js';
import { timeSeriesPanels } from '../src/render/time-series-chart.js';
import { serializeCsv } from '../src/statistics-export.js';
import { createCell } from '../src/data/model.js';
import { STRUCTURE_TYPES } from '../src/analysis/cna.js';
import { createConfiguration, parseConfiguration } from '../src/configuration.js';

/** Frame f: |a| = 10 (1 + 0.01 f), timestep 50 f, q = f + id mod 2. */
function frame(index, { timestep = true } = {}) {
  const count = 4;
  return { frameIndex: index, timestep: timestep ? 50 * index : null, ids: Uint32Array.from([1, 2, 3, 4]), types: new Uint16Array(count), typeLabels: ['Fe'],
    cell: createCell({ vectors: [10 * (1 + 0.01 * index), 0, 0, 0, 10, 0, 0, 0, 10] }), positions: new Float32Array(count * 3),
    properties: [{ name: 'q', unit: 'e', data: Float64Array.from([1, 2, 3, 4], id => index + id % 2) }] };
}

test('frame ranges, axes and CSV tables follow the chosen range', () => {
  assert.deepEqual(seriesFrames({ firstFrame: 1, lastFrame: null, stride: 3 }, 10), [1, 4, 7]);
  assert.deepEqual(seriesFrames({ firstFrame: 0, lastFrame: 4, stride: 2 }, 3), [0, 2]);
  assert.deepEqual(seriesFrames({ firstFrame: 5, lastFrame: 2 }, 10), []);
  assert.deepEqual(seriesFrames({ firstFrame: 0, stride: 0 }, 10), []);
  const store = new TimeSeriesStore();
  store.record(0, [{ name: 'Cell.a', value: 10, unit: 'Å' }], { timestep: 0 });
  store.record(2, [{ name: 'Cell.a', value: 10.2, unit: 'Å' }, { name: 'q', value: 2.5 }], { timestep: 100 });
  assert.deepEqual(seriesAxis(store, [0, 2], 'timestep'), { kind: 'timestep', label: 'Timestep', values: [0, 100] });
  assert.deepEqual(seriesAxis(store, [0, 1, 2], 'timestep').kind, 'frame', 'timesteps must exist for every frame');
  const table = timeSeriesTable(store, ['Cell.a', 'q'], [0, 1, 2], { fileName: 'dir/run.dump' });
  assert.equal(table.filename, 'run-time-series.csv');
  assert.equal(serializeCsv(table), 'source_file,frame_number,timestep,Cell.a [Å],q\r\ndir/run.dump,1,0,10,\r\ndir/run.dump,2,,,\r\ndir/run.dump,3,100,10.2,2.5\r\n');
  assert.deepEqual(timeSeriesPanels([{ name: 'a', unit: 'Å' }, { name: 'b', unit: '' }, { name: 'c', unit: 'Å' }]).map(panel => panel.series.map(item => item.name)), [['a', 'c'], ['b']],
    'different units never share a y axis');
  assert.equal(timeSeriesPanels([{ name: 'a', unit: '' }, { name: 'b', unit: '' }], { separatePanels: true }).length, 2);
});

test('a new analysis signature discards points computed with other settings', () => {
  const store = new TimeSeriesStore();
  store.record(0, [{ name: 'CNA.FCC.fraction', value: 0.9, signature: 'cna:adaptive', kind: 'analysis' }]);
  store.record(1, [{ name: 'CNA.FCC.fraction', value: 0.8, signature: 'cna:adaptive', kind: 'analysis' }]);
  const revision = store.revision;
  assert.equal(store.record(1, [{ name: 'CNA.FCC.fraction', value: 0.8, signature: 'cna:adaptive' }]), false, 'unchanged values are not a change');
  assert.equal(store.revision, revision);
  store.record(2, [{ name: 'CNA.FCC.fraction', value: 0.5, signature: 'cna:fixed', kind: 'analysis' }]);
  assert.equal(store.has('CNA.FCC.fraction', 0), false);
  assert.equal(store.value('CNA.FCC.fraction', 2), 0.5);
  store.record(3, [{ name: 'x', value: 'text' }, { name: 'y', value: null }]);
  assert.equal(store.describe('x'), null, 'only numbers are recorded');
});

test('background collection reads only missing frames, records file values and can be cancelled', async () => {
  const frames = [0, 1, 2, 3, 4].map(index => frame(index));
  const store = new TimeSeriesStore(), reads = [];
  const reference = frames[0].cell;
  const attributesFor = (item, index) => createAttributeRegistry({ frame: item, frameIndex: index, referenceCell: reference, referenceFrameIndex: 0, fileOnly: true });
  const controller = new AbortController();
  const collection = collectFileSeries({ store, frames: [0, 1, 2, 3, 4], names: ['Strain.a', 'Mean.q', 'Timestep'], signal: controller.signal,
    readFrame: async index => { reads.push(index); if (index === 2) controller.abort(); return frames[index]; }, attributesFor });
  await assert.rejects(collection, { name: 'AbortError' });
  assert.deepEqual(reads, [0, 1, 2]);
  assert.equal(store.has('Strain.a', 2), false, 'a cancelled frame is not recorded');
  assert.equal(store.value('Mean.q', 1), 1.5);
  reads.length = 0;
  const result = await collectFileSeries({ store, frames: [0, 1, 2, 3, 4], names: ['Strain.a', 'Mean.q', 'Timestep'],
    readFrame: async index => { reads.push(index); return frames[index]; }, attributesFor });
  assert.deepEqual(reads, [2, 3, 4], 'resumes with the frames still missing');
  assert.deepEqual(result, { read: 3, recorded: 9 });
  for (let index = 0; index < 5; index++) {
    assert.ok(Math.abs(store.value('Strain.a', index) - 0.01 * index) < 1e-15);
    assert.equal(store.value('Mean.q', index), index + 0.5);
    assert.equal(store.timesteps.get(index), 50 * index);
  }
  // A file without timesteps is read once; the absent value is remembered.
  const plain = new TimeSeriesStore(); reads.length = 0;
  const plainFrames = [0, 1].map(index => frame(index, { timestep: false }));
  const readPlain = async index => { reads.push(index); return plainFrames[index]; };
  await collectFileSeries({ store: plain, frames: [0, 1], names: ['Timestep', 'Cell.a'], readFrame: readPlain, attributesFor });
  await collectFileSeries({ store: plain, frames: [0, 1], names: ['Timestep', 'Cell.a'], readFrame: readPlain, attributesFor });
  assert.deepEqual(reads, [0, 1]);
  await assert.rejects(collectFileSeries({ store: new TimeSeriesStore(), frames: [0], names: ['Cell.a'], readFrame: async () => null, attributesFor }), /Frame 1 could not be read/);
  // Analysis values never come from a background registry.
  const analyzed = frame(0);
  analyzed.properties.push({ name: 'structureType', data: new Uint8Array(4).fill(1), categories: STRUCTURE_TYPES, analysisKind: 'cna' });
  const onlyFile = new TimeSeriesStore();
  await collectFileSeries({ store: onlyFile, frames: [0], names: ['CNA.FCC.fraction'], readFrame: async () => analyzed, attributesFor });
  assert.equal(onlyFile.has('CNA.FCC.fraction', 0), false);
  assert.equal(recordRegistry(onlyFile, createAttributeRegistry({ frame: analyzed, frameIndex: 0 }), 0, ['CNA.FCC.fraction']), true);
  assert.equal(onlyFile.value('CNA.FCC.fraction', 0), 1);
});

test('time-series settings are validated and round-trip through configurations', () => {
  const settings = { attributes: ['Timestep', 'CNA.FCC.fraction', 'Mean.c_stress[1]'], firstFrame: 1, lastFrame: 9, stride: 2, xAxis: 'timestep', separatePanels: true, autoCollect: true };
  assert.deepEqual(normalizeTimeSeriesState(settings), settings);
  assert.deepEqual(normalizeTimeSeriesState({}), { attributes: ['Cell.volume'], firstFrame: 0, lastFrame: null, stride: 1, xAxis: 'frame', separatePanels: false, autoCollect: false });
  for (const value of [{ attributes: Array.from({ length: MAX_TIME_SERIES + 1 }, (_, index) => `A${index}`) }, { attributes: ['a', 'a'] },
    { attributes: [''] }, { attributes: ['x'.repeat(257)] }, { attributes: ['bad\nname'] }, { attributes: [7] }, { attributes: 'Timestep' },
    { firstFrame: -1 }, { stride: 0 }, { firstFrame: 5, lastFrame: 2 }, { xAxis: 'time' }, { separatePanels: 'yes' }, { code: 'x' },
    JSON.parse('{"__proto__":{"polluted":1}}'), null, []]) {
    assert.throws(() => normalizeTimeSeriesState(value), /Invalid AlloyView configuration: settings\.extensions\.timeSeries/, JSON.stringify(value));
  }
  const labels = { labels: [{ id: 'label-1', enabled: true, text: 'Step [Timestep]\n[CNA.FCC.fraction:.1%]', position: 'top-left', offset: [0, 4],
    fontSize: 18, color: null, box: 'none', boxColor: '#ffffff' }], selectedId: 'label-1' };
  const recipe = createConfiguration({ source: { kind: 'file', format: 'lammps-dump', files: [{ name: 'run.dump', size: 10 }], frameIndex: 0, frameCount: 10 },
    settings: { activeTool: 'timeSeries', extensions: { textLabels: labels, timeSeries: settings, globalAttributes: { strainReferenceFrame: 3 } } } });
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.deepEqual(restored.settings.extensions.textLabels, labels);
  assert.deepEqual(restored.settings.extensions.timeSeries, settings);
  assert.deepEqual(restored.settings.extensions.globalAttributes, { strainReferenceFrame: 3 });
  assert.equal(restored.settings.activeTool, 'timeSeries');
  // Older recipes stay free of the new extensions.
  const old = parseConfiguration(JSON.stringify(createConfiguration({ settings: {} })));
  for (const key of ['textLabels', 'timeSeries', 'globalAttributes']) assert.equal(Object.hasOwn(old.settings.extensions, key), false);
  const source = { kind: 'file', format: 'lammps-dump', files: [{ name: 'run.dump', size: 10 }], frameIndex: 0, frameCount: 4 };
  assert.throws(() => createConfiguration({ source, settings: { extensions: { timeSeries: { ...settings, lastFrame: 4 } } } }), /timeSeries must use frames/);
  assert.throws(() => createConfiguration({ source, settings: { extensions: { globalAttributes: { strainReferenceFrame: 4 } } } }), /strainReferenceFrame/);
  assert.throws(() => createConfiguration({ settings: { extensions: { textLabels: { labels: [{ text: 'x\u0000' }] } } } }), /textLabels\.labels\[0\]\.text/);
});

class Element {
  constructor(id = '', value = '') {
    this.id = id; this.value = String(value); this.textContent = ''; this.hidden = false; this.checked = false; this.disabled = false; this.title = '';
    this.listeners = new Map(); this.attributes = new Map(); this.children = []; this.style = {}; this.dataset = {}; this.className = ''; this.max = '';
    this.classList = { toggle() {} };
  }
  get valueAsNumber() { return this.value.trim() === '' ? NaN : Number(this.value); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  dispatch(name) { return this.listeners.get(name)?.({ target: this }); }
}

function harness(t, { frameCount = 5 } = {}) {
  const ids = ['time-series-state', 'time-series-status', 'time-series-attribute', 'add-time-series-attribute', 'time-series-attribute-list',
    'time-series-attribute-options', 'time-series-first', 'time-series-last', 'time-series-stride', 'time-series-x-axis', 'time-series-separate',
    'time-series-strain-reference', 'collect-time-series', 'visit-time-series', 'cancel-time-series', 'export-time-series', 'clear-time-series',
    'time-series-progress', 'time-series-results', 'time-series-chart'];
  const fields = Object.fromEntries(ids.map(id => [id, new Element(id)]));
  fields['time-series-x-axis'].value = 'frame';
  const documentRoot = { activeElement: null, getElementById: id => fields[id] ?? null,
    createElement: tag => Object.assign(new Element(), { tag, ownerDocument: documentRoot }),
    createElementNS: (_, tag) => Object.assign(new Element(), { tag, ownerDocument: documentRoot }) };
  for (const element of Object.values(fields)) element.ownerDocument = documentRoot;
  const frames = Array.from({ length: frameCount }, (_, index) => frame(index));
  // Displayed frames carry an analysis result, as after CNA.
  const analyze = item => {
    if (!item.properties.some(property => property.name === 'structureType')) {
      item.properties.push({ name: 'structureType', data: Uint8Array.from([1, 1, 1, item.frameIndex % 2]), categories: STRUCTURE_TYPES, analysisKind: 'cna', analysisKey: 'k' });
    }
  };
  const view = { index: 0, displayed: [], reads: [] };
  analyze(frames[0]);
  const scheduled = [];
  const attributes = createGlobalAttributeSource({ getFrame: () => frames[view.index], getFrameIndex: () => view.index, getFrameCount: () => frameCount,
    getFrameAt: async index => { view.reads.push(index); return frames[index]; }, schedule: callback => scheduled.push(callback) });
  const downloads = [], notices = [];
  const series = initializeTimeSeries({ attributes, documentRoot, getFrame: () => frames[view.index], getFrameIndex: () => view.index,
    getFrameCount: () => frameCount, getFrameAt: async (index, { signal } = {}) => {
      view.reads.push(index);
      await Promise.resolve();
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      return frames[index];
    },
    showFrame: async index => { view.index = index; view.displayed.push(index); analyze(frames[index]); attributes.refresh(); flush(); return true; },
    getFileName: () => 'run.dump', notify: message => notices.push(message), onDownload: (blob, filename) => downloads.push({ blob, filename }) });
  function flush() { while (scheduled.length) scheduled.shift()(); }
  series.setEnabled(true);
  const add = name => { fields['time-series-attribute'].value = name; fields['add-time-series-attribute'].dispatch('click'); };
  t.after(() => series.reset());
  return { fields, series, attributes, view, add, flush, downloads, notices, frames };
}

test('time-series controls read file values without changing the displayed frame', async t => {
  const { fields, series, view, add, downloads } = harness(t);
  for (const button of [...fields['time-series-attribute-list'].children]) button.children.at(-1).dispatch('click');
  for (const name of ['Cell.a', 'Mean.q', 'CNA.FCC.fraction']) add(name);
  assert.deepEqual(series.serialize().attributes, ['Cell.a', 'Mean.q', 'CNA.FCC.fraction']);
  view.reads.length = 0;
  assert.equal(await series.collect(), true);
  assert.deepEqual(view.displayed, [], 'the displayed frame never changes');
  assert.deepEqual(view.reads.toSorted(), [1, 2, 3, 4], 'the displayed frame was recorded directly');
  const data = series.getData();
  assert.deepEqual(data.series[0].values, [10, 10.1, 10.2, 10.3, 10.4].map((value, index) => series.store.value('Cell.a', index)));
  assert.deepEqual(data.series[1].values, [0.5, 1.5, 2.5, 3.5, 4.5]);
  assert.deepEqual(data.series[2].values, [0.75, undefined, undefined, undefined, undefined], 'analysis values only for the analyzed frame');
  assert.equal(fields['time-series-state'].textContent, 'Partial');
  assert.match(fields['time-series-status'].textContent, /CNA\.FCC\.fraction \(4 missing, analysis\)/);
  // Visiting displays each missing frame once, then returns.
  assert.equal(await series.visit(), true);
  assert.deepEqual(view.displayed, [1, 2, 3, 4, 0]);
  assert.equal(view.index, 0);
  assert.deepEqual(series.getData().series[2].values, [0.75, 1, 0.75, 1, 0.75]);
  assert.equal(fields['time-series-state'].textContent, 'Complete');
  const table = await series.exportCsv();
  assert.equal(downloads[0].filename, 'run-time-series.csv');
  assert.equal(table.rows.length, 5);
  assert.equal(await downloads[0].blob.text(), serializeCsv(table));
});

test('cancelling a time-series collection keeps the values read so far', async t => {
  const { fields, series, view, add } = harness(t, { frameCount: 6 });
  add('Mean.q');
  const running = series.collect();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(series.isRunning(), true);
  assert.equal(fields['cancel-time-series'].disabled, false);
  fields['cancel-time-series'].dispatch('click');
  assert.equal(await running, false);
  assert.equal(series.isRunning(), false);
  assert.equal(fields['time-series-state'].textContent, 'Cancelled');
  const partial = series.getData().series.find(item => item.name === 'Mean.q').values.filter(Number.isFinite).length;
  assert.ok(partial >= 1 && partial < 6, `${partial} values kept`);
  assert.deepEqual(view.displayed, []);
  assert.equal(await series.collect(), true);
  assert.equal(series.getData().series.find(item => item.name === 'Mean.q').values.filter(Number.isFinite).length, 6);
});
