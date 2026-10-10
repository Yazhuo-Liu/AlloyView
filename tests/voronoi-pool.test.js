import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { AnalysisPool, VORONOI_CPU_ROUTE_REASON } from '../src/analysis/analysis-pool.js';
import { calculateVoronoi, VORONOI_FIELDS } from '../src/analysis/voronoi.js';
import { crystalFrame } from './helpers/crystals.js';

function nodeFactory(stats) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    stats.created += 1;
    return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transferables) { worker.postMessage(data, transferables); },
      terminate() { worker.terminate(); } };
  };
}

test('parallel Voronoi center ranges retain complete face topology and reuse resident Wasm memory', async () => {
  const stats = { created: 0 };
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 } }, workerFactory: nodeFactory(stats) });
  const frame = crystalFrame('fcc', 6);
  frame.fractional[0] += .003;
  const original = frame.fractional.slice();
  try {
    const first = await pool.analyze(frame, { kind: 'voronoi', bins: 23 });
    const created = stats.created;
    const second = await pool.analyze(frame, { kind: 'voronoi', bins: 23 });
    const direct = await calculateVoronoi(frame, { bins: 23 });
    assert.equal(first.workerCount, 2);
    assert.match(first.engine, /voro\+\+-wasm-worker-pool/);
    assert.equal(first.kernelInitializations, 2);
    assert.equal(first.indexBuilds, 2);
    assert.equal(first.frameUploads, 2);
    assert.equal(first.scheduling, 'dynamic');
    assert.ok(first.chunkCount >= first.workerCount * 4, 'several bounded ranges per worker allow load balancing');
    assert.equal(second.kernelInitializations, 0);
    assert.equal(second.indexBuilds, 0);
    assert.equal(second.frameUploads, 0, 'repeated jobs send chunk parameters and retain the full source snapshot');
    assert.equal(stats.created, created, 'second run reuses both Worker threads and their Wasm modules');
    for (const field of [...Object.keys(VORONOI_FIELDS), 'faceOffsets', 'faceAreas', 'faceOrders', 'faceNeighbors', 'faceBoundary', 'faceAccepted', 'voronoiIndices']) {
      assert.deepEqual(first[field], direct[field], field);
      assert.deepEqual(second[field], direct[field], field);
    }
    assert.ok(Math.abs(first.summary.volumeError) < 1e-12);
    assert.equal(first.volumeHistogram.length, 23);
    assert.equal(first.faceAreaHistogram.length, 23);
    assert.deepEqual(frame.fractional, original);
  } finally { pool.close(); }
});

test('resident Voronoi snapshots detect mutable coordinate and cell input while selected geometry reuses the full index', async () => {
  const stats = { created: 0 };
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 } }, workerFactory: nodeFactory(stats) });
  const frame = crystalFrame('bcc', 6);
  try {
    await pool.analyze(frame, { kind: 'voronoi' });
    const geometry = await pool.analyze(frame, { kind: 'voronoiGeometry', atomIndex: 73 });
    assert.equal(geometry.workerCount, 1);
    assert.equal(geometry.indexReused, true);
    assert.equal(geometry.frameUploaded, false);
    assert.equal(geometry.atomIndex, 73);
    assert.equal(stats.created, 1, 'a 432-atom frame and single selected cell use the same budget-sized Worker');
    const oldVertices = geometry.vertices.slice();
    frame.fractional[73 * 3] += .007;
    frame.cell.origin[0] += 11;
    const updated = await pool.analyze(frame, { kind: 'voronoi' });
    const direct = await calculateVoronoi(frame);
    assert.equal(updated.indexBuilds, 1);
    assert.equal(updated.frameUploads, 1);
    for (const field of ['atomicVolume', 'faceAreas', 'faceOrders', 'faceNeighbors']) assert.deepEqual(updated[field], direct[field], field);
    const moved = await pool.analyze(frame, { kind: 'voronoiGeometry', atomIndex: 73 });
    assert.equal(moved.indexReused, true);
    assert.notDeepEqual(moved.vertices, oldVertices, 'mutating the source cannot reuse the previous atom cell');
    assert.ok(moved.center[0] > geometry.center[0] + 10);
    pool.clearVoronoiFrames();
    const released = await pool.analyze(frame, { kind: 'voronoiGeometry', atomIndex: 73 });
    assert.equal(released.indexReused, false, 'clearing a source releases resident coordinate/index arrays');
    assert.equal(released.kernelReused, true, 'source release retains the native module and growing cell buffers');
    assert.equal(stats.created, 1);
  } finally { pool.close(); }
});

test('with GPU acceleration on, Voronoi is routed to the CPU pool and returns exactly the GPU-off result', async () => {
  const stats = { created: 0 }, gpuCalls = [];
  const pool = new AnalysisPool({ environment: { crossOriginIsolated: true }, workerFactory: nodeFactory(stats),
    gpuBackend: { supports: kind => kind === 'voronoi', close() {},
      async analyze(_frame, parameters) { gpuCalls.push(parameters.kind); throw new Error('The GPU must not be asked.'); } } });
  const frame = crystalFrame('bcc', 4), radii = Float64Array.from(frame.types, (_, atom) => 1 + (atom % 3) * .2);
  frame.fractional[5] += .004;
  // Typed arrays and derived statistics; timings and reuse counters differ between runs.
  const scientific = result => Object.fromEntries(Object.entries(result).filter(([name, value]) => ArrayBuffer.isView(value)
    || ['voronoiIndices', 'summary', 'statistics', 'coordinationHistogram', 'volumeHistogram', 'faceAreaHistogram', 'indexCounts', 'tessellation', 'atomIndex'].includes(name))
    .concat(result.cells ? [['cells', result.cells.map(scientific)]] : []));
  try {
    const off = {};
    for (const [name, parameters] of [['standard', { kind: 'voronoi' }], ['radical', { kind: 'voronoi', radii }],
      ['filtered', { kind: 'voronoi', faceAreaThreshold: .01, relativeFaceAreaThreshold: .005, bins: 17 }], ['geometry', { kind: 'voronoiGeometry', atomIndex: 7 }],
      ['batch', { kind: 'voronoiGeometryBatch', atomIndices: null }]]) off[name] = [parameters, await pool.analyze(frame, parameters)];
    assert.equal(off.standard[1].gpuRequested, false); assert.equal(off.standard[1].routeReason, undefined);
    pool.setGpuEnabled(true);
    assert.equal(pool.gpuVoronoi, false, 'the GPU Voronoi kernel is off unless requested');
    for (const [name, [parameters, expected]] of Object.entries(off)) {
      const progress = [], result = await pool.analyze(frame, parameters, { onProgress: update => progress.push(update) });
      assert.equal(result.backend, 'cpu', name); assert.equal(result.gpuRequested, true);
      assert.equal(result.fallbackReason, undefined, 'routing to the CPU is not a fallback');
      assert.equal(result.routeReason, VORONOI_CPU_ROUTE_REASON);
      assert.equal(result.engine, expected.engine); assert.equal(result.sharedMemory, true);
      assert.ok(progress.length > 0 && progress.every(update => update.backend === 'cpu' && update.fallbackReason === undefined));
      assert.deepEqual(scientific(result), scientific(expected), `${name}: identical to the result with GPU acceleration off`);
      for (const [field, value] of Object.entries(scientific(expected))) if (ArrayBuffer.isView(value)) {
        assert.equal(result[field].constructor, value.constructor);
        assert.ok(value.every((entry, index) => Object.is(entry, result[field][index])), `${name}.${field} is bit-identical`);
      }
    }
    assert.deepEqual(gpuCalls, []);
    assert.ok(off.standard[1].voronoiCoordination.length === frame.types.length && Math.abs(off.standard[1].summary.volumeError) < 1e-12);
  } finally { pool.close(); }
});

test('the explicit option sends Voronoi to the GPU kernel, with the CPU pool as its fallback', async () => {
  const stats = { created: 0 }, gpuCalls = [];
  let fail = false, releases = 0;
  const pool = new AnalysisPool({ environment: { crossOriginIsolated: true }, workerFactory: nodeFactory(stats),
    gpuBackend: { supports: kind => kind === 'voronoi', close() {}, async releaseVoronoi() { releases++; },
      async analyze(_frame, parameters) {
        gpuCalls.push(parameters.kind);
        if (fail) throw new Error('Too many Voronoi cells need exact recovery; using parallel CPU workers.');
        return { engine: 'webgpu-voronoi', atomicVolume: new Float32Array(1) };
      } } });
  const frame = crystalFrame('bcc', 3);
  try {
    pool.setGpuVoronoi(true);
    const off = await pool.analyze(frame, { kind: 'voronoi' });
    assert.equal(off.backend, 'cpu'); assert.equal(off.gpuRequested, false); assert.equal(off.routeReason, undefined);
    assert.deepEqual(gpuCalls, [], 'the request has no effect while GPU acceleration is off');
    pool.setGpuEnabled(true);
    const gpu = await pool.analyze(frame, { kind: 'voronoi' });
    assert.equal(gpu.backend, 'gpu'); assert.equal(gpu.engine, 'webgpu-voronoi'); assert.equal(gpu.routeReason, undefined);
    fail = true;
    const fallback = await pool.analyze(frame, { kind: 'voronoi' });
    assert.equal(fallback.backend, 'cpu'); assert.match(fallback.fallbackReason, /exact recovery/); assert.equal(fallback.routeReason, undefined);
    assert.ok(fallback.voronoiCoordination.every(value => value === 14));
    // Cell geometry has no GPU kernel under either setting.
    const geometry = await pool.analyze(frame, { kind: 'voronoiGeometry', atomIndex: 3 });
    assert.equal(geometry.backend, 'cpu'); assert.match(geometry.fallbackReason, /no GPU kernel/);
    assert.deepEqual(gpuCalls, ['voronoi', 'voronoi']);
    assert.equal(releases, 0);
    pool.setGpuVoronoi(false); pool.setGpuVoronoi(false);
    assert.equal(releases, 1, 'withdrawing the request frees the GPU Voronoi workspace once');
    const routed = await pool.analyze(frame, { kind: 'voronoi' });
    assert.equal(routed.backend, 'cpu'); assert.equal(routed.fallbackReason, undefined); assert.equal(gpuCalls.length, 2);
    assert.deepEqual(routed.atomicVolume, fallback.atomicVolume);
  } finally { pool.close(); }
});
