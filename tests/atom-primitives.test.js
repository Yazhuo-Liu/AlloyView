import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { calculateBonds } from '../src/analysis/bonds.js';
import { AtomPrimitiveLayer, analyzeBondCapCoverage, bondCapsAreCovered, bondDisplayShifts, createFlatArrowMesh, createIndexedPrimitiveMesh, createPrimitiveMesh, normalizeVectorOptions,
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

test('resetting to source coordinates preserves short bonds when periodic fractions round to the upper face', () => {
  const fractional = new Float32Array([1, 1, .5, .1, .1, .5]);
  const frame = { cell, fractional, positions: fractionalToCartesian(fractional, cell), types: new Uint8Array(2) };
  const bonds = calculateBonds(frame, { cutoff: 2 });
  assert.equal(bonds.count, 1);
  const sourceShifts = bonds.shifts.slice();
  const prepared = bondDisplayShifts(bonds, frame, frame.positions.slice());
  const reset = bondDisplayShifts(bonds, frame);
  assert.deepEqual(Array.from(reset), [1, 1, 0]);
  assert.deepEqual(reset, prepared, 'restoring the original array uses the same images as prepared display copies');
  assert.deepEqual(bonds.shifts, sourceShifts, 'scientific bond results retain their own image convention');
  for (let axis = 0; axis < 3; axis++) {
    const actual = frame.positions[3 + axis] - frame.positions[axis]
      + reset[0] * cell.vectors[axis] + reset[1] * cell.vectors[3 + axis] + reset[2] * cell.vectors[6 + axis];
    assert.ok(Math.abs(actual - bonds.vectors[axis]) < 1e-6, 'the rendered bond keeps the physical short displacement');
  }
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

test('indexed cylinders and cones preserve every triangle and Float32 attribute bit, including capped hard edges', () => {
  for (const sides of [3, 8, 10, 32]) for (const cone of [false, true]) {
    const raw = createPrimitiveMesh(cone, sides), { vertices, indices } = createIndexedPrimitiveMesh(cone, sides);
    const expanded = new Float32Array(raw.length);
    for (let index = 0; index < indices.length; index++) {
      expanded.set(vertices.subarray(indices[index] * 6, indices[index] * 6 + 6), index * 6);
    }
    assert.deepEqual(new Uint32Array(expanded.buffer), new Uint32Array(raw.buffer));
    assert.ok(indices instanceof Uint16Array);
    assert.ok(vertices.length < raw.length);
  }
  assert.equal(createIndexedPrimitiveMesh(false).vertices.length / 6, 46);
  assert.equal(createIndexedPrimitiveMesh(true).vertices.length / 6, 33);
});

test('capless indexed cylinders preserve the exact side triangles and never alter arrow cones', () => {
  for (const sides of [3, 8, 10, 32]) {
    const raw = createPrimitiveMesh(false, sides), { vertices, indices } = createIndexedPrimitiveMesh(false, sides, true);
    const expected = Float32Array.from([...raw].filter((_, index) => raw[Math.floor(index / 6) * 6 + 5] === 0));
    const expanded = new Float32Array(indices.length * 6);
    for (let index = 0; index < indices.length; index++) expanded.set(vertices.subarray(indices[index] * 6, indices[index] * 6 + 6), index * 6);
    assert.deepEqual(new Uint32Array(expanded.buffer), new Uint32Array(expected.buffer));
    assert.equal(indices.length, sides * 6);
  }
  assert.equal(createIndexedPrimitiveMesh(false, 10, true).vertices.length / 6, 22);
  assert.throws(() => createIndexedPrimitiveMesh(true, 10, true), /Only bond cylinders/);
});

test('cap coverage uses uploaded endpoint coordinates, periodic shifts and actual per-atom radii', () => {
  const positions = new Float32Array([0, 0, 0, 0, 9, 2, 3, 0]), fractions = new Float32Array([0, 0, 0, 0, .8, .2, .3, 0]);
  const radii = new Float32Array([.7, .3]);
  const renderer = { frame: { cell }, atomRadii: radii, radiusRevision: 3 };
  const bonds = { count: 1, indices: new Uint32Array([0, 1]), vectors: new Float32Array([-1, 2, 3]) };
  const coverage = analyzeBondCapCoverage(renderer, bonds, new Int32Array([-1, 0, 0]), positions, fractions);
  assert.equal(coverage.minimumRadius, radii[1]); assert.equal(coverage.maximumRadius, radii[0]);
  assert.equal(coverage.endpointError, 0); assert.equal(coverage.radiusRevision, 3);
  bonds.vectors[0] = -.75;
  assert.equal(analyzeBondCapCoverage(renderer, bonds, new Int32Array([-1, 0, 0]), positions, fractions).endpointError, .25);
});

test('capless guard requires opaque projected sphere interiors, clip coverage and a resolvable depth gap', () => {
  const view = Float32Array.from([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-10,1]);
  const projection = Float32Array.from([1,0,0,0, 0,1,0,0, 0,0,-.2,0, 0,0,-1.1,1]);
  const renderer = { viewMatrix: view, projectionMatrix: projection, projectionMode: 'orthographic', depthRange: [1,20],
    radiusScale: 1, minimumOffset: [0,0,0], maximumOffset: [0,0,0], canvas: { width: 800, height: 800 },
    sliceMode: 'planes', sliceCount: 0 };
  const coverage = { minimum: [0,0,0], maximum: [1,0,0], minimumRadius: .7, maximumRadius: .7,
    endpointError: 0, coordinateMagnitude: 1, fractionalMaximum: [.5,.5,.5] };
  assert.equal(bondCapsAreCovered(renderer, coverage, .1), true);
  for (const patch of [{ radiusScale: .2 }, { crystalDrag: {} }, { sliceCount: 1 }, { depthRange: [9.5,20] },
    { canvas: { width: 4, height: 4 } }, { projectionMatrix: Float32Array.from(projection, (x,i)=>i===10?-.00001:x) }]) {
    assert.equal(bondCapsAreCovered({ ...renderer, ...patch }, coverage, .1), false);
  }
  assert.equal(bondCapsAreCovered(renderer, { ...coverage, endpointError: .6 }, .1), false);
  assert.equal(bondCapsAreCovered(renderer, { ...coverage, coordinateMagnitude: 1e7 }, .1), false);
  assert.equal(bondCapsAreCovered({ ...renderer, sliceMode: 'legacy', sliceAxis: 0, sliceMaximum: .5 }, coverage, .1), false);
  assert.equal(bondCapsAreCovered({ ...renderer, sliceMode: 'legacy', sliceAxis: 0, sliceMaximum: 1 }, coverage, .1), true);
  const perspective = Float32Array.from([2,0,0,0, 0,2,0,0, 0,0,-1.2,-1, 0,0,-2.2,0]);
  assert.equal(bondCapsAreCovered({ ...renderer, projectionMode: 'perspective', projectionMatrix: perspective }, coverage, .1), true);
  assert.equal(bondCapsAreCovered({ ...renderer, projectionMode: 'perspective', projectionMatrix: perspective },
    { ...coverage, minimum: [80,0,0], maximum: [81,0,0] }, .1), false, 'an off-axis perspective cap can escape a sphere billboard');
});

test('capless batch selection caches geometry, refreshes explicit data edits and retains caps for MSAA, exports and hidden sphere bytes', () => {
  const { layer } = layerFixture();
  const renderer = { frame: { cell, fractional: new Float32Array(6) }, atomCount: 2, atomRadii: new Float32Array([.7,.7]),
    radiusRevision: 1, radiusScale: 1, displayPositions: new Float32Array([0,0,0, 1,0,0]), visibility: new Uint8Array([255,255]),
    viewMatrix: Float32Array.from([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-10,1]),
    projectionMatrix: Float32Array.from([1,0,0,0, 0,1,0,0, 0,0,-.2,0, 0,0,-1.1,1]),
    projectionMode: 'orthographic', depthRange: [1,20], minimumOffset: [0,0,0], maximumOffset: [0,0,0],
    canvas: { width:800,height:800 }, sliceMode: 'planes', sliceCount: 0 };
  Object.assign(layer,{ singleSampleDefault: true, cylinder: { count:120 }, caplessCylinder: { count:60 },
    positionValues: new Float32Array([0,0,0,0, 1,0,0,0]), fractionalValues: new Float32Array(8), width:2,height:1,
    uploadTexture() {}, colorSource: new Uint8Array(6) });
  layer.setBonds(renderer,{ count:1, indices:new Uint32Array([0,1]), vectors:new Float32Array([1,0,0]), shifts:new Int32Array(3) });
  assert.equal(layer.coveredBondMesh(renderer),layer.caplessCylinder);
  const cached=layer.bondCapCoverage;
  renderer.viewMatrix[12]=.1;
  assert.equal(layer.coveredBondMesh(renderer),layer.caplessCylinder);
  assert.equal(layer.bondCapCoverage,cached,'orbit/pan rechecks only the compact projection/depth bounds');
  layer.singleSampleDefault=false; assert.equal(layer.coveredBondMesh(renderer),layer.cylinder);
  layer.singleSampleDefault=true; renderer.renderViewport={width:800,height:800}; assert.equal(layer.coveredBondMesh(renderer),layer.cylinder);
  renderer.renderViewport=null;
  renderer.atomRadii[0]=.02;renderer.radiusRevision++;assert.equal(layer.coveredBondMesh(renderer),layer.cylinder);
  renderer.atomRadii[0]=.7;renderer.radiusRevision++;assert.equal(layer.coveredBondMesh(renderer),layer.caplessCylinder);
  renderer.visibility[0]=1;layer.updateVisibility(renderer);layer.flushTextures(renderer);
  assert.equal(layer.coveredBondMesh(renderer),layer.cylinder,'a primitive flag cannot substitute for an actually displayed sphere');
  renderer.visibility[0]=255;layer.updateVisibility(renderer);layer.flushTextures(renderer);assert.equal(layer.coveredBondMesh(renderer),layer.caplessCylinder);
  renderer.displayPositions[3]=4;layer.updatePositions(renderer);layer.flushTextures(renderer);
  assert.equal(layer.coveredBondMesh(renderer),layer.cylinder,'same-array position changes recompute endpoint mismatch after upload');
  layer.clearInstances();assert.equal(layer.bondCapCoverage,null);assert.equal(layer.bondBuffers.displayShifts,null);
});

test('indexed mesh uploads preserve the active VAO element binding', () => {
  const layer = Object.create(AtomPrimitiveLayer.prototype), originalVao = {}, bindings = new Map([[originalVao, {}]]), uploads = [];
  let vao = originalVao, buffer;
  const initialElement = bindings.get(originalVao);
  layer.gl = { ARRAY_BUFFER: 1, ELEMENT_ARRAY_BUFFER: 2, STATIC_DRAW: 3, VERTEX_ARRAY_BINDING: 4, UNSIGNED_SHORT: 5,
    createBuffer: () => ({}), getParameter: () => vao,
    bindVertexArray(value) { vao = value; },
    bindBuffer(target, value) { buffer = value; if (target === this.ELEMENT_ARRAY_BUFFER) bindings.set(vao, value); },
    bufferData(target, values) { uploads.push({ target, buffer, values }); } };
  const mesh = layer.mesh(false);
  assert.equal(vao, originalVao);
  assert.equal(bindings.get(originalVao), initialElement);
  assert.equal(uploads[1].buffer, mesh.indexBuffer);
  assert.equal(mesh.count, 120); assert.equal(mesh.vertexCount, 46);
  assert.equal(mesh.indexType, layer.gl.UNSIGNED_SHORT);
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

test('clearing attached geometry releases its prepared scalar source and shrinks atom textures', () => {
  const layer = Object.create(AtomPrimitiveLayer.prototype), uploads = [];
  Object.assign(layer, { scalarColorInput: { data: new Float64Array(100), values: new Float32Array(100) },
    positionValues: new Float32Array(400), fractionalValues: new Float32Array(400), colorValues: new Uint8Array(400), width: 10, height: 10,
    visibilityValues: new Int8Array(100), sourceRenderer: {}, colorSource: new Uint8Array(300), textureDirty: { visibility: true },
    gl: { RGBA32F: 1, RGBA8: 2, FLOAT: 3, UNSIGNED_BYTE: 4, R8I: 5, BYTE: 6, RED_INTEGER: 7 }, clearInstances() {},
    uploadTexture(index, values) { uploads.push([index, values.byteLength]); } });
  layer.clear();
  assert.equal(layer.scalarColorInput, null);
  assert.equal(layer.positionValues, null); assert.equal(layer.fractionalValues, null); assert.equal(layer.colorValues, null);
  assert.equal(layer.visibilityValues, null); assert.equal(layer.sourceRenderer, null); assert.equal(layer.colorSource, null);
  assert.equal(layer.width, 1); assert.equal(layer.height, 1);
  assert.deepEqual(uploads, [[0, 16], [1, 4], [2, 16], [3, 1]], 'source-sized texture storage is replaced by single pixels');
});

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

test('visibility edits upload one signed byte per padded atom and preserve coordinate/color mirrors and source arrays', () => {
  const { layer } = layerFixture(), textures = [];
  layer.width = 3; layer.height = 1;
  layer.positionValues = new Float32Array(12);
  layer.fractionalValues = new Float32Array(12);
  layer.colorValues = new Uint8Array(12);
  layer.uploadTexture = (index, values) => textures.push({ index, values: [...values], bytes: values.byteLength });
  Object.assign(layer.gl, { R8I: 3, BYTE: 4, RED_INTEGER: 5 });
  const positions = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const fractional = new Float32Array([.1, .2, .3, .4, .5, .6, .7, .8, .9]);
  const renderer = { atomCount: 3, displayPositions: positions, frame: { fractional },
    visibility: new Uint8Array([255, 0, 0]), selectionVisibility: new Uint8Array([255, 255, 0]) };
  layer.updateVisibility(renderer);
  assert.equal(textures.length, 0, 'filter edits defer uploads until an attached layer draws');
  layer.flushTextures();
  assert.deepEqual(textures, [{ index: 3, values: [1, 0, -1], bytes: 3 }]);
  assert.deepEqual([...positions], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const storage = [layer.positionValues, layer.fractionalValues, layer.colorValues, layer.visibilityValues];
  renderer.selectionVisibility = null;
  layer.updateVisibility(renderer); layer.flushTextures();
  [layer.positionValues, layer.fractionalValues, layer.colorValues, layer.visibilityValues].forEach((values, index) => assert.equal(values, storage[index]));
  assert.deepEqual(textures[1], { index: 3, values: [1, 0, 0], bytes: 3 });
  layer.flushTextures(); assert.equal(textures.length, 2, 'unchanged warm textures need no upload');
});

test('inactive attached layers defer mirror allocation and combine frame, color, preview and coordinate changes on first draw', () => {
  const { layer } = layerFixture(), textures = [];
  Object.assign(layer.gl, { MAX_TEXTURE_SIZE: 10, getParameter: () => 4096, RGBA32F: 3, FLOAT: 4, RGBA8: 5, UNSIGNED_BYTE: 6 });
  layer.uploadTexture = (index, values) => textures.push({ index, values: [...values] });
  const positions = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const renderer = { atomCount: 3, displayPositions: positions, frame: { fractional: positions }, visibility: new Uint8Array([255, 0, 255]) };
  const colors = new Uint8Array(9).fill(80), editedColors = new Uint8Array(9).fill(120);
  layer.setFrame(renderer, colors);
  layer.updateColors(editedColors);
  layer.updateScalarColorPreview({ values: new Float32Array(3), colorOverrides: new Uint8Array([0, 255, 0]) });
  renderer.displayPositions = new Float32Array([10, 20, 30, 40, 50, 60, 70, 80, 90]);
  layer.updatePositions(renderer);
  layer.render(renderer);
  assert.equal(textures.length, 0); assert.equal(layer.positionValues, undefined);
  layer.flushTextures();
  assert.deepEqual([...layer.positionValues].slice(0, 12), [10, 20, 30, 0, 40, 50, 60, 0, 70, 80, 90, 0]);
  assert.deepEqual([...layer.colorValues].slice(0, 12), [120, 120, 120, 0, 120, 120, 120, 255, 120, 120, 120, 0]);
  const mirrors = [layer.positionValues, layer.fractionalValues, layer.colorValues, layer.visibilityValues];
  const bounds = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
  layer.vectorFields = [{ vectors: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 1]), options: normalizeVectorOptions() }];
  layer.extendBounds(renderer, ...bounds);
  assert.ok(bounds.flat().every(Number.isFinite), 'bounds use canonical coordinates independently of lazy texture state');
  layer.vectorFields = [];
  layer.setFrame(renderer, editedColors); layer.flushTextures();
  [layer.positionValues, layer.fractionalValues, layer.colorValues, layer.visibilityValues].forEach((values, index) => {
    assert.equal(values, mirrors[index], 'same-sized frames retain warm staging');
  });
  assert.deepEqual([layer.colorValues[3], layer.colorValues[7], layer.colorValues[11]], [255, 255, 255], 'a new frame clears old preview overrides');
});

test('single-byte visibility textures restore unpack alignment after allocation, subimage update and failure', () => {
  const layer = Object.create(AtomPrimitiveLayer.prototype), uploads = [], gl = { RGBA: 1, RED_INTEGER: 2, UNPACK_ALIGNMENT: 3,
    TEXTURE0: 10, TEXTURE_2D: 11, getParameter: () => 8,
    pixelStorei(parameter, value) { uploads.push(['alignment', value]); }, activeTexture() {}, bindTexture() {},
    texImage2D(...args) { uploads.push(['image', args[3], args[4], args[6], args[8].byteLength]); },
    texSubImage2D(...args) { uploads.push(['subimage', args[4], args[5], args[6], args[8].byteLength]); } };
  Object.assign(layer, { gl, width: 3, height: 2, textures: [null, null, null, {}], textureSizes: [null, null, null, null] });
  layer.uploadTexture(3, new Int8Array(6), 12, 13, gl.RED_INTEGER);
  layer.uploadTexture(3, new Int8Array(6), 12, 13, gl.RED_INTEGER);
  assert.deepEqual(uploads, [['alignment', 1], ['image', 3, 2, 2, 6], ['alignment', 8],
    ['alignment', 1], ['subimage', 3, 2, 2, 6], ['alignment', 8]]);
  gl.texSubImage2D = () => { throw new Error('upload failed'); };
  assert.throws(() => layer.uploadTexture(3, new Int8Array(6), 12, 13, gl.RED_INTEGER), /upload failed/);
  assert.deepEqual(uploads.at(-1), ['alignment', 8]);
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

test('multiple arrow fields keep independent GPU buffers, reuse settings edits and release removed groups', () => {
  const { layer, uploads } = layerFixture(), renderer = { atomCount: 2 };
  Object.assign(layer.gl, { createBuffer: () => ({}), createVertexArray: () => ({}) });
  const forces = new Float32Array([1, 0, 0, 2, 0, 0]), velocities = new Float32Array([0, 3, 0, 0, 4, 0]);
  layer.setVectorFields(renderer, [
    { id: 'force', vectors: forces, options: { scale: 2, color: '#ff0000' } },
    { id: 'velocity', vectors: velocities, options: { scale: 3, color: '#0000ff', anchor: 'head', dimension: '2d' } },
  ]);
  assert.equal(uploads.length, 4);
  assert.notEqual(layer.vectorFields[0].buffers, layer.vectorFields[1].buffers);
  const velocityBuffer = layer.vectorFields[1].buffers;
  layer.setVectorFields(renderer, [
    { id: 'force', vectors: forces, options: { scale: 5, visible: false } },
    { id: 'velocity', vectors: velocities, options: { headLength: .8, upMode: 'fixed', up: [0, 0, 1] } },
  ]);
  assert.equal(uploads.length, 4, 'appearance edits do not upload another vector array');
  assert.equal(layer.vectorFields[0].options.visible, false);
  assert.equal(layer.vectorFields[1].options.scale, 3);
  assert.equal(layer.vectorFields[1].options.anchor, 'head');
  assert.deepEqual(layer.vectorFields[1].options.up, [0, 0, 1]);
  layer.setVectorFields(renderer, [{ id: 'velocity', vectors: velocities }]);
  assert.equal(layer.vectorFields[0].buffers, velocityBuffer);
  assert.equal(uploads.length, 7, 'only removed field storage is released');
  assert.equal(layer.vectors, velocities, 'legacy accessor follows the first remaining field');
  assert.throws(() => layer.setVectorFields(renderer, [{ id: 'velocity', vectors: velocities }, { id: 'bad', vectors: new Float32Array(3) }]), /current frame/);
  assert.equal(layer.vectorFields.length, 1, 'one malformed field cannot discard existing groups');
  assert.throws(() => layer.setVectorFields(renderer, [{ id: 'same', vectors: velocities }, { id: 'same', vectors: forces }]), /unique/);
  assert.equal(uploads.length, 7);
  layer.setVectorFields(renderer, []);
  assert.equal(layer.vectorFields.length, 0);
  assert.equal(layer.vectors, null);
});

test('multi-field bounds use displayed atom anchors and include every visible group across replicas', () => {
  const layer = Object.create(AtomPrimitiveLayer.prototype);
  layer.vectorFields = [
    { vectors: new Float32Array([4, 0, 0]), options: normalizeVectorOptions({ headRadius: .5 }) },
    { vectors: new Float32Array([0, 6, 0]), options: normalizeVectorOptions({ anchor: 'head', headRadius: .5 }) },
    { vectors: new Float32Array([0, 0, 100]), options: normalizeVectorOptions({ visible: false }) },
  ];
  const renderer = { displayPositions: new Float32Array([10, 20, 30]), minimumOffset: [-10, -2, 0], maximumOffset: [5, 3, 0] };
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  layer.extendBounds(renderer, minimum, maximum);
  assert.deepEqual(minimum, [-.5, 11.5, 29.5]);
  assert.deepEqual(maximum, [19.5, 23.5, 30.5]);
});

test('fixed flat-arrow planes require a finite nonzero up direction', () => {
  const up = [0, 0, 2], options = normalizeVectorOptions({ dimension: '2d', upMode: 'fixed', up });
  up[2] = 0;
  assert.deepEqual(options.up, [0, 0, 2]);
  assert.throws(() => normalizeVectorOptions({ up: [0, 0, 0] }), /nonzero/);
  assert.throws(() => normalizeVectorOptions({ up: [NaN, 1, 0] }), /finite/);
  assert.throws(() => normalizeVectorOptions({ upMode: 'other' }), /plane/);
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

test('selection-hidden anchors exclude every attached vector field from bounds across replicas', () => {
  const { layer } = layerFixture();
  layer.vectorFields = [
    { vectors: new Float32Array([100, 0, 0, 2, 0, 0]), options: normalizeVectorOptions({ headRadius: .5 }) },
    { vectors: new Float32Array([0, 200, 0, 0, 3, 0]), options: normalizeVectorOptions({ headRadius: .5 }) },
  ];
  const renderer = { displayPositions: new Float32Array([1, 2, 3, 4, 5, 6]),
    visibility: new Uint8Array([0, 0]), selectionVisibility: new Uint8Array([0, 255]),
    minimumOffset: [-10, -2, 0], maximumOffset: [5, 3, 0] };
  const minimum = [4, 5, 6], maximum = [4, 5, 6];
  layer.extendBounds(renderer, minimum, maximum);
  assert.deepEqual(minimum, [-6.5, 2.5, 5.5]);
  assert.deepEqual(maximum, [11.5, 11.5, 6.5], 'ordinary hidden atoms still contribute their independent arrows');
  renderer.selectionVisibility[1] = 0;
  const allHiddenMinimum = [4, 5, 6], allHiddenMaximum = [4, 5, 6];
  layer.extendBounds(renderer, allHiddenMinimum, allHiddenMaximum);
  assert.deepEqual(allHiddenMinimum, [4, 5, 6]);
  assert.deepEqual(allHiddenMaximum, [4, 5, 6]);
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
