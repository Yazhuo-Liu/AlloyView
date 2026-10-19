import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { GrainSegmentationClient } from '../src/analysis/grains-client.js';
import { GrainStagePool } from '../src/analysis/grain-stage-pool.js';
import { CpuBudget } from '../src/analysis/cpu-budget.js';
import { calculatePtm } from '../src/analysis/ptm.js';
import { buildGrainDendrogram, buildGrainDendrogramParallel, calculateGrains } from '../src/analysis/grains.js';
import { crystalFrame } from './helpers/crystals.js';
import { GRAIN_FIXTURES, loadGrainFixture, ovitoGrainInput } from './helpers/grain-fixtures.js';
function factory(file, created) {
  return () => {
    const worker = new Worker(new URL(`./helpers/${file}`, import.meta.url)); created.push(worker);
    return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfer) { worker.postMessage(data, transfer); }, terminate() { void worker.terminate(); } };
  };
}
for (const shared of [false, true]) test(`real parallel grain stages preserve the complete native model (shared=${shared})`, async () => {
  const created = [], pool = new GrainStagePool({ createWorker: factory('node-grains-stage-worker.mjs', created), environment: { crossOriginIsolated: shared } });
  try {
    const fixture = await loadGrainFixture('twinFault'), input = ovitoGrainInput(fixture, GRAIN_FIXTURES.twinFault());
    for (const algorithm of ['automatic', 'mst']) for (const handleCoherentInterfaces of [true, false]) {
      const options = { algorithm, handleCoherentInterfaces };
      const serial = buildGrainDendrogram(input, options);
      const actual = await buildGrainDendrogramParallel(input, options,
        (stage, values, length) => pool.run(stage, values, length, 3), async () => {});
      assert.deepEqual(actual, serial, 'includes every merge, orientation, bond, regression and plot value');
    }
  } finally { pool.dispose(); await Promise.all(created.map(worker => worker.terminate())); }
});
test('large real client stages reuse their Workers, reduce the CPU reservation before merging, and recover after cancellation', async () => {
  const frame = crystalFrame('fcc', 26, 3.52), ptm = await calculatePtm(frame, { flags: 1, neighborLists: true });
  const input = { ...ptm, fractional: frame.fractional, cell: frame.cell }, original = ptm.neighborIndices.slice();
  const created = [], budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 5 } } });
  const client = new GrainSegmentationClient({ cpuBudget: budget, createWorker: factory('node-grains-worker.mjs', created),
    createStageWorker: factory('node-grains-stage-worker.mjs', created) });
  let mergingReservation;
  try {
    client.warm(frame.ids.length);
    await client.stages.warming?.promise;
    assert.equal(budget.active, 0, 'module-only background warmup releases its permits');
    const remote = await client.segment({ ptm, fractional: frame.fractional, cell: frame.cell }, {}, {
      onProgress: stage => { if (stage === 'merging') mergingReservation = budget.active; } });
    const direct = calculateGrains(input);
    for (const key of ['grainId', 'sizes', 'orientations', 'structureTypes', 'rootStructureTypes', 'plot']) assert.deepEqual(remote[key], direct[key]);
    assert.equal(remote.workerCount, 3); assert.equal(mergingReservation, 1); assert.equal(created.length, 3);
    assert.deepEqual(ptm.neighborIndices, original); assert.equal(budget.active, 0);
    const repeated = await client.segment({ ptm, fractional: frame.fractional, cell: frame.cell }, { minGrainSize: 2 });
    assert.equal(repeated.modelReused, true); assert.equal(created.length, 3);
    client.release();
    const controller = new AbortController();
    const cancelled = client.segment({ ptm, fractional: frame.fractional, cell: frame.cell }, {}, { signal: controller.signal,
      onProgress: stage => { if (stage === 'disorientation') controller.abort(); } });
    await assert.rejects(cancelled, { name: 'AbortError' }); assert.equal(budget.active, 0);
    const helpers = client.stages.slots.map(slot => slot.worker);
    const recovered = await client.segment({ ptm, fractional: frame.fractional, cell: frame.cell });
    assert.deepEqual(recovered.grainId, direct.grainId);
    assert.deepEqual(client.stages.slots.map(slot => slot.worker), helpers); assert.equal(budget.active, 0);
  } finally { client.dispose(); await Promise.all(created.map(worker => worker.terminate())); }
});

test('grain helper admission bounds private copies and output memory while scaling with atom count and cores', () => {
  const createWorker = () => { throw new Error('Admission must not allocate workers.'); };
  const privatePool = new GrainStagePool({ createWorker, environment: { crossOriginIsolated: false } });
  const sharedPool = new GrainStagePool({ createWorker, environment: { crossOriginIsolated: true } });
  assert.equal(privatePool.degree(8000, 14), 1);
  assert.equal(privatePool.degree(20000, 14), 1, 'small grain graphs avoid messaging overhead');
  assert.equal(privatePool.degree(70000, 3), 3);
  assert.equal(privatePool.degree(108000, 6), 6);
  assert.equal(privatePool.degree(259808, 14), 3, 'the physically replicated Ni example retains two range workers');
  assert.equal(privatePool.degree(400000, 14), 1, 'large copied frames keep the original serial route');
  assert.equal(sharedPool.degree(259808, 14), 14, 'shared immutable arrays do not consume one frame copy per worker');
  assert.equal(sharedPool.degree(1000000, 14), 1, 'shared memory cannot hide oversized complete output allocations');
});

test('model keys track explicit geometry/PTM edits, array replacement and small cell changes without scanning atoms', async () => {
  const frame = crystalFrame('fcc', 3, 3.52), ptm = await calculatePtm(frame, { flags: 1, neighborLists: true }), created = [];
  const client = new GrainSegmentationClient({ createWorker: factory('node-grains-worker.mjs', created) });
  const input = { ptm, fractional: frame.fractional, cell: frame.cell };
  try {
    const first = await client.segment(input);
    assert.equal((await client.segment(input, { minGrainSize: 2 })).modelReused, true);
    const rotated = Math.PI / 180;
    for (let atom = 0; atom < ptm.structures.length; atom++) {
      ptm.orientations[atom * 4] = Math.cos(rotated / 2); ptm.orientations[atom * 4 + 3] = Math.sin(rotated / 2);
    }
    ptm.geometryRevision = 1;
    const edited = await client.segment(input);
    assert.equal(edited.modelReused, false); assert.notDeepEqual(edited.orientations, first.orientations);
    assert.equal((await client.segment(input)).modelReused, true);
    frame.cell.vectors[0] *= 1.01;
    assert.equal((await client.segment(input)).modelReused, false);
    ptm.orientations = ptm.orientations.slice();
    assert.equal((await client.segment(input)).modelReused, false);
    input.geometryRevision = 1;
    assert.equal((await client.segment(input)).modelReused, false);
    assert.equal(created.length, 1, 'changes release only model data and retain the warm coordinator');
  } finally { client.dispose(); await Promise.all(created.map(worker => worker.terminate())); }
});

test('late errors from a replaced grain helper cannot clear or terminate its replacement', () => {
  const workers = [], createWorker = () => {
    const listeners = new Map(), worker = {
      addEventListener(type, listener) { listeners.set(type, listener); },
      postMessage() {}, terminate() { this.terminated = true; },
      error() { listeners.get('error')({ message: 'old worker failed' }); },
    };
    workers.push(worker); return worker;
  };
  const pool = new GrainStagePool({ createWorker });
  const first = pool.slot(0);
  first.worker.error(); assert.equal(pool.slots[0], null);
  const replacement = pool.slot(0);
  first.worker.error();
  assert.equal(pool.slots[0], replacement); assert.equal(replacement.worker.terminated, undefined);
  pool.dispose(); assert.equal(replacement.worker.terminated, true);
});
