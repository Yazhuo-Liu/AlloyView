import test from 'node:test';
import assert from 'node:assert/strict';
import { createCell, cartesianToFractional } from '../src/data/model.js';
import { computeDisplacements, prepareDisplacements, calculatePreparedDisplacements } from '../src/analysis/displacement.js';
import { analyzeGpuDisplacement, prepareGpuDisplacementParameters } from '../src/analysis/gpu/displacement.js';

const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
function frame(positions, ids, cellValue = cell) {
  const values = Float64Array.from(positions);
  return { positions: values, fractional: cartesianToFractional(values, cellValue, new Float64Array(values.length)),
    ids: Int32Array.from(ids), cell: cellValue, idSource: 'explicit' };
}

test('prepared displacement preserves authoritative Cartesian arrays, unwrapped selection and shared derived inputs', async () => {
  const reference = frame([9.5, 2, 3], [1]), current = frame([.5, 2, 3], [1]);
  current.positions = Float32Array.from(current.positions);
  reference.unwrappedPositions = new Float64Array([19.5, 2, 3]);
  current.unwrappedPositions = new Float64Array([30.5, 2, 3]);
  const wrapped = await prepareDisplacements(current, reference), unwrapped = await prepareDisplacements(current, reference, { minimumImage: false });
  assert.equal(wrapped.currentPositions, current.positions);
  assert.equal(unwrapped.currentPositions, current.unwrappedPositions);
  assert.equal(unwrapped.referencePositions, reference.unwrappedPositions);
  const derived = { ...current, positions: undefined, unwrappedPositions: undefined };
  const first = await prepareDisplacements(derived, derived), second = await prepareDisplacements(derived, derived);
  assert.equal(first.currentPositions, first.referencePositions);
  assert.equal(first.currentPositions, second.currentPositions);
});

test('public CPU displacement still observes changed fractional coordinates when Cartesian positions are absent', async () => {
  const reference = frame([1, 1, 1], [1]), current = { ...reference, positions: undefined, fractional: reference.fractional.slice() };
  assert.deepEqual([...(await computeDisplacements(current, reference)).vectors], [0, 0, 0]);
  current.fractional[0] += .1;
  assert.deepEqual([...(await computeDisplacements(current, reference)).vectors], [1, 0, 0]);
});

test('prepared CPU ranges preserve stable IDs, unmatched NaNs and magnitudes from rounded vectors', async () => {
  const reference = frame([1, 2, 3, 4, 5, 6], [11, 22]), current = frame([4.13, 5.24, 6.35, 1, 3, 3, 0, 0, 0], [22, 11, 99]);
  const parameters = await prepareDisplacements(current, reference), full = calculatePreparedDisplacements(current, parameters);
  assert.deepEqual(full.vectors, (await computeDisplacements(current, reference)).vectors);
  for (let atom = 0; atom < 3; atom += 1) {
    const range = calculatePreparedDisplacements(current, { ...parameters, startAtom: atom, endAtom: atom + 1 });
    assert.deepEqual(range.vectors, full.vectors.subarray(atom * 3, atom * 3 + 3));
    assert.equal(range.magnitudes[0], full.magnitudes[atom]);
  }
  assert.equal(full.magnitudes[0], Math.hypot(...full.vectors.subarray(0, 3)));
  assert.ok(Number.isNaN(full.magnitudes[2]));
});

test('GPU displacement settings retain current triclinic matrices, periodic axes and source reference identity', async () => {
  const skew = createCell({ vectors: [10, 0, 0, 9, 1, 0, 0, 0, 10], pbc: [true, true, false], triclinic: true });
  const reference = frame([0, 0, 0], [1]), current = frame([9.31, .49, 1], [1], skew);
  const parameters = await prepareDisplacements(current, reference), prepared = prepareGpuDisplacementParameters(current, parameters);
  const integers = new Uint32Array(prepared.settings), floats = new Float32Array(prepared.settings);
  assert.deepEqual([...integers.subarray(0, 4)], [1, 0, 1, 0x7fc00000]);
  assert.deepEqual([...integers.subarray(4, 7)], [1, 1, 0]);
  assert.equal(integers[9], 0);
  assert.equal(floats[16 + 3 * 2] + floats[17 + 3 * 2], 9);
  assert.equal(prepared.referenceFrame, reference);
  assert.throws(() => prepareGpuDisplacementParameters(current, { ...parameters, referenceFrame: { ...reference, cell: skew } }), /match the displacement/);
  assert.throws(() => prepareGpuDisplacementParameters(current, { ...parameters, referenceMapping: new Int32Array([3]) }), /outside the reference/);
  const shared = await prepareDisplacements(current, current);
  assert.equal(new Uint32Array(prepareGpuDisplacementParameters(current, shared).settings)[7], 1);
});

test('GPU displacement returns existing Float32 arrows and Float64 magnitudes, with bounded exact image corrections', async () => {
  const reference = frame([0, 0, 0, 0, 0, 0], [1, 2]), current = frame([5 + 1e-8, 0, 0, 1, 2, 3, 0, 0, 0], [1, 2, 99]);
  const parameters = await prepareDisplacements(current, reference), expected = calculatePreparedDisplacements(current, parameters);
  const runtime = fakeRuntime(expected, new Uint32Array([2, 1, 0]));
  runtime.vectors[0] = 5;
  const actual = await analyzeGpuDisplacement(runtime, current, parameters);
  assert.deepEqual(actual.vectors, expected.vectors);
  assert.ok(actual.magnitudes instanceof Float64Array);
  actual.magnitudes.forEach((value, atom) => Number.isNaN(expected.magnitudes[atom])
    ? assert.ok(Number.isNaN(value)) : assert.ok(Math.abs(value - expected.magnitudes[atom]) < 1e-12));
  assert.equal(actual.gpuCorrectionAtoms, 1);
  assert.equal(actual.matched, 2); assert.equal(actual.unmatched, 1); assert.equal(actual.warning, null);
  assert.equal(runtime.disposed.length, 5); assert.equal(runtime.unpinned, 1);
  assert.deepEqual(runtime.variants, ['cartesian', 'cartesian']);
  assert.ok(parameters.currentPositions.byteLength > 0 && parameters.referenceMapping.byteLength > 0);
});

test('GPU normalized magnitude readback preserves a finite norm larger than Float32 max', async () => {
  const open = createCell({ vectors: cell.vectors, pbc: [false, false, false] });
  const reference = frame([0, 0, 0], [1], open), current = frame([3e38, 3e38, 3e38], [1], open);
  const parameters = await prepareDisplacements(current, reference, { minimumImage: false }), expected = calculatePreparedDisplacements(current, parameters);
  const actual = await analyzeGpuDisplacement(fakeRuntime(expected, new Uint32Array([1])), current, parameters);
  assert.ok(Number.isFinite(actual.magnitudes[0]) && actual.magnitudes[0] > 3.4028235e38);
  assert.ok(Math.abs(actual.magnitudes[0] / expected.magnitudes[0] - 1) < 1e-14);
});

test('GPU displacement cancellation after dispatch releases workspace and frame pins without a CPU retry', async () => {
  const count = 20_000, positions = new Float64Array(count * 3), ids = Int32Array.from({ length: count }, (_, atom) => atom + 1);
  const current = frame(positions, ids), parameters = await prepareDisplacements(current, current);
  const runtime = fakeRuntime({ vectors: new Float32Array(count * 3), magnitudes: new Float64Array(count) }, new Uint32Array(count).fill(1));
  const controller = new AbortController();
  await assert.rejects(analyzeGpuDisplacement(runtime, current, parameters, { signal: controller.signal, onProgress(progress) {
    if (progress.phase === 'analyzing' && progress.completedAtoms > 0) controller.abort();
  } }), { name: 'AbortError' });
  assert.equal(runtime.runs, 1); assert.equal(runtime.reads, 0);
  assert.equal(runtime.disposed.length, 5); assert.equal(runtime.unpinned, 1);
});

test('GPU displacement pre-dispatch failure and already cancelled requests release only allocated state', async () => {
  const current = frame([0, 0, 0], [1]), parameters = await prepareDisplacements(current, current);
  const runtime = fakeRuntime({ vectors: new Float32Array(3), magnitudes: new Float64Array(1) }, new Uint32Array([1]));
  runtime.prepareCartesianFrame = async () => { throw new Error('Upload failed.'); };
  await assert.rejects(analyzeGpuDisplacement(runtime, current, parameters), /Upload failed/);
  assert.equal(runtime.disposed.length, 0); assert.equal(runtime.unpinned, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(analyzeGpuDisplacement(runtime, current, parameters, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(runtime.unpinned, 1);
});

function fakeRuntime(expected, flags) {
  const magnitudes = new Float32Array(expected.magnitudes.length * 4);
  expected.magnitudes.forEach((value, atom) => {
    const vector = expected.vectors.subarray(atom * 3, atom * 3 + 3), scale = Math.max(...vector.map(Math.abs));
    const norm = scale ? value / scale : value, high = Math.fround(norm);
    magnitudes.set([high, norm - high, scale, 0], atom * 4);
  });
  return {
    disposed: [], unpinned: 0, variants: [], runs: 0, reads: 0, vectors: expected.vectors.slice(),
    pinFrames() { return () => { this.unpinned += 1; }; },
    async prepareCartesianFrame(_frame, positions, { variant }) { this.variants.push(variant); return { positionsBuffer: {}, anchor: positions.subarray(0, 3) }; },
    storageBuffer(array) { return { array }; }, createBuffer(bytes) { return { bytes }; }, write() {}, async run() { this.runs += 1; },
    async read() { const result = [this.vectors, magnitudes, flags][this.reads]; this.reads += 1; return result; },
    disposeBuffers(buffers) { this.disposed.push(...buffers); },
  };
}
