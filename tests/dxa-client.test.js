import assert from 'node:assert/strict';
import test from 'node:test';
import { DxaClient } from '../src/analysis/dxa-client.js';
import { createCell } from '../src/data/model.js';

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
    yieldToMain: async () => {}, environment: options.gpuBackend ? { navigator: { gpu: {} } } : globalThis, ...options });
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
  assert.equal(task.parameters.lattice, 'bcc'); assert.equal(task.parameters.gpuEnabled, true);
  worker.emit({ id: task.id, progress: { phase: 'triangulating', completedStages: 3, totalStages: 12 } });
  assert.equal(progress.at(-1).phase, 'triangulating'); assert.equal(progress.at(-1).workerCount, 1);
  worker.emit({ id: task.id, ok: true, result: { segments: [], engine: 'Wasm CPU' } });
  assert.equal((await request).engine, 'Wasm CPU'); assert.equal(client.pending.size, 0);
  client.close();
});

const topologySnapshot = () => ({ vertexCount: 4, tetrahedronCount: 2, edgeCount: 1, transitionCount: 1,
  alpha: 3, vertices: new Float64Array(12), tetrahedra: new Uint32Array(32),
  edges: new Uint32Array(8), transitions: new Float64Array(20) });

const localInput = () => ({ coordinates: new Float64Array(12), templates: new Uint32Array(165),
  inverse: new Float64Array(9), lattice: 1, identifyPlanarDefects: true, atomCount: 4, neighborWidth: 12 });

test('DXA local correspondence uses the shared GPU backend with the original frame identity', async () => {
  const calls = [], progress = [], frame = source();
  const { client, workers } = setup({ gpuBackend: {
    async identifyDxa(actualFrame, input, options) {
      assert.equal(actualFrame, frame, 'resident GPU frame cache identity is preserved');
      const owned = structuredClone(input, { transfer: [input.coordinates.buffer, input.templates.buffer, input.inverse.buffer] });
      calls.push({ input: owned, signal: options.signal });
      options.onProgress({ phase: 'GPU local correspondence', completedAtoms: 2, totalAtoms: 4 });
      return { structures: new Int32Array(4), neighbors: new Int32Array(48).fill(-1),
        neighborWidth: 12, maxNeighborDistance: 0, gpuStages: ['local-neighbors', 'local-structures', 'local-correspondence'] };
    },
    async classifyDxa() { return { regions: new Int32Array([-1, 0]) }; },
  } });
  const request = client.analyze(frame, { gpuEnabled: true }, { onProgress: event => progress.push(event) });
  await flush();
  const worker = workers[0], task = worker.messages[0], input = localInput();
  assert.equal(task.gpuLocalAvailable, true); assert.equal(task.gpuAvailable, true);
  worker.emit({ id: task.id, gpuRequest: { requestId: 5, stage: 'local', input } });
  await flush();
  assert.equal(calls.length, 1); assert.equal(calls[0].input.coordinates.length, 12);
  assert.equal(input.coordinates.byteLength, 0); assert.equal(frame.fractional.byteLength, 96);
  const localReply = worker.messages.at(-1);
  assert.equal(localReply.requestId, 5); assert.equal(localReply.ok, true);
  assert.deepEqual(localReply.result.structures, new Int32Array(4));
  assert.equal(localReply.result.neighbors.length, 48);
  assert.equal(progress.at(-1).completedStages, 0); assert.equal(progress.at(-1).completedAtoms, 2);
  assert.equal(progress.at(-1).totalTetrahedra, undefined);
  worker.emit({ id: task.id, gpuRequest: { requestId: 6, stage: 'tetrahedra', snapshot: topologySnapshot() } });
  await flush();
  assert.equal(worker.messages.at(-1).requestId, 6); assert.equal(worker.messages.at(-1).ok, true);
  assert.equal(client.cpuBudget.active, 1);
  worker.emit({ id: task.id, ok: true, result: { backend: 'hybrid' } });
  assert.equal((await request).backend, 'hybrid'); assert.equal(client.cpuBudget.active, 0);
  await client.close();
});

test('GPU local support is independent of tetrahedron support and local failures retain the paused session', async () => {
  const { client, workers } = setup({ gpuBackend: {
    identifyDxa: async () => { throw new Error('GPU local neighbor occupancy limit'); },
  } });
  const request = client.analyze(source(), { gpuEnabled: true });
  await flush();
  const worker = workers[0], task = worker.messages[0];
  assert.equal(task.gpuLocalAvailable, true); assert.equal(task.gpuAvailable, false);
  worker.emit({ id: task.id, gpuRequest: { requestId: 8, stage: 'local', input: localInput() } });
  await flush();
  const reply = worker.messages.at(-1);
  assert.equal(reply.ok, false); assert.match(reply.error, /occupancy limit/);
  assert.equal(workers.length, 1); assert.equal(client.cpuBudget.active, 1); assert.equal(client.pending.size, 1);
  worker.emit({ id: task.id, ok: true, result: { backend: 'cpu', gpuFallback: true } });
  assert.equal((await request).gpuFallback, true);
  await client.close();
});

test('cancellation before the local GPU RPC keeps the serial kernel and skips the local computation', async () => {
  const controller = new AbortController(); let calls = 0;
  const { client, workers } = setup({ gpuBackend: {
    identifyDxa: async () => { calls++; return {}; },
  } });
  const request = client.analyze(source(), { gpuEnabled: true }, { signal: controller.signal,
    onProgress: progress => { if (progress.backend === 'gpu') controller.abort(); } });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await flush(); const worker = workers[0], id = worker.messages[0].id;
  worker.emit({ id, progress: { phase: 'GPU local neighbors and crystal correspondence', backend: 'gpu' } });
  await rejected;
  assert.equal(worker.terminated, false); assert.equal(worker.messages.at(-1).type, 'cancel');
  worker.emit({ id, gpuRequest: { requestId: 9, stage: 'local', input: localInput() } });
  await flush();
  assert.equal(calls, 0); assert.equal(worker.messages.at(-1).name, 'AbortError');
  assert.equal(client.cpuBudget.active, 1);
  worker.emit({ id, ok: false, name: 'AbortError', error: 'Cancelled at GPU local checkpoint' });
  assert.equal(client.cpuBudget.active, 0);
  await client.close();
});

test('DXA routes owned native topology through the existing GPU backend and returns its regions', async () => {
  const calls = [], progress = [];
  const { client, workers } = setup({ gpuBackend: {
    async classifyDxa(snapshot, options) {
      const owned = structuredClone(snapshot, { transfer: ['vertices', 'tetrahedra', 'edges', 'transitions'].map(key => snapshot[key].buffer) });
      calls.push({ snapshot: owned, signal: options.signal });
      options.onProgress({ phase: 'GPU alpha classification', totalAtoms: 2, completedAtoms: 1 });
      return { regions: new Int32Array([-1, 0]), gpuStages: ['tetrahedron-alpha', 'elastic-compatibility'],
        arithmetic: 'ieee754-f64', elapsedMs: 5 };
    },
  } });
  const frame = source(), request = client.analyze(frame, { gpuEnabled: true }, { onProgress: event => progress.push(event) });
  await flush();
  const worker = workers[0], task = worker.messages[0], snapshot = topologySnapshot();
  assert.equal(task.gpuAvailable, true);
  worker.emit({ id: task.id, gpuRequest: { requestId: 7, snapshot } });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].snapshot.vertices.length, 12);
  assert.equal(snapshot.vertices.byteLength, 0, 'the copied native snapshot transfers ownership');
  assert.equal(frame.fractional.byteLength, 96, 'rendered coordinates remain owned by the caller');
  const reply = worker.messages.at(-1);
  assert.equal(reply.type, 'gpu-result'); assert.equal(reply.requestId, 7);
  assert.equal(reply.ok, true); assert.deepEqual(reply.result.regions, new Int32Array([-1, 0]));
  assert.equal(progress.at(-1).backend, 'gpu');
  assert.equal(progress.at(-1).totalAtoms, 4);
  assert.equal(progress.at(-1).totalTetrahedra, 2); assert.equal(progress.at(-1).completedTetrahedra, 1);
  assert.equal(client.cpuBudget.active, 1, 'the native session retains its global CPU lease');
  worker.emit({ id: task.id, ok: true, result: { segments: [], backend: 'hybrid', engine: 'Wasm CPU + WebGPU' } });
  assert.equal((await request).backend, 'hybrid'); assert.equal(client.cpuBudget.active, 0);
  await client.close();
});

test('GPU memory failure returns to the paused native session without rejecting or restarting DXA', async () => {
  const { client, workers } = setup({ gpuBackend: { classifyDxa: async () => { throw new Error('GPU memory budget exceeded'); } } });
  const request = client.analyze(source(), { gpuEnabled: true });
  await flush();
  const worker = workers[0], task = worker.messages[0];
  worker.emit({ id: task.id, gpuRequest: { requestId: 4, snapshot: topologySnapshot() } });
  await flush();
  const reply = worker.messages.at(-1);
  assert.equal(reply.type, 'gpu-result'); assert.equal(reply.ok, false); assert.match(reply.error, /memory budget/);
  assert.equal(client.pending.size, 1); assert.equal(client.cpuBudget.active, 1);
  assert.equal(workers.length, 1); assert.equal(worker.messages.filter(message => message.type === 'analyze').length, 1);
  worker.emit({ id: task.id, ok: true, result: { backend: 'cpu', gpuFallback: true, fallbackReason: reply.error } });
  assert.equal((await request).gpuFallback, true);
  await client.close();
});

test('cancelling a GPU checkpoint keeps a serial native heap and ignores its late GPU reply', async () => {
  let finishGpu, gpuSignal;
  const { client, workers } = setup({ gpuBackend: {
    classifyDxa: (_snapshot, { signal }) => { gpuSignal = signal; return new Promise(resolve => { finishGpu = resolve; }); },
  } });
  const controller = new AbortController(), first = client.analyze(source(), { gpuEnabled: true }, { signal: controller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await flush();
  const worker = workers[0], firstId = worker.messages[0].id;
  worker.emit({ id: firstId, gpuRequest: { requestId: 10, snapshot: topologySnapshot() } });
  const next = client.analyze(source());
  controller.abort(); await rejected;
  assert.equal(gpuSignal.aborted, true);
  assert.equal(worker.terminated, false);
  assert.equal(client.cpuBudget.active, 1);
  assert.equal(worker.messages.at(-1).type, 'cancel');
  worker.emit({ id: firstId, ok: false, name: 'AbortError', error: 'Cancelled at GPU checkpoint' });
  await flush();
  const nextTask = worker.messages.at(-1);
  assert.equal(nextTask.type, 'analyze'); assert.notEqual(nextTask.id, firstId);
  finishGpu({ regions: new Int32Array([-1, 0]) }); await flush();
  assert.equal(worker.messages.at(-1), nextTask, 'a stale GPU reply cannot reach the next native calculation');
  assert.equal(workers.length, 1);
  worker.emit({ id: nextTask.id, ok: true, result: { segments: [] } });
  await next; assert.equal(client.cpuBudget.active, 0);
  await client.close();
});

test('cancellation in the first GPU progress callback retains a serial heap before its RPC arrives', async () => {
  const controller = new AbortController(); let calls = 0;
  const { client, workers } = setup({ gpuBackend: { classifyDxa: async () => { calls++; return { regions: new Int32Array(2) }; } } });
  const first = client.analyze(source(), { gpuEnabled: true }, { signal: controller.signal,
    onProgress: progress => { if (progress.backend === 'gpu') controller.abort(); } });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await flush(); const worker = workers[0], id = worker.messages[0].id;
  worker.emit({ id, progress: { phase: 'GPU tetrahedron and elastic classification', backend: 'gpu' } });
  await rejected;
  assert.equal(worker.terminated, false); assert.equal(worker.messages.at(-1).type, 'cancel');
  worker.emit({ id, gpuRequest: { requestId: 11, snapshot: topologySnapshot() } });
  await flush();
  assert.equal(calls, 0); assert.equal(worker.messages.at(-1).name, 'AbortError');
  worker.emit({ id, ok: false, name: 'AbortError', error: 'Cancelled' });
  assert.equal(client.cpuBudget.active, 0);
  await client.close();
});

test('DXA preflights snapshot export against the warmed shared GPU memory budget', async () => {
  const { client, workers } = setup({ gpuBackend: { cacheStatus: { budgetBytes: 128 * 1024 ** 2, bufferLimitBytes: 64 * 1024 ** 2 },
    classifyDxa: async () => { throw new Error('not called'); } } });
  const request = client.analyze(source(), { gpuEnabled: true });
  await flush(); const worker = workers[0], task = worker.messages[0];
  assert.equal(task.gpuSnapshotBudgetBytes, 128 * 1024 ** 2);
  assert.equal(task.gpuBufferLimitBytes, 64 * 1024 ** 2);
  worker.emit({ id: task.id, ok: true, result: { segments: [] } }); await request;
  await client.close();
});

test('GPU enabled without browser WebGPU support skips native snapshot preparation', async () => {
  const { client, workers } = setup({ environment: {}, gpuBackend: { classifyDxa: async () => { throw new Error('not called'); } } });
  const request = client.analyze(source(), { gpuEnabled: true });
  await flush(); const worker = workers[0], task = worker.messages[0];
  assert.equal(task.gpuAvailable, false);
  worker.emit({ id: task.id, ok: true, result: { backend: 'cpu', gpuFallback: true } });
  assert.equal((await request).gpuFallback, true);
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
  assert.equal(worker.messages.length, 1, 'native work starts only after initialization acknowledges');
  worker.emit({ id: warmId, ok: true, result: { workerCount: 1, poolSize: 0, kernelGeneration: 1, sharedMemory: false } });
  await flush();
  assert.equal(workers.length, 1);
  assert.equal(worker.messages[1].type, 'analyze');
  worker.emit({ id: worker.messages[1].id, ok: true, result: { segments: [] } });
  await calculation;
  assert.equal(client.cpuBudget.active, 0);
  await client.close();
});
