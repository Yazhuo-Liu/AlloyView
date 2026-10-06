import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool, chooseWorkerCount } from '../src/analysis/analysis-pool.js';
import { CpuBudget } from '../src/analysis/cpu-budget.js';
import { calculatePtm, PTM_FIELDS } from '../src/analysis/ptm.js';
import { crystalFrame } from './helpers/crystals.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const environment = cores => ({ navigator: { hardwareConcurrency: cores },
  performance: { memory: { jsHeapSizeLimit: 4 * 1024 ** 3 } } });

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
    const listeners = new Map();
    const worker = {
      addEventListener(name, listener) { listeners.set(name, listener); },
      postMessage(data, transfers) { stats.messages.push({ worker, data, transfers }); },
      reply(data, result) { listeners.get('message')({ data: { id: data.id, ok: true, result } }); },
      terminate() { stats.terminated++; },
    };
    stats.created++;
    return worker;
  };
}

test('CPU count tracks logical cores minus two, atom count and copy memory without a six-worker ceiling', () => {
  assert.equal(chooseWorkerCount(100_000, 1, environment(8), 4_096), 6);
  assert.equal(chooseWorkerCount(100_000, 1, environment(16), 4_096), 14);
  assert.equal(chooseWorkerCount(1, 1, environment(16), 4_096), 1);
  assert.equal(chooseWorkerCount(100_000, 1, environment(1), 4_096), 1);
  assert.equal(chooseWorkerCount(100_000, 1, environment(2), 4_096), 1);
  const memoryLimited = { navigator: { hardwareConcurrency: 16 },
    performance: { memory: { jsHeapSizeLimit: 100 * 1024 ** 2 } } };
  assert.equal(chooseWorkerCount(100_000, 8 * 1024 ** 2, memoryLimited, 4_096), 1);
});

test('real prewarming initializes PTM once, coalesces growth and keeps kernels for new frames', async () => {
  const stats = { created: 0, terminated: 0, messages: [] };
  const pool = new AnalysisPool({ environment: environment(8), workerFactory: realFactory(stats) });
  try {
    const [initial, expanded] = await Promise.all([
      pool.warmupCpu({ atomCount: 4_096 }),
      pool.warmupCpu({ atomCount: 12_288 }),
    ]);
    assert.equal(initial.readyWorkers, 3);
    assert.equal(expanded.readyWorkers, 3);
    assert.equal(stats.created, 3, 'concurrent prefetches share a growing pool');
    assert.equal(stats.messages.filter(kind => kind === 'warmup').length, 3);
    assert.equal(pool.idle.length, 3, 'ACKs precede exposing warm Workers');
    assert.equal(pool.cpuBudget.active, 0, 'standby Workers hold no CPU permits');
    const slots = new Set(pool.slots);
    await pool.warmupCpu({ atomCount: 12_288 });
    assert.equal(stats.messages.filter(kind => kind === 'warmup').length, 3, 'repeat prefetch sends no reinitialization');
    for (const kind of ['fcc', 'bcc']) {
      const frame = crystalFrame(kind, 3);
      const result = await pool.analyze(frame, { kind: 'ptm' });
      const direct = await calculatePtm(frame);
      assert.equal(result.kernelInitializations, 0, 'the first actual fit already has its resident Wasm module');
      for (const field of Object.keys(PTM_FIELDS)) assert.deepEqual(result[field], direct[field], field);
      assert.equal(stats.created, 3);
      assert.deepEqual(new Set(pool.slots), slots, 'loading another frame preserves Worker and Wasm ownership');
    }
    await pool.warmupCpu({ atomCount: 24_576 });
    assert.equal(pool.cpuWarmupStatus.readyWorkers, 6);
    assert.equal(stats.created, 6, 'growth initializes only the missing slots');
    assert.equal(stats.messages.filter(kind => kind === 'warmup').length, 6);
    for (const slot of slots) assert.ok(pool.slots.has(slot));
  } finally { pool.close(); }
  assert.equal(stats.terminated, stats.created);
});

test('sixteen logical cores can prewarm fourteen slots rather than the old fixed six', async () => {
  const stats = { created: 0, terminated: 0, messages: [] };
  const pool = new AnalysisPool({ environment: environment(16), workerFactory: manualFactory(stats) });
  try {
    const warming = pool.warmupCpu({ atomCount: 100_000 });
    let replied = 0;
    while (replied < 14) {
      while (stats.messages.length === replied) await tick();
      assert.ok(stats.messages.length - replied <= 2, 'module startup uses bounded groups');
      for (const { worker, data, transfers } of stats.messages.slice(replied)) {
        assert.equal(data.kind, 'warmup');
        assert.equal(data.fractional, undefined, 'preheat never duplicates a source frame');
        assert.deepEqual(transfers, []);
        worker.reply(data, { warmed: true, kernelReused: false });
        replied++;
      }
    }
    const status = await warming;
    assert.equal(status.readyWorkers, 14);
    assert.equal(status.maximumWorkers, 14);
    assert.equal(stats.created, 14);
  } finally { pool.close(); }
});

test('an aborted warmup waits for its initializing module ACK and retains the useful slot', async () => {
  const stats = { created: 0, terminated: 0, messages: [] };
  const pool = new AnalysisPool({ environment: environment(4), workerFactory: manualFactory(stats) });
  const controller = new AbortController();
  try {
    const warming = pool.warmupCpu({ atomCount: 1, signal: controller.signal });
    const rejected = assert.rejects(warming, { name: 'AbortError' });
    while (!stats.messages.length) await tick();
    controller.abort();
    await rejected;
    assert.equal(stats.terminated, 0, 'cancelling asynchronous module initialization does not discard its memory');
    const { worker, data } = stats.messages[0];
    worker.reply(data, { warmed: true, kernelReused: false });
    await tick();
    assert.equal(pool.cpuWarmupStatus.readyWorkers, 1);
    assert.equal(pool.cpuBudget.active, 0);
    await pool.warmupCpu({ atomCount: 1 });
    assert.equal(stats.messages.length, 1);
    assert.equal(stats.created, 1);
  } finally { pool.close(); }
});

test('foreground computation enters the shared budget ahead of queued preheat, and aborted waiters allocate nothing', async () => {
  const stats = { created: 0, terminated: 0, messages: [] };
  const env = environment(4), cpuBudget = new CpuBudget({ environment: env });
  const blocker = await cpuBudget.acquire(2);
  const pool = new AnalysisPool({ environment: env, cpuBudget, workerFactory: manualFactory(stats) });
  const controller = new AbortController();
  try {
    const warming = pool.warmupCpu({ atomCount: 8_192, signal: controller.signal });
    const rejected = assert.rejects(warming, { name: 'AbortError' });
    await tick();
    assert.equal(stats.created, 0, 'preheat cannot allocate before acquiring a permit');
    const frame = crystalFrame('fcc', 1);
    const computation = pool.analyze(frame, { kind: 'cna' });
    blocker.release();
    while (stats.messages.length < 2) await tick();
    assert.equal(stats.messages[0].data.kind, 'cna', 'foreground has priority over waiting warmup requests');
    assert.equal(cpuBudget.active, 2);
    controller.abort();
    await rejected;
    for (const { worker, data } of stats.messages) worker.reply(data, data.kind === 'warmup'
      ? { warmed: true } : { startAtom: 0, structures: new Uint8Array(frame.ids.length).fill(1) });
    await computation;
    await tick();
    assert.equal(cpuBudget.active, 0);
    assert.equal(cpuBudget.queue.length, 0);
    assert.equal(stats.created, 2, 'the remaining cancelled warmup never creates a third slot');
  } finally { blocker.release(); pool.close(); }
});
