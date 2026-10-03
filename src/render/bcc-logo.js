import { cross, lookAt, multiply4, normalize, orthographic } from './math.js';

const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in float aSteel;
uniform mat4 uModel;
uniform mat4 uViewProjection;
out vec3 vNormal;
out vec3 vColor;
out float vSteel;
void main() {
  gl_Position = uViewProjection * uModel * vec4(aPosition, 1.0);
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  vSteel = aSteel;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vColor;
in float vSteel;
uniform float uDark;
out vec4 outColor;
void main() {
  vec3 normal = normalize(vNormal);
  vec3 key = normalize(vec3(-0.48, 0.65, 0.72));
  vec3 fill = normalize(vec3(0.68, -0.30, 0.50));
  vec3 steel = mix(vec3(0.51, 0.64, 0.69), vec3(0.69, 0.80, 0.83), uDark);
  vec3 base = pow(mix(vColor, steel, vSteel), vec3(2.2));
  float diffuse = 0.28 + 0.63 * max(dot(normal, key), 0.0)
    + 0.18 * max(dot(normal, fill), 0.0);
  vec3 halfway = normalize(key + vec3(0.0, 0.0, 1.0));
  float specular = pow(max(dot(normal, halfway), 0.0), 36.0) * 0.18;
  vec3 color = base * diffuse + vec3(0.92, 0.97, 1.0) * specular;
  outColor = vec4(pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

// The original mark's four colored columns surround a larger body-center atom.
export function createBccLogoModel() {
  const atoms = [];
  for (const x of [-0.7, 0.7]) {
    for (const y of [-0.7, 0.7]) {
      for (const z of [-0.7, 0.7]) {
        const color = x < 0
          ? (z > 0 ? [0.20, 0.48, 0.91] : [0.28, 0.76, 0.55])
          : (z > 0 ? [0.24, 0.66, 0.76] : [0.68, 0.38, 0.82]);
        atoms.push({ position: [x, y, z], radius: 0.16, color });
      }
    }
  }
  atoms.push({ position: [0, 0, 0], radius: 0.20, color: [0.57, 0.77, 0.78] });
  const bonds = atoms.slice(0, 8).map((_, corner) => [8, corner]);
  const edges = [];
  for (let first = 0; first < 8; first += 1) {
    for (let second = first + 1; second < 8; second += 1) {
      const differences = atoms[first].position.filter((value, axis) => value !== atoms[second].position[axis]);
      if (differences.length === 1) edges.push([first, second]);
    }
  }
  return { atoms, bonds, edges };
}

function createGeometry(model) {
  const vertices = [], indices = [];
  function vertex(position, normal, color, steel = 0) {
    vertices.push(...position, ...normal, ...color, steel);
  }
  for (const { position, radius, color } of model.atoms) {
    const start = vertices.length / 10;
    const rows = 20, columns = 32;
    for (let row = 0; row <= rows; row += 1) {
      const theta = Math.PI * row / rows;
      for (let column = 0; column <= columns; column += 1) {
        const phi = 2 * Math.PI * column / columns;
        const normal = [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)];
        vertex(position.map((value, axis) => value + normal[axis] * radius), normal, color);
      }
    }
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const corner = start + row * (columns + 1) + column;
        indices.push(corner, corner + columns + 1, corner + 1,
          corner + 1, corner + columns + 1, corner + columns + 2);
      }
    }
  }
  function cylinder([first, second], radius, sides) {
    const start = vertices.length / 10;
    const from = model.atoms[first].position, to = model.atoms[second].position;
    const axis = normalize(to.map((value, dimension) => value - from[dimension]));
    const tangent = normalize(cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const bitangent = cross(axis, tangent);
    for (const center of [from, to]) {
      for (let side = 0; side <= sides; side += 1) {
        const angle = 2 * Math.PI * side / sides;
        const normal = tangent.map((value, dimension) => value * Math.cos(angle) + bitangent[dimension] * Math.sin(angle));
        vertex(center.map((value, dimension) => value + radius * normal[dimension]), normal, [0, 0, 0], 1);
      }
    }
    // Both ends sit inside atom spheres, so end caps would be invisible.
    for (let side = 0; side < sides; side += 1) {
      const corner = start + side;
      indices.push(corner, corner + 1, corner + sides + 1,
        corner + 1, corner + sides + 2, corner + sides + 1);
    }
  }
  for (const bond of model.bonds) cylinder(bond, 0.026, 16);
  for (const edge of model.edges) cylinder(edge, 0.007, 8);
  return { vertices: new Float32Array(vertices), indices: new Uint16Array(indices) };
}

function createProgram(gl) {
  const program = gl.createProgram();
  const shaders = [];
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

export function initializeBccLogo(emptyState) {
  const container = emptyState.querySelector('.empty-logo');
  const canvas = container.querySelector('canvas');
  const fallback = container.querySelector('img');
  let gl, program, vertexBuffer, indexBuffer, vertexArray;
  const release = () => {
    if (!gl) return;
    if (vertexArray) gl.deleteVertexArray(vertexArray);
    if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
    if (indexBuffer) gl.deleteBuffer(indexBuffer);
    if (program) gl.deleteProgram(program);
  };
  let indexCount;
  try {
    gl = canvas.getContext('webgl2', { alpha: true, antialias: true, depth: true, powerPreference: 'low-power' });
    if (!gl) return { dispose() {} };
    program = createProgram(gl);
    const geometry = createGeometry(createBccLogoModel());
    indexCount = geometry.indices.length;
    vertexArray = gl.createVertexArray();
    vertexBuffer = gl.createBuffer();
    indexBuffer = gl.createBuffer();
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, geometry.vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
    for (const [location, size, offset] of [[0, 3, 0], [1, 3, 3], [2, 3, 6], [3, 1, 9]]) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 40, offset * 4);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
  } catch {
    release();
    return { dispose() {} }; // Preserve the original mark on unsupported GPUs.
  }

  const uniforms = Object.fromEntries(['uModel', 'uViewProjection', 'uDark'].map(name => [name, gl.getUniformLocation(program, name)]));
  const view = lookAt([0, 0, 5], [0, 0, 0], [0, 1, 0]);
  const pitch = 0.32, c = Math.cos(pitch), s = Math.sin(pitch);
  const tilt = new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
  let yaw = -0.62, request = null, previous = null, lastDraw = null;
  let intersecting = true, disposed = false, lost = false;
  canvas.hidden = false;
  fallback.hidden = true;

  function visible() {
    const bounds = container.getBoundingClientRect();
    return !disposed && !lost && !document.hidden && !emptyState.hidden && intersecting && bounds.width > 0 && bounds.height > 0;
  }
  function stop() {
    if (request !== null) cancelAnimationFrame(request);
    request = previous = lastDraw = null;
  }
  function schedule() {
    if (!visible()) { stop(); return; }
    if (request === null) request = requestAnimationFrame(tick);
  }
  function refresh() {
    lastDraw = null;
    schedule();
  }
  function render() {
    const bounds = container.getBoundingClientRect();
    const resolution = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(bounds.width * resolution));
    const height = Math.max(1, Math.round(bounds.height * resolution));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindVertexArray(vertexArray);
    const co = Math.cos(yaw), si = Math.sin(yaw);
    const turn = new Float32Array([co, 0, -si, 0, 0, 1, 0, 0, si, 0, co, 0, 0, 0, 0, 1]);
    const aspect = width / height;
    gl.uniformMatrix4fv(uniforms.uModel, false, multiply4(tilt, turn));
    gl.uniformMatrix4fv(uniforms.uViewProjection, false, multiply4(orthographic(-1.35 * aspect, 1.35 * aspect, -1.35, 1.35, 0.1, 10), view));
    gl.uniform1f(uniforms.uDark, document.documentElement.dataset.theme === 'dark' ? 1 : 0);
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
  }
  function tick(timestamp) {
    request = null;
    if (!visible()) { stop(); return; }
    if (previous !== null) yaw += Math.min((timestamp - previous) / 1000, 0.1) * 0.32;
    previous = timestamp;
    if (lastDraw === null || timestamp - lastDraw >= 1000 / 30 - 1) {
      render();
      lastDraw = timestamp;
    }
    schedule();
  }

  const resizeObserver = new ResizeObserver(refresh);
  resizeObserver.observe(container);
  const observer = new MutationObserver(refresh);
  observer.observe(emptyState, { attributes: true, attributeFilter: ['hidden'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const intersectionObserver = new IntersectionObserver(([entry]) => {
    intersecting = entry.isIntersecting;
    refresh();
  });
  intersectionObserver.observe(container);
  document.addEventListener('visibilitychange', refresh);
  const onContextLost = () => {
    lost = true;
    stop();
    canvas.hidden = true;
    fallback.hidden = false;
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  schedule();

  return {
    dispose() {
      disposed = true;
      stop();
      resizeObserver.disconnect();
      observer.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener('visibilitychange', refresh);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      release();
    },
  };
}
