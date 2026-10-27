import { determinant3 } from '../../data/model.js';
import { validateVolumetricDataset, volumetricCellDimensions } from '../../data/volumetric-grid.js';
import { GpuUnavailableError, checkSignal, yieldWorker } from './support.js';
import { VOLUMETRIC_COUNT_SHADER, VOLUMETRIC_EMIT_SHADER } from './volumetric-shaders.js';

const caches = new WeakMap();
const BATCH_CELLS = 16_384;
const MAX_TRIANGLES = 1_000_000;
const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const FLOAT_MIN_NORMAL = 2 ** -126;
const error = message => new GpuUnavailableError(`GPU isosurface: ${message}`);
const scoped = (runtime, operation) => runtime.withErrors ? runtime.withErrors(operation) : Promise.resolve().then(operation);

/** Compile only; no scientific results or grid-size workspace is created. */
export async function warmGpuVolumetric(runtime, { signal } = {}) {
  checkSignal(signal);
  await runtime.initialize(signal);
  checkSignal(signal);
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
  });
  try { await Promise.race([Promise.all([runtime.compilePipeline(VOLUMETRIC_COUNT_SHADER), runtime.compilePipeline(VOLUMETRIC_EMIT_SHADER)]), cancelled]); }
  finally { signal?.removeEventListener('abort', abort); }
  checkSignal(signal);
}

/** Releases copied grid data and bounded scratch buffers, retaining the device
 * and compiled pipelines. The owning Worker calls this on source changes. */
export function releaseGpuVolumetric(runtime) {
  const cache = caches.get(runtime);
  if (cache) runtime.disposeBuffers([cache.samples, ...Object.values(cache.scratch).map(entry => entry.buffer)]);
  caches.delete(runtime);
}

function sameInput(cache, dataset, runtime) {
  return cache?.device === runtime.device && cache.source === dataset.values && cache.revision === dataset.revision;
}

function pair(value, tail = 0, output = new Float32Array(3), offset = 0) {
  const high = Math.fround(value), remainder = value - high;
  // Error-free TwoSum retains the lost bits of normalization before packing.
  const combined = remainder + tail, virtualTail = combined - remainder;
  const residualTail = (remainder - (combined - virtualTail)) + (tail - virtualTail);
  const low = Math.fround(combined);
  if (!Number.isFinite(high) || !Number.isFinite(low)
      || low !== 0 && Math.abs(low) < FLOAT_MIN_NORMAL || high !== 0 && Math.abs(high) < FLOAT_MIN_NORMAL) {
    throw error('scalar encoding exceeds normal float32 precision; using CPU Workers.');
  }
  const residual = Math.abs(combined - low) + Math.abs(residualTail);
  // Round upward: this bound is used only to flag uncertain topology.
  const uncertainty = residual === 0 ? 0 : Math.max(FLOAT_MIN_NORMAL, Math.fround(residual * (1 + 2 ** -22)));
  output[offset] = high; output[offset + 1] = low; output[offset + 2] = uncertainty;
  return output;
}

function normalizedPair(value, anchor, scale, output, offset = 0) {
  const difference = value - anchor, virtualAnchor = difference - value;
  // Error-free TwoDiff: tiny near-zero samples must not vanish when the
  // extrema place the normalization anchor far from this particular sample.
  const tail = (value - (difference - virtualAnchor)) - (anchor + virtualAnchor);
  const normalized = difference / scale, normalizedTail = tail / scale;
  if (!Number.isFinite(normalized) || tail !== 0 && normalizedTail === 0) throw error('scalar normalization loses source precision; using CPU Workers.');
  return pair(normalized, normalizedTail, output, offset);
}

export async function prepareGpuVolumetric(runtime, dataset, { signal } = {}) {
  validateVolumetricDataset(dataset);
  checkSignal(signal);
  if (dataset.values.length * 16 > MAX_INPUT_BYTES) throw error('the scalar grid exceeds the upload budget.');
  await runtime.initialize(signal);
  let cache = caches.get(runtime);
  if (sameInput(cache, dataset, runtime)) return { cache, inputReused: true };
  let minimum = Infinity, maximum = -Infinity;
  for (let start = 0; start < dataset.values.length; start += 65_536) {
    checkSignal(signal);
    for (let index = start; index < Math.min(start + 65_536, dataset.values.length); index++) {
      const value = dataset.values[index];
      if (!Number.isFinite(value)) throw new Error('Volumetric values must be finite.');
      minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
    }
    await yieldWorker();
  }
  const anchor = minimum / 2 + maximum / 2;
  const span = Math.max(Math.abs(minimum - anchor), Math.abs(maximum - anchor));
  const scale = span === 0 ? 1 : 2 ** Math.floor(Math.log2(span));
  if (!Number.isFinite(scale) || scale <= 0) throw error('the scalar dynamic range exceeds GPU normalization.');
  const encoded = new Float32Array(dataset.values.length * 4);
  for (let start = 0; start < dataset.values.length; start += 65_536) {
    checkSignal(signal);
    for (let index = start; index < Math.min(start + 65_536, dataset.values.length); index++) {
      normalizedPair(dataset.values[index], anchor, scale, encoded, index * 4);
    }
    await yieldWorker();
  }
  checkSignal(signal);
  // Keep the old valid upload until encoding succeeds; allocation failure also
  // leaves its scientific source intact, ready for CPU fallback or a retry.
  let samples;
  try {
    runtime.reserveWorkspace?.(encoded.byteLength);
    await scoped(runtime, () => { samples = runtime.storageBuffer(encoded); });
    checkSignal(signal);
  } catch (failure) { runtime.disposeBuffers([samples]); throw failure; }
  releaseGpuVolumetric(runtime);
  cache = { device: runtime.device, source: dataset.values, revision: dataset.revision, samples, anchor, scale,
    minimum, maximum, scratch: {} };
  caches.set(runtime, cache);
  return { cache, inputReused: false };
}

async function scratch(runtime, cache, name, bytes) {
  let entry = cache.scratch[name];
  if (entry?.bytes >= bytes) return entry.buffer;
  const size = Math.max(4, 2 ** Math.ceil(Math.log2(bytes || 4)));
  runtime.disposeBuffers([entry?.buffer]); delete cache.scratch[name];
  let buffer;
  try { await scoped(runtime, () => { buffer = runtime.createBuffer(size); }); }
  catch (failure) { runtime.disposeBuffers([buffer]); throw failure; }
  cache.scratch[name] = { buffer, bytes: size };
  return buffer;
}

/** GPU count/prefix/emit extraction; only prefix sums, Cartesian reconstruction
 * and scalar surface-area reduction run on the host. Marching tetrahedra run
 * on the GPU in bounded batches. Geometry output is returned to the existing
 * WebGL renderer, without replacing its rendering backend. */
export async function analyzeGpuIsosurface(runtime, dataset, parameters = {}, { signal, onProgress = () => {} } = {}) {
  const startedAt = performance.now();
  validateVolumetricDataset(dataset);
  const cells = volumetricCellDimensions(dataset), totalCells = cells.reduce((a, b) => a * b, 1);
  const { level, startCell = 0, endCell = totalCells, maxTriangles = MAX_TRIANGLES } = parameters;
  if (!Number.isFinite(level)) throw new Error('An isosurface needs a finite level.');
  if (!Number.isSafeInteger(startCell) || !Number.isSafeInteger(endCell) || startCell < 0 || endCell < startCell || endCell > totalCells) throw new Error('Invalid isosurface cell range.');
  if (!Number.isInteger(maxTriangles) || maxTriangles < 1 || maxTriangles > MAX_TRIANGLES) throw new Error('Invalid isosurface triangle budget.');
  const report = (phase, completedCells = 0) => onProgress({ phase, backend: 'gpu', completedCells, totalCells: endCell - startCell,
    completedAtoms: completedCells, totalAtoms: endCell - startCell, workerCount: 1 });
  report('preparing');
  const { cache, inputReused } = await prepareGpuVolumetric(runtime, dataset, { signal });
  const metadata = { kind: 'isosurface', level, startCell, endCell, totalCells, backend: 'gpu', workerCount: 1, inputReused, gpuInputReused: inputReused };
  const finish = (vertices, triangles, surfaceArea) => ({ ...metadata, vertices, triangles,
    triangleCount: triangles.length / 3, statistics: { surfaceArea }, elapsedMs: performance.now() - startedAt });
  if (endCell === startCell || level < cache.minimum || level > cache.maximum) {
    checkSignal(signal); report('complete', endCell - startCell);
    return finish(new Float64Array(), new Uint32Array(), 0);
  }
  const settings = new Uint32Array(16), floats = new Float32Array(settings.buffer);
  settings.set(dataset.dimensions); settings.set(cells, 3);
  settings[9] = Number(determinant3(dataset.steps) < 0);
  floats.set(normalizedPair(level, cache.anchor, cache.scale), 10);
  const config = await scratch(runtime, cache, 'config', settings.byteLength);
  const countsBuffer = await scratch(runtime, cache, 'counts', BATCH_CELLS * 8);
  const offsetsBuffer = await scratch(runtime, cache, 'offsets', (BATCH_CELLS + 1) * 4);
  const parts = []; let triangleCount = 0, surfaceArea = 0;
  for (let first = startCell; first < endCell; first += BATCH_CELLS) {
    checkSignal(signal);
    const count = Math.min(BATCH_CELLS, endCell - first);
    settings[6] = first; settings[7] = count; runtime.write(config, settings);
    report('gpu-dispatch', first - startCell);
    await runtime.run(VOLUMETRIC_COUNT_SHADER, [config, cache.samples, countsBuffer], count,
      { signal, batchSize: 0, workgroupSize: 64, wait: false });
    const counts = await runtime.read(countsBuffer, Uint32Array, count * 2, { signal });
    const offsets = new Uint32Array(count + 1);
    for (let index = 0; index < count; index++) {
      if (counts[index * 2 + 1]) throw error('the selected level or thin triangles need double-precision CPU topology.');
      if (counts[index * 2] > 12) throw error('the driver returned an invalid tetrahedron count.');
      offsets[index + 1] = offsets[index] + counts[index * 2];
    }
    const batchTriangles = offsets[count];
    if (triangleCount + batchTriangles > maxTriangles) {
      const failure = new Error('The isosurface exceeds the triangle budget; choose another level or a smaller grid.');
      failure.volumetricResourceLimit = true;
      throw failure;
    }
    if (!batchTriangles) { await yieldWorker(); continue; }
    runtime.write(offsetsBuffer, offsets);
    const outputBuffer = await scratch(runtime, cache, 'output', batchTriangles * 3 * 16);
    await runtime.run(VOLUMETRIC_EMIT_SHADER, [config, cache.samples, offsetsBuffer, outputBuffer], count,
      { signal, batchSize: 0, workgroupSize: 64, wait: false });
    report('readback', first - startCell);
    const packed = await runtime.read(outputBuffer, Float32Array, batchTriangles * 12, { signal });
    const vertices = new Float64Array(batchTriangles * 9), h = dataset.steps, o = dataset.origin;
    for (let index = 0; index < batchTriangles * 3; index++) {
      const offset = index * 4, id = packed[offset + 3];
      if (!Number.isInteger(id) || id < first || id >= first + count) throw error('the emitted voxel identity is invalid.');
      const lx = packed[offset], ly = packed[offset + 1], lz = packed[offset + 2];
      if (!(lx >= 0 && lx <= 1 && ly >= 0 && ly <= 1 && lz >= 0 && lz <= 1)) throw error('the emitted intersection is invalid.');
      const x = id % cells[0] + lx, y = Math.floor(id / cells[0]) % cells[1] + ly, z = Math.floor(id / (cells[0] * cells[1])) + lz;
      for (let axis = 0; axis < 3; axis++) {
        const value = o[axis] + x * h[axis] + y * h[3 + axis] + z * h[6 + axis];
        if (!Number.isFinite(value)) throw error('the Cartesian vertex exceeds the coordinate range.');
        vertices[index * 3 + axis] = value;
      }
      if (index % 4096 === 0) { await yieldWorker(); checkSignal(signal); }
    }
    for (let index = 0; index < packed.length; index += 12) {
      // Area depends on local displacements, independent of large origins.
      const a0 = packed[index + 4] - packed[index], a1 = packed[index + 5] - packed[index + 1], a2 = packed[index + 6] - packed[index + 2];
      const b0 = packed[index + 8] - packed[index], b1 = packed[index + 9] - packed[index + 1], b2 = packed[index + 10] - packed[index + 2];
      const ax = a0 * h[0] + a1 * h[3] + a2 * h[6], ay = a0 * h[1] + a1 * h[4] + a2 * h[7], az = a0 * h[2] + a1 * h[5] + a2 * h[8];
      const bx = b0 * h[0] + b1 * h[3] + b2 * h[6], by = b0 * h[1] + b1 * h[4] + b2 * h[7], bz = b0 * h[2] + b1 * h[5] + b2 * h[8];
      surfaceArea += Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2;
    }
    parts.push(vertices); triangleCount += batchTriangles;
    await yieldWorker(); checkSignal(signal);
  }
  const vertices = new Float64Array(triangleCount * 9), triangles = new Uint32Array(triangleCount * 3);
  let offset = 0;
  for (const part of parts) { vertices.set(part, offset); offset += part.length; await yieldWorker(); checkSignal(signal); }
  for (let index = 0; index < triangles.length; index++) {
    triangles[index] = index;
    if ((index & 65535) === 0) { await yieldWorker(); checkSignal(signal); }
  }
  if (!Number.isFinite(surfaceArea)) throw error('surface area exceeds finite precision.');
  report('complete', endCell - startCell);
  return finish(vertices, triangles, surfaceArea);
}
