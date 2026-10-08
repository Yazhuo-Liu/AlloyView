import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuRuntime, GPU_HARDWARE_BATCH_ATOMS, GPU_SOFTWARE_BATCH_ATOMS, GPU_BATCHES_IN_FLIGHT, GPU_MAX_BATCH_ATOMS,
  GPU_MIN_BATCH_ATOMS, GPU_TARGET_BATCH_MS, isSoftwareGpuAdapter, readGpuBuffers } from '../src/analysis/gpu/runtime.js';
import { exactCoordinateWords, prepareCspCoordinates } from '../src/analysis/gpu/centrosymmetry.js';
import { crystalFrame } from './helpers/crystals.js';
import { fakeDevice } from './helpers/fake-gpu.js';

const SOURCE = `@group(0) @binding(0) var<uniform> config: Config;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;`;

function fakeRuntime(options = {}, { software = false } = {}) {
  const fake = fakeDevice(options), runtime = new GpuRuntime();
  runtime.device = fake.device; runtime.initialize = async () => fake.device; runtime.softwareAdapter = software;
  return { runtime, ...fake };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  throw new Error('Condition was not reached.');
}

function batches(log) {
  const result = [];
  for (let index = 0; index < log.length; index++) {
    if (log[index].type !== 'dispatch') continue;
    const bounds = log.slice(0, index).reverse().find(entry => entry.type === 'write' && entry.offset === 104);
    result.push({ bounds: bounds.words, workgroups: log[index].workgroups });
  }
  return result;
}

test('software adapters are recognized from fallback flags and adapter names', () => {
  assert.equal(isSoftwareGpuAdapter({ isFallbackAdapter: true }), true);
  assert.equal(isSoftwareGpuAdapter({ vendor: 'google', architecture: 'swiftshader' }), true);
  assert.equal(isSoftwareGpuAdapter({ description: 'llvmpipe (LLVM 15)' }), true);
  assert.equal(isSoftwareGpuAdapter({ vendor: 'nvidia', architecture: 'pascal' }), false);
});

test('range-batched kernels keep three dispatches queued with queue-ordered bounds instead of waiting for each', async () => {
  const { runtime, log, completions } = fakeRuntime({ holdCompletions: true });
  const config = runtime.createBuffer(128, 64 | 8), output = runtime.createBuffer(4);
  runtime.configContexts.set(config, {});
  const progress = [];
  const running = runtime.run(SOURCE, [config, output], 200_000, { onProgress: value => progress.push(value.completedAtoms) });
  await until(() => batches(log).length === GPU_BATCHES_IN_FLIGHT);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(batches(log).length, GPU_BATCHES_IN_FLIGHT, 'a fourth batch waits for the oldest queued batch');
  assert.equal(progress.length, 0);
  completions[0]();
  await until(() => batches(log).length === 4);
  for (const resolve of completions) resolve();
  await until(() => completions.length === 4);
  completions[3]();
  await running;
  assert.deepEqual(batches(log).map(batch => batch.bounds), [[0, 65_536], [65_536, 131_072], [131_072, 196_608], [196_608, 200_000]]);
  assert.deepEqual(batches(log).map(batch => batch.workgroups), [512, 512, 512, 27]);
  assert.deepEqual(progress, [65_536, 131_072, 196_608, 200_000]);
  assert.equal(GPU_HARDWARE_BATCH_ATOMS, 65_536);
});

test('software adapters keep fixed 16k batches, and heavy kernels start from their own initial batch', async () => {
  for (const [software, initialBatchSize, expected] of [[true, undefined, GPU_SOFTWARE_BATCH_ATOMS], [false, 16_384, 16_384]]) {
    const { runtime, log } = fakeRuntime({}, { software });
    const config = runtime.createBuffer(128, 64 | 8), output = runtime.createBuffer(4);
    runtime.configContexts.set(config, {});
    await runtime.run(SOURCE, [config, output], 40_000, { initialBatchSize });
    assert.deepEqual(batches(log)[0].bounds, [0, expected]);
    if (software) assert.deepEqual(batches(log).map(batch => batch.bounds), [[0, 16_384], [16_384, 32_768], [32_768, 40_000]]);
  }
});

test('measured dispatch times shrink slow pipelines at once and grow fast ones only within a run', () => {
  const { runtime } = fakeRuntime();
  const slow = runtime.adaptBatch('slow', 65_536, GPU_TARGET_BATCH_MS * 5, 65_536);
  assert.equal(slow, Math.floor(65_536 / 5));
  assert.equal(runtime.batchHints.get('slow'), slow, 'a slow pipeline starts smaller in later runs');
  assert.equal(runtime.adaptBatch('tiny', 65_536, GPU_TARGET_BATCH_MS * 1000, 65_536), GPU_MIN_BATCH_ATOMS);
  assert.equal(runtime.adaptBatch('fast', 65_536, 1, 65_536), GPU_MAX_BATCH_ATOMS);
  assert.equal(runtime.batchHints.has('fast'), false, 'growth is never remembered beyond the initial batch');
  assert.equal(runtime.adaptBatch('fast', 100, 1, 65_536), 65_536, 'a short final batch does not drive growth');
  assert.equal(runtime.adaptBatch('steady', 65_536, GPU_TARGET_BATCH_MS, 65_536), 65_536);
});

test('single dispatches followed by a readback skip the separate completion round trip', async () => {
  const { runtime, log, completions } = fakeRuntime();
  const output = runtime.createBuffer(16);
  await runtime.run('@group(0) @binding(0) var<storage, read_write> output: array<u32>;', [output], 4000, { batchSize: 0, wait: false });
  assert.equal(completions.length, 0);
  assert.equal(log.filter(entry => entry.type === 'dispatch').length, 1);
  await runtime.run('@group(0) @binding(0) var<storage, read_write> output: array<u32>;', [output], 4000, { batchSize: 0 });
  assert.equal(completions.length, 1, 'the default still waits for completion');
});

test('several readbacks share one pooled staging mapping and honor source offsets', async () => {
  const { runtime, log } = fakeRuntime();
  const first = runtime.createBuffer(16), second = runtime.createBuffer(16);
  first.data.set(new Uint8Array(Uint32Array.from([1, 2, 3, 4]).buffer));
  second.data.set(new Uint8Array(Float32Array.from([.5, 1.5, 2.5, 3.5]).buffer));
  const fake = runtime.device;
  let maps = 0; const create = fake.createBuffer.bind(fake);
  fake.createBuffer = options => { const buffer = create(options); const map = buffer.mapAsync; buffer.mapAsync = async (...values) => { maps++; return map(...values); }; return buffer; };
  const [words, floats, empty] = await runtime.readMany([{ buffer: first, Type: Uint32Array, length: 3 },
    { buffer: second, Type: Float32Array, length: 2, offset: 8 }, { buffer: second, Type: Uint32Array, length: 0 }]);
  assert.deepEqual([...words], [1, 2, 3]); assert.deepEqual([...floats], [2.5, 3.5]); assert.equal(empty.length, 0);
  assert.equal(maps, 1);
  const copies = log.filter(entry => entry.type === 'copy');
  assert.equal(copies.length, 2); assert.equal(copies[0].target, copies[1].target);
  assert.deepEqual(copies.map(copy => [copy.sourceOffset, copy.targetOffset, copy.size]), [[0, 0, 12], [8, 16, 8]]);
  assert.deepEqual([...await runtime.read(second, Uint32Array, 1, { offset: 12 })], [new Uint32Array(Float32Array.from([3.5]).buffer)[0]]);
  assert.equal(log.filter(entry => entry.type === 'copy').at(-1).target, copies[0].target, 'the staging buffer is reused');
  assert.equal(runtime.stagingPool.length, 1);
  const pooled = runtime.stagingPool[0], allocated = runtime.allocatedBytes;
  runtime.clearFrames();
  assert.equal(pooled.destroyed, true); assert.equal(runtime.stagingPool.length, 0);
  assert.ok(runtime.allocatedBytes < allocated);
  await assert.rejects(runtime.readMany([{ buffer: first, Type: Uint32Array, length: 1, offset: 2 }]), /aligned/);
});

test('runtimes without readMany read requested ranges sequentially', async () => {
  const calls = [];
  const runtime = { async read(buffer, Type, length, options) { calls.push([buffer, length, options.offset ?? 0]); return new Type(length); } };
  const values = await readGpuBuffers(runtime, [{ buffer: 'a', Type: Uint32Array, length: 2 }, { buffer: 'b', Type: Float32Array, length: 1, offset: 8 }]);
  assert.deepEqual(calls, [['a', 2, 0], ['b', 1, 8]]); assert.equal(values[1].constructor, Float32Array);
});

test('a neighbor index is cleared and built in single dispatches with one occupancy readback', async () => {
  const { runtime, log, completions } = fakeRuntime();
  const frame = crystalFrame('fcc', 8);
  frame.gpuFrameId = 7;
  const context = await runtime.prepareNeighbors(frame, 3.1);
  assert.equal(context.atomCount, 2048);
  assert.equal(log.filter(entry => entry.type === 'dispatch').length, 2);
  assert.equal(log.filter(entry => entry.type === 'copy').length, 1);
  assert.equal(completions.length, 0, 'no completion round trips: the readback is queued behind both dispatches');
  const bounds = log.filter(entry => entry.type === 'write' && entry.offset === 104).at(-1);
  assert.deepEqual(bounds.words, [0, 2048]);
  assert.equal(runtime.neighborIndexBuildCount, 1);
});

test('central symmetry and PTM neighbors share one exact coordinate encoding per immutable frame input', async () => {
  const runtime = { exactCoordinateCache: new WeakMap() }, frame = crystalFrame('fcc', 2);
  frame.fractional[0] = -.25;
  const first = await exactCoordinateWords(runtime, frame), second = await exactCoordinateWords(runtime, frame);
  assert.equal(first, second);
  assert.deepEqual(first, await prepareCspCoordinates(frame));
  assert.equal(new Float64Array(first.buffer)[0], .75, 'periodic coordinates are wrapped exactly');
  const moved = { ...frame, cell: { ...frame.cell, pbc: [false, true, true] } };
  moved.fractional = frame.fractional;
  const open = await exactCoordinateWords(runtime, { ...moved, fractional: Float64Array.from(frame.fractional, value => Math.abs(value)) });
  assert.notEqual(open, first);
  const replacedCell = await exactCoordinateWords(runtime, { ...frame, cell: { ...frame.cell } });
  assert.notEqual(replacedCell, first, 'a different cell object is encoded again');
  assert.notEqual(await exactCoordinateWords({}, frame), first, 'runtimes without a cache encode on demand');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(exactCoordinateWords(runtime, frame, { signal: controller.signal }), { name: 'AbortError' });
});
