import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser, useSoftwareAdapter } from './webgpu-browser.mjs';

const production = process.argv.includes('--production');
const report = await withWebGpuBrowser(async ({ evaluate, call, adapter }) => {
  if (production) {
    const origin = await evaluate('location.origin');
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    const deadline = Date.now() + 30_000;
    while (!await evaluate('document.readyState === "complete" && document.querySelector("[data-tool-button=coordination]")')) {
      if (Date.now() > deadline) throw new Error('Production page startup timed out.');
      await delay(25);
    }
    // The application has its own load-time preparation; this isolated pool
    // fixture measures foreground routing and preserves the real Worker APIs.
    await evaluate(`if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true')
      document.getElementById('enable-gpu-computing').click()`);
  }
  return { adapter, ...await evaluate(`(${run.toString()})(${production})`) };
}, { software: useSoftwareAdapter(true) });
assert.equal(report.firstGpuAttempts, 1);
assert.equal(report.repeatGpuAttempts, 1);
assert.equal(report.reusedCpuWorker, true);
assert.equal(report.retainedGpuWorker, true);
assert.equal(report.mutableCpuMatchesOracle, true);
assert.equal(report.toggleRetried, true);
assert.equal(report.deviceReplacementRetried, true);
assert.equal(report.newSourceUsesGpu, true);
assert.equal(report.closedEntries, 0);
console.log(JSON.stringify(report, null, 2));

async function run(production) {
  const base = production ? new URL('./', document.querySelector('script[type=module][src]').src) : new URL('/AlloyView/src/', location.href);
  const [{ AnalysisPool }, { calculateCoordination }, { createCell }] = await Promise.all([
    import(new URL('analysis/analysis-pool.js', base)), import(new URL('analysis/coordination.js', base)), import(new URL('data/model.js', base)),
  ]);
  const pool = new AnalysisPool(), backend = pool.gpuBackend, actualAnalyze = backend.analyze.bind(backend);
  let attempts = 0;
  backend.analyze = (...args) => { attempts++; return actualAnalyze(...args); };
  pool.setGpuEnabled(true);
  const frame = { fractional: new Float64Array([.1, .1, .5, .6, .1, .5, .1, .6, .5]), types: new Int32Array(3),
    typeLabels: ['Type 1'], cell: createCell({ vectors: [2, 0, 0, 0, 2, 0, 0, 0, .012] }) };
  const parameters = { kind: 'coordination', cutoff: 1.1 };
  const compare = (actual, expected) => Array.from(actual).every((value, index) => value === expected[index]);
  const results = [];
  try {
    const first = await pool.analyze(frame, parameters);
    if (first.backend !== 'cpu' || first.fallbackCode !== 'periodic-image-budget') throw new Error(JSON.stringify(first));
    const firstGpuAttempts = attempts, gpuWorker = backend.worker, cpuWorkers = [...pool.slots].map(slot => slot.worker);
    const uploads = pool.gpuCacheStatus.uploadCount;
    const repeated = await pool.analyze(frame, parameters), repeatGpuAttempts = attempts;
    if (!repeated.fallbackCached || repeated.fallbackReason !== first.fallbackReason) throw new Error('Expected an identical remembered geometry refusal.');
    frame.fractional[3] = .12; frame.fractional[4] = .11;
    const changed = await pool.analyze(frame, parameters), oracle = calculateCoordination(frame, parameters.cutoff).coordination;
    if (!changed.fallbackCached || compare(changed.coordination, first.coordination)) throw new Error('Mutable CPU inputs did not change the result.');
    const mutableCpuMatchesOracle = compare(changed.coordination, oracle);
    const retainedGpuWorker = backend.worker === gpuWorker && pool.gpuCacheStatus.uploadCount === uploads;
    const reusedCpuWorker = [...pool.slots].every((slot, index) => slot.worker === cpuWorkers[index]);
    const beforeToggle = attempts;
    pool.setGpuEnabled(false); pool.setGpuEnabled(true);
    const toggled = await pool.analyze(frame, parameters), toggleRetried = attempts === beforeToggle + 1 && !toggled.fallbackCached;
    // Reproduce an idle device-loss notification through the actual listener.
    // The next request must create a new Worker/device without retiring CPUs.
    const beforeLoss = attempts;
    backend.worker.dispatchEvent(new MessageEvent('message', { data: { type: 'device-lost', gpuDeviceLost: true, error: 'Controlled recovery check' } }));
    const recovered = await pool.analyze(frame, parameters);
    const deviceReplacementRetried = attempts === beforeLoss + 1 && backend.worker !== gpuWorker && !recovered.fallbackCached;
    await pool.clearGpuFrames();
    const thick = { ...frame, fractional: frame.fractional.slice(), types: frame.types.slice(),
      cell: createCell({ vectors: [2, 0, 0, 0, 2, 0, 0, 0, 2] }) };
    const gpu = await pool.analyze(thick, parameters);
    const newSourceUsesGpu = gpu.backend === 'gpu' && compare(gpu.coordination, calculateCoordination(thick, parameters.cutoff).coordination);
    for (const value of [first, repeated, changed, toggled, recovered, gpu]) results.push({ backend: value.backend,
      fallbackCode: value.fallbackCode, fallbackCached: Boolean(value.fallbackCached), coordination: Array.from(value.coordination) });
    pool.close();
    return { production, firstGpuAttempts, repeatGpuAttempts, attempts, reusedCpuWorker, retainedGpuWorker,
      mutableCpuMatchesOracle, toggleRetried, deviceReplacementRetried, newSourceUsesGpu,
      closedEntries: pool.gpuFallbacks.size, results };
  } finally { if (!pool.closed) pool.close(); }
}
