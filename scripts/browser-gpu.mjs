import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

const report = await withWebGpuBrowser(async ({ evaluate, adapter, call }) => {
  if (process.argv.includes('--built-only')) return { adapter, scope: 'Versioned production ideal strain workers', builtIdeal: await runBuiltIdealChecks({ evaluate }) };
  if (process.argv.includes('--application-only')) return { adapter, scope: 'Application integration checks',
    application: await runApplicationSmoke({ evaluate, call }) };
  await evaluate(`(async () => {
    const { AnalysisPool } = await import('./src/analysis/analysis-pool.js');
    const { crystalFrame } = await import('./tests/helpers/crystals.js');
    const { createCell, fractionalToCartesian } = await import('./src/data/model.js');
    const { compareGpuBonds, compareGpuFields, compareGpuCentrosymmetry, compareGpuDisplacements, compareGpuPreparedNeighbors, compareGpuPtm, snapshotGpuInputs } = await import('./scripts/gpu-comparison.js');
    const { cnaFixtures, cnaDirectFixtures, referenceStrainFixtures, cspFixtures, displacementFixtures, displacementValidationFixtures, idealStrainFixtures } = await import('./scripts/gpu-fixtures.js');
    const { prepareDisplacements } = await import('./src/analysis/displacement.js');
    const { NeighborSearch } = await import('./src/analysis/neighbors.js');
    const { calculatePtm } = await import('./src/analysis/ptm.js');
    const { STRAIN_FIELDS } = await import('./src/analysis/atomic-strain.js');
    const { REFERENCE_STRAIN_FIELDS } = await import('./src/analysis/reference-strain.js');
    window.gpuTests = { AnalysisPool, crystalFrame, createCell, fractionalToCartesian, compareGpuBonds, compareGpuFields,
      compareGpuCentrosymmetry, compareGpuDisplacements, compareGpuPreparedNeighbors, compareGpuPtm, prepareDisplacements, snapshotGpuInputs, NeighborSearch, calculatePtm,
      cnaFixtures, cnaDirectFixtures, referenceStrainFixtures, cspFixtures, displacementFixtures, displacementValidationFixtures, idealStrainFixtures,
      STRAIN_FIELDS, REFERENCE_STRAIN_FIELDS, rows: [] };
    window.gpuTests.cpu = new AnalysisPool();
    window.gpuTests.cpu.setGpuEnabled(false);
    window.gpuTests.gpu = new AnalysisPool();
    window.gpuTests.gpu.setGpuEnabled(true);
    window.gpuTests.check = (condition, message) => { if (!condition) throw new Error(message); };
    window.gpuTests.isGpu = result => result.backend === 'gpu' || /webgpu/i.test(result.engine ?? '');
    window.gpuTests.compare = (actual, expected, tolerance = 0) => {
      if (actual.length !== expected.length) throw new Error('Result length differs.');
      let maxAbsoluteError = 0;
      for (let atom = 0; atom < actual.length; atom += 1) {
        if (Number.isNaN(actual[atom]) && Number.isNaN(expected[atom])) continue;
        if (!Number.isFinite(actual[atom]) || !Number.isFinite(expected[atom])) {
          if (actual[atom] === expected[atom]) continue;
          throw new Error('Nonfinite result differs at ' + atom);
        }
        const error = Math.abs(actual[atom] - expected[atom]);
        maxAbsoluteError = Math.max(maxAbsoluteError, error);
        if (error > tolerance) throw new Error('Result differs at ' + atom + ': GPU ' + actual[atom] + ', CPU ' + expected[atom] + ', tolerance ' + tolerance);
      }
      return maxAbsoluteError;
    };
    window.gpuTests.cpuPreparedNeighbors = frame => {
      const count = frame.fractional.length / 3, search = new NeighborSearch(frame);
      const counts = new Uint8Array(count), indices = new Uint32Array(count * 18), vectors = new Float64Array(count * 54);
      for (let atom = 0; atom < count; atom++) {
        let neighbors = search.nearest(atom, 18);
        if (neighbors.some(neighbor => neighbor.distanceSquared < 1e-20)) neighbors = [];
        counts[atom] = neighbors.length;
        neighbors.forEach((neighbor, index) => {
          indices[atom * 18 + index] = neighbor.atom;
          vectors.set([neighbor.x, neighbor.y, neighbor.z], (atom * 18 + index) * 3);
        });
      }
      return { counts, indices, vectors, maxNeighbors: 18, startAtom: 0, endAtom: count };
    };
    window.gpuTests.run = async (label, frame, parameters, field, tolerance = 0, requireGpu = true) => {
      const assertInputsIntact = window.gpuTests.snapshotGpuInputs(frame, parameters);
      const expected = parameters.kind === 'ptmNeighbors' ? window.gpuTests.cpuPreparedNeighbors(frame)
        : await window.gpuTests.cpu.analyze(frame, parameters);
      const progressAtoms = [];
      const actual = await window.gpuTests.gpu.analyze(frame, parameters, { onProgress: progress => {
        if (progress.backend === 'gpu' && progress.phase === 'analyzing' && progress.completedAtoms > 0) progressAtoms.push(progress.completedAtoms);
      } });
      assertInputsIntact();
      if (requireGpu && !window.gpuTests.isGpu(actual)) throw new Error(label + ' silently fell back: ' + JSON.stringify({ engine: actual.engine, fallbackReason: actual.fallbackReason }));
      const tensorComparison = ['strain', 'referenceStrain'].includes(parameters.kind)
        ? window.gpuTests.compareGpuFields(actual, expected, parameters.kind === 'strain'
          ? window.gpuTests.STRAIN_FIELDS : window.gpuTests.REFERENCE_STRAIN_FIELDS, tolerance) : null;
      const domainComparison = parameters.kind === 'ptmNeighbors' ? window.gpuTests.compareGpuPreparedNeighbors(actual, expected)
        : parameters.kind === 'centrosymmetry' ? window.gpuTests.compareGpuCentrosymmetry(actual, expected, tolerance)
        : parameters.kind === 'displacement' ? window.gpuTests.compareGpuDisplacements(actual, expected, tolerance) : null;
      let maxAbsoluteError = parameters.kind === 'bonds' ? window.gpuTests.compareGpuBonds(actual, expected)
        : tensorComparison ? tensorComparison.maxAbsoluteError
          : domainComparison ? domainComparison.maxAbsoluteError
          : window.gpuTests.compare(actual[field], expected[field], tolerance);
      if (parameters.kind === 'localShear') {
        window.gpuTests.compare(actual.coordination, expected.coordination);
        window.gpuTests.check(actual.coordinationMode === expected.coordinationMode, label + ' coordination mode differs.');
      }
      if (parameters.kind === 'rdf') window.gpuTests.compare(actual.counts, expected.counts);
      window.gpuTests.rows.push({ label, kind: parameters.kind, atoms: frame.ids.length, backend: actual.backend,
        engine: actual.engine, maxAbsoluteError, fallbackReason: actual.fallbackReason ?? null,
        correctedPairs: actual.correctedPairs ?? actual.precisionCorrections ?? 0,
        correctedAtoms: actual.correctedAtoms ?? actual.gpuCorrectionAtoms ?? 0, inputReused: actual.inputReused ?? null,
        radiusAttempts: actual.gpuRadiusAttempts ?? null,
        gpuInputReused: actual.gpuInputReused ?? null, ...(parameters.kind === 'bonds' ? { edges: actual.count } : {}),
        ...(parameters.kind === 'centrosymmetry' ? { incomplete: actual.incomplete, cspSummary: actual.cspSummary ?? null } : {}),
        ...(parameters.kind === 'displacement' ? { matched: actual.matched, unmatched: actual.unmatched, mappingMode: actual.mappingMode,
          vectorsType: actual.vectors.constructor.name, magnitudesType: actual.magnitudes.constructor.name, progressAtoms,
          comparison: domainComparison } : {}),
        ...(parameters.kind === 'ptmNeighbors' ? { comparedNeighbors: domainComparison.comparedNeighbors, arithmetic: actual.gpuArithmetic } : {}),
        ...(tensorComparison ? { incomplete: actual.incomplete, fieldErrors: tensorComparison.fields, neighborBackend: actual.neighborBackend ?? null,
          ptmBackend: actual.ptmBackend ?? null, referenceBackend: actual.referenceBackend ?? null, tensorBackend: actual.tensorBackend ?? null,
          ptmInputReused: actual.ptmInputReused ?? null, gpuPtmInputReused: actual.gpuPtmInputReused ?? null } : {}) });
      return actual;
    };
  })()`);
  const rows = await evaluate(`(async () => {
    const { cpu, gpu, crystalFrame, createCell, fractionalToCartesian, check, isGpu, run, rows } = window.gpuTests;
    try {
      const fcc = crystalFrame('fcc', 4, 3.52);
      const defaultResult = await cpu.analyze(fcc, { kind: 'coordination', cutoff: 2.8 });
      check(!isGpu(defaultResult), 'The explicit CPU comparison pool must use CPU workers.');
      await run('FCC coordination', fcc, { kind: 'coordination', cutoff: 2.8 }, 'coordination');
      await run('BCC coordination', crystalFrame('bcc', 4, 2.86), { kind: 'coordination', cutoff: 2.6 }, 'coordination');
      const hcp = crystalFrame('hcp', 4, 2.5);
      await run('Triclinic HCP coordination', hcp, { kind: 'coordination', cutoff: 2.7 }, 'coordination');
      const mixed = crystalFrame('fcc', 3, 3.52);
      mixed.cell = createCell({ vectors: mixed.cell.vectors, pbc: [true, false, true] });
      await run('Mixed periodic boundaries', mixed, { kind: 'coordination', cutoff: 2.8 }, 'coordination');
      const thin = crystalFrame('fcc', 1, 3.52);
      await run('Thin cell without repeated IDs', thin, { kind: 'coordination', cutoff: 2.8 }, 'coordination');
      const rdfFrame = crystalFrame('fcc', 4, 3.52);
      for (let atom = 0; atom < rdfFrame.types.length; atom += 1) rdfFrame.types[atom] = atom % 2;
      await run('Total RDF', rdfFrame, { kind: 'rdf', cutoff: 4.8, bins: 40 }, 'values', 1e-8);
      await run('Partial RDF', rdfFrame, { kind: 'rdf', cutoff: 4.8, bins: 40, firstType: 0, secondType: 1 }, 'values', 1e-8);
      await run('Triclinic RDF', hcp, { kind: 'rdf', cutoff: 4.01, bins: 31 }, 'values', 1e-8);
      const boundary = { fractional: Float64Array.from([.1, .1, .1, .2, .1, .1, .35, .1, .1]),
        ids: Uint32Array.from([1, 2, 3]), types: Uint16Array.from([0, 1, 0]),
        cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }) };
      await run('RDF exact shell boundaries', boundary, { kind: 'rdf', cutoff: 4, bins: 4 }, 'counts');
      await run('Coordination exact cutoff', boundary, { kind: 'coordination', cutoff: 1 }, 'coordination');
      const opposite = { fractional: Float64Array.from([0, 0, 0, .5, 0, 0]),
        ids: Uint32Array.from([1, 2]), types: Uint16Array.from([0, 0]),
        cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }) };
      await run('RDF exact cutoff and opposite images', opposite, { kind: 'rdf', cutoff: 5, bins: 10 }, 'counts');
      await run('FCC periodic bonds', fcc, { kind: 'bonds', cutoff: 2.8 });
      await run('Triclinic periodic bonds', hcp, { kind: 'bonds', cutoff: 2.7 });
      await run('Mixed PBC bonds', mixed, { kind: 'bonds', cutoff: 2.8 });
      await run('Thin FCC repeated-image bonds', thin, { kind: 'bonds', cutoff: 2.8 });
      await run('Single-site self-image bonds', crystalFrame('sc', 1, 2), { kind: 'bonds', cutoff: 2.1 });
      await run('Pair override bonds', rdfFrame, { kind: 'bonds', cutoff: 4.8,
        pairCutoffs: [{ first: 0, second: 0, cutoff: 0 }, { first: 0, second: 1, cutoff: 2.8 }, { first: 1, second: 1, cutoff: 3.6 }] });
      await run('Exact cutoff bonds', boundary, { kind: 'bonds', cutoff: 1 });
      for (const pool of [cpu, gpu]) {
        let rejected = false;
        try { await pool.analyze(fcc, { kind: 'bonds', cutoff: 2.8, maxBonds: 1 }); }
        catch (error) { rejected = /exceeds|limited/i.test(error.message); }
        check(rejected, 'Bond limits must reject rather than truncate output.');
      }
      await run('Geometric shear', fcc, { kind: 'localShear', cutoff: 2.8 }, 'localShear', 2e-5);
      await run('Triclinic geometric shear', hcp, { kind: 'localShear', cutoff: 2.7 }, 'localShear', 3e-5);
      await run('Thin FCC repeated atom images', thin, { kind: 'localShear', cutoff: 2.8 }, 'localShear', 3e-5);
      await run('Single-site periodic self images', crystalFrame('sc', 1, 2), { kind: 'localShear', cutoff: 2.1 }, 'localShear', 3e-5);
      const strained = crystalFrame('fcc', 4, 3.52);
      strained.cell = createCell({ vectors: [14.08 * 1.04, .18, 0, 0, 14.08 * .98, 0, 0, 0, 14.08] });
      await run('Homogeneous strain with mean subtraction', strained, { kind: 'localShear', cutoff: 2.8, subtractMean: true }, 'localShear', 3e-5);
      const stretched = crystalFrame('sc', 1, 1);
      stretched.cell = createCell({ vectors: [1.2, 0, 0, 0, 1, 0, 0, 0, 1] });
      for (const subtractMean of [false, true]) await run('Stretched single-site crystal / subtractMean=' + subtractMean,
        stretched, { kind: 'localShear', cutoff: 1.3, subtractMean }, 'localShear', 3e-5);
      const distorted = crystalFrame('fcc', 4, 3.52);
      distorted.fractional[0] += .009;
      distorted.fractional[4] -= .007;
      distorted.positions = fractionalToCartesian(distorted.fractional, distorted.cell);
      await run('Distorted geometric shear', distorted, { kind: 'localShear', cutoff: 2.8, subtractMean: true }, 'localShear', 3e-5);
      await run('Geometric shear exact cutoff', boundary, { kind: 'localShear', cutoff: 1 }, 'localShear', 3e-5);
      const tie = { fractional: Float64Array.from([.5, .5, .5, .6, .5, .5, .4, .5, .5, .5, .6 - 1e-10, .5, .5, .4, .5]),
        ids: Uint32Array.from([1, 2, 3, 4, 5]), types: new Uint16Array(5),
        cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }) };
      await run('Geometric shear nearest-K tie correction', tie, { kind: 'localShear', cutoff: 1.1, subtractMean: true }, 'localShear', 3e-5);
      const isolated = { fractional: Float64Array.from([.1, .1, .1, .5, .5, .5]),
        ids: Uint32Array.from([1, 2]), types: new Uint16Array(2),
        cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }) };
      await run('Isolated geometric shear NaN', isolated, { kind: 'localShear', cutoff: .1 }, 'localShear');
      const references = [{ structure: 1, a: 3.52 }];
      const ptmInput = await cpu.analyze(fcc, { kind: 'ptm', flags: 255 });
      const ideal = await run('Cached PTM ideal strain', fcc, { kind: 'strain', references, ptmInput }, null, 2e-6);
      for (const field of window.gpuTests.STRAIN_FIELDS) check(ideal[field].every(value => value === 0), 'Ideal GPU strain must be exactly zero: ' + field);
      const fresh = await run('Fresh GPU neighbors with CPU PTM and GPU ideal strain', fcc, { kind: 'strain', references, flags: 255 }, null, 2e-6);
      check(fresh.neighborBackend === 'gpu' && fresh.ptmBackend === 'cpu' && fresh.referenceBackend === 'gpu' && fresh.tensorBackend === 'gpu', 'Fresh ideal strain must label GPU-neighbor, CPU-fit and GPU-reference/tensor stages accurately.');
      const freshExpected = await cpu.analyze(fcc, { kind: 'ptm', flags: 255 });
      window.gpuTests.compareGpuPtm(fresh, freshExpected);
      await run('Edited lattice strain from cached PTM', fcc, { kind: 'strain', references: [{ structure: 1, a: 3.4 }], ptmInput }, null, 2e-6);
      const affine = crystalFrame('fcc', 3, 3.52);
      affine.cell = createCell({ vectors: [10.56 * 1.02, .11, 0, 0, 10.56 * .99, .07, 0, 0, 10.56 * 1.03], triclinic: true });
      const affinePtm = await cpu.analyze(affine, { kind: 'ptm', flags: 255 });
      await run('Affine shear and dilation strain', affine, { kind: 'strain', references, ptmInput: affinePtm }, null, 2e-6);
      const hexPtm = await cpu.analyze(hcp, { kind: 'ptm', flags: 255 });
      await run('Hexagonal edited a/c strain', hcp, { kind: 'strain',
        references: [{ structure: 2, a: 2.45, c: Math.sqrt(8 / 3) * 2.6 }], ptmInput: hexPtm }, null, 2e-6);
      const mismatched = await run('Reference mismatch strain NaN', fcc, { kind: 'strain', references: [{ structure: 3, a: 3.52 }], ptmInput }, null, 2e-6);
      check(mismatched.warning === null && mismatched.atomicShearStrain.every(Number.isNaN), 'Rejected PTM/reference strain must remain NaN without warnings.');
      const neighborFrames = [
        ...['fcc', 'bcc', 'hcp', 'sc', 'diamond', 'hex-diamond'].map(kind => ({ label: kind + ' primitive exact PTM neighbors', frame: crystalFrame(kind, 1, 3) })),
        { label: 'HCP triclinic exact PTM neighbors', frame: crystalFrame('hcp', 2, 2.5) },
        { label: 'Sparse periodic exact PTM neighbors', frame: isolated },
        { label: 'Nearest-distance ties exact PTM neighbors', frame: tie },
      ];
      const mixedNearest = crystalFrame('fcc', 2, 3.52);
      mixedNearest.cell = createCell({ ...mixedNearest.cell, pbc: [true, false, true] });
      neighborFrames.push({ label: 'Mixed PBC exact PTM neighbors', frame: mixedNearest });
      const coincident = { fractional: Float64Array.from([.5, .5, .5, .5, .5, .5]), ids: Uint32Array.from([1, 2]), types: new Uint16Array(2),
        cell: createCell({ vectors: [5, 0, 0, 0, 5, 0, 0, 0, 5], pbc: [false, false, false] }) };
      neighborFrames.push({ label: 'Coincident PTM neighbors omit degenerate rows', frame: coincident });
      const singleton = { ...coincident, fractional: Float64Array.from([.5, .5, .5]), ids: Uint32Array.from([1]), types: new Uint16Array(1) };
      neighborFrames.push({ label: 'Single open atom has no prepared PTM neighbors', frame: singleton });
      for (const { label, frame } of neighborFrames) {
        const prepared = await run(label, frame, { kind: 'ptmNeighbors' });
        const intact = window.gpuTests.snapshotGpuInputs(frame, { preparedNeighbors: prepared });
        const cpuFit = await window.gpuTests.calculatePtm(frame, { flags: 255 });
        const preparedFit = await window.gpuTests.calculatePtm(frame, { flags: 255, preparedNeighbors: prepared });
        const comparison = window.gpuTests.compareGpuPtm(preparedFit, cpuFit);
        intact(); rows.at(-1).preparedPtmComparison = comparison;
      }
      for (const fixture of await window.gpuTests.idealStrainFixtures()) {
        const validate = result => {
          if (fixture.expectedStructure !== undefined && result.structures) check(result.structures.every(type => type === fixture.expectedStructure), fixture.label + ' PTM structure differs.');
          if (fixture.expectedZeroStrain) for (const field of window.gpuTests.STRAIN_FIELDS) check(result[field].every(value => value === 0), fixture.label + ' requires exact zero ' + field);
          for (const atom of fixture.expectedZeroAtoms ?? []) for (const field of window.gpuTests.STRAIN_FIELDS) check(result[field][atom] === 0, fixture.label + ' zero atom differs: ' + atom + ' / ' + field);
          for (const atom of fixture.expectedNaNAtoms ?? []) for (const field of window.gpuTests.STRAIN_FIELDS) check(Number.isNaN(result[field][atom]), fixture.label + ' undefined atom differs: ' + atom + ' / ' + field);
          for (const [field, expected] of Object.entries(fixture.expectedFields ?? {})) check(result[field].every(value => Math.abs(value - expected) < 2e-6), fixture.label + ' analytic ' + field + ' differs.');
          if (fixture.expectedFieldsByType) for (let atom = 0; atom < fixture.frame.ids.length; atom++) for (const [field, expected] of Object.entries(fixture.expectedFieldsByType[fixture.frame.types[atom]]))
            check(Math.abs(result[field][atom] - expected) < 2e-6, fixture.label + ' per-element ' + field + ' differs.');
          const tinyFields = {};
          for (const [field, expected] of Object.entries(fixture.expectedTinyFields ?? {})) {
            let maxRelativeError = 0;
            for (const value of result[field]) { const error = Math.abs(value - expected) / expected;
              check(value > 0 && error < fixture.tinyRelativeTolerance, fixture.label + ' must preserve tiny physical ' + field + ': ' + value);
              maxRelativeError = Math.max(maxRelativeError, error);
            }
            tinyFields[field] = { expected, maxRelativeError };
          }
          if (fixture.expectedTinyFields) rows.at(-1).tinyIdealStrain = tinyFields;
        };
        const result = await run(fixture.label, fixture.frame, fixture.parameters, null, 2e-6, !fixture.allowGpuFallback);
        validate(result);
        if (fixture.allowGpuFallback) check(result.backend === 'cpu' && new RegExp(fixture.expectedFallbackReason, 'i').test(result.fallbackReason), fixture.label + ' requires an explicit numeric CPU fallback.');
        else check(result.referenceBackend === 'gpu', fixture.label + ' reference conversion must execute on GPU.');
        if (fixture.freshParameters) {
          const freshResult = await run(fixture.label + ' / fresh GPU-neighbor CPU-fit pipeline', fixture.frame, fixture.freshParameters, null, 2e-6);
          validate(freshResult);
          check(freshResult.neighborBackend === 'gpu' && freshResult.ptmBackend === 'cpu' && freshResult.referenceBackend === 'gpu', fixture.label + ' fresh stages must use GPU neighbors, CPU PTM and GPU reference conversion.');
          window.gpuTests.compareGpuPtm(freshResult, fixture.parameters.ptmInput);
        }
      }
      const outside = crystalFrame('fcc', 3, 3.52);
      outside.cell = createCell({ vectors: outside.cell.vectors, pbc: [false, true, true] });
      outside.fractional[0] = -0.1;
      await run('Unsupported open-cell positions CPU fallback', outside, { kind: 'coordination', cutoff: 2.8 }, 'coordination', 0, false);
      check(!isGpu(rows.at(-1)) && rows.at(-1).fallbackReason, 'Unsupported geometry must identify its CPU fallback.');
      const stageFallback = await run('Unsupported GPU nearest geometry retains GPU ideal reference/tensors', outside,
        { kind: 'strain', references, flags: 255, rmsdCutoff: .1 }, null, 2e-6);
      check(stageFallback.neighborBackend === 'cpu' && stageFallback.ptmBackend === 'cpu' && stageFallback.referenceBackend === 'gpu' && stageFallback.tensorBackend === 'gpu' && stageFallback.neighborFallbackReason,
        'Unsupported neighbor geometry must fall back only that stage and report the reason.');

      for (const fixture of window.gpuTests.cnaFixtures()) {
        const result = await run(fixture.label, fixture.frame, fixture.parameters, 'structures');
        if (fixture.expectedStructure !== undefined) check(result.structures.every(value => value === fixture.expectedStructure), fixture.label + ' wrong ideal CNA structure.');
        if (fixture.expectedCenter !== undefined) check(result.structures[0] === fixture.expectedCenter, fixture.label + ' wrong central CNA structure.');
        if (fixture.expectedMinimumRadiusAttempts !== undefined) check(result.gpuRadiusAttempts >= fixture.expectedMinimumRadiusAttempts, fixture.label + ' must expand its adaptive search radius.');
      }
      {
        const { GpuRuntime } = await import('./src/analysis/gpu/runtime.js');
        const { analyzeGpuCna } = await import('./src/analysis/gpu/cna.js');
        const { calculateCna } = await import('./src/analysis/cna.js');
        const runtime = new GpuRuntime();
        try {
          await runtime.initialize();
          const { checkGpuF64 } = await import('./scripts/gpu-f64-check.js');
          window.gpuTests.exactArithmetic = await checkGpuF64(runtime.device);
          for (const fixture of window.gpuTests.cnaDirectFixtures()) {
            const assertInputsIntact = window.gpuTests.snapshotGpuInputs(fixture.frame, fixture.parameters);
            const expected = calculateCna(fixture.frame, fixture.parameters);
            const actual = await runtime.withErrors(() => analyzeGpuCna(runtime, fixture.frame, fixture.parameters));
            assertInputsIntact();
            const maxAbsoluteError = window.gpuTests.compare(actual.structures, expected.structures);
            check(runtime.pipelines.size > 0 && actual.structures[0] === fixture.expectedCenter, fixture.label + ' must execute GPU and retain its central structure.');
            check(actual.gpuCorrectionAtoms === fixture.expectedCorrectionAtoms, fixture.label + ' must report its bounded overflow correction.');
            rows.push({ label: fixture.label, kind: 'cna', atoms: fixture.frame.ids.length,
              analyzedAtoms: actual.structures.length, backend: 'gpu', engine: 'webgpu-cna-adaptive-direct',
              maxAbsoluteError, correctedAtoms: actual.gpuCorrectionAtoms, radiusAttempts: actual.gpuRadiusAttempts,
              directShader: true, fallbackReason: null });
          }
        } finally { runtime.close(); }
      }
      for (const fixture of window.gpuTests.referenceStrainFixtures()) {
        const result = await run(fixture.label, fixture.frame, fixture.parameters, null, 2e-6, !fixture.allowFallback);
        if (fixture.expectedF) for (let k = 0; k < 9; k++) {
          const values = result['referenceF' + (Math.floor(k / 3) + 1) + (k % 3 + 1)];
          for (const value of values) if (Number.isFinite(value)) check(Math.abs(value - fixture.expectedF[k]) < 2e-6, fixture.label + ' affine F component ' + k + ' differs from prescribed deformation.');
        }
        if (fixture.expectedCenterF) for (let k = 0; k < 9; k++) check(Math.abs(result['referenceF' + (Math.floor(k / 3) + 1) + (k % 3 + 1)][0] - fixture.expectedCenterF[k]) < 2e-6,
          fixture.label + ' central deformation component ' + k + ' differs from exact minimum-image fit.');
        for (const atom of fixture.expectedNaNAtoms ?? []) for (const field of window.gpuTests.REFERENCE_STRAIN_FIELDS)
          check(Number.isNaN(result[field][atom]), fixture.label + ' undefined atom ' + atom + ' / ' + field + ' must be NaN.');
        const identityDeformation = fixture.expectedF?.every((value, k) => value === (k % 4 === 0 ? 1 : 0));
        if (fixture.expectedZeroStrain || identityDeformation) for (const field of window.gpuTests.REFERENCE_STRAIN_FIELDS.filter(name => !name.startsWith('referenceF')))
          check(result[field].every(value => value === 0), fixture.label + ' must preserve exact zero strain: ' + field);
        if (identityDeformation) for (let k = 0; k < 9; k++) check(result['referenceF' + (Math.floor(k / 3) + 1) + (k % 3 + 1)].every(value => value === fixture.expectedF[k]),
          fixture.label + ' must preserve exact identity F component ' + k);
        if (fixture.expectedZeroStrain || identityDeformation) rows.at(-1).zeroStrain = true;
        if (identityDeformation) rows.at(-1).identityF = true;
        if (fixture.expectedTinyFields) {
          const measured = {};
          for (const [field, expected] of Object.entries(fixture.expectedTinyFields)) {
            let minimum = Infinity, maximum = -Infinity, maxRelativeError = 0;
            for (const value of result[field]) {
              const relativeError = Math.abs(value - expected) / expected;
              check(value > 0 && Number.isFinite(relativeError) && relativeError < fixture.tinyRelativeTolerance,
                fixture.label + ' must preserve physical ' + field + ': ' + value + ' / expected ' + expected);
              minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
              maxRelativeError = Math.max(maxRelativeError, relativeError);
            }
            measured[field] = { expected, minimum, maximum, maxRelativeError };
          }
          rows.at(-1).tinyStrain = measured;
        }
        if (fixture.allowFallback && !isGpu(result)) check(Boolean(result.fallbackReason), fixture.label + ' unsupported geometry needs an explicit CPU fallback reason.');
      }
      const cspCacheGroups = new Map();
      for (const fixture of window.gpuTests.cspFixtures()) {
        let parameters = fixture.parameters;
        if (fixture.cacheComparisonGroup && parameters.structureInput) {
          const identified = await gpu.analyze(fixture.frame, { kind: 'cna', mode: 'adaptive' });
          check(isGpu(identified), fixture.label + ' cached structure recognition must originate on GPU.');
          parameters = { ...parameters, structureInput: identified.structures };
        }
        const result = await run(fixture.label, fixture.frame, parameters, 'centrosymmetry', 2e-6);
        if (fixture.expectedValue !== undefined) check(result.centrosymmetry.every(value => fixture.expectedValue === 0 ? value === 0 : Math.abs(value - fixture.expectedValue) < 2e-6), fixture.label + ' wrong normalized CSP value.');
        if (fixture.expectedCenterValue !== undefined) check(Math.abs(result.centrosymmetry[0] - fixture.expectedCenterValue) < 2e-6, fixture.label + ' wrong center CSP value.');
        if (fixture.expectedFiniteBaseline) check(result.centrosymmetry.every(value => Number.isFinite(value) && value > 0), fixture.label + ' must preserve the finite HCP baseline.');
        if (fixture.expectedFiniteNormalized) check(result.centrosymmetry.every(value => Number.isFinite(value) && value >= 0 && value <= 1), fixture.label + ' CSP must remain finite and normalized.');
        if (fixture.expectedSomePositive) check(result.centrosymmetry.some(value => value > 0), fixture.label + ' defects must retain nonzero CSP.');
        for (const atom of fixture.expectedNaNAtoms ?? []) check(Number.isNaN(result.centrosymmetry[atom]), fixture.label + ' undefined CSP atom ' + atom + ' must be NaN.');
        if (fixture.expectedIncomplete !== undefined) check(result.incomplete === fixture.expectedIncomplete, fixture.label + ' incomplete count differs.');
        if (fixture.expectedStructure !== undefined) check(result.cspStructureTypes.every(value => value === fixture.expectedStructure), fixture.label + ' local structure differs.');
        if (fixture.expectedNeighborCount !== undefined) check(result.cspNeighborCounts.every(value => value === fixture.expectedNeighborCount), fixture.label + ' local shell selection differs.');
        if (fixture.expectedCenterStructure !== undefined) check(result.cspStructureTypes[0] === fixture.expectedCenterStructure, fixture.label + ' center structure differs.');
        if (fixture.expectedCenterNeighborCount !== undefined) check(result.cspNeighborCounts[0] === fixture.expectedCenterNeighborCount, fixture.label + ' center shell differs.');
        for (const [name, value] of Object.entries(fixture.expectedSummaryEntries ?? {})) check(result.cspSummary[name] === value, fixture.label + ' summary differs for ' + name);
        if (fixture.expectedMinimumInferred !== undefined) check(result.cspSummary.inferred >= fixture.expectedMinimumInferred, fixture.label + ' defect shell inference must occur.');
        for (const { atom, structure, neighbors } of fixture.expectedAtoms ?? []) check(result.cspStructureTypes[atom] === structure && result.cspNeighborCounts[atom] === neighbors, fixture.label + ' mixed-phase atom ' + atom + ' differs.');
        if (fixture.cacheComparisonGroup) {
          const earlier = cspCacheGroups.get(fixture.cacheComparisonGroup);
          if (earlier) window.gpuTests.compareGpuCentrosymmetry(result, earlier, 0);
          else cspCacheGroups.set(fixture.cacheComparisonGroup, result);
          rows.at(-1).classificationInput = parameters.structureInput ? 'cached-gpu-cna' : 'fresh-gpu-cna';
        }
      }
      for (const fixture of window.gpuTests.displacementFixtures()) {
        const prepared = await window.gpuTests.prepareDisplacements(fixture.frame, fixture.reference, fixture.options);
        const result = await run(fixture.label, fixture.frame, { kind: 'displacement', ...prepared }, null, 2e-6);
        window.gpuTests.compare(result.vectors, Float32Array.from(fixture.expectedVectors), 2e-6);
        for (let atom = 0; atom < result.magnitudes.length; atom++) {
          const expected = fixture.expectedMagnitudes[atom], actual = result.magnitudes[atom];
          if (Number.isNaN(expected) && Number.isNaN(actual)) continue;
          check(Number.isFinite(actual) && Math.abs(actual - expected) <= Math.max(2e-6, Math.abs(expected) * 5e-14), fixture.label + ' independent magnitude differs at ' + atom);
        }
        if (fixture.expectedMagnitudeExceedsFloat32) check(result.magnitudes[0] > 3.4028234663852886e38 && Number.isFinite(result.magnitudes[0]), fixture.label + ' Float64 norm must remain finite above Float32 range.');
        window.gpuTests.compare(result.referenceMapping, fixture.expectedMapping);
        if (fixture.expectedCorrectionAtoms !== undefined) check(result.gpuCorrectionAtoms === fixture.expectedCorrectionAtoms, fixture.label + ' sparse corrections differ: ' + result.gpuCorrectionAtoms);
        for (const completed of fixture.expectedProgressAtoms ?? []) check(rows.at(-1).progressAtoms.includes(completed), fixture.label + ' missing GPU batch progress ' + completed);
        check(result.mappingMode === fixture.expectedMappingMode, fixture.label + ' atom correspondence mode differs.');
        if (fixture.expectedVectors.every(value => value === 0)) {
          check(result.vectors.every(value => value === 0) && result.magnitudes.every(value => value === 0), fixture.label + ' matched zero displacement must remain exactly zero.');
          rows.at(-1).zeroDisplacement = true;
        }
        if (fixture.requirePositiveTinyDisplacement) {
          const tinyAtom = fixture.expectedTinyDisplacementAtom ?? 0;
          const expected = fixture.expectedVectors[tinyAtom * 3], actual = result.vectors[tinyAtom * 3];
          const relativeError = Math.abs(actual - expected) / expected;
          check(actual > 0 && result.magnitudes[tinyAtom] > 0 && relativeError < fixture.tinyRelativeTolerance, fixture.label + ' must preserve a genuine tiny Cartesian shift.');
          rows.at(-1).tinyDisplacement = { expected, actual, atom: tinyAtom, magnitude: result.magnitudes[tinyAtom], relativeError };
        }
      }
      const displacementValidation = [];
      for (const fixture of window.gpuTests.displacementValidationFixtures()) {
        const checkInputs = window.gpuTests.snapshotGpuInputs(fixture.frame, { referenceFrame: fixture.reference });
        let errorMessage = null;
        try {
          const prepared = await window.gpuTests.prepareDisplacements(fixture.frame, fixture.reference, fixture.options);
          await gpu.analyze(fixture.frame, { kind: 'displacement', ...prepared });
        } catch (error) { errorMessage = error.message; }
        checkInputs();
        check(errorMessage && new RegExp(fixture.expectedError, 'i').test(errorMessage), fixture.label + ' must reject: ' + errorMessage);
        displacementValidation.push({ label: fixture.label, error: errorMessage, inputsIntact: true });
      }
      window.gpuTests.displacementValidation = displacementValidation;
      const controller = new AbortController();
      let cancelled = false;
      try {
        await gpu.analyze(crystalFrame('fcc', 15, 3.52), { kind: 'coordination', cutoff: 2.8 }, {
          signal: controller.signal,
          onProgress: () => controller.abort(),
        });
      } catch (error) { cancelled = error.name === 'AbortError'; }
      check(cancelled, 'GPU cancellation must reject with AbortError.');
      await run('GPU recovery after cancellation', fcc, { kind: 'coordination', cutoff: 2.8 }, 'coordination');
      const computingController = new AbortController();
      let cancelledDuringComputing = false, observedGpuComputing = false;
      try {
        await gpu.analyze(crystalFrame('fcc', 20, 3.52), { kind: 'coordination', cutoff: 2.8 }, {
          signal: computingController.signal,
          onProgress: (progress) => {
            if (progress.backend === 'gpu' && progress.phase === 'analyzing' && progress.completedAtoms > 0) {
              observedGpuComputing = true;
              computingController.abort();
            }
          },
        });
      } catch (error) { cancelledDuringComputing = error.name === 'AbortError'; }
      check(observedGpuComputing && cancelledDuringComputing, 'An executing GPU job must cancel between batches.');
      await run('GPU recovery after cancelling dispatched work', fcc, { kind: 'coordination', cutoff: 2.8 }, 'coordination');
      const cancellationChecks = [];
      {
        const frame = crystalFrame('fcc', 18, 3.52), matching = new AbortController();
        const assertInputsIntact = window.gpuTests.snapshotGpuInputs(frame, { referenceFrame: frame });
        let observed = false, aborted = false;
        try { await window.gpuTests.prepareDisplacements(frame, frame, { signal: matching.signal, onProgress: progress => {
          if (progress.phase === 'matching') { observed = true; matching.abort(); }
        } }); } catch (error) { aborted = error.name === 'AbortError'; }
        assertInputsIntact();
        check(observed && aborted, 'Displacement ID preparation must cancel with AbortError.');
        cancellationChecks.push({ kind: 'displacement', stage: 'matching', aborted, inputsIntact: true });
      }
      for (const kind of ['cna', 'referenceStrain', 'centrosymmetry', 'displacement']) {
        const cancellationFrame = crystalFrame('fcc', 18, 3.52);
        const cancellationStructures = new Uint8Array(cancellationFrame.ids.length).fill(1);
        const parameters = kind === 'cna' ? { kind, mode: 'adaptive' }
          : kind === 'centrosymmetry' ? { kind, mode: 'auto', structureInput: cancellationStructures }
          : kind === 'displacement' ? { kind, ...await window.gpuTests.prepareDisplacements(cancellationFrame, cancellationFrame) }
          : { kind, cutoff: 2.8, referenceFractional: cancellationFrame.fractional, referenceCell: cancellationFrame.cell,
            referenceMapping: Int32Array.from(cancellationFrame.ids, (_, index) => index) };
        for (const stage of ['preparing', 'dispatched']) {
          const assertInputsIntact = window.gpuTests.snapshotGpuInputs(cancellationFrame, parameters);
          const cancellation = new AbortController();
          const worker = gpu.gpuBackend.worker;
          const pipelines = gpu.gpuCacheStatus.pipelineCount;
          let aborted = false, observedStage = false;
          try {
            await gpu.analyze(cancellationFrame, parameters, {
              signal: cancellation.signal,
              onProgress: progress => {
                if (stage === 'preparing' || (progress.backend === 'gpu' && progress.phase === 'analyzing' && progress.completedAtoms > 0)) {
                  observedStage = true;
                  cancellation.abort();
                }
              },
            });
          } catch (error) { aborted = error.name === 'AbortError'; }
          assertInputsIntact();
          check(observedStage && aborted, kind + ' cancellation must stop at ' + stage + ' with AbortError.');
          const recovery = await run(kind + ' GPU recovery after ' + stage + ' cancellation', fcc,
            kind === 'cna' ? { kind, mode: 'adaptive' }
              : kind === 'centrosymmetry' ? { kind, mode: 'auto', structureInput: new Uint8Array(fcc.ids.length).fill(1) }
              : kind === 'displacement' ? { kind, ...await window.gpuTests.prepareDisplacements(fcc, fcc) }
              : { kind, cutoff: 2.8, referenceFractional: fcc.fractional, referenceCell: fcc.cell,
                referenceMapping: Int32Array.from(fcc.ids, (_, index) => index) }, kind === 'cna' ? 'structures' : null, 2e-6);
          check(gpu.gpuBackend.worker === worker, 'Cancellation must retain the shared GPU worker.');
          check(gpu.gpuCacheStatus.pipelineCount >= pipelines, 'Cancellation must retain compiled pipelines.');
          cancellationChecks.push({ kind, stage, aborted, workerReused: true, pipelineCount: gpu.gpuCacheStatus.pipelineCount,
            engine: recovery.engine, inputsIntact: true });
        }
      }
      {
        const cancellationFrame = crystalFrame('fcc', 17, 3.52);
        const parameters = { kind: 'strain', references: [{ structure: 1, a: 3.52 }], flags: 31, rmsdCutoff: .1 };
        for (const stage of ['ptm-neighbors', 'ptm-fit', 'strain-tensor']) {
          const inputsIntact = window.gpuTests.snapshotGpuInputs(cancellationFrame, parameters);
          const controller = new AbortController(), worker = gpu.gpuBackend.worker;
          let observed = null, aborted = false;
          try {
            await gpu.analyze(cancellationFrame, parameters, { signal: controller.signal, onProgress: progress => {
              const localCompleted = progress.completedAtoms - (stage === 'ptm-fit' ? cancellationFrame.ids.length : stage === 'strain-tensor' ? cancellationFrame.ids.length * 2 : 0);
              if (progress.stage === stage && (stage === 'strain-tensor' ? progress.phase === 'complete' : progress.phase === 'analyzing' && localCompleted > 0)) {
                observed = { backend: progress.backend, phase: progress.phase, completedAtoms: progress.completedAtoms };
                controller.abort();
              }
            } });
          } catch (error) { aborted = error.name === 'AbortError'; }
          inputsIntact();
          check(observed && aborted, 'Fresh ideal strain must cancel after work at stage ' + stage);
          const recovery = await run('Fresh ideal strain recovery after ' + stage + ' cancellation', crystalFrame('fcc', 2, 3.52), parameters, null, 2e-6);
          check(gpu.gpuBackend.worker === worker && recovery.neighborBackend === 'gpu' && recovery.ptmBackend === 'cpu' && recovery.referenceBackend === 'gpu', 'Ideal strain cancellation must preserve its reusable GPU worker and recover all stages.');
          cancellationChecks.push({ kind: 'strain', stage, aborted, observed, workerReused: true, inputsIntact: true });
        }
      }
      window.gpuTests.cancellationChecks = cancellationChecks;
      return rows;
    } finally { cpu.close(); gpu.close(); }
  })()`);
  assert.ok(rows.some((row) => /webgpu/i.test(row.engine ?? '') || row.backend === 'gpu'), 'No real GPU analysis was performed.');
  const preload = await runGpuPreloadChecks({ evaluate });
  const cancellation = await evaluate('window.gpuTests.cancellationChecks');
  const displacementValidation = await evaluate('window.gpuTests.displacementValidation');
  const exactArithmetic = await evaluate('window.gpuTests.exactArithmetic');
  const application = process.argv.includes('--kernels-only') ? null : await runApplicationSmoke({ evaluate, call });
  return { adapter, softwareTiming: adapter.isFallbackAdapter || /swiftshader|software|llvmpipe/i.test(`${adapter.architecture} ${adapter.description}`),
    checks: rows, exactArithmetic, cancellation, displacementValidation, preload, application };
}, { software: useSoftwareAdapter(true) });
console.log(JSON.stringify(report, null, 2));

async function runGpuPreloadChecks({ evaluate }) {
  return evaluate(`(async () => {
    const { AnalysisPool, crystalFrame, check, compare, compareGpuFields, compareGpuCentrosymmetry, compareGpuDisplacements,
      prepareDisplacements, compareGpuPreparedNeighbors, REFERENCE_STRAIN_FIELDS } = window.gpuTests;
    const gpu = new AnalysisPool(), cpu = new AnalysisPool();
    cpu.setGpuEnabled(false); gpu.setGpuEnabled(true);
    try {
      const started = performance.now();
      const warmed = await gpu.warmupGpu();
      const warmupMs = performance.now() - started;
      check(warmed.initialized && warmed.pipelineCount > 0, 'Warmup must create the device and compile pipelines before analysis.');
      const worker = gpu.gpuBackend.worker;
      const frames = Array.from({ length: 4 }, (_, index) => crystalFrame('fcc', 4, 3.52 + index * .5));
      await gpu.configureGpuCache({ frameCount: frames.length, currentIndex: 0 });
      for (const [frameIndex, frame] of frames.entries()) await gpu.prepareGpuFrame(frame, { frameIndex });
      const full = gpu.gpuCacheStatus;
      check(full.fullTrajectory && full.cachedFrameIndexes.length === frames.length, 'A small complete trajectory must reside on GPU.');
      for (const [frameIndex, frame] of frames.entries()) {
        await gpu.configureGpuCache({ currentIndex: frameIndex });
        const actual = await gpu.analyze(frame, { kind: 'coordination', cutoff: 2.8 });
        const expected = await cpu.analyze(frame, { kind: 'coordination', cutoff: 2.8 });
        check(actual.backend === 'gpu' && actual.inputReused && actual.gpuInputReused, 'Preloaded frames must avoid input transfer/upload on analysis.');
        compare(actual.coordination, expected.coordination);
      }
      // A frame reparsed after CPU eviction retains its source index identity.
      const reparsed = crystalFrame('fcc', 4, 4.52);
      gpu.associateGpuFrame(reparsed, 2);
      const reused = await gpu.analyze(reparsed, { kind: 'coordination', cutoff: 2.8 });
      const expected = await cpu.analyze(reparsed, { kind: 'coordination', cutoff: 2.8 });
      check(reused.inputReused && reused.gpuInputReused, 'CPU reparse must reuse its existing GPU frame.');
      compare(reused.coordination, expected.coordination);
      const cna = await gpu.analyze(reparsed, { kind: 'cna', mode: 'adaptive' });
      const cnaExpected = await cpu.analyze(reparsed, { kind: 'cna', mode: 'adaptive' });
      check(cna.backend === 'gpu' && cna.inputReused && cna.gpuInputReused, 'CNA must reuse previously uploaded coordination geometry.');
      compare(cna.structures, cnaExpected.structures);
      const referenceParameters = { kind: 'referenceStrain', cutoff: 2.8,
        referenceFrame: frames[0], referenceFrameIndex: 0, referenceFractional: frames[0].fractional,
        referenceCell: frames[0].cell, referenceMapping: Int32Array.from(reparsed.ids, (_, atom) => atom) };
      const reference = await gpu.analyze(reparsed, referenceParameters, { frameIndex: 2 });
      const referenceExpected = await cpu.analyze(reparsed, referenceParameters);
      check(reference.backend === 'gpu' && reference.inputReused && reference.gpuInputReused, 'Reference strain must reuse preloaded current geometry.');
      compareGpuFields(reference, referenceExpected, REFERENCE_STRAIN_FIELDS, 2e-6);
      const cspParameters = { kind: 'centrosymmetry', mode: 'auto', structureInput: cna.structures };
      const csp = await gpu.analyze(reparsed, cspParameters), cspExpected = await cpu.analyze(reparsed, cspParameters);
      check(csp.backend === 'gpu' && csp.inputReused && csp.gpuInputReused && csp.gpuCnaReused, 'Auto CSP must share preloaded geometry and recognized GPU CNA.');
      compareGpuCentrosymmetry(csp, cspExpected, 2e-6);
      let classifiedAgain = false;
      const cachedAutoCsp = await gpu.analyze(reparsed, { kind: 'centrosymmetry', mode: 'auto' }, { onProgress: progress => { classifiedAgain ||= progress.stage === 'classifying'; } });
      check(cachedAutoCsp.backend === 'gpu' && cachedAutoCsp.gpuCnaReused && !classifiedAgain, 'Auto CSP must consume the runtime adaptive-CNA cache without dispatching classification again.');
      compareGpuCentrosymmetry(cachedAutoCsp, cspExpected, 0);
      const displacementParameters = { kind: 'displacement', ...await prepareDisplacements(reparsed, frames[0]), referenceFrameIndex: 0 };
      const displacement = await gpu.analyze(reparsed, displacementParameters, { frameIndex: 2 });
      const displacementExpected = await cpu.analyze(reparsed, displacementParameters);
      check(displacement.backend === 'gpu' && displacement.inputReused, 'Displacement must reuse the private current source frame.');
      compareGpuDisplacements(displacement, displacementExpected, 2e-6);
      const displacementAgain = await gpu.analyze(reparsed, displacementParameters, { frameIndex: 2 });
      check(displacementAgain.backend === 'gpu' && displacementAgain.gpuInputReused && displacementAgain.referenceInputReused, 'Displacement must reuse current and reference Cartesian uploads.');
      compareGpuDisplacements(displacementAgain, displacementExpected, 2e-6);
      const neighbors = await gpu.analyze(reparsed, { kind: 'ptmNeighbors' });
      compareGpuPreparedNeighbors(neighbors, window.gpuTests.cpuPreparedNeighbors(reparsed));
      check(neighbors.inputReused && neighbors.gpuInputReused, 'GPU PTM nearest preparation must reuse geometry already consumed by coordination/CNA.');
      const fit = await cpu.analyze(frames[0], { kind: 'ptm', flags: 31 });
      const initialParameters = { kind: 'strain', references: [{ structure: 1, a: 3.52 }], ptmInput: fit };
      const firstStrain = await gpu.analyze(frames[0], initialParameters, { frameIndex: 0 });
      check(firstStrain.backend === 'gpu' && !firstStrain.ptmInputReused && !firstStrain.gpuPtmInputReused, 'The first cached fit must be privately transferred and uploaded to GPU.');
      const beforeReferenceEdit = gpu.gpuCacheStatus;
      const editedParameters = { ...initialParameters, references: [{ structure: 1, a: 3.4 }] };
      const editedStrain = await gpu.analyze(frames[0], editedParameters, { frameIndex: 0 });
      const expectedEdited = await cpu.analyze(frames[0], editedParameters);
      compareGpuFields(editedStrain, expectedEdited, window.gpuTests.STRAIN_FIELDS, 2e-6);
      check(editedStrain.ptmInputReused && editedStrain.gpuPtmInputReused && editedStrain.referenceBackend === 'gpu', 'Reference edits must reuse privately cached and GPU-resident raw fits while converting references on GPU.');
      check(gpu.gpuCacheStatus.uploadCount === beforeReferenceEdit.uploadCount, 'Edited lattice constants must not upload geometry or PTM fits again.');
      const hexFrame = crystalFrame('hcp', 2, 2.5), hexFit = await cpu.analyze(hexFrame, { kind: 'ptm', flags: 255 });
      const hexParameters = { kind: 'strain', ptmInput: hexFit, references: [{ structure: 2, a: 2.5, c: Math.sqrt(8 / 3) * 2.5 }] };
      await gpu.analyze(hexFrame, hexParameters);
      const hexUploads = gpu.gpuCacheStatus.uploadCount;
      const editedHexParameters = { ...hexParameters, references: [{ structure: 2, a: 2.45, c: Math.sqrt(8 / 3) * 2.6 }] };
      const editedHex = await gpu.analyze(hexFrame, editedHexParameters), expectedHex = await cpu.analyze(hexFrame, editedHexParameters);
      compareGpuFields(editedHex, expectedHex, window.gpuTests.STRAIN_FIELDS, 2e-6);
      check(editedHex.ptmInputReused && editedHex.gpuPtmInputReused && gpu.gpuCacheStatus.uploadCount === hexUploads, 'Hexagonal a/c edits must reuse immutable resident raw fits.');
      check(gpu.gpuBackend.worker === worker, 'Different GPU algorithms must share the warmed GPU worker.');
      const beforeClear = gpu.gpuCacheStatus;
      await gpu.clearGpuFrames();
      const cleared = gpu.gpuCacheStatus;
      check(gpu.gpuBackend.worker === worker && cleared.initialized && cleared.pipelineCount === beforeClear.pipelineCount,
        'Source clear must preserve the device and compiled pipelines.');
      check(cleared.cachedFrameIndexes.length === 0 && cleared.residentBytes === 0, 'Source clear must release all resident frame buffers.');
      await gpu.configureGpuCache({ frameCount: 4, currentIndex: 2 });
      await gpu.prepareGpuFrame(frames[2], { frameIndex: 2 });
      const single = gpu.gpuCacheStatus;
      const constrained = await gpu.configureGpuCache({ budgetBytes: single.workspaceBytes + single.frameBytes * 2 + 16, currentIndex: 2 });
      check(constrained.capacity === 2 && !constrained.fullTrajectory, 'A constrained budget must select a bounded frame window.');
      await gpu.prepareGpuFrame(frames[1], { frameIndex: 1 });
      await gpu.prepareGpuFrame(frames[3], { frameIndex: 3 });
      const windowCache = gpu.gpuCacheStatus;
      check(windowCache.cachedFrameIndexes.length <= 2 && windowCache.cachedFrameIndexes.includes(2), 'Bounded cache must retain current frame and respect its capacity.');
      check(windowCache.cachedFrameIndexes.every(index => Math.abs(index - 2) <= 1), 'Bounded cache must retain neighboring frames.');
      const after = await gpu.analyze(frames[2], { kind: 'coordination', cutoff: 2.8 });
      check(after.backend === 'gpu' && after.gpuInputReused, 'Cache eviction must keep the current frame usable for GPU analysis.');
      compare(after.coordination, expected.coordination);
      return { warmupMs, pipelineCount: warmed.pipelineCount, fullTrajectoryFrames: full.cachedFrameIndexes.length,
        constrainedCapacity: windowCache.capacity, constrainedFrames: windowCache.cachedFrameIndexes, reparseReused: reused.gpuInputReused,
        sourceClearPreservedDevice: true, crossAlgorithmWorkerReuse: true,
        ptmNeighborsInputReused: neighbors.inputReused && neighbors.gpuInputReused,
        firstPtmInputReused: firstStrain.ptmInputReused, firstGpuPtmInputReused: firstStrain.gpuPtmInputReused,
        editedPtmInputReused: editedStrain.ptmInputReused, editedGpuPtmInputReused: editedStrain.gpuPtmInputReused,
        latticeEditUploadCountUnchanged: true, hexagonalAcFitReused: editedHex.ptmInputReused && editedHex.gpuPtmInputReused,
        cnaInputReused: cna.inputReused && cna.gpuInputReused,
        referenceInputReused: reference.inputReused && reference.gpuInputReused,
        referenceGpuInputReused: reference.referenceGpuInputReused ?? null,
        cspInputReused: csp.inputReused && csp.gpuInputReused, cspCnaReused: csp.gpuCnaReused, runtimeCnaReusedWithoutReclassification: !classifiedAgain && cachedAutoCsp.gpuCnaReused,
        displacementInputReused: displacementAgain.inputReused && displacementAgain.gpuInputReused,
        displacementReferenceInputReused: displacementAgain.referenceInputReused && displacementAgain.gpuInputReused };
    } finally { gpu.close(); cpu.close(); }
  })()`);
}

async function runApplicationSmoke({ evaluate, call }) {
  async function waitFor(expression, label) {
    for (let attempt = 0; attempt < 2_400; attempt += 1) {
      if (await evaluate(expression)) return;
      await delay(25);
    }
    const diagnostics = await evaluate(`({ toast: document.getElementById('toast')?.textContent,
      cna: document.getElementById('cna-state')?.textContent, cnaMetric: document.getElementById('metric-cna')?.textContent,
      cnaStatus: document.getElementById('cna-status')?.textContent, reference: document.getElementById('reference-strain-state')?.textContent,
      referenceStatus: document.getElementById('reference-strain-status')?.textContent,
      gpu: document.getElementById('enable-gpu-computing')?.getAttribute('aria-pressed'), csp: document.getElementById('csp-state')?.textContent, cspMetric: document.getElementById('metric-csp')?.textContent, cspDisabled: document.getElementById('run-csp')?.disabled, loading: document.getElementById('loading-text')?.textContent, cache: document.getElementById('cache-label')?.textContent, rows: window.applicationGpuChecks?.rows.slice(-4) })`);
    throw new Error(`Timed out: ${label}; ${JSON.stringify(diagnostics)}`);
  }
  await evaluate('location.href = new URL("./index.html", location.href).href');
  await waitFor('document.readyState === "complete" && document.getElementById("enable-gpu-computing") && document.getElementById("open-examples")', 'homepage');
  assert.equal(await evaluate('document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")'), 'true', 'GPU computation is enabled by default in the application.');
  await evaluate(`document.getElementById('open-examples').click()`);
  await waitFor(`document.getElementById('source-dialog').open && [...document.querySelectorAll('#source-options .source-option')].some(button => !button.disabled && button.textContent.includes('fcc-vacancy.cfg'))`, 'example catalog');
  await evaluate(`[...document.querySelectorAll('#source-options .source-option')].find(button => !button.disabled && button.textContent.includes('fcc-vacancy.cfg')).click()`);
  await waitFor('document.getElementById("file-name").textContent === "fcc-vacancy.cfg" && document.getElementById("loading").hidden && !document.getElementById("run-analysis").disabled', 'FCC vacancy example');
  await evaluate(`(async () => {
    const { AnalysisPool } = await import('./src/analysis/analysis-pool.js');
    const { calculateCna } = await import('./src/analysis/cna.js');
    const { calculateCentrosymmetry } = await import('./src/analysis/centrosymmetry.js');
    const { calculatePreparedDisplacements } = await import('./src/analysis/displacement.js');
    const { WebGLRenderer } = await import('./src/render/webgl-renderer.js');
    const { calculateReferenceStrain, REFERENCE_STRAIN_FIELDS } = await import('./src/analysis/reference-strain.js');
    const { calculateAtomicStrain, STRAIN_FIELDS } = await import('./src/analysis/atomic-strain.js');
    const { compareGpuArrays, compareGpuFields, compareGpuCentrosymmetry, compareGpuDisplacements, snapshotGpuInputs } = await import('./scripts/gpu-comparison.js');
    const analyze = AnalysisPool.prototype.analyze, setVectors = WebGLRenderer.prototype.setVectors;
    window.applicationGpuChecks = { rows: [], adaptive: null, arrows: null };
    window.restoreApplicationGpuHooks = () => { AnalysisPool.prototype.analyze = analyze; WebGLRenderer.prototype.setVectors = setVectors; };
    WebGLRenderer.prototype.setVectors = function(vectors, options) {
      const result = setVectors.call(this, vectors, options);
      if (this.canvas.id === 'viewport') window.applicationGpuChecks.arrows = vectors ? { type: vectors.constructor.name, components: vectors.length,
        primitives: this.primitiveLayer?.vectorInstances?.length ?? null, glError: this.gl.getError() } : null;
      return result;
    };
    AnalysisPool.prototype.analyze = async function(frame, parameters, options) {
      const checkInputs = snapshotGpuInputs(frame, parameters);
      const result = await analyze.call(this, frame, parameters, options);
      checkInputs();
      if (parameters.kind === 'cna') {
        const comparison = compareGpuArrays(result.structures, calculateCna(frame, parameters).structures);
        window.applicationGpuChecks.rows.push({ kind: 'cna', mode: parameters.mode, gpu: result.backend === 'gpu',
          atoms: frame.ids.length, engine: result.engine, maxAbsoluteError: comparison.maxAbsoluteError,
          counts: Array.from({ length: 5 }, (_, type) => result.structures.reduce((sum, value) => sum + Number(value === type), 0)) });
        if (parameters.mode === 'adaptive') window.applicationGpuChecks.adaptive = { frame, structures: result.structures, backend: result.backend };
      } else if (parameters.kind === 'referenceStrain') {
        const comparison = compareGpuFields(result, calculateReferenceStrain(frame, parameters), REFERENCE_STRAIN_FIELDS, 2e-6);
        window.applicationGpuChecks.rows.push({ kind: 'referenceStrain', gpu: result.backend === 'gpu', engine: result.engine,
          atoms: frame.ids.length, maxAbsoluteError: comparison.maxAbsoluteError,
          inputReused: result.inputReused, gpuInputReused: result.gpuInputReused,
          referenceInputReused: result.referenceInputReused, referenceGpuInputReused: result.referenceGpuInputReused });
      } else if (parameters.kind === 'strain') {
        const expected = await calculateAtomicStrain(frame, { ...parameters, ptmInput: parameters.ptmInput ?? result });
        const comparison = compareGpuFields(result, { ...expected, warning: null }, STRAIN_FIELDS, 2e-6);
        window.applicationGpuChecks.rows.push({ kind: 'strain', gpu: result.backend === 'gpu', engine: result.engine,
          maxAbsoluteError: comparison.maxAbsoluteError, freshFit: !parameters.ptmInput,
          neighborBackend: result.neighborBackend ?? null, ptmBackend: result.ptmBackend ?? null,
          referenceBackend: result.referenceBackend ?? null, tensorBackend: result.tensorBackend ?? null,
          ptmInputReused: result.ptmInputReused ?? null, gpuPtmInputReused: result.gpuPtmInputReused ?? null });
      } else if (parameters.kind === 'centrosymmetry') {
        const adaptive = window.applicationGpuChecks.adaptive;
        const comparison = compareGpuCentrosymmetry(result, calculateCentrosymmetry(frame, parameters), 2e-6);
        window.applicationGpuChecks.rows.push({ kind: parameters.mode === 'auto' ? 'autoCentrosymmetry' : 'centrosymmetry', mode: parameters.mode,
          neighbors: parameters.neighbors, gpu: result.backend === 'gpu', engine: result.engine, cspSummary: result.cspSummary ?? null,
          maxAbsoluteError: comparison.maxAbsoluteError,
          reusedGpuCna: adaptive?.frame === frame && adaptive.backend === 'gpu' && adaptive.structures === parameters.structureInput });
      } else if (parameters.kind === 'displacement') {
        const comparison = compareGpuDisplacements(result, calculatePreparedDisplacements(frame, parameters), 2e-6);
        window.applicationGpuChecks.rows.push({ kind: 'displacement', gpu: result.backend === 'gpu', engine: result.engine,
          matched: result.matched, unmatched: result.unmatched, vectorsType: result.vectors.constructor.name,
          magnitudesType: result.magnitudes.constructor.name, maxAbsoluteError: comparison.maxAbsoluteError,
          inputReused: result.inputReused, gpuInputReused: result.gpuInputReused });
      }
      return result;
    };
  })()`);
  const cases = [
    { tool: 'centrosymmetry', cspChoice: '8', button: 'run-csp', state: 'csp-state', status: 'metric-csp', color: 'property:centralSymmetry' },
    { tool: 'centrosymmetry', cspChoice: '12', button: 'run-csp', state: 'csp-state', status: 'metric-csp', color: 'property:centralSymmetry' },
    { tool: 'coordination', button: 'run-analysis', state: 'analysis-state', status: 'metric-analysis', cutoff: 'cutoff', value: 3.1, color: 'property:coordination' },
    { tool: 'localShear', button: 'run-local-shear', state: 'local-shear-state', status: 'local-shear-status', cutoff: 'local-shear-cutoff', value: 3.1, color: 'property:localShear' },
    { tool: 'statistics', button: 'run-rdf', state: 'rdf-state', status: 'rdf-status', cutoff: 'rdf-cutoff', value: 3.9 },
    { tool: 'cna', mode: 'fixed', button: 'run-cna', state: 'cna-state', status: 'metric-cna', cutoff: 'cna-cutoff', value: 3.1, color: 'property:structureType' },
    { tool: 'cna', mode: 'adaptive', button: 'run-cna', state: 'cna-state', status: 'metric-cna', color: 'property:structureType' },
  ];
  const results = [];
  for (const test of cases) {
    await evaluate(`(() => {
      const button = document.querySelector('[data-tool-button="${test.tool}"]');
      if (button.getAttribute('aria-expanded') !== 'true') button.click();
      ${test.cspChoice ? `document.getElementById('csp-neighbors').value = '${test.cspChoice}'; document.getElementById('csp-neighbors').dispatchEvent(new Event('change'));` : ''}
      ${test.cutoff ? `document.getElementById('${test.cutoff}').value = '${test.value}';` : ''}
      ${test.mode ? `document.getElementById('cna-mode').value = '${test.mode}'; document.getElementById('cna-mode').dispatchEvent(new Event('change'));` : ''}
    })()`);
    await waitFor(`!document.getElementById('${test.button}').disabled`, `${test.tool} parameter update completed`);
    for (const enabled of [true, false]) {
      const before = await evaluate('window.applicationGpuChecks.rows.length');
      await evaluate(`(() => {
        const toggle = document.getElementById('enable-gpu-computing');
        if (toggle.getAttribute('aria-pressed') !== '${enabled}') toggle.click();
        })()`);
      await waitFor(`!document.getElementById('${test.button}').disabled`, `${test.tool} GPU preference update completed`);
      await evaluate(`document.getElementById('${test.button}').click()`);
      const engine = enabled ? 'webgpu' : 'js-worker';
      await waitFor(`document.getElementById('${test.state}').textContent === 'Calculated' && document.getElementById('${test.status}').textContent.includes('${engine}')`, `${test.tool} ${engine}`);
      if (test.mode) await waitFor(`window.applicationGpuChecks.rows.slice(${before}).some(row => row.kind === 'cna' && row.mode === '${test.mode}' && row.gpu === ${enabled})`, `${test.mode} CNA reruns for GPU preference`);
      const result = await evaluate(`({ tool: '${test.tool}', enabled: ${enabled},
        ${test.mode ? `mode: '${test.mode}', counts: window.applicationGpuChecks.rows.filter(row => row.kind === 'cna' && row.mode === '${test.mode}' && row.gpu === ${enabled}).at(-1).counts,` : ''}
        status: document.getElementById('${test.status}').textContent,
        legend: document.getElementById('legend-color-mode')?.value })`);
      if (test.color) assert.equal(result.legend, test.color, `${test.tool} analysis updates the rendered color legend.`);
      results.push(result);
    }
    if (test.mode) assert.deepEqual(results.at(-1).counts, results.at(-2).counts, `${test.mode} CNA keeps legend structure counts across GPU preferences.`);
  }
  assert.match(await evaluate('document.getElementById("enable-gpu-computing").textContent'), /GPU acceleration/);
  await evaluate(`(() => {
    const toggle = document.getElementById('enable-gpu-computing'); if (toggle.getAttribute('aria-pressed') !== 'true') toggle.click();
    const button = document.querySelector('[data-tool-button="strain"]'); if (button.getAttribute('aria-expanded') !== 'true') button.click();
    document.getElementById('run-strain').click();
  })()`);
  await waitFor(`document.getElementById('strain-state').textContent === 'Calculated' && window.applicationGpuChecks.rows.some(row => row.kind === 'strain' && row.freshFit && row.gpu)`, 'fresh ideal strain GPU neighbor/reference/tensor routing');
  const idealRouting = [await evaluate('window.applicationGpuChecks.rows.filter(row => row.kind === "strain").at(-1)')];
  assert.equal(idealRouting[0].neighborBackend, 'gpu'); assert.equal(idealRouting[0].ptmBackend, 'cpu');
  assert.equal(idealRouting[0].referenceBackend, 'gpu'); assert.equal(idealRouting[0].tensorBackend, 'gpu');
  assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'property:atomicShearStrain');
  let beforeIdeal = await evaluate('window.applicationGpuChecks.rows.length');
  await evaluate(`const input = document.querySelector('[data-lattice-a="0"]'); input.value = '3.4'; input.dispatchEvent(new Event('change'));`);
  await waitFor(`document.getElementById('strain-state').textContent === 'Calculated' && window.applicationGpuChecks.rows.slice(${beforeIdeal}).some(row => row.kind === 'strain' && row.gpu)`, 'native editable reference GPU fit reuse');
  const editedIdeal = await evaluate('window.applicationGpuChecks.rows.filter(row => row.kind === "strain").at(-1)');
  assert.equal(editedIdeal.freshFit, false); assert.equal(editedIdeal.ptmInputReused, true); assert.equal(editedIdeal.gpuPtmInputReused, true);
  idealRouting.push(editedIdeal);
  for (const enabled of [false, true]) {
    beforeIdeal = await evaluate('window.applicationGpuChecks.rows.length');
    await evaluate(`document.getElementById('enable-gpu-computing').click();`);
    await waitFor(`!document.getElementById('run-strain').disabled`, 'ideal strain GPU preference readiness');
    await evaluate(`document.getElementById('run-strain').click();`);
    await waitFor(`document.getElementById('strain-state').textContent === 'Calculated' && window.applicationGpuChecks.rows.slice(${beforeIdeal}).some(row => row.kind === 'strain' && row.gpu === ${enabled})`, 'ideal strain preference ' + enabled);
    idealRouting.push(await evaluate('window.applicationGpuChecks.rows.filter(row => row.kind === "strain").at(-1)'));
    assert.equal(idealRouting.at(-1).freshFit, false, 'GPU preference edits retain scientific PTM fits.');
  }
  await evaluate(`document.getElementById('cancel-strain').click();`);
  assert.equal(await evaluate('document.getElementById("strain-state").textContent'), 'Not calculated');
  results.push({ idealRouting, acceptedIdealResultsCleared: true });
  // The following CNA scenario begins from CPU preference as the preceding cases did.
  await evaluate(`document.getElementById('enable-gpu-computing').click();`);
  await evaluate(`document.getElementById('enable-gpu-computing').click(); document.getElementById('run-cna').click();`);
  await waitFor(`document.getElementById('cna-state').textContent === 'Calculated' && document.getElementById('metric-cna').textContent.includes('webgpu')`, 'adaptive GPU CNA prerequisite');
  await evaluate(`(() => {
    const button = document.querySelector('[data-tool-button="centrosymmetry"]');
    if (button.getAttribute('aria-expanded') !== 'true') button.click();
    document.getElementById('csp-neighbors').value = 'auto';
    document.getElementById('run-csp').click();
  })()`);
  await waitFor(`document.getElementById('csp-state').textContent === 'Calculated' && window.applicationGpuChecks.rows.some(row => row.kind === 'autoCentrosymmetry' && row.reusedGpuCna)`, 'Auto central symmetry reuses recognized GPU CNA');
  const autoCentrosymmetry = await evaluate('window.applicationGpuChecks.rows.find(row => row.kind === "autoCentrosymmetry" && row.reusedGpuCna)');
  assert.equal(autoCentrosymmetry.gpu, true, 'Auto central symmetry pairs neighbors on GPU.');
  assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'property:centralSymmetry');
  results.push(autoCentrosymmetry);
  const autoRouting = [];
  for (const enabled of [false, true]) {
    const before = await evaluate('window.applicationGpuChecks.rows.length');
    await evaluate(`document.getElementById('enable-gpu-computing').click();`);
    await waitFor(`!document.getElementById('run-csp').disabled`, 'Auto CSP GPU preference readiness');
    await evaluate(`document.getElementById('run-csp').click()`);
    await waitFor(`document.getElementById('csp-state').textContent === 'Calculated' && window.applicationGpuChecks.rows.slice(${before}).some(row => row.kind === 'autoCentrosymmetry' && row.gpu === ${enabled})`, 'Auto CSP GPU preference ' + enabled);
    autoRouting.push(await evaluate('window.applicationGpuChecks.rows.filter(row => row.kind === "autoCentrosymmetry").at(-1)'));
  }
  assert.deepEqual(autoRouting[0].cspSummary, autoRouting[1].cspSummary);
  await evaluate(`document.getElementById('cancel-csp').click();`);
  assert.equal(await evaluate('document.getElementById("csp-state").textContent'), 'Not calculated', 'Cancel clears accepted CSP results.');
  results.push({ autoRouting, acceptedCspResultsCleared: true });
  async function loadTrajectory(count, name) {
    await evaluate(`(async () => {
      const { crystalFrame } = await import('./tests/helpers/crystals.js');
      const texts = Array.from({ length: ${count} }, (_, index) => {
        const frame = crystalFrame('fcc', 2, 3.52 + index * .02);
        const rows = [];
        for (let atom = 0; atom < frame.ids.length; atom++) rows.push('Ni ' + frame.ids[atom] + ' ' + [...frame.positions.subarray(atom * 3, atom * 3 + 3)].join(' '));
        return frame.ids.length + '\\nStep=' + index + ' Lattice="' + [...frame.cell.vectors].join(' ') + '" Properties=species:S:1:id:I:1:pos:R:3 pbc="T T T"\\n' + rows.join('\\n') + '\\n';
      });
      const transfer = new DataTransfer();
      transfer.items.add(new File([texts.join('')], ${JSON.stringify(name)}, { type: 'text/plain' }));
      const input = document.getElementById('file-input');
      input.files = transfer.files; input.dispatchEvent(new Event('change'));
    })()`);
    await waitFor(`document.getElementById('file-name').textContent === ${JSON.stringify(name)} && document.getElementById('loading').hidden`, name);
    await waitFor(`document.getElementById('cache-label').dataset.gpuCacheState === 'ready' && Number(document.getElementById('cache-label').dataset.gpuCachedFrames) === ${count}`, name + ' complete GPU preload');
  }
  await evaluate(`document.getElementById('close-file').click();`);
  await loadTrajectory(6, 'gpu-preload.xyz');
  assert.equal(await evaluate('document.getElementById("analysis-state").textContent'), 'Not calculated', 'Preloading must not calculate analysis results.');
  await evaluate(`const slider = document.getElementById('frame-slider'); slider.value = '5'; slider.dispatchEvent(new Event('input'));`);
  await waitFor(`document.getElementById('frame-label').textContent === '6 / 6' && document.getElementById('timestep-label').textContent.includes('5') && document.getElementById('cache-label').dataset.gpuCacheState === 'ready'`, 'rendered preloaded last frame');
  const trajectoryPreload = await evaluate(`({ cachedFrames: Number(document.getElementById('cache-label').dataset.gpuCachedFrames),
    capacity: Number(document.getElementById('cache-label').dataset.gpuCacheCapacity), label: document.getElementById('cache-label').textContent })`);
  const referenceRouting = [];
  await evaluate(`(() => {
    const button = document.querySelector('[data-tool-button="referenceStrain"]');
    if (button.getAttribute('aria-expanded') !== 'true') button.click();
    document.getElementById('reference-frame').value = '1';
    document.getElementById('reference-cutoff').value = '3.1';
  })()`);
  for (const enabled of [true, false, true]) {
    const before = await evaluate('window.applicationGpuChecks.rows.length');
    await evaluate(`(() => {
      const toggle = document.getElementById('enable-gpu-computing');
      if (toggle.getAttribute('aria-pressed') !== '${enabled}') toggle.click();
    })()`);
    if (enabled) await waitFor(`document.getElementById('cache-label').dataset.gpuCacheState === 'ready' && document.getElementById('cache-label').dataset.gpuCachedFrames === '6'`, 'reference trajectory GPU preload');
    await evaluate(`document.getElementById('run-reference-strain').click();`);
    await waitFor(`document.getElementById('reference-strain-state').textContent === 'Calculated' && window.applicationGpuChecks.rows.slice(${before}).some(row => row.kind === 'referenceStrain' && row.gpu === ${enabled})`, 'reference strain GPU preference ' + enabled);
    const result = await evaluate('window.applicationGpuChecks.rows.filter(row => row.kind === "referenceStrain").at(-1)');
    const legendChoice = await evaluate(`({ value: document.getElementById('legend-color-mode').value,
      options: [...document.getElementById('legend-color-mode').options].map(option => option.value),
      state: document.getElementById('reference-strain-state').textContent,
      status: document.getElementById('reference-strain-status').textContent })`);
    assert.equal(legendChoice.value, 'property:referenceShearStrain', JSON.stringify({ enabled, result, legendChoice }));
    referenceRouting.push(result);
  }
  const displacementRouting = [];
  await evaluate(`(() => {
    const button = document.querySelector('[data-tool-button="displacement"]');
    if (button.getAttribute('aria-expanded') !== 'true') button.click();
    document.getElementById('displacement-reference-frame').value = '1';
  })()`);
  for (const enabled of [true, false, true]) {
    const before = await evaluate('window.applicationGpuChecks.rows.length');
    await evaluate(`(() => {
      const toggle = document.getElementById('enable-gpu-computing');
      if (toggle.getAttribute('aria-pressed') !== '${enabled}') toggle.click();
    })()`);
    await waitFor(`!document.getElementById('run-displacement').disabled`, 'Displacement GPU preference readiness');
    await evaluate(`document.getElementById('run-displacement').click()`);
    await waitFor(`document.getElementById('displacement-state').textContent === 'Calculated' && window.applicationGpuChecks.rows.slice(${before}).some(row => row.kind === 'displacement' && row.gpu === ${enabled})`, 'Displacement GPU preference ' + enabled);
    const result = await evaluate('window.applicationGpuChecks.rows.filter(row => row.kind === "displacement").at(-1)');
    assert.equal(await evaluate('document.getElementById("legend-color-mode").value'), 'property:displacementMagnitude');
    displacementRouting.push(result);
  }
  await evaluate(`(() => {
    const button = document.querySelector('[data-tool-button="vectors"]');
    if (button.getAttribute('aria-expanded') !== 'true') button.click();
    const mode = document.getElementById('vector-mode'); mode.value = 'displacement'; mode.dispatchEvent(new Event('change'));
    const arrows = document.getElementById('show-vectors'); arrows.checked = true; arrows.dispatchEvent(new Event('change'));
  })()`);
  await waitFor(`window.applicationGpuChecks.arrows?.type === 'Float32Array'`, 'Displacement Float32 arrow readback');
  const displacementArrows = await evaluate('window.applicationGpuChecks.arrows');
  assert.equal(displacementArrows.glError, 0, 'GPU displacement vectors upload to WebGL without errors.');
  assert.equal(displacementArrows.components, 32 * 3);
  await evaluate(`(() => {
    const button = document.querySelector('[data-tool-button="centrosymmetry"]');
    if (button.getAttribute('aria-expanded') !== 'true') button.click();
    document.getElementById('csp-neighbors').value = 'auto'; document.getElementById('run-csp').click();
  })()`);
  await waitFor(`document.getElementById('csp-state').textContent === 'Calculated'`, 'GPU CSP prerequisite for recipe replay');
  const gpuRecipe = await evaluate(`(async () => {
    const createUrl = URL.createObjectURL, anchorClick = HTMLAnchorElement.prototype.click;
    let saved;
    URL.createObjectURL = function(blob) { saved = blob; return createUrl.call(this, blob); };
    HTMLAnchorElement.prototype.click = () => {};
    try {
      document.getElementById('export-configuration').click();
      if (!saved) throw new Error('GPU recipe export did not create a Blob.');
      window.gpuReplayRecipe = await saved.text(); return JSON.parse(window.gpuReplayRecipe);
    } finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = anchorClick; }
  })()`);
  assert.equal(gpuRecipe.settings.compute.gpuEnabled, true);
  assert.equal(gpuRecipe.settings.analyses.centrosymmetry.enabled, true);
  assert.equal(gpuRecipe.settings.extensions.displacement.enabled, true);
  const replayBefore = await evaluate('window.applicationGpuChecks.rows.length');
  await evaluate(`document.getElementById('cancel-csp').click(); document.getElementById('cancel-displacement').click();`);
  await evaluate(`(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File([window.gpuReplayRecipe], 'gpu-analysis-recipe.json', { type: 'application/json' }));
    const input = document.getElementById('configuration-file'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
  })()`);
  await waitFor(`document.getElementById('configuration-status').textContent.includes('restored') && document.getElementById('csp-state').textContent === 'Calculated' && document.getElementById('displacement-state').textContent === 'Calculated'`, 'GPU CSP and displacement recipe replay');
  const replayRows = await evaluate(`window.applicationGpuChecks.rows.slice(${replayBefore})`);
  assert.ok(replayRows.some(row => row.kind === 'autoCentrosymmetry' && row.gpu));
  assert.ok(replayRows.some(row => row.kind === 'displacement' && row.gpu));
  assert.equal(await evaluate('document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")'), 'true');
  await waitFor(`window.applicationGpuChecks.arrows?.type === 'Float32Array'`, 'Recipe restores GPU displacement arrows');
  await evaluate(`document.getElementById('cancel-csp').click();`);
  await evaluate(`document.getElementById('cancel-displacement').click();`);
  assert.equal(await evaluate('document.getElementById("displacement-state").textContent'), 'Not calculated', 'Cancel clears accepted displacement results.');
  assert.equal(await evaluate('window.applicationGpuChecks.arrows'), null, 'Cancel clears dependent vector arrows.');
  results.push({ displacementRouting, displacementArrows, gpuRecipeReplayed: true, replayRows, acceptedDisplacementResultsCleared: true });
  await evaluate(`document.getElementById('cancel-reference-strain').click();`);
  assert.equal(await evaluate('document.getElementById("reference-strain-state").textContent'), 'Not calculated', 'Cancel clears accepted reference-strain results.');
  await call('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: false });
  const mobileTrajectory = await evaluate(`(() => {
    const bar = document.getElementById('trajectory-section');
    return { width: bar.clientWidth, contentWidth: bar.scrollWidth };
  })()`);
  assert.ok(mobileTrajectory.contentWidth <= mobileTrajectory.width + 1, 'GPU residency labels must fit the mobile trajectory controls.');
  await call('Emulation.clearDeviceMetricsOverride');
  const physicalReplication = await runPhysicalReplicationGpuChecks({ evaluate, waitFor });
  await loadTrajectory(3, 'gpu-replacement.xyz');
  await evaluate(`(() => {
    const toggle = document.getElementById('enable-gpu-computing');
    toggle.click(); toggle.click(); toggle.click(); toggle.click();
  })()`);
  await loadTrajectory(2, 'gpu-final-source.xyz');
  await evaluate(`document.getElementById('enable-gpu-computing').click();`);
  await waitFor(`document.getElementById('cache-label').dataset.gpuCacheState === 'off' && document.getElementById('cache-label').dataset.gpuCachedFrames === '0'`, 'GPU cache cleared on disable');
  results.push({ trajectoryPreload, referenceRouting, acceptedReferenceResultsCleared: true, physicalReplication,
    sourceReplacementFrames: 3, rapidToggleSourceFrames: 2, disableReleasedFrames: true });
  await evaluate('window.restoreApplicationGpuHooks()');
  return results;
}

async function runPhysicalReplicationGpuChecks({ evaluate, waitFor }) {
  await evaluate(`(async () => {
    const { AnalysisPool } = await import('./src/analysis/analysis-pool.js');
    const { WebGLRenderer } = await import('./src/render/webgl-renderer.js');
    const { calculateCoordination } = await import('./src/analysis/coordination.js');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    window.physicalGpuChecks = { rows: [], pool: null, renderer: null };
    const analyze = AnalysisPool.prototype.analyze, render = WebGLRenderer.prototype.requestRender;
    window.restorePhysicalGpuHooks = () => { AnalysisPool.prototype.analyze = analyze; WebGLRenderer.prototype.requestRender = render; };
    AnalysisPool.prototype.analyze = async function(frame, parameters, options) {
      window.physicalGpuChecks.pool = this;
      const result = await analyze.call(this, frame, parameters, options);
      if (parameters.kind === 'coordination') {
        const expected = calculateCoordination(frame, parameters.cutoff);
        check(result.backend === 'gpu', 'Physical replication coordination must execute on GPU.');
        check(result.coordination.length === expected.coordination.length, 'GPU reused a frame with the wrong atom count.');
        check(result.coordination.every((value, atom) => value === expected.coordination[atom]), 'Physical replication GPU/CPU coordination differs.');
        window.physicalGpuChecks.rows.push({ atoms: frame.ids.length, cellA: Math.hypot(...frame.cell.vectors.subarray(0, 3)),
          engine: result.engine, cacheGeneration: this.gpuBackend.generation, cacheFrameBytes: this.gpuCacheStatus.frameBytes,
          outputAtoms: result.coordination.length });
      }
      return result;
    };
    WebGLRenderer.prototype.requestRender = function(...args) {
      if (this.canvas.id === 'viewport') window.physicalGpuChecks.renderer = this;
      return render.apply(this, args);
    };
    document.getElementById('cutoff').value = '3.1';
    document.getElementById('run-analysis').click();
  })()`);
  try {
    await waitFor(`window.physicalGpuChecks.rows.length === 1 && document.getElementById('analysis-state').textContent === 'Calculated'`, 'raw geometry GPU analysis');
    const raw = await evaluate('window.physicalGpuChecks.rows[0]');
    assert.equal(raw.atoms, 32);
    await evaluate(`(() => {
      document.querySelector('[data-tool-button="replicate"]').click();
      document.getElementById('replicate-a').value = '2';
      document.getElementById('apply-replicate').click();
    })()`);
    await waitFor(`window.physicalGpuChecks.renderer?.displayAtomCount === 64 && document.getElementById('atom-count').textContent === '32'`, 'display-only replication');
    await evaluate(`document.getElementById('run-analysis').click();`);
    assert.equal(await evaluate('window.physicalGpuChecks.rows.length'), 1, 'Display replication must reuse its original atom analysis.');
    await evaluate(`(() => { const checkbox = document.getElementById('replicate-atoms'); checkbox.checked = true; checkbox.dispatchEvent(new Event('change')); })()`);
    await waitFor(`document.getElementById('atom-count').textContent === '64' && document.getElementById('cache-label').dataset.gpuCachedFrames === '6' && document.getElementById('cache-label').dataset.gpuCacheState === 'ready'`, 'expanded geometry GPU preload');
    await evaluate(`document.getElementById('run-analysis').click();`);
    await waitFor(`window.physicalGpuChecks.rows.some(row => row.atoms === 64) && document.getElementById('analysis-state').textContent === 'Calculated'`, 'expanded GPU analysis');
    const expanded = await evaluate('window.physicalGpuChecks.rows.find(row => row.atoms === 64)');
    assert.equal(expanded.cellA, raw.cellA * 2);
    assert.ok(expanded.cacheGeneration > raw.cacheGeneration, 'Physical replication invalidates the previous GPU source generation.');
    assert.ok(expanded.cacheFrameBytes > raw.cacheFrameBytes, 'The GPU cache must reserve buffers for the expanded frame.');
    const geometryBuffers = await evaluate(`(() => {
      const renderer = window.physicalGpuChecks.renderer, gl = renderer.gl;
      const previous = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
      try {
        const sizes = {};
        for (const name of ['positionBuffer', 'fractionalBuffer']) {
          gl.bindBuffer(gl.ARRAY_BUFFER, renderer[name]);
          sizes[name] = gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE);
        }
        return { atoms: renderer.atomCount, fractionalType: renderer.frame.fractional.constructor.name, sizes };
      } finally { gl.bindBuffer(gl.ARRAY_BUFFER, previous); }
    })()`);
    assert.equal(geometryBuffers.fractionalType, 'Float64Array', 'Physical replication preserves canonical fractional precision for analysis.');
    for (const bytes of Object.values(geometryBuffers.sizes)) assert.equal(bytes, geometryBuffers.atoms * 3 * Float32Array.BYTES_PER_ELEMENT,
      'WebGL geometry uploads use Float32 stride while retaining Float64 analysis inputs.');
    await evaluate(`(() => { const slider = document.getElementById('frame-slider'); slider.value = '0'; slider.dispatchEvent(new Event('input')); })()`);
    await waitFor(`document.getElementById('frame-label').textContent === '1 / 6' && document.getElementById('atom-count').textContent === '64' && document.getElementById('analysis-state').textContent === 'Calculated' && window.physicalGpuChecks.rows.at(-1)?.cellA === ${7.04 * 2}`, 'expanded next frame');
    const next = await evaluate('window.physicalGpuChecks.rows.at(-1)');
    assert.equal(next.atoms, 64); assert.equal(next.cellA, 7.04 * 2);
    await evaluate(`(() => { const checkbox = document.getElementById('replicate-atoms'); checkbox.checked = false; checkbox.dispatchEvent(new Event('change')); })()`);
    await waitFor(`document.getElementById('atom-count').textContent === '32' && document.getElementById('cache-label').dataset.gpuCachedFrames === '6' && document.getElementById('cache-label').dataset.gpuCacheState === 'ready' && document.getElementById('analysis-state').textContent === 'Calculated' && window.physicalGpuChecks.rows.at(-1)?.atoms === 32 && window.physicalGpuChecks.rows.at(-1)?.cellA === 7.04`, 'restored raw GPU preload');
    const restored = await evaluate('window.physicalGpuChecks.rows.at(-1)');
    assert.equal(restored.atoms, 32); assert.equal(restored.cellA, 7.04);
    assert.ok(restored.cacheGeneration > expanded.cacheGeneration);
    // The earlier displacement checks add Cartesian residency to the raw
    // frame; a source reset removes it and restores only fractional inputs.
    assert.ok(restored.cacheFrameBytes >= restored.atoms * 36 && restored.cacheFrameBytes <= raw.cacheFrameBytes,
      'Restored cache contains the original fractional geometry and releases added Cartesian buffers.');
    assert.ok(restored.cacheFrameBytes < expanded.cacheFrameBytes);
    assert.equal(await evaluate('window.physicalGpuChecks.renderer.displayAtomCount'), 64, 'Disabling physical replication keeps display-only copies.');
    return { sourceAtoms: raw.atoms, expandedAtoms: expanded.atoms, displayAnalysisReused: true,
      expandedNextFrame: next.atoms, restoredAtoms: restored.atoms, geometryBuffers,
      cacheGenerations: [raw.cacheGeneration, expanded.cacheGeneration, restored.cacheGeneration] };
  } finally { await evaluate('window.restorePhysicalGpuHooks()'); }
}

async function runBuiltIdealChecks({ evaluate }) {
  return evaluate(`(async () => {
    const html = await (await fetch('./dist/index.html')).text();
    const entry = html.match(/src="(\\.\\/assets\\/[^" ]+\\/src\\/app\\.js)"/);
    if (!entry) throw new Error('Run npm run build before the --built-only production check.');
    const base = new URL(entry[1].replace(/app\\.js$/, ''), new URL('./dist/index.html', location.href));
    const { AnalysisPool } = await import(new URL('analysis/analysis-pool.js', base).href);
    const { crystalFrame } = await import('./tests/helpers/crystals.js');
    const { STRAIN_FIELDS } = await import(new URL('analysis/atomic-strain.js', base).href);
    const { compareGpuFields, compareGpuPtm } = await import('./scripts/gpu-comparison.js');
    const NativeWorker = window.Worker, workerUrls = [];
    window.Worker = class extends NativeWorker { constructor(url, options) { workerUrls.push(String(url)); super(url, options); } };
    const cpu = new AnalysisPool(), gpu = new AnalysisPool(); cpu.setGpuEnabled(false); gpu.setGpuEnabled(true);
    try {
      const frame = crystalFrame('fcc', 3, 3.52), parameters = { kind: 'strain', references: [{ structure: 1, a: 3.52 }], flags: 255, rmsdCutoff: .1 };
      const fresh = await gpu.analyze(frame, parameters), expected = await cpu.analyze(frame, parameters);
      if (fresh.backend !== 'gpu' || fresh.neighborBackend !== 'gpu' || fresh.ptmBackend !== 'cpu' || fresh.referenceBackend !== 'gpu' || fresh.tensorBackend !== 'gpu') throw new Error('Production ideal strain stage routing differs.');
      const fields = compareGpuFields(fresh, expected, STRAIN_FIELDS, 2e-6), ptm = compareGpuPtm(fresh, expected);
      for (const name of STRAIN_FIELDS) if (!fresh[name].every(value => value === 0)) throw new Error('Production undeformed strain is not zero: ' + name);
      const editedParameters = { ...parameters, references: [{ structure: 1, a: 3.4 }], ptmInput: fresh };
      const before = gpu.gpuCacheStatus.uploadCount;
      const edited = await gpu.analyze(frame, editedParameters), expectedEdited = await cpu.analyze(frame, editedParameters);
      const editedFields = compareGpuFields(edited, expectedEdited, STRAIN_FIELDS, 2e-6);
      if (!edited.ptmInputReused || !edited.gpuPtmInputReused || gpu.gpuCacheStatus.uploadCount !== before) throw new Error('Production reference edit did not retain raw fit residency.');
      if (!workerUrls.length || workerUrls.some(url => !url.includes('/dist/assets/') || !url.includes('/src/'))) throw new Error('Production workers are not versioned: ' + JSON.stringify(workerUrls));
      return { assetBase: base.pathname, atoms: frame.ids.length, freshEngine: fresh.engine, freshFields: fields, ptm,
        editedFields, editedPtmInputReused: edited.ptmInputReused, editedGpuPtmInputReused: edited.gpuPtmInputReused,
        uploadCountUnchanged: true, workerUrls, exactZero: true };
    } finally { cpu.close(); gpu.close(); window.Worker = NativeWorker; }
  })()`);
}
