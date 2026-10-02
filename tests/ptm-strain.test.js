import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePtm } from '../src/analysis/ptm.js';
import { calculateAtomicStrain, STRAIN_FIELDS } from '../src/analysis/atomic-strain.js';
import { referenceForElement, validateReferences } from '../src/analysis/lattice.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

const phases = [['fcc', 1], ['hcp', 2], ['bcc', 3], ['sc', 5], ['diamond', 6], ['hex-diamond', 7]];
const reference = (structure, a = 4) => ({ structure, a, c: Math.sqrt(8 / 3) * a });
function near(values, expected, tolerance = 2e-6) {
  assert.ok(values.length > 0);
  for (const value of values) assert.ok(Math.abs(value - expected) < tolerance, `${value} != ${expected}`);
}
function deform(frame, matrix) {
  const vectors = [];
  for (let i = 0; i < 3; i += 1) for (let row = 0; row < 3; row += 1) {
    vectors.push(matrix.slice(row * 3, row * 3 + 3).reduce((sum, value, k) => sum + value * frame.cell.vectors[i * 3 + k], 0));
  }
  return { ...frame, cell: createCell({ vectors, pbc: frame.cell.pbc, triclinic: true }) };
}

for (const [kind, id] of phases) {
  test(`real PTM matches ideal ${kind} and its reference strain vanishes`, async () => {
    const frame = crystalFrame(kind, 3);
    const result = await calculateAtomicStrain(frame, { references: [reference(id)], flags: 255 });
    assert.ok(result.structures.every(type => type === id));
    near(result.rmsd, 0);
    near(result.atomicShearStrain, 0);
    near(result.atomicHydrostaticStrain, 0);
    near(result.atomicVolumeChange, 0);
    assert.ok(result.atomicShearStrain.every(value => value === 0), 'roundoff must not create a false shear color range');
    assert.equal(result.incomplete, 0);
  });
}

test('PTM matches periodic primitive cells, graphene and an icosahedral center', async () => {
  for (const [kind, id] of phases.slice(0, 4)) {
    const result = await calculatePtm(crystalFrame(kind, 1), { flags: 255 });
    assert.ok(result.structures.every(type => type === id), kind);
  }
  const fractional = [];
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) {
    for (const [x, y] of [[0, 0], [2 / 3, 1 / 3]]) fractional.push((i + x) / 3, (j + y) / 3, .5);
  }
  const graphene = { fractional: Float64Array.from(fractional), cell: createCell({
    vectors: [7.38, 0, 0, -3.69, Math.sqrt(3) * 3.69, 0, 0, 0, 20], pbc: [true, true, false], triclinic: true,
  }) };
  assert.ok((await calculatePtm(graphene, { flags: 128 })).structures.every(type => type === 8));
  const phi = (1 + Math.sqrt(5)) / 2, xyz = [0, 0, 0];
  for (const a of [-1, 1]) for (const b of [-phi, phi]) xyz.push(0, a, b, a, b, 0, b, 0, a);
  const ico = { fractional: Float64Array.from(xyz, x => .5 + x / 10), cell: createCell({
    vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false],
  }) };
  assert.equal((await calculatePtm(ico, { flags: 8 })).structures[0], 4);
});

test('PTM template selection and RMSD cutoff reject fits; zero disables the cutoff', async () => {
  const frame = crystalFrame('fcc', 3);
  assert.ok((await calculatePtm(frame, { flags: 4 })).structures.every(type => type === 0));
  for (let i = 0; i < frame.fractional.length; i += 1) frame.fractional[i] += Math.sin(i * 12.9898) * .001;
  const accepted = await calculatePtm(frame);
  assert.ok(accepted.structures.every(type => type === 1));
  const rejected = await calculatePtm(frame, { rmsdCutoff: .00001 });
  assert.ok(rejected.structures.every(type => type === 0));
  assert.ok(rejected.rmsd.every(Number.isFinite), 'rejected fits keep their diagnostic RMSD');
  assert.ok(rejected.scales.every(Number.isNaN));
  assert.ok((await calculatePtm(frame, { rmsdCutoff: 0 })).structures.every(type => type === 1));
  await assert.rejects(calculatePtm(frame, { flags: 0 }), /template/);
  await assert.rejects(calculatePtm(frame, { rmsdCutoff: NaN }), /threshold/);
});

test('strain preserves absolute scale for isotropic dilation and user-edited lattice constants', async () => {
  const frame = crystalFrame('fcc', 3);
  const dilation = 1.05;
  const dilated = deform(frame, [dilation, 0, 0, 0, dilation, 0, 0, 0, dilation]);
  const result = await calculateAtomicStrain(dilated, { references: [reference(1)] });
  near(result.atomicHydrostaticStrain, (dilation ** 2 - 1) / 2);
  near(result.atomicShearStrain, 0);
  near(result.atomicVolumeChange, dilation ** 3 - 1);
  const ptmInput = await calculatePtm(frame);
  const edited = await calculateAtomicStrain(frame, { ptmInput, references: [reference(1, 4 / dilation)] });
  near(edited.atomicHydrostaticStrain, (dilation ** 2 - 1) / 2);
  near(edited.atomicVolumeChange, dilation ** 3 - 1);
});

test('strain is rotation invariant and reproduces finite simple shear', async () => {
  const frame = crystalFrame('fcc', 3), angle = .71;
  const rotation = [Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle), 0, 0, 0, 1];
  const rotated = await calculateAtomicStrain(deform(frame, rotation), { references: [reference(1)] });
  for (const field of STRAIN_FIELDS) near(rotated[field], 0);
  const gamma = .06;
  const sheared = await calculateAtomicStrain(deform(frame, [1, gamma, 0, 0, 1, 0, 0, 0, 1]), { references: [reference(1)] });
  near(sheared.atomicHydrostaticStrain, gamma ** 2 / 6);
  near(sheared.atomicShearStrain, Math.sqrt(gamma ** 2 / 4 + gamma ** 4 / 12));
  near(sheared.atomicVolumeChange, 0);
});

test('hexagonal reference c removes physical nonideal c/a and detects axial stretching', async () => {
  const frame = crystalFrame('hcp', 3);
  const ref = { structure: 2, a: 4, c: 4 * 1.624 };
  const actual = deform(frame, [1, 0, 0, 0, 1, 0, 0, 0, 1.624 / Math.sqrt(8 / 3)]);
  const unstrained = await calculateAtomicStrain(actual, { references: [ref] });
  near(unstrained.atomicHydrostaticStrain, 0);
  near(unstrained.atomicShearStrain, 0);
  const stretched = await calculateAtomicStrain(deform(actual, [1, 0, 0, 0, 1, 0, 0, 0, 1.04]), { references: [ref] });
  near(stretched.strainE33, (1.04 ** 2 - 1) / 2);
  near(stretched.atomicVolumeChange, .04);
});

test('per-species references and ranged cached strain retain undefined values', async () => {
  const frame = crystalFrame('bcc', 3);
  for (let i = 0; i < frame.types.length; i += 1) frame.types[i] = i % 2;
  const references = [reference(3), reference(1)];
  const ptmInput = await calculatePtm(frame);
  const result = await calculateAtomicStrain(frame, { references, ptmInput });
  assert.equal(result.incomplete, frame.types.length / 2);
  result.atomicHydrostaticStrain.forEach((value, i) => i % 2 ? assert.ok(Number.isNaN(value)) : near([value], 0));
  const split = 25;
  const first = await calculateAtomicStrain(frame, { references, ptmInput, endAtom: split });
  const last = await calculateAtomicStrain(frame, { references, ptmInput, startAtom: split });
  for (const field of STRAIN_FIELDS) assert.deepEqual([...first[field], ...last[field]], [...result[field]]);
  assert.equal('structures' in first, false, 'reuse the existing PTM cache without duplicating it');
  const other = await calculatePtm({ fractional: new Float64Array([0, 0, 0]), cell: createCell({
    vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false],
  }) });
  assert.deepEqual([...other.structures], [0]);
});

test('element presets are explicit and editable; unknown numeric types require input', () => {
  assert.deepEqual(referenceForElement('Al'), { element: 'Al', structure: 1, a: 4.05 });
  assert.equal(referenceForElement('Fe').structure, 3);
  assert.equal(referenceForElement('Mg').c, 3.21 * 1.624);
  assert.equal(referenceForElement('Si').structure, 6);
  const unknown = referenceForElement('1');
  assert.equal(unknown.a, null);
  assert.throws(() => validateReferences([unknown], [0]), /positive reference lattice/);
  assert.throws(() => validateReferences([{ structure: 2, a: 3 }], [0]), /constant c/);
  assert.throws(() => validateReferences([{ structure: 8, a: 3 }], [0]), /positive reference lattice/);
});
