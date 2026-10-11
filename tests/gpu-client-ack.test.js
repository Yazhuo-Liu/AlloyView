import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { crystalFrame } from './helpers/crystals.js';

class WorkerFixture {
  constructor() { this.listeners = new Map(); this.messages = []; this.terminated = false; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  postMessage(data, transfer = []) { this.messages.push(structuredClone(data, { transfer })); }
  terminate() { this.terminated = true; }
  answer(message, extras = {}) {
    this.emit({ id: message.id, ok: true, result: { engine: 'webgpu' },
      cachedFrameIds: [...new Set([message.frameId, message.referenceFrameId].filter(Number.isInteger))], ...extras });
  }
  emit(data) { this.listeners.get('message')({ data }); }
  analyses() { return this.messages.filter(message => message.type === 'analyze'); }
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('GPU task was not dispatched.');
}
function fixture() {
  const worker = new WorkerFixture();
  const client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  const frame = crystalFrame('fcc', 1), count = frame.ids.length;
  const fit = { structures: new Uint8Array(count).fill(1), scales: new Float64Array(count).fill(2.8),
    deformation: new Float64Array(count * 9).fill(1) };
  return { worker, client, frame, fit };
}
async function resident(client, worker, frame) {
  const job = client.analyze(frame, { kind: 'bonds', cutoff: 3 });
  await until(() => worker.analyses().length === 1);
  const message = worker.analyses()[0]; worker.answer(message); await job;
  return message.frameId;
}
const ackFit = (worker, message, extras = {}) => worker.answer(message,
  { cachedPtmFits: [{ frameId: message.frameId, fitId: message.parameters.ptmFitId }], ...extras });

test('a cancelled warmup ACK preserves the raw PTM upload posted behind it until its own ACK', async () => {
  const { worker, client, frame, fit } = fixture();
  try {
    const frameId = await resident(client, worker, frame);
    const background = client.warmup({ analysisKinds: ['voronoi'] });
    const backgroundRejected = assert.rejects(background, { name: 'AbortError' });
    await until(() => worker.messages.at(-1).type === 'warmup');
    const warmup = worker.messages.at(-1);
    const first = client.analyze(frame, { kind: 'strain', ptmInput: fit });
    await until(() => worker.analyses().length === 2); await backgroundRejected;
    const posted = worker.analyses()[1];
    assert.ok(posted.parameters.ptmInput); assert.equal(posted.frame, undefined);
    const source = client.ptmSources.get(frameId);
    worker.answer(warmup, { ok: false, name: 'AbortError', error: 'Cancelled.', cachedFrameIds: [frameId], cachedPtmFits: [] });
    assert.strictEqual(client.ptmSources.get(frameId), source);
    assert.equal(client.cachedPtmFits.size, 0, 'a posted upload is not an acknowledgement');
    ackFit(worker, posted); await first;
    const edited = client.analyze(frame, { kind: 'strain', ptmInput: { ...fit }, references: [{ a: 3.4 }] });
    await until(() => worker.analyses().length === 3);
    const latest = worker.analyses()[2];
    assert.equal(latest.parameters.ptmFitId, posted.parameters.ptmFitId);
    assert.equal(latest.parameters.ptmInput, undefined); assert.equal(latest.parameters.ptmTypes, undefined);
    ackFit(worker, latest); await edited;
    assert.ok(fit.structures.byteLength && fit.scales.byteLength && fit.deformation.byteLength);
    const barrier = client.clearFrames();
    await until(() => worker.messages.at(-1).type === 'clear-frames');
    worker.answer(worker.messages.at(-1)); await barrier;
    assert.equal(client.ptmSources.size, 0); assert.equal(client.cachedPtmFits.size, 0);
  } finally { client.close(); }
});

test('an older fit ACK cannot delete a replacement posted in the second GPU slot', async () => {
  const { worker, client, frame, fit } = fixture();
  try {
    const frameId = await resident(client, worker, frame);
    const first = client.analyze(frame, { kind: 'strain', ptmInput: fit });
    await until(() => worker.analyses().length === 2);
    const changed = { ...fit, deformation: fit.deformation.slice() };
    const second = client.analyze(frame, { kind: 'strain', ptmInput: changed });
    await until(() => worker.analyses().length === 3);
    const initial = worker.analyses()[1], replacement = worker.analyses()[2];
    assert.notEqual(initial.parameters.ptmFitId, replacement.parameters.ptmFitId);
    ackFit(worker, initial); await first;
    assert.equal(client.ptmSources.get(frameId).id, replacement.parameters.ptmFitId);
    assert.equal(client.cachedPtmFits.get(frameId), initial.parameters.ptmFitId);
    ackFit(worker, replacement); await second;
    const edited = client.analyze(frame, { kind: 'strain', ptmInput: changed, references: [{ a: 3.4 }] });
    await until(() => worker.analyses().length === 4);
    const latest = worker.analyses()[3];
    assert.equal(latest.parameters.ptmFitId, replacement.parameters.ptmFitId);
    assert.equal(latest.parameters.ptmInput, undefined);
    ackFit(worker, latest); await edited;
  } finally { client.close(); }
});

test('cancelled provisional fit ownership cannot survive a late ACK or omit the next upload', async () => {
  const { worker, client, frame, fit } = fixture();
  try {
    const frameId = await resident(client, worker, frame), controller = new AbortController();
    const first = client.analyze(frame, { kind: 'strain', ptmInput: fit }, { signal: controller.signal });
    const rejected = assert.rejects(first, { name: 'AbortError' });
    await until(() => worker.analyses().length === 2);
    const posted = worker.analyses()[1]; controller.abort(); await rejected;
    assert.equal(client.ptmSources.size, 0);
    // Even a success received after caller cancellation cannot reconstruct the
    // cancelled source descriptor or authorize dropping a subsequent payload.
    ackFit(worker, posted);
    assert.equal(client.cachedPtmFits.get(frameId), posted.parameters.ptmFitId);
    const retry = client.analyze(frame, { kind: 'strain', ptmInput: fit });
    await until(() => worker.analyses().length === 3);
    assert.ok(worker.analyses()[2].parameters.ptmInput);
    ackFit(worker, worker.analyses()[2]); await retry;
  } finally { client.close(); }
});

function displacement(frame, positions = Float64Array.from(frame.positions)) {
  return { kind: 'displacement', minimumImage: true, referenceFrame: frame, referenceCell: frame.cell,
    referenceFractional: frame.fractional, referenceMapping: Int32Array.from(frame.ids, (_, atom) => atom),
    currentPositions: positions, referencePositions: positions };
}
const ackPositions = (worker, message, extras = {}) => worker.answer(message, { cachedCartesianFrames: [
  { frameId: message.frameId, variants: ['cartesian'] }], ...extras });

test('a stale warmup ACK preserves posted Cartesian sources and only the upload ACK enables reuse', async () => {
  const { worker, client, frame } = fixture();
  try {
    const frameId = await resident(client, worker, frame), parameters = displacement(frame);
    const background = client.warmup({ analysisKinds: ['voronoi'] });
    const rejected = assert.rejects(background, { name: 'AbortError' });
    await until(() => worker.messages.at(-1).type === 'warmup');
    const warmup = worker.messages.at(-1);
    const first = client.analyze(frame, parameters);
    await until(() => worker.analyses().length === 2); await rejected;
    const posted = worker.analyses()[1];
    worker.answer(warmup, { ok: false, name: 'AbortError', error: 'Cancelled.', cachedFrameIds: [frameId], cachedCartesianFrames: [] });
    assert.strictEqual(client.positionSources.get(frameId).get('cartesian'), parameters.currentPositions);
    assert.equal(client.cachedCartesianFrames.size, 0);
    ackPositions(worker, posted); await first;
    const second = client.analyze(frame, parameters);
    await until(() => worker.analyses().length === 3);
    const latest = worker.analyses()[2];
    assert.equal(latest.parameters.currentPositions, undefined); assert.equal(latest.parameters.referencePositions, undefined);
    ackPositions(worker, latest); await second;
    assert.equal(parameters.currentPositions.byteLength, frame.ids.length * 24);
  } finally { client.close(); }
});

test('an old Cartesian variant ACK never acknowledges a later replacement source', async () => {
  const { worker, client, frame } = fixture();
  try {
    await resident(client, worker, frame);
    const original = displacement(frame), changed = displacement(frame, Float64Array.from(frame.positions, value => value + .01));
    const first = client.analyze(frame, original);
    await until(() => worker.analyses().length === 2);
    const second = client.analyze(frame, changed);
    await until(() => worker.analyses().length === 3);
    ackPositions(worker, worker.analyses()[1]); await first;
    const third = client.analyze(frame, changed);
    await until(() => worker.analyses().length === 4);
    const retry = worker.analyses()[3];
    assert.ok(retry.parameters.currentPositions, 'the earlier variant ACK describes the original coordinates');
    ackPositions(worker, worker.analyses()[2]); await second;
    ackPositions(worker, retry); await third;
    const final = client.analyze(frame, changed);
    await until(() => worker.analyses().length === 5);
    assert.equal(worker.analyses()[4].parameters.currentPositions, undefined);
    ackPositions(worker, worker.analyses()[4]); await final;
  } finally { client.close(); }
});

test('GPU progress callback errors reject promptly, keep the posted lease until ACK, and never retry on CPU', async () => {
  const { worker, client, frame } = fixture();
  const pool = new AnalysisPool({ gpuBackend: client }); pool.setGpuEnabled(true);
  let cpuCalls = 0;
  pool.analyzeCPU = async () => { cpuCalls++; throw new Error('Unexpected CPU fallback'); };
  const callbackError = new Error('The caller progress handler failed');
  try {
    await resident(client, worker, frame);
    const first = pool.analyze(frame, { kind: 'coordination', cutoff: 3 }, { onProgress: progress => {
      if (progress.phase === 'analyzing') throw callbackError;
    } });
    const rejected = assert.rejects(first, error => error === callbackError);
    await until(() => worker.analyses().length === 2);
    const next = client.analyze(frame, { kind: 'coordination', cutoff: 3 });
    await until(() => worker.analyses().length === 3);
    const failed = worker.analyses()[1], queued = worker.analyses()[2];
    assert.doesNotThrow(() => worker.emit({ id: failed.id, progress: { phase: 'analyzing', completedAtoms: 1, totalAtoms: 4 } }));
    await rejected;
    assert.equal(cpuCalls, 0); assert.equal(worker.terminated, false);
    assert.equal(client.active.length, 2, 'the cancelled calculation remains posted until its Worker ACK');
    assert.ok(worker.messages.some(message => message.type === 'cancel' && message.id === failed.id));
    assert.doesNotThrow(() => worker.emit({ id: failed.id, progress: { phase: 'analyzing', completedAtoms: 2, totalAtoms: 4 } }));
    worker.answer(failed, { ok: false, name: 'AbortError', error: 'Cancelled.' });
    assert.equal(client.active.length, 1);
    worker.answer(queued); await next;
    assert.equal(client.active.length, 0); assert.equal(client.pending.size, 0);
    assert.equal(client.worker, worker);
  } finally { pool.close(); }
});
