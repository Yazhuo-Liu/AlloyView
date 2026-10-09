import assert from 'node:assert/strict';
import test from 'node:test';
import { colorsByDiscreteProperty, discreteColor, discreteValues, MAX_DISCRETE_VALUES } from '../src/render/discrete-colors.js';
import { fundamentalZoneQuaternion, ipfColor, ipfWeights, normalizeOrientationSettings, OrientationColorResolver, rodriguesColor,
  sampleToCrystalDirection } from '../src/render/orientation-colors.js';
import { initialColorQuantities } from '../src/render/color-quantities.js';
import { visibilityByCategory } from '../src/render/palette.js';
import { calculatePtm } from '../src/analysis/ptm.js';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { createConfiguration, parseConfiguration } from '../src/configuration.js';
import { crystalFrame } from './helpers/crystals.js';

const identity = [1, 0, 0, 0];
const numeric = data => ({ name: 'number', data: Float64Array.from(data) });

test('discrete eligibility requires 1–32 safe integer values, retaining undefined classes', () => {
  assert.deepEqual(discreteValues(numeric([2, -1, 2, -0, NaN, Infinity])), [
    { id: -1, count: 1 }, { id: 0, count: 1 }, { id: 2, count: 2 }, { id: 'NaN', count: 2 },
  ]);
  for (const values of [[], [NaN], [1, .5], [Number.MAX_SAFE_INTEGER + 1], Array.from({ length: MAX_DISCRETE_VALUES + 1 }, (_, i) => i)]) {
    assert.equal(discreteValues(numeric(values)), null);
  }
  assert.equal(discreteValues({ ...numeric([1]), categories: [{ id: 1 }] }), null);
  assert.ok(discreteValues(numeric(Array.from({ length: 32 }, (_, i) => i))));
});

test('discrete colors and per-value hiding survive reordered and missing categories in another frame', () => {
  const hidden = new Set([-3, 'NaN']), first = colorsByDiscreteProperty(numeric([9, -3, NaN, 9]), hidden);
  const next = colorsByDiscreteProperty(numeric([-3, 4, 9]), hidden);
  assert.deepEqual([...first.colors.subarray(0, 3)], [...next.colors.subarray(6, 9)]);
  assert.deepEqual([...visibilityByCategory(first.legend.property, hidden)], [255, 0, 0, 255]);
  assert.deepEqual([...visibilityByCategory(next.legend.property, hidden)], [0, 255, 255]);
  assert.deepEqual(first.legend.items.map(({ id, count, visible }) => [id, count, visible]), [[-3, 1, false], [9, 2, true], ['NaN', 1, false]]);
  assert.equal(first.legend.discrete, true);
  assert.equal(colorsByDiscreteProperty(numeric([.3])), null);
  const spaced = colorsByDiscreteProperty(numeric([0, 997, 1994]));
  assert.equal(new Set(spaced.legend.items.map(item => item.color.join(','))).size, 3, 'Widely spaced ID values receive distinct colors.');
});

test('cubic IPF key has exact red [001], green [101] and blue [111] corners', () => {
  for (const structure of [1, 3]) {
    assert.deepEqual(ipfColor(identity, structure, [0, 0, 1]), [255, 0, 0]);
    assert.deepEqual(ipfColor(identity, structure, [1, 0, 1]), [0, 255, 0]);
    assert.deepEqual(ipfColor(identity, structure, [1, 1, 1]), [0, 0, 255]);
  }
});

test('cubic crystal permutations, signs and quaternion sign describe identical IPF colors', () => {
  const expected = ipfColor(identity, 1, [1, 2, 5]);
  for (const sample of [[-5, 1, -2], [2, -5, 1], [-1, -2, -5]]) assert.deepEqual(ipfColor(identity, 1, sample), expected);
  const q = [.9, .1, -.2, .3];
  assert.deepEqual(ipfColor(q, 3), ipfColor(q.map(value => -value), 3));
  // 90-degree crystal-axis rotation is an m-3m symmetry operation.
  assert.deepEqual(ipfColor([Math.SQRT1_2, 0, 0, Math.SQRT1_2], 1, [1, 2, 5]), expected);
});

test('hexagonal IPF key follows PTM a1=[2−1−10] and the 30-degree [10−10] corner', () => {
  assert.deepEqual(ipfColor(identity, 2, [0, 0, 1]), [255, 0, 0]);
  assert.deepEqual(ipfColor(identity, 2, [1, 0, 0]), [0, 0, 255]);
  const green = ipfColor(identity, 2, [Math.sqrt(3), 1, 0]);
  assert.ok(green[0] === 0 && green[1] === 255 && green[2] <= 1);
  const expected = ipfColor(identity, 2, [1, .2, .8]);
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3, x = Math.cos(angle) - .2 * Math.sin(angle), y = Math.sin(angle) + .2 * Math.cos(angle);
    const actual = ipfColor(identity, 2, [x, y, -.8]);
    actual.forEach((value, channel) => assert.ok(Math.abs(value - expected[channel]) <= 1));
  }
});

test('IPF uses the inverse of the active template-to-sample PTM rotation', () => {
  const q = [Math.cos(Math.PI / 8), 0, Math.sin(Math.PI / 8), 0];
  const direction = sampleToCrystalDirection(q, [0, 0, 1]);
  assert.ok(Math.abs(direction[0] + Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(direction[2] - Math.SQRT1_2) < 1e-12);
  assert.deepEqual(ipfColor(q, 1), [0, 255, 0]);
  assert.equal(ipfWeights([0, 0, 0], 1), null);
  for (const structure of [0, 4]) assert.deepEqual(ipfColor(identity, structure), [130, 130, 130]);
  // SC and cubic diamond share the cubic key; hexagonal diamond and graphene the hexagonal one.
  for (const structure of [5, 6]) assert.deepEqual(ipfColor(identity, structure, [1, 1, 1]), [0, 0, 255]);
  for (const structure of [7, 8]) assert.deepEqual(ipfColor(identity, structure, [1, 0, 0]), [0, 0, 255]);
  assert.deepEqual(ipfColor([NaN, 0, 0, 0], 1), [130, 130, 130]);
});

test('actual compiled PTM orientations reproduce colors of rotated cubic and hexagonal fixtures', async () => {
  const axis = [1, 2, 3], norm = Math.hypot(...axis), angle = .37;
  const q = [Math.cos(angle / 2), ...axis.map(value => value / norm * Math.sin(angle / 2))];
  const [w, x, y, z] = q;
  const rotation = [1 - 2 * (y*y + z*z), 2*(x*y - w*z), 2*(x*z + w*y),
    2*(x*y + w*z), 1 - 2*(x*x + z*z), 2*(y*z - w*x), 2*(x*z - w*y), 2*(y*z + w*x), 1 - 2*(x*x + y*y)];
  for (const [kind, structure] of [['fcc', 1], ['bcc', 3], ['hcp', 2]]) {
    const original = crystalFrame(kind, 3), vectors = [];
    for (let vector = 0; vector < 3; vector++) for (let row = 0; row < 3; row++) {
      vectors.push(rotation.slice(row * 3, row * 3 + 3).reduce((sum, value, column) => sum + value * original.cell.vectors[vector * 3 + column], 0));
    }
    const cell = createCell({ vectors, pbc: original.cell.pbc, triclinic: true });
    const result = await calculatePtm({ ...original, cell, positions: fractionalToCartesian(original.fractional, cell) });
    assert.ok(result.structures.every(id => id === structure));
    for (const sample of [[0, 0, 1], [.2, .6, .9]]) {
      const expected = ipfColor(q, structure, sample);
      for (let atom = 0; atom < result.structures.length; atom++) {
        const actual = ipfColor(result.orientations.subarray(atom * 4, atom * 4 + 4), structure, sample);
        actual.forEach((value, channel) => assert.ok(Math.abs(value - expected[channel]) <= 1, `${kind}, atom ${atom}, channel ${channel}: ${actual} != ${expected}`));
      }
    }
  }
});

test('orientation color resolver caches its current frame, mode, direction and source arrays', () => {
  const frame = crystalFrame('fcc', 1), structures = new Uint8Array(4).fill(1), orientations = Float64Array.from(Array.from({ length: 4 }, () => identity).flat());
  frame.ptm = { structures, orientations }; frame.properties = [{ name: 'ptmStructureType', data: structures }];
  const resolver = new OrientationColorResolver(), first = resolver.resolve(frame, 'builtin:ptm:ipf');
  assert.equal(resolver.resolve(frame, 'builtin:ptm:ipf'), first);
  const identicalDirection = resolver.resolve(frame, 'builtin:ptm:ipf', { direction: 'custom', custom: [0, 0, 1] });
  assert.notEqual(identicalDirection.legend.title, first.legend.title, 'Choosing Custom preserves its own legend label even when the direction equals Z.');
  assert.ok(initialColorQuantities(frame).some(item => item.value === 'builtin:ptm:ipf'));
  const other = resolver.resolve(frame, 'builtin:ptm:ipf', { direction: 'custom', custom: [1, 1, 1] });
  assert.notEqual(other.colors, first.colors); assert.deepEqual([...other.colors.slice(0, 3)], [0, 0, 255]);
  frame.ptm = { ...frame.ptm, orientations: new Float64Array(orientations) };
  assert.notEqual(resolver.resolve(frame, 'builtin:ptm:ipf', { direction: 'custom', custom: [1, 1, 1] }).colors, other.colors);
  frame.properties = []; assert.equal(resolver.resolve(frame, 'builtin:ptm:ipf'), null);
});

test('orientation resolver marks unsupported and unmatched atoms gray and exposes mixed-family keys', () => {
  const structures = Uint8Array.from([1, 2, 3, 0, 4]), orientations = Float64Array.from(Array.from({ length: 5 }, () => identity).flat());
  const frame = { ids: new Uint32Array(5), ptm: { structures, orientations }, properties: [{ name: 'ptmStructureType', data: structures }] };
  const palette = new OrientationColorResolver().resolve(frame, 'builtin:ptm:ipf');
  assert.deepEqual(palette.legend.keys.map(key => key.family), ['cubic', 'hexagonal']);
  assert.equal(palette.legend.undefinedCount, 2); assert.deepEqual([...palette.colors.slice(9)], [130, 130, 130, 130, 130, 130]);
});

test('completed strain-only fits enable orientation colors while estimation-only caches stay unavailable', () => {
  const frame = crystalFrame('fcc', 1), structures = new Uint8Array(4).fill(1);
  frame.ptm = { structures, orientations: Float64Array.from(Array.from({ length: 4 }, () => identity).flat()) };
  const resolver = new OrientationColorResolver();
  assert.equal(resolver.resolve(frame, 'builtin:ptm:ipf'), null, 'An estimation cache alone does not expose a replayable color quantity.');
  frame.properties = [{ name: 'idealStrainStructureType', data: structures, analysisKind: 'strain' }];
  assert.deepEqual([...resolver.resolve(frame, 'builtin:ptm:ipf').colors.slice(0, 3)], [255, 0, 0]);
  assert.ok(initialColorQuantities(frame).some(item => item.value === 'builtin:ptm:ipf'));
  frame.properties[0].data = new Uint8Array(structures);
  assert.equal(resolver.resolve(frame, 'builtin:ptm:ipf'), null, 'Unrelated strain and cache structures cannot be combined.');
  frame.properties[0].data = structures; frame.ptm.orientations = new Float64Array(3);
  assert.equal(resolver.resolve(frame, 'builtin:ptm:ipf'), null, 'Incomplete orientation arrays cannot reach the renderer.');
});

test('quaternion RGB canonicalizes redundant signs and never presents a false IPF key', () => {
  const structures = Uint8Array.from([1, 1, 0, 4]), q = [.9, .1, -.2, .3];
  const frame = { ids: new Uint32Array(4), ptm: { structures, orientations: Float64Array.from([...q, ...q.map(value => -value), ...identity, ...identity]) },
    properties: [{ name: 'ptmStructureType', data: structures }] };
  const palette = new OrientationColorResolver().resolve(frame, 'builtin:ptm:quaternion');
  assert.deepEqual([...palette.colors.slice(0, 3)], [...palette.colors.slice(3, 6)]);
  assert.deepEqual(palette.legend.keys, []); assert.equal(palette.legend.mode, 'quaternion');
  assert.deepEqual([...palette.colors.slice(6)], [130, 130, 130, 130, 130, 130]);
});

test('actual PTM numerical noise cannot turn an identity crystal into a quaternion color speckle', async () => {
  const frame = crystalFrame('fcc', 3), result = await calculatePtm(frame);
  frame.ptm = { structures: result.structures, orientations: result.orientations };
  frame.properties = [{ name: 'ptmStructureType', data: result.structures }];
  const palette = new OrientationColorResolver().resolve(frame, 'builtin:ptm:quaternion');
  assert.ok(palette.colors.every(value => value === 128));
});

test('new color settings round-trip without changing older recipe defaults', () => {
  const colors = { modes: [{ property: 'phase', mode: 'discrete' }], hiddenCategories: [{ property: 'phase', ids: [-3, 9, 'NaN'] }],
    orientation: { direction: 'custom', custom: [.2, .6, .9] } };
  const recipe = createConfiguration({ settings: { display: { colorMode: 'builtin:ptm:ipf' }, colors } });
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.deepEqual(restored.settings.colors.modes, colors.modes);
  assert.deepEqual(restored.settings.colors.hiddenCategories, colors.hiddenCategories);
  assert.deepEqual(restored.settings.colors.orientation, colors.orientation);
  assert.equal(restored.settings.display.colorMode, 'builtin:ptm:ipf');
  assert.equal(Object.hasOwn(createConfiguration().settings.colors, 'modes'), false);
});

test('orientation and discrete settings reject invalid and unknown inputs before restoration', () => {
  for (const orientation of [{ direction: 'a' }, { custom: [0, 0, 0] }, { custom: ['1', 0, 0] }, { custom: [1, 0] }, { custom: [Infinity, 0, 0] }]) {
    assert.throws(() => normalizeOrientationSettings(orientation));
    assert.throws(() => createConfiguration({ settings: { colors: { orientation } } }));
  }
  for (const mode of ['automatic', true, 1]) assert.throws(() => createConfiguration({ settings: { colors: { modes: [{ property: 'phase', mode }] } } }));
  assert.throws(() => createConfiguration({ settings: { colors: { orientation: { unknown: 1 } } } }));
});

test('orientation settings reject array-like custom vectors before copying them', () => {
  const startedAt = performance.now();
  for (const custom of [{ length: 4294967295 }, { length: 3 }, 'abc', [1, 2]]) {
    assert.throws(() => normalizeOrientationSettings({ direction: 'custom', custom }), /three finite components/);
  }
  assert.throws(() => createConfiguration({ settings: { colors: { orientation: { direction: 'z', custom: { length: 4294967295 } } } } }),
    /settings\.colors\.orientation/);
  assert.ok(performance.now() - startedAt < 1000, 'a huge length is rejected without iterating it');
  assert.deepEqual(normalizeOrientationSettings({ direction: 'custom', custom: new Float64Array([0, 1, 1]) }).custom, [0, 1, 1]);
});

test('any 18 consecutive integers, including negative ones, receive distinct discrete colors', () => {
  for (const start of [-9, 0, 1, 8, 1000]) {
    const colors = Array.from({ length: 18 }, (_, index) => discreteColor(start + index).join(','));
    assert.equal(new Set(colors).size, 18, `values ${start}–${start + 17}`);
  }
  assert.deepEqual(discreteColor(-0), discreteColor(0));
  assert.deepEqual(discreteColor('NaN'), [130, 130, 130]);
});

const multiply = ([aw, ax, ay, az], [bw, bx, by, bz]) => [aw * bw - ax * bx - ay * by - az * bz,
  aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw];
const axisAngle = (axis, angle) => { const norm = Math.hypot(...axis); return [Math.cos(angle / 2), ...axis.map(value => value / norm * Math.sin(angle / 2))]; };

test('Rodrigues RGB is invariant under every crystal symmetry operation and the quaternion sign', () => {
  const q = axisAngle([1, 2, 3], .37);
  const cubicOperators = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].flatMap(axis => [1, 2, 3].map(turn => axisAngle(axis, turn * Math.PI / 2)))
    .concat([[1, 1, 0], [1, -1, 0], [1, 0, 1], [1, 0, -1], [0, 1, 1], [0, 1, -1]].map(axis => axisAngle(axis, Math.PI)))
    .concat([[1, 1, 1], [1, 1, -1], [1, -1, 1], [-1, 1, 1]].flatMap(axis => [1, 2].map(turn => axisAngle(axis, turn * 2 * Math.PI / 3))));
  assert.equal(cubicOperators.length, 23);
  for (const structure of [1, 3, 5, 6]) {
    const expected = rodriguesColor(q, structure);
    for (const g of cubicOperators) assert.deepEqual(rodriguesColor(multiply(q, g), structure), expected);
    assert.deepEqual(rodriguesColor(q.map(value => -value), structure), expected);
  }
  const hexagonalOperators = [1, 2, 3, 4, 5].map(turn => axisAngle([0, 0, 1], turn * Math.PI / 3))
    .concat([0, 1, 2, 3, 4, 5].map(step => axisAngle([Math.cos(step * Math.PI / 6), Math.sin(step * Math.PI / 6), 0], Math.PI)));
  for (const structure of [2, 7, 8]) {
    const expected = rodriguesColor(q, structure);
    for (const g of hexagonalOperators) assert.deepEqual(rodriguesColor(multiply(q, g), structure), expected);
  }
  assert.deepEqual(rodriguesColor(q, 4), [130, 130, 130], 'icosahedral environments have no lattice orientation');
});

test('Rodrigues RGB spans each fundamental zone: identity is mid-gray, zone faces saturate', () => {
  assert.deepEqual(rodriguesColor(identity, 1), [128, 128, 128]);
  assert.deepEqual(rodriguesColor(axisAngle([0, 0, 1], Math.PI / 4), 1), [128, 128, 255], 'cubic zone face at 45° about [001]');
  assert.deepEqual(rodriguesColor(axisAngle([0, 0, 1], Math.PI / 6), 2), [128, 128, 255], 'hexagonal zone face at 30° about c');
  assert.deepEqual(rodriguesColor(axisAngle([1, 0, 0], -Math.PI / 2), 2), [0, 128, 128], 'basal axes reach the zone face at 90°');
  const reduced = fundamentalZoneQuaternion(axisAngle([0, 0, 1], .9 * Math.PI), 'cubic');
  assert.ok(reduced[0] > Math.cos(Math.PI / 8) - 1e-12, 'a large rotation reduces into the cubic zone');
});

test('compiled PTM orientations already lie in the fundamental zone, so the reduction leaves them unchanged', async () => {
  const q = axisAngle([1, 2, 3], 2.4), [w, x, y, z] = q;
  const rotation = [1 - 2 * (y*y + z*z), 2*(x*y - w*z), 2*(x*z + w*y),
    2*(x*y + w*z), 1 - 2*(x*x + z*z), 2*(y*z - w*x), 2*(x*z - w*y), 2*(y*z + w*x), 1 - 2*(x*x + y*y)];
  for (const [kind, family] of [['fcc', 'cubic'], ['hcp', 'hexagonal']]) {
    const original = crystalFrame(kind, 3), vectors = [];
    for (let vector = 0; vector < 3; vector++) for (let row = 0; row < 3; row++) {
      vectors.push(rotation.slice(row * 3, row * 3 + 3).reduce((sum, value, column) => sum + value * original.cell.vectors[vector * 3 + column], 0));
    }
    const cell = createCell({ vectors, pbc: original.cell.pbc, triclinic: true });
    const result = await calculatePtm({ ...original, cell, positions: fractionalToCartesian(original.fractional, cell) });
    for (let atom = 0; atom < result.structures.length; atom++) {
      const output = Array.from(result.orientations.subarray(atom * 4, atom * 4 + 4));
      fundamentalZoneQuaternion(output, family).forEach((value, axis) => assert.ok(Math.abs(value - output[axis]) < 1e-9, `${kind} atom ${atom}`));
    }
  }
});
