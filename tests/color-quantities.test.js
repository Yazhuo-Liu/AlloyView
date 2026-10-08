import assert from 'node:assert/strict';
import test from 'node:test';
import { ColorQuantityResolver, initialColorQuantities, BUILTIN_COLOR_MODES } from '../src/render/color-quantities.js';
import { parseXyzFrame } from '../src/io/xyz.js';
import { replicateFrame } from '../src/data/replicate.js';
import { createConfiguration, parseConfiguration } from '../src/configuration.js';
import { colorsByProperty } from '../src/render/palette.js';

function fixture(velocities = true) {
  return parseXyzFrame(`2\nLattice="10 0 0 2 10 0 1 1 10" pbc="T T T" Properties=species:S:1:pos:R:3${velocities ? ':velocity:R:3' : ''}\nFe 12 3 4${velocities ? ' 3 -4 0' : ''}\nNi 2 1 1${velocities ? ' 0 0 2' : ''}\n`);
}

test('coordinates and imported velocity colors are available without publishing analysis properties', () => {
  const frame = fixture(), properties = [...frame.properties], resolver = new ColorQuantityResolver();
  const options = initialColorQuantities(frame);
  for (const axis of 'xyz') assert.ok(options.some(entry => entry.value === `builtin:position:${axis}`));
  for (const axis of [0, 1, 2]) assert.match(options.find(entry => entry.value === `property:velocity_${axis}`).label, new RegExp(`Velocity ${'XYZ'[axis]}`));
  assert.deepEqual([...resolver.resolve(frame, 'builtin:velocity:magnitude').data], [5, 2]);
  assert.equal(resolver.resolve(frame, 'property:velocity_0'), properties[0]);
  assert.deepEqual(frame.properties, properties);
  assert.equal(frame.vectorPropertyResults, undefined);
});

test('coordinate colors follow Cartesian wrapped/unwrapped display and keep one cached scalar array', () => {
  const frame = fixture(), resolver = new ColorQuantityResolver();
  const wrapped = resolver.resolve(frame, 'builtin:position:x');
  assert.deepEqual([...wrapped.data], [frame.positions[0], frame.positions[3]]);
  assert.equal(resolver.resolve(frame, 'builtin:position:x'), wrapped);
  const unwrapped = resolver.resolve(frame, 'builtin:position:x', { coordinateMode: 'unwrapped' });
  assert.deepEqual([...unwrapped.data], [12, 2]);
  assert.notEqual(unwrapped, wrapped);
  assert.match(unwrapped.displayName, /unwrapped/);
  const y = resolver.resolve(frame, 'builtin:position:y');
  assert.equal(resolver.current.property, y);
  resolver.clear(); assert.equal(resolver.current, null);
});

test('absent or partial velocity data retains raw scalars but offers no speed', () => {
  const frame = fixture(false), resolver = new ColorQuantityResolver();
  assert.equal(initialColorQuantities(frame).length, 3);
  frame.properties.push({ name: 'vx', unit: '', data: new Float32Array([1, 2]) });
  assert.ok(initialColorQuantities(frame).some(entry => entry.value === 'property:vx'));
  assert.equal(initialColorQuantities(frame).some(entry => entry.value === 'builtin:velocity:magnitude'), false);
  assert.equal(resolver.resolve(frame, 'builtin:velocity:magnitude'), null);
});

test('imported builtin-like names retain distinct data and legend preference keys', () => {
  const frame = fixture(false), resolver = new ColorQuantityResolver();
  const source = { name: 'builtin:position:x', unit: '', data: new Float64Array([77, 88]) };
  frame.properties.push(source);
  const builtin = resolver.resolve(frame, 'builtin:position:x');
  const imported = resolver.resolve(frame, 'property:builtin:position:x');
  assert.notEqual(imported.name, builtin.name);
  assert.equal(imported.displayName, source.name);
  assert.equal(imported.data, source.data);
  assert.deepEqual([...source.data], [77, 88]);
  assert.equal(initialColorQuantities(frame).filter(entry => /position:x$/.test(entry.value)).length, 2);
});

test('velocity aliases preserve imported units, zero speed and invalid-value conventions', () => {
  const frame = fixture(false), resolver = new ColorQuantityResolver();
  frame.properties = ['vx', 'vy', 'vz'].map((name, axis) => ({ name, unit: 'Å/ps', data: new Float64Array([0, axis === 0 ? NaN : 4]) }));
  const speed = resolver.resolve(frame, 'builtin:velocity:magnitude');
  assert.equal(speed.unit, 'Å/ps'); assert.equal(speed.data[0], 0); assert.ok(Number.isNaN(speed.data[1]));
  assert.match(initialColorQuantities(frame).find(entry => entry.value === 'property:vz').label, /Velocity Z.*Å\/ps/);
});

test('replication colors use enlarged physical coordinates and repeated original velocities', async () => {
  const frame = fixture(), resolver = new ColorQuantityResolver();
  const replicated = await replicateFrame(frame, [2, 1, 1]);
  const position = resolver.resolve(replicated, 'builtin:position:x');
  assert.deepEqual([...position.data], Array.from({ length: 4 }, (_, atom) => replicated.positions[atom * 3]));
  const unwrapped = resolver.resolve(replicated, 'builtin:position:x', { coordinateMode: 'unwrapped' });
  assert.equal(unwrapped.data[2] - unwrapped.data[0], 10);
  assert.deepEqual([...resolver.resolve(replicated, 'builtin:velocity:magnitude').data], [5, 2, 5, 2]);
});

test('builtin quantity settings round-trip with independent manual ranges and reject unknown modes', () => {
  for (const colorMode of BUILTIN_COLOR_MODES) {
    const recipe = createConfiguration({ settings: { display: { colorMode }, colors: {
      ranges: [{ property: colorMode, minimum: -2, maximum: 4 }],
      schemes: [{ property: colorMode, scheme: 'viridis' }],
    } } });
    assert.deepEqual(parseConfiguration(JSON.stringify(recipe)), recipe);
  }
  assert.throws(() => createConfiguration({ settings: { display: { colorMode: 'builtin:position:q' } } }), /colorMode/);
});

test('hidden atoms do not widen coordinate Auto bounds, and fixed ranges survive another frame', () => {
  const resolver = new ColorQuantityResolver(), first = fixture();
  const property = resolver.resolve(first, 'builtin:position:x', { coordinateMode: 'unwrapped' });
  const auto = colorsByProperty(property, undefined, 'viridis', new Set(), new Uint8Array([0, 255]));
  assert.equal(auto.legend.minimum, 2);
  const next = fixture(); next.unwrappedPositions = new Float64Array([100, 3, 4, 101, 1, 1]);
  const palette = colorsByProperty(resolver.resolve(next, 'builtin:position:x', { coordinateMode: 'unwrapped' }), { minimum: -2, maximum: 4 });
  assert.equal(palette.legend.minimum, -2); assert.equal(palette.legend.maximum, 4);
});
