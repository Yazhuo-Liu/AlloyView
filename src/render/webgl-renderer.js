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
  transformPoint,
} from './math.js';

const SPHERE_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;
layout(location=1) in vec3 aCenter;
layout(location=2) in vec3 aColor;
layout(location=3) in vec3 aFractional;
layout(location=4) in float aVisible;
layout(location=5) in float aRadius;
uniform mat4 uView;
uniform mat4 uProjection;
uniform float uRadiusScale;
uniform int uSliceAxis;
uniform float uSliceMaximum;
uniform int uSelected;
out vec2 vCorner;
out vec3 vColor;
out vec3 vCenterView;
flat out int vVisible;
flat out int vSelected;
flat out float vRadius;
void main() {
  vec4 centerView = uView * vec4(aCenter, 1.0);
  float radius = aRadius * uRadiusScale;
  vec4 cornerView = centerView + vec4(aCorner * radius, 0.0, 0.0);
  gl_Position = uProjection * cornerView;
  vCorner = aCorner;
  vColor = aColor;
  vCenterView = centerView.xyz;
  vVisible = aVisible > 0.5 && aFractional[uSliceAxis] <= uSliceMaximum ? 1 : 0;
  vSelected = gl_InstanceID == uSelected ? 1 : 0;
  vRadius = radius;
}`;

const SPHERE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vCorner;
in vec3 vColor;
in vec3 vCenterView;
flat in int vVisible;
flat in int vSelected;
flat in float vRadius;
uniform mat4 uProjection;
out vec4 outColor;
void main() {
  if (vVisible == 0) discard;
  float radiusSquared = dot(vCorner, vCorner);
  if (radiusSquared > 1.0) discard;
  float normalZ = sqrt(max(0.0, 1.0 - radiusSquared));
  vec3 normal = vec3(vCorner, normalZ);

  // View-space studio lighting keeps illumination stable while orbiting and
  // costs only a few ALU operations per covered fragment. Work in approximate
  // linear RGB so the diffuse gradient retains depth without muddying colors.
  vec3 baseColor = pow(vColor, vec3(2.2));
  vec3 viewDirection = vec3(0.0, 0.0, 1.0);
  vec3 keyDirection = normalize(vec3(-0.48, 0.62, 0.72));
  vec3 fillDirection = normalize(vec3(0.68, -0.36, 0.48));
  float keyDiffuse = max(0.0, dot(normal, keyDirection));
  float fillDiffuse = max(0.0, dot(normal, fillDirection));
  float hemisphere = normal.y * 0.5 + 0.5;
  float ambient = mix(0.22, 0.31, hemisphere);

  // Darken the silhouette slightly to make the analytic disc read as a sphere.
  float curvature = mix(0.58, 1.0, smoothstep(0.02, 0.58, normalZ));
  float illumination = (ambient + 0.66 * keyDiffuse + 0.17 * fillDiffuse) * curvature;
  vec3 linearShaded = baseColor * illumination;

  // A broad, restrained metallic highlight gives curvature cues without the
  // plastic-looking hotspot produced by a very high Phong exponent.
  vec3 halfDirection = normalize(keyDirection + viewDirection);
  float specular = pow(max(0.0, dot(normal, halfDirection)), 34.0) * 0.20;
  vec3 highlightColor = mix(vec3(1.0, 0.94, 0.82), baseColor, 0.12);
  linearShaded += highlightColor * specular;
  vec3 shaded = pow(clamp(linearShaded, 0.0, 1.0), vec3(1.0 / 2.2));
  if (vSelected == 1) {
    float ring = smoothstep(0.68, 0.84, radiusSquared);
    shaded = mix(min(shaded * 1.10, vec3(1.0)), vec3(1.0, 0.67, 0.20), ring);
  }
  vec3 surfaceView = vCenterView + vec3(vCorner * vRadius, normalZ * vRadius);
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

const MAX_ORBIT_PITCH = Math.PI / 2 - 0.008;
const VIEW_PRESETS = Object.freeze({
  front: { yaw: 0, pitch: 0 },
  back: { yaw: Math.PI, pitch: 0 },
  left: { yaw: -Math.PI / 2, pitch: 0 },
  right: { yaw: Math.PI / 2, pitch: 0 },
  top: { yaw: 0, pitch: Math.PI / 2 },
  bottom: { yaw: 0, pitch: -Math.PI / 2 },
});

export class WebGLRenderer {
  constructor(canvas, {
    onPick = () => {},
    onStats = () => {},
    onCameraChange = () => {},
    onProjectionChange = () => {},
  } = {}) {
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
    this.onCameraChange = onCameraChange;
    this.onProjectionChange = onProjectionChange;
    this.frame = null;
    this.displayPositions = null;
    this.visibility = null;
    this.atomCount = 0;
    this.radiusScale = 1;
    this.atomRadii = null;
    this.background = [0, 0, 0];
    this.cellColor = [0.62, 0.78, 0.81];
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
    this.visibilityBuffer = gl.createBuffer();
    this.radiusBuffer = gl.createBuffer();
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

    gl.bindBuffer(gl.ARRAY_BUFFER, this.visibilityBuffer);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(4, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.radiusBuffer);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);

    gl.bindVertexArray(this.cellVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cellBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.sphereUniforms = uniforms(gl, this.sphereProgram, [
      'uView', 'uProjection', 'uRadiusScale', 'uSliceAxis', 'uSliceMaximum', 'uSelected',
    ]);
    this.lineUniforms = uniforms(gl, this.lineProgram, ['uViewProjection', 'uColor']);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  }

  setFrame(frame, colors, displayPositions = frame.positions, atomRadii = null) {
    const startedAt = performance.now();
    const gl = this.gl;
    this.frame = frame;
    this.displayPositions = displayPositions;
    this.atomCount = frame.ids.length;
    this.atomRadii = atomRadii ?? new Float32Array(this.atomCount).fill(0.7);
    if (this.atomRadii.length !== this.atomCount) throw new Error('The atom radius array does not match the current frame.');
    this.visibility = new Uint8Array(this.atomCount).fill(255);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, displayPositions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fractionalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, frame.fractional, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.visibilityBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.visibility, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.radiusBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.atomRadii, gl.STATIC_DRAW);
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

  setVisibility(visibility = null) {
    if (!this.frame) return;
    const values = visibility ?? new Uint8Array(this.atomCount).fill(255);
    if (values.length !== this.atomCount) {
      throw new Error('The visibility mask does not match the current frame.');
    }
    this.visibility = values;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.visibilityBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.DYNAMIC_DRAW);
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

  setRadiusScale(scaleFactor) {
    if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) throw new Error('The atom radius scale must be greater than zero.');
    this.radiusScale = scaleFactor;
    this.requestRender();
  }
  setSlice(axis, maximum) { this.sliceAxis = axis; this.sliceMaximum = maximum; this.requestRender(); }
  setSelected(index) { this.selected = index ?? -1; this.requestRender(); }
  setProjection(mode) {
    if (mode !== 'perspective' && mode !== 'orthographic') throw new Error(`Unknown projection mode “${mode}”.`);
    this.projectionMode = mode;
    this.onProjectionChange(mode);
    this.requestRender();
  }
  setCellVisible(visible) { this.cellVisible = Boolean(visible); this.requestRender(); }

  setBackground(hex) {
    const value = hex.replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(value)) return;
    this.background = [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16) / 255);
    const luminance = 0.2126 * this.background[0] + 0.7152 * this.background[1] + 0.0722 * this.background[2];
    this.cellColor = luminance > 0.68 ? [0.22, 0.34, 0.38] : [0.62, 0.78, 0.81];
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

  setView(name) {
    const preset = VIEW_PRESETS[name];
    if (!preset) throw new Error(`Unknown camera view “${name}”.`);
    this.yaw = preset.yaw;
    this.pitch = preset.pitch;
    this.pan = [0, 0, 0];
    this.projectionMode = 'orthographic';
    this.onProjectionChange(this.projectionMode);
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
    if (transparentBackground) gl.clearColor(0, 0, 0, 0);
    else gl.clearColor(...this.background, 1);
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
    gl.uniform1f(this.sphereUniforms.uRadiusScale, this.radiusScale);
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
      gl.uniform3f(this.lineUniforms.uColor, ...this.cellColor);
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
    const { offsetDirection, upHint } = this.cameraOrientation();
    const offset = scale(offsetDirection, this.distance);
    const eye = add(target, offset);
    this.viewMatrix = lookAt(eye, target, upHint);
    const near = Math.max(0.001, Math.min(this.modelRadius * 0.01, this.distance * 0.05));
    const far = Math.max(near + 1, this.distance + this.modelRadius * 6 + 10);
    if (this.projectionMode === 'orthographic') {
      const halfHeight = this.orthographicScale;
      this.projectionMatrix = orthographic(-halfHeight * aspect, halfHeight * aspect, -halfHeight, halfHeight, near, far);
    } else {
      this.projectionMatrix = perspective(this.fov, aspect, near, far);
    }
    this.viewProjectionMatrix = multiply4(this.projectionMatrix, this.viewMatrix);
    this.onCameraChange(axisDirectionsFromView(this.viewMatrix));
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
        // OVITO-style constrained orbit: global Z stays upright and the camera
        // cannot roll over a pole. Upward drags retain the established
        // screen-space direction while the pitch remains bounded.
        this.pitch = Math.max(-MAX_ORBIT_PITCH, Math.min(MAX_ORBIT_PITCH, this.pitch + deltaY * 0.008));
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
    const { offsetDirection, upHint } = this.cameraOrientation();
    const forward = scale(offsetDirection, -1);
    const right = normalize(cross(upHint, offsetDirection));
    return { right, up: normalize(cross(right, forward)) };
  }

  cameraOrientation() {
    const cosinePitch = Math.cos(this.pitch);
    const offsetDirection = [
      cosinePitch * Math.sin(this.yaw),
      -cosinePitch * Math.cos(this.yaw),
      Math.sin(this.pitch),
    ];
    // At the exact top/bottom presets global Z is parallel to the viewing
    // direction, so global Y provides a deterministic screen-up direction.
    const upHint = Math.abs(cosinePitch) < 1e-7 ? [0, 1, 0] : [0, 0, 1];
    return { offsetDirection, upHint };
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
      if (this.visibility?.[atom] === 0) continue;
      const index = atom * 3;
      if (fractional[index + this.sliceAxis] > this.sliceMaximum) continue;
      const view = transformPoint(this.viewMatrix, positions[index], positions[index + 1], positions[index + 2]);
      if (view[2] >= 0) continue;
      const clip = transformPoint(this.projectionMatrix, view[0], view[1], view[2]);
      if (clip[3] <= 0) continue;
      const screenX = (clip[0] / clip[3] * 0.5 + 0.5) * rectangle.width;
      const screenY = (0.5 - clip[1] / clip[3] * 0.5) * rectangle.height;
      const radius = (this.atomRadii?.[atom] ?? 0.7) * this.radiusScale;
      const edgeClip = transformPoint(this.projectionMatrix, view[0] + radius, view[1], view[2]);
      const radiusPixels = Math.max(3, Math.abs(edgeClip[0] / edgeClip[3] - clip[0] / clip[3]) * rectangle.width * 0.5);
      const distanceSquared = (x - screenX) ** 2 + (y - screenY) ** 2;
      if (distanceSquared <= radiusPixels ** 2 && view[2] > closestDepth) {
        closest = atom;
        closestDepth = view[2];
      }
    }
    return closest;
  }

  exportPng(filename = 'alloyview.png', { includeBackground = true, legend = null, includeAxes = false } = {}) {
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
    const cssWidth = Number(this.canvas.clientWidth) || width;
    const scale = Math.max(1, Math.min(3, width / cssWidth));
    if (legend) {
      drawLegendOverlay(context, legend, width, height, scale, { includeBackground });
    }
    if (includeAxes) drawAxesOverlay(context, axisDirectionsFromView(this.viewMatrix), width, height, scale);
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

export function drawLegendOverlay(context, legend, width, height, scale = 1, { includeBackground = true } = {}) {
  if (!legend || width < 100 * scale || height < 72 * scale) return;
  const margin = 18 * scale;
  const padding = 12 * scale;
  const titleHeight = 23 * scale;
  const panelWidth = Math.min((legend.kind === 'types' ? 260 : 240) * scale, width - margin * 2);
  let panelHeight;
  if (legend.kind === 'types') {
    const columns = legend.items.length > 6 ? 2 : 1;
    panelHeight = (padding * 2) + titleHeight + Math.ceil(legend.items.length / columns) * 19 * scale;
  } else {
    panelHeight = 82 * scale;
  }
  panelHeight = Math.min(panelHeight, height - margin * 2);
  const x = margin;
  const y = height - margin - panelHeight;
  const textColors = includeBackground
    ? { title: '#d9e7ea', label: '#a4b7be', muted: '#8299a2' }
    : { title: '#142f3e', label: '#355563', muted: '#526d7b' };

  context.save();
  // Background is one export option for the viewport AND legend. Keep only
  // text, swatches and the scalar color bar when exporting transparency.
  if (includeBackground) {
    context.fillStyle = 'rgba(9, 22, 31, 0.92)';
    context.strokeStyle = 'rgba(105, 139, 151, 0.7)';
    context.lineWidth = scale;
    context.fillRect(x, y, panelWidth, panelHeight);
    context.strokeRect(x + scale * 0.5, y + scale * 0.5, panelWidth - scale, panelHeight - scale);
  }
  context.textBaseline = 'alphabetic';
  context.fillStyle = textColors.title;
  context.font = `600 ${11 * scale}px system-ui, sans-serif`;
  const title = legend.kind === 'scalar' && legend.unit
    ? `${legend.title} [${legend.unit}]`
    : legend.title;
  context.fillText(title, x + padding, y + 20 * scale, panelWidth - padding * 2);

  if (legend.kind === 'types') {
    drawTypeLegend(context, legend, x, y, panelWidth, panelHeight, padding, scale, textColors);
  } else if (legend.kind === 'scalar') {
    drawScalarLegend(context, legend, x, y, panelWidth, padding, scale, textColors);
  }
  context.restore();
}

function drawScalarLegend(context, legend, x, y, panelWidth, padding, scale, textColors) {
  if (legend.schemeLabel) {
    context.fillStyle = textColors.muted;
    context.font = `${8 * scale}px system-ui, sans-serif`;
    context.textAlign = 'right';
    context.fillText(legend.schemeLabel, x + panelWidth - padding, y + 20 * scale, panelWidth * 0.46);
    context.textAlign = 'left';
  }
  const gradientX = x + padding;
  const gradientY = y + 34 * scale;
  const gradientWidth = panelWidth - padding * 2;
  const gradientHeight = 10 * scale;
  const gradient = context.createLinearGradient(gradientX, 0, gradientX + gradientWidth, 0);
  for (const [position, red, green, blue] of legend.colorStops) {
    gradient.addColorStop(position, `rgb(${red} ${green} ${blue})`);
  }
  context.fillStyle = gradient;
  context.fillRect(gradientX, gradientY, gradientWidth, gradientHeight);
  context.strokeStyle = 'rgba(220, 235, 239, 0.38)';
  context.lineWidth = scale;
  context.strokeRect(gradientX, gradientY, gradientWidth, gradientHeight);
  context.fillStyle = textColors.label;
  context.font = `${9 * scale}px system-ui, sans-serif`;
  context.fillText(formatLegendNumber(legend.minimum), gradientX, y + 64 * scale);
  context.textAlign = 'right';
  context.fillText(formatLegendNumber(legend.maximum), gradientX + gradientWidth, y + 64 * scale);
  context.textAlign = 'left';
}

function drawTypeLegend(context, legend, x, y, panelWidth, panelHeight, padding, scale, textColors) {
  const columns = legend.items.length > 6 ? 2 : 1;
  const rows = Math.ceil(legend.items.length / columns);
  const columnWidth = (panelWidth - padding * 2) / columns;
  context.font = `${9 * scale}px system-ui, sans-serif`;
  for (let index = 0; index < legend.items.length; index += 1) {
    const column = Math.floor(index / rows);
    const row = index % rows;
    const itemX = x + padding + column * columnWidth;
    const itemY = y + 38 * scale + row * 19 * scale;
    if (itemY > y + panelHeight - 8 * scale) break;
    const item = legend.items[index];
    context.beginPath();
    context.arc(itemX + 4 * scale, itemY - 3 * scale, 4 * scale, 0, Math.PI * 2);
    context.fillStyle = `rgb(${item.color.join(' ')})`;
    context.fill();
    context.fillStyle = textColors.label;
    const label = item.count === undefined ? item.label
      : `${item.label}: ${item.count}${item.visible === false ? ' (hidden)' : ''}`;
    context.fillText(label, itemX + 13 * scale, itemY, columnWidth - 16 * scale);
  }
}

function formatLegendNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 10_000 || magnitude < 0.001) return value.toExponential(3);
  return Number(value.toPrecision(6)).toString();
}

export function drawAxesOverlay(context, directions, width, height, scale = 1) {
  if (width < 130 * scale || height < 130 * scale) return;
  const center = { x: width - 65 * scale, y: height - 65 * scale };
  const colors = { x: '#e5635b', y: '#70be83', z: '#649df2' };
  context.save();
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.font = `bold ${12 * scale}px system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const axes = Object.entries(directions).sort((a, b) => a[1].depth - b[1].depth);
  for (const [name, direction] of axes) {
    const x = center.x + direction.x * 35 * scale;
    const y = center.y + direction.y * 35 * scale;
    const norm = Math.hypot(direction.x, direction.y);
    const ux = norm > 1e-6 ? direction.x / norm : 0;
    const uy = norm > 1e-6 ? direction.y / norm : -1;
    context.beginPath();
    if (norm > .12) {
      context.moveTo(center.x, center.y); context.lineTo(x, y);
      context.moveTo(x - (ux * 6 - uy * 3) * scale, y - (uy * 6 + ux * 3) * scale);
      context.lineTo(x, y);
      context.lineTo(x - (ux * 6 + uy * 3) * scale, y - (uy * 6 - ux * 3) * scale);
    } else context.arc(x, y, 2.5 * scale, 0, 2 * Math.PI);
    context.strokeStyle = 'rgba(0, 0, 0, .8)'; context.lineWidth = 4 * scale; context.stroke();
    context.strokeStyle = colors[name]; context.lineWidth = 2 * scale; context.stroke();
    const labelX = x + ux * 10 * scale;
    const labelY = y + uy * 10 * scale;
    context.lineWidth = 2.5 * scale; context.strokeStyle = 'rgba(0, 0, 0, .9)';
    context.strokeText(name.toUpperCase(), labelX, labelY);
    context.fillStyle = colors[name]; context.fillText(name.toUpperCase(), labelX, labelY);
  }
  context.restore();
}

export function axisDirectionsFromView(viewMatrix) {
  return {
    x: { x: viewMatrix[0], y: -viewMatrix[1], depth: viewMatrix[2] },
    y: { x: viewMatrix[4], y: -viewMatrix[5], depth: viewMatrix[6] },
    z: { x: viewMatrix[8], y: -viewMatrix[9], depth: viewMatrix[10] },
  };
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
