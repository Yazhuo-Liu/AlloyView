import assert from 'node:assert/strict';
import test from 'node:test';
import { DxaClient } from '../src/analysis/dxa-client.js';
import { createCell } from '../src/data/model.js';
import { CpuBudget } from '../src/analysis/cpu-budget.js';

class FakeWorker {
  constructor() { this.listeners = new Map(); this.messages = []; this.terminated = false; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  postMessage(message, transfer = []) { this.messages.push(structuredClone(message, { transfer })); }
  terminate() { this.terminated = true; }
  emit(data) { this.listeners.get('message')({ data }); }
}
const source = () => ({ fractional: new Float64Array([0, 0, 0, .5, .5, 0, .5, 0, .5, 0, .5, .5]),
  cell: createCell({ vectors: [4, 0, 0, 1, 4, 0, 0, 0, 4] }) });
const setup = (options = {}) => {
  const workers = [], client = new DxaClient({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    yieldToMain: async () => {}, environment: globalThis, ...options });
  return { client, workers };
};
const flush = () => new Promise(resolve => setImmediate(resolve));

test('DXA client transfers owned coordinate copies without detaching the displayed frame', async () => {
  const { client, workers } = setup(), frame = source(), progress = [];
  const request = client.analyze(frame, { lattice: 'bcc', gpuEnabled: true }, { onProgress: event => progress.push(event) });
  await flush();
  const worker = workers[0], task = worker.messages[0];
  assert.equal(frame.fractional.byteLength, 12 * 8); assert.equal(frame.cell.vectors.byteLength, 9 * 8);
  assert.notEqual(task.frame.fractional.buffer, frame.fractional.buffer);
  assert.deepEqual(Array.from(task.frame.fractional), Array.from(frame.fractional));
  assert.equal(task.parameters.lattice, 'bcc'); assert.equal(Object.hasOwn(task.parameters, 'gpuEnabled'), false);
  assert.equal(Object.keys(task).some(key => /gpu/i.test(key)), false);
  worker.emit({ id: task.id, progress: { phase: 'triangulating', completedStages: 3, totalStages: 12 } });
  assert.equal(progress.at(-1).phase, 'triangulating'); assert.equal(progress.at(-1).workerCount, 1);
  worker.emit({ id: task.id, ok: true, result: { segments: [], engine: 'Wasm CPU' } });
  assert.equal((await request).engine, 'Wasm CPU'); assert.equal(client.pending.size, 0);
  client.close();
});


test('DXA ignores legacy GPU flags and does not read or dispatch a GPU backend', async () => {
  let calls = 0;
  const backend = new Proxy({}, { get() { calls++; throw new Error('DXA must not read GPU state.'); } });
  const { client, workers } = setup({ gpuBackend: backend, environment: { navigator: { gpu: {} } } });
  const request = client.analyze(source(), { gpuEnabled: true });
  await flush();
  const worker = workers[0], task = worker.messages[0];
  assert.equal(Object.keys(task).some(key => /gpu/i.test(key)), false);
  assert.equal(Object.hasOwn(task.parameters, 'gpuEnabled'), false);
  worker.emit({ id: task.id, ok: true, result: { backend: 'cpu', engine: 'Wasm CPU' } });
  assert.equal((await request).backend, 'cpu');
  assert.equal(calls, 0);
  assert.equal(typeof client.classifyGpu, 'undefined');
  await client.close();
});

test('running DXA cancellation terminates native work, ignores stale output and creates a fresh worker', async () => {
  const { client, workers } = setup(), controller = new AbortController();
  const first = client.analyze(source(), {}, { signal: controller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await flush(); const oldWorker = workers[0], oldId = oldWorker.messages[0].id;
  controller.abort(); await rejected;
  assert.equal(oldWorker.terminated, true); assert.equal(client.worker, null);
  const progress = [], second = client.analyze(source(), {}, { onProgress: event => progress.push(event) });
  await flush(); const newWorker = workers[1], newId = newWorker.messages[0].id;
  oldWorker.emit({ id: newId, ok: true, result: { incorrect: true } });
  oldWorker.emit({ id: oldId, progress: { phase: 'old-source' } });
  oldWorker.listeners.get('error')({ message: 'old failure' });
  assert.equal(client.pending.size, 1); assert.equal(progress.some(event => event.phase === 'old-source'), false);
  newWorker.emit({ id: newId, ok: true, result: { correct: true } });
  assert.deepEqual(await second, { correct: true }); client.close();
});

test('DXA client serializes whole-frame jobs and cancelling queued work keeps the active kernel', async () => {
  const { client, workers } = setup(), controller = new AbortController();
  const first = client.analyze(source()), second = client.analyze(source(), {}, { signal: controller.signal }), third = client.analyze(source());
  const rejected = assert.rejects(second, { name: 'AbortError' });
  await flush(); const worker = workers[0];
  assert.equal(worker.messages.length, 1);
  controller.abort(); await rejected; assert.equal(worker.terminated, false);
  worker.emit({ id: worker.messages[0].id, ok: true, result: { frame: 1 } });
  assert.deepEqual(await first, { frame: 1 }); await flush();
  assert.equal(workers.length, 1); assert.equal(worker.messages.length, 2);
  worker.emit({ id: worker.messages[1].id, ok: true, result: { frame: 3 } });
  assert.deepEqual(await third, { frame: 3 }); client.close();
});

test('source reset aborts active and queued DXA jobs without dispatching old source frames', async () => {
  const { client, workers } = setup();
  const first = client.analyze(source()), second = client.analyze(source());
  const rejected = Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]);
  await flush(); await client.clearFrames(); await rejected; await flush();
  assert.equal(workers.length, 1); assert.equal(workers[0].messages.length, 1); assert.equal(workers[0].terminated, true);
  assert.equal(client.pending.size, 0); assert.equal(client.current, null);
  const next = client.analyze(source()); await flush();
  workers[1].emit({ id: workers[1].messages[0].id, ok: true, result: {} }); await next;
  client.close(); await assert.rejects(client.analyze(source()), { name: 'AbortError' });
});

test('DXA worker failures reject the active job and queued work uses a fresh worker', async () => {
  const { client, workers } = setup();
  const first = client.analyze(source()), second = client.analyze(source());
  const rejected = assert.rejects(first, /worker crashed/);
  await flush(); workers[0].listeners.get('error')({ message: 'worker crashed' }); await rejected; await flush();
  assert.equal(workers[0].terminated, true); assert.equal(workers.length, 2);
  workers[1].emit({ id: workers[1].messages[0].id, ok: false, error: 'Cell is too thin.', name: 'Error' });
  await assert.rejects(second, /too thin/); assert.equal(client.pending.size, 0); client.close();
});

test('DXA cancellation while preparing a frame never starts a native worker', async () => {
  let resume; const workers = [], controller = new AbortController();
  const client = new DxaClient({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
    yieldToMain: () => new Promise(resolve => { resume = resolve; }) });
  const request = client.analyze(source(), {}, { signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' }); await flush(); controller.abort(); resume(); await rejected; await flush();
  assert.equal(workers.length, 0); assert.equal(client.pending.size, 0); client.close();
});

test('a fatal Wasm error releases the damaged module before another DXA job', async () => {
  const { client, workers } = setup();
  const first = client.analyze(source()), second = client.analyze(source());
  const rejected = assert.rejects(first, { name: 'RuntimeError' });
  await flush(); const worker = workers[0];
  worker.emit({ id: worker.messages[0].id, ok: false, error: 'Wasm memory access failed.', name: 'RuntimeError', fatal: true });
  await rejected; await flush();
  assert.equal(worker.terminated, true); assert.equal(workers.length, 2);
  workers[1].emit({ id: workers[1].messages[0].id, ok: true, result: {} });
  await second; client.close();
});

test('DXA prewarming grows a retained coordinator and source reset keeps its Wasm resources', async () => {
  const workers = [], environment = { navigator: { hardwareConcurrency: 8 }, crossOriginIsolated: true, SharedArrayBuffer };
  const client = new DxaClient({ environment, workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }, yieldToMain: async () => {} });
  const control = { cancelBuffer: new SharedArrayBuffer(64), cancelPointer: 0 };
  for (const count of [2, 3, 4]) {
    const warming = client.warmup({ atomCount: 16000, workerCount: count });
    await flush();
    const worker = workers[0], message = worker.messages.at(-1);
    assert.equal(message.type, 'warmup');
    assert.equal(message.frame, undefined, 'warming does not clone atom arrays');
    worker.emit({ id: message.id, control });
    worker.emit({ id: message.id, ok: true, result: { workerCount: count, poolSize: count - 1,
      kernelGeneration: 1, wasmMemoryBytes: 32 * 1024 ** 2, sharedMemory: true } });
    assert.equal((await warming).kernelGeneration, 1);
  }
  await client.clearFrames();
  const smaller = await client.warmup({ atomCount: 16000, workerCount: 1 });
  assert.equal(smaller.poolSize, 3);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages.length, 3, 'a prepared smaller target sends no initialization request');
  assert.equal(workers[0].terminated, false);
  assert.equal(client.cpuBudget.active, 0);
  await client.close(); assert.equal(workers[0].terminated, true);
});

test('shared DXA cancellation keeps the Worker and lease until ACK, then resets the same word for queued work', async () => {
  const workers = [], environment = { navigator: { hardwareConcurrency: 8 }, crossOriginIsolated: true, SharedArrayBuffer };
  const client = new DxaClient({ environment, workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }, yieldToMain: async () => {} });
  const controller = new AbortController(), control = { cancelBuffer: new SharedArrayBuffer(64), cancelPointer: 0 };
  const first = client.analyze(source(), {}, { signal: controller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await flush();
  const worker = workers[0], firstId = worker.messages[0].id;
  worker.emit({ id: firstId, control });
  const next = client.analyze(source());
  controller.abort(); await rejected;
  assert.equal(Atomics.load(new Int32Array(control.cancelBuffer), 0), 1);
  assert.equal(worker.terminated, false);
  assert.equal(client.cpuBudget.active, 1);
  assert.equal(worker.messages.length, 1);
  worker.emit({ id: firstId, control });
  assert.equal(Atomics.load(new Int32Array(control.cancelBuffer), 0), 1, 'late control delivery preserves cancellation');
  worker.emit({ id: firstId, ok: false, name: 'AbortError', error: 'Cancelled' });
  await flush();
  assert.equal(Atomics.load(new Int32Array(control.cancelBuffer), 0), 0);
  assert.equal(workers.length, 1);
  worker.emit({ id: worker.messages[1].id, ok: true, result: { segments: [] } });
  await next;
  assert.equal(client.cpuBudget.active, 0);
  assert.equal(client.current, null);
  await client.close();
});

test('a foreground DXA request preempts warmup without discarding an initializing serial module', async () => {
  const { client, workers } = setup();
  const warming = client.warmup({ atomCount: 1 });
  const rejected = assert.rejects(warming, { name: 'AbortError' });
  await flush();
  const worker = workers[0], warmId = worker.messages[0].id;
  const calculation = client.analyze(source());
  await rejected;
  assert.equal(worker.terminated, false);
  assert.equal(worker.messages.filter(message => message.type !== 'cancel').length, 1, 'native work starts only after initialization acknowledges');
  assert.deepEqual(worker.messages.at(-1), { type: 'cancel', id: warmId });
  worker.emit({ id: warmId, ok: true, result: { workerCount: 1, poolSize: 0, kernelGeneration: 1, sharedMemory: false } });
  await flush();
  assert.equal(workers.length, 1);
  assert.equal(worker.messages.at(-1).type, 'analyze');
  worker.emit({ id: worker.messages.at(-1).id, ok: true, result: { segments: [] } });
  await calculation;
  assert.equal(client.cpuBudget.active, 0);
  await client.close();
});

test('pthread startup fallback is retained and later jobs acquire only one CPU permit', async () => {
  const environment = { navigator: { hardwareConcurrency: 8 }, crossOriginIsolated: true, SharedArrayBuffer };
  const { client, workers } = setup({ environment });
  const warming = client.warmup({ atomCount: 16000, workerCount: 4 });
  await flush();
  const worker = workers[0], message = worker.messages[0];
  assert.equal(message.workerCount, 4);
  worker.emit({ id: message.id, control: null });
  worker.emit({ id: message.id, ok: true, result: { workerCount: 1, poolSize: 0,
    kernelGeneration: 1, wasmMemoryBytes: 32 * 1024 ** 2, sharedMemory: false,
    threadingFallback: 'Pthread startup denied by the host.' } });
  assert.equal((await warming).workerCount, 1);
  const cached = await client.warmup({ atomCount: 16000, workerCount: 6 });
  assert.equal(cached.workerCount, 1);
  assert.equal(cached.threadingFallback, 'Pthread startup denied by the host.');
  assert.equal(worker.messages.length, 1, 'failed pool startup is not retried on each frame');
  const calculation = client.analyze({ ...source(), fractional: new Float64Array(16000 * 3) });
  await flush();
  assert.equal(worker.messages.at(-1).workerCount, 1);
  assert.equal(client.cpuBudget.active, 1);
  worker.emit({ id: worker.messages.at(-1).id, ok: true, result: { backend: 'cpu' } });
  await calculation;
  assert.equal(client.cpuBudget.active, 0);
  await client.close();
});

for (const announcement of ['before', 'after']) {
  test(`serial cancellation works in an isolated browser when fallback control arrives ${announcement} abort`, async () => {
    const environment = { navigator: { hardwareConcurrency: 8 }, crossOriginIsolated: true, SharedArrayBuffer };
    const { client, workers } = setup({ environment }), controller = new AbortController();
    const request = client.analyze(source(), {}, { signal: controller.signal });
    const rejected = assert.rejects(request, { name: 'AbortError' });
    await flush();
    const worker = workers[0], id = worker.messages[0].id;
    if (announcement === 'before') worker.emit({ id, control: null });
    controller.abort(); await rejected;
    if (announcement === 'after') {
      assert.equal(worker.terminated, false);
      assert.equal(client.cpuBudget.active, 1, 'a possible shared startup retains its permit until mode is known');
      worker.emit({ id, control: null });
    }
    assert.equal(worker.terminated, true);
    assert.equal(client.cpuBudget.active, 0);
    assert.equal(client.current, null);
    const next = client.analyze(source()); await flush();
    assert.equal(workers.length, 2);
    workers[1].emit({ id: workers[1].messages[0].id, ok: true, result: { backend: 'cpu' } });
    await next;
    await client.close();
  });
}

for (const fallback of ['serial-module', 'pthread-pool']) {
  test(`a scientific error after ${fallback} fallback retains the actual one-thread CPU budget`, async () => {
    const environment = { navigator: { hardwareConcurrency: 8 }, crossOriginIsolated: true, SharedArrayBuffer };
    const { client, workers } = setup({ environment });
    const frame = { ...source(), fractional: new Float64Array(16000 * 3) };
    const calculation = client.analyze(frame, {}, { workerCount: 4 });
    const rejected = assert.rejects(calculation, /periodic cell too thin/);
    await flush();
    const worker = workers[0], id = worker.messages[0].id;
    assert.equal(worker.messages[0].workerCount, 4);
    if (fallback === 'serial-module') worker.emit({ id, control: null });
    else {
      worker.emit({ id, control: { cancelBuffer: new SharedArrayBuffer(64), cancelPointer: 0 } });
      worker.emit({ id, progress: { phase: 'Pthread startup unavailable; using one CPU thread', workerCount: 1,
        threadingFallback: 'Pthread startup denied.' } });
    }
    worker.emit({ id, ok: false, error: 'periodic cell too thin' });
    await rejected;
    assert.equal(client.ready, null, 'error replies do not fabricate warmed-module diagnostics');
    assert.equal(client.cpuBudget.active, 0);
    const warming = client.warmup({ atomCount: 16000, workerCount: 6 });
    await flush();
    assert.equal(worker.messages.at(-1).workerCount, 1);
    assert.equal(client.cpuBudget.active, 1);
    worker.emit({ id: worker.messages.at(-1).id, ok: true, result: { workerCount: 1, poolSize: 0, kernelGeneration: 1,
      sharedMemory: fallback === 'pthread-pool', ...(fallback === 'pthread-pool' ? { threadingFallback: 'Pthread startup denied.' } : {}) } });
    await warming;
    const next = client.analyze(frame, {}, { workerCount: 4 }); await flush();
    assert.equal(worker.messages.at(-1).workerCount, 1);
    assert.equal(client.cpuBudget.active, 1);
    worker.emit({ id: worker.messages.at(-1).id, ok: true, result: { backend: 'cpu' } });
    await next;
    assert.equal(client.cpuBudget.active, 0);
    await client.close();
  });
}

test('ordinary one-thread work does not latch serial execution, and Worker replacement clears a fallback latch', async () => {
  const environment = { navigator: { hardwareConcurrency: 8 }, crossOriginIsolated: true, SharedArrayBuffer };
  const { client, workers } = setup({ environment });
  const small = client.analyze(source()); await flush();
  const worker = workers[0], firstId = worker.messages[0].id;
  worker.emit({ id: firstId, control: { cancelBuffer: new SharedArrayBuffer(64), cancelPointer: 0 } });
  worker.emit({ id: firstId, progress: { phase: 'warming', workerCount: 1 } });
  worker.emit({ id: firstId, ok: true, result: { workerCount: 1, poolSize: 0, kernelGeneration: 1, sharedMemory: true } });
  await small;
  const frame = { ...source(), fractional: new Float64Array(16000 * 3) };
  const larger = client.analyze(frame, {}, { workerCount: 4 });
  const rejected = assert.rejects(larger, /damaged Wasm/); await flush();
  const id = worker.messages.at(-1).id;
  assert.equal(worker.messages.at(-1).workerCount, 4, 'small frames do not disable later parallel work');
  worker.emit({ id, progress: { phase: 'warming', workerCount: 1, threadingFallback: 'Pthread startup denied.' } });
  worker.emit({ id, ok: false, error: 'damaged Wasm', fatal: true });
  await rejected;
  const recovery = client.analyze(frame, {}, { workerCount: 4 }); await flush();
  assert.equal(workers.length, 2);
  assert.equal(workers[1].messages[0].workerCount, 4, 'a fresh Worker may attempt normal threading again');
  workers[1].emit({ id: workers[1].messages[0].id, ok: true, result: { backend: 'cpu' } });
  await recovery;
  await client.close();
});

const staticEnvironment = { navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: false };
const largeSource = () => ({ ...source(), fractional: new Float64Array(8192 * 3) });
const stageReply = () => ({ structures: new Int32Array(8192), neighbors: new Int32Array(8192 * 12),
  neighborWidth: 12, maxNeighborDistance: 3, workerCount: 2, elapsedMs: 5 });

test('nonisolated stage RPC releases the coordinator permit before pooled work and reacquires it before import', async () => {
  const cpuBudget = new CpuBudget({ environment: staticEnvironment }); let calls = 0;
  const cpuStageBackend = { analyzeDxaTetrahedra() {}, async analyzeDxaLocal(input, options) {
    calls++; assert.equal(cpuBudget.active, 0, 'the waiting native coordinator holds no compute permit');
    assert.equal(options.workerCount, 2); assert.equal(options.taskTimeoutMs, 123);
    const lease = await cpuBudget.acquire(2, { signal: options.signal });
    assert.equal(cpuBudget.active, 2); lease.release(); return stageReply();
  } };
  const { client, workers } = setup({ environment: staticEnvironment, cpuBudget, cpuStageBackend, cpuStageTaskTimeoutMs: 123 });
  const pending = client.analyze(largeSource()); await flush();
  const worker = workers[0], initial = worker.messages[0];
  assert.equal(initial.cpuOffload, true); assert.equal(initial.workerCount, 1); assert.equal(cpuBudget.active, 1);
  worker.emit({ id: initial.id, control: null });
  worker.emit({ id: initial.id, progress: { cpuStage: 'local', awaitingCpuStage: true } });
  worker.emit({ id: initial.id, cpuStageRequest: { requestId: 1, stage: 'local', input: { immutable: true } } });
  await flush();
  assert.equal(calls, 1); assert.equal(cpuBudget.active, 1);
  const reply = worker.messages.at(-1);
  assert.equal(reply.type, 'cpu-stage-result'); assert.equal(reply.ok, true); assert.equal(reply.result.structures.length, 8192);
  worker.emit({ id: initial.id, ok: true, result: { nativeWorkerCount: 1, workerCount: 2, backend: 'cpu' } });
  await pending; assert.equal(cpuBudget.active, 0);
  await client.close();
});

test('private CPU stage failure reacquires a native permit and supplies a stage fallback reply', async () => {
  const cpuBudget = new CpuBudget({ environment: staticEnvironment });
  const cpuStageBackend = { analyzeDxaTetrahedra() {}, async analyzeDxaLocal() {
    assert.equal(cpuBudget.active, 0); throw new Error('The private Worker could not initialize.');
  } };
  const { client, workers } = setup({ environment: staticEnvironment, cpuBudget, cpuStageBackend });
  const pending = client.analyze(largeSource()); await flush();
  const worker = workers[0], id = worker.messages[0].id;
  worker.emit({ id, cpuStageRequest: { requestId: 2, stage: 'local', input: {} } }); await flush();
  assert.equal(cpuBudget.active, 1); assert.equal(worker.messages.at(-1).ok, false);
  assert.match(worker.messages.at(-1).error, /could not initialize/); assert.equal(worker.terminated, false);
  worker.emit({ id, ok: true, result: { backend: 'cpu' } }); await pending;
  assert.equal(cpuBudget.active, 0); await client.close();
});

test('automatic private DXA degree leaves room for interface snapshots while explicit requests remain available', async () => {
  for (const [requested, expected] of [[undefined, 4], [8, 8]]) {
    const environment = { ...staticEnvironment, navigator: { hardwareConcurrency: 40 } };
    const atomCount = 60229, degrees = [];
    const cpuStageBackend = { analyzeDxaTetrahedra() {}, async analyzeDxaLocal(input, options) {
      degrees.push(options.workerCount);
      return { structures: new Int32Array(atomCount), neighbors: new Int32Array(atomCount * 12),
        neighborWidth: 12, maxNeighborDistance: 3, workerCount: expected };
    } };
    const { client, workers } = setup({ environment, cpuStageBackend });
    const frame = { ...source(), fractional: new Float64Array(atomCount * 3) };
    const pending = client.analyze(frame, {}, { workerCount: requested }); await flush();
    const worker = workers[0], initial = worker.messages[0];
    assert.equal(initial.workerCount, 1); assert.equal(initial.cpuOffload, true);
    worker.emit({ id: initial.id, cpuStageRequest: { requestId: 5, stage: 'local', input: {} } }); await flush();
    assert.deepEqual(degrees, [expected]);
    worker.emit({ id: initial.id, ok: true, result: { backend: 'cpu' } }); await pending;
    assert.equal(frame.fractional.byteLength, atomCount * 3 * 8);
    await client.close();
  }
});

test('CPU stage cancellation waits for private job cleanup and native ACK before the next frame reuses its coordinator', async () => {
  const cpuBudget = new CpuBudget({ environment: staticEnvironment }), controller = new AbortController();
  let finishStage;
  const cpuStageBackend = { analyzeDxaTetrahedra() {}, async analyzeDxaLocal(input, { signal }) {
    const lease = await cpuBudget.acquire(2, { signal });
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { finishStage = () => {
        lease.release(); reject(new DOMException('Private jobs joined.', 'AbortError'));
      }; }, { once: true });
    });
  } };
  const { client, workers } = setup({ environment: staticEnvironment, cpuBudget, cpuStageBackend });
  const first = client.analyze(largeSource(), {}, { signal: controller.signal });
  const rejection = assert.rejects(first, { name: 'AbortError' }); await flush();
  const worker = workers[0], id = worker.messages[0].id;
  worker.emit({ id, control: null });
  worker.emit({ id, cpuStageRequest: { requestId: 3, stage: 'local', input: {} } }); await flush();
  assert.equal(cpuBudget.active, 2);
  const second = client.analyze(source());
  controller.abort(); await rejection;
  assert.equal(worker.terminated, false); assert.equal(worker.messages.at(-1).type, 'cancel');
  worker.emit({ id, ok: false, error: 'Cancelled.', name: 'AbortError' }); await flush();
  assert.equal(worker.messages.filter(message => message.type === 'analyze').length, 1,
    'an early native ACK must not hide still-running private jobs');
  assert.equal(client.current.id, id);
  finishStage(); await flush(); await flush();
  assert.equal(cpuBudget.active, 1); assert.equal(workers.length, 1);
  assert.equal(worker.messages.at(-1).type, 'analyze'); assert.notEqual(worker.messages.at(-1).id, id);
  worker.emit({ id: worker.messages.at(-1).id, ok: true, result: { backend: 'cpu' } });
  await second; assert.equal(cpuBudget.active, 0); await client.close();
});

for (const failure of ['fatal', 'error', 'messageerror']) {
  test(`DXA coordinator ${failure} waits for private cleanup before preparing the next frame`, async () => {
    // Leave a third permit available: a prematurely retired frame could
    // dispatch its successor while the old private snapshots still exist.
    const environment = { ...staticEnvironment, navigator: { hardwareConcurrency: 6 } };
    const cpuBudget = new CpuBudget({ environment });
    let finishCleanup;
    const cpuStageBackend = { analyzeDxaTetrahedra() {}, async analyzeDxaLocal(input, { signal }) {
      const lease = await cpuBudget.acquire(2, { signal });
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { finishCleanup = () => {
          lease.release(); reject(new DOMException('Private jobs joined.', 'AbortError'));
        }; }, { once: true });
      });
    } };
    const { client, workers } = setup({ environment, cpuBudget, cpuStageBackend });
    const first = client.analyze(largeSource());
    const rejected = assert.rejects(first, /crash/); await flush();
    const worker = workers[0], id = worker.messages[0].id;
    worker.emit({ id, control: null });
    worker.emit({ id, cpuStageRequest: { requestId: 4, stage: 'local', input: {} } }); await flush();
    assert.equal(cpuBudget.active, 2);
    const second = client.analyze(source());
    if (failure === 'fatal') worker.emit({ id, ok: false, error: 'Native Worker crash.', name: 'RuntimeError', fatal: true });
    else worker.listeners.get(failure)({ message: 'Native Worker crash.' });
    await rejected; await flush();
    assert.equal(worker.terminated, true, 'A damaged coordinator stops immediately.');
    assert.equal(client.current.id, id, 'The old frame retains ownership until its private jobs join.');
    assert.equal(workers.length, 1, 'The next frame has not allocated another coordinator.');
    assert.equal(cpuBudget.active, 2); assert.equal(client.queue.length, 1);
    finishCleanup(); await flush(); await flush();
    assert.equal(workers.length, 2); assert.equal(cpuBudget.active, 1);
    const nextWorker = workers[1];
    assert.equal(nextWorker.messages[0].type, 'analyze');
    nextWorker.emit({ id: nextWorker.messages[0].id, ok: true, result: { recovered: true } });
    assert.deepEqual(await second, { recovered: true });
    assert.equal(cpuBudget.active, 0); assert.equal(client.current, null);
    await client.close();
  });
}

test('explicit one-worker requests and isolated browsers retain the native route despite an available stage pool', async () => {
  for (const environment of [staticEnvironment, { ...staticEnvironment, crossOriginIsolated: true, SharedArrayBuffer }]) {
    const { client, workers } = setup({ environment, cpuStageBackend: { analyzeDxaLocal() {}, analyzeDxaTetrahedra() {} } });
    const pending = client.analyze(largeSource(), {}, { workerCount: 1 }); await flush();
    assert.equal(workers[0].messages[0].cpuOffload, false);
    workers[0].emit({ id: workers[0].messages[0].id, ok: true, result: {} }); await pending; await client.close();
  }
});
