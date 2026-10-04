import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuRuntime } from '../src/analysis/gpu/runtime.js';
import { conservativeGpuBudget, DEFAULT_GPU_BUDGET_BYTES, FALLBACK_GPU_BUDGET_BYTES,
  frameUploadBytes, gpuWorkspaceBytes, trajectoryCapacity } from '../src/analysis/gpu/cache-policy.js';
import { crystalFrame } from './helpers/crystals.js';

function fixture() {
  const runtime = new GpuRuntime(), allocations = [], scopes = [];
  let destroyed = false, compiled = 0, allocationError = null;
  const device = {
    limits: { maxBufferSize: 256 * 1024 ** 2, maxStorageBufferBindingSize: 256 * 1024 ** 2 },
    queue: { writeBuffer() {}, async onSubmittedWorkDone() {} },
    createBuffer({ size }) {
      const buffer = { size, destroyed: false, destroy() { this.destroyed = true; } };
      allocations.push(buffer);
      if (allocationError) {
        const scope = [...scopes].reverse().find(scope => scope.kind === allocationError);
        scope.error = { message: allocationError === 'out-of-memory' ? 'Simulated GPU allocation exhaustion' : 'Simulated invalid buffer' };
        allocationError = null;
      }
      return buffer;
    },
    pushErrorScope(kind) { scopes.push({ kind, error: null }); },
    async popErrorScope() { return scopes.pop().error; },
    createShaderModule({ code }) { return { code }; },
    createBindGroupLayout(options) { return options; },
    createPipelineLayout(options) { return options; },
    async createComputePipelineAsync() { compiled++; return { getBindGroupLayout() {} }; },
    destroy() { destroyed = true; },
  };
  runtime.device = device;
  runtime.initialize = async () => device;
  runtime.run = async () => {};
  runtime.read = async (_buffer, Type, length) => new Type(length);
  return { runtime, allocations, scopes, failNextAllocation(kind = 'out-of-memory') { allocationError = kind; },
    get destroyed() { return destroyed; }, get compiled() { return compiled; } };
}

function input(frameIndex) {
  const frame = crystalFrame('fcc', 2);
  frame.gpuFrameId = frameIndex + 100;
  return frame;
}

test('GPU budgets reserve compute memory without treating buffer limits as free VRAM', () => {
  const hugeLimits = { maxBufferSize: 8 * 1024 ** 3, maxStorageBufferBindingSize: 4 * 1024 ** 3 };
  assert.equal(conservativeGpuBudget(hugeLimits), DEFAULT_GPU_BUDGET_BYTES);
  assert.equal(DEFAULT_GPU_BUDGET_BYTES, 2 * 1024 ** 3);
  assert.equal(conservativeGpuBudget({ maxBufferSize: 256 * 1024 ** 2, maxStorageBufferBindingSize: 128 * 1024 ** 2 }), DEFAULT_GPU_BUDGET_BYTES);
  assert.equal(conservativeGpuBudget(hugeLimits, { isFallbackAdapter: true }), FALLBACK_GPU_BUDGET_BYTES);
  const frameBytes = frameUploadBytes(input(0)), workspaceBytes = gpuWorkspaceBytes(frameBytes);
  assert.equal(frameBytes, 32 * 36);
  assert.equal(trajectoryCapacity({ frameCount: 20, frameBytes, budgetBytes: workspaceBytes + frameBytes * 3 }), 3);
  assert.equal(trajectoryCapacity({ frameCount: 2, frameBytes, budgetBytes: workspaceBytes + frameBytes * 3 }), 2);
  assert.equal(trajectoryCapacity({ frameCount: 2, frameBytes, budgetBytes: workspaceBytes }), 0);
});

test('oversized frames fail before packing coordinates or allocating host and GPU buffers', async () => {
  const { runtime, allocations } = fixture();
  try {
    const dummy = atomCount => ({ fractional: { length: atomCount * 3,
      get 0() { assert.fail('A rejected oversized frame must not read or pack coordinates.'); } } });
    await assert.rejects(runtime.uploadFrame(dummy(4_000_001)), /precision or memory budget/);
    runtime.device.limits.maxBufferSize = 1024;
    await assert.rejects(runtime.uploadFrame(dummy(33)), /buffer limits/);
    runtime.device.limits.maxBufferSize = 256 * 1024 ** 2;
    runtime.configureCache({ budgetBytes: 512 * 1024 ** 2 });
    await assert.rejects(runtime.uploadFrame(dummy(3_000_000)), /cache budget/);
    assert.equal(allocations.length, 0); assert.equal(runtime.allocatedBytes, 0); assert.equal(runtime.inputUploads, 0);
  } finally { runtime.close(); }
});

test('an unloadable background frame preserves the current resident frame and cache estimate', async () => {
  const { runtime, allocations } = fixture();
  try {
    const frame = input(0), bytes = frameUploadBytes(frame);
    runtime.configureCache({ frameCount: 10, currentIndex: 0, budgetBytes: gpuWorkspaceBytes(bytes) + bytes * 3 });
    await runtime.uploadFrame(frame, { frameIndex: 0 });
    const before = runtime.cacheStatus(), current = runtime.frames.get(frame.gpuFrameId);
    const tooLarge = { gpuFrameId: 101, fractional: { length: frame.fractional.length * 4,
      get 0() { assert.fail('The rejected background frame must not pack coordinates.'); } } };
    await assert.rejects(runtime.uploadFrame(tooLarge, { frameIndex: 1 }), /cache budget/);
    const after = runtime.cacheStatus();
    assert.equal(after.frameBytes, before.frameBytes); assert.equal(after.capacity, before.capacity);
    assert.equal(after.residentBytes, before.residentBytes); assert.equal(after.allocatedBytes, before.allocatedBytes);
    assert.deepEqual(after.cachedFrameIds, before.cachedFrameIds); assert.deepEqual(after.cachedFrameIndexes, [0]);
    assert.equal(current.positionsBuffer.destroyed, false); assert.equal(current.typesBuffer.destroyed, false);
    assert.equal(allocations.length, 2);
  } finally { runtime.close(); }
});

test('the whole trajectory stays resident and repeated analysis uses its existing inputs', async () => {
  const { runtime } = fixture();
  try {
    runtime.configureCache({ frameCount: 5, currentIndex: 2 });
    const frames = Array.from({ length: 5 }, (_, index) => input(index));
    for (const index of [2, 3, 1, 4, 0]) await runtime.uploadFrame(frames[index], { frameIndex: index });
    const status = runtime.cacheStatus();
    assert.equal(status.fullTrajectory, true); assert.equal(status.fullyCached, true);
    assert.deepEqual(status.cachedFrameIndexes, [0, 1, 2, 3, 4]);
    assert.equal(status.residentBytes, status.frameBytes * 5); assert.equal(status.uploadCount, 5);
    await runtime.prepareNeighbors(frames[2], 3.1);
    await runtime.prepareNeighbors(frames[2], 3.2);
    assert.equal(runtime.inputUploads, 5);
    assert.equal(runtime.frames.size, 5);
  } finally { runtime.close(); }
});

test('a constrained cache evicts the furthest frames and follows a moved current frame', async () => {
  const { runtime, allocations } = fixture();
  try {
    const frameBytes = frameUploadBytes(input(0)), budgetBytes = gpuWorkspaceBytes(frameBytes) + frameBytes * 3;
    runtime.configureCache({ frameCount: 10, currentIndex: 4, budgetBytes });
    for (const index of [4, 0, 9]) await runtime.uploadFrame(input(index), { frameIndex: index });
    const distant = runtime.frames.get(109).positionsBuffer;
    await runtime.uploadFrame(input(5), { frameIndex: 5 });
    assert.equal(distant.destroyed, true);
    assert.deepEqual(runtime.cacheStatus().cachedFrameIndexes, [0, 4, 5]);
    await runtime.uploadFrame(input(3), { frameIndex: 3 });
    assert.deepEqual(runtime.cacheStatus().cachedFrameIndexes, [3, 4, 5]);
    assert.equal(runtime.cacheStatus().capacity, 3); assert.equal(runtime.cacheStatus().fullTrajectory, false);
    runtime.configureCache({ currentIndex: 8 });
    await runtime.uploadFrame(input(8), { frameIndex: 8 });
    assert.deepEqual(runtime.cacheStatus().cachedFrameIndexes, [4, 5, 8]);
    assert.equal(runtime.frames.get(108).positionsBuffer.destroyed, false);
    assert.equal(allocations.filter(buffer => !buffer.destroyed).length, 6);
  } finally { runtime.close(); }
});

test('compute allocation protects both the displayed frame and the frame bound to analysis', async () => {
  const { runtime } = fixture();
  try {
    const bytes = frameUploadBytes(input(0)), budgetBytes = gpuWorkspaceBytes(bytes) + bytes * 3;
    runtime.configureCache({ frameCount: 3, currentIndex: 1, budgetBytes });
    const frames = [input(0), input(1), input(2)];
    for (let index = 0; index < 3; index++) await runtime.uploadFrame(frames[index], { frameIndex: index });
    const context = await runtime.prepareNeighbors(frames[0], 3.1);
    const scratch = runtime.createBuffer(budgetBytes - runtime.allocatedBytes + bytes);
    try {
      assert.deepEqual(runtime.cacheStatus().cachedFrameIndexes, [0, 1]);
      assert.equal(context.positionsBuffer.destroyed, false);
      assert.equal(context.configBuffer.destroyed, false);
      assert.equal(runtime.frames.get(101).positionsBuffer.destroyed, false);
    } finally { runtime.disposeBuffers([scratch]); }
  } finally { runtime.close(); }
});

test('clearing a source frees input and index buffers while retaining the device and warmed pipelines', async () => {
  const state = fixture(), { runtime } = state;
  try {
    await runtime.warmup();
    assert.ok(state.compiled >= 10);
    const pipelines = [...runtime.pipelines.values()], device = runtime.device;
    runtime.configureCache({ frameCount: 2 });
    await runtime.uploadFrame(input(0), { frameIndex: 0 });
    await runtime.prepareNeighbors(input(0), 3.1);
    const status = runtime.clearFrames();
    assert.equal(status.initialized, true); assert.equal(status.pipelineCount, pipelines.length);
    assert.equal(status.allocatedBytes, 0); assert.equal(status.residentBytes, 0);
    assert.deepEqual(status.cachedFrameIds, []); assert.equal(runtime.device, device);
    assert.equal(state.destroyed, false); assert.deepEqual([...runtime.pipelines.values()], pipelines);
    await runtime.warmup(); assert.equal(state.compiled, pipelines.length);
    assert.ok(state.allocations.every(buffer => buffer.destroyed));
  } finally { runtime.close(); }
  assert.equal(state.destroyed, true);
});

test('scoped GPU out-of-memory shrinks the cache, frees partial inputs and retries once', async () => {
  const state = fixture(), { runtime } = state;
  try {
    const bytes = frameUploadBytes(input(0)), budgetBytes = gpuWorkspaceBytes(bytes) + bytes * 4;
    runtime.configureCache({ frameCount: 8, currentIndex: 0, budgetBytes });
    await runtime.uploadFrame(input(0), { frameIndex: 0 });
    await runtime.uploadFrame(input(7), { frameIndex: 7 });
    state.failNextAllocation();
    await runtime.uploadFrame(input(1), { frameIndex: 1 });
    const status = runtime.cacheStatus();
    assert.equal(status.memoryLimited, true); assert.ok(status.budgetBytes < budgetBytes);
    assert.equal(status.capacity, 2); assert.deepEqual(status.cachedFrameIndexes, [0, 1]);
    assert.equal(status.uploadCount, 3, 'a failed upload does not claim GPU residency');
    assert.equal(status.allocatedBytes, bytes * 2);
    assert.ok(state.allocations.slice(4, 6).every(buffer => buffer.destroyed));
    assert.deepEqual(state.scopes, []);
  } finally { runtime.close(); }
});

test('the 2 GiB default adapts to a smaller GPU without allocating the entire budget', async () => {
  const state = fixture(), { runtime } = state;
  try {
    runtime.configureCache({ frameCount: 100, currentIndex: 0 });
    assert.equal(runtime.budgetBytes, 2 * 1024 ** 3);
    await runtime.uploadFrame(input(0), { frameIndex: 0 });
    await runtime.uploadFrame(input(99), { frameIndex: 99 });
    const bytes = frameUploadBytes(input(0));
    assert.equal(runtime.allocatedBytes, bytes * 2, 'the budget is a ceiling, not an upfront reservation');
    state.failNextAllocation();
    await runtime.uploadFrame(input(1), { frameIndex: 1 });
    const status = runtime.cacheStatus();
    assert.ok(status.budgetBytes > 0 && status.budgetBytes < 2 * 1024 ** 3);
    assert.equal(status.memoryLimited, true); assert.equal(status.capacity, 2);
    assert.deepEqual(status.cachedFrameIndexes, [0, 1]);
    assert.equal(status.allocatedBytes, bytes * 2);
    assert.deepEqual(state.scopes, []);
  } finally { runtime.close(); }
});

test('validation errors free partial uploads without reducing the memory budget or retrying', async () => {
  const state = fixture(), { runtime } = state;
  try {
    runtime.configureCache({ frameCount: 2 });
    const budget = runtime.budgetBytes;
    state.failNextAllocation('validation');
    await assert.rejects(runtime.uploadFrame(input(0), { frameIndex: 0 }), /invalid buffer/);
    assert.equal(runtime.budgetBytes, budget); assert.equal(runtime.memoryLimited, false);
    assert.equal(runtime.frames.size, 0); assert.equal(runtime.inputUploads, 0); assert.equal(runtime.allocatedBytes, 0);
    assert.equal(state.allocations.length, 2); assert.ok(state.allocations.every(buffer => buffer.destroyed));
  } finally { runtime.close(); }
});

test('a compute OOM drops speculative frames and stale indexes before retrying with the protected inputs', async () => {
  const state = fixture(), { runtime } = state;
  try {
    runtime.configureCache({ frameCount: 6, currentIndex: 2 });
    const frame = input(2);
    for (const index of [2, 3, 1, 4, 0, 5]) await runtime.uploadFrame(input(index), { frameIndex: index });
    const context = await runtime.prepareNeighbors(frame, 3.1);
    state.failNextAllocation();
    let failure;
    const transient = [];
    try {
      await runtime.withErrors(async () => { transient.push(runtime.createBuffer(1024)); });
    } catch (error) { failure = error; }
    finally { runtime.disposeBuffers(transient); }
    assert.equal(failure.gpuOutOfMemory, true);
    assert.equal(runtime.recoverMemory(failure), true);
    assert.deepEqual(runtime.cacheStatus().cachedFrameIndexes, [2]);
    assert.equal(context.positionsBuffer.destroyed, false);
    assert.equal(context.configBuffer.destroyed, true);
    assert.equal(runtime.indexes.size, 0);
    await runtime.withErrors(async () => runtime.prepareNeighbors(frame, 3.1));
    assert.equal(runtime.inputUploads, 6, 'the retried kernel retains the existing current frame upload');
    runtime.finishAnalysis();
    assert.equal(runtime.protectedFrameKey, null);
    assert.equal(runtime.recoverMemory(new Error('ordinary analysis error')), false);
  } finally { runtime.close(); }
});
