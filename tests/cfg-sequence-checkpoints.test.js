import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { computeDisplacements } from '../src/analysis/displacement.js';
import { replicateFrame } from '../src/data/replicate.js';

// Drive the structure Worker module directly with a stand-in global scope.
const listeners = [], replies = [];
globalThis.self = {
  addEventListener: (type, listener) => { if (type === 'message') listeners.push(listener); },
  postMessage: message => replies.push(message),
};
await import('../src/workers/structure-worker.js');

let nextId = 1;
async function request(type, payload) {
  const id = nextId++;
  for (const listener of listeners) await listener({ data: { id, type, payload } });
  const reply = replies.find(message => message.id === id && 'ok' in message);
  assert.ok(reply?.ok, reply?.error);
  return reply.result;
}

async function sequence(count) {
  return Promise.all(Array.from({ length: count }, async (_, index) => {
    const name = `replica.${index}.cfg`;
    return new File([await readFile(new URL(`../examples/fixed_end_climb/${name}`, import.meta.url))], name);
  }));
}

const signature = frame => JSON.stringify([Array.from(frame.unwrappedPositions), Array.from(frame.imageFlags), frame.unwrapSource]);
const continuousFrame = async index => (await request('frame', { index, trajectory: { sequenceUnwrap: true } })).frame;

function syntheticSequence(count, reads, { invalid = -1 } = {}) {
  class ObservedFile extends File {
    async arrayBuffer() { reads.push(this.name); return super.arrayBuffer(); }
  }
  return Array.from({ length: count }, (_, index) => new ObservedFile([
    `Number of particles = 1\nH0(1,1) = 10\nH0(1,2) = 0\nH0(1,3) = 0\nH0(2,1) = 0\nH0(2,2) = 10\nH0(2,3) = 0\nH0(3,1) = 0\nH0(3,2) = 0\nH0(3,3) = 10\n.NO_VELOCITY.\nentry_count = 4\nauxiliary[0] = id\n55.845\nFe\n${index === invalid ? 'broken' : ((.9 + .23 * index) % 1).toFixed(8)} .2 .3 1\n`,
  ], `frame.${index}.cfg`));
}

test('seeking a 165-file CFG folder reads only the selected file, including speculative reads', async () => {
  const reads = [], files = syntheticSequence(165, reads);
  const loaded = await request('load', { files: [...files].reverse() });
  assert.equal(loaded.frameCount, 165);
  assert.equal(loaded.frame.unwrappedPositions, undefined, 'loading does not invent file image data');
  reads.length = 0; replies.length = 0;
  for (const index of [164, 2, 163, 0]) {
    const { frame } = await request('frame', { index, background: index === 163 });
    assert.equal(frame.frameIndex, index);
    assert.equal(frame.unwrappedPositions, undefined);
    assert.equal(frame.imageFlags, undefined);
    assert.equal(frame.properties[0].name, 'mass');
  }
  assert.deepEqual(reads, [164, 2, 163, 0].map(index => `frame.${index}.cfg`));
  assert.equal(replies.some(message => message.stage === 'sequence-unwrap'), false);
});

test('a malformed intermediate frame blocks requested trajectory inference but not viewing a later structure', async () => {
  const reads = [], files = syntheticSequence(8, reads, { invalid: 3 });
  await request('load', { files });
  const { frame } = await request('frame', { index: 7 });
  assert.equal(frame.ids.length, 1);
  await assert.rejects(continuousFrame(7), /numeric|number|coordinate|finite|malformed/i);
  assert.deepEqual((await request('frame', { index: 7 })).frame.positions, frame.positions);
});

test('smoothing a late CFG frame reads its local window without integrating the preceding trajectory', async () => {
  const reads = [], files = syntheticSequence(165, reads);
  await request('load', { files });
  reads.length = 0; replies.length = 0;
  const { frame } = await request('frame', { index: 163, trajectory: { smoothing: 1 } });
  assert.deepEqual([...new Set(reads)].sort(), ['frame.162.cfg', 'frame.163.cfg', 'frame.164.cfg']);
  assert.equal(frame.smoothing.frameCount, 3);
  assert.equal(replies.some(message => message.stage === 'sequence-unwrap'), false);
});

test('on-demand CFG continuity retains multi-cell total displacement before and after physical replication', async () => {
  const reads = [], files = syntheticSequence(8, reads);
  await request('load', { files });
  const raw = (await request('frame', { index: 5 })).frame;
  const reference = await continuousFrame(0), current = await continuousFrame(5);
  for (const physical of [false, true]) {
    const from = physical ? await replicateFrame(reference, [2, 1, 1]) : reference;
    const to = physical ? await replicateFrame(current, [2, 1, 1]) : current;
    const result = await computeDisplacements(to, from, { minimumImage: false });
    for (let atom = 0; atom < to.ids.length; atom++) assert.ok(Math.abs(result.vectors[atom * 3] - 11.5) < 1e-5);
  }
  assert.equal(raw.unwrappedPositions, undefined, 'analysis preparation does not mutate the ordinary frame');
});

test('file image counts stay lazy and explicit Unwrap reads only the selected CFG, including zero counts', async () => {
  const reads = [];
  for (const image of [0, 3]) {
    const files = syntheticSequence(165, reads).map(file => new File([
      `Number of particles = 1\n${Array.from({ length: 9 }, (_, axis) => `H0(${Math.floor(axis / 3) + 1},${axis % 3 + 1}) = ${axis % 4 === 0 ? 10 : 0}`).join('\n')}\n.NO_VELOCITY.\nentry_count = 7\nauxiliary[0] = ix\nauxiliary[1] = iy\nauxiliary[2] = iz\nauxiliary[3] = id\n55.845\nFe\n.02 .2 .3 ${image} -1 2 1\n`,
    ], file.name));
    // Header reads are intentionally excluded; count complete atom parsing.
    for (const file of files) {
      const arrayBuffer = file.arrayBuffer.bind(file);
      file.arrayBuffer = () => { reads.push(file.name); return arrayBuffer(); };
    }
    const loaded = await request('load', { files });
    assert.equal(loaded.frame.unwrappedPositions, undefined);
    assert.equal(loaded.frame.imageFlags[0], image);
    reads.length = 0; replies.length = 0;
    const raw = (await request('frame', { index: 164 })).frame;
    assert.equal(raw.unwrappedPositions, undefined);
    assert.deepEqual(reads, ['frame.164.cfg']);
    reads.length = 0;
    const result = await request('trajectory-unwrap', { index: 164, infer: true });
    assert.ok(Math.abs(result.unwrappedPositions[0] - (.2 + image * 10)) < 1e-5);
    assert.equal(result.inferredUnwrap, undefined);
    assert.deepEqual(reads, ['frame.164.cfg']);
    assert.equal(replies.some(message => message.stage === 'trajectory-unwrap' || message.stage === 'sequence-unwrap'), false);
  }
});

test('missing image counts never trigger inference without its separate opt-in', async () => {
  const reads = [], files = syntheticSequence(165, reads);
  await request('load', { files });
  for (const payload of [{ index: 164 }, { index: 164, infer: false }]) {
    reads.length = 0; replies.length = 0;
    assert.equal((await request('trajectory-unwrap', payload)).inferredUnwrap, null);
    assert.deepEqual(reads, ['frame.164.cfg']);
    assert.equal(replies.some(message => message.stage === 'trajectory-unwrap'), false);
  }
  const raw = await request('frame', { index: 164, trajectory: { unwrap: true } });
  assert.equal(raw.frame.inferredUnwrap, undefined, 'display unwrap alone grants no historical scan');
});

test('opted-in inference retains identical crossing history across large forward and backward jumps', async () => {
  const reads = [], files = syntheticSequence(165, reads);
  await request('load', { files });
  for (const index of [164, 3, 120, 1, 163, 164, 0]) {
    const { inferredUnwrap } = await request('trajectory-unwrap', { index, infer: true });
    assert.ok(Math.abs(inferredUnwrap.unwrappedPositions[0] - 10 * (.9 + .23 * index)) < 1e-4, `frame ${index + 1}`);
  }
});

test('CFG sequence frames resume from saved continuity and match a strict forward pass', async () => {
  const files = await sequence(12);
  await request('load', { files });
  const expected = [];
  for (let index = 0; index < files.length; index++) expected.push(signature(await continuousFrame(index)));

  await request('load', { files });
  // Backward seeks, repeats and the first frame, as prefetch and playback request
  // them. Each request parses only the files after the nearest saved state;
  // restarting from the first file every time would parse 43 files here.
  const order = [7, 3, 7, 11, 0, 5, 5, 10, 1, 11], parsedFiles = [];
  for (const index of order) {
    replies.length = 0;
    const frame = await continuousFrame(index);
    assert.equal(signature(frame), expected[index], `frame ${index}`);
    parsedFiles.push(replies.filter(message => message.stage === 'sequence-unwrap').length);
  }
  assert.deepEqual(parsedFiles, [7, 1, 1, 4, 0, 1, 1, 1, 1, 1]);
});

test('CFG header requests do not advance continuity or discard complete target properties', async () => {
  const files = await sequence(8);
  await request('load', { files });
  const full = await continuousFrame(7);
  const expected = signature(full);
  assert.ok(full.properties.length > 0, 'the displayed target remains a full frame');
  replies.length = 0;
  const { header } = await request('frame-header', { index: 3 });
  assert.equal(header.atomCount, full.ids.length);
  assert.deepEqual(header.cell, full.cell);
  assert.equal(header.frameIndex, 3);
  assert.equal(header.ids, undefined);
  assert.equal(replies.filter(message => message.stage === 'sequence-unwrap').length, 0);
  replies.length = 0;
  const again = await continuousFrame(7);
  assert.equal(signature(again), expected);
  assert.deepEqual(again.properties, full.properties);
  assert.equal(replies.filter(message => message.stage === 'sequence-unwrap').length, 1,
    'a header read leaves the existing near-target checkpoint intact');
});
