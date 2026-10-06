import assert from 'node:assert/strict';
import test from 'node:test';

import {
  colorsByProperty,
  colorsByCategory,
  colorsByType,
  combineVisibilityMasks,
  coupleScalarRange,
  SCALAR_COLOR_SCHEMES,
  visibilityByProperty,
  visibilityByType,
  visibilityByCategory,
} from '../src/render/palette.js';

test('single-species default is AtomEye-style beige and alloys remain distinguishable', () => {
  const generic = colorsByType({ types: new Uint16Array([0]), typeLabels: ['Type 1'] });
  const nickel = colorsByType({ types: new Uint16Array([0]), typeLabels: ['Ni'] });
  assert.deepEqual([...generic.colors], [218, 201, 164]);
  assert.deepEqual([...nickel.colors], [218, 201, 164]);

  const alloy = colorsByType({ types: new Uint16Array([0, 1]), typeLabels: ['Ni', 'Al'] });
  assert.notDeepEqual([...alloy.colors.slice(0, 3)], [...alloy.colors.slice(3, 6)]);
});

test('automatic colors keep roundoff-level crystal volumes uniform while retaining exact data and manual limits', () => {
  const data = Float64Array.of(16 - 8 * Number.EPSILON * 16, 16, 16 + 8 * Number.EPSILON * 16, NaN);
  const original = data.slice(), property = { name: 'atomicVolume', data };
  const automatic = colorsByProperty(property);
  assert.deepEqual(automatic.colors.slice(0, 3), automatic.colors.slice(3, 6));
  assert.deepEqual(automatic.colors.slice(3, 6), automatic.colors.slice(6, 9));
  assert.deepEqual([...automatic.colors.slice(9)], [130, 130, 130]);
  assert.equal(automatic.legend.minimum, data[0]);
  assert.equal(automatic.legend.maximum, data[2]);
  assert.equal(automatic.legend.customRange, false);
  assert.deepEqual(data, original);
  const manual = colorsByProperty(property, { minimum: data[0], maximum: data[2] });
  assert.notDeepEqual(manual.colors.slice(0, 3), manual.colors.slice(6, 9));
  assert.equal(manual.legend.customRange, true);
});

test('automatic uniform-color tolerance is relative and preserves small physical differences', () => {
  for (const data of [Float64Array.of(1, 1 + 1e-12), Float64Array.of(-1e-30, 1e-30), Float64Array.of(1e-30, 2e-30)]) {
    const result = colorsByProperty({ name: 'strain', data });
    assert.notDeepEqual(result.colors.slice(0, 3), result.colors.slice(3, 6));
    assert.equal(result.legend.minimum, data[0]);
    assert.equal(result.legend.maximum, data[1]);
  }
});

test('atom type legend has counts and visibility choices keyed by labels across frames', () => {
  const hidden = new Set(['Ni']);
  const first = { types: new Uint16Array([0, 1, 0, 0]), typeLabels: ['Ni', 'Al', 'Cu'] };
  const { legend } = colorsByType(first, hidden);
  assert.equal(legend.atomTypes, true);
  assert.equal(legend.atomCount, 4);
  assert.deepEqual(legend.items.map(({ id, label, count, visible }) => ({ id, label, count, visible })), [
    { id: 0, label: 'Ni', count: 3, visible: false },
    { id: 1, label: 'Al', count: 1, visible: true },
    { id: 2, label: 'Cu', count: 0, visible: true },
  ]);
  assert.deepEqual([...visibilityByType(first, hidden)], [0, 255, 0, 0]);
  const second = { types: new Uint16Array([0, 1, 1]), typeLabels: ['Al', 'Ni'] };
  assert.deepEqual([...visibilityByType(second, hidden)], [255, 0, 0]);
  assert.equal(visibilityByType(second, new Set()), null);
});

test('categorical legend retains zero-count classes and applies its own hidden category IDs', () => {
  const property = { name: 'phase', data: new Uint8Array([2, 1, 2]), categories: [
    { id: 0, label: 'Unknown', color: [100, 100, 100] },
    { id: 1, label: 'Solid', color: [0, 0, 255] },
    { id: 2, label: 'Liquid', color: [255, 0, 0] },
  ] };
  const hidden = new Set([2]);
  const { legend } = colorsByCategory(property, hidden);
  assert.equal(legend.atomCount, 3);
  assert.deepEqual(legend.items.map(({ id, count, visible }) => ({ id, count, visible })), [
    { id: 0, count: 0, visible: true }, { id: 1, count: 1, visible: true }, { id: 2, count: 2, visible: false },
  ]);
  assert.deepEqual([...visibilityByCategory(property, hidden)], [0, 255, 0]);
  assert.equal(visibilityByCategory(property, new Set()), null);
});

test('element, category and scalar visibility masks intersect without modifying their inputs', () => {
  const element = Uint8Array.from([0, 255, 255, 255]);
  const category = Uint8Array.from([255, 0, 255, 255]);
  const scalar = Uint8Array.from([255, 255, 0, 255]);
  const result = combineVisibilityMasks(null, element, category, scalar);
  assert.deepEqual([...result], [0, 0, 0, 255]);
  assert.deepEqual([...element], [0, 255, 255, 255]);
  assert.deepEqual([...category], [255, 0, 255, 255]);
  assert.deepEqual([...scalar], [255, 255, 0, 255]);
  assert.equal(combineVisibilityMasks(null, undefined), null);
  assert.equal(combineVisibilityMasks(null, scalar), scalar);
  assert.throws(() => combineVisibilityMasks(element, new Uint8Array(3)), /matching atom counts/);
});

test('scalar coloring follows AtomEye-style jet endpoints', () => {
  const palette = colorsByProperty({ name: 'coordination', unit: '', data: new Float32Array([0, 1]) });
  assert.deepEqual([...palette.colors], [0, 0, 128, 128, 0, 0]);
  assert.equal(palette.legend.scheme, 'atomeye');
  assert.match(palette.legend.gradient, /^linear-gradient/);
});

test('scalar color schemes expose stable labels and change both colors and legend stops', () => {
  const schemes = new Map(SCALAR_COLOR_SCHEMES.map(({ value, label }) => [value, label]));
  assert.equal(schemes.size, SCALAR_COLOR_SCHEMES.length);
  for (const [value, label] of Object.entries({
    atomeye: 'AtomEye rainbow', viridis: 'Viridis', plasma: 'Plasma',
    coolwarm: 'Cool–warm', grayscale: 'Grayscale', magma: 'Magma',
    inferno: 'Inferno', cividis: 'Cividis', turbo: 'Turbo', spectral: 'Spectral',
  })) assert.equal(schemes.get(value), label);
  const palette = colorsByProperty(
    { name: 'coordination', unit: '', data: new Float32Array([0, 1]) },
    null,
    'viridis',
  );
  assert.deepEqual([...palette.colors], [68, 1, 84, 253, 231, 37]);
  assert.equal(palette.legend.schemeLabel, 'Viridis');
  assert.deepEqual(palette.legend.colorStops[0], [0, 68, 1, 84]);
  assert.throws(
    () => colorsByProperty({ name: 'value', data: new Float32Array([1]) }, null, 'missing'),
    /Unknown scalar color scheme/,
  );
});

test('new scientific palettes clamp finite outliers and retain gray NaN values', () => {
  const endpoints = {
    magma: [[0, 0, 4], [252, 253, 191]],
    inferno: [[0, 0, 4], [252, 255, 164]],
    cividis: [[0, 34, 78], [254, 232, 56]],
    turbo: [[48, 18, 59], [122, 4, 3]],
    spectral: [[158, 1, 66], [94, 79, 162]],
  };
  const property = { name: 'energy', data: new Float64Array([-10, 0, 1, 10, NaN, Infinity]) };
  for (const [scheme, [first, last]] of Object.entries(endpoints)) {
    const { colors, legend } = colorsByProperty(property, { minimum: 0, maximum: 1 }, scheme);
    assert.deepEqual([...colors], [...first, ...first, ...last, ...last, 130, 130, 130, 130, 130, 130], scheme);
    assert.equal(legend.minimum, 0);
    assert.equal(legend.maximum, 1);
    assert.equal(legend.dataMinimum, -10);
    assert.equal(legend.dataMaximum, 10);
    assert.deepEqual(legend.colorStops[0], [0, ...first]);
    assert.deepEqual(legend.colorStops.at(-1), [1, ...last]);
    assert.equal(legend.scheme, scheme);
  }
});

test('palette anchors and gradients agree with atom colors and PNG legend inputs', () => {
  for (const { value: scheme } of SCALAR_COLOR_SCHEMES) {
    const palette = colorsByProperty({ name: 'value', data: new Float64Array([0, 1]) }, null, scheme);
    const stops = palette.legend.colorStops;
    const sampled = colorsByProperty(
      { name: 'value', data: new Float64Array(stops.map(([position]) => position)) },
      { minimum: 0, maximum: 1 }, scheme,
    );
    assert.deepEqual([...sampled.colors], stops.flatMap(([, ...rgb]) => rgb), scheme);
    assert.match(palette.legend.gradient, /^linear-gradient\(90deg, /);
    for (const [index, [position, red, green, blue]] of stops.entries()) {
      assert.ok(position >= 0 && position <= 1);
      assert.ok(index === 0 || position > stops[index - 1][0]);
      assert.ok([red, green, blue].every(component => Number.isInteger(component) && component >= 0 && component <= 255));
      assert.ok(palette.legend.gradient.includes(`rgb(${red} ${green} ${blue}) ${(position * 100).toFixed(1)}%`));
    }
  }
  const midpoint = colorsByProperty({ name: 'value', data: new Float64Array([0.0625]) }, { minimum: 0, maximum: 1 }, 'magma');
  assert.deepEqual([...midpoint.colors], [15, 9, 38]);
});

test('new palettes retain a NaN legend for entirely undefined fields', () => {
  for (const scheme of ['magma', 'inferno', 'cividis', 'turbo', 'spectral']) {
    const { colors, legend } = colorsByProperty({ name: 'strain', data: new Float32Array([NaN, NaN]) }, null, scheme);
    assert.deepEqual([...colors], [130, 130, 130, 130, 130, 130]);
    assert.equal(legend.kind, 'types');
    assert.deepEqual(legend.items, [{ id: 'NaN', label: 'NaN', color: [130, 130, 130], count: 2, visible: true }]);
  }
});

test('custom scalar legend range controls color normalization and clamps outliers', () => {
  const property = { name: 'coordination', unit: '', data: new Uint32Array([4, 8, 12, 16]) };
  const palette = colorsByProperty(property, { minimum: 8, maximum: 12 });
  assert.equal(palette.legend.minimum, 8);
  assert.equal(palette.legend.maximum, 12);
  assert.equal(palette.legend.dataMinimum, 4);
  assert.equal(palette.legend.dataMaximum, 16);
  assert.equal(palette.legend.customRange, true);
  assert.deepEqual([...palette.colors.slice(0, 3)], [...palette.colors.slice(3, 6)]);
  assert.deepEqual([...palette.colors.slice(6, 9)], [...palette.colors.slice(9, 12)]);
  assert.notDeepEqual([...palette.colors.slice(3, 6)], [...palette.colors.slice(6, 9)]);
});

test('scalar legend rejects an inverted custom range', () => {
  assert.throws(
    () => colorsByProperty({ name: 'value', data: new Float32Array([1, 2]) }, { minimum: 2, maximum: 1 }),
    /maximum must be greater/,
  );
});

test('entirely NaN strain is gray with a NaN key instead of a numeric range or error', () => {
  const property = { name: 'atomicShearStrain', displayName: 'Atomic shear strain', data: new Float32Array([NaN, NaN]) };
  const { colors, legend } = colorsByProperty(property, { minimum: 0, maximum: 1 });
  assert.deepEqual([...colors], [130, 130, 130, 130, 130, 130]);
  assert.equal(legend.title, 'Atomic shear strain');
  assert.equal(legend.kind, 'types');
  assert.deepEqual(legend.items, [{ id: 'NaN', label: 'NaN', color: [130, 130, 130], count: 2, visible: true }]);
});

test('undefined scalar categories can be hidden through their NaN legend key', () => {
  const property = { name: 'displacementMagnitude', data: new Float64Array([NaN, Infinity]) };
  const hidden = new Set(['NaN']);
  const { legend } = colorsByProperty(property, null, 'atomeye', hidden);
  assert.equal(legend.items[0].visible, false);
  assert.deepEqual([...visibilityByCategory(property, hidden)], [0, 0]);
});

test('AtomEye-style scalar thresholds hide only values outside the inclusive range', () => {
  const property = { data: new Float32Array([7, 8, 10, 12, 13, Number.NaN]) };
  assert.deepEqual(
    [...visibilityByProperty(property, { minimum: 8, maximum: 12 })],
    [0, 255, 255, 255, 0, 0],
  );
  assert.equal(visibilityByProperty(property, { minimum: 8, maximum: 12 }, false), null);
  assert.equal(visibilityByProperty(property, null), null);
});

test('live scalar limits push the opposite bound and always stay ordered', () => {
  assert.deepEqual(coupleScalarRange(12, 12, 'minimum', 1), { minimum: 12, maximum: 13 });
  assert.deepEqual(coupleScalarRange(8, 8, 'maximum', 1), { minimum: 7, maximum: 8 });
  assert.deepEqual(coupleScalarRange(4, 9, 'minimum', 1), { minimum: 4, maximum: 9 });
});

test('live scalar coupling advances large bounds without widening already valid small ranges', () => {
  for (const [minimum, maximum, changed] of [
    [1e15, 1, 'minimum'],
    [1e15 + 0.25, 1e15, 'minimum'],
    [0, -1e15, 'maximum'],
    [-1e15, -1e15 - 0.25, 'maximum'],
  ]) {
    const limits = coupleScalarRange(minimum, maximum, changed, 0.01);
    assert.ok(Number.isFinite(limits.minimum) && Number.isFinite(limits.maximum));
    assert.ok(limits.maximum > limits.minimum);
    assert.equal(limits[changed], changed === 'minimum' ? minimum : maximum, 'the user-edited bound stays exact');
  }
  const narrow = { minimum: 1e15, maximum: 1e15 + 0.125 };
  assert.deepEqual(coupleScalarRange(narrow.minimum, narrow.maximum, 'minimum', 1), narrow);
  assert.deepEqual(coupleScalarRange(0, 0, 'minimum', 0), { minimum: 0, maximum: Number.MIN_VALUE });
  assert.deepEqual(coupleScalarRange(0, 0, 'maximum', Number.MIN_VALUE), { minimum: -Number.MIN_VALUE, maximum: 0 });
});

test('live scalar coupling rejects overflow rather than returning an invalid range', () => {
  assert.equal(coupleScalarRange(Number.MAX_VALUE, 1, 'minimum', 0.01), null);
  assert.equal(coupleScalarRange(0, -Number.MAX_VALUE, 'maximum', 0.01), null);
  assert.equal(coupleScalarRange(Infinity, 1, 'minimum', 1), null);
  assert.equal(coupleScalarRange(0, NaN, 'maximum', 1), null);
});
