import assert from 'node:assert/strict';
import test from 'node:test';
import { cartesianToFractional, createCell, fractionalToCartesian } from '../src/data/model.js';
import { bondDisplayShifts } from '../src/render/atom-primitives.js';
import { createDislocationTubeGeometry } from '../src/render/dislocation-layer.js';
import { normalizePeriodicOrigin, periodicDisplayCoordinates, translatePeriodicPoints } from '../src/render/periodic-origin.js';
import { transformPoint } from '../src/render/math.js';
import { cellWireframeDraws, WebGLRenderer } from '../src/render/webgl-renderer.js';

const near = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, `${value} != ${expected[index]}`));
};
const cell = createCell({ origin: [100, -10, 2], vectors: [10, 0, 0, 3, 8, 0, -2, 1, 7], pbc: [true, false, true], triclinic: true });
const coordinates = (fractional, sourceCell = cell) => fractionalToCartesian(fractional, sourceCell, new Float64Array(fractional.length));

test('fractional origins shift and wrap only periodic axes of a skew cell without changing source data', () => {
  const fractions = Float64Array.from([.1, .6, .9, .9, .6, .1]);
  const positions = coordinates(fractions), original = Array.from(positions), originalCell = structuredClone(cell);
  const display = periodicDisplayCoordinates(positions, cell, [.3, .8, -.2]);
  near(display.fractional, [.8, .6, .1, .6, .6, .3]);
  near(display.positions, coordinates(display.fractional));
  assert.notEqual(display.positions, positions);
  assert.deepEqual(Array.from(positions), original);
  assert.deepEqual(cell, originalCell);
  near(fractions, [.1, .6, .9, .9, .6, .1]);
});

test('unwrapped positions translate continuously and retain image coordinates', () => {
  const positions = coordinates([2.1, .6, -.1, 1.9, .6, 1.1]);
  const display = periodicDisplayCoordinates(positions, cell, [.3, 100, -.2], { wrap: false });
  near(display.fractional, [1.8, .6, .1, 1.6, .6, 1.3]);
  near(display.positions, translatePeriodicPoints(positions, cell, [.3, 0, -.2]));
  near(Array.from(positions), coordinates([2.1, .6, -.1, 1.9, .6, 1.1]));
});

test('display origins accept signed image offsets and reject malformed numbers', () => {
  near(normalizePeriodicOrigin(new Float64Array([-2, 3, .25])), [-2, 3, .25]);
  for (const value of [[0, 1], [0, 0, Infinity], [NaN, 0, 0], '0,0,0']) assert.throws(() => normalizePeriodicOrigin(value), /three finite/);
  const first = periodicDisplayCoordinates(coordinates([.1, .6, .9]), cell, [-2.3, 0, 3.2]);
  const second = periodicDisplayCoordinates(coordinates([.1, .6, .9]), cell, [.7, 0, .2]);
  near(first.positions, second.positions);
});

function rendererFixture(sourceCell = cell) {
  const fractional = Float64Array.from([.05, .5, .5, .95, .5, .5]);
  const frame = { cell: sourceCell, fractional, positions: coordinates(fractional, sourceCell), ids: Uint32Array.from([1, 2]) };
  const uploads = new Map();
  let buffer;
  const renderer = Object.assign(Object.create(WebGLRenderer.prototype), {
    frame, atomCount: 2, periodicOrigin: [0, 0, 0], displayPositions: frame.positions, rawDisplayPositions: frame.positions,
    displayFractional: frame.fractional, coordinateMode: 'wrapped',
    positionBuffer: {}, fractionalBuffer: {}, requestRender() {},
    gl: { ARRAY_BUFFER: 1, STATIC_DRAW: 2, bindBuffer(target, value) { buffer = value; },
      bufferData(target, value) { uploads.set(buffer, value); }, finish() {} },
  });
  return { renderer, frame, uploads };
}

test('changing origins rebuilds from raw positions, updates legacy slice/picking coordinates and uploads both arrays', () => {
  const { renderer, frame, uploads } = rendererFixture(), original = structuredClone(frame);
  let updates = 0, networkUpdates = 0;
  renderer.primitiveLayer = { updatePositions(r) { assert.equal(r.displayPositions, renderer.displayPositions); updates++; }, extendBounds() {} };
  renderer.dislocationNetwork = {};
  renderer.dislocationLayer = { setNetwork() { networkUpdates++; }, extendBounds() {} };
  renderer.setPeriodicOrigin([.5, 0, 0]);
  near(renderer.displayFractional, [.55, .5, .5, .45, .5, .5]);
  assert.equal(renderer.rawDisplayPositions, frame.positions);
  assert.equal(uploads.get(renderer.positionBuffer).length, 6);
  assert.equal(uploads.get(renderer.fractionalBuffer).length, 6);
  renderer.sliceMode = 'legacy'; renderer.sliceAxis = 0; renderer.sliceMaximum = .5; renderer.repetitions = [1, 1, 1];
  assert.equal(renderer.isAtomVisible(0), false);
  assert.equal(renderer.isAtomVisible(1), true);
  renderer.setPeriodicOrigin([.25, 0, 0]);
  near(renderer.displayFractional, [.8, .5, .5, .7, .5, .5]);
  assert.equal(renderer.rawDisplayPositions, frame.positions, 'repeated edits do not accumulate translation');
  renderer.setPeriodicOrigin([0, 0, 0]);
  assert.equal(renderer.displayPositions, frame.positions);
  assert.equal(updates, 3); assert.equal(networkUpdates, 3);
  assert.deepEqual(frame, original);
});

test('explicit unwrapped mode stays continuous for a copied source array', () => {
  const { renderer } = rendererFixture();
  const raw = coordinates([2.05, .5, .5, 1.95, .5, .5]);
  renderer.setDisplayPositions(raw, { coordinateMode: 'unwrapped' });
  near(renderer.displayFractional, [2.05, .5, .5, 1.95, .5, .5]);
  renderer.setPeriodicOrigin([.5, 0, 0], { coordinateMode: 'unwrapped' });
  near(renderer.displayFractional, [1.55, .5, .5, 1.45, .5, .5]);
  assert.equal(renderer.rawDisplayPositions, raw);
  renderer.setPeriodicOrigin([0, 0, 0], { coordinateMode: 'unwrapped' });
  near(renderer.displayFractional, [2.05, .5, .5, 1.95, .5, .5]);
  renderer.setPeriodicOrigin([.5, 0, 0], { coordinateMode: 'wrapped' });
  renderer.setDisplayPositions(Float64Array.from(renderer.frame.positions), { coordinateMode: 'wrapped' });
  near(renderer.displayFractional, [.55, .5, .5, .45, .5, .5]);
});

test('a new trajectory frame applies the current origin once and retains the source reference', () => {
  const { renderer, frame } = rendererFixture();
  renderer.setPeriodicOrigin([.5, 0, 0]);
  const fractional = Float64Array.from([.1, .4, .5, .9, .4, .5]);
  const next = { ...frame, fractional, positions: coordinates(fractional) };
  for (const name of ['colorBuffer', 'visibilityBuffer', 'radiusBuffer', 'cellBuffer']) renderer[name] = {};
  renderer.setFrame(next, new Uint8Array(6), next.positions, null, [2, 1, 1], { coordinateMode: 'wrapped' });
  near(renderer.displayFractional, [.6, .4, .5, .4, .4, .5]);
  assert.equal(renderer.rawDisplayPositions, next.positions);
  assert.equal(renderer.displayAtomCount, 4);
  near(next.fractional, [.1, .4, .5, .9, .4, .5]);
});

test('origin-shifted periodic replicas remain pickable and rectangle selection returns their source IDs', async () => {
  const sourceCell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
  const { renderer } = rendererFixture(sourceCell);
  Object.assign(renderer, {
    canvas: { width: 640, height: 480, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }) },
    fov: 40 * Math.PI / 180, projectionMode: 'orthographic', radiusScale: 1,
    atomRadii: new Float32Array([.15, .15]), maximumAtomRadius: .15,
    visibility: Uint8Array.from([255, 255]), sliceMode: 'legacy', sliceAxis: 2, sliceMaximum: 1,
    cellBuffer: {}, onProjectionChange() {}, onCameraChange() {},
  });
  renderer.setPeriodicOrigin([.5, 0, 0]);
  renderer.setReplications([2, 1, 1]);
  renderer.resetCamera(); renderer.setView('top'); renderer.updateMatrices();
  const clip = transformPoint(renderer.viewProjectionMatrix, 14.5, 5, 5);
  const x = (clip[0] / clip[3] * .5 + .5) * 640, y = (.5 - clip[1] / clip[3] * .5) * 480;
  assert.equal(renderer.pick(x, y), 1);
  assert.equal(renderer.lastPick.index, 1);
  assert.deepEqual(renderer.lastPick.replica, [1, 0, 0]);
  near(renderer.lastPick.position, [14.5, 5, 5]);
  assert.notEqual(renderer.lastPick.replica, renderer.replicas[1].indices, 'consumers can retain the clicked image independently');
  const selected = await renderer.selectInRectangle({ left: x - 2, top: y - 2, right: x + 2, bottom: y + 2 });
  assert.deepEqual(Array.from(selected), [1]);
  renderer.setSlices([{ id: 'replica-cut', normal: [1, 0, 0], position: 14, side: 'positive' }]);
  assert.equal(renderer.pick(x, y), 1, 'the clicked replica remains pickable when its primary copy is clipped');
  near(renderer.lastPick.position, [14.5, 5, 5]);
  const source = transformPoint(renderer.viewProjectionMatrix, 4.5, 5, 5);
  assert.equal(renderer.pick((source[0] / source[3] * .5 + .5) * 640, (.5 - source[1] / source[3] * .5) * 480), -1);
  assert.equal(renderer.lastPick, null, 'a miss cannot retain a previous replica anchor');
  renderer.pick(x, y);
  renderer.frame = null;
  assert.equal(renderer.pick(x, y), -1);
  assert.equal(renderer.lastPick, null, 'closed frames cannot leave a stale pick anchor');
});

test('bonds retain their short neighbor displacement while their image shifts change with the origin', () => {
  const { frame } = rendererFixture();
  const bonds = { count: 1, indices: Uint32Array.from([0, 1]), vectors: Float32Array.from([-1, 0, 0]), shifts: Int32Array.from([-1, 0, 0]) };
  const positions = periodicDisplayCoordinates(frame.positions, cell, [.5, 0, 0]).positions;
  assert.deepEqual(Array.from(bondDisplayShifts(bonds, frame, positions)), [0, 0, 0]);
  near(positions.slice(3).map((value, axis) => value - positions[axis]), bonds.vectors);
  assert.deepEqual(Array.from(bonds.shifts), [-1, 0, 0]);
});

test('dislocation origins translate continuous knots before periodic cuts, and unwrapped mode retains the continuous line', () => {
  const points = coordinates([.45, .4, .4, .55, .4, .4]);
  const network = { parameters: { lattice: 'fcc' }, segments: [{ id: 1, familyId: 'other', points }] };
  const original = structuredClone(network);
  const display = { periodicOrigin: [.5, 8, 0], coordinateMode: 'wrapped' };
  const wrapped = createDislocationTubeGeometry(network, cell, {}, display);
  assert.equal(wrapped.curves.length, 2);
  let length = 0;
  for (const curve of wrapped.curves) {
    const fractional = cartesianToFractional(curve.points, cell, new Float64Array(curve.points.length));
    for (let index = 0; index < fractional.length; index += 3) assert.ok(fractional[index] >= -1e-9 && fractional[index] <= 1 + 1e-9);
    for (let index = 3; index < curve.points.length; index += 3) {
      const span = Math.hypot(...[0, 1, 2].map(axis => curve.points[index + axis] - curve.points[index - 3 + axis]));
      assert.ok(span < 1, 'no artificial connector through the box');
      length += span;
    }
  }
  near([length], [1]);
  const unwrapped = createDislocationTubeGeometry(network, cell, {}, { ...display, coordinateMode: 'unwrapped' });
  assert.equal(unwrapped.curves.length, 1);
  near(unwrapped.curves[0].points, translatePeriodicPoints(points, cell, display.periodicOrigin));
  assert.deepEqual(network, original);
});

test('cell basis colors draw complete parallel edges or just the origin triad', () => {
  assert.deepEqual(cellWireframeDraws('rgb').map(draw => [draw.first, draw.count]), [[0, 8], [8, 8], [16, 8]]);
  assert.deepEqual(cellWireframeDraws('rgb-origin').map(draw => [draw.first, draw.count]), [[0, 2], [8, 2], [16, 2]]);
  const draws = cellWireframeDraws('rgb-black');
  assert.equal(draws.reduce((sum, draw) => sum + draw.count, 0), 24);
  assert.ok(draws.slice(3).every(draw => draw.color.every(component => component === 0)));
  const renderer = Object.create(WebGLRenderer.prototype);
  let renders = 0;
  renderer.requestRender = () => renders++;
  renderer.setCellWireframeMode('rgb-origin');
  assert.equal(renderer.cellWireframeMode, 'rgb-origin');
  assert.equal(renders, 1);
  assert.throws(() => renderer.setCellWireframeMode('invalid'), /wireframe mode/);
  assert.equal(renderer.cellWireframeMode, 'rgb-origin');
});
