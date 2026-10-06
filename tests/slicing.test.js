import assert from 'node:assert/strict';
import test from 'node:test';
import { cartesianToFractional, cellVertices, createCell } from '../src/data/model.js';
import { cross, dot, subtract, transformPoint } from '../src/render/math.js';
import { createReplication } from '../src/render/replication.js';
import {
  MAX_SLICES, planeBoxPolygon, planeCellPolygon, pointVisible,
  projectBoundsOnNormal, validateSlice, validateSlices,
} from '../src/render/slicing.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

const box = { minimum: [0, 0, 0], maximum: [1, 1, 1] };
const slice = (normal, position, options = {}) => validateSlice({ normal, position, ...options });

test('Cartesian slice normals normalize without changing the absolute plane distance', () => {
  const original = { id: 'a', name: '倾斜面', normal: [2, 2, 0], position: 3, side: 'positive', enabled: false };
  const normalized = validateSlice(original);
  assert.ok(Math.abs(Math.hypot(...normalized.normal) - 1) < 1e-12);
  assert.equal(normalized.position, 3);
  assert.equal(normalized.side, 'positive');
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.name, '倾斜面');
  assert.deepEqual(original.normal, [2, 2, 0]);
  assert.notEqual(normalized.normal, original.normal);
  assert.ok(Math.abs(Math.hypot(...validateSlice({ normal: [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE], position: 0 }).normal) - 1) < 1e-12);
  for (const invalid of [
    { normal: [0, 0, 0], position: 0 },
    { normal: [1, NaN, 0], position: 0 },
    { normal: [1, 0], position: 0 },
    { normal: [1, 0, 0], position: Infinity },
    { normal: [1, 0, 0], position: 0, side: 'both' },
    { normal: [1, 0, 0], position: 0, enabled: 'false' },
  ]) assert.throws(() => validateSlice(invalid));
  assert.throws(() => validateSlices(Array.from({ length: MAX_SLICES + 1 }, (_, i) => ({ id: `s${i}`, normal: [1, 0, 0], position: i }))), /at most/);
  assert.throws(() => validateSlices([original, original]), /unique/);
});

test('enabled slices intersect half-spaces and include atoms on each boundary', () => {
  const planes = validateSlices([
    { id: 'lower', normal: [1, 0, 0], position: 2, side: 'positive' },
    { id: 'upper', normal: [1, 1, 0], position: 3 * Math.SQRT2 },
    { id: 'disabled', normal: [0, 0, 1], position: -100, enabled: false },
  ]);
  assert.equal(pointVisible([2, 4, 10], planes), true);
  assert.equal(pointVisible([1.9, 0, 10], planes), false);
  assert.equal(pointVisible([2, 4.1, 10], planes), false);
  assert.equal(pointVisible([99, 99, 99], []), true);
  assert.deepEqual(projectBoundsOnNormal([-1, 0, 0], box), { minimum: -1, maximum: 0 });
});

test('a tilted plane intersects the box in a consistently ordered hexagon', () => {
  const plane = slice([1, 1, 1], Math.sqrt(3) / 2);
  const polygon = planeBoxPolygon(plane, box);
  assert.equal(polygon.length, 6);
  for (const point of polygon) {
    assert.ok(Math.abs(dot(plane.normal, point) - plane.position) < 1e-12);
    assert.ok(point.every(value => value >= -1e-12 && value <= 1 + 1e-12));
  }
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length], c = polygon[(i + 2) % polygon.length];
    assert.ok(dot(cross(subtract(b, a), subtract(c, b)), plane.normal) > 0);
  }
  assert.equal(planeBoxPolygon(slice([1, 0, 0], 0), box).length, 4, 'a coincident box face is retained');
  assert.deepEqual(planeBoxPolygon(slice([1, 1, 1], -1), box), []);
  assert.deepEqual(planeBoxPolygon(slice([1, 1, 1], 0), box), [], 'a single tangent vertex has no drawable area');
});

test('plane polygons intersect the actual skew cell instead of its bounding box', () => {
  const cell = createCell({ origin: [3, -2, 1], vectors: [4, 1, 0, -2, 3, 1, 1, -1, 5], triclinic: true });
  const plane = slice([1, 1, -1], 0.5);
  const polygon = planeCellPolygon(plane, cellVertices(cell));
  assert.ok(polygon.length >= 3);
  for (const point of polygon) {
    assert.ok(Math.abs(dot(plane.normal, point) - plane.position) < 1e-7);
    const fractional = cartesianToFractional(point, cell, new Float64Array(3));
    assert.ok(Array.from(fractional).every(value => value >= -1e-7 && value <= 1 + 1e-7));
  }
});

function rendererFixture() {
  const cell = createCell({ vectors: [4, 1, 0, -2, 3, 1, 1, -1, 5], triclinic: true });
  const positions = new Float32Array([1, 1, 1, 2, 2, 2]);
  const renderer = Object.assign(Object.create(WebGLRenderer.prototype), {
    frame: { positions, fractional: new Float32Array([0.2, 0.2, 0.2, 0.4, 0.4, 0.4]), cell },
    displayPositions: positions, atomCount: 2, visibility: new Uint8Array([255, 255]),
    atomRadii: new Float32Array([0.2, 0.2]), maximumAtomRadius: 0.2, radiusScale: 1,
    sliceAxis: 2, sliceMaximum: 1, sliceMode: 'legacy',
    fov: 40 * Math.PI / 180, projectionMode: 'orthographic',
    canvas: { width: 800, height: 600, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) },
    requestRender() {}, onCameraChange() {}, onProjectionChange() {},
    gl: { ARRAY_BUFFER: 1, STATIC_DRAW: 2, bindBuffer() {}, bufferData() {}, finish() {} },
  });
  Object.assign(renderer, createReplication(cell, [2, 1, 1]));
  renderer.resetCamera();
  return renderer;
}

test('replicated and unwrapped atom visibility follows the rendered Cartesian centers', () => {
  const r = rendererFixture(), original = r.frame.positions;
  r.setSlices([{ id: 'x', normal: [1, 0, 0], position: 4.5, side: 'positive' }]);
  assert.equal(r.isAtomVisible(0), false);
  assert.equal(r.isAtomVisible(0, [1, 0, 0]), true, 'a skew replica moves along a, not the X axis alone');
  assert.equal(r.isAnyReplicaVisible(0), true, 'selection remains visible when its source image is cut away');
  r.visibility[0] = 0;
  assert.equal(r.isAnyReplicaVisible(0), false);
  r.visibility[0] = 255;
  r.setDisplayPositions(new Float32Array([20, 1, 1, 2, 2, 2]));
  assert.equal(r.isAtomVisible(0), true, 'the slice uses unwrapped display positions, not wrapped fractions');
  assert.equal(r.frame.positions, original);
  assert.deepEqual(Array.from(original), [1, 1, 1, 2, 2, 2]);
  const bounds = r.getDisplayBounds();
  assert.equal(bounds.maximum[0], 24);
  bounds.maximum[0] = 999;
  assert.equal(r.getDisplayBounds().maximum[0], 24, 'external bounds edits cannot corrupt camera clipping');
  assert.equal(r.getDisplayCellVertices().length, 24);
});

test('picking respects all planes on every replica and preserves the original atom identity', () => {
  const r = rendererFixture();
  r.setSlices([{ id: 'x', normal: [1, 0, 0], position: 4.5, side: 'positive' }]);
  r.setView('top');
  r.updateMatrices();
  const clip = transformPoint(r.viewProjectionMatrix, 5, 2, 1);
  const screen = [(clip[0] / clip[3] * 0.5 + 0.5) * 800, (0.5 - clip[1] / clip[3] * 0.5) * 600];
  assert.equal(r.pick(...screen), 0);
  r.setSlices([
    { id: 'x', normal: [1, 0, 0], position: 4.5, side: 'positive' },
    { id: 'y', normal: [0, 1, 0], position: 1.5 },
  ]);
  assert.equal(r.pick(...screen), -1);
  r.setSlices([]);
  assert.equal(r.pick(...screen), 0);
});

test('plane uniforms match the kept sides and never duplicate atom buffers', () => {
  const r = rendererFixture(), originalFrame = r.frame, positions = r.displayPositions;
  const uniforms = [], draws = [];
  let renderNotifications = 0;
  Object.assign(r, {
    resize() {}, updateMatrices() {}, background: [0, 0, 0], cellVisible: false,
    voronoiCellOptions: { enabled: false, allEnabled: false },
    onRender(renderer) { assert.equal(renderer, r); renderNotifications += 1; },
    sphereUniforms: Object.fromEntries(['uView', 'uProjection', 'uRadiusScale', 'uSliceAxis', 'uSliceMaximum',
      'uSliceMode', 'uSliceCount', 'uSlicePlanes[0]', 'uSelected', 'uRepetitions', 'uReplicaOffset', 'uReplicaIndex']
      .map(name => [name, name])),
  });
  Object.assign(r.gl, {
    clearColor() {}, clear() {}, colorMask() {}, disable() {}, useProgram() {}, bindVertexArray() {},
    uniformMatrix4fv() {}, uniform1f() {}, uniform3f() {},
    uniform1i(name, value) { uniforms.push([name, value]); },
    uniform4fv(name, values) { uniforms.push([name, Array.from(values)]); },
    drawArraysInstanced(mode, first, count, atoms) { draws.push(atoms); },
    bufferData() { throw new Error('Changing slice parameters must not upload atom buffers.'); },
  });
  r.setSlices([
    { id: 'lo', normal: [2, 0, 0], position: 1, side: 'positive' },
    { id: 'hi', normal: [0, 1, 0], position: 2 },
    { id: 'off', normal: [0, 0, 1], position: 0, enabled: false },
  ]);
  r.render(0, { trackStats: false });
  assert.deepEqual(uniforms.find(([name]) => name === 'uSlicePlanes[0]')[1].slice(0, 8), [-1, -0, -0, -1, 0, 1, 0, 2]);
  assert.equal(uniforms.find(([name]) => name === 'uSliceCount')[1], 2);
  assert.equal(uniforms.find(([name]) => name === 'uSliceMode')[1], 1);
  assert.deepEqual(draws, [2, 2]);
  assert.equal(r.frame, originalFrame);
  assert.equal(r.displayPositions, positions);
  assert.equal(renderNotifications, 1);
  assert.throws(() => r.setSlices([{ normal: [0, 0, 0], position: 0 }]));
  assert.equal(r.slices.length, 3, 'failed validation does not change the currently rendered slices');
  r.setSlice(0, 0.5);
  assert.equal(r.sliceMode, 'legacy');
});
