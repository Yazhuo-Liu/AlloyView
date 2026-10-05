import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { DXA_DEFAULTS, DXA_FAMILIES, classifyBurgersVector, dxaCartesianCoordinates,
  estimateDxaMemory, normalizeDxaResult, preflightDxaMemory, splitPeriodicPolyline,
  validateDxaFrame, validateDxaParameters } from '../src/analysis/dxa.js';

const close = (actual, expected, tolerance = 1e-9) => {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) assert.ok(Math.abs(actual[index] - expected[index]) < tolerance,
    `${actual[index]} != ${expected[index]} at ${index}`);
};
const cell = createCell({ origin: [4, -3, 7], vectors: [10, 0, 0, 3, 8, 0, 1, 2, 6] });

test('DXA parameters validate supported phases and native algorithm limits', () => {
  assert.deepEqual(validateDxaParameters(), DXA_DEFAULTS);
  for (const lattice of Object.keys(DXA_FAMILIES)) assert.equal(validateDxaParameters({ lattice }).lattice, lattice);
  for (const parameters of [{ lattice: 'auto' }, { trialCircuitLength: 2 }, { trialCircuitLength: 101 },
    { circuitStretchability: 101 }, { circuitStretchability: -1 }, { lineSmoothingIterations: 1.5 },
    { onlyPerfectDislocations: 'false' }, { linePointInterval: NaN }, { linePointInterval: -1 }]) {
    assert.throws(() => validateDxaParameters(parameters), /DXA|supported/);
  }
  assert.equal(validateDxaParameters({ linePointInterval: 0, lineSmoothingIterations: 0 }).linePointInterval, 0);
});

test('Burgers families preserve cubic signs/permutations and ideal vector magnitudes', () => {
  assert.equal(classifyBurgersVector([0, -.5, .5], 'fcc'), 'perfect');
  assert.equal(classifyBurgersVector([-1 / 3, 1 / 6, -1 / 6], 'fcc'), 'shockley');
  assert.equal(classifyBurgersVector([.5, -.5, -.5], 'bcc'), 'half111');
  assert.equal(classifyBurgersVector([0, -1, 0], 'bcc'), '100');
  assert.equal(classifyBurgersVector([0, 1, -1], 'bcc'), '110');
  assert.equal(classifyBurgersVector([1, 1, 0], 'fcc'), 'other', 'same direction, different Burgers magnitude');
  assert.equal(classifyBurgersVector([0, 0, 0], 'fcc'), 'other');
  assert.throws(() => classifyBurgersVector([NaN, 0, 0], 'fcc'), /finite/);
});

test('hexagonal Burgers families rotate the basal plane while preserving the c axis', () => {
  const a = Math.sqrt(.5), c = Math.sqrt(4 / 3), partial = Math.sqrt(1.5) / 3;
  assert.equal(classifyBurgersVector([a / 2, -a * Math.sqrt(3) / 2, 0], 'hcp'), 'a');
  assert.equal(classifyBurgersVector([0, 0, -c], 'hcp'), 'c');
  assert.equal(classifyBurgersVector([-a / 2, a * Math.sqrt(3) / 2, -c], 'hcp'), 'ca');
  assert.equal(classifyBurgersVector([partial * Math.sqrt(3) / 2, partial / 2, 0], 'hcp'), 'basalPartial');
  assert.equal(classifyBurgersVector([c, 0, 0], 'hcp'), 'other', 'a c-axis vector cannot be permuted into a basal vector');
  assert.equal(classifyBurgersVector([a, 0, c], 'hexDiamond'), 'other', 'diamond has its own family catalog');
});

test('DXA source coordinates wrap PBC images with complete triclinic vectors and origin', () => {
  const source = new Float64Array([1.25, -.4, 2.5, .2, .3, .4, .3, .4, .5, .4, .5, .6]);
  const openCell = createCell({ ...cell, pbc: [true, false, true] });
  const frame = { fractional: source, cell: openCell };
  const positions = dxaCartesianCoordinates(frame);
  close(positions.slice(0, 3), fractionalToCartesian([.25, -.4, .5], openCell, new Float64Array(3)));
  assert.equal(source[0], 1.25, 'input coordinates stay unchanged');
  const positionOnly = { positions: fractionalToCartesian(source, openCell, new Float64Array(source.length)), cell: openCell };
  close(dxaCartesianCoordinates(positionOnly), positions);
  assert.throws(() => validateDxaFrame({ fractional: source, cell: { ...cell, vectors: [1, 0, 0, 1, 0, 0, 0, 0, 1] } }), /cell/);
  assert.throws(() => validateDxaFrame({ fractional: [0, 0, NaN, ...source.slice(3)], cell }), /finite/);
});

test('whole-frame DXA memory preflight rejects excessive work without silently truncating atoms', () => {
  assert.ok(estimateDxaMemory(259_808) > 700 * 1024 ** 2);
  assert.equal(preflightDxaMemory(100, estimateDxaMemory(100)), estimateDxaMemory(100));
  assert.throws(() => preflightDxaMemory(1_000_000), /exceeding.*budget/);
  assert.throws(() => preflightDxaMemory(4, NaN), /budget/);
});

test('DXA normalization retains Burgers vectors, connectivity and source lengths/density', () => {
  const raw = { segments: [{ id: 5, points: [[4, -3, 7], [7, 1, 7]], burgersVector: [.5, 0, -.5],
    spatialBurgersVector: [0, 0, -2.4], clusterId: 8, length: 5, closed: false,
    junctions: [[{ segmentId: 5, end: 1 }], [{ segmentId: 5, end: 0 }]] }], atomStructureTypes: [1, 1, 0, 2] };
  const result = normalizeDxaResult(raw, cell, { gpuEnabled: true }, 4);
  assert.equal(result.segments[0].family, 'perfect');
  assert.ok(result.segments[0].points instanceof Float64Array);
  assert.deepEqual(result.segments[0].spatialBurgersVector, [0, 0, -2.4]);
  assert.deepEqual(result.segments[0].junctions, raw.segments[0].junctions);
  assert.equal(result.counts.perfect, 1); assert.equal(result.familyLengths.perfect, 5);
  assert.equal(result.totalLength, 5); assert.equal(result.volume, 480); assert.equal(result.density, 5 / 480);
  assert.deepEqual(result.structureCounts, { 0: 1, 1: 2, 2: 1 });
  assert.deepEqual(Array.from(result.atomStructureTypes), raw.atomStructureTypes);
  assert.notEqual(result.cell.vectors, cell.vectors);
  assert.throws(() => normalizeDxaResult({ ...raw, atomStructureTypes: [1] }, cell, {}, 4), /structure identifiers/);
  assert.throws(() => normalizeDxaResult({ segments: [{ ...raw.segments[0], points: [[NaN, 0, 0], [0, 0, 0]] }] }, cell), /coordinates/);
  const relatedPhase = normalizeDxaResult({ segments: [{ ...raw.segments[0], structureType: 2 }] }, cell);
  assert.equal(relatedPhase.segments[0].familyId, 'other', 'an unmapped HCP crystal frame is never labeled as an FCC vector');
});

test('triclinic periodic polylines split at faces and preserve physical source length', () => {
  const points = fractionalToCartesian([.8, .2, .4, 1.2, .2, .4], cell, new Float64Array(6));
  const pieces = splitPeriodicPolyline(points, cell);
  assert.equal(pieces.length, 2);
  close(pieces[0], fractionalToCartesian([.8, .2, .4, 1, .2, .4], cell, new Float64Array(6)));
  close(pieces[1], fractionalToCartesian([0, .2, .4, .2, .2, .4], cell, new Float64Array(6)));
  assert.equal(points.length, 6);
  const lengths = pieces.reduce((length, piece) => length + Math.hypot(piece[3] - piece[0], piece[4] - piece[1], piece[5] - piece[2]), 0);
  assert.ok(Math.abs(lengths - 4) < 1e-10);
});

test('periodic splitting handles negative multi-image lines, corner crossings and open axes', () => {
  const multi = fractionalToCartesian([-1.2, .2, .4, 2.2, .2, .4], cell, new Float64Array(6));
  assert.equal(splitPeriodicPolyline(multi, cell).length, 5);
  const corner = fractionalToCartesian([.8, .8, .8, 1.2, 1.2, 1.2], cell, new Float64Array(6));
  assert.equal(splitPeriodicPolyline(corner, cell).length, 2, 'simultaneous face crossings do not create zero-length pieces');
  const open = createCell({ ...cell, pbc: [false, false, false] });
  close(splitPeriodicPolyline(multi, open)[0], multi);
  const zero = fractionalToCartesian([.2, .2, .2, .2, .2, .2], cell, new Float64Array(6));
  assert.deepEqual(splitPeriodicPolyline(zero, cell), []);
});
