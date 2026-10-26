import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeCrystalSymmetryControls } from '../src/ui/view/crystal-symmetry-controls.js';
import { crystalFrame } from './helpers/crystals.js';

function setup(t) {
  const previous = globalThis.document, nodes = new Map();
  globalThis.document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { value: id === 'crystal-symmetry-tolerance' ? '0.0001' : 'cif', hidden: false, listeners: new Map(),
      addEventListener(event, callback) { this.listeners.set(event, callback); }, dispatch(event) { return this.listeners.get(event)?.(); } });
    return nodes.get(id);
  } };
  t.after(() => { globalThis.document = previous; });
  let frame = crystalFrame('fcc', 1), source = 1;
  const jobs = [], exports = [], client = { clears: 0, clear() { this.clears++; }, warm() { return Promise.resolve(); },
    analyze(input, options, execution) { return new Promise((resolve, reject) => jobs.push({ input, options, execution, resolve, reject })); } };
  const controls = initializeCrystalSymmetryControls({ client, getFrame: () => frame, getSourceVersion: () => source,
    onExportCell(...args) { return new Promise(resolve => exports.push({ args, resolve })); } });
  controls.setEnabled(true);
  return { controls, nodes, jobs, exports, client, setFrame(next) { frame = next; }, nextSource() { source++; } };
}
const output = () => ({ number: 225, hallNumber: 523, symbol: 'F m -3 m', pearson: 'cF4', operationCount: 192,
  wyckoffs: ['a','a','a','a'], primitive: crystalFrame('sc', 1), conventional: crystalFrame('fcc', 1),
  engine: 'moyo 0.21.0', elapsedMs: 3, symprec: 1e-4 });

test('current geometry yields independent space-group controls and tolerance edits abort stale standardized exports', async t => {
  const h = setup(t), run = h.controls.run(); h.jobs[0].resolve(output()); await run;
  assert.equal(h.controls.getResult().number, 225);
  assert.equal(h.nodes.get('export-crystal-primitive').disabled, false);
  const exporting = h.nodes.get('export-crystal-primitive').dispatch('click');
  assert.equal(h.exports.length, 1); const [frame, format, kind, execution] = h.exports[0].args;
  assert.equal(frame.ids.length, 1); assert.equal(format, 'cif'); assert.equal(kind, 'primitive'); assert.ok(execution.isCurrent());
  h.nodes.get('crystal-symmetry-tolerance').value = '.005'; h.nodes.get('crystal-symmetry-tolerance').dispatch('change');
  assert.equal(execution.signal.aborted, true); assert.equal(execution.isCurrent(), false);
  assert.equal(h.controls.getResult(), null); assert.equal(h.nodes.get('export-crystal-primitive').disabled, true);
  h.exports[0].resolve(); await exporting;
});

test('source, frame and in-place geometry changes discard late native symmetry results', async t => {
  const h = setup(t);
  for (const change of [() => h.nextSource(), () => h.setFrame(crystalFrame('bcc', 1)),
    () => { h.jobs.at(-1).input.geometryRevision = 1; }]) {
    const run = h.controls.run(), job = h.jobs.at(-1); change(); h.controls.onFrame();
    assert.equal(job.execution.signal.aborted, true); job.resolve(output()); await run;
    assert.equal(h.controls.getResult(), null); assert.equal(h.nodes.get('crystal-symmetry-result').hidden, true);
  }
});
