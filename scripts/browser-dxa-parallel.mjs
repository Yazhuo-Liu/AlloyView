import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';
import { fccScrewFrame } from '../tests/helpers/dislocations.js';
import { runPrivateDxaStageChecks } from './browser-dxa-offload.mjs';

// Run source modules in actual browser Workers: Node worker_threads do not
// exercise nested browser Worker ownership or COOP/COEP deployment behavior.
const software = useSoftwareAdapter(true);
const serialLengthTolerance = 1e-3;
const fixtureVectors = fccScrewFrame().cell.vectors;
// Two circuit centers can differ by four times the upstream Delaunay
// perturbation epsilon because they anchor at unperturbed atom positions.
const windingTolerance = 4e-10 * Math.hypot(...[0, 1, 2].map(axis =>
  fixtureVectors[axis] + fixtureVectors[axis + 3] + fixtureVectors[axis + 6]))
  + 32 * Number.EPSILON * Math.hypot(...fixtureVectors);
const arcRelativeTolerance = 1e-3;

async function checkDeployment(isolated) {
  return withWebGpuBrowser(async ({ evaluate, call }) => {
    await call('Target.setDiscoverTargets', { discover: true });
    const workerTargets = async () => (await call('Target.getTargets')).targetInfos
      .filter(target => target.type === 'worker');
    const initialTargets = new Set((await workerTargets()).map(target => target.targetId));
    const createdTargets = async () => (await workerTargets()).filter(target => !initialTargets.has(target.targetId));
    async function waitFor(predicate, label, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await delay(20);
      }
      throw new Error(`${label}: ${await evaluate('JSON.stringify(window.dxaParallelChecks?.status ?? {})')}`);
    }
    async function waitForAllWorkersToClose(label) {
      await waitFor(async () => (await createdTargets()).length === 0, label, 10_000);
    }
    await evaluate(`(async () => {
      const { DxaClient } = await import('/AlloyView/src/analysis/dxa-client.js');
      const { AnalysisPool } = await import('/AlloyView/src/analysis/analysis-pool.js');
      const { fccScrewFrame } = await import('/AlloyView/tests/helpers/dislocations.js');
      const state = window.dxaParallelChecks = { progress: [], workers: [], status: {}, fccScrewFrame };
      state.environment = { navigator: { hardwareConcurrency: 8 }, crossOriginIsolated, SharedArrayBuffer: globalThis.SharedArrayBuffer };
      if (!crossOriginIsolated) state.cpuPool = new AnalysisPool({ environment: state.environment });
      state.screw = fccScrewFrame();
      state.summarize = result => ({ workerCount: result.workerCount, threaded: result.threaded,
        poolSize: result.poolSize, kernelGeneration: result.kernelGeneration, wasmMemoryBytes: result.wasmMemoryBytes,
        sharedMemory: result.sharedMemory, threadingFallback: result.threadingFallback,
        nativeWorkerCount: result.nativeWorkerCount, cpuOffloadUsed: result.cpuOffloadUsed,
        cpuStageWorkerCounts: result.cpuStageWorkerCounts, cpuStageTimings: result.cpuStageTimings,
        cpuStageFallbacks: result.cpuStageFallbacks,
        engine: result.engine, backend: result.backend, elapsedMs: result.elapsedMs,
        totalLength: result.totalLength, stageTimings: result.stageTimings,
        atomStructureTypes: Array.from(result.atomStructureTypes),
        segments: result.segments.map(segment => ({ id: segment.id, family: segment.familyId,
          structureType: segment.structureType, closed: segment.closed, isInfinite: segment.isInfinite,
          length: segment.length, burgersVector: segment.burgersVector,
          spatialBurgersVector: segment.spatialBurgersVector, junctions: segment.junctions,
          points: Array.from(segment.points) })) });
      state.makeClient = workerCount => new DxaClient({ workerCount,
        environment: state.environment, ...(state.cpuPool ? { cpuStageBackend: state.cpuPool, cpuBudget: state.cpuPool.cpuBudget } : {}),
        workerFactory: () => {
        const worker = new Worker('/AlloyView/src/workers/dxa-worker.js', { type: 'module', name: 'DXA parallel validation' });
        const row = { terminated: false }; state.workers.push(row);
        const terminate = worker.terminate.bind(worker);
        worker.terminate = () => { row.terminated = true; terminate(); };
        return worker;
      } });
      state.recordProgress = progress => {
        state.progress.push(progress); state.status.phase = progress.phase;
        state.status.workerCount = progress.workerCount;
      };
    })()`);
    const environment = await evaluate('({isolated:crossOriginIsolated,sharedMemory:typeof SharedArrayBuffer === "function",hardwareConcurrency:navigator.hardwareConcurrency})');
    assert.equal(environment.isolated, isolated);

    // A nonisolated host retains one global native kernel while local stages
    // use the same CPU pool and lease budget as the ordinary atom analyses.
    if (!isolated) {
      const baseline = await evaluate(`(async () => {
        const state = dxaParallelChecks; state.client = state.makeClient(1);
        const result = state.summarize(await state.client.analyze(state.screw, {}, { onProgress: state.recordProgress }));
        state.client.close(); return result;
      })()`);
      assert.equal(baseline.workerCount, 1);
      assert.equal(Boolean(baseline.cpuOffloadUsed), false, 'An explicit one-worker request preserves the monolithic baseline.');
      await waitForAllWorkersToClose('Nonisolated baseline shutdown');
      const offloaded = await evaluate(`(async () => {
        const state = dxaParallelChecks; state.client = state.makeClient(2);
        const result = state.summarize(await state.client.analyze(state.screw, {}, { onProgress: state.recordProgress }));
        return { ...result, cpuLease: state.cpuPool.cpuBudget.active, sourceCoordinateBytes: state.screw.fractional.byteLength,
          activeCpuJobs: state.cpuPool.active.size, queuedCpuJobs: state.cpuPool.queue.length };
      })()`);
      assert.equal(offloaded.threaded, false);
      assert.equal(offloaded.sharedMemory, false);
      assert.equal(offloaded.backend, 'cpu');
      assert.match(offloaded.engine, /^Wasm CPU/);
      assert.equal(offloaded.nativeWorkerCount, 1);
      assert.equal(offloaded.workerCount, 2);
      assert.equal(offloaded.cpuOffloadUsed, true);
      assert.deepEqual(offloaded.cpuStageWorkerCounts, { local: 2, tetrahedra: 2 });
      assert.deepEqual(offloaded.cpuStageFallbacks, []);
      assert.deepEqual(offloaded.atomStructureTypes, baseline.atomStructureTypes, 'Private local tasks preserve every atom label.');
      assert.equal(offloaded.segments.length, 1);
      assert.equal(offloaded.segments[0].family, 'perfect');
      assert.equal(offloaded.totalLength, baseline.totalLength, 'Serial BDEL ordering and total length remain exact.');
      assert.deepEqual(offloaded.segments, baseline.segments, 'Private CPU stages preserve every segment point and connection.');
      assert.ok(Math.abs(offloaded.totalLength - 6 * 3.52 / Math.sqrt(2)) < serialLengthTolerance);
      for (const key of ['id', 'family', 'structureType', 'closed', 'isInfinite', 'junctions', 'burgersVector', 'spatialBurgersVector']) {
        assert.deepEqual(offloaded.segments[0][key], baseline.segments[0][key], `Private CPU stages preserve segment ${key}.`);
      }
      assert.ok(Array.isArray(offloaded.stageTimings) && offloaded.stageTimings.length >= 11);
      assert.ok(offloaded.stageTimings.every(stage => Number.isFinite(stage.elapsedMs) && stage.elapsedMs >= 0));
      assert.deepEqual(offloaded.cpuStageTimings.map(stage => stage.stage), ['local', 'tetrahedra']);
      for (const stage of offloaded.cpuStageTimings) {
        assert.equal(stage.workerCount, 2);
        assert.ok(Number.isFinite(stage.elapsedMs) && stage.elapsedMs >= 0);
        assert.ok(Number.isFinite(stage.inputBytes) && stage.inputBytes > 0);
        assert.ok(Number.isFinite(stage.copiedBytes) && stage.copiedBytes > 0);
        assert.equal(stage.inputDelivery, 'port', 'The DXA Worker sends stage inputs directly; the page copies none.');
        assert.ok(Number.isInteger(stage.chunkCount) && stage.chunkCount >= 2);
      }
      assert.equal(offloaded.cpuLease, 0, 'The coordinator and local pool jobs release the shared CPU budget.');
      assert.equal(offloaded.activeCpuJobs, 0);
      assert.equal(offloaded.queuedCpuJobs, 0);
      assert.equal(offloaded.sourceCoordinateBytes, baseline.atomStructureTypes.length * 3 * 8, 'Canonical source coordinates remain attached.');
      const targetsBeforeClose = await createdTargets();
      assert.ok(targetsBeforeClose.length >= 3, 'A coordinator and actual CPU pool Workers exist without pthreads.');
      await evaluate('dxaParallelChecks.client.close(); dxaParallelChecks.cpuPool.close()');
      await waitForAllWorkersToClose('Private CPU stage pool shutdown');
      return { deployment: 'Static host without COOP/COEP', environment,
        workerTargets: targetsBeforeClose.length, serial: compact(baseline), offloaded: compact(offloaded) };
    }

    assert.equal(environment.sharedMemory, true);
    const baseline = await evaluate(`(async () => {
      const state = dxaParallelChecks; state.serial = state.makeClient(1);
      const result = await state.serial.analyze(state.screw, {}, { onProgress: state.recordProgress });
      return state.summarize(result);
    })()`);
    assert.equal(baseline.workerCount, 1);
    assert.equal(baseline.threaded, true, 'An isolated host initializes one shared kernel even for a one-thread calculation.');
    assert.equal(baseline.sharedMemory, true);
    assert.equal(baseline.backend, 'cpu');
    await evaluate('dxaParallelChecks.serial.close()');
    await waitForAllWorkersToClose('Single-threaded baseline Worker shutdown');
    const threaded = await evaluate(`(async () => {
      const state = dxaParallelChecks; state.client = state.makeClient(2);
      state.initialWarmup = await state.client.warmup({ atomCount: state.screw.ids.length });
      const result = await state.client.analyze(state.screw, {}, { onProgress: state.recordProgress });
      return state.summarize(result);
    })()`);
    assert.equal(threaded.workerCount, 2);
    assert.equal(threaded.threaded, true);
    assert.equal(threaded.backend, 'cpu');
    assert.match(threaded.engine, /2 threads/);
    assert.deepEqual(threaded.atomStructureTypes, baseline.atomStructureTypes, 'Parallel crystal classification must preserve every atom label.');
    assert.equal(threaded.segments.length, 1);
    assert.equal(threaded.segments[0].family, 'perfect');
    assert.ok(Math.abs(threaded.totalLength - baseline.totalLength) / baseline.totalLength < arcRelativeTolerance,
      JSON.stringify({ serialLength: baseline.totalLength, parallelLength: threaded.totalLength, arcRelativeTolerance }));
    // Parallel Delaunay can choose a different valid triangulation of the
    // degenerate ideal FCC sites. Its line can have a small transverse wiggle,
    // so compare periodic winding within the source's perturbation bound.
    const points = threaded.segments[0].points;
    const periodicWindingZ = Math.abs(points.at(-1) - points[2]);
    const direction = Math.sign(points.at(-1) - points[2]);
    for (let axis = 0; axis < 3; axis++) {
      const delta = points[points.length - 3 + axis] - points[axis];
      assert.ok(Math.abs(delta - direction * fixtureVectors[6 + axis]) < windingTolerance,
        JSON.stringify({ axis, delta, expected: direction * fixtureVectors[6 + axis], windingTolerance }));
    }
    assert.ok(Math.abs(periodicWindingZ - 6 * 3.52 / Math.sqrt(2)) < windingTolerance,
      JSON.stringify({ periodicWindingZ, analyticLength: 6 * 3.52 / Math.sqrt(2), windingTolerance }));
    assert.ok(threaded.totalLength >= periodicWindingZ - windingTolerance && threaded.totalLength / periodicWindingZ < 1 + arcRelativeTolerance,
      JSON.stringify({ parallelLength: threaded.totalLength, periodicWindingZ }));
    for (let index = 0; index < threaded.segments.length; index++) {
      const actual = threaded.segments[index], expected = baseline.segments[index];
      for (const key of ['id', 'family', 'structureType', 'closed', 'isInfinite', 'junctions', 'burgersVector', 'spatialBurgersVector']) {
        assert.deepEqual(actual[key], expected[key], `Parallel extraction must preserve segment ${index} ${key}.`);
      }
    }
    assert.ok(Array.isArray(threaded.stageTimings) && threaded.stageTimings.length >= 11);
    assert.ok(threaded.stageTimings.every(stage => Number.isFinite(stage.elapsedMs) && stage.elapsedMs >= 0));
    assert.ok(threaded.stageTimings.some(stage => stage.phase === 'Identify local crystal structures'));
    const liveTargets = await createdTargets();
    assert.ok(liveTargets.length >= 2, 'Actual nested pthread Workers must exist beside the DXA coordinator.');

    // Increase and then lower concurrency on this same coordinator. Only the
    // missing pthreads are initialized; the kernel and its shared heap survive.
    const reuse = await evaluate(`(async () => {
      const state = dxaParallelChecks;
      const initial = state.initialWarmup;
      const adjacent = await state.client.warmup({ atomCount: state.screw.ids.length, workerCount: 3 });
      const grown = await state.client.warmup({ atomCount: state.screw.ids.length, workerCount: 4 });
      const reduced = await state.client.warmup({ atomCount: state.screw.ids.length, workerCount: 1 });
      await state.client.clearFrames();
      const newSource = await state.client.warmup({ atomCount: state.screw.ids.length, workerCount: 2 });
      return { initial, adjacent, grown, reduced, newSource, coordinatorsCreated: state.workers.length,
        liveCoordinator: state.client.worker !== null };
    })()`);
    assert.equal(reuse.initial.workerCount, 2);
    assert.equal(reuse.adjacent.workerCount, 3);
    assert.equal(reuse.adjacent.poolSize, 2, 'Increasing by one initializes the one missing pthread.');
    assert.equal(reuse.grown.workerCount, 4);
    assert.equal(reuse.reduced.workerCount, 1);
    assert.equal(reuse.newSource.workerCount, 2);
    assert.ok(reuse.initial.poolSize >= 1);
    assert.ok(reuse.grown.poolSize >= 3);
    assert.equal(reuse.reduced.poolSize, reuse.grown.poolSize);
    assert.equal(reuse.newSource.poolSize, reuse.grown.poolSize);
    assert.equal(reuse.grown.kernelGeneration, reuse.initial.kernelGeneration);
    assert.equal(reuse.adjacent.kernelGeneration, reuse.initial.kernelGeneration);
    assert.equal(reuse.reduced.kernelGeneration, reuse.initial.kernelGeneration);
    assert.equal(reuse.newSource.kernelGeneration, reuse.initial.kernelGeneration);
    assert.ok(reuse.grown.wasmMemoryBytes >= reuse.initial.wasmMemoryBytes);
    assert.ok(reuse.reduced.wasmMemoryBytes >= reuse.grown.wasmMemoryBytes);
    assert.equal(reuse.coordinatorsCreated, 2, 'Only the closed scientific baseline and the persistent coordinator exist.');
    assert.equal(reuse.liveCoordinator, true);
    const warmedTargets = await createdTargets();
    assert.ok(warmedTargets.length >= 4, 'Growing to four threads creates the missing actual nested Workers.');

    // Reuse the warmed kernel, then abort a larger frame during local crystal
    // identification. The pool exists already; this phase also includes the
    // serial neighbor-index preparation before the parallel atom loop.
    await evaluate(`(() => {
      const state = dxaParallelChecks; state.controller = new AbortController();
      state.status = { cancelling: true }; state.cancelProgress = null;
      const frame = state.fccScrewFrame({ nx: 96, ny: 72, nz: 8 });
      state.cancelPromise = state.client.analyze(frame, {}, { signal: state.controller.signal,
        onProgress: progress => {
          state.recordProgress(progress);
          if (progress.phase === 'Identify local crystal structures') {
            state.cancelProgress = progress;
            state.cancelStarted = performance.now();
            state.controller.abort();
          }
        } }).then(() => { state.status.cancelUnexpectedlyCompleted = true; }, error => {
          state.status.cancelName = error.name;
          state.status.cancelElapsedMs = performance.now() - state.cancelStarted;
        });
    })()`);
    await waitFor(() => evaluate('Boolean(dxaParallelChecks.status.cancelName || dxaParallelChecks.status.cancelUnexpectedlyCompleted)'), 'Abort local identification with a warmed pthread pool');
    const cancellation = await evaluate(`({ ...dxaParallelChecks.status,
      progress: dxaParallelChecks.cancelProgress,
      coordinatorTerminated: dxaParallelChecks.workers.at(-1).terminated,
      clientReleased: dxaParallelChecks.client.worker === null,
      pending: dxaParallelChecks.client.pending.size })`);
    assert.equal(cancellation.cancelName, 'AbortError');
    assert.equal(cancellation.coordinatorTerminated, false);
    assert.equal(cancellation.clientReleased, false);
    assert.equal(cancellation.pending, 0);
    assert.equal(cancellation.progress?.phase, 'Identify local crystal structures');
    assert.equal(cancellation.progress?.workerCount, 2);
    await waitFor(() => evaluate('dxaParallelChecks.client.current === null'), 'Native cancellation acknowledgement');
    const targetsAfterCancellation = await createdTargets();
    assert.deepEqual(targetsAfterCancellation.map(target => target.targetId).sort(), warmedTargets.map(target => target.targetId).sort(),
      'Normal cancellation preserves every initialized pthread and the coordinator.');

    const recovery = await evaluate(`(async () => {
      const state = dxaParallelChecks;
      const result = await state.client.analyze(state.screw, {}, { onProgress: state.recordProgress });
      return { ...state.summarize(result), workersCreated: state.workers.length,
        sourceCoordinateBytes: state.screw.fractional.byteLength };
    })()`);
    assert.equal(recovery.threaded, true);
    assert.equal(recovery.workerCount, 2);
    assert.equal(recovery.segments.length, 1);
    assert.deepEqual(recovery.atomStructureTypes, baseline.atomStructureTypes);
    assert.ok(Math.abs(recovery.totalLength - baseline.totalLength) / baseline.totalLength < arcRelativeTolerance);
    assert.equal(recovery.segments[0].family, 'perfect');
    assert.deepEqual(recovery.segments[0].burgersVector, baseline.segments[0].burgersVector);
    assert.deepEqual(recovery.segments[0].spatialBurgersVector, baseline.segments[0].spatialBurgersVector);
    const recoveredPoints = recovery.segments[0].points;
    assert.ok(Math.abs(Math.abs(recoveredPoints.at(-1) - recoveredPoints[2]) - 6 * 3.52 / Math.sqrt(2)) < windingTolerance);
    assert.equal(recovery.workersCreated, 2, 'Recovery must reuse the warmed coordinator.');
    assert.equal(recovery.kernelGeneration, reuse.initial.kernelGeneration);
    assert.equal(recovery.poolSize, reuse.grown.poolSize);
    assert.equal(recovery.sourceCoordinateBytes, 30 * 24 * 6 * 2 * 3 * 8, 'The displayed source coordinates must remain attached.');
    await evaluate('dxaParallelChecks.client.close()');
    await waitForAllWorkersToClose('Recovered threaded backend shutdown');
    return { deployment: 'Isolated host with COOP/COEP', environment,
      tolerances: { windingAngstrom: windingTolerance, parallelArcRelative: arcRelativeTolerance }, periodicWindingZ,
      actualWorkerTargets: liveTargets.map(target => ({ type: target.type, url: target.url })),
      serial: compact(baseline), parallel: compact(threaded), reuse, cancellation, recovery: compact(recovery),
      allWorkersClosed: (await createdTargets()).length === 0 };
  }, { software, isolated, requireGpu: false });
}

function compact(result) {
  const { atomStructureTypes, segments, ...rest } = result;
  return { ...rest, atomCount: atomStructureTypes.length, segments: segments.length,
    burgersVector: segments[0]?.burgersVector, spatialBurgersVector: segments[0]?.spatialBurgersVector };
}

async function checkStartupFallback(failure) {
  return withWebGpuBrowser(async ({ evaluate, call }) => {
    await call('Target.setDiscoverTargets', { discover: true });
    const initialTargets = new Set((await call('Target.getTargets')).targetInfos.map(target => target.targetId));
    const createdTargets = async () => (await call('Target.getTargets')).targetInfos
      .filter(target => target.type === 'worker' && !initialTargets.has(target.targetId));
    await evaluate(`(async () => {
      const { DxaClient } = await import('/AlloyView/src/analysis/dxa-client.js');
      const { fccScrewFrame } = await import('/AlloyView/tests/helpers/dislocations.js');
      const failure = ${JSON.stringify(failure)}, state = window.dxaStartupChecks = { attempts: 0, workers: [], fccScrewFrame };
      const bootstrap = failure === 'module'
        ? "const originalFetch = self.fetch; self.fetch = function(resource, options) { if (String(resource?.url ?? resource).includes('dxa-kernel-threaded.wasm')) { self.postMessage({dxaStartupProbe:true}); throw new Error('Injected DXA threaded Wasm fetch failure'); } return originalFetch.call(this, resource, options); };"
        : failure === 'pool'
          ? "self.Worker = class { constructor() { self.postMessage({dxaStartupProbe:true}); throw new Error('Injected DXA pthread Worker startup failure'); } };"
          : "const NativeWorker = self.Worker, startupTimer = self.setTimeout; const stalledUrl = URL.createObjectURL(new Blob(['self.onmessage = () => {};'], {type:'text/javascript'})); self.setTimeout = (handler, ms, ...args) => startupTimer(handler, ms === 15000 ? 1500 : ms, ...args); self.Worker = class { constructor() { self.postMessage({dxaStartupProbe:true}); return new NativeWorker(stalledUrl, {type:'module', name:'DXA stalled pthread validation'}); } };";
      const entryUrl = new URL('/AlloyView/src/workers/dxa-worker.js', location.href).href;
      const earlyMessages = "const earlyMessages = []; const queueMessage = event => earlyMessages.push(event); self.addEventListener('message', queueMessage);";
      const replayMessages = "self.removeEventListener('message', queueMessage); for (const event of earlyMessages) { self.dispatchEvent(new MessageEvent('message', { data: event.data })); await Promise.resolve(); }";
      state.workerUrl = URL.createObjectURL(new Blob([earlyMessages, bootstrap, 'await import(' + JSON.stringify(entryUrl) + ');', replayMessages], { type: 'text/javascript' }));
      state.client = new DxaClient({ workerCount: 2,
        environment: { navigator: { hardwareConcurrency: 8 }, crossOriginIsolated, SharedArrayBuffer },
        workerFactory: () => {
          const worker = new Worker(state.workerUrl, { type: 'module', name: 'DXA startup fallback validation' });
          const row = { terminated: false }; state.workers.push(row);
          worker.addEventListener('message', ({ data }) => { if (data.dxaStartupProbe) state.attempts++; });
          const terminate = worker.terminate.bind(worker);
          worker.terminate = () => { row.terminated = true; terminate(); };
          return worker;
        } });
      state.summarize = result => ({ backend: result.backend, engine: result.engine, workerCount: result.workerCount,
        sharedMemory: result.sharedMemory, threaded: result.threaded, poolSize: result.poolSize,
        kernelGeneration: result.kernelGeneration, wasmMemoryBytes: result.wasmMemoryBytes,
        threadingFallback: result.threadingFallback, segments: result.segments.length,
        family: result.segments[0]?.familyId, length: result.totalLength,
        burgersVector: result.segments[0]?.burgersVector });
    })()`);
    const shared = failure !== 'module';
    const fallback = await evaluate(`(async () => {
      const state = dxaStartupChecks, fixture = state.fccScrewFrame();
      const warmup = await state.client.warmup({ atomCount: fixture.ids.length });
      const firstAttempts = state.attempts;
      const result = state.summarize(await state.client.analyze(fixture));
      const later = await state.client.warmup({ atomCount: fixture.ids.length, workerCount: 4 });
      return { warmup, result, later, firstAttempts, laterAttempts: state.attempts, workersCreated: state.workers.length };
    })()`);
    for (const metadata of [fallback.warmup, fallback.result, fallback.later]) {
      assert.equal(metadata.workerCount, 1);
      assert.equal(metadata.sharedMemory, shared);
      const reason = failure === 'module' ? /wasm|fetch|Aborted|Injected DXA/i
        : failure === 'pool' ? /Injected DXA pthread Worker startup failure/ : /pthread.*startup.*within/i;
      assert.match(metadata.threadingFallback, reason);
    }
    assert.equal(fallback.result.threaded, shared);
    assert.equal(fallback.result.backend, 'cpu');
    assert.equal(fallback.result.engine, 'Wasm CPU');
    assert.equal(fallback.result.segments, 1);
    assert.equal(fallback.result.family, 'perfect');
    assert.ok(Math.abs(fallback.result.length - 6 * 3.52 / Math.sqrt(2)) < serialLengthTolerance);
    assert.ok(fallback.firstAttempts >= 1, 'The actual threaded module/pool startup was attempted.');
    assert.equal(fallback.laterAttempts, fallback.firstAttempts, 'A latched startup failure must not retry pool creation on every request.');
    assert.equal(fallback.result.kernelGeneration, fallback.warmup.kernelGeneration);
    assert.equal(fallback.later.kernelGeneration, fallback.warmup.kernelGeneration);
    assert.equal(fallback.workersCreated, 1);
    assert.equal((await createdTargets()).length, 1, 'Failed startup leaves only the CPU coordinator, with no orphan pthread.');

    const cancellation = await evaluate(`(async () => {
      const state = dxaStartupChecks, controller = new AbortController();
      let errorName;
      try { await state.client.analyze(state.fccScrewFrame({ nx: 96, ny: 72, nz: 8 }), {}, {
        signal: controller.signal, onProgress: progress => { if (progress.phase === 'Identify local crystal structures') controller.abort(); }
      }); } catch (error) { errorName = error.name; }
      for (let attempt = 0; attempt < 1000 && state.client.current !== null; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      return { errorName, coordinatorTerminated: state.workers[0].terminated, pending: state.client.pending.size,
        acknowledged: state.client.current === null };
    })()`);
    assert.deepEqual(cancellation, { errorName: 'AbortError', coordinatorTerminated: !shared, pending: 0, acknowledged: true },
      'Actual fallback capabilities determine whether cancellation retains or terminates the coordinator.');
    const recovery = await evaluate(`(async () => {
      const state = dxaStartupChecks;
      const result = state.summarize(await state.client.analyze(state.fccScrewFrame()));
      state.client.close(); URL.revokeObjectURL(state.workerUrl);
      return { ...result, workersCreated: state.workers.length };
    })()`);
    assert.equal(recovery.backend, 'cpu');
    assert.equal(recovery.workerCount, 1);
    assert.equal(recovery.sharedMemory, shared);
    assert.equal(recovery.segments, 1);
    assert.equal(recovery.family, 'perfect');
    assert.deepEqual(recovery.burgersVector, fallback.result.burgersVector);
    assert.equal(recovery.workersCreated, shared ? 1 : 2);
    for (let attempt = 0; attempt < 500 && (await createdTargets()).length; attempt++) await delay(20);
    assert.equal((await createdTargets()).length, 0, 'All fallback and recovered CPU Workers shut down.');
    return { failure, ...(failure === 'stalledPool' ? { testStartupTimeoutMs: 1500, productionStartupTimeoutMs: 15_000 } : {}),
      fallback, cancellation, recovery };
  }, { software, isolated: true, requireGpu: false });
}

async function checkAbortStartup() {
  return withWebGpuBrowser(async ({ evaluate, call }) => {
    await call('Target.setDiscoverTargets', { discover: true });
    const initialTargets = new Set((await call('Target.getTargets')).targetInfos.map(target => target.targetId));
    const createdTargets = async () => (await call('Target.getTargets')).targetInfos
      .filter(target => target.type === 'worker' && !initialTargets.has(target.targetId));
    const cancellation = await evaluate(`(async () => {
      const { DxaClient } = await import('/AlloyView/src/analysis/dxa-client.js');
      const { fccScrewFrame } = await import('/AlloyView/tests/helpers/dislocations.js');
      const state = window.dxaAbortStartup = { workers: [], stalled: false, fixture: fccScrewFrame() };
      const entryUrl = new URL('/AlloyView/src/workers/dxa-worker.js', location.href).href;
      const bootstrap = "const earlyMessages = []; const queueMessage = event => earlyMessages.push(event); self.addEventListener('message', queueMessage); const NativeWorker = self.Worker; const stalledUrl = URL.createObjectURL(new Blob(['self.onmessage = () => {};'], {type:'text/javascript'})); let first = true; self.Worker = class { constructor(...args) { if (!first) return new NativeWorker(...args); first = false; self.postMessage({dxaStartupStalled:true}); return new NativeWorker(stalledUrl, {type:'module', name:'DXA cancelled startup validation'}); } }; await import(" + JSON.stringify(entryUrl) + "); self.removeEventListener('message', queueMessage); for (const event of earlyMessages) { self.dispatchEvent(new MessageEvent('message', {data:event.data})); await Promise.resolve(); }";
      state.workerUrl = URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }));
      state.client = new DxaClient({ workerCount: 2,
        environment: { navigator: { hardwareConcurrency: 8 }, crossOriginIsolated, SharedArrayBuffer },
        workerFactory: () => {
          const worker = new Worker(state.workerUrl, { type: 'module', name: 'DXA early startup abort validation' });
          const row = { terminated: false }; state.workers.push(row);
          const terminate = worker.terminate.bind(worker);
          worker.terminate = () => { row.terminated = true; terminate(); };
          worker.addEventListener('message', ({ data }) => { if (data.dxaStartupStalled) state.stalled = true; });
          return worker;
        } });
      const controller = new AbortController();
      const warmup = state.client.warmup({ atomCount: state.fixture.ids.length, signal: controller.signal })
        .then(() => 'unexpected success', error => error.name);
      for (let attempt = 0; attempt < 1000 && !state.stalled; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      if (!state.stalled) throw new Error('The real stalled pthread was not created.');
      state.initialControl = state.client.control;
      const activeBeforeAbort = state.client.cpuBudget.active, started = performance.now();
      controller.abort(); const errorName = await warmup;
      for (let attempt = 0; attempt < 500 && state.client.current !== null; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
      return { errorName, acknowledged: state.client.current === null, pending: state.client.pending.size,
        activeBeforeAbort, activeAfterAbort: state.client.cpuBudget.active, acknowledgementMs: performance.now() - started,
        coordinatorTerminated: state.workers[0].terminated, sharedControl: Boolean(state.initialControl?.cancelBuffer) };
    })()`);
    assert.equal(cancellation.errorName, 'AbortError');
    assert.equal(cancellation.acknowledged, true);
    assert.equal(cancellation.pending, 0);
    assert.ok(cancellation.activeBeforeAbort > 0);
    assert.equal(cancellation.activeAfterAbort, 0, 'Startup acknowledgement releases the shared CPU lease.');
    assert.ok(cancellation.acknowledgementMs < 5000, 'Early cancellation acknowledges well before the normal 15-second startup deadline.');
    assert.equal(cancellation.coordinatorTerminated, false);
    assert.equal(cancellation.sharedControl, true);
    for (let attempt = 0; attempt < 200 && (await createdTargets()).length !== 1; attempt++) await delay(20);
    assert.equal((await createdTargets()).length, 1, 'The unacknowledged pthread is removed and terminated without replacing its coordinator.');
    const recovery = await evaluate(`(async () => {
      const state = dxaAbortStartup, ready = await state.client.warmup({ atomCount: state.fixture.ids.length });
      const result = await state.client.analyze(state.fixture);
      return { ready, backend: result.backend, engine: result.engine, workerCount: result.workerCount,
        sharedMemory: result.sharedMemory, poolSize: result.poolSize, kernelGeneration: result.kernelGeneration,
        threadingFallback: result.threadingFallback ?? null, segments: result.segments.length,
        family: result.segments[0]?.familyId, length: result.totalLength,
        burgersMagnitude: Math.hypot(...result.segments[0].burgersVector),
        periodicDelta: [0, 1, 2].map(axis => result.segments[0].points.at(-3 + axis) - result.segments[0].points[axis]),
        workersCreated: state.workers.length, stableControlPointer: state.client.control.cancelPointer === state.initialControl.cancelPointer,
        cpuLease: state.client.cpuBudget.active };
    })()`);
    assert.equal(recovery.backend, 'cpu');
    assert.equal(recovery.workerCount, 2);
    assert.equal(recovery.sharedMemory, true);
    assert.equal(recovery.threadingFallback, null, 'Cancellation does not latch a false startup failure.');
    assert.equal(recovery.segments, 1);
    assert.equal(recovery.family, 'perfect');
    const expectedLength = 6 * 3.52 / Math.sqrt(2);
    assert.ok(Math.abs(recovery.length - expectedLength) / expectedLength < arcRelativeTolerance);
    assert.ok(Math.abs(Math.abs(recovery.periodicDelta[2]) - expectedLength) < windingTolerance);
    assert.ok(recovery.periodicDelta.slice(0, 2).every(value => Math.abs(value) < windingTolerance));
    assert.ok(Math.abs(recovery.burgersMagnitude - Math.sqrt(.5)) < 1e-10);
    assert.equal(recovery.workersCreated, 1);
    assert.equal(recovery.stableControlPointer, true);
    assert.equal(recovery.cpuLease, 0);
    assert.ok((await createdTargets()).length >= 2, 'A valid later startup creates a real pthread in the retained heap.');
    await evaluate('dxaAbortStartup.client.close(); URL.revokeObjectURL(dxaAbortStartup.workerUrl)');
    for (let attempt = 0; attempt < 500 && (await createdTargets()).length; attempt++) await delay(20);
    assert.equal((await createdTargets()).length, 0);
    return { cancellation, recovery, productionStartupTimeoutMs: 15_000 };
  }, { software, isolated: true, requireGpu: false });
}

const staticHost = await checkDeployment(false);
console.error('Passed real nonisolated CPU DXA stage pool and global serial parity.');
const isolatedHost = await checkDeployment(true);
console.error('Passed real isolated pthread DXA, pool reuse and cancellation.');
const startupFallbacks = [];
for (const failure of ['module', 'pool', 'stalledPool']) {
  startupFallbacks.push(await checkStartupFallback(failure));
  console.error(`Passed isolated DXA startup fallback: ${failure}.`);
}
const abortedStartup = await checkAbortStartup();
console.error('Passed early pthread-startup abort, CPU-lease release and retry.');
const privateStageChecks = await runPrivateDxaStageChecks({ software });
console.log(JSON.stringify({ scope: 'Real browser DXA private CPU stage pool, shared-kernel pool growth, cooperative cancellation, recovery and shutdown',
  staticHost, isolatedHost, startupFallbacks, abortedStartup, privateStageChecks }, null, 2));
