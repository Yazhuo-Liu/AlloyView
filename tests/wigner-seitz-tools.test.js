import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeWignerSeitzTools, wignerSeitzExportSites, wignerSeitzMarkers, WIGNER_SEITZ_PROPERTIES } from '../src/wigner-seitz-tools.js';
import { calculateWignerSeitz, WIGNER_SEITZ_SITE_CLASSES } from '../src/analysis/wigner-seitz.js';
import { SiteMarkerLayer, normalizeSiteMarkerOptions, siteMarkerDisplayCoordinates } from '../src/render/site-marker-layer.js';
import { buildStatisticsTable, serializeCsv } from '../src/statistics-export.js';
import { createConfiguration, parseConfiguration } from '../src/configuration.js';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

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

/** B2 FeNi reference (frame 0) and a defective current frame (frame 1):
 * one vacancy (site 3), a swapped Fe–Ni pair (sites 5 and 6, current rows 4
 * and 5 after the removal) and one extra atom near site 10. */
function frames() {
  const base = crystalFrame('bcc', 3, 2.87);
  const reference = { ...base, types: Uint16Array.from({ length: base.ids.length }, (_, atom) => atom % 2), typeLabels: ['Fe', 'Ni'],
    positions: fractionalToCartesian(base.fractional, base.cell, new Float64Array(base.fractional.length)) };
  const rows = [];
  for (let atom = 0; atom < reference.ids.length; atom += 1) if (atom !== 3) rows.push(atom);
  const count = rows.length + 1, fractional = new Float64Array(count * 3), types = new Uint16Array(count);
  rows.forEach((atom, index) => { fractional.set(reference.fractional.subarray(atom * 3, atom * 3 + 3), index * 3); types[index] = reference.types[atom]; });
  [types[4], types[5]] = [types[5], types[4]];
  fractional.set([reference.fractional[30] + .2 / 8.61, reference.fractional[31] + .25 / 8.61, reference.fractional[32]], rows.length * 3);
  const current = { ...reference, ids: Uint32Array.from({ length: count }, (_, atom) => atom + 1), fractional, types,
    positions: fractionalToCartesian(fractional, reference.cell, new Float64Array(count * 3)), properties: [] };
  return { reference: { ...reference, properties: [] }, current };
}

function harness(t, { frameCount = 2 } = {}) {
  const previousDocument = globalThis.document;
  const fields = {};
  for (const id of ['wigner-seitz-state', 'wigner-seitz-status', 'wigner-seitz-backend', 'wigner-seitz-progress', 'wigner-seitz-results',
    'wigner-seitz-summary', 'run-wigner-seitz', 'cancel-wigner-seitz', 'wigner-seitz-table-body', 'wigner-seitz-color-class',
    'wigner-seitz-color-occupancy', 'wigner-seitz-marker-status', 'wigner-seitz-marker-legend']) fields[id] = new Element();
  fields['wigner-seitz-reference-frame'] = new Element('1');
  fields['wigner-seitz-affine'] = new Element();
  fields['wigner-seitz-markers'] = new Element('vacancies');
  fields['wigner-seitz-show-markers'] = new Element(); fields['wigner-seitz-show-markers'].checked = true;
  fields['wigner-seitz-marker-radius'] = new Element('0.6');
  globalThis.document = { getElementById: id => fields[id] ?? null,
    createElement() { const element = new Element(); element.ownerDocument = this; return element; },
    createTextNode: text => text };
  for (const element of Object.values(fields)) element.ownerDocument = globalThis.document;
  t.after(() => { globalThis.document = previousDocument; });
  const { reference, current } = frames();
  const trajectory = [reference, current];
  let index = 1, version = 'a', colorVersion = 0;
  const pending = [], selected = [], changes = [], notifications = [], toolFlags = new Map(), markerCalls = [];
  const renderer = { frame: current, siteMarkers: null, setSiteMarkers(markers, options) { markerCalls.push({ markers, options }); this.siteMarkers = markers; } };
  const pool = { analyze(frame, settings, options) { return new Promise((resolve, reject) => pending.push({ frame, settings, options, resolve, reject })); } };
  const tools = initializeWignerSeitzTools({ renderer, pool, tools: { setToolEnabled: (name, enabled) => toolFlags.set(name, enabled) },
    getFrame: () => trajectory[index], getFrameAt: async frame => trajectory[frame], getFrames: () => new Set(trajectory),
    getFrameCount: () => frameCount, getFrameIndex: () => index, getSourceVersion: () => version, getColorChoiceVersion: () => colorVersion,
    chooseProperty: name => selected.push(name), onResultsChange: change => changes.push(change), notify: message => notifications.push(message) });
  tools.setEnabled(true);
  const settle = async (at = pending.length - 1) => {
    await new Promise(resolve => setImmediate(resolve));
    const { frame, settings } = pending[at];
    const result = calculateWignerSeitz(frame, { fractional: settings.referenceFractional, cell: settings.referenceCell, types: settings.referenceTypes,
      typeLabels: settings.referenceTypeLabels }, { affineMapping: settings.affineMapping });
    pending[at].resolve({ ...result, workerCount: 2, backend: 'cpu', engine: 'js-worker-pool×2', elapsedMs: 4 });
  };
  return { tools, fields, pending, selected, changes, notifications, toolFlags, settle, renderer, markerCalls, reference, current,
    setIndex(next) { index = next; renderer.frame = trajectory[next]; }, setVersion(next) { version = next; } };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('calculation publishes per-atom outputs, vacancy markers, a table and the defect-class color', async t => {
  const h = harness(t);
  const task = h.tools.run();
  await flush();
  assert.equal(h.pending.length, 1);
  const { settings } = h.pending[0];
  assert.equal(settings.kind, 'wignerSeitz'); assert.equal(settings.affineMapping, false);
  assert.strictEqual(settings.referenceFractional, h.reference.fractional);
  assert.deepEqual(h.tools.pendingKinds(), ['wignerSeitz']);
  assert.deepEqual(h.tools.pendingColorProperties().map(entry => entry.name), WIGNER_SEITZ_PROPERTIES.map(entry => entry.name));
  await h.settle();
  assert.equal(await task, true);
  const names = h.current.properties.map(property => property.name);
  assert.deepEqual(names, ['wsOccupancy', 'wsDefectClass', 'wsSiteType', 'wsSiteIndex', 'wsDistance']);
  const classes = h.current.properties.find(property => property.name === 'wsDefectClass');
  assert.deepEqual(classes.categories.map(category => category.label), ['Regular', 'Interstitial', 'Antisite']);
  assert.ok(h.current.properties.every(property => property.analysisKind === 'wignerSeitz' && property.data.length === h.current.ids.length));
  assert.deepEqual(h.current.properties.find(property => property.name === 'wsSiteType').categories.map(category => category.label), ['Fe', 'Ni']);
  assert.equal(h.fields['wigner-seitz-state'].textContent, 'Calculated');
  assert.match(h.fields['wigner-seitz-summary'].textContent, /^1 vacancy · 1 interstitial · 2 antisites · 54 atoms on 54 sites of frame 1/);
  assert.equal(h.fields['wigner-seitz-table-body'].children.length, 3, 'Fe, Ni and the total');
  assert.deepEqual(h.selected, ['wsDefectClass']);
  assert.equal(h.toolFlags.get('wignerSeitz'), true);
  const markers = h.renderer.siteMarkers;
  assert.equal(markers.sites.length, 1);
  assert.equal(markers.sites[0], 3);
  assert.deepEqual(Array.from(markers.colors), WIGNER_SEITZ_SITE_CLASSES[0].color);
  assert.deepEqual(Array.from(markers.positions), Array.from(h.reference.positions.subarray(9, 12)));
  assert.deepEqual(h.markerCalls.at(-1).options, { visible: true, radius: .6 });
  assert.equal(h.fields['wigner-seitz-legend']?.children?.length ?? h.fields['wigner-seitz-marker-legend'].children.length, 4);
  assert.match(h.fields['wigner-seitz-marker-status'].textContent, /^1 vacant site drawn at reference positions/);
});

test('marker choices update the display without recalculating; frames and settings recalculate', async t => {
  const h = harness(t);
  const first = h.tools.run(); await flush(); await h.settle(); await first;
  h.fields['wigner-seitz-markers'].value = 'defects'; h.fields['wigner-seitz-markers'].dispatch('change');
  assert.equal(h.pending.length, 1);
  assert.deepEqual(Array.from(h.renderer.siteMarkers.sites), [3, 5, 6, 10]);
  h.fields['wigner-seitz-markers'].value = 'all'; h.fields['wigner-seitz-markers'].dispatch('change');
  assert.equal(h.renderer.siteMarkers.sites.length, 54);
  h.fields['wigner-seitz-show-markers'].checked = false; h.fields['wigner-seitz-show-markers'].dispatch('change');
  h.fields['wigner-seitz-marker-radius'].value = '1.25'; h.fields['wigner-seitz-marker-radius'].dispatch('change');
  assert.deepEqual(h.markerCalls.at(-1).options, { visible: false, radius: 1.25 });
  assert.equal(h.pending.length, 1);
  // Moving to the reference frame itself recalculates: no defects, no markers.
  h.setIndex(0);
  const onFrame = h.tools.onFrame(); await flush();
  assert.equal(h.pending.length, 2);
  assert.strictEqual(h.pending[1].frame, h.reference);
  await h.settle(); await onFrame;
  assert.equal(h.renderer.siteMarkers.sites.length, 54, 'all-sites mode still draws every site');
  h.fields['wigner-seitz-markers'].value = 'vacancies'; h.fields['wigner-seitz-markers'].dispatch('change');
  assert.equal(h.renderer.siteMarkers, null, 'no vacancies, no marker set');
  // Returning to a calculated frame reuses its cached result.
  h.setIndex(1);
  await h.tools.onFrame();
  assert.equal(h.pending.length, 2);
  assert.equal(h.renderer.siteMarkers.sites.length, 1);
  // Affine mapping is a calculation parameter.
  h.fields['wigner-seitz-affine'].checked = true; h.fields['wigner-seitz-affine'].dispatch('change');
  await flush();
  assert.equal(h.pending.length, 3);
  assert.equal(h.pending[2].settings.affineMapping, true);
  await h.settle();
});

test('invalid reference frames fail clearly; cancel clears outputs and markers', async t => {
  const h = harness(t);
  h.fields['wigner-seitz-reference-frame'].value = '3';
  assert.equal(await h.tools.run(), false);
  assert.equal(h.fields['wigner-seitz-state'].textContent, 'Failed');
  assert.match(h.notifications.at(-1), /from 1 to 2/);
  assert.deepEqual(h.tools.failed(), ['wignerSeitz']);
  h.fields['wigner-seitz-reference-frame'].value = '1';
  const task = h.tools.run(); await flush(); await h.settle(); await task;
  assert.ok(h.current.atomeyeResults.wignerSeitz);
  h.tools.cancel();
  assert.equal(h.current.properties.length, 0);
  assert.equal(h.current.atomeyeResults.wignerSeitz, undefined);
  assert.equal(h.renderer.siteMarkers, null);
  assert.equal(h.toolFlags.get('wignerSeitz'), false);
  assert.equal(h.fields['wigner-seitz-state'].textContent, 'Not calculated');
  // A late result after cancellation is never published.
  h.fields['wigner-seitz-reference-frame'].value = '1';
  const late = h.tools.run(); await flush();
  h.tools.cancel();
  await h.settle(); assert.equal(await late, false);
  assert.equal(h.current.properties.length, 0);
});

test('settings serialize, survive validation and restore with a recalculation', async t => {
  const h = harness(t);
  h.fields['wigner-seitz-affine'].checked = true;
  h.fields['wigner-seitz-markers'].value = 'defects';
  h.fields['wigner-seitz-marker-radius'].value = '0.9';
  const task = h.tools.run(); await flush(); await h.settle(); await task;
  const saved = h.tools.serialize();
  assert.deepEqual(saved, { enabled: true, referenceFrame: 0, affineMapping: true, markers: 'defects', showMarkers: true, markerRadius: .9 });
  const configuration = createConfiguration({ source: { kind: 'file', format: 'xyz-sequence', files: [{ name: 'a.xyz', size: 5 }], frameIndex: 1, frameCount: 2 },
    settings: { extensions: { wignerSeitz: saved } } });
  const parsed = parseConfiguration(JSON.stringify(configuration));
  assert.deepEqual(parsed.settings.extensions.wignerSeitz, saved);
  assert.equal(parseConfiguration(JSON.stringify(createConfiguration({ source: null, settings: {} }))).settings.extensions.wignerSeitz, undefined,
    'older recipes stay without the extension');
  const invalid = [
    [{ ...saved, markers: 'atoms' }, /wignerSeitz.markers is unsupported/],
    [{ ...saved, markerRadius: 0 }, /wignerSeitz.markerRadius must be a finite number/],
    [{ ...saved, referenceFrame: -1 }, /wignerSeitz.referenceFrame must be a finite integer/],
    [{ ...saved, referenceFrame: 2 }, /wignerSeitz.referenceFrame must be smaller than the source frame count/],
    [{ ...saved, affineMapping: 'yes' }, /wignerSeitz.affineMapping must be true or false/],
    [{ ...saved, extra: 1 }, /wignerSeitz.extra is not a supported setting/],
    [{ ...saved, __proto__: { polluted: true }, enabled: true }, null],
  ];
  for (const [value, message] of invalid) {
    const text = JSON.stringify({ ...configuration, settings: { ...configuration.settings, extensions: { ...configuration.settings.extensions, wignerSeitz: value } } });
    if (message) assert.throws(() => parseConfiguration(text), message);
  }
  assert.throws(() => parseConfiguration(JSON.stringify({ ...configuration, settings: { ...configuration.settings,
    extensions: { ...configuration.settings.extensions, wignerSeitz: JSON.parse('{"__proto__":{"x":1}}') } } })), /not a supported setting/);
  // Restore resets the panel, applies the saved settings and recalculates.
  h.tools.reset();
  assert.equal(h.fields['wigner-seitz-markers'].value, 'vacancies');
  const restored = h.tools.restore(parsed.settings.extensions.wignerSeitz); await flush();
  assert.equal(h.fields['wigner-seitz-markers'].value, 'defects');
  assert.equal(h.fields['wigner-seitz-affine'].checked, true);
  assert.equal(h.fields['wigner-seitz-marker-radius'].value, '0.9');
  assert.equal(h.pending.at(-1).settings.affineMapping, true);
  await h.settle(); assert.equal(await restored, true);
  assert.equal(h.renderer.siteMarkers.sites.length, 4);
});

test('the defect-site CSV lists class, per-element occupancy and both positions', () => {
  const { reference, current } = frames();
  const result = calculateWignerSeitz(current, reference);
  result.exportSites = wignerSeitzExportSites(result, current, reference);
  result.referenceFrame = 0;
  const snapshot = { fileName: 'b2.xyz', frameIndex: 1, frame: { atomCount: current.ids.length, ids: current.ids, types: current.types,
    typeLabels: current.typeLabels, positions: current.positions, timestep: 7, cell: current.cell, properties: [] },
    results: { wignerSeitz: result } };
  const table = buildStatisticsTable(snapshot, 'wigner-seitz');
  const rows = serializeCsv(table).trim().split('\r\n').map(line => line.split(','));
  assert.deepEqual(rows[0], ['source_file', 'frame_number', 'timestep', 'site_index', 'site_id', 'site_type', 'site_class', 'occupancy',
    'occupancy_Fe', 'occupancy_Ni', 'reference_x [Å]', 'reference_y [Å]', 'reference_z [Å]', 'current_x [Å]', 'current_y [Å]', 'current_z [Å]']);
  assert.deepEqual(rows.slice(1).map(row => row.slice(3, 10)), [
    ['3', '4', 'Ni', 'vacancy', '0', '0', '0'], ['5', '6', 'Ni', 'antisite', '1', '1', '0'],
    ['6', '7', 'Fe', 'antisite', '1', '0', '1'], ['10', '11', 'Fe', 'interstitial', '2', '2', '0']]);
  assert.deepEqual(rows[1].slice(10).map(Number), [...reference.positions.subarray(9, 12), ...reference.positions.subarray(9, 12)]);
  assert.equal(table.filename, 'b2-frame-2-wigner-seitz.csv');
  const summary = serializeCsv(buildStatisticsTable(snapshot, 'summary'));
  for (const line of ['wignerSeitz,vacancy_count,,1,', 'wignerSeitz,interstitial_count,,1,', 'wignerSeitz,antisite_count,,2,',
    'wignerSeitz,reference_frame,,1,', 'wignerSeitz,vacancy_count,Ni,1,']) assert.ok(summary.includes(line), line);
  assert.throws(() => buildStatisticsTable({ ...snapshot, results: {} }, 'wigner-seitz'), /Calculate Wigner–Seitz defects/);
});

test('markers follow the affine mapping and the display wraps them into the shown cell', () => {
  const { reference } = frames();
  const strained = { ...reference, cell: createCell({ vectors: [9.5, 0, 0, 0, 8.61, 0, 0, 0, 8.61] }) };
  const result = calculateWignerSeitz(strained, reference, { affineMapping: true });
  const mapped = wignerSeitzMarkers(result, strained, reference, 'all', { affineMapping: true });
  assert.ok(Math.abs(mapped.positions[3 * 1] - reference.fractional[3] * 9.5) < 1e-12);
  const plain = wignerSeitzMarkers(result, strained, reference, 'all');
  assert.equal(plain.positions[3], reference.positions[3]);
  assert.throws(() => wignerSeitzMarkers(result, strained, reference, 'sites'), /Choose vacant, defect or all sites/);
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [true, true, false] });
  const display = siteMarkerDisplayCoordinates(Float64Array.of(-1, 12, 15), cell, [0.5, 0, 0.5]);
  const close = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) < 1e-12);
  assert.ok(close(Array.from(display.positions), [4, 2, 15]), 'periodic axes wrap with the display origin; open axes do not move');
  assert.deepEqual(normalizeSiteMarkerOptions({ radius: 2 }, { visible: false }), { visible: false, radius: 2 });
  assert.throws(() => normalizeSiteMarkerOptions({ radius: 0 }), /greater than zero/);
});

test('the marker layer uploads once, follows the periodic origin and draws every replica', () => {
  const calls = [], gl = {};
  for (const name of ['VERTEX_SHADER', 'FRAGMENT_SHADER', 'ARRAY_BUFFER', 'FLOAT', 'UNSIGNED_BYTE', 'STATIC_DRAW', 'TRIANGLE_STRIP']) gl[name] = name;
  for (const name of ['createProgram', 'createShader', 'createVertexArray', 'createBuffer']) gl[name] = () => ({});
  gl.getUniformLocation = (_program, name) => name;
  gl.getShaderParameter = gl.getProgramParameter = () => true;
  for (const name of ['shaderSource', 'compileShader', 'attachShader', 'deleteShader', 'linkProgram', 'bindVertexArray', 'bindBuffer', 'bufferData',
    'enableVertexAttribArray', 'vertexAttribPointer', 'vertexAttribDivisor', 'useProgram', 'uniform1i', 'uniform1f', 'uniform3f', 'uniform4fv',
    'uniformMatrix4fv', 'drawArraysInstanced']) gl[name] = (...values) => calls.push({ name, values });
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
  const renderer = { frame: { cell }, periodicOrigin: [0, 0, 0], viewMatrix: new Float32Array(16), projectionMatrix: new Float32Array(16),
    sliceMode: 'planes', sliceCount: 0, replicas: [{ indices: [0, 0, 0], offset: [0, 0, 0] }, { indices: [1, 0, 0], offset: [10, 0, 0] }] };
  const layer = new SiteMarkerLayer(gl), markers = { positions: Float64Array.of(11, 2, 3, 4, 5, 6), colors: Uint8Array.of(1, 2, 3, 4, 5, 6) };
  layer.setMarkers(renderer, markers, { radius: .5 });
  const uploads = () => calls.filter(call => call.name === 'bufferData').length;
  const initial = uploads();
  layer.render(renderer);
  assert.equal(uploads(), initial, 'an unchanged display is not uploaded again');
  assert.deepEqual(calls.filter(call => call.name === 'drawArraysInstanced').map(call => call.values.at(-1)), [2, 2]);
  const near = (actual, expected) => assert.ok(Array.from(actual).every((value, index) => Math.abs(value - expected[index]) < 1e-12), `${Array.from(actual)}`);
  near(layer.displayPositions.subarray(0, 3), [1, 2, 3]);
  const minimum = [0, 0, 0], maximum = [10, 10, 10];
  layer.extendBounds(renderer, minimum, maximum);
  assert.deepEqual(minimum, [0, 0, 0]);
  renderer.periodicOrigin = [.5, 0, 0];
  layer.render(renderer);
  assert.ok(uploads() > initial);
  near(layer.displayPositions.subarray(0, 3), [6, 2, 3]);
  layer.setMarkers(renderer, markers, { visible: false });
  calls.length = 0; layer.render(renderer);
  assert.equal(calls.length, 0, 'hidden markers draw nothing');
  layer.setMarkers(renderer, null);
  assert.equal(layer.count, 0);
  assert.throws(() => layer.setMarkers(renderer, { positions: Float64Array.of(1, 2), colors: Uint8Array.of(1) }), /three coordinates/);
});
