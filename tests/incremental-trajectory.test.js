import assert from 'node:assert/strict';
import test from 'node:test';
import { openIndexedTrajectory } from '../src/workers/indexed-trajectory.js';
import { parseFrameDescriptor } from '../src/workers/frame-parser.js';
import { indexXyz, readXyzFrame } from '../src/io/xyz.js';
import { indexLammpsDump, readLammpsFrame } from '../src/io/lammps-dump.js';
import { indexPdb, readPdbFrame } from '../src/io/pdb.js';
import { crystalFrame, dumpText } from './helpers/crystals.js';

function delayedFile(text, name, after) {
  const file = new File([text], name);
  let unblock;
  const wait = new Promise(resolve => { unblock = resolve; });
  const delayed = { name, size: file.size, type: file.type, text: file.text.bind(file), arrayBuffer: file.arrayBuffer.bind(file),
    slice(start, end) {
      const blob = file.slice(start, end);
      return { text: async () => { if (start >= after) await wait; return blob.text(); },
        arrayBuffer: async () => { if (start >= after) await wait; return blob.arrayBuffer(); } };
    } };
  return { file, delayed, unblock };
}

test('the first XYZ frame becomes available before the remaining single-file index is read', async () => {
  const { file, delayed, unblock } = delayedFile('1\nfirst\nFe 0 0 0\n1\nsecond\nFe 1 2 3\n', 'trajectory.xyz', 20);
  const snapshots = [];
  const opened = await openIndexedTrajectory([delayed], 'xyz', { parse: parseFrameDescriptor, indexChunkSize: 20, onIndex: info => snapshots.push(info) });
  assert.equal(opened.result.frame.positions[0], 0);
  assert.equal(opened.result.frameCount, 1);
  assert.equal(opened.result.indexComplete, false);
  unblock();
  await opened.source.indexPromise;
  const indexed = await indexXyz(file);
  assert.equal(opened.source.frameCount, 2);
  assert.equal(snapshots.at(-1).indexComplete, true);
  const next = await parseFrameDescriptor(opened.source.descriptors[1]);
  const expected = await readXyzFrame(file, indexed.offsets, 1, file.name);
  assert.deepEqual({ ...next, parseMs: 0 }, { ...expected, parseMs: 0 });
});

test('a complete dump frame is published at its next timestep boundary, with exact byte ranges', async () => {
  const text = dumpText([crystalFrame('bcc', 1, 3.3), crystalFrame('bcc', 1, 3.4)]);
  const secondStart = text.indexOf('ITEM: TIMESTEP', 1);
  const gate = secondStart + 'ITEM: TIMESTEP'.length + 1;
  const { file, delayed, unblock } = delayedFile(text, 'trajectory.dump', gate);
  const opened = await openIndexedTrajectory([delayed], 'lammps-dump', { parse: parseFrameDescriptor, indexChunkSize: gate });
  assert.equal(opened.result.indexComplete, false);
  assert.equal(opened.source.descriptors[0].end, secondStart);
  unblock();
  await opened.source.indexPromise;
  const indexed = await indexLammpsDump(file);
  for (let index = 0; index < 2; index++) {
    const actual = await parseFrameDescriptor(opened.source.descriptors[index]);
    const expected = await readLammpsFrame(file, indexed.offsets, index, file.name);
    assert.deepEqual(actual.positions, expected.positions);
    assert.deepEqual(actual.cell, expected.cell);
    assert.deepEqual(actual.ids, expected.ids);
  }
});

test('PDB progressive models preserve per-model headers including later cell changes', async () => {
  const atom = 'ATOM      7  CA  ALA A   1       1.000   2.000   3.000  1.00 12.50           C  ';
  const cell = 'CRYST1   10.000   11.000   12.000  90.00  90.00  90.00 P 1           1';
  const file = new File([`MODEL        1\n${atom}\nENDMDL\n${cell}\nTITLE     later title\nMODEL        2\n${atom}\nENDMDL\n`], 'trajectory.pdb');
  const opened = await openIndexedTrajectory([file], 'pdb', { parse: parseFrameDescriptor, indexChunkSize: 17 });
  await opened.source.indexPromise;
  const indexed = await indexPdb(file);
  for (let index = 0; index < 2; index++) {
    const actual = await parseFrameDescriptor(opened.source.descriptors[index]);
    const expected = await readPdbFrame(file, indexed, index, file.name);
    assert.deepEqual(actual.positions, expected.positions);
    assert.deepEqual(actual.cell, expected.cell);
    assert.equal(actual.comment, expected.comment);
  }
});

test('late malformed frames report an indexing failure after first-frame delivery', async () => {
  const { delayed, unblock } = delayedFile('1\nfirst\nFe 0 0 0\n2\nsecond\nFe 1 2 3\n', 'broken.xyz', 20);
  const snapshots = [];
  const opened = await openIndexedTrajectory([delayed], 'xyz', { parse: parseFrameDescriptor, indexChunkSize: 20, onIndex: info => snapshots.push(info) });
  assert.equal(opened.result.frame.ids.length, 1);
  unblock();
  await assert.rejects(opened.source.indexPromise, /truncated/);
  assert.equal(snapshots.at(-1).indexComplete, true);
  assert.match(snapshots.at(-1).error, /truncated/);
});
