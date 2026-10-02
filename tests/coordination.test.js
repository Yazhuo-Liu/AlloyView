import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCoordination } from '../src/analysis/coordination.js';
import { createCell } from '../src/data/model.js';

test('2x2x2 FCC has 12 nearest neighbors at a 3.0 Å cutoff', () => {
  const frame = crystalFrame('fcc', 2, 4.05);
  const result = calculateCoordination(frame, 3.0);
  assert.equal(result.coordination.length, 32);
  assert.ok(result.coordination.every((value) => value === 12));
});

test('2x2x2 BCC has 8 nearest neighbors below the second shell', () => {
  const frame = crystalFrame('bcc', 2, 3.3);
  const result = calculateCoordination(frame, 3.0);
  assert.equal(result.coordination.length, 16);
  assert.ok(result.coordination.every((value) => value === 8));
});

test('minimum image finds a neighbor across a periodic boundary', () => {
  const frame = {
    fractional: new Float32Array([0.01, 0.5, 0.5, 0.99, 0.5, 0.5]),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }),
  };
  assert.deepEqual([...calculateCoordination(frame, 0.21).coordination], [1, 1]);
  frame.cell.pbc[0] = false;
  assert.deepEqual([...calculateCoordination(frame, 0.21).coordination], [0, 0]);
});

test('restricted triclinic image search matches a boundary-crossing pair', () => {
  const frame = {
    fractional: new Float32Array([0.98, 0.98, 0.5, 0.02, 0.02, 0.5]),
    cell: createCell({ vectors: [5, 0, 0, 2.4, 5, 0, 0.8, -0.6, 5], triclinic: true }),
  };
  assert.deepEqual([...calculateCoordination(frame, 0.4).coordination], [1, 1]);
});

test('one FCC vacancy lowers exactly its 12 nearest neighbors to coordination 11', () => {
  const frame = crystalFrame('fcc', 3, 4.05);
  frame.fractional = frame.fractional.slice(3);
  const result = calculateCoordination(frame, 3.0);
  const histogram = new Map();
  for (const value of result.coordination) histogram.set(value, (histogram.get(value) ?? 0) + 1);
  assert.equal(histogram.get(11), 12);
  assert.equal(histogram.get(12), frame.fractional.length / 3 - 12);
});

test('independent atom-range results merge to the single-worker result', () => {
  const frame = crystalFrame('fcc', 3, 4.05);
  const expected = calculateCoordination(frame, 3.0).coordination;
  const midpoint = expected.length / 2;
  const left = calculateCoordination(frame, 3.0, { startAtom: 0, endAtom: midpoint }).coordination;
  const right = calculateCoordination(frame, 3.0, { startAtom: midpoint, endAtom: expected.length }).coordination;
  const merged = Uint32Array.from(left, (value, atom) => value + right[atom]);
  assert.deepEqual(merged, expected);
});

function crystalFrame(kind, repetitions, latticeConstant) {
  const basis = kind === 'fcc'
    ? [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]]
    : [[0, 0, 0], [0.5, 0.5, 0.5]];
  const fractional = [];
  for (let i = 0; i < repetitions; i += 1) {
    for (let j = 0; j < repetitions; j += 1) {
      for (let k = 0; k < repetitions; k += 1) {
        for (const site of basis) {
          fractional.push(
            (i + site[0]) / repetitions,
            (j + site[1]) / repetitions,
            (k + site[2]) / repetitions,
          );
        }
      }
    }
  }
  const length = repetitions * latticeConstant;
  return {
    fractional: Float32Array.from(fractional),
    cell: createCell({ vectors: [length, 0, 0, 0, length, 0, 0, 0, length] }),
  };
}
