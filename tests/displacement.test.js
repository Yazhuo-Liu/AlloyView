import assert from 'node:assert/strict';
import test from 'node:test';
import { computeDisplacements, minimumImageDisplacement } from '../src/analysis/displacement.js';
import { cartesianToFractional, createCell, fractionalToCartesian } from '../src/data/model.js';

const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });

function frame(ids, positions, cellValue = cell, metadata = {}) {
  return { ids: Float64Array.from(ids), positions: Float64Array.from(positions),
    fractional: cartesianToFractional(positions, cellValue, new Float64Array(positions.length)),
    cell: cellValue, idSource: 'explicit', ...metadata };
}

function near(actual, expected, tolerance = 2e-6) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < tolerance, `${value} != ${expected[axis]}`));
}

test('displacements follow stable IDs across reorder and leave new atoms undefined', async () => {
  const reference = frame([1, 2, 3], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const current = frame([3, 1, 4], [8, 8, 9, 1, 3, 3, 0, 0, 0]);
  const before = Array.from(current.positions), referenceBefore = Array.from(reference.positions);
  const result = await computeDisplacements(current, reference);
  near(result.vectors.subarray(0, 6), [1, 0, 0, 0, 1, 0]);
  assert.ok(result.vectors.subarray(6).every(Number.isNaN));
  assert.deepEqual([...result.referenceMapping], [2, 0, -1]);
  assert.equal(result.matched, 2);
  assert.equal(result.unmatched, 1);
  assert.equal(result.mappingMode, 'id');
  assert.deepEqual([...current.positions], before);
  assert.deepEqual([...reference.positions], referenceBefore);
});

test('wrapped crossings use shortest periodic displacement and unwrapped coordinates retain image motion', async () => {
  const reference = frame([1], [9.5, 2, 3]), current = frame([1], [.5, 2, 3]);
  near((await computeDisplacements(current, reference)).vectors, [1, 0, 0]);
  near((await computeDisplacements(current, reference, { minimumImage: false })).vectors, [-9, 0, 0]);
  reference.unwrappedPositions = new Float64Array([19.5, 2, 3]);
  current.unwrappedPositions = new Float64Array([30.5, 2, 3]);
  near((await computeDisplacements(current, reference, { minimumImage: false })).vectors, [11, 0, 0]);
  near((await computeDisplacements(current, reference)).vectors, [1, 0, 0]);
});

test('minimum images use the Cartesian metric in strongly skewed cells', async () => {
  const skew = createCell({ vectors: [10, 0, 0, 9, 1, 0, 0, 0, 10], pbc: [true, true, false], triclinic: true });
  const reference = frame([8], [0, 0, 0], skew), current = frame([8], [9.31, .49, 1], skew);
  near((await computeDisplacements(current, reference)).vectors, [.31, -.51, 1]);
  near(minimumImageDisplacement([9.31, .49, 1], skew), [.31, -.51, 1]);
  // Verify against all lattice images within a generous bounded brute-force set.
  const output = minimumImageDisplacement([9.31, .49, 1], skew);
  const squared = output.reduce((sum, value) => sum + value * value, 0);
  for (let a = -5; a <= 5; a += 1) for (let b = -5; b <= 5; b += 1) {
    const candidate = [9.31 + 10 * a + 9 * b, .49 + b, 1];
    assert.ok(squared <= candidate.reduce((sum, value) => sum + value * value, 0) + 1e-12);
  }
});

test('nonperiodic axes do not wrap and current cell metric determines periodic images', async () => {
  const mixed = createCell({ vectors: cell.vectors, pbc: [true, false, false] });
  near(minimumImageDisplacement([9, 17, -20], mixed), [-1, 17, -20]);
  const currentCell = createCell({ vectors: [12, 0, 0, 0, 10, 0, 0, 0, 10] });
  const reference = frame([1], [1, 1, 1]), current = frame([1], [11, 1, 1], currentCell);
  near((await computeDisplacements(current, reference)).vectors, [-2, 0, 0]);
});

test('orthogonal fast path also respects rotated bases and mixed periodic axes', () => {
  const rotated = createCell({ vectors: [6, 8, 0, -8, 6, 0, 0, 0, 10], pbc: [true, false, true] });
  near(minimumImageDisplacement([3.8, 8.4, -8], rotated), [-2.2, .4, 2]);
  const open = createCell({ vectors: rotated.vectors, pbc: [false, false, false] });
  assert.deepEqual([...minimumImageDisplacement([3.8, 8.4, -8], open)], [3.8, 8.4, -8]);
});

test('cell deformation and origin changes contribute without affine remapping', async () => {
  const referenceCell = createCell({ origin: [10, 20, 30], vectors: cell.vectors, pbc: [false, false, false] });
  const currentCell = createCell({ origin: [11, 22, 33], vectors: [12, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] });
  const fractional = new Float64Array([.25, .25, .25]);
  const reference = { ids: new Int32Array([1]), fractional, cell: referenceCell };
  const current = { ids: new Int32Array([1]), fractional, cell: currentCell };
  near((await computeDisplacements(current, reference)).vectors, [1.5, 2, 3]);
  reference.positions = fractionalToCartesian(fractional, referenceCell, new Float64Array(3));
  current.positions = fractionalToCartesian(fractional, currentCell, new Float64Array(3));
  near((await computeDisplacements(current, reference)).vectors, [1.5, 2, 3]);
});

test('reference matching rejects duplicate, fractional and missing explicit IDs', async () => {
  const reference = frame([1, 2], [1, 1, 1, 2, 2, 2]);
  await assert.rejects(computeDisplacements(frame([1, 1], [1, 1, 1, 2, 2, 2]), reference), /Displacement requires unique integer atom IDs/);
  await assert.rejects(computeDisplacements(frame([1.5, 2], [1, 1, 1, 2, 2, 2]), reference), /unique integer/);
  const synthesized = { ...reference, sourceFormat: 'cfg', idSource: 'row-order' };
  await assert.rejects(computeDisplacements(synthesized, reference), /explicit atom IDs.*generated row IDs/);
  near((await computeDisplacements(synthesized, synthesized)).vectors, [0, 0, 0, 0, 0, 0]);
  await assert.rejects(computeDisplacements({ ...reference, ids: undefined }, reference), /an atom ID for every atom/);
});

test('generated CFG and XYZ IDs fall back to row order only when both counts agree', async () => {
  const reference = frame([1, 2], [1, 0, 0, 4, 0, 0], cell, { sourceFormat: 'cfg', idSource: 'row-order' });
  // The generated IDs themselves carry no cross-frame meaning: row coordinates
  // are compared regardless of their numeric values.
  const current = frame([999, 998], [2, 0, 0, 4, 2, 0], cell, { sourceFormat: 'xyz', idSource: 'row-order' });
  const result = await computeDisplacements(current, reference);
  near(result.vectors, [1, 0, 0, 0, 2, 0]);
  assert.equal(result.mappingMode, 'row-order');
  assert.deepEqual([...result.referenceMapping], [0, 1]);
  assert.equal(result.matched, 2);
  assert.equal(result.unmatched, 0);
  const oldCfg = { ...current, sourceFormat: 'cfg', idSource: undefined };
  near((await computeDisplacements(oldCfg, reference)).vectors, [1, 0, 0, 0, 2, 0]);
  assert.equal((await computeDisplacements(reference, reference)).mappingMode, 'row-order');
  const fewer = frame([1], [0, 0, 0], cell, { idSource: 'row-order' });
  await assert.rejects(computeDisplacements(fewer, reference), /same atom count/);
  await assert.rejects(computeDisplacements(reference, fewer), /same atom count/);
  const explicit = { ...current, idSource: 'explicit' };
  await assert.rejects(computeDisplacements(explicit, reference), /explicit atom IDs.*generated row IDs/);
  await assert.rejects(computeDisplacements(reference, explicit), /explicit atom IDs.*generated row IDs/);
});

test('invalid coordinates and image-search budgets fail explicitly', async () => {
  const reference = frame([1], [0, 0, 0]);
  await assert.rejects(computeDisplacements(frame([1], [NaN, 0, 0]), reference), /finite atom coordinates/);
  await assert.rejects(computeDisplacements({ ...reference, positions: new Float64Array(2) }, reference), /atom count/);
  await assert.rejects(computeDisplacements(reference, reference, { minimumImage: 'yes' }), /boolean/);
  assert.throws(() => minimumImageDisplacement([0, Infinity, 0], cell), /finite Cartesian/);
  const thin = createCell({ vectors: [1000, 0, 0, 999.9, .00001, 0, 0, 0, 10], pbc: [true, true, false], triclinic: true });
  assert.throws(() => minimumImageDisplacement([490, 0, 0], thin), /too thin/);
});

test('displacement preparation and calculation are cancellable and report phases', async () => {
  const reference = frame([1], [0, 0, 0]), current = frame([1], [1, 0, 0]);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(computeDisplacements(current, reference, { signal: aborted.signal }), { name: 'AbortError' });
  const phases = [];
  await computeDisplacements(current, reference, { onProgress: progress => phases.push(progress.phase) });
  assert.ok(phases.includes('matching'));
  assert.ok(phases.includes('displacement'));
  const count = 4096, ids = Array.from({ length: count }, (_, index) => index + 1), positions = new Float64Array(count * 3);
  const large = frame(ids, positions), cancel = new AbortController();
  await assert.rejects(computeDisplacements(large, large, { signal: cancel.signal, onProgress(progress) {
    if (progress.phase === 'displacement' && progress.completed === 2048) cancel.abort();
  } }), { name: 'AbortError' });
});

test('row-order mapping yields to cancellation while preparing large frames', async () => {
  const count = 70_000, positions = new Float64Array(count * 3);
  const ids = Array.from({ length: count }, (_, index) => index + 1);
  const generated = frame(ids, positions, cell, { idSource: 'row-order' }), cancel = new AbortController();
  let matchingCheckpoint = false;
  await assert.rejects(computeDisplacements(generated, generated, {
    signal: cancel.signal, onProgress(progress) {
      if (progress.phase === 'matching' && progress.completed === 65_536) {
        matchingCheckpoint = true;
        cancel.abort();
      }
    },
  }), { name: 'AbortError' });
  assert.equal(matchingCheckpoint, true);
});
