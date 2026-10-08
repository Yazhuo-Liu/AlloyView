import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { calculateBondStatistics } from '../src/analysis/bond-statistics.js';
import { calculateCna } from '../src/analysis/cna.js';
import { crystalFrame } from './helpers/crystals.js';

function nodeFactory(stats) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    stats.created += 1;
    return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transferables) { worker.postMessage(data, transferables); },
      terminate() { worker.terminate(); } };
  };
}

test('real CPU workers merge independent bond-statistics ranges and reuse the existing Bonds pool', async () => {
  const stats = { created: 0 };
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 } }, workerFactory: nodeFactory(stats) });
  const frame = crystalFrame('fcc', 11), parameters = { cutoff: 3, lengthBins: 53, angleBins: 71 };
  const original = frame.fractional.slice();
  try {
    const bonds = await pool.analyze(frame, { kind: 'bonds', cutoff: 3 });
    assert.equal(bonds.workerCount, 2);
    const created = stats.created, progress = [];
    const result = await pool.analyze(frame, { kind: 'bondStatistics', ...parameters }, { onProgress: update => progress.push(update) });
    const direct = calculateBondStatistics(frame, parameters);
    assert.equal(result.backend, 'cpu');
    assert.equal(result.workerCount, 2);
    assert.equal(stats.created, created, 'both metrics tasks use Workers already used by Bonds');
    for (const name of ['coordination', 'q4', 'q6', 'lengthCounts', 'angleCounts']) assert.deepEqual(result[name], direct[name], name);
    assert.equal(result.lengthDistribution.total, bonds.count);
    assert.equal(result.statistics.angle.count, direct.statistics.angle.count);
    assert.equal(progress.at(-1).completedAtoms, frame.types.length);
    assert.ok(progress.every((entry, index) => !index || entry.completedAtoms >= progress[index - 1].completedAtoms));
    assert.deepEqual(frame.fractional, original, 'transfers retain authoritative coordinates');
    assert.equal(pool.idle.length, 2);
  } finally { pool.close(); }
});

test('shared CPU inputs produce the same q/histograms without modifying element arrays', async () => {
  const frame = crystalFrame('bcc', 3), original = frame.types.slice();
  const pool = new AnalysisPool({ environment: { crossOriginIsolated: true }, workerFactory: nodeFactory({ created: 0 }) });
  try {
    const result = await pool.analyze(frame, { kind: 'bondStatistics', cutoff: 4.01 });
    const direct = calculateBondStatistics(frame, { cutoff: 4.01 });
    assert.equal(result.sharedMemory, true);
    for (const name of ['coordination', 'q4', 'q6', 'lengthCounts', 'angleCounts']) assert.deepEqual(result[name], direct[name], name);
    assert.deepEqual(frame.types, original);
  } finally { pool.close(); }
});

test('GPU unavailability keeps bond statistics functional in pure CPU mode', async () => {
  const frame = crystalFrame('sc', 2);
  const pool = new AnalysisPool({ workerFactory: nodeFactory({ created: 0 }), gpuBackend: {
    supports: kind => kind === 'bondStatistics',
    analyze: async () => { throw new Error('Test device does not support WebGPU.'); }, close() {},
  } });
  pool.setGpuEnabled(true);
  try {
    const result = await pool.analyze(frame, { kind: 'bondStatistics', cutoff: 4.01 });
    assert.equal(result.backend, 'cpu');
    assert.equal(result.gpuRequested, true);
    assert.match(result.fallbackReason, /does not support WebGPU/);
    assert.equal(result.lengthDistribution.total, frame.types.length * 3);
  } finally { pool.close(); }
});

test('cancelling heavy bond statistics preserves its Worker while a queued independent CNA completes', async () => {
  const stats = { created: 0 }, controller = new AbortController();
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 2 } }, workerFactory: nodeFactory(stats) });
  let interrupted = false;
  const heavy = pool.analyze(crystalFrame('fcc', 16), { kind: 'bondStatistics', cutoff: 3 }, {
    signal: controller.signal, onProgress(progress) {
      if (progress.completedAtoms > 0 && progress.completedAtoms < progress.totalAtoms) { interrupted = true; controller.abort(); }
    },
  });
  const smallFrame = crystalFrame('bcc', 2), independent = pool.analyze(smallFrame, { kind: 'cna' });
  try {
    const results = await Promise.allSettled([heavy, independent]);
    assert.equal(interrupted, true);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[0].reason.name, 'AbortError');
    assert.equal(results[1].status, 'fulfilled');
    assert.deepEqual(results[1].value.structures, calculateCna(smallFrame).structures);
    assert.equal(stats.created, 1, 'the next job reuses the cancelled bounded Worker');
    assert.equal(pool.active.size, 0);
  } finally { pool.close(); }
});
