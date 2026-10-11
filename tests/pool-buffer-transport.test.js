import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { calculateReferenceStrain, REFERENCE_STRAIN_FIELDS } from '../src/analysis/reference-strain.js';
import { finalizeLocalShear } from '../src/analysis/local-shear.js';
import { crystalFrame } from './helpers/crystals.js';

function realPool(sharedMemory, cores, posted) {
  const stats = { created: 0, terminated: 0 };
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: cores }, crossOriginIsolated: sharedMemory },
    workerFactory() {
      const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url)); stats.created++;
      return {
        addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
        postMessage(data, transfers) { posted(data); worker.postMessage(data, transfers); },
        terminate() { stats.terminated++; worker.terminate(); },
      };
    } });
  return { pool, stats };
}

test('reference Workers share exact wrapped geometry and inverse IDs without changing image-bearing inputs', async () => {
  const reference = crystalFrame('fcc', 11), frame = { ...reference, fractional: reference.fractional.slice(),
    cell: { ...reference.cell, vectors: reference.cell.vectors.slice(), pbc: [true, false, true] } };
  reference.cell = { ...reference.cell, pbc: [true, false, true] };
  frame.fractional[0] = -0; frame.fractional[1] = -.2; frame.fractional[2] += 2;
  frame.cell.vectors[0] *= 1.1;
  const mapping = Int32Array.from(frame.ids, (_, atom) => atom);
  mapping[17] = -1;
  const parameters = { kind: 'referenceStrain', referenceFractional: reference.fractional,
    referenceCell: reference.cell, referenceMapping: mapping, cutoff: 3 };
  const expected = calculateReferenceStrain(frame, parameters), original = frame.fractional.slice();
  for (const shared of [false, true]) {
    const currentBuffers = new Set(), inverseBuffers = new Set();
    const { pool } = realPool(shared, 4, data => {
      if (data.kind !== 'referenceStrain') return;
      if (data.referenceCurrentFractional) {
        assert.ok(data.referenceCurrentFractional.buffer instanceof SharedArrayBuffer);
        assert.ok(Object.is(data.referenceCurrentFractional[0], 0));
        assert.equal(data.referenceCurrentFractional[1], -.2);
        currentBuffers.add(data.referenceCurrentFractional.buffer);
      }
      if (data.referenceInverseMapping) {
        assert.ok(data.referenceInverseMapping.buffer instanceof SharedArrayBuffer);
        assert.equal(data.referenceInverseMapping[17], -1);
        inverseBuffers.add(data.referenceInverseMapping.buffer);
      }
    });
    try {
      const result = await pool.analyzeCPU(frame, parameters);
      assert.equal(result.workerCount, 2);
      for (const name of REFERENCE_STRAIN_FIELDS) assert.deepEqual(result[name], expected[name], name);
      assert.equal(currentBuffers.size, shared ? 1 : 0);
      assert.equal(inverseBuffers.size, shared ? 1 : 0);
      assert.deepEqual(frame.fractional, original);
      assert.ok(result.memoryEstimateBytes <= result.memoryBudgetBytes);
      assert.equal(pool.active.size, 0);
    } finally { pool.close(); }
  }
});

test('reference shared preparation preserves Float32 source support with one Float64 normalized table', async () => {
  const reference = crystalFrame('fcc', 3), frame = { ...reference, fractional: Float32Array.from(reference.fractional) };
  reference.fractional = Float32Array.from(reference.fractional);
  frame.fractional[0] = .01;
  const original = frame.fractional.slice();
  const parameters = { kind: 'referenceStrain', referenceFractional: reference.fractional, referenceCell: reference.cell,
    referenceMapping: Int32Array.from(frame.ids, (_, atom) => atom), cutoff: 3 };
  const expected = calculateReferenceStrain(frame, parameters);
  for (const shared of [false, true]) {
    const { pool } = realPool(shared, 4, data => {
      if (data.kind === 'referenceStrain' && shared) assert.ok(data.referenceCurrentFractional instanceof Float64Array);
    });
    try {
      const result = await pool.analyzeCPU(frame, parameters);
      for (const name of REFERENCE_STRAIN_FIELDS) assert.deepEqual(result[name], expected[name], name);
      assert.deepEqual(frame.fractional, original);
    } finally { pool.close(); }
  }
});

test('private local-shear finalization transfers each row once even when several chunks reuse one Worker', async () => {
  const frame = crystalFrame('sc', 50), count = frame.ids.length;
  const metrics = Float64Array.from({ length: count * 6 }, (_, index) => (index % 11 - 3) / 7);
  const original = metrics.slice();
  const parameters = { kind: 'localShearFinalize', metricInput: metrics, normalization: 1.2,
    meanMetric: [.1, -.2, .3, -.4, .5, -.6], subtractMean: true };
  const expected = finalizeLocalShear(metrics, parameters).localShear;
  for (const shared of [false, true]) {
    const ranges = [];
    const { pool, stats } = realPool(shared, 3, data => {
      if (data.kind !== 'localShearFinalize') return;
      ranges.push([data.startAtom, data.endAtom]);
      if (!shared) {
        assert.equal(data.metricStartAtom, data.startAtom);
        assert.equal(data.metricInput.length, (data.endAtom - data.startAtom) * 6);
        assert.equal(data.metricInput[0], original[data.startAtom * 6]);
      }
    });
    try {
      const result = await pool.analyzeCPU(frame, parameters);
      assert.deepEqual(result.localShear, expected);
      assert.equal(ranges.length, 2);
      assert.deepEqual(ranges, [[0, 65_536], [65_536, count]]);
      assert.equal(stats.created, 1); assert.equal(stats.terminated, 0);
      assert.deepEqual(metrics, original);
      assert.equal(pool.active.size, 0);
      await pool.analyzeCPU(crystalFrame('fcc', 2), { kind: 'cna' });
      assert.equal(stats.created, 1, 'the next analysis keeps the same Worker');
    } finally { pool.close(); }
  }
});

test('shared input admission still charges additional private calculation context', () => {
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 16 },
    performance: { memory: { jsHeapSizeLimit: 128 * 1024 ** 2 } } } });
  try {
    const common = [1_000_000, 0, 0, 16 * 1024 ** 2, 4096, [], true];
    const ordinary = pool.cpuResidentWorkerPolicy(...common);
    const privateContext = pool.cpuResidentWorkerPolicy(...common, { privateContextBytes: 16 * 1024 ** 2 });
    assert.ok(privateContext.workerCount < ordinary.workerCount);
    assert.ok(privateContext.memoryEstimateBytes <= privateContext.memoryBudgetBytes);
  } finally { pool.close(); }
});

test('reference source snapshots are charged once while unrelated Worker contexts stay charged and active references stay pinned', async () => {
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 8 } } });
  try {
    for (const shared of [false, true]) {
      pool.cpuSnapshots = [];
      const current = await pool.prepareCpuSnapshot(crystalFrame('fcc', 2), shared);
      const reference = await pool.prepareCpuSnapshot(crystalFrame('fcc', 4), shared);
      const referenceBytes = reference.source.byteLength + reference.coordinates.byteLength
        + reference.sourceTypes.byteLength + reference.types.byteLength;
      assert.equal(pool.cpuRetainedInputBytes(current.key), referenceBytes);
      assert.equal(pool.cpuRetainedInputBytes(current.key, [reference.key]), 0);
      const slot = { terminated: true, residentInputBytes: 1234, residentSharedInputBytes: 0 };
      pool.slots.add(slot);
      assert.equal(pool.cpuRetainedInputBytes(current.key, [reference.key]), 1234,
        'reference exclusion must not hide retained private calculation memory');
      pool.slots.delete(slot);
      const controller = new AbortController();
      controller.cpuFrameKey = current.key;
      controller.cpuFrameKeys = [current.key, reference.key];
      pool.controllers.add(controller);
      pool.trimIdleCpuInputs(current.key);
      assert.ok(pool.cpuSnapshots.includes(reference), 'a live reference index survives memory trimming');
      pool.controllers.delete(controller);
    }
  } finally { pool.close(); }
});
