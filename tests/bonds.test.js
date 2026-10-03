import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBonds } from '../src/analysis/bonds.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

test('primitive SC bonds retain three periodic self edges and six neighbors', () => {
  const result = calculateBonds(crystalFrame('sc', 1), { cutoff: 4.01 });
  assert.equal(result.count, 3);
  assert.deepEqual([...result.indices], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...result.coordination], [6]);
  assert.deepEqual([...result.shifts], [0, 0, 1, 0, 1, 0, 1, 0, 0]);
  assert.deepEqual([...result.vectors], [0, 0, 4, 0, 4, 0, 4, 0, 0]);
});

test('triclinic bonds carry the correct vector and lattice translation', () => {
  const frame = { fractional: Float64Array.from([.05, .05, .2, .95, .95, .2]), types: Uint16Array.from([0, 1]),
    cell: createCell({ vectors: [10, 0, 0, 4, 8, 0, 0, 0, 10], triclinic: true }) };
  const result = calculateBonds(frame, { cutoff: 2 });
  assert.equal(result.count, 1);
  assert.deepEqual([...result.indices], [0, 1]);
  assert.deepEqual([...result.shifts], [-1, -1, 0]);
  assert.ok(Math.abs(result.vectors[0] + 1.4) < 1e-6);
  assert.ok(Math.abs(result.vectors[1] + .8) < 1e-6);
  assert.deepEqual([...result.coordination], [1, 1]);
  frame.cell.pbc = [false, false, false];
  assert.equal(calculateBonds(frame, { cutoff: 2 }).count, 0);
});

test('element pair cutoffs override symmetrically and zero disables a pair', () => {
  const frame = { fractional: Float64Array.from([.1, .1, .1, .2, .1, .1, .3, .1, .1]), types: Uint16Array.from([0, 1, 0]),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
  const result = calculateBonds(frame, { cutoff: 2.1, pairCutoffs: [{ first: 1, second: 0, cutoff: 0 }] });
  assert.equal(result.count, 1);
  assert.deepEqual([...result.indices], [0, 2]);
  assert.deepEqual([...result.coordination], [1, 0, 1]);
  assert.throws(() => calculateBonds(frame, { cutoff: 2.1, pairCutoffs: [{ first: 0, second: 1, cutoff: 1 },
    { first: 1, second: 0, cutoff: 2 }] }), /only one cutoff/);
});

test('split bond ranges reproduce the unique graph and coordination', () => {
  const frame = crystalFrame('hcp', 2), cutoff = 4.01, count = frame.fractional.length / 3;
  const full = calculateBonds(frame, { cutoff });
  const first = calculateBonds(frame, { cutoff, endAtom: count / 2 });
  const second = calculateBonds(frame, { cutoff, startAtom: count / 2 });
  for (const field of ['indices', 'vectors', 'shifts', 'coordination']) assert.deepEqual([...first[field], ...second[field]], [...full[field]]);
  assert.equal(first.count + second.count, full.count);
});

test('bond output limit rejects instead of truncating and reports actual progress', () => {
  const frame = crystalFrame('fcc', 5), phases = [], atoms = [];
  assert.throws(() => calculateBonds(frame, { cutoff: 3, maxBonds: 10 }), /exceeds/);
  const result = calculateBonds(frame, { cutoff: 3, onPhase: (phase) => phases.push(phase), onAtoms: (count) => atoms.push(count) });
  assert.deepEqual(phases, ['indexing', 'analyzing']);
  assert.ok(atoms.some((count) => count > 0 && count < frame.types.length));
  assert.equal(atoms.at(-1), frame.types.length);
  assert.equal(result.count, frame.types.length * 6);
});
