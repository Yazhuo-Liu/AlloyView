import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell } from '../src/data/model.js';
import { createReplication, normalizeRepetitions } from '../src/render/replication.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

const cell = () => createCell({
  origin: [3, -2, 1],
  vectors: [4, 1, 0, -2, 3, 1, 1, -1, 5],
  pbc: [true, true, true], triclinic: true,
});

test('replication follows all three skew cell vectors and preserves the source cell', () => {
  const source = cell(), original = [...source.vectors];
  const result = createReplication(source, [2, 3, 2]);
  assert.equal(result.replicas.length, 12);
  assert.deepEqual(result.replicas.at(-1), { indices: [1, 2, 1], offset: [1, 6, 7] });
  assert.deepEqual([...result.displayCell.vectors], [8, 2, 0, -6, 9, 3, 2, -2, 10]);
  assert.deepEqual([...source.vectors], original);
  assert.deepEqual([...source.origin], [3, -2, 1]);
  assert.deepEqual(result.minimumOffset, [-4, -1, 0]);
  assert.deepEqual(result.maximumOffset, [5, 7, 7]);
});

test('only periodic directions can repeat and invalid or excessive counts are rejected', () => {
  assert.deepEqual(normalizeRepetitions([3, 20, 2], [true, false, true]), [3, 1, 2]);
  assert.deepEqual(createReplication(cell()).repetitions, [1, 1, 1]);
  for (const counts of [[0, 1, 1], [-1, 1, 1], [1.5, 1, 1], [NaN, 1, 1], [17, 17, 17], [4097, 1, 1]]) {
    assert.throws(() => normalizeRepetitions(counts, [true, true, true]));
  }
});

test('display replication uploads only the outer box and retains one set of atom buffers', () => {
  const renderer = Object.create(WebGLRenderer.prototype);
  const sourceCell = cell();
  const positions = new Float32Array([3, -2, 1, 4, -1, 2]);
  const property = { data: new Float32Array([0, 0.1]) };
  const frame = { ids: new Int32Array([1, 2]), positions, cell: sourceCell, properties: [property] };
  const uploads = [];
  renderer.frame = frame;
  renderer.atomCount = 2;
  renderer.displayPositions = positions;
  renderer.cellBuffer = {};
  renderer.gl = {
    ARRAY_BUFFER: 1, STATIC_DRAW: 2,
    bindBuffer(target, buffer) { assert.equal(buffer, renderer.cellBuffer); },
    bufferData(target, values) { uploads.push(values); },
  };
  renderer.requestRender = () => {};
  renderer.setReplications([2, 3, 2]);
  assert.equal(renderer.displayAtomCount, 24);
  assert.equal(renderer.atomCount, 2);
  assert.equal(renderer.frame, frame);
  assert.equal(renderer.displayPositions, positions);
  assert.equal(frame.properties[0], property);
  assert.equal(frame.cell, sourceCell);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].length, 72);
  renderer.setReplications([1, 1, 1]);
  assert.equal(renderer.displayAtomCount, 2);
});

test('camera encloses replicated unwrapped atoms, including negative vector directions', () => {
  const renderer = Object.create(WebGLRenderer.prototype);
  renderer.frame = { cell: cell() };
  renderer.displayPositions = new Float32Array([-10, 20, -5, 30, -8, 40]);
  Object.assign(renderer, createReplication(renderer.frame.cell, [2, 3, 2]));
  renderer.fov = 40 * Math.PI / 180;
  renderer.requestRender = () => {};
  renderer.resetCamera();
  // Atomic extrema [-14,-9,-5] .. [35,27,47] exceed the outer cell.
  assert.deepEqual(renderer.target, [10.5, 9, 21]);
  assert.equal(renderer.modelRadius, Math.hypot(49, 36, 52) / 2);
});

test('replicated selection and picking share the expanded slice and visibility mask', () => {
  const renderer = Object.create(WebGLRenderer.prototype);
  renderer.frame = { fractional: new Float32Array([0.75, 0.2, 0.3]) };
  renderer.repetitions = [2, 1, 1];
  renderer.sliceAxis = 0;
  renderer.sliceMaximum = 0.5;
  renderer.visibility = new Uint8Array([255]);
  assert.equal(renderer.isAtomVisible(0), true, 'the first copy lies at 0.375 in the expanded cell');
  assert.equal(renderer.isAtomVisible(0, [1, 0, 0]), false, 'the second copy lies at 0.875');
  renderer.visibility[0] = 0;
  assert.equal(renderer.isAtomVisible(0), false);
  renderer.visibility[0] = 255;
  renderer.repetitions = [1, 1, 1];
  assert.equal(renderer.isAtomVisible(0), false, 'resetting replication restores the source-cell slice');
});
