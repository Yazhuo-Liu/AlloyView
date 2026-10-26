import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { warmCrystalSymmetry, analyzeCrystalSymmetry } from '../src/analysis/crystal-symmetry.js';
import { SPACE_GROUP_SETTINGS, resolveSpaceGroup } from '../src/crystal/space-groups.js';
import { parseCifSymmetryOperation, parseCif } from '../src/io/cif.js';
import { structureExportText } from '../src/io/structure-export.js';
import { createCell, fractionalToCartesian, determinant3 } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

await warmCrystalSymmetry({ wasmBinary: readFileSync(new URL('../src/crystal/vendor/moyo/moyo_wasm_bg.wasm', import.meta.url)) });

test('the pinned Hall database covers all 230 groups and 530 coordinate settings with safe affine operators', () => {
  assert.equal(SPACE_GROUP_SETTINGS.length, 530);
  assert.equal(new Set(SPACE_GROUP_SETTINGS.map(entry => entry.number)).size, 230);
  for (const entry of SPACE_GROUP_SETTINGS) {
    assert.equal(resolveSpaceGroup({ number: entry.number, hall: entry.hallSymbol, setting: entry.setting }).hallNumber, entry.hallNumber);
    assert.deepEqual([...resolveSpaceGroup({ hall: entry.hallSymbol }).operations].sort(), [...entry.operations].sort());
    const operations = entry.operations.map(parseCifSymmetryOperation);
    assert.ok(operations.length && operations.length <= 192);
    assert.ok(operations.some(({ rotation, translation }) => rotation.every((v, i) => v === (i % 4 === 0 ? 1 : 0)) && translation.every(v => v === 0)));
  }
});

test('Hall, full HM and explicit coordinate settings resolve origins and axes without guessing ambiguous declarations', () => {
  assert.equal(resolveSpaceGroup({ number: 225 }).hallNumber, 523);
  assert.equal(resolveSpaceGroup({ name: 'P 1 21/c 1' }).hallNumber, 81);
  assert.equal(resolveSpaceGroup({ name: 'P21/c', setting: 'b2' }).hallNumber, 82);
  assert.equal(resolveSpaceGroup({ name: 'R-3m:H' }).hallNumber, 458);
  assert.equal(resolveSpaceGroup({ number: 166, hall: '-R 3 2"' }).hallNumber, 458);
  assert.equal(resolveSpaceGroup({ number: 166, hall: '-R 3 2=' }).hallNumber, 458);
  assert.equal(resolveSpaceGroup({ hall: 'P 32' }).number, 145);
  assert.equal(resolveSpaceGroup({ hall: 'P 3 2' }).number, 149);
  assert.equal(resolveSpaceGroup({ hall: 'P 62' }).number, 171);
  assert.equal(resolveSpaceGroup({ hall: 'P 6 2' }).number, 177);
  for (const number of [14, 48, 146, 166, 227]) assert.throws(() => resolveSpaceGroup({ number }), /ambiguous/);
  assert.throws(() => resolveSpaceGroup({ number: 225, name: 'I m -3 m' }), /inconsistent/);
  assert.throws(() => resolveSpaceGroup({ name: 'R3:H', setting: 'R' }), /disagree/);
});

for (const [kind, number, conventionalCount, primitiveCount] of [
  ['fcc', 225, 4, 1], ['bcc', 229, 2, 1], ['diamond', 227, 8, 2], ['hcp', 194, 2, 2], ['sc', 221, 1, 1],
]) test(`real moyo identifies ${kind} and exports equivalent primitive and conventional cells`, async () => {
  const frame = crystalFrame(kind, 1); frame.typeLabels = ['Si'];
  const before = structuredClone(frame), result = await analyzeCrystalSymmetry(frame);
  assert.equal(result.number, number);
  assert.equal(result.conventional.ids.length, conventionalCount);
  assert.equal(result.primitive.ids.length, primitiveCount);
  assert.equal(result.orbits.length, frame.ids.length);
  assert.equal(result.wyckoffs.length, frame.ids.length);
  const v = Math.abs(determinant3(result.conventional.cell.vectors)) / conventionalCount;
  assert.ok(Math.abs(v - Math.abs(determinant3(result.primitive.cell.vectors)) / primitiveCount) < 1e-8);
  for (const output of [result.primitive, result.conventional]) {
    assert.equal((await analyzeCrystalSymmetry(output)).number, number);
    const roundTrip = parseCif(structureExportText(output, { format: 'cif' }));
    assert.equal((await analyzeCrystalSymmetry(roundTrip)).number, number);
    assert.equal(output.properties.length, 0);
  }
  assert.deepEqual(frame, before);
});

test('species preserve noncentrosymmetric zincblende, instead of incorrectly reporting diamond', async () => {
  const frame = crystalFrame('diamond', 1); frame.typeLabels = ['Zn', 'S']; frame.types.fill(1, 4);
  const result = await analyzeCrystalSymmetry(frame);
  assert.equal(result.number, 216); assert.equal(result.primitive.ids.length, 2);
  assert.deepEqual(new Set(result.primitive.types), new Set([0, 1]));
});

test('Hall screw handedness distinguishes physical reflection from a passive left-handed basis change', async () => {
  const frame = parseCif(`data_chiral
_cell_length_a 4
_cell_length_b 4
_cell_length_c 7
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 120
_space_group_IT_number 152
loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z
Si1 Si .123 .237 .319
O1 O .217 .413 .537
`);
  assert.equal(frame.ids.length, 12);
  assert.equal((await analyzeCrystalSymmetry(frame)).number, 152);
  const passive = structuredClone(frame), h = passive.cell.vectors;
  passive.cell = createCell({ vectors: [...h.slice(3, 6), ...h.slice(0, 3), ...h.slice(6, 9)] });
  for (let i = 0; i < passive.ids.length; i++) {
    const first = passive.fractional[3 * i]; passive.fractional[3 * i] = passive.fractional[3 * i + 1]; passive.fractional[3 * i + 1] = first;
  }
  const result = await analyzeCrystalSymmetry(passive);
  assert.equal(result.number, 152); assert.ok(determinant3(result.conventional.cell.vectors) > 0);
  const reflected = structuredClone(frame);
  for (let i = 2; i < 9; i += 3) reflected.cell.vectors[i] *= -1;
  assert.equal((await analyzeCrystalSymmetry(reflected)).number, 154);
});

test('rotated and unimodularly skewed primitive bases retain space group and species', async () => {
  const frame = crystalFrame('fcc', 1); frame.typeLabels = ['Al'];
  const primitive = (await analyzeCrystalSymmetry(frame)).primitive;
  const h = primitive.cell.vectors, old = primitive.fractional;
  const skew = Array.from(h); for (let k = 0; k < 3; k++) skew[3 + k] += h[k];
  const angle = .37, c = Math.cos(angle), s = Math.sin(angle);
  for (let row = 0; row < 3; row++) { const x = skew[3 * row], y = skew[3 * row + 1]; skew[3 * row] = c * x - s * y; skew[3 * row + 1] = s * x + c * y; }
  primitive.cell = createCell({ vectors: skew, origin: [50, -30, 2] });
  primitive.fractional = Float64Array.from(old, (value, i) => i % 3 === 0 ? value - old[i + 1] : value);
  primitive.positions = fractionalToCartesian(primitive.fractional, primitive.cell);
  assert.equal((await analyzeCrystalSymmetry(primitive)).number, 225);
});

test('physical distortions respect tolerance and invalid occupancy or open cells are never silently regularized', async () => {
  const frame = crystalFrame('fcc', 1); frame.cell.vectors[0] += .003;
  assert.equal((await analyzeCrystalSymmetry(frame, { symprec: .02 })).number, 225);
  assert.notEqual((await analyzeCrystalSymmetry(frame, { symprec: 1e-5 })).number, 225);
  for (const value of [.5, 0, NaN]) {
    frame.properties = [{ name: 'occupancy', data: Float64Array.from(frame.ids, () => value) }];
    await assert.rejects(analyzeCrystalSymmetry(frame), /fully occupied/);
  }
  frame.properties = []; frame.crystal = { disordered: true };
  await assert.rejects(analyzeCrystalSymmetry(frame), /disordered/);
  delete frame.crystal; frame.cell.pbc[0] = false;
  await assert.rejects(analyzeCrystalSymmetry(frame), /all three axes/);
});
