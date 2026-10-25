import test from 'node:test';
import assert from 'node:assert/strict';
import { crystalCellMetrics, initializeCrystalTools, CRYSTAL_TOOL_DEFAULTS } from '../src/ui/view/crystal-tools.js';
import { createCell } from '../src/data/model.js';
import { estimateFrameBytes } from '../src/data/cache-policy.js';
import { createConfiguration, parseConfiguration, matchesSource } from '../src/application/configuration.js';

class Element {
  constructor() {
    this.value = ''; this.textContent = ''; this.hidden = false; this.checked = false; this.disabled = false;
    this.children = []; this.listeners = new Map(); this.classList = { toggle() {} };
  }
  get valueAsNumber() { return this.value.trim() === '' ? NaN : Number(this.value); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  dispatch(name) { this.listeners.get(name)?.({ target: this }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  removeAttribute(name) { delete this[name]; }
}

function frame(typeLabels = ['Ti', 'O']) {
  return { ids: Uint32Array.of(11, 12, 13), types: Uint16Array.of(0, 1, 1), typeLabels,
    cell: createCell({ vectors: [4, 0, 0, 0, 5, 0, 0, 0, 6] }),
    fractional: new Float64Array(9), positions: new Float64Array(9), properties: [],
    crystal: { format: 'cif', spaceGroup: { name: 'P m -3 m', number: 221 },
      symmetryOperations: ['x,y,z'], symmetrySource: 'explicit', asymmetricSiteCount: 2, expandedAtomCount: 3,
      warnings: ['Fractional occupancy sites are retained.'] } };
}

function harness(t) {
  const previous = globalThis.document, fields = new Map();
  globalThis.document = { getElementById(id) {
    if (!fields.has(id)) { const element = new Element(); element.ownerDocument = this; fields.set(id, element); }
    return fields.get(id);
  }, createElement() { const element = new Element(); element.ownerDocument = this; return element; } };
  t.after(() => { globalThis.document = previous; });
  let currentFrame = frame(), source = 1;
  const jobs = [], draws = [], exports = [], changes = [], enabled = [], notifications = [];
  const controller = initializeCrystalTools({
    getFrame: () => currentFrame, getSourceVersion: () => source,
    renderer: { setCoordinationPolyhedra: (...args) => draws.push(args) },
    tools: { setToolEnabled: (...args) => enabled.push(args) },
    pool: { analyze(input, params, options) { return new Promise((resolve, reject) => jobs.push({ input, params, options, resolve, reject })); } },
    onResultsChange: change => changes.push(change), notify: message => notifications.push(message),
    onExport: format => { exports.push(format); }, onExportStatistics: result => { exports.push(result); },
  });
  controller.setEnabled(true);
  return { controller, jobs, draws, exports, changes, enabled, notifications, fields,
    getFrame: () => currentFrame, setFrame(next) { currentFrame = next; }, changeSource() { source++; },
    field: id => fields.get(id),
    choose(key, label, checked) {
      const row = fields.get(`crystal-${key}-types`).children.find(item => item.children[1].textContent === label);
      assert.ok(row, label); row.children[0].checked = checked; row.children[0].dispatch('change');
    },
  };
}

const output = () => ({ cells: [{ atomIndex: 0, coordination: 6, volume: 4 / 3, surfaceArea: 4 * Math.sqrt(3) }],
  coordination: Uint32Array.of(6, 0, 0), volumes: Float64Array.of(4 / 3, NaN, NaN), surfaceAreas: Float64Array.of(4 * Math.sqrt(3), NaN, NaN),
  summary: { selected: 1, constructed: 1, undercoordinated: 0, coplanar: 0, skipped: 0, volumeSum: 4 / 3 },
  engine: 'CPU workers × 2', workerCount: 2 });

test('Crystal opens without analysis and reports actual cell geometry and declared metadata', async t => {
  const h = harness(t);
  assert.equal(await h.controller.onFrame(), false);
  assert.equal(h.jobs.length, 0); assert.equal(h.controller.isUntouched(), true);
  assert.equal(h.field('crystal-cell-lengths').textContent, '4 · 5 · 6');
  assert.equal(h.field('crystal-cell-angles').textContent, '90 · 90 · 90');
  assert.equal(h.field('crystal-cell-volume').textContent, '120');
  assert.match(h.field('crystal-space-group').textContent, /P m -3 m.*221/);
  assert.match(h.field('crystal-sites').textContent, /2 asymmetric sites → 3 symmetry-expanded sites/);
  assert.match(h.field('crystal-warnings').textContent, /Fractional occupancy/);
  delete h.getFrame().crystal;
  h.getFrame().properties = [{ name: 'occupancy', data: Float64Array.of(0.5, 1, NaN) }];
  await h.controller.onFrame();
  assert.equal(h.field('crystal-space-group').textContent, 'Not declared');
  assert.equal(h.field('crystal-occupancy-note').hidden, false);
  assert.equal(h.field('crystal-warnings').hidden, true);
  assert.equal(h.jobs.length, 0);
});

test('crystal cell metrics use triclinic vectors and preserve handedness-independent volume', () => {
  const metrics = crystalCellMetrics({ vectors: [3, 0, 0, 2, 4, 0, 1, 1, -5] });
  assert.equal(metrics.volume, 60);
  assert.deepEqual(metrics.lengths, [3, Math.sqrt(20), Math.sqrt(27)]);
  assert.ok(Math.abs(metrics.angles[2] - Math.acos(1 / Math.sqrt(5)) * 180 / Math.PI) < 1e-12);
  assert.equal(crystalCellMetrics({ vectors: new Float64Array(9) }), null);
});

test('replicated crystal metadata distinguishes the imported symmetry from the current supercell', async t => {
  const h = harness(t), source = h.getFrame();
  h.setFrame({ ...source, ids: new Uint32Array(6), cell: createCell({ vectors: [8, 0, 0, 0, 5, 0, 0, 0, 6] }),
    physicalReplication: { repetitions: [2, 1, 1], sourceAtomCount: 3 } });
  await h.controller.onFrame();
  assert.equal(h.field('crystal-cell-lengths').textContent, '8 · 5 · 6');
  assert.equal(h.field('crystal-cell-volume').textContent, '240');
  assert.match(h.field('crystal-sites').textContent, /Source file: 2 asymmetric sites → 3 symmetry-expanded sites.*6 atoms.*2 × 1 × 1/);
  assert.match(h.field('crystal-symmetry').textContent, /source file.*not reassessed/);
  assert.match(h.field('crystal-warnings').textContent, /^Source-file notes:/);
});

test('polyhedra resolve type labels, publish one result, and reuse geometry for appearance changes', async t => {
  const h = harness(t), originalProperties = h.getFrame().properties;
  h.choose('center', 'O', false); h.choose('neighbor', 'Ti', false);
  h.field('crystal-cutoff').value = '2.3';
  const task = h.controller.run();
  assert.deepEqual(h.jobs[0].params, { kind: 'coordinationPolyhedra', cutoff: 2.3, centerTypes: [0], neighborTypes: [1] });
  assert.deepEqual(h.controller.pendingKinds(), ['coordinationPolyhedra']);
  const result = output(); h.jobs[0].resolve(result);
  assert.equal(await task, true);
  assert.equal(h.controller.getResult(), result); assert.equal(h.draws.at(-1)[0], result);
  assert.equal(h.getFrame().properties, originalProperties);
  assert.match(h.field('crystal-summary').textContent, /1 polyhedra from 1 centers/);
  assert.match(h.field('crystal-summary').textContent, /may overlap/);
  h.field('crystal-opacity').value = '0.8'; h.field('crystal-opacity').dispatch('input');
  h.field('crystal-edges').checked = false; h.field('crystal-edges').dispatch('change');
  assert.equal(h.jobs.length, 1); assert.equal(h.draws.at(-1)[0], result);
  assert.deepEqual(h.draws.at(-1)[1], { visible: true, color: '#3b82f6', opacity: 0.8, showEdges: false });
  assert.deepEqual(h.controller.serialize(), { enabled: true, cutoff: 2.3, centerTypes: ['Ti'], neighborTypes: ['O'],
    visible: true, color: '#3b82f6', opacity: 0.8, showEdges: false });
  h.controller.cancel();
  assert.equal(h.controller.getResult(), null); assert.equal(h.draws.at(-1)[0], null);
  assert.deepEqual(h.controller.pendingKinds(), []); assert.equal(h.controller.isEnabled(), false);
});

test('new frames preserve named type choices and obsolete requests cannot republish a previous mesh', async t => {
  const h = harness(t);
  h.choose('center', 'O', false); h.choose('neighbor', 'Ti', false);
  const first = h.controller.run();
  h.setFrame(frame(['O', 'Ti']));
  const second = h.controller.onFrame();
  assert.equal(h.jobs[0].options.signal.aborted, true);
  assert.deepEqual(h.jobs[1].params.centerTypes, [1]); assert.deepEqual(h.jobs[1].params.neighborTypes, [0]);
  h.jobs[0].resolve(output()); assert.equal(await first, false); assert.equal(h.controller.getResult(), null);
  const current = output(); h.jobs[1].resolve(current); assert.equal(await second, true);
  assert.equal(h.controller.getResult(), current);
  const third = h.controller.run(); h.changeSource(); h.controller.cancel();
  h.jobs[2].resolve(output()); assert.equal(await third, false); assert.equal(h.controller.getResult(), null);
  assert.equal(h.draws.at(-1)[0], null);
});

test('invalid cutoff clears obsolete geometry and failed or cancelled work can be retried', async t => {
  const h = harness(t), first = h.controller.run();
  h.jobs[0].resolve(output()); await first;
  h.field('crystal-cutoff').value = 'Infinity';
  assert.equal(await h.controller.run(), false); assert.equal(h.jobs.length, 1);
  assert.equal(h.controller.getResult(), null); assert.deepEqual(h.controller.failed(), ['crystal']);
  assert.equal(h.field('cancel-crystal').disabled, false);
  h.field('crystal-cutoff').value = '3';
  const second = h.controller.run();
  h.jobs[1].reject(new Error('Neighbor search limit exceeded.'));
  assert.equal(await second, false); assert.match(h.field('crystal-status').textContent, /limit/);
  assert.equal(h.field('crystal-progress').hidden, true);
  const retry = h.controller.run(); h.jobs[2].resolve(output()); assert.equal(await retry, true);
});

test('only the current polyhedra result is charged to frame memory and clearing preserves unrelated results', async t => {
  const h = harness(t), source = h.getFrame(), properties = source.properties;
  const other = { data: new Float64Array(10) }; source.atomeyeResults = { unrelated: other };
  const before = estimateFrameBytes(source), task = h.controller.run(), result = output();
  h.jobs[0].resolve(result); await task;
  assert.equal(source.atomeyeResults.coordinationPolyhedra, result);
  assert.equal(estimateFrameBytes(source), before + result.coordination.byteLength + result.volumes.byteLength + result.surfaceAreas.byteLength);
  h.setFrame(frame()); const next = h.controller.onFrame();
  assert.equal(Object.hasOwn(source.atomeyeResults, 'coordinationPolyhedra'), false);
  assert.equal(estimateFrameBytes(source), before); assert.equal(source.atomeyeResults.unrelated, other);
  assert.equal(source.properties, properties);
  h.jobs[1].resolve(output()); await next;
  // An external replacement is not owned by this controller's clear operation.
  h.getFrame().atomeyeResults.coordinationPolyhedra = other;
  h.controller.cancel(); assert.equal(h.getFrame().atomeyeResults.coordinationPolyhedra, other);
});

test('Crystal export callbacks receive formats or current results and a restored recipe recalculates', async t => {
  const h = harness(t);
  h.field('export-crystal-cif').dispatch('click'); await Promise.resolve();
  h.field('export-crystal-poscar').dispatch('click'); await Promise.resolve();
  assert.deepEqual(h.exports, ['cif', 'poscar']);
  const settings = { enabled: true, ...CRYSTAL_TOOL_DEFAULTS, centerTypes: ['Ti'], neighborTypes: ['O'], showEdges: false };
  const restored = h.controller.restore(settings);
  assert.equal(h.jobs.length, 1); h.jobs[0].resolve(output()); assert.equal(await restored, true);
  assert.deepEqual(h.controller.serialize(), settings);
  h.field('export-crystal-statistics').dispatch('click'); await Promise.resolve();
  assert.equal(h.exports.at(-1), h.controller.getResult());
  h.controller.reset(); assert.equal(h.controller.isUntouched(), true); assert.equal(h.controller.isEnabled(), false);
  assert.equal(h.field('export-crystal-statistics').disabled, true);
  const n = h.jobs.length;
  assert.equal(await h.controller.restore(settings, { isCurrent: () => false }), false);
  assert.equal(h.jobs.length, n);
});

test('Crystal recipes are optional, portable, strict, and accept a CIF source', () => {
  assert.equal(Object.hasOwn(createConfiguration().settings.extensions, 'crystal'), false);
  const crystal = { enabled: true, ...CRYSTAL_TOOL_DEFAULTS, centerTypes: ['Ti'], neighborTypes: ['O'] };
  const recipe = createConfiguration({ settings: { activeTool: 'crystal', extensions: { crystal } },
    source: { format: 'cif', files: [{ name: 'rutile.cif', size: 500 }], frameCount: 1 } });
  assert.deepEqual(parseConfiguration(JSON.stringify(recipe)), recipe);
  assert.deepEqual(recipe.settings.extensions.crystal, crystal);
  assert.equal(matchesSource(recipe, [{ name: 'rutile.cif', size: 500 }], 'cif'), true);
  assert.equal(matchesSource(recipe, [{ name: 'rutile.cif', size: 500 }], 'poscar'), false);
  crystal.centerTypes.push('Ba'); assert.deepEqual(recipe.settings.extensions.crystal.centerTypes, ['Ti']);
  for (const invalid of [{ cutoff: 0 }, { cutoff: null }, { cutoff: 1e7 }, { cutoff: '3' }, { opacity: 2 },
    { color: 'red' }, { centerTypes: [0] }, { centerTypes: ['Ti', 'Ti'] }, { neighborTypes: '' },
    { showEdges: 1 }, { enabled: 'yes' }, { cells: [] }, { vertices: [0, 0, 0] }]) {
    assert.throws(() => createConfiguration({ settings: { extensions: { crystal: invalid } } }), /settings\.extensions\.crystal/);
  }
});
