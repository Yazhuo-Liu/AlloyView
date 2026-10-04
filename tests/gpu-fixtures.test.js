import assert from 'node:assert/strict';
import test from 'node:test';
import { cnaDirectFixtures, cnaFixtures, cloneFrame, pointFrame, referenceStrainFixtures, reorderFrame, transformFrame } from '../scripts/gpu-fixtures.js';
import { calculateCna } from '../src/analysis/cna.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { calculateReferenceStrain, REFERENCE_STRAIN_FIELDS } from '../src/analysis/reference-strain.js';
import { fractionalToCartesian } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

function near(actual, expected, tolerance = 2e-6) {
  assert.ok(Number.isFinite(actual), `Expected a finite value, received ${actual}.`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test('GPU fixture cloning isolates typed coordinates, IDs, cell and per-atom properties', () => {
  const source = crystalFrame('fcc', 1, 3.52);
  source.properties = [{ name: 'energy', data: Float64Array.from([1, 2, 3, 4]) }];
  source.unwrappedPositions = Float64Array.from(source.positions);
  source.imageFlags = new Int32Array(12);
  const cloned = cloneFrame(source);
  for (const name of ['ids', 'types', 'positions', 'fractional', 'unwrappedPositions', 'imageFlags']) {
    assert.deepEqual(cloned[name], source[name]);
    assert.notEqual(cloned[name].buffer, source[name].buffer);
  }
  assert.notEqual(cloned.cell.vectors.buffer, source.cell.vectors.buffer);
  assert.notEqual(cloned.cell.origin.buffer, source.cell.origin.buffer);
  cloned.fractional[0] = .7;
  cloned.cell.vectors[0] = 20;
  cloned.properties[0].data[0] = 99;
  cloned.typeLabels[0] = 'Changed';
  assert.equal(source.fractional[0], 0);
  assert.equal(source.cell.vectors[0], 3.52);
  assert.equal(source.properties[0].data[0], 1);
  assert.equal(source.typeLabels[0], 'X');
});

test('row reordering preserves string IDs, typed properties, vectors and omitted vacancies', () => {
  const source = crystalFrame('fcc', 1, 3.52);
  source.ids = ['first', 'second', 'third', 'fourth'];
  source.types = Uint16Array.from([0, 1, 2, 3]);
  source.properties = [{ name: 'energy', data: Float64Array.from([1, 2, 3, 4]) }];
  source.imageFlags = Int32Array.from({ length: 12 }, (_, index) => index);
  source.unwrappedPositions = Float64Array.from(source.positions);
  const reordered = reorderFrame(source, [3, 0, 2]);
  assert.deepEqual(reordered.ids, ['fourth', 'first', 'third']);
  assert.deepEqual(reordered.types, Uint16Array.from([3, 0, 2]));
  assert.deepEqual(reordered.properties[0].data, Float64Array.from([4, 1, 3]));
  assert.deepEqual(reordered.imageFlags, Int32Array.from([9, 10, 11, 0, 1, 2, 6, 7, 8]));
  assert.deepEqual(reordered.unwrappedPositions.subarray(0, 3), source.unwrappedPositions.subarray(9, 12));
  assert.deepEqual(reordered.fractional.subarray(0, 3), source.fractional.subarray(9, 12));
  assert.deepEqual(reordered.cell.vectors, source.cell.vectors);
  assert.deepEqual(source.ids, ['first', 'second', 'third', 'fourth']);
  assert.throws(() => reorderFrame(source, [1, 1]), /unique valid/);
  assert.throws(() => reorderFrame(source, [-1]), /unique valid/);
});

test('Cartesian affine fixtures preserve the physical map when their origin is reexpressed', () => {
  const source = transformFrame(crystalFrame('hcp', 1, 2.5), undefined, { translation: [8.5, -3.25, 1.75] });
  const originalFractional = source.fractional.slice();
  const F = [1.02, .12, .03, -.04, .98, .05, .02, 0, 1.04];
  const translation = [7.5, 2.25, -5];
  const transformed = transformFrame(source, F, { translation, origin: [-12, 3, 7] });
  const input = fractionalToCartesian(source.fractional, source.cell, new Float64Array(source.fractional.length));
  const output = fractionalToCartesian(transformed.fractional, transformed.cell, new Float64Array(transformed.fractional.length));
  for (let atom = 0; atom < source.ids.length; atom += 1) for (let row = 0; row < 3; row += 1) {
    const expected = translation[row] + [0, 1, 2].reduce((sum, k) => sum + F[row * 3 + k] * input[atom * 3 + k], 0);
    near(output[atom * 3 + row], expected, 1e-12);
  }
  assert.deepEqual(source.fractional, originalFractional);
  assert.deepEqual(transformed.cell.origin, Float64Array.from([-12, 3, 7]));
  assert.throws(() => pointFrame([[0, 1], [0, 1, 2, 3]]), /finite 3D/);
});

test('affine-transformed cells preserve exact fractional open-boundary coordinates', () => {
  const source = crystalFrame('fcc', 2, 3.52);
  source.cell.pbc = [true, false, true];
  const transformed = transformFrame(source, [1.02, .12, .03, 0, .98, .05, 0, 0, 1.04], { translation: [7.5, 2.25, -5] });
  assert.deepEqual(transformed.fractional, source.fractional);
  assert.notEqual(transformed.fractional.buffer, source.fractional.buffer);
  for (let atom = 0; atom < source.ids.length; atom += 1) assert.ok(transformed.fractional[atom * 3 + 1] >= 0);
});

for (const fixture of cnaFixtures().filter(entry => entry.expectedStructure !== undefined || entry.expectedCenter !== undefined)) {
  test(`GPU scientific fixture: ${fixture.label} has its expected CNA classification`, () => {
    const result = calculateCna(fixture.frame, fixture.parameters);
    if (fixture.expectedStructure !== undefined) assert.ok(result.structures.every(value => value === fixture.expectedStructure));
    if (fixture.expectedCenter !== undefined) assert.equal(result.structures[0], fixture.expectedCenter);
    if (fixture.expectedMinimumRadiusAttempts !== undefined) {
      const search = new NeighborSearch(fixture.frame);
      assert.ok(search.within(0, search.initialRadius).length < 14, 'The isolated center needs a larger sphere to find fourteen neighbors.');
      assert.equal(search.nearest(0, 14).length, 14);
    }
  });
}

for (const fixture of cnaDirectFixtures()) {
  test(`GPU scientific fixture: ${fixture.label} preserves the icosahedral center`, () => {
    const result = calculateCna(fixture.frame, fixture.parameters);
    assert.equal(fixture.frame.ids.length, 21);
    assert.equal(result.structures.length, 1);
    assert.equal(result.structures[0], fixture.expectedCenter);
    const search = new NeighborSearch(fixture.frame);
    const neighbors = search.nearest(0, 14);
    const closePackedRadius = neighbors.slice(0, 12).reduce((sum, neighbor) => sum + Math.sqrt(neighbor.distanceSquared), 0)
      / 12 * (1 + Math.SQRT2) / 2;
    assert.ok(Number.isFinite(Math.fround(search.initialRadius ** 2)), 'The initial neighbor query is representable in Float32.');
    assert.equal(Math.fround(closePackedRadius ** 2), Infinity, 'The graph radius exceeds Float32 after adaptive scaling.');
  });
}

function analyticStrain(F) {
  const E = Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3), column = index % 3;
    return ([0, 1, 2].reduce((sum, k) => sum + F[k * 3 + row] * F[k * 3 + column], 0) - (row === column ? 1 : 0)) / 2;
  });
  const hydrostatic = (E[0] + E[4] + E[8]) / 3;
  const shear = Math.sqrt(E.reduce((sum, value, k) => sum + (value - (k % 4 === 0 ? hydrostatic : 0)) ** 2, 0) / 2);
  const determinant = F[0] * (F[4] * F[8] - F[5] * F[7])
    - F[1] * (F[3] * F[8] - F[5] * F[6]) + F[2] * (F[3] * F[7] - F[4] * F[6]);
  return { referenceShearStrain: shear, referenceHydrostaticStrain: hydrostatic, referenceVolumeChange: determinant - 1,
    referenceE11: E[0], referenceE22: E[4], referenceE33: E[8], referenceE12: E[1], referenceE13: E[2], referenceE23: E[5],
    ...Object.fromEntries(F.map((value, k) => [`referenceF${Math.floor(k / 3) + 1}${k % 3 + 1}`, value])) };
}

for (const fixture of referenceStrainFixtures()) {
  test(`GPU scientific fixture: ${fixture.label} matches its affine strain or undefined fit`, () => {
    const result = calculateReferenceStrain(fixture.frame, fixture.parameters);
    const nanAtoms = new Set(fixture.expectedNaNAtoms ?? []);
    const expected = fixture.expectedF && analyticStrain(fixture.expectedF);
    const expectedCenter = fixture.expectedCenterF && analyticStrain(fixture.expectedCenterF);
    for (let atom = 0; atom < fixture.frame.ids.length; atom += 1) for (const name of REFERENCE_STRAIN_FIELDS) {
      if (nanAtoms.has(atom)) assert.ok(Number.isNaN(result[name][atom]), `${name}[${atom}] should be NaN.`);
      else if (expected) near(result[name][atom], expected[name]);
      else if (atom === 0 && expectedCenter) near(result[name][atom], expectedCenter[name]);
      else assert.ok(Number.isFinite(result[name][atom]), `${name}[${atom}] should have a defined fit.`);
    }
    for (const [name, expectedTiny] of Object.entries(fixture.expectedTinyFields ?? {})) {
      assert.ok(expectedTiny > 0, `${name} should describe a genuine positive strain.`);
      for (const value of result[name]) {
        assert.ok(value > 0, `${name} must preserve genuine tiny strain instead of clamping it to zero.`);
        assert.ok(Math.abs(value - expectedTiny) / expectedTiny < fixture.tinyRelativeTolerance,
          `${name}: ${value} differs from ${expectedTiny} by more than the relative tolerance.`);
      }
    }
    assert.equal(result.incomplete, nanAtoms.size);
    assert.equal(result.warning, null);
  });
}
