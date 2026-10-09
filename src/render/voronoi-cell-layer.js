import { parsePrimitiveColor } from './atom-primitives.js';
import { dislocationSlicePlanes } from './dislocation-layer.js';
import { MAX_SLICE_PLANES, SLICE_EPSILON } from './slicing.js';
import { SCALAR_COLOR_GLSL, SCALAR_COLOR_UNIFORMS, applyScalarColorUniforms, scalarPreviewAtomVisible } from './scalar-colormap.js';

/** `xray` (the default) keeps every cell translucent and fades deeper cells;
 * `surface` hides faces and edges behind the nearest cells. */
export const VORONOI_CELL_STYLES = Object.freeze(['xray', 'surface']);
export const MINIMUM_VORONOI_CELL_SCALE = 0.4;

export function normalizeVoronoiCellOptions(options = {}, previous = {}) {
  const color = options.color ?? previous.color ?? '#3b82f6';
  parsePrimitiveColor(color);
  const opacity = Number(options.opacity ?? previous.opacity ?? 0.5);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('Voronoi cell opacity must be between zero and one.');
  const style = options.style ?? previous.style ?? 'xray';
  if (!VORONOI_CELL_STYLES.includes(style)) throw new Error(`Voronoi cell style must be one of ${VORONOI_CELL_STYLES.join(', ')}.`);
  const scale = Number(options.scale ?? previous.scale ?? 1);
  if (!Number.isFinite(scale) || scale < MINIMUM_VORONOI_CELL_SCALE || scale > 1) {
    throw new Error(`Voronoi cell scale must be between ${MINIMUM_VORONOI_CELL_SCALE} and one.`);
  }
  return { enabled: Boolean(options.enabled ?? previous.enabled ?? false),
    allEnabled: Boolean(options.allEnabled ?? previous.allEnabled ?? false), color, opacity, style, scale };
}

const SELECTED_EDGE_STYLE = Object.freeze({ width: 2.8, edge: [1, 0.95, 0.75], outline: [0.32, 0.2, 0.06], core: 0.72 });

/** Unselected outlines contrast with the viewport background: dark ink derived
 * from the cell color on light backgrounds, and a pale core with a dark rim on
 * dark backgrounds. A fixed pale core washes out against white and pale faces. */
export function voronoiEdgeStyle(color, background = [0, 0, 0], width = 2.2, shortEdge = 0) {
  const [red, green, blue] = background;
  const light = 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.5;
  return light
    ? { width, shortEdge, edge: color.map(value => value * 0.3), outline: color.map(value => value * 0.18), core: 0.7 }
    : { width, shortEdge, edge: color.map(value => value + (1 - value) * 0.82), outline: color.map(value => value * 0.25), core: 0.68 };
}

// Marks a face or edge slot that no other displayed cell shares.
export const NO_NEIGHBOR = 0xffffffff;

/** Local Cartesian vertices remain independent of
 * display wrapping, periodic origin, replication and scientific atom arrays.
 *
 * With `shared`, a face shared with another analyzed cell is kept only by the
 * lower-index cell, and an edge only by the lowest-index cell around it. Each
 * kept face records that neighbor; each kept edge records up to two other
 * cells and their image offsets, so the renderer can still draw a copy for a
 * cell displayed in another periodic image, hidden owner or shrunken view. */
export function createVoronoiCellMesh(cell, { shared = false } = {}) {
  if (!Number.isInteger(cell?.atomIndex) || cell.atomIndex < 0) throw new Error('A Voronoi cell needs a valid atom index.');
  const { vertices, faceOffsets, faceVertices } = cell, atom = cell.atomIndex;
  if (!vertices || vertices.length % 3 || !Array.from(vertices).every(Number.isFinite)
    || !faceOffsets || faceOffsets.length < 2 || faceOffsets[0] !== 0
    || faceOffsets.at(-1) !== faceVertices?.length) throw new Error('Invalid Voronoi cell geometry.');
  // The atom may lie on a nonperiodic boundary. Use a point inside the
  // convex polyhedron to orient faces, rather than the local atom origin.
  const interior = [0, 0, 0];
  for (let index = 0; index < vertices.length; index++) interior[index % 3] += vertices[index] / (vertices.length / 3);
  const faceCount = faceOffsets.length - 1, neighbors = new Int32Array(faceCount).fill(-1), offsets = new Array(faceCount);
  const values = [], vertexNeighbors = [], indices = [], faces = [], edges = new Map();
  for (let face = 0; face < faceCount; face++) {
    const start = faceOffsets[face], end = faceOffsets[face + 1];
    if (end - start < 3 || end < start) throw new Error('Voronoi cell faces require at least three corners.');
    const corners = Array.from(faceVertices.subarray(start, end));
    if (corners.some(index => !Number.isInteger(index) || index < 0 || index * 3 >= vertices.length)) throw new Error('Invalid Voronoi face vertex.');
    const points = corners.map(index => Array.from(vertices.subarray(index * 3, index * 3 + 3)));
    // Newell's normal stays well defined for tiny or nearly collinear faces,
    // whose bisector offset below would otherwise be imprecise.
    let normal = [0, 0, 0];
    points.forEach((point, corner) => {
      const next = points[(corner + 1) % points.length];
      normal[0] += (point[1] - next[1]) * (point[2] + next[2]);
      normal[1] += (point[2] - next[2]) * (point[0] + next[0]);
      normal[2] += (point[0] - next[0]) * (point[1] + next[1]);
    });
    const length = Math.hypot(...normal);
    if (!(length > 0)) throw new Error('A Voronoi cell face is degenerate.');
    normal = normal.map(value => value / length);
    const inward = normal.reduce((sum, value, axis) => sum + value * (points[0][axis] - interior[axis]), 0) < 0;
    if (inward) normal = normal.map(value => -value);
    for (let corner = 0; corner < corners.length; corner++) {
      const a = corners[corner], b = corners[(corner + 1) % corners.length], key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const entry = edges.get(key) ?? { a, b, faces: [] };
      entry.faces.push(face); edges.set(key, entry);
    }
    const neighbor = shared ? cell.faceNeighbors?.[face] ?? -1 : -1;
    if (neighbor >= 0 && neighbor !== atom) {
      // The neighbor's image lies across the bisector plane, at twice the
      // plane's distance from this atom along the outward normal. Radical
      // faces are not midway; their cells carry the actual image vectors.
      const distance = normal.reduce((sum, value, axis) => sum + value * points[0][axis], 0);
      const vector = cell.neighborVectors?.subarray(face * 3, face * 3 + 3);
      neighbors[face] = neighbor;
      offsets[face] = vector?.every(Number.isFinite) ? Array.from(vector) : normal.map(value => 2 * distance * value);
      if (neighbor < atom) continue;
    }
    const first = values.length / 6, firstIndex = indices.length;
    for (const point of points) { values.push(...point, ...normal); vertexNeighbors.push(neighbors[face] < 0 ? NO_NEIGHBOR : neighbors[face]); }
    for (let corner = 1; corner + 1 < points.length; corner++) {
      if (inward) indices.push(first, first + corner + 1, first + corner);
      else indices.push(first, first + corner, first + corner + 1);
    }
    faces.push({ firstIndex, indexCount: indices.length - firstIndex, neighbor: neighbors[face] < 0 ? NO_NEIGHBOR : neighbors[face] });
  }
  const faceVertexCount = values.length / 6, edgeIds = [], edgeRecords = [];
  for (const { a, b, faces: adjacent } of edges.values()) {
    // Faces toward a boundary or this cell's own periodic image add no other
    // displayed cell. Rare edges shared by more than three cells may be drawn
    // by two owners; none is ever omitted.
    const others = adjacent.filter(face => neighbors[face] >= 0);
    if (others.some(face => neighbors[face] < atom)) continue;
    const [first, second] = others;
    values.push(...vertices.subarray(a * 3, a * 3 + 3), ...(first === undefined ? [0, 0, 0] : offsets[first]),
      ...vertices.subarray(b * 3, b * 3 + 3), ...(second === undefined ? [0, 0, 0] : offsets[second]));
    const record = { a: first === undefined ? NO_NEIGHBOR : neighbors[first], b: second === undefined ? NO_NEIGHBOR : neighbors[second] };
    edgeIds.push(atom, record.a, record.b, 0); edgeRecords.push(record);
  }
  return { values: Float32Array.from(values), vertexNeighbors: Uint32Array.from(vertexNeighbors), edgeIds: Uint32Array.from(edgeIds),
    indices: Uint32Array.from(indices), faces, edges: edgeRecords,
    vertexCount: faceVertexCount, indexCount: indices.length, edgeCount: edgeRecords.length * 2 };
}

/** Pack a bounded group of cells into one face/outline draw buffer, storing
 * each shared face and edge once. Atom IDs stay integer attributes so display
 * transforms and masks need no mesh rebuild. `cellIds` holds two integers per
 * vertex slot: (owner, neighbor) for faces and (owner, other, other, 0) across
 * an edge's two slots. */
export function createVoronoiCellBatch(cells) {
  const meshes = cells.map(cell => createVoronoiCellMesh(cell, { shared: true }));
  const vertexCount = meshes.reduce((sum, mesh) => sum + mesh.vertexCount, 0);
  const edgeCount = meshes.reduce((sum, mesh) => sum + mesh.edgeCount, 0);
  const indexCount = meshes.reduce((sum, mesh) => sum + mesh.indexCount, 0);
  const values = new Float32Array((vertexCount + edgeCount) * 6), cellIds = new Uint32Array((vertexCount + edgeCount) * 2);
  const indices = new Uint32Array(indexCount);
  const bounds = new Float64Array(cells.length * 7), cellRanges = new Uint32Array(cells.length * 5);
  const foreignFaces = [], foreignEdges = [];
  let vertex = 0, edge = vertexCount, index = 0;
  cells.forEach((cell, cellIndex) => {
    const mesh = meshes[cellIndex];
    // A cell's owned faces and edges are contiguous; the faces and edges its
    // neighbors own on its behalf are listed separately. Together they let a
    // selection emphasize the whole polyhedron without extracting geometry.
    cellRanges.set([cell.atomIndex, index, mesh.indexCount, edge, mesh.edgeCount], cellIndex * 5);
    values.set(mesh.values.subarray(0, mesh.vertexCount * 6), vertex * 6);
    values.set(mesh.values.subarray(mesh.vertexCount * 6), edge * 6);
    for (let offset = 0; offset < mesh.vertexCount; offset++) {
      cellIds[(vertex + offset) * 2] = cell.atomIndex; cellIds[(vertex + offset) * 2 + 1] = mesh.vertexNeighbors[offset];
    }
    cellIds.set(mesh.edgeIds, edge * 2);
    for (const face of mesh.faces) if (face.neighbor !== NO_NEIGHBOR) foreignFaces.push(face.neighbor, index + face.firstIndex, face.indexCount);
    mesh.edges.forEach(({ a, b }, offset) => {
      if (a !== NO_NEIGHBOR) foreignEdges.push(a, edge + offset * 2, 1);
      if (b !== NO_NEIGHBOR) foreignEdges.push(b, edge + offset * 2, 2);
    });
    for (const value of mesh.indices) indices[index++] = value + vertex;
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
    for (let point = 0; point < cell.vertices.length; point += 3) for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], cell.vertices[point + axis]);
      maximum[axis] = Math.max(maximum[axis], cell.vertices[point + axis]);
    }
    bounds.set([cell.atomIndex, ...minimum, ...maximum], cellIndex * 7);
    vertex += mesh.vertexCount; edge += mesh.edgeCount;
  });
  return { values, cellIds, indices, bounds, cellRanges, foreignFaces: Uint32Array.from(foreignFaces),
    foreignEdges: Uint32Array.from(foreignEdges), vertexCount, indexCount, edgeCount, cellCount: cells.length };
}

// Display positions differ by at least a cell vector across a periodic
// boundary, so this tolerance only absorbs float32 rounding.
const SAME_IMAGE_TOLERANCE = 0.02;

// Whether `other` minus its image offset (`scale` times the vector at
// `values[start]`) is displayed at `atom`'s position.
function sameImage(positions, atom, other, values, start, scale = 1) {
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(positions[other * 3 + axis] - scale * values[start + axis] - positions[atom * 3 + axis]) >= SAME_IMAGE_TOLERANCE) return false;
  }
  return true;
}

/** The shared faces and edges whose other cell is displayed in a different
 * periodic image than their owner, for the given display positions. Only these
 * need a second copy at true cell size; every other stored copy serves all of
 * its cells. Copies are compact standalone records, so all chunks' copies can
 * share one small buffer and a few draws: face triangle corners as
 * (position, normal) with (owner, neighbor) IDs, and edges drawn from their
 * first other cell followed by those drawn from their second. */
export function periodicCopies(mesh, positions) {
  const { values, cellIds, indices, foreignFaces, foreignEdges } = mesh, corners = [], edges = [[], []];
  for (let entry = 0; entry < foreignFaces.length; entry += 3) {
    const neighbor = foreignFaces[entry], first = foreignFaces[entry + 1], count = foreignFaces[entry + 2];
    const vertex = indices[first], base = vertex * 6;
    // The offset is twice the face's bisector distance along its normal.
    const distance = 2 * (values[base] * values[base + 3] + values[base + 1] * values[base + 4] + values[base + 2] * values[base + 5]);
    if (!sameImage(positions, cellIds[vertex * 2], neighbor, values, base + 3, distance)) {
      for (let index = first; index < first + count; index++) corners.push(indices[index]);
    }
  }
  for (let entry = 0; entry < foreignEdges.length; entry += 3) {
    const other = foreignEdges[entry], slot = foreignEdges[entry + 1], which = foreignEdges[entry + 2];
    if (!sameImage(positions, cellIds[slot * 2], other, values, slot * 6 + (which === 1 ? 3 : 9))) edges[which - 1].push(slot);
  }
  const faceValues = new Float32Array(corners.length * 6), faceIds = new Uint32Array(corners.length * 2);
  corners.forEach((vertex, index) => {
    faceValues.set(values.subarray(vertex * 6, vertex * 6 + 6), index * 6);
    faceIds.set(cellIds.subarray(vertex * 2, vertex * 2 + 2), index * 2);
  });
  const slots = [...edges[0], ...edges[1]];
  const edgeValues = new Float32Array(slots.length * 12), edgeIds = new Uint32Array(slots.length * 4);
  slots.forEach((slot, index) => {
    edgeValues.set(values.subarray(slot * 6, slot * 6 + 12), index * 12);
    edgeIds.set(cellIds.subarray(slot * 2, slot * 2 + 4), index * 4);
  });
  return { faceValues, faceIds, cornerCount: corners.length, edgeValues, edgeIds,
    firstEdgeCount: edges[0].length, secondEdgeCount: edges[1].length };
}

const SAME_IMAGE = SAME_IMAGE_TOLERANCE.toFixed(2);
// Shared GLSL: atom texture lookup and same-location test.
const ATOM_LOOKUP = `
${SCALAR_COLOR_GLSL}
uniform sampler2D uScalarValues;
uniform int uScalarTextureWidth;
const uint NO_NEIGHBOR = 0xffffffffu;
vec4 atomAt(uint index) {
  int atom = int(index);
  vec4 value = texelFetch(uAtoms, ivec2(atom % uAtomTextureWidth, atom / uAtomTextureWidth), 0);
  if (uScalarColorEnabled && !scalarShown(texelFetch(uScalarValues, ivec2(atom % uScalarTextureWidth, atom / uScalarTextureWidth), 0).r)) value.w = 0.0;
  return value;
}
bool sameImage(vec3 a, vec3 b) { return all(lessThan(abs(a - b), vec3(${SAME_IMAGE}))); }`;

const VERTEX = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in uint aAtomIndex;
layout(location=3) in uint aNeighbor;
uniform mat4 uView;
uniform mat4 uProjection;
uniform vec3 uCenter;
uniform bool uBatched;
uniform sampler2D uAtoms;
uniform int uAtomTextureWidth;
uniform float uScale;
uniform vec2 uDepthRange;
// 0: the owner's copy; 1: the neighbor's copy, submitted only where the two
// cells are displayed apart; 2/3: the same copies, forced for selected cells;
// −1: both copies as instances 0 and 1, at a reduced Cell scale.
uniform int uAnchor;
// 0: every face; 1/2: only faces facing away from/toward the camera.
uniform int uFacing;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vView;
out float vDepth;
flat out float vVisible;
${ATOM_LOOKUP}
void main() {
  vec3 origin = vec3(0.0), local = aPosition, normal = aNormal;
  bool visible = true;
  if (uBatched) {
    bool shared = aNeighbor != NO_NEIGHBOR, trueSize = uScale > 0.9999;
    int anchor = uAnchor < 0 ? gl_InstanceID : uAnchor;
    // The neighbor's image lies across the bisector plane of this face.
    vec3 offset = 2.0 * dot(aPosition, aNormal) * aNormal;
    if (anchor == 1 || anchor == 3) {
      vec4 neighbor = shared ? atomAt(aNeighbor) : vec4(0.0);
      normal = -aNormal; origin = neighbor.xyz; local = aPosition - offset;
      visible = shared && neighbor.w > 0.5;
      // A selected neighbor redraws a merged face with the owner's arithmetic,
      // reproducing the resolved surface depth exactly.
      if (anchor == 3 && shared && trueSize) {
        vec4 owner = atomAt(aAtomIndex);
        if (sameImage(neighbor.xyz - offset, owner.xyz)) { origin = owner.xyz; local = aPosition; }
      }
    } else {
      vec4 owner = atomAt(aAtomIndex);
      origin = owner.xyz; visible = owner.w > 0.5;
      // A hidden owner's copy still bounds a visible neighbor displayed beside it.
      if (!visible && anchor == 0 && shared && trueSize) {
        vec4 neighbor = atomAt(aNeighbor);
        visible = neighbor.w > 0.5 && sameImage(neighbor.xyz - offset, owner.xyz);
      }
    }
  }
  vWorld = uCenter + origin + local * uScale;
  vNormal = mat3(uView) * normal;
  vec4 view = uView * vec4(vWorld, 1.0);
  vView = view.xyz;
  if (uFacing != 0) {
    bool front = uProjection[3][3] > 0.5 ? vNormal.z > 0.0 : dot(vNormal, -view.xyz) > 0.0;
    visible = visible && (uFacing == 2) == front;
  }
  vVisible = visible ? 1.0 : 0.0;
  vDepth = clamp((-view.z - uDepthRange.x) / max(uDepthRange.y - uDepthRange.x, 1e-6), 0.0, 1.0);
  // Collapse undrawn copies before rasterization instead of discarding pixels.
  gl_Position = visible ? uProjection * view : vec4(2.0, 2.0, 2.0, 1.0);
}`;
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec3 vWorld;
in vec3 vNormal;
in vec3 vView;
in float vDepth;
flat in float vVisible;
uniform vec3 uColor;
uniform mat4 uProjection;
uniform float uOpacity;
uniform float uDepthFade;
uniform bool uDepthOnly;
uniform bool uTwoSided;
uniform int uSliceCount;
uniform vec4 uSlicePlanes[${MAX_SLICE_PLANES}];
out vec4 outColor;
// Flat, outward face normals retain the physical facets. Distinct key and
// fill lights make opposite faces read differently, including the rear
// surfaces of translucent cells. Use the same view-space studio as atoms.
vec3 shade(vec3 normal, vec3 viewDirection) {
  vec3 key = normalize(vec3(-0.48, 0.62, 0.72));
  vec3 fill = normalize(vec3(0.68, -0.36, 0.48));
  float ambient = mix(0.18, 0.29, normal.y * 0.5 + 0.5);
  float light = ambient + 0.72 * max(0.0, dot(normal, key))
    + 0.18 * max(0.0, dot(normal, fill));
  vec3 halfDirection = normalize(key + viewDirection);
  float specular = pow(max(0.0, dot(normal, halfDirection)), 28.0) * 0.16;
  return pow(uColor, vec3(2.2)) * light + vec3(1.0, 0.96, 0.88) * specular;
}
void main() {
  if (vVisible < 0.5) discard;
  for (int plane = 0; plane < ${MAX_SLICE_PLANES}; plane++) {
    if (plane >= uSliceCount) break;
    if (dot(uSlicePlanes[plane].xyz, vWorld) > uSlicePlanes[plane].w + ${SLICE_EPSILON}) discard;
  }
  // The nearest-surface pass needs only depth; its blend leaves color intact.
  if (uDepthOnly) { outColor = vec4(0.0); return; }
  vec3 normal = normalize(vNormal);
  vec3 viewDirection = uProjection[3][3] > 0.5 ? vec3(0.0, 0.0, 1.0) : normalize(-vView);
  // One stored copy of a shared face is the rear of one cell and the front of
  // its neighbor; light it as the surface facing the camera.
  if (uTwoSided && dot(normal, viewDirection) < 0.0) normal = -normal;
  outColor = vec4(pow(clamp(shade(normal, viewDirection), 0.0, 1.0), vec3(1.0 / 2.2)), uOpacity * (1.0 - uDepthFade * vDepth));
}`;

const SELECTED_FACE_COLOR = [1, 0.68, 0.16];

const OUTLINE_VERTEX = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec3 aStart;
layout(location=1) in vec3 aEnd;
layout(location=2) in uint aAtomIndex;
// Up to two other cells sharing this edge, and their image offsets.
layout(location=3) in uvec2 aNeighbors;
layout(location=4) in vec3 aOffsetA;
layout(location=5) in vec3 aOffsetB;
uniform mat4 uView;
uniform mat4 uProjection;
uniform vec3 uCenter;
uniform bool uBatched;
uniform sampler2D uAtoms;
uniform int uAtomTextureWidth;
uniform vec2 uViewport;
uniform float uEdgeWidth;
uniform float uScale;
uniform vec2 uDepthRange;
uniform float uShortEdge;
// 0: the owner's copy; 1/2: the first/second other cell's copy, submitted
// only where it is displayed apart; 3-5: the same copies, forced; −1: all
// three as consecutive ribbons of each edge instance, at a reduced Cell scale.
uniform int uAnchor;
out vec3 vWorld;
out float vSide;
out float vDepth;
out float vLengthFade;
flat out float vVisible;
${ATOM_LOOKUP}
void main() {
  vec3 origin = vec3(0.0), shift = vec3(0.0);
  vVisible = 1.0;
  if (uBatched) {
    bool hasA = aNeighbors.x != NO_NEIGHBOR, hasB = aNeighbors.y != NO_NEIGHBOR, trueSize = uScale > 0.9999;
    int mode = uAnchor < 0 ? gl_VertexID / 6 : uAnchor, anchor = mode % 3;
    bool visible;
    if (anchor == 0) {
      vec4 owner = atomAt(aAtomIndex);
      origin = owner.xyz; visible = owner.w > 0.5;
      // A hidden owner's copy still serves other cells displayed beside it.
      if (!visible && mode == 0 && trueSize) {
        if (hasA) { vec4 a = atomAt(aNeighbors.x); visible = a.w > 0.5 && sameImage(a.xyz - aOffsetA, owner.xyz); }
        if (!visible && hasB) { vec4 b = atomAt(aNeighbors.y); visible = b.w > 0.5 && sameImage(b.xyz - aOffsetB, owner.xyz); }
      }
    } else if (anchor == 1) {
      vec4 a = hasA ? atomAt(aNeighbors.x) : vec4(0.0);
      origin = a.xyz; shift = aOffsetA; visible = hasA && a.w > 0.5;
    } else {
      vec4 b = hasB ? atomAt(aNeighbors.y) : vec4(0.0);
      origin = b.xyz; shift = aOffsetB; visible = hasB && b.w > 0.5;
      // Both other cells may share one image apart from the owner; the first
      // cell's copy already draws it there.
      if (visible && mode == 2 && hasA && trueSize) {
        vec4 a = atomAt(aNeighbors.x);
        visible = !(a.w > 0.5 && sameImage(a.xyz - aOffsetA, b.xyz - aOffsetB));
      }
    }
    vVisible = visible ? 1.0 : 0.0;
  }
  vDepth = 0.0; vLengthFade = 1.0;
  if (vVisible < 0.5) { vWorld = origin; vSide = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 start = uCenter + origin + (aStart - shift) * uScale;
  vec3 end = uCenter + origin + (aEnd - shift) * uScale;
  // Transform each endpoint once; uProjection * uView * p would multiply
  // two matrices in every one of the six ribbon vertices.
  vec4 viewStart = uView * vec4(start, 1.0), viewEnd = uView * vec4(end, 1.0);
  vec4 first = uProjection * viewStart, last = uProjection * viewEnd;
  // Clip the segment before perspective expansion. A line crossing the near
  // plane otherwise expands from a negative W and can cover the whole image.
  float nearFirst = first.z + first.w, nearLast = last.z + last.w;
  if (nearFirst < 0.0 && nearLast < 0.0) {
    vWorld = start; vSide = 0.0; vVisible = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;
  }
  if (nearFirst < 0.0) {
    float fraction = nearFirst / (nearFirst - nearLast);
    first = mix(first, last, fraction); start = mix(start, end, fraction); viewStart = mix(viewStart, viewEnd, fraction);
  } else if (nearLast < 0.0) {
    float fraction = nearLast / (nearLast - nearFirst);
    last = mix(last, first, fraction); end = mix(end, start, fraction); viewEnd = mix(viewEnd, viewStart, fraction);
  }
  vec2 difference = (last.xy / last.w - first.xy / first.w) * uViewport;
  float projectedLength = length(difference);
  if (projectedLength < 1e-6) {
    vWorld = start; vSide = 0.0; vVisible = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;
  }
  int corner = int[6](0, 1, 2, 2, 1, 3)[gl_VertexID % 6];
  bool atEnd = corner >= 2;
  float side = (corner == 0 || corner == 2) ? -1.0 : 1.0;
  // Edges only a few pixels long, from distant cells or microscopic faces,
  // fade out instead of merging into a solid mesh; zooming in restores them.
  if (uShortEdge > 0.0) vLengthFade = smoothstep(0.35 * uShortEdge, uShortEdge, 0.5 * projectedLength);
  // A fully faded ribbon would still rasterize and blend; skip its fragments.
  if (vLengthFade <= 0.0) {
    vWorld = start; vSide = 0.0; vVisible = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;
  }
  vec2 direction = difference / projectedLength;
  vec2 perpendicular = vec2(-direction.y, direction.x);
  vec4 clip = atEnd ? last : first;
  // Square caps meet cleanly at polygon corners. Width is in device pixels,
  // independently of camera distance, projection and portable GL line limits.
  vec2 pixelOffset = (perpendicular * side + direction * (atEnd ? 1.0 : -1.0)) * uEdgeWidth * 0.5;
  clip.xy += pixelOffset * 2.0 / uViewport * clip.w;
  clip.z -= 1e-6 * clip.w;
  gl_Position = clip; vWorld = atEnd ? end : start; vSide = side;
  float depth = -(atEnd ? viewEnd.z : viewStart.z);
  vDepth = clamp((depth - uDepthRange.x) / max(uDepthRange.y - uDepthRange.x, 1e-6), 0.0, 1.0);
}`;
const OUTLINE_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec3 vWorld;
in float vSide;
in float vDepth;
in float vLengthFade;
flat in float vVisible;
uniform vec3 uEdgeColor;
uniform vec3 uOutlineColor;
uniform float uCoreRatio;
uniform float uAlpha;
uniform float uDepthFade;
uniform int uSliceCount;
uniform vec4 uSlicePlanes[${MAX_SLICE_PLANES}];
out vec4 outColor;
void main() {
  if (vVisible < 0.5) discard;
  for (int plane = 0; plane < ${MAX_SLICE_PLANES}; plane++) {
    if (plane >= uSliceCount) break;
    if (dot(uSlicePlanes[plane].xyz, vWorld) > uSlicePlanes[plane].w + ${SLICE_EPSILON}) discard;
  }
  float side = abs(vSide);
  vec3 color = mix(uEdgeColor, uOutlineColor, smoothstep(uCoreRatio - 0.08, uCoreRatio + 0.08, side));
  float coverage = 1.0 - smoothstep(1.0 - fwidth(vSide) * 0.5, 1.0, side);
  outColor = vec4(color, coverage * vLengthFade * uAlpha * (1.0 - uDepthFade * vDepth));
}`;

// Vertex attribute and byte offset within an edge's two vertex slots.
const EDGE_ATTRIBUTES = [[0, 0], [4, 12], [1, 24], [5, 36]];

/** Reuse the existing edge endpoints as instanced ribbons, without allocating
 * additional geometry buffers or rebuilding cells for camera/selection edits. */
class VoronoiOutlineRenderer {
  constructor(gl) {
    this.gl = gl; this.program = createProgram(gl, OUTLINE_VERTEX, OUTLINE_FRAGMENT, 'Voronoi outline');
    this.uniforms = Object.fromEntries(['uView', 'uProjection', 'uCenter', 'uBatched', 'uAtoms', 'uAtomTextureWidth',
      'uViewport', 'uEdgeWidth', 'uEdgeColor', 'uOutlineColor', 'uCoreRatio', 'uAlpha', 'uScale', 'uDepthRange', 'uDepthFade', 'uShortEdge',
      'uAnchor', 'uSliceCount', 'uSlicePlanes[0]', 'uScalarValues', 'uScalarTextureWidth', ...SCALAR_COLOR_UNIFORMS]
      .map(name => [name, gl.getUniformLocation(this.program, name)]));
  }
  // Each edge spans two 24-byte vertex slots: start, offset A, end, offset B.
  // Its IDs span two integer pairs: owner, other A, other B, unused.
  createVao(withIds = false) {
    const gl = this.gl, vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    for (const [attribute] of EDGE_ATTRIBUTES) { gl.enableVertexAttribArray(attribute); gl.vertexAttribDivisor(attribute, 1); }
    if (withIds) for (const attribute of [2, 3]) { gl.enableVertexAttribArray(attribute); gl.vertexAttribDivisor(attribute, 1); }
    gl.bindVertexArray(null);
    return vao;
  }
  begin(renderer, planes, { batched = false, textureWidth = 1, scale = 1, depthFade = 0 } = {}) {
    const gl = this.gl, u = this.uniforms;
    gl.useProgram(this.program); gl.uniform1i(u.uBatched, Number(batched)); gl.uniform1i(u.uAtoms, batched ? 5 : 0);
    applyVoronoiScalarPreview(gl, u, renderer);
    gl.uniform1i(u.uAtomTextureWidth, textureWidth);
    gl.uniformMatrix4fv(u.uView, false, renderer.viewMatrix); gl.uniformMatrix4fv(u.uProjection, false, renderer.projectionMatrix);
    const width = Math.max(1, renderer.renderViewport?.tile.renderWidth ?? renderer.canvas?.width ?? 1);
    const height = Math.max(1, renderer.renderViewport?.tile.renderHeight ?? renderer.canvas?.height ?? 1);
    this.pixelRatio = renderer.renderViewport?.annotationScale ?? Math.max(1, width / Math.max(1, renderer.canvas?.clientWidth ?? width));
    gl.uniform2f(u.uViewport, width, height); gl.uniform1i(u.uSliceCount, planes.count); gl.uniform4fv(u['uSlicePlanes[0]'], planes.values);
    gl.uniform1f(u.uScale, scale); gl.uniform2f(u.uDepthRange, ...(renderer.depthRange ?? [0, 1])); gl.uniform1f(u.uDepthFade, depthFade);
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.disable(gl.CULL_FACE);
  }
  setDepthFade(value) { this.gl.uniform1f(this.uniforms.uDepthFade, value); }
  setAnchor(anchor) { this.gl.uniform1i(this.uniforms.uAnchor, anchor); }
  // WebGL2 has no base instance, so each draw points the attributes at its
  // first edge slot.
  // `ribbons` draws that many 6-vertex ribbons per edge instance.
  draw({ edgeVao, buffer, idBuffer }, firstEdge, edgeCount, center, style = SELECTED_EDGE_STYLE, alpha = 1, ribbons = 1) {
    if (!edgeCount) return;
    const gl = this.gl, u = this.uniforms; gl.bindVertexArray(edgeVao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (const [attribute, offset] of EDGE_ATTRIBUTES) gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 48, firstEdge * 24 + offset);
    if (idBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer);
      gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 16, firstEdge * 8); gl.vertexAttribIPointer(3, 2, gl.UNSIGNED_INT, 16, firstEdge * 8 + 4);
    } else { gl.vertexAttribI4ui(2, 0, 0, 0, 0); gl.vertexAttribI4ui(3, NO_NEIGHBOR, NO_NEIGHBOR, 0, 0); }
    gl.uniform3f(u.uCenter, ...center); gl.uniform1f(u.uEdgeWidth, style.width * this.pixelRatio);
    gl.uniform3f(u.uEdgeColor, ...style.edge); gl.uniform3f(u.uOutlineColor, ...style.outline);
    gl.uniform1f(u.uCoreRatio, style.core); gl.uniform1f(u.uAlpha, alpha);
    gl.uniform1f(u.uShortEdge, (style.shortEdge ?? 0) * this.pixelRatio);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6 * ribbons, edgeCount / 2);
  }
}

function selectedCellAtoms(renderer) {
  const atoms = new Set([renderer.selected, ...(renderer.getSelectionHighlightAtoms?.() ?? renderer.selectedAtoms ?? []),
    ...(renderer.sliceSelectedAtoms ?? [])]);
  for (const atom of atoms) if (!Number.isInteger(atom) || atom < 0 || atom >= renderer.atomCount
    || !renderer.visibility?.[atom] || !scalarPreviewAtomVisible(renderer.scalarColorPreview, atom)) atoms.delete(atom);
  return atoms;
}

const FACE_UNIFORMS = ['uView', 'uProjection', 'uCenter', 'uColor', 'uOpacity', 'uSliceCount', 'uSlicePlanes[0]',
  'uBatched', 'uAtoms', 'uAtomTextureWidth', 'uScale', 'uDepthRange', 'uDepthFade', 'uDepthOnly', 'uAnchor', 'uFacing', 'uTwoSided'];

export class VoronoiCellLayer {
  constructor(gl) {
    this.gl = gl;
    this.program = createProgram(gl);
    this.uniforms = Object.fromEntries([...FACE_UNIFORMS, 'uScalarValues', 'uScalarTextureWidth', ...SCALAR_COLOR_UNIFORMS].map(name => [name, gl.getUniformLocation(this.program, name)]));
    this.vao = gl.createVertexArray(); this.buffer = gl.createBuffer(); this.indexBuffer = gl.createBuffer();
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (let attribute = 0; attribute < 2; attribute++) {
      gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 24, attribute * 12);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer); gl.bindVertexArray(null);
    this.outline = new VoronoiOutlineRenderer(gl); this.edgeVao = this.outline.createVao();
    this.geometry = null; this.options = normalizeVoronoiCellOptions();
    this.vertexCount = this.indexCount = this.edgeCount = this.renderedReplicaCount = 0;
    this.highlightedCellCount = 0;
  }

  setGeometry(geometry, options = {}) {
    this.options = normalizeVoronoiCellOptions(options, this.options);
    if (geometry === this.geometry) return;
    const mesh = geometry ? createVoronoiCellMesh(geometry) : null;
    this.geometry = geometry;
    this.vertexCount = mesh?.vertexCount ?? 0; this.indexCount = mesh?.indexCount ?? 0; this.edgeCount = mesh?.edgeCount ?? 0;
    this.renderedReplicaCount = 0;
    this.highlightedCellCount = 0;
    const gl = this.gl; gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.bufferData(gl.ARRAY_BUFFER, mesh?.values ?? 0, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh?.indices ?? 0, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  clear() { this.setGeometry(null); }

  extendBounds(renderer, minimum, maximum) {
    const atom = this.geometry?.atomIndex;
    if (!this.options.enabled || !this.geometry || atom >= renderer.atomCount) return;
    const vertices = this.geometry.vertices;
    for (let index = 0; index < vertices.length; index += 3) for (let axis = 0; axis < 3; axis++) {
      const value = vertices[index + axis] + renderer.displayPositions[atom * 3 + axis];
      minimum[axis] = Math.min(minimum[axis], value + (renderer.minimumOffset?.[axis] ?? 0));
      maximum[axis] = Math.max(maximum[axis], value + (renderer.maximumOffset?.[axis] ?? 0));
    }
  }

  render(renderer) {
    this.renderedReplicaCount = this.highlightedCellCount = 0;
    const atom = this.geometry?.atomIndex;
    if (!this.options.enabled || !this.indexCount || !renderer.frame || atom >= renderer.atomCount || !renderer.visibility?.[atom]
      || !scalarPreviewAtomVisible(renderer.scalarColorPreview, atom)) return;
    const gl = this.gl, u = this.uniforms, planes = dislocationSlicePlanes(renderer);
    gl.useProgram(this.program); gl.bindVertexArray(this.vao);
    gl.uniform1i(u.uBatched, 0);
    applyVoronoiScalarPreview(gl, u, renderer);
    gl.vertexAttribI4ui(2, 0, 0, 0, 0); gl.vertexAttribI4ui(3, NO_NEIGHBOR, 0, 0, 0);
    // The inspected cell keeps every face; its rear surfaces keep their own shading.
    gl.uniform1i(u.uAnchor, 2); gl.uniform1i(u.uFacing, 0); gl.uniform1i(u.uTwoSided, 0);
    gl.uniformMatrix4fv(u.uView, false, renderer.viewMatrix); gl.uniformMatrix4fv(u.uProjection, false, renderer.projectionMatrix);
    const selected = selectedCellAtoms(renderer).has(atom);
    this.highlightedCellCount = Number(selected);
    const baseColor = parsePrimitiveColor(this.options.color), color = selected ? SELECTED_FACE_COLOR : baseColor;
    gl.uniform1i(u.uSliceCount, planes.count); gl.uniform4fv(u['uSlicePlanes[0]'], planes.values);
    // A single convex cell has no deeper cells to fade or hide.
    gl.uniform1f(u.uScale, this.options.scale); gl.uniform2f(u.uDepthRange, ...(renderer.depthRange ?? [0, 1]));
    gl.uniform1f(u.uDepthFade, 0); gl.uniform1i(u.uDepthOnly, 0);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.CULL_FACE); gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -1);
    for (const replica of renderer.replicas) {
      gl.uniform3f(u.uCenter, ...replica.offset.map((value, axis) => value + renderer.displayPositions[atom * 3 + axis]));
      gl.uniform3f(u.uColor, ...color);
      gl.uniform1f(u.uOpacity, selected ? Math.max(0.62, this.options.opacity) : this.options.opacity);
      // A convex cell has one rear and one front surface along each ray.
      // Draw those in order so translucent shading is independent of the
      // scientific face traversal order, without sorting/rebuilding the mesh.
      gl.cullFace(gl.FRONT);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
      gl.cullFace(gl.BACK);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
      this.renderedReplicaCount++;
    }
    // Draw light outlines after every replica's translucent faces. A later
    // face pass can otherwise blend over and erase an earlier replica's edges.
    this.outline.begin(renderer, planes, { scale: this.options.scale });
    const edges = selected ? SELECTED_EDGE_STYLE : voronoiEdgeStyle(baseColor, renderer.background);
    for (const replica of renderer.replicas) {
      this.outline.draw(this, this.vertexCount, this.edgeCount,
        replica.offset.map((value, axis) => value + renderer.displayPositions[atom * 3 + axis]), edges);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.depthMask(true); gl.enable(gl.CULL_FACE); gl.disable(gl.BLEND);
  }
}

// Depth-slope units, in pixels: about one ribbon width, so a face never hides
// the outline along its own boundary while deeper outlines remain hidden.
const SURFACE_POLYGON_OFFSET = 2;
const XRAY_FACE_FADE = 0.7, XRAY_EDGE_FADE = 0.85;
const HIDDEN_HIGHLIGHT_OPACITY = 0.22, HIDDEN_HIGHLIGHT_EDGE_ALPHA = 0.5;
// Dense tessellations use thinner base outlines than a single inspected cell,
// and fade outlines shorter than this many CSS pixels.
const ALL_CELL_EDGE_WIDTH = 1.6, ALL_CELL_SHORT_EDGE = 12;

/** Full tessellations use one GPU buffer group per bounded worker chunk,
 * rather than a draw call and uniform upload for every atom. */
export class VoronoiAllCellLayer {
  constructor(gl) {
    this.gl = gl; this.program = createProgram(gl);
    this.uniforms = Object.fromEntries([...FACE_UNIFORMS, 'uScalarValues', 'uScalarTextureWidth', ...SCALAR_COLOR_UNIFORMS].map(name => [name, gl.getUniformLocation(this.program, name)]));
    this.texture = gl.createTexture(); this.textureValues = null; this.textureWidth = 0;
    this.options = normalizeVoronoiCellOptions(); this.geometry = null; this.chunks = [];
    this.cellCount = this.renderedReplicaCount = this.renderedChunkCount = 0;
    this.highlightedCellCount = this.renderedHighlightReplicaCount = 0;
    this.positionRevision = this.positions = this.visibility = null; this.positionVersion = 0;
    this.outline = new VoronoiOutlineRenderer(gl);
    // Copies for cells displayed across a periodic boundary, from all chunks.
    const copyVao = gl.createVertexArray(), copyBuffer = gl.createBuffer(), copyIdBuffer = gl.createBuffer();
    gl.bindVertexArray(copyVao); gl.bindBuffer(gl.ARRAY_BUFFER, copyBuffer);
    for (let attribute = 0; attribute < 2; attribute++) {
      gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 24, attribute * 12);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, copyIdBuffer);
    gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 8, 0);
    gl.enableVertexAttribArray(3); gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 8, 4);
    gl.bindVertexArray(null);
    this.copyFaces = { vao: copyVao, buffer: copyBuffer, idBuffer: copyIdBuffer, cornerCount: 0 };
    this.copyEdges = { edgeVao: this.outline.createVao(true), buffer: gl.createBuffer(), idBuffer: gl.createBuffer(), firstSlots: 0, secondSlots: 0 };
    this.copyKey = null;
  }

  setGeometry(geometry, options = {}) {
    this.options = normalizeVoronoiCellOptions(options, this.options);
    // Streaming appends preserve all uploaded buffers. Replacing the scientific
    // result removes old groups immediately, including incomplete requests.
    if (geometry !== this.geometry || (geometry?.chunks.length ?? 0) < this.chunks.length) this.clearBuffers();
    this.geometry = geometry;
    for (let index = this.chunks.length; index < (geometry?.chunks.length ?? 0); index++) {
      const mesh = geometry.chunks[index], gl = this.gl;
      const vao = gl.createVertexArray(), buffer = gl.createBuffer(), indexBuffer = gl.createBuffer(), idBuffer = gl.createBuffer();
      gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.values, gl.STATIC_DRAW);
      for (let attribute = 0; attribute < 2; attribute++) {
        gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 24, attribute * 12);
      }
      // Face vertices carry (owner, neighbor) integer pairs.
      gl.bindBuffer(gl.ARRAY_BUFFER, idBuffer); gl.bufferData(gl.ARRAY_BUFFER, mesh.cellIds, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 8, 0);
      gl.enableVertexAttribArray(3); gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 8, 4);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.chunks.push({ mesh, vao, edgeVao: this.outline.createVao(true), buffer, indexBuffer, idBuffer });
    }
    this.cellCount = geometry?.cellCount ?? 0;
    this.renderedReplicaCount = this.renderedChunkCount = 0;
    this.highlightedCellCount = this.renderedHighlightReplicaCount = 0;
  }

  clearBuffers() {
    const gl = this.gl;
    for (const chunk of this.chunks) {
      gl.deleteVertexArray(chunk.vao); gl.deleteVertexArray(chunk.edgeVao); gl.deleteBuffer(chunk.buffer);
      gl.deleteBuffer(chunk.indexBuffer); gl.deleteBuffer(chunk.idBuffer);
    }
    this.chunks = []; this.cellCount = 0; this.highlightRuns = null; this.copyKey = null;
    this.highlightedCellCount = this.renderedHighlightReplicaCount = 0;
  }

  clear() {
    this.setGeometry(null);
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // Release the previous frame's large atom texture while retaining objects.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
    this.textureValues = this.positions = this.visibility = this.positionRevision = null;
    this.textureWidth = 0;
  }

  updatePositions(renderer) {
    if (renderer.displayPositions === this.positions && renderer.visibility === this.visibility
      && renderer.voronoiDisplayRevision === this.positionRevision) return;
    const gl = this.gl, maximum = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const width = Math.max(1, Math.min(renderer.atomCount, 2048, maximum));
    const height = Math.max(1, Math.ceil(renderer.atomCount / width));
    if (height > maximum) throw new Error('The Voronoi display exceeds this GPU’s atom-texture capacity.');
    if (this.textureValues?.length !== width * height * 4) this.textureValues = new Float32Array(width * height * 4);
    const values = this.textureValues;
    for (let atom = 0; atom < renderer.atomCount; atom++) {
      for (let axis = 0; axis < 3; axis++) values[atom * 4 + axis] = renderer.displayPositions[atom * 3 + axis];
      values[atom * 4 + 3] = renderer.visibility?.[atom] ? 1 : 0;
    }
    gl.activeTexture(gl.TEXTURE0 + 5); gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, values);
    this.textureWidth = width; this.positions = renderer.displayPositions; this.positionVersion++;
    this.visibility = renderer.visibility; this.positionRevision = renderer.voronoiDisplayRevision;
  }

  extendBounds(renderer, minimum, maximum, startChunk = 0) {
    if (!this.options.allEnabled || !this.geometry) return;
    for (let index = startChunk; index < this.geometry.chunks.length; index++) {
      const chunk = this.geometry.chunks[index];
      for (let cell = 0; cell < chunk.bounds.length; cell += 7) {
        const atom = chunk.bounds[cell];
        if (atom >= renderer.atomCount) continue;
        for (let axis = 0; axis < 3; axis++) {
          const center = renderer.displayPositions[atom * 3 + axis];
          minimum[axis] = Math.min(minimum[axis], center + chunk.bounds[cell + 1 + axis] + (renderer.minimumOffset?.[axis] ?? 0));
          maximum[axis] = Math.max(maximum[axis], center + chunk.bounds[cell + 4 + axis] + (renderer.maximumOffset?.[axis] ?? 0));
        }
      }
    }
  }

  /** Gather every chunk's periodic copies into one small buffer pair after
   * display positions or the streamed chunks change. */
  refreshCopies(positions) {
    const key = `${this.positionVersion}:${this.chunks.length}`;
    if (this.copyKey === key) return;
    const gl = this.gl, parts = this.chunks.map(chunk => periodicCopies(chunk.mesh, positions));
    const join = (name, Type) => {
      const output = new Type(parts.reduce((sum, part) => sum + part[name].length, 0));
      let offset = 0;
      for (const part of parts) { output.set(part[name], offset); offset += part[name].length; }
      return output;
    };
    const cornerCount = parts.reduce((sum, part) => sum + part.cornerCount, 0);
    // Upload only when either list changes from or to empty, or is non-empty.
    if (cornerCount || this.copyFaces.cornerCount) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.copyFaces.buffer); gl.bufferData(gl.ARRAY_BUFFER, join('faceValues', Float32Array), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.copyFaces.idBuffer); gl.bufferData(gl.ARRAY_BUFFER, join('faceIds', Uint32Array), gl.DYNAMIC_DRAW);
    }
    const ordered = which => parts.flatMap(part => {
      const [start, count] = which === 1 ? [0, part.firstEdgeCount] : [part.firstEdgeCount, part.secondEdgeCount];
      return [{ values: part.edgeValues.subarray(start * 12, (start + count) * 12), ids: part.edgeIds.subarray(start * 4, (start + count) * 4) }];
    });
    const edgeParts = [...ordered(1), ...ordered(2)];
    const firstSlots = parts.reduce((sum, part) => sum + part.firstEdgeCount * 2, 0), secondSlots = parts.reduce((sum, part) => sum + part.secondEdgeCount * 2, 0);
    if (firstSlots || secondSlots || this.copyEdges.firstSlots || this.copyEdges.secondSlots) {
      const values = new Float32Array((firstSlots + secondSlots) * 6), ids = new Uint32Array((firstSlots + secondSlots) * 2);
      let offset = 0;
      for (const part of edgeParts) { values.set(part.values, offset * 6); ids.set(part.ids, offset * 2); offset += part.values.length / 6; }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.copyEdges.buffer); gl.bufferData(gl.ARRAY_BUFFER, values, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.copyEdges.idBuffer); gl.bufferData(gl.ARRAY_BUFFER, ids, gl.DYNAMIC_DRAW);
    }
    Object.assign(this.copyFaces, { cornerCount }); Object.assign(this.copyEdges, { firstSlots, secondSlots });
    this.copyKey = key;
  }

  /** Draw runs for selected cells: each cell's owned faces and edges plus
   * those its neighbors own on its behalf, merged into contiguous ranges.
   * Rebuilt only when the selection or the streamed chunk list changes. */
  selectedRuns(selected) {
    const key = [...selected].sort((a, b) => a - b).join(',');
    if (this.highlightRuns?.key === key && this.highlightRuns.chunkCount === this.chunks.length) return this.highlightRuns;
    const runs = [], cells = new Set();
    for (const chunk of this.chunks) {
      const { cellRanges, foreignFaces, foreignEdges } = chunk.mesh, faces = [], edges = [];
      for (let entry = 0; entry < cellRanges.length; entry += 5) {
        if (!selected.has(cellRanges[entry])) continue;
        cells.add(cellRanges[entry]);
        faces.push([2, cellRanges[entry + 1], cellRanges[entry + 2]]); edges.push([3, cellRanges[entry + 3], cellRanges[entry + 4]]);
      }
      for (let entry = 0; entry < foreignFaces.length; entry += 3) {
        if (selected.has(foreignFaces[entry])) faces.push([3, foreignFaces[entry + 1], foreignFaces[entry + 2]]);
      }
      for (let entry = 0; entry < foreignEdges.length; entry += 3) {
        if (selected.has(foreignEdges[entry])) edges.push([3 + foreignEdges[entry + 2], foreignEdges[entry + 1], 2]);
      }
      if (faces.length || edges.length) runs.push({ chunk, faces: mergeRuns(faces), edges: mergeRuns(edges) });
    }
    return this.highlightRuns = { key, chunkCount: this.chunks.length, runs, cellCount: cells.size };
  }

  render(renderer) {
    this.renderedReplicaCount = this.renderedChunkCount = 0;
    this.highlightedCellCount = this.renderedHighlightReplicaCount = 0;
    if (!this.options.allEnabled || !this.cellCount || !renderer.frame) return;
    this.updatePositions(renderer);
    const gl = this.gl, u = this.uniforms, planes = dislocationSlicePlanes(renderer);
    const { opacity, scale } = this.options, surface = this.options.style === 'surface';
    gl.useProgram(this.program); gl.uniform1i(u.uBatched, 1); gl.uniform1i(u.uAtoms, 5);
    applyVoronoiScalarPreview(gl, u, renderer);
    gl.uniform1i(u.uAtomTextureWidth, this.textureWidth); gl.activeTexture(gl.TEXTURE0 + 5); gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniformMatrix4fv(u.uView, false, renderer.viewMatrix); gl.uniformMatrix4fv(u.uProjection, false, renderer.projectionMatrix);
    const color = parsePrimitiveColor(this.options.color);
    gl.uniform1i(u.uSliceCount, planes.count); gl.uniform4fv(u['uSlicePlanes[0]'], planes.values);
    gl.uniform1f(u.uScale, scale); gl.uniform2f(u.uDepthRange, ...(renderer.depthRange ?? [0, 1]));
    gl.uniform1i(u.uDepthOnly, 0); gl.uniform1i(u.uFacing, 0); gl.uniform1i(u.uTwoSided, 1);
    gl.enable(gl.BLEND); gl.depthMask(false); gl.enable(gl.POLYGON_OFFSET_FILL);
    const cull = face => { if (face) { gl.enable(gl.CULL_FACE); gl.cullFace(face); } else gl.disable(gl.CULL_FACE); };
    // At true size, one stored copy serves both cells unless they are
    // displayed in different periodic images; only those faces are drawn again
    // at the neighbor. A reduced Cell scale shrinks each cell toward its own
    // atom, so every shared face then needs the neighbor's copy.
    const trueSize = scale > 0.9999;
    if (trueSize) this.refreshCopies(renderer.displayPositions);
    const drawAll = face => {
      cull(face);
      for (const replica of renderer.replicas) {
        gl.uniform3f(u.uCenter, ...replica.offset);
        gl.uniform1i(u.uAnchor, trueSize ? 0 : -1);
        for (const chunk of this.chunks) {
          gl.bindVertexArray(chunk.vao);
          if (trueSize) gl.drawElements(gl.TRIANGLES, chunk.mesh.indexCount, gl.UNSIGNED_INT, 0);
          else gl.drawElementsInstanced(gl.TRIANGLES, chunk.mesh.indexCount, gl.UNSIGNED_INT, 0, 2);
        }
        if (trueSize && this.copyFaces.cornerCount) {
          gl.uniform1i(u.uAnchor, 1); gl.bindVertexArray(this.copyFaces.vao);
          gl.drawArrays(gl.TRIANGLES, 0, this.copyFaces.cornerCount);
        }
      }
    };
    const translucent = () => gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (surface) {
      // Resolve the nearest cell surface into depth first, leaving the image
      // untouched. A stored shared face may face either way, so neither pass
      // culls. The later color pass and outlines then pass only where no
      // nearer cell hides them, without sorting any mesh.
      gl.polygonOffset(SURFACE_POLYGON_OFFSET, SURFACE_POLYGON_OFFSET);
      gl.depthMask(true); gl.blendFuncSeparate(gl.ZERO, gl.ONE, gl.ZERO, gl.ONE); gl.uniform1i(u.uDepthOnly, 1);
      drawAll(null);
      gl.depthMask(false); gl.uniform1i(u.uDepthOnly, 0);
    } else gl.polygonOffset(-1, -1);
    translucent(); gl.uniform1f(u.uDepthFade, surface ? 0 : XRAY_FACE_FADE);
    gl.uniform3f(u.uColor, ...color); gl.uniform1f(u.uOpacity, opacity);
    // See-through draws every camera-averted polygon before every facing one.
    for (const face of surface ? [null] : [gl.FRONT, gl.BACK]) drawAll(face);
    this.renderedReplicaCount = renderer.replicas.length;
    this.renderedChunkCount = renderer.replicas.length * this.chunks.length;
    // Selected cells are drawn after the base tessellation, so the highlight
    // stays legible regardless of chunk order and does not depend on the
    // separate "Show selected cell" preview setting.
    const selected = selectedCellAtoms(renderer), highlight = selected.size ? this.selectedRuns(selected) : null;
    this.highlightedCellCount = highlight?.cellCount ?? 0;
    // Forced anchors place every face at its selected cell; facing is judged
    // from that cell, so its rear surfaces precede its front ones.
    const highlightFaces = (facings, alpha) => {
      gl.uniform1f(u.uOpacity, alpha); cull(null);
      for (const facing of facings) {
        gl.uniform1i(u.uFacing, facing);
        for (const replica of renderer.replicas) {
          gl.uniform3f(u.uCenter, ...replica.offset);
          for (const { chunk, faces } of highlight.runs) {
            gl.bindVertexArray(chunk.vao);
            for (const [anchor, first, count] of faces) {
              if (!count) continue;
              gl.uniform1i(u.uAnchor, anchor); gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, first * 4);
            }
          }
        }
      }
      gl.uniform1i(u.uFacing, 0);
    };
    if (highlight?.runs.length) {
      gl.uniform3f(u.uColor, ...SELECTED_FACE_COLOR); gl.uniform1f(u.uDepthFade, 0);
      if (surface) {
        // Visible facets coincide with the resolved surface. The hidden part
        // of a selection, including an interior cell, stays locatable as a
        // faint amber ghost; GREATER and LEQUAL never draw a fragment twice.
        gl.depthFunc(gl.GREATER); highlightFaces([1, 2], HIDDEN_HIGHLIGHT_OPACITY);
        gl.depthFunc(gl.LEQUAL); highlightFaces([2], Math.max(0.62, opacity));
      } else {
        gl.polygonOffset(-2, -2); highlightFaces([1, 2], Math.max(0.62, opacity));
      }
      this.renderedHighlightReplicaCount = renderer.replicas.length;
    }
    // Draw outlines after every translucent face, including highlighted faces.
    // Atom depth and world-space slice clipping still apply; in surface mode
    // the resolved cell depth also removes every hidden outline.
    this.outline.begin(renderer, planes, { batched: true, textureWidth: this.textureWidth, scale,
      depthFade: surface ? 0 : XRAY_EDGE_FADE });
    const edges = voronoiEdgeStyle(color, renderer.background, ALL_CELL_EDGE_WIDTH, ALL_CELL_SHORT_EDGE);
    for (const replica of renderer.replicas) {
      this.outline.setAnchor(trueSize ? 0 : -1);
      for (const chunk of this.chunks) {
        this.outline.draw(chunk, chunk.mesh.vertexCount, chunk.mesh.edgeCount, replica.offset, edges, 1, trueSize ? 1 : 3);
      }
      if (trueSize) {
        const { firstSlots, secondSlots } = this.copyEdges;
        this.outline.setAnchor(1); this.outline.draw(this.copyEdges, 0, firstSlots, replica.offset, edges);
        this.outline.setAnchor(2); this.outline.draw(this.copyEdges, firstSlots, secondSlots, replica.offset, edges);
      }
    }
    const highlightEdges = alpha => {
      for (const replica of renderer.replicas) for (const { chunk, edges: runs } of highlight.runs) for (const [anchor, first, count] of runs) {
        this.outline.setAnchor(anchor);
        this.outline.draw(chunk, first, count, replica.offset, SELECTED_EDGE_STYLE, alpha);
      }
    };
    if (highlight?.runs.length) {
      this.outline.setDepthFade(0);
      if (surface) { gl.depthFunc(gl.GREATER); highlightEdges(HIDDEN_HIGHLIGHT_EDGE_ALPHA); gl.depthFunc(gl.LEQUAL); }
      highlightEdges(1);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.depthMask(true); gl.enable(gl.CULL_FACE); gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
  }
}

function applyVoronoiScalarPreview(gl, uniforms, renderer) {
  // Unit 5 holds the existing atom-position texture; unit 6 is the shared
  // scalar field. Range changes touch uniforms rather than cell geometry.
  gl.uniform1i(uniforms.uScalarValues, renderer.scalarColorPreview ? 6 : 0);
  gl.uniform1i(uniforms.uScalarTextureWidth, renderer.scalarColorTextureWidth ?? 1);
  if (renderer.scalarColorPreview) {
    gl.activeTexture(gl.TEXTURE0 + 6); gl.bindTexture(gl.TEXTURE_2D, renderer.scalarColorTexture);
  }
  applyScalarColorUniforms(gl, uniforms, renderer.scalarColorPreview);
}

// Sort [anchor, first, count] draw ranges and join adjacent ones per anchor.
function mergeRuns(entries) {
  entries.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const entry of entries) {
    const last = merged.at(-1);
    if (last && last[0] === entry[0] && last[1] + last[2] === entry[1]) last[2] += entry[2];
    else merged.push([...entry]);
  }
  return merged;
}

function createProgram(gl, vertex = VERTEX, fragment = FRAGMENT, label = 'Voronoi cell') {
  const program = gl.createProgram();
  for (const [kind, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
    const shader = gl.createShader(kind); gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`${label} shader failed: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program, shader); gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`${label} shader linking failed: ${gl.getProgramInfoLog(program)}`);
  return program;
}
