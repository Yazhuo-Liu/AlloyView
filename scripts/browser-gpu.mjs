import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

const report = await withWebGpuBrowser(async ({ evaluate, adapter, call }) => {
  if (process.argv.includes('--application-only')) return { adapter, scope: 'Application integration checks',
    application: await runApplicationSmoke({ evaluate, call }) };
  await evaluate(`(async () => {
    const { AnalysisPool } = await import('./src/analysis/analysis-pool.js');
    const { crystalFrame } = await import('./tests/helpers/crystals.js');
    const { createCell, fractionalToCartesian } = await import('./src/data/model.js');
    const { compareGpuBonds, compareGpuFields, snapshotGpuInputs } = await import('./scripts/gpu-comparison.js');
    const { cnaFixtures, cnaDirectFixtures, referenceStrainFixtures } = await import('./scripts/gpu-fixtures.js');
    const { STRAIN_FIELDS } = await import('./src/analysis/atomic-strain.js');
    const { REFERENCE_STRAIN_FIELDS } = await import('./src/analysis/reference-strain.js');
    window.gpuTests = { AnalysisPool, crystalFrame, createCell, fractionalToCartesian, compareGpuBonds, compareGpuFields,
      snapshotGpuInputs, cnaFixtures, cnaDirectFixtures, referenceStrainFixtures, STRAIN_FIELDS, REFERENCE_STRAIN_FIELDS, rows: [] };
    window.gpuTests.cpu = new AnalysisPool();
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
    window.gpuTests.run = async (label, frame, parameters, field, tolerance = 0, requireGpu = true) => {
      const assertInputsIntact = window.gpuTests.snapshotGpuInputs(frame, parameters);
      const expected = await window.gpuTests.cpu.analyze(frame, parameters);
      const actual = await window.gpuTests.gpu.analyze(frame, parameters);
      assertInputsIntact();
      if (requireGpu && !window.gpuTests.isGpu(actual)) throw new Error(label + ' silently fell back: ' + JSON.stringify({ engine: actual.engine, fallbackReason: actual.fallbackReason }));
      const tensorComparison = ['strain', 'referenceStrain'].includes(parameters.kind)
        ? window.gpuTests.compareGpuFields(actual, expected, parameters.kind === 'strain'
          ? window.gpuTests.STRAIN_FIELDS : window.gpuTests.REFERENCE_STRAIN_FIELDS, tolerance) : null;
      let maxAbsoluteError = parameters.kind === 'bonds' ? window.gpuTests.compareGpuBonds(actual, expected)
        : tensorComparison ? tensorComparison.maxAbsoluteError
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
        ...(tensorComparison ? { incomplete: actual.incomplete, fieldErrors: tensorComparison.fields } : {}) });
      return actual;
    };
  })()`);
  const rows = await evaluate(`(async () => {
    const { cpu, gpu, crystalFrame, createCell, fractionalToCartesian, check, isGpu, run, rows } = window.gpuTests;
    try {
      const fcc = crystalFrame('fcc', 4, 3.52);
      const defaultResult = await cpu.analyze(fcc, { kind: 'coordination', cutoff: 2.8 });
      check(!isGpu(defaultResult), 'GPU computing must default to disabled.');
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
      const fresh = await run('Fresh CPU PTM with GPU strain tensor', fcc, { kind: 'strain', references, flags: 255 }, null, 2e-6);
      check(fresh.ptmBackend === 'cpu' && fresh.tensorBackend === 'gpu', 'Fresh strain must label its CPU/GPU stages accurately.');
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
      const outside = crystalFrame('fcc', 3, 3.52);
      outside.cell = createCell({ vectors: outside.cell.vectors, pbc: [false, true, true] });
      outside.fractional[0] = -0.1;
      await run('Unsupported open-cell positions CPU fallback', outside, { kind: 'coordination', cutoff: 2.8 }, 'coordination', 0, false);
      check(!isGpu(rows.at(-1)) && rows.at(-1).fallbackReason, 'Unsupported geometry must identify its CPU fallback.');
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
      for (const kind of ['cna', 'referenceStrain']) {
        const cancellationFrame = crystalFrame('fcc', 18, 3.52);
        const parameters = kind === 'cna' ? { kind, mode: 'adaptive' }
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
              : { kind, cutoff: 2.8, referenceFractional: fcc.fractional, referenceCell: fcc.cell,
                referenceMapping: Int32Array.from(fcc.ids, (_, index) => index) }, kind === 'cna' ? 'structures' : null, 2e-6);
          check(gpu.gpuBackend.worker === worker, 'Cancellation must retain the shared GPU worker.');
          check(gpu.gpuCacheStatus.pipelineCount >= pipelines, 'Cancellation must retain compiled pipelines.');
          cancellationChecks.push({ kind, stage, aborted, workerReused: true, pipelineCount: gpu.gpuCacheStatus.pipelineCount,
            engine: recovery.engine, inputsIntact: true });
        }
      }
      window.gpuTests.cancellationChecks = cancellationChecks;
      return rows;
    } finally { cpu.close(); gpu.close(); }
  })()`);
  assert.ok(rows.some((row) => /webgpu/i.test(row.engine ?? '') || row.backend === 'gpu'), 'No real GPU analysis was performed.');
  const preload = await runGpuPreloadChecks({ evaluate });
  const cancellation = await evaluate('window.gpuTests.cancellationChecks');
  const application = await runApplicationSmoke({ evaluate, call });
  return { adapter, softwareTiming: adapter.isFallbackAdapter || /swiftshader|software|llvmpipe/i.test(`${adapter.architecture} ${adapter.description}`),
    checks: rows, cancellation, preload, application };
}, { software: useSoftwareAdapter(true) });
console.log(JSON.stringify(report, null, 2));

async function runGpuPreloadChecks({ evaluate }) {
  return evaluate(`(async () => {
    const { AnalysisPool, crystalFrame, check, compare, compareGpuFields, REFERENCE_STRAIN_FIELDS } = window.gpuTests;
    const gpu = new AnalysisPool(), cpu = new AnalysisPool();
    gpu.setGpuEnabled(true);
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
        cnaInputReused: cna.inputReused && cna.gpuInputReused,
        referenceInputReused: reference.inputReused && reference.gpuInputReused,
        referenceGpuInputReused: reference.referenceGpuInputReused ?? null };
    } finally { gpu.close(); cpu.close(); }
  })()`);
}

async function runApplicationSmoke({ evaluate, call }) {
  async function waitFor(expression, label) {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await evaluate(expression)) return;
      await delay(25);
    }
    const diagnostics = await evaluate(`({ toast: document.getElementById('toast')?.textContent,
      cna: document.getElementById('cna-state')?.textContent, cnaMetric: document.getElementById('metric-cna')?.textContent,
      cnaStatus: document.getElementById('cna-status')?.textContent, reference: document.getElementById('reference-strain-state')?.textContent,
      referenceStatus: document.getElementById('reference-strain-status')?.textContent,
      gpu: document.getElementById('enable-gpu-computing')?.getAttribute('aria-pressed'), rows: window.applicationGpuChecks?.rows.slice(-4) })`);
    throw new Error(`Timed out: ${label}; ${JSON.stringify(diagnostics)}`);
  }
  await evaluate('location.href = new URL("./index.html", location.href).href');
  await waitFor('document.readyState === "complete" && document.getElementById("enable-gpu-computing") && document.getElementById("open-examples")', 'homepage');
  assert.equal(await evaluate('document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")'), 'false');
  await evaluate(`document.getElementById('open-examples').click();
    [...document.querySelectorAll('.source-option')].find(button => button.textContent.includes('fcc-vacancy.cfg')).click();`);
  await waitFor('document.getElementById("file-name").textContent === "fcc-vacancy.cfg" && document.getElementById("loading").hidden && !document.getElementById("run-analysis").disabled', 'FCC vacancy example');
  await evaluate(`(async () => {
    const { AnalysisPool } = await import('./src/analysis/analysis-pool.js');
    const { calculateCna } = await import('./src/analysis/cna.js');
    const { calculateReferenceStrain, REFERENCE_STRAIN_FIELDS } = await import('./src/analysis/reference-strain.js');
    const { compareGpuArrays, compareGpuFields, snapshotGpuInputs } = await import('./scripts/gpu-comparison.js');
    const analyze = AnalysisPool.prototype.analyze;
    window.applicationGpuChecks = { rows: [], adaptive: null };
    window.restoreApplicationGpuHooks = () => { AnalysisPool.prototype.analyze = analyze; };
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
      } else if (parameters.kind === 'centrosymmetry' && parameters.mode === 'auto') {
        const adaptive = window.applicationGpuChecks.adaptive;
        window.applicationGpuChecks.rows.push({ kind: 'autoCentrosymmetry', gpu: result.backend === 'gpu', engine: result.engine,
          reusedGpuCna: adaptive?.frame === frame && adaptive.backend === 'gpu' && adaptive.structures === parameters.structureInput });
      }
      return result;
    };
  })()`);
  const cases = [
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
      ${test.cutoff ? `document.getElementById('${test.cutoff}').value = '${test.value}';` : ''}
      ${test.mode ? `document.getElementById('cna-mode').value = '${test.mode}'; document.getElementById('cna-mode').dispatchEvent(new Event('change'));` : ''}
    })()`);
    await waitFor(`!document.getElementById('${test.button}').disabled`, `${test.tool} parameter update completed`);
    for (const enabled of [true, false]) {
      const before = await evaluate('window.applicationGpuChecks.rows.length');
      await evaluate(`(() => {
        const toggle = document.getElementById('enable-gpu-computing');
        if (toggle.getAttribute('aria-pressed') !== '${enabled}') toggle.click();
        document.getElementById('${test.button}').click();
      })()`);
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
  assert.equal(autoCentrosymmetry.gpu, false, 'Auto central symmetry retains its CPU pairing algorithm.');
  results.push(autoCentrosymmetry);
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
    assert.equal(restored.cacheFrameBytes, raw.cacheFrameBytes);
    assert.equal(await evaluate('window.physicalGpuChecks.renderer.displayAtomCount'), 64, 'Disabling physical replication keeps display-only copies.');
    return { sourceAtoms: raw.atoms, expandedAtoms: expanded.atoms, displayAnalysisReused: true,
      expandedNextFrame: next.atoms, restoredAtoms: restored.atoms, geometryBuffers,
      cacheGenerations: [raw.cacheGeneration, expanded.cacheGeneration, restored.cacheGeneration] };
  } finally { await evaluate('window.restorePhysicalGpuHooks()'); }
}
