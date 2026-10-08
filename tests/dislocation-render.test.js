import assert from 'node:assert/strict';
import test from 'node:test';
import { cartesianToFractional, createCell, fractionalToCartesian } from '../src/data/model.js';
import { DXA_FAMILIES } from '../src/analysis/dxa.js';
import {
  DislocationLayer, clipDislocationSegment, createDislocationInstances, createDislocationTubeGeometry,
  dislocationSlicePlanes, normalizeDislocationOptions,
} from '../src/render/dislocation-layer.js';
import { validateSlices } from '../src/render/slicing.js';
import { createReplication } from '../src/render/replication.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

const cell = createCell({ vectors: [10, 0, 0, 4, 8, 0, 0, 0, 12], origin: [4, 5, 6], triclinic: true });
const family = DXA_FAMILIES.fcc[0].id;
const network = points => ({ parameters: { lattice: 'fcc' }, segments: [{ id: 1, familyId: family, points }], totalLength: 2, density: 2 / 960 });
const near = (first, last, tolerance = 1e-6) => assert.ok(Math.abs(first - last) < tolerance, `${first} != ${last}`);
const vectorNear = (first, last, tolerance = 1e-6) => first.forEach((value, axis) => near(value, last[axis], tolerance));
const openCell = createCell({ vectors: [20, 0, 0, 0, 20, 0, 0, 0, 20], pbc: [false, false, false] });

function assertFrames(curve) {
  for (let index = 0; index < curve.ringCount * 3; index += 3) {
    const tangent = curve.tangents.slice(index, index + 3), normal = curve.normals.slice(index, index + 3);
    assert.ok([...tangent, ...normal].every(Number.isFinite));
    near(Math.hypot(...tangent), 1);
    near(Math.hypot(...normal), 1);
    near(tangent.reduce((sum, value, axis) => sum + value * normal[axis], 0), 0);
  }
}

function assertSolidCaps(geometry, curve) {
  const bodyIndices = (curve.ringCount - 1) * curve.radialSegments * 6;
  assert.equal(curve.indexCount, bodyIndices + 2 * curve.radialSegments * 3);
  let offset = curve.indexStart + bodyIndices;
  for (const [ring, sign] of [[0, -1], [curve.ringCount - 1, 1]]) {
    const tangent = curve.tangents.slice(ring * 3, ring * 3 + 3);
    const normal = tangent.map(value => value * sign);
    const triangles = geometry.indices.slice(offset, offset + curve.radialSegments * 3);
    const center = triangles[0];
    vectorNear(geometry.values.slice(center * 12, center * 12 + 3), curve.points.slice(ring * 3, ring * 3 + 3));
    vectorNear(geometry.values.slice(center * 12 + 3, center * 12 + 6), [0, 0, 0]);
    for (let index = 0; index < triangles.length; index += 3) {
      const vertices = Array.from(triangles.slice(index, index + 3));
      assert.equal(vertices[0], center, 'every cap triangle covers the center, leaving no hole');
      const positions = vertices.map(vertex => Array.from(geometry.values.slice(vertex * 12 + 3, vertex * 12 + 6)));
      const [a, b, c] = positions;
      const ab = b.map((value, axis) => value - a[axis]), ac = c.map((value, axis) => value - a[axis]);
      const faceNormal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      assert.ok(faceNormal.reduce((sum, value, axis) => sum + value * normal[axis], 0) > 0, 'cap triangles face outward');
      for (const vertex of vertices) vectorNear(geometry.values.slice(vertex * 12 + 6, vertex * 12 + 9), normal);
    }
    offset += curve.radialSegments * 3;
  }
}

test('dislocation curves split at triclinic periodic faces without a cell-spanning connector', () => {
  const points = fractionalToCartesian(new Float64Array([0.9, 0.3, 0.4, 1.1, 0.3, 0.4]), cell, new Float64Array(6));
  const result = network(points), original = Array.from(points);
  const geometry = createDislocationInstances(result, cell);
  assert.equal(geometry.count, 2);
  near(geometry.values[0], 14.2);
  near(geometry.values[3], 15.2);
  near(geometry.values[9], 5.2);
  near(geometry.values[12], 6.2);
  let drawnLength = 0;
  for (let offset = 0; offset < geometry.values.length; offset += 9) {
    drawnLength += Math.hypot(...[0, 1, 2].map(axis => geometry.values[offset + 3 + axis] - geometry.values[offset + axis]));
  }
  near(drawnLength, 2);
  assert.deepEqual(Array.from(points), original);
  assert.equal(result.totalLength, 2);
  assert.equal(result.density, 2 / 960);
});

test('dislocation family filtering and coloring are independent of atom visibility', () => {
  const points = new Float64Array([7, 7, 8, 8, 7, 8]), result = network(points);
  assert.equal(createDislocationInstances(result, cell, { visibleFamilies: [] }).count, 0);
  assert.equal(createDislocationInstances(result, cell, { familyVisibility: { [family]: false } }).count, 0);
  const geometry = createDislocationInstances(result, cell, { visibleFamilies: [family], familyColors: { [family]: '#ff8000' } });
  assert.equal(geometry.count, 1);
  near(geometry.values[6], 1); near(geometry.values[7], 128 / 255); near(geometry.values[8], 0);
  const all = normalizeDislocationOptions({ visibleFamilies: null }, { visibleFamilies: [] });
  assert.equal(all.visibleFamilies, null);
  assert.throws(() => normalizeDislocationOptions({ radius: 0 }), /radius/);
  assert.throws(() => createDislocationInstances(network([7, 7, 8, NaN, 7, 8]), cell), /finite/);
  assert.equal(createDislocationTubeGeometry(result, cell, { visibleFamilies: [] }).indexCount, 0);
  assert.equal(createDislocationTubeGeometry(result, cell, { familyVisibility: { [family]: false } }).count, 0);
  const tube = createDislocationTubeGeometry(result, cell, { familyColors: { [family]: '#ff8000' } });
  vectorNear(tube.values.slice(9, 12), [1, 128 / 255, 0]);
  assert.throws(() => createDislocationTubeGeometry(network([7, 7, 8, NaN, 7, 8]), cell), /finite/);
});

test('connected tube interpolation preserves native knots, caps only open ends, and shares every interior ring', () => {
  const points = new Float64Array([0, 0, 0, 2, 0, 0, 2, 2, 0]), result = network(points);
  Object.assign(result.segments[0], { burgersVector: [0.5, 0, 0.5], length: 4, junctions: [[], [{ segmentId: 2, end: 0 }]] });
  const original = structuredClone(result), geometry = createDislocationTubeGeometry(result, openCell), curve = geometry.curves[0];
  assert.ok(curve.ringCount > 3, 'bends receive render-only samples');
  assert.equal(curve.closed, false);
  assert.equal(curve.capStart, true); assert.equal(curve.capEnd, true);
  vectorNear(curve.points.slice(0, 3), [0, 0, 0]);
  vectorNear(curve.points.slice(-3), [2, 2, 0]);
  assert.ok(Array.from({ length: curve.ringCount }, (_, ring) => curve.points.slice(ring * 3, ring * 3 + 3))
    .some(point => point[0] === 2 && point[1] === 0 && point[2] === 0), 'native bend point is retained');
  assert.ok(curve.points.some((value, index) => index % 3 === 1 && value < 0), 'restrained interpolation rounds the bend');
  assertFrames(curve);
  const bodyIndices = geometry.indices.slice(0, (curve.ringCount - 1) * curve.radialSegments * 6);
  for (let ring = 1; ring < curve.ringCount - 1; ring += 1) {
    for (let side = 0; side < curve.radialSegments; side += 1) {
      const vertex = ring * curve.radialSegments + side;
      assert.equal(bodyIndices.filter(index => index === vertex).length, 6, 'both neighboring bands use one shared vertex');
    }
  }
  for (let vertex = 0; vertex < curve.ringCount * curve.radialSegments; vertex += 1) {
    const radial = geometry.values.slice(vertex * 12 + 3, vertex * 12 + 6);
    const tangent = curve.tangents.slice(Math.floor(vertex / curve.radialSegments) * 3, Math.floor(vertex / curve.radialSegments) * 3 + 3);
    near(Math.hypot(...radial), 1);
    near(radial.reduce((sum, value, axis) => sum + value * tangent[axis], 0), 0);
  }
  assert.deepEqual(result, original, 'coordinates, Burgers vectors, junctions, lengths and statistics stay scientific source data');
});

test('nonplanar closed loops use a shared first ring and correct transported frame twist', () => {
  const points = new Float64Array([0, 0, 0, 3, 0, 1, 4, 2, -1, 1, 4, 2, -1, 2, -0.5, 0, 0, 0]);
  const result = network(points);
  result.segments[0].closed = true;
  const geometry = createDislocationTubeGeometry(result, openCell), curve = geometry.curves[0];
  assert.equal(curve.closed, true);
  assert.equal(curve.capStart, false); assert.equal(curve.capEnd, false);
  assert.equal(curve.vertexCount, curve.ringCount * curve.radialSegments);
  assert.equal(curve.indexCount, curve.ringCount * curve.radialSegments * 6);
  assert.notDeepEqual(Array.from(curve.points.slice(0, 3)), Array.from(curve.points.slice(-3)), 'the duplicate terminal ring is removed');
  vectorNear(curve.seam.start.center, curve.seam.end.center);
  vectorNear(curve.seam.start.tangent, curve.seam.end.tangent, 1e-12);
  vectorNear(curve.seam.start.normal, curve.seam.end.normal, 1e-12);
  assertFrames(curve);
  const edges = new Map();
  for (let index = 0; index < geometry.indices.length; index += 3) {
    const triangle = geometry.indices.slice(index, index + 3);
    for (let side = 0; side < 3; side += 1) {
      const ends = [triangle[side], triangle[(side + 1) % 3]].sort((a, b) => a - b), key = ends.join(',');
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  assert.ok([...edges.values()].every(count => count === 2), 'closed mesh has no unjoined seam or exposed edge');
});

test('native closed loops with numerical endpoint residuals snap only the display copy', () => {
  for (const residual of [2.3429572948430177e-8, 1e-7]) {
    const result = network(new Float64Array([0, 0, 0, 3, 0, 1, 4, 2, -1, 1, 4, 2, -1, 2, -0.5, residual, -residual / 2, 0]));
    result.segments[0].closed = true;
    const original = structuredClone(result), geometry = createDislocationTubeGeometry(result, openCell), curve = geometry.curves[0];
    assert.equal(curve.closed, true);
    assert.equal(curve.capStart, false); assert.equal(curve.capEnd, false);
    vectorNear(curve.seam.start.center, curve.seam.end.center, 1e-12);
    vectorNear(curve.seam.start.tangent, curve.seam.end.tangent, 1e-12);
    vectorNear(curve.seam.start.normal, curve.seam.end.normal, 1e-12);
    assert.equal(curve.indexCount, curve.ringCount * curve.radialSegments * 6);
    assert.deepEqual(result, original, 'native endpoints and measured length remain untouched');
  }
});

test('triclinic periodic tube cuts have solid caps and matching frames without cell-spanning triangles', () => {
  const points = fractionalToCartesian([0.8, 0.8, 0.4, 1.2, 1.2, 0.4, 1.3, 1.3, 0.6], cell, new Float64Array(9));
  const result = network(points), original = structuredClone(result), geometry = createDislocationTubeGeometry(result, cell);
  assert.equal(geometry.curves.length, 2, 'simultaneous periodic face crossings produce two pieces');
  const [first, last] = geometry.curves;
  assert.equal(first.capStart, true); assert.equal(first.capEnd, true);
  assert.equal(last.capStart, true); assert.equal(last.capEnd, true);
  vectorNear(first.tangents.slice(-3), last.tangents.slice(0, 3), 1e-12);
  vectorNear(first.normals.slice(-3), last.normals.slice(0, 3), 1e-12);
  vectorNear(first.points.slice(-3).map((value, axis) => value - last.points[axis]), [14, 8, 0]);
  for (const curve of geometry.curves) {
    assertFrames(curve);
    assertSolidCaps(geometry, curve);
    const fractional = cartesianToFractional(curve.points, cell, new Float64Array(curve.points.length));
    assert.ok(fractional.every(value => value >= -1e-9 && value <= 1 + 1e-9));
    const curveIndices = geometry.indices.slice(curve.indexStart, curve.indexStart + curve.indexCount);
    assert.ok(curveIndices.every(index => index >= curve.vertexStart && index < curve.vertexStart + curve.vertexCount), 'faces stay within one periodic piece');
  }
  const firstRing = first.vertexStart + (first.ringCount - 1) * first.radialSegments;
  for (let side = 0; side < first.radialSegments; side += 1) {
    vectorNear(geometry.values.slice((firstRing + side) * 12 + 3, (firstRing + side) * 12 + 9),
      geometry.values.slice((last.vertexStart + side) * 12 + 3, (last.vertexStart + side) * 12 + 9), 1e-12);
  }
  assert.deepEqual(result, original);
});

test('closed periodic winding lines keep their lattice displacement instead of adding a closing connector', () => {
  const points = fractionalToCartesian([0.2, 0.3, 0.1, 0.2, 0.3, 1.1], cell, new Float64Array(6));
  const result = network(points); result.segments[0].closed = true; result.segments[0].isInfinite = true;
  const geometry = createDislocationTubeGeometry(result, cell), curve = geometry.curves[0];
  assert.equal(curve.closed, false, 'periodic continuation joins translated replicas rather than different cell faces');
  assert.equal(curve.capStart, true); assert.equal(curve.capEnd, true);
  assertSolidCaps(geometry, curve);
  vectorNear(curve.tangents.slice(0, 3), curve.tangents.slice(-3), 1e-12);
  vectorNear(curve.normals.slice(0, 3), curve.normals.slice(-3), 1e-12);
  let displayedLength = 0;
  for (let index = 3; index < curve.points.length; index += 3) {
    displayedLength += Math.hypot(...[0, 1, 2].map(axis => curve.points[index + axis] - curve.points[index - 3 + axis]));
  }
  near(displayedLength, 12);
  assert.deepEqual(Array.from(result.segments[0].points), Array.from(points));
  points[points.length - 1] += 1e-7;
  const residualGeometry = createDislocationTubeGeometry(result, cell), residualCurve = residualGeometry.curves[0];
  assert.equal(residualCurve.closed, false);
  assert.equal(residualCurve.capStart, true); assert.equal(residualCurve.capEnd, true);
  assertSolidCaps(residualGeometry, residualCurve);
  near(residualCurve.points.at(-1) - residualCurve.points[2], 12, 1e-12);
  vectorNear(residualCurve.tangents.slice(0, 3), residualCurve.tangents.slice(-3), 1e-12);
  vectorNear(residualCurve.normals.slice(0, 3), residualCurve.normals.slice(-3), 1e-12);
  near(result.segments[0].points.at(-1), points[2] + 12 + 1e-7, 1e-12);
});

test('repeated knots, reversals and uneven spans produce finite tube frames', () => {
  for (const points of [
    [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 5, 0],
    [0, 0, 0, 0.00001, 0, 0, 1, 2, 0, 1, 2, 0, 1, 9, 3],
  ]) {
    const geometry = createDislocationTubeGeometry(network(points), openCell);
    assert.ok(geometry.values.every(Number.isFinite));
    geometry.curves.forEach(assertFrames);
  }
  assert.equal(createDislocationTubeGeometry(network([1, 1, 1, 1, 1, 1]), openCell).count, 0);
});

test('coincident open junction endpoints retain their native open topology', () => {
  const result = network([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 0, 0]);
  Object.assign(result.segments[0], { closed: false, junctions: [[{ segmentId: 2, end: 0 }], [{ segmentId: 3, end: 1 }]] });
  const curve = createDislocationTubeGeometry(result, openCell).curves[0];
  assert.equal(curve.closed, false);
  assert.equal(curve.capStart, true); assert.equal(curve.capEnd, true);
  vectorNear(curve.points.slice(0, 3), curve.points.slice(-3));
  assert.notDeepEqual(Array.from(curve.tangents.slice(0, 3)), Array.from(curve.tangents.slice(-3)), 'branches are not smoothed into a fictitious closed loop');
});

test('multiple slice intersections retain the visible middle of a dislocation segment', () => {
  const slices = validateSlices([
    { normal: [1, 0, 0], position: 1, side: 'negative' },
    { normal: [1, 0, 0], position: -1, side: 'positive', id: 'lower' },
  ]);
  const clipped = clipDislocationSegment([-2, 0, 0], [2, 0, 0], slices, 0);
  assert.deepEqual(clipped, [[-1, 0, 0], [1, 0, 0]]);
  assert.equal(clipDislocationSegment([-2, 3, 0], [-2, 5, 0], slices), null);
  assert.deepEqual(clipDislocationSegment([-2, 0, 0], [2, 0, 0], slices.map(slice => ({ ...slice, enabled: false }))), [[-2, 0, 0], [2, 0, 0]]);
  const slab = validateSlices([{ normal: [1, 0, 0], position: 0.5, slab: true, thickness: 1 }]);
  assert.deepEqual(clipDislocationSegment([-2, 0, 0], [2, 0, 0], slab, 0), [[0, 0, 0], [1, 0, 0]], 'a slab clips a crossing line at both faces');
  assert.equal(clipDislocationSegment([2, 0, 0], [2, 3, 0], slab), null);
});

test('legacy slice planes use full inverse cell, origin and displayed repeat count', () => {
  const renderer = { frame: { cell }, sliceMode: 'legacy', sliceAxis: 0, sliceMaximum: 0.6, repetitions: [2, 1, 1] };
  const planes = dislocationSlicePlanes(renderer);
  const onPlane = fractionalToCartesian(new Float64Array([1.2, 0.8, 0.2]), cell, new Float64Array(3));
  const signed = point => [0, 1, 2].reduce((sum, axis) => sum + point[axis] * planes.values[axis], 0) - planes.values[3];
  near(signed(onPlane), 0);
  const inside = fractionalToCartesian(new Float64Array([1.1, 0.8, 0.2]), cell, new Float64Array(3));
  const outside = fractionalToCartesian(new Float64Array([1.3, 0.8, 0.2]), cell, new Float64Array(3));
  assert.ok(signed(inside) < 0); assert.ok(signed(outside) > 0);
  assert.equal(planes.count, 1);
});

function mockGl() {
  let next = 0, offset;
  const calls = { data: [], draws: [], shaders: [] };
  const gl = {
    ARRAY_BUFFER: 1, STATIC_DRAW: 2, FLOAT: 3, VERTEX_SHADER: 4, FRAGMENT_SHADER: 5, COMPILE_STATUS: 6, LINK_STATUS: 7, TRIANGLES: 8,
    ELEMENT_ARRAY_BUFFER: 9, UNSIGNED_INT: 10,
    createProgram: () => ({}), createShader: () => ({}), shaderSource(shader, source) { calls.shaders.push(source); },
    compileShader() {}, getShaderParameter: () => true, attachShader() {}, deleteShader() {}, linkProgram() {}, getProgramParameter: () => true,
    getUniformLocation: (program, name) => name, createVertexArray: () => ({}), createBuffer: () => ({ id: next++ }),
    bindVertexArray() {}, bindBuffer() {}, bufferData(target, values) { calls.data.push(values); },
    enableVertexAttribArray() {}, vertexAttribPointer() {}, vertexAttribDivisor() {}, useProgram() {},
    uniformMatrix4fv() {}, uniform1f() {}, uniform1i() {}, uniform4fv() {},
    uniform3f(location, ...value) { if (location === 'uReplicaOffset') offset = value; },
    drawElements(mode, count, type, first) { calls.draws.push({ count, type, first, offset }); },
  };
  return { gl, calls };
}

test('display replication and slicing reuse dislocation source geometry and exports draw the same layer', () => {
  const { gl, calls } = mockGl(), layer = new DislocationLayer(gl);
  const renderer = { frame: { cell }, visibility: new Uint8Array([0]), viewMatrix: new Float32Array(16), projectionMatrix: new Float32Array(16),
    sliceMode: 'planes', sliceCount: 0, slicePlaneValues: new Float32Array(64), ...createReplication(cell, [2, 1, 1]) };
  const result = network(new Float64Array([7, 7, 8, 8, 7, 8]));
  layer.setNetwork(renderer, result, { radius: 0.25 });
  const uploads = calls.data.length;
  layer.render(renderer);
  assert.equal(calls.draws.length, 2);
  assert.ok(calls.draws.every(draw => draw.count === layer.indexCount && draw.type === gl.UNSIGNED_INT));
  assert.deepEqual(calls.draws.map(draw => draw.offset), [[0, 0, 0], [10, 0, 0]]);
  renderer.sliceCount = 1;
  layer.render(renderer);
  layer.setNetwork(renderer, result, { radius: 0.4 });
  assert.equal(calls.data.length, uploads, 'changing slices, radius or display repeats must not upload a network again');
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  layer.extendBounds(renderer, minimum, maximum);
  vectorNear(minimum, [6.6, 6.6, 7.6]);
  vectorNear(maximum, [18.4, 7.4, 8.4]);
  assert.equal(result.totalLength, 2);
  layer.setNetwork(renderer, result, { enabled: false });
  const draws = calls.draws.length;
  layer.render(renderer);
  assert.equal(calls.draws.length, draws);
  layer.clear();
  assert.equal(layer.count, 0);
  assert.equal(calls.data.at(-1), 0);
  layer.setNetwork({ frame: null }, null);
  assert.equal(layer.geometry, null, 'clearing an already closed frame remains valid');
  assert.ok(calls.shaders[1].includes('uSlicePlanes'), 'tube surfaces use Cartesian half-space clipping');
  assert.ok(calls.shaders[0].includes('uProjection * uView'), 'tube vertices use the same camera and projection as atoms and exports');
});

test('clearing the dislocation renderer API retains the loaded analysis frame', () => {
  const renderer = Object.create(WebGLRenderer.prototype), frame = {};
  let redraws = 0;
  Object.assign(renderer, { frame, dislocationNetwork: {}, requestRender() { redraws += 1; } });
  renderer.setDislocationNetwork(null);
  assert.equal(renderer.frame, frame);
  assert.equal(renderer.dislocationNetwork, null);
  assert.equal(redraws, 1);
  assert.equal(renderer.dislocationOptions.radius, 0.2);
});
