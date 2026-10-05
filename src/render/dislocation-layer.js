import { invert3 } from '../data/model.js';
import { DXA_FAMILIES, splitPeriodicPolyline } from '../analysis/dxa.js';
import { parsePrimitiveColor } from './atom-primitives.js';
import { appendDislocationTube, createDislocationCurve } from './dislocation-curves.js';
import { MAX_SLICES, SLICE_EPSILON } from './slicing.js';

// A dislocation is a geometric curve, not a bond between two atom indices.
// Keep the connected source-cell tube pieces in one indexed buffer. Periodic display
// images and slice planes are uniforms, so neither repeats nor dragging a
// slice reconstructs the full dislocation network.
const VERTEX = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec3 aCenter;
layout(location=1) in vec3 aRadial;
layout(location=2) in vec3 aNormal;
layout(location=3) in vec3 aColor;
uniform mat4 uView;
uniform mat4 uProjection;
uniform vec3 uReplicaOffset;
uniform float uRadius;
out vec3 vNormal;
out vec3 vWorld;
flat out vec3 vColor;
void main() {
  vWorld = aCenter + uReplicaOffset + aRadial * uRadius;
  vNormal = mat3(uView) * aNormal;
  vColor = aColor;
  gl_Position = uProjection * uView * vec4(vWorld, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec3 vNormal;
in vec3 vWorld;
flat in vec3 vColor;
uniform int uSliceCount;
uniform vec4 uSlicePlanes[${MAX_SLICES}];
out vec4 outColor;
void main() {
  for (int plane = 0; plane < ${MAX_SLICES}; plane++) {
    if (plane >= uSliceCount) break;
    if (dot(uSlicePlanes[plane].xyz, vWorld) > uSlicePlanes[plane].w + ${SLICE_EPSILON}) discard;
  }
  vec3 normal = normalize(vNormal);
  vec3 key = normalize(vec3(-0.48, 0.62, 0.72));
  vec3 fill = normalize(vec3(0.68, -0.36, 0.48));
  float light = 0.30 + 0.64 * max(0.0, dot(normal, key)) + 0.16 * max(0.0, dot(normal, fill));
  float specular = 0.14 * pow(max(0.0, dot(normal, normalize(key + vec3(0.0, 0.0, 1.0)))), 28.0);
  vec3 linearColor = pow(vColor, vec3(2.2)) * light + vec3(specular);
  outColor = vec4(pow(clamp(linearColor, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

function normalizedColor(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    if (value.length !== 3 || !Array.from(value).every(component => Number.isFinite(component) && component >= 0 && component <= 255)) {
      throw new Error('Dislocation colors require three RGB components.');
    }
    return Array.from(value, component => component / (Math.max(...value) > 1 ? 255 : 1));
  }
  return parsePrimitiveColor(value);
}

export function normalizeDislocationOptions(options = {}, previous = {}) {
  const radius = options.radius ?? previous.radius ?? 0.2;
  if (!Number.isFinite(radius) || radius <= 0) throw new Error('Dislocation line radius must be greater than zero.');
  const selected = Object.hasOwn(options, 'visibleFamilies') ? options.visibleFamilies : previous.visibleFamilies ?? null;
  if (selected !== null && !Array.isArray(selected) && !(selected instanceof Set)) {
    throw new Error('Visible dislocation families must be an array or set.');
  }
  const visibleFamilies = selected === null ? null : Array.from(selected);
  if (visibleFamilies?.some(id => typeof id !== 'string')) throw new Error('Dislocation family identifiers must be strings.');
  const familyVisibility = { ...(previous.familyVisibility ?? {}), ...(options.familyVisibility ?? {}) };
  if (Object.values(familyVisibility).some(value => typeof value !== 'boolean')) throw new Error('Dislocation family visibility must be true or false.');
  const familyColors = { ...(previous.familyColors ?? {}), ...(options.familyColors ?? {}) };
  for (const [id, color] of Object.entries(familyColors)) familyColors[id] = normalizedColor(color);
  return {
    enabled: Boolean(options.enabled ?? options.visible ?? previous.enabled ?? true),
    radius, visibleFamilies, familyVisibility, familyColors,
  };
}

function pointArray(points) {
  if (Array.isArray(points) && Array.isArray(points[0])) points = points.flat();
  if ((!Array.isArray(points) && !ArrayBuffer.isView(points)) || points.length < 6 || points.length % 3 !== 0) {
    throw new Error('A dislocation curve requires at least two XYZ points.');
  }
  for (const value of points) if (!Number.isFinite(value)) throw new Error('Dislocation curve coordinates must be finite.');
  return points;
}

/** Source-cell edge data retained for consumers of the original display helper.
 * The renderer uses the continuous tube mesh below, rather than these edges.
 */
export function createDislocationInstances(network, cell, options = {}) {
  const settings = normalizeDislocationOptions(options), values = [];
  const families = DXA_FAMILIES[network?.parameters?.lattice ?? 'fcc'] ?? [];
  const colors = new Map(families.map(family => [family.id, normalizedColor(family.color)]));
  const selected = settings.visibleFamilies === null ? null : new Set(settings.visibleFamilies);
  if (!network || !Array.isArray(network.segments)) throw new Error('A dislocation network requires a segment list.');
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (const segment of network.segments) {
    const family = segment.familyId ?? segment.family ?? 'other';
    if ((selected && !selected.has(family)) || settings.familyVisibility[family] === false) continue;
    const color = settings.familyColors[family] ?? colors.get(family) ?? [0.88, 0.34, 0.34];
    const curves = splitPeriodicPolyline(pointArray(segment.points), cell);
    for (const points of curves) {
      for (let offset = 0; offset < points.length - 3; offset += 3) {
        const first = [points[offset], points[offset + 1], points[offset + 2]];
        const last = [points[offset + 3], points[offset + 4], points[offset + 5]];
        if (Math.hypot(...last.map((value, axis) => value - first[axis])) <= 1e-12) continue;
        values.push(...first, ...last, ...color);
        for (let axis = 0; axis < 3; axis += 1) {
          minimum[axis] = Math.min(minimum[axis], first[axis], last[axis]);
          maximum[axis] = Math.max(maximum[axis], first[axis], last[axis]);
        }
      }
    }
  }
  return { values: Float32Array.from(values), count: values.length / 9, minimum, maximum };
}

/** Build smooth, connected source-cell tubes without altering analysis data. */
export function createDislocationTubeGeometry(network, cell, options = {}) {
  const settings = normalizeDislocationOptions(options), values = [], indices = [], curves = [];
  const families = DXA_FAMILIES[network?.parameters?.lattice ?? 'fcc'] ?? [];
  const colors = new Map(families.map(family => [family.id, normalizedColor(family.color)]));
  const selected = settings.visibleFamilies === null ? null : new Set(settings.visibleFamilies);
  if (!network || !Array.isArray(network.segments)) throw new Error('A dislocation network requires a segment list.');
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (const segment of network.segments) {
    const family = segment.familyId ?? segment.family ?? 'other';
    if ((selected && !selected.has(family)) || settings.familyVisibility[family] === false) continue;
    const color = settings.familyColors[family] ?? colors.get(family) ?? [0.88, 0.34, 0.34];
    for (const curve of createDislocationCurve(pointArray(segment.points), cell, segment.closed ?? null)) {
      const mesh = appendDislocationTube(values, indices, curve, color);
      curves.push({ segmentId: segment.id, familyId: family, ...mesh });
      for (let index = 0; index < mesh.points.length; index += 3) {
        for (let axis = 0; axis < 3; axis += 1) {
          minimum[axis] = Math.min(minimum[axis], mesh.points[index + axis]);
          maximum[axis] = Math.max(maximum[axis], mesh.points[index + axis]);
        }
      }
    }
  }
  return { values: Float32Array.from(values), indices: Uint32Array.from(indices), curves, count: curves.length,
    vertexCount: values.length / 12, indexCount: indices.length, minimum, maximum };
}

/** Centerline/half-space intersection, including segments whose endpoints are
 * outside different planes but which cross the visible volume in between. */
export function clipDislocationSegment(start, end, slices, epsilon = SLICE_EPSILON) {
  let lower = 0, upper = 1;
  const delta = end.map((value, axis) => value - start[axis]);
  for (const slice of slices) {
    if (!slice.enabled) continue;
    const sign = slice.side === 'positive' ? -1 : 1;
    const distance = sign * (slice.normal.reduce((sum, value, axis) => sum + value * start[axis], 0) - slice.position);
    const slope = sign * slice.normal.reduce((sum, value, axis) => sum + value * delta[axis], 0);
    if (Math.abs(slope) < 1e-12) { if (distance > epsilon) return null; }
    else if (slope > 0) upper = Math.min(upper, (epsilon - distance) / slope);
    else lower = Math.max(lower, (epsilon - distance) / slope);
    if (upper <= lower) return null;
  }
  return [start.map((value, axis) => value + delta[axis] * lower), start.map((value, axis) => value + delta[axis] * upper)];
}

/** Convert the old fractional-axis slice to the same Cartesian half-space
 * representation. The inverse column is essential for triclinic cells. */
export function dislocationSlicePlanes(renderer) {
  if (renderer.sliceMode === 'planes') {
    return { count: renderer.sliceCount ?? 0, values: renderer.slicePlaneValues ?? new Float32Array(MAX_SLICES * 4) };
  }
  const axis = renderer.sliceAxis ?? 2, inverse = invert3(renderer.frame.cell.vectors);
  const normal = [inverse[axis], inverse[3 + axis], inverse[6 + axis]], norm = Math.hypot(...normal);
  const origin = renderer.frame.cell.origin;
  const position = (renderer.sliceMaximum ?? 1) * (renderer.repetitions?.[axis] ?? 1)
    + normal.reduce((sum, value, component) => sum + value * origin[component], 0);
  const values = new Float32Array(MAX_SLICES * 4);
  values.set(normal.map(value => value / norm));
  values[3] = position / norm;
  return { count: 1, values };
}

export class DislocationLayer {
  constructor(gl) {
    this.gl = gl;
    this.program = createProgram(gl);
    this.uniforms = Object.fromEntries(['uView', 'uProjection', 'uReplicaOffset', 'uRadius', 'uSliceCount', 'uSlicePlanes[0]']
      .map(name => [name, gl.getUniformLocation(this.program, name)]));
    this.vao = gl.createVertexArray();
    this.meshBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer);
    for (let attribute = 0; attribute < 4; attribute += 1) {
      gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 48, attribute * 12);
      gl.vertexAttribDivisor(attribute, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bindVertexArray(null);
    this.options = normalizeDislocationOptions();
    this.network = null;
    this.count = 0;
    this.vertexCount = this.indexCount = 0;
    this.geometry = null;
  }

  setNetwork(renderer, network, options = {}) {
    const normalized = normalizeDislocationOptions(options, this.options);
    const appearanceKey = JSON.stringify([normalized.visibleFamilies, normalized.familyVisibility, normalized.familyColors]);
    if (network && (this.network !== network || this.cell !== renderer.frame.cell || this.appearanceKey !== appearanceKey)) {
      const geometry = createDislocationTubeGeometry(network, renderer.frame.cell, normalized);
      this.minimum = geometry.minimum;
      this.maximum = geometry.maximum;
      this.count = geometry.count;
      this.vertexCount = geometry.vertexCount;
      this.indexCount = geometry.indexCount;
      this.geometry = { curves: geometry.curves, vertexCount: geometry.vertexCount, indexCount: geometry.indexCount };
      this.gl.bindVertexArray(this.vao);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.meshBuffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, geometry.values, this.gl.STATIC_DRAW);
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, geometry.indices, this.gl.STATIC_DRAW);
      this.gl.bindVertexArray(null);
    } else if (!network) this.clear();
    this.options = normalized;
    this.network = network;
    this.cell = renderer.frame?.cell ?? null;
    this.appearanceKey = appearanceKey;
  }

  clear() {
    this.network = null;
    this.count = 0;
    this.vertexCount = this.indexCount = 0;
    this.geometry = null;
    this.minimum = this.maximum = null;
    this.gl.bindVertexArray(this.vao);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.meshBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, 0, this.gl.STATIC_DRAW);
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, 0, this.gl.STATIC_DRAW);
    this.gl.bindVertexArray(null);
  }

  render(renderer) {
    if (!this.network || !this.count || !this.options.enabled) return;
    const gl = this.gl, u = this.uniforms, planes = dislocationSlicePlanes(renderer);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(u.uView, false, renderer.viewMatrix);
    gl.uniformMatrix4fv(u.uProjection, false, renderer.projectionMatrix);
    gl.uniform1f(u.uRadius, this.options.radius);
    gl.uniform1i(u.uSliceCount, planes.count);
    gl.uniform4fv(u['uSlicePlanes[0]'], planes.values);
    for (const replica of renderer.replicas) {
      gl.uniform3f(u.uReplicaOffset, ...replica.offset);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    }
  }

  extendBounds(renderer, minimum, maximum) {
    if (!this.count || !this.options.enabled) return;
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], this.minimum[axis] + (renderer.minimumOffset?.[axis] ?? 0) - this.options.radius);
      maximum[axis] = Math.max(maximum[axis], this.maximum[axis] + (renderer.maximumOffset?.[axis] ?? 0) + this.options.radius);
    }
  }
}

function createProgram(gl) {
  const program = gl.createProgram();
  for (const [kind, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
    const shader = gl.createShader(kind);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Dislocation shader failed: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Dislocation shader linking failed: ${gl.getProgramInfoLog(program)}`);
  return program;
}
