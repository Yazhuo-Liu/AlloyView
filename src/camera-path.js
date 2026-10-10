/** Camera keyframes and their interpolation.
 *
 * A camera is the renderer's orbit state, in the format configurations
 * already use: yaw, pitch, roll, constrainUp, target, pan, distance, fov,
 * orthographicScale and projectionMode. A path is a list of keyframes
 * { time, camera, frame } in ascending time (seconds).
 *
 * Orientation. If both keyframes of a segment keep Z upright, azimuth (the
 * shorter way round) and elevation are interpolated and the camera stays
 * upright. Otherwise the two camera bases are converted to unit quaternions
 * and interpolated by spherical linear interpolation along the shorter arc,
 * with the upright constraint released inside the segment.
 *
 * Position. The orbit center, the logarithms of the distance and of the
 * parallel scale, and the view angle follow a monotone cubic Hermite spline
 * through the keyframes (Fritsch–Carlson limited tangents): continuous
 * velocity, exact at every keyframe, and never beyond the keyframe values, so
 * two equal keyframes hold the camera still. An optional ease slows the
 * motion to rest at each keyframe. The projection type switches at keyframes. */

export const MAX_CAMERA_KEYFRAMES = 64;
export const MAX_CAMERA_PATH_SECONDS = 3600;
export const MIN_KEYFRAME_GAP = 0.001;
export const DEFAULT_KEYFRAME_SPACING = 2;
export const CAMERA_PATH_EASINGS = Object.freeze(['linear', 'ease']);
export const FRAME_LINK_MODES = Object.freeze(['current', 'rate', 'fit', 'keyframes']);
export const DEFAULT_FRAME_LINK = Object.freeze({ mode: 'current', first: 0, last: null, step: 1, rate: 10 });
export const FRAME_RATE_RANGE = Object.freeze([0.01, 1000]);
const CAMERA_KEYS = Object.freeze(['yaw', 'pitch', 'roll', 'fov', 'constrainUp', 'target', 'pan', 'distance', 'orthographicScale', 'projectionMode']);
const MAX_COORDINATE = 1e15;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v) => { const length = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / length, v[1] / length, v[2] / length]; };

export function cloneCamera(camera) {
  return { yaw: camera.yaw, pitch: camera.pitch, roll: camera.roll ?? 0, fov: camera.fov, constrainUp: camera.constrainUp !== false,
    target: [...camera.target], pan: [...camera.pan], distance: camera.distance, orthographicScale: camera.orthographicScale,
    projectionMode: camera.projectionMode };
}

/** The renderer's orbit state as a detached camera. */
export function captureCamera(renderer) { return cloneCamera(renderer); }

/** Set the renderer's orbit state; the projection callback runs only on a change. */
export function applyCamera(renderer, camera) {
  const { projectionMode, ...orbit } = cloneCamera(camera);
  Object.assign(renderer, orbit);
  if (renderer.projectionMode !== projectionMode) renderer.setProjection(projectionMode);
  renderer.requestRender();
}

/** Screen right, screen up and the direction from the orbit center to the
 * eye, exactly as WebGLRenderer.cameraOrientation() and cameraBasis() give. */
export function cameraBasis(camera) {
  const { yaw, pitch } = camera, cosinePitch = Math.cos(pitch);
  const back = [cosinePitch * Math.sin(yaw), -cosinePitch * Math.cos(yaw), Math.sin(pitch)];
  let upHint = Math.abs(cosinePitch) < 1e-7 ? [0, 1, 0] : [0, 0, 1];
  if (camera.constrainUp === false) {
    const roll = camera.roll ?? 0, right = [Math.cos(yaw), Math.sin(yaw), 0];
    const up = [-Math.sin(pitch) * Math.sin(yaw), Math.sin(pitch) * Math.cos(yaw), cosinePitch];
    upHint = [0, 1, 2].map(axis => up[axis] * Math.cos(roll) + right[axis] * Math.sin(roll));
  }
  const right = normalize(cross(upHint, back));
  return { right, up: normalize(cross(back, right)), back };
}

/** Unit quaternion [w, x, y, z] of the rotation whose columns are right, up, back. */
export function quaternionFromBasis({ right, up, back }) {
  const m00 = right[0], m11 = up[1], m22 = back[2], trace = m00 + m11 + m22;
  let q;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [s / 4, (up[2] - back[1]) / s, (back[0] - right[2]) / s, (right[1] - up[0]) / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [(up[2] - back[1]) / s, s / 4, (up[0] + right[1]) / s, (back[0] + right[2]) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(back[0] - right[2]) / s, (up[0] + right[1]) / s, s / 4, (back[1] + up[2]) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(right[1] - up[0]) / s, (back[0] + right[2]) / s, (back[1] + up[2]) / s, s / 4];
  }
  const length = Math.hypot(...q) || 1;
  return q.map(value => value / length);
}

export function basisFromQuaternion([w, x, y, z]) {
  return {
    right: [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
    up: [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
    back: [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
  };
}

/** Spherical linear interpolation along the shorter arc. */
export function slerpQuaternion(a, b, t) {
  let cosine = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = cosine < 0 ? -1 : 1;
  if (t <= 0) return [...a];
  if (t >= 1) return b.map(value => sign * value);
  cosine = Math.min(1, cosine * sign);
  let weightA = 1 - t, weightB = t;
  if (cosine < 0.9999995) {
    const angle = Math.acos(cosine), sine = Math.sin(angle);
    weightA = Math.sin((1 - t) * angle) / sine; weightB = Math.sin(t * angle) / sine;
  }
  const q = a.map((value, index) => weightA * value + weightB * sign * b[index]);
  const length = Math.hypot(...q) || 1;
  return q.map(value => value / length);
}

/** Orbit angles of a free (not upright) camera with the given basis. Looking
 * straight along Z leaves the azimuth open; yawHint chooses it. */
export function anglesFromBasis({ up, back }, yawHint = 0) {
  const horizontal = Math.hypot(back[0], back[1]);
  const pitch = Math.atan2(back[2], horizontal);
  const yaw = horizontal > 1e-9 ? Math.atan2(back[0], -back[1]) : yawHint;
  const baseRight = [Math.cos(yaw), Math.sin(yaw), 0];
  const baseUp = [-Math.sin(pitch) * Math.sin(yaw), Math.sin(pitch) * Math.cos(yaw), Math.cos(pitch)];
  return { yaw, pitch, roll: Math.atan2(dot(up, baseRight), dot(up, baseUp)) };
}

const shortestAngle = delta => delta - 2 * Math.PI * Math.round(delta / (2 * Math.PI));
const cameraCenter = camera => camera.target.map((value, axis) => value + camera.pan[axis]);

/** Monotone cubic Hermite value at `time` in segment `index` of the samples. */
function monotoneValue(times, values, index, u) {
  const count = values.length, secant = i => (values[i + 1] - values[i]) / (times[i + 1] - times[i]);
  const tangent = i => {
    if (i === 0) return secant(0);
    if (i === count - 1) return secant(count - 2);
    const before = secant(i - 1), after = secant(i);
    if (before * after <= 0) return 0;
    const left = times[i] - times[i - 1], right = times[i + 1] - times[i];
    const slope = (before * right + after * left) / (left + right);
    return Math.sign(slope) * Math.min(Math.abs(slope), 3 * Math.abs(before), 3 * Math.abs(after));
  };
  const a = values[index], b = values[index + 1];
  if (a === b) return a;
  const span = times[index + 1] - times[index], u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * span * tangent(index)
    + (-2 * u3 + 3 * u2) * b + (u3 - u2) * span * tangent(index + 1);
}

export function easeProgress(progress, easing) {
  return easing === 'ease' ? progress * progress * (3 - 2 * progress) : progress;
}

export function cameraPathDuration(path) { return path.keyframes.length ? path.keyframes.at(-1).time : 0; }

/** The camera at `time`. Before the first and after the last keyframe the
 * camera holds; at a keyframe's time the keyframe is returned unchanged. */
export function sampleCameraPath(path, time) {
  const keyframes = path.keyframes;
  if (!keyframes.length) return null;
  if (!(time > keyframes[0].time)) return cloneCamera(keyframes[0].camera);
  const last = keyframes.length - 1;
  if (time >= keyframes[last].time) return cloneCamera(keyframes[last].camera);
  let index = 0;
  while (keyframes[index + 1].time <= time) index++;
  const from = keyframes[index], to = keyframes[index + 1];
  if (time === from.time) return cloneCamera(from.camera);
  const u = easeProgress((time - from.time) / (to.time - from.time), path.easing);
  const times = keyframes.map(keyframe => keyframe.time);
  const channel = read => monotoneValue(times, keyframes.map(keyframe => read(keyframe.camera)), index, u);
  // Zoom is interpolated in the logarithm; an unchanged value is kept exactly.
  const scaled = read => read(from.camera) === read(to.camera) ? read(from.camera) : Math.exp(channel(camera => Math.log(read(camera))));
  const centers = keyframes.map(keyframe => cameraCenter(keyframe.camera));
  const target = [0, 1, 2].map(axis => monotoneValue(times, centers.map(center => center[axis]), index, u));
  const a = from.camera, b = to.camera;
  let orientation;
  const yawHint = a.yaw + shortestAngle(b.yaw - a.yaw) * u;
  if (a.constrainUp !== false && b.constrainUp !== false) {
    orientation = { yaw: yawHint, pitch: a.pitch + (b.pitch - a.pitch) * u, roll: 0, constrainUp: true };
  } else {
    const q = slerpQuaternion(quaternionFromBasis(cameraBasis(a)), quaternionFromBasis(cameraBasis(b)), u);
    orientation = { ...anglesFromBasis(basisFromQuaternion(q), yawHint), constrainUp: false };
  }
  return { ...orientation, target, pan: [0, 0, 0],
    distance: Math.max(0.02, scaled(camera => camera.distance)),
    orthographicScale: Math.max(1e-6, scaled(camera => camera.orthographicScale)),
    fov: Math.min(175 * Math.PI / 180, Math.max(Math.PI / 180, channel(camera => camera.fov))),
    projectionMode: a.projectionMode };
}

/** The frames a link plays: first, first + step, … up to last (inclusive). */
export function resolveFrameRange(frames, frameCount) {
  const count = Math.max(1, frameCount | 0);
  const first = Math.min(count - 1, Math.max(0, frames.first ?? 0));
  const last = Math.min(count - 1, Math.max(first, frames.last ?? count - 1));
  const step = Math.max(1, frames.step ?? 1);
  return { first, last, step, count: Math.floor((last - first) / step) + 1 };
}

/** The trajectory frame shown at `time`, or null to keep the displayed one. */
export function trajectoryFrameAt(path, time, { frameCount, duration }) {
  const frames = path.frames ?? DEFAULT_FRAME_LINK;
  if (frames.mode === 'current' || frameCount < 1) return null;
  if (frames.mode === 'keyframes') {
    const linked = path.keyframes.filter(keyframe => keyframe.frame !== null && keyframe.frame !== undefined);
    if (!linked.length) return null;
    let value;
    if (time <= linked[0].time) value = linked[0].frame;
    else if (time >= linked.at(-1).time) value = linked.at(-1).frame;
    else {
      let index = 0;
      while (linked[index + 1].time <= time) index++;
      const from = linked[index], to = linked[index + 1];
      value = from.frame + (to.frame - from.frame) * (time - from.time) / (to.time - from.time);
    }
    return Math.min(frameCount - 1, Math.max(0, Math.round(value)));
  }
  const range = resolveFrameRange(frames, frameCount);
  const position = frames.mode === 'rate' ? time * frames.rate : duration > 0 ? time / duration * range.count : 0;
  return range.first + range.step * Math.min(range.count - 1, Math.max(0, Math.floor(position + 1e-9)));
}

/**
 * The timeline shared by the preview and the movie export. A camera path
 * with at least two keyframes animates the camera for its duration; frames
 * played at a rate extend the duration to cover their range. Video frame i
 * is sampled at i / fps, and an animated camera path includes its end pose.
 */
export function planMovie(path, { fps, frameCount = 1, maxFrames = Infinity } = {}) {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('Choose a positive frame rate.');
  const frames = path.frames ?? DEFAULT_FRAME_LINK, keyframes = path.keyframes;
  const cameraAnimated = keyframes.length >= 2, pathDuration = cameraAnimated ? cameraPathDuration(path) : 0;
  const range = resolveFrameRange(frames, frameCount);
  const playsFrames = frames.mode === 'rate' && frameCount > 1 && range.count > 1;
  const framesDuration = playsFrames ? range.count / frames.rate : 0;
  const duration = Math.max(pathDuration, framesDuration);
  if (!(duration > 0)) {
    throw new Error(frames.mode === 'rate' ? 'This trajectory range has a single frame. Add two camera keyframes or choose more frames.'
      : 'Nothing moves yet. Add at least two camera keyframes, or play trajectory frames at a rate.');
  }
  if (frames.mode === 'keyframes' && !keyframes.some(keyframe => keyframe.frame !== null && keyframe.frame !== undefined)) {
    throw new Error('No keyframe stores a trajectory frame. Add the keyframes again, or choose another trajectory link.');
  }
  // The end pose of a camera path is part of the movie; a frame range is not
  // followed by an extra frame.
  const includeEnd = cameraAnimated && pathDuration >= framesDuration - 1e-9;
  const frameTotal = Math.max(1, Math.round(duration * fps)) + (includeEnd ? 1 : 0);
  if (frameTotal > maxFrames) throw new Error(`This movie has ${frameTotal.toLocaleString('en-US')} frames; the limit is ${maxFrames.toLocaleString('en-US')}. Lower the frame rate or shorten it.`);
  const timeAt = index => Math.min(duration, index / fps);
  return { duration, frameTotal, fps, cameraAnimated, playsFrames, includeEnd, range, timeAt,
    cameraAt: index => keyframes.length ? sampleCameraPath(path, timeAt(index)) : null,
    frameAt: index => trajectoryFrameAt(path, timeAt(index), { frameCount, duration }),
    movieSeconds: frameTotal / fps };
}

function sortKeyframes(keyframes) { return [...keyframes].sort((a, b) => a.time - b.time); }

function validTime(time) {
  if (!Number.isFinite(time) || time < 0 || time > MAX_CAMERA_PATH_SECONDS) throw new Error(`Keyframe times are from 0 to ${MAX_CAMERA_PATH_SECONDS} seconds.`);
  return Math.round(time * 1000) / 1000;
}

/** Add a keyframe. Without a time it follows the last one; a keyframe at an
 * existing time replaces that keyframe. Returns the new keyframe list. */
export function addKeyframe(keyframes, camera, { time = null, frame = null } = {}) {
  const at = time === null ? (keyframes.length ? keyframes.at(-1).time + DEFAULT_KEYFRAME_SPACING : 0) : time;
  const value = validTime(at);
  const kept = keyframes.filter(keyframe => Math.abs(keyframe.time - value) >= MIN_KEYFRAME_GAP);
  if (kept.length >= MAX_CAMERA_KEYFRAMES) throw new Error(`A camera path has at most ${MAX_CAMERA_KEYFRAMES} keyframes.`);
  return sortKeyframes([...kept, { time: value, camera: cloneCamera(camera), frame }]);
}

export function removeKeyframe(keyframes, index) { return keyframes.filter((_, position) => position !== index); }

/** Change one keyframe's time; the list is sorted again. */
export function retimeKeyframe(keyframes, index, time) {
  const value = validTime(time);
  if (keyframes.some((keyframe, position) => position !== index && Math.abs(keyframe.time - value) < MIN_KEYFRAME_GAP)) {
    throw new Error('Another keyframe already has this time.');
  }
  return sortKeyframes(keyframes.map((keyframe, position) => position === index ? { ...keyframe, time: value } : keyframe));
}

/** Exchange a keyframe's view with its neighbor's; the times stay in place. */
export function moveKeyframe(keyframes, index, direction) {
  const other = index + direction;
  if (index < 0 || index >= keyframes.length || other < 0 || other >= keyframes.length) return keyframes;
  return keyframes.map((keyframe, position) => position === index ? { ...keyframes[other], time: keyframe.time }
    : position === other ? { ...keyframes[index], time: keyframe.time } : keyframe);
}

export function createCameraPath() { return { keyframes: [], easing: 'linear', frames: { ...DEFAULT_FRAME_LINK } }; }

function fail(path, message) { throw new Error(`Invalid AlloyView configuration: ${path} ${message}.`); }

function record(value, path, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'must be an object');
  for (const key of Object.keys(value)) if (FORBIDDEN_KEYS.has(key) || !keys.includes(key)) fail(`${path}.${key}`, 'is not a supported setting');
  return value;
}

function finite(value, path, minimum, maximum, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isSafeInteger(value))) {
    fail(path, `must be a finite ${integer ? 'integer' : 'number'} from ${minimum} to ${maximum}`);
  }
  return value;
}

function vector(value, path) {
  if (!Array.isArray(value) || value.length !== 3) fail(path, 'must contain 3 entries');
  return value.map((component, index) => finite(component, `${path}[${index}]`, -MAX_COORDINATE, MAX_COORDINATE));
}

/** Validate one saved camera with the bounds configurations use. */
export function normalizeCameraState(value, path) {
  const input = record(value, path, CAMERA_KEYS);
  const constrainUp = input.constrainUp ?? true;
  if (typeof constrainUp !== 'boolean') fail(`${path}.constrainUp`, 'must be true or false');
  if (!['perspective', 'orthographic'].includes(input.projectionMode)) fail(`${path}.projectionMode`, 'is unsupported');
  return {
    yaw: finite(input.yaw, `${path}.yaw`, -1e12, 1e12),
    pitch: finite(input.pitch, `${path}.pitch`, constrainUp ? -Math.PI / 2 - 1e-7 : -1e12, constrainUp ? Math.PI / 2 + 1e-7 : 1e12),
    roll: finite(input.roll ?? 0, `${path}.roll`, -1e12, 1e12),
    fov: finite(input.fov ?? 40 * Math.PI / 180, `${path}.fov`, Math.PI / 180, 175 * Math.PI / 180),
    constrainUp,
    target: vector(input.target, `${path}.target`), pan: vector(input.pan, `${path}.pan`),
    distance: finite(input.distance, `${path}.distance`, 1e-12, MAX_COORDINATE),
    orthographicScale: finite(input.orthographicScale, `${path}.orthographicScale`, 1e-12, MAX_COORDINATE),
    projectionMode: input.projectionMode,
  };
}

/** Validate a shared camera path before it reaches the UI. */
export function normalizeCameraPathState(value, { path = 'settings.extensions.movie.path' } = {}) {
  const input = record(value ?? {}, path, ['keyframes', 'easing', 'frames']);
  const list = input.keyframes ?? [];
  if (!Array.isArray(list) || list.length > MAX_CAMERA_KEYFRAMES) fail(`${path}.keyframes`, `must contain 0–${MAX_CAMERA_KEYFRAMES} entries`);
  const keyframes = list.map((item, index) => {
    const entryPath = `${path}.keyframes[${index}]`, entry = record(item, entryPath, ['time', 'camera', 'frame']);
    return { time: finite(entry.time, `${entryPath}.time`, 0, MAX_CAMERA_PATH_SECONDS),
      camera: normalizeCameraState(entry.camera, `${entryPath}.camera`),
      frame: entry.frame === undefined || entry.frame === null ? null : finite(entry.frame, `${entryPath}.frame`, 0, Number.MAX_SAFE_INTEGER, true) };
  });
  for (let index = 1; index < keyframes.length; index++) {
    if (keyframes[index].time - keyframes[index - 1].time < MIN_KEYFRAME_GAP) fail(`${path}.keyframes[${index}].time`, 'must be later than the previous keyframe');
  }
  const easing = input.easing ?? 'linear';
  if (!CAMERA_PATH_EASINGS.includes(easing)) fail(`${path}.easing`, 'is unsupported');
  const link = record(input.frames ?? {}, `${path}.frames`, ['mode', 'first', 'last', 'step', 'rate']);
  const mode = link.mode ?? DEFAULT_FRAME_LINK.mode;
  if (!FRAME_LINK_MODES.includes(mode)) fail(`${path}.frames.mode`, 'is unsupported');
  const first = finite(link.first ?? 0, `${path}.frames.first`, 0, Number.MAX_SAFE_INTEGER, true);
  const last = link.last === undefined || link.last === null ? null : finite(link.last, `${path}.frames.last`, first, Number.MAX_SAFE_INTEGER, true);
  return { keyframes, easing, frames: { mode, first, last,
    step: finite(link.step ?? 1, `${path}.frames.step`, 1, 1_000_000, true),
    rate: finite(link.rate ?? DEFAULT_FRAME_LINK.rate, `${path}.frames.rate`, ...FRAME_RATE_RANGE) } };
}
