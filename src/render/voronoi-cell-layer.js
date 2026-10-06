import { parsePrimitiveColor } from './atom-primitives.js';
import { dislocationSlicePlanes } from './dislocation-layer.js';
import { MAX_SLICES, SLICE_EPSILON } from './slicing.js';

export function normalizeVoronoiCellOptions(options = {}, previous = {}) {
  const color = options.color ?? previous.color ?? '#008b95';
  parsePrimitiveColor(color);
  const opacity = Number(options.opacity ?? previous.opacity ?? 0.22);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('Voronoi cell opacity must be between zero and one.');
  return { enabled: Boolean(options.enabled ?? previous.enabled ?? false), color, opacity };
}

/** One inspected cell only. Local Cartesian vertices remain independent of
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

const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
uniform mat4 uView;
uniform mat4 uProjection;
uniform vec3 uCenter;
out vec3 vWorld;
out vec3 vNormal;
void main() {
  vWorld = uCenter + aPosition;
  vNormal = mat3(uView) * aNormal;
  gl_Position = uProjection * uView * vec4(vWorld, 1.0);
}`;
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec3 vWorld;
in vec3 vNormal;
uniform vec3 uColor;
uniform float uOpacity;
uniform bool uEdges;
uniform int uSliceCount;
uniform vec4 uSlicePlanes[${MAX_SLICES}];
out vec4 outColor;
void main() {
  for (int plane = 0; plane < ${MAX_SLICES}; plane++) {
    if (plane >= uSliceCount) break;
    if (dot(uSlicePlanes[plane].xyz, vWorld) > uSlicePlanes[plane].w + ${SLICE_EPSILON}) discard;
  }
  float light = uEdges ? 1.0 : 0.6 + 0.4 * abs(dot(normalize(vNormal), normalize(vec3(-0.48, 0.62, 0.72))));
  outColor = vec4(uColor * light, uOpacity);
}`;

export class VoronoiCellLayer {
  constructor(gl) {
    this.gl = gl;
    this.program = createProgram(gl);
    this.uniforms = Object.fromEntries(['uView', 'uProjection', 'uCenter', 'uColor', 'uOpacity', 'uEdges', 'uSliceCount', 'uSlicePlanes[0]']
      .map(name => [name, gl.getUniformLocation(this.program, name)]));
    this.vao = gl.createVertexArray(); this.buffer = gl.createBuffer(); this.indexBuffer = gl.createBuffer();
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (let attribute = 0; attribute < 2; attribute++) {
      gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 24, attribute * 12);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer); gl.bindVertexArray(null);
    this.geometry = null; this.options = normalizeVoronoiCellOptions();
    this.vertexCount = this.indexCount = this.edgeCount = this.renderedReplicaCount = 0;
  }

  setGeometry(geometry, options = {}) {
    this.options = normalizeVoronoiCellOptions(options, this.options);
    if (geometry === this.geometry) return;
    const mesh = geometry ? createVoronoiCellMesh(geometry) : null;
    this.geometry = geometry;
    this.vertexCount = mesh?.vertexCount ?? 0; this.indexCount = mesh?.indexCount ?? 0; this.edgeCount = mesh?.edgeCount ?? 0;
    this.renderedReplicaCount = 0;
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
    this.renderedReplicaCount = 0;
    const atom = this.geometry?.atomIndex;
    if (!this.options.enabled || !this.indexCount || !renderer.frame || atom >= renderer.atomCount || !renderer.visibility?.[atom]) return;
    const gl = this.gl, u = this.uniforms, planes = dislocationSlicePlanes(renderer);
    gl.useProgram(this.program); gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(u.uView, false, renderer.viewMatrix); gl.uniformMatrix4fv(u.uProjection, false, renderer.projectionMatrix);
    gl.uniform3f(u.uColor, ...parsePrimitiveColor(this.options.color));
    gl.uniform1i(u.uSliceCount, planes.count); gl.uniform4fv(u['uSlicePlanes[0]'], planes.values);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.CULL_FACE); gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -1);
    for (const replica of renderer.replicas) {
      gl.uniform3f(u.uCenter, ...replica.offset.map((value, axis) => value + renderer.displayPositions[atom * 3 + axis]));
      gl.uniform1i(u.uEdges, 0); gl.uniform1f(u.uOpacity, this.options.opacity);
      // A convex cell has one rear and one front surface along each ray.
      // Draw those in order so translucent shading is independent of the
      // scientific face traversal order, without sorting/rebuilding the mesh.
      gl.cullFace(gl.FRONT);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
      gl.cullFace(gl.BACK);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
      gl.uniform1i(u.uEdges, 1); gl.uniform1f(u.uOpacity, 0.9);
      gl.drawArrays(gl.LINES, this.vertexCount, this.edgeCount);
      this.renderedReplicaCount++;
    }
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.depthMask(true); gl.enable(gl.CULL_FACE); gl.disable(gl.BLEND);
  }
}

function createProgram(gl) {
  const program = gl.createProgram();
  for (const [kind, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
    const shader = gl.createShader(kind); gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Voronoi cell shader failed: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program, shader); gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Voronoi cell shader linking failed: ${gl.getProgramInfoLog(program)}`);
  return program;
}
