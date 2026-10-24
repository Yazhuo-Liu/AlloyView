import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCfg } from '../src/io/cfg.js';
import { fileDisplayPositions } from '../src/data/coordinate-display.js';
import { TrajectoryProcessor } from '../src/workers/trajectory-processor.js';

function text(x, { image = null, length = 10 } = {}) {
  const images = image !== null;
  return `Number of particles = 1\nH0(1,1) = ${length}\nH0(1,2) = 0\nH0(1,3) = 0\nH0(2,1) = 0\nH0(2,2) = 10\nH0(2,3) = 0\nH0(3,1) = 0\nH0(3,2) = 0\nH0(3,3) = 10\n.NO_VELOCITY.\nentry_count = ${images ? 7 : 4}\n${images ? 'auxiliary[0] = ix\nauxiliary[1] = iy\nauxiliary[2] = iz\nauxiliary[3] = id' : 'auxiliary[0] = id'}\n55.845\nFe\n${x} .2 .3 ${images ? `${image} 0 0 ` : ''}1\n`;
}
function fixture(inputs) {
  const reads = [];
  const read = index => parseCfg(inputs[index], `frame.${index}.cfg`, { projection: 'coordinates', deferUnwrap: true });
  const processor = new TrajectoryProcessor({ readFrame: async index => { reads.push(index); return read(index); }, getFrameCount: () => inputs.length });
  return { read, reads, processor };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 2e-5, `${actual} != ${expected}`);

test('smoothing preserves source out-of-cell positions separately from wrapped analysis geometry', async () => {
  const { read, processor } = fixture([text(1.2), text(1.3)]);
  const frame = read(0);
  assert.equal(frame.unwrappedPositions, undefined);
  await processor.prepare(frame, 0, { smoothing: 1 });
  near(frame.positions[0], 2.5);
  near(fileDisplayPositions(frame)[0], 12.5);
  near(frame.unwrappedPositions[0], 12.5);
});

test('smoothing distinguishes source file images from explicit image counters and includes the averaged cell', async () => {
  const { read, processor } = fixture([text(1.2, { image: 3, length: 10 }), text(1.3, { image: 3, length: 12 })]);
  const frame = read(0);
  await processor.prepare(frame, 0, { smoothing: 1 });
  near(frame.cell.vectors[0], 11);
  near(frame.positions[0], 2.75);
  near(fileDisplayPositions(frame)[0], 13.75);
  near(frame.unwrappedPositions[0], 35.75);
});

test('source-boundary display smoothing does not invent image counts or inferred history', async () => {
  const { read, processor } = fixture([text(1), text(0)]);
  const frame = read(0);
  await processor.prepare(frame, 0, { smoothing: 1 });
  near(fileDisplayPositions(frame)[0], 10);
  near(frame.positions[0], 0);
  assert.equal(frame.unwrappedPositions, undefined);
  assert.equal(frame.imageFlags, undefined);
  assert.equal(frame.inferredUnwrap, undefined);
});

test('cached deferred file metadata survives line generation with complete buffer accounting', async () => {
  const { processor } = fixture([text(1.2, { image: 3 }), text(1.3, { image: 3 })]);
  const snapshot = await processor.coordinates(0);
  assert.ok(snapshot.filePositions); assert.ok(snapshot.imageFlags);
  assert.equal(snapshot.unwrapSource, 'ix/iy/iz');
  assert.equal(snapshot.unwrappedPositions, null);
  const expected = 256 + [...new Set([snapshot.ids.buffer, snapshot.fractional.buffer, snapshot.filePositions.buffer,
    snapshot.imageFlags.buffer, snapshot.cell.origin.buffer, snapshot.cell.vectors.buffer])].reduce((sum, buffer) => sum + buffer.byteLength, 0);
  assert.equal(processor.storeBytes, expected);
  const lines = await processor.lines({ ids: [1], first: 0, last: 1, stride: 1 });
  near(lines.vertices[0], 32); near(lines.vertices[4], 33);
  assert.equal(snapshot.unwrappedPositions, null, 'line-only derived buffers are not leaked into uncharged raw cache entries');
});

test('coordinate snapshots keep aliases of source and continuous positions without double allocation', () => {
  const { read, processor } = fixture([text(1.2)]);
  const frame = read(0);
  frame.unwrappedPositions = frame.filePositions;
  const snapshot = processor.remember(0, frame, { copy: true });
  assert.equal(snapshot.filePositions, snapshot.unwrappedPositions);
  assert.notEqual(snapshot.filePositions, frame.filePositions);
  assert.equal([...processor.store.get(0).references.keys()].filter(buffer => buffer === snapshot.filePositions.buffer).length, 1);
});
