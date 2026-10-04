import assert from 'node:assert/strict';
import test from 'node:test';
import { cnaDirectFixtures, cnaFixtures, cloneFrame, cspFixtures, displacementFixtures, displacementValidationFixtures,
  idealStrainFixtures, pointFrame, referenceStrainFixtures, reorderFrame, transformFrame } from '../scripts/gpu-fixtures.js';
import { calculateCna } from '../src/analysis/cna.js';
import { calculateAtomicStrain, STRAIN_FIELDS } from '../src/analysis/atomic-strain.js';
import { calculateCentrosymmetry } from '../src/analysis/centrosymmetry.js';
import { calculatePreparedDisplacements, computeDisplacements, prepareDisplacements } from '../src/analysis/displacement.js';
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

for (const fixture of cspFixtures()) {
  test(`GPU scientific fixture: ${fixture.label} preserves normalized CSP and its shell selection`, () => {
    const retainedLabels = fixture.parameters.structureInput?.slice();
    const result = calculateCentrosymmetry(fixture.frame, fixture.parameters);
    assert.equal(result.centrosymmetry.length, fixture.frame.ids.length);
    for (const value of result.centrosymmetry) assert.ok(Number.isNaN(value) || (value >= 0 && value <= 1), 'Normalized CSP lies in [0,1] or is undefined.');
    if (fixture.expectedValue !== undefined) for (const value of result.centrosymmetry) near(value, fixture.expectedValue, 1e-12);
    if (fixture.expectedCenterValue !== undefined) near(result.centrosymmetry[0], fixture.expectedCenterValue, 1e-12);
    if (fixture.expectedFiniteBaseline) assert.ok(result.centrosymmetry.every(value => value > .01 && value < 1), 'Ideal HCP retains its intrinsic positive CSP.');
    if (fixture.expectedFiniteNormalized) assert.ok(result.centrosymmetry.every(Number.isFinite));
    if (fixture.expectedSomePositive) assert.ok(result.centrosymmetry.some(value => value > .001), 'Defective environments retain elevated finite CSP.');
    for (const atom of fixture.expectedNaNAtoms ?? []) assert.ok(Number.isNaN(result.centrosymmetry[atom]));
    if (fixture.expectedIncomplete !== undefined) assert.equal(result.incomplete, fixture.expectedIncomplete);
    if (fixture.parameters.mode === 'auto') {
      if (fixture.expectedStructure !== undefined) assert.ok(result.cspStructureTypes.every(value => value === fixture.expectedStructure));
      if (fixture.expectedNeighborCount !== undefined) assert.ok(result.cspNeighborCounts.every(value => value === fixture.expectedNeighborCount));
      if (fixture.expectedCenterStructure !== undefined) assert.equal(result.cspStructureTypes[0], fixture.expectedCenterStructure);
      if (fixture.expectedCenterNeighborCount !== undefined) assert.equal(result.cspNeighborCounts[0], fixture.expectedCenterNeighborCount);
      for (const [name, value] of Object.entries(fixture.expectedSummaryEntries ?? {})) assert.equal(result.cspSummary[name], value);
      for (const expected of fixture.expectedAtoms ?? []) {
        assert.equal(result.cspStructureTypes[expected.atom], expected.structure);
        assert.equal(result.cspNeighborCounts[expected.atom], expected.neighbors);
      }
      if (fixture.expectedMinimumInferred !== undefined) assert.ok(result.cspSummary.inferred >= fixture.expectedMinimumInferred);
      assert.equal(['fcc', 'bcc', 'hcp', 'other', 'ico'].reduce((sum, name) => sum + result.cspSummary[name], 0), fixture.frame.ids.length);
      assert.equal(result.cspSummary.unresolved, result.centrosymmetry.filter(Number.isNaN).length);
      if (retainedLabels) assert.deepEqual(fixture.parameters.structureInput, retainedLabels);
      if (retainedLabels && fixture.cacheComparisonGroup) {
        const fresh = calculateCentrosymmetry(fixture.frame, { mode: 'auto' });
        for (const name of ['centrosymmetry', 'cspStructureTypes', 'cspNeighborCounts', 'cspSummary', 'incomplete']) assert.deepEqual(result[name], fresh[name]);
      }
    }
  });
}

for (const fixture of displacementFixtures()) {
  test(`GPU scientific fixture: ${fixture.label} has its expected Cartesian displacement`, async () => {
    const sourcePositions = fixture.frame.positions.slice(), referencePositions = fixture.reference.positions.slice();
    const parameters = await prepareDisplacements(fixture.frame, fixture.reference, fixture.options);
    const completedAtoms = [];
    const result = calculatePreparedDisplacements(fixture.frame, parameters, { onProgress: ({ completed }) => completedAtoms.push(completed) });
    assert.equal(result.vectors.length, fixture.expectedVectors.length);
    for (let k = 0; k < result.vectors.length; k += 1) {
      if (Number.isNaN(fixture.expectedVectors[k])) assert.ok(Number.isNaN(result.vectors[k]));
      else near(result.vectors[k], Math.fround(fixture.expectedVectors[k]));
    }
    const magnitudes = result.magnitudes;
    assert.ok(magnitudes instanceof Float64Array);
    for (let atom = 0; atom < magnitudes.length; atom += 1) {
      if (Number.isNaN(fixture.expectedMagnitudes[atom])) assert.ok(Number.isNaN(magnitudes[atom]));
      else near(magnitudes[atom], fixture.expectedMagnitudes[atom]);
    }
    assert.deepEqual(result.referenceMapping, fixture.expectedMapping);
    assert.equal(result.mappingMode, fixture.expectedMappingMode);
    assert.equal(result.minimumImage, fixture.options.minimumImage);
    assert.equal(result.matched, fixture.expectedMapping.filter(index => index >= 0).length);
    assert.equal(result.unmatched, fixture.expectedMapping.filter(index => index < 0).length);
    if (fixture.expectedVectors.every(value => value === 0)) {
      assert.ok(result.vectors.every(value => value === 0), 'Matched unchanged positions retain exact zero vectors.');
      assert.ok(magnitudes.every(value => value === 0), 'Matched unchanged positions retain exact zero magnitudes.');
    }
    for (const completed of fixture.expectedProgressAtoms ?? []) assert.ok(completedAtoms.includes(completed), `Progress includes ${completed} completed atoms.`);
    if (fixture.requirePositiveTinyDisplacement) {
      const atom = fixture.expectedTinyDisplacementAtom ?? 0, index = atom * 3;
      assert.ok(result.vectors[index] > 0 && magnitudes[atom] > 0, 'Genuine tiny displacement and magnitude remain positive.');
      assert.ok(Math.abs(result.vectors[index] - fixture.expectedVectors[index]) / fixture.expectedVectors[index] < fixture.tinyRelativeTolerance);
      assert.ok(Math.abs(magnitudes[atom] - fixture.expectedMagnitudes[atom]) / fixture.expectedMagnitudes[atom] < fixture.tinyRelativeTolerance);
    }
    if (fixture.expectedMagnitudeExceedsFloat32) {
      assert.ok(result.vectors.every(Number.isFinite), 'Every individual Float32 displacement component remains finite.');
      assert.ok(Number.isFinite(magnitudes[0]), 'The combined displacement magnitude remains finite in Float64.');
      assert.equal(Math.fround(magnitudes[0]), Infinity, 'The physical magnitude exceeds the Float32 numeric range.');
      assert.equal(magnitudes[0], Math.hypot(...result.vectors));
    }
    assert.deepEqual(fixture.frame.positions, sourcePositions);
    assert.deepEqual(fixture.reference.positions, referencePositions);
  });
}

for (const fixture of displacementValidationFixtures()) {
  test(`GPU scientific validation fixture: ${fixture.label}`, async () => {
    await assert.rejects(computeDisplacements(fixture.frame, fixture.reference, fixture.options), new RegExp(fixture.expectedError));
  });
}

for (const fixture of await idealStrainFixtures()) {
  test(`GPU scientific fixture: ${fixture.label} retains physical ideal-lattice strain`, async () => {
    const retained = Object.fromEntries(Object.entries(fixture.parameters.ptmInput).filter(([, value]) => ArrayBuffer.isView(value))
      .map(([name, value]) => [name, value.slice()]));
    const result = await calculateAtomicStrain(fixture.frame, fixture.parameters);
    assert.equal(result.incomplete, fixture.expectedNaNAtoms?.length ?? 0);
    if (fixture.expectedStructure !== undefined) assert.ok(fixture.parameters.ptmInput.structures.every(type => type === fixture.expectedStructure));
    if (fixture.expectedZeroStrain) for (const name of STRAIN_FIELDS) assert.ok(result[name].every(value => value === 0), `${name} preserves exact zero.`);
    for (const atom of fixture.expectedZeroAtoms ?? []) for (const name of STRAIN_FIELDS) assert.equal(result[name][atom], 0);
    for (const atom of fixture.expectedNaNAtoms ?? []) for (const name of STRAIN_FIELDS) assert.ok(Number.isNaN(result[name][atom]));
    for (const [name, expected] of Object.entries(fixture.expectedFields ?? {})) for (const value of result[name]) near(value, expected);
    if (fixture.expectedFieldsByType) for (let atom = 0; atom < fixture.frame.ids.length; atom += 1) {
      for (const [name, expected] of Object.entries(fixture.expectedFieldsByType[fixture.frame.types[atom]])) near(result[name][atom], expected);
    }
    for (const [name, expected] of Object.entries(fixture.expectedTinyFields ?? {})) {
      assert.ok(expected > 0);
      for (const value of result[name]) {
        assert.ok(value > 0, `${name} retains genuine tiny physical strain.`);
        assert.ok(Math.abs(value - expected) / expected < fixture.tinyRelativeTolerance, `${name}: ${value} differs from ${expected}.`);
      }
    }
    for (const [name, values] of Object.entries(retained)) assert.deepEqual(fixture.parameters.ptmInput[name], values);
    if (fixture.freshParameters) {
      const fresh = await calculateAtomicStrain(fixture.frame, fixture.freshParameters);
      assert.equal(fresh.incomplete, 0);
      assert.ok(fresh.structures.every(type => type === fixture.expectedStructure));
      for (const name of STRAIN_FIELDS) assert.deepEqual(fresh[name], result[name], 'Fresh and cached physical tensor results agree.');
    }
  });
}
