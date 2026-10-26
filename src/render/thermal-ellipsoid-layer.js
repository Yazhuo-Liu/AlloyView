import { THERMAL_DEFAULTS, thermalProbabilityScale } from '../crystal/thermal-ellipsoids.js';
import { MAX_SLICE_PLANES, SLICE_EPSILON } from './slicing.js';
import { CRYSTAL_DRAG_GLSL, CRYSTAL_DRAG_UNIFORMS, applyCrystalDragUniforms } from './crystal-drag.js';
import { SCALAR_COLOR_GLSL, SCALAR_COLOR_UNIFORMS, applyScalarColorUniforms } from './scalar-colormap.js';

const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 aUnit;
layout(location=1) in vec3 aCenter;
layout(location=2) in vec3 aColor;
layout(location=3) in vec3 aFractional;
layout(location=4) in float aVisible;
layout(location=5) in vec3 aAxis0;
layout(location=6) in vec3 aAxis1;
layout(location=7) in vec3 aAxis2;
layout(location=8) in float aScalar;
layout(location=9) in float aColorOverride;
${SCALAR_COLOR_GLSL}
${CRYSTAL_DRAG_GLSL}
uniform mat4 uView;
uniform mat4 uProjection;
uniform float uScale;
uniform int uSliceAxis;
uniform float uSliceMaximum;
uniform int uSliceMode;
uniform int uSliceCount;
uniform vec4 uSlicePlanes[${MAX_SLICE_PLANES}];
uniform int uSelected;
uniform int uSelectedAtoms[19];
uniform vec3 uReplicaOffset;
uniform vec3 uReplicaIndex;
uniform vec3 uRepetitions;
out vec3 vNormal;
out vec3 vColor;
out vec3 vUnit;
flat out int vSelected;
void main() {
  vec3 center = aCenter + uReplicaOffset;
  vec3 drag = crystalDragStep(aFractional);
  if (uCrystalDrag) center += uCrystalCell * drag;
  mat3 axes = mat3(aAxis0, aAxis1, aAxis2);
  bool visible = aVisible > 0.5 && dot(aAxis0,aAxis0) > 0.0 && scalarShown(aScalar);
  if (uSliceMode == 0) visible = visible && (aFractional[uSliceAxis] + drag[uSliceAxis] + uReplicaIndex[uSliceAxis]) / uRepetitions[uSliceAxis] <= uSliceMaximum;
  else for (int plane = 0; plane < ${MAX_SLICE_PLANES}; plane++) {
    if (plane >= uSliceCount) break;
    if (dot(uSlicePlanes[plane].xyz, center) > uSlicePlanes[plane].w + ${SLICE_EPSILON}) visible = false;
  }
  gl_Position = visible ? uProjection * uView * vec4(center + axes * (aUnit * uScale), 1.0) : vec4(2.0,2.0,2.0,1.0);
  // Columns are orthogonal principal axes, so the inverse transpose is a
  // column-wise division by squared axis lengths, without a matrix inverse.
  vec3 normal = aAxis0 * aUnit.x / max(dot(aAxis0,aAxis0), 1e-30)
    + aAxis1 * aUnit.y / max(dot(aAxis1,aAxis1), 1e-30)
    + aAxis2 * aUnit.z / max(dot(aAxis2,aAxis2), 1e-30);
  vNormal = mat3(uView) * normal;
  vColor = scalarColor(aScalar, aColorOverride > 0.5, aColor);
  vUnit = aUnit;
  bool selected = gl_InstanceID == uSelected;
  for (int i = 0; i < 19; i++) selected = selected || gl_InstanceID == uSelectedAtoms[i];
  vSelected = selected ? 1 : 0;
}`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vColor;
in vec3 vUnit;
flat in int vSelected;
uniform float uOpacity;
out vec4 outColor;
void main() {
  vec3 normal = normalize(vNormal);
  if (!gl_FrontFacing) normal = -normal;
  float light = 0.3 + 0.65 * max(0.0,dot(normal,normalize(vec3(-0.48,0.62,0.72))));
  vec3 color = pow(clamp(pow(vColor,vec3(2.2)) * light,0.0,1.0),vec3(1.0/2.2));
  // Three principal great circles make axis orientation visible.
  float line = 1.0 - smoothstep(0.014, 0.035, min(abs(vUnit.x),min(abs(vUnit.y),abs(vUnit.z))));
  color = mix(color, vSelected == 1 ? vec3(1.0,0.67,0.2) : vec3(0.1), line * 0.65);
  if (vSelected == 1) color = mix(color, vec3(1.0,0.67,0.2),0.25);
  outColor = vec4(color, uOpacity);
}`;

export function normalizeThermalOptions(options = {}, previous = THERMAL_DEFAULTS) {
  const result = { ...THERMAL_DEFAULTS, ...previous, ...options };
  if (typeof result.enabled !== 'boolean') throw new Error('Thermal ellipsoid visibility must be boolean.');
  thermalProbabilityScale(result.probability);
  if (!Number.isFinite(result.opacity) || result.opacity < 0.05 || result.opacity > 1) throw new Error('Thermal ellipsoid opacity must be between 5% and 100%.');
  return { enabled: result.enabled, probability: result.probability, opacity: result.opacity };
}
export function thermalEllipsoidGeometry(data, atomCount) {
  if (data == null) return null;
  if (!(data.transforms instanceof Float32Array) || data.transforms.length !== atomCount * 9
    || !Number.isInteger(data.count) || data.count < 0 || data.count > atomCount
    || !Number.isFinite(data.maxRadius) || data.maxRadius < 0) throw new Error('Thermal ellipsoid geometry does not match the current atoms.');
  return data;
}

/** One small sphere mesh and nine floats per atom; appearance edits are uniforms.
 * All positions, colors and visibility buffers belong to the atom renderer. */
export class ThermalEllipsoidLayer {
  constructor(gl) {
    this.gl = gl; this.program = createProgram(gl);
    const names = ['uView','uProjection','uScale','uOpacity','uSliceAxis','uSliceMaximum','uSliceMode','uSliceCount','uSlicePlanes[0]',
      'uSelected','uSelectedAtoms[0]','uReplicaOffset','uReplicaIndex','uRepetitions', ...CRYSTAL_DRAG_UNIFORMS, ...SCALAR_COLOR_UNIFORMS];
    this.uniforms = Object.fromEntries(names.map(name => [name,gl.getUniformLocation(this.program,name)]));
    this.vao = gl.createVertexArray(); this.unitBuffer = gl.createBuffer(); this.axesBuffer = gl.createBuffer();
    const vertices = [], rings = 12, segments = 24;
    const point = (i,j) => { const a=i*Math.PI/rings,b=j*2*Math.PI/segments; return [Math.sin(a)*Math.cos(b),Math.sin(a)*Math.sin(b),Math.cos(a)]; };
    for (let i=0;i<rings;i++) for (let j=0;j<segments;j++) {
      const a=point(i,j),b=point(i+1,j),c=point(i+1,j+1),d=point(i,j+1);
      if (i>0) vertices.push(...a,...b,...d);
      if (i<rings-1) vertices.push(...b,...c,...d);
    }
    this.vertexCount=vertices.length/3;
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER,this.unitBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
    gl.bindVertexArray(null); this.data=null; this.options=normalizeThermalOptions();
  }
  setGeometry(data,options) {
    this.options=normalizeThermalOptions(options,this.options);this.scale=thermalProbabilityScale(this.options.probability);
    if(data!==this.data){this.data=data;this.gl.bindBuffer(this.gl.ARRAY_BUFFER,this.axesBuffer);this.gl.bufferData(this.gl.ARRAY_BUFFER,data?.transforms??0,this.gl.STATIC_DRAW);}
  }
  bind(renderer) {
    const gl=this.gl;gl.bindVertexArray(this.vao);
    const attrs=[[1,renderer.positionBuffer,3,gl.FLOAT,false],[2,renderer.colorBuffer,3,gl.UNSIGNED_BYTE,true],
      [3,renderer.fractionalBuffer,3,gl.FLOAT,false],[4,renderer.visibilityBuffer,1,gl.UNSIGNED_BYTE,true],
      [8,renderer.scalarColorPreview ? renderer.scalarColorBuffer : null,1,gl.FLOAT,false],[9,renderer.scalarColorPreview ? renderer.colorOverrideBuffer : null,1,gl.UNSIGNED_BYTE,true]];
    for(const [location,buffer,size,type,normalized] of attrs){
      if(!buffer){gl.disableVertexAttribArray(location);gl.vertexAttrib1f(location,0);continue;}
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,size,type,normalized,0,0);gl.vertexAttribDivisor(location,1);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER,this.axesBuffer);
    for(let axis=0;axis<3;axis++){gl.enableVertexAttribArray(5+axis);gl.vertexAttribPointer(5+axis,3,gl.FLOAT,false,36,axis*12);gl.vertexAttribDivisor(5+axis,1);}
  }
  bindAtomMask(renderer) {
    const gl=this.gl;gl.bindVertexArray(renderer.sphereVao);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.axesBuffer);gl.enableVertexAttribArray(9);gl.vertexAttribPointer(9,3,gl.FLOAT,false,36,0);gl.vertexAttribDivisor(9,1);
    gl.bindVertexArray(null);
  }
  clear(){this.setGeometry(null,this.options);}
  render(renderer){
    if(!this.data?.count||!this.options.enabled||!renderer.frame)return;
    const gl=this.gl,u=this.uniforms;this.bind(renderer);gl.useProgram(this.program);
    gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(true);
    gl.uniformMatrix4fv(u.uView,false,renderer.viewMatrix);gl.uniformMatrix4fv(u.uProjection,false,renderer.projectionMatrix);
    gl.uniform1f(u.uScale,this.scale);gl.uniform1f(u.uOpacity,this.options.opacity);
    gl.uniform1i(u.uSliceAxis,renderer.sliceAxis??2);gl.uniform1f(u.uSliceMaximum,renderer.sliceMaximum??1);
    gl.uniform1i(u.uSliceMode,renderer.sliceMode==='planes'?1:0);gl.uniform1i(u.uSliceCount,renderer.sliceCount??0);
    gl.uniform4fv(u['uSlicePlanes[0]'],renderer.slicePlaneValues??new Float32Array(MAX_SLICE_PLANES*4));
    gl.uniform3f(u.uRepetitions,...(renderer.repetitions??[1,1,1]));
    gl.uniform1i(u.uSelected,renderer.selected??-1);
    const selected=new Int32Array(19).fill(-1),all=[...(renderer.selectedAtoms??[]),...(renderer.sliceSelectedAtoms??[])].filter(x=>x>=0);
    selected.set([...new Set(all)].slice(0,19));gl.uniform1iv(u['uSelectedAtoms[0]'],selected);
    applyCrystalDragUniforms(gl,u,renderer.crystalDrag);applyScalarColorUniforms(gl,u,renderer.scalarColorPreview);
    for(const replica of renderer.replicas??[{indices:[0,0,0],offset:[0,0,0]}]){
      gl.uniform3f(u.uReplicaOffset,...replica.offset);gl.uniform3f(u.uReplicaIndex,...replica.indices);
      gl.drawArraysInstanced(gl.TRIANGLES,0,this.vertexCount,renderer.atomCount);
    }
  }
  extendBounds(renderer,minimum,maximum){
    if(!this.data?.count||!this.options.enabled)return;
    const radius=this.data.maxRadius*this.scale;
    // Existing scene bounds contain every displayed center and replica.
    for(let axis=0;axis<3;axis++){minimum[axis]-=radius;maximum[axis]+=radius;}
  }
}
function createProgram(gl){
  const program=gl.createProgram();
  for(const [kind,source]of [[gl.VERTEX_SHADER,VERTEX],[gl.FRAGMENT_SHADER,FRAGMENT]]){
    const shader=gl.createShader(kind);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(`Thermal ellipsoid shader: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program,shader);gl.deleteShader(shader);
  }
  gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(`Thermal ellipsoid shader: ${gl.getProgramInfoLog(program)}`);
  return program;
}

/** Exact ray/quadric picking in view coordinates; returns the nearest surface z. */
export function thermalRayDepth(axes, atom, probabilityScale, view, center, projection, ndcX, ndcY) {
  const perspective = Math.abs(projection[11]) > 0.5;
  const origin = perspective ? [0, 0, 0] : [(ndcX - projection[12]) / projection[0], (ndcY - projection[13]) / projection[5], 0];
  const direction = perspective ? [(ndcX + projection[8]) / projection[0], (ndcY + projection[9]) / projection[5], -1] : [0, 0, -1];
  const delta = origin.map((x, i) => x - center[i]);
  let a = 0, b = 0, c = -1;
  for (let axis = 0; axis < 3; axis++) {
    const index = atom * 9 + axis * 3, x = axes[index], y = axes[index + 1], z = axes[index + 2];
    const column = [view[0] * x + view[4] * y + view[8] * z, view[1] * x + view[5] * y + view[9] * z, view[2] * x + view[6] * y + view[10] * z];
    const divisor = (x*x + y*y + z*z) * probabilityScale;
    if (!(divisor > 0)) return null;
    const q = column.reduce((sum, value, i) => sum + value * delta[i], 0) / divisor;
    const d = column.reduce((sum, value, i) => sum + value * direction[i], 0) / divisor;
    a += d*d; b += q*d; c += q*q;
  }
  const discriminant = b*b-a*c;
  if (!(discriminant >= 0) || !(a > 0)) return null;
  const near = (-b-Math.sqrt(discriminant))/a, far = (-b+Math.sqrt(discriminant))/a, t = near >= 0 ? near : far;
  return t >= 0 ? origin[2]+t*direction[2] : null;
}
