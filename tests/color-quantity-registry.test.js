import assert from 'node:assert/strict';
import test from 'node:test';
import { createColorQuantityRegistry } from '../src/application/color-quantity-registry.js';
import { parseXyzFrame } from '../src/io/xyz.js';

const frame = () => parseXyzFrame('2\nLattice="10 0 0 0 10 0 0 0 10" pbc="T T T" Properties=species:S:1:pos:R:3:c_pe:R:1\nFe 1 2 3 -4\nNi 4 5 6 -3\n');

test('the menu lists atom type, published quantities, then pending ones in registration order', () => {
  const registry = createColorQuantityRegistry();
  registry.register({ pendingColorProperties: () => [{ name: 'coordination', label: 'coordination' }] });
  registry.register({ pendingColorModes: () => [{ value: 'builtin:ptm:ipf', label: 'PTM orientation · inverse pole figure' }] });
  registry.register({ pendingColorProperties: () => [{ name: 'wait', label: 'wait [eV]', note: 'waiting for external data…' }] });
  const values = registry.options(frame()).map(item => item.value);
  assert.deepEqual(values, ['type', 'builtin:position:x', 'builtin:position:y', 'builtin:position:z', 'property:c_pe',
    'property:coordination', 'builtin:ptm:ipf', 'property:wait']);
  const labels = Object.fromEntries(registry.options(frame()).map(item => [item.value, item.label]));
  assert.equal(labels['property:coordination'], 'coordination (calculating…)');
  assert.equal(labels['builtin:ptm:ipf'], 'PTM orientation · inverse pole figure (calculating…)');
  assert.equal(labels['property:wait'], 'wait [eV] (waiting for external data…)');
  assert.equal(labels.type, 'Atom type');
});

test('published quantities win over pending placeholders and a selection stays listed', () => {
  const registry = createColorQuantityRegistry();
  registry.register({ pendingColorProperties: () => [{ name: 'c_pe', label: 'c_pe' }] });
  const current = frame();
  const options = registry.options(current, { selected: 'property:c_pe' });
  assert.deepEqual(options.filter(item => item.value === 'property:c_pe').map(item => item.label), ['c_pe']);
  const missing = registry.options(current, { selected: 'property:gone' });
  assert.deepEqual(missing.at(-1), { value: 'property:gone', label: 'gone (unavailable in this frame)' });
  assert.deepEqual(registry.options(current, { selected: 'builtin:ptm:ipf' }).at(-1),
    { value: 'builtin:ptm:ipf', label: 'builtin:ptm:ipf (unavailable in this frame)' });
  assert.deepEqual(createColorQuantityRegistry().options(null).map(item => item.value), ['type']);
});

test('kinds and failures aggregate across providers that implement only some methods', () => {
  const registry = createColorQuantityRegistry();
  const grains = { pendingColorProperties: () => [{ name: 'grainId', label: 'Grain ID' }],
    pendingKinds: () => ['grains'], getPropertyKind: name => name === 'grainId' ? 'grains' : null, failed: () => [] };
  const topology = { pendingKinds: () => [], getPropertyKind: name => name === 'q6' ? 'bondOrder' : null, failed: () => ['bondOrder'] };
  const dxa = { pendingColorProperties: () => [{ name: 'dxaStructureType', label: 'Crystal structure (DXA)' }], failed: () => ['dxa'] };
  for (const provider of [grains, topology, dxa, grains]) registry.register(provider);
  assert.deepEqual(registry.pendingKinds(), ['grains']);
  assert.equal(registry.propertyKind('grainId'), 'grains');
  assert.equal(registry.propertyKind('q6'), 'bondOrder');
  assert.equal(registry.propertyKind('dxaStructureType'), null);
  assert.deepEqual(registry.failedKinds(), ['bondOrder', 'dxa']);
  assert.deepEqual(registry.pendingProperties().map(({ provider, name }) => [provider === grains ? 'grains' : 'dxa', name]),
    [['grains', 'grainId'], ['dxa', 'dxaStructureType']]);
  registry.register(null);
  assert.equal(registry.pendingProperties().length, 2);
});
