import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';
import { analysisValidationError, fatalAnalysisError } from '../src/analysis/errors.js';
import { analyzeGpuReferenceStrain } from '../src/analysis/gpu/reference-strain.js';
import { crystalFrame } from './helpers/crystals.js';

function nodeFactory(stats) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    stats.created++; stats.active++;
    return { addEventListener(name, callback) { worker.on(name, data => callback(name === 'message' ? { data } : data)); },
      postMessage(data, transfer) { worker.postMessage(data, transfer); },
      terminate() { stats.active--; worker.terminate(); } };
  };
}

test('preflight RDF errors and controlled Voronoi geometry errors preserve a real warm PTM Worker and heap', async () => {
  const stats = { created: 0, active: 0 }, frame = crystalFrame('fcc', 2);
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 3 } }, workerFactory: nodeFactory(stats) });
  try {
    const first = await pool.analyze(frame, { kind: 'ptm' });
    assert.equal(first.kernelInitializations, 1);
    const slot = [...pool.slots][0], heap = slot.moduleHeapBytes.ptm;
    const open = { ...frame, cell: { ...frame.cell, pbc: [true, true, false] } };
    await assert.rejects(pool.analyze(open, { kind: 'rdf', cutoff: 2 }), error =>
      error.analysisErrorKind === 'validation' && /periodic boundaries/.test(error.message));
    assert.equal(stats.created, 1); assert.equal(stats.active, 1);
    // This is a data-dependent scientific failure, after native Voro++ was
    // entered; a public schema check cannot recognize coincident sites.
    const coincident = { ...frame, fractional: frame.fractional.slice() };
    coincident.fractional.set(coincident.fractional.subarray(0, 3), 3);
    await assert.rejects(pool.analyze(coincident, { kind: 'voronoi' }), /coincident/);
    assert.equal(stats.active, 1); assert.ok(pool.slots.has(slot));
    assert.equal(slot.moduleHeapBytes.ptm, heap);
    const anotherRejectedFrame = { ...coincident, fractional: coincident.fractional.slice() };
    await assert.rejects(pool.analyze(anotherRejectedFrame, { kind: 'voronoi' }), /coincident/);
    assert.equal(slot.cpuFrameKeys.has(first.frameKey), false,
      'error ACKs remove a preceding frame evicted while preparing rejected input');
    const recovered = await pool.analyze(frame, { kind: 'ptm' });
    assert.equal(recovered.kernelInitializations, 0);
    assert.deepEqual(recovered.structures, first.structures);
    assert.equal(stats.created, 1);
    assert.equal(pool.cpuBudget.active, 0);
  } finally { pool.close(); }
  assert.equal(stats.active, 0);
});

for (const sharedMemory of [false, true]) {
  test(`a scientific range failure preserves all real warm Workers after sibling ACKs (${sharedMemory ? 'shared' : 'private'})`, async () => {
    const stats = { created: 0, active: 0 }, frame = crystalFrame('fcc', 11);
    const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: sharedMemory }, workerFactory: nodeFactory(stats) });
    try {
      const first = await pool.analyze(frame, { kind: 'ptm' });
      assert.equal(first.workerCount, 2); assert.equal(first.kernelInitializations, 2);
      const created = stats.created, slots = [...pool.slots];
      const coincident = { ...frame, fractional: frame.fractional.slice() };
      coincident.fractional.set(coincident.fractional.subarray(0, 3), 3);
      await assert.rejects(pool.analyze(coincident, { kind: 'voronoi' }), /coincident/);
      // An error rejects promptly, while bounded sibling chunks keep their
      // leases until ACK. Following work waits and reuses those same slots.
      const recovered = await pool.analyze(frame, { kind: 'ptm' });
      assert.equal(recovered.kernelInitializations, 0); assert.deepEqual(recovered.structures, first.structures);
      assert.equal(stats.created, created); assert.equal(stats.active, created);
      assert.ok(slots.every(slot => pool.slots.has(slot))); assert.equal(pool.cpuBudget.active, 0);
    } finally { pool.close(); }
  });
}

class ReplyWorker {
  constructor() { this.listeners = new Map(); this.messages = []; this.terminated = false; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(type, data) { this.listeners.get(type)?.(type === 'message' ? { data } : data); }
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error('Timed out waiting for Worker dispatch.');
}

for (const failure of ['fatal-reply', 'error', 'messageerror', 'legacy-reply']) {
  test(`${failure} retires its damaged CPU Worker and releases its lease for the next job`, async () => {
    const workers = [], pool = new AnalysisPool({ workerFactory: () => { const worker = new ReplyWorker(); workers.push(worker); return worker; } });
    const controller = new AbortController(), frame = crystalFrame('fcc', 1);
    try {
      const task = pool.runTask({ kind: 'unknown', fractional: frame.fractional, cell: frame.cell }, controller.signal);
      const rejected = assert.rejects(task);
      await until(() => workers[0]?.messages.length);
      const worker = workers[0], id = worker.messages[0].id;
      if (failure === 'fatal-reply') worker.emit('message', { id, ok: false, error: 'memory access out of bounds', name: 'RuntimeError', fatal: true });
      else if (failure === 'legacy-reply') worker.emit('message', { id, ok: false, error: 'unclassified failure' });
      else worker.emit(failure, { message: 'Worker transport failed' });
      await rejected;
      assert.equal(worker.terminated, true); assert.equal(pool.slots.size, 0); assert.equal(pool.cpuBudget.active, 0);
      const following = pool.runTask({ kind: 'unknown', fractional: frame.fractional, cell: frame.cell }, controller.signal);
      await until(() => workers[1]?.messages.length);
      workers[1].emit('message', { id: workers[1].messages[0].id, ok: true, result: { recovered: true } });
      assert.deepEqual(await following, { recovered: true });
      assert.equal(pool.idle.length, 1); assert.equal(pool.cpuBudget.active, 0);
    } finally { pool.close(); }
  });
}

test('native traps and internal programming failures are fatal, controlled validation failures are not', () => {
  assert.equal(fatalAnalysisError(new WebAssembly.RuntimeError('memory access out of bounds')), true);
  assert.equal(fatalAnalysisError(new TypeError('internal state is unavailable')), true);
  assert.equal(fatalAnalysisError(new Error('Too many neighbors; reduce the cutoff')), false);
  assert.equal(fatalAnalysisError(analysisValidationError(new TypeError('Malformed parameters'))), false);
});

test('GPU validation rejects once, while backend failures still fall back to the CPU', async () => {
  const calls = { gpu: 0, cpu: 0 }, frame = crystalFrame('fcc', 2);
  const backend = { supports: () => true, close() {}, async analyze() {
    calls.gpu++; throw analysisValidationError(new Error('Invalid supplied analysis input'));
  } };
  const pool = new AnalysisPool({ gpuBackend: backend });
  pool.setGpuEnabled(true);
  pool.analyzeCPU = async () => { calls.cpu++; return {}; };
  try {
    await assert.rejects(pool.analyze(frame, { kind: 'coordination', cutoff: -1 }), /cutoff/);
    assert.deepEqual(calls, { gpu: 0, cpu: 0 });
    const open = { ...frame, cell: { ...frame.cell, pbc: [false, true, true] } };
    await assert.rejects(pool.analyze(open, { kind: 'rdf', cutoff: 2 }), /periodic boundaries/);
    assert.deepEqual(calls, { gpu: 0, cpu: 0 });
    await assert.rejects(pool.analyze(frame, { kind: 'coordination', cutoff: 3 }), /supplied analysis input/);
    assert.deepEqual(calls, { gpu: 1, cpu: 0 });
    backend.analyze = async () => { calls.gpu++; throw new Error('GPU device lost'); };
    assert.equal((await pool.analyze(frame, { kind: 'coordination', cutoff: 3 })).backend, 'cpu');
    assert.deepEqual(calls, { gpu: 2, cpu: 1 });
  } finally { pool.close(); }
});

test('GPU Worker validation classification reaches its client without recreating the Worker', async () => {
  const worker = new ReplyWorker(), client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  const frame = crystalFrame('fcc', 2);
  try {
    const task = client.analyze(frame, { kind: 'coordination', cutoff: -1 });
    const rejection = assert.rejects(task, error => error.analysisErrorKind === 'validation');
    await until(() => worker.messages.length);
    worker.emit('message', { id: worker.messages[0].id, ok: false, error: 'Invalid cutoff', errorKind: 'validation' });
    await rejection;
    assert.equal(client.worker, worker); assert.equal(worker.terminated, false);
  } finally { client.close(); }
});

test('data-dependent GPU reference mapping validation does not launch a redundant CPU calculation', async () => {
  const frame = crystalFrame('fcc', 2), referenceMapping = new Int32Array(frame.types.length);
  const backend = { supports: () => true, close() {}, analyze: (data, parameters, options) => analyzeGpuReferenceStrain({}, data, parameters, options) };
  const pool = new AnalysisPool({ gpuBackend: backend });
  let cpuCalls = 0;
  pool.setGpuEnabled(true); pool.analyzeCPU = async () => { cpuCalls++; return {}; };
  try {
    // The shape and cutoff are valid; all atoms matching one reference site
    // is detected in the GPU Worker's full scientific input validator.
    await assert.rejects(pool.analyze(frame, { kind: 'referenceStrain', cutoff: 3,
      referenceFrame: frame, referenceFractional: frame.fractional, referenceCell: frame.cell, referenceMapping }),
    error => error.analysisErrorKind === 'validation' && /one-to-one/.test(error.message));
    assert.equal(cpuCalls, 0);
  } finally { pool.close(); }
});

test('a GPU correction Wasm trap retires its Worker and rejects every already-posted task', async () => {
  const workers = [], frame = crystalFrame('fcc', 2);
  const client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } },
    workerFactory: () => { const worker = new ReplyWorker(); workers.push(worker); return worker; } });
  try {
    const upload = client.analyze(frame, { kind: 'coordination', cutoff: 3 });
    await until(() => workers[0]?.messages.length);
    workers[0].emit('message', { id: workers[0].messages[0].id, ok: true, result: {}, cachedFrameIds: [workers[0].messages[0].frameId] });
    await upload;
    const running = client.analyze(frame, { kind: 'coordination', cutoff: 3 });
    const postedBehind = client.analyze(frame, { kind: 'coordination', cutoff: 3 });
    const rejected = Promise.all([assert.rejects(running, /memory access/), assert.rejects(postedBehind, /memory access/)]);
    await until(() => workers[0].messages.length === 3);
    workers[0].emit('message', { id: workers[0].messages[1].id, ok: false, fatal: true,
      name: 'RuntimeError', error: 'memory access out of bounds' });
    await rejected;
    assert.equal(workers[0].terminated, true); assert.equal(client.worker, null);
    const following = client.analyze(frame, { kind: 'coordination', cutoff: 3 });
    await until(() => workers[1]?.messages.length);
    assert.ok(workers[1].messages[0].frame, 'the replacement cannot claim the damaged Worker input cache');
    workers[1].emit('message', { id: workers[1].messages[0].id, ok: true, result: {} });
    await following;
  } finally { client.close(); }
});
