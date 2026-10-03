import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell } from '../src/data/model.js';
import { AtomPrimitiveLayer, bondDisplayShifts, createPrimitiveMesh, parsePrimitiveColor, validateBonds } from '../src/render/atom-primitives.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

const cell = createCell({ vectors: [10, 0, 0, 3, 8, 0, -2, 1, 7] });

test('bond image shifts follow skew vectors and unwrapped atom positions', () => {
  const frame = { cell, positions: new Float32Array([1, 2, 3, 9, 2, 3]) };
  const result = { indices: new Uint32Array([0, 1]), vectors: new Float32Array([-2, 0, 0]), shifts: new Int32Array([-1, 0, 0]), count: 1 };
  assert.equal(bondDisplayShifts(result, frame), result.shifts);
  const unwrapped = new Float32Array([1, 2, 3, -1, 2, 3]);
  assert.deepEqual([...bondDisplayShifts(result, frame, unwrapped)], [0, 0, 0]);
  const skew = { ...result, vectors: new Float32Array([11, 8, 0]), shifts: undefined };
  assert.deepEqual([...bondDisplayShifts(skew, frame)], [0, 1, 0]);
});

test('bond arrays retain periodic self edges and reject malformed endpoints', () => {
  const result = { indices: new Uint32Array([0, 0]), vectors: new Float32Array([10, 0, 0]), shifts: new Int32Array([1, 0, 0]), count: 1 };
  const validated = validateBonds(result, 1);
  assert.equal(validated.indices, result.indices);
  assert.equal(validated.vectors, result.vectors);
  assert.throws(() => validateBonds({ ...result, count: 2 }, 1), /bond count/);
  assert.throws(() => validateBonds({ ...result, indices: new Uint32Array([0, 1]) }, 1), /endpoint/);
  assert.throws(() => validateBonds({ ...result, vectors: new Float32Array([NaN, 0, 0]) }, 1), /finite/);
  assert.throws(() => validateBonds({ ...result, shifts: new Float32Array([1, 0, 0]) }, 1), /bond count/);
});

test('cylinders and arrow cones have actual outward-facing, capped triangle geometry', () => {
  for (const cone of [false, true]) {
    const mesh = createPrimitiveMesh(cone, 8);
    assert.equal(mesh.length % 18, 0);
    assert.ok([...mesh].every(Number.isFinite));
    let tipCount = 0;
    for (let index = 0; index < mesh.length; index += 18) {
      const a = mesh.subarray(index, index + 3), b = mesh.subarray(index + 6, index + 9), c = mesh.subarray(index + 12, index + 15);
      const ab = b.map((value, axis) => value - a[axis]), ac = c.map((value, axis) => value - a[axis]);
      const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const normal = mesh.subarray(index + 3, index + 6);
      assert.ok(cross.reduce((sum, value, axis) => sum + value * normal[axis], 0) > 0, 'winding agrees with the surface normal');
      for (const point of [a, b, c]) if (point[0] === 0 && point[1] === 0 && point[2] === 1) tipCount += 1;
    }
    assert.equal(tipCount, 8);
  }
});

test('vector colors accept hex and normalized RGB without silently changing invalid input', () => {
  assert.deepEqual(parsePrimitiveColor('#ff8000'), [1, 128 / 255, 0]);
  assert.deepEqual(parsePrimitiveColor(new Float32Array([0, 0.5, 1])), [0, 0.5, 1]);
  assert.throws(() => parsePrimitiveColor('#f00'), /six-digit/);
  assert.throws(() => parsePrimitiveColor([256, 0, 0]), /between/);
});

function layerFixture() {
  const layer = Object.create(AtomPrimitiveLayer.prototype), uploads = [];
  let bound;
  layer.gl = { ARRAY_BUFFER: 1, STATIC_DRAW: 2,
    bindBuffer(target, buffer) { bound = buffer; },
    bufferData(target, values) { uploads.push({ buffer: bound, values }); } };
  layer.bondOptions = { visible: true, radius: 0.08 };
  layer.vectorOptions = { visible: true, scale: 1, radius: 0.06, color: [1, 0.5, 0] };
  layer.bondBuffers = { indices: {}, vectors: {}, shifts: {}, count: 0 };
  layer.vectorBuffers = { indices: {}, vectors: {}, shifts: {}, count: 0 };
  return { layer, uploads };
}

test('bond display options reuse analysis arrays and instance uploads', () => {
  const { layer, uploads } = layerFixture();
  const renderer = { atomCount: 2, frame: { cell, positions: new Float32Array([0, 0, 0, 1, 0, 0]) } };
  renderer.displayPositions = renderer.frame.positions;
  const result = { indices: new Uint32Array([0, 1]), vectors: new Float32Array([1, 0, 0]), shifts: new Int32Array(3), count: 1 };
  layer.setBonds(renderer, result);
  assert.equal(uploads.length, 3);
  assert.equal(uploads[0].values, result.indices);
  assert.equal(uploads[1].values, result.vectors);
  layer.setBonds(renderer, result, { visible: false, radius: 0.15 });
  assert.equal(uploads.length, 3, 'visibility and radius are shader options');
  assert.equal(layer.bondOptions.visible, false);
  assert.equal(layer.bondBuffers.count, 1);
  layer.setBonds(renderer, null);
  assert.equal(layer.bondBuffers.count, 0);
  assert.ok(uploads.slice(3).every(upload => upload.values === 0), 'cancel releases GPU bond data');
});

test('vector display retains source data and reuses instances when scaling', () => {
  const { layer, uploads } = layerFixture(), renderer = { atomCount: 3 };
  const values = new Float32Array([1, 2, 3, NaN, 2, 3, 0, 0, 0]);
  layer.setVectors(renderer, values);
  assert.deepEqual([...uploads[0].values], [0, 0, 1, 1, 2, 2]);
  assert.equal(uploads[1].values, values, 'GPU suppresses NaN vectors without a main-thread copy');
  layer.setVectors(renderer, values, { scale: 2, color: '#00ff00', visible: false });
  assert.equal(uploads.length, 2);
  assert.equal(layer.vectorOptions.scale, 2);
  assert.deepEqual(layer.vectorOptions.color, [0, 1, 0]);
  assert.throws(() => layer.setVectors(renderer, values, { scale: -1 }), /greater/);
});

test('multi-atom highlighting and atom centering preserve camera orientation and zoom', () => {
  const renderer = Object.create(WebGLRenderer.prototype);
  Object.assign(renderer, { frame: {}, atomCount: 3, displayPositions: new Float32Array([0, 0, 0, 2, 3, 4, 5, 6, 7]),
    requestRender() {}, yaw: 0.5, pitch: 0.3, distance: 12, orthographicScale: 6, pan: [1, 2, 3] });
  renderer.setSelectedAtoms([0, 2, 0]);
  renderer.setSelected(2);
  assert.deepEqual([...renderer.selectedAtoms].slice(0, 3), [0, 2, -1]);
  renderer.centerOnAtom(1);
  assert.deepEqual(renderer.target, [2, 3, 4]);
  assert.deepEqual(renderer.pan, [0, 0, 0]);
  assert.equal(renderer.yaw, 0.5); assert.equal(renderer.pitch, 0.3); assert.equal(renderer.distance, 12);
  assert.throws(() => renderer.centerOnAtom(3), /outside/);
  assert.throws(() => renderer.setSelectedAtoms([3]), /current frame/);
});

test('per-atom radius overrides upload without replacing frame or camera', () => {
  const renderer = Object.create(WebGLRenderer.prototype), uploaded = [];
  Object.assign(renderer, { frame: {}, atomCount: 2, radiusBuffer: {}, yaw: 0.6, requestRender() {},
    gl: { ARRAY_BUFFER: 1, DYNAMIC_DRAW: 2, bindBuffer() {}, bufferData(target, data) { uploaded.push(data); } } });
  const frame = renderer.frame, values = new Float32Array([0.4, 1.2]);
  renderer.setAtomRadii(values);
  assert.equal(renderer.frame, frame);
  assert.equal(renderer.atomRadii, values);
  assert.equal(renderer.maximumAtomRadius, values[1]);
  assert.equal(uploaded[0], values);
  assert.equal(renderer.yaw, 0.6);
  assert.throws(() => renderer.setAtomRadii(new Float32Array([0, 1])), /greater/);
});

test('arrow bounds include tips across negative skew replication extents', () => {
  const { layer } = layerFixture();
  layer.vectors = new Float32Array([0, 0, 6]);
  layer.vectorOptions = { visible: true, scale: 2, radius: 0.1 };
  const renderer = { displayPositions: new Float32Array([1, 2, 3]), minimumOffset: [-2, 0, 0], maximumOffset: [10, 8, 7] };
  const minimum = [1, 2, 3], maximum = [1, 2, 3];
  layer.extendBounds(renderer, minimum, maximum);
  assert.ok(minimum[0] < -1);
  assert.ok(maximum[2] > 22);
});

test('JPEG export renders an opaque image while keeping legend and axis options', () => {
  const renderer = Object.create(WebGLRenderer.prototype);
  let options, mime;
  renderer.captureImage = values => {
    options = values;
    return { toBlob(callback, type) { mime = type; callback(null); } };
  };
  const legend = { kind: 'types', items: [] };
  renderer.exportJpg('snapshot.jpg', { includeBackground: false, includeAxes: true, legend });
  assert.deepEqual(options, { includeBackground: true, includeAxes: true, legend });
  assert.equal(mime, 'image/jpeg');
});
