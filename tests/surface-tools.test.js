import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateSurfaceMesh } from '../src/analysis/surface-mesh.js';
import { createConfiguration, parseConfiguration } from '../src/configuration.js';
import { createAttributeRegistry, SURFACE_ATTRIBUTES } from '../src/global-attributes.js';
import { buildStatisticsTable, serializeCsv } from '../src/statistics-export.js';
import { SURFACE_MESH_TOOL_DEFAULTS, initializeSurfaceTools, maskDigest, surfaceSummaryRows } from '../src/surface-tools.js';
import { fccBlock, periodicDistance, subsetFrame } from './helpers/surfaces.js';

class Element {
  constructor(value = '') {
    this.value = String(value); this.textContent = ''; this.hidden = false; this.checked = false; this.title = '';
    this.disabled = false; this.listeners = new Map(); this.style = {}; this.className = ''; this.children = [];
    this.classList = { toggle() {} };
  }
  get valueAsNumber() { return this.value.trim() === '' ? NaN : Number(this.value); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name) { this.listeners.get(name)?.({ target: this }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

const L = 24, block = fccBlock(6, 4);
/** Two frames with a void at the cell corner; the second void is larger. */
const frames = [9, 10].map(radius => ({ ...subsetFrame(block, position => periodicDistance(position, [0, 0, 0], L) > radius - 4), typeLabels: ['Cu'] }));

function harness(t) {
  const previousDocument = globalThis.document, fields = {};
  for (const id of ['surface-mesh-state', 'surface-mesh-status', 'surface-mesh-backend', 'surface-mesh-progress', 'surface-mesh-results',
    'surface-mesh-summary', 'run-surface-mesh', 'cancel-surface-mesh', 'surface-mesh-table-body', 'surface-mesh-region-body',
    'surface-mesh-region-caption', 'surface-mesh-radius-help', 'surface-mesh-suggest', 'surface-mesh-display-status',
    'export-surface-mesh-stl', 'export-surface-mesh-ply', 'export-surface-mesh-obj', 'surface-mesh-selection']) fields[id] = new Element();
  fields['surface-mesh-radius'] = new Element('');
  fields['surface-mesh-smoothing'] = new Element('8');
  fields['surface-mesh-opacity'] = new Element('1');
  for (const id of ['surface-mesh-visible', 'surface-mesh-caps']) { fields[id] = new Element(); fields[id].checked = true; }
  for (const id of ['surface-mesh-color', 'surface-mesh-interior-color', 'surface-mesh-cap-color']) fields[id] = new Element();
  globalThis.document = { getElementById: id => fields[id] ?? null,
    createElement() { const element = new Element(); element.ownerDocument = this; return element; } };
  for (const element of Object.values(fields)) element.ownerDocument = globalThis.document;
  t.after(() => { globalThis.document = previousDocument; });
  let index = 0, version = 'a', groups = [], visibility = null;
  const pending = [], meshCalls = [], toolFlags = new Map(), notifications = [], changes = [], downloads = [], timers = [];
  const renderer = { frame: frames[0], periodicOrigin: [0, 0, 0], coordinateMode: 'wrapped', visibility: null,
    setSurfaceMesh(id, mesh, options) { meshCalls.push({ id, mesh, options: { ...options } }); return { id, mesh, options, error: null }; } };
  const client = { surface(frame, parameters, options) { return new Promise((resolve, reject) => pending.push({ frame, parameters, options, resolve, reject })); } };
  const tools = initializeSurfaceTools({ renderer, client, tools: { setToolEnabled: (name, enabled) => toolFlags.set(name, enabled) },
    getFrame: () => frames[index], getFrames: () => new Set(frames), getSourceVersion: () => version, getSelectionGroups: () => groups,
    getVisibility: () => visibility, getFileStem: () => 'sample', getFrameIndex: () => index,
    onResultsChange: change => changes.push(change), notify: message => notifications.push(message),
    onDownload: (blob, filename) => downloads.push({ blob, filename }),
    setTimer: callback => { timers.push(callback); return timers.length; }, clearTimer: id => { timers[id - 1] = null; } });
  tools.setEnabled(true);
  /** Answer a pending request with the real kernel. */
  const settle = async (at = pending.length - 1) => {
    const { frame, parameters, options } = pending[at];
    pending[at].resolve(await calculateSurfaceMesh(frame, parameters, { mask: options.mask }));
    await new Promise(resolve => setImmediate(resolve));
  };
  return { tools, fields, pending, meshCalls, toolFlags, notifications, changes, downloads, timers, renderer, settle,
    setIndex(next) { index = next; renderer.frame = frames[next]; }, setVersion(next) { version = next; },
    setGroups(next) { groups = next; }, setVisibility(next) { visibility = next; } };
}

test('the Surface panel suggests a radius, constructs the mesh and shows its measurements', async t => {
  const h = harness(t), { tools, fields } = h;
  assert.equal(tools.isUntouched(), true);
  assert.equal(fields['surface-mesh-state'].textContent, 'Not calculated');
  await tools.onFrame();
  assert.equal(fields['surface-mesh-radius'].value, '3.4', 'Cu: 1.15 × the 2.95 Å first-shell cutoff');
  assert.match(fields['surface-mesh-radius-help'].textContent, /3\.40 Å/);
  assert.equal(tools.isUntouched(), true, 'a suggested radius is not a saved choice');
  assert.equal(h.pending.length, 0, 'opening a frame does not start the analysis');
  fields['surface-mesh-radius'].value = '3.5';
  fields['surface-mesh-smoothing'].value = '0';
  const running = tools.run();
  assert.equal(fields['surface-mesh-state'].textContent, 'Calculating…');
  assert.equal(fields['run-surface-mesh'].disabled, true);
  assert.deepEqual(h.pending[0].parameters, { radius: 3.5, smoothingLevel: 0 });
  assert.equal(h.pending[0].options.mask, null, 'all atoms: no mask');
  h.pending[0].options.onProgress({ phase: 'Periodic Delaunay tessellation', completedStages: 0, totalStages: 6, workerCount: 4 });
  assert.match(fields['surface-mesh-status'].textContent, /Periodic Delaunay tessellation · 4 threads · 0 \/ 6 stages/);
  await h.settle();
  assert.equal(await running, true);
  const result = tools.getResult();
  assert.equal(fields['surface-mesh-state'].textContent, 'Calculated');
  assert.equal(h.toolFlags.get('surfaceMesh'), true);
  assert.equal(fields['surface-mesh-results'].hidden, false);
  assert.match(fields['surface-mesh-summary'].textContent, /triangles · .* vertices · .* atoms · probe radius 3\.5 Å · smoothing 0/);
  assert.equal(frames[0].atomeyeResults.surfaceMesh.result, result);
  // Statistics table: label, value and unit cells per row.
  const rows = fields['surface-mesh-table-body'].children.map(row => row.children.map(cell => cell.textContent));
  assert.deepEqual(rows, surfaceSummaryRows(result));
  assert.deepEqual(rows.map(row => row[0]), ['Surface area', 'Solid volume', 'Empty volume', 'Void volume', 'Solid regions', 'Empty regions',
    'Surface components', 'Specific surface area']);
  assert.match(rows[3][1], /\(\d+(\.\d+)?%\)/);
  assert.equal(rows[5][1], '1 (1 voids)');
  const regions = fields['surface-mesh-region-body'].children.map(row => row.children.map(cell => cell.textContent));
  assert.deepEqual(regions.map(row => row[1]), ['Solid', 'Void']);
  // The mesh goes to the renderer once, with the panel's style.
  const shown = h.meshCalls.at(-1);
  assert.equal(shown.id, 'surface');
  assert.equal(shown.mesh.vertices, result.vertices);
  assert.equal(shown.mesh.triangles, result.triangles);
  assert.deepEqual(shown.options, { visible: true, caps: true, opacity: 1, color: '#c9d4e3', interiorColor: '#b5524a', capColor: '#8fa3bf' });
  assert.equal(fields['export-surface-mesh-stl'].disabled, false);
  // Display edits redraw the same mesh object and never recalculate.
  fields['surface-mesh-opacity'].value = '0.35'; fields['surface-mesh-opacity'].dispatch('input');
  fields['surface-mesh-color'].value = '#112233'; fields['surface-mesh-color'].dispatch('change');
  fields['surface-mesh-caps'].checked = false; fields['surface-mesh-caps'].dispatch('change');
  fields['surface-mesh-visible'].checked = false; fields['surface-mesh-visible'].dispatch('change');
  assert.equal(h.pending.length, 1);
  assert.equal(h.meshCalls.at(-1).mesh, shown.mesh);
  assert.deepEqual(h.meshCalls.at(-1).options, { visible: false, caps: false, opacity: 0.35, color: '#112233', interiorColor: '#b5524a', capColor: '#8fa3bf' });
  // A parameter edit recalculates; returning to the old value reuses nothing stale.
  fields['surface-mesh-smoothing'].value = '4'; fields['surface-mesh-smoothing'].dispatch('change');
  assert.equal(h.pending.length, 2);
  assert.equal(h.meshCalls.at(-1).mesh, null, 'the outdated surface is removed while recalculating');
  await h.settle();
  assert.equal(tools.getResult().smoothingLevel, 4);
  // Cancel clears the result and the display but keeps the settings.
  tools.cancel();
  assert.equal(fields['surface-mesh-state'].textContent, 'Not calculated');
  assert.equal(h.toolFlags.get('surfaceMesh'), false);
  assert.equal(h.meshCalls.at(-1).mesh, null);
  assert.equal(frames[0].atomeyeResults.surfaceMesh, undefined);
  assert.equal(fields['surface-mesh-radius'].value, '3.5');
  assert.equal(tools.getResult(), null);
});

test('frame changes recalculate, cached frames redraw at once and stale replies are dropped', async t => {
  const h = harness(t), { tools, fields } = h;
  await tools.onFrame();
  fields['surface-mesh-radius'].value = '3.5'; fields['surface-mesh-radius'].dispatch('change');
  const first = tools.run();
  await h.settle();
  await first;
  const volume = tools.getResult().voidVolume;
  // Next frame: queued automatically; the previous frame's mesh is removed first.
  h.setIndex(1);
  const second = tools.onFrame();
  assert.equal(h.meshCalls.at(-1).mesh, null);
  assert.equal(h.pending.length, 2);
  assert.equal(h.pending[1].frame, frames[1]);
  assert.equal(fields['surface-mesh-radius'].value, '3.5', 'an edited radius is kept across frames');
  assert.deepEqual(tools.pendingKinds(), ['surfaceMesh']);
  await h.settle();
  assert.equal(await second, true);
  assert.ok(tools.getResult().voidVolume > volume, 'the larger void of the second frame');
  // Back to the first frame: its cached result is shown without a new job.
  h.setIndex(0);
  assert.equal(await tools.onFrame(), true);
  assert.equal(h.pending.length, 2);
  assert.equal(tools.getResult().voidVolume, volume);
  assert.equal(h.meshCalls.at(-1).mesh.vertices, frames[0].atomeyeResults.surfaceMesh.result.vertices);
  // A reply for a frame that is no longer displayed is ignored.
  tools.cancel();
  const stale = tools.run();
  h.setIndex(1);
  const current = tools.onFrame();
  assert.equal(h.pending[2].options.signal.aborted, true);
  h.pending[2].resolve(frames[0].atomeyeResults?.surfaceMesh?.result ?? {});
  assert.equal(await stale, false);
  await h.settle(3);
  assert.equal(await current, true);
  assert.equal(tools.getResult().atomCount, frames[1].ids.length);
  // A failure is reported and leaves the tool enabled for a retry.
  fields['surface-mesh-radius'].value = '20'; fields['surface-mesh-radius'].dispatch('change');
  const failed = h.pending.at(-1);
  failed.reject(new Error('Cannot generate Delaunay tessellation. Simulation cell is too small, or radius parameter is too large.'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fields['surface-mesh-state'].textContent, 'Failed');
  assert.match(fields['surface-mesh-status'].textContent, /radius parameter is too large/);
  assert.deepEqual(tools.failed(), ['surfaceMesh']);
  assert.equal(h.meshCalls.at(-1).mesh, null);
  // Invalid input never reaches the Worker.
  const requests = h.pending.length;
  fields['surface-mesh-radius'].value = '-1';
  assert.equal(await tools.run(), false);
  assert.equal(h.pending.length, requests);
  assert.match(h.notifications.at(-1), /positive probe sphere radius/);
  fields['surface-mesh-radius'].value = '3.5'; fields['surface-mesh-smoothing'].value = '2.5';
  assert.equal(await tools.run(), false);
  assert.match(h.notifications.at(-1), /smoothing level from 0 to 100/);
});

test('the surface can be restricted to a selection group or to the visible atoms', async t => {
  const h = harness(t), { tools, fields } = h, frame = frames[0];
  const members = Array.from(frame.ids).filter((_, atom) => frame.positions[atom * 3 + 2] < 12);
  h.setGroups([{ id: 'lower', name: 'Lower half', atomIds: members }]);
  await tools.onFrame();
  assert.deepEqual(fields['surface-mesh-selection'].children.map(option => [option.value, option.textContent]),
    [['all', 'All atoms'], ['visible', 'Visible atoms'], ['group:lower', `Lower half · ${members.length.toLocaleString('en-US')} IDs`]]);
  fields['surface-mesh-radius'].value = '3.5';
  fields['surface-mesh-selection'].value = 'group:lower';
  const grouped = tools.run();
  const mask = h.pending[0].options.mask;
  assert.equal(mask.reduce((sum, value) => sum + value, 0), members.length);
  await h.settle();
  await grouped;
  assert.equal(tools.getResult().inputCount, members.length);
  assert.match(fields['surface-mesh-summary'].textContent, new RegExp(`${members.length.toLocaleString('en-US')} of ${frame.ids.length.toLocaleString('en-US')} atoms`));
  // Editing the group's members recalculates; other group edits do not.
  h.setGroups([{ id: 'lower', name: 'Lower half', atomIds: members.slice(10) }]);
  void tools.refreshSelectionGroups();
  assert.equal(h.pending.length, 2);
  assert.equal(h.pending[1].options.mask.reduce((sum, value) => sum + value, 0), members.length - 10);
  await h.settle();
  // A missing group fails with an explanation instead of using all atoms.
  h.setGroups([]);
  assert.equal(await tools.refreshSelectionGroups(), false);
  assert.equal(fields['surface-mesh-state'].textContent, 'Failed');
  assert.match(fields['surface-mesh-status'].textContent, /no longer exists/);
  assert.ok(fields['surface-mesh-selection'].children.some(option => option.textContent === 'Missing group (lower)'));
  // Visible atoms: the display mask at calculation time; filter changes rerun after a pause.
  const visibility = Uint8Array.from({ length: frame.ids.length }, (_, atom) => frame.positions[atom * 3] < 12 ? 255 : 0);
  h.setVisibility(visibility);
  fields['surface-mesh-selection'].value = 'visible'; fields['surface-mesh-selection'].dispatch('change');
  const request = h.pending.at(-1);
  assert.deepEqual(Array.from(request.options.mask), Array.from(visibility, value => value ? 1 : 0));
  await h.settle();
  assert.equal(tools.getResult().inputCount, visibility.filter(Boolean).length);
  const before = h.pending.length;
  assert.equal(tools.refreshVisibility(), true);
  assert.equal(tools.refreshVisibility(), true, 'further changes restart the pause');
  assert.equal(h.pending.length, before, 'nothing starts until the filters settle');
  assert.equal(h.timers.filter(Boolean).length, 1);
  h.setVisibility(Uint8Array.from(visibility, (value, atom) => atom % 2 ? value : 0));
  h.timers.find(Boolean)();
  assert.equal(h.pending.length, before + 1);
  await h.settle();
  // An unchanged mask reuses the cached result; all atoms ignore visibility.
  assert.equal(maskDigest(Uint8Array.of(1, 0, 1)), maskDigest(Uint8Array.of(255, 0, 7)));
  assert.notEqual(maskDigest(Uint8Array.of(1, 0, 1)), maskDigest(Uint8Array.of(1, 1, 0)));
  const settled = h.pending.length;
  assert.equal(await tools.run({ automatic: true }), true);
  assert.equal(h.pending.length, settled);
  fields['surface-mesh-selection'].value = 'all'; fields['surface-mesh-selection'].dispatch('change');
  await h.settle();
  assert.equal(tools.refreshVisibility(), false);
});

test('surface settings round-trip through a validated configuration and old recipes are unaffected', async t => {
  const h = harness(t), { tools, fields } = h;
  await tools.onFrame();
  const untouched = tools.serialize();
  assert.deepEqual(untouched, { enabled: false, ...SURFACE_MESH_TOOL_DEFAULTS });
  assert.equal(untouched.radius, null);
  // Recipes without the extension stay valid and gain no surface entry.
  const old = createConfiguration({ settings: {} });
  assert.equal(Object.hasOwn(old.settings.extensions, 'surfaceMesh'), false);
  assert.equal(Object.hasOwn(parseConfiguration(JSON.stringify(old)).settings.extensions, 'surfaceMesh'), false);
  h.setGroups([{ id: 'grain', name: 'Grain', atomIds: [1, 2, 3, 4, 5] }]);
  void tools.refreshSelectionGroups();
  fields['surface-mesh-radius'].value = '3.75'; fields['surface-mesh-radius'].dispatch('change');
  fields['surface-mesh-smoothing'].value = '12';
  fields['surface-mesh-selection'].value = 'group:grain'; fields['surface-mesh-selection'].dispatch('change');
  fields['surface-mesh-opacity'].value = '0.6'; fields['surface-mesh-caps'].checked = false;
  fields['surface-mesh-interior-color'].value = '#AA0000';
  const saved = tools.serialize();
  assert.deepEqual(saved, { enabled: false, radius: 3.75, smoothingLevel: 12, atoms: 'group', selectionGroupId: 'grain',
    visible: true, caps: false, opacity: 0.6, color: '#c9d4e3', interiorColor: '#aa0000', capColor: '#8fa3bf' });
  assert.equal(tools.isUntouched(), false);
  const selectionGroups = { groups: [{ id: 'grain', name: 'Grain', atomIds: [1, 2, 3, 4, 5], color: '#ff0000', visible: true }] };
  const configuration = createConfiguration({ settings: { selectionGroups, extensions: { surfaceMesh: { ...saved, enabled: true } } } });
  const parsed = parseConfiguration(JSON.stringify(configuration)).settings.extensions.surfaceMesh;
  assert.deepEqual(parsed, { ...saved, enabled: true });
  // Restoring applies the settings and recalculates the enabled analysis.
  tools.reset();
  assert.equal(fields['surface-mesh-smoothing'].value, '8');
  const restored = tools.restore(parsed);
  assert.equal(fields['surface-mesh-radius'].value, '3.75');
  assert.equal(fields['surface-mesh-smoothing'].value, '12');
  assert.equal(fields['surface-mesh-selection'].value, 'group:grain');
  assert.equal(fields['surface-mesh-caps'].checked, false);
  assert.equal(fields['surface-mesh-interior-color'].value, '#aa0000');
  assert.deepEqual(h.pending.at(-1).parameters, { radius: 3.75, smoothingLevel: 12 });
  assert.equal(h.pending.at(-1).options.mask.reduce((sum, value) => sum + value, 0), 5);
  await h.settle();
  assert.equal(await restored, true);
  assert.deepEqual(tools.serialize(), { ...saved, enabled: true });
  // A restore without the extension resets to the defaults and the suggestion.
  await tools.restore(undefined);
  assert.equal(tools.isEnabled(), false);
  assert.equal(fields['surface-mesh-radius'].value, '3.4');
  assert.equal(tools.isUntouched(), true);
  // Shared recipes are validated: wrong types, ranges and unknown keys are rejected.
  const invalid = extension => () => createConfiguration({ settings: { selectionGroups, extensions: { surfaceMesh: extension } } });
  assert.throws(invalid({ enabled: true }), /radius is required/);
  assert.throws(invalid({ radius: -1 }), /radius/);
  assert.throws(invalid({ radius: 1e7 }), /radius/);
  assert.throws(invalid({ radius: 3, smoothingLevel: 101 }), /smoothingLevel/);
  assert.throws(invalid({ radius: 3, smoothingLevel: 1.5 }), /smoothingLevel/);
  assert.throws(invalid({ radius: 3, opacity: 2 }), /opacity/);
  assert.throws(invalid({ radius: 3, color: 'javascript:alert(1)' }), /color/);
  assert.throws(invalid({ radius: 3, atoms: 'some' }), /atoms/);
  assert.throws(invalid({ radius: 3, atoms: 'group' }), /selectionGroupId/);
  assert.throws(invalid({ radius: 3, atoms: 'group', selectionGroupId: 'missing' }), /saved selection group/);
  assert.throws(invalid({ radius: 3, script: 'x' }), /not a supported setting/);
  assert.throws(invalid({ radius: 3, caps: 'yes' }), /true or false/);
  assert.deepEqual(invalid({ radius: 3, atoms: 'all', selectionGroupId: 'grain' })().settings.extensions.surfaceMesh.selectionGroupId, null);
  assert.ok(createConfiguration({ settings: { activeTool: 'surfaceMesh' } }).settings.activeTool === 'surfaceMesh');
});

test('the displayed surface exports as STL, PLY and OBJ at the current periodic origin', async t => {
  const h = harness(t), { tools, fields } = h;
  assert.equal(tools.exportMesh('stl'), null);
  assert.match(h.notifications.at(-1), /Construct the surface/);
  await tools.onFrame();
  fields['surface-mesh-radius'].value = '3.5'; fields['surface-mesh-smoothing'].value = '0';
  const running = tools.run();
  await h.settle();
  await running;
  const capped = tools.exportMesh('stl');
  assert.equal(h.downloads.at(-1).filename, 'sample-frame-1-surface.stl');
  // Atoms of this lattice lie on the cell faces: cuts through them leave
  // zero-area triangles, which the STL writer omits.
  const stl = new DataView(await h.downloads.at(-1).blob.arrayBuffer()), facets = stl.getUint32(80, true);
  assert.equal(stl.byteLength, 84 + facets * 50);
  assert.ok(facets > tools.getResult().faceCount && facets <= capped.triangleCount);
  assert.ok(capped.parts.includes(1), 'the void at the cell corner is capped on the cell faces');
  // Without caps, and after moving the void to the cell center, fewer triangles are written.
  fields['surface-mesh-caps'].checked = false;
  const open = tools.exportMesh('ply');
  assert.equal(h.downloads.at(-1).filename, 'sample-frame-1-surface.ply');
  assert.ok(open.triangleCount < capped.triangleCount && !open.parts.includes(1));
  h.renderer.periodicOrigin = [0.5, 0.5, 0.5];
  const centered = tools.exportMesh('obj');
  assert.equal(centered.triangleCount, tools.getResult().faceCount, 'no face of the centered void crosses the cell');
  assert.match(await h.downloads.at(-1).blob.text(), /^# AlloyView surface mesh, probe radius 3\.5 A\n/);
  // Unwrapped display: the source cut, translated with the atoms.
  h.renderer.coordinateMode = 'unwrapped';
  const moved = tools.exportMesh('obj');
  assert.equal(moved.triangleCount, open.triangleCount);
  assert.ok(Math.abs(Math.min(...moved.positions.filter((_, component) => component % 3 === 0)) + 12) < 1e-9);
  h.renderer.coordinateMode = 'wrapped';
  fields['export-surface-mesh-stl'].dispatch('click');
  assert.equal(h.downloads.at(-1).filename, 'sample-frame-1-surface.stl');
  assert.equal(tools.exportMesh('vtk'), null);
  assert.match(h.notifications.at(-1), /STL, PLY or OBJ/);
});

test('surface measurements become global attributes and summary CSV rows', async t => {
  const h = harness(t), { tools, fields } = h, frame = frames[0];
  await tools.onFrame();
  fields['surface-mesh-radius'].value = '3.5';
  const running = tools.run();
  await h.settle();
  await running;
  const result = tools.getResult(), registry = createAttributeRegistry({ frame, frameIndex: 0, frameCount: 2 });
  const table = buildStatisticsTable({ frame: { ...frame, atomCount: frame.ids.length, properties: [] }, results: { surfaceMesh: result } }, 'summary');
  // Columns after the file, frame and timestep context: analysis, metric, label, value, unit.
  const csv = serializeCsv(table).split(/\r?\n/).map(line => line.split(',').slice(3));
  for (const [name, field, unit] of SURFACE_ATTRIBUTES) {
    const attribute = registry.get(`Surface.${name}`);
    assert.equal(attribute.value, result[field], name);
    assert.equal(attribute.kind, 'analysis');
    assert.equal(attribute.unit, unit);
    // Every attribute equals the summary row it names.
    const row = csv.find(line => line[0] === attribute.csv[0] && line[1] === attribute.csv[1] && line[2] === attribute.csv[2]);
    assert.ok(row, `summary row for ${name}`);
    assert.equal(Number(row[3]), result[field], `${name} in the summary CSV`);
  }
  assert.equal(registry.get('Surface.void_region_count').value, 1);
  assert.equal(registry.get('surface.SURFACE_AREA').value, result.surfaceArea, 'names are case-insensitive');
  const metric = name => csv.filter(line => line[0] === 'surfaceMesh' && line[1] === name);
  assert.deepEqual(metric('probe_radius')[0].slice(3), ['3.5', 'Å']);
  assert.deepEqual(metric('region_volume').map(line => line[2]), ['filled 0', 'void 1']);
  assert.equal(Number(metric('region_surface_area')[1][3]), result.regionAreas[1]);
  // Without a result there are no surface attributes or rows.
  tools.cancel();
  assert.equal(createAttributeRegistry({ frame, frameIndex: 0 }).has('Surface.surface_area'), false);
});
