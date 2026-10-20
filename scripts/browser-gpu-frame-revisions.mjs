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
      if (Date.now() > deadline) throw new Error('Production startup timed out.');
      await delay(25);
    }
    await evaluate(`if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click()`);
  }
  return { adapter, ...await evaluate(`(${run.toString()})(${production})`) };
}, { software: useSoftwareAdapter(true) });
assert.deepEqual(report.initial, [2, 1, 1]);
assert.deepEqual(report.explicitInvalidation, [2, 2, 2]);
assert.deepEqual(report.revisionEdit, [2, 1, 1]);
assert.equal(report.additionalInputUploads, 2);
assert.equal(report.reparsedResidentInput, true);
assert.equal(report.unrelatedFrameRetained, true);
assert.equal(report.retainedWorkerAndPipelines, true);
assert.equal(report.referenceCancelled, true);
assert.equal(report.pendingAfterRecovery, 0);
console.log(JSON.stringify(report, null, 2));

async function run(production) {
  const base = production ? new URL('./', document.querySelector('script[type=module][src]').src) : new URL('/AlloyView/src/', location.href);
  const [{ AnalysisPool }, { createCell }, { calculateCoordination }] = await Promise.all([
    import(new URL('analysis/analysis-pool.js', base)), import(new URL('data/model.js', base)), import(new URL('analysis/coordination.js', base)),
  ]);
  const pool = new AnalysisPool(), client = pool.gpuBackend;
  pool.setGpuEnabled(true);
  const frame = { fractional: new Float64Array([.1, .1, .5, .2, .1, .5, .1, .2, .5]), types: new Int32Array(3),
    typeLabels: ['Type 1'], cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
  const other = structuredClone(frame), parameters = { kind: 'coordination', cutoff: 1.1 };
  const analyze = async (source, options = {}) => {
    const result = await client.analyze(source, parameters, options), expected = calculateCoordination(source, parameters.cutoff).coordination;
    if (result.backend !== 'gpu' || Array.from(expected).some((value, index) => value !== result.coordination[index])) throw new Error('CPU/GPU coordination mismatch');
    return result;
  };
  try {
    await client.configureCache({ frameCount: 2, currentIndex: 0 });
    const initial = Array.from((await analyze(frame, { frameIndex: 0 })).coordination);
    await analyze(other, { frameIndex: 1 });
    const uploads = client.cacheStatus.uploadCount, worker = client.worker, pipelines = client.cacheStatus.pipelineCount, otherId = client.frameRevision(other);
    frame.fractional[3] = .17; frame.fractional[7] = .17;
    await pool.invalidateGpuFrame(frame);
    const explicitInvalidation = Array.from((await analyze(frame, { frameIndex: 0 })).coordination);
    const reparsed = structuredClone(frame);
    const resident = await analyze(reparsed, { frameIndex: 0 }), reparsedResidentInput = resident.inputReused && resident.gpuInputReused;
    reparsed.fractional[3] = .2; reparsed.fractional[7] = .2; reparsed.geometryRevision += 1;
    const revisionEdit = Array.from((await analyze(reparsed, { frameIndex: 0 })).coordination);
    const additionalInputUploads = client.cacheStatus.uploadCount - uploads;
    const retained = await analyze(other, { frameIndex: 1 });
    const unrelatedFrameRetained = !retained.inputReused && retained.gpuInputReused && client.frameRevision(other) === otherId;
    // Cancellation during reference preparation must be AbortError, and the
    // old two-input job must not publish a result after its reference changes.
    const reference = other, mapping = Int32Array.from([0, 1, 2]);
    const pending = client.analyze(reparsed, { kind: 'referenceStrain', cutoff: 1.1, referenceFrame: reference,
      referenceFrameIndex: 1, referenceFractional: reference.fractional, referenceCell: reference.cell,
      referenceMapping: mapping });
    const cancelled = pending.then(() => false, error => { if (error.name !== 'AbortError') throw error; return true; });
    const barrier = client.invalidateFrame(reference), referenceCancelled = await cancelled;
    await barrier; await analyze(reparsed, { frameIndex: 0 });
    return { production, initial, explicitInvalidation, revisionEdit, additionalInputUploads,
      reparsedResidentInput, unrelatedFrameRetained, referenceCancelled,
      retainedWorkerAndPipelines: client.worker === worker && client.cacheStatus.pipelineCount >= pipelines,
      pendingAfterRecovery: client.pending.size, activeAfterRecovery: client.active.length,
      uploadCount: client.cacheStatus.uploadCount, pipelineCount: client.cacheStatus.pipelineCount };
  } finally { pool.close(); }
}
