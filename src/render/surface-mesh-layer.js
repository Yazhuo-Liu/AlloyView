import { invert3 } from '../data/model.js';
import { parsePrimitiveColor } from './atom-primitives.js';
import { crystalDragImages } from './crystal-drag.js';
import { dislocationSlicePlanes } from './dislocation-layer.js';
import { effectivePeriodicOrigin } from './periodic-origin.js';
import { MAX_SLICE_PLANES, SLICE_EPSILON } from './slicing.js';
import { buildSurfaceDisplayMesh } from './surface-mesh-geometry.js';

/** Closed triangle meshes: the alpha-shape surface and the DXA defect mesh.
 * Each mesh is wrapped into the displayed cell, cut at its periodic faces and
 * closed there with cap polygons (see surface-mesh-geometry.js). Display
 * replication, slices and the crystal-drag preview are uniforms; only a
 * committed periodic origin rebuilds the wrapped geometry. */
export const SURFACE_MESH_DEFAULTS = Object.freeze({
  surface: Object.freeze({ visible: true, color: '#c9d4e3', interiorColor: '#b5524a', capColor: '#8fa3bf', opacity: 1, caps: true }),
  dxaDefect: Object.freeze({ visible: true, color: '#d9c06a', interiorColor: '#c7ae5c', capColor: '#b39b52', opacity: 1, caps: true }),
});
export const SURFACE_MESH_IDS = Object.freeze(Object.keys(SURFACE_MESH_DEFAULTS));

export function normalizeSurfaceMeshOptions(options = {}, previous = SURFACE_MESH_DEFAULTS.surface) {
  const settings = {};
  for (const name of ['color', 'interiorColor', 'capColor']) {
    settings[name] = options[name] ?? previous[name] ?? SURFACE_MESH_DEFAULTS.surface[name];
    parsePrimitiveColor(settings[name]);
  }
  const opacity = Number(options.opacity ?? previous.opacity ?? 1);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('Surface mesh opacity must be between zero and one.');
  return { ...settings, opacity, visible: Boolean(options.visible ?? previous.visible ?? true), caps: Boolean(options.caps ?? previous.caps ?? true) };
}

const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
uniform mat4 uView;
uniform mat4 uProjection;
uniform vec3 uOffset;
out vec3 vWorld;
out vec3 vNormal;
out vec3 vView;
void main() {
  vWorld = aPosition + uOffset;
  vNormal = mat3(uView) * aNormal;
  vec4 view = uView * vec4(vWorld, 1.0);
  vView = view.xyz;
  gl_Position = uProjection * view;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
in vec3 vView;
uniform mat4 uProjection;
uniform vec3 uColor;
uniform vec3 uInteriorColor;
uniform float uOpacity;
uniform int uSliceCount;
uniform vec4 uSlicePlanes[${MAX_SLICE_PLANES}];
uniform bool uDragClip;
uniform mat3 uInverseCell;
uniform vec3 uCellOrigin;
uniform vec3 uClipMinimum;
uniform vec3 uClipMaximum;
out vec4 outColor;
void main() {
  // While a wrapped crystal is dragged, the committed pieces are drawn in
  // neighboring images and cut where they leave the displayed cell.
  if (uDragClip) {
    vec3 fractional = uInverseCell * (vWorld - uCellOrigin);
    if (any(lessThan(fractional, uClipMinimum)) || any(greaterThanEqual(fractional, uClipMaximum))) discard;
  }
  for (int plane = 0; plane < ${MAX_SLICE_PLANES}; plane++) {
    if (plane >= uSliceCount) break;
    if (dot(uSlicePlanes[plane].xyz, vWorld) > uSlicePlanes[plane].w + ${SLICE_EPSILON}) discard;
  }
  // The side facing the camera decides the color: the outside of the solid,
  // or its inside where a slice or an open cut exposes it.
  vec3 normal = normalize(vNormal);
  vec3 color = uColor;
  if (!gl_FrontFacing) { normal = -normal; color = uInteriorColor; }
  vec3 viewDirection = uProjection[3][3] > 0.5 ? vec3(0.0, 0.0, 1.0) : normalize(-vView);
  // The same view-space studio as atoms and Voronoi cells.
  vec3 key = normalize(vec3(-0.48, 0.62, 0.72));
  vec3 fill = normalize(vec3(0.68, -0.36, 0.48));
  float ambient = mix(0.20, 0.31, normal.y * 0.5 + 0.5);
  float light = ambient + 0.66 * max(0.0, dot(normal, key)) + 0.17 * max(0.0, dot(normal, fill));
  float specular = pow(max(0.0, dot(normal, normalize(key + viewDirection))), 28.0) * 0.14;
  vec3 linear = pow(color, vec3(2.2)) * light + vec3(1.0, 0.96, 0.88) * specular;
  outColor = vec4(pow(clamp(linear, 0.0, 1.0), vec3(1.0 / 2.2)), uOpacity);
}`;

const UNIFORMS = ['uView', 'uProjection', 'uOffset', 'uColor', 'uInteriorColor', 'uOpacity', 'uSliceCount', 'uSlicePlanes[0]',
  'uDragClip', 'uInverseCell', 'uCellOrigin', 'uClipMinimum', 'uClipMaximum'];

function createProgram(gl) {
  const program = gl.createProgram();
  for (const [kind, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
    const shader = gl.createShader(kind);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Surface mesh shader failed: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Surface mesh shader linking failed: ${gl.getProgramInfoLog(program)}`);
  return program;
}

/** What the renderer state implies for wrapped geometry: in wrapped display
 * the mesh is cut at the shifted cell; unwrapped display keeps the source
 * cell's cut and translates it with the atoms. */
export function surfaceMeshDisplayState(renderer) {
  const cell = renderer.frame.cell, wrapped = (renderer.coordinateMode ?? 'wrapped') !== 'unwrapped';
  const origin = effectivePeriodicOrigin(renderer.periodicOrigin ?? [0, 0, 0], cell), h = cell.vectors;
  return { origin: wrapped ? origin : [0, 0, 0],
    translation: wrapped ? [0, 0, 0] : [0, 1, 2].map(axis => -(origin[0] * h[axis] + origin[1] * h[3 + axis] + origin[2] * h[6 + axis])) };
}

export class SurfaceMeshLayer {
  constructor(gl) {
    this.gl = gl;
    this.program = createProgram(gl);
    this.uniforms = Object.fromEntries(UNIFORMS.map(name => [name, gl.getUniformLocation(this.program, name)]));
    this.entries = new Map();
  }

  entry(id) {
    let entry = this.entries.get(id);
    if (!entry) {
      const gl = this.gl;
      entry = { id, mesh: null, display: null, options: normalizeSurfaceMeshOptions({}, SURFACE_MESH_DEFAULTS[id] ?? SURFACE_MESH_DEFAULTS.surface),
        vao: gl.createVertexArray(), buffer: gl.createBuffer(), indexBuffer: gl.createBuffer(), displayKey: null, cell: null, error: null };
      gl.bindVertexArray(entry.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
      for (let attribute = 0; attribute < 2; attribute += 1) {
        gl.enableVertexAttribArray(attribute);
        gl.vertexAttribPointer(attribute, 3, gl.FLOAT, false, 24, attribute * 12);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, entry.indexBuffer);
      gl.bindVertexArray(null);
      this.entries.set(id, entry);
    }
    return entry;
  }

  /** mesh: { vertices, triangles, reverse, spaceFilling } or null. Options
   * alone (color, opacity, visibility) never rebuild geometry; the cap
   * toggle does, because caps are part of the wrapped mesh. */
  setMesh(renderer, id, mesh, options = {}) {
    const entry = this.entry(id);
    entry.options = normalizeSurfaceMeshOptions(options, entry.options);
    if (!mesh) { this.release(entry); return entry; }
    if (!renderer.frame) throw new Error('Load a structure before displaying a surface mesh.');
    const state = surfaceMeshDisplayState(renderer);
    const displayKey = JSON.stringify([state.origin, entry.options.caps]);
    if (entry.mesh !== mesh || entry.cell !== renderer.frame.cell || entry.displayKey !== displayKey) {
      entry.mesh = mesh; entry.cell = renderer.frame.cell; entry.displayKey = displayKey;
      this.upload(entry, state);
    }
    entry.translation = state.translation;
    return entry;
  }

  upload(entry, state) {
    const gl = this.gl, startedAt = performance.now();
    try {
      entry.display = buildSurfaceDisplayMesh(entry.mesh, entry.cell, { origin: state.origin, caps: entry.options.caps,
        reverse: Boolean(entry.mesh.reverse), spaceFilling: Boolean(entry.mesh.spaceFilling) });
      entry.error = null;
    } catch (error) {
      // A mesh that cannot be wrapped is left out; the analysis result stays.
      entry.display = null; entry.error = error.message || String(error);
    }
    const display = entry.display, count = display?.vertexCount ?? 0, values = new Float32Array(count * 6);
    for (let vertex = 0; vertex < count; vertex += 1) {
      values[vertex * 6] = display.positions[vertex * 3]; values[vertex * 6 + 1] = display.positions[vertex * 3 + 1];
      values[vertex * 6 + 2] = display.positions[vertex * 3 + 2];
      values[vertex * 6 + 3] = display.normals[vertex * 3]; values[vertex * 6 + 4] = display.normals[vertex * 3 + 1];
      values[vertex * 6 + 5] = display.normals[vertex * 3 + 2];
    }
    gl.bindVertexArray(entry.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, entry.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, display?.indices ?? new Uint32Array(0), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    entry.buildMs = performance.now() - startedAt;
  }

  release(entry) {
    if (!entry.mesh && !entry.display) return;
    entry.mesh = entry.display = entry.cell = entry.displayKey = entry.error = null;
    const gl = this.gl;
    gl.bindVertexArray(entry.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, entry.buffer); gl.bufferData(gl.ARRAY_BUFFER, 0, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, entry.indexBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, 0, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  clear() { for (const entry of this.entries.values()) this.release(entry); }

  /** Rebuild after the periodic origin or coordinate mode changed. */
  refresh(renderer) {
    for (const entry of this.entries.values()) if (entry.mesh) this.setMesh(renderer, entry.id, entry.mesh, entry.options);
  }

  get active() { return [...this.entries.values()].some(entry => entry.display && entry.options.visible); }

  drawn(entry) { return Boolean(entry.display?.indices.length && entry.options.visible && entry.options.opacity > 0); }

  render(renderer) {
    const entries = [...this.entries.values()].filter(entry => this.drawn(entry));
    this.renderedTriangleCount = 0;
    if (!entries.length || !renderer.frame) return;
    const gl = this.gl, u = this.uniforms, planes = dislocationSlicePlanes(renderer), cell = renderer.frame.cell;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.uView, false, renderer.viewMatrix);
    gl.uniformMatrix4fv(u.uProjection, false, renderer.projectionMatrix);
    gl.uniform1i(u.uSliceCount, planes.count);
    gl.uniform4fv(u['uSlicePlanes[0]'], planes.values);
    // Opacity is blended, never dithered into multisample coverage.
    const coverage = gl.isEnabled(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    const drag = renderer.crystalDrag, clip = Boolean(drag?.wrap.some(Boolean));
    const images = drag ? crystalDragImages(cell, drag) : [[0, 0, 0]];
    gl.uniform1i(u.uDragClip, clip ? 1 : 0);
    if (clip) {
      gl.uniformMatrix3fv(u.uInverseCell, false, Float32Array.from(invert3(cell.vectors)));
      gl.uniform3f(u.uCellOrigin, ...cell.origin);
    }
    const repetitions = renderer.repetitions ?? [1, 1, 1];
    // Every triangle is submitted twice, once per facing.
    let drawn = 0;
    const draw = entry => {
      const { display, options } = entry, surface = parsePrimitiveColor(options.color), cap = parsePrimitiveColor(options.capColor);
      gl.bindVertexArray(entry.vao);
      gl.uniform3f(u.uInteriorColor, ...parsePrimitiveColor(options.interiorColor));
      gl.uniform1f(u.uOpacity, options.opacity);
      for (const replica of renderer.replicas) {
        if (clip) {
          gl.uniform3f(u.uClipMinimum, ...replica.indices.map((value, axis) => drag.wrap[axis] ? value : -1e30));
          gl.uniform3f(u.uClipMaximum, ...replica.indices.map((value, axis) => drag.wrap[axis] ? value + 1 : 1e30));
        }
        for (const image of images) {
          gl.uniform3f(u.uOffset, ...replica.offset.map((value, axis) => value + image[axis] + (entry.translation?.[axis] ?? 0)));
          gl.uniform3f(u.uColor, ...surface);
          gl.drawElements(gl.TRIANGLES, display.surfaceIndexCount, gl.UNSIGNED_INT, 0);
          drawn += display.surfaceIndexCount / 3;
          // Caps close the outer faces of the displayed block. They belong to
          // the committed cut, so a wrapped drag preview leaves them out.
          if (clip) continue;
          gl.uniform3f(u.uColor, ...cap);
          for (const range of display.capRanges) {
            const index = replica.indices[range.axis];
            if (range.side ? index !== repetitions[range.axis] - 1 : index !== 0) continue;
            gl.drawElements(gl.TRIANGLES, range.count, gl.UNSIGNED_INT, range.first * 4);
            drawn += range.count / 3;
          }
        }
      }
    };
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    const opaque = entries.filter(entry => entry.options.opacity >= 1);
    if (opaque.length) {
      // Interior faces first and slightly deeper, then exterior faces. Where a
      // surface folds away from the camera, both have the same depth along
      // the fold and steep faces round it differently; drawn in one pass or
      // without the offset, interior color bleeds onto the outline.
      gl.cullFace(gl.FRONT);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(4, 16);
      for (const entry of opaque) draw(entry);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.cullFace(gl.BACK);
      for (const entry of opaque) draw(entry);
    }
    const translucent = entries.filter(entry => entry.options.opacity < 1);
    if (translucent.length) {
      // Rear faces first, then front faces, without writing depth: the
      // result does not depend on triangle order for a simple closed shape.
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      for (const face of [gl.FRONT, gl.BACK]) {
        gl.cullFace(face);
        for (const entry of translucent) draw(entry);
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    this.renderedTriangleCount = drawn / 2;
    if (coverage) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.bindVertexArray(null);
  }

  extendBounds(renderer, minimum, maximum) {
    for (const entry of this.entries.values()) {
      if (!entry.display?.vertexCount || !entry.options.visible) continue;
      for (let axis = 0; axis < 3; axis += 1) {
        const shift = entry.translation?.[axis] ?? 0;
        minimum[axis] = Math.min(minimum[axis], entry.display.minimum[axis] + shift + (renderer.minimumOffset?.[axis] ?? 0));
        maximum[axis] = Math.max(maximum[axis], entry.display.maximum[axis] + shift + (renderer.maximumOffset?.[axis] ?? 0));
      }
    }
  }
}
