import { invert3 } from '../data/model.js';
import { MAX_SLICE_PLANES, SLICE_EPSILON } from './slicing.js';
import { SCALAR_COLOR_GLSL, SCALAR_COLOR_UNIFORMS, applyScalarColorUniforms } from './scalar-colormap.js';
import { CRYSTAL_DRAG_GLSL, CRYSTAL_DRAG_UNIFORMS, applyCrystalDragUniforms } from './crystal-drag.js';

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
uniform highp isampler2D uVisibility;
uniform sampler2D uScalarValues;
${SCALAR_COLOR_GLSL}
${CRYSTAL_DRAG_GLSL}
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
uniform vec4 uSlicePlanes[${MAX_SLICE_PLANES}];
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
uniform bool uAmbientOcclusion;
uniform float uOcclusionIntensity;
uniform sampler2D uOcclusion;
uniform int uOcclusionWidth;
uniform int uAtomCount;
uniform int uReplicaCount;
out vec3 vNormal;
out vec3 vWorld;
out float vAlong;
flat out vec3 vColorFirst;
flat out vec3 vColorSecond;
flat out int vVisible;
ivec2 atomUV(uint atom) { return ivec2(int(atom) % uTextureWidth, int(atom) / uTextureWidth); }
// Bond halves take their atom's ambient occlusion in the displayed copy.
float occlusion(vec3 replica, uint atom) {
  int copy = clamp(int(replica.x + uRepetitions.x * (replica.y + uRepetitions.y * replica.z)), 0, uReplicaCount - 1);
  int index = copy * uAtomCount + int(atom);
  return texelFetch(uOcclusion, ivec2(index % uOcclusionWidth, index / uOcclusionWidth), 0).r;
}
bool sliceVisible(vec3 position, vec3 fractional, vec3 replica) {
  if (uSliceMode == 0) return (fractional[uSliceAxis] + replica[uSliceAxis]) / uRepetitions[uSliceAxis] <= uSliceMaximum;
  for (int plane = 0; plane < ${MAX_SLICE_PLANES}; plane++) {
    if (plane >= uSliceCount) break;
    if (dot(uSlicePlanes[plane].xyz, position) > uSlicePlanes[plane].w + ${SLICE_EPSILON}) return false;
  }
  return true;
}
void main() {
  ivec2 first = atomUV(aAtoms.x), second = atomUV(aAtoms.y);
  vec4 startData = texelFetch(uPositions, first, 0);
  vec4 endData = texelFetch(uPositions, second, 0);
  vec3 firstFractional = texelFetch(uFractional, first, 0).xyz;
  vec3 secondFractional = texelFetch(uFractional, second, 0).xyz;
  // A crystal drag moves each endpoint with its atom's rewrapped image.
  vec3 firstStep = crystalDragStep(firstFractional), secondStep = crystalDragStep(secondFractional);
  vec3 start = startData.xyz + uReplicaOffset;
  if (uCrystalDrag) start += uCrystalCell * firstStep;
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
  vec3 secondReplica = uReplicaIndex + aShift;
  if (uCrystalDrag) secondReplica += round(firstStep - secondStep);
  if (uAmbientOcclusion && !uVectorMode) {
    vColorFirst *= mix(1.0, occlusion(uReplicaIndex, aAtoms.x), uOcclusionIntensity);
    vColorSecond *= mix(1.0, occlusion(secondReplica, aAtoms.y), uOcclusionIntensity);
  }
  bool endpointInDisplay = uVectorMode || (all(greaterThanEqual(secondReplica, vec3(0.0))) && all(lessThan(secondReplica, uRepetitions)));
  // Ordinary atom/category filters leave the independent arrow layer visible.
  // Selection hiding uses a negative flag to hide the atom's attached arrows.
  int firstVisible = texelFetch(uVisibility, first, 0).r, secondVisible = texelFetch(uVisibility, second, 0).r;
  bool shown = (uVectorMode ? (firstVisible >= 0 && secondVisible >= 0)
      : (firstVisible > 0 && secondVisible > 0))
    && vectorLength > 1e-12 && segmentLength > 1e-12 && endpointInDisplay;
  shown = shown && sliceVisible(start, firstFractional + firstStep, uReplicaIndex);
  if (!uVectorMode) shown = shown && scalarShown(firstScalar) && scalarShown(secondScalar);
  if (!uVectorMode) shown = shown && sliceVisible(start + delta, secondFractional + secondStep, secondReplica);
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
uniform vec4 uSlicePlanes[${MAX_SLICE_PLANES}];
uniform bool uFlatMode;
out vec4 outColor;
void main() {
  if (vVisible == 0) discard;
  if (uSliceMode == 1) {
    for (int plane = 0; plane < ${MAX_SLICE_PLANES}; plane++) {
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

/** Share only identical position/normal rows. Caps keep their hard normals and
 * the cone keeps each tip normal; the original triangles and seam bits remain
 * unchanged, including when small atoms expose a bond's end caps. */
export function createIndexedPrimitiveMesh(cone = false, sides = 10, capless = false) {
  if (cone && capless) throw new Error('Only bond cylinders can omit their caps.');
  const raw = createPrimitiveMesh(cone, sides), words = new Uint32Array(raw.buffer, raw.byteOffset, raw.length);
  const unique = new Map(), vertices = [], indices = [];
  for (let offset = 0; offset < raw.length; offset += 6) {
    if (capless && raw[offset + 5] !== 0) continue;
    const key = Array.from(words.subarray(offset, offset + 6)).join(',');
    let index = unique.get(key);
    if (index === undefined) {
      index = vertices.length / 6;
      unique.set(key, index);
      vertices.push(...raw.subarray(offset, offset + 6));
    }
    indices.push(index);
  }
  const IndexType = vertices.length / 6 <= 65536 ? Uint16Array : Uint32Array;
  return { vertices: Float32Array.from(vertices), indices: IndexType.from(indices) };
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
    // Real MSAA draws differ after deleting analytically covered caps, even
    // at a pixel well inside a sphere's opaque disc. The sample/depth mechanism
    // is unproven, so a larger silhouette margin does not establish coverage.
    // Retain the original caps for those contexts and all offscreen exports.
    this.singleSampleDefault = gl.getParameter(gl.FRAMEBUFFER_BINDING) === null && gl.getParameter(gl.SAMPLES) === 0
      && gl.getParameter(gl.DEPTH_BITS) >= 16;
    this.program = program(gl, VERTEX, FRAGMENT);
    this.uniforms = Object.fromEntries(['uPositions', 'uColors', 'uFractional', 'uVisibility', 'uTextureWidth', 'uView', 'uProjection',
      'uReplicaOffset', 'uReplicaIndex', 'uRepetitions', 'uSliceAxis', 'uSliceMaximum', 'uSliceMode', 'uSliceCount',
      'uSlicePlanes[0]', 'uVectorMode', 'uVectorColor', 'uScale', 'uRadius', 'uExtent',
      'uAnchor', 'uHeadLength', 'uArrowHead', 'uFlatMode', 'uFixedUp', 'uArrowUp', 'uScalarValues',
      'uAmbientOcclusion', 'uOcclusionIntensity', 'uOcclusion', 'uOcclusionWidth', 'uAtomCount', 'uReplicaCount',
      ...SCALAR_COLOR_UNIFORMS, ...CRYSTAL_DRAG_UNIFORMS].map(name => [name, gl.getUniformLocation(this.program, name)]));
    this.textures = Array.from({ length: 4 }, () => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    });
    this.textureSizes = [null, null, null, null];
    this.cylinder = this.mesh(false);
    this.caplessCylinder = this.mesh(false, false, true);
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

  mesh(cone, flat = false, capless = false) {
    const gl = this.gl, data = flat ? { vertices: createFlatArrowMesh(cone) } : createIndexedPrimitiveMesh(cone, 10, capless);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices, gl.STATIC_DRAW);
    let indexBuffer;
    if (data.indices) {
      // Element bindings belong to a VAO. Mesh creation must not overwrite
      // whichever atom or attached-geometry VAO the renderer last used.
      const vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
      gl.bindVertexArray(null);
      indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(vao);
    }
    return { buffer, count: data.indices?.length ?? data.vertices.length / 6, vertexCount: data.vertices.length / 6,
      indexBuffer, indexType: data.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  }

  instances() {
    const gl = this.gl;
    return { vao: gl.createVertexArray(), indices: gl.createBuffer(), vectors: gl.createBuffer(), shifts: gl.createBuffer(), count: 0 };
  }

  setFrame(renderer, colors) {
    const maximum = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE), count = renderer.atomCount;
    const width = Math.min(maximum, Math.max(1, Math.ceil(Math.sqrt(count)))), height = Math.max(1, Math.ceil(count / width));
    if (height > maximum) throw new Error('The structure exceeds this GPU’s atom texture capacity.');
    this.clearInstances();
    this.width = width; this.height = height;
    // Most frames never draw bonds or arrows. Retain the canonical descriptors
    // and allocate/upload their texture mirrors only when that layer draws.
    this.sourceRenderer = renderer; this.colorSource = colors;
    this.scalarColorInput = null;
    this.textureDirty = { position: true, fractional: true, visibility: true, color: true };
    this.shiftsDirty = false;
  }

  uploadTexture(index, values, internalFormat, type, format = this.gl.RGBA) {
    const gl = this.gl;
    // One-byte rows need no padding, including odd texture widths. Restore the
    // shared GL state for both initial allocation and same-size updates.
    const alignment = format === gl.RED_INTEGER ? gl.getParameter(gl.UNPACK_ALIGNMENT) : null;
    if (alignment !== null) gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    try {
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[index]);
      const size = this.textureSizes[index];
      if (size?.[0] === this.width && size?.[1] === this.height) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, format, type, values);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, this.width, this.height, 0, format, type, values);
        this.textureSizes[index] = [this.width, this.height];
      }
    } finally {
      if (alignment !== null) gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
      gl.activeTexture(gl.TEXTURE0);
    }
  }

  updatePositions(renderer, regenerateShifts = true) {
    this.sourceRenderer = renderer; this.textureDirty ??= {};
    this.textureDirty.position = true; this.textureDirty.visibility = true;
    if (regenerateShifts) {
      this.textureDirty.fractional = true;
      this.shiftsDirty = true;
    }
  }

  updateVisibility(renderer) {
    this.sourceRenderer = renderer; this.textureDirty ??= {};
    this.textureDirty.visibility = true;
    // Explicit uploads may follow in-place edits of the same selection mask.
    // Its revision matters only when selection hiding restricts arrow anchors.
    this.boundsSelectionRevision = (this.boundsSelectionRevision ?? 0) + 1;
  }

  updateColors(colors) {
    this.colorSource = colors; this.scalarColorInput = null;
    this.textureDirty ??= {};
    this.textureDirty.color = true; this.textureDirty.preview = false;
  }

  updateScalarColorPreview(input) {
    if (this.scalarColorInput === input) return;
    this.scalarColorInput = input; this.textureDirty ??= {};
    this.textureDirty.preview = true;
  }

  flushTextures(renderer = this.sourceRenderer) {
    const dirty = this.textureDirty ?? {};
    if (!renderer) return;
    const gl = this.gl, pixels = this.width * this.height, count = renderer.atomCount;
    const storage = (name, Type, length) => {
      if (this[name]?.length !== length) this[name] = new Type(length);
      return this[name];
    };
    if (dirty.position) {
      this.bondCapCoverage = null;
      const values = storage('positionValues', Float32Array, pixels * 4), positions = renderer.displayPositions;
      for (let atom = 0; atom < count; atom++) {
        const index = atom * 3, target = atom * 4;
        values[target] = positions[index]; values[target + 1] = positions[index + 1]; values[target + 2] = positions[index + 2];
      }
      this.uploadTexture(0, values, gl.RGBA32F, gl.FLOAT);
    }
    if (dirty.fractional) {
      this.bondCapCoverage = null;
      const values = storage('fractionalValues', Float32Array, pixels * 4), positions = renderer.displayFractional ?? renderer.frame.fractional;
      for (let atom = 0; atom < count; atom++) {
        const index = atom * 3, target = atom * 4;
        values[target] = positions[index]; values[target + 1] = positions[index + 1]; values[target + 2] = positions[index + 2];
      }
      this.uploadTexture(2, values, gl.RGBA32F, gl.FLOAT);
    }
    if (dirty.visibility) {
      const values = storage('visibilityValues', Int8Array, pixels);
      this.bondSphereVisibilityCompatible = true;
      // Keep arrows independent of ordinary atom/category hiding; selection
      // hiding suppresses every attached primitive with a distinct signed flag.
      for (let atom = 0; atom < count; atom++) {
        // Sphere visibility is a normalized byte tested against 0.5, whereas
        // primitive visibility uses an integer flag. Noncanonical small bytes
        // must never let a visible bond rely on a sphere that was discarded.
        const visible = renderer.visibility?.[atom] ?? 255;
        if (visible !== 0 && visible <= 127 && renderer.selectionVisibility?.[atom] !== 0) this.bondSphereVisibilityCompatible = false;
        values[atom] = renderer.selectionVisibility?.[atom] === 0 ? -1 : renderer.visibility?.[atom] === 0 ? 0 : 1;
      }
      this.uploadTexture(3, values, gl.R8I, gl.BYTE, gl.RED_INTEGER);
    }
    if (dirty.color || dirty.preview) {
      const values = storage('colorValues', Uint8Array, pixels * 4);
      if (dirty.color) {
        const colors = this.colorSource;
        for (let atom = 0; atom < count; atom++) {
          const index = atom * 3, target = atom * 4;
          values[target] = colors[index]; values[target + 1] = colors[index + 1]; values[target + 2] = colors[index + 2];
          values[target + 3] = 255;
        }
      }
      if (this.scalarColorInput) {
        for (let atom = 0; atom < count; atom++) values[atom * 4 + 3] = this.scalarColorInput.colorOverrides[atom];
      }
      this.uploadTexture(1, values, gl.RGBA8, gl.UNSIGNED_BYTE);
    }
    if (this.shiftsDirty && this.bonds) this.uploadShifts(this.bondBuffers, bondDisplayShifts(this.bonds, renderer.frame, renderer.displayPositions));
    this.shiftsDirty = false;
    this.textureDirty = {};
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
    // Default antialiased contexts never need this CPU descriptor. In
    // particular, do not retain an additional bond-sized unwrapped-shift array
    // for a guard which cannot run on that context.
    buffers.displayShifts = buffers === this.bondBuffers && this.singleSampleDefault ? shifts : null;
    if (buffers === this.bondBuffers) this.bondCapCoverage = null;
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
    if (!unchanged) this.bondCapCoverage = null;
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
    // Explicit vector setters remain data boundaries even for reused arrays.
    // A caller can edit values in place before setting that same array again.
    this.vectorBoundsCache?.clear();
    this.vectorBoundsSource = this.vectorBoundsSelections = this.vectorBoundsFrame = null;
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
    buffers.displayShifts = null;
    if (buffers === this.bondBuffers) this.bondCapCoverage = null;
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

  /** Upload per-displayed-atom occlusion values once per result, when bonds draw. */
  uploadOcclusion(factors) {
    if (this.occlusionSource === factors) return;
    const gl = this.gl, maximum = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const width = Math.min(maximum, Math.max(1, Math.ceil(Math.sqrt(factors.length))));
    const height = Math.max(1, Math.ceil(factors.length / width));
    if (height > maximum) throw new Error('Ambient occlusion exceeds this GPU’s texture capacity for bonds.');
    const values = new Float32Array(width * height); values.set(factors);
    if (!this.occlusionTexture) {
      this.occlusionTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + 4); gl.bindTexture(gl.TEXTURE_2D, this.occlusionTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.activeTexture(gl.TEXTURE0 + 4); gl.bindTexture(gl.TEXTURE_2D, this.occlusionTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, values);
    gl.activeTexture(gl.TEXTURE0);
    this.occlusionSource = factors; this.occlusionWidth = width;
  }

  clear() {
    this.clearInstances();
    this.scalarColorInput = null;
    if (this.occlusionTexture) {
      // Release the source-sized texture; the object stays reusable.
      this.gl.activeTexture(this.gl.TEXTURE0 + 4); this.gl.bindTexture(this.gl.TEXTURE_2D, this.occlusionTexture);
      this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.R32F, 1, 1, 0, this.gl.RED, this.gl.FLOAT, new Float32Array(1));
      this.gl.activeTexture(this.gl.TEXTURE0);
      this.occlusionSource = null; this.occlusionWidth = 1;
    }
    this.positionValues = this.colorValues = this.fractionalValues = this.visibilityValues = null;
    this.sourceRenderer = this.colorSource = null;
    this.textureDirty = {}; this.shiftsDirty = false;
    this.width = this.height = 1;
    this.uploadTexture(0, new Float32Array(4), this.gl.RGBA32F, this.gl.FLOAT);
    this.uploadTexture(1, new Uint8Array(4), this.gl.RGBA8, this.gl.UNSIGNED_BYTE);
    this.uploadTexture(2, new Float32Array(4), this.gl.RGBA32F, this.gl.FLOAT);
    this.uploadTexture(3, new Int8Array(1), this.gl.R8I, this.gl.BYTE, this.gl.RED_INTEGER);
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
    if (mesh.indexBuffer) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
      gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, mesh.indexType, 0, buffers.count);
    }
    else gl.drawArraysInstanced(gl.TRIANGLES, 0, mesh.count, buffers.count);
  }

  render(renderer) {
    const fields = this.vectorFields ?? (this.vectors ? [{ vectors: this.vectors, options: this.vectorOptions, buffers: this.vectorBuffers }] : []);
    if ((!this.bonds || !this.bondOptions.visible) && !fields.some(field => field.options.visible)) return;
    const gl = this.gl, u = this.uniforms;
    gl.useProgram(this.program);
    if (renderer.scalarColorPreview) this.updateScalarColorPreview(renderer.scalarColorPreview.input);
    this.flushTextures(renderer);
    gl.activeTexture(gl.TEXTURE0 + 5);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[3]);
    gl.uniform1i(u.uVisibility, 5);
    for (let index = 0; index < (renderer.scalarColorPreview ? 4 : 3); index += 1) {
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, index === 3 ? renderer.scalarColorTexture : this.textures[index]);
    }
    gl.uniform1i(u.uPositions, 0); gl.uniform1i(u.uColors, 1); gl.uniform1i(u.uFractional, 2);
    gl.uniform1i(u.uScalarValues, renderer.scalarColorPreview ? 3 : 2);
    applyScalarColorUniforms(gl, u, renderer.scalarColorPreview);
    applyCrystalDragUniforms(gl, u, renderer.crystalDrag);
    gl.uniform1i(u.uTextureWidth, this.width);
    const occlusion = this.bonds && this.bondOptions.visible && renderer.ambientOcclusionActive?.() ? renderer.ambientOcclusionFactors : null;
    gl.uniform1i(u.uAmbientOcclusion, occlusion ? 1 : 0);
    if (occlusion) {
      this.uploadOcclusion(occlusion);
      gl.activeTexture(gl.TEXTURE0 + 4); gl.bindTexture(gl.TEXTURE_2D, this.occlusionTexture); gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(u.uOcclusion, 4); gl.uniform1i(u.uOcclusionWidth, this.occlusionWidth);
      gl.uniform1i(u.uAtomCount, renderer.atomCount); gl.uniform1i(u.uReplicaCount, renderer.replicas.length);
      gl.uniform1f(u.uOcclusionIntensity, renderer.ambientOcclusionIntensity);
    } else gl.uniform1i(u.uOcclusion, 0);
    gl.uniformMatrix4fv(u.uView, false, renderer.viewMatrix);
    gl.uniformMatrix4fv(u.uProjection, false, renderer.projectionMatrix);
    gl.uniform3f(u.uRepetitions, ...renderer.repetitions);
    gl.uniform1i(u.uSliceAxis, renderer.sliceAxis);
    gl.uniform1f(u.uSliceMaximum, renderer.sliceMaximum);
    gl.uniform1i(u.uSliceMode, renderer.sliceMode === 'planes' ? 1 : 0);
    gl.uniform1i(u.uSliceCount, renderer.sliceCount ?? 0);
    gl.uniform4fv(u['uSlicePlanes[0]'], renderer.slicePlaneValues);
    const firstOptions = this.vectorOptions;
    const bondMesh = this.coveredBondMesh(renderer);
    for (const replica of renderer.replicas) {
      gl.uniform3f(u.uReplicaOffset, ...replica.offset);
      gl.uniform3f(u.uReplicaIndex, ...replica.indices);
      if (this.bonds && this.bondOptions.visible) this.drawMesh(this.bondBuffers, bondMesh, this.bondOptions.radius, 1, [0, 1], false);
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

  coveredBondMesh(renderer) {
    if (!this.bonds?.count || !this.bondOptions.visible || !this.caplessCylinder || renderer.crystalDrag
      || this.bondSphereVisibilityCompatible === false
      || !this.singleSampleDefault || renderer.renderViewport
      || !(renderer.atomRadii instanceof Float32Array) || !(renderer.visibility instanceof Uint8Array)
      || renderer.sliceMode === 'planes' && renderer.sliceCount) return this.cylinder;
    if (!this.bondCapCoverage || this.bondCapCoverage.radiusRevision !== renderer.radiusRevision
      || this.bondCapCoverage.radii !== renderer.atomRadii) {
      this.bondCapCoverage = analyzeBondCapCoverage(renderer, this.bonds, this.bondBuffers.displayShifts,
        this.positionValues, this.fractionalValues);
    }
    return bondCapsAreCovered(renderer, this.bondCapCoverage, this.bondOptions.radius) ? this.caplessCylinder : this.cylinder;
  }

  extendBounds(renderer, minimum, maximum) {
    const fields = this.vectorFields ?? (this.vectors ? [{ vectors: this.vectors, options: this.vectorOptions }] : []);
    if (!fields.length) {
      this.vectorBoundsCache?.clear();
      this.vectorBoundsSource = this.vectorBoundsSelections = this.vectorBoundsFrame = null;
      return;
    }
    // Public bounds/coordinate updates refresh this token even for in-place
    // position edits. Standalone callers without one keep uncached semantics.
    const source = renderer.sourceBoundsCache;
    const cacheable = Boolean(source && source.positions === renderer.displayPositions);
    const selections = renderer.selectionVisibility ?? null;
    const selectionRevision = selections ? this.boundsSelectionRevision ?? 0 : 0;
    this.vectorBoundsCache ??= new Map();
    if (!cacheable || this.vectorBoundsSource !== source || this.vectorBoundsSelections !== selections
      || this.vectorBoundsFrame !== renderer.frame || this.vectorBoundsSelectionRevision !== selectionRevision) this.vectorBoundsCache.clear();
    // Hidden fields must not keep an obsolete full-frame coordinate array or
    // selection mask alive after a source change.
    this.vectorBoundsSource = cacheable ? source : null;
    this.vectorBoundsSelections = cacheable ? selections : null;
    this.vectorBoundsFrame = cacheable ? renderer.frame : null;
    this.vectorBoundsSelectionRevision = selectionRevision;
    for (const { id, vectors, options } of fields) {
      if (!options.visible) continue;
      const { scale, radius, headRadius = DEFAULT_VECTOR_OPTIONS.headRadius, anchor = 'tail' } = options;
      const shift = { tail: 0, head: -1, center: -0.5 }[anchor], padding = Math.max(radius, headRadius);
      const key = id ?? vectors;
      let bounds = this.vectorBoundsCache.get(key);
      if (!cacheable || !bounds || bounds.source !== source || bounds.vectors !== vectors || bounds.frame !== renderer.frame
        || !Object.is(bounds.scale, scale) || bounds.anchor !== anchor || bounds.selections !== selections || bounds.selectionRevision !== selectionRevision) {
        bounds = { ...vectorGeometryBounds(vectors, renderer.displayPositions, selections, scale, shift),
          source, vectors, frame: renderer.frame, scale, anchor, selections, selectionRevision };
        if (cacheable) this.vectorBoundsCache.set(key, bounds);
      }
      if (!bounds.count) continue;
      // Keep the original addition/subtraction order. Replica offsets and
      // uniform padding need only six operations after the geometric extrema.
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], bounds.minimum[axis] + (renderer.minimumOffset?.[axis] ?? 0) - padding);
        maximum[axis] = Math.max(maximum[axis], bounds.maximum[axis] + (renderer.maximumOffset?.[axis] ?? 0) + padding);
      }
    }
  }
}

/** Describe the geometry that was uploaded, once per position/radius change.
 * The second cap follows the Float32 bond displacement, which need not end
 * exactly at its atom's displayed periodic image. Preserve that discrepancy. */
export function analyzeBondCapCoverage(renderer, bonds, shifts, positions, fractions) {
  if (!positions || !fractions || !shifts || !renderer.atomRadii) return null;
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  const fractionalMaximum = [-Infinity, -Infinity, -Infinity], cell = renderer.frame.cell.vectors;
  let minimumRadius = Infinity, maximumRadius = 0, endpointError = 0, coordinateMagnitude = 1;
  for (let bond = 0; bond < bonds.count; bond++) {
    const first = bonds.indices[bond * 2], second = bonds.indices[bond * 2 + 1], offset = bond * 3;
    let errorSquared = 0;
    for (let endpoint = 0; endpoint < 2; endpoint++) {
      const atom = endpoint === 0 ? first : second;
      minimumRadius = Math.min(minimumRadius, renderer.atomRadii[atom]);
      maximumRadius = Math.max(maximumRadius, renderer.atomRadii[atom]);
      for (let axis = 0; axis < 3; axis++) {
        const position = positions[atom * 4 + axis];
        minimum[axis] = Math.min(minimum[axis], position); maximum[axis] = Math.max(maximum[axis], position);
        fractionalMaximum[axis] = Math.max(fractionalMaximum[axis], fractions[atom * 4 + axis]);
        coordinateMagnitude = Math.max(coordinateMagnitude, Math.abs(position));
      }
    }
    for (let axis = 0; axis < 3; axis++) {
      const image = shifts[offset] * cell[axis] + shifts[offset + 1] * cell[axis + 3] + shifts[offset + 2] * cell[axis + 6];
      const error = positions[first * 4 + axis] + bonds.vectors[offset + axis] - positions[second * 4 + axis] - image;
      errorSquared += error * error;
      coordinateMagnitude = Math.max(coordinateMagnitude, Math.abs(image), Math.abs(bonds.vectors[offset + axis]));
    }
    endpointError = Math.max(endpointError, Math.sqrt(errorSquared));
  }
  return { minimum, maximum, fractionalMaximum, minimumRadius, maximumRadius, endpointError, coordinateMagnitude,
    radii: renderer.atomRadii, radiusRevision: renderer.radiusRevision };
}

/** Conservative whole-batch guard. A sphere is a camera-facing impostor, not a
 * triangulated sphere: radius alone cannot prove cap occlusion in perspective.
 * Bound each cap's projection inside the opaque inner 90% of that impostor,
 * and require a depth gap larger than even a 16-bit depth buffer's rounding.
 * Slicing/interactive wrapping retain caps; hidden bonds are discarded using
 * the same endpoint visibility/scalar conditions as their spheres. No bond
 * arrays are partitioned or uploaded again when orbiting or changing styles. */
export function bondCapsAreCovered(renderer, coverage, radius) {
  if (!coverage || renderer.crystalDrag || renderer.sliceMode === 'planes' && renderer.sliceCount) return false;
  if (renderer.sliceMode !== 'planes' && (!(renderer.sliceMaximum >= 1)
    || !(coverage.fractionalMaximum[renderer.sliceAxis] <= 1))) return false;
  const view = renderer.viewMatrix, projection = renderer.projectionMatrix;
  if (!view || !projection || !renderer.depthRange || !renderer.minimumOffset || !renderer.maximumOffset) return false;
  const epsilon = 2 ** -23, scale = Math.fround(renderer.radiusScale), smallest = Math.fround(coverage.minimumRadius * scale);
  const largest = Math.fround(coverage.maximumRadius * scale), minimum = [], maximum = [];
  let magnitude = coverage.coordinateMagnitude;
  for (let axis = 0; axis < 3; axis++) {
    minimum[axis] = coverage.minimum[axis] + renderer.minimumOffset[axis];
    maximum[axis] = coverage.maximum[axis] + renderer.maximumOffset[axis];
    magnitude = Math.max(magnitude, Math.abs(minimum[axis]), Math.abs(maximum[axis]), Math.abs(view[12 + axis]));
  }
  // Cover Float32 endpoint additions, rotated bases and view transforms. Very
  // large coordinates naturally reject this path instead of dropping caps.
  const roundoff = 128 * epsilon * magnitude;
  const extent = Math.fround(radius) * (1 + 128 * epsilon) + coverage.endpointError + roundoff;
  const low = [], high = [];
  for (let row = 0; row < 3; row++) {
    let lo = Math.fround(view[12 + row]), hi = lo;
    for (let axis = 0; axis < 3; axis++) {
      const coefficient = Math.fround(view[axis * 4 + row]);
      const a = minimum[axis] * coefficient, b = maximum[axis] * coefficient;
      lo += Math.min(a, b); hi += Math.max(a, b);
    }
    low[row] = lo - roundoff; high[row] = hi + roundoff;
  }
  const closest = -high[2], furthest = -low[2], near = renderer.depthRange[0], far = renderer.depthRange[1];
  if (!(smallest > 0 && extent < smallest && closest - largest > near + roundoff
    && furthest + largest < far - roundoff)) return false;
  const perspective = renderer.projectionMode === 'perspective';
  const offAxis = Math.hypot(Math.max(Math.abs(low[0]), Math.abs(high[0])), Math.max(Math.abs(low[1]), Math.abs(high[1])));
  if (perspective && !(closest > extent)) return false;
  const projected = perspective ? extent * (1 + (offAxis + extent) / (closest - extent)) : extent;
  const viewport = renderer.renderViewport, width = viewport?.tile?.renderWidth ?? viewport?.width ?? renderer.canvas?.width;
  const height = viewport?.tile?.renderHeight ?? viewport?.height ?? renderer.canvas?.height;
  // Default multisample interpolation can evaluate at the pixel center just
  // outside a covered triangle. Reserve two pixel diagonals in world units.
  const pixelPad = 4 * Math.hypot(1 / (Math.abs(projection[0]) * width), 1 / (Math.abs(projection[5]) * height))
    * (perspective ? furthest : 1);
  if (!(projected + pixelPad < smallest * .9)) return false;
  const gap = Math.sqrt(smallest * smallest - (projected + pixelPad) ** 2) - extent;
  if (!(gap > roundoff)) return false;
  const depthGap = perspective ? Math.abs(projection[14]) * gap / (2 * furthest * furthest) : Math.abs(projection[10]) * gap / 2;
  const depthRoundoff = 64 * epsilon * (1 + Math.abs(projection[10]) + Math.abs(projection[14]) / closest);
  return depthGap > 8 / 65535 + depthRoundoff;
}

function vectorGeometryBounds(vectors, positions, selections, scale, shift) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity, count = 0;
  for (let offset = 0; offset < vectors.length; offset += 3) {
    if (selections?.[offset / 3] === 0) continue;
    const x = vectors[offset], y = vectors[offset + 1], z = vectors[offset + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    count++;
    const dx = x * scale, dy = y * scale, dz = z * scale;
    const tx = positions[offset] + dx * shift, ty = positions[offset + 1] + dy * shift, tz = positions[offset + 2] + dz * shift;
    minX = Math.min(minX, Math.min(tx, tx + dx)); maxX = Math.max(maxX, Math.max(tx, tx + dx));
    minY = Math.min(minY, Math.min(ty, ty + dy)); maxY = Math.max(maxY, Math.max(ty, ty + dy));
    minZ = Math.min(minZ, Math.min(tz, tz + dz)); maxZ = Math.max(maxZ, Math.max(tz, tz + dz));
  }
  return { count, minimum: [minX, minY, minZ], maximum: [maxX, maxY, maxZ] };
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
