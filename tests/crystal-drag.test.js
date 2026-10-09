import assert from 'node:assert/strict';
import test from 'node:test';
import { cartesianToFractional, createCell, fractionalToCartesian } from '../src/data/model.js';
import { bondDisplayShifts } from '../src/render/atom-primitives.js';
import { DXA_FAMILIES } from '../src/analysis/dxa.js';
import { createDislocationTubeGeometry } from '../src/render/dislocation-layer.js';
import {
  CRYSTAL_DRAG_GLSL, CrystalDragGesture, crystalDragBondShifts, crystalDragBounds, crystalDragDisplay, crystalDragImages,
  originChangeForDisplacement, screenDragDisplacement, snapCrystalOrigin,
} from '../src/render/crystal-drag.js';
import { periodicDisplayCoordinates } from '../src/render/periodic-origin.js';
import { transformPoint } from '../src/render/math.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';
import { initializeCrystalDragControls } from '../src/crystal-drag-controls.js';

const cubic = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
const skew = createCell({ origin: [100, -10, 2], vectors: [10, 0, 0, 3, 8, 0, -2, 1, 7], pbc: [true, false, true], triclinic: true });
const skewPeriodic = createCell({ origin: [-3, 4, 1], vectors: [9, 0, 0, 2.5, 8, 0, -1.5, 2, 7.5], triclinic: true });
const near = (actual, expected, tolerance = 1e-9, label = '') => {
  assert.equal(actual.length, expected.length);
  Array.from(actual).forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= tolerance,
    `${label}[${index}] ${value} != ${expected[index]}`));
};
function random(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}
const coordinates = (fractional, cell) => fractionalToCartesian(fractional, cell, new Float64Array(fractional.length));

function rendererFixture(cell = cubic, fractional = Float64Array.from([.5, .5, .5, .1, .2, .3, .9, .8, .7])) {
  const count = fractional.length / 3, positions = coordinates(fractional, cell);
  const frame = { cell, fractional, positions, ids: Uint32Array.from({ length: count }, (_, index) => index + 1) };
  const uploads = [];
  let bound;
  const renderer = Object.assign(Object.create(WebGLRenderer.prototype), {
    frame, atomCount: count, periodicOrigin: [0, 0, 0], displayPositions: positions, rawDisplayPositions: positions,
    displayFractional: fractional, coordinateMode: 'wrapped', crystalDrag: null,
    positionBuffer: { name: 'position' }, fractionalBuffer: { name: 'fractional' }, cellBuffer: { name: 'cell' },
    renders: 0, requestRender() { this.renders++; },
    canvas: { width: 640, height: 480, clientWidth: 640, clientHeight: 480, getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }) },
    fov: 40 * Math.PI / 180, projectionMode: 'perspective', radiusScale: 1, atomRadii: new Float32Array(count).fill(.4), maximumAtomRadius: .4,
    visibility: new Uint8Array(count).fill(255), sliceMode: 'legacy', sliceAxis: 2, sliceMaximum: 1,
    onProjectionChange() {}, onCameraChange() {},
    gl: { ARRAY_BUFFER: 1, STATIC_DRAW: 2, bindBuffer(target, buffer) { bound = buffer; }, bufferData(target, values) { uploads.push([bound, values]); } },
  });
  renderer.setReplications([1, 1, 1]);
  renderer.resetCamera();
  renderer.updateMatrices();
  uploads.length = 0;
  return { renderer, frame, uploads };
}
const screen = (renderer, point) => {
  const clip = transformPoint(renderer.viewProjectionMatrix, ...point);
  return [(clip[0] / clip[3] * .5 + .5) * 640, (.5 - clip[1] / clip[3] * .5) * 480];
};

test('a screen drag maps to a displacement in the screen plane through the anchor, in both projections', () => {
  for (const projectionMode of ['perspective', 'orthographic']) {
    const { renderer } = rendererFixture();
    renderer.projectionMode = projectionMode; renderer.yaw = .7; renderer.pitch = -.3; renderer.updateMatrices();
    for (const anchor of [[5, 5, 5], [1, 2, 3], [9, 1, 6]]) {
      const displacement = screenDragDisplacement({ viewMatrix: renderer.viewMatrix, projectionMatrix: renderer.projectionMatrix,
        width: 640, height: 480 }, anchor, 37, -21);
      const before = screen(renderer, anchor), after = screen(renderer, anchor.map((value, axis) => value + displacement[axis]));
      near([after[0] - before[0], after[1] - before[1]], [37, -21], 1e-3, `${projectionMode} pixels`);
      const view = renderer.viewMatrix, depth = [view[2], view[6], view[10]];
      assert.ok(Math.abs(depth.reduce((sum, value, axis) => sum + value * displacement[axis], 0)) < 1e-6 * Math.hypot(...displacement),
        'parallel to the screen (single-precision view matrix)');
    }
    // Perspective drags are larger for deeper anchors; parallel ones are not.
    const forward = [-renderer.viewMatrix[2], -renderer.viewMatrix[6], -renderer.viewMatrix[10]];
    const length = anchor => Math.hypot(...screenDragDisplacement({ viewMatrix: renderer.viewMatrix,
      projectionMatrix: renderer.projectionMatrix, width: 640, height: 480 }, anchor, 10, 0));
    const deep = [5, 5, 5].map((value, axis) => value + 4 * forward[axis]);
    if (projectionMode === 'perspective') assert.ok(length(deep) > length([5, 5, 5]) * 1.05);
    else assert.ok(Math.abs(length(deep) - length([5, 5, 5])) < 1e-9);
  }
});

test('displacements become reduced origin changes along periodic axes only, in triclinic cells', () => {
  near(originChangeForDisplacement([1, 0, 0], cubic), [-.1, 0, 0]);
  const h = skewPeriodic.vectors, combination = [.2, .3, -.1];
  const displacement = [0, 1, 2].map(axis => combination[0] * h[axis] + combination[1] * h[3 + axis] + combination[2] * h[6 + axis]);
  near(originChangeForDisplacement(displacement, skewPeriodic), [-.2, -.3, .1], 1e-12);
  const partial = [0, 1, 2].map(axis => .2 * skew.vectors[axis] + .3 * skew.vectors[3 + axis] - .1 * skew.vectors[6 + axis]);
  const change = originChangeForDisplacement(partial, skew);
  near(change, [-.2, 0, .1], 1e-12);
  assert.ok(Object.is(change[1], 0), 'the open b direction keeps its origin');
});

test('committed drag origins are snapped decimals that typing reproduces; wrapped mode reduces whole cells', () => {
  assert.deepEqual(snapCrystalOrigin([1.23456, -0.25004, 7], skew), [0.2346, 0, 0]);
  assert.deepEqual(snapCrystalOrigin([1.23456, -0.25004, -2.5], cubic, 'wrapped'), [0.2346, 0.75, 0.5]);
  assert.deepEqual(snapCrystalOrigin([1.23456, -0.25004, -2.5], cubic, 'unwrapped'), [1.2346, -0.25, -2.5]);
  for (const value of snapCrystalOrigin([-0.00001, 0.99999, -1e-9], cubic)) assert.ok(Object.is(value, 0), `${value} rounds to +0`);
  assert.ok(Object.is(snapCrystalOrigin([-0.00001, 0, 0], cubic, 'unwrapped')[0], 0), 'no negative zero');
  const randomValue = random(7);
  for (let trial = 0; trial < 500; trial++) {
    const origin = snapCrystalOrigin([0, 1, 2].map(() => (randomValue() - .5) * 8), cubic, trial % 2 ? 'wrapped' : 'unwrapped');
    for (const value of origin) assert.ok(Object.is(Number(String(value)), value), `${value} round-trips through a number field`);
  }
});

function shaderCase(cell, coordinateMode, seed) {
  const randomValue = random(seed), count = 200;
  const source = Float64Array.from({ length: count * 3 }, () => coordinateMode === 'unwrapped' ? randomValue() * 3 - 1 : randomValue() * 1.1 - .05);
  const raw = coordinates(source, cell);
  const committed = snapCrystalOrigin([0, 1, 2].map(() => randomValue() * 2 - 1), cell, coordinateMode);
  const display = periodicDisplayCoordinates(raw, cell, committed, { wrap: coordinateMode === 'wrapped' });
  const target = snapCrystalOrigin(committed.map(value => value + randomValue() * 3 - 1.5), cell, coordinateMode);
  const periodic = cell.pbc.map(Number);
  const drag = { shift: target.map((value, axis) => value - committed[axis]), wrap: coordinateMode === 'wrapped' ? periodic : [0, 0, 0] };
  return { raw, display, target, drag };
}

test('the shader wrap reproduces the CPU display of the committed origin (triclinic, partial PBC, both modes)', () => {
  for (const cell of [cubic, skew, skewPeriodic]) for (const coordinateMode of ['wrapped', 'unwrapped']) for (let seed = 1; seed <= 6; seed++) {
    const { raw, display, target, drag } = shaderCase(cell, coordinateMode, seed * 31 + cell.vectors[3]);
    const expected = periodicDisplayCoordinates(raw, cell, target, { wrap: coordinateMode === 'wrapped' });
    const shifted = crystalDragDisplay(display.positions, display.fractional, cell, drag);
    near(shifted.positions, expected.positions, 1e-9, `${coordinateMode} positions`);
    near(shifted.fractional, expected.fractional, 1e-12, `${coordinateMode} fractions`);
    // Single precision, as on the GPU: atoms within float rounding of a cell
    // face may land on the opposite face, i.e. one cell vector away.
    const gpu = crystalDragDisplay(display.positions, display.fractional, cell, drag, { float32: true });
    for (let atom = 0; atom < raw.length / 3; atom++) {
      const error = Math.hypot(...[0, 1, 2].map(axis => gpu.positions[atom * 3 + axis] - expected.positions[atom * 3 + axis]));
      const boundary = [0, 1, 2].some(axis => drag.wrap[axis] && Math.abs(expected.fractional[atom * 3 + axis] - Math.round(expected.fractional[atom * 3 + axis])) < 1e-5);
      assert.ok(error < 5e-5 || boundary, `float32 atom ${atom} error ${error}`);
    }
  }
});

test('a drag from the zero origin rewraps source coordinates outside the cell like a typed origin', () => {
  const fractional = Float64Array.from([-.02, .5, 1.03, .4, -.1, .99]), raw = coordinates(fractional, cubic);
  const drag = { shift: [.25, 0, 0], wrap: [1, 1, 1] };
  const shifted = crystalDragDisplay(raw, fractional, cubic, drag);
  near(shifted.fractional, periodicDisplayCoordinates(raw, cubic, [.25, 0, 0]).fractional, 1e-12);
  near(shifted.fractional, [.73, .5, .03, .15, .9, .99], 1e-12);
});

test('bond image shifts follow the shader wrap exactly as the committed bond shifts', () => {
  const randomValue = random(99), count = 60;
  for (const cell of [cubic, skewPeriodic, skew]) {
    const source = Float64Array.from({ length: count * 3 }, () => randomValue());
    const raw = coordinates(source, cell), frame = { cell, positions: raw, fractional: source };
    const indices = [], vectors = [], periodicShifts = [];
    for (let first = 0; first < count; first++) for (let second = first + 1; second < count; second++) {
      // The minimum-image vector between the two source atoms.
      const delta = [0, 1, 2].map(axis => source[second * 3 + axis] - source[first * 3 + axis]);
      const image = delta.map((value, axis) => cell.pbc[axis] ? -Math.round(value) : 0);
      const fractionalVector = delta.map((value, axis) => value + image[axis]);
      if (Math.hypot(...fractionalVector) > .35) continue;
      indices.push(first, second); periodicShifts.push(...image.map(value => -value));
      vectors.push(...[0, 1, 2].map(axis => fractionalVector[0] * cell.vectors[axis] + fractionalVector[1] * cell.vectors[3 + axis] + fractionalVector[2] * cell.vectors[6 + axis]));
    }
    const bonds = { count: indices.length / 2, indices: Uint32Array.from(indices), vectors: Float32Array.from(vectors), shifts: Int32Array.from(periodicShifts) };
    assert.ok(bonds.count > 30);
    const committed = snapCrystalOrigin([.37, .61, .12], cell), target = snapCrystalOrigin([.81, .05, .93], cell);
    const display = periodicDisplayCoordinates(raw, cell, committed), next = periodicDisplayCoordinates(raw, cell, target);
    const shifts = bondDisplayShifts(bonds, frame, display.positions);
    const drag = { shift: target.map((value, axis) => value - committed[axis]), wrap: cell.pbc.map(Number) };
    assert.deepEqual(Array.from(crystalDragBondShifts(bonds, shifts, display.fractional, drag)),
      Array.from(bondDisplayShifts(bonds, frame, next.positions)));
  }
});

test('DXA pieces drawn at the drag images and clipped to the cell cover exactly the lines rebuilt on release', () => {
  const lineLength = (curves, images, cell, wrap) => {
    const inverse = cartesianToFractional(new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]).map((value, index) => value + cell.origin[index % 3]), cell, new Float64Array(9));
    const fraction = point => [0, 1, 2].map(axis => (point[0] - cell.origin[0]) * inverse[axis] + (point[1] - cell.origin[1]) * inverse[3 + axis] + (point[2] - cell.origin[2]) * inverse[6 + axis]);
    let total = 0;
    // A closed tube also joins its last ring to its first.
    for (const { points, closed } of curves) for (const image of images) for (let index = 0; index + (closed ? 2 : 5) < points.length; index += 3) {
      const next = (index + 3) % points.length;
      const first = [0, 1, 2].map(axis => points[index + axis] + image[axis]), last = [0, 1, 2].map(axis => points[next + axis] + image[axis]);
      const a = fraction(first), b = fraction(last);
      let lower = 0, upper = 1;
      // Liang–Barsky against 0 ≤ f ≤ 1 on wrapped axes, as the fragment shader clips.
      for (let axis = 0; axis < 3 && lower < upper; axis++) {
        if (!wrap[axis]) continue;
        const slope = b[axis] - a[axis];
        if (Math.abs(slope) < 1e-15) { if (a[axis] < 0 || a[axis] > 1) upper = lower; continue; }
        const t0 = -a[axis] / slope, t1 = (1 - a[axis]) / slope;
        lower = Math.max(lower, Math.min(t0, t1)); upper = Math.min(upper, Math.max(t0, t1));
      }
      if (upper > lower) total += Math.hypot(...last.map((value, axis) => value - first[axis])) * (upper - lower);
    }
    return total;
  };
  for (const cell of [skewPeriodic, skew, cubic]) {
    // A loop around a periodic corner crosses several faces.
    const fractional = [];
    for (let step = 0; step < 48; step++) {
      const angle = step / 48 * 2 * Math.PI;
      fractional.push(.93 + .2 * Math.cos(angle), .5 + .1 * Math.sin(2 * angle), .06 + .2 * Math.sin(angle));
    }
    const network = { parameters: { lattice: 'fcc' }, segments: [{ id: 1, familyId: DXA_FAMILIES.fcc[0].id, closed: true,
      points: coordinates(Float64Array.from(fractional), cell) }] };
    const wrap = cell.pbc.map(Number);
    // Typed origins may lie outside [0, 1); the drag commits a reduced one.
    for (const [committed, target] of [[[0, 0, 0], [.3, .7, .45]], [[.62, .1, .9], [.05, .95, .2]], [[-2.3, 1.6, .4], [.85, .25, .4]]]) {
      const before = createDislocationTubeGeometry(network, cell, {}, { periodicOrigin: committed, coordinateMode: 'wrapped' });
      const after = createDislocationTubeGeometry(network, cell, {}, { periodicOrigin: target, coordinateMode: 'wrapped' });
      const drag = { shift: target.map((value, axis) => cell.pbc[axis] ? value - committed[axis] : 0), wrap };
      const images = crystalDragImages(cell, drag);
      assert.equal(images.length, 2 ** wrap.filter(Boolean).length);
      const expected = lineLength(after.curves, [[0, 0, 0]], cell, wrap);
      const previewed = lineLength(before.curves, images, cell, wrap);
      assert.ok(expected > 1 && Math.abs(previewed - expected) < 1e-6 * expected, `${previewed} != ${expected}`);
    }
  }
  // Unwrapped lines only translate.
  assert.deepEqual(crystalDragImages(cubic, { shift: [.25, 0, -.5], wrap: [0, 0, 0] }), [[-2.5, 0, 5]]);
});

test('drag bounds keep wrapped overhangs on both faces and translate unwrapped scenes', () => {
  const vertices = Float64Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 0, 0, 0, 10, 10, 0, 10, 0, 10, 10, 10, 10, 10]);
  const bounds = crystalDragBounds({ minimum: [-1, 0, 0], maximum: [10, 10, 12] }, vertices, cubic, [0, 0, 0]);
  assert.deepEqual(bounds, { minimum: [-1, 0, -2], maximum: [11, 10, 12] });
  const moved = crystalDragBounds({ minimum: [0, 0, 0], maximum: [10, 10, 10] }, vertices, cubic, [.5, 0, -.25]);
  assert.deepEqual(moved, { minimum: [-5, 0, 0], maximum: [10, 10, 12.5] });
  assert.equal(crystalDragBounds(null, vertices, cubic, [0, 0, 0]), null);
});

test('the shared GLSL step is zero unless a drag is active and never moves open axes', () => {
  assert.match(CRYSTAL_DRAG_GLSL, /if \(!uCrystalDrag\) return vec3\(0\.0\)/);
  const { renderer } = rendererFixture(skew);
  renderer.setCrystalDragShift([.3, .4, -.2]);
  assert.deepEqual(renderer.crystalDrag.shift, [.3, 0, -.2]);
  assert.deepEqual(renderer.crystalDrag.wrap, [1, 0, 1]);
  assert.deepEqual(Array.from(renderer.crystalDrag.cell), Array.from(Float32Array.from(skew.vectors)));
  renderer.coordinateMode = 'unwrapped'; renderer.setCrystalDragShift([.3, .4, -.2]);
  assert.deepEqual(renderer.crystalDrag.wrap, [0, 0, 0]);
  assert.deepEqual(renderer.crystalDrag.periodic, [1, 0, 1]);
  renderer.setCrystalDragShift(null);
  assert.equal(renderer.crystalDrag, null);
  assert.throws(() => renderer.setCrystalDragShift([0, NaN, 0]), /three finite/);
});

test('a pointer drag previews without uploads and its commit equals typing the same origin', () => {
  for (const [cell, projectionMode, repetitions] of [[cubic, 'perspective', [2, 1, 2]], [skewPeriodic, 'orthographic', [1, 1, 1]], [skew, 'perspective', [1, 1, 1]]]) {
    const fractional = Float64Array.from({ length: 300 }, random(5));
    const dragged = rendererFixture(cell, fractional), typed = rendererFixture(cell, fractional);
    for (const { renderer } of [dragged, typed]) {
      renderer.setReplications(repetitions); renderer.projectionMode = projectionMode; renderer.yaw = .4; renderer.updateMatrices();
    }
    const renderer = dragged.renderer;
    renderer.setPeriodicOrigin([.125, 0, .5]); typed.renderer.setPeriodicOrigin([.125, 0, .5]);
    dragged.uploads.length = 0;
    let committed = null;
    const gesture = new CrystalDragGesture(renderer, { getOrigin: () => renderer.periodicOrigin,
      onCommit: origin => { committed = origin; renderer.setPeriodicOrigin(origin); } });
    // Grab the atom nearest the screen center so its image stays put while dragging.
    const [x, y] = screen(renderer, renderer.target);
    assert.equal(gesture.begin(x, y), true);
    const target = [[x + 15, y + 4], [x + 60, y - 30], [x + 113, y - 77]].map(([px, py]) => gesture.moveTo(px, py)).at(-1);
    assert.equal(dragged.uploads.length, 0, 'pointer moves upload no buffers');
    assert.ok(renderer.crystalDrag, 'the drag previews through shader uniforms');
    assert.deepEqual(renderer.periodicOrigin, [.125, 0, .5], 'the committed origin is unchanged while dragging');
    assert.ok(target.some((value, axis) => value !== [.125, 0, .5][axis]));
    if (!cell.pbc[1]) assert.equal(target[1], 0);
    gesture.commit();
    assert.equal(renderer.crystalDrag, null);
    assert.ok(dragged.uploads.length >= 2, 'the release uploads the rebuilt display once');
    assert.deepEqual(committed, target);
    typed.renderer.setPeriodicOrigin(committed.map(value => Number(String(value))));
    for (const name of ['displayPositions', 'displayFractional']) {
      assert.equal(renderer[name].length, typed.renderer[name].length);
      renderer[name].forEach((value, index) => assert.ok(Object.is(value, typed.renderer[name][index]), `${name}[${index}]`));
    }
    assert.deepEqual(renderer.periodicOrigin, typed.renderer.periodicOrigin);
  }
});

test('the grabbed atom follows the pointer after release', () => {
  const fractional = Float64Array.from([.5, .5, .5, .45, .55, .5, .2, .3, .6]);
  for (const projectionMode of ['perspective', 'orthographic']) {
    const { renderer } = rendererFixture(cubic, fractional);
    renderer.projectionMode = projectionMode; renderer.yaw = .3; renderer.pitch = .2; renderer.updateMatrices();
    const gesture = new CrystalDragGesture(renderer, { getOrigin: () => renderer.periodicOrigin, onCommit: origin => renderer.setPeriodicOrigin(origin) });
    const start = screen(renderer, [5, 5, 5]);
    gesture.begin(...start);
    assert.equal(renderer.lastPick?.index, 0);
    gesture.moveTo(start[0] + 25, start[1] - 12);
    gesture.commit();
    renderer.updateMatrices();
    const end = screen(renderer, Array.from(renderer.displayPositions.slice(0, 3)));
    near([end[0] - start[0], end[1] - start[1]], [25, -12], .05, projectionMode);
  }
});

test('cancelling restores the previous origin and display without rebuilding', () => {
  const { renderer, uploads } = rendererFixture();
  renderer.setPeriodicOrigin([.25, .5, 0]);
  const before = Float64Array.from(renderer.displayPositions);
  uploads.length = 0;
  let commits = 0;
  const gesture = new CrystalDragGesture(renderer, { getOrigin: () => renderer.periodicOrigin, onCommit: () => commits++ });
  gesture.begin(320, 240); gesture.moveTo(400, 200);
  assert.ok(renderer.crystalDrag);
  assert.equal(gesture.cancel(), true);
  assert.equal(renderer.crystalDrag, null);
  assert.equal(commits, 0); assert.equal(uploads.length, 0);
  assert.deepEqual(renderer.periodicOrigin, [.25, .5, 0]);
  assert.deepEqual(Array.from(renderer.displayPositions), Array.from(before));
  assert.equal(gesture.cancel(), false);
  // Returning to the start commits nothing.
  gesture.begin(320, 240); gesture.moveTo(400, 200); gesture.moveTo(320, 240); gesture.commit();
  assert.equal(commits, 0);
});

class Events {
  handlers = new Map();
  addEventListener(name, handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(handler);
  }
  removeEventListener(name, handler) { this.handlers.get(name)?.delete(handler); }
  emit(type, values = {}) {
    const event = { type, pointerType: 'mouse', pointerId: 1, button: 0, preventDefault() {}, ...values };
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}
function element(id) {
  const node = new Events();
  Object.assign(node, { id, hidden: false, disabled: false, textContent: '', attributes: {}, children: [],
    classList: { values: new Set(), add(name) { this.values.add(name); }, remove(name) { this.values.delete(name); },
      toggle(name, on) { if (on) this.values.add(name); else this.values.delete(name); }, contains(name) { return this.values.has(name); } },
    setAttribute(name, value) { this.attributes[name] = String(value); }, getAttribute(name) { return this.attributes[name] ?? null; },
    append(...nodes) { this.children.push(...nodes); }, after(node) { this.next = node; }, remove() { this.removed = true; },
    click() { this.emit('click'); } });
  return node;
}

function controlsFixture() {
  const fixture = rendererFixture(cubic, Float64Array.from({ length: 150 }, random(11)));
  const { renderer } = fixture;
  const document = new Events(), nodes = { 'origin-drag-mode': element('origin-drag-mode'), 'reset-camera': element('reset-camera') };
  Object.assign(document, { defaultView: new Events(), head: element('head'), getElementById: id => nodes[id] ?? null,
    createElement: () => element('') });
  const captures = new Set(), canvas = new Events();
  Object.assign(canvas, { width: 640, height: 480, clientWidth: 640, clientHeight: 480,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 480 }),
    ownerDocument: document, parentElement: element('viewport'), classList: element('').classList,
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => { captures.delete(id); canvas.emit('lostpointercapture', { pointerId: id }); } });
  renderer.canvas = canvas;
  renderer.picks = [];
  renderer.onPick = atom => renderer.picks.push(atom);
  renderer.interactions = null;
  renderer.installInteractions();
  const commits = [];
  const controls = initializeCrystalDragControls({ renderer, getOrigin: () => renderer.periodicOrigin,
    getCoordinateMode: () => renderer.coordinateMode, commit: origin => { commits.push(origin); renderer.setPeriodicOrigin(origin); } });
  controls.setEnabled(true);
  const pointer = (type, x, y, extra = {}) => canvas.emit(type, { clientX: x, clientY: y, ...extra });
  return { ...fixture, document, nodes, canvas, controls, commits, pointer, captures };
}

test('Move crystal mode and Alt-drag route pointer gestures; Escape and a second finger cancel', () => {
  const f = controlsFixture(), r = f.renderer;
  const [x, y] = screen(r, r.target);
  // Without the mode a left drag still orbits; Alt-drag moves the crystal.
  const yaw = r.yaw;
  f.pointer('pointerdown', x, y); f.pointer('pointermove', x + 30, y); f.pointer('pointerup', x + 30, y);
  assert.notEqual(r.yaw, yaw); assert.equal(f.commits.length, 0);
  f.uploads.length = 0;
  f.pointer('pointerdown', x, y, { altKey: true }); f.pointer('pointermove', x + 2, y, { altKey: true });
  assert.equal(r.crystalDrag, null, 'a sub-threshold move is still a click');
  f.pointer('pointermove', x + 40, y - 10, { altKey: true });
  assert.ok(r.crystalDrag); assert.equal(f.uploads.length, 0);
  assert.equal(f.canvas.classList.contains('crystal-dragging'), true);
  f.document.emit('keydown', { key: 'Escape' });
  assert.equal(r.crystalDrag, null, 'Escape cancels the preview');
  f.pointer('pointermove', x + 80, y - 10, { altKey: true }); f.pointer('pointerup', x + 80, y - 10, { altKey: true });
  assert.deepEqual(f.commits, [], 'nothing is committed after Escape');
  assert.deepEqual(r.periodicOrigin, [0, 0, 0]);
  assert.equal(f.canvas.classList.contains('crystal-dragging'), false);
  // The mode toggle makes plain left drags move the crystal; release commits.
  f.nodes['origin-drag-mode'].click();
  assert.equal(f.nodes['origin-drag-mode'].getAttribute('aria-pressed'), 'true');
  assert.equal(f.canvas.classList.contains('crystal-drag-mode'), true);
  const orbit = r.yaw;
  f.pointer('pointerdown', x, y); f.pointer('pointermove', x + 50, y); f.pointer('pointerup', x + 50, y);
  assert.equal(r.yaw, orbit, 'the mode replaces orbiting');
  assert.equal(f.commits.length, 1); assert.ok(f.commits[0][0] !== 0);
  assert.deepEqual(r.periodicOrigin, f.commits[0]);
  // Shift and right drags still pan; a tap still selects.
  for (const extra of [{ shiftKey: true }, { button: 2 }]) {
    r.pan = [0, 0, 0];
    f.pointer('pointerdown', x, y, extra); f.pointer('pointermove', x + 20, y, extra); f.pointer('pointerup', x + 20, y, extra);
    assert.ok(r.pan.some(value => value !== 0)); assert.equal(f.commits.length, 1);
  }
  f.pointer('pointerdown', x, y); f.pointer('pointerup', x, y);
  assert.equal(r.picks.length, 1); assert.equal(f.commits.length, 1);
  // One finger drags; a second finger cancels into pinch/pan.
  const touch = (type, id, px, py) => f.pointer(type, px, py, { pointerType: 'touch', pointerId: id });
  touch('pointerdown', 5, x, y); touch('pointermove', 5, x, y + 40);
  assert.ok(r.crystalDrag);
  touch('pointerdown', 6, x + 100, y);
  assert.equal(r.crystalDrag, null);
  touch('pointerup', 5, x, y + 40); touch('pointerup', 6, x + 100, y);
  assert.equal(f.commits.length, 1);
  touch('pointerdown', 7, x, y); touch('pointermove', 7, x - 30, y + 45); touch('pointerup', 7, x - 30, y + 45);
  assert.equal(f.commits.length, 2, 'a one-finger drag commits on release');
  // Box selection keeps the crystal mode in charge of left drags.
  r.selectionInteraction = { mode: 'box', onBox() { throw new Error('no box while moving the crystal'); } };
  f.pointer('pointerdown', x, y); f.pointer('pointermove', x + 25, y + 5); f.pointer('pointerup', x + 25, y + 5);
  assert.equal(f.commits.length, 3);
  // Pointer cancellation and window blur restore the committed origin.
  const committed = [...r.periodicOrigin];
  f.pointer('pointerdown', x, y); f.pointer('pointermove', x + 25, y); f.pointer('pointercancel', x + 25, y);
  f.pointer('pointerdown', x, y); f.pointer('pointermove', x + 25, y); f.document.defaultView.emit('blur');
  assert.equal(r.crystalDrag, null); assert.deepEqual(r.periodicOrigin, committed); assert.equal(f.commits.length, 3);
  assert.equal(f.captures.size, 0);
  // Disabling (closing or loading a source) cancels and refuses new drags.
  f.pointer('pointerdown', x, y); f.pointer('pointermove', x + 25, y);
  f.controls.setEnabled(false);
  assert.equal(r.crystalDrag, null);
  assert.equal(f.nodes['origin-drag-mode'].disabled, true);
  f.pointer('pointerup', x + 25, y);
  assert.equal(f.commits.length, 3);
  f.controls.dispose();
  assert.equal(r.crystalDragController, undefined);
});

test('keyboard nudges move the crystal along periodic cell vectors and snap the committed origin', () => {
  const f = controlsFixture(), r = f.renderer;
  f.controls.nudge(0, .05);
  assert.deepEqual(f.commits.at(-1), [.95, 0, 0], 'moving the crystal +a lowers the wrapped origin');
  f.controls.nudge(2, -.05 / 4);
  assert.deepEqual(r.periodicOrigin, [.95, 0, .0125]);
  r.coordinateMode = 'unwrapped';
  f.controls.nudge(0, 1);
  assert.deepEqual(r.periodicOrigin, [-.05, 0, .0125], 'unwrapped origins keep whole-cell translations');
  const partial = rendererFixture(skew);
  const controls = initializeCrystalDragControls({ renderer: Object.assign(partial.renderer, { canvas: f.canvas }),
    getOrigin: () => partial.renderer.periodicOrigin, getCoordinateMode: () => 'wrapped', commit: origin => partial.renderer.setPeriodicOrigin(origin) });
  controls.setEnabled(true);
  assert.equal(controls.canNudge(1), false, 'open directions cannot be nudged');
  controls.nudge(1, .05);
  assert.deepEqual(partial.renderer.periodicOrigin, [0, 0, 0]);
  controls.setEnabled(false);
  assert.equal(controls.canNudge(0), false);
});

test('the source and every derived display stay independent of a drag preview', () => {
  const { renderer, frame } = rendererFixture(skewPeriodic, Float64Array.from({ length: 60 }, random(3)));
  const source = structuredClone({ positions: frame.positions, fractional: frame.fractional, cell: frame.cell });
  renderer.setPeriodicOrigin([.3, .1, .7]);
  const display = Float64Array.from(renderer.displayPositions);
  renderer.setCrystalDragShift([.2, -.4, .05]);
  assert.deepEqual(Array.from(renderer.displayPositions), Array.from(display), 'previews never rewrite display arrays');
  assert.deepEqual({ positions: frame.positions, fractional: frame.fractional, cell: frame.cell }, source);
  near(cartesianToFractional(frame.positions, frame.cell, new Float64Array(frame.positions.length)), frame.fractional, 1e-12);
});
