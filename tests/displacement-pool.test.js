import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { prepareDisplacements, calculatePreparedDisplacements } from '../src/analysis/displacement.js';
import { crystalFrame } from './helpers/crystals.js';

function workerFactory() {
  return () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfer) { worker.postMessage(data, transfer); }, terminate() { worker.terminate(); } };
  };
}

function inputs() {
  const reference = crystalFrame('sc', 38);
  const current = { ...reference, ids: reference.ids.slice(), fractional: reference.fractional.slice(),
    positions: Float64Array.from(reference.positions), unwrappedPositions: Float64Array.from(reference.positions, value => value + 320) };
  reference.unwrappedPositions = Float64Array.from(reference.positions, value => value + 160);
  [current.ids[0], current.ids[1]] = [current.ids[1], current.ids[0]];
  current.ids[current.ids.length - 1] += 100;
  current.unwrappedPositions[current.unwrappedPositions.length - 1] = NaN;
  current.unwrappedPositions[0] += .123456789;
  reference.displayOnlyCallback = () => {};
  return { current, reference };
}

test('displacement GPU fallback computes prepared ranges in copied and shared CPU workers without rematching or detaching inputs', async () => {
  const { current, reference } = inputs();
  const prepared = await prepareDisplacements(current, reference, { minimumImage: false });
  const direct = calculatePreparedDisplacements(current, prepared), original = prepared.currentPositions.slice();
  for (const sharedMemory of [false, true]) {
    let gpuAttempts = 0;
    const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: sharedMemory },
      workerFactory: workerFactory(), gpuBackend: { supports: kind => kind === 'displacement', close() {},
        async analyze() { gpuAttempts++; throw new Error('Simulated Cartesian GPU allocation limit'); } } });
    pool.setGpuEnabled(true);
    const progress = [];
    try {
      const result = await pool.analyze(current, { kind: 'displacement', ...prepared, referenceFrameIndex: 0 },
        { frameIndex: 1, onProgress: update => progress.push(update) });
      assert.equal(gpuAttempts, 1); assert.equal(result.backend, 'cpu'); assert.equal(result.gpuRequested, true);
      assert.match(result.fallbackReason, /Cartesian GPU allocation limit/);
      assert.equal(result.workerCount, 2); assert.equal(result.sharedMemory, sharedMemory);
      assert.deepEqual(result.vectors, direct.vectors); assert.deepEqual(result.magnitudes, direct.magnitudes);
      assert.equal(result.matched, current.ids.length - 1); assert.equal(result.unmatched, 1);
      assert.strictEqual(result.referenceMapping, prepared.referenceMapping);
      assert.equal(result.mappingMode, 'id'); assert.equal(result.minimumImage, false);
      assert.deepEqual(prepared.currentPositions, original);
      assert.ok(prepared.referenceMapping.byteLength > 0);
      assert.equal(progress.at(-1).completedAtoms, current.ids.length);
      assert.equal(pool.active.size, 0);
    } finally { pool.close(); }
  }
});

test('CPU displacement cancellation terminates active worker ranges and allows following prepared jobs to finish', async () => {
  const { current, reference } = inputs(), prepared = await prepareDisplacements(current, reference);
  const small = crystalFrame('fcc', 1), nextParameters = await prepareDisplacements(small, small);
  const controller = new AbortController();
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 2 } }, workerFactory: workerFactory() });
  let checkpoint = false;
  try {
    const first = pool.analyze(current, { kind: 'displacement', ...prepared }, { signal: controller.signal, onProgress(update) {
      if (update.phase === 'analyzing' && update.completedAtoms > 0) { checkpoint = true; controller.abort(); }
    } });
    const cancellation = assert.rejects(first, { name: 'AbortError' });
    const next = pool.analyze(small, { kind: 'displacement', ...nextParameters });
    await cancellation;
    const result = await next;
    assert.equal(checkpoint, true);
    assert.ok(result.vectors.every(value => value === 0)); assert.ok(result.magnitudes.every(value => value === 0));
    assert.equal(result.matched, 4); assert.equal(pool.active.size, 0); assert.equal(pool.queue.length, 0);
    assert.ok(current.positions.byteLength > 0 && reference.positions.byteLength > 0);
  } finally { pool.close(); }
});
