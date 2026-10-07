import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { chooseDxaStageWorkers } from '../src/analysis/dxa-cpu-pool.js';
import { calculateDxa, dxaCartesianCoordinates, releaseDxaKernels } from '../src/analysis/dxa.js';
import { calculateDxaLocalRange, releaseDxaCpuStageData } from '../src/analysis/dxa-cpu-stages.js';
import { crystalFrame } from './helpers/crystals.js';
import { fccScrewFrame } from './helpers/dislocations.js';

const environment = { navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: false };
const localInput = (frame = crystalFrame('fcc', 13)) => ({ atomCount: frame.fractional.length / 3,
  coordinates: dxaCartesianCoordinates(frame), cell: frame.cell, lattice: 1, perfectOnly: false });
const tables = count => ({ atomCount: 8192, vertexCount: 4, tetrahedronCount: count, edgeCount: 1, transitionCount: 1,
  vertices: new Float64Array(12), tetrahedra: new Uint32Array(count * 16), edges: new Uint32Array(8),
  transitions: new Float64Array(20), alpha: 10 });

function realFactory(stats) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    stats.created++;
    return {
      addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfers) { stats.messages.push({ kind: data.kind, uploaded: Boolean(data.dxaStageInput) }); worker.postMessage(data, transfers); },
      terminate() { stats.terminated++; void worker.terminate(); },
    };
  };
}
function manualFactory(workers, respond) {
  return () => {
    const listeners = new Map();
    const worker = {
      messages: [], terminated: false,
      addEventListener(name, listener) { listeners.set(name, listener); },
      postMessage(message, transfer = []) {
        const data = structuredClone(message, { transfer }); this.messages.push(data);
        if (data.id) respond?.(worker, data);
      },
      reply(data, result) { listeners.get('message')({ data: { id: data.id, ok: true, result } }); },
      terminate() { this.terminated = true; },
    };
    workers.push(worker); return worker;
  };
}
const goodLocal = data => ({ startAtom: data.startAtom, endAtom: data.endAtom,
  structures: new Int32Array(data.endAtom - data.startAtom).fill(1),
  neighbors: new Int32Array((data.endAtom - data.startAtom) * 12).fill(-1),
  neighborWidth: 12, maxNeighborDistance: 3, kernelReused: !data.dxaStageInput,
  frameUploaded: Boolean(data.dxaStageInput), wasmMemoryBytes: 32 * 1024 ** 2 });

test('CPU stage admission counts actual output chunks and retained grown native heaps', () => {
  const pool = { limit: 8, environment, slots: new Set() }, snapshot = tables(30000);
  assert.equal(chooseDxaStageWorkers(pool, 'tetrahedra', snapshot, { workerCount: 8 }).workerCount, 4);
  assert.throws(() => chooseDxaStageWorkers(pool, 'tetrahedra', tables(8192)), /two parallel/);
  pool.slots.add({ dxaHeapBytes: 1.4 * 1024 ** 3, dxaWarmed: true });
  assert.throws(() => chooseDxaStageWorkers(pool, 'tetrahedra', snapshot), /memory\/concurrency/);
});

test('DXA admission counts fifteen real warmed PTM/Voronoi heaps once and permits both local and interface stages', () => {
  const mib = 1024 ** 2, pool = { limit: 30, environment,
    slots: new Set(Array.from({ length: 15 }, () => ({ ptmWarmed: true, voronoiWarmed: true,
      moduleHeapBytes: { ptm: 17039360, voronoi: 16908288, dxa: 0 }, residentInputBytes: 4 * mib }))) };
  const input = localInput(); input.atomCount = 60229; input.coordinates = new Float64Array(input.atomCount * 3);
  const local = chooseDxaStageWorkers(pool, 'local', input, { workerCount: 15 });
  assert.equal(local.workerCount, 15); assert.ok(local.memoryEstimateBytes <= 1.5 * 1024 ** 3);
  for (const slot of [...pool.slots].slice(0, local.workerCount)) {
    slot.dxaWarmed = true; slot.moduleHeapBytes.dxa = 32 * mib;
  }
  const snapshot = tables(400000); snapshot.atomCount = input.atomCount;
  const classified = chooseDxaStageWorkers(pool, 'tetrahedra', snapshot, { workerCount: 15 });
  assert.ok(classified.workerCount >= 2, 'resident local-stage heaps and complete interface tables must still fit real parallel work');
  assert.ok(classified.memoryEstimateBytes <= 1.5 * 1024 ** 3);
  for (const slot of pool.slots) slot.moduleHeapBytes.voronoi = 128 * mib;
  assert.throws(() => chooseDxaStageWorkers(pool, 'local', input, { workerCount: 2 }), /memory\/concurrency/,
    'actual grown native heaps continue to enforce the total memory budget');
});

test('merged-output allocation failure registers no stage locks, abort listeners or CPU jobs', async () => {
  const pool = new AnalysisPool({ environment, workerFactory: () => { throw new Error('No Worker should be created.'); } });
  const input = localInput(), Type = globalThis.Int32Array, signal = new AbortController().signal;
  try {
    globalThis.Int32Array = class extends Type { constructor() { throw new RangeError('Merged output allocation failed.'); } };
    await assert.rejects(pool.analyzeDxaLocal(input, { signal }), /allocation failed/);
    assert.equal(pool.dxaStages.size, 0); assert.equal(pool.controllers.size, 0);
    assert.equal(pool.cpuBudget.active, 0); assert.equal(pool.active.size, 0);
  } finally { globalThis.Int32Array = Type; pool.close(); }
});

test('pooled CPU ranges upload immutable inputs once per slot, merge all rows, and release stage data', async () => {
  const workers = [], input = localInput(), original = input.coordinates.slice();
  const pool = new AnalysisPool({ environment, workerFactory: manualFactory(workers,
    (worker, data) => setImmediate(() => worker.reply(data, goodLocal(data)))) });
  try {
    const result = await pool.analyzeDxaLocal(input, { workerCount: 2 });
    assert.equal(result.workerCount, 2); assert.equal(result.chunkCount, 5);
    assert.equal(result.structures.length, input.atomCount); assert.ok(result.structures.every(value => value === 1));
    assert.equal(result.neighbors.length, input.atomCount * 12); assert.ok(result.neighbors.every(value => value === -1));
    assert.equal(workers.length, 2);
    assert.equal(workers.flatMap(worker => worker.messages).filter(data => data.dxaStageInput).length, 2);
    assert.equal(result.copiedBytes, result.inputBytes * 2);
    assert.deepEqual(input.coordinates, original);
    assert.ok(workers.every(worker => worker.messages.at(-1).kind === 'dxaRelease'));
    assert.ok([...pool.slots].every(slot => slot.dxaHeapBytes === 32 * 1024 ** 2 && !slot.dxaResidentKey));
    assert.equal(pool.cpuBudget.active, 0);
  } finally { pool.close(); }
});

for (const failure of ['constructor', 'stalled', 'malformed']) {
  test(`CPU stage ${failure} failure joins private jobs, frees permits and permits a fresh retry`, async () => {
    const workers = []; let healthy = false;
    const factory = manualFactory(workers, (worker, data) => {
      if (healthy || failure === 'malformed') setImmediate(() => worker.reply(data,
        healthy ? goodLocal(data) : { ...goodLocal(data), structures: new Int32Array(1) }));
    });
    const pool = new AnalysisPool({ environment, workerFactory: () => {
      if (!healthy && failure === 'constructor') throw new Error('CPU Worker constructor denied.');
      return factory();
    } });
    try {
      await assert.rejects(pool.analyzeDxaLocal(localInput(), { taskTimeoutMs: 25 }),
        failure === 'constructor' ? /constructor denied/ : failure === 'stalled' ? /within 25 ms/ : /invalid local/);
      assert.equal(pool.cpuBudget.active, 0); assert.equal(pool.cpuBudget.queue.length, 0); assert.equal(pool.active.size, 0);
      assert.ok(workers.every(worker => worker.terminated || worker.messages.at(-1).kind === 'dxaRelease'));
      healthy = true;
      const result = await pool.analyzeDxaLocal(localInput(), { taskTimeoutMs: 1000 });
      assert.equal(result.structures.length, 8788); assert.equal(pool.cpuBudget.active, 0);
    } finally { pool.close(); }
  });
}

test('CPU stage abort and throwing progress callbacks cannot strand Worker jobs or leases', async () => {
  const workers = [], controller = new AbortController();
  const pool = new AnalysisPool({ environment, workerFactory: manualFactory(workers) });
  try {
    const pending = pool.analyzeDxaLocal(localInput(), { signal: controller.signal });
    const rejection = assert.rejects(pending, { name: 'AbortError' });
    while (!workers.some(worker => worker.messages.length)) await new Promise(resolve => setImmediate(resolve));
    controller.abort(); await rejection;
    assert.equal(pool.cpuBudget.active, 0); assert.ok(workers.every(worker => worker.terminated));
    await assert.rejects(pool.analyzeDxaLocal(localInput(), { onProgress: () => { throw new Error('Status callback failed.'); } }), /Status callback failed/);
    assert.equal(pool.cpuBudget.active, 0);
  } finally { pool.close(); }
});

test('real CPU Worker local rows match the original native range and reuse prewarmed kernels', async () => {
  const stats = { created: 0, terminated: 0, messages: [] }, input = localInput();
  const pool = new AnalysisPool({ environment, workerFactory: realFactory(stats) });
  try {
    await pool.warmupCpu({ atomCount: input.atomCount, modules: ['dxa'] });
    assert.equal(pool.cpuWarmupStatus.readyModules.dxa, 2);
    assert.ok([...pool.slots].every(slot => slot.moduleHeapBytes.dxa >= 32 * 1024 ** 2));
    const pooled = await pool.analyzeDxaLocal(input, { workerCount: 2 });
    const direct = await calculateDxaLocalRange(input, { residentKey: 'direct-local', startAtom: 0, endAtom: input.atomCount });
    assert.deepEqual(pooled.structures, direct.structures); assert.deepEqual(pooled.neighbors, direct.neighbors);
    assert.equal(pooled.maxNeighborDistance, direct.maxNeighborDistance);
    assert.equal(pooled.kernelInitializations, 0); assert.equal(stats.created, 2);
    assert.equal(stats.messages.filter(message => message.kind === 'dxaLocal' && message.uploaded).length, 2);
    assert.equal(pool.cpuBudget.active, 0);
  } finally { await releaseDxaCpuStageData(); pool.close(); }
});

test('selective DXA warmup initializes its module only and later PTM warmup reuses the same slots', async () => {
  const stats = { created: 0, terminated: 0, messages: [] };
  const pool = new AnalysisPool({ environment, workerFactory: realFactory(stats) });
  try {
    const ready = await pool.warmupCpu({ atomCount: 8192, modules: ['dxa', 'dxa'] });
    assert.equal(ready.readyWorkers, 2); assert.deepEqual(ready.modules, ['dxa']);
    assert.deepEqual(ready.readyModules, { voronoi: 0, ptm: 0, dxa: 2 });
    assert.equal(stats.created, 2); assert.equal(pool.cpuBudget.active, 0);
    const heaps = [...pool.slots].map(slot => slot.dxaHeapBytes);
    assert.ok(heaps.every(bytes => bytes >= 32 * 1024 ** 2));
    const sent = stats.messages.length;
    await pool.warmupCpu({ atomCount: 8192, modules: ['dxa'] });
    assert.equal(stats.messages.length, sent, 'prepared DXA kernels need no repeated initialization request');
    const ptm = await pool.warmupCpu({ atomCount: 8192 });
    assert.deepEqual(ptm.modules, ['ptm']); assert.deepEqual(ptm.readyModules, { voronoi: 0, ptm: 2, dxa: 2 });
    assert.equal(stats.created, 2, 'other module requests add kernels to the existing resident slots');
    assert.deepEqual([...pool.slots].map(slot => slot.dxaHeapBytes), heaps);
    assert.ok([...pool.slots].every(slot => slot.moduleHeapBytes.ptm >= 16 * 1024 ** 2 && slot.moduleHeapBytes.voronoi === 0));
    assert.equal(pool.cpuBudget.active, 0);
  } finally { pool.close(); }
});

function science(result) {
  const { segments, atomStructureTypes, totalLength, families, cell } = result;
  return { segments, atomStructureTypes, totalLength, families, cell };
}
test('real local and interface CPU Worker stages preserve the complete native screw-dislocation network', async () => {
  const stats = { created: 0, terminated: 0, messages: [] }, frame = fccScrewFrame(), original = frame.fractional.slice();
  const pool = new AnalysisPool({ environment, workerFactory: realFactory(stats) });
  try {
    const baseline = await calculateDxa(frame, {}, { workerCount: 1 });
    const offloaded = await calculateDxa(frame, {}, { workerCount: 1, runCpuStage: (stage, input, options) =>
      pool[stage === 'local' ? 'analyzeDxaLocal' : 'analyzeDxaTetrahedra'](input, { ...options, workerCount: 2 }) });
    assert.equal(baseline.segments.length, 1); assert.deepEqual(science(offloaded), science(baseline));
    assert.deepEqual(offloaded.cpuStageWorkerCounts, { local: 2, tetrahedra: 2 });
    assert.equal(offloaded.nativeWorkerCount, 1); assert.equal(offloaded.workerCount, 2);
    assert.equal(offloaded.cpuOffloadUsed, true); assert.deepEqual(offloaded.cpuStageFallbacks, []);
    assert.equal(offloaded.cpuStageTimings.length, 2); assert.ok(offloaded.cpuStageTimings.every(stage => stage.copiedBytes === stage.inputBytes * 2));
    assert.deepEqual(frame.fractional, original); assert.equal(pool.cpuBudget.active, 0);
    const warm = await calculateDxa(frame, {}, { workerCount: 1, runCpuStage: (stage, input, options) =>
      pool[stage === 'local' ? 'analyzeDxaLocal' : 'analyzeDxaTetrahedra'](input, { ...options, workerCount: 2 }) });
    assert.deepEqual(science(warm), science(baseline)); assert.ok(warm.cpuStageTimings.every(stage => stage.kernelInitializations === 0));
    assert.equal(stats.created, 2);
  } finally { pool.close(); await releaseDxaKernels(); }
});

test('CPU stage rejection falls back independently to the complete native pipeline', async () => {
  const frame = crystalFrame('bcc', 4), parameters = { lattice: 'bcc' };
  const baseline = await calculateDxa(frame, parameters, { workerCount: 1 });
  const stages = [];
  try {
    const fallback = await calculateDxa(frame, parameters, { workerCount: 1, runCpuStage: async stage => {
      stages.push(stage); throw new Error(`${stage} private worker denied`);
    } });
    assert.deepEqual(science(fallback), science(baseline)); assert.deepEqual(stages, ['local', 'tetrahedra']);
    assert.deepEqual(fallback.cpuStageFallbacks.map(entry => entry.stage), stages);
    assert.equal(fallback.cpuOffloadUsed, false); assert.equal(fallback.nativeWorkerCount, 1);
  } finally { await releaseDxaKernels(); }
});
