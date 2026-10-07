import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import createDxa from '../src/analysis/dxa-kernel.mjs';
import { createCell, fractionalToCartesian, invert3 } from '../src/data/model.js';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';
import { analyzeGpuDxaLocalStructures, validateGpuDxaLocalInput, prepareGpuDxaLocalSettings,
  preflightGpuDxaLocalMemory, GPU_DXA_LOCAL_BATCH_ATOMS } from '../src/analysis/gpu/dxa-local.js';
import { DXA_LOCAL_SHADER, DXA_LOCAL_ROW_WORDS, DXA_LOCAL_WORKGROUP_SIZE } from '../src/analysis/gpu/dxa-local-shaders.js';
import { DXA_LOCAL_NEIGHBORS_SHADER, DXA_LOCAL_NEIGHBOR_ROW_WORDS } from '../src/analysis/gpu/dxa-local-neighbor-shaders.js';
import { GPU_DXA_LOCAL_NEIGHBOR_BATCH_ATOMS } from '../src/analysis/gpu/dxa-local-neighbors.js';

const MISSING = 0xffff_ffff;
let templatesPromise;
function nativeTemplates() {
  return templatesPromise ??= (async () => {
    const module = await createDxa({ wasmBinary: await readFile(new URL('../src/analysis/dxa-kernel.wasm', import.meta.url)) });
    const coordinates = module._malloc(4 * 24), cell = module._malloc(96);
    try {
      module.HEAPF64.set([0, 0, 0, 0, 2, 2, 2, 0, 2, 2, 2, 0], coordinates / 8);
      module.HEAPF64.set([20, 0, 0, 0, 20, 0, 0, 0, 20, 0, 0, 0], cell / 8);
      assert.equal(module._alloy_dxa_prepare(coordinates, 4, cell, 7, 1, 14, 9, 0, 1, 2.5), 1);
      const pointer = module._alloy_dxa_local_templates_ptr();
      return module.HEAPU32.slice(pointer / 4, pointer / 4 + 165);
    } finally { module._alloy_dxa_dispose(); module._free(coordinates); module._free(cell); }
  })();
}

async function inputs(count = 32) {
  const fractional = new Float64Array(count * 3);
  for (let atom = 0; atom < count; atom++) fractional.set([(atom % 17) / 17,
    (Math.floor(atom / 17) % 17) / 17, (Math.floor(atom / 289) % 17) / 17], atom * 3);
  const cell = createCell({ vectors: [20, 0, 0, 1.25, 20, 0, .5, .75, 20], origin: [4, -3, 2] });
  const frame = { fractional, cell, types: new Uint16Array(count) };
  return { frame, input: { coordinates: fractionalToCartesian(fractional, cell, new Float64Array(count * 3)),
    templates: (await nativeTemplates()).slice(), inverse: Float64Array.from(invert3(cell.vectors)),
    lattice: 1, identifyPlanarDefects: true } };
}

/** This fixture runs the real orchestration/nearest-table lifecycle. Fake
 * kernels produce explicit valid rows; scientific shader comparisons are in
 * the real WebGPU browser checks rather than mirrored by this unit fixture. */
function fixture({ failAllocation = -1, failRead = -1, cancelAfterRun, mutateRows,
  resolveAfterAttempt = 1, candidateOverflow = false } = {}) {
  const allocated = [], released = [], runs = [], reads = [], reserves = [], contexts = [], pins = [];
  let unpins = 0;
  const allocate = bytes => {
    if (allocated.length === failAllocation) throw new Error('Allocation failed.');
    const buffer = { data: new Uint8Array(Math.max(4, bytes)) }; allocated.push(buffer); return buffer;
  };
  const dispatch = (source, bindings, options) => {
    if (source === DXA_LOCAL_NEIGHBORS_SHADER) {
      const [context, table, packed, settings, status] = bindings, config = new Uint32Array(context.data.buffer);
      const start = config[26], end = config[27], count = end - start;
      runs.push({ source, table, packed, settings, start, end, count, options });
      const words = new Uint32Array(status.data.buffer);
      if (candidateOverflow) words[1] = 1;
      if (context.attempt >= resolveAfterAttempt) words[0] += count;
    } else {
      assert.equal(source, DXA_LOCAL_SHADER);
      const [settings, table, templates, output] = bindings, controls = new Uint32Array(settings.data.buffer);
      const start = controls[1], end = controls[2], total = controls[0], type = controls[3];
      runs.push({ source, table, settings, templates, output, start, end, count: end - start, options });
      const rows = new Uint32Array(output.data.buffer), view = new DataView(output.data.buffer);
      const width = new Uint32Array(templates.data.buffer)[(type - 1) * 33];
      for (let atom = start; atom < end; atom++) {
        const offset = atom * DXA_LOCAL_ROW_WORDS;
        rows[offset] = type;
        rows.fill(MISSING, offset + 1, offset + 17);
        for (let neighbor = 0; neighbor < width; neighbor++) rows[offset + 1 + neighbor] = (atom + neighbor + 1) % total;
        view.setFloat64((offset + 17) * 4, 2.5, true);
      }
      mutateRows?.(rows, view);
    }
    if (cancelAfterRun?.source === source) cancelAfterRun.controller.abort();
  };
  const runtime = {
    device: { limits: { maxBufferSize: 256 * 1024 ** 2, maxStorageBufferBindingSize: 256 * 1024 ** 2 } },
    budgetBytes: 512 * 1024 ** 2,
    async initialize(signal) { signal?.throwIfAborted(); },
    reserveWorkspace(bytes) { reserves.push(bytes); },
    createBuffer: allocate,
    storageBuffer(values) { const buffer = allocate(values.byteLength); buffer.data.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)); return buffer; },
    write(buffer, values, offset = 0) { buffer.data.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), offset); },
    pinFrames(frames) { pins.push(...frames); return () => { unpins++; }; },
    async prepareNeighbors(frame, radius, { signal }) {
      signal?.throwIfAborted();
      // The configuration words carry each neighbor dispatch's atom range.
      const context = { frame, radius, attempt: contexts.length + 1, data: new Uint8Array(112) }; contexts.push(context); return context;
    },
    neighborBindings(context, extras) { return [context, ...extras]; },
    async runSequence(source, bindings, total, options) {
      for (let start = 0; start < total; start += options.batch) {
        options.signal?.throwIfAborted();
        options.setRange(start, Math.min(total, start + options.batch));
        dispatch(source, bindings, options);
        options.onProgress?.(Math.min(total, start + options.batch));
      }
      options.signal?.throwIfAborted();
    },
    async read(buffer, Type, length, { signal }) {
      signal?.throwIfAborted(); reads.push({ buffer, Type, length });
      if (reads.length - 1 === failRead) throw new Error('Device read failed.');
      return new Type(buffer.data.buffer.slice(0, length * Type.BYTES_PER_ELEMENT));
    },
    disposeBuffers(buffers) { released.push(...buffers); },
  };
  return { runtime, allocated, released, runs, reads, reserves, contexts, pins, get unpins() { return unpins; } };
}

function assertReleased(setup) {
  assert.equal(setup.released.length, setup.allocated.length);
  assert.equal(new Set(setup.released).size, setup.released.length, 'temporary buffers release exactly once');
  for (const buffer of setup.allocated) assert.ok(setup.released.includes(buffer));
  assert.equal(setup.unpins, setup.pins.length, 'every nested frame pin is released');
}

test('GPU DXA local shells stay resident through classification and only compact output is read back', async () => {
  const count = GPU_DXA_LOCAL_NEIGHBOR_BATCH_ATOMS + 13, { frame, input } = await inputs(count), setup = fixture(), progress = [];
  const result = await analyzeGpuDxaLocalStructures(setup.runtime, frame, input, { onProgress: update => progress.push(update) });
  const nearestRuns = setup.runs.filter(run => run.source === DXA_LOCAL_NEIGHBORS_SHADER);
  const localRuns = setup.runs.filter(run => run.source === DXA_LOCAL_SHADER);
  assert.deepEqual(nearestRuns.map(run => [run.start, run.end]), [[0, GPU_DXA_LOCAL_NEIGHBOR_BATCH_ATOMS],
    [GPU_DXA_LOCAL_NEIGHBOR_BATCH_ATOMS, count]]);
  assert.deepEqual(localRuns.map(run => [run.start, run.end]), [[0, GPU_DXA_LOCAL_BATCH_ATOMS],
    [GPU_DXA_LOCAL_BATCH_ATOMS, GPU_DXA_LOCAL_BATCH_ATOMS * 2], [GPU_DXA_LOCAL_BATCH_ATOMS * 2, count]]);
  assert.ok(localRuns.every(run => run.options.workgroupSize === DXA_LOCAL_WORKGROUP_SIZE && !run.options.updateRange));
  assert.ok(setup.runs.every(run => run.table === nearestRuns[0].table), 'classification consumes the same device table');
  assert.equal(nearestRuns[0].table.data.byteLength, count * DXA_LOCAL_NEIGHBOR_ROW_WORDS * 4);
  assert.equal(nearestRuns[0].packed.data.byteLength, count * 36);
  assert.equal(setup.reads.length, 2);
  assert.equal(setup.reads[0].length, 4, 'nearest status is only sixteen bytes');
  assert.equal(setup.reads[1].buffer, localRuns[0].output);
  assert.ok(setup.reads.every(read => read.buffer !== nearestRuns[0].table), 'the large nearest table never returns to CPU');
  assert.ok(result.structures.every(type => type === 1)); assert.equal(result.neighborWidth, 12);
  assert.deepEqual([...result.neighbors.subarray(0, 12)], Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(result.maxNeighborDistance, 2.5);
  assert.equal(result.uploadedBytes, count * 36 + 88 + 128 + 660);
  assert.equal(result.readbackBytes, 16 + count * DXA_LOCAL_ROW_WORDS * 4);
  assert.deepEqual(result.gpuStages, ['local-neighbors', 'local-structures', 'local-correspondence']);
  assert.equal(result.arithmetic, 'ieee754-f64'); assert.equal(result.gpuRadiusAttempts, 1);
  assert.equal(progress.at(-1).phase, 'complete'); assert.equal(progress.at(-1).completedAtoms, count);
  assert.equal(setup.contexts[0].frame, frame); assert.equal(setup.pins.length, 2);
  assert.ok(setup.pins.every(pinned => pinned === frame));
  assertReleased(setup);
});

test('adaptive GPU DXA radius retries reuse one table and read only status between attempts', async () => {
  const { frame, input } = await inputs(), setup = fixture({ resolveAfterAttempt: 2 });
  const result = await analyzeGpuDxaLocalStructures(setup.runtime, frame, input);
  assert.equal(result.gpuRadiusAttempts, 2); assert.equal(setup.contexts.length, 2);
  assert.equal(setup.contexts[1].radius, setup.contexts[0].radius * 1.6);
  assert.equal(setup.allocated.length, 7);
  assert.deepEqual(setup.reads.map(read => read.length), [4, 4, 32 * DXA_LOCAL_ROW_WORDS]);
  assert.equal(result.readbackBytes, 32 + 32 * DXA_LOCAL_ROW_WORDS * 4);
  assertReleased(setup);
});

test('GPU DXA local preflight rejects complete tables before allocations or cache reservations', async () => {
  const { frame, input } = await inputs();
  for (const mode of ['buffer', 'budget']) {
    const setup = fixture();
    if (mode === 'buffer') setup.runtime.device.limits.maxStorageBufferBindingSize = 100;
    else setup.runtime.budgetBytes = 100;
    await assert.rejects(analyzeGpuDxaLocalStructures(setup.runtime, frame, input), /GPU (buffer limits|memory budget)/);
    assert.equal(setup.allocated.length, 0); assert.equal(setup.reserves.length, 0); assert.equal(setup.pins.length, 0);
  }
  const setup = fixture();
  assert.equal(preflightGpuDxaLocalMemory(setup.runtime, 32), 32 * (456 + 36 + 80 + 80) + 908);
  assert.equal(setup.reserves.length, 1);
});

test('GPU DXA local cancellation and allocation/read failures release outputs, nearest workspaces and frame pins', async () => {
  const { frame, input } = await inputs();
  const cases = Array.from({ length: 7 }, (_, failAllocation) => ({ failAllocation }));
  cases.push({ failRead: 0 }, { failRead: 1 }, { candidateOverflow: true });
  for (const source of [DXA_LOCAL_NEIGHBORS_SHADER, DXA_LOCAL_SHADER]) cases.push({ cancelAfterRun: { source, controller: new AbortController() } });
  for (const options of cases) {
    const setup = fixture(options);
    await assert.rejects(analyzeGpuDxaLocalStructures(setup.runtime, frame, input,
      { signal: options.cancelAfterRun?.controller.signal }));
    assertReleased(setup);
  }
});

test('invalid GPU local classifications and correspondence request fallback while releasing every workspace', async () => {
  const { frame, input } = await inputs();
  const corruptions = [
    rows => { rows[19] = 1; }, rows => { rows[19] = 4; }, rows => { rows[19] = 5; },
    rows => { rows[0] = 3; }, rows => { rows[1] = 0; }, rows => { rows[2] = rows[1]; },
    rows => { rows[13] = 1; }, (_rows, view) => { view.setFloat64(17 * 4, NaN, true); },
    (_rows, view) => { view.setFloat64(17 * 4, 0, true); },
  ];
  for (const mutateRows of corruptions) {
    const setup = fixture({ mutateRows });
    await assert.rejects(analyzeGpuDxaLocalStructures(setup.runtime, frame, input), /DXA|simulation cell/);
    assertReleased(setup);
  }
});

test('GPU DXA local schema validation precedes allocation and native binary64 cell bits reach settings unchanged', async () => {
  const { frame, input } = await inputs();
  const invalids = [
    value => { value.coordinates = new Float32Array(value.coordinates); },
    value => { value.templates = value.templates.slice(1); }, value => { value.inverse[0] = NaN; },
    value => { value.lattice = 6; }, value => { value.identifyPlanarDefects = 1; },
    value => { value.templates[0] = 11; }, value => { value.templates[17] |= 1; },
    value => { value.templates[17] ^= 2; },
  ];
  for (const mutate of invalids) {
    const value = { ...input, templates: input.templates.slice(), inverse: input.inverse.slice() }, setup = fixture(); mutate(value);
    await assert.rejects(analyzeGpuDxaLocalStructures(setup.runtime, frame, value), /GPU DXA/);
    assert.equal(setup.allocated.length, 0);
  }
  assert.deepEqual(validateGpuDxaLocalInput(frame, input), { atomCount: 32, neighborWidth: 12, requiredNeighbors: 13 });
  const settings = prepareGpuDxaLocalSettings({ ...frame, cell: { ...frame.cell, pbc: [true, false, true] } }, input);
  assert.deepEqual([...settings.subarray(0, 6)], [32, 0, 32, 1, 1, 5]);
  assert.deepEqual(new Uint8Array(settings.buffer, 32, 72), new Uint8Array(input.inverse.buffer));
  const view = new DataView(settings.buffer);
  assert.equal(view.getFloat64(104, true), .5 + 1e-12); assert.equal(view.getFloat64(112, true), Math.fround(1e-12));
});

class WorkerFixture {
  constructor() { this.listeners = new Map(); this.messages = []; this.terminated = false; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  postMessage(data, transfer = []) { this.messages.push(structuredClone(data, { transfer })); }
  terminate() { this.terminated = true; }
  answer(message, extras = {}) {
    this.listeners.get('message')({ data: { id: message.id, ok: true,
      result: { structures: new Int32Array(32), neighbors: new Int32Array(384).fill(-1), neighborWidth: 12, maxNeighborDistance: 0 },
      cachedFrameIds: message.frameId ? [message.frameId] : [], cacheStatus: { budgetBytes: 128 * 1024 ** 2 }, ...extras } });
  }
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error('GPU task was not dispatched.');
}

test('GPU local DXA reuses one worker and resident frame identity while copying all caller-owned native arrays', async () => {
  const { frame, input } = await inputs(), before = structuredClone(input), worker = new WorkerFixture(); let workerCount = 0;
  const client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => { workerCount++; return worker; } });
  try {
    const warm = client.warmup(); await until(() => worker.messages.length === 1); worker.answer(worker.messages[0]); await warm;
    const first = client.identifyDxa(frame, input, { frameIndex: 7 });
    await until(() => worker.messages.length === 2);
    const message = worker.messages[1];
    assert.equal(message.type, 'analyze'); assert.equal(message.parameters.kind, 'dxaLocal'); assert.equal(message.frameIndex, 7);
    assert.deepEqual(message.frame.fractional, frame.fractional); assert.notEqual(message.frame.fractional.buffer, frame.fractional.buffer);
    for (const key of ['coordinates', 'templates', 'inverse']) {
      assert.deepEqual(message.parameters[key], input[key]); assert.notEqual(message.parameters[key].buffer, input[key].buffer);
    }
    worker.answer(message); await first;
    const second = client.identifyDxa(frame, input);
    await until(() => worker.messages.length === 3);
    const reused = worker.messages[2];
    assert.equal(reused.frame, undefined); assert.equal(reused.frameId, message.frameId); assert.equal(reused.frameIndex, 7);
    worker.answer(reused); await second;
    assert.deepEqual(input, before); assert.equal(workerCount, 1); assert.equal(worker.terminated, false);
    assert.equal(frame.fractional.byteLength, 32 * 24);
  } finally { client.close(); }
});

test('GPU local DXA cancels queued input copies and preserves its device worker until running work acknowledges', async () => {
  const { frame, input } = await inputs(), worker = new WorkerFixture();
  const client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  try {
    const runningController = new AbortController(), running = client.identifyDxa(frame, input, { signal: runningController.signal });
    const runningRejected = assert.rejects(running, { name: 'AbortError' });
    await until(() => worker.messages.length === 1);
    const queuedController = new AbortController(), queued = client.identifyDxa(frame, input, { signal: queuedController.signal });
    const queuedRejected = assert.rejects(queued, { name: 'AbortError' });
    queuedController.abort(); await queuedRejected;
    assert.equal(worker.messages.length, 1); assert.equal(input.coordinates.byteLength, 32 * 24);
    runningController.abort(); await runningRejected;
    assert.equal(worker.messages.at(-1).type, 'cancel'); assert.equal(worker.terminated, false);
    client.release({ whenIdle: true }); assert.equal(worker.terminated, false);
    worker.answer(worker.messages[0], { ok: false, name: 'AbortError', error: 'Cancelled.' });
    assert.equal(worker.terminated, true);
    assert.equal(input.templates.byteLength, 660); assert.equal(frame.fractional.byteLength, 32 * 24);
  } finally { client.close(); }
});
