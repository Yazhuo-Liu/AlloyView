import assert from 'node:assert/strict';
import test from 'node:test';
import { GENERATOR_CUBIC, GENERATOR_HEXAGONAL, NO_DISORIENTATION, RADIANS_TO_DEGREES, disorientationCubic, disorientationHexagonal,
  interfacialDisorientation, latticeDisorientation, mapOntoTarget, quaternionProduct, rotateIntoFundamentalZone,
  symmetryFamily } from '../src/analysis/disorientation.js';
import { calculatePtm } from '../src/analysis/ptm.js';
import { axisAngleQuaternion, mulberry32, quaternionMultiply, randomQuaternion, stackedLayersFrame } from './helpers/polycrystal.js';

const IDENTITY = [1, 0, 0, 0];
const degrees = (fn, a, b) => fn(Float64Array.from(a), 0, Float64Array.from(b), 0) * RADIANS_TO_DEGREES;
const cubic = (a, b) => degrees(disorientationCubic, a, b), hexagonal = (a, b) => degrees(disorientationHexagonal, a, b);
function close(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≈ ${expected}`);
}

test('the symmetry tables are the 24 cubic and 12 hexagonal proper rotations', () => {
  for (const [table, order] of [[GENERATOR_CUBIC, 24], [GENERATOR_HEXAGONAL, 12]]) {
    assert.equal(table.length, order * 4);
    const seen = new Set();
    for (let g = 0; g < order; g += 1) {
      const q = Array.from(table.subarray(g * 4, g * 4 + 4));
      close(Math.hypot(...q), 1, 1e-15);
      seen.add(q.map(value => value.toFixed(9)).join());
      // Closure: the product of two operations is an operation, up to sign.
      const product = new Float64Array(4);
      quaternionProduct(table, g * 4, table, ((g * 7 + 3) % order) * 4, product, 0);
      const match = Array.from({ length: order }, (_, h) => Math.abs(product.reduce((sum, value, k) => sum + value * table[h * 4 + k], 0)));
      close(Math.max(...match), 1, 1e-12);
    }
    assert.equal(seen.size, order);
  }
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map(symmetryFamily), [null, 'cubic', 'hexagonal', 'cubic', null, 'cubic', 'cubic', 'hexagonal', 'hexagonal']);
});

test('cubic disorientation reproduces known angles', () => {
  close(cubic(IDENTITY, IDENTITY), 0, 1e-12);
  for (const angle of [3, 17.5, 30, 44.9]) close(cubic(IDENTITY, axisAngleQuaternion([0, 0, 1], angle)), angle);
  // A fourfold axis: 90° is a symmetry operation, 45° the largest about <100>, 60° equals 30°.
  close(cubic(IDENTITY, axisAngleQuaternion([1, 0, 0], 90)), 0);
  close(cubic(IDENTITY, axisAngleQuaternion([0, 1, 0], 45)), 45);
  close(cubic(IDENTITY, axisAngleQuaternion([0, 0, 1], 60)), 30);
  // The Σ3 twin: 60° about <111>; 120° about <111> is a symmetry operation.
  close(cubic(IDENTITY, axisAngleQuaternion([1, 1, 1], 60)), 60);
  close(cubic(IDENTITY, axisAngleQuaternion([1, 1, 1], 120)), 0);
  // Σ5: 36.87° about <100>; Σ9: 38.94° about <110>.
  close(cubic(IDENTITY, axisAngleQuaternion([1, 0, 0], 2 * Math.atan(1 / 3) * RADIANS_TO_DEGREES)), 36.8698976, 1e-6);
  close(cubic(IDENTITY, axisAngleQuaternion([1, 1, 0], Math.acos(7 / 9) * RADIANS_TO_DEGREES)), 38.9424413, 1e-6);
  // Mackenzie's maximum, 62.7994°, about <1, 1, √2 − 1>.
  const maximum = 2 * Math.acos((Math.SQRT2 + 1) / 2 / Math.sqrt(2)) * RADIANS_TO_DEGREES;
  close(maximum, 62.7994296, 1e-6);
  close(cubic(IDENTITY, axisAngleQuaternion([1, 1, Math.SQRT2 - 1], maximum)), maximum, 1e-5);
});

test('hexagonal disorientation reproduces known angles', () => {
  for (const angle of [4, 12.5, 29.9]) close(hexagonal(IDENTITY, axisAngleQuaternion([0, 0, 1], angle)), angle);
  close(hexagonal(IDENTITY, axisAngleQuaternion([0, 0, 1], 60)), 0);
  close(hexagonal(IDENTITY, axisAngleQuaternion([0, 0, 1], 45)), 15);
  close(hexagonal(IDENTITY, axisAngleQuaternion([1, 0, 0], 180)), 0);
  close(hexagonal(IDENTITY, axisAngleQuaternion([1, 0, 0], 90)), 90);
  close(hexagonal(IDENTITY, axisAngleQuaternion([1, 0, 0], 100)), 80);
  // The largest hexagonal disorientation is 93.84°.
  const random = mulberry32(5);
  let largest = 0;
  for (let sample = 0; sample < 20000; sample += 1) largest = Math.max(largest, hexagonal(IDENTITY, randomQuaternion(random)));
  assert.ok(largest > 92 && largest <= 93.8411, String(largest));
});

test('disorientation is symmetric, bounded and invariant under the symmetry group', () => {
  const random = mulberry32(11);
  for (const [fn, table, order, bound] of [[cubic, GENERATOR_CUBIC, 24, 62.7995], [hexagonal, GENERATOR_HEXAGONAL, 12, 93.8411]]) {
    for (let sample = 0; sample < 200; sample += 1) {
      const a = randomQuaternion(random), b = randomQuaternion(random), base = fn(a, b);
      assert.ok(base >= 0 && base <= bound);
      close(fn(b, a), base, 1e-5);
      const g = Array.from(table.subarray((sample % order) * 4, (sample % order) * 4 + 4));
      const h = Array.from(table.subarray(((sample * 5 + 1) % order) * 4, ((sample * 5 + 1) % order) * 4 + 4));
      // Equivalent descriptions of both crystals, and a common rotation of the sample.
      close(fn(quaternionMultiply(a, g), quaternionMultiply(b, h)), base, 1e-5);
      const sampleRotation = randomQuaternion(random);
      close(fn(quaternionMultiply(sampleRotation, a), quaternionMultiply(sampleRotation, b)), base, 1e-5);
      // The sign of a quaternion does not change its rotation.
      close(fn(a, b.map(value => -value)), base, 1e-5);
    }
  }
});

test('lattice disorientation is in degrees and undefined between different or non-lattice structures', () => {
  const a = Float64Array.from(IDENTITY), b = Float64Array.from(axisAngleQuaternion([0, 0, 1], 10));
  for (const type of [1, 3, 5, 6]) close(latticeDisorientation(type, type, a, 0, b, 0), 10);
  for (const type of [2, 7, 8]) close(latticeDisorientation(type, type, a, 0, b, 0), 10);
  assert.equal(latticeDisorientation(1, 2, a, 0, b, 0), NO_DISORIENTATION);
  assert.equal(latticeDisorientation(1, 3, a, 0, a, 0), NO_DISORIENTATION, 'FCC and BCC never share a grain');
  assert.equal(latticeDisorientation(4, 4, a, 0, a, 0), NO_DISORIENTATION, 'icosahedral atoms have no lattice orientation');
  assert.equal(latticeDisorientation(0, 0, a, 0, a, 0), NO_DISORIENTATION);
  assert.equal(NO_DISORIENTATION, Number.MAX_VALUE);
  // Offsets address quaternions inside per-atom arrays.
  const packed = Float64Array.of(9, 9, ...IDENTITY, ...axisAngleQuaternion([1, 0, 0], 7));
  close(latticeDisorientation(3, 3, packed, 2, packed, 6), 7);
});

test('the fundamental zone keeps the equivalent closest to the identity', () => {
  const random = mulberry32(3);
  for (const table of [GENERATOR_CUBIC, GENERATOR_HEXAGONAL]) {
    for (let sample = 0; sample < 100; sample += 1) {
      const q = Float64Array.from(randomQuaternion(random)), original = Array.from(q);
      const index = rotateIntoFundamentalZone(table, q);
      assert.ok(index >= 0 && q[0] >= 0);
      close(Math.hypot(...q), 1, 1e-12);
      // No other equivalent has a larger w.
      for (let g = 0; g < table.length; g += 4) {
        const w = Math.abs(original[0] * table[g] - original[1] * table[g + 1] - original[2] * table[g + 2] - original[3] * table[g + 3]);
        assert.ok(w <= q[0] + 1e-12);
      }
    }
  }
  const zero = new Float64Array(4);
  assert.equal(rotateIntoFundamentalZone(GENERATOR_CUBIC, zero), -1);
  assert.deepEqual(Array.from(zero), [0, 0, 0, 0]);
  assert.equal(rotateIntoFundamentalZone(GENERATOR_CUBIC, Float64Array.of(NaN, 0, 0, 0)), -1);
});

test('mapping onto a target undoes a symmetry operation', () => {
  const random = mulberry32(21);
  for (const [type, table, order] of [[1, GENERATOR_CUBIC, 24], [3, GENERATOR_CUBIC, 24], [2, GENERATOR_HEXAGONAL, 12]]) {
    for (let sample = 0; sample < 100; sample += 1) {
      const target = randomQuaternion(random), tilt = axisAngleQuaternion([random() - .5, random() - .5, random() - .5], 2 * random());
      const near = quaternionMultiply(target, tilt);
      const g = Array.from(table.subarray((sample % order) * 4, (sample % order) * 4 + 4));
      const q = Float64Array.from(quaternionMultiply(near, g));
      const angle = mapOntoTarget(type, Float64Array.from(target), 0, q, 0) * RADIANS_TO_DEGREES;
      assert.ok(angle <= 2 + 1e-6, `${angle}`);
      // The mapped quaternion is the tilted one again, up to sign.
      close(Math.abs(q.reduce((sum, value, k) => sum + value * near[k], 0)), 1, 1e-12);
    }
  }
  const q = Float64Array.from(axisAngleQuaternion([0, 0, 1], 80));
  assert.equal(mapOntoTarget(4, Float64Array.from(IDENTITY), 0, q, 0), Infinity, 'no lattice for icosahedral atoms');
  assert.deepEqual(Array.from(q), axisAngleQuaternion([0, 0, 1], 80), 'and the quaternion is left as it was');
  assert.equal(mapOntoTarget(0, Float64Array.from(IDENTITY), 0, q, 0), Infinity);
});

test('a coherent FCC–HCP interface has no interfacial disorientation', async () => {
  // Ideal layers: FCC, an intrinsic stacking fault (two HCP layers), FCC.
  const frame = stackedLayersFrame({ steps: [...Array(8).fill(1), -1, ...Array(8).fill(1)], nearest: 2.5, nx: 6, ny: 4 });
  const ptm = await calculatePtm(frame, { flags: 7, neighborLists: true });
  const counts = [0, 0, 0];
  for (const type of ptm.structures) counts[type] += 1;
  assert.deepEqual(counts, [0, 15 * 48, 2 * 48]);
  const output = new Float64Array(4);
  let pairs = 0;
  for (let atom = 0; atom < ptm.structures.length; atom += 1) {
    if (ptm.structures[atom] !== 1) continue;
    for (let slot = 0; slot < ptm.neighborCounts[atom]; slot += 1) {
      const neighbor = ptm.neighborIndices[atom * 16 + slot];
      if (ptm.structures[neighbor] !== 2) continue;
      // FCC parent: the HCP atom becomes an FCC orientation equal to its neighbor's.
      const angle = interfacialDisorientation(true, ptm.orientations, atom * 4, ptm.orientations, neighbor * 4, output);
      assert.ok(angle < 1e-4, `${angle}`);
      assert.ok(latticeDisorientation(1, 1, ptm.orientations, atom * 4, output, 0) < 1e-4);
      assert.ok(output[0] >= 0);
      // HCP parent: the FCC atom becomes an HCP orientation equal to its neighbor's.
      const reverse = interfacialDisorientation(false, ptm.orientations, neighbor * 4, ptm.orientations, atom * 4, output);
      assert.ok(reverse < 1e-4, `${reverse}`);
      assert.ok(latticeDisorientation(2, 2, ptm.orientations, neighbor * 4, output, 0) < 1e-4);
      pairs += 1;
    }
  }
  assert.ok(pairs >= 96);
  // An unrelated orientation is far from coherent.
  const tilted = Float64Array.from(axisAngleQuaternion([1, 0, 0], 20));
  const fcc = ptm.structures.indexOf(1), hcp = ptm.structures.indexOf(2);
  const rotated = new Float64Array(4);
  quaternionProduct(tilted, 0, ptm.orientations, hcp * 4, rotated, 0);
  assert.ok(interfacialDisorientation(true, ptm.orientations, fcc * 4, rotated, 0, output) > 4);
});
