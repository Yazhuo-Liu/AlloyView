import { writeFile } from 'node:fs/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

const selected = process.argv.find((argument) => argument.startsWith('--kernel='))?.split('=')[1] ?? 'all';
const supported = ['coordination', 'rdf', 'localShear', 'bonds', 'strain', 'strainFresh', 'strainEdited', 'cnaFixed', 'cnaAdaptive', 'referenceStrain', 'csp8', 'csp12', 'cspAuto', 'displacement'];
if (selected !== 'all' && !supported.includes(selected)) throw new Error(`Choose --kernel=all or one of ${supported.join(', ')}.`);
const requested = selected === 'all' ? supported : [selected];
const report = await withWebGpuBrowser(async ({ evaluate, adapter }) => {
  const results = await evaluate(`(async () => {
    const { AnalysisPool } = await import('./src/analysis/analysis-pool.js');
    const { parseCfg } = await import('./src/io/cfg.js');
    const { bondVectorTolerance, compareGpuBonds, compareGpuFields, compareGpuCentrosymmetry, compareGpuDisplacements, compareGpuPtm, snapshotGpuInputs } = await import('./scripts/gpu-comparison.js');
    const { cartesianToFractional } = await import('./src/data/model.js');
    const { prepareDisplacements } = await import('./src/analysis/displacement.js');
    const { transformFrame } = await import('./scripts/gpu-fixtures.js');
    const { STRAIN_FIELDS } = await import('./src/analysis/atomic-strain.js');
    const { REFERENCE_STRAIN_FIELDS } = await import('./src/analysis/reference-strain.js');
    const frame = parseCfg(await (await fetch('./examples/NiGB_minimized.cfg')).text(), 'NiGB_minimized.cfg');
    // Benchmark the GPU PTM-neighbor kernel itself; the application chooses it only for small CPU pools.
    const cpu = new AnalysisPool(), gpu = new AnalysisPool({ ptmNeighborBackend: 'gpu' });
    cpu.setGpuEnabled(false); gpu.setGpuEnabled(true);
    const preload = { enabled: ${JSON.stringify(process.argv.includes('--preload'))}, wallMs: 0 };
    const rows = [], ptmPreparation = { wallMs: 0, engine: null };
    const editedFitPreparation = { wallMs: 0, engine: null };
    const displacementPreparation = { wallMs: 0 };
    const translation = [.12, -.08, .05];
    const translatedPositions = Float64Array.from(frame.positions, (value, component) => value + translation[component % 3]);
    const translatedFrame = { ...frame, positions: translatedPositions, fractional: cartesianToFractional(translatedPositions, frame.cell, new Float64Array(translatedPositions.length)) };
    let ptmInput;
    const isGpu = result => result.backend === 'gpu' || /webgpu/i.test(result.engine ?? '');
    const timed = async (pool, parameters, inputFrame = frame) => {
      const assertInputsIntact = snapshotGpuInputs(inputFrame, parameters);
      const started = performance.now();
      const result = await pool.analyze(inputFrame, parameters);
      const wallMs = performance.now() - started;
      assertInputsIntact();
      return { result, wallMs };
    };
    const compare = (actual, expected, tolerance = 0) => {
      if (actual.length !== expected.length) throw new Error('Result lengths differ.');
      let maxAbsoluteError = 0;
      for (let atom = 0; atom < actual.length; atom += 1) {
        if (Number.isNaN(actual[atom]) && Number.isNaN(expected[atom])) continue;
        const difference = Math.abs(actual[atom] - expected[atom]);
        if (!Number.isFinite(difference) || difference > tolerance) throw new Error('GPU/CPU mismatch at ' + atom + ': ' + actual[atom] + ' / ' + expected[atom]);
        maxAbsoluteError = Math.max(maxAbsoluteError, difference);
      }
      return maxAbsoluteError;
    };
    try {
      if (preload.enabled) {
        const started = performance.now();
        await gpu.warmupGpu();
        await gpu.configureGpuCache({ frameCount: 1, currentIndex: 0 });
        await gpu.prepareGpuFrame(frame, { frameIndex: 0 });
        preload.wallMs = performance.now() - started;
        preload.cache = gpu.gpuCacheStatus;
      }
      for (const kernel of ${JSON.stringify(requested)}) {
        const kind = kernel.startsWith('strain') ? 'strain' : kernel.startsWith('cna') ? 'cna' : kernel.startsWith('csp') ? 'centrosymmetry' : kernel;
        // This example has a 4.97773 Å periodic Z cell. RDF is limited to half
        // that face height; coordination/shear retain their image conventions.
        if (kind === 'strain' && kernel !== 'strainFresh' && !ptmInput) {
          const preparation = await timed(cpu, { kind: 'ptm', flags: 31, rmsdCutoff: .1 });
          ptmInput = preparation.result;
          ptmPreparation.wallMs = preparation.wallMs;
          ptmPreparation.engine = ptmInput.engine;
        }
        // A synthetic affine current frame is copied from this one source, so
        // reference-strain correspondence is known directly by source row.
        const affineF = [1.02, .12, .03, 0, .98, .05, 0, 0, 1.04];
        const inputFrame = kind === 'referenceStrain' ? transformFrame(frame, affineF) : kind === 'displacement' ? translatedFrame : frame;
        let displacementParameters;
        if (kind === 'displacement') {
          const started = performance.now();
          displacementParameters = await prepareDisplacements(inputFrame, frame, { minimumImage: true });
          displacementPreparation.wallMs = performance.now() - started;
        }
        const parameters = kind === 'strain' ? { kind, references: frame.typeLabels.map(() => ({ structure: 1, a: kernel === 'strainEdited' ? 3.4 : 3.52 })), flags: 31, rmsdCutoff: .1, ...(kernel === 'strainFresh' ? {} : { ptmInput }) }
          : kind === 'cna' ? { kind, mode: kernel === 'cnaFixed' ? 'fixed' : 'adaptive', ...(kernel === 'cnaFixed' ? { cutoff: 3.1 } : {}) }
          : kind === 'referenceStrain' ? { kind, cutoff: 3.1, referenceFrame: frame, referenceFractional: frame.fractional,
            referenceCell: frame.cell, referenceMapping: Int32Array.from(frame.ids, (_, atom) => atom) }
          : kind === 'centrosymmetry' ? { kind, mode: kernel === 'cspAuto' ? 'auto' : 'manual', ...(kernel !== 'cspAuto' ? { neighbors: kernel === 'csp8' ? 8 : 12 } : {}) }
          : kind === 'displacement' ? { kind, ...displacementParameters }
          : kind === 'rdf' ? { kind, cutoff: 2.48, bins: 100 }
          : { kind, cutoff: 3.1, ...(kind === 'localShear' ? { subtractMean: false } : {}) };
        if (kernel === 'strainEdited') {
          const preparation = await timed(gpu, { ...parameters, references: frame.typeLabels.map(() => ({ structure: 1, a: 3.52 })) }, inputFrame);
          if (!isGpu(preparation.result)) throw new Error('Resident fit preparation silently fell back: ' + preparation.result.fallbackReason);
          editedFitPreparation.wallMs = preparation.wallMs; editedFitPreparation.engine = preparation.result.engine;
          editedFitPreparation.cache = gpu.gpuCacheStatus;
        }
        const uploadCountBefore = gpu.gpuCacheStatus?.uploadCount ?? null;
        const cpuCold = await timed(cpu, parameters, inputFrame), cpuWarm = await timed(cpu, parameters, inputFrame);
        const gpuCold = await timed(gpu, parameters, inputFrame), gpuWarm = await timed(gpu, parameters, inputFrame);
        for (const measured of [gpuCold, gpuWarm]) if (!isGpu(measured.result))
          throw new Error(kernel + ' must execute real GPU kernels: ' + (measured.result.fallbackReason ?? measured.result.engine));
        const field = kind === 'coordination' ? 'coordination' : kind === 'rdf' ? 'counts' : kind === 'cna' ? 'structures' : 'localShear';
        const tolerance = kind === 'localShear' ? 3e-5 : 0;
        const compareResults = (actual, expected) => kind === 'bonds' ? compareGpuBonds(actual, expected, bondVectorTolerance(inputFrame))
          : kind === 'strain' ? compareGpuFields(actual, expected, STRAIN_FIELDS, 2e-6).maxAbsoluteError
            : kind === 'referenceStrain' ? compareGpuFields(actual, expected, REFERENCE_STRAIN_FIELDS, 2e-6).maxAbsoluteError
            : kind === 'centrosymmetry' ? compareGpuCentrosymmetry(actual, expected, 2e-6).maxAbsoluteError
            : kind === 'displacement' ? compareGpuDisplacements(actual, expected, 2e-6).maxAbsoluteError
            : compare(actual[field], expected[field], tolerance);
        const maxAbsoluteError = Math.max(compareResults(gpuCold.result, cpuCold.result), compareResults(gpuWarm.result, cpuWarm.result));
        let ptmComparison = null;
        if (kernel === 'strainFresh') {
          for (const measured of [gpuCold, gpuWarm]) if (measured.result.neighborBackend !== 'gpu' || measured.result.ptmBackend !== 'cpu' || measured.result.referenceBackend !== 'gpu' || measured.result.tensorBackend !== 'gpu')
            throw new Error('Fresh ideal strain must use GPU neighbors, CPU PTM and GPU reference/tensor stages.');
          ptmComparison = { cold: compareGpuPtm(gpuCold.result, cpuCold.result), warm: compareGpuPtm(gpuWarm.result, cpuWarm.result) };
        }
        if (kernel === 'strainEdited') {
          for (const measured of [gpuCold, gpuWarm]) if (!measured.result.ptmInputReused || !measured.result.gpuPtmInputReused)
            throw new Error('Lattice edits must reuse private and GPU-resident raw PTM fits.');
          if (gpu.gpuCacheStatus.uploadCount !== uploadCountBefore) throw new Error('Lattice edits unexpectedly uploaded geometry or PTM fits.');
        }
        if (kind === 'localShear') {
          compare(gpuCold.result.coordination, cpuCold.result.coordination);
          compare(gpuWarm.result.coordination, cpuWarm.result.coordination);
        }
        const gpuActive = isGpu(gpuWarm.result);
        const { ptmInput: omittedFit, referenceFrame: omittedReference, referenceFractional: omittedCoordinates,
          referenceCell: omittedCell, referenceMapping: omittedMapping, currentPositions: omittedCurrentPositions,
          referencePositions: omittedReferencePositions, ...reportedParameters } = parameters;
        const correctedAtoms = gpuWarm.result.correctedAtoms ?? gpuWarm.result.gpuCorrectionAtoms ?? 0;
        if (['cna', 'referenceStrain', 'centrosymmetry', 'displacement'].includes(kind) && correctedAtoms >= frame.ids.length)
          throw new Error(kernel + ' corrected the entire structure on CPU rather than using genuine GPU analysis.');
        rows.push({ kernel, kind, parameters: reportedParameters, ...(kind === 'referenceStrain' ? {
          input: 'Synthetic affine copy with known same-row correspondence to NiGB reference', deformationGradient: affineF,
          incomplete: gpuWarm.result.incomplete, fieldErrors: compareGpuFields(gpuWarm.result, cpuWarm.result, REFERENCE_STRAIN_FIELDS, 2e-6).fields,
        } : {}), ...(kind === 'strain' ? { input: kernel === 'strainFresh' ? 'Fresh GPU nearest-18 preparation, CPU WebAssembly PTM fit, GPU reference conversion and tensor evaluation' : kernel === 'strainEdited' ? 'Edited lattice constant 3.52 to 3.4 Å with previously uploaded immutable CPU PTM fits' : 'Cached CPU PTM correspondences; GPU reference conversion and tensor evaluation',
          incomplete: gpuWarm.result.incomplete, ptmComparison,
          stageBackends: { neighbors: gpuWarm.result.neighborBackend ?? null, ptm: gpuWarm.result.ptmBackend ?? null, reference: gpuWarm.result.referenceBackend, tensor: gpuWarm.result.tensorBackend },
          ptmInputReused: gpuWarm.result.ptmInputReused, gpuPtmInputReused: gpuWarm.result.gpuPtmInputReused,
          ptmInputReusedCold: gpuCold.result.ptmInputReused, gpuPtmInputReusedCold: gpuCold.result.gpuPtmInputReused,
          uploadCountBefore, uploadCountAfter: gpu.gpuCacheStatus.uploadCount,
          fieldErrors: compareGpuFields(gpuWarm.result, cpuWarm.result, STRAIN_FIELDS, 2e-6).fields } : {}), ...(kind === 'bonds' ? { edges: gpuWarm.result.count } : {}),
          ...(kind === 'centrosymmetry' ? { incomplete: gpuWarm.result.incomplete, cspSummary: gpuWarm.result.cspSummary ?? null,
            arithmetic: gpuWarm.result.gpuArithmetic, cnaReused: gpuWarm.result.gpuCnaReused,
            cnaCorrectedAtoms: gpuWarm.result.gpuCnaCorrectionAtoms ?? 0,
            cnaCorrectedAtomsCold: gpuCold.result.gpuCnaCorrectionAtoms ?? 0, cnaReusedCold: gpuCold.result.gpuCnaReused, radiusAttempts: gpuWarm.result.gpuRadiusAttempts } : {}),
          ...(kind === 'displacement' ? { input: 'Synthetic translated Cartesian copy of NiGB source; preparation/matching timed separately',
            translation, matched: gpuWarm.result.matched, unmatched: gpuWarm.result.unmatched, mappingMode: gpuWarm.result.mappingMode,
            vectorsType: gpuWarm.result.vectors.constructor.name, magnitudesType: gpuWarm.result.magnitudes.constructor.name,
            workflowWallMs: { cpuCold: displacementPreparation.wallMs + cpuCold.wallMs, cpuWarm: displacementPreparation.wallMs + cpuWarm.wallMs,
              gpuCold: displacementPreparation.wallMs + gpuCold.wallMs, gpuWarm: displacementPreparation.wallMs + gpuWarm.wallMs },
            comparison: compareGpuDisplacements(gpuWarm.result, cpuWarm.result, 2e-6) } : {}),
          ...(kind === 'cna' ? { structureHistogram: Array.from({ length: 5 }, (_, type) => gpuWarm.result.structures.reduce((sum, value) => sum + Number(value === type), 0)),
            correctionReasons: gpuWarm.result.gpuCorrectionReasons ?? null, radiusAttempts: gpuWarm.result.gpuRadiusAttempts } : {}),
          gpuActive, gpuEngine: gpuWarm.result.engine,
          cpuEngine: cpuWarm.result.engine, cpuWorkers: cpuWarm.result.workerCount,
          cpuWallMs: { cold: cpuCold.wallMs, warm: cpuWarm.wallMs },
          gpuWallMs: { cold: gpuCold.wallMs, warm: gpuWarm.wallMs },
          fallbackReason: gpuWarm.result.fallbackReason ?? null, maxAbsoluteError,
          correctedPairs: gpuWarm.result.correctedPairs ?? gpuWarm.result.precisionCorrections ?? 0,
          correctedAtoms, correctedAtomsCold: gpuCold.result.correctedAtoms ?? gpuCold.result.gpuCorrectionAtoms ?? 0,
          correctedAtomFraction: correctedAtoms / frame.ids.length, inputReused: gpuWarm.result.inputReused ?? null,
          gpuInputReused: gpuWarm.result.gpuInputReused ?? null, adapter: gpuWarm.result.adapter ?? null,
          referenceInputReused: gpuWarm.result.referenceInputReused ?? null,
          referenceGpuInputReused: gpuWarm.result.referenceGpuInputReused ?? (kind === 'displacement' ? gpuWarm.result.gpuInputReused && gpuWarm.result.referenceInputReused : null),
          warmWallTimeRatio: gpuActive ? cpuWarm.wallMs / gpuWarm.wallMs : null });
      }
      return { file: 'examples/NiGB_minimized.cfg', atoms: frame.ids.length, preload, ptmPreparation, editedFitPreparation, displacementPreparation, rows };
    } finally { cpu.close(); gpu.close(); }
  })()`, { timeoutMs: Math.max(360_000, requested.length * 180_000) });
  const software = adapter.isFallbackAdapter || /swiftshader|software|llvmpipe/i.test(`${adapter.architecture} ${adapter.description}`);
  return { adapter, software, timingScope: 'Full AnalysisPool call: initialization, input preparation/upload, kernel execution, output readback, and result assembly. Displacement ID matching/coordinate preparation is timed separately; its workflow times add that shared cost. strainEdited uploads immutable raw fits in separately timed preparation before the lattice edit; both measured calls use resident fits.',
    runOrder: 'Kernels run in the listed order through the same CPU and GPU pools. Cold means the first call of that kernel; earlier kernels can have initialized the device, workers, and shared input buffers.',
    timingInterpretation: software ? 'Software WebGPU adapter; these timings do not measure physical GPU acceleration.'
      : 'Current browser adapter; compare cold and warm wall times on the same machine.', ...results };
}, { software: useSoftwareAdapter(false) });
const serialized = `${JSON.stringify(report, null, 2)}\n`;
const output = process.argv.find((argument) => argument.startsWith('--output='))?.slice('--output='.length);
if (output) await writeFile(output, serialized);
process.stdout.write(serialized);
