import { withWebGpuBrowser, useSoftwareAdapter } from './webgpu-browser.mjs';

// Actual Fe geometry through the public AnalysisPool API. GPU nearest-neighbor
// preparation feeds the shared CPU Wasm fitter; cached fits feed GPU strain.
// Software execution establishes numerical parity, not hardware speed.
const software = useSoftwareAdapter(true);
const source = process.argv.includes('--source');
const report = await withWebGpuBrowser(async ({ evaluate, adapter }) => {
  const input = await evaluate(`(${initialize.toString()})(${source})`, { timeoutMs: 120_000 });
  console.log(JSON.stringify({ phase: 'Actual Fe lattice validation input', ...input }));
  const cpu = await evaluate('feLatticeChecks.runCpu()', { timeoutMs: 120_000 });
  console.log(JSON.stringify({ phase: 'Native CPU PTM reference', ...cpu }));
  const startedAt = performance.now();
  const timer = setInterval(() => {
    void evaluate('feLatticeChecks.progress', { timeoutMs: 10_000 }).then(progress => {
      console.log(JSON.stringify({ phase: 'Actual Fe GPU lattice validation', elapsedMs: performance.now() - startedAt, progress }));
    }).catch(() => {});
  }, 30_000);
  let gpu;
  try { gpu = await evaluate('feLatticeChecks.runGpu()', { timeoutMs: 1_800_000 }); }
  finally { clearInterval(timer); }
  await evaluate('feLatticeChecks.close()');
  return { adapter, softwareValidation: software, hardwarePerformanceMeasured: false, input, cpu, gpu };
}, { software, isolated: false });
console.log(JSON.stringify(report, null, 2));

async function initialize(source) {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  let base;
  if (source) base = new URL('./src/', location.href);
  else {
    const response = await fetch('./dist/index.html');
    check(response.ok, 'Run npm run build before the production Fe lattice check, or use --source.');
    const entry = (await response.text()).match(/src="(\.\/assets\/[^" ]+\/src\/app\.js)"/);
    check(entry, 'The production app must use a versioned asset tree.');
    base = new URL(entry[1].replace(/app\.js$/, ''), new URL('./dist/index.html', location.href));
  }
  const [{ AnalysisPool }, { CpuBudget }, { parseLammpsFrame }, { calculatePtm },
    { estimateLatticeReferences }, { calculateAtomicStrain, STRAIN_FIELDS }, comparisons] = await Promise.all([
    import(new URL('analysis/analysis-pool.js', base).href),
    import(new URL('analysis/cpu-budget.js', base).href),
    import(new URL('io/lammps-dump.js', base).href),
    import(new URL('analysis/ptm.js', base).href),
    import(new URL('analysis/lattice-estimate.js', base).href),
    import(new URL('analysis/atomic-strain.js', base).href),
    import('./scripts/gpu-comparison.js'),
  ]);
  const fixture = new URL('../examples/Fe_disloc_loop.dump', base);
  const response = await fetch(fixture);
  check(response.ok, 'The actual Fe loop dump must be included in the selected asset tree.');
  const frame = parseLammpsFrame(await response.text(), 'Fe_disloc_loop.dump');
  check(frame.ids.length === 60229, 'Every actual source atom must participate.');
  check(frame.typeLabels.length === 1 && frame.typeLabels[0] === 'Type 1', 'The numeric dump must retain unknown element identity.');
  const NativeWorker = window.Worker, workerUrls = [];
  window.Worker = class extends NativeWorker {
    constructor(url, options) { workerUrls.push(String(url)); super(url, options); }
  };
  // Bound this scientific browser check to two fitting workers. It uses the
  // production pool, queue and reusable Wasm modules without oversubscribing.
  const pool = new AnalysisPool({ cpuBudget: new CpuBudget({ environment: { navigator: { hardwareConcurrency: 4 } } }) });
  pool.setGpuEnabled(true);
  const state = window.feLatticeChecks = { frame, pool, workerUrls, cpu: null, fit: null, progress: null };
  let ptmFits = 0, neighborPreparations = 0, tensorRequests = 0;
  const nativeCpuAnalyze = pool.analyzeCPU.bind(pool);
  pool.analyzeCPU = (input, parameters, options) => {
    if (parameters.kind === 'ptm' || (parameters.kind === 'strain' && !parameters.ptmInput)) ptmFits++;
    return nativeCpuAnalyze(input, parameters, options);
  };
  const nativeGpuAnalyze = pool.gpuBackend.analyze.bind(pool.gpuBackend);
  pool.gpuBackend.analyze = (input, parameters, options) => {
    if (parameters.kind === 'ptmNeighbors') neighborPreparations++;
    if (parameters.kind === 'strain') tensorRequests++;
    return nativeGpuAnalyze(input, parameters, options);
  };
  const progress = update => { state.progress = update; };
  const counts = result => {
    const histogram = {};
    for (const value of result.structures) histogram[value] = (histogram[value] ?? 0) + 1;
    return histogram;
  };
  const parameters = { kind: 'ptm', flags: 127, rmsdCutoff: .1 };
  const checkEstimate = estimates => {
    check(estimates.length === 1 && estimates[0].status === 'estimated', 'The actual numeric type must receive one confident geometric reference.');
    const estimate = estimates[0];
    check(estimate.element === '' && estimate.structure === 3, 'Geometry must identify BCC without guessing Fe chemistry.');
    check(Math.abs(estimate.a - 2.836575) < 1e-5 && estimate.sampleCount > 60000,
      'The fitted BCC lattice constant/sample count differs from the actual fixture.');
  };
  state.runCpu = async () => {
    state.cpu = await calculatePtm(frame, parameters);
    const estimates = await estimateLatticeReferences(frame, state.cpu);
    checkEstimate(estimates);
    return { atoms: state.cpu.structures.length, structureCounts: counts(state.cpu), elapsedMs: state.cpu.elapsedMs, estimates };
  };
  state.runGpu = async () => {
    const inputsIntact = comparisons.snapshotGpuInputs(frame);
    state.fit = await pool.analyze(frame, parameters, { onProgress: progress });
    const fit = state.fit;
    check(fit.backend === 'hybrid' && fit.neighborBackend === 'gpu' && fit.ptmBackend === 'cpu' && !fit.fallbackReason,
      'PTM must prepare neighbors on GPU and fit once in the shared CPU Wasm pool: ' + JSON.stringify({
        backend: fit.backend, neighborBackend: fit.neighborBackend, ptmBackend: fit.ptmBackend, fallbackReason: fit.fallbackReason }));
    check(fit.engine.includes('webgpu') && fit.engine.includes('ptm-wasm') && fit.ptmEngine.includes('ptm-wasm'),
      'The full engine and fitter metadata must disclose both stages.');
    const ptmComparison = comparisons.compareGpuPtm(fit, state.cpu);
    const estimates = await estimateLatticeReferences(frame, fit);
    checkEstimate(estimates);
    check(ptmFits === 1 && neighborPreparations === 1, 'Lattice estimation must consume the existing fit without another preparation or fit.');
    const fitIntact = comparisons.snapshotGpuInputs(frame, { ptmInput: fit });
    const runTensor = async references => {
      const expected = await calculateAtomicStrain(frame, { references, ptmInput: fit });
      const actual = await pool.analyze(frame, { kind: 'strain', references, ptmInput: fit }, { onProgress: progress });
      check(actual.backend === 'gpu' && actual.tensorBackend === 'gpu' && actual.referenceBackend === 'gpu' && !actual.fallbackReason,
        'Cached PTM must convert the reference and compute strain on GPU.');
      const comparison = comparisons.compareGpuFields(actual, { ...expected, warning: null }, STRAIN_FIELDS, 2e-6);
      check(ptmFits === 1 && neighborPreparations === 1, 'Cached strain must not prepare neighbors or fit PTM again.');
      return { comparison, incomplete: actual.incomplete, backend: actual.backend, engine: actual.engine,
        referenceBackend: actual.referenceBackend, tensorBackend: actual.tensorBackend,
        ptmInputReused: actual.ptmInputReused, gpuPtmInputReused: actual.gpuPtmInputReused };
    };
    const strain = await runTensor(estimates);
    const uploads = pool.gpuCacheStatus.uploadCount;
    const edited = await runTensor(estimates.map(reference => ({ ...reference, a: reference.a * 1.005 })));
    check(edited.ptmInputReused && edited.gpuPtmInputReused && pool.gpuCacheStatus.uploadCount === uploads,
      'An edited lattice constant must retain privately cached and GPU-resident fit data.');
    inputsIntact(); fitIntact();
    check(workerUrls.length > 0 && workerUrls.every(url => url.startsWith(base.href)),
      'CPU and GPU workers must use the selected versioned production modules.');
    return { atoms: fit.structures.length, structureCounts: counts(fit), backend: fit.backend, engine: fit.engine,
      ptmBackend: fit.ptmBackend, neighborBackend: fit.neighborBackend, ptmEngine: fit.ptmEngine,
      ptmWorkerCount: fit.ptmWorkerCount, ptmElapsedMs: fit.ptmElapsedMs, neighborElapsedMs: fit.neighborElapsedMs,
      estimates, ptmComparison, strain, editedStrain: edited, ptmFits, neighborPreparations, tensorRequests,
      uploadCountUnchangedAfterEdit: true, sourceAndFitIntact: true, workerUrls, cache: pool.gpuCacheStatus };
  };
  state.close = () => { pool.close(); window.Worker = NativeWorker; };
  return { atoms: frame.ids.length, typeLabels: frame.typeLabels, fixture: fixture.pathname,
    assetBase: base.pathname, versionedProduction: !source, fittingWorkerBudget: 2 };
}
