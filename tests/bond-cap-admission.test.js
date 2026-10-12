import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { calculateBonds } from '../src/analysis/bonds.js';
import { crystalFrame } from './helpers/crystals.js';

function trackedWorkers(stats) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url)), jobs = new Map();
    stats.created++;
    return {
      addEventListener(name, listener) {
        worker.on(name, data => {
          if (name === 'message') {
            const job = jobs.get(data.id);
            if (job?.kind === 'bonds' && data.ok === true) stats.partialCounts.push(data.result.count);
          }
          listener(name === 'message' ? { data } : data);
        });
      },
      postMessage(data, transfers) {
        jobs.set(data.id, data);
        if (data.kind === 'bonds') stats.postedAtoms += data.endAtom - data.startAtom;
        worker.postMessage(data, transfers);
      },
      terminate() { stats.terminated++; void worker.terminate(); },
    };
  };
}

for (const sharedMemory of [false, true]) test(`oversized global bond output stops new ranges and preserves independent jobs (${sharedMemory ? 'shared' : 'private'})`, async () => {
  const stats = { created: 0, terminated: 0, postedAtoms: 0, partialCounts: [] }, frame = crystalFrame('sc', 25);
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: sharedMemory },
    workerFactory: trackedWorkers(stats) });
  try {
    const tooMany = pool.analyze(frame, { kind: 'bonds', cutoff: 4.01, maxBonds: 10_000 });
    const independent = pool.analyze(crystalFrame('fcc', 2), { kind: 'cna' });
    await assert.rejects(tooMany, /Bond output exceeds 10,000 edges; reduce the cutoff\./);
    assert.ok((await independent).structures.every(value => value === 1));
    // Some already posted bounded work can finish after rejection; its ACK
    // must retain the Worker and lease rather than publishing a partial graph.
    const deadline = performance.now() + 5000;
    while (pool.active.size && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(pool.active.size, 0);
    assert.ok(stats.partialCounts.every(count => count <= 10_000), 'every completed range fits the local limit');
    assert.ok(stats.partialCounts.reduce((sum, count) => sum + count, 0) > 10_000, 'the failure comes from the combined graph');
    assert.ok(stats.postedAtoms < frame.types.length / 2, 'the unneeded tail is never posted');
    assert.equal(stats.terminated, 0, 'cancellation retains warm Workers');
    const created = stats.created, small = crystalFrame('sc', 2);
    const recovered = await pool.analyze(small, { kind: 'bonds', cutoff: 4.01 });
    const oracle = calculateBonds(small, { cutoff: 4.01 });
    for (const field of ['indices', 'vectors', 'shifts', 'coordination']) assert.deepEqual(recovered[field], oracle[field], field);
    assert.equal(stats.created, created, 'following jobs reuse the same slots');
    assert.equal(pool.cpuBudget.active, 0);
    assert.equal(pool.queue.length, 0);
  } finally { pool.close(); }
});
