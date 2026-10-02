import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCna } from '../src/analysis/cna.js';
import { calculateCentrosymmetry } from '../src/analysis/centrosymmetry.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

for (const [kind, id, cutoff] of [['fcc', 1, 3.5], ['hcp', 2, 4.8], ['bcc', 3, 4.8]]) {
  test(`adaptive and fixed CNA recognize all atoms of ideal ${kind.toUpperCase()}`, () => {
    const frame = crystalFrame(kind);
    for (const mode of ['adaptive', 'fixed']) {
      const result = calculateCna(frame, { mode, cutoff });
      assert.equal(result.structures.length, frame.ids.length);
      assert.ok(result.structures.every((value) => value === id), `${mode}: ${[...result.structures]}`);
    }
  });
}

test('CNA retains periodic images in primitive one-cell FCC, HCP and BCC', () => {
  for (const [kind, id] of [['fcc', 1], ['hcp', 2], ['bcc', 3]]) {
    assert.ok(calculateCna(crystalFrame(kind, 1)).structures.every((value) => value === id));
  }
});

test('icosahedral cluster center has twelve 555 signatures', () => {
  const phi = (1 + Math.sqrt(5)) / 2;
  const xyz = [0, 0, 0];
  for (const a of [-1, 1]) for (const b of [-phi, phi]) {
    xyz.push(0, a, b, a, b, 0, b, 0, a);
  }
  const frame = { fractional: Float64Array.from(xyz, (x) => .5 + x / 10),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
  assert.equal(calculateCna(frame).structures[0], 4);
  assert.equal(calculateCna(frame, { mode: 'fixed', cutoff: 2.2 }).structures[0], 4);
  assert.ok(calculateCna(frame).structures.slice(1).every((value) => value === 0));
});

test('vacancy affects only its local environment and isolated atoms remain Other', () => {
  const frame = crystalFrame('fcc', 4);
  frame.fractional = frame.fractional.slice(3);
  const result = calculateCna(frame).structures;
  assert.ok(result.includes(0));
  assert.ok(result.filter((value) => value === 1).length > result.length * .8);
  const single = { fractional: new Float64Array([.5, .5, .5]), cell: createCell({
    vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false],
  }) };
  assert.deepEqual([...calculateCna(single).structures], [0]);
  assert.ok(Number.isNaN(calculateCentrosymmetry(single).centrosymmetry[0]));
});

test('adaptive CNA is invariant under rigid rotation and uniform scale', () => {
  const frame = crystalFrame('fcc');
  const angle = .71;
  const h = frame.cell.vectors;
  for (let row = 0; row < 3; row += 1) {
    const x = h[row * 3], y = h[row * 3 + 1];
    h[row * 3] = (Math.cos(angle) * x - Math.sin(angle) * y) * 1.8;
    h[row * 3 + 1] = (Math.sin(angle) * x + Math.cos(angle) * y) * 1.8;
    h[row * 3 + 2] *= 1.8;
  }
  assert.ok(calculateCna(frame).structures.every((value) => value === 1));
});

test('adaptive CNA recognizes mildly perturbed FCC and coexisting lattice scales', () => {
  const noisy = crystalFrame('fcc', 4);
  for (let i = 0; i < noisy.fractional.length; i += 1) noisy.fractional[i] += Math.sin(i * 12.9898) * .001;
  assert.ok(calculateCna(noisy).structures.every((id) => id === 1));
  const fcc = crystalFrame('fcc', 4, 4);
  const bcc = crystalFrame('bcc', 4, 7);
  const xyz = [...fcc.positions];
  for (let i = 0; i < bcc.positions.length; i += 1) xyz.push(bcc.positions[i] + (i % 3 === 0 ? 40 : 0));
  const mixed = { fractional: Float64Array.from(xyz, (value) => value / 80),
    cell: createCell({ vectors: [80, 0, 0, 0, 80, 0, 0, 0, 80], pbc: [false, false, false] }) };
  const types = calculateCna(mixed).structures;
  assert.equal(types[84], 1); // Interior FCC site (1,1,1), basis 0.
  assert.equal(types[fcc.ids.length + 42], 3); // Interior BCC site, different lattice scale.
});

test('CNA and central-symmetry disjoint ranges reproduce the full result', () => {
  const frame = crystalFrame('hcp');
  for (const [calculate, field] of [[calculateCna, 'structures'], [calculateCentrosymmetry, 'centrosymmetry']]) {
    const full = calculate(frame)[field];
    const midpoint = Math.floor(full.length / 2);
    const first = calculate(frame, { endAtom: midpoint })[field];
    const second = calculate(frame, { startAtom: midpoint })[field];
    assert.deepEqual([...first, ...second], [...full]);
  }
});

test('normalized central symmetry vanishes for FCC/BCC and rises at a vacancy', () => {
  for (const [kind, neighbors] of [['fcc', 12], ['bcc', 8]]) {
    const frame = crystalFrame(kind);
    assert.ok(calculateCentrosymmetry(frame, { neighbors }).centrosymmetry.every((value) => value < 1e-12));
    frame.fractional = frame.fractional.slice(3);
    assert.ok(calculateCentrosymmetry(frame, { neighbors }).centrosymmetry.some((value) => value > .001));
  }
});

test('neighbor vectors match brute-force image enumeration for a skew cell and mixed PBC', () => {
  const frame = { fractional: Float64Array.from([.98, .02, -.2, .04, .95, .1, .45, .52, 1.3, .65, .2, .7]),
    cell: createCell({ vectors: [4, 0, 0, 3.6, 3, 0, 1.5, -.7, 5], pbc: [true, true, false], triclinic: true }) };
  const search = new NeighborSearch(frame);
  for (let atom = 0; atom < 4; atom += 1) {
    const expected = [];
    for (let other = 0; other < 4; other += 1) for (let a = -5; a <= 5; a += 1) for (let b = -5; b <= 5; b += 1) {
      if (other === atom && !a && !b) continue;
      const d = [0, 1, 2].map((axis) => frame.fractional[other * 3 + axis] - frame.fractional[atom * 3 + axis] + [a, b, 0][axis]);
      const h = frame.cell.vectors;
      const v = [0, 1, 2].map((axis) => d[0] * h[axis] + d[1] * h[3 + axis] + d[2] * h[6 + axis]);
      expected.push(v.reduce((sum, x) => sum + x * x, 0));
    }
    expected.sort((a, b) => a - b);
    const actual = search.nearest(atom, 14).map((n) => n.distanceSquared);
    actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9));
  }
});

test('invalid parameters and atom ranges fail rather than returning partial analysis', () => {
  const frame = crystalFrame('fcc');
  assert.throws(() => calculateCna(frame, { mode: 'fixed', cutoff: 0 }));
  assert.throws(() => calculateCna(frame, { mode: 'ptm' }));
  assert.throws(() => calculateCna(frame, { startAtom: -1 }));
  assert.throws(() => calculateCentrosymmetry(frame, { neighbors: 7 }));
});
