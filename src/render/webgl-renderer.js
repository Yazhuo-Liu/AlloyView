import { cellVertices } from '../data/model.js';
import {
  add,
  cross,
  lookAt,
  multiply4,
  normalize,
  orthographic,
  perspective,
  scale,
  subtract,
  transformPoint,
} from './math.js';

const SPHERE_VERTEX = `#version 300 es
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
uniform int uSelected;
out vec2 vCorner;
out vec3 vColor;
out vec3 vCenterView;
flat out int vVisible;
flat out int vSelected;
void main() {
  vec4 centerView = uView * vec4(aCenter, 1.0);
  vec4 cornerView = centerView + vec4(aCorner * uRadius, 0.0, 0.0);
  gl_Position = uProjection * cornerView;
  vCorner = aCorner;
  vColor = aColor;
  vCenterView = centerView.xyz;
  vVisible = aFractional[uSliceAxis] <= uSliceMaximum ? 1 : 0;
  vSelected = gl_InstanceID == uSelected ? 1 : 0;
}`;

const SPHERE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vCorner;
in vec3 vColor;
in vec3 vCenterView;
flat in int vVisible;
flat in int vSelected;
uniform mat4 uProjection;
uniform float uRadius;
out vec4 outColor;
void main() {
  if (vVisible == 0) discard;
  float radiusSquared = dot(vCorner, vCorner);
  if (radiusSquared > 1.0) discard;
  float normalZ = sqrt(max(0.0, 1.0 - radiusSquared));
  vec3 normal = vec3(vCorner, normalZ);
  vec3 lightDirection = normalize(vec3(-0.42, 0.58, 0.72));
  float diffuse = max(0.0, dot(normal, lightDirection));
  float rim = pow(1.0 - normalZ, 2.0) * 0.10;
  vec3 shaded = vColor * (0.32 + 0.68 * diffuse) + vec3(rim);
  if (vSelected == 1) {
    float ring = smoothstep(0.68, 0.84, radiusSquared);
    shaded = mix(shaded * 1.14, vec3(1.0, 0.69, 0.24), ring);
  }
  vec3 surfaceView = vCenterView + vec3(vCorner * uRadius, normalZ * uRadius);
  vec4 surfaceClip = uProjection * vec4(surfaceView, 1.0);
  gl_FragDepth = surfaceClip.z / surfaceClip.w * 0.5 + 0.5;
  float alpha = 1.0 - smoothstep(0.965, 1.0, radiusSquared);
  outColor = vec4(shaded, alpha);
}`;

const LINE_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
uniform mat4 uViewProjection;
void main() { gl_Position = uViewProjection * vec4(aPosition, 1.0); }`;

const LINE_FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 outColor;
void main() { outColor = vec4(uColor, 0.92); }`;

const CELL_EDGES = [
  0, 1, 0, 2, 0, 4, 1, 3, 1, 5, 2, 3,
  2, 6, 4, 5, 4, 6, 3, 7, 5, 7, 6, 7,
];

export class WebGLRenderer {
  constructor(canvas, { onPick = () => {}, onStats = () => {} } = {}) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: true,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!this.gl) throw new Error('WebGL 2 is not available in this browser or on this GPU.');
    this.onPick = onPick;
    this.onStats = onStats;
    this.frame = null;
    this.displayPositions = null;
    this.atomCount = 0;
    this.radius = 0.7;
    this.background = [7 / 255, 16 / 255, 24 / 255];
    this.cellVisible = true;
    this.sliceAxis = 2;
    this.sliceMaximum = 1;
    this.selected = -1;
    this.projectionMode = 'perspective';
    this.fov = 40 * Math.PI / 180;
    this.yaw = -0.62;
    this.pitch = 0.38;
    this.target = [0, 0, 0];
    this.pan = [0, 0, 0];
    this.distance = 10;
    this.orthographicScale = 5;
    this.modelRadius = 5;
    this.viewMatrix = new Float32Array(16);
    this.projectionMatrix = new Float32Array(16);
    this.viewProjectionMatrix = new Float32Array(16);
    this.frameTimes = [];
    this.lastStatsAt = 0;
    this.renderRequested = false;
    this.initializeGl();
    this.installInteractions();
    this.resizeObserver = new ResizeObserver(() => this.requestRender());
    this.resizeObserver.observe(canvas);
    this.requestRender();
  }

  initializeGl() {
    const gl = this.gl;
    this.sphereProgram = createProgram(gl, SPHERE_VERTEX, SPHERE_FRAGMENT);
    this.lineProgram = createProgram(gl, LINE_VERTEX, LINE_FRAGMENT);
    this.sphereVao = gl.createVertexArray();
    this.positionBuffer = gl.createBuffer();
    this.colorBuffer = gl.createBuffer();
    this.fractionalBuffer = gl.createBuffer();
    this.cellVao = gl.createVertexArray();
    this.cellBuffer = gl.createBuffer();

    gl.bindVertexArray(this.sphereVao);
    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(2, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.fractionalBuffer);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);

    gl.bindVertexArray(this.cellVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cellBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.sphereUniforms = uniforms(gl, this.sphereProgram, [
      'uView', 'uProjection', 'uRadius', 'uSliceAxis', 'uSliceMaximum', 'uSelected',
    ]);
    this.lineUniforms = uniforms(gl, this.lineProgram, ['uViewProjection', 'uColor']);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  }

  setFrame(frame, colors, displayPositions = frame.positions) {
    const startedAt = performance.now();
    const gl = this.gl;
    this.frame = frame;
    this.displayPositions = displayPositions;
    this.atomCount = frame.ids.length;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, displayPositions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fractionalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, frame.fractional, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cellBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, buildCellLines(frame.cell), gl.STATIC_DRAW);
    gl.finish();
    this.requestRender();
    return performance.now() - startedAt;
  }

  setColors(colors) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    this.requestRender();
  }

  setDisplayPositions(positions) {
    if (!this.frame || positions.length !== this.atomCount * 3) {
      throw new Error('The display coordinate array does not match the current frame.');
    }
    const startedAt = performance.now();
    this.displayPositions = positions;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, positions, this.gl.STATIC_DRAW);
    this.gl.finish();
    this.requestRender();
    return performance.now() - startedAt;
  }

  setRadius(radius) { this.radius = radius; this.requestRender(); }
  setSlice(axis, maximum) { this.sliceAxis = axis; this.sliceMaximum = maximum; this.requestRender(); }
  setSelected(index) { this.selected = index ?? -1; this.requestRender(); }
  setProjection(mode) { this.projectionMode = mode; this.requestRender(); }
  setCellVisible(visible) { this.cellVisible = Boolean(visible); this.requestRender(); }

  setBackground(hex) {
    const value = hex.replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(value)) return;
    this.background = [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16) / 255);
    this.requestRender();
  }

  resetCamera() {
    if (!this.frame) return;
    const vertices = cellVertices(this.frame.cell);
    const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const array of [vertices, this.displayPositions]) {
      for (let index = 0; index < array.length; index += 3) {
        for (let component = 0; component < 3; component += 1) {
          minimum[component] = Math.min(minimum[component], array[index + component]);
          maximum[component] = Math.max(maximum[component], array[index + component]);
        }
      }
    }
    this.target = minimum.map((value, component) => (value + maximum[component]) / 2);
    this.pan = [0, 0, 0];
    this.modelRadius = Math.max(0.5, Math.hypot(
      maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2],
    ) / 2);
    this.distance = Math.max(3, this.modelRadius / Math.tan(this.fov / 2) * 1.35);
    this.orthographicScale = this.modelRadius * 1.25;
    this.yaw = -0.62;
    this.pitch = 0.38;
    this.requestRender();
  }

  requestRender() {
    if (this.renderRequested) return;
    this.renderRequested = true;
    requestAnimationFrame((timestamp) => {
      this.renderRequested = false;
      this.render(timestamp);
    });
  }

  render(timestamp = performance.now(), { transparentBackground = false, trackStats = true } = {}) {
    const gl = this.gl;
    this.resize();
    this.updateMatrices();
    gl.clearColor(...this.background, transparentBackground ? 0 : 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.frame) return;

    // Preserve an opaque alpha channel for the interactive view and normal PNG
    // exports. Transparent exports keep atom edge coverage in the alpha channel.
    if (!transparentBackground) gl.colorMask(true, true, true, false);

    gl.disable(gl.BLEND);
    gl.useProgram(this.sphereProgram);
    gl.bindVertexArray(this.sphereVao);
    gl.uniformMatrix4fv(this.sphereUniforms.uView, false, this.viewMatrix);
    gl.uniformMatrix4fv(this.sphereUniforms.uProjection, false, this.projectionMatrix);
    gl.uniform1f(this.sphereUniforms.uRadius, this.radius);
    gl.uniform1i(this.sphereUniforms.uSliceAxis, this.sliceAxis);
    gl.uniform1f(this.sphereUniforms.uSliceMaximum, this.sliceMaximum);
    gl.uniform1i(this.sphereUniforms.uSelected, this.selected);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.atomCount);

    if (this.cellVisible) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.lineProgram);
      gl.bindVertexArray(this.cellVao);
      gl.uniformMatrix4fv(this.lineUniforms.uViewProjection, false, this.viewProjectionMatrix);
      gl.uniform3f(this.lineUniforms.uColor, 0.62, 0.78, 0.81);
      gl.drawArrays(gl.LINES, 0, CELL_EDGES.length);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.colorMask(true, true, true, true);
    if (trackStats) this.recordFrame(timestamp);
  }

  updateMatrices() {
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    const aspect = width / height;
    const target = add(this.target, this.pan);
    const cosinePitch = Math.cos(this.pitch);
    const offset = [
      this.distance * cosinePitch * Math.sin(this.yaw),
      this.distance * Math.sin(this.pitch),
      this.distance * cosinePitch * Math.cos(this.yaw),
    ];
    const eye = add(target, offset);
    this.viewMatrix = lookAt(eye, target, [0, 1, 0]);
    const near = Math.max(0.001, Math.min(this.modelRadius * 0.01, this.distance * 0.05));
    const far = Math.max(near + 1, this.distance + this.modelRadius * 6 + 10);
    if (this.projectionMode === 'orthographic') {
      const halfHeight = this.orthographicScale;
      this.projectionMatrix = orthographic(-halfHeight * aspect, halfHeight * aspect, -halfHeight, halfHeight, near, far);
    } else {
      this.projectionMatrix = perspective(this.fov, aspect, near, far);
    }
    this.viewProjectionMatrix = multiply4(this.projectionMatrix, this.viewMatrix);
  }

  resize() {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.gl.viewport(0, 0, width, height);
    }
  }

  installInteractions() {
    let pointer = null;
    this.canvas.addEventListener('pointerdown', (event) => {
      if (!this.frame) return;
      this.canvas.setPointerCapture(event.pointerId);
      pointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        mode: event.button === 2 || event.shiftKey ? 'pan' : 'rotate',
      };
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const deltaX = event.clientX - pointer.x;
      const deltaY = event.clientY - pointer.y;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      if (pointer.mode === 'rotate') {
        this.yaw -= deltaX * 0.008;
        // Keep screen-space motion intuitive: dragging upward (negative deltaY)
        // tilts the view upward instead of moving the camera above the model.
        this.pitch = Math.max(-1.52, Math.min(1.52, this.pitch + deltaY * 0.008));
      } else {
        const { right, up } = this.cameraBasis();
        const worldPerPixel = this.projectionMode === 'orthographic'
          ? 2 * this.orthographicScale / Math.max(1, this.canvas.clientHeight)
          : 2 * Math.tan(this.fov / 2) * this.distance / Math.max(1, this.canvas.clientHeight);
        this.pan = add(this.pan, add(scale(right, -deltaX * worldPerPixel), scale(up, deltaY * worldPerPixel)));
      }
      this.requestRender();
    });
    const endPointer = (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const moved = Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY);
      if (moved < 4 && event.button === 0) this.onPick(this.pick(event.clientX, event.clientY));
      pointer = null;
    };
    this.canvas.addEventListener('pointerup', endPointer);
    this.canvas.addEventListener('pointercancel', () => { pointer = null; });
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    this.canvas.addEventListener('wheel', (event) => {
      if (!this.frame) return;
      event.preventDefault();
      const factor = Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * 0.0018);
      if (this.projectionMode === 'orthographic') this.orthographicScale = Math.max(0.02, this.orthographicScale * factor);
      else this.distance = Math.max(0.02, this.distance * factor);
      this.requestRender();
    }, { passive: false });
  }

  cameraBasis() {
    const target = add(this.target, this.pan);
    const cosinePitch = Math.cos(this.pitch);
    const eye = add(target, [
      this.distance * cosinePitch * Math.sin(this.yaw),
      this.distance * Math.sin(this.pitch),
      this.distance * cosinePitch * Math.cos(this.yaw),
    ]);
    const forward = normalize(subtract(target, eye));
    const right = normalize(cross(forward, [0, 1, 0]));
    return { right, up: normalize(cross(right, forward)) };
  }

  pick(clientX, clientY) {
    if (!this.frame) return -1;
    this.updateMatrices();
    const rectangle = this.canvas.getBoundingClientRect();
    const x = clientX - rectangle.left;
    const y = clientY - rectangle.top;
    let closest = -1;
    let closestDepth = Number.NEGATIVE_INFINITY;
    const positions = this.displayPositions;
    const fractional = this.frame.fractional;
    for (let atom = 0; atom < this.atomCount; atom += 1) {
      const index = atom * 3;
      if (fractional[index + this.sliceAxis] > this.sliceMaximum) continue;
      const view = transformPoint(this.viewMatrix, positions[index], positions[index + 1], positions[index + 2]);
      if (view[2] >= 0) continue;
      const clip = transformPoint(this.projectionMatrix, view[0], view[1], view[2]);
      if (clip[3] <= 0) continue;
      const screenX = (clip[0] / clip[3] * 0.5 + 0.5) * rectangle.width;
      const screenY = (0.5 - clip[1] / clip[3] * 0.5) * rectangle.height;
      const edgeClip = transformPoint(this.projectionMatrix, view[0] + this.radius, view[1], view[2]);
      const radiusPixels = Math.max(3, Math.abs(edgeClip[0] / edgeClip[3] - clip[0] / clip[3]) * rectangle.width * 0.5);
      const distanceSquared = (x - screenX) ** 2 + (y - screenY) ** 2;
      if (distanceSquared <= radiusPixels ** 2 && view[2] > closestDepth) {
        closest = atom;
        closestDepth = view[2];
      }
    }
    return closest;
  }

  exportPng(filename = 'alloyview.png', { includeBackground = true } = {}) {
    const gl = this.gl;
    let width;
    let height;
    let pixels;
    try {
      this.render(performance.now(), {
        transparentBackground: !includeBackground,
        trackStats: false,
      });
      width = this.canvas.width;
      height = this.canvas.height;
      pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    } finally {
      // Keep the interactive viewport opaque even after a transparent export.
      this.render(performance.now(), { trackStats: false });
    }
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = width;
    exportCanvas.height = height;
    const context = exportCanvas.getContext('2d');
    const image = context.createImageData(width, height);
    const stride = width * 4;
    for (let row = 0; row < height; row += 1) {
      const source = (height - row - 1) * stride;
      image.data.set(pixels.subarray(source, source + stride), row * stride);
    }
    context.putImageData(image, 0, 0);
    exportCanvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement('a');
      link.download = filename;
      link.href = URL.createObjectURL(blob);
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 0);
    }, 'image/png');
  }

  recordFrame(timestamp) {
    this.frameTimes.push(timestamp);
    while (this.frameTimes.length > 60 || (this.frameTimes.length > 1 && timestamp - this.frameTimes[0] > 1200)) {
      this.frameTimes.shift();
    }
    if (timestamp - this.lastStatsAt > 500 && this.frameTimes.length > 2) {
      const duration = this.frameTimes.at(-1) - this.frameTimes[0];
      if (duration > 0) this.onStats({ fps: (this.frameTimes.length - 1) * 1000 / duration });
      this.lastStatsAt = timestamp;
    }
  }
}

function buildCellLines(cell) {
  const vertices = cellVertices(cell);
  const lines = new Float32Array(CELL_EDGES.length * 3);
  for (let endpoint = 0; endpoint < CELL_EDGES.length; endpoint += 1) {
    const vertex = CELL_EDGES[endpoint];
    lines[endpoint * 3] = vertices[vertex * 3];
    lines[endpoint * 3 + 1] = vertices[vertex * 3 + 1];
    lines[endpoint * 3 + 2] = vertices[vertex * 3 + 2];
  }
  return lines;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  const vertex = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`WebGL program linking failed: ${gl.getProgramInfoLog(program)}`);
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return program;
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`WebGL shader compilation failed: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function uniforms(gl, program, names) {
  return Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));
}
