import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell } from '../src/data/model.js';
import { AtomPrimitiveLayer, bondDisplayShifts, createFlatArrowMesh, createPrimitiveMesh, normalizeVectorOptions,
  parsePrimitiveColor, validateBonds, vectorArrowEndpoints } from '../src/render/atom-primitives.js';
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
  layer.setVectors(renderer, values, { headRadius: .4, headLength: .9, radius: .12, anchor: 'head', dimension: '2d' });
  assert.equal(uploads.length, 2, 'arrow shape, anchoring and 2D mode are shader/mesh options');
  assert.equal(layer.vectorOptions.headRadius, .4);
  assert.equal(layer.vectorOptions.headLength, .9);
  assert.equal(layer.vectorOptions.anchor, 'head');
  assert.equal(layer.vectorOptions.dimension, '2d');
  assert.equal(layer.vectorOptions.scale, 2);
});

test('arrow anchoring fixes the requested tail, head or center at each atom', () => {
  const position = [2, 3, 4], vector = [1, -2, 3], options = { scale: 2, headLength: .8 };
  const tail = vectorArrowEndpoints(position, vector, options);
  assert.deepEqual(tail.tail, position);
  assert.deepEqual(tail.tip, [4, -1, 10]);
  const head = vectorArrowEndpoints(position, vector, { ...options, anchor: 'head' });
  assert.deepEqual(head.tip, position);
  assert.deepEqual(head.tail, [0, 7, -2]);
  const center = vectorArrowEndpoints(position, vector, { ...options, anchor: 'center', dimension: '2d' });
  assert.deepEqual(center.tail, [1, 5, 1]);
  assert.deepEqual(center.tip, [3, 1, 7]);
  assert.equal(center.headLength, .8);
  assert.equal(center.shaftLength, Math.hypot(2, -4, 6) - .8);
  const shortened = vectorArrowEndpoints(position, [.1, 0, 0], { headLength: 2 });
  assert.equal(shortened.headLength, .1);
  assert.equal(shortened.shaftLength, 0);
  assert.deepEqual(shortened.headBase, position);
  const zero = vectorArrowEndpoints(position, [0, 0, 0]);
  assert.equal(zero.length, 0);
  assert.deepEqual(zero.headBase, position);
});

test('flat arrow shaft and head are actual camera-facing planar triangles', () => {
  for (const head of [false, true]) {
    const values = createFlatArrowMesh(head);
    assert.equal(values.length / 6, head ? 3 : 6);
    for (let vertex = 0; vertex < values.length; vertex += 6) {
      assert.equal(values[vertex + 1], 0);
      assert.deepEqual([...values.subarray(vertex + 3, vertex + 6)], [0, 1, 0]);
    }
    for (let triangle = 0; triangle < values.length; triangle += 18) {
      const ax = values[triangle], az = values[triangle + 2];
      const bx = values[triangle + 6], bz = values[triangle + 8];
      const cx = values[triangle + 12], cz = values[triangle + 14];
      assert.ok((bz - az) * (cx - ax) - (bx - ax) * (cz - az) > 0);
    }
  }
});

test('arrow dimensions reject invalid values and preserve independent manual proportions', () => {
  const options = normalizeVectorOptions({ radius: .1, headRadius: .7, headLength: .2, anchor: 'center', dimension: '2d' });
  assert.equal(options.headRadius, .7);
  assert.equal(options.headLength, .2);
  assert.equal(normalizeVectorOptions({ scale: 4 }, options).headRadius, .7);
  for (const name of ['radius', 'headRadius', 'headLength', 'scale']) {
    for (const value of [0, -1, Infinity, NaN]) assert.throws(() => normalizeVectorOptions({ [name]: value }), /greater/);
  }
  assert.throws(() => normalizeVectorOptions({ anchor: 'tip' }), /anchoring/);
  assert.throws(() => normalizeVectorOptions({ dimension: '1d' }), /geometry/);
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

test('head and center anchoring extend bounds behind the atom across replicas', () => {
  const { layer } = layerFixture();
  layer.vectors = new Float32Array([0, 0, 6]);
  const renderer = { displayPositions: new Float32Array([1, 2, 3]), minimumOffset: [-2, 0, -4], maximumOffset: [10, 8, 7] };
  for (const anchor of ['head', 'center']) {
    layer.vectorOptions = normalizeVectorOptions({ visible: true, scale: 2, radius: .1, headRadius: .5, anchor });
    const minimum = [1, 2, 3], maximum = [1, 2, 3];
    layer.extendBounds(renderer, minimum, maximum);
    assert.equal(minimum[2], anchor === 'head' ? -13.5 : -7.5);
    assert.equal(maximum[2], anchor === 'head' ? 10.5 : 16.5);
    assert.equal(minimum[0], -1.5);
    assert.equal(maximum[0], 11.5);
  }
});

test('arrow bounds remain independent of hidden atoms and follow arrow-layer visibility', () => {
  const { layer } = layerFixture();
  layer.vectors = new Float32Array([12, 0, 0]);
  layer.vectorOptions = normalizeVectorOptions({ radius: .1, headRadius: .5 });
  const renderer = { displayPositions: new Float32Array([1, 2, 3]), visibility: new Uint8Array([0]),
    minimumOffset: [0, 0, 0], maximumOffset: [10, 8, 7] };
  const minimum = [1, 2, 3], maximum = [1, 2, 3];
  layer.extendBounds(renderer, minimum, maximum);
  assert.equal(maximum[0], 23.5, 'the hidden anchor atom does not remove its arrow tip from fit/clipping bounds');
  assert.equal(minimum[0], .5);
  layer.vectorOptions.visible = false;
  const hiddenMinimum = [1, 2, 3], hiddenMaximum = [1, 2, 3];
  layer.extendBounds(renderer, hiddenMinimum, hiddenMaximum);
  assert.deepEqual(hiddenMinimum, [1, 2, 3]);
  assert.deepEqual(hiddenMaximum, [1, 2, 3]);
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
