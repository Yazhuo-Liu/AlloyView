import assert from 'node:assert/strict';
import test from 'node:test';
import { cartesianToFractional, createCell, fractionalToCartesian } from '../src/data/model.js';
import { createReplication } from '../src/data/replication.js';
import { DislocationLayer, createDislocationTubeGeometry, normalizeDislocationOptions } from '../src/render/dislocation-layer.js';
import { createDislocationVectorGeometry, createDislocationVectorPaths, sampleDislocationVectorPath } from '../src/render/dislocation-vectors.js';
import { DISLOCATION_VECTOR_DEFAULTS, DISLOCATION_VECTOR_MINIMUM, DISLOCATION_VECTOR_MAXIMUM } from '../src/render/dislocation-vector-style.js';

const openCell = createCell({ vectors: [20, 0, 0, 0, 20, 0, 0, 0, 20], pbc: [false, false, false] });
const cell = createCell({ vectors: [10, 0, 0, 4, 8, 0, 0, 0, 12], origin: [4, 5, 6], triclinic: true });
const network = (points, extra = {}) => ({ segments: [{ id: 3, familyId: 'perfect', points,
  burgersVector: [99, 0, 0], spatialBurgersVector: [0, 2, 0], ...extra }] });
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const vectorNear = (actual, expected, tolerance) => Array.from(actual).forEach((value, axis) => near(value, expected[axis], tolerance));
const enabled = { showLineDirections: true, showBurgersVectors: true };

test('vector options validate, copy annotations, preserve previous settings, and reset selection', () => {
  const annotation = { segmentId: 3, position: .25, flipped: true, signature: 'source' };
  const defaults = normalizeDislocationOptions();
  assert.equal(defaults.radius, .75);
  assert.equal(defaults.burgersVectorScale, 2);
  assert.equal(defaults.burgersVectorRadius, .84);
  assert.equal(defaults.lineDirectionRadius, .84);
  assert.equal(defaults.lineDirectionScale, 1);
  assert.equal(defaults.showLineDirections, false);
  const settings = normalizeDislocationOptions({ ...enabled, vectorAnnotations: [annotation], selectedVectorId: 3 });
  annotation.position = .9;
  assert.equal(settings.vectorAnnotations[0].position, .25);
  const next = normalizeDislocationOptions({ selectedVectorId: null }, settings);
  assert.equal(next.selectedVectorId, null);
  assert.notEqual(next.vectorAnnotations, settings.vectorAnnotations);
  assert.notEqual(next.vectorAnnotations[0], settings.vectorAnnotations[0]);
  assert.equal(next.showBurgersVectors, true);
  for (const name of Object.keys(DISLOCATION_VECTOR_DEFAULTS)) {
    for (const value of [0, -1, Infinity, NaN, '2', null, DISLOCATION_VECTOR_MINIMUM / 2, DISLOCATION_VECTOR_MAXIMUM + 1]) {
      assert.throws(() => normalizeDislocationOptions({ [name]: value }), /radius|scale/);
      assert.throws(() => createDislocationVectorGeometry([], openCell, { [name]: value }), /between/);
    }
    for (const value of [DISLOCATION_VECTOR_MINIMUM, DISLOCATION_VECTOR_MAXIMUM]) {
      assert.equal(normalizeDislocationOptions({ [name]: value })[name], value);
    }
    assert.equal(normalizeDislocationOptions({}, { [name]: 4 })[name], 4);
  }
  assert.throws(() => normalizeDislocationOptions({ showLineDirections: 1 }), /visibility/);
  assert.throws(() => normalizeDislocationOptions({ vectorAnnotations: [{ ...annotation, position: 1.01 }] }), /position/);
  assert.throws(() => normalizeDislocationOptions({ vectorAnnotations: [annotation, annotation] }), /distinct/);
  assert.throws(() => normalizeDislocationOptions({ vectorAnnotations: [{ ...annotation, flipped: 1 }] }), /reversal/);
  assert.throws(() => normalizeDislocationOptions({ selectedVectorId: -1 }), /identifier/);
});

test('one spatial Burgers arrow per source segment reverses both directions without changing anchors or analysis', () => {
  const result = network([1, 4, 4, 9, 4, 4]), original = structuredClone(result);
  const sources = createDislocationVectorPaths(result, openCell);
  const settings = { ...enabled, burgersVectorScale: 3, vectorAnnotations: [{ segmentId: 3, position: .4, flipped: false }] };
  const forward = createDislocationVectorGeometry(sources, openCell, settings).objects[0];
  const reversed = createDislocationVectorGeometry(sources, openCell, { ...settings,
    vectorAnnotations: [{ segmentId: 3, position: .4, flipped: true }] }).objects[0];
  vectorNear(forward.root, [4.2, 4, 4]);
  vectorNear(forward.burgersEnd, [4.2, 10, 4]);
  vectorNear(reversed.root, forward.root);
  vectorNear(reversed.burgers, forward.burgers.map(value => -value));
  vectorNear(reversed.tangent, forward.tangent.map(value => -value));
  vectorNear(reversed.lineStart, forward.lineEnd);
  vectorNear(reversed.lineEnd, forward.lineStart);
  assert.deepEqual(result, original);
});

test('anchor sampling uses smoothed displayed line and physical cumulative arc length', () => {
  const result = network([1, 2, 3, 3, 3, 3, 8, 8, 3, 11, 8, 4]);
  const sources = createDislocationVectorPaths(result, openCell), source = sources[0];
  const tube = createDislocationTubeGeometry(result, openCell).curves[0];
  vectorNear(source.paths[0].points, tube.points);
  const target = .61, sample = sampleDislocationVectorPath(source, target);
  let traveled = 0, expected;
  for (let index = 1; index < source.points.length; index++) {
    const first = source.points[index - 1], last = source.points[index];
    const distance = Math.hypot(...last.map((value, axis) => value - first[axis]));
    if (traveled + distance >= target * source.length) {
      const t = (target * source.length - traveled) / distance;
      expected = first.map((value, axis) => value + (last[axis] - value) * t); break;
    }
    traveled += distance;
  }
  vectorNear(sample.point, expected);
  near(Math.hypot(...sample.tangent), 1);
});

test('triclinic periodic cuts preserve one arrow and source fractions across all displayed pieces', () => {
  const points = fractionalToCartesian([.8, .8, .4, 1.2, 1.2, .4, 1.3, 1.3, .6], cell, new Float64Array(9));
  const result = network(points), sources = createDislocationVectorPaths(result, cell), source = sources[0];
  assert.equal(source.paths.length, 2);
  near(source.paths[0].fractions[0], 0); near(source.paths.at(-1).fractions.at(-1), 1);
  near(source.paths[0].fractions.at(-1), source.paths[1].fractions[0]);
  for (const path of source.paths) {
    const fractional = cartesianToFractional(path.points, cell, new Float64Array(path.points.length));
    assert.ok(fractional.every(value => value >= -1e-9 && value <= 1 + 1e-9));
    assert.ok(path.fractions.every((value, index) => index === 0 || value >= path.fractions[index - 1]));
  }
  const geometry = createDislocationVectorGeometry(sources, cell, enabled);
  assert.equal(geometry.objects.length, 1);
  assert.equal(geometry.objects[0].paths, source.paths);
  const seamFraction = source.paths[1].fractions[0];
  const atSeam = createDislocationVectorGeometry(sources, cell, { ...enabled,
    vectorAnnotations: [{ segmentId: 3, position: seamFraction, flipped: false }] }).objects[0];
  const roots = source.paths.flatMap(path => [Array.from(path.points.slice(0, 3)), Array.from(path.points.slice(-3))]);
  assert.ok(roots.some(point => Math.hypot(...point.map((value, axis) => value - atSeam.root[axis])) < 1e-8), 'exact seam root remains on a displayed path endpoint');
});

test('closed finite loops and periodic winding retain their native topology and complete arc length', () => {
  const loop = network([1, 1, 1, 7, 1, 1, 7, 7, 1, 1, 7, 1, 1, 1, 1], { closed: true });
  const [source] = createDislocationVectorPaths(loop, openCell);
  assert.equal(source.finiteLoop, true);
  vectorNear(sampleDislocationVectorPath(source, 0).point, sampleDislocationVectorPath(source, 1).point);
  vectorNear(sampleDislocationVectorPath(source, 0).tangent, sampleDislocationVectorPath(source, 1).tangent);
  const points = fractionalToCartesian([.2, .3, .1, .2, .3, 1.1], cell, new Float64Array(6));
  const [winding] = createDislocationVectorPaths(network(points, { closed: true, isInfinite: true }), cell);
  near(winding.length, 12);
  assert.equal(winding.finiteLoop, false);
  vectorNear(sampleDislocationVectorPath(winding, 1).point.map((value, axis) => value - winding.points[0][axis]), [0, 0, 12]);
  near(winding.paths.reduce((sum, path) => {
    for (let index = 3; index < path.points.length; index += 3) sum += Math.hypot(...[0, 1, 2].map(axis => path.points[index + axis] - path.points[index - 3 + axis]));
    return sum;
  }, 0), 12);
});

test('periodic origins, unwrapped coordinates and family visibility transform vector anchors consistently', () => {
  const points = fractionalToCartesian([.8, .3, .4, 1.2, .3, .4], cell, new Float64Array(6));
  const result = network(points);
  const display = { periodicOrigin: [.2, 0, 0], coordinateMode: 'unwrapped' };
  const sources = createDislocationVectorPaths(result, cell, {}, display);
  const geometry = createDislocationVectorGeometry(sources, cell, enabled);
  const tube = createDislocationTubeGeometry(result, cell, {}, display);
  vectorNear(sources[0].paths[0].points, tube.curves[0].points);
  vectorNear(geometry.objects[0].root, sampleDislocationVectorPath(sources[0], .5).point);
  assert.equal(createDislocationVectorPaths(result, cell, { familyVisibility: { perfect: false } }).length, 0);
  assert.equal(createDislocationVectorPaths(result, cell, { visibleFamilies: ['other'] }).length, 0);
});

test('screw vectors remain wider than the line and all arrow surfaces have finite normals and bounds', () => {
  const result = network([1, 4, 4, 18, 4, 4], { spatialBurgersVector: [2.5, 0, 0] });
  const geometry = createDislocationVectorGeometry(createDislocationVectorPaths(result, openCell), openCell, enabled);
  assert.ok(geometry.values.every(Number.isFinite));
  assert.ok(geometry.indexCount > 0);
  assert.ok(geometry.indices.every(index => index < geometry.vertexCount));
  assert.ok(geometry.maximum[1] - 4 > .75);
  assert.ok(geometry.maximum[2] - 4 > .75);
  for (let index = 0; index < geometry.values.length; index += 12) {
    near(Math.hypot(...geometry.values.slice(index + 6, index + 9)), 1, 1e-6);
    for (let axis = 0; axis < 3; axis++) {
      const coordinate = geometry.values[index + axis] + geometry.values[index + 3 + axis];
      assert.ok(coordinate >= geometry.minimum[axis] - 1e-6);
      assert.ok(coordinate <= geometry.maximum[axis] + 1e-6);
    }
  }
});

test('four arrow dimensions change independently and preserve anchors, native vectors and flip semantics', () => {
  const result = network([1, 4, 4, 18, 4, 4]), original = structuredClone(result);
  const sources = createDislocationVectorPaths(result, openCell);
  const geometry = options => createDislocationVectorGeometry(sources, openCell, { ...enabled, ...options });
  const base = geometry(), object = base.objects[0];
  const midpoint = value => value.lineStart.map((component, axis) => (component + value.lineEnd[axis]) / 2);
  const length = (start, end) => Math.hypot(...end.map((component, axis) => component - start[axis]));
  const rows = (mesh, kind) => {
    const output = [];
    for (let index = 0; index < mesh.values.length; index += 12) {
      if ((mesh.values[index + 9] > .5) === (kind === 'line')) output.push(Array.from(mesh.values.slice(index, index + 12)));
    }
    return output;
  };
  const shaftRadii = (mesh, kind) => {
    const axis = kind === 'line' ? 0 : 1, center = kind === 'line' ? midpoint(mesh.objects[0]) : mesh.objects[0].root;
    return rows(mesh, kind).filter(row => Math.abs(row[6 + axis]) < 1e-8).map(row =>
      Math.hypot(...[0, 1, 2].filter(component => component !== axis).map(component => row[component] + row[3 + component] - center[component])));
  };
  near(length(object.lineStart, object.lineEnd), 3.75);
  near(length(object.root, object.burgersEnd), 4);
  for (const kind of ['line', 'burgers']) {
    assert.ok(shaftRadii(base, kind).length > 0);
    shaftRadii(base, kind).forEach(value => near(value, .84, 1e-6));
  }
  assert.deepEqual(geometry({ radius: 8 }).values, base.values, 'tube radius does not affect either arrow');
  const settings = { burgersVectorRadius: 1.68, burgersVectorScale: 6, lineDirectionRadius: 2.52, lineDirectionScale: 3 };
  for (const [name, value] of Object.entries(settings)) {
    const changed = geometry({ [name]: value }), changedObject = changed.objects[0];
    const kind = name.startsWith('burgers') ? 'burgers' : 'line', other = kind === 'burgers' ? 'line' : 'burgers';
    assert.deepEqual(rows(changed, other), rows(base, other), `${name} leaves the other arrow geometry unchanged`);
    vectorNear(changedObject.root, object.root);
    vectorNear(midpoint(changedObject), midpoint(object));
    vectorNear(changedObject.tangent, object.tangent);
    vectorNear(changedObject.burgers, object.burgers);
    if (name.endsWith('Radius')) {
      vectorNear(changedObject.burgersEnd, object.burgersEnd);
      vectorNear(changedObject.lineStart, object.lineStart);
      vectorNear(changedObject.lineEnd, object.lineEnd);
      shaftRadii(changed, kind).forEach(radius => near(radius, value, 1e-6));
    } else if (kind === 'burgers') near(length(changedObject.root, changedObject.burgersEnd), 12);
    else near(length(changedObject.lineStart, changedObject.lineEnd), 11.25);
  }
  const forward = geometry(settings).objects[0];
  const reverse = geometry({ ...settings, vectorAnnotations: [{ segmentId: 3, position: .5, flipped: true }] }).objects[0];
  vectorNear(reverse.root, forward.root);
  vectorNear(reverse.lineStart, forward.lineEnd);
  vectorNear(reverse.lineEnd, forward.lineStart);
  vectorNear(reverse.burgers, forward.burgers.map(value => -value));
  assert.deepEqual(result, original);
});

function mockGl() {
  let next = 0, bound, vao;
  const calls = { uploads: [], draws: [] };
  const gl = {
    ARRAY_BUFFER: 1, STATIC_DRAW: 2, FLOAT: 3, VERTEX_SHADER: 4, FRAGMENT_SHADER: 5, COMPILE_STATUS: 6, LINK_STATUS: 7,
    TRIANGLES: 8, ELEMENT_ARRAY_BUFFER: 9, UNSIGNED_INT: 10, DYNAMIC_DRAW: 11,
    createProgram: () => ({}), createShader: () => ({}), shaderSource() {}, compileShader() {}, getShaderParameter: () => true,
    attachShader() {}, deleteShader() {}, linkProgram() {}, getProgramParameter: () => true, getUniformLocation: (_, name) => name,
    createVertexArray: () => ({ id: next++ }), createBuffer: () => ({ id: next++ }), bindVertexArray(value) { vao = value; },
    bindBuffer(_, value) { bound = value; }, bufferData(_, value) { calls.uploads.push({ buffer: bound, value }); },
    enableVertexAttribArray() {}, vertexAttribPointer() {}, vertexAttribDivisor() {}, useProgram() {},
    uniformMatrix4fv() {}, uniformMatrix3fv() {}, uniform1f() {}, uniform1i() {}, uniform4fv() {}, uniform3f() {},
    drawElements(_, count) { calls.draws.push({ vao, count }); },
  };
  return { gl, calls };
}

test('annotation dragging updates only arrow buffers while camera, slices and replicas reuse cached geometry', () => {
  const { gl, calls } = mockGl(), layer = new DislocationLayer(gl);
  const repeatedCell = createCell({ vectors: openCell.vectors });
  const renderer = { frame: { cell: repeatedCell }, viewMatrix: new Float32Array(16), projectionMatrix: new Float32Array(16),
    sliceMode: 'planes', sliceCount: 0, slicePlaneValues: new Float32Array(64), ...createReplication(repeatedCell, [2, 1, 1]) };
  const result = network([1, 4, 4, 18, 4, 4]);
  layer.setNetwork(renderer, result, enabled);
  const tubes = layer.geometry, paths = layer.vectorSources, originalUploads = calls.uploads.length;
  layer.setNetwork(renderer, result, { vectorAnnotations: [{ segmentId: 3, position: .7, flipped: true }] });
  assert.equal(layer.geometry, tubes);
  assert.equal(layer.vectorSources, paths);
  assert.equal(calls.uploads.length, originalUploads + 2);
  assert.ok(calls.uploads.slice(originalUploads).every(upload => upload.buffer !== layer.meshBuffer && upload.buffer !== layer.indexBuffer));
  for (const [name, value] of Object.entries({ burgersVectorRadius: 1.1, burgersVectorScale: 3, lineDirectionRadius: 1.2, lineDirectionScale: 2 })) {
    const before = calls.uploads.length;
    layer.setNetwork(renderer, result, { [name]: value });
    assert.equal(layer.geometry, tubes);
    assert.equal(layer.vectorSources, paths);
    assert.equal(calls.uploads.length, before + 2);
    assert.ok(calls.uploads.slice(before).every(upload => upload.buffer !== layer.meshBuffer && upload.buffer !== layer.indexBuffer));
    assert.deepEqual(calls.uploads.at(-2).value, layer.vectorGeometry.values, 'render/export buffer uses the edited arrow geometry');
  }
  const arrows = layer.vectorGeometry, arrowUploads = calls.uploads.length;
  layer.setNetwork(renderer, result, { radius: 1.5 });
  assert.equal(layer.vectorGeometry, arrows);
  assert.equal(calls.uploads.length, arrowUploads, 'changing tube radius does not rebuild arrows');
  renderer.sliceCount = 1;
  const uploads = calls.uploads.length;
  layer.setNetwork(renderer, result);
  layer.render(renderer);
  assert.equal(calls.uploads.length, uploads);
  assert.equal(calls.draws.length, 4, 'both source line and arrows draw for each displayed replica');
  renderer.crystalDrag = { shift: [.2, 0, 0], wrap: [1, 0, 0] };
  layer.render(renderer);
  assert.equal(calls.uploads.length, uploads, 'crystal drag also updates uniforms only');
  assert.equal(calls.draws.length, 12, 'line and arrows draw the same periodic preview images');
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  layer.extendBounds(renderer, minimum, maximum);
  assert.ok(minimum[1] <= layer.vectorGeometry.minimum[1]);
  assert.ok(maximum[0] >= layer.vectorGeometry.maximum[0] + 20);
  layer.setNetwork(renderer, result, { showLineDirections: false, showBurgersVectors: false });
  assert.equal(layer.vectorGeometry, null);
  layer.clear();
  assert.equal(layer.vectorSources, null);
  assert.equal(calls.uploads.at(-1).value, 0);
});
