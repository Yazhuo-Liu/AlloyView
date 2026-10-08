import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';
import { GpuRuntime } from '../src/analysis/gpu/runtime.js';
import { REFERENCE_STRAIN_FIELDS } from '../src/analysis/reference-strain.js';
import { crystalFrame } from './helpers/crystals.js';

const frame = () => crystalFrame('fcc', 2);
const abortError = () => new DOMException('cancelled', 'AbortError');

function routingPool(behavior = async () => ({ engine: 'webgpu', coordination: new Uint32Array([12]) })) {
  const calls = { gpu: 0, cpu: 0, released: 0 };
  const gpuBackend = { supports: kind => kind === 'coordination', async analyze(...args) { calls.gpu++; return behavior(...args); },
    release() { calls.released++; }, close() {} };
  const pool = new AnalysisPool({ gpuBackend });
  pool.analyzeCPU = async (_frame, _parameters, { onProgress }) => {
    calls.cpu++; onProgress({ phase: 'complete', completedAtoms: 1, totalAtoms: 1 });
    return { engine: 'js-worker', coordination: new Uint32Array([12]) };
  };
  return { pool, calls };
}

test('GPU is opt-in; supported jobs route to GPU while unsupported jobs retain CPU metadata', async () => {
  const { pool, calls } = routingPool();
  const data = frame();
  try {
    assert.equal(pool.gpuEnabled, false);
    const cpu = await pool.analyze(data, { kind: 'coordination' });
    assert.equal(cpu.backend, 'cpu'); assert.equal(cpu.gpuRequested, false); assert.equal(calls.gpu, 0);
    pool.setGpuEnabled(true);
    const gpu = await pool.analyze(data, { kind: 'coordination' });
    assert.equal(gpu.backend, 'gpu'); assert.equal(gpu.gpuRequested, true); assert.equal(gpu.engine, 'webgpu');
    const progress = [];
    const unsupported = await pool.analyze(data, { kind: 'ptm' }, { onProgress: value => progress.push(value) });
    assert.equal(unsupported.backend, 'cpu'); assert.equal(unsupported.gpuRequested, true);
    assert.match(unsupported.fallbackReason, /no GPU kernel/);
    assert.equal(progress[0].fallbackReason, unsupported.fallbackReason);
    assert.equal(calls.gpu, 1); assert.equal(calls.cpu, 2);
  } finally { pool.close(); }
});

test('device errors fall back to CPU and include the failed GPU attempt in wall time', async () => {
  const { pool, calls } = routingPool(async () => { await new Promise(resolve => setTimeout(resolve, 20)); throw new Error('GPU device lost'); });
  pool.setGpuEnabled(true);
  try {
    const result = await pool.analyze(frame(), { kind: 'coordination' });
    assert.equal(result.backend, 'cpu'); assert.match(result.fallbackReason, /device lost/);
    assert.ok(result.elapsedMs >= 15); assert.equal(calls.cpu, 1);
    pool.releaseGpuResources(); assert.equal(calls.released, 1);
  } finally { pool.close(); }
});

test('GPU cancellation never retries an expensive job on CPU', async () => {
  const { pool, calls } = routingPool(async () => { throw abortError(); });
  pool.setGpuEnabled(true);
  try { await assert.rejects(pool.analyze(frame(), { kind: 'coordination' }), { name: 'AbortError' }); assert.equal(calls.cpu, 0); }
  finally { pool.close(); }
});

test('CNA and complete reference tensors route through the GPU pool and retain scientific inputs on fallback', async () => {
  const data = frame(), mapping = Int32Array.from({ length: data.types.length }, (_, index) => index);
  const tensors = Object.fromEntries(REFERENCE_STRAIN_FIELDS.map((field, index) => [field, new Float32Array(data.types.length).fill(index)]));
  const calls = [];
  const gpuBackend = { supports: kind => ['cna', 'referenceStrain'].includes(kind), close() {},
    async analyze(_frame, parameters, options) {
      calls.push({ parameters, options });
      if (parameters.fail) throw new Error('Reference cache cannot fit both frames');
      if (parameters.cancel) throw abortError();
      return parameters.kind === 'cna' ? { structures: new Uint8Array(data.types.length).fill(1), engine: `webgpu-cna-${parameters.mode}` }
        : { ...tensors, engine: 'webgpu-reference-strain' };
    } };
  const pool = new AnalysisPool({ gpuBackend }), cpuInputs = [];
  pool.analyzeCPU = async (_frame, parameters) => { cpuInputs.push(parameters); return { ...tensors, engine: 'js-worker' }; };
  const parameters = { kind: 'referenceStrain', referenceFrame: data, referenceFrameIndex: 0,
    referenceFractional: data.fractional, referenceCell: data.cell, referenceMapping: mapping };
  pool.setGpuEnabled(true);
  try {
    for (const mode of ['fixed', 'adaptive']) {
      const cna = await pool.analyze(data, { kind: 'cna', mode }, { frameIndex: 3 });
      assert.equal(cna.backend, 'gpu'); assert.equal(cna.engine, `webgpu-cna-${mode}`);
      assert.equal(cna.structures.length, data.types.length);
    }
    const result = await pool.analyze(data, parameters, { frameIndex: 1 });
    assert.equal(result.backend, 'gpu'); assert.equal(result.engine, 'webgpu-reference-strain');
    assert.equal(calls.at(-1).options.frameIndex, 1);
    for (const field of REFERENCE_STRAIN_FIELDS) assert.strictEqual(result[field], tensors[field]);
    const fallback = await pool.analyze(data, { ...parameters, fail: true });
    assert.equal(fallback.backend, 'cpu'); assert.match(fallback.fallbackReason, /fit both frames/);
    assert.strictEqual(cpuInputs[0].referenceFractional, data.fractional);
    assert.strictEqual(cpuInputs[0].referenceCell, data.cell);
    assert.strictEqual(cpuInputs[0].referenceMapping, mapping);
    await assert.rejects(pool.analyze(data, { ...parameters, cancel: true }), { name: 'AbortError' });
    assert.equal(cpuInputs.length, 1, 'GPU cancellation never queues reference CPU fallback');
  } finally { pool.close(); }
});

class FakeWorker {
  constructor() { this.listeners = new Map(); this.messages = []; this.terminated = false; }
  addEventListener(name, listener) { const values = this.listeners.get(name) ?? []; values.push(listener); this.listeners.set(name, values); }
  postMessage(data, transfer = []) { this.messages.push(structuredClone(data, { transfer })); }
  terminate() { this.terminated = true; }
  emit(name, data) { for (const listener of this.listeners.get(name) ?? []) listener(name === 'message' ? { data } : data); }
  answer(message, extras = {}) { this.emit('message', { id: message.id, ok: true, result: { engine: 'webgpu' },
    cachedFrameIds: message.frameId === undefined ? [] : [message.frameId], ...extras }); }
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for GPU worker dispatch.');
}

function fakeClient() {
  const workers = [];
  return { workers, client: new GpuAnalysisClient({ environment: { navigator: { gpu: {} } },
    workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } }) };
}

test('one GPU worker serializes jobs and reuses uploaded frame identities without detaching source arrays', async () => {
  const { client, workers } = fakeClient(), data = frame();
  try {
    const original = data.fractional.slice();
    const first = client.analyze(data, { kind: 'coordination' });
    const second = client.analyze(data, { kind: 'rdf' });
    await until(() => workers[0]?.messages.length === 1);
    const message = workers[0].messages[0];
    assert.deepEqual(data.fractional, original); assert.ok(message.frame.fractional.byteLength > 0);
    workers[0].answer(message); await first;
    await until(() => workers[0].messages.length === 2);
    assert.equal(workers[0].messages[1].frame, undefined, 'the warm worker already owns this input frame');
    workers[0].answer(workers[0].messages[1]); await second;
    assert.equal(workers.length, 1);
  } finally { client.close(); }
});

test('a resident analysis is posted behind running GPU work, at most one deep, and results settle in posting order', async () => {
  const { client, workers } = fakeClient(), data = frame();
  try {
    const upload = client.analyze(data, { kind: 'coordination' });
    await until(() => workers[0]?.messages.length === 1);
    workers[0].answer(workers[0].messages[0]); await upload;
    const order = [];
    const second = client.analyze(data, { kind: 'rdf' }).then(value => { order.push('rdf'); return value; });
    const third = client.analyze(data, { kind: 'bonds', cutoff: 3 }).then(value => { order.push('bonds'); return value; });
    const fourth = client.analyze(data, { kind: 'coordination' }).then(value => { order.push('coordination'); return value; });
    await until(() => workers[0].messages.length === 3);
    await new Promise(resolve => setTimeout(resolve, 10));
    const [, running, waiting] = workers[0].messages;
    assert.equal(workers[0].messages.length, 3, 'a third task stays in the client queue');
    assert.deepEqual([running.parameters.kind, waiting.parameters.kind], ['rdf', 'bonds']);
    assert.equal(running.frame, undefined); assert.equal(waiting.frame, undefined, 'only resident inputs are posted early');
    workers[0].answer(running);
    await until(() => workers[0].messages.length === 4);
    workers[0].answer(waiting); workers[0].answer(workers[0].messages[3]);
    await Promise.all([second, third, fourth]);
    assert.deepEqual(order, ['rdf', 'bonds', 'coordination']);
    assert.equal(client.current, null);
  } finally { client.close(); }
});

test('a posted queued analysis keeps cancellation semantics and a worker failure rejects every posted task', async () => {
  const { client, workers } = fakeClient(), data = frame(), controller = new AbortController();
  try {
    const upload = client.analyze(data, { kind: 'coordination' });
    await until(() => workers[0]?.messages.length === 1);
    workers[0].answer(workers[0].messages[0]); await upload;
    const running = client.analyze(data, { kind: 'rdf' });
    const cancelled = client.analyze(data, { kind: 'bonds', cutoff: 3 }, { signal: controller.signal });
    const rejection = assert.rejects(cancelled, { name: 'AbortError' });
    await until(() => workers[0].messages.length === 3);
    controller.abort(); await rejection;
    assert.deepEqual(workers[0].messages.at(-1), { type: 'cancel', id: workers[0].messages[2].id });
    const later = client.analyze(data, { kind: 'coordination' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(workers[0].messages.filter(message => message.type === 'analyze').length, 3,
      'the cancelled task occupies its slot until the worker acknowledges it');
    workers[0].answer(workers[0].messages[1]); await running;
    workers[0].answer(workers[0].messages[2], { ok: false, name: 'AbortError', error: 'cancelled' });
    await until(() => workers[0].messages.filter(message => message.type === 'analyze').length === 4);
    const behind = client.analyze(data, { kind: 'rdf' });
    await until(() => workers[0].messages.filter(message => message.type === 'analyze').length === 5);
    const failures = [assert.rejects(later, /GPU worker crashed/), assert.rejects(behind, /GPU worker crashed/)];
    workers[0].emit('error', { message: 'GPU worker crashed' });
    await Promise.all(failures);
    assert.equal(client.current, null); assert.equal(client.worker, null);
  } finally { client.close(); }
});

test('GPU abort settles promptly and keeps following jobs serialized until worker acknowledgement', async () => {
  const { client, workers } = fakeClient(), controller = new AbortController();
  try {
    const first = client.analyze(frame(), { kind: 'coordination' }, { signal: controller.signal });
    const outcome = assert.rejects(first, { name: 'AbortError' });
    const next = client.analyze(frame(), { kind: 'coordination' });
    await until(() => workers[0]?.messages.length === 1);
    const message = workers[0].messages[0];
    controller.abort(); await outcome;
    assert.equal(workers[0].messages.at(-1).type, 'cancel');
    assert.equal(workers[0].messages.filter(item => item.type === 'analyze').length, 1);
    workers[0].answer(message, { ok: false, name: 'AbortError', error: 'cancelled' });
    await until(() => workers[0].messages.filter(item => item.type === 'analyze').length === 2);
    workers[0].answer(workers[0].messages.at(-1)); await next;
  } finally { client.close(); }
});

test('release during preparation cannot clear a new task or dispatch a queued third task early', async () => {
  const { client, workers } = fakeClient();
  try {
    const first = client.analyze(frame(), { kind: 'coordination' });
    const cancelled = assert.rejects(first, { name: 'AbortError' });
    client.release();
    const second = client.analyze(frame(), { kind: 'coordination' });
    const third = client.analyze(frame(), { kind: 'coordination' });
    await cancelled;
    await until(() => workers[1]?.messages.length === 1);
    assert.equal(workers[0].messages.length, 0);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(workers[1].messages.length, 1, 'third task stays queued behind second');
    workers[0].emit('error', { message: 'late error from released worker' });
    assert.equal(workers[1].terminated, false);
    workers[1].answer(workers[1].messages[0]); await second;
    await until(() => workers[1].messages.length === 2);
    workers[1].answer(workers[1].messages[1]); await third;
  } finally { client.close(); }
});

test('missing WebGPU is a recoverable backend failure and allocates no worker', async () => {
  let workers = 0;
  const client = new GpuAnalysisClient({ environment: {}, workerFactory: () => { workers++; return new FakeWorker(); } });
  await assert.rejects(client.analyze(frame(), { kind: 'coordination' }), /WebGPU is unavailable/);
  assert.equal(workers, 0); client.close();
});

test('warmup and a source reset preserve the same GPU worker while discarding frame payloads', async () => {
  const { client, workers } = fakeClient();
  try {
    await client.clearFrames(); assert.equal(workers.length, 0, 'clearing an unused GPU does not start it');
    const warmup = client.warmup();
    await until(() => workers[0]?.messages.length === 1);
    assert.equal(workers[0].messages[0].type, 'warmup');
    workers[0].answer(workers[0].messages[0], { cacheStatus: { capacity: 10, budgetBytes: 1024, cachedFrameIndexes: [] } });
    assert.equal((await warmup).capacity, 10);
    await client.warmup(); assert.equal(workers[0].messages.length, 1, 'device/pipelines are already warm');
    const reset = client.clearFrames();
    await until(() => workers[0].messages.length === 2);
    assert.equal(workers[0].messages[1].type, 'clear-frames');
    workers[0].answer(workers[0].messages[1]); await reset;
    await client.warmup();
    assert.equal(workers.length, 1); assert.equal(workers[0].terminated, false);
    assert.equal(workers[0].messages.length, 2, 'reset only releases frame resources');
  } finally { client.close(); }
});

test('pre-uploaded trajectory frames survive CPU eviction and omit subsequent analysis input copies', async () => {
  const { client, workers } = fakeClient(), data = frame();
  try {
    const original = data.fractional.slice();
    const prepared = client.prepareFrame(data, { frameIndex: 8 });
    await until(() => workers[0]?.messages.length === 1);
    const upload = workers[0].messages[0];
    assert.equal(upload.type, 'prepare-frame'); assert.equal(upload.frameIndex, 8);
    workers[0].answer(upload, { cacheStatus: { capacity: 12, cachedFrameIds: [upload.frameId], cachedFrameIndexes: [8] } });
    await prepared;
    const reparsed = frame(); client.associateFrame(reparsed, 8);
    const analysis = client.analyze(reparsed, { kind: 'coordination' });
    await until(() => workers[0].messages.length === 2);
    const request = workers[0].messages[1];
    assert.equal(request.frameId, upload.frameId); assert.equal(request.frame, undefined);
    assert.deepEqual(data.fractional, original);
    const status = client.cacheStatus; status.cachedFrameIndexes.push(100);
    assert.deepEqual(client.cacheStatus.cachedFrameIndexes, [8], 'callers cannot mutate client residency metadata');
    workers[0].answer(request); await analysis;
  } finally { client.close(); }
});

test('foreground analysis preempts background uploads and runs ahead of queued preparation', async () => {
  const { client, workers } = fakeClient();
  try {
    const first = client.prepareFrame(frame(), { frameIndex: 1 });
    const cancelled = assert.rejects(first, { name: 'AbortError' });
    const queuedFrame = frame(), original = queuedFrame.fractional.slice();
    const queued = client.prepareFrame(queuedFrame, { frameIndex: 2 });
    await until(() => workers[0]?.messages.length === 1);
    const upload = workers[0].messages[0];
    const foreground = client.analyze(frame(), { kind: 'coordination' });
    await cancelled;
    assert.equal(workers[0].messages.at(-1).type, 'cancel');
    assert.equal(workers[0].messages.filter(message => message.frame).length, 1, 'queued prefetch has no copied payload');
    workers[0].answer(upload, { ok: false, name: 'AbortError', error: 'cancelled', cachedFrameIds: [] });
    await until(() => workers[0].messages.some(message => message.type === 'analyze'));
    const calculation = workers[0].messages.at(-1);
    workers[0].answer(calculation); await foreground;
    await until(() => workers[0].messages.filter(message => message.type === 'prepare-frame').length === 2);
    assert.deepEqual(queuedFrame.fractional, original);
    workers[0].answer(workers[0].messages.at(-1)); await queued;
  } finally { client.close(); }
});

test('source reset cancels old work promptly and ignores stale resident IDs before new uploads', async () => {
  const { client, workers } = fakeClient();
  try {
    const old = client.prepareFrame(frame(), { frameIndex: 0 });
    const cancelled = assert.rejects(old, { name: 'AbortError' });
    await until(() => workers[0]?.messages.length === 1);
    const staleUpload = workers[0].messages[0];
    const cleared = client.clearFrames(); await cancelled;
    const next = client.prepareFrame(frame(), { frameIndex: 0 });
    workers[0].answer(staleUpload);
    assert.deepEqual(client.cacheStatus.cachedFrameIds, [], 'old source replies cannot restore residency');
    await until(() => workers[0].messages.some(message => message.type === 'clear-frames'));
    const reset = workers[0].messages.at(-1); workers[0].answer(reset); await cleared;
    await until(() => workers[0].messages.filter(message => message.type === 'prepare-frame').length === 2);
    const freshUpload = workers[0].messages.at(-1);
    assert.ok(freshUpload.frame); assert.notEqual(freshUpload.frameId, staleUpload.frameId);
    workers[0].answer(freshUpload); await next;
    assert.equal(workers.length, 1); assert.equal(workers[0].terminated, false);
  } finally { client.close(); }
});

test('disabling GPU releases background work while accepted calculations finish before device teardown', async () => {
  const { client, workers } = fakeClient();
  try {
    const first = client.analyze(frame(), { kind: 'coordination' });
    const second = client.analyze(frame(), { kind: 'rdf' });
    const preparation = client.prepareFrame(frame(), { frameIndex: 1 });
    const cancelledPreparation = assert.rejects(preparation, { name: 'AbortError' });
    await until(() => workers[0]?.messages.length === 1);
    client.release({ whenIdle: true }); await cancelledPreparation;
    assert.equal(workers[0].terminated, false);
    assert.equal(workers[0].messages.some(message => message.type === 'cancel'), false, 'foreground jobs retain their accepted preference');
    workers[0].answer(workers[0].messages[0]); await first;
    await until(() => workers[0].messages.length === 2);
    assert.equal(workers[0].messages[1].type, 'analyze');
    workers[0].answer(workers[0].messages[1]); await second;
    assert.equal(workers[0].terminated, true, 'device teardown waits for the last calculation');
    assert.equal(client.worker, null);
  } finally { client.close(); }
});

test('rapid reenable cancels deferred teardown and reuses the worker after the running calculation', async () => {
  const { client, workers } = fakeClient();
  const pool = new AnalysisPool({ gpuBackend: client });
  try {
    pool.setGpuEnabled(true);
    const first = pool.analyze(frame(), { kind: 'coordination' });
    await until(() => workers[0]?.messages.length === 1);
    pool.setGpuEnabled(false); pool.releaseGpuResources({ whenIdle: true });
    pool.setGpuEnabled(true);
    workers[0].answer(workers[0].messages[0]); await first;
    assert.equal(workers[0].terminated, false);
    const next = pool.analyze(frame(), { kind: 'coordination' });
    await until(() => workers[0].messages.length === 2);
    workers[0].answer(workers[0].messages[1]); await next;
    assert.equal(workers.length, 1); assert.equal(workers[0].terminated, false);
  } finally { pool.close(); }
});

test('GPU runtime frees partial allocations and bounds cached frame/index resources', async () => {
  const runtime = new GpuRuntime();
  const allocations = [];
  runtime.device = { limits: { maxBufferSize: 2 ** 28, maxStorageBufferBindingSize: 2 ** 28 }, queue: { writeBuffer() {} },
    createBuffer({ size }) { const buffer = { size, destroyed: false, destroy() { this.destroyed = true; } }; allocations.push(buffer); return buffer; }, destroy() {} };
  runtime.initialize = async () => runtime.device;
  runtime.run = async () => {};
  runtime.read = async (_buffer, Type, length) => new Type(length);
  try {
    const first = frame(), otherCutoff = await runtime.prepareNeighbors(first, 3.1);
    const nextCutoff = await runtime.prepareNeighbors(first, 3.2);
    assert.equal(otherCutoff.positionsBuffer, nextCutoff.positionsBuffer);
    assert.equal(otherCutoff.typesBuffer, nextCutoff.typesBuffer); assert.equal(runtime.inputUploads, 1);
    await runtime.prepareNeighbors(frame(), 3.1); const recent = frame(); await runtime.prepareNeighbors(recent, 3.1);
    assert.equal(runtime.frames.size, 2); assert.equal(runtime.indexes.size, 2);
    assert.equal(otherCutoff.positionsBuffer.destroyed, true);
    const allocate = runtime.device.createBuffer;
    let remaining = 2;
    runtime.device.createBuffer = options => { if (--remaining === 0) throw new Error('simulated allocation failure'); return allocate(options); };
    await assert.rejects(runtime.prepareNeighbors(recent, 3.2), /simulated allocation failure/);
    assert.equal(allocations.at(-1).destroyed, true, 'the first allocation is freed when the following allocation fails');
    runtime.device.createBuffer = allocate;
    runtime.device.limits.maxBufferSize = 4;
    await assert.rejects(runtime.prepareNeighbors(frame(), 3.1), /buffer limits/);
  } finally { runtime.close(); }
  assert.equal(runtime.allocatedBytes, 0);
  assert.ok(allocations.every(buffer => buffer.destroyed));
});

test('GPU error scopes convert allocation/validation failures into CPU fallback errors and preserve AbortError', async () => {
  const runtime = new GpuRuntime();
  const scopes = [];
  runtime.device = { pushErrorScope(value) { scopes.push(value); }, async popErrorScope() {
    return scopes.pop() === 'out-of-memory' ? { message: 'GPU out of memory' } : null;
  } };
  await assert.rejects(runtime.withErrors(async () => ({ values: new Float32Array([1]) })), { name: 'GpuUnavailableError', message: 'GPU out of memory' });
  assert.deepEqual(scopes, []);
  await assert.rejects(runtime.withErrors(async () => { throw abortError(); }), { name: 'AbortError' });
  assert.deepEqual(scopes, []);
});

test('GPU runtime rejects precision overflows and nonperiodic coordinates outside the cell', async () => {
  const runtime = new GpuRuntime(); runtime.initialize = async () => {};
  const overflow = frame(); overflow.cell.vectors = Float64Array.from(overflow.cell.vectors, value => value * 1e40);
  await assert.rejects(runtime.prepareNeighbors(overflow, 1e40), /numeric range/);
  const outside = frame(); outside.cell.pbc = [false, false, false]; outside.fractional[0] = -0.1;
  await assert.rejects(runtime.prepareNeighbors(outside, 3.1), /inside the cell/);
});
