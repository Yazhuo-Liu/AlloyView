import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCoordination, createCoordinationIndex } from '../src/analysis/coordination.js';
import { createCell } from '../src/data/model.js';

const fixtures = [
  ['skew periodic', [8, 0, 0, 3.9, 7, 0, -2, 1.1, 6], [true, true, true], 2.3],
  ['thin periodic', [1.1, 0, 0, 0.4, 8, 0, 0.3, -0.2, 7], [true, true, true], 2.3],
  ['nonperiodic', [8, 0, 0, -3.1, 7, 0, 1, -0.4, 9], [false, false, false], 2.3],
  ['mixed boundaries', [8, 0, 0, 2.1, 7, 0, 0.2, 1.3, 9], [false, true, false], 2.3],
];

for (const [name, vectors, pbc, cutoff] of fixtures) {
  test(`resident coordination index preserves exact outputs for ${name}`, () => {
    const frame = makeFrame(vectors, pbc);
    const expected = calculateCoordination(frame, cutoff);
    for (const sharedMemory of [false, true]) {
      const index = createCoordinationIndex(frame, cutoff, { sharedMemory });
      assert.equal(index.heads.buffer instanceof SharedArrayBuffer, sharedMemory);
      assert.equal(index.next.buffer instanceof SharedArrayBuffer, sharedMemory);
      assert.equal(index.atomBins.buffer instanceof SharedArrayBuffer, sharedMemory);
      const result = calculateCoordination(frame, cutoff, { coordinationIndex: index });
      compareResult(result, expected);
      // A structured clone is the Worker handoff contract; it must retain list
      // order, while shared storage remains the same underlying allocation.
      compareResult(calculateCoordination(frame, cutoff, {
        coordinationIndex: structuredClone(index),
      }), expected);
    }
  });

  test(`bounded coordination chunks preserve counts and pair statistics for ${name}`, () => {
    const frame = makeFrame(vectors, pbc);
    const count = frame.fractional.length / 3;
    const expected = calculateCoordination(frame, cutoff);
    const index = createCoordinationIndex(frame, cutoff, { sharedMemory: true });
    const merged = new Uint32Array(count);
    let candidatePairs = 0;
    let acceptedPairs = 0;
    for (let startAtom = 0; startAtom < count; startAtom += 7) {
      const endAtom = Math.min(count, startAtom + 7);
      const range = { startAtom, endAtom, coordinationIndex: index };
      const owned = calculateCoordination(frame, cutoff, range);
      const compact = calculateCoordination(frame, cutoff, { ...range, compactOutput: true });
      assert.equal(compact.compactOutput, true);
      assert.equal(compact.coordination.length, endAtom - startAtom);
      assert.deepEqual(compact.coordination, expected.coordination.slice(startAtom, endAtom));
      assert.equal(compact.candidatePairs, owned.candidatePairs);
      assert.equal(compact.acceptedPairs, owned.acceptedPairs);
      merged.set(compact.coordination, startAtom);
      candidatePairs += compact.candidatePairs;
      acceptedPairs += compact.acceptedPairs;
    }
    assert.deepEqual(merged, expected.coordination);
    assert.equal(candidatePairs, expected.candidatePairs);
    assert.equal(acceptedPairs, expected.acceptedPairs);
  });
}

test('resident coordination indices reject a different cell, cutoff, or atom count', () => {
  const frame = makeFrame(fixtures[0][1], fixtures[0][2]);
  const index = createCoordinationIndex(frame, 2.3);
  assert.throws(() => calculateCoordination(frame, 2.4, { coordinationIndex: index }), /does not match/);
  assert.throws(() => calculateCoordination({ ...frame, fractional: frame.fractional.slice(3) }, 2.3, {
    coordinationIndex: index,
  }), /does not match/);
  const changed = { ...frame, cell: createCell({ vectors: frame.cell.vectors, pbc: [false, true, true] }) };
  assert.throws(() => calculateCoordination(changed, 2.3, { coordinationIndex: index }), /does not match/);
  changed.cell.pbc = [...frame.cell.pbc];
  changed.cell.vectors[0] += 1;
  assert.throws(() => calculateCoordination(changed, 2.3, { coordinationIndex: index }), /does not match/);
});

function compareResult(result, expected) {
  const { elapsedMs: _resultElapsed, ...actual } = result;
  const { elapsedMs: _expectedElapsed, ...reference } = expected;
  assert.deepEqual(actual, reference);
}

function makeFrame(vectors, pbc) {
  const fractional = new Float64Array(77 * 3);
  for (let atom = 0; atom < 77; atom += 1) {
    fractional[atom * 3] = ((atom * 19) % 79) / 79 - 0.1;
    fractional[atom * 3 + 1] = ((atom * 23) % 83) / 83;
    fractional[atom * 3 + 2] = ((atom * 31) % 89) / 89 + 0.2;
  }
  return { fractional, cell: createCell({ vectors, pbc }) };
}
