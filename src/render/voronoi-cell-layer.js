import { parsePrimitiveColor } from './atom-primitives.js';
import { dislocationSlicePlanes } from './dislocation-layer.js';
import { MAX_SLICES, SLICE_EPSILON } from './slicing.js';

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

/** Local Cartesian vertices remain independent of
 * display wrapping, periodic origin, replication and scientific atom arrays. */
export function createVoronoiCellMesh(cell) {
  if (!Number.isInteger(cell?.atomIndex) || cell.atomIndex < 0) throw new Error('A Voronoi cell needs a valid atom index.');
  const { vertices, faceOffsets, faceVertices } = cell;
  if (!vertices || vertices.length % 3 || !Array.from(vertices).every(Number.isFinite)
    || !faceOffsets || faceOffsets.length < 2 || faceOffsets[0] !== 0
    || faceOffsets.at(-1) !== faceVertices?.length) throw new Error('Invalid Voronoi cell geometry.');
  // The atom may lie on a nonperiodic boundary. Use a point inside the
  // convex polyhedron to orient faces, rather than the local atom origin.
  const interior = [0, 0, 0];
  for (let index = 0; index < vertices.length; index++) interior[index % 3] += vertices[index] / (vertices.length / 3);
  const values = [], indices = [], edges = new Map();
  for (let face = 0; face < faceOffsets.length - 1; face++) {
    const start = faceOffsets[face], end = faceOffsets[face + 1];
    if (end - start < 3 || end < start) throw new Error('Voronoi cell faces require at least three corners.');
    const corners = Array.from(faceVertices.subarray(start, end));
    if (corners.some(index => !Number.isInteger(index) || index < 0 || index * 3 >= vertices.length)) throw new Error('Invalid Voronoi face vertex.');
    const points = corners.map(index => Array.from(vertices.subarray(index * 3, index * 3 + 3)));
    let normal;
    for (let corner = 1; corner + 1 < points.length; corner++) {
      const a = points[corner].map((value, axis) => value - points[0][axis]);
      const b = points[corner + 1].map((value, axis) => value - points[0][axis]);
      const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const length = Math.hypot(...n);
      if (length > 0) { normal = n.map(value => value / length); break; }
    }
    if (!normal) throw new Error('A Voronoi cell face is degenerate.');
    const inward = normal.reduce((sum, value, axis) => sum + value * (points[0][axis] - interior[axis]), 0) < 0;
    if (inward) normal = normal.map(value => -value);
    const first = values.length / 6;
    for (const point of points) values.push(...point, ...normal);
    for (let corner = 1; corner + 1 < points.length; corner++) {
      if (inward) indices.push(first, first + corner + 1, first + corner);
      else indices.push(first, first + corner, first + corner + 1);
    }
    for (let corner = 0; corner < corners.length; corner++) {
      const a = corners[corner], b = corners[(corner + 1) % corners.length];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (!edges.has(key)) edges.set(key, [...vertices.subarray(a * 3, a * 3 + 3), 0, 0, 0,
        ...vertices.subarray(b * 3, b * 3 + 3), 0, 0, 0]);
    }
  }
  const faceVertexCount = values.length / 6;
  for (const edge of edges.values()) values.push(...edge);
  return { values: Float32Array.from(values), indices: Uint32Array.from(indices),
    vertexCount: faceVertexCount, indexCount: indices.length, edgeCount: edges.size * 2 };
}

/** Pack a bounded group of cells into one face/outline draw buffer. Atom IDs
 * stay integer attributes so display transforms and masks need no mesh rebuild. */
export function createVoronoiCellBatch(cells) {
  const meshes = cells.map(createVoronoiCellMesh);
  const vertexCount = meshes.reduce((sum, mesh) => sum + mesh.vertexCount, 0);
  const edgeCount = meshes.reduce((sum, mesh) => sum + mesh.edgeCount, 0);
  const indexCount = meshes.reduce((sum, mesh) => sum + mesh.indexCount, 0);
  const values = new Float32Array((vertexCount + edgeCount) * 6);
  const indices = new Uint32Array(indexCount), atomIndices = new Uint32Array(vertexCount + edgeCount);
  const bounds = new Float64Array(cells.length * 7), cellRanges = new Uint32Array(cells.length * 5);
  let vertex = 0, edge = vertexCount, index = 0;
  cells.forEach((cell, cellIndex) => {
    const mesh = meshes[cellIndex];
    // Faces and edges for a cell are contiguous. Preserve their draw ranges
    // so selecting an atom can emphasize its existing mesh without extracting
    // geometry, uploading buffers or drawing the whole tessellation again.
    cellRanges.set([cell.atomIndex, index, mesh.indexCount, edge, mesh.edgeCount], cellIndex * 5);
    values.set(mesh.values.subarray(0, mesh.vertexCount * 6), vertex * 6);
    values.set(mesh.values.subarray(mesh.vertexCount * 6), edge * 6);
    atomIndices.fill(cell.atomIndex, vertex, vertex + mesh.vertexCount);
    atomIndices.fill(cell.atomIndex, edge, edge + mesh.edgeCount);
    for (const value of mesh.indices) indices[index++] = value + vertex;
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
    for (let point = 0; point < cell.vertices.length; point += 3) for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], cell.vertices[point + axis]);
      maximum[axis] = Math.max(maximum[axis], cell.vertices[point + axis]);
    }
    bounds.set([cell.atomIndex, ...minimum, ...maximum], cellIndex * 7);
    vertex += mesh.vertexCount; edge += mesh.edgeCount;
  });
  return { values, indices, atomIndices, bounds, cellRanges, vertexCount, indexCount, edgeCount, cellCount: cells.length };
}

const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in uint aAtomIndex;
uniform mat4 uView;
uniform mat4 uProjection;
uniform vec3 uCenter;
uniform bool uBatched;
uniform sampler2D uAtoms;
uniform int uAtomTextureWidth;
uniform float uScale;
uniform vec2 uDepthRange;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vView;
out float vDepth;
flat out float vVisible;
void main() {
  vec4 atom = vec4(0.0, 0.0, 0.0, 1.0);
  if (uBatched) atom = texelFetch(uAtoms, ivec2(int(aAtomIndex) % uAtomTextureWidth, int(aAtomIndex) / uAtomTextureWidth), 0);
  vVisible = atom.w;
  // Local vertices are relative to the generating atom, which lies inside its
  // convex cell; scaling about it separates neighboring cells by a uniform gap.
  vWorld = uCenter + atom.xyz + aPosition * uScale;
  vNormal = mat3(uView) * aNormal;
  vec4 view = uView * vec4(vWorld, 1.0);
  vView = view.xyz;
  vDepth = clamp((-view.z - uDepthRange.x) / max(uDepthRange.y - uDepthRange.x, 1e-6), 0.0, 1.0);
  gl_Position = uProjection * view;
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
uniform int uSliceCount;
uniform vec4 uSlicePlanes[${MAX_SLICES}];
out vec4 outColor;
void main() {
  if (vVisible < 0.5) discard;
  for (int plane = 0; plane < ${MAX_SLICES}; plane++) {
    if (plane >= uSliceCount) break;
    if (dot(uSlicePlanes[plane].xyz, vWorld) > uSlicePlanes[plane].w + ${SLICE_EPSILON}) discard;
  }
  // The nearest-surface pass needs only depth; its blend leaves color intact.
  if (uDepthOnly) { outColor = vec4(0.0); return; }
  // Flat, outward face normals retain the physical facets. Distinct key and
  // fill lights make opposite faces read differently, including the rear
  // surfaces of translucent cells. Use the same view-space studio as atoms.
  vec3 normal = normalize(vNormal);
  vec3 key = normalize(vec3(-0.48, 0.62, 0.72));
  vec3 fill = normalize(vec3(0.68, -0.36, 0.48));
  float ambient = mix(0.18, 0.29, normal.y * 0.5 + 0.5);
  float light = ambient + 0.72 * max(0.0, dot(normal, key))
    + 0.18 * max(0.0, dot(normal, fill));
  vec3 base = pow(uColor, vec3(2.2));
  vec3 viewDirection = uProjection[3][3] > 0.5 ? vec3(0.0, 0.0, 1.0) : normalize(-vView);
  vec3 halfDirection = normalize(key + viewDirection);
  float specular = pow(max(0.0, dot(normal, halfDirection)), 28.0) * 0.16;
  vec3 shaded = base * light + vec3(1.0, 0.96, 0.88) * specular;
  outColor = vec4(pow(clamp(shaded, 0.0, 1.0), vec3(1.0 / 2.2)), uOpacity * (1.0 - uDepthFade * vDepth));
}`;

const SELECTED_FACE_COLOR = [1, 0.68, 0.16];

const OUTLINE_VERTEX = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec3 aStart;
layout(location=1) in vec3 aEnd;
layout(location=2) in uint aAtomIndex;
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
out vec3 vWorld;
out float vSide;
out float vDepth;
out float vLengthFade;
flat out float vVisible;
void main() {
  vec4 atom = vec4(0.0, 0.0, 0.0, 1.0);
  if (uBatched) atom = texelFetch(uAtoms, ivec2(int(aAtomIndex) % uAtomTextureWidth, int(aAtomIndex) / uAtomTextureWidth), 0);
  vVisible = atom.w;
  vDepth = 0.0; vLengthFade = 1.0;
  vec3 start = uCenter + atom.xyz + aStart * uScale;
  vec3 end = uCenter + atom.xyz + aEnd * uScale;
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
  int corner = int[6](0, 1, 2, 2, 1, 3)[gl_VertexID];
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
uniform vec4 uSlicePlanes[${MAX_SLICES}];
out vec4 outColor;
void main() {
  if (vVisible < 0.5) discard;
  for (int plane = 0; plane < ${MAX_SLICES}; plane++) {
    if (plane >= uSliceCount) break;
    if (dot(uSlicePlanes[plane].xyz, vWorld) > uSlicePlanes[plane].w + ${SLICE_EPSILON}) discard;
  }
  float side = abs(vSide);
  vec3 color = mix(uEdgeColor, uOutlineColor, smoothstep(uCoreRatio - 0.08, uCoreRatio + 0.08, side));
  float coverage = 1.0 - smoothstep(1.0 - fwidth(vSide) * 0.5, 1.0, side);
  outColor = vec4(color, coverage * vLengthFade * uAlpha * (1.0 - uDepthFade * vDepth));
}`;

/** Reuse the existing edge endpoints as instanced ribbons, without allocating
 * additional geometry buffers or rebuilding cells for camera/selection edits. */
class VoronoiOutlineRenderer {
  constructor(gl) {
    this.gl = gl; this.program = createProgram(gl, OUTLINE_VERTEX, OUTLINE_FRAGMENT, 'Voronoi outline');
    this.uniforms = Object.fromEntries(['uView', 'uProjection', 'uCenter', 'uBatched', 'uAtoms', 'uAtomTextureWidth',
      'uViewport', 'uEdgeWidth', 'uEdgeColor', 'uOutlineColor', 'uCoreRatio', 'uAlpha', 'uScale', 'uDepthRange', 'uDepthFade', 'uShortEdge',
      'uSliceCount', 'uSlicePlanes[0]']
      .map(name => [name, gl.getUniformLocation(this.program, name)]));
  }
  createVao(buffer, atomBuffer = null) {
    const gl = this.gl, vao = gl.createVertexArray(); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (let attribute = 0; attribute < 2; attribute++) {
      gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 48, attribute * 24);
      gl.vertexAttribDivisor(attribute, 1);
    }
    if (atomBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, atomBuffer); gl.enableVertexAttribArray(2);
      gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 8, 0); gl.vertexAttribDivisor(2, 1);
    }
    gl.bindVertexArray(null); return vao;
  }
  begin(renderer, planes, { batched = false, textureWidth = 1, scale = 1, depthFade = 0 } = {}) {
    const gl = this.gl, u = this.uniforms;
    gl.useProgram(this.program); gl.uniform1i(u.uBatched, Number(batched)); gl.uniform1i(u.uAtoms, batched ? 5 : 0);
    gl.uniform1i(u.uAtomTextureWidth, textureWidth);
    gl.uniformMatrix4fv(u.uView, false, renderer.viewMatrix); gl.uniformMatrix4fv(u.uProjection, false, renderer.projectionMatrix);
    const width = Math.max(1, renderer.canvas?.width ?? 1), height = Math.max(1, renderer.canvas?.height ?? 1);
    this.pixelRatio = Math.max(1, width / Math.max(1, renderer.canvas?.clientWidth ?? width));
    gl.uniform2f(u.uViewport, width, height); gl.uniform1i(u.uSliceCount, planes.count); gl.uniform4fv(u['uSlicePlanes[0]'], planes.values);
    gl.uniform1f(u.uScale, scale); gl.uniform2f(u.uDepthRange, ...(renderer.depthRange ?? [0, 1])); gl.uniform1f(u.uDepthFade, depthFade);
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.disable(gl.CULL_FACE);
  }
  setDepthFade(value) { this.gl.uniform1f(this.uniforms.uDepthFade, value); }
  draw({ edgeVao, buffer, atomBuffer }, firstEdge, edgeCount, center, style = SELECTED_EDGE_STYLE, alpha = 1) {
    if (!edgeCount) return;
    const gl = this.gl, u = this.uniforms; gl.bindVertexArray(edgeVao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (let attribute = 0; attribute < 2; attribute++) gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 48, firstEdge * 24 + attribute * 24);
    if (atomBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, atomBuffer); gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 8, firstEdge * 4);
    } else gl.vertexAttribI4ui(2, 0, 0, 0, 0);
    gl.uniform3f(u.uCenter, ...center); gl.uniform1f(u.uEdgeWidth, style.width * this.pixelRatio);
    gl.uniform3f(u.uEdgeColor, ...style.edge); gl.uniform3f(u.uOutlineColor, ...style.outline);
    gl.uniform1f(u.uCoreRatio, style.core); gl.uniform1f(u.uAlpha, alpha);
    gl.uniform1f(u.uShortEdge, (style.shortEdge ?? 0) * this.pixelRatio);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, edgeCount / 2);
  }
}

function selectedCellAtoms(renderer) {
  const atoms = new Set([renderer.selected, ...(renderer.getSelectionHighlightAtoms?.() ?? renderer.selectedAtoms ?? []),
    ...(renderer.sliceSelectedAtoms ?? [])]);
  for (const atom of atoms) if (!Number.isInteger(atom) || atom < 0 || atom >= renderer.atomCount
    || !renderer.visibility?.[atom]) atoms.delete(atom);
  return atoms;
}

// Normal batches have explicit cell ranges. Deriving them once also supports
// meshes retained by another view from before the range metadata was added.
function cellDrawRanges(mesh) {
  const ranges = new Map();
  if (mesh.cellRanges) {
    for (let entry = 0; entry < mesh.cellRanges.length; entry += 5) {
      const [atom, firstIndex, indexCount, firstEdge, edgeCount] = mesh.cellRanges.subarray(entry, entry + 5);
      const atomRanges = ranges.get(atom) ?? [];
      atomRanges.push({ firstIndex, indexCount, firstEdge, edgeCount }); ranges.set(atom, atomRanges);
    }
    return ranges;
  }
  for (let index = 0; index < mesh.indexCount;) {
    const firstIndex = index, atom = mesh.atomIndices[mesh.indices[index]];
    while (index < mesh.indexCount && mesh.atomIndices[mesh.indices[index]] === atom) index += 3;
    const atomRanges = ranges.get(atom) ?? [];
    atomRanges.push({ firstIndex, indexCount: index - firstIndex, firstEdge: 0, edgeCount: 0 }); ranges.set(atom, atomRanges);
  }
  for (let edge = mesh.vertexCount; edge < mesh.vertexCount + mesh.edgeCount;) {
    const firstEdge = edge, atom = mesh.atomIndices[edge];
    while (edge < mesh.vertexCount + mesh.edgeCount && mesh.atomIndices[edge] === atom) edge += 2;
    const atomRanges = ranges.get(atom);
    if (atomRanges?.length) { atomRanges[0].firstEdge = firstEdge; atomRanges[0].edgeCount = edge - firstEdge; }
  }
  return ranges;
}

const FACE_UNIFORMS = ['uView', 'uProjection', 'uCenter', 'uColor', 'uOpacity', 'uSliceCount', 'uSlicePlanes[0]',
  'uBatched', 'uAtoms', 'uAtomTextureWidth', 'uScale', 'uDepthRange', 'uDepthFade', 'uDepthOnly'];

export class VoronoiCellLayer {
  constructor(gl) {
    this.gl = gl;
    this.program = createProgram(gl);
    this.uniforms = Object.fromEntries(FACE_UNIFORMS.map(name => [name, gl.getUniformLocation(this.program, name)]));
    this.vao = gl.createVertexArray(); this.buffer = gl.createBuffer(); this.indexBuffer = gl.createBuffer();
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (let attribute = 0; attribute < 2; attribute++) {
      gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 24, attribute * 12);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer); gl.bindVertexArray(null);
    this.outline = new VoronoiOutlineRenderer(gl); this.edgeVao = this.outline.createVao(this.buffer);
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
    if (!this.options.enabled || !this.indexCount || !renderer.frame || atom >= renderer.atomCount || !renderer.visibility?.[atom]) return;
    const gl = this.gl, u = this.uniforms, planes = dislocationSlicePlanes(renderer);
    gl.useProgram(this.program); gl.bindVertexArray(this.vao);
    gl.uniform1i(u.uBatched, 0);
    gl.vertexAttribI4ui(2, 0, 0, 0, 0);
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
    this.uniforms = Object.fromEntries(FACE_UNIFORMS.map(name => [name, gl.getUniformLocation(this.program, name)]));
    this.texture = gl.createTexture(); this.textureValues = null; this.textureWidth = 0;
    this.options = normalizeVoronoiCellOptions(); this.geometry = null; this.chunks = [];
    this.cellCount = this.renderedReplicaCount = this.renderedChunkCount = 0;
    this.highlightedCellCount = this.renderedHighlightReplicaCount = 0;
    this.positionRevision = this.positions = this.visibility = null;
    this.outline = new VoronoiOutlineRenderer(gl);
  }

  setGeometry(geometry, options = {}) {
    this.options = normalizeVoronoiCellOptions(options, this.options);
    // Streaming appends preserve all uploaded buffers. Replacing the scientific
    // result removes old groups immediately, including incomplete requests.
    if (geometry !== this.geometry || (geometry?.chunks.length ?? 0) < this.chunks.length) this.clearBuffers();
    this.geometry = geometry;
    for (let index = this.chunks.length; index < (geometry?.chunks.length ?? 0); index++) {
      const mesh = geometry.chunks[index], gl = this.gl;
      const vao = gl.createVertexArray(), buffer = gl.createBuffer(), indexBuffer = gl.createBuffer(), atomBuffer = gl.createBuffer();
      gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.values, gl.STATIC_DRAW);
      for (let attribute = 0; attribute < 2; attribute++) {
        gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 24, attribute * 12);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, atomBuffer); gl.bufferData(gl.ARRAY_BUFFER, mesh.atomIndices, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      const edgeVao = this.outline.createVao(buffer, atomBuffer);
      this.chunks.push({ mesh, vao, edgeVao, buffer, indexBuffer, atomBuffer, cellRanges: cellDrawRanges(mesh) });
    }
    this.cellCount = geometry?.cellCount ?? 0;
    this.renderedReplicaCount = this.renderedChunkCount = 0;
    this.highlightedCellCount = this.renderedHighlightReplicaCount = 0;
  }

  clearBuffers() {
    const gl = this.gl;
    for (const chunk of this.chunks) {
      gl.deleteVertexArray(chunk.vao); gl.deleteVertexArray(chunk.edgeVao); gl.deleteBuffer(chunk.buffer);
      gl.deleteBuffer(chunk.indexBuffer); gl.deleteBuffer(chunk.atomBuffer);
    }
    this.chunks = []; this.cellCount = 0;
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
    this.textureWidth = width; this.positions = renderer.displayPositions;
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

  render(renderer) {
    this.renderedReplicaCount = this.renderedChunkCount = 0;
    this.highlightedCellCount = this.renderedHighlightReplicaCount = 0;
    if (!this.options.allEnabled || !this.cellCount || !renderer.frame) return;
    this.updatePositions(renderer);
    const gl = this.gl, u = this.uniforms, planes = dislocationSlicePlanes(renderer);
    const { opacity, scale } = this.options, surface = this.options.style === 'surface';
    gl.useProgram(this.program); gl.uniform1i(u.uBatched, 1); gl.uniform1i(u.uAtoms, 5);
    gl.uniform1i(u.uAtomTextureWidth, this.textureWidth); gl.activeTexture(gl.TEXTURE0 + 5); gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniformMatrix4fv(u.uView, false, renderer.viewMatrix); gl.uniformMatrix4fv(u.uProjection, false, renderer.projectionMatrix);
    const color = parsePrimitiveColor(this.options.color);
    gl.uniform1i(u.uSliceCount, planes.count); gl.uniform4fv(u['uSlicePlanes[0]'], planes.values);
    gl.uniform1f(u.uScale, scale); gl.uniform2f(u.uDepthRange, ...(renderer.depthRange ?? [0, 1]));
    gl.uniform1i(u.uDepthOnly, 0);
    gl.enable(gl.BLEND); gl.enable(gl.CULL_FACE); gl.depthMask(false); gl.enable(gl.POLYGON_OFFSET_FILL);
    const drawFaces = (indexCount, firstIndex, culls) => {
      for (const face of culls) { gl.cullFace(face); gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, firstIndex * 4); }
    };
    const translucent = () => gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (surface) {
      // Resolve the nearest cell surface into depth first, leaving the image
      // untouched. Shared faces are front faces of exactly one adjacent cell,
      // so back faces are unnecessary; a slice-opened cell exposes its
      // neighbor's coincident face. The later color pass and outlines then
      // pass only where no nearer cell hides them, without sorting any mesh.
      gl.polygonOffset(SURFACE_POLYGON_OFFSET, SURFACE_POLYGON_OFFSET);
      gl.depthMask(true); gl.blendFuncSeparate(gl.ZERO, gl.ONE, gl.ZERO, gl.ONE); gl.uniform1i(u.uDepthOnly, 1);
      for (const replica of renderer.replicas) {
        gl.uniform3f(u.uCenter, ...replica.offset);
        for (const chunk of this.chunks) { gl.bindVertexArray(chunk.vao); drawFaces(chunk.mesh.indexCount, 0, [gl.BACK]); }
      }
      gl.depthMask(false); gl.uniform1i(u.uDepthOnly, 0);
    } else gl.polygonOffset(-1, -1);
    translucent(); gl.uniform1f(u.uDepthFade, surface ? 0 : XRAY_FACE_FADE);
    gl.uniform3f(u.uColor, ...color); gl.uniform1f(u.uOpacity, opacity);
    // See-through cells draw rear then front surfaces, as for one convex cell.
    const baseCulls = surface ? [gl.BACK] : [gl.FRONT, gl.BACK];
    for (const replica of renderer.replicas) {
      gl.uniform3f(u.uCenter, ...replica.offset);
      for (const chunk of this.chunks) {
        gl.bindVertexArray(chunk.vao);
        drawFaces(chunk.mesh.indexCount, 0, baseCulls);
        this.renderedChunkCount++;
      }
      this.renderedReplicaCount++;
    }
    // The all-cell mesh already contains the selected polyhedron. Draw only
    // its contiguous triangle/edge ranges after the base tessellation, so the
    // highlight stays legible regardless of chunk order and does not depend
    // on the separate "Show selected cell" preview setting.
    const selected = selectedCellAtoms(renderer), highlights = [], highlightedAtoms = new Set();
    for (const chunk of this.chunks) for (const atom of selected) {
      const ranges = chunk.cellRanges.get(atom);
      if (!ranges) continue;
      highlights.push({ chunk, ranges }); highlightedAtoms.add(atom);
    }
    this.highlightedCellCount = highlightedAtoms.size;
    const highlightFaces = (culls, alpha) => {
      gl.uniform1f(u.uOpacity, alpha);
      for (const replica of renderer.replicas) {
        gl.uniform3f(u.uCenter, ...replica.offset);
        for (const { chunk, ranges } of highlights) {
          gl.bindVertexArray(chunk.vao);
          for (const range of ranges) drawFaces(range.indexCount, range.firstIndex, culls);
        }
      }
    };
    if (highlights.length) {
      gl.uniform3f(u.uColor, ...SELECTED_FACE_COLOR); gl.uniform1f(u.uDepthFade, 0);
      if (surface) {
        // Visible facets coincide with the resolved surface. The hidden part
        // of a selection, including an interior cell, stays locatable as a
        // faint amber ghost; GREATER and LEQUAL never draw a fragment twice.
        gl.depthFunc(gl.GREATER); highlightFaces([gl.FRONT, gl.BACK], HIDDEN_HIGHLIGHT_OPACITY);
        gl.depthFunc(gl.LEQUAL); highlightFaces([gl.BACK], Math.max(0.62, opacity));
      } else {
        gl.polygonOffset(-2, -2); highlightFaces([gl.FRONT, gl.BACK], Math.max(0.62, opacity));
      }
      this.renderedHighlightReplicaCount = renderer.replicas.length;
    }
    // Draw outlines after every translucent face, including highlighted faces.
    // Atom depth and world-space slice clipping still apply; in surface mode
    // the resolved cell depth also removes every hidden outline.
    this.outline.begin(renderer, planes, { batched: true, textureWidth: this.textureWidth, scale,
      depthFade: surface ? 0 : XRAY_EDGE_FADE });
    const edges = voronoiEdgeStyle(color, renderer.background, ALL_CELL_EDGE_WIDTH, ALL_CELL_SHORT_EDGE);
    for (const replica of renderer.replicas) for (const chunk of this.chunks) {
      this.outline.draw(chunk, chunk.mesh.vertexCount, chunk.mesh.edgeCount, replica.offset, edges);
    }
    const highlightEdges = alpha => {
      for (const replica of renderer.replicas) for (const { chunk, ranges } of highlights) for (const range of ranges) {
        this.outline.draw(chunk, range.firstEdge, range.edgeCount, replica.offset, SELECTED_EDGE_STYLE, alpha);
      }
    };
    if (highlights.length) {
      this.outline.setDepthFade(0);
      if (surface) { gl.depthFunc(gl.GREATER); highlightEdges(HIDDEN_HIGHLIGHT_EDGE_ALPHA); gl.depthFunc(gl.LEQUAL); }
      highlightEdges(1);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.depthMask(true); gl.enable(gl.CULL_FACE); gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
  }
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
