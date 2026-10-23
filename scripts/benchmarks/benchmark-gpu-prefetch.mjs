import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { withWebGpuBrowser, useSoftwareAdapter } from '../lib/webgpu-browser.mjs';

// Actual Worker uploads and retained input bytes; no render/analysis timing.
// Use a common explicit 2 GiB budget so software adapters can reproduce the
// historical full-trajectory policy. Native defaults are reported separately.
const value = (name, fallback) => process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const baseline = value('baseline');
assert.ok(baseline, 'Pass --baseline=/path/to/the/pre-optimization/repository.');
const atoms = Number(value('atoms', 130_000)), frames = Number(value('frames', 160)), trials = Number(value('trials', 3));
assert.ok(Number.isSafeInteger(atoms) && atoms > 0 && atoms <= 150_000);
assert.ok(Number.isSafeInteger(frames) && frames >= 8 && frames <= 160);
assert.ok(Number.isSafeInteger(trials) && trials >= 1 && trials <= 10);
const root = resolve(import.meta.dirname, '../..'), temporary = await mkdtemp(resolve(root, '.benchmark-gpu-prefetch-'));
try {
  await cp(resolve(baseline, 'src'), resolve(temporary, 'src'), { recursive: true });
  const sources = { before: await readFile(resolve(baseline, 'src/analysis/gpu/worker.js'), 'utf8'),
    after: await readFile(resolve(root, 'src/analysis/gpu/worker.js'), 'utf8') };
  const report = await withWebGpuBrowser(async ({ evaluate, call, adapter }) => ({ adapter,
    browser: await call('Browser.getVersion'),
    ...await evaluate(`(${run.toString()})(${JSON.stringify({ sources, atoms, frames, trials,
      bases: { before: `/AlloyView/${basename(temporary)}/src/`, after: '/AlloyView/src/' } })})`, { timeoutMs: 900_000 }),
  }), { software: useSoftwareAdapter(true) });
  for (const sample of report.samples) {
    assert.equal(sample.backgroundReads, sample.version === 'before' ? frames - 1 : 4);
    assert.equal(sample.residentFrames, sample.version === 'before' ? frames : 5);
    assert.equal(sample.hostFrames, sample.version === 'before' ? frames : 1);
    assert.equal(sample.hostInputBytes, (atoms * (Float64Array.BYTES_PER_ELEMENT * 3 + Uint16Array.BYTES_PER_ELEMENT)
      + 12 * Float64Array.BYTES_PER_ELEMENT) * sample.hostFrames);
    assert.equal(sample.residentBytes, atoms * 36 * sample.residentFrames);
    assert.equal(sample.retainedWorkerAndPipelines, true);
  }
  console.log(JSON.stringify({ command: ['node', ...process.argv.slice(1)], baseline: resolve(baseline),
    environment: { node: process.version, platform: process.platform, architecture: process.arch }, ...report }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }

async function run({ sources, atoms, frames: frameCount, trials, bases }) {
  const implementations = {};
  for (const [version, base] of Object.entries(bases)) implementations[version] = {
    ...(await import(base + 'analysis/gpu/client.js')), ...(await import(base + 'data/gpu-prefetch.js')),
    ...(await import(base + 'data/model.js')),
  };
  const urls = {};
  for (const [version, source] of Object.entries(sources)) {
    const base = new URL(bases[version] + 'analysis/gpu/worker.js', location.href);
    let patched = source.replace(/from '([^']+)'/g, (_, path) => `from '${new URL(path, base).href}'`)
      .replace(/import\('([^']+)'\)/g, (_, path) => `import('${new URL(path, base).href}')`);
    // Diagnostic-only hook reads strong input references after each task. It
    // counts distinct buffers, including runtime references, without changing
    // cache policy or retaining the arrays itself. Production has no hook.
    patched += `\nconst originalCacheState = cacheState;
cacheState = function() {
  const value = originalCacheState(), buffers = new Set(), seen = new Set();
  const visit = object => {
    if (!object || typeof object !== 'object' || seen.has(object) || object instanceof GPUBuffer) return;
    seen.add(object);
    if (ArrayBuffer.isView(object)) { buffers.add(object.buffer); return; }
    if (object instanceof Map) { for (const entry of object.values()) visit(entry); return; }
    for (const entry of Object.values(object)) visit(entry);
  };
  visit(frames); visit(runtime.frames);
  return { ...value, cacheStatus: { ...value.cacheStatus,
    measuredHostFrameCount: frames.size,
    measuredHostInputBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0) } };
};\n`;
    urls[version] = URL.createObjectURL(new Blob([patched], { type: 'text/javascript' }));
  }
  const samples = [], nativeBudgets = {};
  try {
    for (let trial = 0; trial < trials; trial++) for (const version of trial % 2 ? ['after', 'before'] : ['before', 'after']) {
      const api = implementations[version], client = new api.GpuAnalysisClient({ workerFactory: () => new Worker(urls[version], { type: 'module' }) });
      let reads = 0;
      const pool = {
        get gpuCacheStatus() { return client.cacheStatus; }, warmupGpu: options => client.warmup(options),
        configureGpuCache: options => client.configureCache(options),
        prepareGpuFrame: (frame, options) => client.prepareFrame(frame, options), clearGpuFrames: () => client.clearFrames(),
      };
      const cell = api.createCell({ vectors: [500, 0, 0, 0, 500, 0, 0, 0, 500] });
      const makeFrame = index => {
        const fractional = new Float64Array(atoms * 3), types = new Uint16Array(atoms);
        // Deterministic regular coordinates; uploading does not build an index.
        for (let atom = 0; atom < atoms; atom++) {
          fractional[atom * 3] = ((atom % 53) + index / 1000) / 53;
          fractional[atom * 3 + 1] = Math.floor(atom / 53) % 53 / 53;
          fractional[atom * 3 + 2] = Math.floor(atom / (53 * 53)) / 53;
          types[atom] = atom % 2;
        }
        return { fractional, types, cell, typeLabels: ['Fe', 'Ni'] };
      };
      const scheduler = new api.GpuPrefetchScheduler({ pool, getFrame: async index => { reads++; return makeFrame(index); },
        yieldBackground: async () => {}, onStatus: status => { if (status?.phase === 'unavailable') throw new Error(status.error); } });
      try {
        // Complete unchanged device/pipeline warmup before measuring uploads.
        await client.warmup();
        nativeBudgets[version] = client.cacheStatus.budgetBytes;
        await client.configureCache({ frameCount, currentIndex: 0, budgetBytes: 2 * 1024 ** 3 });
        const worker = client.worker, pipelineCount = client.cacheStatus.pipelineCount;
        await scheduler.setFrame({ sourceKey: 'memory-benchmark', frameCount, currentIndex: 0, frame: makeFrame(0) });
        const start = performance.now();
        await scheduler.setEnabled(true);
        const elapsedMs = performance.now() - start, status = client.cacheStatus;
        samples.push({ version, trial, elapsedMs, backgroundReads: reads, capacity: status.capacity,
          residentFrames: status.cachedFrameIds.length, residentBytes: status.residentBytes, allocatedBytes: status.allocatedBytes,
          hostFrames: status.measuredHostFrameCount, hostInputBytes: status.measuredHostInputBytes,
          budgetBytes: status.budgetBytes, retainedWorkerAndPipelines: client.worker === worker && client.cacheStatus.pipelineCount === pipelineCount });
      } finally { scheduler.pause(); client.close(); }
      // Let the terminated Worker's device reclaim allocations before the
      // next implementation starts. This wait is outside measured durations.
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally { for (const url of Object.values(urls)) URL.revokeObjectURL(url); }
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  return { atoms, frames: frameCount, trials, nativeBudgets, deviceMemoryGiB: navigator.deviceMemory ?? null,
    commonBudgetBytes: 2 * 1024 ** 3, samples,
    medians: Object.fromEntries(['before', 'after'].map(version => [version, Object.fromEntries(
      ['elapsedMs', 'backgroundReads', 'residentFrames', 'residentBytes', 'hostFrames', 'hostInputBytes'].map(field =>
        [field, median(samples.filter(sample => sample.version === version).map(sample => sample[field]))]))])),
    note: 'Interleaved real browser Worker/WebGPU residency benchmark. A common explicit 2 GiB limit isolates the five-frame policy; native adapter budgets are also shown. Inputs are generated binary64 coordinates and uint16 species. Upload completion excludes rendering, analysis and the normal 40 ms background delay. SwiftShader timing does not predict physical GPU throughput.' };
}
