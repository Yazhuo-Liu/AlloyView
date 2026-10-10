import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell } from '../src/data/model.js';
import { createCrystalDragState } from '../src/render/crystal-drag.js';
import { createReplication } from '../src/render/replication.js';
import {
  SURFACE_MESH_DEFAULTS, SURFACE_MESH_IDS, SurfaceMeshLayer, normalizeSurfaceMeshOptions, surfaceMeshDisplayState,
} from '../src/render/surface-mesh-layer.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });

/** A box [8, 12] × [3, 7] × [4, 6] with wrapped vertices: it crosses the a face. */
function crossingBox() {
  const vertices = [];
  for (let corner = 0; corner < 8; corner += 1) vertices.push(corner & 1 ? 2 : 8, corner & 2 ? 7 : 3, corner & 4 ? 6 : 4);
  const quads = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]];
  return { vertices: Float64Array.from(vertices), triangles: Uint32Array.from(quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d])) };
}

function mockGl() {
  const calls = { data: [], draws: [], shaders: [], state: [] };
  let offset = [0, 0, 0], color = null, opacity = null, cull = null, blend = false, depthMask = true, clip = 0, vao = null, polygonOffset = null;
  const enabled = new Set(['CULL_FACE', 'SAMPLE_ALPHA_TO_COVERAGE']);
  const gl = {
    VERTEX_SHADER: 'vertex', FRAGMENT_SHADER: 'fragment', ARRAY_BUFFER: 'array', ELEMENT_ARRAY_BUFFER: 'element', STATIC_DRAW: 'static',
    FLOAT: 'float', TRIANGLES: 'triangles', UNSIGNED_INT: 'uint', COMPILE_STATUS: 'compiled', LINK_STATUS: 'linked',
    BLEND: 'BLEND', CULL_FACE: 'CULL_FACE', SAMPLE_ALPHA_TO_COVERAGE: 'SAMPLE_ALPHA_TO_COVERAGE', FRONT: 'front', BACK: 'back',
    SRC_ALPHA: 1, ONE_MINUS_SRC_ALPHA: 2, ONE: 3,
    createProgram: () => ({}), createShader: kind => ({ kind }), shaderSource(shader, source) { calls.shaders.push(source); },
    compileShader() {}, getShaderParameter: () => true, attachShader() {}, deleteShader() {}, linkProgram() {}, getProgramParameter: () => true,
    getUniformLocation: (program, name) => name, createVertexArray: () => ({ id: calls.state.length + Math.random() }), createBuffer: () => ({}),
    bindVertexArray(value) { vao = value; }, bindBuffer() {}, bufferData(target, values) { calls.data.push({ target, values }); },
    enableVertexAttribArray() {}, vertexAttribPointer() {}, useProgram() {},
    uniformMatrix4fv() {}, uniformMatrix3fv() {}, uniform4fv() {},
    uniform1f(location, value) { if (location === 'uOpacity') opacity = value; },
    uniform1i(location, value) { if (location === 'uDragClip') clip = value; },
    uniform3f(location, ...value) { if (location === 'uOffset') offset = value; if (location === 'uColor') color = value; },
    enable(flag) { enabled.add(flag); if (flag === 'BLEND') blend = true; }, disable(flag) { enabled.delete(flag); if (flag === 'BLEND') blend = false; },
    POLYGON_OFFSET_FILL: 'POLYGON_OFFSET_FILL', polygonOffset(factor, units) { polygonOffset = [factor, units]; },
    isEnabled: flag => enabled.has(flag), cullFace(face) { cull = face; }, depthMask(value) { depthMask = value; }, blendFuncSeparate() {},
    drawElements(mode, count, type, first) {
      calls.draws.push({ count, first, offset, color, opacity, cull: enabled.has('CULL_FACE') ? cull : null, blend, depthMask, clip, vao,
        coverage: enabled.has('SAMPLE_ALPHA_TO_COVERAGE'), polygonOffset: enabled.has('POLYGON_OFFSET_FILL') ? polygonOffset : null });
    },
  };
  return { gl, calls, enabled };
}

function rendererFor(repetitions = [1, 1, 1], frameCell = cell) {
  return { frame: { cell: frameCell }, viewMatrix: new Float32Array(16), projectionMatrix: new Float32Array(16), periodicOrigin: [0, 0, 0],
    coordinateMode: 'wrapped', sliceMode: 'planes', sliceCount: 0, slicePlaneValues: new Float32Array(128), crystalDrag: null,
    ...createReplication(frameCell, repetitions) };
}

test('mesh style options are validated and merged with the defaults of each mesh', () => {
  assert.deepEqual(SURFACE_MESH_IDS, ['surface', 'dxaDefect']);
  assert.deepEqual(normalizeSurfaceMeshOptions(), { ...SURFACE_MESH_DEFAULTS.surface });
  const custom = normalizeSurfaceMeshOptions({ opacity: 0.4, caps: false, color: '#102030' }, SURFACE_MESH_DEFAULTS.dxaDefect);
  assert.deepEqual(custom, { ...SURFACE_MESH_DEFAULTS.dxaDefect, opacity: 0.4, caps: false, color: '#102030' });
  assert.deepEqual(normalizeSurfaceMeshOptions({ visible: false }, custom), { ...custom, visible: false });
  for (const invalid of [{ opacity: -0.1 }, { opacity: 1.5 }, { opacity: NaN }, { color: 'red' }, { capColor: '#12' }]) {
    assert.throws(() => normalizeSurfaceMeshOptions(invalid), /opacity|color/i);
  }
});

test('replicated display draws the wrapped surface in every copy and caps only on the outer faces', () => {
  const { gl, calls } = mockGl(), layer = new SurfaceMeshLayer(gl), renderer = rendererFor([3, 1, 1]), mesh = crossingBox();
  const entry = layer.setMesh(renderer, 'surface', mesh, {});
  assert.equal(entry.error, null);
  assert.deepEqual(entry.display.capRanges.map(range => [range.axis, range.side]), [[0, 0], [0, 1]]);
  const uploads = calls.data.length;
  assert.equal(uploads, 2, 'one vertex and one index upload');
  assert.equal(calls.data[0].values.length, entry.display.vertexCount * 6, 'interleaved float32 position and normal');
  assert.ok(calls.data[0].values instanceof Float32Array && calls.data[1].values instanceof Uint32Array);
  layer.render(renderer);
  // Opaque meshes are two-sided: interior faces first, pushed slightly back,
  // then exterior faces, so a fold never shows interior color on its outline.
  const interior = calls.draws.filter(draw => draw.cull === 'front'), exterior = calls.draws.filter(draw => draw.cull === 'back');
  assert.equal(interior.length + exterior.length, calls.draws.length);
  assert.deepEqual(interior.map(draw => [draw.count, draw.first, draw.offset]), exterior.map(draw => [draw.count, draw.first, draw.offset]));
  assert.ok(calls.draws.indexOf(exterior[0]) > calls.draws.indexOf(interior.at(-1)));
  assert.ok(interior.every(draw => draw.polygonOffset?.[0] > 0) && exterior.every(draw => draw.polygonOffset === null));
  const surfaceDraws = exterior.filter(draw => draw.first === 0), capDraws = exterior.filter(draw => draw.first !== 0);
  assert.deepEqual(surfaceDraws.map(draw => draw.offset), [[0, 0, 0], [10, 0, 0], [20, 0, 0]]);
  assert.ok(surfaceDraws.every(draw => draw.count === entry.display.surfaceIndexCount));
  // Lower cap in the first copy, upper cap in the last: interior cell faces stay open to their neighbors.
  assert.deepEqual(capDraws.map(draw => [draw.offset[0], draw.first]), [[0, entry.display.capRanges[0].first * 4], [20, entry.display.capRanges[1].first * 4]]);
  assert.ok(capDraws.every(draw => draw.count === entry.display.capRanges[0].count));
  assert.equal(layer.renderedTriangleCount, (3 * entry.display.surfaceIndexCount + 2 * entry.display.capRanges[0].count) / 3);
  // Opaque: depth-writing, no blending and no alpha-to-coverage.
  assert.ok(calls.draws.every(draw => !draw.blend && draw.depthMask && !draw.coverage && draw.opacity === 1));
  const surfaceColor = surfaceDraws[0].color, capColor = capDraws[0].color;
  assert.notDeepEqual(surfaceColor, capColor, 'caps use their own color');
  assert.ok(calls.shaders[1].includes('gl_FrontFacing') && calls.shaders[1].includes('uInteriorColor'), 'two-sided shading with an interior color');
  assert.ok(calls.shaders[1].includes('uSlicePlanes'), 'slices clip the mesh');
  // Style changes and replication never upload geometry again.
  layer.setMesh(renderer, 'surface', mesh, { color: '#ff0000', interiorColor: '#00ff00', opacity: 0.5 });
  Object.assign(renderer, createReplication(cell, [1, 2, 1]));
  calls.draws.length = 0;
  layer.render(renderer);
  assert.equal(calls.data.length, uploads);
  // Translucent: rear faces of every copy first, then front faces, blended without depth writes.
  assert.deepEqual(calls.draws.map(draw => draw.cull), [...Array(6).fill('front'), ...Array(6).fill('back')]);
  assert.ok(calls.draws.every(draw => draw.blend && !draw.depthMask && draw.opacity === 0.5 && !draw.coverage));
  assert.equal(calls.draws.filter(draw => draw.first !== 0).length, 8, 'both a caps in both b copies, twice');
  assert.deepEqual(calls.draws[0].color, [1, 0, 0]);
  assert.ok(gl.isEnabled(gl.SAMPLE_ALPHA_TO_COVERAGE) && gl.isEnabled(gl.CULL_FACE), 'renderer state is restored');
  // Hidden or fully transparent meshes draw nothing; the cap toggle rebuilds without caps.
  calls.draws.length = 0;
  layer.setMesh(renderer, 'surface', mesh, { visible: false });
  layer.render(renderer);
  layer.setMesh(renderer, 'surface', mesh, { visible: true, opacity: 0 });
  layer.render(renderer);
  assert.equal(calls.draws.length, 0);
  assert.equal(calls.data.length, uploads);
  const uncapped = layer.setMesh(renderer, 'surface', mesh, { opacity: 1, caps: false });
  assert.equal(calls.data.length, uploads + 2);
  assert.equal(uncapped.display.capRanges.length, 0);
  layer.render(renderer);
  assert.ok(calls.draws.length === 4 && calls.draws.every(draw => draw.first === 0), 'two copies, both facings, no caps');
});

test('the periodic origin rebuilds the cut, a crystal drag previews it and unwrapped display translates it', () => {
  const { gl, calls } = mockGl(), layer = new SurfaceMeshLayer(gl), renderer = rendererFor(), mesh = crossingBox();
  const entry = layer.setMesh(renderer, 'surface', mesh, {});
  assert.deepEqual(surfaceMeshDisplayState(renderer), { origin: [0, 0, 0], translation: [0, 0, 0] });
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  layer.extendBounds(renderer, minimum, maximum);
  assert.deepEqual([minimum, maximum].map(values => values.map(value => Math.round(value * 1e9) / 1e9)), [[0, 3, 4], [10, 7, 6]]);
  // A committed origin of half a cell moves the box into the cell interior.
  renderer.periodicOrigin = [0.5, 0, 0];
  const uploads = calls.data.length;
  layer.refresh(renderer);
  assert.equal(calls.data.length, uploads + 2, 'the wrapped geometry is rebuilt once');
  assert.equal(entry.display.capRanges.length, 0);
  assert.deepEqual(entry.display.minimum.map(value => Math.round(value * 1e9) / 1e9), [3, 3, 4]);
  layer.refresh(renderer);
  assert.equal(calls.data.length, uploads + 2, 'an unchanged origin keeps the buffers');
  // While dragging in wrapped display: neighboring images, clipped to the cell, without caps.
  renderer.periodicOrigin = [0, 0, 0];
  layer.refresh(renderer);
  renderer.sceneBounds = { minimum: [0, 0, 0], maximum: [10, 10, 10] };
  renderer.crystalDrag = createCrystalDragState(renderer, [0.25, 0, 0]);
  calls.draws.length = 0;
  layer.render(renderer);
  assert.equal(calls.draws.length, 16, 'two images along each of the three wrapped axes, both facings');
  assert.ok(calls.draws.every(draw => draw.clip === 1 && draw.first === 0), 'caps of the committed cut are not drawn');
  assert.deepEqual([...new Set(calls.draws.map(draw => draw.offset[0]))].sort((a, b) => a - b), [-2.5, 7.5]);
  assert.ok(calls.shaders[1].includes('uDragClip') && calls.shaders[1].includes('uClipMinimum'));
  // Unwrapped display keeps the source cut and moves it with the atoms, caps included.
  renderer.crystalDrag = null;
  renderer.coordinateMode = 'unwrapped';
  renderer.periodicOrigin = [0.5, 0, 0];
  const before = calls.data.length;
  layer.refresh(renderer);
  assert.equal(calls.data.length, before, 'no rebuild: only a translation');
  assert.deepEqual(surfaceMeshDisplayState(renderer), { origin: [0, 0, 0], translation: [-5, -0, -0] });
  calls.draws.length = 0;
  layer.render(renderer);
  assert.deepEqual(calls.draws.map(draw => draw.offset[0]), Array(6).fill(-5));
  assert.equal(calls.draws.filter(draw => draw.first !== 0).length, 4);
  renderer.crystalDrag = createCrystalDragState(renderer, [0.25, 0, 0]);
  calls.draws.length = 0;
  layer.render(renderer);
  assert.equal(calls.draws.length, 6, 'one translated copy with its caps, both facings');
  assert.ok(calls.draws.every(draw => draw.clip === 0 && draw.offset[0] === -7.5));
  const lower = [Infinity, Infinity, Infinity], upper = [-Infinity, -Infinity, -Infinity];
  layer.extendBounds(renderer, lower, upper);
  assert.deepEqual([lower[0], upper[0]].map(value => Math.round(value * 1e9) / 1e9), [-5, 5]);
});

test('two meshes are kept apart, a mesh that cannot be wrapped is reported, and clearing releases buffers', () => {
  const { gl, calls } = mockGl(), layer = new SurfaceMeshLayer(gl), renderer = rendererFor(), mesh = crossingBox();
  const surface = layer.setMesh(renderer, 'surface', mesh, {});
  const defect = layer.setMesh(renderer, 'dxaDefect', { ...crossingBox(), reverse: true }, {});
  assert.equal(defect.options.color, SURFACE_MESH_DEFAULTS.dxaDefect.color);
  assert.equal(surface.options.color, SURFACE_MESH_DEFAULTS.surface.color);
  // Reversed: the solid is everything outside the box, so all six faces are capped.
  assert.equal(defect.display.capRanges.length, 6);
  assert.ok(layer.active);
  layer.render(renderer);
  assert.equal(new Set(calls.draws.map(draw => draw.vao)).size, 2);
  // A triangle with one edge longer than half the cell has no consistent periodic image.
  const invalid = layer.setMesh(renderer, 'surface', { vertices: Float64Array.of(1, 1, 1, 4, 1, 1, 7, 2, 1), triangles: Uint32Array.of(0, 1, 2) }, {});
  assert.match(invalid.error, /cannot be wrapped/);
  assert.equal(invalid.display, null);
  calls.draws.length = 0;
  layer.render(renderer);
  assert.ok(calls.draws.length > 0 && new Set(calls.draws.map(draw => draw.vao)).size === 1, 'the other mesh is still drawn');
  layer.clear();
  assert.equal(layer.active, false);
  assert.equal(calls.data.at(-1).values, 0);
  calls.draws.length = 0;
  layer.render(renderer);
  assert.equal(calls.draws.length, 0);
  assert.throws(() => layer.setMesh({ frame: null }, 'surface', mesh), /Load a structure/);
  assert.equal(layer.setMesh({ frame: null }, 'surface', null).mesh, null, 'clearing without a frame is valid');
});

test('the renderer owns the layer: frame changes clear meshes and the second view copies them', () => {
  const { gl } = mockGl();
  const create = () => Object.assign(Object.create(WebGLRenderer.prototype), { gl, ...rendererFor(), surfaceMeshLayer: null,
    updateSceneBounds() { this.boundsUpdates = (this.boundsUpdates ?? 0) + 1; }, requestRender() { this.renders = (this.renders ?? 0) + 1; } });
  const renderer = create(), mesh = crossingBox();
  assert.equal(renderer.setSurfaceMesh('surface', null), null, 'removing a mesh that was never shown creates no layer');
  assert.equal(renderer.surfaceMeshLayer, null);
  assert.deepEqual(renderer.surfaceMeshes(), []);
  const entry = renderer.setSurfaceMesh('surface', mesh, { opacity: 0.7 });
  assert.equal(entry.options.opacity, 0.7);
  assert.equal(renderer.boundsUpdates, 1);
  assert.deepEqual(renderer.surfaceMeshes().map(item => item.id), ['surface']);
  const second = create();
  second.copySurfaceMeshes(renderer);
  assert.deepEqual(second.surfaceMeshes().map(item => [item.id, item.mesh, item.options.opacity]), [['surface', mesh, 0.7]]);
  renderer.setSurfaceMesh('dxaDefect', { ...crossingBox(), reverse: true });
  renderer.setSurfaceMesh('surface', null);
  second.copySurfaceMeshes(renderer);
  assert.deepEqual(second.surfaceMeshes().map(item => item.id), ['dxaDefect'], 'removed meshes disappear from the second view');
  renderer.frame = null;
  assert.throws(() => renderer.setSurfaceMesh('surface', mesh), /Load a structure/);
});
