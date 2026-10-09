import { MAX_SLICE_PLANES, SLICE_EPSILON } from './slicing.js';
import { periodicDisplayCoordinates } from './periodic-origin.js';

// Point markers at positions that carry no atom, such as vacant Wigner–Seitz
// sites. They are camera-facing sphere impostors like atoms, with a dark rim so
// a marker is not mistaken for an atom. Slices hide a marker by its center,
// exactly as they hide atoms; atom visibility filters do not apply.
const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aCenter;
layout(location=2) in vec3 aColor;
layout(location=3) in vec3 aFractional;
uniform mat4 uView;
uniform mat4 uProjection;
uniform float uRadius;
uniform int uSliceAxis;
uniform float uSliceMaximum;
uniform int uSliceMode;
uniform int uSliceCount;
uniform vec4 uSlicePlanes[${MAX_SLICE_PLANES}];
uniform vec3 uReplicaOffset;
uniform vec3 uReplicaIndex;
uniform vec3 uRepetitions;
out vec2 vCorner;
out vec3 vColor;
out vec3 vCenterView;
void main() {
  vec3 worldCenter = aCenter + uReplicaOffset;
  vec4 centerView = uView * vec4(worldCenter, 1.0);
  gl_Position = uProjection * (centerView + vec4(aCorner * uRadius, 0.0, 0.0));
  vCorner = aCorner;
  vColor = aColor;
  vCenterView = centerView.xyz;
  bool visible = true;
  if (uSliceMode == 0) {
    visible = (aFractional[uSliceAxis] + uReplicaIndex[uSliceAxis]) / uRepetitions[uSliceAxis] <= uSliceMaximum;
  } else {
    for (int plane = 0; plane < ${MAX_SLICE_PLANES}; plane++) {
      if (plane >= uSliceCount) break;
      if (dot(uSlicePlanes[plane].xyz, worldCenter) > uSlicePlanes[plane].w + ${SLICE_EPSILON}) { visible = false; break; }
    }
  }
  if (!visible) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vCorner;
in vec3 vColor;
in vec3 vCenterView;
uniform mat4 uProjection;
uniform float uRadius;
out vec4 outColor;
void main() {
  float radiusSquared = dot(vCorner, vCorner);
  if (radiusSquared > 1.0) discard;
  float normalZ = sqrt(max(0.0, 1.0 - radiusSquared));
  vec3 normal = vec3(vCorner, normalZ);
  float light = 0.34 + 0.62 * max(0.0, dot(normal, normalize(vec3(-0.48, 0.62, 0.72))));
  vec3 shaded = pow(clamp(pow(vColor, vec3(2.2)) * light, 0.0, 1.0), vec3(1.0 / 2.2));
  shaded = mix(shaded, vec3(0.06), smoothstep(0.62, 0.8, radiusSquared));
  vec4 surfaceClip = uProjection * vec4(vCenterView + vec3(vCorner * uRadius, normalZ * uRadius), 1.0);
  gl_FragDepth = surfaceClip.z / surfaceClip.w * 0.5 + 0.5;
  outColor = vec4(shaded, 1.0 - smoothstep(0.965, 1.0, radiusSquared));
}`;

export function normalizeSiteMarkerOptions(options = {}, previous = {}) {
  const radius = options.radius ?? previous.radius ?? 0.6;
  if (!Number.isFinite(radius) || radius <= 0) throw new Error('Site marker radius must be greater than zero.');
  return { visible: Boolean(options.visible ?? previous.visible ?? true), radius };
}

/** Display coordinates of Cartesian marker positions, wrapped into the shown
 * periodic cell with the renderer's periodic display origin. */
export function siteMarkerDisplayCoordinates(positions, cell, periodicOrigin = [0, 0, 0]) {
  if (!positions.length) return { positions: new Float64Array(0), fractional: new Float64Array(0) };
  return periodicDisplayCoordinates(positions, cell, periodicOrigin, { wrap: true });
}

/** `markers` holds Cartesian `positions` (3 per marker) and byte RGB `colors`. */
export class SiteMarkerLayer {
  constructor(gl) {
    this.gl = gl;
    this.program = createProgram(gl);
    this.uniforms = Object.fromEntries(['uView', 'uProjection', 'uRadius', 'uSliceAxis', 'uSliceMaximum', 'uSliceMode',
      'uSliceCount', 'uSlicePlanes[0]', 'uReplicaOffset', 'uReplicaIndex', 'uRepetitions'].map(name => [name, gl.getUniformLocation(this.program, name)]));
    this.vao = gl.createVertexArray();
    this.quadBuffer = gl.createBuffer();
    this.positionBuffer = gl.createBuffer();
    this.colorBuffer = gl.createBuffer();
    this.fractionalBuffer = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (const [location, buffer, size, type, normalized] of [[1, this.positionBuffer, 3, gl.FLOAT, false],
      [2, this.colorBuffer, 3, gl.UNSIGNED_BYTE, true], [3, this.fractionalBuffer, 3, gl.FLOAT, false]]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, type, normalized, 0, 0);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
    this.options = normalizeSiteMarkerOptions();
    this.markers = null;
    this.count = 0;
    this.displayKey = null;
    this.minimum = this.maximum = null;
  }

  setMarkers(renderer, markers, options = {}) {
    const normalized = normalizeSiteMarkerOptions(options, this.options);
    if (markers) {
      const count = markers.positions?.length / 3;
      if (!Number.isInteger(count) || markers.colors?.length !== count * 3) throw new Error('Site markers need three coordinates and three color bytes each.');
      for (const value of markers.positions) if (!Number.isFinite(value)) throw new Error('Site marker coordinates must be finite.');
      if (markers !== this.markers) {
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.colorBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, markers.colors instanceof Uint8Array ? markers.colors : Uint8Array.from(markers.colors), this.gl.STATIC_DRAW);
        this.displayKey = null;
      }
      this.markers = markers;
      this.count = count;
      this.options = normalized;
      this.refresh(renderer);
    } else {
      this.clear();
      this.options = normalized;
    }
  }

  /** Recompute display coordinates after the frame cell or periodic display
   * origin changed; uploads happen only when either differs. */
  refresh(renderer) {
    if (!this.markers || !renderer.frame) return;
    const origin = renderer.periodicOrigin ?? [0, 0, 0];
    const key = [renderer.frame.cell, ...origin];
    if (this.displayKey && key.every((value, index) => Object.is(value, this.displayKey[index]))) return;
    const display = siteMarkerDisplayCoordinates(this.markers.positions, renderer.frame.cell, origin);
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, Float32Array.from(display.positions), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fractionalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, Float32Array.from(display.fractional), gl.STATIC_DRAW);
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < display.positions.length; index += 1) {
      const axis = index % 3, value = display.positions[index];
      if (value < minimum[axis]) minimum[axis] = value;
      if (value > maximum[axis]) maximum[axis] = value;
    }
    this.minimum = minimum; this.maximum = maximum;
    this.displayPositions = display.positions;
    this.displayKey = key;
  }

  clear() {
    this.markers = null;
    this.count = 0;
    this.displayKey = null;
    this.displayPositions = null;
    this.minimum = this.maximum = null;
    const gl = this.gl;
    for (const buffer of [this.positionBuffer, this.colorBuffer, this.fractionalBuffer]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, 0, gl.STATIC_DRAW);
    }
  }

  render(renderer) {
    if (!this.count || !this.options.visible || !renderer.frame) return;
    this.refresh(renderer);
    const gl = this.gl, u = this.uniforms;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(u.uView, false, renderer.viewMatrix);
    gl.uniformMatrix4fv(u.uProjection, false, renderer.projectionMatrix);
    gl.uniform1f(u.uRadius, this.options.radius);
    gl.uniform1i(u.uSliceAxis, renderer.sliceAxis ?? 2);
    gl.uniform1f(u.uSliceMaximum, renderer.sliceMaximum ?? 1);
    gl.uniform1i(u.uSliceMode, renderer.sliceMode === 'planes' ? 1 : 0);
    gl.uniform1i(u.uSliceCount, renderer.sliceCount ?? 0);
    gl.uniform4fv(u['uSlicePlanes[0]'], renderer.slicePlaneValues ?? new Float32Array(MAX_SLICE_PLANES * 4));
    gl.uniform3f(u.uRepetitions, ...(renderer.repetitions ?? [1, 1, 1]));
    for (const replica of renderer.replicas ?? [{ indices: [0, 0, 0], offset: [0, 0, 0] }]) {
      gl.uniform3f(u.uReplicaOffset, ...replica.offset);
      gl.uniform3f(u.uReplicaIndex, ...replica.indices);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    }
    this.renderedReplicaCount = (renderer.replicas ?? [null]).length;
  }

  extendBounds(renderer, minimum, maximum) {
    if (!this.count || !this.options.visible) return;
    this.refresh(renderer);
    if (!this.minimum) return;
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
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Site marker shader failed: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Site marker shader linking failed: ${gl.getProgramInfoLog(program)}`);
  return program;
}
