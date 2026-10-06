import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Real browser/Worker timing; SwiftShader supplies graphics and the optional
// GPU preparation probe, never a claim about physical GPU performance.
const root = resolve(import.meta.dirname, '..');
const outputArgument = process.argv.indexOf('--output');
const output = (outputArgument >= 0 ? process.argv[outputArgument + 1] : null) || '/tmp/alloyview-voronoi-browser-benchmark.json';
const referenceArgument = process.argv.indexOf('--reference');
const reference = referenceArgument >= 0 ? JSON.parse(await readFile(process.argv[referenceArgument + 1], 'utf8')) : null;
const modes = [{ gpu: false, isolated: false }, { gpu: false, isolated: true }, { gpu: true, isolated: false }]
  .filter(mode => (!process.argv.includes('--cpu-only') || !mode.gpu) && (!process.argv.includes('--gpu-only') || mode.gpu));
const productionBuild = (await readFile(resolve(root, 'dist/index.html'), 'utf8')).match(/name="alloyview-build" content="([^"]+)"/)?.[1] ?? null;
const report = { productionBuild, workingTreeChanged: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  file: 'examples/hea-fcc-screw.dump', atoms: 28_800, graphics: 'SwiftShader', runs: [] };
for (const mode of modes) {
  console.error(`Starting ${mode.gpu ? 'GPU' : 'CPU'} ${mode.isolated ? 'shared' : 'private'} mode`);
  const run = await withWebGpuBrowser(async ({ call, evaluate }) => {
    const stage = name => console.error(`${new Date().toISOString()} ${name}`);
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    stage('Navigate production app');
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function wait(expression, timeout = 120_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(25); }
      throw new Error(`Timed out: ${expression}`);
    }
    await wait('document.readyState==="complete" && !!document.getElementById("file-input")');
    stage('Instrument pool');
    await evaluate(`(${instrument.toString()})()`);
    stage('Set GPU toggle');
    await evaluate(`if(document.getElementById('enable-gpu-computing').getAttribute('aria-pressed')!==${JSON.stringify(String(mode.gpu))})document.getElementById('enable-gpu-computing').click()`);
    stage('Set source file');
    const { root: document } = await call('DOM.getDocument');
    const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector: '#file-input' });
    await evaluate('voronoiTiming.loadStartedAt=performance.now()');
    await call('DOM.setFileInputFiles', { nodeId, files: [resolve(root, report.file)] });
    await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
    stage('Wait source visible');
    await wait('document.getElementById("file-name").textContent==="hea-fcc-screw.dump" && document.getElementById("loading").hidden && !!voronoiTiming.pool');
    await evaluate('voronoiTiming.sourceVisibleAt=performance.now()');
    stage('Wait CPU modules');
    await wait('voronoiTiming.cpuWarms.some(event=>event.complete) && !voronoiTiming.pool.cpuWarmup');
    if (await evaluate('typeof voronoiTiming.pool.prepareCpuFrame==="function"')) {
      stage('Wait CPU resident frame');
      await wait('voronoiTiming.cpuFrames.some(event=>event.complete) && voronoiTiming.cpuFrames.every(event=>event.complete||event.error)');
    }
    if (mode.gpu) {
      await wait('voronoiTiming.pool.gpuCacheStatus?.cachedFrameIndexes?.includes(0)');
      if (await evaluate('"preparedVoronoiFrameIndexes" in voronoiTiming.pool.gpuCacheStatus'))
        await wait('voronoiTiming.pool.gpuCacheStatus.preparedVoronoiFrameIndexes.includes(0)');
    }
    await evaluate('voronoiTiming.backgroundReadyAt=performance.now();voronoiTiming.before={cpu:voronoiTiming.pool.cpuWarmupStatus,gpu:voronoiTiming.pool.gpuCacheStatus,snapshot:!!voronoiTiming.pool.voronoiSnapshot,workers:voronoiTiming.workersCreated};document.querySelector("[data-tool-button=voronoi]").click()');
    // The GPU baseline records load/preparation only. Software-GPU full-cell
    // timings would not quantify a physical adapter's speedup over CPU.
    if (!mode.gpu) for (let repeat = 0; repeat < 1; repeat++) {
      stage('Click Voronoi');
      await evaluate('document.getElementById("run-voronoi").click()');
      await wait(`voronoiTiming.jobs.length===${repeat + 1} && voronoiTiming.jobs[${repeat}].complete`);
      await wait('document.getElementById("voronoi-state").textContent==="Calculated"');
    }
    if (mode.gpu) {
      await wait('voronoiTiming.gpuWarms.some(event=>!event.analysisKinds?.length && event.complete)');
      await evaluate('voronoiTiming.generalGpuReadyAt=performance.now()');
    }
    return evaluate('voronoiTiming.report()');
  }, { software: true, isolated: mode.isolated });
  if (!mode.gpu && run.cpuFrames.length) {
    assert.equal(run.before.cpu.preparedVoronoiWorkers, run.cpuFrames.find(frame => frame.complete)?.status.targetWorkers, 'all admitted CPU slots contain the displayed frame');
    for (const field of ['kernelInitializations', 'indexBuilds', 'frameUploads'])
      assert.equal(run.jobs[0].result[field], 0, `prepared first analysis reuses ${field}`);
  }
  if (reference && !mode.gpu) {
    const previous = reference.runs.find(previous => previous.gpu === mode.gpu && previous.isolated === mode.isolated);
    assert.ok(previous?.jobs[0]?.scientificDigest, 'reference includes the same mode and scientific digest');
    assert.deepEqual(run.jobs[0].scientificDigest, previous.jobs[0].scientificDigest, 'preparation preserves all scientific arrays and face topology exactly');
    run.scientificReferenceMatched = true;
  }
  report.runs.push({ ...mode, ...run });
  console.log(JSON.stringify({ ...mode, ...run }, null, 2));
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(`Saved ${output}`);

async function instrument() {
  const app = document.querySelector('script[type=module]').src;
  const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', app));
  const timing = window.voronoiTiming = { cpuWarms: [], cpuFrames: [], gpuWarms: [], gpuFrames: [], jobs: [], workersCreated: 0, snapshots: [] };
  for (const [name, list] of [['warmupCpu', 'cpuWarms'], ['prepareCpuFrame', 'cpuFrames'], ['warmupGpu', 'gpuWarms'], ['prepareGpuFrame', 'gpuFrames']]) {
    const original = AnalysisPool.prototype[name];
    if (typeof original !== 'function') continue;
    AnalysisPool.prototype[name] = async function(...args) {
      timing.pool = this; const option = name === 'prepareGpuFrame' || name === 'prepareCpuFrame' ? args[1] : args[0];
      const event = { start: performance.now(), complete: false, ...(option?.analysisKinds ? { analysisKinds: option.analysisKinds } : {}), ...(option?.modules ? { modules: option.modules } : {}) }; timing[list].push(event);
      try { const value = await original.apply(this, args); Object.assign(event, { end: performance.now(), complete: true, status: value }); return value; }
      catch (error) { Object.assign(event, { end: performance.now(), error: error.message }); throw error; }
    };
  }
  const create = AnalysisPool.prototype.createWorker;
  AnalysisPool.prototype.createWorker = function(...args) { timing.workersCreated++; return create.apply(this, args); };
  const snapshot = AnalysisPool.prototype.prepareVoronoiSnapshot;
  AnalysisPool.prototype.prepareVoronoiSnapshot = async function(...args) {
    const previous = this.voronoiSnapshot, start = performance.now(), value = await snapshot.apply(this, args);
    timing.snapshots.push({ start, end: performance.now(), reused: previous === value,
      sharedMemory: value.sharedMemory }); return value;
  };
  const analyze = AnalysisPool.prototype.analyze;
  AnalysisPool.prototype.analyze = async function(frame, parameters, options = {}) {
    timing.pool = this;
    if (parameters.kind !== 'voronoi') return analyze.call(this, frame, parameters, options);
    const event = { start: performance.now(), progress: [], complete: false, cpuBefore: this.cpuWarmupStatus, gpuBefore: this.gpuCacheStatus };
    timing.jobs.push(event);
    try {
      const result = await analyze.call(this, frame, parameters, { ...options, onProgress: update => {
        if (event.progress.length < 256) event.progress.push({ time: performance.now(), ...update }); options.onProgress?.(update);
      } });
      Object.assign(event, { end: performance.now(), complete: true, result: Object.fromEntries(['backend', 'engine', 'workerCount', 'sharedMemory', 'elapsedMs', 'kernelInitializations', 'indexBuilds', 'frameUploads', 'chunkCount', 'gpuCorrectedCellCount'].map(name => [name, result[name]])) });
      const digestStarted = performance.now();
      const hash = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), value => value.toString(16).padStart(2, '0')).join('');
      event.scientificDigest = Object.fromEntries(await Promise.all(Object.entries(result).filter(([, value]) => ArrayBuffer.isView(value)).sort(([a], [b]) => a.localeCompare(b)).map(async ([name, value]) =>
        [name, { type: value.constructor.name, length: value.length, hash: await hash(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer) }])));
      if (result.voronoiIndices) event.scientificDigest.voronoiIndices = { length: result.voronoiIndices.length,
        hash: await hash(new TextEncoder().encode(JSON.stringify(result.voronoiIndices)).buffer) };
      event.digestMs = performance.now() - digestStarted;
      return result;
    } catch (error) { Object.assign(event, { end: performance.now(), error: error.message }); throw error; }
  };
  timing.report = () => {
    const origin = timing.loadStartedAt;
    const relative = entries => entries.map(event => ({ ...event, start: event.start - origin, end: event.end - origin }));
    return { hardwareConcurrency: navigator.hardwareConcurrency, isolated: crossOriginIsolated,
      loadVisibleMs: timing.sourceVisibleAt - origin, backgroundReadyMs: timing.backgroundReadyAt - origin,
      ...(timing.generalGpuReadyAt !== undefined ? { generalGpuReadyMs: timing.generalGpuReadyAt - origin } : {}),
      before: timing.before, after: { cpu: timing.pool.cpuWarmupStatus, gpu: timing.pool.gpuCacheStatus, workers: timing.workersCreated },
      cpuWarms: relative(timing.cpuWarms), cpuFrames: relative(timing.cpuFrames), gpuWarms: relative(timing.gpuWarms), gpuFrames: relative(timing.gpuFrames), snapshots: relative(timing.snapshots),
      jobs: timing.jobs.map(event => ({ ...event, start: event.start - origin, end: event.end - origin,
        clickToKernelMs: event.progress.find(update => update.phase === 'analyzing')?.time - event.start,
        clickToResultMs: event.end - event.start, progress: event.progress.map(update => ({ ...update, time: update.time - event.start })) })) };
  };
}
