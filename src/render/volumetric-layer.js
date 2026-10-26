import { invert3 } from '../data/model.js';
import { parsePrimitiveColor } from './atom-primitives.js';
import { dislocationSlicePlanes } from './dislocation-layer.js';
import { MAX_SLICE_PLANES, SLICE_EPSILON } from './slicing.js';

const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
uniform mat4 uView, uProjection;
uniform vec3 uOffset;
out vec3 vWorld, vNormal;
void main() {
  vWorld = aPosition + uOffset;
  vNormal = mat3(uView) * aNormal;
  gl_Position = uProjection * uView * vec4(vWorld, 1.0);
}`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec3 vWorld, vNormal;
uniform vec3 uColor, uCellOrigin, uReplica, uPeriodic;
uniform mat3 uInverseCell;
uniform bool uWrap;
uniform float uOpacity;
uniform int uSliceCount;
uniform vec4 uSlicePlanes[${MAX_SLICE_PLANES}];
out vec4 outColor;
void main() {
  if (uWrap) {
    vec3 f = uInverseCell * (vWorld - uReplica - uCellOrigin);
    for (int axis = 0; axis < 3; axis++) {
      if (uPeriodic[axis] > 0.5 && (f[axis] < 0.0 || f[axis] >= 1.0)) discard;
    }
  }
  for (int plane = 0; plane < ${MAX_SLICE_PLANES}; plane++) {
    if (plane >= uSliceCount) break;
    if (dot(uSlicePlanes[plane].xyz, vWorld) > uSlicePlanes[plane].w + ${SLICE_EPSILON}) discard;
  }
  vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 key = normalize(vec3(-0.48, 0.62, 0.72));
  float light = 0.32 + 0.62 * max(0.0, dot(n, key)) + 0.16 * max(0.0, dot(n, normalize(vec3(0.68,-0.36,0.48))));
  float shine = 0.14 * pow(max(0.0, dot(n, normalize(key + vec3(0,0,1)))), 28.0);
  outColor = vec4(pow(clamp(pow(uColor,vec3(2.2)) * light + shine, 0.0, 1.0),vec3(1.0/2.2)), uOpacity);
}`;

export function normalizeVolumetricSurfaceOptions(options = {}, previous = {}) {
  const color = options.color ?? previous.color ?? '#5b8def';
  parsePrimitiveColor(color);
  const visible = options.visible ?? previous.visible ?? true;
  const opacity = options.opacity ?? previous.opacity ?? 0.7;
  if (typeof visible !== 'boolean') throw new Error('Isosurface visibility must be boolean.');
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('Isosurface opacity must be between zero and one.');
  return { color, visible, opacity };
}

const geometryCache = new WeakMap();
/** The Worker normally supplies packed drawing arrays. The indexed fallback
 * keeps the public renderer usable for a direct CPU-kernel caller; it is packed
 * once and reused by the second view, styling and context restoration. */
export function volumetricSurfaceGeometry(mesh) {
  if (mesh == null) return null;
  if (geometryCache.has(mesh)) return geometryCache.get(mesh);
  let geometry = mesh.renderGeometry;
  if (geometry) {
    if (!(geometry.positions instanceof Float32Array) || !(geometry.normals instanceof Float32Array)
      || geometry.positions.length % 9 || geometry.normals.length !== geometry.positions.length
      || !geometry.bounds || geometry.bounds.length !== 6) throw new Error('Invalid packed isosurface geometry.');
  } else {
    const { vertices, triangles } = mesh;
    if (!ArrayBuffer.isView(vertices) || !ArrayBuffer.isView(triangles) || vertices.length % 3 || triangles.length % 3) throw new Error('Invalid isosurface geometry.');
    const positions = new Float32Array(triangles.length * 3), normals = new Float32Array(positions.length);
    const bounds = Float64Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
    for (let face = 0; face < triangles.length; face += 3) {
      for (let corner = 0; corner < 3; corner++) {
        const index = triangles[face + corner];
        if (!Number.isInteger(index) || index < 0 || index * 3 + 2 >= vertices.length) throw new Error('Invalid isosurface triangle index.');
        for (let axis = 0; axis < 3; axis++) {
          const value = vertices[index * 3 + axis], offset = (face + corner) * 3 + axis;
          if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new Error('Isosurface coordinates exceed the drawing range.');
          positions[offset] = value;
          bounds[axis] = Math.min(bounds[axis], value); bounds[axis + 3] = Math.max(bounds[axis + 3], value);
        }
      }
      const offset = face * 3;
      const a = [0,1,2].map(axis => positions[offset + 3 + axis] - positions[offset + axis]);
      const b = [0,1,2].map(axis => positions[offset + 6 + axis] - positions[offset + axis]);
      const n = [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]], length = Math.hypot(...n) || 1;
      for (let corner = 0; corner < 3; corner++) for (let axis = 0; axis < 3; axis++) normals[offset + corner * 3 + axis] = n[axis] / length;
    }
    geometry = { positions, normals, bounds };
  }
  geometryCache.set(mesh, geometry);
  return geometry;
}

/** Uniform translations split a periodic surface at the displayed cell faces.
 * They never wrap individual vertices or manufacture a closing cap. */
export function volumetricImages(renderer, mesh) {
  const cell = renderer.frame?.cell, vectors = cell?.vectors;
  const periodic = mesh?.grid?.periodic ?? [false,false,false];
  if (!vectors) return { offsets:[[0,0,0]], periodic:[0,0,0], wrap:false, shift:[0,0,0] };
  const wrap = renderer.coordinateMode !== 'unwrapped' && periodic.some(Boolean);
  const shift = [0,1,2].map(axis => periodic[axis]
    ? Number(renderer.periodicOrigin?.[axis] ?? 0) + Number(renderer.crystalDrag?.shift?.[axis] ?? 0) : 0);
  if (wrap) for (let axis = 0; axis < 3; axis++) shift[axis] -= Math.floor(shift[axis]);
  const choices = shift.map((value, axis) => wrap && periodic[axis] && value > 0 ? [0,1] : [0]);
  const offsets = [];
  for (const a of choices[0]) for (const b of choices[1]) for (const c of choices[2]) {
    offsets.push([0,1,2].map(axis => (a-shift[0])*vectors[axis] + (b-shift[1])*vectors[3+axis] + (c-shift[2])*vectors[6+axis]));
  }
  return {offsets,periodic:periodic.map(Number),wrap,shift};
}

function shaderProgram(gl) {
  const program = gl.createProgram(), shaders = [];
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX],[gl.FRAGMENT_SHADER, FRAGMENT]]) {
      const shader = gl.createShader(type); shaders.push(shader);
      gl.shaderSource(shader,source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Isosurface shader compilation failed.');
      gl.attachShader(program,shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Isosurface shader linking failed.');
    return program;
  } catch (error) { gl.deleteProgram(program); throw error; }
  finally { for (const shader of shaders) gl.deleteShader(shader); }
}

export class VolumetricLayer {
  constructor(gl) {
    this.gl = gl; this.program = shaderProgram(gl); this.vao = gl.createVertexArray();
    this.positionBuffer = gl.createBuffer(); this.normalBuffer = gl.createBuffer();
    this.uniforms = Object.fromEntries(['uView','uProjection','uOffset','uColor','uOpacity','uSliceCount','uSlicePlanes[0]',
      'uWrap','uInverseCell','uCellOrigin','uReplica','uPeriodic'].map(name=>[name,gl.getUniformLocation(this.program,name)]));
    gl.bindVertexArray(this.vao);
    for (const [index,buffer] of [[0,this.positionBuffer],[1,this.normalBuffer]]) {
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer); gl.enableVertexAttribArray(index); gl.vertexAttribPointer(index,3,gl.FLOAT,false,0,0);
    }
    gl.bindVertexArray(null); this.mesh = null; this.geometry = null; this.options = normalizeVolumetricSurfaceOptions();
  }
  setSurface(mesh, options) {
    const geometry = volumetricSurfaceGeometry(mesh);
    if (geometry !== this.geometry) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER,this.positionBuffer); gl.bufferData(gl.ARRAY_BUFFER,geometry?.positions ?? 0,gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER,this.normalBuffer); gl.bufferData(gl.ARRAY_BUFFER,geometry?.normals ?? 0,gl.STATIC_DRAW);
    }
    this.mesh = mesh; this.geometry = geometry; this.options = options;
  }
  clear() { if (this.geometry) this.setSurface(null,this.options); }
  extendBounds(renderer, minimum, maximum) {
    if (!this.geometry?.positions.length || !this.options.visible) return;
    const {offsets,wrap} = volumetricImages(renderer,this.mesh), bounds = this.geometry.bounds;
    // Wrapped periodic pieces lie in the already bounded cell. Open grid axes
    // and unwrapped views still need the actual mesh extent (e.g. Cube origin).
    if (wrap && this.mesh?.grid?.periodic?.every(Boolean)) return;
    for (const replica of renderer.replicas ?? [{offset:[0,0,0]}]) for (const offset of offsets) for (let axis=0;axis<3;axis++) {
      minimum[axis] = Math.min(minimum[axis],bounds[axis]+offset[axis]+replica.offset[axis]);
      maximum[axis] = Math.max(maximum[axis],bounds[axis+3]+offset[axis]+replica.offset[axis]);
    }
  }
  render(renderer) {
    this.renderedImageCount = 0;
    if (!this.geometry?.positions.length || !this.options.visible || this.options.opacity === 0) return;
    const gl=this.gl,u=this.uniforms,{offsets,periodic,wrap}=volumetricImages(renderer,this.mesh), cell=renderer.frame.cell;
    gl.useProgram(this.program); gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(u.uView,false,renderer.viewMatrix); gl.uniformMatrix4fv(u.uProjection,false,renderer.projectionMatrix);
    gl.uniform3f(u.uColor,...parsePrimitiveColor(this.options.color)); gl.uniform1f(u.uOpacity,this.options.opacity);
    const slices=dislocationSlicePlanes(renderer);
    gl.uniform1i(u.uSliceCount,slices.count); gl.uniform4fv(u['uSlicePlanes[0]'],slices.values);
    gl.uniform1i(u.uWrap,wrap?1:0); gl.uniform3f(u.uPeriodic,...periodic);
    gl.uniformMatrix3fv(u.uInverseCell,false,Float32Array.from(invert3(cell.vectors))); gl.uniform3f(u.uCellOrigin,...cell.origin);
    gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(this.options.opacity === 1);
    for (const replica of renderer.replicas ?? [{offset:[0,0,0]}]) {
      gl.uniform3f(u.uReplica,...replica.offset);
      for (const offset of offsets) {
        gl.uniform3f(u.uOffset,...offset.map((value,axis)=>value+replica.offset[axis]));
        gl.drawArrays(gl.TRIANGLES,0,this.geometry.positions.length/3); this.renderedImageCount++;
      }
    }
    gl.depthMask(true); gl.disable(gl.BLEND); gl.bindVertexArray(null);
  }
  dispose() {
    const gl=this.gl; gl.deleteBuffer(this.positionBuffer); gl.deleteBuffer(this.normalBuffer);
    gl.deleteVertexArray(this.vao); gl.deleteProgram(this.program); this.mesh=null; this.geometry=null;
  }
}
