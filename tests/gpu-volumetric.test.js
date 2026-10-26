import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGpuIsosurface, prepareGpuVolumetric, releaseGpuVolumetric, warmGpuVolumetric } from '../src/analysis/gpu/volumetric.js';
import { VOLUMETRIC_COUNT_SHADER, VOLUMETRIC_EMIT_SHADER } from '../src/analysis/gpu/volumetric-shaders.js';

// Lifecycle/packing tests only. The browser companion runs the real WGSL and
// compares triangle topology, orientation, coordinates and area against CPU.
function grid(values = [0, 1, 0, 1, 0, 1, 0, 1]) {
  return { dimensions: [2, 2, 2], values: Float64Array.from(values), origin: new Float64Array(3),
    steps: Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), periodic: [false, false, false] };
}
function fixture({ count = 1, flags = 0, onRead } = {}) {
  const allocations = [], compiled = [], dispatches = [];
  const runtime = {
    device: {}, async initialize() {}, async compilePipeline(source) { compiled.push(source); },
    reserveWorkspace() {},
    createBuffer(bytes) { const buffer = { data: new Uint8Array(bytes), destroyed: false }; allocations.push(buffer); return buffer; },
    storageBuffer(values) { const buffer = this.createBuffer(values.byteLength); this.write(buffer, values); return buffer; },
    write(buffer, values) { buffer.data.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)); },
    disposeBuffers(buffers) { for (const buffer of buffers) if (buffer) buffer.destroyed = true; },
    async run(source, bindings, cells) {
      dispatches.push({ source, cells });
      if (source === VOLUMETRIC_COUNT_SHADER) new Uint32Array(bindings[2].data.buffer).set([count, flags]);
      else {
        assert.equal(source, VOLUMETRIC_EMIT_SHADER);
        const first = new Uint32Array(bindings[0].data.buffer)[6], output = new Float32Array(bindings[3].data.buffer);
        output.set([0.5, 0, 0, 0, 0.5, 1, 0, 0, 0.5, 0, 1, 0]);
        output[3] = output[7] = output[11] = first;
      }
    },
    async read(buffer, Type, length, { signal } = {}) {
      onRead?.();
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      return new Type(buffer.data.buffer.slice(0, length * Type.BYTES_PER_ELEMENT));
    },
  };
  return { runtime, allocations, compiled, dispatches };
}

test('volumetric GPU warmup compiles only and cancellation releases the waiter', async () => {
  const f = fixture(); await warmGpuVolumetric(f.runtime);
  assert.deepEqual(f.compiled, [VOLUMETRIC_COUNT_SHADER, VOLUMETRIC_EMIT_SHADER]);
  assert.equal(f.allocations.length, 0);
  const controller = new AbortController();
  f.runtime.compilePipeline = () => new Promise(() => {});
  const pending = warmGpuVolumetric(f.runtime, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('GPU scalar encoding retains tiny residuals around large offsets and caches only immutable source identities', async () => {
  const f = fixture(), dataset = grid([1e12, 1e12 + 1 / 1024, 1e12, 1e12, 1e12, 1e12, 1e12, 1e12]);
  const initial = await prepareGpuVolumetric(f.runtime, dataset);
  const encoded = new Float32Array(initial.cache.samples.data.buffer);
  assert.equal(encoded[0] + encoded[1], -1); assert.equal(encoded[4] + encoded[5], 1);
  assert.equal((await prepareGpuVolumetric(f.runtime, dataset)).inputReused, true);
  const replacement = await prepareGpuVolumetric(f.runtime, { ...dataset, revision: 1 });
  assert.equal(replacement.inputReused, false); assert.equal(initial.cache.samples.destroyed, true);
  releaseGpuVolumetric(f.runtime); assert.ok(f.allocations.every(buffer => buffer.destroyed));
});

test('GPU normalization carries source precision lost by subtracting a distant scalar anchor', async () => {
  const f = fixture(), dataset = grid([0, 1, 1e-20, 0, 0, 0, 0, 0]);
  const { cache } = await prepareGpuVolumetric(f.runtime, dataset);
  const encoded = new Float32Array(cache.samples.data.buffer);
  assert.equal(encoded[8], -1); assert.ok(encoded[9] > 0, 'the 1e-20 source residual survives normalization');
  releaseGpuVolumetric(f.runtime);
});

test('GPU prefix/emit host assembly preserves source buffers, local surface area and reusable allocations', async () => {
  const f = fixture(), dataset = grid(); dataset.origin.set([1e16, -1e16, 1e16]);
  const before = dataset.values.slice(), first = await analyzeGpuIsosurface(f.runtime, dataset, { level: 0.5 });
  assert.equal(first.triangleCount, 1); assert.equal(first.statistics.surfaceArea, 0.5);
  assert.deepEqual(first.triangles, Uint32Array.from([0, 1, 2])); assert.deepEqual(dataset.values, before);
  const allocated = f.allocations.length, second = await analyzeGpuIsosurface(f.runtime, dataset, { level: 0.6 });
  assert.equal(second.gpuInputReused, true); assert.equal(f.allocations.length, allocated);
  releaseGpuVolumetric(f.runtime); assert.ok(f.allocations.every(buffer => buffer.destroyed));
});

test('GPU numerical diagnostics and output budgets reject before emitting truncated geometry', async () => {
  const flagged = fixture({ flags: 1 });
  await assert.rejects(analyzeGpuIsosurface(flagged.runtime, grid(), { level: 0.5 }), { name: 'GpuUnavailableError' });
  assert.equal(flagged.dispatches.length, 1); releaseGpuVolumetric(flagged.runtime);
  const excessive = fixture({ count: 2 });
  await assert.rejects(analyzeGpuIsosurface(excessive.runtime, grid(), { level: 0.5, maxTriangles: 1 }), failure => /triangle budget/.test(failure.message) && failure.volumetricResourceLimit);
  assert.equal(excessive.dispatches.length, 1); releaseGpuVolumetric(excessive.runtime);
});

test('GPU cancellation preserves reusable buffers and source clear frees them', async () => {
  const controller = new AbortController(), f = fixture({ onRead: () => controller.abort() });
  await assert.rejects(analyzeGpuIsosurface(f.runtime, grid(), { level: 0.5 }, { signal: controller.signal }), { name: 'AbortError' });
  assert.ok(f.allocations.length > 1 && f.allocations.every(buffer => !buffer.destroyed));
  releaseGpuVolumetric(f.runtime); assert.ok(f.allocations.every(buffer => buffer.destroyed));
});

test('invalid GPU volume settings and scalar values fail before allocating resources', async () => {
  const f = fixture();
  await assert.rejects(analyzeGpuIsosurface(f.runtime, grid(), { level: NaN }), /finite/);
  await assert.rejects(analyzeGpuIsosurface(f.runtime, grid(), { level: 0.5, startCell: -1 }), /range/);
  await assert.rejects(analyzeGpuIsosurface(f.runtime, grid([NaN, 0, 0, 0, 0, 0, 0, 0]), { level: 0.5 }), /finite/);
  assert.equal(f.allocations.length, 0);
});

test('asynchronous GPU allocation failures do not replace valid resident grids or retain failed scratch', async () => {
  const f = fixture(), dataset = grid(), original = await prepareGpuVolumetric(f.runtime, dataset);
  f.runtime.withErrors = async operation => { await operation(); throw new Error('scoped allocation failure'); };
  await assert.rejects(prepareGpuVolumetric(f.runtime, { ...dataset, values: dataset.values.slice() }), /scoped allocation/);
  assert.equal(original.cache.samples.destroyed, false);
  assert.equal(f.allocations.at(-1).destroyed, true);
  await assert.rejects(analyzeGpuIsosurface(f.runtime, dataset, { level: 0.5 }), /scoped allocation/);
  assert.equal(f.allocations.at(-1).destroyed, true);
  delete f.runtime.withErrors;
  assert.equal((await analyzeGpuIsosurface(f.runtime, dataset, { level: 0.5 })).inputReused, true);
  releaseGpuVolumetric(f.runtime);
  assert.ok(f.allocations.every(buffer => buffer.destroyed));
});
