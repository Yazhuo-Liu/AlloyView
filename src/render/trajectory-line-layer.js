import { MAX_SLICE_PLANES, SLICE_EPSILON } from './slicing.js';
import { dislocationSlicePlanes } from './dislocation-layer.js';
import { effectivePeriodicOrigin } from './periodic-origin.js';
import { SCALAR_COLOR_SCHEMES, colorMapStops } from './palette.js';
import { MAX_COLOR_STOPS } from './scalar-colormap.js';
import { MAX_TRAJECTORY_LINE_WIDTH, MIN_TRAJECTORY_LINE_WIDTH, TRAJECTORY_LINE_DEFAULTS } from '../data/trajectory-tools.js';

export { MAX_TRAJECTORY_LINE_WIDTH, MIN_TRAJECTORY_LINE_WIDTH, TRAJECTORY_LINE_DEFAULTS };

const SCHEMES = new Set(SCALAR_COLOR_SCHEMES.map(({ value }) => value));

// One instance per segment between consecutive path vertices. Each segment
// is a screen-space ribbon of constant pixel width with square caps that
// close the joints. Widths are CSS pixels; image exports multiply them by the
// export line scale, so lines keep their proportion at any resolution.
const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec4 aFirst;
layout(location=1) in vec4 aLast;
uniform mat4 uViewProjection;
uniform vec2 uViewport;
uniform float uWidth;
uniform vec3 uOffset;
out vec3 vWorld;
out float vTime;
void main() {
  // A negative time marks the last point of a path: no segment follows it.
  if (aFirst.w < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 firstWorld = aFirst.xyz + uOffset, lastWorld = aLast.xyz + uOffset;
  float firstTime = aFirst.w, lastTime = aLast.w < 0.0 ? -aLast.w - 1.0 : aLast.w;
  vec4 first = uViewProjection * vec4(firstWorld, 1.0);
  vec4 last = uViewProjection * vec4(lastWorld, 1.0);
  float firstNear = first.z + first.w, lastNear = last.z + last.w;
  if (firstNear < 0.0 && lastNear < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (firstNear < 0.0) {
    float amount = firstNear / (firstNear - lastNear);
    first = mix(first, last, amount); firstWorld = mix(firstWorld, lastWorld, amount); firstTime = mix(firstTime, lastTime, amount);
  } else if (lastNear < 0.0) {
    float amount = lastNear / (lastNear - firstNear);
    last = mix(last, first, amount); lastWorld = mix(lastWorld, firstWorld, amount); lastTime = mix(lastTime, firstTime, amount);
  }
  vec2 direction = (last.xy / last.w - first.xy / first.w) * uViewport;
  float lengthSquared = dot(direction, direction);
  if (lengthSquared < 1e-12) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 tangent = direction * inversesqrt(lengthSquared);
  vec2 normal = vec2(-tangent.y, tangent.x);
  bool atLast = gl_VertexID >= 2;
  vec4 clip = atLast ? last : first;
  vWorld = atLast ? lastWorld : firstWorld;
  vTime = atLast ? lastTime : firstTime;
  float side = gl_VertexID % 2 == 0 ? 1.0 : -1.0;
  vec2 offset = side * normal + (atLast ? 1.0 : -1.0) * tangent;
  clip.xy += offset * uWidth / uViewport * clip.w;
  gl_Position = clip;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec3 vWorld;
in float vTime;
uniform int uSliceCount;
uniform vec4 uSlicePlanes[${MAX_SLICE_PLANES}];
uniform bool uColorByTime;
uniform vec3 uColor;
uniform int uColorStopCount;
uniform vec4 uColorStops[${MAX_COLOR_STOPS}];
out vec4 outColor;
void main() {
  for (int plane = 0; plane < ${MAX_SLICE_PLANES}; plane++) {
    if (plane >= uSliceCount) break;
    if (dot(uSlicePlanes[plane].xyz, vWorld) > uSlicePlanes[plane].w + ${SLICE_EPSILON}) discard;
  }
  vec3 color = uColor;
  if (uColorByTime) {
    float amount = clamp(vTime, 0.0, 1.0);
    vec4 left = uColorStops[0], right = left;
    for (int index = 1; index < ${MAX_COLOR_STOPS}; index++) {
      if (index >= uColorStopCount) break;
      right = uColorStops[index];
      if (right.x >= amount) break;
      left = right;
    }
    float fraction = right.x > left.x ? (amount - left.x) / (right.x - left.x) : 0.0;
    color = mix(left.yzw, right.yzw, fraction) / 255.0;
  }
  outColor = vec4(color, 1.0);
}`;

function hexColor(value) {
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw new Error('Trajectory line colors must be six-digit hex colors.');
  return value.toLowerCase();
}

export function normalizeTrajectoryLineOptions(options = {}, previous = TRAJECTORY_LINE_DEFAULTS) {
  const merged = { ...previous, ...options };
  const width = Number(merged.width);
  if (!Number.isFinite(width) || width < MIN_TRAJECTORY_LINE_WIDTH || width > MAX_TRAJECTORY_LINE_WIDTH) {
    throw new Error(`Trajectory line width must be from ${MIN_TRAJECTORY_LINE_WIDTH} to ${MAX_TRAJECTORY_LINE_WIDTH} pixels.`);
  }
  if (!SCHEMES.has(merged.colorScheme)) throw new Error(`Unknown trajectory line color scheme “${merged.colorScheme}”.`);
  return { visible: Boolean(merged.visible), color: hexColor(merged.color), width,
    colorByTime: Boolean(merged.colorByTime), colorScheme: merged.colorScheme };
}

function checkLines(lines) {
  const count = lines?.vertexCount;
  if (!Number.isSafeInteger(count) || count < 0 || !(lines.vertices instanceof Float32Array) || lines.vertices.length !== count * 4) {
    throw new Error('Trajectory lines require four float32 values per vertex.');
  }
  return count;
}

export class TrajectoryLineLayer {
  constructor(gl) {
    this.gl = gl;
    const program = gl.createProgram(), shaders = [];
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
        const shader = gl.createShader(type); shaders.push(shader);
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Trajectory line shader failed: ${gl.getShaderInfoLog(shader)}`);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Trajectory line shader linking failed: ${gl.getProgramInfoLog(program)}`);
    } catch (error) { gl.deleteProgram(program); throw error; }
    finally { for (const shader of shaders) gl.deleteShader(shader); }
    this.program = program;
    this.uniforms = Object.fromEntries(['uViewProjection', 'uViewport', 'uWidth', 'uOffset', 'uSliceCount', 'uSlicePlanes[0]',
      'uColorByTime', 'uColor', 'uColorStopCount', 'uColorStops[0]'].map(name => [name, gl.getUniformLocation(program, name)]));
    this.vao = gl.createVertexArray();
    this.buffer = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (const location of [0, 1]) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 16, location * 16);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
    this.lines = null;
    this.count = 0;
    this.options = normalizeTrajectoryLineOptions();
  }

  setLines(lines, options = {}) {
    this.options = normalizeTrajectoryLineOptions(options, this.options);
    if (!lines) { this.clear(); return; }
    if (lines !== this.lines) {
      this.count = checkLines(lines);
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, lines.vertices, gl.STATIC_DRAW);
      this.lines = lines;
    }
  }

  clear() {
    this.lines = null;
    this.count = 0;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.STATIC_DRAW);
  }

  /** Lines are unwrapped paths in Cartesian space. They move with the
   * periodic display origin like unwrapped atoms, and repeat with display
   * copies of the cell. */
  displayShift(renderer) {
    const cell = renderer.frame?.cell;
    if (!cell) return [0, 0, 0];
    const origin = effectivePeriodicOrigin(renderer.periodicOrigin ?? [0, 0, 0], cell), h = cell.vectors;
    return [0, 1, 2].map(axis => -(origin[0] * h[axis] + origin[1] * h[3 + axis] + origin[2] * h[6 + axis]));
  }

  render(renderer) {
    if (!this.lines || this.count < 2 || !this.options.visible) return;
    const gl = this.gl, u = this.uniforms, viewport = renderer.renderViewport;
    const canvas = renderer.canvas;
    const pixelRatio = Math.max(1, canvas.width / (Number(canvas.clientWidth) || canvas.width));
    const width = this.options.width * pixelRatio * (viewport?.lineScale ?? 1);
    const size = viewport ? [viewport.tile.renderWidth, viewport.tile.renderHeight] : [canvas.width, canvas.height];
    const planes = dislocationSlicePlanes(renderer), shift = this.displayShift(renderer);
    const color = [1, 3, 5].map(offset => parseInt(this.options.color.slice(offset, offset + 2), 16) / 255);
    const stops = colorMapStops(this.options.colorScheme), values = new Float32Array(MAX_COLOR_STOPS * 4);
    stops.slice(0, MAX_COLOR_STOPS).forEach((stop, index) => values.set(stop, index * 4));
    const culling = gl.isEnabled(gl.CULL_FACE);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(u.uViewProjection, false, renderer.viewProjectionMatrix);
    gl.uniform2f(u.uViewport, size[0], size[1]);
    gl.uniform1f(u.uWidth, width);
    gl.uniform1i(u.uSliceCount, planes.count);
    gl.uniform4fv(u['uSlicePlanes[0]'], planes.values);
    gl.uniform1i(u.uColorByTime, this.options.colorByTime ? 1 : 0);
    gl.uniform3f(u.uColor, ...color);
    gl.uniform1i(u.uColorStopCount, Math.min(MAX_COLOR_STOPS, stops.length));
    gl.uniform4fv(u['uColorStops[0]'], values);
    for (const replica of renderer.replicas) {
      gl.uniform3f(u.uOffset, replica.offset[0] + shift[0], replica.offset[1] + shift[1], replica.offset[2] + shift[2]);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count - 1);
    }
    gl.bindVertexArray(null);
    if (culling) gl.enable(gl.CULL_FACE);
  }

  extendBounds(renderer, minimum, maximum) {
    const bounds = this.lines?.bounds;
    if (!bounds || !this.options.visible) return;
    const shift = this.displayShift(renderer);
    for (let axis = 0; axis < 3; axis += 1) {
      minimum[axis] = Math.min(minimum[axis], bounds.minimum[axis] + shift[axis] + (renderer.minimumOffset?.[axis] ?? 0));
      maximum[axis] = Math.max(maximum[axis], bounds.maximum[axis] + shift[axis] + (renderer.maximumOffset?.[axis] ?? 0));
    }
  }
}
