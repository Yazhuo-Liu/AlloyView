import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Imported by the complete pthread/private-stage suite. These cases use real
// nonisolated Workers and the shared application CPU permit accounting.
export async function runPrivateDxaStageChecks({ software = true } = {}) {
  const results = [];
  for (const stage of ['local', 'tetrahedra']) {
    for (const failure of ['constructor', 'stalled', 'protocol']) {
      results.push(await runScenario({ stage, failure }, software));
      console.error(`Passed private DXA ${stage} CPU fallback: ${failure}.`);
    }
    results.push(await runScenario({ stage, cancel: true }, software));
    console.error(`Passed private DXA ${stage} CPU cancellation and recovery.`);
  }
  return results;
}

async function runScenario(scenario, software) {
  return withWebGpuBrowser(async ({ evaluate, call }) => {
    await call('Target.setDiscoverTargets', { discover: true });
    const initial = new Set((await call('Target.getTargets')).targetInfos.map(target => target.targetId));
    const liveWorkers = async () => (await call('Target.getTargets')).targetInfos
      .filter(target => target.type === 'worker' && !initial.has(target.targetId));
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await delay(20);
      }
      throw new Error(`${label}: ${await evaluate('JSON.stringify(privateDxaChecks.status)')}`);
    };
    await evaluate(`(${initializePrivateScenario.toString()})(${JSON.stringify(scenario)})`);
    const baseline = await evaluate('privateDxaChecks.baseline()', { timeoutMs: 120_000 });
    await waitFor(async () => (await liveWorkers()).length === 0, 'Serial comparison shutdown');

    let extraction, cancellation;
    if (scenario.cancel) {
      await evaluate('privateDxaChecks.startCancellation()');
      await waitFor(() => evaluate('Boolean(privateDxaChecks.status.cancelName || privateDxaChecks.status.unexpectedCompletion)'),
        `Cancel active ${scenario.stage} tasks`);
      await waitFor(() => evaluate('privateDxaChecks.client.current === null && privateDxaChecks.cpuBudget.active === 0'),
        'Private-stage cancellation acknowledgement releases the CPU budget');
      cancellation = await evaluate('privateDxaChecks.cancellationStatus()');
      assert.equal(cancellation.errorName, 'AbortError');
      assert.equal(cancellation.stage, scenario.stage);
      assert.ok(cancellation.completedAtoms > 0, 'Cancellation occurs after actual private stage work begins.');
      assert.equal(cancellation.coordinatorTerminated, false, 'An asynchronous CPU checkpoint preserves the native coordinator.');
      assert.equal(cancellation.pending, 0);
      assert.equal(cancellation.activeCpuJobs, 0);
      assert.equal(cancellation.activeCpuLease, 0);
      assert.ok(cancellation.acknowledgementMs < 5000, 'Cancel acknowledges before the ordinary stage deadline.');
    } else {
      extraction = await evaluate('privateDxaChecks.extractWithFault()', { timeoutMs: 120_000 });
      assertScience(extraction, baseline);
      const fallback = extraction.cpuStageFallbacks.find(row => row.stage === scenario.stage);
      assert.ok(fallback, `The failed ${scenario.stage} stage reports native recovery.`);
      assert.match(fallback.reason, scenario.failure === 'constructor' ? /Injected.*startup/i
        : scenario.failure === 'protocol' ? /Injected.*CPU task/i : /timed out|timeout|within/i);
      assert.equal(extraction.activeCpuJobs, 0);
      assert.equal(extraction.activeCpuLease, 0);
      assert.ok(extraction.failedWorkersTerminated, 'Failed or stalled pool slots are terminated.');
    }

    const recovery = await evaluate('privateDxaChecks.recover()', { timeoutMs: 120_000 });
    assertScience(recovery, baseline);
    assert.equal(recovery.cpuOffloadUsed, true);
    assert.equal(recovery.nativeWorkerCount, 1);
    assert.equal(recovery.workerCount, 2);
    assert.deepEqual(recovery.cpuStageWorkerCounts, { local: 2, tetrahedra: 2 });
    assert.deepEqual(recovery.cpuStageFallbacks, [], 'A recovered backend retries rather than latching an independent-pool failure.');
    assert.equal(recovery.activeCpuLease, 0);
    assert.equal(recovery.activeCpuJobs, 0);
    assert.equal(recovery.sourceCoordinateBytes, baseline.sourceCoordinateBytes);
    assert.equal(recovery.coordinatorsCreated, 2, 'Only the closed baseline and retained stage coordinator are created.');
    await evaluate('privateDxaChecks.close()');
    await waitFor(async () => (await liveWorkers()).length === 0, 'Every coordinator and private stage Worker shuts down');
    const compact = result => {
      if (!result) return result;
      const { atomLabels, segments, ...metadata } = result;
      return { ...metadata, atoms: atomLabels.length, segments: segments.length };
    };
    return { scenario, baseline: compact(baseline), extraction: compact(extraction), cancellation,
      recovery: compact(recovery), allWorkersClosed: true };
  }, { software, isolated: false, requireGpu: false });
}

function assertScience(actual, expected) {
  assert.equal(actual.backend, 'cpu');
  assert.equal(actual.nativeWorkerCount, 1);
  assert.deepEqual(actual.atomLabels, expected.atomLabels);
  assert.equal(actual.segments.length, 1);
  assert.equal(actual.totalLength, expected.totalLength);
  assert.deepEqual(actual.segments, expected.segments, 'Nonisolated native recovery preserves every segment point and field.');
  for (const key of ['family', 'structureType', 'closed', 'isInfinite', 'burgersVector', 'spatialBurgersVector', 'junctions']) {
    assert.deepEqual(actual.segments[0][key], expected.segments[0][key], `Complete private-stage extraction preserves ${key}.`);
  }
}

async function initializePrivateScenario(scenario) {
  const [{ DxaClient }, { AnalysisPool }, { CpuBudget }, { fccScrewFrame }] = await Promise.all([
    import('/AlloyView/src/analysis/dxa-client.js'), import('/AlloyView/src/analysis/analysis-pool.js'),
    import('/AlloyView/src/analysis/cpu-budget.js'), import('/AlloyView/tests/helpers/dislocations.js'),
  ]);
  const state = window.privateDxaChecks = { scenario, status: {}, coordinators: [], failedWorkers: [],
    source: fccScrewFrame(), faultEnabled: false };
  const environment = { navigator: { hardwareConcurrency: 8 }, crossOriginIsolated: false,
    SharedArrayBuffer: globalThis.SharedArrayBuffer };
  state.cpuBudget = new CpuBudget({ environment });
  state.pool = new AnalysisPool({ environment, cpuBudget: state.cpuBudget });
  const fakeProgram = scenario.failure === 'protocol'
    ? "self.onmessage = ({data}) => { if (data.id !== undefined) self.postMessage({id:data.id,ok:false,error:'Injected DXA CPU task failure'}); };"
    : 'self.onmessage = () => {};';
  state.failureUrl = URL.createObjectURL(new Blob([fakeProgram], { type: 'text/javascript' }));
  state.failedPool = new AnalysisPool({ environment, cpuBudget: state.cpuBudget, workerFactory: () => {
    if (scenario.failure === 'constructor') throw new Error('Injected DXA CPU Worker startup failure');
    const worker = new Worker(state.failureUrl, { type: 'module', name: 'DXA private stage fault validation' });
    const row = { terminated: false }; state.failedWorkers.push(row);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { row.terminated = true; terminate(); };
    return worker;
  } });
  const runStage = (stage, input, options) => {
    const failed = state.faultEnabled && stage === scenario.stage;
    const pool = failed ? state.failedPool : state.pool;
    return pool[stage === 'local' ? 'analyzeDxaLocal' : 'analyzeDxaTetrahedra'](input,
      { ...options, ...(failed ? { taskTimeoutMs: 150 } : {}) });
  };
  const cpuStageBackend = {
    analyzeDxaLocal: (input, options) => runStage('local', input, options),
    analyzeDxaTetrahedra: (input, options) => runStage('tetrahedra', input, options),
  };
  state.makeClient = workerCount => new DxaClient({ workerCount, environment,
    cpuStageBackend, cpuBudget: state.cpuBudget, workerFactory: () => {
      const worker = new Worker('/AlloyView/src/workers/dxa-worker.js', { type: 'module', name: 'DXA private stage coordinator' });
      const row = { terminated: false }; state.coordinators.push(row);
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => { row.terminated = true; terminate(); };
      return worker;
    } });
  state.summarize = result => ({ backend: result.backend, engine: result.engine,
    workerCount: result.workerCount, nativeWorkerCount: result.nativeWorkerCount,
    cpuOffloadUsed: result.cpuOffloadUsed, cpuStageWorkerCounts: result.cpuStageWorkerCounts,
    cpuStageTimings: result.cpuStageTimings, cpuStageFallbacks: result.cpuStageFallbacks,
    totalLength: result.totalLength, atomLabels: Array.from(result.atomStructureTypes),
    kernelGeneration: result.kernelGeneration, elapsedMs: result.elapsedMs,
    sourceCoordinateBytes: state.source.fractional.byteLength,
    activeCpuLease: state.cpuBudget.active, activeCpuJobs: state.pool.active.size + state.failedPool.active.size,
    failedWorkersTerminated: state.failedWorkers.every(row => row.terminated),
    coordinatorsCreated: state.coordinators.length,
    segments: result.segments.map(segment => ({ id: segment.id, length: segment.length,
      points: Array.from(segment.points), family: segment.familyId, structureType: segment.structureType,
      closed: segment.closed, isInfinite: segment.isInfinite, burgersVector: segment.burgersVector,
      spatialBurgersVector: segment.spatialBurgersVector, junctions: segment.junctions })) });
  state.baseline = async () => {
    const client = state.makeClient(1), result = state.summarize(await client.analyze(state.source));
    client.close(); return result;
  };
  state.extractWithFault = async () => {
    state.faultEnabled = true; state.client = state.makeClient(2);
    return state.summarize(await state.client.analyze(state.source));
  };
  state.startCancellation = () => {
    state.client = state.makeClient(2); state.controller = new AbortController();
    const frame = state.source;
    state.promise = state.client.analyze(frame, {}, { signal: state.controller.signal, onProgress: progress => {
      if (progress.cpuStage === scenario.stage && progress.completedAtoms > 0 && !state.cancelProgress) {
        state.cancelProgress = progress; state.cancelStarted = performance.now(); state.controller.abort();
      }
    } }).then(() => { state.status.unexpectedCompletion = true; }, error => { state.status.cancelName = error.name; });
  };
  state.cancellationStatus = () => ({ errorName: state.status.cancelName, stage: state.cancelProgress?.cpuStage,
    completedAtoms: state.cancelProgress?.completedAtoms,
    acknowledgementMs: performance.now() - state.cancelStarted,
    coordinatorTerminated: state.coordinators.at(-1).terminated, pending: state.client.pending.size,
    activeCpuJobs: state.pool.active.size, activeCpuLease: state.cpuBudget.active });
  state.recover = async () => {
    state.faultEnabled = false;
    return state.summarize(await state.client.analyze(state.source));
  };
  state.close = () => { state.client.close(); state.pool.close(); state.failedPool.close(); URL.revokeObjectURL(state.failureUrl); };
}
