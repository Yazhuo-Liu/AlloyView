import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { CpuBudget } from '../src/analysis/cpu-budget.js';
import { calculateVoronoi, VORONOI_FIELDS } from '../src/analysis/voronoi.js';
import { crystalFrame } from './helpers/crystals.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const scientificFields = [...Object.keys(VORONOI_FIELDS), 'faceOffsets', 'faceAreas', 'faceOrders',
  'faceNeighbors', 'faceBoundary', 'faceAccepted', 'voronoiIndices'];
const environment = (sharedMemory = false) => ({ navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: sharedMemory });

function realFactory(stats) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    stats.created++;
    return {
      addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfers) { stats.messages.push(data.kind); worker.postMessage(data, transfers); },
      terminate() { stats.terminated++; worker.terminate(); },
    };
  };
}
function manualFactory(stats) {
  return () => {
    const listeners = new Map(), worker = {
      addEventListener(name, listener) { listeners.set(name, listener); },
      postMessage(data) { stats.messages.push({ worker, data }); },
      reply(data, result) { listeners.get('message')({ data: { id: data.id, ok: true, result } }); },
      terminate() { stats.terminated++; },
    };
    stats.created++; return worker;
  };
}

for (const sharedMemory of [false, true]) test(`background Voronoi preparation retains exact resident inputs (${sharedMemory ? 'shared' : 'private'} memory)`, async () => {
  const stats = { created: 0, terminated: 0, messages: [] };
  const pool = new AnalysisPool({ environment: environment(sharedMemory), workerFactory: realFactory(stats) });
  const frame = crystalFrame('fcc', 6), original = frame.fractional.slice();
  frame.fractional[0] += .002;
  original[0] += .002;
  try {
    const [first, joined] = await Promise.all([pool.prepareCpuFrame(frame), pool.prepareCpuFrame(frame)]);
    assert.equal(first.readyWorkers, 2); assert.equal(joined.frameKey, first.frameKey);
    assert.equal(first.sharedMemory, sharedMemory);
    assert.equal(stats.created, 2); assert.equal(stats.messages.filter(kind => kind === 'voronoiPrepare').length, 2);
    assert.deepEqual(pool.cpuWarmupStatus.readyModules, { voronoi: 2, ptm: 0, dxa: 0 });
    assert.ok([...pool.slots].every(slot => slot.moduleHeapBytes.voronoi >= 16 * 1024 ** 2
      && slot.residentInputBytes >= frame.fractional.byteLength * 2), 'heap and resident-index telemetry cover both native and retained JS memory');
    assert.equal(pool.cpuBudget.active, 0, 'prepared idle Workers retain memory without CPU permits');
    const warm = await pool.warmupCpu({ atomCount: 8192, modules: ['ptm', 'voronoi'] });
    assert.equal(warm.readyWorkers, 2); assert.deepEqual(warm.readyModules, { voronoi: 2, ptm: 2, dxa: 0 });
    const result = await pool.analyzeCPU(frame, { kind: 'voronoi', bins: 19 });
    const direct = await calculateVoronoi(frame, { bins: 19 });
    assert.equal(result.kernelInitializations, 0); assert.equal(result.indexBuilds, 0); assert.equal(result.frameUploads, 0);
    for (const field of scientificFields) assert.deepEqual(result[field], direct[field], field);
    const messages = stats.messages.length;
    await pool.prepareCpuFrame(frame);
    assert.equal(stats.messages.length, messages, 'repeat preparation sends no redundant source/index work');
    assert.equal(stats.created, 2); assert.deepEqual(frame.fractional, original);
    frame.fractional[60] += .003; frame.cell.origin[2] += 7;
    const changed = await pool.prepareCpuFrame(frame);
    assert.notEqual(changed.frameKey, first.frameKey, 'mutable source/cell updates replace the exact snapshot');
    const updated = await pool.analyzeCPU(frame, { kind: 'voronoi' });
    const updatedDirect = await calculateVoronoi(frame);
    assert.equal(updated.indexBuilds, 0); assert.equal(updated.frameUploads, 0);
    for (const field of scientificFields) assert.deepEqual(updated[field], updatedDirect[field], field);
    pool.clearVoronoiFrames();
    assert.ok([...pool.slots].every(slot => slot.residentInputBytes === 0), 'releasing resident coordinates removes their memory reservation');
    assert.equal(pool.cpuWarmupStatus.preparedVoronoiWorkers, 0);
    const rebuilt = await pool.prepareCpuFrame(frame);
    assert.notEqual(rebuilt.frameKey, changed.frameKey);
    assert.equal(stats.created, 2, 'source invalidation releases coordinates/index, retaining native modules');
  } finally { pool.close(); }
});

test('module-aware warmup allocates only requested kernels and rejects unknown module names', async () => {
  const stats = { created: 0, terminated: 0, messages: [] };
  const pool = new AnalysisPool({ environment: environment(), workerFactory: realFactory(stats) });
  try {
    const status = await pool.warmupCpu({ atomCount: 8192, modules: ['voronoi'] });
    assert.equal(status.readyWorkers, 2); assert.deepEqual(status.readyModules, { voronoi: 2, ptm: 0, dxa: 0 });
    await assert.rejects(pool.warmupCpu({ atomCount: 1, modules: [] }), /modules/);
    await assert.rejects(pool.warmupCpu({ atomCount: 1, modules: ['unknown'] }), /modules/);
    const messages = stats.messages.length;
    await pool.warmupCpu({ atomCount: 8192, modules: ['voronoi', 'voronoi'] });
    assert.equal(stats.messages.length, messages);
  } finally { pool.close(); }
});

test('coalescing requested module sets recalculates the native heap memory quota', async () => {
  const stats = { created: 0, terminated: 0, messages: [] };
  const env = { navigator: { hardwareConcurrency: 16 }, performance: { memory: { jsHeapSizeLimit: 256 * 1024 ** 2 } } };
  const pool = new AnalysisPool({ environment: env, workerFactory: realFactory(stats) });
  try {
    const [ptm, voronoi] = await Promise.all([
      pool.warmupCpu({ atomCount: 100_000, modules: ['ptm'] }),
      pool.warmupCpu({ atomCount: 100_000, modules: ['voronoi'] }),
    ]);
    assert.equal(ptm.targetWorkers, 1); assert.equal(voronoi.targetWorkers, 1);
    assert.equal(stats.created, 1, 'the combined 16 MiB + 16 MiB heaps constrain growing shared warmup requests');
    assert.deepEqual(pool.cpuWarmupStatus.readyModules, { voronoi: 1, ptm: 1, dxa: 0 });
  } finally { pool.close(); }
});

test('foreground calculation preempts queued frame preparation and preparation precedes module-only warmup', async () => {
  const stats = { created: 0, terminated: 0, messages: [] }, env = environment();
  const budget = new CpuBudget({ environment: env }), blocker = await budget.acquire(2);
  const pool = new AnalysisPool({ environment: env, cpuBudget: budget, workerFactory: manualFactory(stats) });
  try {
    const frame = crystalFrame('fcc', 6), background = pool.prepareCpuFrame(frame);
    const rejected = assert.rejects(background, { name: 'AbortError' });
    const warming = pool.warmupCpu({ atomCount: 8192 });
    await tick(); await tick();
    const foreground = pool.analyzeCPU(frame, { kind: 'cna' });
    blocker.release();
    while (stats.messages.length < 2) await tick();
    assert.equal(stats.messages[0].data.kind, 'cna');
    assert.ok(stats.messages.every(message => message.data.kind !== 'voronoiPrepare'), 'preempted queued frame jobs never upload coordinates');
    for (const { worker, data } of stats.messages) worker.reply(data, data.kind === 'warmup'
      ? { warmed: true } : { startAtom: 0, structures: new Uint8Array(frame.ids.length).fill(1) });
    await rejected; await foreground;
    // A cold slot used by CNA still needs its first module-only warmup.
    while (stats.messages.length < 3) await tick();
    stats.messages[2].worker.reply(stats.messages[2].data, { warmed: true });
    await warming;
    assert.equal(stats.created, 2);
  } finally { blocker.release(); pool.close(); }
});

test('queued frame preparation has priority over module-only pool growth', async () => {
  const stats = { created: 0, terminated: 0, messages: [] }, env = environment();
  const budget = new CpuBudget({ environment: env }), blocker = await budget.acquire(2);
  const pool = new AnalysisPool({ environment: env, cpuBudget: budget, workerFactory: manualFactory(stats) });
  try {
    const warming = pool.warmupCpu({ atomCount: 8192 });
    const preparing = pool.prepareCpuFrame(crystalFrame('fcc', 6));
    await tick(); await tick(); blocker.release();
    while (stats.messages.length < 2) await tick();
    assert.ok(stats.messages.slice(0, 2).every(({ data }) => data.kind === 'voronoiPrepare'));
    for (const { worker, data } of stats.messages.slice(0, 2)) worker.reply(data,
      { warmed: true, kernelReused: false, indexReused: false, frameUploaded: true });
    await preparing;
    while (stats.messages.length < 4) await tick();
    for (const { worker, data } of stats.messages.slice(2)) worker.reply(data, { warmed: true });
    await warming; assert.equal(stats.created, 2);
  } finally { blocker.release(); pool.close(); }
});

test('an aborted posted preparation preserves its Worker/module/index for the next job', async () => {
  const stats = { created: 0, terminated: 0, messages: [] };
  const pool = new AnalysisPool({ environment: environment(), workerFactory: manualFactory(stats) });
  const frame = crystalFrame('bcc', 3), controller = new AbortController();
  try {
    const preparing = pool.prepareCpuFrame(frame, { signal: controller.signal });
    const rejected = assert.rejects(preparing, { name: 'AbortError' });
    while (!stats.messages.length) await tick();
    const { worker, data } = stats.messages[0];
    assert.equal(data.kind, 'voronoiPrepare'); controller.abort(); await rejected;
    assert.equal(stats.terminated, 0);
    worker.reply(data, { warmed: true, kernelReused: false, indexReused: false, frameUploaded: true });
    await tick();
    const ready = await pool.prepareCpuFrame(frame);
    assert.equal(ready.readyWorkers, 1); assert.equal(stats.messages.length, 1);
    assert.equal(pool.cpuBudget.active, 0); assert.equal(stats.terminated, 0);
  } finally { pool.close(); }
});

test('cancelling a private preparation before upload keeps previously warmed native memory', async () => {
  const stats = { created: 0, terminated: 0, messages: [] };
  const pool = new AnalysisPool({ environment: environment(), workerFactory: manualFactory(stats) });
  try {
    const warming = pool.warmupCpu({ atomCount: 1, modules: ['voronoi'] });
    while (!stats.messages.length) await tick();
    stats.messages[0].worker.reply(stats.messages[0].data, { warmed: true, modules: ['voronoi'] });
    await warming;
    const controller = new AbortController(), frame = crystalFrame('bcc', 3);
    const preparing = pool.prepareCpuFrame(frame, { signal: controller.signal,
      onProgress: progress => { if (progress.phase === 'preparing' && pool.active.size) controller.abort(); } });
    const rejected = assert.rejects(preparing, { name: 'AbortError' });
    await rejected;
    assert.equal(stats.terminated, 0); assert.equal(stats.messages.length, 1);
    assert.equal(pool.cpuWarmupStatus.readyModules.voronoi, 1);
    assert.equal(pool.cpuWarmupStatus.preparedVoronoiWorkers, 0, 'an unposted source was never marked resident');
    assert.equal(pool.cpuBudget.active, 0);
  } finally { pool.close(); }
});

test('clearing a source during preparation discards its eventual coordinates/index while keeping native modules', async () => {
  const stats = { created: 0, terminated: 0, messages: [] };
  const pool = new AnalysisPool({ environment: environment(), workerFactory: manualFactory(stats) });
  const frame = crystalFrame('bcc', 3);
  try {
    const preparing = pool.prepareCpuFrame(frame), rejected = assert.rejects(preparing, { name: 'AbortError' });
    while (!stats.messages.length) await tick();
    const old = stats.messages[0]; pool.clearVoronoiFrames(); await rejected;
    old.worker.reply(old.data, { warmed: true, kernelReused: false, indexReused: false, frameUploaded: true });
    await tick();
    assert.equal(pool.cpuWarmupStatus.preparedVoronoiWorkers, 0);
    assert.equal(pool.cpuWarmupStatus.readyModules.voronoi, 1); assert.equal(stats.terminated, 0);
    const updated = pool.prepareCpuFrame(frame);
    while (stats.messages.filter(({ data }) => data.kind === 'voronoiPrepare').length < 2) await tick();
    const next = stats.messages.find(({ data }) => data.kind === 'voronoiPrepare' && data.id !== old.data.id);
    assert.notEqual(next.data.residentFrameKey, old.data.residentFrameKey);
    assert.ok(next.data.fractional, 'the released source snapshot must be uploaded again');
    next.worker.reply(next.data, { warmed: true, kernelReused: true, indexReused: false, frameUploaded: true });
    await updated; assert.equal(stats.created, 1);
  } finally { pool.close(); }
});

test('source invalidation during a yielding cached-snapshot check cannot revive that source', async () => {
  const pool = new AnalysisPool({ environment: environment(), workerFactory: () => { throw new Error('Snapshot validation creates no Workers.'); } });
  const frame = crystalFrame('bcc', 1);
  frame.fractional = new Float64Array(300_000);
  const scheduler = globalThis.scheduler;
  try {
    await pool.prepareVoronoiSnapshot(frame, false);
    let yielded = false;
    globalThis.scheduler = { yield() { yielded = true; pool.clearVoronoiFrames(); return Promise.resolve(); } };
    await assert.rejects(pool.prepareVoronoiSnapshot(frame, false), { name: 'AbortError' });
    assert.equal(yielded, true); assert.equal(pool.voronoiSnapshot, null);
  } finally {
    if (scheduler === undefined) delete globalThis.scheduler; else globalThis.scheduler = scheduler;
    pool.close();
  }
});

for (const mode of ['modules', 'frame']) test(`background ${mode} retries let ordinary Worker ACK tasks run with a boosted scheduler`, async () => {
  const stats = { created: 0, terminated: 0, messages: [] };
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 5 } }, workerFactory: manualFactory(stats) });
  const scheduler = globalThis.scheduler, signal = new AbortController(), initializationSignal = new AbortController();
  let boostedYields = 0, acknowledged = false, acknowledgement;
  try {
    // Model browser scheduler.yield continuations running ahead of Worker ACK
    // tasks. Abort after a bounded number so a regressed microtask spin fails
    // this assertion instead of hanging the entire Node test process.
    globalThis.scheduler = { yield() {
      if (++boostedYields > 64) signal.abort();
      return Promise.resolve();
    } };
    const frame = crystalFrame('fcc', 8), snapshot = await pool.prepareVoronoiSnapshot(frame, false);
    const slots = Array.from({ length: 3 }, () => pool.createWorker());
    pool.idle.push(...slots);
    Object.assign(slots[0], { ptmWarmed: true, voronoiWarmed: true, voronoiFrameKey: snapshot.key });
    const payload = mode === 'modules' ? { kind: 'warmup', modules: ['voronoi', 'ptm'] }
      : { kind: 'voronoiPrepare', fractional: snapshot.coordinates, cell: snapshot.cell, residentFrameKey: snapshot.key };
    const initialization = Promise.all(Array.from({ length: 2 }, () => pool.runTask(payload,
      initializationSignal.signal, undefined))).catch(error => { if (!pool.closed) throw error; });
    while (stats.messages.length < 2) await tick();
    const initialYields = boostedYields;
    acknowledgement = setTimeout(() => {
      acknowledged = true;
      for (const { worker, data } of stats.messages.slice(0, 2)) worker.reply(data, mode === 'modules'
        ? { warmed: true, modules: ['voronoi', 'ptm'] }
        : { warmed: true, kernelReused: false, indexReused: false, frameUploaded: true });
    }, 15);
    const prepared = await (mode === 'modules'
      ? pool.warmupCpu({ atomCount: 12_288, modules: ['voronoi', 'ptm'], signal: signal.signal })
      : pool.prepareCpuFrame(frame, { signal: signal.signal }));
    await initialization;
    assert.equal(acknowledged, true); assert.equal(prepared.readyWorkers, 3);
    assert.equal(boostedYields, initialYields, 'background retries wait for ordinary tasks, not boosted continuations');
    assert.equal(stats.messages.length, 2, 'already-ready slots need no new worker messages');
    assert.equal(pool.cpuBudget.active, 0);
  } finally {
    clearTimeout(acknowledgement);
    if (scheduler === undefined) delete globalThis.scheduler; else globalThis.scheduler = scheduler;
    pool.close();
  }
});
