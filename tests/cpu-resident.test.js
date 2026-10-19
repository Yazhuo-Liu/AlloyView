import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { calculateCna } from '../src/analysis/cna.js';
import { calculateCentrosymmetry } from '../src/analysis/centrosymmetry.js';
import { crystalFrame } from './helpers/crystals.js';

function poolFor(sharedMemory, concurrency = 4, memory, { onReply } = {}) {
  const messages = [], dispatches = [], replies = [], stats = { created: 0, terminated: 0 };
  const pool = new AnalysisPool({ environment: { crossOriginIsolated: sharedMemory,
    navigator: { hardwareConcurrency: concurrency }, performance: memory ? { memory: { jsHeapSizeLimit: memory } } : {} },
  workerFactory() {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url)), workerId = stats.created++;
    const requests = new Map();
    return { workerId, addEventListener(name, callback) { worker.on(name, value => {
      if (name !== 'message') { callback(value); return; }
      const deliver = () => callback({ data: value });
      if (value.phase) { deliver(); return; }
      const request = requests.get(value.id); requests.delete(value.id);
      replies.push({ ...request, ok: value.ok, frameUploaded: value.result?.frameUploaded, indexBuilt: value.result?.indexBuilt });
      if (onReply) onReply({ workerId, request, data: value, deliver }); else deliver();
    }); },
      postMessage(data, transfer) {
        const request = { workerId, id: data.id, kind: data.kind, frameKey: data.cpuFrameKey,
          uploaded: data.fractional !== undefined, startAtom: data.startAtom, endAtom: data.endAtom };
        requests.set(data.id, request); dispatches.push(request);
        messages.push(data); worker.postMessage(data, transfer);
      },
      terminate() { stats.terminated++; worker.terminate(); } };
  } });
  return { pool, messages, dispatches, replies, stats };
}

function residentFrames(pool) {
  return new Map([...pool.slots].map(slot => [slot.worker.workerId, new Set(slot.cpuFrameKeys)]));
}

function assertResidentReuse({ dispatches, replies }, result, before = new Map()) {
  const chunks = dispatches.filter(request => request.frameKey === result.frameKey);
  assert.equal(chunks.length, result.chunkCount, 'every chunk is accounted for in the transport trace');
  const visited = new Set();
  let uploads = 0;
  for (const chunk of chunks) {
    const resident = before.get(chunk.workerId)?.has(result.frameKey) || visited.has(chunk.workerId);
    assert.equal(chunk.uploaded, !resident,
      `Worker ${chunk.workerId}, frame ${result.frameKey}: only its first nonresident chunk uploads coordinates`);
    visited.add(chunk.workerId);
    uploads += Number(!resident);
  }
  const completed = replies.filter(reply => reply.frameKey === result.frameKey);
  assert.equal(completed.length, chunks.length);
  assert.ok(completed.every(reply => reply.ok), 'all observed chunks completed on real Workers');
  assert.equal(completed.filter(reply => reply.frameUploaded).length, uploads, 'Worker ACKs confirm the actual uploads');
  assert.equal(completed.filter(reply => reply.indexBuilt).length, result.indexBuilds, 'Worker ACKs confirm the index builds');
  assert.equal(result.frameUploads, uploads);
  assert.equal(result.indexBuilds, result.sharedMemory ? 0 : uploads);
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
  const { pool, dispatches, replies, stats } = poolFor(sharedMemory), frames = [crystalFrame('fcc', 11), crystalFrame('bcc', 14)];
  try {
    const first = await Promise.all(frames.map(frame => pool.analyzeCPU(frame, { kind: 'cna' })));
    for (let index = 0; index < first.length; index++) {
      assert.ok(first[index].indexBuilds <= (sharedMemory ? 1 : first[index].workerCount));
      assert.deepEqual(first[index].structures, calculateCna(frames[index]).structures);
    }
    // Concurrent jobs need not visit every slot. A later job may legitimately
    // upload once to a slot that has only seen the other frame so far.
    const before = residentFrames(pool), posted = dispatches.length, completed = replies.length, created = stats.created;
    const repeated = await Promise.all(frames.map(frame => pool.analyzeCPU(frame, { kind: 'centrosymmetry', neighbors: 12 })));
    for (let index = 0; index < repeated.length; index++) {
      assertResidentReuse({ dispatches: dispatches.slice(posted), replies: replies.slice(completed) }, repeated[index], before);
      assert.deepEqual(repeated[index].centrosymmetry, calculateCentrosymmetry(frames[index]).centrosymmetry);
    }
    assert.equal(stats.created, created); assert.equal(stats.terminated, 0);
  } finally { pool.close(); }
});

test('a delayed real Worker ACK exercises one necessary cold-slot upload without repeated uploads', { timeout: 30_000 }, async () => {
  const frames = [crystalFrame('fcc', 11), crystalFrame('bcc', 14)];
  const totalAtoms = frames.reduce((sum, frame) => sum + frame.fractional.length / 3, 0);
  let phase = 'first', firstHeld, repeatHeld, completedAtoms = 0, otherKey, coldUploadObserved = false;
  const { pool, dispatches, replies, stats } = poolFor(false, 4, undefined, { onReply(reply) {
    const { request, deliver } = reply;
    if (phase === 'first' && request?.kind === 'cna') {
      completedAtoms += request.endAtom - request.startAtom;
      // Let the other real Worker consume both jobs while this slot remains
      // leased to its first chunk. Only delivery of the ACK is delayed.
      if (reply.workerId === 0 && !firstHeld) firstHeld = reply;
      else deliver();
      if (completedAtoms === totalAtoms) firstHeld.deliver();
      return;
    }
    if (phase === 'repeat' && request?.kind === 'centrosymmetry') {
      // Keep the slot that already knows both frames busy. The other slot
      // must receive its first upload of the second frame before it is freed.
      if (reply.workerId !== firstHeld.workerId && !repeatHeld) {
        repeatHeld = reply;
        if (coldUploadObserved) deliver();
        return;
      }
      deliver();
      if (reply.workerId === firstHeld.workerId && request.frameKey === otherKey && !coldUploadObserved) {
        coldUploadObserved = true; repeatHeld?.deliver();
      }
      return;
    }
    deliver();
  } });
  try {
    const first = await Promise.all(frames.map(frame => pool.analyzeCPU(frame, { kind: 'cna' })));
    assert.equal(stats.created, 2);
    const heldIndex = first.findIndex(result => result.frameKey === firstHeld.request.frameKey), otherIndex = 1 - heldIndex;
    otherKey = first[otherIndex].frameKey;
    const before = residentFrames(pool);
    assert.deepEqual([...before.get(firstHeld.workerId)], [first[heldIndex].frameKey], 'the delayed slot has only visited one frame');
    assert.ok([...before].filter(([id]) => id !== firstHeld.workerId).every(([, keys]) => keys.size === 2));
    phase = 'repeat';
    const posted = dispatches.length, completed = replies.length;
    const repeated = await Promise.all([heldIndex, otherIndex].map(index => pool.analyzeCPU(frames[index], { kind: 'centrosymmetry', neighbors: 12 })));
    assert.ok(coldUploadObserved, 'the controlled schedule really exercised the previously unseen slot/frame pair');
    assert.equal(repeated[0].frameUploads, 0);
    assert.equal(repeated[1].frameUploads, 1, 'only the newly visited slot needs an upload');
    for (let index = 0; index < repeated.length; index++) {
      assertResidentReuse({ dispatches: dispatches.slice(posted), replies: replies.slice(completed) }, repeated[index], before);
      assert.deepEqual(repeated[index].centrosymmetry, calculateCentrosymmetry(frames[[heldIndex, otherIndex][index]]).centrosymmetry);
    }
    assert.equal(stats.created, 2); assert.equal(stats.terminated, 0);
  } finally { pool.close(); }
});
