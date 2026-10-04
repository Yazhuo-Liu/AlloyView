import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';
import { crystalFrame } from './helpers/crystals.js';

class WorkerFixture {
  constructor() { this.listeners = new Map(); this.messages = []; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  postMessage(data, transfer = []) { this.messages.push(structuredClone(data, { transfer })); }
  terminate() {}
  answer(message) { this.listeners.get('message')({ data: { id: message.id, ok: true, result: { engine: 'webgpu' },
    cachedFrameIds: [...new Set([message.frameId, message.referenceFrameId].filter(Number.isInteger))] } }); }
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error('GPU task was not dispatched.');
}

test('cached GPU strain transfers private PTM tensor inputs while retaining frame and complete CPU fit caches', async () => {
  const worker = new WorkerFixture(), client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  const frame = crystalFrame('fcc', 2), count = frame.types.length;
  const ptmInput = { structures: new Uint8Array(count).fill(1), scales: new Float64Array(count).fill(2.823456789),
    deformation: Float64Array.from({ length: count * 9 }, (_, index) => index % 4 ? .00000000314159 : 1),
    rmsd: new Float32Array(count).fill(.01), distances: new Float32Array(count).fill(2.8) };
  const originals = Object.fromEntries(Object.entries(ptmInput).map(([name, values]) => [name, values.slice()]));
  const fractional = frame.fractional.slice();
  try {
    const warm = client.analyze(frame, { kind: 'bonds', cutoff: 3.1 });
    await until(() => worker.messages.length === 1); worker.answer(worker.messages[0]); await warm;
    const strain = client.analyze(frame, { kind: 'strain', ptmInput });
    await until(() => worker.messages.length === 2);
    const message = worker.messages[1];
    assert.equal(message.frame, undefined, 'the GPU frame upload is reused');
    assert.deepEqual(Object.keys(message.parameters.ptmInput), ['structures', 'scales', 'deformation']);
    for (const name of ['structures', 'scales', 'deformation']) {
      assert.equal(message.parameters.ptmInput[name].constructor, ptmInput[name].constructor);
      assert.deepEqual(message.parameters.ptmInput[name], originals[name]);
    }
    for (const [name, values] of Object.entries(ptmInput)) assert.deepEqual(values, originals[name], `${name} is retained for CPU reuse`);
    assert.deepEqual(frame.fractional, fractional);
    worker.answer(message); await strain;
  } finally { client.close(); }
});

test('invalid cached GPU tensor inputs fail dispatch without sending a partial job or detaching the frame', async () => {
  const worker = new WorkerFixture(), client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  const frame = crystalFrame('fcc', 1), original = frame.fractional.slice();
  try {
    await assert.rejects(client.analyze(frame, { kind: 'strain', ptmInput: { structures: new Uint8Array(4), scales: [2, 2, 2, 2] } }), /typed PTM scales/);
    assert.equal(worker.messages.length, 0); assert.deepEqual(frame.fractional, original);
  } finally { client.close(); }
});

test('GPU reference strain privately transfers reference coordinates and mappings, then reuses both resident frames', async () => {
  const worker = new WorkerFixture(), client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  const current = crystalFrame('fcc', 2), reference = crystalFrame('fcc', 2);
  const currentOriginal = current.fractional.slice(), referenceOriginal = reference.fractional.slice();
  const mapping = Int32Array.from({ length: current.ids.length }, (_, index) => index), originalMapping = mapping.slice();
  const parameters = { kind: 'referenceStrain', cutoff: 3.1, referenceFrame: reference, referenceFrameIndex: 0,
    referenceFractional: reference.fractional, referenceCell: reference.cell, referenceMapping: mapping };
  try {
    assert.equal(client.supports('cna'), true);
    assert.equal(client.supports('referenceStrain'), true);
    const first = client.analyze(current, parameters, { frameIndex: 1 });
    await until(() => worker.messages.length === 1);
    const message = worker.messages[0];
    assert.deepEqual(message.frame.fractional, currentOriginal);
    assert.deepEqual(message.referenceFrame.fractional, referenceOriginal);
    assert.deepEqual(message.parameters.referenceMapping, originalMapping);
    assert.equal(message.frameIndex, 1); assert.equal(message.referenceFrameIndex, 0);
    assert.notEqual(message.frameId, message.referenceFrameId);
    assert.equal(message.parameters.referenceFrame, undefined);
    assert.equal(message.parameters.referenceFractional, undefined);
    assert.equal(message.parameters.referenceCell, undefined);
    worker.answer(message); await first;
    const second = client.analyze(current, parameters, { frameIndex: 1 });
    await until(() => worker.messages.length === 2);
    const reused = worker.messages[1];
    assert.equal(reused.frame, undefined); assert.equal(reused.referenceFrame, undefined);
    assert.equal(reused.referenceFrameId, message.referenceFrameId);
    assert.deepEqual(reused.parameters.referenceMapping, originalMapping);
    worker.answer(reused); await second;
    assert.deepEqual(current.fractional, currentOriginal);
    assert.deepEqual(reference.fractional, referenceOriginal);
    assert.deepEqual(mapping, originalMapping);
  } finally { client.close(); }
});

test('legacy reference arrays receive a reusable private frame identity', async () => {
  const worker = new WorkerFixture(), client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  const frame = crystalFrame('fcc', 1), reference = crystalFrame('fcc', 1);
  const referenceMapping = Int32Array.from({ length: frame.ids.length }, (_, index) => index);
  const parameters = { kind: 'referenceStrain', cutoff: 3.1, referenceFractional: reference.fractional,
    referenceCell: reference.cell, referenceMapping };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = client.analyze(frame, parameters);
      await until(() => worker.messages.length === attempt + 1);
      const message = worker.messages[attempt];
      if (attempt) assert.equal(message.referenceFrame, undefined);
      else assert.deepEqual(message.referenceFrame.fractional, reference.fractional);
      worker.answer(message); await pending;
    }
  } finally { client.close(); }
});

test('legacy coordinate-only references cannot replace a trajectory frame species cache', async () => {
  const worker = new WorkerFixture(), client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  const current = crystalFrame('fcc', 1), reference = crystalFrame('fcc', 1);
  reference.types.set([0, 1, 0, 1]);
  const referenceMapping = Int32Array.from({ length: current.types.length }, (_, index) => index);
  const parameters = { kind: 'referenceStrain', cutoff: 3.1, referenceFractional: reference.fractional,
    referenceCell: reference.cell, referenceMapping };
  try {
    const warm = client.analyze(current, parameters, { frameIndex: 1 });
    await until(() => worker.messages.length === 1);
    const virtual = worker.messages[0];
    assert.equal(virtual.referenceFrame.types, undefined);
    worker.answer(virtual); await warm;
    await assert.rejects(client.analyze(current, { ...parameters, referenceFrameIndex: 0 }, { frameIndex: 1 }),
      /indexes require an actual referenceFrame/);
    assert.equal(client.indexFrameIds.has(0), false, 'coordinate-only metadata cannot claim a logical trajectory frame');
    assert.equal(worker.messages.length, 1);
    const actual = client.analyze(reference, { kind: 'rdf', cutoff: 1.9, bins: 20, neighborType: 1 }, { frameIndex: 0 });
    await until(() => worker.messages.length === 2);
    const uploaded = worker.messages[1];
    assert.notEqual(uploaded.frameId, virtual.referenceFrameId);
    assert.deepEqual(uploaded.frame.types, reference.types, 'element-filtered analysis uploads the actual frame species');
    worker.answer(uploaded); await actual;
    const reused = client.analyze(reference, { kind: 'bonds', cutoff: 3.1 }, { frameIndex: 0 });
    await until(() => worker.messages.length === 3);
    assert.equal(worker.messages[2].frameId, uploaded.frameId);
    assert.equal(worker.messages[2].frame, undefined, 'only the actual species-bearing frame is reused');
    worker.answer(worker.messages[2]); await reused;
    assert.deepEqual([...reference.types], [0, 1, 0, 1]);
  } finally { client.close(); }
});

test('a reference to the current frame transfers its coordinates only once and rejects mismatched metadata safely', async () => {
  const worker = new WorkerFixture(), client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  const frame = crystalFrame('fcc', 1), original = frame.fractional.slice();
  const referenceMapping = Int32Array.from({ length: frame.ids.length }, (_, index) => index);
  const parameters = { kind: 'referenceStrain', cutoff: 3.1, referenceFrame: frame, referenceFrameIndex: 0,
    referenceFractional: frame.fractional, referenceCell: frame.cell, referenceMapping };
  try {
    const pending = client.analyze(frame, parameters, { frameIndex: 0 });
    await until(() => worker.messages.length === 1);
    const message = worker.messages[0];
    assert.equal(message.referenceFrameId, message.frameId);
    assert.equal(message.referenceFrame, undefined);
    assert.deepEqual(message.frame.fractional, original);
    worker.answer(message); await pending;
    await assert.rejects(client.analyze(frame, { ...parameters, referenceFractional: frame.fractional.slice() }), /metadata must identify/);
    await assert.rejects(client.analyze(frame, { ...parameters, referenceMapping: [0, 1, 2, 3] }), /typed referenceMapping/);
    await assert.rejects(client.analyze(frame, { ...parameters, referenceFrameIndex: 1 }), /different current and reference indexes/);
    assert.equal(client.frameIndexes.get(frame), 0, 'invalid metadata must not relabel a cached current frame');
    assert.equal(client.indexFrameIds.has(1), false);
    const other = crystalFrame('fcc', 1);
    await assert.rejects(client.analyze(frame, { ...parameters, referenceFrame: other,
      referenceFractional: other.fractional, referenceCell: other.cell }), /same index must identify/);
    assert.equal(worker.messages.length, 1);
    assert.deepEqual(frame.fractional, original);
    assert.deepEqual([...referenceMapping], [0, 1, 2, 3]);
  } finally { client.close(); }
});

test('cancelling a chunked private reference mapping copy sends no partial GPU job and retains all source inputs', async () => {
  const worker = new WorkerFixture(), client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  const controller = new AbortController(), atomCount = 4 * 1024 ** 2 / Int32Array.BYTES_PER_ELEMENT + 1;
  const small = crystalFrame('fcc', 1);
  const current = { ...small, fractional: new Float32Array(atomCount * 3), types: new Uint16Array(atomCount) };
  let mapping, chunks = 0;
  class CancelOnCopy extends Int32Array {
    set(values, offset) {
      super.set(values, offset);
      if (mapping && this !== mapping) { chunks++; controller.abort(); }
    }
  }
  mapping = new CancelOnCopy(atomCount).fill(-1);
  const referenceOriginal = small.fractional.slice();
  try {
    await assert.rejects(client.analyze(current, { kind: 'referenceStrain', referenceFrame: small,
      referenceFractional: small.fractional, referenceCell: small.cell, referenceMapping: mapping, cutoff: 3.1 },
    { signal: controller.signal }), { name: 'AbortError' });
    await until(() => client.current === null);
    assert.equal(chunks, 1, 'cancellation occurs after the first private mapping chunk');
    assert.equal(worker.messages.length, 0);
    assert.equal(current.fractional.byteLength, atomCount * 3 * Float32Array.BYTES_PER_ELEMENT);
    assert.equal(current.types.byteLength, atomCount * Uint16Array.BYTES_PER_ELEMENT);
    assert.deepEqual(small.fractional, referenceOriginal);
    assert.equal(mapping.byteLength, atomCount * Int32Array.BYTES_PER_ELEMENT);
    assert.ok(mapping.every(value => value === -1));
    const next = client.analyze(small, { kind: 'cna', mode: 'fixed', cutoff: 3.1 });
    await until(() => worker.messages.length === 1);
    worker.answer(worker.messages[0]); await next;
  } finally { client.close(); }
});
