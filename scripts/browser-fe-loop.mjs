import assert from 'node:assert/strict';
import { withWebGpuBrowser, useSoftwareAdapter } from './webgpu-browser.mjs';

// Real user-provided BCC loop, complete CPU Wasm, and scientific invariants.
// Software graphics is optional; neither DXA run requires WebGPU.
const workerArgument = process.argv.find(argument => argument.startsWith('--workers='));
const automatic = workerArgument === '--workers=auto';
const workerCount = automatic ? undefined : workerArgument ? Number(workerArgument.split('=')[1]) : 2;
assert.ok(automatic || Number.isSafeInteger(workerCount) && workerCount >= 1 && workerCount <= 64, 'Use --workers=auto or --workers=1..64.');
const repetitionArgument = process.argv.find(argument => argument.startsWith('--repetitions='));
const repetitions = repetitionArgument ? Number(repetitionArgument.split('=')[1]) : 2;
assert.ok(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 10, 'Use --repetitions=1..10.');
const isolated = process.argv.includes('--isolated');
const software = useSoftwareAdapter(true);
const report = await withWebGpuBrowser(async ({ evaluate }) => {
  await evaluate(`(${initialize.toString()})(${workerCount})`, { timeoutMs: 120_000 });
  const preparation = automatic ? await evaluate('feLoopChecks.prepareApplication()', { timeoutMs: 120_000 }) : null;
  const cold = await evaluate('feLoopChecks.runCpu()', { timeoutMs: 120_000 });
  console.log(JSON.stringify({ phase: 'CPU scientific reference', ...cold }));
  const serialWarm = await evaluate('feLoopChecks.runCpu()', { timeoutMs: 120_000 });
  console.log(JSON.stringify({ phase: 'Warm global serial baseline', ...serialWarm }));
  const startedAt = performance.now();
  const progressTimer = setInterval(() => {
    void evaluate('feLoopChecks.progress', { timeoutMs: 10_000 }).then(progress => {
      console.log(JSON.stringify({ phase: 'Warm CPU validation', elapsedMs: performance.now() - startedAt, progress }));
    }).catch(() => {});
  }, 30_000);
  const warmRuns = [];
  try {
    for (let repetition = 0; repetition < repetitions; repetition++) {
      warmRuns.push(await evaluate('feLoopChecks.runWarm()', { timeoutMs: 120_000 }));
      console.log(JSON.stringify({ phase: 'CPU measured run', repetition: repetition + 1,
        wholeElapsedMs: warmRuns.at(-1).wholeElapsedMs, stages: warmRuns.at(-1).cpuStageTimings,
        fallback: warmRuns.at(-1).cpuStageFallbacks, heapBytes: warmRuns.at(-1).poolHeaps.totalModuleHeapBytes }));
    }
  }
  finally { clearInterval(progressTimer); }
  await evaluate('feLoopChecks.close()');
  return { fixture: 'examples/Fe_disloc_loop.dump', backend: 'cpu', isolated,
    requestedSoftwareGraphics: software, performanceGuarantee: false, requestedWorkers: automatic ? 'auto' : workerCount,
    preparation, cold, serialWarm, repetitions, warm: warmRuns[0], repeatWarm: warmRuns.at(-1), warmRuns };
}, { software, isolated, requireGpu: false });
console.log(JSON.stringify(report, null, 2));

async function initialize(workerCount) {
  const [{ parseLammpsFrame }, { dxaWorkerCount }, { DxaClient }, { AnalysisPool }] = await Promise.all([
    import('./src/io/lammps-dump.js'), import('./src/analysis/dxa.js'),
    import('./src/analysis/dxa-client.js'), import('./src/analysis/analysis-pool.js'),
  ]);
  const response = await fetch('./examples/Fe_disloc_loop.dump');
  if (!response.ok) throw new Error('The Fe loop dump did not load.');
  const frame = parseLammpsFrame(await response.text(), 'Fe_disloc_loop.dump');
  const state = window.feLoopChecks = { frame, cpu: null };
  state.cpuPool = new AnalysisPool();
  state.client = new DxaClient({ cpuStageBackend: state.cpuPool, cpuBudget: state.cpuPool.cpuBudget });
  const slotIds = new WeakMap(); let nextSlotId = 0;
  const poolHeaps = () => {
    const slots = [...state.cpuPool.slots].map(slot => {
      if (!slotIds.has(slot)) slotIds.set(slot, ++nextSlotId);
      return { id: slotIds.get(slot), moduleHeapBytes: { ...slot.moduleHeapBytes },
        residentInputBytes: slot.residentInputBytes ?? 0, dxaHeapBytes: slot.dxaHeapBytes ?? 0,
        dxaReserved: Boolean(slot.dxaReservedKey), dxaResident: Boolean(slot.dxaResidentKey) };
    });
    return { slots, totalModuleHeapBytes: slots.reduce((sum, slot) => sum
      + Object.values(slot.moduleHeapBytes).reduce((bytes, value) => bytes + value, 0), 0),
    totalResidentInputBytes: slots.reduce((sum, slot) => sum + slot.residentInputBytes, 0) };
  };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const exact = (actual, expected, label) => {
    const serialize = value => JSON.stringify(value, (_, item) => ArrayBuffer.isView(item) ? Array.from(item) : item);
    check(serialize(actual) === serialize(expected), label + ': serial and offloaded values differ');
  };
  const equal = (actual, expected, label) => {
    check(actual.length === expected.length, label + ': different sizes');
    for (let i = 0; i < actual.length; i++) check(actual[i] === expected[i],
      label + ': index ' + i + ', warm=' + actual[i] + ', reference=' + expected[i]);
  };
  const summarize = result => ({ atoms: result.atomStructureTypes.length, backend: result.backend,
    engine: result.engine, workerCount: result.workerCount, threaded: result.threaded,
    sharedMemory: result.sharedMemory, poolSize: result.poolSize,
    kernelGeneration: result.kernelGeneration, wasmMemoryBytes: result.wasmMemoryBytes,
    threadingFallback: result.threadingFallback, structureCounts: result.structureCounts,
    nativeWorkerCount: result.nativeWorkerCount, cpuOffloadUsed: result.cpuOffloadUsed,
    cpuStageWorkerCounts: result.cpuStageWorkerCounts, cpuStageTimings: result.cpuStageTimings,
    cpuStageFallbacks: result.cpuStageFallbacks,
    totalLength: result.totalLength, density: result.density, elapsedMs: result.elapsedMs,
    stageTimings: result.stageTimings,
    segments: result.segments.map(segment => ({ id: segment.id, family: segment.familyId,
      closed: segment.closed, isInfinite: segment.isInfinite, length: segment.length,
      burgersVector: segment.burgersVector, spatialBurgersVector: segment.spatialBurgersVector,
      pointCount: segment.points.length / 3, junctions: segment.junctions })) });
  const checkLoop = result => {
    check(result.backend === 'cpu' && /^Wasm CPU/.test(result.engine), 'Every DXA stage must run on CPU.');
    check(result.atomStructureTypes.length === 60229, 'All source atoms must participate in DXA.');
    check(result.structureCounts[3] > 60000, 'The actual fixture must remain predominantly BCC.');
    check(result.segments.length === 1, 'The actual fixture must contain exactly one dislocation loop.');
    const segment = result.segments[0];
    check(segment.familyId === 'half111' && segment.structureType === 3, 'The loop must have BCC 1/2<111> Burgers family.');
    check(segment.closed && !segment.isInfinite, 'The loop must close without winding through PBC.');
    check(Math.abs(Math.hypot(...segment.burgersVector) - Math.sqrt(3) / 2) < 1e-10,
      'Crystal-local Burgers magnitude must be sqrt(3)/2.');
    check(Math.hypot(...segment.spatialBurgersVector) > 2.4 && Math.hypot(...segment.spatialBurgersVector) < 2.5,
      'Physical Burgers magnitude must agree with the Fe nearest-neighbor distance.');
    check(segment.length > 100 && segment.length < 108, 'The closed loop must retain its physical length.');
    check(segment.points.length >= 12 && segment.points.every(Number.isFinite), 'The loop must have finite line geometry.');
    for (let axis = 0; axis < 3; axis++) check(Math.abs(segment.points[axis]
      - segment.points[segment.points.length - 3 + axis]) < 1e-6, 'The finite loop endpoints must coincide.');
    check(segment.junctions.length === 2, 'Closed loop endpoint connectivity is missing.');
    for (let end = 0; end < 2; end++) check(segment.junctions[end].length === 1
      && segment.junctions[end][0].segmentId === segment.id && segment.junctions[end][0].end === 1 - end,
    'The loop must have reciprocal self-junctions.');
  };
  state.runCpu = async () => {
    const started = performance.now();
    state.cpu = await state.client.analyze(frame, { lattice: 'bcc' }, { workerCount: 1 });
    const wholeElapsedMs = performance.now() - started;
    checkLoop(state.cpu);
    return { ...summarize(state.cpu), wholeElapsedMs, poolHeaps: poolHeaps() };
  };
  state.prepareApplication = async () => {
    const started = performance.now();
    const modules = await state.cpuPool.warmupCpu({ atomCount: frame.ids.length, modules: ['voronoi', 'ptm'] });
    const residentFrame = await state.cpuPool.prepareCpuFrame(frame, { kind: 'voronoi' });
    const coordinator = await state.client.warmup({ atomCount: frame.ids.length });
    return { elapsedMs: performance.now() - started, hardwareConcurrency: navigator.hardwareConcurrency,
      maximumWorkers: state.cpuPool.limit, slotCount: state.cpuPool.slots.size,
      status: state.cpuPool.cpuWarmupStatus, modules, residentFrame, coordinator };
  };
  state.runWarm = async () => {
    const before = frame.fractional.slice();
    const started = performance.now();
    const actual = await state.client.analyze(frame, { lattice: 'bcc' }, { workerCount,
      onProgress: update => { state.progress = update; } });
    const wholeElapsedMs = performance.now() - started;
    checkLoop(actual);
    const expectedWorkers = crossOriginIsolated
      ? Math.min(state.cpuPool.limit, dxaWorkerCount(frame.ids.length, workerCount))
      : Math.min(state.cpuPool.limit, workerCount ?? Math.ceil(frame.ids.length / 4096));
    check(workerCount === undefined
      ? actual.workerCount >= 1 && actual.workerCount <= expectedWorkers
      : actual.workerCount === expectedWorkers,
    actual.threadingFallback || 'Unexpected peak CPU worker count.');
    if (!crossOriginIsolated && actual.workerCount > 1) {
      check(actual.nativeWorkerCount === 1 && actual.cpuOffloadUsed,
        'Nonisolated execution uses private CPU stage Workers around one native thread.');
    }
    check(state.cpuPool.cpuBudget.active === 0 && state.cpuPool.active.size === 0,
      'Complete extraction must release all CPU stage tasks and reservations.');
    equal(frame.fractional, before, 'Source coordinates');
    equal(actual.atomStructureTypes, state.cpu.atomStructureTypes, 'Final atom crystal structures');
    check(actual.kernelGeneration === state.cpu.kernelGeneration, 'Warm extraction must retain its Wasm module.');
    check(actual.wasmMemoryBytes >= state.cpu.wasmMemoryBytes, 'Warm extraction retains the allocated heap.');
    const segment = actual.segments[0], expected = state.cpu.segments[0];
    const physicalDifference = Math.min(...[1, -1].map(sign => Math.hypot(...segment.spatialBurgersVector.map(
      (value, axis) => value - sign * expected.spatialBurgersVector[axis]))));
    const relativeLengthDifference = Math.abs(actual.totalLength - state.cpu.totalLength) / state.cpu.totalLength;
    if (crossOriginIsolated) {
      check(physicalDifference <= Math.hypot(...expected.spatialBurgersVector) * .002,
        'Physical Burgers vector must agree up to reversal and crystal symmetry.');
      // Native PDEL insertion can choose a different smoothed core polyline.
      // Match the existing 1% CPU benchmark contract; private BDEL is exact.
      check(relativeLengthDifference <= .01,
        `Parallel PDEL polyline length differs by more than 1%: serial=${state.cpu.totalLength}, `
        + `parallel=${actual.totalLength}, difference=${relativeLengthDifference * 100}%, `
        + `nativeWorkers=${actual.nativeWorkerCount}, points=${segment.points.length / 3}.`);
    } else {
      exact(actual.segments, state.cpu.segments, 'All segment points, lengths, Burgers vectors and connectivity');
      for (const field of ['totalLength', 'density', 'volume', 'counts', 'familyLengths', 'structureCounts']) {
        exact(actual[field], state.cpu[field], field);
      }
    }
    return { ...summarize(actual), wholeElapsedMs,
      relativeLengthDifference, physicalBurgersDifference: physicalDifference,
      exactNativeNetwork: !crossOriginIsolated,
      poolHeaps: poolHeaps(),
      activeCpuLease: state.cpuPool.cpuBudget.active, activeCpuJobs: state.cpuPool.active.size };
  };
  state.close = async () => { await state.client.close(); state.cpuPool.close(); };
}
