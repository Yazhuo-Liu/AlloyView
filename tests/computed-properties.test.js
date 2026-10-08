import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyComputedProperties, compileComputedProperties, COMPUTED_PROPERTY_KIND, isComputedProperty,
  MAX_COMPUTED_PROPERTIES, normalizeComputedPropertyState, removeComputedProperties, validateComputedPropertyName,
} from '../src/computed-properties.js';
import { createConfiguration, parseConfiguration } from '../src/configuration.js';
import { replicateFrame } from '../src/data/replicate.js';
import { clearAnalysisResults, replaceAnalysisProperty } from '../src/analysis/results.js';

function frame(step = 0, extra = []) {
  const ids = Float64Array.of(1, 2, 3);
  const fractional = Float64Array.of(0.1 + step * 0.1, 0.2, 0.3, 0.5, 0.5, 0.5, 0.9, 0.8, 0.7);
  return {
    ids, idSource: 'explicit', types: Uint16Array.of(0, 1, 0), typeLabels: ['Type 1', 'Type 2'], frameIndex: step, timestep: step * 100,
    fractional, positions: Float64Array.from(fractional, value => value * 10), unwrappedPositions: null, imageFlags: null,
    cell: { origin: Float64Array.of(0, 0, 0), vectors: Float64Array.of(10, 0, 0, 0, 10, 0, 0, 0, 10), pbc: [true, true, true], triclinic: false },
    properties: [
      { name: 'stress', unit: 'bar·Å³', data: Float64Array.of(10, 20, 30).map(value => value * (step + 1)) },
      { name: 'volume', unit: 'Å³', data: Float64Array.of(10, 10, 5) },
      ...extra,
    ],
  };
}

const definitions = properties => compileComputedProperties({ properties });
const computed = target => Object.fromEntries(target.properties.filter(isComputedProperty).map(property => [property.name, Array.from(property.data)]));

test('computed properties are recalculated per frame and reuse unchanged inputs', () => {
  const recipe = definitions([
    { name: 'pressure', unit: 'bar', expression: 'stress / volume' },
    { name: 'scaled', expression: 'pressure * 2 + Position.X' },
  ]);
  const cache = new WeakMap();
  const first = frame(0), second = frame(1);
  const original = first.properties[0];
  let result = applyComputedProperties(first, recipe, cache);
  assert.equal(result.changed, true);
  assert.deepEqual(result.statuses.map(status => status.state), ['ready', 'ready']);
  assert.deepEqual(computed(first), { pressure: [1, 2, 6], scaled: [3, 9, 21] });
  assert.equal(first.properties[0], original, 'input properties are untouched');
  const property = first.properties.find(item => item.name === 'pressure');
  assert.equal(property.unit, 'bar');
  assert.equal(property.analysisKind, COMPUTED_PROPERTY_KIND);
  assert.equal(property.expression, 'stress / volume');

  result = applyComputedProperties(first, recipe, cache);
  assert.equal(result.changed, false, 'unchanged inputs keep the same property objects');
  assert.equal(first.properties.find(item => item.name === 'pressure'), property);

  applyComputedProperties(second, recipe, cache);
  assert.deepEqual(computed(second), { pressure: [2, 4, 12], scaled: [6, 13, 33] });

  // A changed input array (for example a re-imported column) recalculates.
  first.properties[0] = { ...original, data: Float64Array.of(0, 0, 0) };
  applyComputedProperties(first, recipe, cache);
  assert.deepEqual(computed(first).pressure, [0, 0, 0]);
  assert.notEqual(first.properties.find(item => item.name === 'pressure'), property);

  // Removing a definition removes its column; reordering follows the recipe.
  applyComputedProperties(first, definitions([{ name: 'pressure', expression: 'volume' }]), cache);
  assert.deepEqual(computed(first), { pressure: [10, 10, 5] });
  assert.equal(removeComputedProperties(first), true);
  assert.deepEqual(computed(first), {});
  assert.equal(removeComputedProperties(first), false);
});

test('missing analysis inputs wait, then appear when the analysis result arrives', () => {
  const recipe = definitions([{ name: 'defect', expression: 'CSP > 4 ? stress : 0' }]);
  const target = frame(), cache = new WeakMap();
  let result = applyComputedProperties(target, recipe, cache);
  assert.equal(result.statuses[0].state, 'waiting');
  assert.match(result.statuses[0].message, /CSP reads centralSymmetry; calculate it first/);
  assert.deepEqual(computed(target), {});
  replaceAnalysisProperty(target, { name: 'centralSymmetry', data: Float32Array.of(1, 5, 9), analysisKind: 'centrosymmetry' });
  result = applyComputedProperties(target, recipe, cache);
  assert.equal(result.statuses[0].state, 'ready');
  assert.deepEqual(computed(target), { defect: [0, 20, 30] });
  // Cancelling the analysis returns the property to waiting.
  clearAnalysisResults(target, 'centrosymmetry');
  result = applyComputedProperties(target, recipe, cache);
  assert.equal(result.statuses[0].state, 'waiting');
  assert.deepEqual(computed(target), {});
});

test('velocity magnitude updates when only one external component is replaced', () => {
  const target = frame(0, ['vx', 'vy', 'vz'].map((name, axis) => ({ name, data: new Float64Array(3).fill([1, 2, 2][axis]) })));
  const recipe = definitions([{ name: 'speed', expression: 'Velocity.Magnitude' }]), cache = new WeakMap();
  applyComputedProperties(target, recipe, cache);
  assert.deepEqual(computed(target).speed, [3, 3, 3]);
  const x = target.properties.find(property => property.name === 'vx').data;
  for (const [name, value, expected] of [['vy', 6, Math.sqrt(41)], ['vz', 3, Math.sqrt(46)]]) {
    const index = target.properties.findIndex(property => property.name === name);
    target.properties[index] = { name, data: new Float64Array(3).fill(value) };
    assert.equal(applyComputedProperties(target, recipe, cache).changed, true);
    for (const value of computed(target).speed) assert.ok(Math.abs(value - expected) < 1e-12);
    assert.equal(target.properties.find(property => property.name === 'vx').data, x);
    assert.equal(applyComputedProperties(target, recipe, cache).changed, false, 'unchanged components still reuse computed values');
  }
});

test('a column with the same name reports a conflict instead of being replaced', () => {
  const target = frame(0, [{ name: 'Pressure', data: Float64Array.of(7, 7, 7) }]);
  const result = applyComputedProperties(target, definitions([{ name: 'pressure', expression: 'stress' }]));
  assert.equal(result.statuses[0].state, 'conflict');
  assert.match(result.statuses[0].message, /already has a property named “Pressure”/);
  assert.deepEqual(Array.from(target.properties.find(property => property.name === 'Pressure').data), [7, 7, 7]);
});

test('physical replicas recalculate computed values for every copy', async () => {
  const recipe = definitions([{ name: 'xPlusStress', expression: 'Position.X + stress' }]);
  const source = frame();
  applyComputedProperties(source, recipe);
  const replicated = await replicateFrame(source, [2, 1, 1], { yieldTask: async () => {} });
  // Computed values are not copied as inputs; the replica derives its own.
  assert.equal(replicated.properties.some(isComputedProperty), false);
  applyComputedProperties(replicated, recipe);
  const values = computed(replicated).xPlusStress;
  assert.equal(values.length, 6);
  for (let atom = 0; atom < 6; atom++) {
    assert.ok(Math.abs(values[atom] - (replicated.positions[atom * 3] + replicated.properties[0].data[atom])) < 1e-9);
  }
});

test('names must be unique identifiers that do not shadow built-ins or analysis fields', () => {
  assert.equal(validateComputedPropertyName(' vonMises '), 'vonMises');
  assert.equal(validateComputedPropertyName('stress.vm'), 'stress.vm');
  for (const [name, pattern] of [
    ['', /Enter a property name/], ['1abc', /starting with a letter/], ['von Mises', /letters, digits/], ['a-b', /letters, digits/],
    ['x'.repeat(65), /up to 64/], ['Position.X', /built-in expression variable/], ['type', /built-in expression variable/],
    ['csp', /built-in expression variable/], ['n', /built-in expression variable/], ['coordination', /reserved/],
    ['displacementX', /reserved/], ['__proto__', /reserved/], ['constructor', /reserved/],
  ]) assert.throws(() => validateComputedPropertyName(name), pattern, name);
  assert.throws(() => validateComputedPropertyName('Stress', ['stress']), /already exists/);
});

test('recipes validate syntax, order, cycles and keys before use', () => {
  const valid = { properties: [{ name: 'a', unit: 'eV', expression: 'stress\n  * 2' }, { name: 'b', expression: 'a + `a`' }] };
  assert.deepEqual(normalizeComputedPropertyState(valid), { properties: [{ name: 'a', unit: 'eV', expression: 'stress\n  * 2' }, { name: 'b', unit: '', expression: 'a + `a`' }] });
  for (const [value, pattern] of [
    [{ properties: [{ name: 'a', expression: 'b' }, { name: 'b', expression: '1' }] }, /“a” refers to “b”, which is defined after it/],
    [{ properties: [{ name: 'a', expression: 'A + 1' }] }, /“a” cannot refer to itself/],
    [{ properties: [{ name: 'a', expression: 'sqrt(' }] }, /“a”: The expression ends where a value is expected at column 6/],
    [{ properties: [{ name: 'a', expression: 'CSP = 1' }] }, /Use == to compare/],
    [{ properties: [{ name: 'a', expression: 'x'.repeat(4097) }] }, /at most 4096 characters/],
    [{ properties: [{ name: 'a', expression: 'x\u0000' }] }, /expression text/],
    [{ properties: [{ name: 'a', expression: 1 }] }, /expression text/],
    [{ properties: [{ name: 'a', unit: 'x'.repeat(33), expression: '1' }] }, /Units must be printable/],
    [{ properties: [{ name: 'a', expression: '1' }, { name: 'A', expression: '2' }] }, /already exists/],
    [{ properties: [{ name: 'a', expression: '1', values: [1, 2, 3] }] }, /Unexpected properties\[0\] key “values”/],
    [{ properties: [], data: [] }, /Unexpected state key “data”/],
    [JSON.parse('{"properties":[{"name":"a","expression":"1","__proto__":{"polluted":true}}]}'), /Unexpected properties\[0\] key “__proto__”/],
    [{ properties: Array.from({ length: MAX_COMPUTED_PROPERTIES + 1 }, (_, index) => ({ name: `p${index}`, expression: '1' })) }, /up to 64/],
    [{ properties: 'a' }, /up to 64/],
    [[], /Invalid state/],
  ]) assert.throws(() => normalizeComputedPropertyState(value), pattern, JSON.stringify(value).slice(0, 80));
  assert.equal({}.polluted, undefined);
});

test('configuration recipes store expression text and parse it again on import', () => {
  const properties = [{ name: 'vonMises', unit: 'GPa', expression: 'sqrt(0.5 * ((sxx - syy)^2 + (syy - szz)^2 + (szz - sxx)^2)) / atomicVolume / 1e4' },
    { name: 'highStress', unit: '', expression: 'vonMises > 2 && Type == "Fe"' }];
  const configuration = createConfiguration({ settings: { activeTool: 'expressions', extensions: { expressions: { properties } } } });
  assert.equal(configuration.settings.activeCategory, 'modification');
  const restored = parseConfiguration(JSON.stringify(configuration));
  assert.deepEqual(restored.settings.extensions.expressions, { properties });
  assert.deepEqual(restored, configuration);
  assert.equal(createConfiguration({}).settings.extensions.expressions, undefined, 'older recipes have no expression settings');
  for (const [expressions, pattern] of [
    [{ properties: [{ name: 'a', expression: 'b +' }] }, /settings\.extensions\.expressions: “a”: The expression ends/],
    [{ properties: [{ name: 'a', expression: 'b' }, { name: 'b', expression: '1' }] }, /defined after it/],
    [{ properties: [{ name: 'Position.X', expression: '1' }] }, /built-in expression variable/],
    [{ properties: [{ name: 'a', expression: '1', data: [1] }] }, /Unexpected properties\[0\] key/],
  ]) {
    const text = JSON.stringify({ ...configuration, settings: { ...configuration.settings, extensions: { ...configuration.settings.extensions, expressions } } });
    assert.throws(() => parseConfiguration(text), error => error.message.startsWith('Invalid AlloyView configuration:') && pattern.test(error.message), JSON.stringify(expressions));
  }
});
