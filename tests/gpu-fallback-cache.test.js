import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { GpuFallbackCache } from '../src/analysis/gpu-fallback-cache.js';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';
import { GpuRuntime, GpuUnavailableError, gpuInputUnsupported } from '../src/analysis/gpu/runtime.js';
import { calculateCoordination } from '../src/analysis/coordination.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

const unsupported = () => new GpuUnavailableError('The periodic image search exceeds the GPU budget.', 'periodic-image-budget');
const parameters = () => ({ kind: 'coordination', cutoff: 3 });
function poolFor(behavior = async () => { throw unsupported(); }) {
  const calls = { gpu: 0, cpu: 0, inputs: [] };
  const backend = { fallbackGeneration: 0, supports: () => true, close() {}, release() {},
    clearFrames() { this.fallbackGeneration++; },
    async analyze(...args) { calls.gpu++; return behavior(...args); } };
  const pool = new AnalysisPool({ gpuBackend: backend });
  pool.analyzeCPU = async (frame, options, { onProgress }) => {
    calls.cpu++; calls.inputs.push(frame); onProgress({ phase: 'complete' });
    return { engine: 'js-worker', coordination: new Uint32Array(frame.types.length) };
  };
  pool.setGpuEnabled(true);
  return { pool, backend, calls };
}

test('explicit geometry refusals skip the next GPU attempt while keeping CPU progress and reason metadata', async () => {
  const { pool, calls } = poolFor(), frame = crystalFrame('bcc', 2);
  try {
    const first = await pool.analyze(frame, parameters()), progress = [];
    const second = await pool.analyze(frame, { cutoff: 3, kind: 'coordination' }, { onProgress: value => progress.push(value) });
    assert.equal(calls.gpu, 1); assert.equal(calls.cpu, 2);
    assert.equal(first.fallbackCached, undefined); assert.equal(second.fallbackCached, true);
    assert.equal(second.fallbackReason, first.fallbackReason); assert.equal(second.fallbackCode, 'periodic-image-budget');
    assert.equal(second.backend, 'cpu'); assert.equal(second.gpuRequested, true);
    assert.equal(progress.at(-1).fallbackCached, true); assert.equal(progress.at(-1).fallbackReason, second.fallbackReason);
  } finally { pool.close(); }
});

test('single-frame invalidation retries that input without forgetting another frame refusal', async () => {
  const { pool, backend, calls } = poolFor(), first = crystalFrame('bcc', 2), second = crystalFrame('fcc', 2);
  const ids = new WeakMap(); let next = 0, invalidations = 0;
  backend.frameRevision = frame => { if (!ids.has(frame)) ids.set(frame, ++next); return ids.get(frame); };
  backend.invalidateFrame = async frame => { invalidations++; ids.set(frame, ++next); };
  try {
    await pool.analyze(first, parameters()); await pool.analyze(second, parameters());
    assert.equal(pool.gpuFallbacks.size, 2);
    await pool.invalidateGpuFrame(first);
    assert.equal(invalidations, 1); assert.equal(pool.gpuFallbacks.size, 1);
    assert.equal((await pool.analyze(second, parameters())).fallbackCached, true);
    assert.equal((await pool.analyze(first, parameters())).fallbackCached, undefined);
    assert.equal(calls.gpu, 3); assert.equal((await pool.analyze(first, parameters())).fallbackCached, true);
  } finally { pool.close(); }
});

test('a GPU input token changed during a failed attempt cannot memorize its obsolete refusal', async () => {
  let reject, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { pool, backend } = poolFor(async () => { started(); return new Promise((_resolve, fail) => { reject = fail; }); });
  const frame = crystalFrame('bcc', 2); let revision = 1;
  backend.frameRevision = () => revision;
  try {
    const pending = pool.analyze(frame, parameters()); await ready;
    revision++; reject(unsupported()); await pending;
    assert.equal(pool.gpuFallbacks.size, 0);
  } finally { pool.close(); }
});

test('source, device recovery, explicit GPU toggles, frame revisions and bounded cell mutations permit retry', async () => {
  const { pool, backend, calls } = poolFor(), frame = crystalFrame('bcc', 2);
  const mutations = [
    () => pool.clearGpuFrames(), () => pool.clearCpuFrames(), () => pool.releaseGpuResources(),
    () => { backend.fallbackGeneration++; }, () => { pool.setGpuEnabled(false); pool.setGpuEnabled(true); },
    () => { frame.revision = 1; }, () => { frame.cell.vectors[0] *= 1.01; },
    () => { frame.cell.origin[1] = 4; }, () => { frame.cell.pbc[2] = false; },
    () => { frame.fractional = frame.fractional.slice(); }, () => { frame.types = frame.types.slice(); },
  ];
  try {
    await pool.analyze(frame, parameters());
    for (const mutate of mutations) {
      const before = calls.gpu; await mutate();
      await pool.analyze(frame, parameters()); await pool.analyze(frame, parameters());
      assert.equal(calls.gpu, before + 1);
    }
    pool.close(); assert.equal(pool.gpuFallbacks.size, 0);
  } finally { if (!pool.closed) pool.close(); }
});

test('kernel, range and complete element-pair parameters have distinct fallback entries', async () => {
  const { pool, calls } = poolFor(), frame = crystalFrame('fcc', 2);
  try {
    const options = [parameters(), { kind: 'coordination', cutoff: 3, endAtom: 5 }, { kind: 'coordination', cutoff: 2 },
      { kind: 'bonds', cutoff: 3, pairCutoffs: [{ first: 0, second: 1, cutoff: 5 }] },
      { kind: 'bonds', cutoff: 3, pairCutoffs: [{ first: 0, second: 1, cutoff: 4 }] },
      { kind: 'cna', mode: 'fixed', cutoff: 3 }];
    for (const option of options) { await pool.analyze(frame, option); await pool.analyze(frame, option); }
    assert.equal(calls.gpu, options.length); assert.equal(calls.cpu, 2 * options.length);
  } finally { pool.close(); }
});

test('ordinary errors, OOM, device loss, validation and content-dependent refusals are never memorized by message text', async () => {
  const errors = [new Error(unsupported().message), new GpuUnavailableError(unsupported().message),
    Object.assign(unsupported(), { gpuOutOfMemory: true }), Object.assign(unsupported(), { gpuDeviceLost: true }),
    Object.assign(unsupported(), { gpuDeviceUnavailable: true }),
    Object.assign(new GpuUnavailableError('Too many reference environments need exact correction.'), { gpuUnsupportedScope: 'coordinates', gpuUnsupportedCode: 'cell-neighbor-geometry' }),
    new GpuUnavailableError('The neighbor cells are too densely occupied for a bounded GPU dispatch.')];
  for (const error of errors) {
    const { pool, calls } = poolFor(async () => { throw error; }), frame = crystalFrame('bcc', 2);
    try { await pool.analyze(frame, parameters()); await pool.analyze(frame, parameters());
      assert.equal(calls.gpu, 2); assert.equal(pool.gpuFallbacks.size, 0); }
    finally { pool.close(); }
  }
});

test('cancellation and validation errors neither fall back nor create an unsupported entry', async () => {
  for (const error of [new DOMException('cancelled', 'AbortError'), Object.assign(unsupported(), { analysisErrorKind: 'validation' })]) {
    const { pool, calls } = poolFor(async () => { throw error; }), frame = crystalFrame('bcc', 2);
    try { await assert.rejects(pool.analyze(frame, parameters())); assert.equal(calls.cpu, 0); assert.equal(pool.gpuFallbacks.size, 0); }
    finally { pool.close(); }
  }
  const { pool, calls } = poolFor(), frame = crystalFrame('bcc', 2), controller = new AbortController();
  try {
    await pool.analyze(frame, parameters()); controller.abort();
    await assert.rejects(pool.analyze(frame, parameters(), { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls.cpu, 1); assert.equal(calls.gpu, 1);
  } finally { pool.close(); }
});

test('in-flight source or cell changes cannot publish a stale routing entry', async () => {
  let reject, started;
  const ready = new Promise(resolve => { started = resolve; });
  const { pool, calls } = poolFor(async () => { started(); return new Promise((_resolve, fail) => { reject = fail; }); });
  const frame = crystalFrame('bcc', 2);
  try {
    const pending = pool.analyze(frame, parameters()); await ready;
    frame.cell.vectors[0] *= 2; reject(unsupported()); await pending;
    assert.equal(pool.gpuFallbacks.size, 0);
    pool.gpuBackend.analyze = async () => { calls.gpu++; pool.clearGpuFrames(); throw unsupported(); };
    await pool.analyze(frame, parameters()); assert.equal(pool.gpuFallbacks.size, 0);
  } finally { pool.close(); }
});

test('a remembered CPU fallback runs beside independent GPU work without changing its queue or aborting it', async () => {
  const frame = crystalFrame('bcc', 2), independent = crystalFrame('fcc', 2);
  let release, started;
  const running = new Promise(resolve => { started = resolve; });
  const { pool, calls } = poolFor(async source => {
    if (source === frame) throw unsupported();
    started(); return new Promise(resolve => { release = () => resolve({ coordination: new Uint32Array(source.types.length), engine: 'webgpu' }); });
  });
  try {
    await pool.analyze(frame, parameters());
    const pending = pool.analyze(independent, parameters()); await running;
    const cached = await pool.analyze(frame, parameters());
    assert.equal(cached.fallbackCached, true); assert.equal(calls.gpu, 2);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(pool.analyze(frame, parameters(), { signal: abort.signal }), { name: 'AbortError' });
    release(); assert.equal((await pending).backend, 'gpu');
    assert.equal(calls.cpu, 2); assert.equal(calls.gpu, 2);
  } finally { pool.close(); }
});

test('cache admission is bounded, weak and excludes array payloads and adaptive/content-dependent kernels', () => {
  const cache = new GpuFallbackCache(), frame = crystalFrame('bcc', 2), error = unsupported();
  const first = cache.request(frame, parameters()); cache.remember(first, error);
  for (let cutoff = 4; cutoff < 200; cutoff++) cache.remember(cache.request(frame, { kind: 'coordination', cutoff }), error);
  assert.equal(cache.size, 128); assert.equal(cache.lookup(first), null);
  for (const kind of ['ptmNeighbors', 'centrosymmetry', 'strain', 'referenceStrain', 'displacement', 'voronoi']) {
    assert.equal(cache.request(frame, { kind, cutoff: 3 }), null);
  }
  assert.equal(cache.request(frame, { kind: 'cna', mode: 'adaptive', cutoff: 3 }), null);
  assert.equal(cache.request(frame, { ...parameters(), structureInput: new Uint8Array(4) }), null);
  assert.equal(cache.request(frame, { ...parameters(), description: 'x'.repeat(4096) }), null);
  assert.equal(cache.request(frame, { ...parameters(), pairCutoffs: new Array(100).fill(1) }), null);
  const retained = [...cache.entries.keys()][0];
  assert.ok(retained.frame instanceof WeakRef); assert.ok(retained.coordinates instanceof WeakRef);
  assert.equal(Object.values(retained).some(value => ArrayBuffer.isView(value)), false);
  cache.clear(); assert.equal(cache.size, 0);
});

test('runtime emits explicit stable codes before building or dispatching a neighbor index', async () => {
  const runtime = new GpuRuntime(), frame = { fractional: new Float64Array([.1, .1, .5]),
    cell: createCell({ vectors: [2, 0, 0, 0, 2, 0, 0, 0, .012] }) };
  runtime.initialize = async () => {};
  await assert.rejects(runtime.prepareNeighbors(frame, 1.1), error => error.gpuUnsupportedScope === 'cell-cutoff'
    && error.gpuUnsupportedCode === 'periodic-image-budget');
  assert.equal(runtime.indexes.size, 0);
});

test('extreme density refusals are reused only for the same explicitly versioned scientific input', () => {
  const frame = crystalFrame('fcc', 2), options = { kind: 'rdf', cutoff: 3, bins: 20 };
  const error = gpuInputUnsupported('The neighbor cells exceed the GPU traversal safety bound.', 'neighbor-density-budget');
  const unversioned = new GpuFallbackCache();
  assert.equal(unversioned.remember(unversioned.request(frame, options), error), false);
  let revision = 1;
  const cache = new GpuFallbackCache({ inputRevisionFor: () => revision });
  const request = cache.request(frame, options);
  assert.equal(cache.remember(request, error), true);
  assert.equal(cache.lookup(cache.request(frame, options)).fallbackCode, 'neighbor-density-budget');
  revision++;
  assert.equal(cache.lookup(cache.request(frame, options)), null, 'a coordinate edit retries the GPU occupancy check');
  assert.equal(cache.remember(request, error), false, 'a late refusal from the preceding input revision cannot be published');
});

test('cached geometry routing uses present mutable coordinates in a reused real CPU Worker', async () => {
  const { pool, calls } = poolFor();
  delete pool.analyzeCPU;
  let created = 0;
  pool.workerFactory = () => {
    created++; const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    return { addEventListener(name, callback) { worker.on(name, value => callback(name === 'message' ? { data: value } : value)); },
      postMessage(data, transfer) { worker.postMessage(data, transfer); }, terminate() { worker.terminate(); } };
  };
  const frame = { fractional: new Float64Array([.1, .1, .5, .6, .1, .5, .1, .6, .5]), types: new Int32Array(3),
    cell: createCell({ vectors: [2, 0, 0, 0, 2, 0, 0, 0, .012] }) }, options = { kind: 'coordination', cutoff: 1.1 };
  try {
    const first = await pool.analyze(frame, options), workers = [...pool.slots].map(slot => slot.worker);
    frame.fractional[3] = .12; frame.fractional[4] = .11;
    const second = await pool.analyze(frame, options);
    assert.equal(second.fallbackCached, true); assert.equal(calls.gpu, 1); assert.equal(created, 1);
    assert.notDeepEqual(second.coordination, first.coordination);
    assert.deepEqual(second.coordination, calculateCoordination(frame, 1.1).coordination);
    assert.deepEqual([...pool.slots].map(slot => slot.worker), workers);
    frame.fractional[0] = NaN;
    await assert.rejects(pool.analyze(frame, options), /non-finite/);
  } finally { pool.close(); }
});

test('GPU client preserves refusal metadata and invalidates routing generation on loss, clear and release', async () => {
  class FakeWorker {
    constructor() { this.listeners = new Map(); this.messages = []; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    postMessage(data) { this.messages.push(data); }
    terminate() {}
    answer(data) { this.listeners.get('message')({ data }); }
  }
  const workers = [], client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } },
    workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  const wait = async predicate => { for (let index = 0; index < 100 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(predicate()); };
  try {
    const pending = client.analyze(crystalFrame('bcc', 2), parameters());
    await wait(() => workers[0]?.messages.length > 0);
    const error = unsupported(); workers[0].answer({ id: workers[0].messages[0].id, ok: false, name: error.name, error: error.message,
      gpuUnsupportedScope: error.gpuUnsupportedScope, gpuUnsupportedCode: error.gpuUnsupportedCode, gpuOutOfMemory: true });
    await assert.rejects(pending, value => value.gpuUnsupportedScope === 'cell-cutoff'
      && value.gpuUnsupportedCode === 'periodic-image-budget' && value.gpuOutOfMemory);
    const before = client.fallbackGeneration;
    workers[0].answer({ type: 'device-lost', gpuDeviceLost: true });
    assert.equal(client.fallbackGeneration, before + 1);
    await client.clearFrames(); assert.equal(client.fallbackGeneration, before + 2);
    client.release(); assert.equal(client.fallbackGeneration, before + 3);
  } finally { client.close(); }
});
