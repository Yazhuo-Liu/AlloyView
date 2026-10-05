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
const setup = () => {
  const workers = [], client = new DxaClient({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }, yieldToMain: async () => {} });
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
