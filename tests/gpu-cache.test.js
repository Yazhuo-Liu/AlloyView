import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuRuntime, MAX_GPU_PERIODIC_RADIUS_FACES } from '../src/analysis/gpu/runtime.js';
import { CNA_FIXED_SHADER, CNA_ADAPTIVE_SHADER } from '../src/analysis/gpu/cna-shaders.js';
import { REFERENCE_STRAIN_CLEAR_SHADER, REFERENCE_STRAIN_SHADER } from '../src/analysis/gpu/reference-strain-shaders.js';
import { CSP_SHADER } from '../src/analysis/gpu/centrosymmetry-shaders.js';
import { DISPLACEMENT_SHADER } from '../src/analysis/gpu/displacement-shaders.js';
import { PTM_NEIGHBORS_SHADER } from '../src/analysis/gpu/ptm-neighbors-shaders.js';
import { conservativeGpuBudget, DEFAULT_GPU_BUDGET_BYTES, FALLBACK_GPU_BUDGET_BYTES,
  frameUploadBytes, gpuWorkspaceBytes, trajectoryCapacity } from '../src/analysis/gpu/cache-policy.js';
import { crystalFrame } from './helpers/crystals.js';

function fixture() {
  const runtime = new GpuRuntime(), allocations = [], scopes = [];
  let destroyed = false, compiled = 0, allocationError = null;
  const device = {
    limits: { maxBufferSize: 256 * 1024 ** 2, maxStorageBufferBindingSize: 256 * 1024 ** 2 },
    queue: { writeBuffer(buffer, _offset, data) { buffer.lastWrite = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength).slice(); },
      async onSubmittedWorkDone() {} },
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

test('a dual-frame reference job retains both inputs during compute OOM recovery without relabeling the displayed frame', async () => {
  const state = fixture(), { runtime } = state;
  let unpin;
  try {
    const bytes = frameUploadBytes(input(0)), budgetBytes = gpuWorkspaceBytes(bytes) + bytes * 4;
    runtime.configureCache({ frameCount: 4, currentIndex: 1, budgetBytes });
    const frames = [input(0), input(1), input(2), input(3)];
    for (let index = 0; index < frames.length; index++) await runtime.uploadFrame(frames[index], { frameIndex: index });
    const referencePositions = runtime.frames.get(100).positionsBuffer, currentPositions = runtime.frames.get(101).positionsBuffer;
    unpin = runtime.pinFrames([frames[1], frames[0]]);
    await runtime.prepareNeighbors(frames[0], 3.1);
    state.failNextAllocation();
    const temporary = [];
    let failure;
    try { await runtime.withErrors(async () => { temporary.push(runtime.createBuffer(1024)); }); }
    catch (error) { failure = error; }
    finally { runtime.disposeBuffers(temporary); }
    assert.equal(runtime.recoverMemory(failure), true);
    assert.equal(runtime.cacheStatus().currentIndex, 1);
    assert.deepEqual(runtime.cacheStatus().cachedFrameIndexes, [0, 1]);
    assert.equal(referencePositions.destroyed, false);
    assert.equal(currentPositions.destroyed, false);
    unpin(); unpin = null; runtime.finishAnalysis();
    runtime.configureCache({ currentIndex: 3 });
    await runtime.uploadFrame(frames[3], { frameIndex: 3 });
    assert.deepEqual(runtime.cacheStatus().cachedFrameIndexes, [1, 3]);
    assert.equal(referencePositions.destroyed, true, 'the completed reference job no longer pins its input');
  } finally { unpin?.(); runtime.close(); }
});

test('nested worker and kernel pins survive the outer release and a reference cannot be evicted before readback completes', async () => {
  const { runtime } = fixture();
  let outer, inner;
  try {
    const bytes = frameUploadBytes(input(0));
    runtime.configureCache({ frameCount: 5, currentIndex: 1, budgetBytes: gpuWorkspaceBytes(bytes) + bytes * 2 });
    const reference = input(0), current = input(1), background = input(2);
    await runtime.uploadFrame(reference, { frameIndex: 0 });
    await runtime.uploadFrame(current, { frameIndex: 1 });
    outer = runtime.pinFrames([current, reference]);
    inner = runtime.pinFrames([reference]);
    outer(); outer = null;
    runtime.configureCache({ currentIndex: 1 });
    await assert.rejects(runtime.uploadFrame(background, { frameIndex: 2 }), /cache budget/);
    assert.deepEqual(runtime.cacheStatus().cachedFrameIndexes, [0, 1]);
    inner(); inner(); inner = null; runtime.finishAnalysis();
    await runtime.uploadFrame(background, { frameIndex: 2 });
    assert.deepEqual(runtime.cacheStatus().cachedFrameIndexes, [1, 2]);
  } finally { outer?.(); inner?.(); runtime.close(); }
});

test('clearing a source frees input and index buffers while retaining the device and warmed pipelines', async () => {
  const state = fixture(), { runtime } = state;
  try {
    await runtime.warmup();
    assert.equal(state.compiled, 20);
    for (const source of [CNA_FIXED_SHADER, CNA_ADAPTIVE_SHADER, REFERENCE_STRAIN_CLEAR_SHADER, REFERENCE_STRAIN_SHADER, CSP_SHADER, DISPLACEMENT_SHADER, PTM_NEIGHBORS_SHADER]) {
      assert.ok(runtime.pipelines.has(source), 'new analysis kernels compile during device warmup');
    }
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

function ptmFit(frame, revision = 0) {
  const count = frame.types.length;
  return { structures: new Uint8Array(count).fill(1), scales: new Float64Array(count).fill(2.823456789),
    deformation: Float64Array.from({ length: count * 9 }, (_, component) => component % 4 ? 0 : 1), revision };
}

function ptmEncoder(counter) {
  return async (frame, fit) => {
    counter.count += 1;
    const count = frame.types.length, metadata = new Uint32Array(count * 2);
    fit.structures.forEach((structure, atom) => { metadata[atom * 2] = structure; });
    return { types: Uint32Array.from(frame.types), metadata, scales: new Float32Array(count * 2), deformation: new Float32Array(count * 18) };
  };
}

test('raw PTM fits cache 88 bytes per atom beyond shared types and survive edited lattice references', async () => {
  const { runtime, allocations } = fixture(), frame = input(0), fit = ptmFit(frame), counter = { count: 0 };
  try {
    const first = await runtime.preparePtmBuffers(frame, fit, ptmEncoder(counter), { frameIndex: 0 });
    assert.equal(first.reused, false); assert.equal(counter.count, 1);
    assert.equal(runtime.frames.get(100).bytes, frame.types.length * 92);
    assert.equal(runtime.allocatedBytes, frame.types.length * 92);
    assert.equal(runtime.frames.get(100).positionsBuffer, undefined, 'tensor fits do not require a neighbor upload');
    const second = await runtime.preparePtmBuffers(frame, { ...fit }, ptmEncoder(counter));
    assert.equal(second.reused, true); assert.equal(counter.count, 1); assert.equal(allocations.length, 4);
    assert.equal(second.metadataBuffer, first.metadataBuffer);
    await runtime.uploadFrame(frame, { frameIndex: 0 });
    assert.equal(runtime.frames.get(100).typesBuffer, first.typesBuffer);
    assert.equal(runtime.frames.get(100).bytes, frame.types.length * 124);
    assert.equal(runtime.allocatedBytes, frame.types.length * 124, 'lazy positions add 32N, without duplicating types');
    runtime.clearFrames(); assert.equal(runtime.getPtmBuffers(frame), undefined); assert.equal(runtime.allocatedBytes, 0);
    assert.ok(allocations.every(buffer => buffer.destroyed));
    assert.ok(fit.scales.byteLength && fit.deformation.byteLength && fit.structures.byteLength);
  } finally { runtime.close(); }
});

test('PTM fit revision and replaced element arrays refresh buffers atomically and invalidate old typed neighbor grids', async () => {
  const { runtime } = fixture(), frame = input(0), fit = ptmFit(frame), counter = { count: 0 };
  try {
    await runtime.uploadFrame(frame);
    const first = await runtime.preparePtmBuffers(frame, fit, ptmEncoder(counter));
    const grid = await runtime.prepareNeighbors(frame, 3.1);
    frame.types = new Uint16Array(frame.types.length).fill(2);
    const revised = { ...fit, revision: 1 }, updated = await runtime.preparePtmBuffers(frame, revised, ptmEncoder(counter));
    assert.equal(updated.reused, false); assert.equal(counter.count, 2);
    assert.ok(first.typesBuffer.destroyed && first.metadataBuffer.destroyed && first.scalesBuffer.destroyed && first.deformationBuffer.destroyed);
    assert.ok(grid.configBuffer.destroyed && grid.headsBuffer.destroyed && grid.nextBuffer.destroyed);
    assert.equal(runtime.indexes.size, 0);
    assert.ok(new Uint32Array(updated.typesBuffer.lastWrite.buffer).every(value => value === 2));
    assert.equal(runtime.residentBytes, frame.types.length * 124);
    assert.equal(runtime.allocatedBytes, frame.types.length * 124);
    assert.equal(runtime.getPtmBuffers(frame, fit), undefined);
    assert.equal((await runtime.preparePtmBuffers(frame, revised, ptmEncoder(counter))).reused, true);
  } finally { runtime.close(); }
});

test('cached PTM tensor inputs accept outside-cell source geometry and release only their fit on cancellation invalidation', async () => {
  const { runtime } = fixture(), frame = input(0), fit = ptmFit(frame), counter = { count: 0 };
  frame.cell.pbc = [false, false, false]; frame.fractional[0] = 2; fit.gpuFitId = 7;
  try {
    const first = await runtime.preparePtmBuffers(frame, fit, ptmEncoder(counter));
    assert.equal(first.reused, false);
    await assert.rejects(runtime.uploadFrame(frame), /inside the cell/);
    runtime.clearPtmBuffers(frame, 6); assert.equal(runtime.getPtmBuffers(frame).metadataBuffer, first.metadataBuffer);
    runtime.clearPtmBuffers(frame, 7); assert.equal(runtime.getPtmBuffers(frame), undefined);
    assert.ok(first.metadataBuffer.destroyed && first.scalesBuffer.destroyed && first.deformationBuffer.destroyed);
    assert.equal(first.typesBuffer.destroyed, false); assert.equal(runtime.residentBytes, frame.types.length * 4);
  } finally { runtime.close(); }
});

test('cancelled replacement PTM uploads preserve the preceding valid fit and free temporary allocations', async () => {
  const { runtime, allocations } = fixture(), frame = input(0), fit = ptmFit(frame), counter = { count: 0 };
  try {
    const first = await runtime.preparePtmBuffers(frame, fit, ptmEncoder(counter));
    const controller = new AbortController(), before = runtime.allocatedBytes;
    runtime.device.queue.onSubmittedWorkDone = async () => controller.abort();
    await assert.rejects(runtime.preparePtmBuffers(frame, { ...fit, revision: 1 }, ptmEncoder(counter), { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(runtime.allocatedBytes, before); assert.equal(first.metadataBuffer.destroyed, false);
    assert.equal(runtime.getPtmBuffers(frame, fit).metadataBuffer, first.metadataBuffer);
    assert.ok(allocations.slice(4).every(buffer => buffer.destroyed));
  } finally { runtime.close(); }
});

test('Cartesian-only residency accepts open positions outside the box and anchors precise source coordinates', async () => {
  const { runtime } = fixture();
  try {
    const frame = input(0), count = frame.types.length;
    frame.cell.pbc = [false, false, false];
    frame.fractional[0] = 2;
    const positions = new Float64Array(count * 3).fill(1e8);
    positions[3] = 1e8 + 1.4901161193847656e-8;
    const result = await runtime.prepareCartesianFrame(frame, positions, { frameIndex: 0 });
    assert.deepEqual([...result.anchor], [1e8, 1e8, 1e8]);
    const packed = new Float32Array(result.positionsBuffer.lastWrite.buffer);
    assert.equal(packed[8] + packed[12], positions[3] - positions[0]);
    assert.equal(runtime.frames.get(100).positionsBuffer, undefined, 'displacement needs no wrapped neighbor upload');
    assert.equal(runtime.frames.get(100).bytes, count * 32);
    assert.equal(runtime.cacheStatus().residentBytes, count * 32);
    await assert.rejects(runtime.uploadFrame(frame), /nonperiodic coordinates inside/);
    assert.equal(result.positionsBuffer.destroyed, false);
    const reused = await runtime.prepareCartesianFrame(frame, positions);
    assert.equal(reused.positionsBuffer, result.positionsBuffer);
    assert.equal(runtime.inputUploads, 1);
  } finally { runtime.close(); }
});

test('Cartesian packing carries a conservative encoding error for tiny motion across large source spans', async () => {
  const { runtime } = fixture();
  try {
    const frame = input(0), positions = new Float64Array(frame.types.length * 3);
    positions[3] = 1e6 + .02;
    const result = await runtime.prepareCartesianFrame(frame, positions);
    const packed = new Float32Array(result.positionsBuffer.lastWrite.buffer);
    assert.equal(packed[3], 0);
    const error = Math.abs(positions[3] - (packed[8] + packed[12]));
    assert.ok(error > 0);
    assert.ok(packed[11] >= error, 'the shader can identify displacement comparable to quantization uncertainty');
  } finally { runtime.close(); }
});

test('Cartesian variants reuse immutable inputs, refresh source changes, and coexist with lazy species uploads', async () => {
  const { runtime, allocations } = fixture();
  try {
    const frame = input(0), count = frame.types.length;
    const wrapped = Float64Array.from(frame.positions), unwrapped = Float64Array.from(wrapped, value => value + 40);
    const first = await runtime.prepareCartesianFrame(frame, wrapped, { frameIndex: 0 });
    const second = await runtime.prepareCartesianFrame(frame, unwrapped, { variant: 'unwrapped-cartesian' });
    assert.notEqual(first.positionsBuffer, second.positionsBuffer);
    assert.equal(runtime.frames.get(100).bytes, count * 64);
    await runtime.uploadFrame(frame, { frameIndex: 0 });
    const resident = runtime.frames.get(100);
    assert.equal(resident.bytes, count * 100);
    assert.equal(runtime.cacheStatus().residentBytes, count * 100);
    assert.ok(resident.typesBuffer);
    assert.equal(first.positionsBuffer.destroyed, false);
    const changed = wrapped.slice(); changed[3] += .125;
    const updated = await runtime.prepareCartesianFrame(frame, changed);
    assert.notEqual(updated.positionsBuffer, first.positionsBuffer);
    assert.equal(first.positionsBuffer.destroyed, true);
    assert.equal(second.positionsBuffer.destroyed, false);
    assert.equal(runtime.cacheStatus().residentBytes, count * 100, 'replacement does not add a new residency variant');
    assert.equal((await runtime.prepareCartesianFrame(frame, unwrapped, { variant: 'unwrapped-cartesian' })).positionsBuffer, second.positionsBuffer);
    runtime.clearFrames();
    assert.equal(runtime.allocatedBytes, 0);
    assert.ok(allocations.every(buffer => buffer.destroyed));
  } finally { runtime.close(); }
});

test('adaptive GPU CNA classifications survive result transfer but expire with their resident source', async () => {
  const { runtime } = fixture();
  try {
    const frame = input(0), structures = new Uint8Array(frame.types.length).fill(2);
    assert.equal(runtime.cacheAdaptiveCna(frame, structures), false, 'unresident or partial classifications are not cached');
    await runtime.uploadFrame(frame);
    assert.equal(runtime.cacheAdaptiveCna(frame, structures.subarray(1)), false);
    assert.equal(runtime.cacheAdaptiveCna(frame, structures), true);
    structuredClone(structures, { transfer: [structures.buffer] });
    assert.ok(runtime.getAdaptiveCna(frame).every(type => type === 2));
    runtime.evictFrame(100);
    assert.equal(runtime.getAdaptiveCna(frame), undefined);
    await runtime.uploadFrame(frame);
    runtime.cacheAdaptiveCna(frame, new Uint8Array(frame.types.length));
    runtime.clearFrames();
    assert.equal(runtime.adaptiveCna.size, 0);
  } finally { runtime.close(); }
});

test('Cartesian variant OOM retry preserves both active frames and frees its failed partial buffer', async () => {
  const state = fixture(), { runtime } = state;
  let releasePins;
  try {
    const frames = [input(0), input(1), input(3)], bytes = frames[0].types.length * 32;
    runtime.configureCache({ frameCount: 4, currentIndex: 1, budgetBytes: gpuWorkspaceBytes(bytes * 2) + bytes * 3 });
    for (const frame of frames) await runtime.prepareCartesianFrame(frame, Float64Array.from(frame.positions), { frameIndex: frame.gpuFrameId - 100 });
    const current = runtime.frames.get(101).cartesian.get('cartesian').positionsBuffer;
    const reference = runtime.frames.get(100).cartesian.get('cartesian').positionsBuffer;
    releasePins = runtime.pinFrames([frames[0], frames[1]]);
    state.failNextAllocation();
    const unwrapped = await runtime.prepareCartesianFrame(frames[0], Float64Array.from(frames[0].positions, value => value + 80),
      { variant: 'unwrapped-cartesian', frameIndex: 0 });
    assert.equal(current.destroyed, false); assert.equal(reference.destroyed, false);
    assert.equal(unwrapped.positionsBuffer.destroyed, false);
    assert.deepEqual(runtime.cacheStatus().cachedFrameIndexes, [0, 1]);
    assert.equal(runtime.cacheStatus().currentIndex, 1);
    assert.equal(runtime.cacheStatus().residentBytes, bytes * 3);
    assert.equal(runtime.allocatedBytes, bytes * 3);
    assert.ok(state.allocations.at(-2).destroyed, 'the first failed variant upload is released before retry');
    assert.deepEqual(state.scopes, []);
  } finally { releasePins?.(); runtime.close(); }
  assert.ok(state.allocations.every(buffer => buffer.destroyed));
});

test('collapsed linked-cell dimensions use the unique stencil size when bounding adaptive search work', async () => {
  const { runtime } = fixture();
  try {
    const frame = crystalFrame('fcc', 3);
    frame.cell.pbc = [true, false, true];
    const context = await runtime.prepareNeighbors(frame, 6.45);
    assert.deepEqual(context.dimensions, [1, 1, 1]);
    const config = new Uint32Array(context.configBuffer.lastWrite.buffer);
    assert.equal(config[28], 2000);
    assert.ok(config[28] >= frame.types.length, 'a 108-atom surface does not exceed its actual candidate-work budget');
  } finally { runtime.close(); }
});

test('very large periodic image coefficients fall back before upload while thin open axes stay supported', async () => {
  const { runtime, allocations } = fixture();
  try {
    assert.equal(MAX_GPU_PERIODIC_RADIUS_FACES, 32);
    const frame = input(0);
    frame.cell.vectors = new Float64Array([.05, 0, 0, 0, 8, 0, 0, 0, 8]);
    frame.cell.pbc = [true, false, false];
    await assert.rejects(runtime.prepareNeighbors(frame, 2), /distance precision budget/);
    assert.equal(allocations.length, 0);
    frame.cell.vectors[0] = 2 / MAX_GPU_PERIODIC_RADIUS_FACES;
    await assert.rejects(runtime.prepareNeighbors(frame, 2), /padded periodic image geometry/);
    assert.equal(allocations.length, 0, 'the shader search includes the padded, rather than just nominal, radius');
    frame.cell.vectors[0] = .05;
    frame.cell.pbc = [false, true, true];
    const context = await runtime.prepareNeighbors(frame, 2);
    assert.equal(context.dimensions[0], 1);
    assert.equal(runtime.inputUploads, 1, 'an irrelevant nonperiodic aspect ratio does not force fallback');
  } finally { runtime.close(); }
});

test('neighbor distance tolerance covers image cancellation coefficients and rejects padded-radius overflow', async () => {
  const { runtime, allocations } = fixture();
  try {
    const frame = input(0);
    frame.cell.vectors = new Float64Array([.25, 0, 0, 0, 8, 0, 0, 0, 8]);
    frame.cell.pbc = [true, false, false];
    const context = await runtime.prepareNeighbors(frame, 2);
    const coefficientSum = 9 + 1 + 1;
    const expected = Math.fround((2 * 8 * 32 * 2 ** -23 + 4 * 64 * 2 ** -23) * coefficientSum / 4);
    assert.equal(context.distanceTolerance, expected);
    runtime.clearFrames();
    const before = allocations.length;
    const cutoff = 1.84467e19;
    frame.cell.vectors = new Float64Array([cutoff, 0, 0, 0, cutoff, 0, 0, 0, cutoff]);
    frame.cell.pbc = [true, true, true];
    assert.ok(Number.isFinite(Math.fround(cutoff * cutoff)), 'the unpadded cutoff is representable');
    await assert.rejects(runtime.prepareNeighbors(frame, cutoff), /padded GPU neighbor radius/);
    assert.equal(allocations.length, before, 'overflow fails before uploading or casting image bounds in WGSL');
  } finally { runtime.close(); }
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
