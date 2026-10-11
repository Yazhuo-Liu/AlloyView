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

test('changed Worker degree keeps atom fields and histograms exact with bounded Float64 moment rounding', async () => {
  const frame = crystalFrame('fcc', 13);
  for (let index = 0; index < frame.fractional.length; index++) frame.fractional[index] += Math.sin(index * .123) * .0003;
  const pools = [3, 8].map(cores => new AnalysisPool({ environment: { navigator: { hardwareConcurrency: cores } },
    workerFactory: nodeFactory({ created: 0 }) }));
  try {
    const parameters = { kind: 'bondStatistics', cutoff: 3, lengthBins: 32, angleBins: 32 };
    const one = await pools[0].analyze(frame, parameters), many = await pools[1].analyze(frame, parameters);
    assert.equal(one.workerCount, 1); assert.equal(many.workerCount, 3);
    for (const name of ['coordination', 'q4', 'q6', 'lengthCounts', 'angleCounts']) assert.deepEqual(many[name], one[name], name);
    for (const name of ['length', 'angle', 'q4', 'q6']) {
      assert.equal(many.moments[name].count, one.moments[name].count);
      for (const field of ['mean', 'm2']) {
        const first = one.moments[name][field], second = many.moments[name][field];
        assert.ok(Math.abs(first - second) <= 1e-12 * Math.max(Math.abs(first), Math.abs(second)), `${name}.${field}`);
      }
    }
    const small = await pools[0].analyze(frame, { kind: 'localShear', cutoff: 3 });
    const large = await pools[1].analyze(frame, { kind: 'localShear', cutoff: 3 });
    assert.deepEqual(large.localShear, small.localShear);
    assert.deepEqual(large.coordination, small.coordination);
    assert.ok(Math.abs(small.normalization - large.normalization) <= 1e-12 * Math.abs(small.normalization));
  } finally { for (const pool of pools) pool.close(); }
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
