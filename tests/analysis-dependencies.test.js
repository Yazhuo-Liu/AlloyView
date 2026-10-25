import assert from 'node:assert/strict';
import test from 'node:test';
import { affectedPropertyNames, createAnalysisDependencies } from '../src/application/analysis-dependencies.js';
import { initializeExpressionControls } from '../src/ui/properties/expression-controls.js';

function harness() {
  const frame = { ids: Uint32Array.of(1, 2), types: Uint8Array.of(0, 0), typeLabels: ['Fe'],
    positions: new Float64Array(6), fractional: new Float64Array(6), cell: { vectors: Float64Array.of(2, 0, 0, 0, 2, 0, 0, 0, 2) }, properties: [] };
  const producers = new Map(), calls = [], filters = { crystalSource: null, quantity: 'type' };
  const expressions = initializeExpressionControls({ getFrame: () => frame, documentRoot: null });
  const deps = createAnalysisDependencies({ getFrame: () => frame, getProducer: name => { calls.push(name); return producers.get(name); },
    getExpressionStatus: name => expressions.getPropertyStatus(name), getExpressionReferences: name => expressions.getPropertyReferences(name),
    getFilters: () => filters });
  return { frame, producers, calls, filters, expressions, deps };
}

test('column edits invalidate transitive computed consumers without evaluating unrelated recipes', () => {
  const h = harness();
  h.expressions.setState({ properties: [
    { name: 'base', expression: '`energy` * 2', unit: '' },
    { name: 'chained', expression: 'BASE + 1', unit: '' },
    { name: 'symmetry', expression: 'CSP ^ 2', unit: '' },
    { name: 'literal', expression: '`CSP` + 1', unit: '' },
    { name: 'unrelated', expression: 'Position.X', unit: '' },
  ] });
  const affected = names => affectedPropertyNames(names, h.expressions.getState().properties,
    name => h.expressions.getPropertyReferences(name));
  assert.deepEqual(affected(['ENERGY']), ['ENERGY', 'base', 'chained']);
  assert.deepEqual(affected(['centralSymmetry']), ['centralSymmetry', 'symmetry']);
  assert.deepEqual(affected(['CSP']), ['CSP', 'symmetry', 'literal']);
  assert.deepEqual(affected(['base']), ['base', 'chained']);
  assert.deepEqual(affected([]), []);
  assert.equal(affected(null), null);
  assert.equal(h.frame.properties.length, 0);
});

test('column edits invalidate velocity builtins and their consumers after an imported family changes', () => {
  const h = harness();
  h.expressions.setState({ properties: [
    { name: 'speed2', expression: 'Velocity.Magnitude * 2', unit: '' },
    { name: 'downstream', expression: 'speed2 + 1', unit: '' },
    { name: 'component', expression: 'Velocity.X', unit: '' },
    { name: 'literal', expression: '`Velocity.X`', unit: '' },
  ] });
  const affected = names => affectedPropertyNames(names, h.expressions.getState().properties,
    name => h.expressions.getPropertyReferences(name));
  assert.deepEqual(affected(['vx']), ['vx', 'speed2', 'downstream', 'component']);
  assert.deepEqual(affected([]), []);
});

test('only a current-frame active producer makes a missing quantity pending; present arrays remain ready', () => {
  const h = harness();
  assert.equal(h.deps.getPropertyDependency('property:centralSymmetry').state, 'unavailable');
  h.producers.set('centralSymmetry', { name: 'Central symmetry', state: 'pending' });
  assert.equal(h.deps.getPropertyDependency('property:centralSymmetry').state, 'pending');
  assert.equal(h.deps.getPropertyDependency('property:centralSymmetry', { ...h.frame }).state, 'unavailable');
  h.frame.properties.push({ name: 'centralSymmetry', data: Float64Array.of(0, 1) });
  assert.equal(h.deps.getPropertyDependency('property:centralSymmetry').state, 'ready');
  h.frame.properties[0].data = Float64Array.of(0);
  h.producers.set('centralSymmetry', { state: 'unavailable', message: 'The symmetry calculation failed.' });
  assert.match(h.deps.getPropertyDependency('property:centralSymmetry').message, /failed/);
});

test('computed dependencies follow parsed references and analysis aliases without evaluation', () => {
  const h = harness();
  h.expressions.setState({ properties: [
    { name: 'base', expression: 'CSP + Position.X + ID + Type + Frame', unit: '' },
    { name: 'squared', expression: 'BASE^2', unit: '' },
  ] });
  h.expressions.sync(h.frame);
  h.producers.set('centralSymmetry', { name: 'Central symmetry', state: 'pending' });
  const pending = h.deps.getPropertyDependency('property:squared');
  assert.equal(pending.state, 'pending');
  assert.deepEqual(pending.producers, ['Central symmetry']);
  assert.deepEqual(h.calls, ['centralSymmetry'], 'built-ins do not look for producers or create per-atom fields');
  h.producers.clear();
  assert.match(h.deps.getPropertyDependency('property:squared').message, /squared requires base.*base requires centralSymmetry/);
  h.frame.properties.push({ name: 'centralSymmetry', data: Float64Array.of(1, 2) });
  h.expressions.sync(h.frame);
  assert.equal(h.deps.getPropertyDependency('property:squared').state, 'ready');
});

test('quoted names retain columns, aliases respect raw-column precedence, and conflicts never wait', () => {
  const h = harness();
  h.frame.properties.push({ name: 'csp', data: Float64Array.of(3, 4) });
  h.expressions.setState({ properties: [{ name: 'raw', expression: 'CSP', unit: '' }, { name: 'quoted', expression: '`missing` + 1', unit: '' }] });
  h.expressions.sync(h.frame);
  h.producers.set('centralSymmetry', { name: 'CSP analysis', state: 'pending' });
  assert.equal(h.deps.getPropertyDependency('property:raw').state, 'ready');
  assert.match(h.deps.getPropertyDependency('property:quoted').message, /missing/);
  h.frame.properties.push({ name: 'raw', data: Float64Array.of(5) });
  h.expressions.sync(h.frame);
  assert.match(h.deps.getPropertyDependency('property:raw').message, /already has a property/);
});

test('visible surfaces depend only on the selected hidden classification and filtered color quantity', () => {
  const h = harness(), hidden = new Map([['structureType', new Set([1])], ['ptmStructureType', new Set([3])], ['otherQuantity', new Set([0])]]);
  h.producers.set('structureType', { name: 'CNA', state: 'pending' });
  h.producers.set('ptmStructureType', { name: 'PTM', state: 'pending' });
  h.filters.hiddenCategories = name => hidden.get(name);
  h.filters.crystalSource = 'structureType';
  assert.deepEqual(h.deps.getVisibilityDependencies().map(input => input.name), ['CNA']);
  assert.deepEqual(h.calls, ['structureType']);
  h.calls.length = 0; hidden.get('structureType').clear();
  assert.deepEqual(h.deps.getVisibilityDependencies(), []);
  assert.deepEqual(h.calls, [], 'unfiltered classification outputs cannot serialize independent analyses');
  h.filters.quantity = 'property:otherQuantity';
  assert.equal(h.deps.getVisibilityDependencies()[0].state, 'unavailable');
});

test('visible masks wait for enabled producers despite existing imported or earlier values', () => {
  const h = harness();
  h.frame.properties.push({ name: 'structureType', data: Uint8Array.of(1, 3) });
  h.producers.set('structureType', { name: 'CNA', state: 'pending' });
  h.filters.crystalSource = 'structureType';
  h.filters.hiddenCategories = name => name === 'structureType' ? new Set([1]) : null;
  assert.equal(h.deps.getPropertyDependency('property:structureType').state, 'ready', 'Binning can explicitly consume a present imported column');
  assert.deepEqual(h.deps.getVisibilityDependencies(), [{ name: 'CNA', state: 'pending' }]);
  h.producers.set('structureType', { state: 'unavailable' });
  assert.deepEqual(h.deps.getVisibilityDependencies(), [], 'existing input classifications remain usable when no calculation is active');

  h.frame.properties.push({ name: 'centralSymmetry', data: Float64Array.of(1, 2) });
  h.expressions.setState({ properties: [
    { name: 'base', expression: 'CSP * 2', unit: '' }, { name: 'squared', expression: 'base^2', unit: '' },
  ] });
  h.expressions.sync(h.frame);
  h.filters.crystalSource = null; h.filters.quantity = 'property:squared';
  h.filters.scalarRange = () => ({ minimum: 0, maximum: 1 });
  h.producers.set('centralSymmetry', { name: 'Central symmetry', state: 'pending' });
  assert.equal(h.deps.getPropertyDependency('property:squared').state, 'ready');
  const dependency = h.deps.getVisibilityDependencies()[0];
  assert.equal(dependency.state, 'pending');
  assert.deepEqual(dependency.producers, ['Central symmetry'], 'present computed values retain their transitive mask dependencies');
});

test('a failed requested producer cannot certify an earlier computed mask as the current formal appearance', () => {
  const h = harness();
  const property = { name: 'structureType', analysisKind: 'cna', data: Uint8Array.of(1, 3) };
  h.frame.properties.push(property);
  h.filters.crystalSource = 'structureType';
  h.filters.hiddenCategories = () => new Set([1]);
  h.producers.set('structureType', { state: 'unavailable', failed: true, message: 'CNA failed for the requested cutoff.' });
  assert.equal(h.deps.getPropertyDependency('property:structureType').state, 'ready', 'explicit statistics can still inspect the completed earlier column');
  assert.equal(h.deps.getPropertyDependency('property:structureType', h.frame, { waitForProducers: true }).state, 'unavailable');
  assert.match(h.deps.getVisibilityDependencies()[0].message, /requested cutoff/);
  delete property.analysisKind;
  assert.deepEqual(h.deps.getVisibilityDependencies(), [], 'an actual imported column remains usable independently of the failed optional producer');
});

test('quoted references follow the expression kernel exact-first case fallback and never alias builtins', () => {
  const h = harness();
  h.frame.properties.push({ name: 'Foo', data: Float64Array.of(3, 4) });
  h.expressions.setState({ properties: [
    { name: 'folded', expression: '`foo` * 2', unit: '' },
    { name: 'combined', expression: '`foo` + CSP', unit: '' },
    { name: 'literalBuiltin', expression: '`position.x`', unit: '' },
  ] });
  h.expressions.sync(h.frame);
  assert.deepEqual(h.frame.properties.find(property => property.name === 'folded').data, Float64Array.of(6, 8));
  assert.equal(h.deps.getPropertyDependency('property:folded').state, 'ready');
  h.producers.set('centralSymmetry', { name: 'Central symmetry', state: 'pending' });
  assert.equal(h.deps.getPropertyDependency('property:combined').state, 'pending', 'quoted Foo is a valid folded column and only CSP remains pending');
  assert.equal(h.deps.getPropertyDependency('property:literalBuiltin').state, 'unavailable');
  h.frame.properties.push({ name: 'FOO', data: Float64Array.of(5, 6) });
  h.expressions.sync(h.frame);
  assert.equal(h.expressions.getPropertyStatus('combined').state, 'waiting', 'the evaluator can encounter missing CSP before the ambiguous column');
  assert.equal(h.deps.getPropertyDependency('property:combined').state, 'unavailable', 'ambiguous quoted names fail instead of waiting for unrelated CSP');
});

test('fixed scalar hiding follows transitive computations and built-in coordinates need no producer', () => {
  const h = harness();
  h.expressions.setState({ properties: [{ name: 'maskQuantity', expression: 'CSP * 2', unit: '' }] }); h.expressions.sync(h.frame);
  h.producers.set('centralSymmetry', { name: 'Central symmetry', state: 'pending' });
  h.filters.quantity = 'property:maskQuantity';
  h.filters.scalarRange = () => ({ minimum: 0, maximum: 1 });
  h.filters.hideOutside = () => false;
  assert.deepEqual(h.deps.getVisibilityDependencies(), []);
  h.filters.hideOutside = () => true;
  assert.equal(h.deps.getVisibilityDependencies()[0].state, 'pending');
  h.filters.quantity = 'builtin:position:x';
  assert.deepEqual(h.deps.getVisibilityDependencies(), []);
});

test('static builtin inspection never reads per-atom IDs/types or allocates their derived arrays', () => {
  const h = harness();
  const noAtoms = new Proxy({ length: 1_000_000 }, { get(target, key) { if (key === 'length') return target.length; throw new Error(`Unexpected per-atom read ${String(key)}`); } });
  h.frame.ids = noAtoms; h.frame.types = noAtoms; h.frame.positions = { length: 3_000_000 };
  h.expressions.setState({ properties: [{ name: 'builtinOnly', expression: 'ID + Type + Index + Position.X + N + Frame', unit: '' }] });
  assert.equal(h.deps.getPropertyDependency('builtin:position:x').state, 'ready');
  assert.equal(h.deps.getPropertyDependency('property:builtinOnly').state, 'unavailable', 'a saved but unevaluated recipe has no active asynchronous producer');
  assert.deepEqual(h.calls, []);
  assert.equal(h.frame.properties.length, 0);
});
