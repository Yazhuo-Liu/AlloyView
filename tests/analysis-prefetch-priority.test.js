import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';
import { crystalFrame } from './helpers/crystals.js';

const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };

function queuedPool() {
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 } },
    workerFactory: () => { throw new Error('No task in this admission test should allocate a Worker.'); } });
  pool.pump = () => {};
  pool.analyzeWithProgress = async function(frame, parameters, { signal }) {
    if (parameters.foreground) return { engine: 'foreground', backend: 'cpu' };
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await this.runTask({ kind: parameters.kind, cpuFrameKey: 1 }, controller.signal, signal);
    } finally { signal.removeEventListener('abort', abort); }
  };
  return pool;
}

test('ordinary foreground calculation cancels queued predictions before admitting its own work', async () => {
  const pool = queuedPool(), source = new AbortController();
  try {
    const prediction = pool.analyze({}, { kind: 'cna' }, { background: true, signal: source.signal });
    const rejected = assert.rejects(prediction, { name: 'AbortError' });
    await flush(); assert.equal(pool.queue.length, 1); assert.equal(pool.queue[0].payload.cpuPriority, -2);
    const foreground = await pool.analyze({}, { kind: 'coordination', foreground: true });
    assert.equal(foreground.engine, 'foreground'); await rejected;
    assert.equal(pool.backgroundAnalyses.size, 0); assert.equal(pool.cpuBudget.active, 0);
  } finally { pool.close(); }
});

test('promoting a prediction updates queued CPU priority and keeps the same task alive', async () => {
  const pool = queuedPool(), source = new AbortController();
  try {
    const prediction = pool.analyze({}, { kind: 'ptm' }, { background: true, signal: source.signal });
    await flush(); const task = pool.queue[0]; assert.equal(task.payload.cpuPriority, -2);
    assert.equal(pool.promoteAnalysis(source.signal), true);
    assert.equal(task.payload.cpuPriority, 0); assert.equal(task.signal.aborted, false);
    await pool.analyze({}, { kind: 'coordination', foreground: true });
    assert.equal(task.signal.aborted, false, 'another foreground request does not cancel the promoted owner');
    pool.queue.splice(pool.queue.indexOf(task), 1);
    pool.finish(task, null, { engine: 'same-task', backend: 'cpu' });
    assert.equal((await prediction).engine, 'same-task');
  } finally { pool.close(); }
});

test('speculative GPU analyses do not preempt preparation and can be promoted in place', async () => {
  const client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } },
    workerFactory: () => { throw new Error('No queued-only task should allocate a GPU Worker.'); } });
  client.pump = () => {};
  let preparationPreemptions = 0;
  client.preemptPreparation = () => { preparationPreemptions++; };
  const controller = new AbortController(), frame = crystalFrame('fcc', 1);
  const warmup = client.warmup(); warmup.catch(() => {});
  const prediction = client.analyze(frame, { kind: 'coordination', cutoff: 3 }, { signal: controller.signal, priority: 3 });
  prediction.catch(() => {});
  try {
    assert.equal(preparationPreemptions, 0);
    assert.deepEqual(client.queue.map(task => task.priority), [2, 3]);
    const original = client.queue.find(task => task.type === 'analyze');
    assert.equal(client.promote(controller.signal), true);
    assert.equal(preparationPreemptions, 1); assert.equal(client.queue[0], original); assert.equal(original.priority, 1);
    client.settle(original, null, { engine: 'webgpu' });
    assert.equal((await prediction).engine, 'webgpu');
  } finally { client.close(); await assert.rejects(warmup, { name: 'AbortError' }); }
});
