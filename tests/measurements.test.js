import assert from 'node:assert/strict';
import test from 'node:test';
import { measureAtoms, minimumImageVector } from '../src/measurements.js';
import { createCell, fractionalToCartesian } from '../src/data/model.js';

const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
function frame(points, pbc = [false, false, false]) {
  return { ids: Uint32Array.from(points, (_, index) => 10 + index), positions: Float64Array.from(points.flat()),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc }) };
}

test('ordered picks measure distance, bond angle and signed dihedral in degrees', () => {
  const source = frame([[0, 1, 0], [0, 0, 0], [1, 0, 0], [1, 0, 1]]);
  const result = measureAtoms(source, [0, 1, 2, 3]);
  assert.deepEqual(result.atomIds, [10, 11, 12, 13]);
  assert.deepEqual(result.distances, [1, 1, 1]);
  near(result.angle, 90);
  near(result.dihedral, 90);
  near(measureAtoms(frame([[0, 1, 0], [0, 0, 0], [1, 0, 0], [1, 0, -1]]), [0, 1, 2, 3]).dihedral, -90);
});

test('periodic measurements follow nearest adjacent images and honor each PBC flag', () => {
  const source = frame([[9.5, 0, 0], [.5, 0, 0], [.5, 2, 0]], [true, false, true]);
  const result = measureAtoms(source, [0, 1, 2]);
  near(result.distance, 1);
  near(result.angle, 90);
  assert.deepEqual(result.positions, [[9.5, 0, 0], [10.5, 0, 0], [10.5, 2, 0]]);
  near(measureAtoms(source, [0, 1], { minimumImage: false }).distance, 9);
  assert.deepEqual(minimumImageVector([9, 11, 0], source.cell), [-1, 11, 0]);
});

test('exact triclinic image search corrects the failure of fractional rounding', () => {
  const cell = createCell({ vectors: [10, 0, 0, 9, 1, 0, 0, 0, 10], triclinic: true });
  const displacement = fractionalToCartesian([.49, .49, 0], cell, new Float64Array(3));
  const result = minimumImageVector(displacement, cell);
  near(result[0], .31);
  near(result[1], -.51);
  near(result[2], 0);
});

test('an exact lattice displacement is resolved directly even in a very thin skew cell', () => {
  const cell = createCell({ vectors: [1e5, 0, 0, 1e5, 1e-12, 0, 0, 0, 1e5], triclinic: true });
  assert.deepEqual(minimumImageVector([1e5, 0, 0], cell), [0, 0, 0]);
});

test('triclinic closest images agree with exhaustive image search, including mixed PBC', () => {
  for (const pbc of [[true, true, true], [true, false, true], [false, true, false]]) {
    const cell = createCell({ vectors: [4, .4, .2, 3.7, 1.1, .3, 1.8, 1.2, 3.6], pbc, triclinic: true });
    for (let sample = 0; sample < 40; sample += 1) {
      const fractional = [.49 * Math.sin(sample + .9), .49 * Math.cos(sample * .71), .49 * Math.sin(sample * .51)];
      const displacement = fractionalToCartesian(fractional, cell, new Float64Array(3));
      let best = Infinity;
      for (let i = pbc[0] ? -6 : 0; i <= (pbc[0] ? 6 : 0); i += 1) {
        for (let j = pbc[1] ? -6 : 0; j <= (pbc[1] ? 6 : 0); j += 1) {
          for (let k = pbc[2] ? -6 : 0; k <= (pbc[2] ? 6 : 0); k += 1) {
            const point = fractionalToCartesian(fractional.map((value, axis) => value - [i, j, k][axis]), cell, new Float64Array(3));
            best = Math.min(best, Math.hypot(...point));
          }
        }
      }
      near(Math.hypot(...minimumImageVector(displacement, cell)), best);
    }
  }
});

test('explicit picked replica coordinates and full-frame overrides are measured directly', () => {
  const source = frame([[1, 0, 0], [2, 0, 0], [3, 0, 0]], [true, true, true]);
  near(measureAtoms(source, [0, 1], { positions: [[1, 0, 0], [12, 0, 0]], minimumImage: false }).distance, 11);
  near(measureAtoms(source, [1, 2], { positions: new Float64Array([2, 0, 0, 23, 0, 0]), minimumImage: false }).distance, 21);
  near(measureAtoms(source, [0, 2], { positions: [0, 0, 0, 2, 0, 0, 40, 0, 0], minimumImage: false }).distance, 40);
});

test('coincident points and collinear dihedrals produce NaN rather than spurious angles', () => {
  const source = frame([[0, 0, 0], [0, 0, 0], [1, 0, 0], [2, 0, 0]]);
  const result = measureAtoms(source, [0, 1, 2, 3]);
  assert.equal(result.distance, 0);
  assert.ok(Number.isNaN(result.angle));
  assert.ok(Number.isNaN(result.dihedral));
  near(measureAtoms(source, [1, 2, 3]).angle, 180);
});

test('rigid rotation leaves all measured quantities unchanged', () => {
  const source = frame([[0, 1, 0], [0, 0, 0], [1, 0, 0], [1, 0, 1]]);
  const rotated = frame([[0, 0, 1], [0, 0, 0], [0, 1, 0], [1, 1, 0]]);
  const before = measureAtoms(source, [0, 1, 2, 3]);
  const after = measureAtoms(rotated, [0, 1, 2, 3]);
  near(after.angle, before.angle);
  near(after.dihedral, before.dihedral);
});

test('measurements reject invalid picks and malformed coordinate overrides', () => {
  const source = frame([[0, 0, 0], [1, 0, 0]]);
  assert.throws(() => measureAtoms(source, [0]), /two and four/);
  assert.throws(() => measureAtoms(source, [0, 2]), /outside/);
  assert.throws(() => measureAtoms(source, [0, .5]), /outside/);
  assert.throws(() => measureAtoms(source, [0, 1], { positions: [[0, 0, 0]] }), /tuple/);
  assert.throws(() => measureAtoms(source, [0, 1], { positions: [[0, 0, 0], [NaN, 0, 0]] }), /finite/);
  assert.throws(() => measureAtoms(source, [0, 1], { positions: [1, 2] }), /length/);
});
