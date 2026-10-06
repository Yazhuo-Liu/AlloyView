import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
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

test('Voronoi uses shared CPU workers when GPU is enabled and reports the deliberate fallback', async () => {
  const stats = { created: 0 };
  const pool = new AnalysisPool({ environment: { crossOriginIsolated: true }, workerFactory: nodeFactory(stats),
    gpuBackend: { supports: () => false, close() {} } });
  pool.setGpuEnabled(true);
  try {
    const result = await pool.analyze(crystalFrame('bcc', 3), { kind: 'voronoi' });
    assert.equal(result.backend, 'cpu');
    assert.equal(result.gpuRequested, true);
    assert.equal(result.sharedMemory, true);
    assert.match(result.fallbackReason, /no GPU kernel/);
    assert.ok(result.voronoiCoordination.every(value => value === 14));
    assert.ok(Math.abs(result.summary.volumeError) < 1e-12);
  } finally { pool.close(); }
});
