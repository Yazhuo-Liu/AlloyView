import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell, frameTransferables, validateFrame } from '../src/data/model.js';
import { physicalReplicationPlan, replicateFrame } from '../src/data/replicate.js';
import { ColorQuantityResolver } from '../src/render/color-quantities.js';
import { estimateFrameBytes } from '../src/data/cache-policy.js';
import { computeDisplacements } from '../src/analysis/displacement.js';
import { ensureFileUnwrappedPositions } from '../src/data/coordinate-display.js';

const cartesian = ([x, y, z]) => [1 + 10 * x + 2 * y + z, 2 + 8 * y + z, 3 + 6 * z];
function source() {
  const cell = createCell({ origin: [1, 2, 3], vectors: [10, 0, 0, 2, 8, 0, 1, 1, 6], pbc: [true, true, true], triclinic: true });
  return { cell, ids: Float64Array.of(1), idSource: 'explicit', types: Uint16Array.of(0), typeLabels: ['Fe'], properties: [],
    fractional: Float64Array.from([.9, .2, .3]), positions: Float64Array.from(cartesian([.9, .2, .3])),
    filePositions: Float64Array.from(cartesian([-.1, .2, .3])), imageFlags: Int32Array.of(3, -1, 2),
    unwrapSource: 'ix/iy/iz', sourceFormat: 'cfg' };
}
function near(actual, expected, tolerance = 1e-5) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance, `${value} != ${expected[index]}`));
}

test('default position colors use source coordinates without materializing image shifts', () => {
  const frame = source(), resolver = new ColorQuantityResolver();
  near(resolver.resolve(frame, 'builtin:position:x').data, [.7]);
  assert.equal(frame.unwrappedPositions, undefined);
  near(resolver.resolve(frame, 'builtin:position:x', { coordinateMode: 'wrapped' }).data, [10.7]);
  assert.equal(frame.unwrappedPositions, undefined);
  const file = resolver.resolve(frame, 'builtin:position:x', { coordinateMode: 'file' });
  assert.match(file.displayName, /file/);
  assert.equal(resolver.resolve(frame, 'builtin:position:x', { coordinateMode: 'file' }), file);
});

test('source positions transfer once, retain their own storage, and count in the frame budget', () => {
  const frame = source(), base = { ...frame }; delete base.filePositions;
  assert.equal(estimateFrameBytes(frame) - estimateFrameBytes(base), frame.filePositions.byteLength);
  assert.equal(estimateFrameBytes({ ...base, filePositions: base.positions }), estimateFrameBytes(base));
  const transfers = frameTransferables(frame);
  assert.equal(transfers.filter(buffer => buffer === frame.filePositions.buffer).length, 1);
  const transferred = structuredClone(frame, { transfer: transfers });
  assert.equal(frame.filePositions.byteLength, 0);
  near(transferred.filePositions, [.7, 3.9, 4.8]);
  assert.equal(validateFrame(transferred), transferred);
  assert.throws(() => validateFrame({ ...transferred, filePositions: new Float32Array(6) }), /file coordinate array length/);
});

test('physical copies expand source display positions without applying image counters to them', async () => {
  const frame = source(), before = frame.filePositions.slice();
  frame.inferredUnwrap = { imageFlags: Int32Array.of(9, 9, 9), unwrappedPositions: Float32Array.of(99, 99, 99) };
  const result = await replicateFrame(frame, [2, 1, 1]);
  assert.equal(result.filePositions.length, 6);
  near(result.filePositions, [.7, 3.9, 4.8, 10.7, 3.9, 4.8]);
  near(result.unwrappedPositions, [40.7, -2.1, 16.8, 50.7, -2.1, 16.8]);
  assert.notDeepEqual(result.positions, result.filePositions);
  assert.equal(result.inferredUnwrap, undefined);
  assert.deepEqual(frame.filePositions, before);
  assert.equal(frame.unwrappedPositions, undefined, 'replication does not materialize into its source');
  const base = { ...frame }; delete base.filePositions;
  const noImages = { ...base }; delete noImages.imageFlags;
  const withoutFile = physicalReplicationPlan(noImages, [2, 1, 1]);
  const withFile = physicalReplicationPlan({ ...noImages, filePositions: frame.filePositions }, [2, 1, 1]);
  assert.equal(withFile.estimatedBytes - withoutFile.estimatedBytes, 6 * Float64Array.BYTES_PER_ELEMENT);
  assert.throws(() => physicalReplicationPlan({ ...frame, filePositions: new Float32Array(1) }, [2, 1, 1]), /incomplete/);
});

test('deferred image counters remain exact for requested total displacement while minimum-image reads stay lazy', async () => {
  const reference = source(), current = source();
  reference.fractional = Float64Array.of(.95, .2, .3);
  reference.positions = Float64Array.from(cartesian(reference.fractional));
  reference.imageFlags = Int32Array.of(0, 0, 0);
  current.fractional = Float64Array.of(.05, .2, .3);
  current.positions = Float64Array.from(cartesian(current.fractional));
  current.imageFlags = Int32Array.of(1, 0, 0);
  const wrappedPositions = current.positions.slice();
  near((await computeDisplacements(current, reference)).vectors, [1, 0, 0]);
  assert.equal(reference.unwrappedPositions, undefined); assert.equal(current.unwrappedPositions, undefined);
  near((await computeDisplacements(current, reference, { minimumImage: false })).vectors, [1, 0, 0]);
  assert.ok(current.unwrappedPositions);
  assert.deepEqual(current.positions, wrappedPositions);
});

test('single-frame reconstruction ignores image counters along open cell directions', () => {
  const frame = source();
  frame.cell.pbc = [true, false, true];
  near(ensureFileUnwrappedPositions(frame), cartesian([3.9, .2, 2.3]));
});
