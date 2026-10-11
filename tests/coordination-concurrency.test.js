import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { crystalFrame } from './helpers/crystals.js';

function realPool(sharedMemory, { heapLimit } = {}) {
  const stats = { created: 0, terminated: 0, bytes: 0, peakPermits: 0, holdResults: false, replies: [] };
  stats.releaseResults = () => { stats.holdResults = false; for (const reply of stats.replies.splice(0)) reply(); };
  const environment = { navigator: { hardwareConcurrency: 16 }, crossOriginIsolated: sharedMemory,
    ...(heapLimit ? { performance: { memory: { jsHeapSizeLimit: heapLimit } } } : {}) };
  const pool = new AnalysisPool({ environment, workerFactory() {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url)); stats.created++;
    return {
      addEventListener(name, listener) { worker.on(name, data => {
        const deliver = () => listener(name === 'message' ? { data } : data);
        if (name === 'message' && stats.holdResults && data.ok !== undefined) stats.replies.push(deliver);
        else deliver();
      }); },
      postMessage(data, transfers = []) {
        stats.bytes += transfers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
        stats.peakPermits = Math.max(stats.peakPermits, pool.cpuBudget.active);
        worker.postMessage(data, transfers);
      },
      terminate() { stats.terminated++; worker.terminate(); },
    };
  } });
  return { pool, stats };
}

test('tight-memory retry never releases an acknowledged private frame while its Worker still holds a lease', async () => {
  const frame = crystalFrame('fcc', 31), small = crystalFrame('fcc', 2);
  const { pool, stats } = realPool(false, { heapLimit: 64 * 1024 ** 2 });
  const controller = new AbortController();
  let analyzing;
  const started = new Promise(resolve => { analyzing = resolve; });
  try {
    await pool.analyzeCPU(small, { kind: 'ptm' });
    await pool.analyzeCPU(frame, { kind: 'coordination', cutoff: 3 });
    const snapshot = pool.cpuSnapshots.find(value => value.source === frame.fractional);
    const slot = [...pool.slots][0], bytes = slot.residentInputBytes;
    stats.holdResults = true;
    const leased = pool.runTask({ kind: 'coordination', cutoff: 3, fractional: snapshot.coordinates,
      types: snapshot.types, cell: snapshot.cell, cpuFrameKey: snapshot.key, compactOutput: true,
      startAtom: 0, endAtom: frame.ids.length }, controller.signal, controller.signal,
    phase => { if (phase === 'analyzing') analyzing(); });
    await started;
    await assert.rejects(pool.analyzeCPU(frame, { kind: 'coordination', cutoff: 3 }), /cannot fit/);
    assert.equal(slot.residentInputBytes, bytes); assert.ok(slot.cpuFrameKeys.has(snapshot.key));
    assert.equal(pool.cpuBudget.active, 1); assert.equal(stats.created, 1);
    stats.releaseResults(); await leased;
    const repeated = await pool.analyzeCPU(frame, { kind: 'coordination', cutoff: 3 });
    assert.ok(repeated.coordination.every(count => count === 12));
    assert.equal(stats.created, 1); assert.equal(stats.terminated, 0); assert.equal(pool.cpuBudget.active, 0);
  } finally { stats.releaseResults(); controller.abort(); pool.close(); }
});

function waitForAcknowledgements(pool) {
  if (!pool.active.size) return Promise.resolve();
  return new Promise(resolve => {
    const settled = () => {
      if (pool.active.size) return;
      pool.slotWaiters.delete(settled); resolve();
    };
    pool.slotWaiters.add(settled);
    settled();
  });
}

for (const sharedMemory of [false, true]) {
  test(`120k coordination uses more than three reusable Workers within the core budget (${sharedMemory ? 'shared' : 'copied'})`, async () => {
    const frame = crystalFrame('fcc', 31), { pool, stats } = realPool(sharedMemory);
    const original = frame.fractional.slice();
    try {
      const first = await pool.analyzeCPU(frame, { kind: 'coordination', cutoff: 3 });
      assert.ok(first.workerCount > 3 && first.workerCount <= 14);
      assert.equal(stats.created, first.workerCount);
      assert.ok(stats.peakPermits <= 14); assert.equal(pool.cpuBudget.active, 0);
      assert.ok(first.coordination.every(count => count === 12));
      assert.equal(first.meanCoordination, 12);
      assert.equal(first.acceptedPairs, frame.ids.length * 6);
      const firstBytes = stats.bytes;
      assert.equal(firstBytes, sharedMemory ? 0 : first.workerCount * (frame.fractional.byteLength + frame.types.byteLength));
      const next = await pool.analyzeCPU(frame, { kind: 'coordination', cutoff: 3 });
      assert.deepEqual(next.coordination, first.coordination);
      assert.equal(next.candidatePairs, first.candidatePairs); assert.equal(next.acceptedPairs, first.acceptedPairs);
      assert.equal(stats.bytes, firstBytes); assert.equal(stats.created, first.workerCount); assert.equal(stats.terminated, 0);
      assert.equal(next.frameUploads, 0); assert.equal(next.indexBuilds, 0);
      assert.ok(next.memoryEstimateBytes <= next.memoryBudgetBytes);
      assert.deepEqual(frame.fractional, original); assert.equal(pool.active.size, 0); assert.equal(pool.queue.length, 0);
      const shear = await pool.analyzeCPU(frame, { kind: 'localShearCoordination', cutoff: 3 });
      assert.ok(shear.workerCount > 3 && shear.workerCount <= 14);
      assert.deepEqual(shear.coordination, first.coordination); assert.equal(shear.coordinationSum, frame.ids.length * 12);
    } finally { pool.close(); }
  });

  test(`coordination admission charges a retained Wasm heap under low memory and cancellation keeps its Worker (${sharedMemory ? 'shared' : 'copied'})`, async () => {
    const frame = crystalFrame('fcc', 31), small = crystalFrame('fcc', 2);
    const { pool, stats } = realPool(sharedMemory, { heapLimit: 64 * 1024 ** 2 });
    const controller = new AbortController();
    let checkpoint = false;
    try {
      const fitted = await pool.analyzeCPU(small, { kind: 'ptm' });
      const result = await pool.analyzeCPU(frame, { kind: 'coordination', cutoff: 3 });
      assert.ok(result.memoryEstimateBytes <= result.memoryBudgetBytes);
      assert.equal(result.memoryBudgetBytes, 32 * 1024 ** 2);
      assert.ok(result.coordination.every(count => count === 12));
      if (!sharedMemory) assert.ok(result.workerCount < 4, 'private frame/index copies compete with the retained native heap');
      const created = stats.created;
      const nativeSlot = [...pool.slots].find(slot => slot.ptmWarmed), heapBytes = nativeSlot.moduleHeapBytes.ptm;
      const running = pool.analyzeCPU(frame, { kind: 'coordination', cutoff: 3 }, { signal: controller.signal,
        onProgress(update) {
          if (update.phase === 'analyzing') { checkpoint = true; controller.abort(); }
        },
      });
      const rejected = assert.rejects(running, { name: 'AbortError' });
      await rejected;
      await waitForAcknowledgements(pool);
      const recovered = await pool.analyzeCPU(frame, { kind: 'coordination', cutoff: 3 });
      assert.equal(checkpoint, true); assert.deepEqual(recovered.coordination, result.coordination);
      assert.equal(nativeSlot.moduleHeapBytes.ptm, heapBytes); assert.equal(nativeSlot.ptmWarmed, true);
      // Template admission reserves the possible cold native heap beside the
      // existing warm heap. Restore that headroom before running the fitter.
      pool.environment.performance.memory.jsHeapSizeLimit *= 2;
      const repeatedFit = await pool.analyzeCPU(small, { kind: 'ptm' });
      assert.deepEqual(repeatedFit.deformation, fitted.deformation);
      assert.equal(stats.created, created); assert.equal(stats.terminated, 0);
      assert.equal(pool.cpuBudget.active, 0); assert.equal(pool.cpuBudget.queue.length, 0);
      assert.equal(pool.active.size, 0); assert.equal(pool.queue.length, 0);
    } finally { pool.close(); }
  });
}
