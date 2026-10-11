import test from 'node:test';
import assert from 'node:assert/strict';
import { availableVectorSources, createVectorField, findVectorComponents, importedVectorComponents, linkedArrowDimensions, renameVectorFieldProperty, vectorFieldData } from '../src/vector-settings.js';
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

test('memoized vector names and component descriptors follow in-place property metadata edits', () => {
  const properties = ['spinX', 'spinY', 'spinZ'].map(name => ({ name, data: Float32Array.of(1) }));
  const frame = { ids: Uint32Array.of(1), properties };
  assert.ok(availableVectorSources(frame).some(source => source.value === 'property:spin'));
  properties.forEach((property, index) => { property.name = `moment${'XYZ'[index]}`; });
  assert.ok(availableVectorSources(frame).some(source => source.value === 'property:moment'));
  assert.equal(availableVectorSources(frame).some(source => source.value === 'property:spin'), false);
  properties.forEach((property, index) => { property.name = `f${'xyz'[index]}`; });
  assert.deepEqual(findVectorComponents(properties, 'force'), properties);
  properties[1].name = 'unrelated';
  assert.equal(findVectorComponents(properties, 'force'), null, 'renaming a cached alias cannot leave a stale complete family');
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

test('multiple fields independently read existing forces and displacement without computing or mutating data', () => {
  const frame = { ids: new Uint32Array([1, 2]), properties: ['fx', 'fy', 'fz'].map((name, axis) => field(name, { data: Float32Array.of(axis + 1, axis + 2) })) };
  registerVectorProperties(frame, { mode: 'displacement', vectors: [4, 5, 6, 7, 8, 9] });
  const original = [...frame.properties], data = frame.properties.map(property => [...property.data]);
  const forces = createVectorField({ id: 'force', name: 'Forces', enabled: true, mode: 'force', scale: 2, color: '#ff0000' });
  const displacement = createVectorField({ id: 'displacement', enabled: true, mode: 'displacement', anchor: 'center', dimension: '2d', upMode: 'fixed', up: [0, 0, 1] });
  assert.deepEqual([...vectorFieldData(frame, forces).vectors], [1, 2, 3, 2, 3, 4]);
  assert.equal(vectorFieldData(frame, forces).options.scale, 2);
  assert.equal(vectorFieldData(frame, displacement), null, 'arrows cannot enable displacement calculations');
  const result = vectorFieldData(frame, displacement, { displacementEnabled: true });
  assert.deepEqual([...result.vectors], [4, 5, 6, 7, 8, 9]);
  assert.equal(result.options.anchor, 'center');
  assert.equal(result.options.upMode, 'fixed');
  assert.deepEqual(result.options.up, [0, 0, 1]);
  assert.deepEqual(frame.properties, original);
  assert.deepEqual(frame.properties.map(property => [...property.data]), data);
});

test('custom fields retain their settings when hidden or temporarily missing on another frame', () => {
  const frame = { ids: new Uint32Array(2), properties: [field('a'), field('b'), field('c')] };
  const settings = { enabled: true, components: ['a', 'b', 'c'], componentScales: [2, 0, -3] };
  const first = createVectorField(settings), second = createVectorField(settings, 'vector-2');
  first.components[0] = 'c'; first.componentScales[0] = 4;
  assert.deepEqual(second.components, ['a', 'b', 'c']);
  assert.deepEqual(second.componentScales, [2, 0, -3]);
  assert.deepEqual([...vectorFieldData(frame, second).vectors], [2, 0, -3, 4, 0, -6]);
  assert.equal(vectorFieldData({ ...frame, properties: [field('a'), field('b')] }, second), null);
  assert.deepEqual(second.components, ['a', 'b', 'c']);
  assert.deepEqual([...vectorFieldData(frame, second).vectors], [2, 0, -3, 4, 0, -6]);
  second.enabled = false;
  assert.equal(vectorFieldData(frame, second), null);
  assert.equal(first.enabled, true);
});

test('arrow appearance and display-origin edits reuse data while source and signed component-scale changes rebuild it', () => {
  const frame = { ids: new Uint32Array(2), properties: ['x', 'y', 'z'].map(name => field(name)) };
  const settings = createVectorField({ enabled: true, components: ['x', 'y', 'z'] }), cache = new Map();
  const first = vectorFieldData(frame, settings, { cache });
  settings.scale = 10; settings.color = '#00ff00'; settings.anchor = 'head';
  frame.displayPositions = new Float32Array([1, 2, 3, 4, 5, 6]);
  const appearance = vectorFieldData(frame, settings, { cache });
  assert.equal(appearance.vectors, first.vectors);
  assert.equal(appearance.options.scale, 10);
  settings.componentScales[0] = -1;
  const componentEdit = vectorFieldData(frame, settings, { cache });
  assert.notEqual(componentEdit.vectors, first.vectors);
  assert.deepEqual([...componentEdit.vectors], [-1, 1, 1, -2, 2, 2]);
  frame.properties[0] = field('x', { data: Float32Array.of(10, 20) });
  const propertyEdit = vectorFieldData(frame, settings, { cache });
  assert.deepEqual([...propertyEdit.vectors], [-10, 1, 1, -20, 2, 2]);
  assert.notEqual(propertyEdit.vectors, componentEdit.vectors);
});

test('renaming a source property preserves custom and preset arrows, keeping their original display scale and style', () => {
  const frame = { ids: new Uint32Array(2), properties: ['fx', 'fy', 'fz'].map(name => field(name)) };
  const custom = createVectorField({ enabled: true, components: ['fx', 'fy', 'fz'], componentScales: [2, -3, 4], scale: 5, color: '#12abef' });
  const preset = createVectorField({ enabled: true, mode: 'force', componentScales: [9, 8, 7], scale: 6, color: '#abcdef', anchor: 'head' });
  const customBefore = vectorFieldData(frame, custom), presetBefore = vectorFieldData(frame, preset);
  frame.properties[0] = { ...frame.properties[0], name: 'appliedForceX' };
  assert.equal(renameVectorFieldProperty(custom, 'fx', 'appliedForceX'), true);
  assert.equal(renameVectorFieldProperty(preset, 'fx', 'appliedForceX', ['fx', 'fy', 'fz']), true);
  const customAfter = vectorFieldData(frame, custom), presetAfter = vectorFieldData(frame, preset);
  assert.deepEqual(customAfter.vectors, customBefore.vectors);
  assert.deepEqual(customAfter.options, customBefore.options);
  assert.deepEqual(presetAfter.vectors, presetBefore.vectors);
  assert.deepEqual(presetAfter.options, presetBefore.options);
  assert.equal(preset.mode, 'generic');
  assert.deepEqual(preset.componentScales, [1, 1, 1]);
  assert.equal(renameVectorFieldProperty(custom, 'unrelated', 'other'), false);
  assert.equal(custom.mode, 'generic');
});
