import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser, useSoftwareAdapter } from './webgpu-browser.mjs';

const production = process.argv.includes('--production');
const report = await withWebGpuBrowser(async ({ evaluate, call, adapter }) => {
  if (production) {
    const origin = await evaluate('location.origin');
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    const deadline = Date.now() + 30_000;
    while (!await evaluate('document.readyState === "complete" && document.getElementById("enable-gpu-computing")')) {
      if (Date.now() > deadline) throw new Error('Production startup timed out.');
      await delay(25);
    }
    await evaluate(`if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click()`);
  }
  return { adapter, ...await evaluate(`(${run.toString()})(${production})`) };
}, { software: useSoftwareAdapter(true) });
assert.deepEqual(report.calibration.slice(0, 6).map(row => row.backend), ['gpu', 'gpu', 'gpu', 'cpu', 'cpu', 'cpu']);
assert.equal(report.exactHistograms, true);
assert.equal(report.batchPinned, true);
assert.equal(report.cachedBackendRejected, true);
assert.equal(report.firstRefusalAttempts, 1);
assert.equal(report.repeatRefusalAttempts, 1);
assert.equal(report.revisionRetryAttempts, 2);
assert.equal(report.refusalCode, 'cna-correction-budget');
assert.equal(report.retainedGpuWorker, true);
assert.equal(report.sourceArraysRetained, true);
assert.equal(report.releasedCpuPermits, 0);
console.log(JSON.stringify(report, null, 2));

async function run(production) {
  const base = production ? new URL('./', document.querySelector('script[type=module][src]').src) : new URL('/AlloyView/src/', location.href);
  const [{ AnalysisPool }, { CpuBudget }, { calculateRdf }, { createCell, fractionalToCartesian }] = await Promise.all([
    import(new URL('analysis/analysis-pool.js', base)), import(new URL('analysis/cpu-budget.js', base)),
    import(new URL('analysis/rdf.js', base)), import(new URL('data/model.js', base)),
  ]);
  const repeat = 17, values = [], lattice = 4;
  for (let x = 0; x < repeat; x++) for (let y = 0; y < repeat; y++) for (let z = 0; z < repeat; z++)
    for (const [dx, dy, dz] of [[0,0,0], [0,.5,.5], [.5,0,.5], [.5,.5,0]]) values.push((x+dx)/repeat, (y+dy)/repeat, (z+dz)/repeat);
  const fractional = Float64Array.from(values), cell = createCell({ vectors: [68,0,0,0,68,0,0,0,68] });
  const frame = { fractional, cell, positions: fractionalToCartesian(fractional, cell), types: new Uint16Array(values.length / 3),
    ids: Uint32Array.from({ length: values.length / 3 }, (_, index) => index + 1), typeLabels: ['Al'], properties: [], geometryRevision: 0 };
  const pool = new AnalysisPool({ cpuBudget: new CpuBudget({ environment: { navigator: { hardwareConcurrency: 8 } } }) });
  const backend = pool.gpuBackend, analyzeGpu = backend.analyze.bind(backend); let cnaAttempts = 0;
  backend.analyze = (input, parameters, ...rest) => { if (parameters.kind === 'cna') cnaAttempts++; return analyzeGpu(input, parameters, ...rest); };
  pool.setGpuEnabled(true);
  const p = { kind: 'rdf', cutoff: 3.2, bins: 24 }, expected = calculateRdf(frame, p), calibration = [];
  let exactHistograms = true;
  const same = (a, b) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  try {
    for (let index = 0; index < 7; index++) {
      const result = await pool.analyze(frame, p);
      exactHistograms &&= same(result.counts, expected.counts) && same(result.values, expected.values);
      calibration.push({ backend: result.backend, elapsedMs: result.elapsedMs, routeReason: result.routeReason ?? null, fallbackReason: result.fallbackReason ?? null });
    }
    const worker = backend.worker, release = pool.beginRoutingBatch();
    let batchPinned, cachedBackendRejected;
    try {
      const first = await pool.analyze(frame, p), changed = await pool.analyze(frame, { ...p, bins: 25 });
      const nestedRelease = pool.beginRoutingBatch();
      try {
        const nested = await pool.analyze(frame, { ...p, bins: 26 });
        batchPinned = first.backend === changed.backend && first.backend === nested.backend;
      } finally { nestedRelease(); }
      cachedBackendRejected = !pool.canReuseRoutingResult(frame, p, { backend: first.backend === 'gpu' ? 'cpu' : 'gpu' });
    } finally { release(); }
    // A complete ideal shell at its exact distance flags every local graph
    // for precision recovery. More than 16,384 cells is an explicit,
    // input-dependent refusal, rather than a cell/cutoff capability refusal.
    const cna = { kind: 'cna', mode: 'fixed', cutoff: lattice / Math.SQRT2 };
    const first = await pool.analyze(frame, cna), firstRefusalAttempts = cnaAttempts;
    const repeated = await pool.analyze(frame, cna), repeatRefusalAttempts = cnaAttempts;
    if (!repeated.fallbackCached) throw new Error(`Content refusal was not remembered: ${JSON.stringify({ code: first.fallbackCode, reason: first.fallbackReason })}`);
    await pool.invalidateGpuFrame(frame);
    const revised = await pool.analyze(frame, cna), revisionRetryAttempts = cnaAttempts;
    if (revised.fallbackCached) throw new Error('A changed input revision must retry the GPU kernel.');
    const retainedGpuWorker = backend.worker === worker;
    const sourceArraysRetained = frame.fractional === fractional && fractional.length === values.length && frame.ids.length === values.length / 3;
    return { production, atoms: frame.ids.length, cpuLimit: pool.limit, calibration, profiles: pool.gpuRoutingStatus,
      exactHistograms, batchPinned, cachedBackendRejected, firstRefusalAttempts, repeatRefusalAttempts,
      revisionRetryAttempts, refusalCode: first.fallbackCode, retainedGpuWorker, sourceArraysRetained, releasedCpuPermits: pool.cpuBudget.active };
  } finally { pool.close(); }
}
