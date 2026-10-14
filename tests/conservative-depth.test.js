import assert from 'node:assert/strict';
import test from 'node:test';
import { conservativeSphereSources, createConservativeDepthProgram, orderedOpaqueReplicas, resetConservativeDepth } from '../src/render/conservative-depth.js';
const vertex = '#version 300 es\nvoid main() { gl_Position = uProjection * cornerView; }';
const fragment = '#version 300 es\nvoid main() { gl_FragDepth = surfaceClip.z / surfaceClip.w * 0.5 + 0.5; }';
test('sphere variant preserves xy/w and clamps depth before conservative comparison, including near-plane cases', () => {
  const sources = conservativeSphereSources(vertex, fragment);
  assert.match(sources.fragment, /layout\(depth_greater\)/); assert.match(sources.fragment, /clamp\(surfaceClip/);
  assert.match(sources.vertex, /raster\.z =/); assert.doesNotMatch(sources.vertex, /raster\.[xyw] =/);
  assert.match(sources.vertex, /raster.z >= -raster.w/); assert.match(sources.vertex, /front.w > 0.0/);
});
test('explicit NDC arithmetic slack prevents a real Float32 raster/fragment depth inversion', () => {
  const f = Math.fround, clamp = value => Math.min(1, Math.max(-1, value));
  const z = f(-6537.43115234375), radius = f(.004230954937760146), normal = f(.5263996187809632);
  const a = f(-1.0348789691925049), b = f(-305.2846984863281), project = value => f(f(a * value) + b), w = f(-z);
  const guard = f(f(radius * f(1.001)) + f(Math.abs(z) * f(.0000005)));
  const frontZ = f(z + guard), lower = clamp(f(project(frontZ) / f(-frontZ)));
  const surfaceZ = f(z + f(normal * radius));
  const fragmentDepth = f(f(f(project(surfaceZ) / f(-surfaceZ)) * .5) + .5);
  const rasterDepth = slack => f(f(f(f(clamp(Math.min(f(project(z) / w), f(lower - slack))) * w) / w) * .5) + .5);
  // This case invalidates depth_greater when only geometric radius padding is
  // used, regardless of mathematically correct ordering in real arithmetic.
  assert.ok(fragmentDepth < rasterDepth(0));
  const sources = conservativeSphereSources(vertex, fragment);
  const slack = Number(sources.vertex.match(/front\.z \/ front\.w - ([\d.]+)/)[1]);
  assert.ok(fragmentDepth >= rasterDepth(slack));
  assert.match(sources.vertex, /clamp\(front.z \/ front.w - [\d.]+, -1.0, 1.0\)/);
});
test('failed feature compilation cleans every object, caches refusal and uses original shaders', () => {
  let made = 0, shaders = 0, programs = 0, fallbacks = 0;
  const gl = { VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, getSupportedExtensions() { return []; },
    createProgram() { made++; return {}; }, createShader() { return {}; }, shaderSource() {}, compileShader() {},
    getShaderParameter() { return false; }, getShaderInfoLog() { return 'unsupported'; },
    deleteProgram() { programs++; }, deleteShader() { shaders++; } };
  const fallback = (_gl, v, f) => { assert.equal(v, vertex); assert.equal(f, fragment); fallbacks++; return {}; };
  assert.equal(createConservativeDepthProgram(gl, vertex, fragment, fallback).supported, false);
  assert.equal(createConservativeDepthProgram(gl, vertex, fragment, fallback).supported, false);
  assert.deepEqual([made, programs, shaders, fallbacks], [1, 1, 1, 2]);
});
test('replica sorting retains original ordinals and leaves overlapping or dragging geometry untouched', () => {
  const r = { replicas: [0, 10, -10].map(z => ({ offset: [0, 0, z] })), viewMatrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
    projectionMatrix: [1,0,0,0, 0,1,0,0, 0,0,-.001,0, 0,0,0,1],
    sourceBoundsCache: { minimum: [0,0,0], maximum: [1,1,1] }, maximumAtomRadius: .5, radiusScale: 1 };
  r.viewMatrix[14] = -100;
  assert.deepEqual(orderedOpaqueReplicas(r).map(row => row.ordinal), [1,0,2]);
  r.sourceBoundsCache.maximum[2] = 20; assert.deepEqual(orderedOpaqueReplicas(r).map(row => row.ordinal), [0,1,2]);
  r.sourceBoundsCache.maximum[2] = 1; r.crystalDrag = {}; assert.deepEqual(orderedOpaqueReplicas(r).map(row => row.ordinal), [0,1,2]);
});
test('replica ordering reuses bounded rows and invalidates changed mutable inputs and replacement copies', () => {
  const r = { replicas: [0,10,-10].map(z => ({ offset: [0,0,z] })), viewMatrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-100,1],
    projectionMatrix: [1,0,0,0, 0,1,0,0, 0,0,-.001,0, 0,0,0,1],
    sourceBoundsCache: { minimum: [0,0,0], maximum: [1,1,1] }, maximumAtomRadius: .5, radiusScale: 1 };
  const first = orderedOpaqueReplicas(r);
  assert.equal(orderedOpaqueReplicas(r), first);
  r.replicas[1].offset[2] = -20;
  assert.deepEqual(orderedOpaqueReplicas(r).map(row => row.ordinal), [0,2,1]);
  r.replicas[1] = { offset: [0,0,30] };
  assert.deepEqual(orderedOpaqueReplicas(r).map(row => row.ordinal), [1,0,2]);
  assert.equal(orderedOpaqueReplicas(r)[0].replica, r.replicas[1]);
  r.opaqueReplicaOrdering = false;
  assert.deepEqual(orderedOpaqueReplicas(r).map(row => row.ordinal), [0,1,2]);
});
test('Float32-collapsed offsets and quantized equal-depth copies retain original LEQUAL winners', () => {
  const r = { replicas: [0,10,-10].map(z => ({ offset: [0,0,z] })), viewMatrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-100,1],
    projectionMatrix: [1,0,0,0, 0,1,0,0, 0,0,-1e-9,0, 0,0,0,1],
    sourceBoundsCache: { minimum: [0,0,0], maximum: [1,1,1] }, maximumAtomRadius: .5, radiusScale: 1 };
  assert.deepEqual(orderedOpaqueReplicas(r).map(row => row.ordinal), [0,1,2]);
  r.projectionMatrix[10] = -.001;
  r.sourceBoundsCache.minimum[2] = r.sourceBoundsCache.maximum[2] = 1e12;
  r.viewMatrix[14] = -1e12 -100;
  assert.deepEqual(orderedOpaqueReplicas(r).map(row => row.ordinal), [0,1,2]);
});
test('context restoration retries an unsupported feature, and successful linking releases both shader objects', () => {
  let supported = false, made = 0, deleted = 0;
  const gl = { VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    getSupportedExtensions() { return []; }, createProgram() { made++; return {}; }, createShader() { return {}; },
    shaderSource() {}, compileShader() {}, getShaderParameter() { return supported; }, getShaderInfoLog() { return 'unsupported'; },
    attachShader() {}, linkProgram() {}, getProgramParameter() { return true; }, deleteProgram() {}, deleteShader() { deleted++; } };
  const fallback = () => ({});
  assert.equal(createConservativeDepthProgram(gl, vertex, fragment, fallback).supported, false);
  supported = true;
  assert.equal(createConservativeDepthProgram(gl, vertex, fragment, fallback).supported, false);
  resetConservativeDepth(gl);
  assert.equal(createConservativeDepthProgram(gl, vertex, fragment, fallback).supported, true);
  assert.equal(made, 2); assert.equal(deleted, 3);
});
test('a low precision shader implementation keeps the original depth path without compiling a candidate', () => {
  let compiled = false;
  const gl = { VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, HIGH_FLOAT: 3,
    getSupportedExtensions() { return []; }, getShaderPrecisionFormat() { return { precision: 16 }; },
    createProgram() { compiled = true; return {}; } };
  const fallback = (_gl, v, f) => { assert.equal(v, vertex); assert.equal(f, fragment); return {}; };
  const result = createConservativeDepthProgram(gl, vertex, fragment, fallback);
  assert.equal(result.supported, false); assert.match(result.reason, /Float32 highp/); assert.equal(compiled, false);
});
