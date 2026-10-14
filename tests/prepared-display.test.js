import assert from 'node:assert/strict';
import test from 'node:test';
import { cartesianToFractional, createCell, fractionalToCartesian } from '../src/data/model.js';
import { periodicDisplayCoordinates } from '../src/render/periodic-origin.js';
import { validatePreparedDisplay } from '../src/render/prepared-display.js';
import { preparedPrimitiveBondShifts, validatePrimitiveBondPreparation } from '../src/render/prepared-primitive-inputs.js';
import { bondDisplayShifts } from '../src/render/atom-primitives.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

function fixture() {
  return Object.assign(Object.create(WebGLRenderer.prototype), {
    frame: null, contextLost: true, periodicOrigin: [0, 0, 0], coordinateMode: 'wrapped',
    voronoiDisplayRevision: 0, displayRevision: 0, sourceBoundsRevision: 0,
    selectedAtoms: new Int32Array(16).fill(-1), sliceSelectedAtoms: new Int32Array(3).fill(-1),
    repetitions: [1, 1, 1], clearScalarColorPreview() {}, cancelSelectionGesture() {}, requestRender() {},
    bondOptions: { radius: .08, visible: true },
    onProjectionChange() {}, slicePlaneValues: new Float32Array(64),
  });
}

function source() {
  const cell = createCell({ origin: [12, -3, 2], vectors: [-8, 1, 0, 3, 7, 1, -2, 2, 9], pbc: [true, false, true] });
  const fractional = Float64Array.of(.05, .3, .8, .95, .6, .2);
  return { cell, fractional, positions: fractionalToCartesian(fractional, cell, new Float64Array(6)), ids: Uint32Array.of(1, 2) };
}

function adopt(main, second = fixture()) {
  const snapshot = main.exportDisplaySnapshot();
  second.setFrame(main.frame, main.atomColors, main.rawDisplayPositions, main.atomRadii, main.repetitions,
    { coordinateMode: main.coordinateMode, preparedDisplay: snapshot });
  return { snapshot, second };
}

test('prepared views share exact wrapped/unwrapped coordinates and pure bounds across skewed negative replicas', () => {
  const frame = source(), main = fixture(), colors = new Uint8Array(6).fill(160), radii = Float32Array.of(.6, 1.4);
  main.setFrame(frame, colors, frame.positions, radii, [2, 1, 3]);
  for (const mode of ['wrapped', 'unwrapped']) for (const origin of [[0, 0, 0], [.3, 7, -.2], [-2.3, 0, 3.2]]) {
    const raw = mode === 'wrapped' ? frame.positions : Float64Array.from(frame.positions, (value, index) => value + (index % 3 ? 0 : 24));
    main.setPeriodicOrigin(origin, { coordinateMode: mode }); main.setDisplayPositions(raw, { coordinateMode: mode });
    const { snapshot, second } = adopt(main);
    assert.equal(second.displayPositions, main.displayPositions);
    assert.equal(second.displayFractional, main.displayFractional);
    assert.equal(second.rawDisplayPositions, raw);
    assert.equal(second.atomRadii, radii);
    assert.equal(second.maximumAtomRadius, main.maximumAtomRadius);
    assert.deepEqual(second.periodicOrigin, origin);
    assert.deepEqual(second.sceneBounds, main.sceneBounds);
    assert.deepEqual(second.selectionSourceBounds, main.selectionSourceBounds);
    const expected = origin[0] || origin[2] ? periodicDisplayCoordinates(raw, frame.cell, origin, { wrap: mode === 'wrapped' })
      : { positions: raw, fractional: mode === 'wrapped' ? frame.fractional : cartesianToFractional(raw, frame.cell, new Float64Array(raw.length)) };
    assert.deepEqual(second.displayPositions, expected.positions);
    assert.deepEqual(second.displayFractional, expected.fractional);
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.sourceBounds.minimum));
  }
});

test('second view skips coordinate and radius scans while attached scene bounds remain independent', () => {
  const frame = source(), main = fixture(); let coordinateReads = 0, radiusReads = 0;
  const tracked = (array, read) => new Proxy(Array.from(array), { get(target, key) {
    if (/^\d+$/.test(String(key))) read(); return target[key];
  } });
  frame.positions = tracked(frame.positions, () => coordinateReads++);
  const radii = tracked([.6, 1.4], () => radiusReads++);
  main.setFrame(frame, new Uint8Array(6), frame.positions, radii, [2, 1, 3]);
  assert.equal(coordinateReads, 6); assert.equal(radiusReads, 2);
  const snapshot = main.exportDisplaySnapshot(); coordinateReads = radiusReads = 0;
  const second = fixture();
  second.trajectoryLineLayer = { clear() {}, extendBounds(r, minimum, maximum) { maximum[2] = 97; } };
  second.setFrame(frame, main.atomColors, frame.positions, radii, main.repetitions, { preparedDisplay: snapshot });
  assert.equal(coordinateReads, 0); assert.equal(radiusReads, 0);
  assert.equal(second.sceneBounds.maximum[2], 97);
  assert.notEqual(main.sceneBounds.maximum[2], 97, 'full scene bounds are never shared between views');
  second.setReplications([3, 1, 1]);
  assert.equal(coordinateReads, 0); assert.equal(radiusReads, 0);
  assert.deepEqual(main.repetitions, [2, 1, 3]);
});

test('explicit same-array setters revoke stale publications and refresh both coordinates and maximum radius', () => {
  const frame = source(), main = fixture(), radii = Float32Array.of(.6, 1.4);
  main.setFrame(frame, new Uint8Array(6), frame.positions, radii);
  const { snapshot: old, second } = adopt(main), revision = main.displayRevision;
  frame.positions[0] -= 30; main.setDisplayPositions(frame.positions);
  assert.equal(main.displayRevision, revision + 1);
  assert.throws(() => validatePreparedDisplay(old, frame, frame.positions, 'wrapped'), /does not match/);
  const fresh = main.exportDisplaySnapshot();
  second.setDisplayPositions(frame.positions, { coordinateMode: 'wrapped', preparedDisplay: fresh });
  assert.equal(second.displayPositions, main.displayPositions);
  assert.deepEqual(second.sceneBounds, main.sceneBounds);
  radii[0] = 3.5; main.setAtomRadii(radii);
  assert.throws(() => validatePreparedDisplay(fresh, frame, frame.positions, 'wrapped'), /does not match/);
  const changed = main.exportDisplaySnapshot();
  second.setAtomRadii(radii, { preparedDisplay: changed });
  assert.equal(second.maximumAtomRadius, 3.5);
  assert.equal(second.preparedPrimitivePreparation, main.preparedPrimitivePreparation, 'radius edits retain coordinate rows');
  second.clearFrame();
  assert.equal(main.exportDisplaySnapshot(), changed, 'a consumer cannot revoke its publisher');
  assert.equal(second.preparedDisplaySnapshot, null); assert.equal(second.preparedPrimitivePreparation, null);
  main.clearFrame();
  assert.throws(() => validatePreparedDisplay(changed, frame, frame.positions, 'wrapped'), /does not match/);
});

test('forged descriptors, stale cell/PBC/origin metadata, changed shapes and unmatched sources reject before adoption', () => {
  const frame = source(), main = fixture(); main.setFrame(frame, new Uint8Array(6), frame.positions, Float32Array.of(.6, 1.4));
  const snapshot = main.exportDisplaySnapshot(), second = fixture();
  for (const invalid of [{ ...snapshot }, { ...snapshot, displayPositions: new Float64Array(3) }]) {
    assert.throws(() => second.setFrame(frame, main.atomColors, frame.positions, main.atomRadii, [1, 1, 1],
      { preparedDisplay: invalid }), /does not match/);
    assert.equal(second.frame, null);
  }
  assert.throws(() => validatePreparedDisplay(snapshot, { ...frame }, frame.positions, 'wrapped'), /does not match/);
  assert.throws(() => validatePreparedDisplay(snapshot, frame, frame.positions.slice(), 'wrapped'), /does not match/);
  assert.throws(() => validatePreparedDisplay(snapshot, frame, frame.positions, 'unwrapped'), /does not match/);
  assert.throws(() => validatePreparedDisplay(snapshot, frame, frame.positions, 'wrapped', { periodicOrigin: [1, 0, 0] }), /does not match/);
  for (const [array, index, value] of [[frame.cell.vectors, 0, -10], [frame.cell.origin, 1, 7], [frame.cell.pbc, 0, false]]) {
    const old = array[index]; array[index] = value;
    assert.throws(() => validatePreparedDisplay(snapshot, frame, frame.positions, 'wrapped'), /does not match/);
    array[index] = old;
  }
  const oldIds = frame.ids; frame.ids = Uint32Array.of(1);
  assert.throws(() => validatePreparedDisplay(snapshot, frame, frame.positions, 'wrapped'), /does not match/);
  frame.ids = oldIds;
});

test('publication metadata preserves original NaN, signed-zero and empty coordinate bound semantics', () => {
  for (const positions of [Float64Array.of(-0, 0, -0, 0, -0, 0), Float64Array.of(NaN, 1, 2), new Float64Array(0)]) {
    const frame = source(); frame.positions = positions; frame.fractional = new Float64Array(positions.length);
    frame.ids = Uint32Array.from({ length: positions.length / 3 }, (_, atom) => atom + 1);
    const main = fixture(); main.setFrame(frame, new Uint8Array(positions.length));
    const { second } = adopt(main);
    for (const key of ['minimum', 'maximum']) for (let axis = 0; axis < 3; axis++) {
      assert.ok(Object.is(second.selectionSourceBounds[key][axis], main.selectionSourceBounds[key][axis]));
      assert.ok(Object.is(second.sceneBounds[key][axis], main.sceneBounds[key][axis]));
    }
  }
});

test('Float64 vertex conversion runs once per shared revision, with independent GL uploads and bounded mirror lifetime', () => {
  const frame = source(), main = fixture(), second = fixture();
  main.setFrame(frame, new Uint8Array(6), frame.positions, Float32Array.of(.6, 1.4));
  assert.equal(main.preparedDisplayUploads, null, 'single-view setters retain no Float32 upload mirrors');
  adopt(main, second);
  const original = Float32Array.from; let conversions = 0;
  Float32Array.from = function(values, ...args) {
    if (values instanceof Float64Array) conversions++;
    return original.call(Float32Array, values, ...args);
  };
  try {
    for (const origin of [[0, 0, 0], [.3, 0, -.2]]) {
      main.periodicOrigin = origin;
      main.setDisplayPositions(frame.positions, { coordinateMode: 'wrapped' });
      const uploads = [];
      main.gl = { ARRAY_BUFFER: 1, STATIC_DRAW: 2, DYNAMIC_DRAW: 3, bindBuffer() {}, bufferData(target, values) { uploads.push(values); } };
      second.gl = { ...main.gl, bufferData(target, values) { uploads.push(values); } };
      conversions = 0;
      main.uploadFrameBuffers();
      const snapshot = main.exportDisplaySnapshot();
      second.setDisplayPositions(frame.positions, { coordinateMode: 'wrapped', preparedDisplay: snapshot });
      second.uploadFrameBuffers();
      assert.equal(conversions, 2, 'one positions conversion and one fractions conversion serve both GL contexts');
      assert.equal(uploads[0], uploads[6]); assert.equal(uploads[1], uploads[7]);
      assert.deepEqual(uploads[0], original.call(Float32Array, main.displayPositions));
      assert.deepEqual(uploads[1], original.call(Float32Array, main.displayFractional));
      assert.equal(snapshot.uploadByteLength, 6 * Float32Array.BYTES_PER_ELEMENT * 2);
      main.uploadFrameBuffers(); second.uploadFrameBuffers();
      assert.equal(conversions, 2, 'context resource uploads reuse immutable vertex mirrors');
    }
  } finally { Float32Array.from = original; }
  second.clearFrame(); main.setDisplayPreparationSharing(false);
  assert.equal(main.preparedDisplaySnapshot, null); assert.equal(main.preparedDisplayUploads, null);
  main.clearFrame(); assert.equal(main.preparedPrimitivePreparation, null);
});

test('bond publications share exact shifts, retain ownership through context replay and reject stale or failed updates', () => {
  const frame = source(), main = fixture(); main.setFrame(frame, new Uint8Array(6));
  main.setPeriodicOrigin([.3, 0, -.2]);
  const { second } = adopt(main);
  const bonds = { indices: Uint32Array.of(0, 1), vectors: Float32Array.of(-.8, .6, -5), shifts: Int32Array.of(-1, 0, 0), count: 1 };
  main.setBonds(bonds); const publication = main.preparedBondSnapshot;
  second.setBonds(main.atomBonds, { preparedBonds: publication });
  let calculations = 0;
  const calculate = (...args) => { calculations++; return bondDisplayShifts(...args); };
  const first = preparedPrimitiveBondShifts(main, main.atomBonds, calculate);
  const other = preparedPrimitiveBondShifts(second, second.atomBonds, calculate);
  assert.equal(first, other); assert.equal(calculations, 1);
  assert.deepEqual(first, bondDisplayShifts(main.atomBonds, frame, main.displayPositions));
  main.setBonds(main.atomBonds, { ...main.bondOptions, preparedBonds: publication });
  assert.equal(main.preparedBondSnapshot, publication, 'context replay retains the original owned token');
  assert.equal(main.ownPreparedBondSnapshot, publication);
  assert.throws(() => main.setBonds(bonds, { radius: -1 }), /radius/);
  assert.equal(main.preparedBondSnapshot, publication, 'failed setters keep the last valid descriptor');
  assert.equal(validatePrimitiveBondPreparation(publication, main, main.atomBonds), publication);
  second.clearFrame();
  assert.equal(validatePrimitiveBondPreparation(publication, main, main.atomBonds), publication, 'consumer cleanup cannot revoke the publisher');
  main.setBonds(bonds, { visible: false });
  assert.notEqual(main.preparedBondSnapshot, publication);
  assert.throws(() => validatePrimitiveBondPreparation(publication, main, main.atomBonds), /does not match/);
  main.clearFrame(); assert.equal(main.preparedBondSnapshot, null); assert.equal(main.ownPreparedBondSnapshot, null);
});
