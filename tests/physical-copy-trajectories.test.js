import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { replicateFrame } from '../src/data/replicate.js';
import { TrajectoryLineBuilder } from '../src/data/trajectory-tools.js';
import { initializeTrajectoryToolControls } from '../src/ui/selection/trajectory-tool-controls.js';
import { TrajectoryProcessor } from '../src/workers/trajectory-processor.js';

const repetitions = [2, 3, 2];
const context = { repetitions };
const wrapped = value => value - Math.floor(value);
const copyId = (id, offset) => `@AlloyView:copy:${offset.join(':')}:${encodeURIComponent(String(id))}`;

function fixture(index, { images = false, ids = [7, 'Ni: β/one', '@AlloyView:copy:1:0:0:7'], omit = null } = {}) {
  const cell = createCell({ origin: [3 + index * .17, -2 + index * .03, 1 - index * .07],
    vectors: [10 + index * .2, .3, 0, -2, 9 + index * .1, .4, 1.2, -1, 8 - index * .08], pbc: [true, true, true], triclinic: true });
  const entries = ids.map((id, atom) => ({ id, coordinates: [.85 + index * .21 + atom * .03, .12 - index * .17 + atom * .1, .55 + index * .11] }))
    .filter(entry => String(entry.id) !== String(omit));
  if (index % 2) entries.reverse();
  const fractional = Float64Array.from(entries.flatMap(entry => entry.coordinates.map(wrapped)));
  const frame = { frameIndex: index, cell, fractional, positions: fractionalToCartesian(fractional, cell, new Float64Array(fractional.length)),
    ids: entries.map(entry => entry.id), idSource: 'explicit', types: new Uint16Array(entries.length), typeLabels: ['Ni'], properties: [] };
  if (images) {
    frame.imageFlags = Int32Array.from(entries.flatMap(entry => entry.coordinates.map(Math.floor)));
    frame.unwrappedPositions = fractionalToCartesian(Float64Array.from(entries.flatMap(entry => entry.coordinates)), cell, new Float64Array(fractional.length));
  }
  return frame;
}

function build(ids, frames, options = {}) {
  const builder = new TrajectoryLineBuilder(ids, frames.map(frame => frame.frameIndex), options);
  for (const frame of frames) builder.add(frame);
  return builder.finish();
}

test('B35 reproduces paths of actual physical copies with authoritative images, changing triclinic cells and origins', async () => {
  const frames = Array.from({ length: 5 }, (_, index) => fixture(index, { images: true }));
  const expanded = await Promise.all(frames.map(frame => replicateFrame(frame, repetitions)));
  const selected = [expanded[0].ids[2], expanded[0].ids[3], expanded[0].ids[17], expanded[0].ids.at(-1), 7];
  const expected = build(selected, expanded);
  const actual = build(selected, frames, { physicalReplication: context });
  assert.equal(actual.missingCount, 0);
  assert.equal(actual.lineCount, selected.length);
  assert.deepEqual(actual.lineAtomIds, selected);
  assert.deepEqual(actual.vertices, expected.vertices, 'selected-source calculation equals full physical replication without constructing expanded samples');
  assert.deepEqual(actual.lineOffsets, expected.lineOffsets);
  assert.deepEqual(actual.frames, expected.frames);
});

test('B35 unwraps each copy in the source lattice before adding its changing cell offset', () => {
  const frames = Array.from({ length: 5 }, (_, index) => fixture(index));
  const ids = [7, copyId(7, [1, 0, 0]), copyId(7, [1, 2, 1])];
  const result = build(ids, frames, { physicalReplication: context });
  assert.equal(result.lineCount, 3);
  for (let line = 0; line < ids.length; line++) for (let index = 0; index < frames.length; index++) {
    const offset = [[0, 0, 0], [1, 0, 0], [1, 2, 1]][line];
    const frame = frames[index], u = [.85 + index * .21, .12 - index * .17, .55 + index * .11];
    for (let axis = 0; axis < 3; axis++) {
      const expected = frame.cell.origin[axis] + [0, 1, 2].reduce((sum, direction) => sum + (u[direction] + offset[direction]) * frame.cell.vectors[direction * 3 + axis], 0);
      assert.equal(result.vertices[(line * frames.length + index) * 4 + axis], Math.fround(expected));
    }
  }
});

test('B35 decodes escaped reserved source IDs once and leaves ordinary source IDs literal', async () => {
  const literal = '@AlloyView:copy:1:0:0:7';
  const frames = [fixture(0, { images: true }), fixture(1, { images: true })];
  const direct = build([literal], frames);
  const expanded = await replicateFrame(frames[0], [2, 1, 1]);
  const base = expanded.ids[2], copy = expanded.ids[5];
  assert.equal(base, `@AlloyView:base:${encodeURIComponent(literal)}`);
  assert.equal(copy, copyId(literal, [1, 0, 0]));
  const physical = build([base, copy], frames, { physicalReplication: { repetitions: [2, 1, 1] } });
  assert.deepEqual(physical.vertices.subarray(0, 8), direct.vertices);
  const sameLookingId = build([literal], frames, { physicalReplication: { repetitions: [2, 1, 1] } });
  const source = build([7], frames);
  for (let index = 0; index < frames.length; index++) for (let axis = 0; axis < 3; axis++) {
    assert.equal(sameLookingId.vertices[index * 4 + axis], Math.fround(source.vertices[index * 4 + axis] + frames[index].cell.vectors[axis]));
  }
  assert.notDeepEqual(sameLookingId.vertices, direct.vertices, 'physical compound ID and an ordinary literal source ID are different atoms');
});

test('B35 missing sources, obsolete copies and noncanonical IDs cannot generate phantom paths', () => {
  const absent = 999;
  const invalid = [copyId(7, [2, 0, 0]), '@AlloyView:copy:01:0:0:7', '@AlloyView:copy:0:0:0:7',
    '@AlloyView:copy:1:0:0:%37', '@AlloyView:copy:1:0:0:%GG', '@AlloyView:base:7', copyId(absent, [1, 0, 0])];
  const frames = [fixture(0), fixture(1, { omit: 7 }), fixture(2), fixture(3)];
  const ids = [...invalid, copyId(7, [1, 0, 0]), 7];
  const result = build(ids, frames, { physicalReplication: context });
  assert.equal(result.lineCount, 2);
  assert.equal(result.vertexCount, 6);
  assert.deepEqual(result.lineAtomIds, ids.slice(-2));
  assert.deepEqual(result.missingAtomIds, invalid);
  assert.equal(result.missingCount, invalid.length);
  assert.deepEqual(Array.from(result.lineOffsets), [0, 3, 6]);
});

test('B35 rejects malformed copy contexts and duplicate selected IDs before sample allocation', () => {
  for (const value of [{}, { repetitions: [2, 1] }, { repetitions: [2, 0, 1] }, { repetitions: [4096, 2, 1] }]) {
    assert.throws(() => new TrajectoryLineBuilder([7], [0, 1], { physicalReplication: value }), /repeat|cells/i);
  }
  assert.throws(() => new TrajectoryLineBuilder([7, '7'], [0, 1], { physicalReplication: context }), /listed twice/);
  assert.throws(() => new TrajectoryLineBuilder([copyId(7, [1, 0, 0]), copyId(7, [1, 0, 0])], [0, 1], { physicalReplication: context }), /listed twice/);
});

test('B35 processor reads source samples once for many copies, keeps source arrays and observes cancellation', async () => {
  const frames = Array.from({ length: 4 }, (_, index) => fixture(index, { images: true }));
  const original = frames.map(frame => frame.positions.slice()), reads = [];
  const processor = new TrajectoryProcessor({ getFrameCount: async () => frames.length,
    readFrame: async index => { reads.push(index); return frames[index]; }, coordinateBudgetBytes: 1, readAhead: 0 });
  const ids = Array.from({ length: 3 }, (_, index) => index ? copyId(7, [1, index - 1, 1]) : 7);
  const result = await processor.lines({ ids, first: 0, last: 3, stride: 1, physicalReplication: context });
  assert.equal(result.lineCount, 3);
  assert.deepEqual(reads, [0, 1, 2, 3]);
  frames.forEach((frame, index) => assert.deepEqual(frame.positions, original[index]));
  const controller = new AbortController();
  await assert.rejects(processor.lines({ ids, first: 0, last: 3, stride: 1, physicalReplication: context },
    { signal: controller.signal, onProgress: () => controller.abort() }), error => error.name === 'AbortError');
});

function controls({ frame = fixture(0), worker = {}, ensureIndexed = async () => {} } = {}) {
  let currentFrame = frame, version = 1;
  const requests = [], rendered = [];
  const tool = initializeTrajectoryToolControls({ getFrame: () => currentFrame, getFrameCount: () => 2, getSourceVersion: () => version, ensureIndexed,
    renderer: { setTrajectoryLines: result => rendered.push(result) }, worker: { trajectoryLines: async (request, options) => {
      requests.push(request);
      if (worker.trajectoryLines) return worker.trajectoryLines(request, options);
      return build(request.ids, [fixture(0), fixture(1)], { physicalReplication: request.physicalReplication,
        inferMissingImages: request.inferMissingImages });
    } } });
  return { tool, requests, rendered, setFrame: next => { currentFrame = next; }, setVersion: next => { version = next; } };
}

test('B35 controls send only copy counts, retain compound settings and clear paths after physical layout changes', async () => {
  const frame = { ...fixture(0), physicalReplication: { repetitions, sourceAtomCount: 3 } };
  const { tool, requests, setFrame } = controls({ frame });
  const id = copyId(7, [1, 2, 1]);
  assert.equal(await tool.restoreLines({ enabled: true, atomIds: [id], firstFrame: 0, lastFrame: 1, stride: 1 }), true);
  assert.deepEqual(requests[0], { ids: [id], first: 0, last: 1, stride: 1, inferMissingImages: false, physicalReplication: { repetitions } });
  assert.notEqual(requests[0].physicalReplication.repetitions, repetitions, 'request takes an immutable small snapshot');
  assert.deepEqual(tool.serialize().lines.atomIds, [id]);
  assert.equal(tool.getLines().missingCount, 0);
  const previous = tool.getLines();
  setFrame({ ...fixture(1), physicalReplication: { repetitions: [...repetitions] } }); tool.onFrame();
  assert.equal(tool.getLines(), previous, 'navigation with the same copy layout retains the paths');
  setFrame(fixture(1)); tool.onFrame();
  assert.equal(tool.getLines(), null);
});

test('B35 late copy results cannot republish after a layout change, source change or cancellation', async () => {
  for (const action of ['layout', 'source', 'cancel']) {
    let resolve, signal;
    const frame = { ...fixture(0), physicalReplication: { repetitions } };
    const harness = controls({ frame, worker: { trajectoryLines: async (_request, options) => {
      signal = options.signal;
      return new Promise(done => { resolve = done; });
    } } });
    const pending = harness.tool.restoreLines({ enabled: true, atomIds: [copyId(7, [1, 0, 0])], firstFrame: 0, lastFrame: 1, stride: 1 });
    while (!resolve) await Promise.resolve();
    if (action === 'layout') { harness.setFrame(fixture(1)); harness.tool.onFrame(); assert.equal(signal.aborted, true); }
    if (action === 'source') harness.setVersion(2);
    if (action === 'cancel') { harness.tool.cancelLines(); assert.equal(signal.aborted, true); }
    resolve(build([7], [fixture(0), fixture(1)]));
    assert.equal(await pending, false);
    assert.equal(harness.tool.getLines(), null);
    assert.ok(harness.rendered.every(result => result === null));
  }
});

test('B35 an index wait cannot dispatch obsolete copy IDs after reset, source or layout changes', async () => {
  for (const action of ['layout', 'source', 'cancel', 'reset']) {
    let resume;
    const harness = controls({ frame: { ...fixture(0), physicalReplication: context },
      ensureIndexed: () => new Promise(done => { resume = done; }) });
    const pending = harness.tool.restoreLines({ enabled: true, atomIds: [copyId(7, [1, 0, 0])], firstFrame: 0, lastFrame: 1, stride: 1 });
    while (!resume) await Promise.resolve();
    if (action === 'layout') harness.setFrame(fixture(1));
    if (action === 'source') harness.setVersion(2);
    if (action === 'cancel') harness.tool.cancelLines();
    if (action === 'reset') harness.tool.reset();
    resume();
    assert.equal(await pending, false);
    assert.deepEqual(harness.requests, []);
    assert.equal(harness.tool.getLines(), null);
  }
});
