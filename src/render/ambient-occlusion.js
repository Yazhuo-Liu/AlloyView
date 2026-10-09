import { MAX_SLICE_PLANES, SLICE_EPSILON } from './slicing.js';
import { lookAt, orthographic } from './math.js';

// Ambient occlusion in the manner of OVITO's AmbientOcclusionModifier,
// implemented independently: render the displayed atoms from many directions
// with a parallel projection, each atom drawn in a flat color encoding its
// index, and count the pixels each atom keeps. An atom that stays visible
// from most directions is exposed; one hidden behind others is occluded.
// The result is one view-independent brightness value per displayed atom.

export const AMBIENT_OCCLUSION_DIRECTIONS = Object.freeze([16, 40, 100, 200]);
export const AMBIENT_OCCLUSION_RESOLUTIONS = Object.freeze([256, 512, 1024, 2048]);
export const DEFAULT_AMBIENT_OCCLUSION = Object.freeze({ enabled: false, intensity: 0.7, directions: 40, resolution: 1024 });
/** Fixed seed: every computation for the same inputs is identical. */
export const AMBIENT_OCCLUSION_SEED = 20261008;
/** Atom × replica instances; the IDs fit 32 bits but counts and factors use
 * 8 bytes per instance on the CPU and 4 on the GPU. */
export const MAX_AMBIENT_OCCLUSION_INSTANCES = 1 << 24;
const SETTING_KEYS = Object.freeze(['enabled', 'intensity', 'directions', 'resolution']);
/** Background readback buffers: at most four, together at most 32 MiB. */
const READBACK_BYTES = 32 * 1024 * 1024;
/** Directions in flight on the GPU draw at most this many atoms in total (at
 * least one direction), which bounds the queued GPU work per frame. */
const MAX_INSTANCES_IN_FLIGHT = 1 << 20;

/** Validate a complete or partial settings object over `previous`. */
export function normalizeAmbientOcclusionSettings(value = {}, previous = DEFAULT_AMBIENT_OCCLUSION) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ambient occlusion settings must be an object.');
  for (const key of Object.keys(value)) if (!SETTING_KEYS.includes(key)) throw new Error(`Unknown ambient occlusion setting “${key}”.`);
  const settings = Object.fromEntries(SETTING_KEYS.map(key => [key, value[key] ?? previous[key] ?? DEFAULT_AMBIENT_OCCLUSION[key]]));
  if (typeof settings.enabled !== 'boolean') throw new Error('Ambient occlusion must be on or off.');
  if (typeof settings.intensity !== 'number' || !Number.isFinite(settings.intensity) || settings.intensity < 0 || settings.intensity > 1) {
    throw new Error('Ambient occlusion intensity must be between 0 and 1.');
  }
  if (!AMBIENT_OCCLUSION_DIRECTIONS.includes(settings.directions)) {
    throw new Error(`Ambient occlusion uses ${alternatives(AMBIENT_OCCLUSION_DIRECTIONS)} directions.`);
  }
  if (!AMBIENT_OCCLUSION_RESOLUTIONS.includes(settings.resolution)) {
    throw new Error(`The ambient occlusion buffer must be ${alternatives(AMBIENT_OCCLUSION_RESOLUTIONS)} pixels wide.`);
  }
  return settings;
}

function alternatives(values) { return `${values.slice(0, -1).join(', ')} or ${values.at(-1)}`; }

/** Brightness multiplier applied to an atom's color; the shaders evaluate the
 * same expression as mix(1, normalized, intensity). */
export function ambientOcclusionBrightness(normalized, intensity) {
  return 1 - intensity + intensity * normalized;
}

/** A small deterministic generator (mulberry32) for the fixed rotation. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` quasi-uniform unit vectors (row-major xyz): a Fibonacci sphere, so
 * opposite hemispheres are sampled equally, turned by a fixed pseudo-random
 * rotation. The rotation keeps samples off the Cartesian axes along which
 * crystal columns align, where a single direction would see straight through
 * the lattice. */
export function ambientOcclusionDirections(count, seed = AMBIENT_OCCLUSION_SEED) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 4096) throw new Error('Use 1–4096 ambient occlusion directions.');
  const random = seededRandom(seed);
  // Uniform random unit quaternion (Shoemake), converted to a rotation matrix.
  const u1 = random(), u2 = random() * 2 * Math.PI, u3 = random() * 2 * Math.PI;
  const x = Math.sqrt(1 - u1) * Math.sin(u2), y = Math.sqrt(1 - u1) * Math.cos(u2);
  const z = Math.sqrt(u1) * Math.sin(u3), w = Math.sqrt(u1) * Math.cos(u3);
  const rotation = [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
  const golden = Math.PI * (3 - Math.sqrt(5)), directions = new Float64Array(count * 3);
  for (let index = 0; index < count; index++) {
    const height = 1 - (2 * index + 1) / count, radius = Math.sqrt(Math.max(0, 1 - height * height)), angle = index * golden;
    const point = [radius * Math.cos(angle), radius * Math.sin(angle), height];
    let length = 0;
    for (let axis = 0; axis < 3; axis++) {
      const value = rotation[axis * 3] * point[0] + rotation[axis * 3 + 1] * point[1] + rotation[axis * 3 + 2] * point[2];
      directions[index * 3 + axis] = value; length += value * value;
    }
    length = Math.sqrt(length);
    for (let axis = 0; axis < 3; axis++) directions[index * 3 + axis] /= length;
  }
  return directions;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Add one visible pixel per covered texel to its instance. Texels hold
 * instance + 1 as little-endian RGBA bytes; zero is the background. */
export function accumulateVisiblePixels(pixels, counts) {
  if (!(pixels instanceof Uint8Array) || pixels.length % 4) throw new Error('Ambient occlusion pixels must be RGBA bytes.');
  if (!(counts instanceof Uint32Array)) throw new Error('Ambient occlusion counts must be a Uint32Array.');
  const limit = counts.length, texels = pixels.length >> 2;
  let covered = 0, invalid = 0;
  if (LITTLE_ENDIAN && pixels.byteOffset % 4 === 0) {
    const ids = new Uint32Array(pixels.buffer, pixels.byteOffset, texels);
    for (let texel = 0; texel < texels; texel++) {
      const id = ids[texel];
      if (id === 0) continue;
      if (id > limit) { invalid++; continue; }
      counts[id - 1]++; covered++;
    }
  } else {
    for (let offset = 0; offset < texels * 4; offset += 4) {
      const id = (pixels[offset] | pixels[offset + 1] << 8 | pixels[offset + 2] << 16 | pixels[offset + 3] << 24) >>> 0;
      if (id === 0) continue;
      if (id > limit) { invalid++; continue; }
      counts[id - 1]++; covered++;
    }
  }
  return { covered, invalid };
}

/** Per-instance normalized exposure in [0, 1]. Counts are divided by the
 * atom's squared radius, so a large atom is not brighter merely because it
 * covers more pixels, then by the largest such value. Instances are
 * replica-major: instance = replica × atomCount + atom. */
export function normalizeAmbientOcclusion(counts, radii, atomCount, output = new Float32Array(counts.length)) {
  if (!Number.isSafeInteger(atomCount) || atomCount < 1 || counts.length % atomCount) throw new Error('Ambient occlusion counts do not match the atom count.');
  if (!radii || radii.length !== atomCount) throw new Error('Ambient occlusion radii do not match the atom count.');
  if (output.length !== counts.length) throw new Error('The ambient occlusion output does not match its counts.');
  let maximum = 0;
  for (let first = 0; first < counts.length; first += atomCount) {
    for (let atom = 0; atom < atomCount; atom++) {
      const exposure = counts[first + atom] / (radii[atom] * radii[atom]);
      if (exposure > maximum) maximum = exposure;
    }
  }
  for (let first = 0; first < counts.length; first += atomCount) {
    for (let atom = 0; atom < atomCount; atom++) {
      output[first + atom] = maximum > 0 ? counts[first + atom] / (radii[atom] * radii[atom]) / maximum : 0;
    }
  }
  return { factors: output, maximum };
}

/** Bounding sphere of the unhidden displayed atoms, including every replica
 * and the largest displayed radius. Slices are not applied here: the buffer
 * covers the complete unhidden structure, so each direction uses the same
 * pixel size. */
export function ambientOcclusionBounds(renderer) {
  const positions = renderer.displayPositions, visibility = renderer.visibility, radii = renderer.atomRadii;
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  let largest = 0, visible = 0;
  for (let atom = 0; atom < renderer.atomCount; atom++) {
    if (visibility && visibility[atom] === 0) continue;
    visible++;
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[atom * 3 + axis];
      if (value < minimum[axis]) minimum[axis] = value;
      if (value > maximum[axis]) maximum[axis] = value;
    }
    if (radii[atom] > largest) largest = radii[atom];
  }
  if (!visible) return null;
  for (let axis = 0; axis < 3; axis++) {
    minimum[axis] += renderer.minimumOffset?.[axis] ?? 0;
    maximum[axis] += renderer.maximumOffset?.[axis] ?? 0;
  }
  const center = minimum.map((value, axis) => (value + maximum[axis]) / 2);
  const halfDiagonal = Math.hypot(...maximum.map((value, axis) => value - minimum[axis])) / 2;
  const padding = largest * renderer.radiusScale;
  // A small relative margin keeps silhouettes off the buffer's edge.
  const radius = (halfDiagonal + padding) * (1 + 1e-4) + 1e-6;
  return { center, radius, visible };
}

/** Parallel camera looking at the bounds from `direction` (unit, toward the eye). */
export function ambientOcclusionCamera(direction, bounds) {
  const { center, radius } = bounds;
  const eye = [0, 1, 2].map(axis => center[axis] + direction[axis] * 2 * radius);
  const up = Math.abs(direction[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  return { view: lookAt(eye, center, up), projection: orthographic(-radius, radius, -radius, radius, radius, 3 * radius) };
}

// Object identities without retaining previous frames or coordinate arrays.
const objectIds = new WeakMap();
let nextObjectId = 1;
function objectId(value) {
  if (!value || typeof value !== 'object') return 0;
  let id = objectIds.get(value);
  if (!id) { id = nextObjectId++; objectIds.set(value, id); }
  return id;
}

function sliceState(renderer) {
  if (renderer.sliceMode === 'planes') {
    const count = renderer.sliceCount ?? 0;
    return { mode: 'planes', count, planes: Float32Array.from((renderer.slicePlaneValues ?? []).slice(0, count * 4)) };
  }
  return { mode: 'legacy', axis: renderer.sliceAxis, maximum: renderer.sliceMaximum };
}

function replicaState(renderer) {
  const replicas = renderer.replicas ?? [{ indices: [0, 0, 0], offset: [0, 0, 0] }];
  const values = new Float64Array(replicas.length * 6);
  replicas.forEach(({ indices, offset }, index) => { values.set(indices, index * 6); values.set(offset, index * 6 + 3); });
  return values;
}

/** Every input that changes the factors: coordinates and periodic origin
 * (through the display coordinate arrays), visibility, radii and their scale,
 * replication, slices and the sampling settings. Colors, camera, background
 * and intensity are deliberately absent. */
export function ambientOcclusionInputs(renderer, settings) {
  return {
    atomCount: renderer.atomCount,
    positions: objectId(renderer.displayPositions),
    fractional: objectId(renderer.displayFractional),
    visibility: renderer.visibility ?? null,
    visibilityCopy: renderer.visibility ? renderer.visibility.slice() : null,
    radii: renderer.atomRadii ?? null,
    radiiCopy: renderer.atomRadii ? renderer.atomRadii.slice() : null,
    radiusScale: renderer.radiusScale,
    replicas: replicaState(renderer),
    slices: sliceState(renderer),
    directions: settings.directions,
    resolution: settings.resolution,
    seed: AMBIENT_OCCLUSION_SEED,
  };
}

// Analysis updates often replace visibility and radius arrays with equal
// contents. Compare those contents once, then adopt the new array so later
// checks are reference comparisons again.
// A known different array is remembered too, so a stale result costs one
// scan rather than one per rendered frame.
function sameContents(inputs, name, value) {
  if (inputs[name] === value) return true;
  if (inputs[`${name}Different`] === value) return false;
  const copy = inputs[`${name}Copy`];
  let same = Boolean(value && copy && value.length === copy.length);
  for (let index = 0; same && index < copy.length; index++) if (copy[index] !== value[index]) same = false;
  if (same) inputs[name] = value; else inputs[`${name}Different`] = value;
  return same;
}

function sameValues(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (!Object.is(left[index], right[index])) return false;
  return true;
}

export function ambientOcclusionInputsMatch(inputs, renderer, settings) {
  if (!inputs || inputs.atomCount !== renderer.atomCount || inputs.directions !== settings.directions
    || inputs.resolution !== settings.resolution || inputs.seed !== AMBIENT_OCCLUSION_SEED
    || inputs.radiusScale !== renderer.radiusScale
    || inputs.positions !== objectId(renderer.displayPositions) || inputs.fractional !== objectId(renderer.displayFractional)) return false;
  const slices = sliceState(renderer);
  if (slices.mode !== inputs.slices.mode) return false;
  if (slices.mode === 'planes' ? slices.count !== inputs.slices.count || !sameValues(slices.planes, inputs.slices.planes)
    : slices.axis !== inputs.slices.axis || !Object.is(slices.maximum, inputs.slices.maximum)) return false;
  if (!sameValues(replicaState(renderer), inputs.replicas)) return false;
  return sameContents(inputs, 'visibility', renderer.visibility ?? null) && sameContents(inputs, 'radii', renderer.atomRadii ?? null);
}

const ID_VERTEX = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aCenter;
layout(location=3) in vec3 aFractional;
layout(location=4) in float aVisible;
layout(location=5) in float aRadius;
uniform mat4 uView;
uniform mat4 uProjection;
uniform float uRadiusScale;
uniform int uSliceAxis;
uniform float uSliceMaximum;
uniform int uSliceMode;
uniform int uSliceCount;
uniform vec4 uSlicePlanes[${MAX_SLICE_PLANES}];
uniform vec3 uReplicaOffset;
uniform vec3 uReplicaIndex;
uniform vec3 uRepetitions;
uniform uint uFirstId;
out vec2 vCorner;
out vec3 vCenterView;
flat out uint vId;
flat out float vRadius;
void main() {
  vec3 worldCenter = aCenter + uReplicaOffset;
  vec4 centerView = uView * vec4(worldCenter, 1.0);
  float radius = aRadius * uRadiusScale;
  gl_Position = uProjection * (centerView + vec4(aCorner * radius, 0.0, 0.0));
  vCorner = aCorner;
  vCenterView = centerView.xyz;
  vRadius = radius;
  // The same visibility tests as the atom shader, so hidden and sliced-away
  // atoms neither occlude others nor receive a value.
  bool sliceVisible = true;
  if (uSliceMode == 0) {
    float sliceCoordinate = (aFractional[uSliceAxis] + uReplicaIndex[uSliceAxis]) / uRepetitions[uSliceAxis];
    sliceVisible = sliceCoordinate <= uSliceMaximum;
  } else {
    for (int plane = 0; plane < ${MAX_SLICE_PLANES}; plane++) {
      if (plane >= uSliceCount) break;
      if (dot(uSlicePlanes[plane].xyz, worldCenter) > uSlicePlanes[plane].w + ${SLICE_EPSILON}) {
        sliceVisible = false;
        break;
      }
    }
  }
  if (!(aVisible > 0.5 && sliceVisible)) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vId = uFirstId + uint(gl_InstanceID);
}`;

const ID_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec2 vCorner;
in vec3 vCenterView;
flat in uint vId;
flat in float vRadius;
uniform mat4 uProjection;
out vec4 outId;
void main() {
  float radiusSquared = dot(vCorner, vCorner);
  if (radiusSquared > 1.0) discard;
  float normalZ = sqrt(max(0.0, 1.0 - radiusSquared));
  vec4 surfaceClip = uProjection * vec4(vCenterView + vec3(vCorner * vRadius, normalZ * vRadius), 1.0);
  gl_FragDepth = surfaceClip.z / surfaceClip.w * 0.5 + 0.5;
  // Exact bytes: k / 255 converts back to k in an RGBA8 target.
  outId = vec4(uvec4(vId, vId >> 8u, vId >> 16u, vId >> 24u) & 255u) / 255.0;
}`;

const ID_UNIFORMS = ['uView', 'uProjection', 'uRadiusScale', 'uSliceAxis', 'uSliceMaximum', 'uSliceMode', 'uSliceCount',
  'uSlicePlanes[0]', 'uReplicaOffset', 'uReplicaIndex', 'uRepetitions', 'uFirstId'];

/** GPU resources for index passes in one WebGL2 context. It reads the
 * renderer's own atom buffers and restores every state it changes. */
export class AmbientOcclusionPass {
  constructor(gl) {
    this.gl = gl;
    this.program = createProgram(gl, ID_VERTEX, ID_FRAGMENT);
    this.uniforms = Object.fromEntries(ID_UNIFORMS.map(name => [name, gl.getUniformLocation(this.program, name)]));
    this.vao = null; this.vaoBuffers = null; this.quad = null;
    this.framebuffer = this.color = this.depth = null; this.resolution = 0;
    // Background work copies each image into a pixel-pack buffer behind a
    // fence and collects it on a later task, so it never waits for the GPU.
    this.asynchronous = true; this.slots = [];
  }

  attach(renderer) {
    const gl = this.gl, buffers = [renderer.positionBuffer, renderer.fractionalBuffer, renderer.visibilityBuffer, renderer.radiusBuffer];
    if (this.vao && this.vaoBuffers.every((buffer, index) => buffer === buffers[index])) return;
    const previous = gl.getParameter(gl.ARRAY_BUFFER_BINDING), previousVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.vao = gl.createVertexArray(); this.vaoBuffers = buffers;
    gl.bindVertexArray(this.vao);
    if (!this.quad) {
      this.quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    } else gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (const [location, buffer, size, type, normalized] of [[1, buffers[0], 3, gl.FLOAT, false], [3, buffers[1], 3, gl.FLOAT, false],
      [4, buffers[2], 1, gl.UNSIGNED_BYTE, true], [5, buffers[3], 1, gl.FLOAT, false]]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, type, normalized, 0, 0);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(previousVao); gl.bindBuffer(gl.ARRAY_BUFFER, previous);
  }

  allocate(resolution) {
    const gl = this.gl;
    const limit = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), ...Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS)));
    if (resolution > limit) throw new Error(`This GPU supports ambient occlusion buffers up to ${limit} pixels.`);
    if (this.resolution === resolution && this.framebuffer) return;
    this.release();
    const previous = { framebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING), renderbuffer: gl.getParameter(gl.RENDERBUFFER_BINDING) };
    try {
      this.framebuffer = gl.createFramebuffer(); this.color = gl.createRenderbuffer(); this.depth = gl.createRenderbuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.color);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, resolution, resolution);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.color);
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, resolution, resolution);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE || gl.getError() !== gl.NO_ERROR) {
        throw new Error('This GPU could not allocate the ambient occlusion buffer. Choose a lower resolution.');
      }
      this.resolution = resolution;
    } catch (error) { this.release(); throw error; }
    finally { gl.bindFramebuffer(gl.FRAMEBUFFER, previous.framebuffer); gl.bindRenderbuffer(gl.RENDERBUFFER, previous.renderbuffer); }
  }

  /** Free background readback slots for the allocated resolution. */
  available() {
    if (!this.slots.length) {
      const gl = this.gl, bytes = this.resolution * this.resolution * 4;
      const count = Math.max(1, Math.min(4, Math.floor(READBACK_BYTES / bytes)));
      const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
      for (let index = 0; index < count; index++) {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
        this.slots.push({ buffer, sync: null, busy: false });
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
    }
    return this.slots.some(slot => !slot.busy);
  }

  ready(slot) { return this.gl.getSyncParameter(slot.sync, this.gl.SYNC_STATUS) === this.gl.SIGNALED; }

  /** Copy a submitted image into `pixels` (waits only if it is not ready). */
  collect(slot, pixels) {
    const gl = this.gl, previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
    this.free(slot);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('The GPU could not read back the ambient occlusion pass.');
  }

  free(slot) {
    if (slot.sync) this.gl.deleteSync(slot.sync);
    slot.sync = null; slot.busy = false;
  }

  /** Render one direction. With `pixels`, read the index image back at once;
   * otherwise queue the copy into a free readback slot and return the slot. */
  render(renderer, direction, bounds, pixels = null) {
    const gl = this.gl, u = this.uniforms, resolution = this.resolution;
    if (gl.isContextLost()) throw new Error('The graphics context was lost. Reload the structure to compute ambient occlusion.');
    const slot = pixels ? null : this.slots.find(candidate => !candidate.busy);
    if (!pixels && !slot) throw new Error('No ambient occlusion readback slot is free.');
    this.attach(renderer);
    const saved = {
      draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      viewport: gl.getParameter(gl.VIEWPORT), program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
      clear: gl.getParameter(gl.COLOR_CLEAR_VALUE), colorMask: gl.getParameter(gl.COLOR_WRITEMASK), depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
      flags: [gl.BLEND, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SCISSOR_TEST, gl.DEPTH_TEST].map(flag => [flag, gl.isEnabled(flag)]),
    };
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.viewport(0, 0, resolution, resolution);
      for (const flag of [gl.BLEND, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SCISSOR_TEST]) gl.disable(flag);
      gl.enable(gl.DEPTH_TEST);
      gl.colorMask(true, true, true, true); gl.depthMask(true);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const camera = ambientOcclusionCamera(direction, bounds);
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.uniformMatrix4fv(u.uView, false, camera.view);
      gl.uniformMatrix4fv(u.uProjection, false, camera.projection);
      gl.uniform1f(u.uRadiusScale, renderer.radiusScale);
      gl.uniform1i(u.uSliceAxis, renderer.sliceAxis);
      gl.uniform1f(u.uSliceMaximum, renderer.sliceMaximum);
      gl.uniform1i(u.uSliceMode, renderer.sliceMode === 'planes' ? 1 : 0);
      gl.uniform1i(u.uSliceCount, renderer.sliceCount ?? 0);
      gl.uniform4fv(u['uSlicePlanes[0]'], renderer.slicePlaneValues ?? new Float32Array(MAX_SLICE_PLANES * 4));
      gl.uniform3f(u.uRepetitions, ...renderer.repetitions);
      renderer.replicas.forEach((replica, ordinal) => {
        gl.uniform3f(u.uReplicaOffset, ...replica.offset);
        gl.uniform3f(u.uReplicaIndex, ...replica.indices);
        // Instance IDs are replica-major and offset by one; zero is empty.
        gl.uniform1ui(u.uFirstId, ordinal * renderer.atomCount + 1);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, renderer.atomCount);
      });
      if (pixels) gl.readPixels(0, 0, resolution, resolution, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      else {
        const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
        gl.readPixels(0, 0, resolution, resolution, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
        slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); slot.busy = true;
        gl.flush();
      }
      if (gl.getError() !== gl.NO_ERROR) throw new Error('The GPU could not render the ambient occlusion pass.');
      return slot;
    } finally {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, saved.draw); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, saved.read);
      gl.viewport(...saved.viewport); gl.useProgram(saved.program); gl.bindVertexArray(saved.vao);
      gl.clearColor(...saved.clear); gl.colorMask(...saved.colorMask); gl.depthMask(saved.depthMask);
      for (const [flag, enabled] of saved.flags) if (enabled) gl.enable(flag); else gl.disable(flag);
    }
  }

  release() {
    const gl = this.gl;
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);
    for (const buffer of [this.color, this.depth]) if (buffer) gl.deleteRenderbuffer(buffer);
    for (const slot of this.slots) { this.free(slot); gl.deleteBuffer(slot.buffer); }
    this.framebuffer = this.color = this.depth = null; this.resolution = 0; this.slots = [];
  }

  dispose() {
    this.release();
    const gl = this.gl;
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.quad) gl.deleteBuffer(this.quad);
    gl.deleteProgram(this.program);
    this.vao = this.quad = this.vaoBuffers = null;
  }
}

function defaultSchedule(callback, delay) {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
}

/** Owns the settings, the cached result and an incremental, cancellable
 * computation for one renderer. `update()` runs after every frame drawn and
 * costs a few comparisons when nothing changed; `ensureCurrent()` finishes
 * the computation synchronously before an image export. */
export class AmbientOcclusionController {
  constructor(renderer, { onChange = () => {}, onStatus = () => {}, schedule = defaultSchedule,
    now = () => performance.now(), budgetMs = 12, delayMs = 150, createPass = gl => new AmbientOcclusionPass(gl) } = {}) {
    Object.assign(this, { renderer, onChange, onStatus, schedule, now, budgetMs, delayMs, createPass });
    this.settings = { ...DEFAULT_AMBIENT_OCCLUSION };
    this.result = this.job = this.pending = this.cancelledInputs = this.pass = null;
    this.status = { state: 'off' };
  }

  setSettings(patch) {
    const previous = this.settings, settings = normalizeAmbientOcclusionSettings(patch, previous);
    this.settings = settings;
    if (!settings.enabled) {
      // Off releases the buffers; only the settings remain.
      this.stop(); this.result = null; this.cancelledInputs = null; this.pixels = null; this.pass?.release();
      if (this.renderer.ambientOcclusionFactors) this.renderer.setAmbientOcclusion(null, { intensity: settings.intensity });
      this.report({ state: 'off' });
      this.onChange();
      return settings;
    }
    if (this.renderer.ambientOcclusionFactors && settings.intensity !== this.renderer.ambientOcclusionIntensity) {
      this.renderer.setAmbientOcclusion(this.renderer.ambientOcclusionFactors, { intensity: settings.intensity });
      this.onChange();
    }
    if (!previous.enabled || previous.directions !== settings.directions || previous.resolution !== settings.resolution) {
      this.cancelledInputs = null;
      this.update({ immediate: !previous.enabled });
    }
    return settings;
  }

  matches(inputs) { return ambientOcclusionInputsMatch(inputs, this.renderer, this.settings); }

  /** Start, restart or abandon work when the rendered inputs changed. */
  update({ immediate = false } = {}) {
    const renderer = this.renderer;
    if (!this.settings.enabled) return;
    if (!renderer.frame) {
      this.stop(); this.result = null;
      if (renderer.ambientOcclusionFactors) renderer.setAmbientOcclusion(null);
      this.report({ state: 'idle' });
      return;
    }
    if (this.result && this.matches(this.result.inputs)) {
      // Inputs returned to those of the displayed result, e.g. after Cancel.
      this.stop(); this.cancelledInputs = null;
      if (renderer.ambientOcclusionFactors !== this.result.factors) this.apply(this.result.factors);
      this.report(this.readyStatus());
      return;
    }
    if (this.job && this.matches(this.job.inputs)) return;
    if (this.pending && this.matches(this.pending.inputs) && !immediate) return;
    if (!immediate && this.matches(this.cancelledInputs)) return;
    // Wait until edits such as a slider drag pause; the previous result stays
    // visible until the new one is ready.
    this.stop();
    const pending = { inputs: ambientOcclusionInputs(renderer, this.settings) };
    pending.cancel = this.schedule(() => this.begin(pending), immediate ? 0 : this.delayMs);
    this.pending = pending;
    this.report({ state: 'queued', completed: 0, total: this.settings.directions });
  }

  begin(pending) {
    if (this.pending !== pending) return;
    this.pending = null;
    if (!this.matches(pending.inputs)) { this.update(); return; }
    try { this.start(pending.inputs); } catch (error) { this.fail(error); return; }
    this.advance();
  }

  start(inputs) {
    const renderer = this.renderer, instances = renderer.atomCount * renderer.replicas.length;
    if (instances > MAX_AMBIENT_OCCLUSION_INSTANCES) {
      throw new Error(`Ambient occlusion supports up to ${MAX_AMBIENT_OCCLUSION_INSTANCES.toLocaleString('en-US')} displayed atoms; this view has ${instances.toLocaleString('en-US')}.`);
    }
    this.pass ??= this.createPass(renderer.gl);
    this.pass.allocate(inputs.resolution);
    const texels = inputs.resolution * inputs.resolution;
    this.pixels = this.pixels?.length === texels * 4 ? this.pixels : new Uint8Array(texels * 4);
    this.job = { inputs, directions: ambientOcclusionDirections(inputs.directions), next: 0, done: 0, total: inputs.directions,
      counts: new Uint32Array(instances), bounds: ambientOcclusionBounds(renderer), startedAt: this.now(), workMs: 0,
      flight: [], cancel: null };
  }

  direction(job, index) { return job.directions.subarray(index * 3, index * 3 + 3); }

  /** One direction rendered and read back at once. */
  step(job) {
    if (job.bounds) {
      this.pass.render(this.renderer, this.direction(job, job.next), job.bounds, this.pixels);
      accumulateVisiblePixels(this.pixels, job.counts);
    }
    job.next++; job.done++;
  }

  /** Images on the GPU are read back in submission order: all of them when
   * waiting, otherwise those already finished, until the deadline passes. */
  collect(job, { wait = false, deadline = Infinity } = {}) {
    while (job.flight.length && (wait || this.pass.ready(job.flight[0]))) {
      this.pass.collect(job.flight.shift(), this.pixels);
      accumulateVisiblePixels(this.pixels, job.counts);
      job.done++;
      if (this.now() >= deadline) break;
    }
  }

  advance() {
    const job = this.job;
    if (!job) return;
    job.cancel = null;
    if (!this.matches(job.inputs)) { this.stop(); this.update(); return; }
    const started = this.now(), instances = job.counts.length;
    try {
      // Background work never waits for the GPU: images are collected only
      // after their fences signal (immediate readback is for exports).
      if (job.bounds && this.pass.asynchronous) {
        this.collect(job, { deadline: started + this.budgetMs });
        // Submitting is cheap: refill every free slot so the GPU keeps working
        // while later slices read back.
        while (job.next < job.total && this.pass.available()
          && (!job.flight.length || (job.flight.length + 1) * instances <= MAX_INSTANCES_IN_FLIGHT)) {
          job.flight.push(this.pass.render(this.renderer, this.direction(job, job.next), job.bounds));
          job.next++;
        }
      } else {
        do { this.step(job); } while (job.next < job.total && this.now() - started < this.budgetMs);
      }
    } catch (error) { this.fail(error); return; }
    job.workMs += this.now() - started;
    if (job.done >= job.total) { this.finish(job); return; }
    this.report({ state: 'computing', completed: job.done, total: job.total });
    // Poll a pending fence soon; otherwise continue after other tasks.
    job.cancel = this.schedule(() => { if (this.job === job) this.advance(); }, job.flight.length ? 1 : 0);
  }

  finish(job) {
    const renderer = this.renderer;
    const { factors } = normalizeAmbientOcclusion(job.counts, renderer.atomRadii, renderer.atomCount);
    this.job = null;
    this.result = { inputs: job.inputs, factors, elapsedMs: this.now() - job.startedAt, workMs: job.workMs,
      directions: job.total, resolution: job.inputs.resolution, instances: job.counts.length, visible: job.bounds?.visible ?? 0 };
    this.apply(factors);
    this.report(this.readyStatus());
  }

  apply(factors) {
    this.renderer.setAmbientOcclusion(factors, { intensity: this.settings.intensity });
    this.onChange();
  }

  /** Complete the factors for the current inputs now. Exports call this so
   * every image, including each frame of a ZIP, uses a current result. */
  ensureCurrent() {
    const renderer = this.renderer;
    if (!this.settings.enabled || !renderer.frame) return false;
    if (this.result && this.matches(this.result.inputs)) {
      if (renderer.ambientOcclusionFactors !== this.result.factors) this.apply(this.result.factors);
      return true;
    }
    let job = this.job && this.matches(this.job.inputs) ? this.job : null;
    if (!job) {
      this.stop();
      try { this.start(ambientOcclusionInputs(renderer, this.settings)); }
      catch (error) { this.fail(error); throw error; }
      job = this.job;
    }
    job.cancel?.(); job.cancel = null;
    const started = this.now();
    try { this.collect(job, { wait: true }); while (job.next < job.total) this.step(job); }
    catch (error) { this.fail(error); throw error; }
    job.workMs += this.now() - started;
    this.finish(job);
    return true;
  }

  /** Recalculate even if the inputs appear unchanged. */
  recompute() {
    if (!this.settings.enabled) return;
    this.stop(); this.result = null; this.cancelledInputs = null;
    this.update({ immediate: true });
  }

  /** Stop the current computation; it resumes only after an input changes
   * or Recompute. The last completed result stays displayed. */
  cancel() {
    if (!this.job && !this.pending) return;
    this.cancelledInputs = (this.job ?? this.pending).inputs;
    this.stop();
    this.report({ state: 'cancelled' });
  }

  stop() {
    this.pending?.cancel?.(); this.pending = null;
    this.job?.cancel?.();
    for (const slot of this.job?.flight ?? []) this.pass.free(slot);
    this.job = null;
  }

  fail(error) {
    this.stop(); this.result = null;
    if (this.renderer.ambientOcclusionFactors) this.renderer.setAmbientOcclusion(null);
    this.cancelledInputs = this.renderer.frame ? ambientOcclusionInputs(this.renderer, this.settings) : null;
    this.report({ state: 'error', message: error?.message ?? String(error) });
    this.onChange();
  }

  readyStatus() {
    const result = this.result;
    return { state: 'ready', completed: result.directions, total: result.directions, elapsedMs: result.elapsedMs,
      workMs: result.workMs, resolution: result.resolution, instances: result.instances, visible: result.visible };
  }

  report(status) {
    const previous = this.status;
    if (Object.keys(status).length === Object.keys(previous).length && Object.entries(status).every(([key, value]) => previous[key] === value)) return;
    this.status = status; this.onStatus(status);
  }

  dispose() { this.stop(); this.pass?.dispose(); this.pass = null; this.pixels = null; }
}

function createProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Ambient occlusion shader failed: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program, shader); gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Ambient occlusion program failed: ${gl.getProgramInfoLog(program)}`);
  return program;
}
