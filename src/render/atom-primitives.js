import { invert3 } from '../data/model.js';
import { MAX_SLICES, SLICE_EPSILON } from './slicing.js';
import { SCALAR_COLOR_GLSL, SCALAR_COLOR_UNIFORMS, applyScalarColorUniforms } from './scalar-colormap.js';

// Atom textures and instance buffers have source-frame sizes. Repeating a skew
// cell changes uniforms only; recoloring/filtering never walks every bond.
const VERTEX = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec3 aMesh;
layout(location=1) in vec3 aNormal;
layout(location=2) in uvec2 aAtoms;
layout(location=3) in vec3 aVector;
layout(location=4) in vec3 aShift;
uniform sampler2D uPositions;
uniform sampler2D uColors;
uniform sampler2D uFractional;
uniform sampler2D uScalarValues;
${SCALAR_COLOR_GLSL}
uniform int uTextureWidth;
uniform mat4 uView;
uniform mat4 uProjection;
uniform vec3 uReplicaOffset;
uniform vec3 uReplicaIndex;
uniform vec3 uRepetitions;
uniform int uSliceAxis;
uniform float uSliceMaximum;
uniform int uSliceMode;
uniform int uSliceCount;
uniform vec4 uSlicePlanes[${MAX_SLICES}];
uniform bool uVectorMode;
uniform vec3 uVectorColor;
uniform float uScale;
uniform float uRadius;
uniform vec2 uExtent;
uniform float uAnchor;
uniform float uHeadLength;
uniform bool uArrowHead;
uniform bool uFlatMode;
uniform bool uFixedUp;
uniform vec3 uArrowUp;
out vec3 vNormal;
out vec3 vWorld;
out float vAlong;
flat out vec3 vColorFirst;
flat out vec3 vColorSecond;
flat out int vVisible;
ivec2 atomUV(uint atom) { return ivec2(int(atom) % uTextureWidth, int(atom) / uTextureWidth); }
bool sliceVisible(vec3 position, vec3 fractional, vec3 replica) {
  if (uSliceMode == 0) return (fractional[uSliceAxis] + replica[uSliceAxis]) / uRepetitions[uSliceAxis] <= uSliceMaximum;
  for (int plane = 0; plane < ${MAX_SLICES}; plane++) {
    if (plane >= uSliceCount) break;
    if (dot(uSlicePlanes[plane].xyz, position) > uSlicePlanes[plane].w + ${SLICE_EPSILON}) return false;
  }
  return true;
}
void main() {
  ivec2 first = atomUV(aAtoms.x), second = atomUV(aAtoms.y);
  vec4 startData = texelFetch(uPositions, first, 0);
  vec4 endData = texelFetch(uPositions, second, 0);
  vec3 start = startData.xyz + uReplicaOffset;
  bool validVector = !any(isnan(aVector)) && !any(isinf(aVector));
  vec3 delta = validVector ? aVector * uScale : vec3(0.0);
  float vectorLength = length(delta);
  vec3 direction = vectorLength > 1e-12 ? delta / vectorLength : vec3(0.0, 0.0, 1.0);
  vec3 reference = abs(direction.z) < 0.85 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 across = normalize(cross(reference, direction));
  if (uFlatMode) {
    // Keep the complete world vector, including depth. Only the glyph's width
    // faces the camera, so rotating the view projects the original 3D direction.
    vec3 cameraBack = transpose(mat3(uView)) * vec3(0.0, 0.0, 1.0);
    vec3 screenAcross = uFixedUp ? cross(direction, uArrowUp) : cross(cameraBack, direction);
    across = length(screenAcross) > 1e-12 ? normalize(screenAcross)
      : uFixedUp ? across : transpose(mat3(uView)) * vec3(1.0, 0.0, 0.0);
  }
  vec3 up = cross(direction, across);
  vec2 extent = uExtent;
  if (uVectorMode) {
    float shaftFraction = 1.0 - min(1.0, uHeadLength / max(vectorLength, 1e-12));
    extent = uArrowHead ? vec2(shaftFraction, 1.0) : vec2(0.0, shaftFraction);
  }
  float segmentLength = vectorLength * (extent.y - extent.x);
  vAlong = mix(extent.x, extent.y, aMesh.z);
  vWorld = start + delta * (vAlong + (uVectorMode ? uAnchor : 0.0))
    + (across * aMesh.x + up * aMesh.y) * uRadius;
  // Inverse scale keeps the cone's surface normal correct for any vector length.
  vec3 normal = vec3(aNormal.xy / max(uRadius, 1e-12), aNormal.z / max(segmentLength, 1e-12));
  vNormal = uFlatMode ? vec3(0.0, 0.0, 1.0)
    : mat3(uView) * normalize(across * normal.x + up * normal.y + direction * normal.z);
  gl_Position = uProjection * uView * vec4(vWorld, 1.0);
  vec4 firstColor = texelFetch(uColors, first, 0), secondColor = texelFetch(uColors, second, 0);
  float firstScalar = uScalarColorEnabled ? texelFetch(uScalarValues, first, 0).r : 0.0;
  float secondScalar = uScalarColorEnabled ? texelFetch(uScalarValues, second, 0).r : 0.0;
  vColorFirst = uVectorMode ? uVectorColor : scalarColor(firstScalar, firstColor.a > 0.5, firstColor.rgb);
  vColorSecond = uVectorMode ? uVectorColor : scalarColor(secondScalar, secondColor.a > 0.5, secondColor.rgb);
  vec3 firstFractional = texelFetch(uFractional, first, 0).xyz;
  vec3 secondFractional = texelFetch(uFractional, second, 0).xyz;
  vec3 secondReplica = uReplicaIndex + aShift;
  bool endpointInDisplay = uVectorMode || (all(greaterThanEqual(secondReplica, vec3(0.0))) && all(lessThan(secondReplica, uRepetitions)));
  // Ordinary atom/category filters leave the independent arrow layer visible.
  // Selection hiding uses a negative flag to hide the atom's attached arrows.
  bool shown = (uVectorMode ? (startData.w >= 0.0 && endData.w >= 0.0)
      : (startData.w > 0.5 && endData.w > 0.5))
    && vectorLength > 1e-12 && segmentLength > 1e-12 && endpointInDisplay;
  shown = shown && sliceVisible(start, firstFractional, uReplicaIndex);
  if (!uVectorMode) shown = shown && scalarShown(firstScalar) && scalarShown(secondScalar);
  if (!uVectorMode) shown = shown && sliceVisible(start + delta, secondFractional, secondReplica);
  vVisible = shown ? 1 : 0;
  // Hidden bonds and arrows are dropped before rasterization.
  if (!shown) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec3 vNormal;
in vec3 vWorld;
in float vAlong;
flat in vec3 vColorFirst;
flat in vec3 vColorSecond;
flat in int vVisible;
uniform int uSliceMode;
uniform int uSliceCount;
uniform vec4 uSlicePlanes[${MAX_SLICES}];
uniform bool uFlatMode;
out vec4 outColor;
void main() {
  if (vVisible == 0) discard;
  if (uSliceMode == 1) {
    for (int plane = 0; plane < ${MAX_SLICES}; plane++) {
      if (plane >= uSliceCount) break;
      if (dot(uSlicePlanes[plane].xyz, vWorld) > uSlicePlanes[plane].w + ${SLICE_EPSILON}) discard;
    }
  }
  vec3 normal = normalize(vNormal);
  vec3 base = vAlong < 0.5 ? vColorFirst : vColorSecond;
  if (uFlatMode) { outColor = vec4(base, 1.0); return; }
  vec3 key = normalize(vec3(-0.48, 0.62, 0.72));
  vec3 fill = normalize(vec3(0.68, -0.36, 0.48));
  float light = 0.30 + 0.64 * max(0.0, dot(normal, key)) + 0.16 * max(0.0, dot(normal, fill));
  float specular = 0.14 * pow(max(0.0, dot(normal, normalize(key + vec3(0.0, 0.0, 1.0)))), 28.0);
  vec3 linearColor = pow(base, vec3(2.2)) * light + vec3(specular);
  outColor = vec4(pow(clamp(linearColor, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

export function createPrimitiveMesh(cone = false, sides = 10) {
  if (!Number.isInteger(sides) || sides < 3) throw new Error('A cylinder needs at least three sides.');
  const vertices = [];
  const vertex = (x, y, z, nx, ny, nz) => vertices.push(x, y, z, nx, ny, nz);
  for (let side = 0; side < sides; side += 1) {
    const a = side * Math.PI * 2 / sides, b = (side + 1) * Math.PI * 2 / sides;
    const x = Math.cos(a), y = Math.sin(a), nextX = Math.cos(b), nextY = Math.sin(b);
    if (cone) {
      vertex(x, y, 0, x, y, 1);
      vertex(nextX, nextY, 0, nextX, nextY, 1);
      vertex(0, 0, 1, Math.cos((a + b) / 2), Math.sin((a + b) / 2), 1);
    } else {
      vertex(x, y, 0, x, y, 0); vertex(nextX, nextY, 0, nextX, nextY, 0); vertex(x, y, 1, x, y, 0);
      vertex(nextX, nextY, 0, nextX, nextY, 0); vertex(nextX, nextY, 1, nextX, nextY, 0); vertex(x, y, 1, x, y, 0);
      vertex(0, 0, 1, 0, 0, 1); vertex(x, y, 1, 0, 0, 1); vertex(nextX, nextY, 1, 0, 0, 1);
    }
    vertex(0, 0, 0, 0, 0, -1); vertex(nextX, nextY, 0, 0, 0, -1); vertex(x, y, 0, 0, 0, -1);
  }
  return new Float32Array(vertices);
}

/** Flat rectangle/triangle meshes use the same across/up/along coordinates as
 * cylinders. Their winding faces cameraBack after the billboard basis transform.
 */
export function createFlatArrowMesh(head = false) {
  const points = head ? [[-1, 0], [0, 1], [1, 0]]
    : [[-1, 0], [-1, 1], [1, 0], [1, 0], [-1, 1], [1, 1]];
  return Float32Array.from(points.flatMap(([x, z]) => [x, 0, z, 0, 1, 0]));
}

export const DEFAULT_VECTOR_OPTIONS = Object.freeze({
  visible: true, scale: 1, radius: 0.06, headRadius: 0.15, headLength: 0.3,
  anchor: 'tail', dimension: '3d', color: Object.freeze([0.97, 0.65, 0.20]),
  upMode: 'camera', up: Object.freeze([0, 1, 0]),
});

export function normalizeVectorOptions(options = {}, previous = {}) {
  const values = Object.fromEntries(Object.entries(DEFAULT_VECTOR_OPTIONS)
    .map(([name, fallback]) => [name, options[name] ?? previous[name] ?? fallback]));
  for (const name of ['scale', 'radius', 'headRadius', 'headLength']) {
    if (!Number.isFinite(values[name]) || values[name] <= 0) {
      throw new Error('Vector scale, shaft radius, head radius and head length must be greater than zero.');
    }
  }
  if (!['tail', 'head', 'center'].includes(values.anchor)) throw new Error('Arrow anchoring must be tail, head or center.');
  if (!['3d', '2d'].includes(values.dimension)) throw new Error('Arrow geometry must be 3d or 2d.');
  if (!['camera', 'fixed'].includes(values.upMode)) throw new Error('Arrow plane must face the camera or use a fixed up direction.');
  if (!(Array.isArray(values.up) || ArrayBuffer.isView(values.up)) || values.up.length !== 3
    || !Array.from(values.up).every(Number.isFinite) || Math.hypot(...values.up) < 1e-12) throw new Error('Arrow up direction requires three finite components and a nonzero length.');
  values.up = Array.from(values.up);
  values.visible = Boolean(values.visible);
  values.color = parsePrimitiveColor(values.color);
  return values;
}

/** Physical endpoints shared with tests and scene-bound calculations. The head
 * shrinks to the full arrow length for short vectors; it never reverses a shaft.
 */
export function vectorArrowEndpoints(position, vector, options = {}) {
  if (position?.length !== 3 || vector?.length !== 3
    || ![...position, ...vector].every(Number.isFinite)) throw new Error('Arrow endpoints require finite XYZ coordinates.');
  const settings = normalizeVectorOptions(options), { scale, radius, headRadius, anchor } = settings;
  const delta = Array.from(vector, value => value * scale), length = Math.hypot(...delta);
  const headLength = Math.min(length, settings.headLength), shaftLength = length - headLength;
  const shift = { tail: 0, head: -1, center: -0.5 }[anchor];
  const tail = Array.from(position, (value, axis) => value + delta[axis] * shift);
  const tip = tail.map((value, axis) => value + delta[axis]);
  const headBase = tail.map((value, axis) => value + (length > 0 ? delta[axis] * shaftLength / length : 0));
  return { tail, tip, headBase, length, shaftLength, headLength, radius, headRadius };
}

export function parsePrimitiveColor(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    if (value.length !== 3 || !Array.from(value).every(component => Number.isFinite(component) && component >= 0 && component <= 1)) {
      throw new Error('Vector colors require three components between zero and one.');
    }
    return Array.from(value);
  }
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw new Error('Use a six-digit hex color for vectors.');
  return [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255);
}

export function validateBonds(result, atomCount) {
  if (!result) return null;
  const count = result.count ?? result.indices?.length / 2;
  if (!Number.isSafeInteger(count) || count < 0 || !(result.indices instanceof Uint32Array)
    || !(result.vectors instanceof Float32Array) || result.indices.length !== count * 2 || result.vectors.length !== count * 3
    || (result.shifts && (!(result.shifts instanceof Int32Array) || result.shifts.length !== count * 3))) {
    throw new Error('The bond arrays do not match the bond count.');
  }
  for (const atom of result.indices) if (atom >= atomCount) throw new Error('A bond endpoint is outside the current frame.');
  for (const component of result.vectors) if (!Number.isFinite(component)) throw new Error('Bond displacements must be finite.');
  return { ...result, count };
}

// Adjust image indices when showing unwrapped positions, without changing the
// physically short displacement supplied by the periodic neighbor worker.
export function bondDisplayShifts(result, frame, positions = frame.positions) {
  if (positions === frame.positions && result.shifts) return result.shifts;
  const inverse = invert3(frame.cell.vectors), shifts = new Int32Array(result.count * 3);
  for (let bond = 0; bond < result.count; bond += 1) {
    const first = result.indices[bond * 2] * 3, second = result.indices[bond * 2 + 1] * 3;
    const x = result.vectors[bond * 3] - (positions[second] - positions[first]);
    const y = result.vectors[bond * 3 + 1] - (positions[second + 1] - positions[first + 1]);
    const z = result.vectors[bond * 3 + 2] - (positions[second + 2] - positions[first + 2]);
    for (let axis = 0; axis < 3; axis += 1) shifts[bond * 3 + axis] = Math.round(x * inverse[axis] + y * inverse[3 + axis] + z * inverse[6 + axis]);
  }
  return shifts;
}

export class AtomPrimitiveLayer {
  constructor(gl) {
    this.gl = gl;
    this.program = program(gl, VERTEX, FRAGMENT);
    this.uniforms = Object.fromEntries(['uPositions', 'uColors', 'uFractional', 'uTextureWidth', 'uView', 'uProjection',
      'uReplicaOffset', 'uReplicaIndex', 'uRepetitions', 'uSliceAxis', 'uSliceMaximum', 'uSliceMode', 'uSliceCount',
      'uSlicePlanes[0]', 'uVectorMode', 'uVectorColor', 'uScale', 'uRadius', 'uExtent',
      'uAnchor', 'uHeadLength', 'uArrowHead', 'uFlatMode', 'uFixedUp', 'uArrowUp', 'uScalarValues',
      ...SCALAR_COLOR_UNIFORMS].map(name => [name, gl.getUniformLocation(this.program, name)]));
    this.textures = Array.from({ length: 3 }, () => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    });
    this.textureSizes = [null, null, null];
    this.cylinder = this.mesh(false);
    this.cone = this.mesh(true);
    this.flatShaft = this.mesh(false, true);
    this.flatHead = this.mesh(true, true);
    this.bondBuffers = this.instances();
    this.vectorBuffers = this.instances();
    this.bonds = this.vectors = null;
    this.vectorFields = [];
    this.bondOptions = { visible: true, radius: 0.08 };
    this.vectorOptions = normalizeVectorOptions();
  }

  mesh(cone, flat = false) {
    const gl = this.gl, values = flat ? createFlatArrowMesh(cone) : createPrimitiveMesh(cone), buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
    return { buffer, count: values.length / 6 };
  }

  instances() {
    const gl = this.gl;
    return { vao: gl.createVertexArray(), indices: gl.createBuffer(), vectors: gl.createBuffer(), shifts: gl.createBuffer(), count: 0 };
  }

  setFrame(renderer, colors) {
    this.scalarColorInput = null;
    const gl = this.gl, maximum = gl.getParameter(gl.MAX_TEXTURE_SIZE), count = renderer.atomCount;
    this.clearInstances();
    this.width = Math.min(maximum, Math.max(1, Math.ceil(Math.sqrt(count))));
    this.height = Math.max(1, Math.ceil(count / this.width));
    if (this.height > maximum) throw new Error('The structure exceeds this GPU’s atom texture capacity.');
    this.positionValues = new Float32Array(this.width * this.height * 4);
    this.colorValues = new Uint8Array(this.width * this.height * 4);
    this.fractionalValues = new Float32Array(this.width * this.height * 4);
    this.updatePositions(renderer);
    this.updateColors(colors);
  }

  uploadTexture(index, values, internalFormat, type) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + index);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[index]);
    const size = this.textureSizes[index];
    if (size?.[0] === this.width && size?.[1] === this.height) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RGBA, type, values);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, this.width, this.height, 0, gl.RGBA, type, values);
      this.textureSizes[index] = [this.width, this.height];
    }
    gl.activeTexture(gl.TEXTURE0);
  }

  updatePositions(renderer, regenerateShifts = true) {
    const fractional = renderer.displayFractional ?? renderer.frame.fractional;
    for (let atom = 0; atom < renderer.atomCount; atom += 1) {
      const index = atom * 3, target = atom * 4;
      this.positionValues[target] = renderer.displayPositions[index];
      this.positionValues[target + 1] = renderer.displayPositions[index + 1];
      this.positionValues[target + 2] = renderer.displayPositions[index + 2];
      this.positionValues[target + 3] = renderer.selectionVisibility?.[atom] === 0
        ? -1 : renderer.visibility?.[atom] === 0 ? 0 : 1;
      if (this.fractionalValues) {
        this.fractionalValues[target] = fractional[index];
        this.fractionalValues[target + 1] = fractional[index + 1];
        this.fractionalValues[target + 2] = fractional[index + 2];
      }
    }
    this.uploadTexture(0, this.positionValues, this.gl.RGBA32F, this.gl.FLOAT);
    if (this.fractionalValues && regenerateShifts) this.uploadTexture(2, this.fractionalValues, this.gl.RGBA32F, this.gl.FLOAT);
    if (this.bonds && regenerateShifts) this.uploadShifts(this.bondBuffers, bondDisplayShifts(this.bonds, renderer.frame, renderer.displayPositions));
  }

  updateColors(colors) {
    this.scalarColorInput = null;
    for (let atom = 0; atom < colors.length / 3; atom += 1) {
      this.colorValues[atom * 4] = colors[atom * 3];
      this.colorValues[atom * 4 + 1] = colors[atom * 3 + 1];
      this.colorValues[atom * 4 + 2] = colors[atom * 3 + 2];
      this.colorValues[atom * 4 + 3] = 255;
    }
    this.uploadTexture(1, this.colorValues, this.gl.RGBA8, this.gl.UNSIGNED_BYTE);
  }

  updateScalarColorPreview(input) {
    if (this.scalarColorInput === input) return;
    this.scalarColorInput = input;
    const gl = this.gl;
    for (let atom = 0; atom < input.values.length; atom++) this.colorValues[atom * 4 + 3] = input.colorOverrides[atom];
    this.uploadTexture(1, this.colorValues, gl.RGBA8, gl.UNSIGNED_BYTE);
    gl.activeTexture(gl.TEXTURE0);
  }

  uploadInstances(buffers, indices, vectors) {
    const gl = this.gl;
    buffers.count = indices.length / 2;
    for (const [name, values] of [['indices', indices], ['vectors', vectors]]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[name]);
      gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
    }
  }

  uploadShifts(buffers, shifts) {
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffers.shifts);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, shifts, this.gl.STATIC_DRAW);
  }

  setBonds(renderer, result, options = {}) {
    const unchanged = result && this.bonds && result.indices === this.bonds.indices && result.vectors === this.bonds.vectors
      && result.shifts === this.bonds.shifts && (result.count ?? result.indices.length / 2) === this.bonds.count;
    const bonds = unchanged ? this.bonds : validateBonds(result, renderer.atomCount);
    const radius = options.radius ?? this.bondOptions.radius;
    if (!Number.isFinite(radius) || radius <= 0) throw new Error('Bond radius must be greater than zero.');
    this.bonds = bonds;
    this.bondOptions = { visible: options.visible ?? this.bondOptions.visible, radius };
    if (bonds && !unchanged) {
      this.uploadInstances(this.bondBuffers, bonds.indices, bonds.vectors);
      this.uploadShifts(this.bondBuffers, bondDisplayShifts(bonds, renderer.frame, renderer.displayPositions));
    } else if (!bonds) this.releaseInstances(this.bondBuffers);
  }

  setVectors(renderer, values, options = {}) {
    const settings = normalizeVectorOptions(options, this.vectorOptions);
    this.setVectorFields(renderer, values ? [{ id: 'legacy', vectors: values, options: settings }] : []);
    this.vectorOptions = settings;
  }

  setVectorFields(renderer, fields = []) {
    if (!Array.isArray(fields)) throw new Error('Vector fields must be an array.');
    const previous = new Map((this.vectorFields ?? []).map(field => [field.id, field]));
    const ids = new Set();
    // Validate every field before changing buffers, so one bad field cannot
    // discard other arrows already on screen.
    const next = fields.map(field => {
      if (!field || typeof field.id !== 'string' || !field.id || ids.has(field.id)) throw new Error('Vector fields require unique nonempty IDs.');
      ids.add(field.id);
      if (!(field.vectors instanceof Float32Array) || field.vectors.length !== renderer.atomCount * 3) throw new Error('The vector array does not match the current frame.');
      return { id: field.id, vectors: field.vectors, options: normalizeVectorOptions(field.options, previous.get(field.id)?.options) };
    });
    let indices;
    for (const field of next) {
      const old = previous.get(field.id);
      field.buffers = old?.buffers ?? (next[0] === field && ![...previous.values()].some(item => item.buffers === this.vectorBuffers)
        ? this.vectorBuffers : this.instances());
      if (old?.vectors !== field.vectors) {
        if (!indices) {
          // A plain loop; Uint32Array.from with a callback is ~20× slower here.
          indices = new Uint32Array(renderer.atomCount * 2);
          for (let index = 0; index < indices.length; index += 1) indices[index] = index >> 1;
        }
        // Original atom indices keep all fields aligned with slices and replicas.
        this.uploadInstances(field.buffers, indices, field.vectors);
      }
    }
    for (const field of previous.values()) if (!ids.has(field.id)) {
      this.releaseInstances(field.buffers);
      if (field.buffers !== this.vectorBuffers) {
        for (const name of ['indices', 'vectors', 'shifts']) this.gl.deleteBuffer?.(field.buffers[name]);
        this.gl.deleteVertexArray?.(field.buffers.vao);
      }
    }
    if (!next.length && !previous.size) this.releaseInstances(this.vectorBuffers);
    this.vectorFields = next;
    this.vectors = next[0]?.vectors ?? null;
    if (next[0]) this.vectorOptions = next[0].options;
  }

  releaseInstances(buffers) {
    const gl = this.gl;
    buffers.count = 0;
    for (const name of ['indices', 'vectors', 'shifts']) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[name]);
      gl.bufferData(gl.ARRAY_BUFFER, 0, gl.STATIC_DRAW);
    }
  }

  clearInstances() {
    this.bonds = this.vectors = null;
    this.releaseInstances(this.bondBuffers);
    this.setVectorFields({ atomCount: 0 }, []);
  }

  clear() {
    this.clearInstances();
    this.scalarColorInput = null;
    this.positionValues = this.colorValues = this.fractionalValues = null;
    this.width = this.height = 1;
    this.uploadTexture(0, new Float32Array(4), this.gl.RGBA32F, this.gl.FLOAT);
    this.uploadTexture(1, new Uint8Array(4), this.gl.RGBA8, this.gl.UNSIGNED_BYTE);
    this.uploadTexture(2, new Float32Array(4), this.gl.RGBA32F, this.gl.FLOAT);
  }

  drawMesh(buffers, mesh, radius, scale, extent, vectorMode, arrowHead = false) {
    if (!buffers.count) return;
    const gl = this.gl, u = this.uniforms;
    gl.bindVertexArray(buffers.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
    for (let attribute = 0; attribute < 2; attribute += 1) {
      gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 24, attribute * 12);
      gl.vertexAttribDivisor(attribute, 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.indices);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribIPointer(2, 2, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.vectors);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(3, 1);
    if (vectorMode) {
      gl.disableVertexAttribArray(4);
      gl.vertexAttrib3f(4, 0, 0, 0);
    } else {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers.shifts);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 3, gl.INT, false, 0, 0);
      gl.vertexAttribDivisor(4, 1);
    }
    gl.uniform1i(u.uVectorMode, vectorMode ? 1 : 0);
    gl.uniform1i(u.uFlatMode, vectorMode && this.vectorOptions.dimension === '2d' ? 1 : 0);
    gl.uniform1i(u.uArrowHead, arrowHead ? 1 : 0);
    gl.uniform1f(u.uRadius, radius);
    gl.uniform1f(u.uScale, scale);
    gl.uniform2f(u.uExtent, ...extent);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, mesh.count, buffers.count);
  }

  render(renderer) {
    const fields = this.vectorFields ?? (this.vectors ? [{ vectors: this.vectors, options: this.vectorOptions, buffers: this.vectorBuffers }] : []);
    if ((!this.bonds || !this.bondOptions.visible) && !fields.some(field => field.options.visible)) return;
    const gl = this.gl, u = this.uniforms;
    gl.useProgram(this.program);
    if (renderer.scalarColorPreview) this.updateScalarColorPreview(renderer.scalarColorPreview.input);
    for (let index = 0; index < (renderer.scalarColorPreview ? 4 : 3); index += 1) {
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, index === 3 ? renderer.scalarColorTexture : this.textures[index]);
    }
    gl.uniform1i(u.uPositions, 0); gl.uniform1i(u.uColors, 1); gl.uniform1i(u.uFractional, 2);
    gl.uniform1i(u.uScalarValues, renderer.scalarColorPreview ? 3 : 2);
    applyScalarColorUniforms(gl, u, renderer.scalarColorPreview);
    gl.uniform1i(u.uTextureWidth, this.width);
    gl.uniformMatrix4fv(u.uView, false, renderer.viewMatrix);
    gl.uniformMatrix4fv(u.uProjection, false, renderer.projectionMatrix);
    gl.uniform3f(u.uRepetitions, ...renderer.repetitions);
    gl.uniform1i(u.uSliceAxis, renderer.sliceAxis);
    gl.uniform1f(u.uSliceMaximum, renderer.sliceMaximum);
    gl.uniform1i(u.uSliceMode, renderer.sliceMode === 'planes' ? 1 : 0);
    gl.uniform1i(u.uSliceCount, renderer.sliceCount ?? 0);
    gl.uniform4fv(u['uSlicePlanes[0]'], renderer.slicePlaneValues);
    const firstOptions = this.vectorOptions;
    for (const replica of renderer.replicas) {
      gl.uniform3f(u.uReplicaOffset, ...replica.offset);
      gl.uniform3f(u.uReplicaIndex, ...replica.indices);
      if (this.bonds && this.bondOptions.visible) this.drawMesh(this.bondBuffers, this.cylinder, this.bondOptions.radius, 1, [0, 1], false);
      for (const field of fields) if (field.options.visible) {
        this.vectorOptions = field.options;
        gl.uniform3f(u.uVectorColor, ...field.options.color);
        gl.uniform1f(u.uAnchor, { tail: 0, head: -1, center: -0.5 }[field.options.anchor]);
        gl.uniform1f(u.uHeadLength, field.options.headLength);
        gl.uniform1i(u.uFixedUp, field.options.upMode === 'fixed' ? 1 : 0);
        gl.uniform3f(u.uArrowUp, ...field.options.up);
        const { scale, radius, headRadius, dimension } = field.options;
        const flat = dimension === '2d';
        this.drawMesh(field.buffers, flat ? this.flatShaft : this.cylinder, radius, scale, [0, 1], true);
        this.drawMesh(field.buffers, flat ? this.flatHead : this.cone, headRadius, scale, [0, 1], true, true);
      }
    }
    this.vectorOptions = firstOptions;
    gl.activeTexture(gl.TEXTURE0);
  }

  extendBounds(renderer, minimum, maximum) {
    const fields = this.vectorFields ?? (this.vectors ? [{ vectors: this.vectors, options: this.vectorOptions }] : []);
    for (const { vectors, options } of fields) {
      if (!options.visible) continue;
      const { scale, radius, headRadius = DEFAULT_VECTOR_OPTIONS.headRadius, anchor = 'tail' } = options;
      const shift = { tail: 0, head: -1, center: -0.5 }[anchor], padding = Math.max(radius, headRadius);
      for (let offset = 0; offset < vectors.length; offset += 3) {
        if (renderer.selectionVisibility?.[offset / 3] === 0) continue;
        if (!Number.isFinite(vectors[offset]) || !Number.isFinite(vectors[offset + 1]) || !Number.isFinite(vectors[offset + 2])) continue;
        for (let axis = 0; axis < 3; axis += 1) {
          const delta = vectors[offset + axis] * scale;
          const tail = renderer.displayPositions[offset + axis] + delta * shift, tip = tail + delta;
          minimum[axis] = Math.min(minimum[axis], Math.min(tail, tip) + (renderer.minimumOffset?.[axis] ?? 0) - padding);
          maximum[axis] = Math.max(maximum[axis], Math.max(tail, tip) + (renderer.maximumOffset?.[axis] ?? 0) + padding);
        }
      }
    }
  }
}

function program(gl, vertex, fragment) {
  const result = gl.createProgram();
  for (const [kind, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
    const shader = gl.createShader(kind);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Atom geometry shader failed: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(result, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(result);
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(`Atom geometry linking failed: ${gl.getProgramInfoLog(result)}`);
  return result;
}
