import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MeasuredGpuRouting } from '../src/analysis/gpu-routing.js';
import { GpuFallbackCache } from '../src/analysis/gpu-fallback-cache.js';
import { gpuInputUnsupported } from '../src/analysis/gpu/runtime.js';
import { crystalFrame } from './helpers/crystals.js';
import { CpuBudget } from '../src/analysis/cpu-budget.js';
import { Worker as NodeWorker } from 'node:worker_threads';
import { analyzeGpuRdf } from '../src/analysis/gpu/rdf.js';
const frame = () => crystalFrame('fcc', 17);
test('routing calibrates without duplicate work and learns either winner with hysteresis', () => {
  const router = new MeasuredGpuRouting(), source = frame(), parameters = { kind: 'centrosymmetry', neighbors: 12 };
  const key = router.key(source, parameters, 6, 0);
  for (const ms of [150, 50, 48]) { assert.equal(router.choose(key, parameters.kind).backend, 'gpu'); router.observe(key, 'gpu', ms); }
  for (const ms of [200, 15, 17]) { assert.equal(router.choose(key, parameters.kind).backend, 'cpu'); router.observe(key, 'cpu', ms); }
  assert.equal(router.choose(key, parameters.kind).backend, 'cpu');
  for (let i = 0; i < 7; i++) { router.observe(key, 'gpu', 5); router.observe(key, 'cpu', 30); }
  assert.equal(router.choose(key, parameters.kind).backend, 'gpu');
  assert.equal(router.status()[0].cpuSamples, 7);
  assert.notEqual(router.key(source, { ...parameters, neighbors: 8 }, 6, 0), key);
  assert.notEqual(router.key(source, parameters, 14, 0), key);
  router.key(source, parameters, 6, 1); assert.equal(router.status().length, 0);
});
test('batch backend remains fixed across density/size profiles, small frames and device resets, then unlocks', () => {
  const router = new MeasuredGpuRouting(), source = frame(), p = { kind: 'rdf', cutoff: 2 };
  const key = router.key(source, p, 6, 0);
  for (let i = 0; i < 3; i++) { router.choose(key, p.kind); router.observe(key, 'gpu', 40); }
  const end = router.beginBatch(); assert.equal(router.choose(key, p.kind).backend, 'cpu');
  const other = router.key(source, { ...p, cutoff: 3 }, 6, 0);
  assert.equal(router.choose(other, p.kind).backend, 'cpu'); assert.equal(router.choose(null, p.kind).backend, 'cpu');
  router.clear(); assert.equal(router.choose(key, p.kind).backend, 'cpu'); end();
  assert.equal(router.choose(key, p.kind).backend, 'gpu');
});
test('a nested batch keeps its inherited backend after the outer batch closes', () => {
  const router = new MeasuredGpuRouting(), source = frame(), p = { kind: 'rdf', cutoff: 2 };
  const key = router.key(source, p, 6, 0);
  for (let i = 0; i < 3; i++) { router.choose(key, p.kind); router.observe(key, 'gpu', 40); }
  const outer = router.beginBatch(); assert.equal(router.choose(key, p.kind).backend, 'cpu');
  const inner = router.beginBatch(); assert.equal(router.choose(key, p.kind).backend, 'cpu');
  outer(); router.clear(); assert.equal(router.choose(key, p.kind).backend, 'cpu');
  inner(); assert.equal(router.choose(key, p.kind).backend, 'gpu');
});
test('profile keys ignore parameter ordering and reject unsafe metadata without serialization', () => {
  const router = new MeasuredGpuRouting(), source = frame();
  const pairs = [{ first: 2, second: 0, cutoff: 2, toJSON() { throw new Error('Unexpected serialization'); } }];
  const key = router.key(source, { kind: 'bonds', cutoff: 3, pairCutoffs: pairs }, 6, 0);
  assert.equal(key, router.key(source, { pairCutoffs: [{ first: 0, second: 2, cutoff: 2 }], cutoff: 3, kind: 'bonds' }, 6, 0));
  assert.equal(router.key(source, { kind: 'cna', extra: NaN }, 6, 0), null);
  assert.equal(router.key(source, { kind: 'cna', extra: { recursive: source } }, 6, 0), null);
});
test('content refusals require an explicit revision token and expire on in-flight geometry changes', () => {
  const source = crystalFrame('fcc', 2), p = { kind: 'cna', mode: 'adaptive' }; let revision = 1;
  const cache = new GpuFallbackCache({ inputRevisionFor: () => revision });
  const request = cache.request(source, p), error = gpuInputUnsupported('Candidate budget', 'cna-candidate-budget');
  assert.equal(cache.remember(request, error), true); assert.equal(cache.lookup(cache.request(source, p)).fallbackCached, true);
  revision++; assert.equal(cache.lookup(cache.request(source, p)), null); assert.equal(cache.remember(request, error), false);
  const unsafe = new GpuFallbackCache(); assert.equal(unsafe.request(source, p), null);
  error.gpuOutOfMemory = true; assert.equal(cache.remember(cache.request(source, p), error), false);
  assert.equal(cache.request(source, { ...p, structureInput: new Uint8Array(4) }), null);
});

test('the pool applies a measured CPU route exactly once and excludes busy admissions from calibration', async () => {
  let cpu = 0, gpu = 0;
  const backend = { fallbackGeneration: 0, active: [{}], supports: () => true,
    analyze() { gpu++; throw new Error('A chosen CPU route must not dispatch GPU work'); }, close() {} };
  const pool = new AnalysisPool({ gpuBackend: backend }); pool.setGpuEnabled(true);
  const source = frame(), p = { kind: 'centrosymmetry', neighbors: 12 };
  const key = pool.gpuRouting.key(source, p, pool.limit, 0);
  for (let i = 0; i < 3; i++) { pool.gpuRouting.choose(key, p.kind); pool.gpuRouting.observe(key, 'gpu', 40); pool.gpuRouting.observe(key, 'cpu', 10); }
  pool.analyzeCPU = async () => { cpu++; return { engine: 'cpu', centrosymmetry: Float64Array.of(.25) }; };
  try {
    const result = await pool.analyze(source, p);
    assert.equal(result.backend, 'cpu'); assert.match(result.routeReason, /measured/);
    assert.deepEqual(Array.from(result.centrosymmetry), [.25]); assert.deepEqual([cpu, gpu], [1,0]);
    assert.equal(pool.gpuRoutingStatus[0].cpuSamples, 3, 'busy GPU admission does not bias the cost model');
  } finally { pool.close(); }
});

test('busy admission defers CPU calibration and sparse rechecks while retaining batch pins and learned winners', async () => {
  const source = frame(), p = { kind: 'centrosymmetry', neighbors: 12 };
  for (const busyKind of ['cpu', 'gpu']) {
    let gpuCalls = 0, cpuCalls = 0;
    const backend = { supports: () => true, close() {}, active: busyKind === 'gpu' ? [{}] : [],
      async analyze() { gpuCalls++; return { centrosymmetry: Float64Array.of(.25), engine: 'webgpu' }; } };
    const pool = new AnalysisPool({ gpuBackend: backend }); pool.setGpuEnabled(true);
    pool.analyzeCPU = async () => { cpuCalls++; return { centrosymmetry: Float64Array.of(.25), engine: 'cpu' }; };
    const key = pool.gpuRouting.key(source, p, pool.limit, 0);
    for (let i = 0; i < 3; i++) { pool.gpuRouting.choose(key, p.kind); pool.gpuRouting.observe(key, 'gpu', 40); }
    const lease = busyKind === 'cpu' ? await pool.cpuBudget.acquire() : null;
    try {
      for (let i = 0; i < 3; i++) assert.equal((await pool.analyze(source, p)).backend, 'gpu');
      assert.deepEqual([gpuCalls, cpuCalls], [3, 0], 'busy requests cannot consume untrainable CPU probes');
      const releaseBatch = pool.beginRoutingBatch();
      assert.equal(pool.canReuseRoutingResult(source, p, { backend: 'gpu' }), true, 'cache checks use the same probe gate');
      lease?.release(); backend.active = [];
      assert.equal((await pool.analyze(source, p)).backend, 'gpu', 'the first batch pin survives later idle admission');
      releaseBatch();
      assert.equal((await pool.analyze(source, p)).backend, 'cpu', 'calibration resumes when a new unpinned request is idle');
      const profile = pool.gpuRouting.profiles.get(key);
      profile.gpu = [40, 40, 40]; profile.cpu = [10, 10, 10]; profile.runs = 32;
      assert.equal(pool.gpuRouting.choose(key, p.kind, { allowProbe: false }).backend, 'cpu', 'busy admission keeps the learned winner');
      assert.equal(pool.gpuRouting.choose(key, p.kind).backend, 'gpu', 'idle admission permits its sparse alternate recheck');
      const pinned = pool.beginRoutingBatch();
      assert.equal(pool.gpuRouting.choose(key, p.kind).backend, 'gpu');
      assert.equal(pool.gpuRouting.choose(key, p.kind, { allowProbe: false }).backend, 'gpu', 'an existing probe batch stays pinned');
      pinned();
    } finally { lease?.release(); pool.close(); }
  }
});

test('timing samples exclude work admitted during a run, late profile resets and final cancellation', async () => {
  const source = frame(), p = { kind: 'rdf', cutoff: 2, bins: 10 };
  for (const scenario of ['overlap', 'reset', 'cancel', 'clean']) {
    const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 4 } } });
    let pool;
    const controller = new AbortController(), backend = { fallbackGeneration: 0, nextId: 1,
      supports: () => true, close() {}, async analyze() {
        this.nextId++;
        if (scenario === 'overlap') { const other = await budget.acquire(); other.release(); }
        if (scenario === 'reset') { pool.gpuRouting.clear(); pool.gpuRouting.choose(pool.gpuRouting.key(source, p, pool.limit, 0), p.kind); }
        return { counts: Float64Array.of(1), engine: 'webgpu' };
      } };
    pool = new AnalysisPool({ cpuBudget: budget, gpuBackend: backend }); pool.setGpuEnabled(true);
    try {
      const originalAnalyze = pool.analyzeWithProgress.bind(pool);
      pool.analyzeWithProgress = async (...args) => {
        const result = await originalAnalyze(...args);
        if (scenario === 'cancel') controller.abort();
        return result;
      };
      const job = pool.analyze(source, p, { signal: controller.signal });
      if (scenario === 'cancel') await assert.rejects(job, { name: 'AbortError' }); else await job;
      assert.equal(pool.gpuRoutingStatus[0].gpuSamples, Number(scenario === 'clean'), scenario);
      assert.equal(budget.admissionObservers.size, 0, 'measurement admission guards never retain a settled job');
    } finally { pool.close(); }
  }
});

test('real CPU calibration admits its own ranges and records one complete result', async () => {
  const source = frame(), p = { kind: 'centrosymmetry', neighbors: 12 }, backend = { supports: () => true, close() {},
    analyze() { throw new Error('Unexpected GPU calibration'); } };
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 5 }, crossOriginIsolated: true }, gpuBackend: backend,
    workerFactory: () => {
      const worker = new NodeWorker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url), { type: 'module' });
      return { addEventListener(name, callback) { worker.on(name, name === 'message' ? data => callback({ data }) : callback); },
        postMessage: (...args) => worker.postMessage(...args), terminate: () => worker.terminate() };
    } });
  pool.setGpuEnabled(true); const key = pool.gpuRouting.key(source, p, pool.limit, 0);
  for (let i = 0; i < 3; i++) { pool.gpuRouting.choose(key, p.kind); pool.gpuRouting.observe(key, 'gpu', 40); }
  try {
    const result = await pool.analyze(source, p);
    assert.equal(result.backend, 'cpu'); assert.equal(result.centrosymmetry.length, source.types.length);
    assert.ok(pool.cpuBudget.admissionRevision > 1, 'real shared-index and central-range permits were admitted');
    assert.equal(pool.gpuRoutingStatus[0].cpuSamples, 1); assert.equal(pool.cpuBudget.admissionObservers.size, 0);
  } finally { pool.close(); }
});

test('RDF diagnostic refusals preserve their revision scope and release every temporary buffer', async () => {
  const source = crystalFrame('fcc', 2);
  for (const flag of [1, 2]) {
    const buffers = [], released = [];
    const runtime = { async prepareNeighbors() { return {}; }, createBuffer() { const b = {}; buffers.push(b); return b; },
      storageBuffer() { return this.createBuffer(); }, neighborBindings(_context, values) { return values; },
      async zeroBuffer() {}, async run() {}, async read(_buffer, Type, length) {
        const result = new Type(length); if (length === 4) result[flag] = 1; return result;
      }, disposeBuffers(values) { released.push(...values); } };
    await assert.rejects(analyzeGpuRdf(runtime, source, { cutoff: 2, bins: 10 }), error => {
      assert.equal(error.name, 'GpuUnavailableError'); assert.equal(error.gpuUnsupportedScope, 'input-revision');
      assert.equal(error.gpuUnsupportedCode, flag === 1 ? 'rdf-correction-budget' : 'rdf-neighbor-budget'); return true;
    });
    assert.deepEqual(released, buffers);
  }
});
