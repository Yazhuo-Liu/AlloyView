import test from 'node:test';
import assert from 'node:assert/strict';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';
import { lookAt } from '../src/render/math.js';

function fixture() {
  let renders = 0, projection;
  const renderer = Object.assign(Object.create(WebGLRenderer.prototype), {
    canvas: { width: 800, height: 400 }, frame: {},
    target: [1, 2, 3], pan: [4, 5, 6], yaw: -.62, pitch: .38,
    roll: 0, constrainUp: true, distance: 10, orthographicScale: 5,
    fov: 40 * Math.PI / 180, projectionMode: 'perspective', modelRadius: 2,
    requestRender() { renders++; }, onProjectionChange(mode) { projection = mode; },
  });
  return { renderer, renders: () => renders, projection: () => projection };
}
function close(a, b, tolerance = 1e-10) { assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`); }
function closeVector(a, b, tolerance) { a.forEach((value, axis) => close(value, b[axis], tolerance)); }

test('precise camera values use Cartesian coordinates, normalized directions, and horizontal parallel field width', () => {
  const { renderer: r } = fixture();
  const state = r.getCameraState(), offset = r.cameraOrientation().offsetDirection;
  closeVector(state.center, [5, 7, 9]);
  closeVector(state.position, offset.map((value, axis) => state.center[axis] + value * 10));
  closeVector(state.direction, offset.map(value => -value));
  close(Math.hypot(...state.direction), 1); close(Math.hypot(...state.up), 1);
  close(state.up.reduce((sum, value, axis) => sum + value * state.direction[axis], 0), 0);
  close(state.fieldWidth, 20);
});

test('editing position translates the camera while keeping its direction and orbit distance', () => {
  const { renderer: r, renders } = fixture(), before = r.getCameraState();
  const position = [20, -3, 11];
  r.setCameraState({ position });
  const after = r.getCameraState();
  closeVector(after.position, position); closeVector(after.direction, before.direction);
  closeVector(r.pan, [0, 0, 0]); close(r.distance, 10); assert.equal(renders(), 1);
});

test('editing a nonunit direction rotates about the eye and rejects an invalid zero direction', () => {
  const { renderer: r, renders } = fixture(), before = r.getCameraState();
  r.setCameraState({ direction: [2, -3, 4] });
  closeVector(r.getCameraState().position, before.position);
  closeVector(r.getCameraState().direction, [2, -3, 4].map(value => value / Math.sqrt(29)));
  const saved = r.getCameraState();
  assert.throws(() => r.setCameraState({ position: [50, 50, 50], direction: [0, 0, 0], fov: Math.PI / 3 }), /nonzero/);
  assert.deepEqual(r.getCameraState(), saved); assert.equal(renders(), 1);
});

test('roll changes screen up and right without changing camera position or viewing direction', () => {
  const { renderer: r } = fixture(), before = r.getCameraState(), basis = r.cameraBasis();
  r.setCameraState({ constrainUp: false, roll: Math.PI / 2 });
  const after = r.getCameraState();
  closeVector(after.position, before.position); closeVector(after.direction, before.direction);
  closeVector(after.up, basis.right);
  closeVector(r.cameraBasis().right, basis.up.map(value => -value));
  const view = lookAt(after.position, after.center, after.up);
  closeVector([view[1], view[5], view[9]], after.up, 1e-7);
});

test('releasing Z upright preserves top and bottom views; free orbit crosses a pole smoothly', () => {
  for (const pitch of [Math.PI / 2, -Math.PI / 2]) {
    const { renderer: r } = fixture(); r.yaw = 0; r.pitch = pitch;
    const before = r.getCameraState();
    r.setCameraState({ constrainUp: false });
    closeVector(r.getCameraState().up, before.up);
    const up = r.getCameraState().up;
    r.orbitCamera(0, .0001);
    assert.ok(Math.abs(r.pitch) > Math.abs(pitch));
    assert.ok(up.reduce((sum, value, axis) => sum + value * r.getCameraState().up[axis], 0) > .999);
  }
});

test('restoring Z upright after crossing a pole retains the viewing direction and clamps subsequent mouse orbit', () => {
  const { renderer: r } = fixture();
  r.setCameraState({ constrainUp: false, pitch: 2.5, roll: .8 });
  const before = r.getCameraState();
  r.setCameraState({ constrainUp: true });
  const after = r.getCameraState();
  closeVector(after.position, before.position); closeVector(after.direction, before.direction);
  close(after.roll, 0); assert.ok(Math.abs(r.pitch) <= Math.PI / 2);
  r.orbitCamera(0, 10); close(r.pitch, Math.PI / 2 - .008);
});

test('projection, FOV and parallel field-width edits keep orientation and validate before mutation', () => {
  const { renderer: r, projection } = fixture(), before = r.getCameraState();
  r.setCameraState({ projectionMode: 'orthographic', fieldWidth: 12, fov: Math.PI / 3 });
  assert.equal(projection(), 'orthographic'); close(r.orthographicScale, 3); close(r.fov, Math.PI / 3);
  closeVector(r.getCameraState().direction, before.direction);
  closeVector(r.getCameraState().position, before.position);
  for (const patch of [{ fov: 0 }, { fov: Math.PI }, { fieldWidth: -1 }, { distance: NaN },
    { yaw: Infinity }, { pitch: Math.PI }, { projectionMode: 'invalid' }, { position: [1, 2] }, { constrainUp: 1 }]) {
    const saved = r.getCameraState();
    assert.throws(() => r.setCameraState(patch)); assert.deepEqual(r.getCameraState(), saved);
  }
});

test('camera values follow mouse-style orbit, screen-space pan, and zoom without reading stale matrices', () => {
  const { renderer: r } = fixture(), before = r.getCameraState();
  r.orbitCamera(.1, -.2); r.pan = [10, 20, 30]; r.distance *= .5;
  const after = r.getCameraState();
  assert.notDeepEqual(after.position, before.position); assert.notDeepEqual(after.direction, before.direction);
  closeVector(after.center, [11, 22, 33]);
  close(Math.hypot(...after.position.map((value, axis) => value - after.center[axis])), 5);
  r.projectionMode = 'orthographic'; r.orthographicScale *= .25;
  close(r.getCameraState().fieldWidth, 5);
});

for (const roll of [0, Math.PI / 2, -Math.PI / 2, .73]) {
  test(`free orbit at roll ${roll} keeps horizontal gestures horizontal in screen coordinates`, () => {
    const { renderer: r } = fixture();
    r.setCameraState({ constrainUp: false, roll });
    const before = r.getCameraState(), offset = before.direction.map(value => -value), { right } = r.cameraBasis();
    const angle = .12;
    r.orbitCamera(angle, 0);
    const after = r.getCameraState(), expected = offset.map((value, axis) => value * Math.cos(angle) + right[axis] * Math.sin(angle));
    closeVector(after.direction, expected.map(value => -value));
    closeVector(after.up, before.up);
    closeVector(after.center, before.center); close(after.distance, before.distance);
  });

  test(`free orbit at roll ${roll} keeps vertical gestures vertical in screen coordinates`, () => {
    const { renderer: r } = fixture();
    r.setCameraState({ constrainUp: false, roll });
    const before = r.getCameraState(), offset = before.direction.map(value => -value), { right } = r.cameraBasis();
    const angle = -.08;
    r.orbitCamera(0, angle);
    const after = r.getCameraState();
    const expected = offset.map((value, axis) => value * Math.cos(angle) + before.up[axis] * Math.sin(angle));
    closeVector(after.direction, expected.map(value => -value));
    closeVector(r.cameraBasis().right, right);
    closeVector(after.up, before.up.map((value, axis) => value * Math.cos(angle) - offset[axis] * Math.sin(angle)));
  });
}

test('combined free orbit has an exact reverse after a pole crossing and retains a complete serializable orientation', () => {
  const { renderer: r } = fixture();
  r.setCameraState({ constrainUp: false, pitch: Math.PI * .7, yaw: -2.4, roll: 1.2 });
  const before = r.getCameraState();
  r.orbitCamera(.37, -.22); r.orbitCamera(-.37, .22);
  const after = r.getCameraState();
  closeVector(after.position, before.position); closeVector(after.direction, before.direction); closeVector(after.up, before.up);
  assert.ok([r.yaw, r.pitch, r.roll].every(Number.isFinite));
  const { renderer: restored } = fixture();
  restored.setCameraState({ yaw: r.yaw, pitch: r.pitch, roll: r.roll, constrainUp: false });
  closeVector(restored.getCameraState().direction, after.direction); closeVector(restored.getCameraState().up, after.up);
});
