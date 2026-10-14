import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

test('CFG sequence frames resume from saved continuity and match a strict forward pass', async () => {
  const files = await sequence(12);
  await request('load', { files });
  const expected = [];
  for (let index = 0; index < files.length; index++) expected.push(signature((await request('frame', { index })).frame));

  await request('load', { files });
  // Backward seeks, repeats and the first frame, as prefetch and playback request
  // them. Each request parses only the files after the nearest saved state;
  // restarting from the first file every time would parse 43 files here.
  const order = [7, 3, 7, 11, 0, 5, 5, 10, 1, 11], parsedFiles = [];
  for (const index of order) {
    replies.length = 0;
    const { frame } = await request('frame', { index });
    assert.equal(signature(frame), expected[index], `frame ${index}`);
    parsedFiles.push(replies.filter(message => message.stage === 'sequence-unwrap').length);
  }
  assert.deepEqual(parsedFiles, [7, 1, 1, 4, 0, 1, 1, 1, 1, 1]);
});

test('CFG header requests do not advance continuity or discard complete target properties', async () => {
  const files = await sequence(8);
  await request('load', { files });
  const full = (await request('frame', { index: 7 })).frame;
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
  const again = (await request('frame', { index: 7 })).frame;
  assert.equal(signature(again), expected);
  assert.deepEqual(again.properties, full.properties);
  assert.equal(replies.filter(message => message.stage === 'sequence-unwrap').length, 1,
    'a header read leaves the existing near-target checkpoint intact');
});
