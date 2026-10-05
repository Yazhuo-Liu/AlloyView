import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// Run source modules in actual browser Workers: Node worker_threads do not
// exercise nested browser Worker ownership or COOP/COEP deployment behavior.
const software = useSoftwareAdapter(true);
const serialLengthTolerance = 1e-3;
const windingTolerance = 1e-8;
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
      const { fccScrewFrame } = await import('/AlloyView/tests/helpers/dislocations.js');
      const state = window.dxaParallelChecks = { progress: [], workers: [], status: {}, fccScrewFrame };
      state.screw = fccScrewFrame();
      state.summarize = result => ({ workerCount: result.workerCount, threaded: result.threaded,
        poolSize: result.poolSize, kernelGeneration: result.kernelGeneration, wasmMemoryBytes: result.wasmMemoryBytes,
        engine: result.engine, backend: result.backend, elapsedMs: result.elapsedMs,
        totalLength: result.totalLength, stageTimings: result.stageTimings,
        atomStructureTypes: Array.from(result.atomStructureTypes),
        segments: result.segments.map(segment => ({ id: segment.id, family: segment.familyId,
          structureType: segment.structureType, closed: segment.closed, isInfinite: segment.isInfinite,
          length: segment.length, burgersVector: segment.burgersVector,
          spatialBurgersVector: segment.spatialBurgersVector, junctions: segment.junctions,
          points: Array.from(segment.points) })) });
      state.makeClient = workerCount => new DxaClient({ workerCount,
        environment: { navigator: { hardwareConcurrency: 8 }, crossOriginIsolated, SharedArrayBuffer: globalThis.SharedArrayBuffer },
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

    // A non-isolated host must silently retain the single-threaded backend,
    // even when a caller requests multiple threads.
    if (!isolated) {
      const fallback = await evaluate(`(async () => {
        const state = dxaParallelChecks; state.client = state.makeClient(2);
        const result = await state.client.analyze(state.screw, {}, { onProgress: state.recordProgress });
        state.result = state.summarize(result); return state.result;
      })()`);
      assert.equal(fallback.threaded, false);
      assert.equal(fallback.workerCount, 1);
      assert.equal(fallback.segments.length, 1);
      assert.equal(fallback.segments[0].family, 'perfect');
      assert.ok(Math.abs(fallback.totalLength - 6 * 3.52 / Math.sqrt(2)) < serialLengthTolerance);
      assert.ok(Array.isArray(fallback.stageTimings) && fallback.stageTimings.length >= 11);
      assert.ok(fallback.stageTimings.every(stage => Number.isFinite(stage.elapsedMs) && stage.elapsedMs >= 0));
      const targetsBeforeClose = await createdTargets();
      assert.equal(targetsBeforeClose.length, 1, 'Static hosting must create no nested pthread Workers.');
      await evaluate('dxaParallelChecks.client.close()');
      await waitForAllWorkersToClose('Serial fallback Worker shutdown');
      return { deployment: 'Static host without COOP/COEP', environment,
        workerTargets: targetsBeforeClose.length, ...compact(fallback) };
    }

    assert.equal(environment.sharedMemory, true);
    const baseline = await evaluate(`(async () => {
      const state = dxaParallelChecks; state.serial = state.makeClient(1);
      const result = await state.serial.analyze(state.screw, {}, { onProgress: state.recordProgress });
      return state.summarize(result);
    })()`);
    assert.equal(baseline.workerCount, 1);
    assert.equal(baseline.threaded, true, 'An isolated host initializes one shared kernel even for a one-thread calculation.');
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
    // so compare the exact periodic winding to the analytic straight length.
    const points = threaded.segments[0].points;
    const periodicWindingZ = Math.abs(points.at(-1) - points[2]);
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
  }, { software, isolated });
}

function compact(result) {
  const { atomStructureTypes, segments, ...rest } = result;
  return { ...rest, atomCount: atomStructureTypes.length, segments: segments.length,
    burgersVector: segments[0]?.burgersVector, spatialBurgersVector: segments[0]?.spatialBurgersVector };
}

const staticHost = await checkDeployment(false);
const isolatedHost = await checkDeployment(true);
console.log(JSON.stringify({ scope: 'Real browser DXA serial fallback, shared-kernel pool growth, cooperative cancellation, recovery and shutdown',
  staticHost, isolatedHost }, null, 2));
