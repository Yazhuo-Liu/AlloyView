import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';
import { GpuRuntime } from '../src/analysis/gpu/runtime.js';
import { analyzeGpuDxaClassification, validateGpuDxaSnapshot, prepareGpuDxaSettings,
  preflightGpuDxaMemory, GPU_DXA_BATCH_TETRAHEDRA } from '../src/analysis/gpu/dxa.js';
import { DXA_ALPHA_SHADER, DXA_REGION_SHADER, DXA_WORKGROUP_SIZE } from '../src/analysis/gpu/dxa-shaders.js';

function snapshot(count = 1) {
  const vertices = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const tetrahedra = new Uint32Array(count * 16);
  for (let cell = 0; cell < count; cell++) tetrahedra.set([0, 1, 2, 3,
    0xffff_ffff, 0xffff_ffff, 0xffff_ffff, 0xffff_ffff, 0, 1, 2, 3, 4, 5, 1, 0], cell * 16);
  const edges = new Uint32Array(6 * 8), view = new DataView(edges.buffer);
  const pairs = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
  for (let edge = 0; edge < 6; edge++) for (let axis = 0; axis < 3; axis++) {
    view.setFloat64(edge * 32 + axis * 8, vertices[pairs[edge][1] * 3 + axis] - vertices[pairs[edge][0] * 3 + axis], true);
  }
  const transitions = new Float64Array(20);
  transitions.set([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1]);
  return { vertices, tetrahedra, edges, transitions, alpha: 5, tetrahedronCount: count };
}

function fixture({ failAllocation = -1, failRead = false, cancelAfterRun } = {}) {
  const allocated = [], released = [], runs = [], reads = [], reserves = [];
  const allocate = bytes => {
    if (allocated.length === failAllocation) throw new Error('Allocation failed.');
    const buffer = { data: new Uint8Array(Math.max(4, bytes)) }; allocated.push(buffer); return buffer;
  };
  const runtime = {
    device: { limits: { maxBufferSize: 256 * 1024 ** 2, maxStorageBufferBindingSize: 256 * 1024 ** 2 } },
    budgetBytes: 512 * 1024 ** 2,
    async initialize(signal) { signal?.throwIfAborted(); },
    reserveWorkspace(bytes) { reserves.push(bytes); },
    createBuffer: allocate,
    storageBuffer(values) { const buffer = allocate(values.byteLength); buffer.data.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)); return buffer; },
    write(buffer, values, offset = 0) { buffer.data.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), offset); },
    async run(source, bindings, count, options) {
      const settings = new Uint32Array(bindings[0].data.buffer);
      runs.push({ source, start: settings[3], end: settings[4], count, options });
      const output = new Int32Array(bindings.at(-1).data.buffer);
      output.fill(source === DXA_ALPHA_SHADER ? 1 : 0, settings[3], settings[4]);
      cancelAfterRun?.abort();
    },
    async read(buffer, Type, length, { signal }) {
      signal?.throwIfAborted(); reads.push(buffer);
      if (failRead) throw new Error('Device lost.');
      return new Type(buffer.data.buffer.slice(0, length * Type.BYTES_PER_ELEMENT));
    },
    disposeBuffers(buffers) { released.push(...buffers); },
  };
  return { runtime, allocated, released, runs, reads, reserves };
}

test('GPU DXA uploads the geometry once, completes both batched passes, and reads only final regions', async () => {
  const count = GPU_DXA_BATCH_TETRAHEDRA + 13, geometry = snapshot(count), setup = fixture(), progress = [];
  const result = await analyzeGpuDxaClassification(setup.runtime, geometry, { onProgress: update => progress.push(update) });
  assert.deepEqual(result.regions, new Int32Array(count));
  assert.deepEqual(setup.runs.map(run => run.source), [DXA_ALPHA_SHADER, DXA_ALPHA_SHADER, DXA_REGION_SHADER, DXA_REGION_SHADER]);
  assert.deepEqual(setup.runs.map(run => [run.start, run.end]), [[0, GPU_DXA_BATCH_TETRAHEDRA],
    [GPU_DXA_BATCH_TETRAHEDRA, count], [0, GPU_DXA_BATCH_TETRAHEDRA], [GPU_DXA_BATCH_TETRAHEDRA, count]]);
  assert.ok(setup.runs.every(run => run.options.workgroupSize === DXA_WORKGROUP_SIZE && !run.options.updateRange));
  assert.equal(setup.allocated.length, 7); assert.equal(setup.reads.length, 1);
  assert.equal(setup.reads[0], setup.allocated.at(-1));
  assert.deepEqual(setup.released, setup.allocated);
  assert.equal(result.readbackBytes, count * 4);
  assert.equal(result.uploadedBytes, 32 + Object.values(geometry).filter(ArrayBuffer.isView).reduce((total, array) => total + array.byteLength, 0));
  assert.deepEqual(result.gpuStages, ['tetrahedron-alpha', 'elastic-compatibility']);
  assert.equal(result.arithmetic, 'ieee754-f64');
  assert.equal(setup.reserves.length, 1); assert.equal(setup.reserves[0], result.uploadedBytes + count * 12);
  assert.equal(progress.at(-1).completedTetrahedra, count);
});

test('GPU DXA validates geometry, topology and transition matrices before any buffer allocation', async () => {
  const invalids = [
    geometry => { geometry.vertices[0] = NaN; },
    geometry => { geometry.tetrahedra[0] = 4; },
    geometry => { geometry.tetrahedra[4] = 1; },
    geometry => { geometry.tetrahedra[8] = 6; },
    geometry => { geometry.tetrahedra[14] = 2; },
    geometry => { geometry.edges[6] = 1; },
    geometry => { geometry.transitions[2] = Infinity; },
    geometry => { geometry.transitions[18] = .5; },
  ];
  for (const mutate of invalids) {
    const geometry = snapshot(), setup = fixture(); mutate(geometry);
    await assert.rejects(analyzeGpuDxaClassification(setup.runtime, geometry), /GPU DXA/);
    assert.equal(setup.allocated.length, 0); assert.equal(setup.reserves.length, 0);
  }
  const geometry = snapshot();
  assert.throws(() => validateGpuDxaSnapshot({ ...geometry, vertices: new Float32Array(12) }), /typed f64/);
  assert.throws(() => validateGpuDxaSnapshot({ ...geometry, tetrahedra: new Uint32Array(15) }), /strides/);
  assert.throws(() => validateGpuDxaSnapshot({ ...geometry, edgeCount: 7 }), /does not match/);
  assert.throws(() => validateGpuDxaSnapshot({ ...geometry, alpha: -1 }), /alpha/);
  if (typeof SharedArrayBuffer !== 'undefined') {
    assert.throws(() => validateGpuDxaSnapshot({ ...geometry, transitions: new Float64Array(new SharedArrayBuffer(160)) }), /transferable/);
  }
});

test('GPU DXA accepts exact f64 word views, reverse edge references and unmapped transitions', () => {
  const geometry = snapshot();
  geometry.vertices = new Uint32Array(geometry.vertices.buffer);
  geometry.tetrahedra[8] = 0x8000_0000;
  geometry.edges[6] = 0xffff_ffff;
  assert.deepEqual(validateGpuDxaSnapshot(geometry), { vertexCount: 4, tetrahedronCount: 1, edgeCount: 6, transitionCount: 1 });
  const settings = prepareGpuDxaSettings(geometry), view = new DataView(settings.buffer);
  assert.equal(view.getFloat64(0, true), 5);
  assert.deepEqual([...settings.subarray(2)], [1, 0, 1, 4, 6, 1]);
});

test('GPU DXA buffer and complete-workspace preflight reject before allocations or cache reservations', async () => {
  for (const mode of ['buffer', 'budget']) {
    const geometry = snapshot(), setup = fixture();
    if (mode === 'buffer') setup.runtime.device.limits.maxBufferSize = 64;
    else setup.runtime.budgetBytes = 64;
    await assert.rejects(analyzeGpuDxaClassification(setup.runtime, geometry), /GPU (buffer limits|memory budget)/);
    assert.equal(setup.allocated.length, 0); assert.equal(setup.reserves.length, 0);
  }
  const setup = fixture(), geometry = snapshot();
  assert.equal(preflightGpuDxaMemory(setup.runtime, geometry), 556);
});

test('GPU DXA cancellation, allocation failure and device-read failure release all temporary buffers', async () => {
  for (const options of [{ failAllocation: 3 }, { failRead: true }, { cancelAfterRun: new AbortController() }]) {
    const setup = fixture(options), geometry = snapshot();
    await assert.rejects(analyzeGpuDxaClassification(setup.runtime, geometry, { signal: options.cancelAfterRun?.signal }));
    assert.deepEqual(setup.released, setup.allocated);
    if (options.cancelAfterRun) {
      assert.equal(setup.runs.length, 1); assert.equal(setup.reads.length, 0);
    }
  }
});

class WorkerFixture {
  constructor() { this.listeners = new Map(); this.messages = []; this.terminated = false; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  postMessage(data, transfer = []) { this.messages.push(structuredClone(data, { transfer })); }
  terminate() { this.terminated = true; }
  answer(message, extras = {}) { this.listeners.get('message')({ data: { id: message.id, ok: true,
    result: { regions: new Int32Array([0]), engine: 'webgpu-dxa-classification' },
    cachedFrameIds: [12], cacheStatus: { cachedFrameIds: [12], uploadCount: 4 }, ...extras } }); }
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error('GPU task was not dispatched.');
}

test('GPU DXA service reuses the existing device worker and transfers only owned mesh tables', async () => {
  const worker = new WorkerFixture(); let workerCount = 0;
  const client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => { workerCount++; return worker; } });
  const geometry = snapshot();
  try {
    const warm = client.warmup(); await until(() => worker.messages.length === 1);
    worker.answer(worker.messages[0]); await warm;
    const job = client.classifyDxa(geometry);
    await until(() => worker.messages.length === 2);
    const message = worker.messages[1];
    assert.equal(message.type, 'classify-dxa'); assert.equal(message.frame, undefined);
    assert.equal(message.snapshot.vertices.length, 12);
    for (const name of ['vertices', 'tetrahedra', 'edges', 'transitions']) assert.equal(geometry[name].byteLength, 0);
    worker.answer(message); const result = await job;
    assert.deepEqual(result.regions, new Int32Array([0])); assert.equal(workerCount, 1);
    assert.equal(client.cacheStatus.uploadCount, 4); assert.deepEqual(client.cacheStatus.cachedFrameIds, [12]);
    assert.equal(worker.terminated, false);
  } finally { client.close(); }
});

test('GPU DXA cancellation preserves the worker and queued owned tables until dispatch', async () => {
  const worker = new WorkerFixture(), client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  try {
    const firstController = new AbortController(), first = client.classifyDxa(snapshot(), { signal: firstController.signal });
    const rejection = assert.rejects(first, { name: 'AbortError' });
    await until(() => worker.messages.length === 1);
    const queued = snapshot(), queuedController = new AbortController();
    const pending = client.classifyDxa(queued, { signal: queuedController.signal });
    const queuedRejection = assert.rejects(pending, { name: 'AbortError' }); queuedController.abort(); await queuedRejection;
    assert.equal(queued.vertices.byteLength, 96);
    firstController.abort(); await rejection;
    assert.equal(worker.messages.at(-1).type, 'cancel'); assert.equal(worker.terminated, false);
    client.release({ whenIdle: true }); assert.equal(worker.terminated, false, 'release waits for the running DXA acknowledgement');
    worker.answer(worker.messages[0], { ok: false, name: 'AbortError', error: 'Cancelled.' });
    assert.equal(worker.terminated, true);
  } finally { client.close(); }
});

test('GPU workspace reservation rejects a job that cannot fit before evicting any cached frame', () => {
  const runtime = new GpuRuntime(); runtime.budgetBytes = 100;
  let evictions = 0; runtime.evictFrame = () => { evictions++; };
  assert.throws(() => runtime.reserveWorkspace(101), /memory budget/);
  assert.equal(evictions, 0);
});

test('GPU workspace reservations preserve the current frame and nested analysis pins', () => {
  const runtime = new GpuRuntime(); runtime.budgetBytes = 100; runtime.currentIndex = 1;
  runtime.device = { limits: { maxBufferSize: 100, maxStorageBufferBindingSize: 100 },
    createBuffer({ size }) { return { size, destroyed: false, destroy() { this.destroyed = true; } }; }, destroy() {} };
  for (let index = 0; index < 3; index++) {
    const positionsBuffer = runtime.createBuffer(16), typesBuffer = runtime.createBuffer(4);
    runtime.frames.set(index, { positionsBuffer, typesBuffer, frameIndex: index, bytes: 20 });
    runtime.residentBytes += 20;
  }
  runtime.analysisFramePins.set(0, 2);
  const pinned = runtime.frames.get(0), displayed = runtime.frames.get(1), speculative = runtime.frames.get(2);
  runtime.reserveWorkspace(60);
  assert.equal(runtime.allocatedBytes, 40); assert.equal(runtime.frames.size, 2);
  assert.equal(pinned.positionsBuffer.destroyed, false); assert.equal(displayed.positionsBuffer.destroyed, false);
  assert.equal(speculative.positionsBuffer.destroyed, true);
  assert.throws(() => runtime.reserveWorkspace(64), /available GPU memory budget/);
  assert.equal(pinned.positionsBuffer.destroyed, false); assert.equal(displayed.positionsBuffer.destroyed, false);
  runtime.close();
});
