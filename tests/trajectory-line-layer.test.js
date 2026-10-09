import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell } from '../src/data/model.js';
import { createReplication } from '../src/render/replication.js';
import { TrajectoryLineLayer, normalizeTrajectoryLineOptions } from '../src/render/trajectory-line-layer.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
const lines = () => ({ vertices: Float32Array.from([1, 1, 1, 0, 12, 1, 1, -2, 3, 3, 3, 0, 4, 4, 4, -2]), vertexCount: 4, lineCount: 2,
  bounds: { minimum: [1, 1, 1], maximum: [12, 4, 4] } });

function mockGl() {
  const calls = { data: [], draws: [], uniforms: {}, shaders: [], culling: [] };
  let culling = true;
  const gl = {
    ARRAY_BUFFER: 1, STATIC_DRAW: 2, FLOAT: 3, VERTEX_SHADER: 4, FRAGMENT_SHADER: 5, COMPILE_STATUS: 6, LINK_STATUS: 7, TRIANGLE_STRIP: 8, CULL_FACE: 9,
    createProgram: () => ({}), createShader: () => ({}), shaderSource(shader, source) { calls.shaders.push(source); }, compileShader() {},
    getShaderParameter: () => true, attachShader() {}, deleteShader() {}, linkProgram() {}, getProgramParameter: () => true, deleteProgram() {},
    getUniformLocation: (program, name) => name, createVertexArray: () => ({}), createBuffer: () => ({}), bindVertexArray() {}, bindBuffer() {},
    bufferData(target, values) { calls.data.push(values); }, enableVertexAttribArray() {}, vertexAttribPointer() {}, vertexAttribDivisor() {},
    useProgram() {}, isEnabled: () => culling, enable() { culling = true; calls.culling.push(true); }, disable() { culling = false; calls.culling.push(false); },
    uniformMatrix4fv() {}, uniform1i(name, value) { calls.uniforms[name] = value; }, uniform4fv(name, value) { calls.uniforms[name] = value; },
    uniform1f(name, value) { calls.uniforms[name] = value; }, uniform2f(name, ...value) { calls.uniforms[name] = value; },
    uniform3f(name, ...value) { if (name === 'uOffset') calls.uniforms.offsets = [...(calls.uniforms.offsets ?? []), value]; else calls.uniforms[name] = value; },
    drawArraysInstanced(mode, first, count, instances) { calls.draws.push({ mode, count, instances }); },
  };
  return { gl, calls };
}

function renderer(overrides = {}) {
  return { frame: { cell }, canvas: { width: 800, height: 600, clientWidth: 400 }, renderViewport: null, viewProjectionMatrix: new Float32Array(16),
    sliceMode: 'planes', sliceCount: 0, slicePlaneValues: new Float32Array(64), periodicOrigin: [0, 0, 0], ...createReplication(cell, [1, 1, 1]), ...overrides };
}

test('line options are validated and merged', () => {
  assert.deepEqual(normalizeTrajectoryLineOptions(), { visible: true, color: '#ff9f1c', width: 2, colorByTime: false, colorScheme: 'viridis' });
  assert.deepEqual(normalizeTrajectoryLineOptions({ width: 4, color: '#ABCDEF' }, normalizeTrajectoryLineOptions({ colorByTime: true })),
    { visible: true, color: '#abcdef', width: 4, colorByTime: true, colorScheme: 'viridis' });
  assert.throws(() => normalizeTrajectoryLineOptions({ width: 0.1 }), /width/);
  assert.throws(() => normalizeTrajectoryLineOptions({ color: 'red' }), /hex/);
  assert.throws(() => normalizeTrajectoryLineOptions({ colorScheme: 'nope' }), /scheme/);
});

test('one instanced segment per vertex pair, pixel widths scaled for exports, replicas and the periodic origin', () => {
  const { gl, calls } = mockGl(), layer = new TrajectoryLineLayer(gl), result = lines();
  layer.setLines(result, { width: 3 });
  layer.setLines(result, { width: 3, colorByTime: true });
  assert.equal(calls.data.filter(value => value === result.vertices).length, 1, 'appearance edits reuse the uploaded vertices');
  layer.render(renderer());
  assert.deepEqual(calls.draws.at(-1), { mode: gl.TRIANGLE_STRIP, count: 4, instances: 3 });
  assert.equal(calls.uniforms.uWidth, 6, 'CSS pixels times the device pixel ratio');
  assert.deepEqual(calls.uniforms.uViewport, [800, 600]);
  assert.equal(calls.uniforms.uColorByTime, 1);
  assert.deepEqual(calls.culling, [false, true], 'ribbons draw with culling disabled, then restore it');
  layer.render(renderer({ renderViewport: { lineScale: 4, tile: { renderWidth: 1000, renderHeight: 700 } } }));
  assert.equal(calls.uniforms.uWidth, 24, 'exports scale the width like cell outlines');
  assert.deepEqual(calls.uniforms.uViewport, [1000, 700]);
  calls.uniforms.offsets = [];
  layer.render(renderer({ periodicOrigin: [0.5, 0, 0], ...createReplication(cell, [2, 1, 1]) }));
  assert.deepEqual(calls.uniforms.offsets, [[-5, 0, 0], [5, 0, 0]]);
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  layer.extendBounds(renderer({ periodicOrigin: [0.5, 0, 0] }), minimum, maximum);
  assert.deepEqual(minimum, [-4, 1, 1]);
  assert.deepEqual(maximum, [7, 4, 4]);
  const draws = calls.draws.length;
  layer.setLines(result, { visible: false });
  layer.render(renderer());
  assert.equal(calls.draws.length, draws);
  layer.setLines(null);
  assert.equal(layer.count, 0);
  assert.ok(calls.shaders[0].includes('aFirst.w < 0.0'), 'the last point of each path starts no segment');
  assert.ok(calls.shaders[1].includes('uSlicePlanes'), 'lines are clipped by slices');
});

test('the renderer line API accepts options before any lines or frame exist', () => {
  const view = Object.create(WebGLRenderer.prototype);
  let redraws = 0;
  Object.assign(view, { frame: null, trajectoryLineLayer: null, requestRender() { redraws += 1; } });
  view.setTrajectoryLines(null, { width: 5 });
  assert.equal(view.trajectoryLines, null);
  assert.equal(view.trajectoryLineOptions.width, 5);
  assert.equal(redraws, 1);
});
