import assert from 'node:assert/strict';
import test from 'node:test';
import { cellVertices, createCell } from '../src/data/model.js';
import { createReplication } from '../src/render/replication.js';
import { scale, transformPoint } from '../src/render/math.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

function fixture(cell = createCell({ vectors: [1144, 0, 0, 0, 183.04, 0, 0, 0, 11.44] })) {
  const renderer = Object.assign(Object.create(WebGLRenderer.prototype), {
    frame: { cell, fractional: new Float32Array([.0025, .015625, .5]) },
    displayPositions: new Float32Array([2.86, 2.86, 5.72]),
    atomCount: 1, atomRadii: new Float32Array([1.26]), maximumAtomRadius: 1.26,
    visibility: new Uint8Array([255]), radiusScale: 1, sliceAxis: 2, sliceMaximum: 1,
    fov: 40 * Math.PI / 180, projectionMode: 'orthographic',
    canvas: { width: 1728, height: 925, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1728, height: 925 }) },
    requestRender() {}, onCameraChange() {}, onProjectionChange() {},
    gl: { ARRAY_BUFFER: 1, STATIC_DRAW: 2, bindBuffer() {}, bufferData() {}, finish() {} },
  });
  Object.assign(renderer, createReplication(cell));
  renderer.resetCamera();
  return renderer;
}

function assertDepths(renderer, positions) {
  for (let i = 0; i < positions.length; i += 3) {
    const clip = transformPoint(renderer.viewProjectionMatrix, ...positions.subarray(i, i + 3));
    const z = clip[2] / clip[3];
    assert.ok(z > -1 && z < 1, `position ${i / 3} has clipped depth ${z}`);
  }
}

test('a close perspective distance cannot clip the cell after switching to orthographic', () => {
  const r = fixture();
  r.distance = r.modelRadius * .25; // The old positive near plane cut four cell corners here.
  const savedDistance = r.distance, savedScale = r.orthographicScale;
  r.updateMatrices();
  assertDepths(r, cellVertices(r.displayCell));
  assertDepths(r, r.displayPositions);
  assert.equal(r.distance, savedDistance, 'preserve the perspective zoom for switching back');
  assert.equal(r.orthographicScale, savedScale);
  const vertices = cellVertices(r.displayCell), closeView = [];
  for (let i = 0; i < vertices.length; i += 3) {
    closeView.push(transformPoint(r.viewProjectionMatrix, ...vertices.subarray(i, i + 3)).slice(0, 2));
  }
  r.distance *= 20;
  r.updateMatrices();
  for (let i = 0; i < vertices.length; i += 3) {
    const clip = transformPoint(r.viewProjectionMatrix, ...vertices.subarray(i, i + 3));
    clip.slice(0, 2).forEach((value, axis) => assert.ok(Math.abs(value - closeView[i / 3][axis]) < 1e-5));
  }
});

test('orthographic clipping covers the entire scene at every standard view and orbit', () => {
  const r = fixture();
  r.distance = .02;
  for (const name of ['front', 'back', 'left', 'right', 'top', 'bottom']) {
    r.setView(name); r.updateMatrices();
    assertDepths(r, cellVertices(r.displayCell));
  }
  for (const [yaw, pitch] of [[-.62, .38], [2.7, -1.1], [-2.9, 1.4]]) {
    r.yaw = yaw; r.pitch = pitch; r.pan = [50, -10, 15]; r.updateMatrices();
    assertDepths(r, cellVertices(r.displayCell));
  }
});

test('atoms in the formerly clipped foreground remain pickable in orthographic views', () => {
  const r = fixture();
  r.distance = r.modelRadius * .25;
  r.updateMatrices();
  const clip = transformPoint(r.viewProjectionMatrix, ...r.displayPositions);
  assert.ok(Math.abs(clip[0]) < 1 && Math.abs(clip[1]) < 1);
  assert.equal(r.pick((clip[0] * .5 + .5) * r.canvas.width, (.5 - clip[1] * .5) * r.canvas.height), 0);
});

test('clipping tracks growing unwrapped coordinates without resetting the camera', () => {
  const r = fixture();
  const originalTarget = [...r.target], originalRadius = r.modelRadius;
  const positions = new Float32Array([150000, -30000, 5000]);
  r.setDisplayPositions(positions);
  r.updateMatrices();
  assertDepths(r, positions);
  assertDepths(r, cellVertices(r.displayCell));
  assert.deepEqual(r.target, originalTarget);
  assert.equal(r.modelRadius, originalRadius);
  assert.equal(r.displayPositions, positions);
});

test('replicated atoms with negative cell vectors remain within the depth range', () => {
  const cell = createCell({ vectors: [4, 1, 0, -2, 3, 1, 1, -1, 5], triclinic: true });
  const r = fixture(cell);
  r.distance = .02;
  r.setReplications([4, 3, 2]);
  r.updateMatrices();
  assertDepths(r, cellVertices(r.displayCell));
  for (const replica of r.replicas) {
    const position = r.displayPositions.map((value, axis) => value + replica.offset[axis]);
    assertDepths(r, position);
  }
});

test('depth padding includes enlarged sphere surfaces in both projections', () => {
  const r = fixture();
  r.setRadiusScale(5);
  for (const mode of ['orthographic', 'perspective']) {
    r.projectionMode = mode; r.updateMatrices();
    const direction = r.cameraOrientation().offsetDirection;
    const radius = r.maximumAtomRadius * r.radiusScale;
    const front = r.displayPositions.map((value, axis) => value + scale(direction, radius)[axis]);
    const back = r.displayPositions.map((value, axis) => value - scale(direction, radius)[axis]);
    assertDepths(r, front); assertDepths(r, back);
  }
});
