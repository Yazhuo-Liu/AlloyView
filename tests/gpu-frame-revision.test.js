import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';
import { GpuRuntime } from '../src/analysis/gpu/runtime.js';
import { crystalFrame } from './helpers/crystals.js';

class WorkerFixture {
  constructor() { this.listeners = new Map(); this.messages = []; this.frames = new Map(); this.terminated = false; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  postMessage(data, transfer = []) { this.messages.push(structuredClone(data, { transfer })); }
  terminate() { this.terminated = true; }
  answer(message, extra = {}) {
    for (const [id, frame] of [[message.frameId, message.frame], [message.referenceFrameId, message.referenceFrame]]) if (frame) this.frames.set(id, frame);
    if (message.type === 'release-frame') this.frames.delete(message.releasedFrameId);
    let result = { engine: 'webgpu' };
    if (message.parameters?.kind === 'voronoi') {
      const count = this.frames.get(message.frameId).fractional.length / 3;
      result = { ...result, ...Object.fromEntries(['atomicVolume', 'voronoiSurfaceArea', 'voronoiCoordination', 'voronoiBoundaryFaces', 'voronoiMaxFaceOrder'].map(name => [name, new Float64Array(count)])),
        faceOffsets: new Uint32Array(count + 1), faceNeighbors: new Int32Array(), voronoiIndices: Array(count).fill('') };
    }
    this.listeners.get('message')({ data: { id: message.id, ok: true, result,
      cachedFrameIds: [...this.frames.keys()], ...extra } });
  }
}
const until = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  throw new Error('GPU request was not posted.');
};
function fixture() {
  const worker = new WorkerFixture(), client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  return { worker, client, frame: crystalFrame('fcc', 1) };
}
async function run(client, worker, frame, parameters = { kind: 'coordination', cutoff: 3 }, options) {
  const before = worker.messages.length, result = client.analyze(frame, parameters, options);
  await until(() => worker.messages.length > before);
  const message = worker.messages.at(-1); assert.equal(message.type, 'analyze'); worker.answer(message); await result; return message;
}
async function release(client, worker, frame) {
  const before = worker.messages.length, result = client.invalidateFrame(frame);
  await until(() => worker.messages.length > before);
  const message = worker.messages.at(-1); assert.equal(message.type, 'release-frame'); worker.answer(message); await result; return message;
}

test('explicit frame invalidation replaces only its resident inputs and keeps a warm device and unrelated frame', async () => {
  const { client, worker, frame } = fixture(), other = crystalFrame('bcc', 1);
  try {
    const original = await run(client, worker, frame, undefined, { frameIndex: 0 });
    const untouched = await run(client, worker, other, undefined, { frameIndex: 1 });
    client.deviceWarmed = true; client.warmedAnalysisKinds.add('voronoi');
    const uploads = worker.messages.filter(message => message.frame).length;
    frame.fractional[3] += .05;
    const barrier = await release(client, worker, frame);
    assert.equal(barrier.releasedFrameId, original.frameId);
    const changed = await run(client, worker, frame, undefined, { frameIndex: 0 });
    assert.notEqual(changed.frameId, original.frameId); assert.equal(changed.frame.fractional[3], frame.fractional[3]);
    const reused = await run(client, worker, other, undefined, { frameIndex: 1 });
    assert.equal(reused.frameId, untouched.frameId); assert.equal(reused.frame, undefined);
    assert.equal(worker.messages.filter(message => message.frame).length, uploads + 1);
    assert.equal(client.worker, worker); assert.equal(worker.terminated, false); assert.equal(client.deviceWarmed, true);
    assert.deepEqual([...client.warmedAnalysisKinds], ['voronoi']); assert.equal(client.invalidatedFrameIds.size, 0);
  } finally { client.close(); }
});

test('geometry revisions and fixed-size cell edits refresh inputs, while indexed immutable reparses reuse the GPU upload', async () => {
  const { client, worker, frame } = fixture();
  try {
    const first = await run(client, worker, frame, undefined, { frameIndex: 0 });
    const reparsed = structuredClone(frame);
    const reused = await run(client, worker, reparsed, undefined, { frameIndex: 0 });
    assert.equal(reused.frameId, first.frameId); assert.equal(reused.frame, undefined);
    const changes = [value => { value.geometryRevision = 1; value.fractional[0] = .1; },
      value => { value.cell.origin[0] += 3; }, value => { value.cell.vectors[0] += .1; },
      value => { value.cell.pbc[0] = false; }, value => { value.fractional = value.fractional.slice(); },
      value => { value.types = value.types.slice(); }, value => { value.positions = value.positions.slice(); }];
    let previous = first.frameId;
    for (const mutate of changes) {
      mutate(reparsed);
      const offset = worker.messages.length, result = client.analyze(reparsed, { kind: 'coordination', cutoff: 3 });
      await until(() => worker.messages.length > offset);
      const barrier = worker.messages.at(-1); assert.equal(barrier.type, 'release-frame'); worker.answer(barrier);
      await until(() => worker.messages.at(-1).type === 'analyze');
      const changed = worker.messages.at(-1); assert.notEqual(changed.frameId, previous); assert.ok(changed.frame);
      worker.answer(changed); await result; previous = changed.frameId;
    }
    const invalid = { ...reparsed, geometryRevision: -1 };
    await assert.rejects(client.analyze(invalid, { kind: 'coordination', cutoff: 3 }), /geometryRevision/);
  } finally { client.close(); }
});

test('invalidating a reference cancels running and posted dual-frame jobs until ACK, rejects queued uses and preserves unrelated work', async () => {
  const { client, worker, frame } = fixture(), reference = crystalFrame('bcc', 1), other = crystalFrame('sc', 2);
  try {
    const a = await run(client, worker, frame, undefined, { frameIndex: 0 });
    const b = await run(client, worker, reference, undefined, { frameIndex: 1 });
    const c = await run(client, worker, other, undefined, { frameIndex: 2 });
    const parameters = { kind: 'referenceStrain', cutoff: 3, referenceFrame: reference,
      referenceFrameIndex: 1, referenceCell: reference.cell, referenceFractional: reference.fractional,
      referenceMapping: new Int32Array(frame.types.length).fill(-1) };
    const jobs = Array.from({ length: 3 }, () => client.analyze(frame, parameters));
    const rejected = jobs.map(job => assert.rejects(job, { name: 'AbortError' }));
    await until(() => worker.messages.filter(message => message.type === 'analyze').length === 5);
    const posted = worker.messages.filter(message => message.type === 'analyze').slice(-2);
    const unrelated = client.analyze(other, { kind: 'coordination', cutoff: 3 });
    const barrier = client.invalidateFrame(reference);
    await Promise.all(rejected); assert.equal(client.active.length, 2);
    assert.equal(worker.messages.filter(message => message.type === 'cancel').length, 2);
    assert.equal(worker.messages.some(message => message.type === 'release-frame'), false, 'no old buffers released while a posted job holds its lease');
    worker.answer(posted[0], { cachedCartesianFrames: [{ frameId: b.frameId, variants: ['cartesian'] }],
      cachedPtmFits: [{ frameId: b.frameId, fitId: 17 }] });
    assert.equal(client.cachedFrameIds.has(b.frameId), false); assert.equal(client.cachedCartesianFrames.has(b.frameId), false);
    assert.equal(client.cachedPtmFits.has(b.frameId), false, 'a late successful ACK cannot revive an invalidated fit');
    worker.answer(posted[1]);
    await until(() => worker.messages.at(-1).type === 'release-frame'); worker.answer(worker.messages.at(-1)); await barrier;
    await until(() => worker.messages.at(-1).type === 'analyze');
    const surviving = worker.messages.at(-1); assert.equal(surviving.frameId, c.frameId); assert.equal(surviving.frame, undefined);
    worker.answer(surviving); await unrelated;
    assert.equal(client.cachedFrameIds.has(a.frameId), true); assert.equal(client.worker, worker);
    assert.equal(client.pending.size, 0); assert.equal(client.active.length, 0);
  } finally { client.close(); }
});

test('frame invalidation clears acknowledged Cartesian and PTM sources so their next request uploads private inputs again', async () => {
  const { client, worker, frame } = fixture();
  const fit = { structures: new Uint8Array(4).fill(1), scales: new Float64Array(4).fill(1), deformation: new Float64Array(36).fill(1) };
  const positions = Float64Array.from(frame.positions), displacement = { kind: 'displacement', referenceFrame: frame,
    referenceFractional: frame.fractional, referenceCell: frame.cell, referenceMapping: Int32Array.from([0, 1, 2, 3]),
    currentPositions: positions, referencePositions: positions };
  try {
    const initial = await run(client, worker, frame);
    const first = client.analyze(frame, displacement); await until(() => worker.messages.at(-1).parameters?.kind === 'displacement');
    worker.answer(worker.messages.at(-1), { cachedCartesianFrames: [{ frameId: initial.frameId, variants: ['cartesian'] }] }); await first;
    const strain = client.analyze(frame, { kind: 'strain', ptmInput: fit }); await until(() => worker.messages.at(-1).parameters?.kind === 'strain');
    const oldFit = worker.messages.at(-1); worker.answer(oldFit, { cachedPtmFits: [{ frameId: initial.frameId, fitId: oldFit.parameters.ptmFitId }] }); await strain;
    await release(client, worker, frame);
    assert.equal(client.positionSources.size, 0); assert.equal(client.ptmSources.size, 0);
    const changed = await run(client, worker, frame, displacement);
    assert.ok(changed.parameters.currentPositions); assert.strictEqual(changed.parameters.referencePositions, changed.parameters.currentPositions, 'a self-reference still uploads positions once');
    const freshFit = await run(client, worker, frame, { kind: 'strain', ptmInput: fit });
    assert.ok(freshFit.parameters.ptmInput); assert.notEqual(freshFit.parameters.ptmFitId, oldFit.parameters.ptmFitId);
    assert.ok(frame.fractional.byteLength && fit.scales.byteLength && positions.byteLength);
  } finally { client.close(); }
});

test('type-subset inputs never claim the source trajectory identity and release with the source geometry', async () => {
  const { client, worker, frame } = fixture(); frame.typeLabels = ['A', 'B']; frame.types[3] = 1;
  try {
    const source = await run(client, worker, frame, undefined, { frameIndex: 0 });
    const subset = await run(client, worker, frame, { kind: 'voronoi', selectedTypes: ['A'] });
    assert.notEqual(subset.frameId, source.frameId); assert.equal(client.indexFrameIds.get(0), source.frameId);
    assert.equal(source.frame.gpuDerivedFrame, false);
    assert.equal(subset.frame.gpuDerivedFrame, true);
    assert.equal(subset.frameIndex, 0, 'subset analysis still follows the source trajectory index');
    const before = worker.messages.length, barrier = client.invalidateFrame(frame);
    await until(() => worker.messages.length > before); const first = worker.messages.at(-1);
    assert.equal(first.type, 'release-frame'); assert.equal(first.releasedFrameId, subset.frameId); worker.answer(first);
    await until(() => worker.messages.at(-1) !== first); const second = worker.messages.at(-1);
    assert.equal(second.releasedFrameId, source.frameId); worker.answer(second); await barrier;
    assert.equal(worker.frames.size, 0); assert.equal(client.derivedFrameIds.size, 0);
  } finally { client.close(); }
});

test('the revision check does not read coordinate or type contents before dispatch', () => {
  const { client, frame } = fixture();
  try {
    const unread = length => new Proxy({ length }, { get(target, key) { if (/^\d+$/.test(String(key))) assert.fail('A revision check scanned an atom array'); return target[key]; } });
    frame.fractional = unread(3_000_000); frame.types = unread(1_000_000);
    const first = client.frameRevision(frame); assert.equal(client.frameRevision(frame), first);
    frame.geometryRevision = 1; assert.notEqual(client.frameRevision(frame), first);
    assert.equal(client.worker, null, 'marking edits does not initialize an unused GPU');
  } finally { client.close(); }
});

test('single-frame GPU release disposes all its variants and indices while retaining other buffers, pipelines and reusable workspaces', () => {
  const runtime = new GpuRuntime(), destroyed = [];
  const buffer = (id, size = 8) => { const result = { destroy() { destroyed.push(id); } }; runtime.bufferSizes.set(result, size); runtime.allocatedBytes += size; return result; };
  runtime.device = { limits: { maxBufferSize: 1024 ** 3, maxStorageBufferBindingSize: 1024 ** 3 }, destroy() { assert.fail('A frame invalidation destroyed the device'); } };
  runtime.pipelines.set('warm', {}); runtime.frameCount = 2; runtime.currentIndex = 0;
  runtime.frames.set(10, { positionsBuffer: buffer('positions'), typesBuffer: buffer('types'),
    ptm: { metadataBuffer: buffer('ptm-meta'), scalesBuffer: buffer('ptm-scale'), deformationBuffer: buffer('ptm-fit') },
    cartesian: new Map([['cartesian', { positionsBuffer: buffer('cartesian') }], ['unwrapped-cartesian', { positionsBuffer: buffer('unwrapped') }]]), bytes: 56, frameIndex: 0 });
  runtime.frames.set(11, { positionsBuffer: buffer('other'), bytes: 8, frameIndex: 1 }); runtime.residentBytes = 64;
  runtime.indexes.set('old', { frameKey: 10, configBuffer: buffer('index-config'), headsBuffer: buffer('index-heads'), nextBuffer: buffer('index-next') });
  runtime.adaptiveCna.set(10, new Uint8Array(1)); runtime.adaptiveCna.set(11, new Uint8Array(1));
  runtime.voronoiPreparations.set(10, {}); runtime.voronoiCpuContext = { frameKey: 10 };
  const workspace = {}; runtime.voronoiWorkspace = workspace; runtime.protectedFrameKey = 10;
  runtime.analysisFramePins.set(10, 1); assert.throws(() => runtime.releaseFrame(10), /active GPU frame/);
  runtime.analysisFramePins.delete(10); runtime.releaseFrame(10);
  assert.equal(destroyed.length, 10); assert.equal(runtime.allocatedBytes, 8); assert.equal(runtime.residentBytes, 8);
  assert.equal(runtime.frames.has(11), true); assert.equal(runtime.adaptiveCna.has(11), true);
  assert.equal(runtime.pipelines.size, 1); assert.equal(runtime.voronoiWorkspace, workspace);
  assert.equal(runtime.voronoiCpuContext, null); assert.equal(runtime.protectedFrameKey, null);
});

test('invalidating during a private coordinate copy aborts before transfer and releases its old identity after cleanup', async () => {
  const { client, worker, frame } = fixture();
  let source, invalidation, copies = 0;
  class EditedDuringCopy extends Float64Array {
    set(values, offset) {
      super.set(values, offset);
      if (source && this !== source && !invalidation) { copies++; source[0] = .2; invalidation = client.invalidateFrame(frame); }
    }
  }
  const count = 4 * 1024 ** 2 / Float64Array.BYTES_PER_ELEMENT + 1;
  frame.fractional = source = new EditedDuringCopy(count * 3); frame.types = new Uint16Array(count);
  try {
    const job = client.analyze(frame, { kind: 'coordination', cutoff: 3 });
    await assert.rejects(job, { name: 'AbortError' });
    await until(() => worker.messages.some(message => message.type === 'release-frame'));
    assert.equal(worker.messages.some(message => message.type === 'analyze'), false);
    assert.equal(copies, 1); assert.equal(source.byteLength, count * 24);
    worker.answer(worker.messages.at(-1)); await invalidation;
    assert.equal(client.active.length, 0); assert.equal(client.worker, worker);
    await run(client, worker, crystalFrame('fcc', 1));
  } finally { client.close(); }
});

test('a geometry revision changed while a request runs rejects its old result even before another analysis starts', async () => {
  const { client, worker, frame } = fixture();
  try {
    const initial = await run(client, worker, frame);
    const job = client.analyze(frame, { kind: 'coordination', cutoff: 3 }), rejected = assert.rejects(job, { name: 'AbortError' });
    await until(() => worker.messages.filter(message => message.type === 'analyze').length === 2);
    const pending = worker.messages.at(-1); frame.geometryRevision = 1;
    worker.answer(pending); await rejected;
    assert.equal(client.cachedFrameIds.has(initial.frameId), false);
    await until(() => worker.messages.at(-1).type === 'release-frame'); worker.answer(worker.messages.at(-1));
    await until(() => client.active.length === 0);
    const fresh = await run(client, worker, frame); assert.ok(fresh.frame); assert.notEqual(fresh.frameId, initial.frameId);
  } finally { client.close(); }
});

test('a known stale indexed alias uses its own coordinates and cannot borrow or replace an edited canonical input', async () => {
  const { client, worker, frame } = fixture();
  try {
    await run(client, worker, frame, undefined, { frameIndex: 0 });
    const edited = structuredClone(frame); await run(client, worker, edited, undefined, { frameIndex: 0 });
    edited.fractional[0] = .4; await release(client, worker, edited);
    const current = await run(client, worker, edited, undefined, { frameIndex: 0 });
    const stale = await run(client, worker, frame, undefined, { frameIndex: 0 });
    assert.notEqual(stale.frameId, current.frameId); assert.ok(stale.frame); assert.equal(stale.frame.fractional[0], 0);
    assert.equal(client.indexFrameIds.get(0), current.frameId);
    const reused = await run(client, worker, edited, undefined, { frameIndex: 0 });
    assert.equal(reused.frameId, current.frameId); assert.equal(reused.frame, undefined);
    const repeatedStale = await run(client, worker, frame, undefined, { frameIndex: 0 });
    assert.equal(repeatedStale.frameId, stale.frameId); assert.equal(repeatedStale.frame, undefined);
  } finally { client.close(); }
});

test('a source revision detected while reusing a compact Voronoi selection registers its refreshed derived identity', async () => {
  const { client, worker, frame } = fixture(); frame.typeLabels = ['A', 'B']; frame.types[3] = 1;
  try {
    await run(client, worker, frame, undefined, { frameIndex: 0 });
    const subset = await run(client, worker, frame, { kind: 'voronoi', selectedTypes: ['A'] });
    frame.geometryRevision = 1;
    const before = worker.messages.length, result = client.analyze(frame, { kind: 'voronoi', selectedTypes: ['A'] });
    await until(() => worker.messages.length > before);
    const first = worker.messages.at(-1); assert.equal(first.type, 'release-frame'); worker.answer(first);
    await until(() => worker.messages.at(-1) !== first); const second = worker.messages.at(-1); assert.equal(second.type, 'release-frame'); worker.answer(second);
    await until(() => worker.messages.at(-1).type === 'analyze'); const refreshed = worker.messages.at(-1);
    assert.notEqual(refreshed.frameId, subset.frameId); worker.answer(refreshed); await result;
    const sourceId = client.frameRevision(frame); assert.equal(client.derivedFrameIds.get(sourceId).has(refreshed.frameId), true);
    const invalidation = client.invalidateFrame(frame);
    await until(() => worker.messages.at(-1).type === 'release-frame'); const derivedRelease = worker.messages.at(-1);
    assert.equal(derivedRelease.releasedFrameId, refreshed.frameId); worker.answer(derivedRelease);
    await until(() => worker.messages.at(-1) !== derivedRelease); worker.answer(worker.messages.at(-1)); await invalidation;
    assert.equal(worker.frames.has(refreshed.frameId), false);
  } finally { client.close(); }
});

test('explicit invalidation advances the visible revision so a fresh original-file reparse cannot borrow edited geometry', async () => {
  const { client, worker, frame } = fixture();
  try {
    await run(client, worker, frame, undefined, { frameIndex: 0 });
    const edited = structuredClone(frame); await run(client, worker, edited, undefined, { frameIndex: 0 });
    edited.fractional[0] = .4; await release(client, worker, edited);
    assert.equal(edited.geometryRevision, 1);
    const current = await run(client, worker, edited, undefined, { frameIndex: 0 });
    const editedReparse = await run(client, worker, structuredClone(edited), undefined, { frameIndex: 0 });
    assert.equal(editedReparse.frameId, current.frameId); assert.equal(editedReparse.frame, undefined);
    const originalReparse = structuredClone(frame);
    const original = await run(client, worker, originalReparse, undefined, { frameIndex: 0 });
    assert.notEqual(original.frameId, current.frameId); assert.ok(original.frame); assert.equal(original.frame.fractional[0], 0);
    assert.equal(client.indexFrameIds.get(0), current.frameId, 'a newly loaded older revision does not replace edited canonical geometry');
  } finally { client.close(); }
});

test('old aliases and an unseen original-source reparse cannot cancel a running task on the newer canonical revision', async () => {
  const { client, worker, frame } = fixture();
  try {
    const original = structuredClone(frame);
    await run(client, worker, frame, undefined, { frameIndex: 0 });
    const edited = structuredClone(frame); await run(client, worker, edited, undefined, { frameIndex: 0 });
    edited.fractional[0] = .4; await release(client, worker, edited);
    const canonical = await run(client, worker, edited, undefined, { frameIndex: 0 });
    const current = client.analyze(edited, { kind: 'coordination', cutoff: 3 }, { frameIndex: 0 });
    await until(() => worker.messages.filter(message => message.type === 'analyze').length === 4);
    const pending = worker.messages.at(-1), freshOld = client.analyze(original, { kind: 'coordination', cutoff: 3 }, { frameIndex: 0 });
    assert.equal(worker.messages.some(message => message.type === 'cancel' && message.id === pending.id), false);
    worker.answer(pending); await current;
    await until(() => worker.messages.at(-1).type === 'analyze' && worker.messages.at(-1) !== pending);
    const older = worker.messages.at(-1); assert.notEqual(older.frameId, canonical.frameId); assert.equal(older.frame.fractional[0], 0);
    worker.answer(older); await freshOld;
    assert.equal(client.indexFrameIds.get(0), canonical.frameId);
    const oldAlias = await run(client, worker, frame, undefined, { frameIndex: 0 });
    assert.equal(oldAlias.frame.fractional[0], 0); assert.equal(client.indexFrameIds.get(0), canonical.frameId);
  } finally { client.close(); }
});

test('invalid revision markers fail before cancelling or modifying the resident frame mapping', async () => {
  const { client, worker, frame } = fixture();
  try {
    const resident = await run(client, worker, frame, undefined, { frameIndex: 0 });
    const mapping = client.indexFrameIds.get(0), before = worker.messages.length;
    Object.freeze(frame);
    assert.throws(() => client.invalidateFrame(frame), error => error.analysisErrorKind === 'validation' && /writable/.test(error.message));
    assert.equal(client.indexFrameIds.get(0), mapping); assert.equal(client.cachedFrameIds.has(resident.frameId), true); assert.equal(worker.messages.length, before);
    const overflow = { ...frame, geometryRevision: Number.MAX_SAFE_INTEGER };
    assert.throws(() => client.invalidateFrame(overflow, { frameIndex: 0 }), /safe integer/);
    assert.equal(overflow.geometryRevision, Number.MAX_SAFE_INTEGER); assert.equal(client.indexFrameIds.get(0), mapping); assert.equal(worker.messages.length, before);
  } finally { client.close(); }
});

test('invalidating an older indexed alias targets its input and leaves a newer canonical running job intact', async () => {
  const { client, worker, frame } = fixture();
  try {
    await run(client, worker, frame, undefined, { frameIndex: 0 });
    const edited = structuredClone(frame); await run(client, worker, edited, undefined, { frameIndex: 0 });
    edited.fractional[0] = .4; await release(client, worker, edited);
    const canonical = await run(client, worker, edited, undefined, { frameIndex: 0 });
    const current = client.analyze(edited, { kind: 'coordination', cutoff: 3 }, { frameIndex: 0 });
    await until(() => worker.messages.filter(message => message.type === 'analyze').length === 4); const pending = worker.messages.at(-1);
    const invalidation = client.invalidateFrame(frame, { frameIndex: 0 });
    assert.equal(worker.messages.some(message => message.type === 'cancel' && message.id === pending.id), false);
    assert.equal(client.indexFrameIds.get(0), canonical.frameId); assert.equal(frame.geometryRevision, 2, 'an edited old alias gets a distinct visible revision');
    worker.answer(pending); await current;
    await until(() => worker.messages.at(-1).type === 'release-frame'); const discarded = worker.messages.at(-1);
    assert.notEqual(discarded.releasedFrameId, canonical.frameId); worker.answer(discarded); await invalidation;
    assert.equal(client.cachedFrameIds.has(canonical.frameId), true);
    const original = await run(client, worker, frame, undefined, { frameIndex: 0 });
    assert.equal(original.frame.fractional[0], 0); assert.notEqual(original.frameId, canonical.frameId);
    assert.equal(client.indexFrameIds.get(0), canonical.frameId);
  } finally { client.close(); }
});

test('dual-frame dependency capture follows the actual current identity when associating a newer reference revision changes aliases', async () => {
  const { client, worker, frame } = fixture();
  try {
    await run(client, worker, frame, undefined, { frameIndex: 0 });
    const reference = { ...frame, geometryRevision: 1 };
    const job = client.analyze(frame, { kind: 'referenceStrain', cutoff: 3, referenceFrame: reference, referenceFrameIndex: 0,
      referenceFractional: reference.fractional, referenceCell: reference.cell, referenceMapping: Int32Array.from([0, 1, 2, 3]) });
    const rejected = assert.rejects(job, { name: 'AbortError' });
    await until(() => worker.messages.at(-1).type === 'release-frame'); const initialRelease = worker.messages.at(-1); worker.answer(initialRelease);
    await until(() => worker.messages.at(-1).type === 'analyze'); const posted = worker.messages.at(-1);
    assert.notEqual(posted.frameId, posted.referenceFrameId);
    assert.equal(client.current.frameDependencies.includes(posted.frameId), true);
    const barrier = client.invalidateFrame(frame);
    await rejected; assert.equal(worker.messages.some(message => message.type === 'cancel' && message.id === posted.id), true);
    worker.answer(posted, { result: { stale: true } });
    await until(() => worker.messages.at(-1).type === 'release-frame'); worker.answer(worker.messages.at(-1)); await barrier;
    assert.equal(client.active.length, 0);
  } finally { client.close(); }
});
