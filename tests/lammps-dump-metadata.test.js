import assert from 'node:assert/strict';
import test from 'node:test';
import { byteParserStatistics } from '../src/io/ascii-rows.js';
import { detectStructureFormatHeader } from '../src/io/file-sequences.js';
import { indexLammpsDump, parseLammpsFrame, readLammpsFrame } from '../src/io/lammps-dump.js';
import { openIndexedTrajectory } from '../src/workers/indexed-trajectory.js';
import { parseFrameDescriptor } from '../src/workers/frame-parser.js';

const encoder = new TextEncoder();
function dump({ before = '', after = '', columns = 'id type xs ys zs', rows = ['17 2 0.1 0.2 0.3'], count = rows.length, timestep = 0 } = {}) {
  return before + 'ITEM: TIMESTEP\n' + timestep + '\n' + after +
    'ITEM: NUMBER OF ATOMS\n' + count + '\nITEM: BOX BOUNDS pp pp pp\n0 10\n0 20\n0 30\nITEM: ATOMS ' +
    columns + '\n' + rows.join('\n') + '\n';
}
const canonical = frame => ({ ...frame, parseMs: 0 });

test('dump metadata before/after TIMESTEP preserves direct byte parsing and coordinate values', () => {
  const base = parseLammpsFrame(dump());
  for (const options of [
    { before: 'ITEM: UNITS\nmetal\nITEM: TIME\n0.25\n' },
    { before: 'ITEM: TIME\n0.25\n', after: 'ITEM: UNITS\nmetal\n' },
    { after: 'ITEM: TIME\n0.25\nITEM: UNITS\nmetal\n' },
  ]) {
    for (const endings of ['\n', '\r\n']) {
      const text = dump(options).replace(/\n/g, endings);
      const fallbacks = byteParserStatistics.fallbacks;
      const bytes = parseLammpsFrame(encoder.encode(text));
      assert.equal(byteParserStatistics.fallbacks, fallbacks);
      assert.deepEqual(canonical(bytes), canonical(parseLammpsFrame(text)));
      assert.deepEqual(bytes.positions, base.positions);
      assert.deepEqual(bytes.ids, base.ids);
      assert.equal(bytes.lammpsUnits, 'metal');
      assert.equal(bytes.simulationTime, 0.25);
      assert.equal(detectStructureFormatHeader(text), 'lammps-dump');
    }
  }
});

test('dump without type retains IDs, defaults to Type 1 and distinguishes explicit element labels', () => {
  for (const text of [
    dump({ columns: 'id xs ys zs', rows: ['17 0.1 0.2 0.3', '19 0.4 0.5 0.6'] }),
    dump({ columns: 'id element xs ys zs', rows: ['17 Fe 0.1 0.2 0.3', '19 Ni 0.4 0.5 0.6', '21 Fe 0.7 0.8 0.9'] }),
  ]) {
    const frame = parseLammpsFrame(text, 'Cu.dump');
    assert.deepEqual(canonical(parseLammpsFrame(encoder.encode(text), 'Cu.dump')), canonical(frame));
    assert.equal(frame.idSource, 'explicit');
    assert.equal(frame.ids[0], 17);
    if (text.includes('element')) {
      assert.deepEqual(frame.typeLabels, ['Fe', 'Ni']);
      assert.deepEqual([...frame.types], [0, 1, 0]);
    } else {
      assert.deepEqual(frame.typeLabels, ['Type 1']);
      assert.deepEqual([...frame.types], [0, 0]);
    }
  }
});

test('declared atom count is strict in text and bytes, including extra data after blanks', () => {
  for (const extra of ['19 2 0.4 0.5 0.6\n', '\n \t\n19 2 0.4 0.5 0.6\n', dump({ timestep: 1 })]) {
    const text = dump() + extra;
    assert.throws(() => parseLammpsFrame(text), /unexpected data after the declared 1 atom rows/);
    assert.throws(() => parseLammpsFrame(encoder.encode(text)), /unexpected data after the declared 1 atom rows/);
  }
  const text = dump() + '\n \t\r\n\u00a0\n';
  assert.deepEqual(canonical(parseLammpsFrame(encoder.encode(text))), canonical(parseLammpsFrame(text)));
});

test('optional metadata cannot hide incomplete, duplicate or nonnumeric values', () => {
  for (const [before, after, pattern] of [
    ['ITEM: UNITS\n', '', /requires a value/],
    ['ITEM: UNITS\nmetal\n', 'ITEM: UNITS\nreal\n', /UNITS is repeated/],
    ['ITEM: TIME\n0\n', 'ITEM: TIME\n1\n', /TIME is repeated/],
    ['', 'ITEM: TIME\nNaN\n', /not a finite number/],
  ]) {
    const text = dump({ before, after });
    for (const input of [text, encoder.encode(text)]) assert.throws(() => parseLammpsFrame(input), pattern);
  }
});

test('indexing keeps optional prefixes with their own frames through tiny chunk boundaries', async () => {
  const first = dump({ before: 'ITEM: UNITS\nmetal\nITEM: TIME\n0\n' });
  const second = dump({ before: 'ITEM: TIME\n0.5\n', after: 'ITEM: UNITS\nmetal\n', timestep: 10 });
  const third = dump({ after: 'ITEM: TIME\n1\n', timestep: 20 });
  for (const bom of ['', '\uFEFF']) {
    const file = new File([bom + first + second + third], 'metadata.dump');
    const prefixBytes = encoder.encode(bom + first).length;
    for (const chunkSize of [1, 2, 7, 15, 29, file.size]) {
      const emitted = [];
      const index = await indexLammpsDump(file, () => {}, { chunkSize, onFrame: d => emitted.push(d) });
      assert.deepEqual(index.offsets, [0, prefixBytes, prefixBytes + encoder.encode(second).length]);
      assert.equal(emitted.length, 3);
      for (let frame = 0; frame < 3; frame++) {
        const actual = await readLammpsFrame(file, index.offsets, frame);
        assert.equal(actual.timestep, frame * 10);
        assert.equal(actual.simulationTime, frame / 2);
      }
    }
    const opened = await openIndexedTrajectory([file], 'lammps-dump', { parse: parseFrameDescriptor, indexChunkSize: 17 });
    await opened.source.indexPromise;
    assert.equal(opened.source.frameCount, 3);
    assert.equal(opened.result.frame.simulationTime, 0);
    for (const descriptor of opened.source.descriptors) {
      assert.equal((await parseFrameDescriptor(descriptor)).timestep, descriptor.index * 10);
    }
  }
});
