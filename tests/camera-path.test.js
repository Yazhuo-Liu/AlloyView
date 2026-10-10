import assert from 'node:assert/strict';
import test from 'node:test';
import { addKeyframe, anglesFromBasis, applyCamera, basisFromQuaternion, cameraBasis, cameraPathDuration, captureCamera, createCameraPath,
  DEFAULT_KEYFRAME_SPACING, MAX_CAMERA_KEYFRAMES, moveKeyframe, normalizeCameraPathState, planMovie, quaternionFromBasis, removeKeyframe,
  retimeKeyframe, sampleCameraPath, slerpQuaternion, trajectoryFrameAt } from '../src/camera-path.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

const DEGREE = Math.PI / 180;
const camera = (overrides = {}) => ({ yaw: -0.62, pitch: 0.38, roll: 0, fov: 40 * DEGREE, constrainUp: true, target: [1, 2, 3], pan: [0, 0, 0],
  distance: 30, orthographicScale: 12, projectionMode: 'perspective', ...overrides });
const path = (keyframes, extra = {}) => ({ ...createCameraPath(), keyframes: keyframes.map(([time, value, frame = null]) => ({ time, camera: value, frame })), ...extra });
const close = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label ?? 'value'}: ${actual} ≈ ${expected}`);
const closeVector = (actual, expected, tolerance, label) => actual.forEach((value, index) => close(value, expected[index], tolerance, `${label}[${index}]`));
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const quaternionAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(dot(a, b))));
const basisAngle = (a, b) => quaternionAngle(quaternionFromBasis(a), quaternionFromBasis(b));
function random(seed) { let state = seed >>> 0; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; }; }

test('camera bases equal the renderer\'s for upright, rolled and pole views', () => {
  const next = random(7);
  const cameras = [camera(), camera({ yaw: 0, pitch: Math.PI / 2 }), camera({ yaw: 0, pitch: -Math.PI / 2 }), camera({ yaw: 2, pitch: Math.PI / 2 }),
    camera({ constrainUp: false, roll: 0.7 }), camera({ constrainUp: false, pitch: 2.1, yaw: 9, roll: -2 }), camera({ constrainUp: false, pitch: Math.PI / 2, yaw: 0.3, roll: 1 }),
    ...Array.from({ length: 40 }, () => camera({ yaw: (next() - 0.5) * 20, pitch: (next() - 0.5) * 3.1, roll: (next() - 0.5) * 6, constrainUp: next() > 0.5 }))];
  for (const value of cameras) {
    const renderer = Object.assign(Object.create(WebGLRenderer.prototype), value);
    const expected = { ...renderer.cameraBasis(), back: renderer.cameraOrientation().offsetDirection }, actual = cameraBasis(value);
    for (const name of ['right', 'up', 'back']) closeVector(actual[name], expected[name], 1e-12, name);
    // The basis is right-handed and orthonormal: right × up = back.
    const { right, up, back } = actual;
    closeVector([right[1] * up[2] - right[2] * up[1], right[2] * up[0] - right[0] * up[2], right[0] * up[1] - right[1] * up[0]], back, 1e-12, 'right × up');
  }
});

test('quaternions round-trip camera bases and orbit angles reproduce them', () => {
  const next = random(11);
  for (let trial = 0; trial < 200; trial++) {
    const value = camera({ yaw: (next() - 0.5) * 12, pitch: (next() - 0.5) * 6, roll: (next() - 0.5) * 6, constrainUp: false });
    const basis = cameraBasis(value), q = quaternionFromBasis(basis);
    close(Math.hypot(...q), 1, 1e-12, 'unit quaternion');
    const restored = basisFromQuaternion(q);
    for (const name of ['right', 'up', 'back']) closeVector(restored[name], basis[name], 1e-12, name);
    const angles = anglesFromBasis(restored), again = cameraBasis({ ...value, ...angles, constrainUp: false });
    assert.ok(Math.abs(angles.pitch) <= Math.PI / 2 + 1e-12);
    for (const name of ['right', 'up', 'back']) closeVector(again[name], basis[name], 1e-9, `angles ${name}`);
  }
  // Straight down the Z axis the azimuth is open; any hint gives the same view.
  const top = cameraBasis(camera({ yaw: 0.4, pitch: Math.PI / 2, roll: 0.9, constrainUp: false }));
  for (const hint of [0, 1, -2.5]) {
    const angles = anglesFromBasis(top, hint);
    assert.equal(angles.yaw, hint);
    assert.ok(basisAngle(cameraBasis(camera({ ...angles, constrainUp: false })), top) < 1e-7);
  }
  // All four branches of the matrix conversion.
  for (const q of [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [0.1, 0.9, 0.3, 0.3], [0.1, 0.3, 0.9, 0.3], [0.1, 0.3, 0.3, 0.9]]) {
    const unit = q.map(value => value / Math.hypot(...q));
    assert.ok(quaternionAngle(quaternionFromBasis(basisFromQuaternion(unit)), unit) < 1e-7);
  }
});

test('slerp follows the shorter arc at constant angular speed with exact endpoints', () => {
  const next = random(3);
  for (let trial = 0; trial < 100; trial++) {
    const a = quaternionFromBasis(cameraBasis(camera({ yaw: next() * 6, pitch: next() * 3 - 1.5, roll: next() * 6, constrainUp: false })));
    const b = quaternionFromBasis(cameraBasis(camera({ yaw: next() * 6, pitch: next() * 3 - 1.5, roll: next() * 6, constrainUp: false })));
    const total = quaternionAngle(a, b);
    assert.ok(total <= Math.PI + 1e-12, 'never more than half a turn');
    assert.deepEqual(slerpQuaternion(a, b, 0), a);
    assert.ok(quaternionAngle(slerpQuaternion(a, b, 1), b) < 1e-7);
    for (const t of [0.1, 0.25, 0.5, 0.9]) {
      const q = slerpQuaternion(a, b, t);
      close(Math.hypot(...q), 1, 1e-12, 'unit');
      close(quaternionAngle(a, q), t * total, 1e-7, 'angle from the start');
      close(quaternionAngle(q, b), (1 - t) * total, 1e-7, 'angle to the end');
      // q and −q are the same rotation: the result must not depend on the sign.
      assert.ok(quaternionAngle(slerpQuaternion(a, b.map(value => -value), t), q) < 1e-7);
    }
  }
  // 350° apart about Z is 10° the other way.
  const turn = angle => [Math.cos(angle / 2), 0, 0, Math.sin(angle / 2)];
  const middle = slerpQuaternion(turn(0), turn(350 * DEGREE), 0.5);
  assert.ok(quaternionAngle(middle, turn(-5 * DEGREE)) < 1e-9);
  // Nearly equal rotations stay finite and normalized.
  const near = slerpQuaternion(turn(1), turn(1 + 1e-9), 0.5);
  close(Math.hypot(...near), 1, 1e-12, 'unit'); assert.ok(near.every(Number.isFinite));
});

test('keyframes are reproduced exactly and the camera holds outside the path', () => {
  const first = camera({ yaw: 7.5, pitch: 0.2, target: [1, 2, 3], pan: [0.5, 0, -1] });
  const second = camera({ yaw: -3, pitch: 1.1, roll: 0.4, constrainUp: false, distance: 55, fov: 20 * DEGREE, orthographicScale: 3, projectionMode: 'orthographic' });
  const third = camera({ yaw: 0, pitch: Math.PI / 2, distance: 10 });
  const value = path([[1, first], [3.5, second], [4, third]]);
  for (const [time, expected] of [[1, first], [3.5, second], [4, third], [0, first], [-5, first], [99, third], [NaN, first]]) {
    assert.deepEqual(sampleCameraPath(value, time), expected, `time ${time}`);
  }
  // Samples are detached copies.
  sampleCameraPath(value, 1).target[0] = 99;
  assert.equal(first.target[0], 1);
  assert.equal(sampleCameraPath(createCameraPath(), 1), null);
  assert.deepEqual(sampleCameraPath(path([[2, first]]), 5), first);
  assert.equal(cameraPathDuration(value), 4); assert.equal(cameraPathDuration(createCameraPath()), 0);
});

test('upright segments stay upright and turn the shorter way; other segments slerp without the constraint', () => {
  const a = camera({ yaw: 350 * DEGREE, pitch: 10 * DEGREE }), b = camera({ yaw: 10 * DEGREE + 4 * Math.PI, pitch: 50 * DEGREE });
  const upright = path([[0, a], [2, b]]);
  for (const time of [0.25, 1, 1.75]) {
    const sample = sampleCameraPath(upright, time), u = time / 2;
    assert.equal(sample.constrainUp, true); assert.equal(sample.roll, 0);
    close(sample.yaw, (350 + 20 * u) * DEGREE, 1e-12, 'azimuth through 0°, not through 180°');
    close(sample.pitch, (10 + 40 * u) * DEGREE, 1e-12, 'elevation');
    closeVector(cameraBasis(sample).up.slice(2), [Math.cos(sample.pitch)], 1e-12, 'screen up keeps a positive Z part');
  }
  // Exactly opposite azimuths still give a finite, upright path.
  const opposite = sampleCameraPath(path([[0, camera({ yaw: 0 })], [1, camera({ yaw: Math.PI })]]), 0.5);
  close(Math.abs(opposite.yaw), Math.PI / 2, 1e-12, 'half-way');
  // Top view to front view: continuous from the pole, where yaw 0 means screen-up +Y.
  const descend = path([[0, camera({ yaw: 0, pitch: Math.PI / 2 })], [1, camera({ yaw: 0, pitch: 0 })]]);
  assert.ok(basisAngle(cameraBasis(sampleCameraPath(descend, 1e-6)), cameraBasis(descend.keyframes[0].camera)) < 1e-5);

  // One rolled end releases the constraint inside the segment only.
  const free = camera({ yaw: 2, pitch: 1.9, roll: 1.2, constrainUp: false }), start = camera({ yaw: 0.3, pitch: 0.4 });
  const mixed = path([[0, start], [4, free], [6, camera({ yaw: 1, pitch: -0.5 })]]);
  const q0 = quaternionFromBasis(cameraBasis(start)), q1 = quaternionFromBasis(cameraBasis(free)), total = quaternionAngle(q0, q1);
  for (const time of [0.5, 2, 3.9]) {
    const sample = sampleCameraPath(mixed, time), q = quaternionFromBasis(cameraBasis(sample));
    assert.equal(sample.constrainUp, false);
    close(quaternionAngle(q0, q), time / 4 * total, 1e-7, 'constant angular speed');
    close(quaternionAngle(q, q1), (1 - time / 4) * total, 1e-7, 'on the arc');
  }
  // The displayed orientation is continuous across every keyframe, including
  // those where the constraint switches.
  for (const keyframe of mixed.keyframes) {
    for (const time of [keyframe.time - 1e-7, keyframe.time + 1e-7]) {
      if (time < 0 || time > 6) continue;
      assert.ok(basisAngle(cameraBasis(sampleCameraPath(mixed, time)), cameraBasis(keyframe.camera)) < 1e-5, `continuous at ${keyframe.time}`);
    }
  }
  // A free segment through the pole produces finite angles the renderer accepts.
  const over = path([[0, camera({ yaw: 0, pitch: Math.PI / 2 - 0.3, constrainUp: false })], [1, camera({ yaw: 0, pitch: Math.PI / 2 + 0.3, constrainUp: false })]]);
  const pole = sampleCameraPath(over, 0.5), poleBasis = cameraBasis(pole);
  assert.ok([pole.yaw, pole.pitch, pole.roll].every(Number.isFinite));
  closeVector(poleBasis.back, [0, 0, 1], 1e-9, 'passes over the top');
  closeVector(poleBasis.right, [1, 0, 0], 1e-9, 'pole right'); closeVector(poleBasis.up, [0, 1, 0], 1e-9, 'pole up');
  // Two unrolled free cameras half a turn apart orbit about Z rather than over the top.
  const around = sampleCameraPath(path([[0, camera({ yaw: 0, pitch: 1.2, constrainUp: false })], [1, camera({ yaw: Math.PI, pitch: 1.2, constrainUp: false })]]), 0.5);
  close(cameraBasis(around).back[2], Math.sin(1.2), 1e-9, 'constant elevation');
});

test('center, distance, scale and view angle follow a monotone spline through the keyframes', () => {
  const keys = [[0, camera({ target: [0, 0, 0], distance: 10, orthographicScale: 2, fov: 20 * DEGREE })],
    [1, camera({ target: [10, 0, 5], distance: 40, orthographicScale: 8, fov: 60 * DEGREE })],
    [3, camera({ target: [10, 0, 5], distance: 40, orthographicScale: 8, fov: 60 * DEGREE })],
    [4, camera({ target: [0, 4, 5], pan: [1, 0, 0], distance: 5, orthographicScale: 1, fov: 30 * DEGREE })]];
  const value = path(keys);
  // Two keyframes: straight line for the center, geometric interpolation for zoom.
  const two = path(keys.slice(0, 2)), half = sampleCameraPath(two, 0.5);
  closeVector(half.target, [5, 0, 2.5], 1e-12, 'linear center'); assert.deepEqual(half.pan, [0, 0, 0]);
  close(half.distance, 20, 1e-12, 'geometric mean distance'); close(half.orthographicScale, 4, 1e-12, 'geometric mean scale');
  close(half.fov, 40 * DEGREE, 1e-12, 'linear view angle');
  // Equal neighbors hold still, and values never leave the keyframe range.
  for (let time = 1; time <= 3; time += 0.125) {
    const sample = sampleCameraPath(value, time);
    assert.deepEqual([sample.target, sample.distance, sample.orthographicScale, sample.fov], [[10, 0, 5], 40, 8, 60 * DEGREE]);
  }
  for (let time = 0; time <= 4; time += 0.01) {
    const sample = sampleCameraPath(value, time);
    assert.ok(sample.distance >= 5 - 1e-9 && sample.distance <= 40 + 1e-9 && sample.target[0] >= -1e-9 && sample.target[0] <= 10 + 1e-9
      && sample.target[1] >= -1e-9 && sample.target[1] <= 4 + 1e-9 && sample.fov >= 20 * DEGREE - 1e-12 && sample.fov <= 60 * DEGREE + 1e-12, `no overshoot at ${time}`);
  }
  // The pan is folded into the center.
  closeVector(sampleCameraPath(value, 3.999999).target, [1, 4, 5], 1e-4, 'target + pan');
  // Velocity is continuous at an interior keyframe of a smooth path.
  const smooth = path([[0, camera({ target: [0, 0, 0] })], [1, camera({ target: [1, 2, 0] })], [3, camera({ target: [4, 3, 0] })], [4, camera({ target: [6, 9, 0] })]]);
  for (const time of [1, 3]) {
    const h = 1e-5, at = t => sampleCameraPath(smooth, t).target;
    const before = at(time).map((v, i) => (v - at(time - h)[i]) / h), after = at(time + h).map((v, i) => (v - at(time)[i]) / h);
    closeVector(before, after, 1e-3, `velocity at ${time}`);
    assert.ok(Math.hypot(...after) > 0.5, 'the camera keeps moving through the keyframe');
  }
  // Ease brings the motion to rest at each keyframe and keeps the same path.
  const eased = { ...two, easing: 'ease' };
  closeVector(sampleCameraPath(eased, 0.5).target, [5, 0, 2.5], 1e-12, 'eased midpoint');
  close(sampleCameraPath(eased, 0.25).target[0], 10 * (0.25 ** 2 * (3 - 0.5)), 1e-12, 'smoothstep');
  assert.ok(sampleCameraPath(eased, 1e-4).target[0] < 1e-6, 'starts from rest');
  // The projection type switches at keyframes.
  const mixed = path([[0, camera({ projectionMode: 'orthographic' })], [1, camera({ projectionMode: 'perspective' })], [2, camera({ projectionMode: 'orthographic' })]]);
  assert.deepEqual([0.5, 1, 1.5, 2].map(time => sampleCameraPath(mixed, time).projectionMode), ['orthographic', 'perspective', 'perspective', 'orthographic']);
});

test('trajectory links map time to frames at a rate, fitted to the duration or stored in keyframes', () => {
  const keys = [[0, camera(), 2], [2, camera({ yaw: 1 }), 12], [4, camera({ yaw: 2 }), null], [6, camera({ yaw: 3 }), 4]];
  const linked = frames => path(keys, { frames: { mode: 'current', first: 0, last: null, step: 1, rate: 10, ...frames } });
  assert.equal(trajectoryFrameAt(linked({}), 1, { frameCount: 40, duration: 6 }), null);
  const stored = linked({ mode: 'keyframes' });
  assert.deepEqual([-1, 0, 1, 1.04, 2, 4, 6, 9].map(time => trajectoryFrameAt(stored, time, { frameCount: 40, duration: 6 })), [2, 2, 7, 7, 12, 8, 4, 4]);
  assert.equal(trajectoryFrameAt(stored, 2, { frameCount: 5, duration: 6 }), 4, 'clamped to the trajectory');
  const rate = linked({ mode: 'rate', first: 10, last: 30, step: 5, rate: 2 });
  assert.deepEqual([0, 0.49, 0.5, 1, 2, 2.4, 3, 50].map(time => trajectoryFrameAt(rate, time, { frameCount: 40, duration: 6 })), [10, 10, 15, 20, 30, 30, 30, 30]);
  const fit = linked({ mode: 'fit', first: 0, last: 5 });
  assert.deepEqual([0, 0.99, 1, 3, 5.99, 6].map(time => trajectoryFrameAt(fit, time, { frameCount: 40, duration: 6 })), [0, 0, 1, 3, 5, 5]);
  // One movie frame per trajectory frame when the rates are equal.
  const one = path([], { frames: { mode: 'rate', first: 0, last: null, step: 1, rate: 30 } }), plan = planMovie(one, { fps: 30, frameCount: 40 });
  assert.deepEqual([plan.frameTotal, plan.duration, plan.cameraAnimated, plan.includeEnd], [40, 40 / 30, false, false]);
  assert.deepEqual(Array.from({ length: 40 }, (_, index) => plan.frameAt(index)), Array.from({ length: 40 }, (_, index) => index));
  assert.equal(plan.cameraAt(0), null);
});

test('movie plans cover the camera path including its end pose and report what cannot be rendered', () => {
  const keys = [[0, camera()], [2, camera({ yaw: 1 })]];
  const plan = planMovie(path(keys), { fps: 30, frameCount: 1 });
  assert.deepEqual([plan.frameTotal, plan.duration, plan.cameraAnimated, plan.includeEnd, plan.movieSeconds], [61, 2, true, true, 61 / 30]);
  assert.deepEqual(plan.cameraAt(0), keys[0][1]); assert.deepEqual(plan.cameraAt(60), keys[1][1]);
  close(plan.cameraAt(30).yaw, -0.62 + 1.62 / 2, 1e-12, 'midpoint');
  assert.equal(plan.frameAt(10), null);
  // Frames at a rate extend a shorter camera path; the camera then holds its last pose.
  const both = planMovie(path(keys, { frames: { mode: 'rate', first: 0, last: 39, step: 1, rate: 10 } }), { fps: 20, frameCount: 40 });
  assert.deepEqual([both.duration, both.frameTotal, both.includeEnd], [4, 80, false]);
  assert.deepEqual([both.frameAt(0), both.frameAt(1), both.frameAt(2), both.frameAt(79)], [0, 0, 1, 39]);
  assert.deepEqual(both.cameraAt(79), keys[1][1]);
  // A longer camera path keeps the last trajectory frame.
  const longer = planMovie(path(keys, { frames: { mode: 'rate', first: 0, last: 9, step: 1, rate: 10 } }), { fps: 20, frameCount: 40 });
  assert.deepEqual([longer.duration, longer.frameTotal, longer.frameAt(40)], [2, 41, 9]);
  const fitted = planMovie(path(keys, { frames: { mode: 'fit', first: 0, last: null, step: 1, rate: 10 } }), { fps: 10, frameCount: 4 });
  assert.deepEqual(Array.from({ length: fitted.frameTotal }, (_, index) => fitted.frameAt(index)), [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3]);
  assert.throws(() => planMovie(path([[0, camera()]]), { fps: 30 }), /Add at least two camera keyframes/);
  assert.throws(() => planMovie(createCameraPath(), { fps: 30, frameCount: 40 }), /Nothing moves yet/);
  assert.throws(() => planMovie(path([], { frames: { mode: 'rate', first: 3, last: 3, step: 1, rate: 10 } }), { fps: 30, frameCount: 40 }), /single frame/);
  assert.throws(() => planMovie(path(keys, { frames: { mode: 'keyframes', first: 0, last: null, step: 1, rate: 10 } }), { fps: 30, frameCount: 40 }), /No keyframe stores a trajectory frame/);
  assert.throws(() => planMovie(path(keys), { fps: 30, maxFrames: 60 }), /61 frames; the limit is 60/);
  assert.throws(() => planMovie(path(keys), { fps: 0 }), /positive frame rate/);
});

test('keyframes are added after the last one, replaced at equal times, retimed in order and swapped in place', () => {
  let keyframes = addKeyframe([], camera());
  keyframes = addKeyframe(keyframes, camera({ yaw: 1 }), { frame: 3 });
  keyframes = addKeyframe(keyframes, camera({ yaw: 2 }), { time: 1 });
  assert.deepEqual(keyframes.map(keyframe => [keyframe.time, keyframe.camera.yaw, keyframe.frame]), [[0, -0.62, null], [1, 2, null], [DEFAULT_KEYFRAME_SPACING, 1, 3]]);
  keyframes = addKeyframe(keyframes, camera({ yaw: 5 }), { time: 1.0004 });
  assert.deepEqual(keyframes.map(keyframe => [keyframe.time, keyframe.camera.yaw]), [[0, -0.62], [1, 5], [2, 1]], 'a keyframe at the same time replaces the old one');
  // Stored cameras are copies.
  const source = camera(); keyframes = addKeyframe(keyframes, source, { time: 9 }); source.target[0] = 77;
  assert.equal(keyframes.at(-1).camera.target[0], 1);
  assert.deepEqual(retimeKeyframe(keyframes, 0, 5).map(keyframe => [keyframe.time, keyframe.camera.yaw]), [[1, 5], [2, 1], [5, -0.62], [9, -0.62]]);
  assert.throws(() => retimeKeyframe(keyframes, 0, 2), /already has this time/);
  for (const time of [-1, NaN, 3601, Infinity]) assert.throws(() => retimeKeyframe(keyframes, 0, time), /0 to 3600 seconds/);
  assert.throws(() => addKeyframe(keyframes, camera(), { time: 99999 }), /0 to 3600 seconds/);
  assert.deepEqual(moveKeyframe(keyframes, 1, -1).map(keyframe => [keyframe.time, keyframe.camera.yaw]), [[0, 5], [1, -0.62], [2, 1], [9, -0.62]]);
  assert.equal(moveKeyframe(keyframes, 0, -1), keyframes); assert.equal(moveKeyframe(keyframes, 3, 1), keyframes);
  assert.deepEqual(removeKeyframe(keyframes, 1).map(keyframe => keyframe.time), [0, 2, 9]);
  let full = [];
  for (let index = 0; index < MAX_CAMERA_KEYFRAMES; index++) full = addKeyframe(full, camera());
  assert.throws(() => addKeyframe(full, camera()), /at most 64 keyframes/);
  assert.equal(addKeyframe(full, camera(), { time: 0 }).length, MAX_CAMERA_KEYFRAMES, 'replacing stays within the limit');
});

test('renderer cameras are captured and applied without touching the projection needlessly', () => {
  const calls = [], renderer = { ...camera({ yaw: 1 }), requestRender: () => calls.push('render'), setProjection(mode) { calls.push(mode); this.projectionMode = mode; } };
  const saved = captureCamera(renderer);
  assert.deepEqual(saved, camera({ yaw: 1 })); assert.notEqual(saved.target, renderer.target);
  applyCamera(renderer, camera({ yaw: 2, target: [4, 5, 6] }));
  assert.deepEqual([renderer.yaw, renderer.target, calls], [2, [4, 5, 6], ['render']]);
  applyCamera(renderer, camera({ projectionMode: 'orthographic' }));
  assert.deepEqual(calls, ['render', 'orthographic', 'render']);
});

test('saved camera paths validate strictly and round-trip', () => {
  assert.deepEqual(normalizeCameraPathState(undefined), createCameraPath());
  const saved = { keyframes: [{ time: 0, camera: camera(), frame: 3 }, { time: 2.5, camera: camera({ constrainUp: false, pitch: 4, roll: 1 }) }],
    easing: 'ease', frames: { mode: 'rate', first: 2, last: 30, step: 2, rate: 12.5 } };
  const normalized = normalizeCameraPathState(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(normalized, { ...saved, keyframes: [saved.keyframes[0], { ...saved.keyframes[1], frame: null }] });
  assert.deepEqual(normalizeCameraPathState(JSON.parse(JSON.stringify(normalized))), normalized);
  const mutate = change => { const value = JSON.parse(JSON.stringify(saved)); change(value); return value; };
  const invalid = [[], { extra: 1 }, { keyframes: {} }, mutate(value => { value.keyframes[1].time = 0; }), mutate(value => { value.keyframes[1].time = 0.0005; }),
    mutate(value => { value.keyframes.reverse(); }), mutate(value => { value.keyframes[0].time = -1; }), mutate(value => { value.keyframes[0].time = 3601; }),
    mutate(value => { value.keyframes[0].time = '0'; }), mutate(value => { value.keyframes[0].frame = 1.5; }), mutate(value => { value.keyframes[0].frame = -1; }),
    mutate(value => { value.keyframes[0].camera.pitch = 2; }), mutate(value => { value.keyframes[0].camera.distance = 0; }),
    mutate(value => { value.keyframes[0].camera.target = [0, 0]; }), mutate(value => { value.keyframes[0].camera.target[1] = null; }),
    mutate(value => { value.keyframes[0].camera.projectionMode = 'fisheye'; }), mutate(value => { value.keyframes[0].camera.fov = 4; }),
    mutate(value => { delete value.keyframes[0].camera.yaw; }), mutate(value => { value.keyframes[0].camera.script = 'x'; }),
    mutate(value => { value.keyframes[0].camera.constrainUp = 1; }), mutate(value => { value.keyframes[0].run = true; }),
    mutate(value => { value.easing = 'bounce'; }), mutate(value => { value.frames.mode = 'all'; }), mutate(value => { value.frames.rate = 0; }),
    mutate(value => { value.frames.last = 1; }), mutate(value => { value.frames.step = 0; }), mutate(value => { value.frames.first = 1.5; }),
    mutate(value => { value.frames.extra = 1; }), { keyframes: Array.from({ length: MAX_CAMERA_KEYFRAMES + 1 }, (_, index) => ({ time: index, camera: camera() })) },
    JSON.parse('{"keyframes":[],"__proto__":{"x":1}}')];
  for (const value of invalid) assert.throws(() => normalizeCameraPathState(value), /Invalid AlloyView configuration: settings\.extensions\.movie\.path/, JSON.stringify(value).slice(0, 120));
});
