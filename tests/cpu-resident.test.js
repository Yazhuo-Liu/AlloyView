import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { calculateCna } from '../src/analysis/cna.js';
import { calculateCentrosymmetry } from '../src/analysis/centrosymmetry.js';
import { crystalFrame } from './helpers/crystals.js';

function poolFor(sharedMemory, concurrency = 4, memory) {
  const messages = [], stats = { created: 0, terminated: 0 };
  const pool = new AnalysisPool({ environment: { crossOriginIsolated: sharedMemory,
    navigator: { hardwareConcurrency: concurrency }, performance: memory ? { memory: { jsHeapSizeLimit: memory } } : {} },
  workerFactory() {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url)); stats.created++;
    return { addEventListener(name, callback) { worker.on(name, value => callback(name === 'message' ? { data: value } : value)); },
      postMessage(data, transfer) { messages.push(data); worker.postMessage(data, transfer); },
      terminate() { stats.terminated++; worker.terminate(); } };
  } });
  return { pool, messages, stats };
}

for (const sharedMemory of [false, true]) {
  test(`ordinary CPU chunks reuse frame/index across CNA and CSP (${sharedMemory ? 'shared' : 'copied'})`, async () => {
    const { pool, messages, stats } = poolFor(sharedMemory);
    const frame = crystalFrame('fcc', 11), original = frame.fractional.slice();
    try {
      const first = await pool.analyzeCPU(frame, { kind: 'cna' });
      assert.equal(first.scheduling, 'dynamic'); assert.ok(first.chunkCount > first.workerCount);
      assert.equal(first.indexBuilds, sharedMemory ? 1 : first.workerCount);
      assert.deepEqual(first.structures, calculateCna(frame).structures);
      const created = stats.created, mark = messages.length;
      const second = await pool.analyzeCPU(frame, { kind: 'centrosymmetry', neighbors: 12 });
      assert.equal(second.frameKey, first.frameKey); assert.equal(second.indexBuilds, 0); assert.equal(second.frameUploads, 0);
      assert.deepEqual(second.centrosymmetry, calculateCentrosymmetry(frame).centrosymmetry);
      assert.equal(stats.created, created);
      for (const message of messages.slice(mark).filter(message => message.cpuFrameKey !== undefined)) {
        assert.equal(message.fractional, undefined, 'resident chunks do not resend coordinates');
        assert.equal(message.cell, undefined, 'resident chunks do not resend the immutable cell');
      }
      if (sharedMemory) {
        const snapshot = pool.cpuSnapshots[0];
        for (const field of ['coordinates', 'heads', 'next']) assert.ok(snapshot.neighborIndex[field].buffer instanceof SharedArrayBuffer);
      }
      assert.deepEqual(frame.fractional, original, 'scientific source arrays stay attached and unchanged');
    } finally { pool.close(); }
  });

  test(`resident snapshots detect coordinate, cell and type mutations (${sharedMemory ? 'shared' : 'copied'})`, async () => {
    const { pool } = poolFor(sharedMemory, 2), frame = crystalFrame('bcc', 3);
    try {
      let previous = await pool.analyzeCPU(frame, { kind: 'cna' });
      for (const mutate of [() => { frame.fractional[0] += .075; },
        () => { frame.cell.vectors[0] *= 1.025; }, () => { frame.types[0] += 1; }]) {
        mutate();
        const result = await pool.analyzeCPU(frame, { kind: 'cna' });
        assert.notEqual(result.frameKey, previous.frameKey);
        assert.deepEqual(result.structures, calculateCna(frame).structures);
        previous = result;
      }
      const mark = previous.frameKey;
      pool.clearVoronoiFrames(); assert.equal(pool.cpuSnapshots.length, 0);
      const reloaded = await pool.analyzeCPU(frame, { kind: 'cna' });
      assert.notEqual(reloaded.frameKey, mark); assert.equal(reloaded.indexBuilds, 1);
    } finally { pool.close(); }
  });

  test(`Voronoi load preparation warms the ordinary CPU index (${sharedMemory ? 'shared' : 'copied'})`, async () => {
    const { pool } = poolFor(sharedMemory, 2), frame = crystalFrame('bcc', 3);
    try {
      await pool.prepareCpuFrame(frame);
      const result = await pool.analyzeCPU(frame, { kind: 'cna' });
      assert.equal(result.indexBuilds, 0); assert.equal(result.frameUploads, 0);
      assert.deepEqual(result.structures, calculateCna(frame).structures);
    } finally { pool.close(); }
  });
}

test('shared neighbor descriptors preserve ordering, self images and private query scratch', () => {
  const frame = crystalFrame('bcc', 1);
  const owner = new NeighborSearch(frame, { sharedMemory: true });
  const reader = NeighborSearch.fromIndex(owner.exportIndex());
  assert.equal(reader.coordinates, owner.coordinates); assert.equal(reader.heads, owner.heads);
  assert.deepEqual(reader.nearest(0, 14), owner.nearest(0, 14));
  assert.notEqual(reader.rangeX, owner.rangeX); assert.notEqual(reader.nearestRadii, owner.nearestRadii);
  assert.throws(() => NeighborSearch.fromIndex({}), /incomplete/);
});

test('isolated PTM warmup counts shared frame/index memory once instead of per Worker', () => {
  const { pool } = poolFor(true, 32, 4 * 1024 ** 3);
  try { assert.equal(pool.cpuModuleWorkerCount(1_000_000, 24_000_000, ['ptm']), 30); }
  finally { pool.close(); }
});

for (const sharedMemory of [false, true]) test(`concurrent different frames retain two indices without chunk thrashing (${sharedMemory ? 'shared' : 'copied'})`, async () => {
  const { pool } = poolFor(sharedMemory), frames = [crystalFrame('fcc', 11), crystalFrame('bcc', 14)];
  try {
    const first = await Promise.all(frames.map(frame => pool.analyzeCPU(frame, { kind: 'cna' })));
    for (let index = 0; index < first.length; index++) {
      assert.ok(first[index].indexBuilds <= (sharedMemory ? 1 : first[index].workerCount));
      assert.deepEqual(first[index].structures, calculateCna(frames[index]).structures);
    }
    const repeated = await Promise.all(frames.map(frame => pool.analyzeCPU(frame, { kind: 'centrosymmetry', neighbors: 12 })));
    for (let index = 0; index < repeated.length; index++) {
      assert.equal(repeated[index].indexBuilds, 0); assert.equal(repeated[index].frameUploads, 0);
      assert.deepEqual(repeated[index].centrosymmetry, calculateCentrosymmetry(frames[index]).centrosymmetry);
    }
  } finally { pool.close(); }
});
