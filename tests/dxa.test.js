import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { DXA_DEFAULTS, DXA_FAMILIES, classifyBurgersVector, dxaCartesianCoordinates,
  calculateDxa, dxaWorkerCount, estimateDxaMemory, normalizeDxaResult, preflightDxaMemory, prepareDxaThreadPool, releaseDxaKernels, splitPeriodicPolyline, warmupDxa,
  validateDxaFrame, validateDxaParameters } from '../src/analysis/dxa.js';
import { crystalFrame } from './helpers/crystals.js';

const close = (actual, expected, tolerance = 1e-9) => {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) assert.ok(Math.abs(actual[index] - expected[index]) < tolerance,
    `${actual[index]} != ${expected[index]} at ${index}`);
};
const cell = createCell({ origin: [4, -3, 7], vectors: [10, 0, 0, 3, 8, 0, 1, 2, 6] });

test('DXA threads require shared memory and isolation, with a bounded hardware budget', () => {
  const browser = { SharedArrayBuffer, crossOriginIsolated: true, navigator: { hardwareConcurrency: 16 } };
  assert.equal(dxaWorkerCount(10000, undefined, browser), 5);
  assert.equal(dxaWorkerCount(100000, undefined, browser), 14);
  assert.equal(dxaWorkerCount(100000, undefined, { ...browser, navigator: { hardwareConcurrency: 8 } }), 6);
  assert.equal(dxaWorkerCount(10000, 2, browser), 2);
  assert.equal(dxaWorkerCount(10000, 2, { ...browser, crossOriginIsolated: false }), 1);
  assert.equal(dxaWorkerCount(10000, 2, { ...browser, SharedArrayBuffer: undefined }), 1);
  assert.equal(dxaWorkerCount(256, 2, browser), 1);
  assert.equal(dxaWorkerCount(10000, undefined, { ...browser, navigator: { hardwareConcurrency: 2 } }), 1);
  assert.equal(dxaWorkerCount(10000, undefined, { process: { versions: { node: '24' } }, SharedArrayBuffer }), 1);
  assert.equal(dxaWorkerCount(100000, 14, browser), 14);
  for (const request of [0, -1, 2.5, NaN, Infinity]) assert.throws(() => dxaWorkerCount(10000, request, browser), /worker count/);
});

test('DXA parameters validate supported phases and native algorithm limits', () => {
  assert.deepEqual(validateDxaParameters(), DXA_DEFAULTS);
  for (const lattice of Object.keys(DXA_FAMILIES)) assert.equal(validateDxaParameters({ lattice }).lattice, lattice);
  for (const parameters of [{ lattice: 'auto' }, { trialCircuitLength: 2 }, { trialCircuitLength: 101 },
    { circuitStretchability: 101 }, { circuitStretchability: -1 }, { lineSmoothingIterations: 1.5 },
    { onlyPerfectDislocations: 'false' }, { linePointInterval: NaN }, { linePointInterval: -1 }]) {
    assert.throws(() => validateDxaParameters(parameters), /DXA|supported/);
  }
  assert.equal(validateDxaParameters({ linePointInterval: 0, lineSmoothingIterations: 0 }).linePointInterval, 0);
  assert.deepEqual(validateDxaParameters({ gpuEnabled: true }), DXA_DEFAULTS, 'retired GPU flags are ignored and not serialized');
  assert.throws(() => validateDxaParameters({ trialCircuitLength: null }), /DXA/);
});

test('Burgers families preserve cubic signs/permutations and ideal vector magnitudes', () => {
  assert.equal(classifyBurgersVector([0, -.5, .5], 'fcc'), 'perfect');
  assert.equal(classifyBurgersVector([-1 / 3, 1 / 6, -1 / 6], 'fcc'), 'shockley');
  assert.equal(classifyBurgersVector([.5, -.5, -.5], 'bcc'), 'half111');
  assert.equal(classifyBurgersVector([0, -1, 0], 'bcc'), '100');
  assert.equal(classifyBurgersVector([0, 1, -1], 'bcc'), '110');
  assert.equal(classifyBurgersVector([1, 1, 0], 'fcc'), 'other', 'same direction, different Burgers magnitude');
  assert.equal(classifyBurgersVector([0, 0, 0], 'fcc'), 'other');
  assert.throws(() => classifyBurgersVector([NaN, 0, 0], 'fcc'), /finite/);
});

test('hexagonal Burgers families rotate the basal plane while preserving the c axis', () => {
  const a = Math.sqrt(.5), c = Math.sqrt(4 / 3), partial = Math.sqrt(1.5) / 3;
  assert.equal(classifyBurgersVector([a / 2, -a * Math.sqrt(3) / 2, 0], 'hcp'), 'a');
  assert.equal(classifyBurgersVector([0, 0, -c], 'hcp'), 'c');
  assert.equal(classifyBurgersVector([-a / 2, a * Math.sqrt(3) / 2, -c], 'hcp'), 'ca');
  assert.equal(classifyBurgersVector([partial * Math.sqrt(3) / 2, partial / 2, 0], 'hcp'), 'basalPartial');
  assert.equal(classifyBurgersVector([c, 0, 0], 'hcp'), 'other', 'a c-axis vector cannot be permuted into a basal vector');
  assert.equal(classifyBurgersVector([a, 0, c], 'hexDiamond'), 'other', 'diamond has its own family catalog');
});

test('DXA source coordinates wrap PBC images with complete triclinic vectors and origin', () => {
  const source = new Float64Array([1.25, -.4, 2.5, .2, .3, .4, .3, .4, .5, .4, .5, .6]);
  const openCell = createCell({ ...cell, pbc: [true, false, true] });
  const frame = { fractional: source, cell: openCell };
  const positions = dxaCartesianCoordinates(frame);
  close(positions.slice(0, 3), fractionalToCartesian([.25, -.4, .5], openCell, new Float64Array(3)));
  assert.equal(source[0], 1.25, 'input coordinates stay unchanged');
  const positionOnly = { positions: fractionalToCartesian(source, openCell, new Float64Array(source.length)), cell: openCell };
  close(dxaCartesianCoordinates(positionOnly), positions);
  assert.throws(() => validateDxaFrame({ fractional: source, cell: { ...cell, vectors: [1, 0, 0, 1, 0, 0, 0, 0, 1] } }), /cell/);
  assert.throws(() => validateDxaFrame({ fractional: [0, 0, NaN, ...source.slice(3)], cell }), /finite/);
});

test('whole-frame DXA memory preflight rejects excessive work without silently truncating atoms', () => {
  assert.ok(estimateDxaMemory(259_808) > 700 * 1024 ** 2);
  assert.equal(preflightDxaMemory(100, estimateDxaMemory(100)), estimateDxaMemory(100));
  assert.throws(() => preflightDxaMemory(1_000_000), /exceeding.*budget/);
  assert.throws(() => preflightDxaMemory(4, NaN), /budget/);
});

test('DXA normalization retains Burgers vectors, connectivity and source lengths/density', () => {
  const raw = { segments: [{ id: 5, points: [[4, -3, 7], [7, 1, 7]], burgersVector: [.5, 0, -.5],
    spatialBurgersVector: [0, 0, -2.4], clusterId: 8, length: 5, closed: false,
    junctions: [[{ segmentId: 5, end: 1 }], [{ segmentId: 5, end: 0 }]] }], atomStructureTypes: [1, 1, 0, 2] };
  const result = normalizeDxaResult(raw, cell, { gpuEnabled: true }, 4);
  assert.equal(result.segments[0].family, 'perfect');
  assert.ok(result.segments[0].points instanceof Float64Array);
  assert.deepEqual(result.segments[0].spatialBurgersVector, [0, 0, -2.4]);
  assert.deepEqual(result.segments[0].junctions, raw.segments[0].junctions);
  assert.equal(result.counts.perfect, 1); assert.equal(result.familyLengths.perfect, 5);
  assert.equal(result.totalLength, 5); assert.equal(result.volume, 480); assert.equal(result.density, 5 / 480);
  assert.deepEqual(result.structureCounts, { 0: 1, 1: 2, 2: 1 });
  assert.deepEqual(Array.from(result.atomStructureTypes), raw.atomStructureTypes);
  assert.notEqual(result.cell.vectors, cell.vectors);
  assert.throws(() => normalizeDxaResult({ ...raw, atomStructureTypes: [1] }, cell, {}, 4), /structure identifiers/);
  assert.throws(() => normalizeDxaResult({ segments: [{ ...raw.segments[0], points: [[NaN, 0, 0], [0, 0, 0]] }] }, cell), /coordinates/);
  const relatedPhase = normalizeDxaResult({ segments: [{ ...raw.segments[0], structureType: 2 }] }, cell);
  assert.equal(relatedPhase.segments[0].familyId, 'other', 'an unmapped HCP crystal frame is never labeled as an FCC vector');
});

test('triclinic periodic polylines split at faces and preserve physical source length', () => {
  const points = fractionalToCartesian([.8, .2, .4, 1.2, .2, .4], cell, new Float64Array(6));
  const pieces = splitPeriodicPolyline(points, cell);
  assert.equal(pieces.length, 2);
  close(pieces[0], fractionalToCartesian([.8, .2, .4, 1, .2, .4], cell, new Float64Array(6)));
  close(pieces[1], fractionalToCartesian([0, .2, .4, .2, .2, .4], cell, new Float64Array(6)));
  assert.equal(points.length, 6);
  const lengths = pieces.reduce((length, piece) => length + Math.hypot(piece[3] - piece[0], piece[4] - piece[1], piece[5] - piece[2]), 0);
  assert.ok(Math.abs(lengths - 4) < 1e-10);
});

test('periodic splitting handles negative multi-image lines, corner crossings and open axes', () => {
  const multi = fractionalToCartesian([-1.2, .2, .4, 2.2, .2, .4], cell, new Float64Array(6));
  assert.equal(splitPeriodicPolyline(multi, cell).length, 5);
  const corner = fractionalToCartesian([.8, .8, .8, 1.2, 1.2, 1.2], cell, new Float64Array(6));
  assert.equal(splitPeriodicPolyline(corner, cell).length, 2, 'simultaneous face crossings do not create zero-length pieces');
  const open = createCell({ ...cell, pbc: [false, false, false] });
  close(splitPeriodicPolyline(multi, open)[0], multi);
  const zero = fractionalToCartesian([.2, .2, .2, .2, .2, .2], cell, new Float64Array(6));
  assert.deepEqual(splitPeriodicPolyline(zero, cell), []);
});

test('native CPU DXA keeps one warmed heap, stable scientific results and CPU-only progress', async () => {
  const frame = crystalFrame('fcc', 4), progress = [];
  try {
    const ready = await warmupDxa({ atomCount: frame.ids.length });
    const forbiddenGpuStage = () => { throw new Error('Retired GPU callbacks must never run.'); };
    const first = await calculateDxa(frame, { gpuEnabled: true }, {
      onProgress: event => progress.push(event), identifyDxa: forbiddenGpuStage, classifyDxa: forbiddenGpuStage,
    });
    assert.equal(first.backend, 'cpu');
    assert.equal(first.engine, 'Wasm CPU');
    assert.equal(first.workerCount, 1);
    assert.equal(first.kernelGeneration, ready.kernelGeneration);
    assert.ok(first.wasmMemoryBytes >= ready.wasmMemoryBytes);
    assert.equal(first.segments.length, 0);
    assert.ok(first.atomStructureTypes.every(type => type === 1));
    assert.ok(progress.length > 5 && progress.every(event => event.backend === 'cpu'));
    assert.ok(first.stageTimings.length > 5 && first.stageTimings.every(stage => stage.backend === 'cpu' && stage.elapsedMs >= 0));
    assert.equal(Object.keys(first).some(key => /^gpu|^stageFallbacks$|^fallbackReason$/i.test(key)), false);
    assert.deepEqual(first.parameters, DXA_DEFAULTS);
    const second = await calculateDxa(frame);
    assert.equal(second.kernelGeneration, first.kernelGeneration);
    assert.deepEqual(second.atomStructureTypes, first.atomStructureTypes);
    assert.deepEqual(second.segments, first.segments);
  } finally { await releaseDxaKernels(); }
});

test('CPU DXA cancellation between native stages disposes the session and reuses its warmed kernel', async () => {
  const frame = crystalFrame('fcc', 4), controller = new AbortController();
  try {
    const ready = await warmupDxa({ atomCount: frame.ids.length });
    await assert.rejects(calculateDxa(frame, {}, { signal: controller.signal, onProgress(event) {
      if (event.completedStages === 6) controller.abort();
    } }), { name: 'AbortError' });
    const next = await calculateDxa(frame);
    assert.equal(next.kernelGeneration, ready.kernelGeneration);
    assert.equal(next.segments.length, 0);
    assert.ok(next.atomStructureTypes.every(type => type === 1));
  } finally { await releaseDxaKernels(); }
});

test('native pthread DXA retains CPU parity and its growable pool', async () => {
  const frame = crystalFrame('fcc', 8);
  try {
    const serial = await calculateDxa(frame, {}, { workerCount: 1 });
    const threaded = await calculateDxa(frame, {}, { workerCount: 2 });
    assert.equal(threaded.workerCount, 2);
    assert.equal(threaded.poolSize, 1);
    assert.equal(threaded.backend, 'cpu');
    assert.equal(threaded.engine, 'Wasm CPU · 2 threads');
    assert.equal(threaded.kernelGeneration, serial.kernelGeneration);
    assert.deepEqual(threaded.segments, serial.segments);
    assert.deepEqual(threaded.atomStructureTypes, serial.atomStructureTypes);
    const smaller = await warmupDxa({ atomCount: frame.ids.length, workerCount: 1 });
    assert.equal(smaller.poolSize, 1, 'a smaller target retains already prepared slots');
  } finally { await releaseDxaKernels(); }
});

function poolFixture({ load = async worker => worker, allocate } = {}) {
  const workers = [], runtimeError = () => {};
  const pool = { unusedWorkers: [], runningWorkers: [],
    allocateUnusedWorker() {
      if (allocate) allocate(workers.length);
      const worker = { terminated: false, terminate() { this.terminated = true; } };
      workers.push(worker); this.unusedWorkers.push(worker);
    },
    loadWasmModuleToWorker(worker) { worker.onerror = runtimeError; return load(worker, workers.indexOf(worker)); },
  };
  const module = { dxaShared: true, PThread: pool, HEAP32: new Int32Array(new SharedArrayBuffer(8)), _alloy_dxa_cancel_ptr: () => 0 };
  return { module, workers, runtimeError };
}

test('denied pthread startup removes failed slots and latches one CPU thread in the same shared heap', async () => {
  const { module, workers, runtimeError } = poolFixture({ load: async (_worker, index) => {
    if (index === 1) throw new Error('Pthread module was denied.');
  } });
  assert.equal(await prepareDxaThreadPool(module, 4), 1);
  assert.match(module.dxaThreadingFallback, /denied/);
  assert.equal(module.PThread.unusedWorkers.length, 2);
  assert.equal(workers[1].terminated, true);
  assert.equal(workers[0].onerror, runtimeError, 'successful slots retain normal fatal-runtime handling');
  assert.equal(await prepareDxaThreadPool(module, 6), 1);
  assert.equal(workers.length, 3, 'latched failure never repeats startup on later frames');
});

test('synchronous pthread load and allocation failures clean partial startup before serial fallback', async () => {
  const failedLoad = poolFixture({ load() { throw new Error('Worker module cannot load.'); } });
  assert.equal(await prepareDxaThreadPool(failedLoad.module, 3), 1);
  assert.equal(failedLoad.workers.length, 2);
  assert.ok(failedLoad.workers.every(worker => worker.terminated));
  assert.equal(failedLoad.module.PThread.unusedWorkers.length, 0);
  let loaded = false;
  const failedAllocation = poolFixture({ allocate(index) { if (index === 1) throw new Error('Worker construction denied.'); },
    load: async () => { await new Promise(resolve => setTimeout(resolve, 0)); loaded = true; } });
  assert.equal(await prepareDxaThreadPool(failedAllocation.module, 4), 1);
  assert.equal(loaded, true, 'already started slots are joined before leaving pool preparation');
  assert.equal(failedAllocation.module.PThread.unusedWorkers.length, 1);
});

test('pthread error events fall back, while cancellation is never reported as startup failure', async () => {
  const denied = poolFixture({ load(worker) {
    queueMicrotask(() => worker.onerror({ message: 'Pthread worker rejected by CSP.' }));
    return new Promise(() => {});
  } });
  assert.equal(await prepareDxaThreadPool(denied.module, 2), 1);
  assert.equal(denied.workers[0].terminated, true);
  assert.equal(denied.module.PThread.unusedWorkers.length, 0);
  assert.match(denied.module.dxaThreadingFallback, /CSP/);
  const controller = new AbortController(), canceled = poolFixture({ load: async () => { controller.abort(); } });
  await assert.rejects(prepareDxaThreadPool(canceled.module, 2, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(canceled.module.dxaThreadingFallback, undefined);
});

test('stalled pthread startup is bounded, retains loaded slots and ignores late notifications', async () => {
  let finishStalled;
  const { module, workers, runtimeError } = poolFixture({ load(worker, index) {
    if (index === 0) { worker.loaded = true; return Promise.resolve(worker); }
    return new Promise(resolve => { finishStalled = () => { worker.loaded = true; resolve(worker); }; });
  } });
  assert.equal(await prepareDxaThreadPool(module, 3, { startupTimeoutMs: 30 }), 1);
  assert.match(module.dxaThreadingFallback, /pthread worker.*startup within 30 ms/);
  assert.deepEqual(module.PThread.unusedWorkers, [workers[0]]);
  assert.equal(workers[0].terminated, false);
  assert.equal(workers[0].onerror, runtimeError);
  assert.equal(workers[1].terminated, true);
  const retiredHandler = workers[1].onerror;
  finishStalled(); await new Promise(resolve => setTimeout(resolve, 0));
  workers[1].onerror({ message: 'An obsolete startup failure.' });
  assert.equal(workers[1].onerror, retiredHandler, 'a late loaded result never restores a removed worker’s runtime handler');
  assert.deepEqual(module.PThread.unusedWorkers, [workers[0]]);
  assert.equal(await prepareDxaThreadPool(module, 4, { startupTimeoutMs: 30 }), 1);
  assert.equal(workers.length, 2, 'timeout fallback remains latched');
});

test('signal abort immediately cleans stalled pthread slots and later startup retries the same heap', async () => {
  let stalling = true;
  const controller = new AbortController();
  const { module, workers } = poolFixture({ load(worker) {
    return stalling ? new Promise(() => {}) : Promise.resolve(worker);
  } });
  const preparation = prepareDxaThreadPool(module, 3, { signal: controller.signal, startupTimeoutMs: 5000 });
  const rejected = assert.rejects(preparation, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(workers.length, 2);
  controller.abort(); await rejected;
  assert.ok(workers.every(worker => worker.terminated));
  assert.equal(module.PThread.unusedWorkers.length, 0);
  assert.equal(module.dxaThreadingFallback, undefined);
  stalling = false;
  assert.equal(await prepareDxaThreadPool(module, 2, { startupTimeoutMs: 100 }), 2);
  assert.equal(workers.length, 3);
  assert.equal(module.PThread.unusedWorkers.length, 1);
});

test('shared atomic cancellation releases stalled startup without a controller message', async () => {
  const { module, workers } = poolFixture({ load: () => new Promise(() => {}) });
  const preparation = prepareDxaThreadPool(module, 3, { startupTimeoutMs: 5000 });
  const rejected = assert.rejects(preparation, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 0));
  Atomics.store(module.HEAP32, 0, 1);
  await rejected;
  assert.ok(workers.every(worker => worker.terminated));
  assert.equal(module.PThread.unusedWorkers.length, 0);
  assert.equal(module.dxaThreadingFallback, undefined);
});

test('aborted queued pool preparation allocates no stale slots after another module finishes startup', async () => {
  let releaseFirst;
  const first = poolFixture({ load: worker => new Promise(resolve => { releaseFirst = () => resolve(worker); }) });
  const firstPreparation = prepareDxaThreadPool(first.module, 2, { startupTimeoutMs: 1000 });
  await new Promise(resolve => setTimeout(resolve, 0));
  const second = poolFixture(), controller = new AbortController();
  const secondPreparation = prepareDxaThreadPool(second.module, 2, { signal: controller.signal, startupTimeoutMs: 1000 });
  const rejected = assert.rejects(secondPreparation, { name: 'AbortError' });
  controller.abort(); await rejected;
  assert.equal(second.workers.length, 0);
  releaseFirst();
  assert.equal(await firstPreparation, 2);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(second.workers.length, 0);
});
