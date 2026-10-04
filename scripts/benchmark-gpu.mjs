import { writeFile } from 'node:fs/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

const selected = process.argv.find((argument) => argument.startsWith('--kernel='))?.split('=')[1] ?? 'all';
const supported = ['coordination', 'rdf', 'localShear', 'bonds', 'strain'];
if (selected !== 'all' && !supported.includes(selected)) throw new Error(`Choose --kernel=all or one of ${supported.join(', ')}.`);
const requested = selected === 'all' ? supported : [selected];
const report = await withWebGpuBrowser(async ({ evaluate, adapter }) => {
  const results = await evaluate(`(async () => {
    const { AnalysisPool } = await import('./src/analysis/analysis-pool.js');
    const { parseCfg } = await import('./src/io/cfg.js');
    const { compareGpuBonds } = await import('./scripts/gpu-comparison.js');
    const { STRAIN_FIELDS } = await import('./src/analysis/atomic-strain.js');
    const frame = parseCfg(await (await fetch('./examples/NiGB_minimized.cfg')).text(), 'NiGB_minimized.cfg');
    const cpu = new AnalysisPool(), gpu = new AnalysisPool();
    gpu.setGpuEnabled(true);
    const preload = { enabled: ${JSON.stringify(process.argv.includes('--preload'))}, wallMs: 0 };
    const rows = [], ptmPreparation = { wallMs: 0, engine: null };
    let ptmInput;
    const isGpu = result => result.backend === 'gpu' || /webgpu/i.test(result.engine ?? '');
    const timed = async (pool, parameters) => {
      const started = performance.now();
      const result = await pool.analyze(frame, parameters);
      return { result, wallMs: performance.now() - started };
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
      for (const kind of ${JSON.stringify(requested)}) {
        // This example has a 4.97773 Å periodic Z cell. RDF is limited to half
        // that face height; coordination/shear retain their image conventions.
        if (kind === 'strain' && !ptmInput) {
          const preparation = await timed(cpu, { kind: 'ptm', flags: 31, rmsdCutoff: .1 });
          ptmInput = preparation.result;
          ptmPreparation.wallMs = preparation.wallMs;
          ptmPreparation.engine = ptmInput.engine;
        }
        const parameters = kind === 'strain' ? { kind, references: frame.typeLabels.map(() => ({ structure: 1, a: 3.52 })), ptmInput }
          : kind === 'rdf' ? { kind, cutoff: 2.48, bins: 100 }
          : { kind, cutoff: 3.1, ...(kind === 'localShear' ? { subtractMean: false } : {}) };
        const cpuCold = await timed(cpu, parameters), cpuWarm = await timed(cpu, parameters);
        const gpuCold = await timed(gpu, parameters), gpuWarm = await timed(gpu, parameters);
        const field = kind === 'coordination' ? 'coordination' : kind === 'rdf' ? 'counts' : 'localShear';
        const tolerance = kind === 'localShear' ? 3e-5 : 0;
        const compareResults = (actual, expected) => kind === 'bonds' ? compareGpuBonds(actual, expected)
          : kind === 'strain' ? Math.max(...STRAIN_FIELDS.map(name => compare(actual[name], expected[name], 2e-6)))
            : compare(actual[field], expected[field], tolerance);
        const maxAbsoluteError = Math.max(compareResults(gpuCold.result, cpuCold.result), compareResults(gpuWarm.result, cpuWarm.result));
        if (kind === 'localShear') {
          compare(gpuCold.result.coordination, cpuCold.result.coordination);
          compare(gpuWarm.result.coordination, cpuWarm.result.coordination);
        }
        const gpuActive = isGpu(gpuWarm.result);
        const { ptmInput: omittedFit, ...reportedParameters } = parameters;
        rows.push({ kind, parameters: reportedParameters, ...(kind === 'strain' ? { input: 'Cached CPU PTM correspondences; tensor evaluation only',
          incomplete: gpuWarm.result.incomplete } : {}), ...(kind === 'bonds' ? { edges: gpuWarm.result.count } : {}),
          gpuActive, gpuEngine: gpuWarm.result.engine,
          cpuEngine: cpuWarm.result.engine, cpuWorkers: cpuWarm.result.workerCount,
          cpuWallMs: { cold: cpuCold.wallMs, warm: cpuWarm.wallMs },
          gpuWallMs: { cold: gpuCold.wallMs, warm: gpuWarm.wallMs },
          fallbackReason: gpuWarm.result.fallbackReason ?? null, maxAbsoluteError,
          correctedPairs: gpuWarm.result.correctedPairs ?? gpuWarm.result.precisionCorrections ?? 0,
          correctedAtoms: gpuWarm.result.correctedAtoms ?? gpuWarm.result.gpuCorrectionAtoms ?? 0, inputReused: gpuWarm.result.inputReused ?? null,
          gpuInputReused: gpuWarm.result.gpuInputReused ?? null, adapter: gpuWarm.result.adapter ?? null,
          warmWallTimeRatio: gpuActive ? cpuWarm.wallMs / gpuWarm.wallMs : null });
      }
      return { file: 'examples/NiGB_minimized.cfg', atoms: frame.ids.length, preload, ptmPreparation, rows };
    } finally { cpu.close(); gpu.close(); }
  })()`);
  const software = adapter.isFallbackAdapter || /swiftshader|software|llvmpipe/i.test(`${adapter.architecture} ${adapter.description}`);
  return { adapter, software, timingScope: 'Full AnalysisPool call: initialization, input preparation/upload, kernel execution, output readback, and result assembly.',
    runOrder: 'Kernels run in the listed order through the same CPU and GPU pools. Cold means the first call of that kernel; earlier kernels can have initialized the device, workers, and shared input buffers.',
    timingInterpretation: software ? 'Software WebGPU adapter; these timings do not measure physical GPU acceleration.'
      : 'Current browser adapter; compare cold and warm wall times on the same machine.', ...results };
}, { software: useSoftwareAdapter(false) });
const serialized = `${JSON.stringify(report, null, 2)}\n`;
const output = process.argv.find((argument) => argument.startsWith('--output='))?.slice('--output='.length);
if (output) await writeFile(output, serialized);
process.stdout.write(serialized);
