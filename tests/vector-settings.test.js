import test from 'node:test';
import assert from 'node:assert/strict';
import { availableVectorSources, findVectorComponents, importedVectorComponents, linkedArrowDimensions } from '../src/vector-settings.js';
import { registerVectorProperties } from '../src/analysis/vector-properties.js';

test('presets select a complete numeric family without mixing vector sources', () => {
  const properties = ['fx', 'vy', 'fz', 'Force_0', 'Force_1', 'Force_2'].map(name => ({ name }));
  assert.deepEqual(findVectorComponents(properties, 'force').map(property => property.name), ['Force_0', 'Force_1', 'Force_2']);
  assert.equal(findVectorComponents(properties, 'velocity'), null);
  assert.deepEqual(findVectorComponents(['v[1]', 'v[2]', 'v[3]'].map(name => ({ name })), 'velocity').map(property => property.name), ['v[1]', 'v[2]', 'v[3]']);
  assert.equal(findVectorComponents([{ name: 'fx' }, { name: 'fy', categories: ['low'] }, { name: 'fz' }], 'force'), null);
  const derived = ['forceX', 'forceY', 'forceZ'].map(name => ({ name, analysisKind: 'vectors' }));
  assert.equal(findVectorComponents(derived, 'force'), null);
  assert.deepEqual(findVectorComponents([...derived, ...properties], 'force').map(property => property.name), ['Force_0', 'Force_1', 'Force_2']);
});

test('dimension links preserve an arbitrary manually chosen ratio from any edited dimension', () => {
  const previous = { radius: .1, headRadius: .4, headLength: .8 };
  assert.deepEqual(linkedArrowDimensions(previous, 'headLength', 2.4), { radius: .3, headRadius: 1.2, headLength: 2.4 });
  assert.deepEqual(previous, { radius: .1, headRadius: .4, headLength: .8 });
  for (const value of [0, -1, Infinity, NaN]) assert.throws(() => linkedArrowDimensions(previous, 'radius', value), /positive finite/);
});

test('preset recomputation keeps the original family priority when derived fields shadow imported aliases', () => {
  for (const mode of ['force', 'velocity']) {
    const original = ['X', 'Y', 'Z'].map((axis, index) => ({ name: `${mode}${axis}`, data: new Float64Array([index + 1]) }));
    const aliases = ['x', 'y', 'z'].map((axis, index) => ({ name: `${mode}_${axis}`, data: new Float64Array([(index + 1) * 10]) }));
    const frame = { ids: new Uint32Array([1]), properties: [...original, ...aliases] };
    for (let repeat = 0; repeat < 3; repeat++) {
      const components = importedVectorComponents(frame, mode);
      assert.deepEqual(components, original);
      registerVectorProperties(frame, { mode, vectors: components.map(item => item.data[0]) });
      assert.deepEqual([...frame.analysisOriginalProperties.values()], original);
    }
    assert.deepEqual(frame.properties.slice(0, 3).map(item => item.data[0]), [1, 2, 3]);
  }
});

test('an original property absent from the live list can still complete an imported vector family', () => {
  const original = ['forceX', 'forceY', 'forceZ'].map(name => ({ name, data: new Float32Array([1]) }));
  const frame = { properties: [original[0], original[1]], analysisOriginalProperties: new Map([[original[2].name, original[2]]]) };
  assert.deepEqual(importedVectorComponents(frame, 'force'), original);
  assert.equal(importedVectorComponents({ properties: [] }, 'force'), null);
});

const field = (name, extra = {}) => ({ name, data: new Float32Array([1, 2]), ...extra });
const source = (sources, name) => sources.find(candidate => candidate.value === name);

test('vector source discovery shows only existing complete imported presets and does not create properties', () => {
  const properties = ['fx', 'fy', 'fz', 'vx', 'vy'].map(name => field(name));
  const frame = { ids: new Uint32Array(2), properties };
  const sources = availableVectorSources(frame);
  assert.deepEqual(sources.map(item => item.value), ['generic', 'force']);
  assert.equal(source(sources, 'generic').components, null);
  assert.deepEqual(source(sources, 'force').components, properties.slice(0, 3));
  assert.equal(frame.properties, properties);
  assert.equal(properties.length, 5);
  assert.equal(frame.analysisOriginalProperties, undefined);
  assert.deepEqual(availableVectorSources(null), [{ value: 'generic', label: 'Custom XYZ properties', components: null }]);
});

test('displacement is available only after an enabled displacement calculation publishes all three components', () => {
  const frame = { ids: new Uint32Array(2), properties: ['displacementX', 'displacementY', 'displacementZ'].map(name => field(name)) };
  assert.equal(source(availableVectorSources(frame, { displacementEnabled: true }), 'displacement'), undefined, 'imported names alone are not a displacement analysis');
  registerVectorProperties(frame, { mode: 'displacement', vectors: [1, 2, 3, 4, 5, 6] });
  assert.equal(source(availableVectorSources(frame), 'displacement'), undefined, 'a disabled calculation is not selectable');
  const selected = source(availableVectorSources(frame, { displacementEnabled: true }), 'displacement');
  assert.ok(selected.components.every(item => item.analysisKind === 'displacement'));
  frame.properties = frame.properties.filter(item => item.name !== 'displacementZ');
  assert.equal(source(availableVectorSources(frame, { displacementEnabled: true }), 'displacement'), undefined);
});

test('complete other XYZ and zero/one-based indexed families become stable named vector sources', () => {
  const named = [
    field('dipole.x'), field('dipole_y'), field('DipoleZ'),
    field('c_flux[1]'), field('c_flux[2]'), field('c_flux[3]'),
    field('spin_0'), field('spin_1'), field('spin_2'),
    field('ptmDirectionX', { analysisKind: 'ptm' }), field('ptmDirectionY', { analysisKind: 'ptm' }), field('ptmDirectionZ', { analysisKind: 'ptm' }),
  ];
  const frame = { ids: new Uint32Array(2), properties: named };
  const sources = availableVectorSources(frame);
  assert.deepEqual(sources.map(item => item.value), ['generic', 'property:dipole', 'property:cflux', 'property:spin', 'property:ptmdirection']);
  for (const [index, family] of ['dipole', 'cflux', 'spin', 'ptmdirection'].entries()) {
    assert.deepEqual(source(sources, `property:${family}`).components, named.slice(index * 3, index * 3 + 3));
  }
  assert.equal(source(sources, 'property:cflux').label, 'c_flux');
  assert.equal(frame.properties, named);
});

test('source discovery respects Extended XYZ metadata and excludes categories, short fields and partial families', () => {
  const metadata = { name: 'Angular momentum', width: 3 };
  const properties = Array.from({ length: 3 }, (_, component) => field(`angular_${component}`, { field: metadata, component }));
  properties.push(field('brokenX'), field('brokenY'), field('brokenZ', { categories: ['low', 'high'] }),
    field('shortX'), field('shortY'), field('shortZ', { data: new Float32Array(1) }),
    field('mixedX'), field('mixed_1'), field('mixed_2'));
  const sources = availableVectorSources({ ids: new Uint32Array(2), properties });
  assert.deepEqual(sources.map(item => item.value), ['generic', 'property:angularmomentum']);
  assert.equal(source(sources, 'property:angularmomentum').label, 'Angular momentum');
  assert.deepEqual(source(sources, 'property:angularmomentum').components, properties.slice(0, 3));
});

test('imported presets remain selectable through legacy calculated name collisions without duplicate family entries', () => {
  const imported = ['forceX', 'forceY', 'forceZ', 'velocityX', 'velocityY', 'velocityZ'].map(name => field(name));
  const frame = { ids: new Uint32Array(2), properties: [...imported] };
  registerVectorProperties(frame, { mode: 'force', vectors: [1, 2, 3, 4, 5, 6] });
  registerVectorProperties(frame, { mode: 'velocity', vectors: [1, 2, 3, 4, 5, 6] });
  const sources = availableVectorSources(frame);
  assert.deepEqual(sources.map(item => item.value), ['generic', 'force', 'velocity']);
  assert.deepEqual(source(sources, 'force').components, imported.slice(0, 3));
  assert.deepEqual(source(sources, 'velocity').components, imported.slice(3, 6));
  assert.equal(source(availableVectorSources({ properties: ['forceX', 'forceY', 'forceZ'].map(name => field(name, { analysisKind: 'other' })) }), 'force'), undefined);
});
