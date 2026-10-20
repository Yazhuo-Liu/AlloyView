import assert from 'node:assert/strict';
import test from 'node:test';
import { createGzip, constants, gzipSync } from 'node:zlib';
import { once } from 'node:events';
import { openIndexedTrajectory } from '../src/workers/indexed-trajectory.js';
import { parseFrameDescriptor } from '../src/workers/frame-parser.js';
import { crystalFrame, dumpText } from './helpers/crystals.js';

// A real, single-member gzip stream flushed at a chosen decoded boundary.
// Its final compressed bytes remain unavailable until release() is called.
async function gatedGzip(text, prefixEnd, name, { truncate = 0 } = {}) {
  const compressor = createGzip();
  const pieces = [];
  compressor.on('data', chunk => pieces.push(chunk));
  const finished = once(compressor, 'end');
  compressor.write(Buffer.from(text).subarray(0, prefixEnd));
  await new Promise((resolve, reject) => compressor.flush(constants.Z_SYNC_FLUSH, error => error ? reject(error) : resolve()));
  const split = pieces.reduce((sum, part) => sum + part.length, 0);
  compressor.end(Buffer.from(text).subarray(prefixEnd));
  await finished;
  const complete = Buffer.concat(pieces);
  const bytes = complete.subarray(0, complete.length - truncate);
  const native = new File([bytes], name);
  let controller, cancelled = false, released = false, streamed = 0;
  const file = { name, size: native.size, lastModified: native.lastModified,
    slice(start, end) {
      const blob = native.slice(start, end);
      if (start !== 0 || end !== native.size) return blob;
      return { stream: () => new ReadableStream({
        start(output) { controller = output; output.enqueue(bytes.subarray(0, split)); streamed += split; },
        cancel() { cancelled = true; },
      }) };
    },
  };
  return { file, get streamed() { return streamed; }, get cancelled() { return cancelled; },
    release() {
      if (released || cancelled) return;
      released = true; streamed += bytes.length - split;
      controller.enqueue(bytes.subarray(split)); controller.close();
    },
  };
}

const atom = 'ATOM      7  CA  ALA A   1       1.000   2.000   3.000  1.00 12.50           C  ';
const cell = 'CRYST1   10.000   11.000   12.000  90.00  90.00  90.00 P 1           1';
const dump = '\uFEFFITEM: UNITS\nmetal\n' + dumpText([crystalFrame('bcc', 1, 3.3), crystalFrame('bcc', 1, 3.4)]);
const cases = [
  { format: 'xyz', text: '1\n第一帧\nFe 0 0 0\n1\nsecond\nFe 1 2 3\n', prefix: '1\n第一帧\nFe 0 0 0\n' },
  { format: 'lammps-dump', text: dump, prefix: dump.slice(0, dump.indexOf('ITEM: TIMESTEP', dump.indexOf('ITEM: TIMESTEP') + 1) + 'ITEM: TIMESTEP\n'.length) },
  { format: 'pdb', text: `${cell}\nMODEL        1\n${atom}\nENDMDL\nTITLE     second\nMODEL        2\n${atom}\nENDMDL\n`,
    prefix: `${cell}\nMODEL        1\n${atom}\nENDMDL\n` },
];

for (const { format, text, prefix } of cases) test(`${format}: first gzip frame is usable before compressed EOF; all bytes/projections stay exact`, async () => {
  const name = `trajectory.${format}.gz`;
  const gate = await gatedGzip(text, Buffer.byteLength(prefix), name);
  const opening = openIndexedTrajectory([gate.file], format, { parse: parseFrameDescriptor, indexChunkSize: 7 });
  // A bounded test deadline detects the old all-decompressed-before-index path.
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('First frame waited for gzip EOF.')), 10_000); });
  let opened;
  try { opened = await Promise.race([opening, timeout]); }
  finally { clearTimeout(timer); gate.release(); }
  assert.equal(opened.result.indexComplete, false);
  assert.equal(opened.result.frameCount, 1);
  await opened.source.indexPromise;
  const plain = await openIndexedTrajectory([new File([text], name)], format, { parse: parseFrameDescriptor, indexChunkSize: 7 });
  await plain.source.indexPromise;
  assert.equal(opened.source.frameCount, 2);
  for (let index = 0; index < 2; index++) {
    const actual = opened.source.descriptors[index], expected = plain.source.descriptors[index];
    assert.equal(actual.file.size, actual.end, 'retained File contains one frame, not the growing prefix');
    assert.deepEqual(new Uint8Array(await actual.file.arrayBuffer()), new Uint8Array(await expected.file.slice(expected.start, expected.end).arrayBuffer()));
    for (const projection of ['full', 'coordinates', 'header']) {
      const next = await parseFrameDescriptor({ ...actual, projection });
      const reference = await parseFrameDescriptor({ ...expected, projection });
      assert.deepEqual({ ...next, parseMs: 0 }, { ...reference, parseMs: 0 });
    }
  }
});

test('cancelling after first gzip delivery aborts the blocked stream and never publishes its last dump frame', async () => {
  const { text, prefix, format } = cases[1];
  const gate = await gatedGzip(text, Buffer.byteLength(prefix), 'cancel.dump.gz');
  const controller = new AbortController();
  const opened = await openIndexedTrajectory([gate.file], format, { parse: parseFrameDescriptor, signal: controller.signal });
  assert.equal(opened.source.frameCount, 1);
  assert.ok(gate.streamed < gate.file.size);
  const rejected = assert.rejects(opened.source.indexPromise, { name: 'AbortError' });
  controller.abort();
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gate.cancelled, true);
  assert.equal(opened.source.frameCount, 1);
});

test('a truncated gzip reports a late decompression error and never guesses a final dump boundary', async () => {
  const { text, prefix, format } = cases[1];
  const gate = await gatedGzip(text, Buffer.byteLength(prefix), 'truncated.dump.gz', { truncate: 6 });
  const opened = await openIndexedTrajectory([gate.file], format, { parse: parseFrameDescriptor });
  assert.equal(opened.source.frameCount, 1);
  gate.release();
  await assert.rejects(opened.source.indexPromise, /could not be decompressed/);
  assert.equal(opened.source.frameCount, 1);
  assert.equal(opened.source.indexComplete, true);
});

test('gzip failure before any complete frame rejects the candidate and publishes its error', async () => {
  const compressed = gzipSync('2\nmissing atom\nFe 0 0 0\n');
  const notices = [];
  await assert.rejects(openIndexedTrajectory([new File([compressed.subarray(0, compressed.length - 6)], 'broken.xyz.gz')], 'xyz', {
    parse: parseFrameDescriptor, onIndex: info => notices.push(info),
  }), /could not be decompressed/);
  assert.equal(notices.at(-1).frameCount, 0);
  assert.equal(notices.at(-1).indexComplete, true);
  assert.match(notices.at(-1).error, /could not be decompressed/);
});

test('gzip sequence order and newline-free final frames match uncompressed indexing', async () => {
  const inputs = [new File([gzipSync('1\nten\nFe 10 0 0')], 'frame10.xyz.gz'),
    new File([gzipSync('1\ntwo\nFe 2 0 0')], 'frame2.xyz.gz')];
  const opened = await openIndexedTrajectory(inputs, 'xyz', { parse: parseFrameDescriptor, indexChunkSize: 1 });
  await opened.source.indexPromise;
  assert.equal(opened.source.frameCount, 2);
  assert.equal(opened.result.frame.positions[0], 2);
  assert.equal((await parseFrameDescriptor(opened.source.descriptors[1])).positions[0], 10);
});

test('a long Unicode XYZ comment spanning many streamed chunks preserves the following frame boundaries', async () => {
  const text = `1\n${'边界'.repeat(5000)}\nFe 1 2 3\n1\nnext\nNi 4 5 6`;
  const opened = await openIndexedTrajectory([new File([gzipSync(text)], 'long.xyz.gz')], 'xyz', {
    parse: parseFrameDescriptor, indexChunkSize: 17,
  });
  await opened.source.indexPromise;
  assert.equal(opened.source.frameCount, 2);
  assert.equal(opened.result.frame.comment, '边界'.repeat(5000));
  assert.deepEqual(Array.from((await parseFrameDescriptor(opened.source.descriptors[1])).positions), [4, 5, 6]);
});

test('large gzip frames seal bounded Blob parts instead of one Blob per decompressor chunk', async () => {
  const first = `1\n${'x'.repeat(9 * 1024 ** 2)}\nFe 1 2 3\n`;
  const input = new File([gzipSync(first + '1\nnext\nNi 4 5 6\n')], 'large-comment.xyz.gz');
  const NativeBlob = globalThis.Blob, rawParts = [];
  globalThis.Blob = class extends NativeBlob {
    constructor(parts, options) {
      super(parts, options);
      const bytes = parts.reduce((sum, part) => sum + (ArrayBuffer.isView(part) ? part.byteLength : 0), 0);
      if (bytes) rawParts.push(bytes);
    }
  };
  try {
    const opened = await openIndexedTrajectory([input], 'xyz', { parse: async descriptor => ({ bytes: descriptor.file.size }) });
    await opened.source.indexPromise;
    assert.equal(opened.result.frame.bytes, first.length);
    assert.equal(await opened.source.descriptors[0].file.text(), first);
    assert.ok(rawParts.includes(8 * 1024 ** 2));
    assert.ok(rawParts.every(bytes => bytes <= 8 * 1024 ** 2));
    assert.ok(rawParts.length <= 4, 'stream chunks are batched into bounded parts and complete frames');
  } finally { globalThis.Blob = NativeBlob; }
});
