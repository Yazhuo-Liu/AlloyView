import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { AnalysisPool, VORONOI_CPU_ROUTE_REASON } from '../src/analysis/analysis-pool.js';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';
import { prepareDisplacements, calculatePreparedDisplacements } from '../src/analysis/displacement.js';
import { calculateReferenceStrain, createReferenceMapping } from '../src/analysis/reference-strain.js';
import { calculateVoronoi } from '../src/analysis/voronoi.js';
import { calculatePtm } from '../src/analysis/ptm.js';
import { crystalFrame } from './helpers/crystals.js';
import { fakeGpu } from './helpers/fake-gpu.js';

// The real GPU worker module runs in this thread on a device whose shaders
// never execute, so its exact-pair self-test fails. The module registers its
// message listener on `self` at import; the client talks to it through a
// Worker-shaped bridge, and CPU fallbacks use real analysis workers.
const fake = fakeGpu(), replies = new Set();
let deliver;
Object.defineProperty(globalThis, 'navigator', { value: { gpu: fake.gpu }, configurable: true });
globalThis.self = { addEventListener(type, listener) { if (type === 'message') deliver = listener; },
  postMessage(data) { for (const listener of replies) listener({ data }); } };
await import('../src/analysis/gpu/worker.js');

function pools() {
  const client = new GpuAnalysisClient({ environment: { navigator: { gpu: fake.gpu } }, workerFactory: () => ({
    addEventListener(type, listener) { if (type === 'message') replies.add(listener); },
    postMessage(data) { deliver({ data }); }, terminate() { replies.clear(); } }) });
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4, gpu: fake.gpu } }, gpuBackend: client, workerFactory: () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfer) { worker.postMessage(data, transfer); }, terminate() { worker.terminate(); } };
  } });
  pool.setGpuEnabled(true);
  return { pool, client };
}
const uploads = () => fake.log.filter(entry => entry.type === 'write').length;
const REASON = /shader compiler of this GPU does not preserve exact double-float arithmetic; using CPU workers/;

test('a device that fails the exact-pair self-test sends every pair kernel to CPU workers and keeps the others on the GPU', async () => {
  const { pool, client } = pools(), frame = crystalFrame('fcc', 3);
  const moved = { ...frame, ids: frame.ids.slice(), fractional: frame.fractional.slice(), positions: Float64Array.from(frame.positions, value => value + .125) };
  try {
    const coordination = await pool.analyze(frame, { kind: 'coordination', cutoff: 3 }, { frameIndex: 0 });
    assert.equal(coordination.backend, 'gpu'); assert.equal(coordination.fallbackReason, undefined);
    assert.equal(pool.gpuCacheStatus.exactPairs, false, 'the self-test result is part of the GPU status');
    const resident = [...client.cachedFrameIds], written = uploads();

    const displacementParameters = { kind: 'displacement', ...await prepareDisplacements(moved, frame) };
    const displacement = await pool.analyze(moved, displacementParameters);
    assert.equal(displacement.backend, 'cpu'); assert.match(displacement.fallbackReason, REASON);
    assert.deepEqual(displacement.vectors, calculatePreparedDisplacements(moved, displacementParameters).vectors);

    const referenceParameters = { kind: 'referenceStrain', cutoff: 3.1, referenceFrame: frame, referenceFractional: frame.fractional,
      referenceCell: frame.cell, referenceMapping: createReferenceMapping(moved, frame) };
    const reference = await pool.analyze(moved, referenceParameters);
    assert.equal(reference.backend, 'cpu'); assert.match(reference.fallbackReason, REASON);
    assert.deepEqual(reference.referenceShearStrain, calculateReferenceStrain(moved, referenceParameters).referenceShearStrain);

    // Automatic selection never asks the device for Voronoi; the explicit
    // WebGPU kernel request does, and is refused by the self-test.
    const routed = await pool.analyze(frame, { kind: 'voronoi' }, { frameIndex: 0 });
    assert.equal(routed.backend, 'cpu'); assert.equal(routed.fallbackReason, undefined); assert.equal(routed.routeReason, VORONOI_CPU_ROUTE_REASON);
    pool.setGpuVoronoi(true);
    const voronoi = await pool.analyze(frame, { kind: 'voronoi' }, { frameIndex: 0 });
    assert.equal(voronoi.backend, 'cpu'); assert.match(voronoi.fallbackReason, REASON); assert.equal(voronoi.routeReason, undefined);
    assert.deepEqual(voronoi.voronoiIndices, (await calculateVoronoi(frame)).voronoiIndices);
    assert.deepEqual(routed.voronoiIndices, voronoi.voronoiIndices);

    const strain = await pool.analyze(frame, { kind: 'strain', references: [{ structure: 1, a: 4 }], ptmInput: await calculatePtm(frame) }, { frameIndex: 0 });
    assert.equal(strain.backend, 'cpu'); assert.equal(strain.tensorBackend, 'cpu'); assert.match(strain.fallbackReason, REASON);
    assert.ok(strain.atomicShearStrain.every(value => value === 0));

    assert.equal(uploads(), written, 'refused kernels upload nothing');
    assert.deepEqual([...client.cachedFrameIds], resident, 'and retain no input in the GPU worker');
    const again = await pool.analyze(frame, { kind: 'coordination', cutoff: 3 }, { frameIndex: 0 });
    assert.equal(again.backend, 'gpu'); assert.equal(again.gpuInputReused, true);
  } finally { pool.close(); }
});

test('GPU preparation on such a device keeps the frame resident without Voronoi pipelines or workspace', async () => {
  const { pool } = pools(), frame = crystalFrame('fcc', 2);
  try {
    pool.associateGpuFrame(frame, 0);
    await pool.warmupGpu({ analysisKinds: ['voronoi'] });
    await pool.configureGpuCache({ frameCount: 1, currentIndex: 0 });
    const prepared = await pool.prepareGpuFrame(frame, { frameIndex: 0, analysisKinds: ['voronoi'] });
    assert.equal(prepared.exactPairs, false);
    assert.deepEqual(prepared.cachedFrameIndexes, [0]); assert.deepEqual(prepared.preparedVoronoiFrameIndexes, []);
    assert.equal(prepared.voronoiWorkspaceAtoms, 0);
    const warmed = await pool.warmupGpu();
    assert.equal(warmed.pipelineCount, 18, 'the general warmup compiles the 18 kernels that can run');
  } finally { pool.close(); }
});
