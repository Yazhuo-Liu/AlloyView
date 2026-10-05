import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { DXA_DEFAULTS, DXA_FAMILIES, classifyBurgersVector, dxaCartesianCoordinates,
  calculateDxa, dxaWorkerCount, estimateDxaMemory, normalizeDxaResult, preflightDxaMemory, releaseDxaKernels, splitPeriodicPolyline,
  validateDxaFrame, validateDxaParameters } from '../src/analysis/dxa.js';
import { crystalFrame } from './helpers/crystals.js';

const close = (actual, expected, tolerance = 1e-9) => {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) assert.ok(Math.abs(actual[index] - expected[index]) < tolerance,
    `${actual[index]} != ${expected[index]} at ${index}`);
};
const cell = createCell({ origin: [4, -3, 7], vectors: [10, 0, 0, 3, 8, 0, 1, 2, 6] });

test('DXA threads require shared memory and isolation, with a bounded hardware budget', () => {
  const browser = { SharedArrayBuffer, crossOriginIsolated: true, navigator: { hardwareConcurrency: 16 } };
  assert.equal(dxaWorkerCount(10000, undefined, browser), 3);
  assert.equal(dxaWorkerCount(100000, undefined, browser), 14);
  assert.equal(dxaWorkerCount(100000, undefined, { ...browser, navigator: { hardwareConcurrency: 8 } }), 6);
  assert.equal(dxaWorkerCount(10000, 2, browser), 2);
  assert.equal(dxaWorkerCount(10000, 2, { ...browser, crossOriginIsolated: false }), 1);
  assert.equal(dxaWorkerCount(10000, 2, { ...browser, SharedArrayBuffer: undefined }), 1);
  assert.equal(dxaWorkerCount(256, 2, browser), 1);
  assert.equal(dxaWorkerCount(10000, undefined, { ...browser, navigator: { hardwareConcurrency: 2 } }), 1);
  assert.equal(dxaWorkerCount(10000, undefined, { process: { versions: { node: '24' } }, SharedArrayBuffer }), 1);
  assert.equal(dxaWorkerCount(100000, 14, browser), 14);
  for (const request of [0, -1, 2.5, NaN, Infinity]) assert.throws(() => dxaWorkerCount(10000, request, browser), /worker count/);
});

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

test('staged DXA imports local GPU correspondence and records per-stage fallback without reinitializing its kernel', async () => {
  const frame = crystalFrame('fcc', 4);
  let reference, localCalls = 0;
  try {
    const verified = await calculateDxa(frame, { gpuEnabled: true }, {
      verifyGpuLocalStructures: true,
      identifyDxa: async (input, options) => {
        assert.equal(input.coordinates.length, frame.ids.length * 3);
        assert.equal(input.templates.length, 165); assert.equal(input.inverse.length, 9);
        assert.equal(input.lattice, 1); assert.equal(input.identifyPlanarDefects, true);
        assert.ok(options.referenceStructures.every(value => value === 1));
        reference = { structures: options.referenceStructures, neighbors: options.referenceNeighbors,
          neighborWidth: input.neighborWidth, maxNeighborDistance: options.referenceMaxNeighborDistance,
          elapsedMs: 3, uploadedBytes: 48, readbackBytes: 24, arithmetic: 'ieee754-f64' };
        localCalls++;
        return reference;
      },
      classifyDxa: async () => { throw new Error('tetrahedron GPU budget unavailable'); },
    });
    assert.equal(verified.backend, 'hybrid'); assert.equal(verified.gpuFallback, false);
    assert.deepEqual(verified.gpuStages, ['local-neighbors', 'local-structures', 'local-correspondence']);
    assert.deepEqual(verified.stageFallbacks, [{ stage: 'tetrahedra', reason: 'tetrahedron GPU budget unavailable' }]);
    assert.equal(verified.gpuElapsedMs, 3); assert.equal(verified.gpuUploadedBytes, 48); assert.equal(verified.gpuReadbackBytes, 24);
    assert.equal(verified.segments.length, 0);
    const withoutCpuOracle = await calculateDxa(frame, { gpuEnabled: true }, { identifyDxa: async (_input, options) => {
      assert.equal(options.referenceStructures, undefined); localCalls++;
      return reference;
    } });
    assert.equal(withoutCpuOracle.kernelGeneration, verified.kernelGeneration);
    assert.equal(withoutCpuOracle.backend, 'hybrid'); assert.equal(withoutCpuOracle.gpuFallback, false);
    assert.equal(withoutCpuOracle.segments.length, 0);
    assert.ok(!withoutCpuOracle.stageTimings.some(stage => /Identify local crystal/.test(stage.phase)),
      'the production GPU local path does not repeat native crystal identification');
    assert.equal(localCalls, 2);
    const localFailure = await calculateDxa(frame, { gpuEnabled: true }, {
      identifyDxa: async () => { throw new Error('local GPU occupancy exceeded'); },
      verifyGpuClassification: true,
      classifyDxa: async (_snapshot, options) => ({ regions: options.referenceRegions,
        elapsedMs: 7, uploadedBytes: 16, readbackBytes: 8, arithmetic: 'ieee754-f64' }),
    });
    assert.equal(localFailure.kernelGeneration, verified.kernelGeneration);
    assert.equal(localFailure.backend, 'hybrid'); assert.equal(localFailure.gpuFallback, false);
    assert.deepEqual(localFailure.gpuStages, ['tetrahedron-alpha', 'elastic-compatibility']);
    assert.deepEqual(localFailure.stageFallbacks, [{ stage: 'local', reason: 'local GPU occupancy exceeded' }]);
    assert.equal(localFailure.segments.length, 0);
    const invalid = { ...reference, neighbors: reference.neighbors.slice() };
    invalid.neighbors[0] = 0;
    const rejectedImport = await calculateDxa(frame, { gpuEnabled: true }, { identifyDxa: async () => invalid });
    assert.equal(rejectedImport.backend, 'cpu'); assert.equal(rejectedImport.gpuFallback, true);
    assert.equal(rejectedImport.segments.length, 0);
    assert.ok(rejectedImport.stageFallbacks.some(entry => entry.stage === 'local' && /neighbor|correspondence/i.test(entry.reason)));
    assert.equal(rejectedImport.kernelGeneration, verified.kernelGeneration);
    for (const metrics of [{ elapsedMs: -1 }, { uploadedBytes: Infinity }, { readbackBytes: 1.5 }]) {
      const invalidMetrics = await calculateDxa(frame, { gpuEnabled: true }, {
        identifyDxa: async () => ({ ...reference, ...metrics }),
      });
      assert.equal(invalidMetrics.backend, 'cpu'); assert.equal(invalidMetrics.gpuFallback, true);
      assert.equal(invalidMetrics.segments.length, 0);
      assert.ok(invalidMetrics.stageFallbacks.some(entry => entry.stage === 'local' && /performance metrics/.test(entry.reason)));
      assert.equal(invalidMetrics.kernelGeneration, verified.kernelGeneration);
    }
    const controller = new AbortController();
    await assert.rejects(calculateDxa(frame, { gpuEnabled: true }, { signal: controller.signal,
      identifyDxa: async () => { controller.abort(); return reference; } }), { name: 'AbortError' });
    const resumed = await calculateDxa(frame);
    assert.equal(resumed.kernelGeneration, verified.kernelGeneration);
    assert.equal(resumed.segments.length, 0);
  } finally { await releaseDxaKernels(); }
});
