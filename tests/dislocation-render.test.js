import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { DXA_FAMILIES } from '../src/analysis/dxa.js';
import {
  DislocationLayer, clipDislocationSegment, createDislocationInstances,
  dislocationSlicePlanes, normalizeDislocationOptions,
} from '../src/render/dislocation-layer.js';
import { validateSlices } from '../src/render/slicing.js';
import { createReplication } from '../src/render/replication.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

const cell = createCell({ vectors: [10, 0, 0, 4, 8, 0, 0, 0, 12], origin: [4, 5, 6], triclinic: true });
const family = DXA_FAMILIES.fcc[0].id;
const network = points => ({ parameters: { lattice: 'fcc' }, segments: [{ id: 1, familyId: family, points }], totalLength: 2, density: 2 / 960 });
const near = (first, last, tolerance = 1e-6) => assert.ok(Math.abs(first - last) < tolerance, `${first} != ${last}`);

test('dislocation curves split at triclinic periodic faces without a cell-spanning connector', () => {
  const points = fractionalToCartesian(new Float64Array([0.9, 0.3, 0.4, 1.1, 0.3, 0.4]), cell, new Float64Array(6));
  const result = network(points), original = Array.from(points);
  const geometry = createDislocationInstances(result, cell);
  assert.equal(geometry.count, 2);
  near(geometry.values[0], 14.2);
  near(geometry.values[3], 15.2);
  near(geometry.values[9], 5.2);
  near(geometry.values[12], 6.2);
  let drawnLength = 0;
  for (let offset = 0; offset < geometry.values.length; offset += 9) {
    drawnLength += Math.hypot(...[0, 1, 2].map(axis => geometry.values[offset + 3 + axis] - geometry.values[offset + axis]));
  }
  near(drawnLength, 2);
  assert.deepEqual(Array.from(points), original);
  assert.equal(result.totalLength, 2);
  assert.equal(result.density, 2 / 960);
});

test('dislocation family filtering and coloring are independent of atom visibility', () => {
  const points = new Float64Array([7, 7, 8, 8, 7, 8]), result = network(points);
  assert.equal(createDislocationInstances(result, cell, { visibleFamilies: [] }).count, 0);
  assert.equal(createDislocationInstances(result, cell, { familyVisibility: { [family]: false } }).count, 0);
  const geometry = createDislocationInstances(result, cell, { visibleFamilies: [family], familyColors: { [family]: '#ff8000' } });
  assert.equal(geometry.count, 1);
  near(geometry.values[6], 1); near(geometry.values[7], 128 / 255); near(geometry.values[8], 0);
  const all = normalizeDislocationOptions({ visibleFamilies: null }, { visibleFamilies: [] });
  assert.equal(all.visibleFamilies, null);
  assert.throws(() => normalizeDislocationOptions({ radius: 0 }), /radius/);
  assert.throws(() => createDislocationInstances(network([7, 7, 8, NaN, 7, 8]), cell), /finite/);
});

test('multiple slice intersections retain the visible middle of a dislocation segment', () => {
  const slices = validateSlices([
    { normal: [1, 0, 0], position: 1, side: 'negative' },
    { normal: [1, 0, 0], position: -1, side: 'positive', id: 'lower' },
  ]);
  const clipped = clipDislocationSegment([-2, 0, 0], [2, 0, 0], slices, 0);
  assert.deepEqual(clipped, [[-1, 0, 0], [1, 0, 0]]);
  assert.equal(clipDislocationSegment([-2, 3, 0], [-2, 5, 0], slices), null);
  assert.deepEqual(clipDislocationSegment([-2, 0, 0], [2, 0, 0], slices.map(slice => ({ ...slice, enabled: false }))), [[-2, 0, 0], [2, 0, 0]]);
});

test('legacy slice planes use full inverse cell, origin and displayed repeat count', () => {
  const renderer = { frame: { cell }, sliceMode: 'legacy', sliceAxis: 0, sliceMaximum: 0.6, repetitions: [2, 1, 1] };
  const planes = dislocationSlicePlanes(renderer);
  const onPlane = fractionalToCartesian(new Float64Array([1.2, 0.8, 0.2]), cell, new Float64Array(3));
  const signed = point => [0, 1, 2].reduce((sum, axis) => sum + point[axis] * planes.values[axis], 0) - planes.values[3];
  near(signed(onPlane), 0);
  const inside = fractionalToCartesian(new Float64Array([1.1, 0.8, 0.2]), cell, new Float64Array(3));
  const outside = fractionalToCartesian(new Float64Array([1.3, 0.8, 0.2]), cell, new Float64Array(3));
  assert.ok(signed(inside) < 0); assert.ok(signed(outside) > 0);
  assert.equal(planes.count, 1);
});

function mockGl() {
  let next = 0, offset;
  const calls = { data: [], draws: [], shaders: [] };
  const gl = {
    ARRAY_BUFFER: 1, STATIC_DRAW: 2, FLOAT: 3, VERTEX_SHADER: 4, FRAGMENT_SHADER: 5, COMPILE_STATUS: 6, LINK_STATUS: 7, TRIANGLES: 8,
    createProgram: () => ({}), createShader: () => ({}), shaderSource(shader, source) { calls.shaders.push(source); },
    compileShader() {}, getShaderParameter: () => true, attachShader() {}, deleteShader() {}, linkProgram() {}, getProgramParameter: () => true,
    getUniformLocation: (program, name) => name, createVertexArray: () => ({}), createBuffer: () => ({ id: next++ }),
    bindVertexArray() {}, bindBuffer() {}, bufferData(target, values) { calls.data.push(values); },
    enableVertexAttribArray() {}, vertexAttribPointer() {}, vertexAttribDivisor() {}, useProgram() {},
    uniformMatrix4fv() {}, uniform1f() {}, uniform1i() {}, uniform4fv() {},
    uniform3f(location, ...value) { if (location === 'uReplicaOffset') offset = value; },
    drawArraysInstanced(mode, first, count, instances) { calls.draws.push({ count, instances, offset }); },
  };
  return { gl, calls };
}

test('display replication and slicing reuse dislocation source geometry and exports draw the same layer', () => {
  const { gl, calls } = mockGl(), layer = new DislocationLayer(gl);
  const renderer = { frame: { cell }, visibility: new Uint8Array([0]), viewMatrix: new Float32Array(16), projectionMatrix: new Float32Array(16),
    sliceMode: 'planes', sliceCount: 0, slicePlaneValues: new Float32Array(64), ...createReplication(cell, [2, 1, 1]) };
  const result = network(new Float64Array([7, 7, 8, 8, 7, 8]));
  layer.setNetwork(renderer, result, { radius: 0.25 });
  const uploads = calls.data.length;
  layer.render(renderer);
  assert.equal(calls.draws.length, 2);
  assert.ok(calls.draws.every(draw => draw.instances === 1));
  assert.deepEqual(calls.draws.map(draw => draw.offset), [[0, 0, 0], [10, 0, 0]]);
  renderer.sliceCount = 1;
  layer.render(renderer);
  layer.setNetwork(renderer, result, { radius: 0.4 });
  assert.equal(calls.data.length, uploads, 'changing slices, radius or display repeats must not upload a network again');
  assert.equal(result.totalLength, 2);
  layer.setNetwork(renderer, result, { enabled: false });
  const draws = calls.draws.length;
  layer.render(renderer);
  assert.equal(calls.draws.length, draws);
  layer.clear();
  assert.equal(layer.count, 0);
  assert.equal(calls.data.at(-1), 0);
  assert.ok(calls.shaders.every(shader => shader.includes('uSlicePlanes')), 'cylinder endpoints and surfaces are clipped');
});

test('clearing the dislocation renderer API retains the loaded analysis frame', () => {
  const renderer = Object.create(WebGLRenderer.prototype), frame = {};
  let redraws = 0;
  Object.assign(renderer, { frame, dislocationNetwork: {}, requestRender() { redraws += 1; } });
  renderer.setDislocationNetwork(null);
  assert.equal(renderer.frame, frame);
  assert.equal(renderer.dislocationNetwork, null);
  assert.equal(redraws, 1);
  assert.equal(renderer.dislocationOptions.radius, 0.2);
});
