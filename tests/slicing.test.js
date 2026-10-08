import assert from 'node:assert/strict';
import test from 'node:test';
import { cartesianToFractional, cellVertices, createCell, invert3 } from '../src/data/model.js';
import { cross, dot, subtract, transformPoint } from '../src/render/math.js';
import { createReplication } from '../src/render/replication.js';
import {
  DEFAULT_SLAB_THICKNESS, MAX_MILLER_INDEX, MAX_SLICE_PLANES, MAX_SLICES, flippedSliceSide, millerPlane,
  nearestLatticePlanePosition, planeBoxPolygon, planeCellPolygon, pointVisible, projectBoundsOnNormal,
  sliceHalfSpaces, sliceOutlinePolygons, sliceOutlineSegments, stepSlicePosition, validateMillerIndices,
  validateSlice, validateSlices,
} from '../src/render/slicing.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

const box = { minimum: [0, 0, 0], maximum: [1, 1, 1] };
const slice = (normal, position, options = {}) => validateSlice({ normal, position, ...options });

test('Cartesian slice normals normalize without changing the absolute plane distance', () => {
  const original = { id: 'a', name: '倾斜面', normal: [2, 2, 0], position: 3, side: 'positive', enabled: false };
  const normalized = validateSlice(original);
  assert.ok(Math.abs(Math.hypot(...normalized.normal) - 1) < 1e-12);
  assert.equal(normalized.position, 3);
  assert.equal(normalized.side, 'positive');
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.name, '倾斜面');
  assert.deepEqual(original.normal, [2, 2, 0]);
  assert.notEqual(normalized.normal, original.normal);
  assert.ok(Math.abs(Math.hypot(...validateSlice({ normal: [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE], position: 0 }).normal) - 1) < 1e-12);
  for (const invalid of [
    { normal: [0, 0, 0], position: 0 },
    { normal: [1, NaN, 0], position: 0 },
    { normal: [1, 0], position: 0 },
    { normal: [1, 0, 0], position: Infinity },
    { normal: [1, 0, 0], position: 0, side: 'both' },
    { normal: [1, 0, 0], position: 0, enabled: 'false' },
  ]) assert.throws(() => validateSlice(invalid));
  assert.throws(() => validateSlices(Array.from({ length: MAX_SLICES + 1 }, (_, i) => ({ id: `s${i}`, normal: [1, 0, 0], position: i }))), /at most/);
  assert.throws(() => validateSlices([original, original]), /unique/);
});

test('enabled slices intersect half-spaces and include atoms on each boundary', () => {
  const planes = validateSlices([
    { id: 'lower', normal: [1, 0, 0], position: 2, side: 'positive' },
    { id: 'upper', normal: [1, 1, 0], position: 3 * Math.SQRT2 },
    { id: 'disabled', normal: [0, 0, 1], position: -100, enabled: false },
  ]);
  assert.equal(pointVisible([2, 4, 10], planes), true);
  assert.equal(pointVisible([1.9, 0, 10], planes), false);
  assert.equal(pointVisible([2, 4.1, 10], planes), false);
  assert.equal(pointVisible([99, 99, 99], []), true);
  assert.deepEqual(projectBoundsOnNormal([-1, 0, 0], box), { minimum: -1, maximum: 0 });
});

test('a tilted plane intersects the box in a consistently ordered hexagon', () => {
  const plane = slice([1, 1, 1], Math.sqrt(3) / 2);
  const polygon = planeBoxPolygon(plane, box);
  assert.equal(polygon.length, 6);
  for (const point of polygon) {
    assert.ok(Math.abs(dot(plane.normal, point) - plane.position) < 1e-12);
    assert.ok(point.every(value => value >= -1e-12 && value <= 1 + 1e-12));
  }
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length], c = polygon[(i + 2) % polygon.length];
    assert.ok(dot(cross(subtract(b, a), subtract(c, b)), plane.normal) > 0);
  }
  assert.equal(planeBoxPolygon(slice([1, 0, 0], 0), box).length, 4, 'a coincident box face is retained');
  assert.deepEqual(planeBoxPolygon(slice([1, 1, 1], -1), box), []);
  assert.deepEqual(planeBoxPolygon(slice([1, 1, 1], 0), box), [], 'a single tangent vertex has no drawable area');
});

test('plane polygons intersect the actual skew cell instead of its bounding box', () => {
  const cell = createCell({ origin: [3, -2, 1], vectors: [4, 1, 0, -2, 3, 1, 1, -1, 5], triclinic: true });
  const plane = slice([1, 1, -1], 0.5);
  const polygon = planeCellPolygon(plane, cellVertices(cell));
  assert.ok(polygon.length >= 3);
  for (const point of polygon) {
    assert.ok(Math.abs(dot(plane.normal, point) - plane.position) < 1e-7);
    const fractional = cartesianToFractional(point, cell, new Float64Array(3));
    assert.ok(Array.from(fractional).every(value => value >= -1e-7 && value <= 1 + 1e-7));
  }
});

function rendererFixture() {
  const cell = createCell({ vectors: [4, 1, 0, -2, 3, 1, 1, -1, 5], triclinic: true });
  const positions = new Float32Array([1, 1, 1, 2, 2, 2]);
  const renderer = Object.assign(Object.create(WebGLRenderer.prototype), {
    frame: { positions, fractional: new Float32Array([0.2, 0.2, 0.2, 0.4, 0.4, 0.4]), cell },
    displayPositions: positions, atomCount: 2, visibility: new Uint8Array([255, 255]),
    atomRadii: new Float32Array([0.2, 0.2]), maximumAtomRadius: 0.2, radiusScale: 1,
    sliceAxis: 2, sliceMaximum: 1, sliceMode: 'legacy',
    fov: 40 * Math.PI / 180, projectionMode: 'orthographic',
    canvas: { width: 800, height: 600, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) },
    requestRender() {}, onCameraChange() {}, onProjectionChange() {},
    gl: { ARRAY_BUFFER: 1, STATIC_DRAW: 2, bindBuffer() {}, bufferData() {}, finish() {} },
  });
  Object.assign(renderer, createReplication(cell, [2, 1, 1]));
  renderer.resetCamera();
  return renderer;
}

test('replicated and unwrapped atom visibility follows the rendered Cartesian centers', () => {
  const r = rendererFixture(), original = r.frame.positions;
  r.setSlices([{ id: 'x', normal: [1, 0, 0], position: 4.5, side: 'positive' }]);
  assert.equal(r.isAtomVisible(0), false);
  assert.equal(r.isAtomVisible(0, [1, 0, 0]), true, 'a skew replica moves along a, not the X axis alone');
  assert.equal(r.isAnyReplicaVisible(0), true, 'selection remains visible when its source image is cut away');
  r.visibility[0] = 0;
  assert.equal(r.isAnyReplicaVisible(0), false);
  r.visibility[0] = 255;
  r.setDisplayPositions(new Float32Array([20, 1, 1, 2, 2, 2]));
  assert.equal(r.isAtomVisible(0), true, 'the slice uses unwrapped display positions, not wrapped fractions');
  assert.equal(r.frame.positions, original);
  assert.deepEqual(Array.from(original), [1, 1, 1, 2, 2, 2]);
  const bounds = r.getDisplayBounds();
  assert.equal(bounds.maximum[0], 24);
  bounds.maximum[0] = 999;
  assert.equal(r.getDisplayBounds().maximum[0], 24, 'external bounds edits cannot corrupt camera clipping');
  assert.equal(r.getDisplayCellVertices().length, 24);
});

test('picking respects all planes on every replica and preserves the original atom identity', () => {
  const r = rendererFixture();
  r.setSlices([{ id: 'x', normal: [1, 0, 0], position: 4.5, side: 'positive' }]);
  r.setView('top');
  r.updateMatrices();
  const clip = transformPoint(r.viewProjectionMatrix, 5, 2, 1);
  const screen = [(clip[0] / clip[3] * 0.5 + 0.5) * 800, (0.5 - clip[1] / clip[3] * 0.5) * 600];
  assert.equal(r.pick(...screen), 0);
  r.setSlices([
    { id: 'x', normal: [1, 0, 0], position: 4.5, side: 'positive' },
    { id: 'y', normal: [0, 1, 0], position: 1.5 },
  ]);
  assert.equal(r.pick(...screen), -1);
  r.setSlices([]);
  assert.equal(r.pick(...screen), 0);
});

test('plane uniforms match the kept sides and never duplicate atom buffers', () => {
  const r = rendererFixture(), originalFrame = r.frame, positions = r.displayPositions;
  const uniforms = [], draws = [];
  let renderNotifications = 0;
  Object.assign(r, {
    resize() {}, updateMatrices() {}, background: [0, 0, 0], cellVisible: false,
    voronoiCellOptions: { enabled: false, allEnabled: false },
    onRender(renderer) { assert.equal(renderer, r); renderNotifications += 1; },
    sphereUniforms: Object.fromEntries(['uView', 'uProjection', 'uRadiusScale', 'uSliceAxis', 'uSliceMaximum',
      'uSliceMode', 'uSliceCount', 'uSlicePlanes[0]', 'uSelected', 'uRepetitions', 'uReplicaOffset', 'uReplicaIndex']
      .map(name => [name, name])),
  });
  Object.assign(r.gl, {
    clearColor() {}, clear() {}, colorMask() {}, disable() {}, useProgram() {}, bindVertexArray() {},
    uniformMatrix4fv() {}, uniform1f() {}, uniform3f() {},
    uniform1i(name, value) { uniforms.push([name, value]); },
    uniform4fv(name, values) { uniforms.push([name, Array.from(values)]); },
    drawArraysInstanced(mode, first, count, atoms) { draws.push(atoms); },
    bufferData() { throw new Error('Changing slice parameters must not upload atom buffers.'); },
  });
  r.setSlices([
    { id: 'lo', normal: [2, 0, 0], position: 1, side: 'positive' },
    { id: 'hi', normal: [0, 1, 0], position: 2 },
    { id: 'off', normal: [0, 0, 1], position: 0, enabled: false },
  ]);
  r.render(0, { trackStats: false });
  assert.deepEqual(uniforms.find(([name]) => name === 'uSlicePlanes[0]')[1].slice(0, 8), [-1, -0, -0, -1, 0, 1, 0, 2]);
  assert.equal(uniforms.find(([name]) => name === 'uSliceCount')[1], 2);
  assert.equal(uniforms.find(([name]) => name === 'uSliceMode')[1], 1);
  assert.deepEqual(draws, [2, 2]);
  assert.equal(r.frame, originalFrame);
  assert.equal(r.displayPositions, positions);
  assert.equal(renderNotifications, 1);
  assert.throws(() => r.setSlices([{ normal: [0, 0, 0], position: 0 }]));
  assert.equal(r.slices.length, 3, 'failed validation does not change the currently rendered slices');
  r.setSlice(0, 0.5);
  assert.equal(r.sliceMode, 'legacy');
});

function close(actual, expected, tolerance = 1e-12, message = `${actual} differs from ${expected}`) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), message);
}

function vectorClose(actual, expected, tolerance = 1e-12) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, axis) => close(value, expected[axis], tolerance, `${actual} differs from ${expected}`));
}

function polygonArea(polygon) {
  const sum = polygon.reduce((total, point, index) => {
    const next = polygon[(index + 1) % polygon.length], product = cross(point, next);
    return total.map((value, axis) => value + product[axis]);
  }, [0, 0, 0]);
  return Math.hypot(...sum) / 2;
}

test('Miller normals and spacings use the reciprocal lattice of cubic cells and supercells', () => {
  const a = 3.52, cubic = [a, 0, 0, 0, a, 0, 0, 0, a];
  for (const [indices, normal, spacing] of [
    [[1, 0, 0], [1, 0, 0], a],
    [[0, 0, 2], [0, 0, 1], a / 2],
    [[1, 1, 1], [1, 1, 1].map(value => value / Math.sqrt(3)), a / Math.sqrt(3)],
    [[-1, 1, 0], [-1, 1, 0].map(value => value / Math.SQRT2), a / Math.SQRT2],
  ]) {
    const plane = millerPlane(indices, cubic);
    assert.deepEqual(plane.indices, indices);
    vectorClose(plane.normal, normal);
    close(plane.spacing, spacing);
    close(1 / Math.hypot(...plane.reciprocal), spacing);
  }
  // Indices refer to the simulation cell: crystal (111) of a 10×10×10 cell is (10 10 10).
  const supercell = cubic.map(value => value * 10);
  close(millerPlane([10, 10, 10], supercell).spacing, a / Math.sqrt(3));
  close(millerPlane([1, 1, 1], supercell).spacing, 10 * a / Math.sqrt(3));
  vectorClose(millerPlane([1, 1, 1], supercell).normal, millerPlane([1, 1, 1], cubic).normal);
  for (const invalid of [[0, 0, 0], [1, 0], [1, 0.5, 0], [1, 0, NaN], [MAX_MILLER_INDEX + 1, 0, 0], '111', null]) {
    assert.throws(() => millerPlane(invalid, cubic), /Miller indices/);
  }
  assert.throws(() => millerPlane([1, 0, 0], [1, 0, 0, 2, 0, 0, 0, 0, 1]), /singular/);
  assert.ok(Object.is(validateMillerIndices([-0, 1, 2])[0], 0), 'negative zero is stored as zero');
});

test('hexagonal and triclinic Miller planes match the reciprocal metric and contain lattice points', () => {
  const a = 2.95, c = 4.6846, hexagonal = [a, 0, 0, -a / 2, a * Math.sqrt(3) / 2, 0, 0, 0, c];
  for (const [h, k, l] of [[1, 0, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [1, -2, 3], [2, 1, -4]]) {
    close(millerPlane([h, k, l], hexagonal).spacing, 1 / Math.sqrt(4 / 3 * (h * h + h * k + k * k) / a ** 2 + l * l / c ** 2));
  }
  close(millerPlane([1, 0, 0], hexagonal).spacing, a * Math.sqrt(3) / 2);
  close(millerPlane([1, 1, 0], hexagonal).spacing, a / 2);
  close(millerPlane([0, 0, 1], hexagonal).spacing, c);
  const prism = millerPlane([1, 0, 0], hexagonal).normal;
  close(dot(prism, hexagonal.slice(3, 6)), 0); close(dot(prism, hexagonal.slice(6, 9)), 0);

  const cell = createCell({ origin: [3, -2, 1], vectors: [4, 1, 0, -2, 3, 1, 1, -1, 5], triclinic: true });
  const rows = [0, 1, 2].map(row => Array.from(cell.vectors.slice(row * 3, row * 3 + 3)));
  for (let i = 0; i < 3; i += 1) {
    const { reciprocal } = millerPlane([0, 1, 2].map(axis => Number(axis === i)), cell.vectors);
    rows.forEach((row, j) => close(dot(reciprocal, row), Number(i === j), 1e-12, `b${i + 1} · a${j + 1}`));
  }
  const inverseMetric = invert3(rows.flatMap(left => rows.map(right => dot(left, right))));
  for (const indices of [[1, 2, 3], [-2, 0, 1], [3, -1, -1]]) {
    const plane = millerPlane(indices, cell.vectors);
    const quadratic = indices.reduce((sum, left, i) => sum + indices.reduce((row, right, j) => row + left * inverseMetric[i * 3 + j] * right, 0), 0);
    close(plane.spacing, 1 / Math.sqrt(quadratic));
    // Every lattice point o + u a₁ + v a₂ + w a₃ lies on plane m = hu + kv + lw.
    for (const [u, v, w] of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [2, -1, 3], [-4, 5, 1]]) {
      const point = [0, 1, 2].map(axis => cell.origin[axis] + u * rows[0][axis] + v * rows[1][axis] + w * rows[2][axis]);
      close((dot(plane.normal, point) - dot(plane.normal, cell.origin)) / plane.spacing, indices[0] * u + indices[1] * v + indices[2] * w, 1e-9);
    }
    const nearest = nearestLatticePlanePosition(plane, cell.origin, [1.3, 0.2, -0.7]);
    const order = (nearest - dot(plane.normal, cell.origin)) / plane.spacing;
    close(order, Math.round(order), 1e-9);
    assert.ok(Math.abs(nearest - dot(plane.normal, [1.3, 0.2, -0.7])) <= plane.spacing / 2 + 1e-12);
  }
});

test('steps move a plane along its normal onto successive lattice planes and flip swaps only the kept side', () => {
  assert.equal(stepSlicePosition(1.5, 0.25, 2), 2);
  assert.equal(stepSlicePosition(1.5, 0.25, -6), 0);
  assert.equal(stepSlicePosition(2, 0.5), 2.5);
  for (const [position, step, count] of [[NaN, 1, 1], [0, 0, 1], [0, -1, 1], [0, 1, 0.5], [0, Infinity, 1], [1e300, 1e15, 2 ** 1000]]) {
    assert.throws(() => stepSlicePosition(position, step, count));
  }
  const a = 3.6, cell = createCell({ origin: [0.5, -1, 2], vectors: [4 * a, 0, 0, 0, 4 * a, 0, 0, 0, 4 * a] });
  const plane = millerPlane([4, 4, 4], cell.vectors), base = dot(plane.normal, cell.origin);
  close(plane.spacing, a / Math.sqrt(3));
  let position = nearestLatticePlanePosition(plane, cell.origin, [7, 7, 7]);
  for (let step = 0; step < 12; step += 1) {
    const order = (position - base) / plane.spacing;
    close(order, Math.round(order), 1e-9);
    position = stepSlicePosition(position, plane.spacing, 1);
  }
  close(stepSlicePosition(position, plane.spacing, -12), nearestLatticePlanePosition(plane, cell.origin, [7, 7, 7]), 1e-12);

  assert.equal(flippedSliceSide('negative'), 'positive');
  assert.equal(flippedSliceSide('positive'), 'negative');
  const kept = validateSlice({ normal: [1, 1, 0], position: 1 });
  const flipped = validateSlice({ ...kept, side: flippedSliceSide(kept.side) });
  assert.deepEqual([flipped.normal, flipped.position], [kept.normal, kept.position]);
  for (const point of [[0, 0, 5], [2, 2, -1], [-3, 1, 0]]) assert.notEqual(pointVisible(point, [kept]), pointVisible(point, [flipped]));
  const onPlane = [Math.SQRT2, 0, 9];
  assert.equal(pointVisible(onPlane, [kept]) && pointVisible(onPlane, [flipped]), true, 'atoms on the plane stay with either side');
});

test('a slab keeps both sides within half its thickness and intersects other slices', () => {
  const [slab] = validateSlices([{ id: 'slab', normal: [0, 0, 2], position: 5, slab: true, thickness: 2, side: 'positive' }]);
  assert.deepEqual([slab.slab, slab.thickness, slab.normal], [true, 2, [0, 0, 1]]);
  for (const [z, kept] of [[5, true], [4, true], [6, true], [6 + 5e-6, true], [6 + 2e-5, false], [3.9, false], [7, false]]) {
    assert.equal(pointVisible([0, 0, z], [slab]), kept, `z = ${z}`);
  }
  assert.equal(pointVisible([0, 0, 9], [{ ...slab, enabled: false }]), true);
  const planes = validateSlices([slab, { id: 'x', normal: [1, 0, 0], position: 0, side: 'positive' }]);
  assert.equal(pointVisible([1, 0, 5], planes), true);
  assert.equal(pointVisible([-1, 0, 5], planes), false);
  assert.equal(pointVisible([1, 0, 8], planes), false);
  const plain = validateSlice({ normal: [1, 0, 0], position: 0 });
  assert.deepEqual([plain.slab, plain.thickness], [false, DEFAULT_SLAB_THICKNESS]);
  for (const invalid of [{ slab: 'yes' }, { thickness: 0 }, { thickness: -1 }, { thickness: Infinity }, { thickness: '2' }]) {
    assert.throws(() => validateSlice({ normal: [1, 0, 0], position: 0, ...invalid }));
  }
});

test('slices become shader half-spaces with existing planes unchanged and two faces per slab', () => {
  const slices = validateSlices([
    { id: 'lo', normal: [2, 0, 0], position: 1, side: 'positive' },
    { id: 'hi', normal: [0, 1, 0], position: 2 },
    { id: 'off', normal: [0, 0, 1], position: 0, enabled: false, slab: true },
    { id: 'slab', normal: [0, 0, 1], position: 3, slab: true, thickness: 1 },
  ]);
  const halfSpaces = sliceHalfSpaces(slices);
  assert.deepEqual(halfSpaces, [
    { normal: [-1, -0, -0], offset: -1 }, { normal: [0, 1, 0], offset: 2 },
    { normal: [0, 0, 1], offset: 3.5 }, { normal: [-0, -0, -1], offset: -2.5 },
  ]);
  assert.equal(MAX_SLICE_PLANES, 2 * MAX_SLICES, 'sixteen slabs fit the shader arrays');
  let seed = 7;
  const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  for (let sample = 0; sample < 2000; sample += 1) {
    const point = [random() * 6 - 1, random() * 6 - 1, random() * 6];
    assert.equal(halfSpaces.every(({ normal, offset }) => dot(normal, point) <= offset + 1e-5), pointVisible(point, slices));
  }
});

test('cut outlines follow planes and slab faces inside the cell and are clipped by other slices', () => {
  const cube = cellVertices(createCell({ vectors: [1, 0, 0, 0, 1, 0, 0, 0, 1] }));
  let polygons = sliceOutlinePolygons(validateSlices([{ id: 'x', normal: [1, 0, 0], position: 0.5 }]), cube);
  assert.equal(polygons.length, 1);
  assert.equal(polygons[0].length, 4);
  close(polygonArea(polygons[0]), 1);
  assert.ok(polygons[0].every(point => point[0] === 0.5));
  assert.equal(sliceOutlinePolygons(validateSlices([{ id: 'x', normal: [1, 0, 0], position: 0.5, side: 'positive' }]), cube).length, 1);

  const slab = { id: 's', normal: [1, 0, 0], position: 0.5, slab: true, thickness: 0.2 };
  polygons = sliceOutlinePolygons(validateSlices([slab]), cube);
  assert.deepEqual(polygons.map(polygon => Number(polygon[0][0].toFixed(12))).sort(), [0.4, 0.6]);
  polygons = sliceOutlinePolygons(validateSlices([slab, { id: 'y', normal: [0, 1, 0], position: 0.25 }]), cube);
  assert.deepEqual(polygons.map(polygon => Number(polygonArea(polygon).toFixed(12))), [0.25, 0.25, 0.2],
    'each face keeps only the region the other slices keep');
  assert.deepEqual(sliceOutlinePolygons(validateSlices([{ id: 'x', normal: [1, 0, 0], position: 0.5 },
    { id: 'cut', normal: [1, 0, 0], position: 0.6, side: 'positive' }]), cube), [], 'disjoint half-spaces have no visible cut');
  for (const hidden of [{ enabled: false }, { position: 2 }, { normal: [1, 1, 1], position: 0 }]) {
    assert.deepEqual(sliceOutlinePolygons(validateSlices([{ id: 'x', normal: [1, 0, 0], position: 0.5, ...hidden }]), cube), []);
  }

  const skew = createCell({ origin: [3, -2, 1], vectors: [4, 1, 0, -2, 3, 1, 1, -1, 5], triclinic: true });
  const slices = validateSlices([{ id: 'slab', normal: [1, 1, -1], position: 0.5, slab: true, thickness: 1.5 },
    { id: 'z', normal: [0, 0, 1], position: 4 }]);
  polygons = sliceOutlinePolygons(slices, cellVertices(skew));
  assert.equal(polygons.length, 3);
  for (const polygon of polygons) {
    for (const point of polygon) {
      assert.ok(Array.from(cartesianToFractional(point, skew, new Float64Array(3))).every(value => value >= -1e-7 && value <= 1 + 1e-7));
      assert.equal(pointVisible(point, slices), true);
    }
  }
  const segments = sliceOutlineSegments(slices, cellVertices(skew));
  assert.equal(segments.length, polygons.reduce((sum, polygon) => sum + polygon.length, 0) * 6);
  vectorClose(Array.from(segments.slice(0, 3)), polygons[0][0], 1e-6);
  vectorClose(Array.from(segments.slice(polygons[0].length * 6 - 3, polygons[0].length * 6)), polygons[0][0], 1e-6);
});

test('renderer slabs clip atoms and picks, and cut outlines draw only when shown and exported', () => {
  const r = rendererFixture();
  r.setSlices([{ id: 'slab', normal: [0, 0, 1], position: 1, slab: true, thickness: 0.5 }]);
  assert.equal(r.sliceCount, 2);
  assert.deepEqual(Array.from(r.slicePlaneValues.slice(0, 8)), [0, 0, 1, 1.25, -0, -0, -1, -0.75]);
  assert.equal(r.isAtomVisible(0), true);
  assert.equal(r.isAtomVisible(0, [1, 0, 0]), true);
  assert.equal(r.isAtomVisible(1), false);
  r.setView('top');
  r.updateMatrices();
  const clip = transformPoint(r.viewProjectionMatrix, 2, 2, 2);
  const screen = [(clip[0] / clip[3] * 0.5 + 0.5) * 800, (0.5 - clip[1] / clip[3] * 0.5) * 600];
  assert.equal(r.pick(...screen), -1, 'an atom outside the slab cannot be picked');
  r.setSlices([{ id: 'slab', normal: [0, 0, 1], position: 2, slab: true, thickness: 0.5 }]);
  assert.equal(r.pick(...screen), 1);

  const calls = [];
  Object.assign(r, {
    resize() {}, updateMatrices() {}, background: [0, 0, 0], cellVisible: false,
    voronoiCellOptions: { enabled: false, allEnabled: false }, sliceOutlineColor: [0.31, 0.886, 0.816],
    sphereUniforms: {}, lineUniforms: { uViewProjection: 'uViewProjection', uColor: 'uColor' },
    lineProgram: 'line', sliceOutlineBuffer: 'outline-buffer', sliceOutlineVao: 'outline-vao',
  });
  const record = name => (...args) => calls.push([name, ...args]);
  Object.assign(r.gl, Object.fromEntries(['clearColor', 'clear', 'colorMask', 'disable', 'enable', 'useProgram',
    'bindVertexArray', 'uniformMatrix4fv', 'uniform1f', 'uniform1i', 'uniform4fv', 'uniform1iv', 'blendFuncSeparate',
    'drawArraysInstanced', 'bindBuffer', 'bufferData', 'drawArrays', 'uniform3f'].map(name => [name, record(name)])),
  { LINES: 'LINES', DEPTH_TEST: 'DEPTH_TEST', BLEND: 'BLEND', ARRAY_BUFFER: 'ARRAY_BUFFER', DYNAMIC_DRAW: 'DYNAMIC_DRAW' });
  const lines = () => calls.filter(([name, mode]) => name === 'drawArrays' && mode === 'LINES');
  const uploads = () => calls.filter(([name, target, data]) => name === 'bufferData' && data instanceof Float32Array);
  r.render(0, { trackStats: false });
  assert.equal(lines().length, 0, 'outlines are off by default');
  r.setSliceOutlines(true);
  r.render(0, { trackStats: false });
  assert.equal(uploads().length, 1);
  const expected = sliceOutlineSegments(r.slices, r.getDisplayCellVertices());
  assert.deepEqual(Array.from(uploads()[0][2]), Array.from(expected));
  assert.deepEqual(lines()[0], ['drawArrays', 'LINES', 0, expected.length / 3]);
  const drawIndex = calls.indexOf(lines()[0]);
  assert.deepEqual(calls.slice(0, drawIndex).findLast(([name, value]) => ['disable', 'enable'].includes(name) && value === 'DEPTH_TEST'),
    ['disable', 'DEPTH_TEST'], 'outlines stay on top of atoms');
  assert.deepEqual(calls.slice(0, drawIndex).findLast(([name, location]) => name === 'uniform3f' && location === 'uColor'),
    ['uniform3f', 'uColor', 0.31, 0.886, 0.816]);
  r.render(0, { trackStats: false });
  assert.equal(uploads().length, 1, 'unchanged slices and cell reuse the uploaded outline');
  assert.equal(lines().length, 2);
  r.render(0, { trackStats: false, sliceOutlines: false });
  assert.equal(lines().length, 2, 'an export can leave outlines out');
  r.setSlices([{ id: 'slab', normal: [0, 0, 1], position: 1.5, slab: true, thickness: 0.5 }]);
  r.render(0, { trackStats: false });
  assert.equal(uploads().length, 2, 'moving the plane rebuilds its outline');
  r.setSliceOutlines(false);
  r.render(0, { trackStats: false });
  assert.equal(lines().length, 3);
});

test('image capture passes the outline export choice to its render', () => {
  const originalDocument = globalThis.document, options = [];
  globalThis.document = { createElement: () => ({ getContext: () => ({
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData() {},
  }) }) };
  try {
    const renderer = Object.create(WebGLRenderer.prototype);
    Object.assign(renderer, { canvas: { width: 1, height: 1 }, gl: { readPixels() {} },
      render: (timestamp, values) => options.push(values) });
    renderer.captureImage({ includeSliceOutlines: false });
    renderer.captureImage();
    assert.deepEqual(options, [{ transparentBackground: false, trackStats: false, sliceOutlines: false }, { trackStats: false },
      { transparentBackground: false, trackStats: false }, { trackStats: false }]);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
