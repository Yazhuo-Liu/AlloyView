import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool, chooseWorkerCount } from '../src/analysis/analysis-pool.js';
import { cpuMemoryBudget } from '../src/analysis/cpu-memory.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { crystalFrame } from './helpers/crystals.js';
import { assignWignerSeitzSites } from '../src/analysis/wigner-seitz.js';

const MiB = 1024 ** 2, GiB = 1024 ** 3;
const chrome = { navigator: { hardwareConcurrency: 32, deviceMemory: 8 },
  performance: { memory: { jsHeapSizeLimit: 4 * GiB } } };
const firefox = { navigator: { hardwareConcurrency: 32 }, performance: {} };

test('memory hints retain large CPU pools without ignoring fixed outputs or small devices', () => {
  const cases = [
    [chrome, 1_000_000, 16 * MiB, 344_000_000, 30],
    [firefox, 1_000_000, 16 * MiB, 344_000_000, 30],
    [firefox, 2_000_000, 16 * MiB, 688_000_000, 30],
    [{ navigator: { hardwareConcurrency: 8 } }, 1_000_000, 16 * MiB, 344_000_000, 6],
    [{ navigator: { hardwareConcurrency: 4 } }, 1_000_000, 16 * MiB, 128 * MiB, 2],
    [{ navigator: { hardwareConcurrency: 32, deviceMemory: .5 } }, 1_000_000, 16 * MiB, 64 * MiB, 4],
    [{ navigator: { hardwareConcurrency: 32 }, performance: { memory: { jsHeapSizeLimit: 128 * MiB } } },
      1_000_000, 16 * MiB, 16 * MiB, 3],
  ];
  for (const [environment, atoms, perWorker, fixed, expected] of cases) {
    const count = chooseWorkerCount(atoms, perWorker, environment, 4096, { sharedBytes: fixed });
    assert.equal(count, expected);
    assert.ok(fixed + perWorker * count <= cpuMemoryBudget(environment));
  }
  assert.equal(chooseWorkerCount(1, 0, firefox), 1);
  assert.throws(() => chooseWorkerCount(1_000_000, MiB, firefox, 4096, { sharedBytes: 3 * GiB }), /cannot fit.*one Worker/);
  assert.throws(() => chooseWorkerCount(1_000_000, 3 * GiB, firefox), /cannot fit.*one Worker/);
  assert.throws(() => chooseWorkerCount(100, NaN, firefox), /finite and non-negative/);
});

test('private residency drops its second frame only when that preserves more Workers', () => {
  const pool = new AnalysisPool({ environment: firefox });
  try {
    const isolated = pool.cpuResidentWorkerPolicy(1_000_000, 48_000_000, 0, 344_000_000, 4096, ['ptm'], true);
    const privatePolicy = pool.cpuResidentWorkerPolicy(1_000_000, 48_000_000, 0, 344_000_000, 4096, ['ptm'], false);
    assert.equal(isolated.workerCount, 30); assert.equal(isolated.residentFrameLimit, 2);
    assert.equal(privatePolicy.workerCount, 27); assert.equal(privatePolicy.residentFrameLimit, 1);
    for (const result of [isolated, privatePolicy]) assert.ok(result.memoryEstimateBytes <= result.memoryBudgetBytes);
    const small = pool.cpuResidentWorkerPolicy(120_000, 5_760_000, 0, 20_000_000, 4096, ['ptm'], false);
    assert.equal(small.workerCount, 30); assert.equal(small.residentFrameLimit, 2);
  } finally { pool.close(); }
});

test('warmup budgets module allocations and counts grown retained heaps once', () => {
  const pool = new AnalysisPool({ environment: chrome });
  try {
    assert.equal(pool.cpuModuleWorkerCount(1_000_000, 24_000_000, ['ptm']), 30);
    // These slots stand for acknowledged modules. No frame is allocated by
    // module-only warmup, even if the future structure is several million atoms.
    for (let index = 0; index < 30; index++) pool.slots.add({ terminated: true, ptmWarmed: true,
      moduleHeapBytes: { ptm: 32 * MiB } });
    const grown = pool.cpuMemoryWorkerCount(1_000_000, 0, 344_000_000, 4096, ['ptm']);
    assert.equal(grown.workerCount, 30);
    assert.equal(grown.retainedHeapBytes, 960 * MiB);
    assert.equal(grown.memoryEstimateBytes, 344_000_000 + 960 * MiB);
    pool.slots.values().next().value.moduleHeapBytes.ptm = 2 * GiB;
    assert.throws(() => pool.cpuMemoryWorkerCount(1_000_000, 0, 344_000_000, 4096, ['ptm']), /memory budget/);
  } finally { pool.slots.clear(); pool.close(); }
});

test('private normalized coordinates reuse storage while image-bearing, public and shared inputs stay immutable', () => {
  const frame = crystalFrame('bcc', 2);
  frame.cell.pbc = [true, false, true];
  frame.fractional[0] = 2.123456789; frame.fractional[1] = -.25; frame.fractional[2] = -1.3;
  const original = frame.fractional.slice();
  const publicIndex = new NeighborSearch(frame);
  assert.deepEqual(frame.fractional, original);
  const owned = { ...frame, fractional: frame.fractional.slice() };
  const privateIndex = new NeighborSearch(owned, { reuseCoordinates: true });
  assert.notEqual(privateIndex.coordinates, owned.fractional);
  assert.deepEqual(owned.fractional, original);
  assert.deepEqual(privateIndex.exportIndex(), publicIndex.exportIndex());
  assert.equal(owned.fractional[1], -.25, 'open-axis coordinates remain physical');
  for (let atom = 0; atom < frame.ids.length; atom++) assert.deepEqual(privateIndex.nearest(atom, 14), publicIndex.nearest(atom, 14));
  const shared = new Float64Array(new SharedArrayBuffer(original.byteLength)); shared.set(original);
  assert.throws(() => new NeighborSearch({ ...frame, fractional: shared }, { reuseCoordinates: true }), /private Float64/);
  assert.deepEqual(shared, original);
  const normalized = crystalFrame('bcc', 2);
  assert.equal(new NeighborSearch(normalized, { reuseCoordinates: true }).coordinates, normalized.fractional);
  normalized.fractional[0] = -0;
  const zeroIndex = new NeighborSearch(normalized, { reuseCoordinates: true });
  assert.notEqual(zeroIndex.coordinates, normalized.fractional);
  assert.ok(Object.is(normalized.fractional[0], -0)); assert.ok(Object.is(zeroIndex.coordinates[0], 0));
});

function realPool(environment) {
  const stats = { created: 0, terminated: 0 };
  const pool = new AnalysisPool({ environment, workerFactory() {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url)); stats.created++;
    return { addEventListener(name, callback) { worker.on(name, value => callback(name === 'message' ? { data: value } : value)); },
      postMessage(data, transfers) { worker.postMessage(data, transfers); }, terminate() { stats.terminated++; worker.terminate(); } };
  } });
  return { pool, stats };
}

test('CNA cannot remove image coordinates needed by subsequent non-affine Wigner-Seitz analysis', async () => {
  const frame = { ids: Uint32Array.of(1, 2), types: Uint32Array.of(0, 0),
    fractional: Float64Array.of(1.05, .2, .3, .15, .2, .3),
    cell: { vectors: Float64Array.of(11, 0, 0, 0, 10, 0, 0, 0, 10), pbc: [true, true, true], origin: Float64Array.of(0, 0, 0) } };
  const parameters = { kind: 'wignerSeitzAssign', affineMapping: false,
    referenceFractional: Float64Array.of(.05, .2, .3, .15, .2, .3),
    referenceCell: { ...frame.cell, vectors: Float64Array.of(10, 0, 0, 0, 10, 0, 0, 0, 10) } };
  const expected = assignWignerSeitzSites(frame, parameters), original = frame.fractional.slice();
  const { pool } = realPool({ navigator: { hardwareConcurrency: 3 } });
  try {
    await pool.analyzeCPU(frame, { kind: 'cna' });
    const result = await pool.analyzeCPU(frame, parameters);
    assert.deepEqual(result.siteIndex, Int32Array.of(1, 1));
    assert.deepEqual(result.siteIndex, expected.siteIndex); assert.deepEqual(result.siteDistance, expected.siteDistance);
    assert.deepEqual(frame.fractional, original);
  } finally { pool.close(); }
});

test('low-memory frame transitions evict data while preserving private Workers and accurate input accounting', async () => {
  const { pool, stats } = realPool({ navigator: { hardwareConcurrency: 8 },
    performance: { memory: { jsHeapSizeLimit: 2 * MiB } } });
  try {
    let first;
    for (const frame of [crystalFrame('fcc', 11), crystalFrame('bcc', 14)]) {
      const result = await pool.analyzeCPU(frame, { kind: 'cna' });
      assert.equal(result.workerCount, 2); assert.equal(result.residentFrameLimit, 1);
      assert.ok(result.memoryEstimateBytes <= result.memoryBudgetBytes);
      for (const slot of pool.slots) {
        assert.equal(slot.cpuFrameKeys.size, 1); assert.equal(slot.cpuFramePrivateBytes.size, 1);
        assert.equal(slot.residentSharedInputBytes, 0);
        assert.ok(slot.residentInputBytes >= frame.fractional.byteLength + frame.types.byteLength);
        assert.ok(slot.residentInputBytes < 2 * frame.fractional.byteLength + frame.types.byteLength + 20 * frame.ids.length,
          'wrapped index shares the private frame coordinate allocation');
      }
      if (!first) first = new Set(pool.slots);
      else assert.deepEqual(new Set(pool.slots), first);
    }
    assert.equal(stats.created, 2); assert.equal(stats.terminated, 0);
  } finally { pool.close(); }
});

test('memory admission includes inactive old frames and deduplicates shared frame groups', () => {
  const pool = new AnalysisPool({ environment: firefox });
  try {
    pool.slots.add({ terminated: true, residentInputBytes: 600 * MiB, residentSharedInputBytes: 0 });
    pool.slots.add({ terminated: true, residentInputBytes: 800 * MiB, residentSharedInputBytes: 0 });
    const retained = pool.cpuMemoryWorkerCount(1_000_000, 16 * MiB, 344_000_000, 4096);
    assert.equal(retained.retainedInputBytes, 1400 * MiB);
    assert.ok(retained.memoryEstimateBytes <= retained.memoryBudgetBytes);
    pool.slots.add({ terminated: true, residentInputBytes: 800 * MiB });
    assert.throws(() => pool.cpuMemoryWorkerCount(1_000_000, 0, 344_000_000, 4096), /memory budget/);
    pool.slots.clear();
    for (let index = 0; index < 14; index++) pool.slots.add({ terminated: true,
      residentInputBytes: 100 * MiB, residentSharedInputBytes: 100 * MiB, residentSharedGroups: [['frame:77', 100 * MiB]] });
    assert.equal(pool.cpuRetainedInputBytes(), 100 * MiB);
    assert.equal(pool.cpuRetainedInputBytes(77), 0, 'current shared frame already belongs to fixed source/index bytes');
  } finally { pool.slots.clear(); pool.close(); }
});
