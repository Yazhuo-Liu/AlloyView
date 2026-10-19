import assert from 'node:assert/strict';
import test from 'node:test';
import { GpuRuntime } from '../src/analysis/gpu/runtime.js';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';
import { COORDINATION_SHADER } from '../src/analysis/gpu/coordination.js';
import { VORONOI_CLIP_SHADER } from '../src/analysis/gpu/voronoi-shaders.js';
import { fakeGpu } from './helpers/fake-gpu.js';
import { crystalFrame } from './helpers/crystals.js';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 0)); }
  assert.fail('timed out waiting for GPU task');
}
function runtimeFixture() {
  const fake = fakeGpu(), listeners = new Map(), lost = deferred(), notices = [];
  fake.device.lost = lost.promise;
  fake.device.addEventListener = (name, listener) => listeners.set(name, listener);
  let destroyCount = 0;
  fake.device.destroy = () => { destroyCount++; lost.resolve({ reason: 'destroyed', message: 'test device destroyed' }); };
  const runtime = new GpuRuntime({ environment: { navigator: { gpu: fake.gpu } }, onDeviceLost: message => notices.push(message) });
  return { ...fake, runtime, notices, lost, emit: error => listeners.get('uncapturederror')({ error, preventDefault() {} }), get destroyCount() { return destroyCount; } };
}

test('uncaptured validation fails only its task, drains scopes, and preserves the device for the next calculation', async () => {
  const fixture = runtimeFixture(), { runtime, device, emit, notices } = fixture, scopes = [];
  try {
    await runtime.initialize();
    device.pushErrorScope = kind => scopes.push(kind); device.popErrorScope = async () => { scopes.pop(); return null; };
    await assert.rejects(runtime.withErrors(async () => {
      emit({ name: 'GPUValidationError', message: 'invalid binding for this task' }); return { shouldNotPublish: true };
    }), { name: 'GpuUnavailableError', message: 'invalid binding for this task' });
    assert.deepEqual(scopes, []); assert.equal(runtime.lost, null); assert.deepEqual(notices, []);
    assert.deepEqual(await runtime.withErrors(async () => ({ valid: true })), { valid: true });
    assert.equal(await runtime.initialize(), device); assert.equal(runtime.cacheStatus().initialized, true);
    emit({ name: 'GPUValidationError', message: 'idle validation' });
    await assert.rejects(runtime.initialize(), /idle validation/);
    assert.equal(await runtime.initialize(), device, 'the diagnostic is consumed once, without poisoning initialization');
  } finally { runtime.close(); }
});

test('idle device loss expires resident readiness, notifies once, and never restarts inside the failed request', async () => {
  const { runtime, device, lost, emit, notices } = runtimeFixture();
  try {
    await runtime.initialize(); const frame = crystalFrame('fcc', 2); frame.gpuFrameId = 1;
    await runtime.uploadFrame(frame, { frameIndex: 0 }); assert.deepEqual(runtime.cacheStatus().cachedFrameIds, [1]);
    lost.resolve({ reason: 'unknown', message: 'driver reset' }); await Promise.resolve();
    assert.equal(runtime.cacheStatus().initialized, false); assert.deepEqual(runtime.cacheStatus().cachedFrameIds, []);
    assert.deepEqual(runtime.cacheStatus().cachedFrameIndexes, []);
    await assert.rejects(runtime.initialize(), { name: 'GpuDeviceLostError', gpuDeviceLost: true });
    assert.equal(runtime.device, device); assert.equal(notices.length, 1);
    emit({ name: 'GPUInternalError', message: 'second notification' }); assert.equal(notices.length, 1);
  } finally { runtime.close(); }
});

test('uncaptured internal driver errors request device recovery while uncaptured OOM remains a scoped task failure', async () => {
  const { runtime, emit, notices } = runtimeFixture();
  try {
    await runtime.initialize();
    emit({ name: 'GPUOutOfMemoryError', message: 'allocation failed' });
    await assert.rejects(runtime.withErrors(async () => true), { name: 'GpuUnavailableError', gpuOutOfMemory: true });
    assert.equal(runtime.lost, null); assert.equal(notices.length, 0);
    emit({ name: 'GPUInternalError', message: 'internal driver failure' });
    await assert.rejects(runtime.initialize(), { name: 'GpuDeviceLostError', gpuDeviceLost: true });
    assert.deepEqual(notices, ['internal driver failure']);
  } finally { runtime.close(); }
});

test('closing during device acquisition destroys its eventual device and cannot revive a closed runtime', async () => {
  const fake = fakeGpu(), entered = deferred(), released = deferred(); let destroyed = 0;
  fake.device.destroy = () => { destroyed++; };
  const runtime = new GpuRuntime({ environment: { navigator: { gpu: { async requestAdapter() {
    return { info: {}, limits: fake.device.limits, async requestDevice() { entered.resolve(); await released.promise; return fake.device; } };
  } } } } });
  const initializing = runtime.initialize(), rejected = assert.rejects(initializing, /released/);
  await entered.promise; runtime.close(); released.resolve(); await rejected;
  assert.equal(destroyed, 1); assert.equal(runtime.device, null);
  await assert.rejects(runtime.initialize(), /released/);
});

test('adapter acquisition failure retries only on a later request and never loops within initialization', async () => {
  const fake = fakeGpu(); let requests = 0;
  const runtime = new GpuRuntime({ environment: { navigator: { gpu: { async requestAdapter(options) {
    requests++;
    return requests === 1 ? null : fake.gpu.requestAdapter(options);
  } } } } });
  try {
    await assert.rejects(runtime.initialize(), { gpuDeviceUnavailable: true });
    assert.equal(requests, 1);
    assert.equal(await runtime.initialize(), fake.device); assert.equal(requests, 2);
    assert.equal(await runtime.initialize(), fake.device); assert.equal(requests, 2);
  } finally { runtime.close(); }
});

test('a single shader warmup rejection does not stop unrelated pipelines; successful on-demand retry clears its diagnostic', async () => {
  const { runtime, device } = runtimeFixture(), compile = device.createComputePipelineAsync;
  let rejectCoordination = true;
  try {
    await runtime.initialize(); runtime.exactPairs = true;
    device.createComputePipelineAsync = async options => {
      if (rejectCoordination && options.compute.module.code === COORDINATION_SHADER) throw new Error('coordination compile failed');
      return compile(options);
    };
    const status = await runtime.warmup();
    assert.equal(status.initialized, true); assert.equal(status.pipelineCount, 21);
    assert.deepEqual(status.kernelFailures, [{ kind: 'coordination', phase: 'warming', error: 'coordination compile failed' }]);
    rejectCoordination = false; await runtime.compilePipeline(COORDINATION_SHADER);
    assert.deepEqual(runtime.cacheStatus().kernelFailures, []); assert.equal(runtime.cacheStatus().pipelineCount, 22);
    device.createComputePipelineAsync = async options => {
      if (options.compute.module.code === VORONOI_CLIP_SHADER) throw new Error('optional Voronoi shader failed');
      return compile(options);
    };
    await assert.rejects(runtime.warmup({ analysisKinds: ['voronoi'] }), { gpuAnalysisKind: 'voronoi' });
    assert.equal((await runtime.warmup()).initialized, true);
    assert.equal(runtime.cacheStatus().kernelFailures[0].kind, 'voronoi');
  } finally { runtime.close(); }
});

class FakeWorker {
  constructor() { this.messages = []; this.listeners = new Map(); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  postMessage(data, transfer = []) { this.messages.push(structuredClone(data, { transfer })); }
  emit(data) { this.listeners.get('message')({ data }); }
  answer(message, data = {}) { this.emit({ id: message.id, ok: true, ...data }); }
  terminate() { this.terminated = true; }
}
function clientFixture() {
  const workers = [], client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => {
    const worker = new FakeWorker(); workers.push(worker); return worker;
  } });
  return { client, workers };
}
async function prepare(client, workers, frame, index) {
  const offset = workers.at(-1)?.messages.length ?? 0;
  const prepared = client.prepareFrame(frame, { frameIndex: index });
  await until(() => (workers.at(-1)?.messages.length ?? 0) > offset && workers.at(-1)?.messages.at(-1)?.type === 'prepare-frame');
  const worker = workers.at(-1), message = worker.messages.at(-1), previous = [...client.cachedFrameIds];
  worker.answer(message, { cachedFrameIds: [...previous, message.frameId] }); await prepared;
  return message.frameId;
}

test('a validation reply fails one GPU job and retains acknowledged inputs and the worker', async () => {
  const { client, workers } = clientFixture(), frame = crystalFrame('fcc', 2);
  try {
    const id = await prepare(client, workers, frame, 0), worker = workers[0];
    const failed = client.analyze(frame, { kind: 'coordination', cutoff: 3 }), rejection = assert.rejects(failed, /invalid binding/);
    await until(() => worker.messages.at(-1).type === 'analyze');
    worker.answer(worker.messages.at(-1), { ok: false, name: 'GpuUnavailableError', error: 'invalid binding', cachedFrameIds: [id] }); await rejection;
    const next = client.analyze(frame, { kind: 'coordination', cutoff: 3 });
    await until(() => worker.messages.filter(message => message.type === 'analyze').length === 2);
    assert.equal(worker.messages.at(-1).frame, undefined);
    worker.answer(worker.messages.at(-1), { result: { valid: true }, cachedFrameIds: [id] }); assert.equal((await next).valid, true);
    assert.equal(workers.length, 1); assert.equal(worker.terminated, undefined);
  } finally { client.close(); }
});

test('loss rejects both posted jobs, then queued work creates one replacement and privately retransfers canonical inputs', async () => {
  const { client, workers } = clientFixture(), frame = crystalFrame('fcc', 2), other = crystalFrame('bcc', 2), nextFrame = crystalFrame('hcp', 2);
  const source = frame.fractional.slice(), nextSource = nextFrame.fractional.slice();
  try {
    await prepare(client, workers, frame, 0); await prepare(client, workers, other, 1);
    const worker = workers[0], offset = worker.messages.length;
    const first = client.analyze(frame, { kind: 'coordination', cutoff: 3 });
    const second = client.analyze(other, { kind: 'coordination', cutoff: 3 });
    const failures = [assert.rejects(first, { name: 'GpuDeviceLostError' }), assert.rejects(second, { name: 'GpuDeviceLostError' })];
    await until(() => worker.messages.slice(offset).filter(message => message.type === 'analyze').length === 2);
    assert.ok(worker.messages.slice(offset).every(message => message.frame === undefined));
    const queued = client.analyze(nextFrame, { kind: 'coordination', cutoff: 3 });
    worker.emit({ type: 'device-lost', error: 'driver reset', gpuDeviceLost: true }); await Promise.all(failures);
    await until(() => workers[1]?.messages.at(-1)?.type === 'analyze');
    assert.equal(worker.terminated, true); assert.equal(workers.length, 2);
    assert.equal(client.warmedUp, false); assert.equal(client.deviceWarmed, false); assert.deepEqual([...client.cachedFrameIds], []);
    const request = workers[1].messages.at(-1);
    assert.deepEqual(request.frame.fractional, nextSource); assert.notEqual(request.frame.fractional.buffer, nextFrame.fractional.buffer);
    worker.answer(worker.messages.at(-1), { cachedFrameIds: [999], result: { stale: true } });
    assert.deepEqual([...client.cachedFrameIds], [], 'late acknowledgements from the lost worker stay expired');
    workers[1].answer(request, { result: { recovered: true }, cachedFrameIds: [request.frameId] });
    assert.equal((await queued).recovered, true); assert.deepEqual(frame.fractional, source); assert.deepEqual(nextFrame.fractional, nextSource);
  } finally { client.close(); }
});

test('idle loss expires warmup shortcuts and PTM/Cartesian ACKs before the next request initializes once', async () => {
  const { client, workers } = clientFixture();
  try {
    const warmed = client.warmup(); await until(() => workers[0]?.messages.length === 1);
    workers[0].answer(workers[0].messages[0]); await warmed;
    client.cachedFrameIds.add(42); client.cachedPtmFits.set(42, 1); client.ptmSources.set(42, {});
    client.cachedCartesianFrames.set(42, new Set(['cartesian'])); client.positionSources.set(42, new Map([['cartesian', {}]]));
    workers[0].emit({ type: 'device-lost', error: 'idle reset' });
    assert.equal(workers.length, 1); assert.equal(client.worker, null);
    assert.equal(client.cachedPtmFits.size, 0); assert.equal(client.ptmSources.size, 0);
    assert.equal(client.cachedCartesianFrames.size, 0); assert.equal(client.positionSources.size, 0);
    const again = client.warmup(); await until(() => workers[1]?.messages.length === 1);
    assert.equal(workers.length, 2); workers[1].answer(workers[1].messages[0]); await again;
  } finally { client.close(); }
});

test('recovery resends complete raw PTM fits rather than trusting the lost worker acknowledgement', async () => {
  const { client, workers } = clientFixture(), frame = crystalFrame('fcc', 1), count = frame.types.length;
  const ptmInput = { structures: new Uint8Array(count).fill(1), scales: new Float64Array(count).fill(2.8),
    deformation: Float64Array.from({ length: count * 9 }, (_, index) => index % 4 ? 0 : 1) };
  const parameters = { kind: 'strain', ptmInput }, originals = Object.values(ptmInput).map(array => array.slice());
  try {
    const first = client.analyze(frame, parameters);
    await until(() => workers[0]?.messages.length === 1);
    const initial = workers[0].messages[0];
    workers[0].answer(initial, { cachedFrameIds: [initial.frameId], cachedPtmFits: [{ frameId: initial.frameId, fitId: initial.parameters.ptmFitId }] });
    await first;
    const cached = client.analyze(frame, parameters);
    await until(() => workers[0].messages.length === 2);
    const reuse = workers[0].messages[1]; assert.equal(reuse.parameters.ptmInput, undefined);
    workers[0].answer(reuse, { cachedFrameIds: [initial.frameId], cachedPtmFits: [{ frameId: initial.frameId, fitId: initial.parameters.ptmFitId }] });
    await cached; workers[0].emit({ type: 'device-lost', error: 'PTM cache lost' });
    const recovered = client.analyze(frame, parameters);
    await until(() => workers[1]?.messages.length === 1);
    const message = workers[1].messages[0];
    assert.ok(message.frame); assert.deepEqual(message.parameters.ptmInput, ptmInput);
    assert.deepEqual(message.parameters.ptmTypes, frame.types);
    workers[1].answer(message, { result: { valid: true } }); await recovered;
    Object.values(ptmInput).forEach((array, index) => assert.deepEqual(array, originals[index]));
    assert.equal(workers.length, 2);
  } finally { client.close(); }
});

test('recovery resends both Cartesian reference frames and mappings without detaching their scientific inputs', async () => {
  const { client, workers } = clientFixture(), frame = crystalFrame('fcc', 1), reference = crystalFrame('fcc', 1);
  const parameters = { kind: 'displacement', minimumImage: true, mappingMode: 'id', referenceFrame: reference, referenceFrameIndex: 0,
    referenceFractional: reference.fractional, referenceCell: reference.cell,
    referenceMapping: Int32Array.from({ length: frame.types.length }, (_, index) => index),
    currentPositions: Float64Array.from(frame.positions), referencePositions: Float64Array.from(reference.positions) };
  const originals = [parameters.currentPositions.slice(), parameters.referencePositions.slice(), parameters.referenceMapping.slice()];
  const answer = (worker, message) => worker.answer(message, {
    cachedFrameIds: [message.frameId, message.referenceFrameId],
    cachedCartesianFrames: [message.frameId, message.referenceFrameId].map(frameId => ({ frameId, variants: ['cartesian'] })),
  });
  try {
    const first = client.analyze(frame, parameters, { frameIndex: 1 });
    await until(() => workers[0]?.messages.length === 1); answer(workers[0], workers[0].messages[0]); await first;
    const reused = client.analyze(frame, parameters, { frameIndex: 1 });
    await until(() => workers[0].messages.length === 2);
    const cached = workers[0].messages[1];
    assert.equal(cached.parameters.currentPositions, undefined); assert.equal(cached.parameters.referencePositions, undefined);
    answer(workers[0], cached); await reused;
    workers[0].emit({ type: 'device-lost', error: 'dual-frame cache lost' });
    const recovered = client.analyze(frame, parameters, { frameIndex: 1 });
    await until(() => workers[1]?.messages.length === 1);
    const message = workers[1].messages[0];
    assert.deepEqual(message.frame.fractional, frame.fractional); assert.deepEqual(message.referenceFrame.fractional, reference.fractional);
    assert.deepEqual(message.parameters.currentPositions, originals[0]);
    assert.deepEqual(message.parameters.referencePositions, originals[1]);
    assert.deepEqual(message.parameters.referenceMapping, originals[2]);
    answer(workers[1], message); await recovered;
    assert.deepEqual(parameters.currentPositions, originals[0]); assert.deepEqual(parameters.referencePositions, originals[1]);
    assert.deepEqual(parameters.referenceMapping, originals[2]); assert.equal(workers.length, 2);
  } finally { client.close(); }
});

test('GPU-off and cancellation during loss do not allocate a replacement or convert AbortError into GPU fallback', async () => {
  const { client, workers } = clientFixture(), frame = crystalFrame('fcc', 2), other = crystalFrame('bcc', 2), controller = new AbortController();
  try {
    const first = client.analyze(frame, { kind: 'coordination', cutoff: 3 }, { signal: controller.signal }), cancelled = assert.rejects(first, { name: 'AbortError' });
    await until(() => workers[0]?.messages.at(-1)?.type === 'analyze');
    const queued = client.analyze(other, { kind: 'coordination', cutoff: 3 }), rejected = assert.rejects(queued, { name: 'GpuDeviceLostError' });
    controller.abort(); await cancelled; client.release({ whenIdle: true });
    workers[0].emit({ type: 'device-lost', error: 'reset while GPU is off' }); await rejected;
    assert.equal(workers.length, 1); assert.equal(client.worker, null); assert.equal(client.pending.size, 0);
    client.resume(); const again = client.analyze(frame, { kind: 'coordination', cutoff: 3 });
    await until(() => workers[1]?.messages.at(-1)?.type === 'analyze');
    workers[1].answer(workers[1].messages.at(-1), { result: { recovered: true } }); await again;
    assert.equal(workers.length, 2);
  } finally { client.close(); }
});

test('source reset around loss cannot dispatch canceled old frames or accept old resident ACKs', async () => {
  const { client, workers } = clientFixture(), frame = crystalFrame('fcc', 2), next = crystalFrame('bcc', 2);
  try {
    const old = client.analyze(frame, { kind: 'coordination', cutoff: 3 }), cancelled = assert.rejects(old, { name: 'AbortError' });
    await until(() => workers[0]?.messages.at(-1)?.type === 'analyze');
    const oldRequest = workers[0].messages.at(-1), barrier = client.clearFrames();
    workers[0].emit({ type: 'device-lost', error: 'old source lost' }); await cancelled;
    await until(() => workers[1]?.messages.at(-1)?.type === 'clear-frames');
    workers[0].answer(oldRequest, { cachedFrameIds: [oldRequest.frameId] });
    workers[1].answer(workers[1].messages.at(-1), { cachedFrameIds: [] }); await barrier;
    const calculated = client.analyze(next, { kind: 'coordination', cutoff: 3 });
    await until(() => workers[1].messages.at(-1)?.type === 'analyze');
    const message = workers[1].messages.at(-1); assert.deepEqual(message.frame.fractional, next.fractional);
    assert.notEqual(message.frameId, oldRequest.frameId);
    workers[1].answer(message, { result: { valid: true } }); await calculated;
    assert.equal(workers.length, 2);
  } finally { client.close(); }
});
