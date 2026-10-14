import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell } from '../src/data/model.js';
import { AtomPrimitiveLayer, bondDisplayShifts } from '../src/render/atom-primitives.js';
import { createPrimitivePreparation, revokePrimitivePreparation, releasePrimitivePreparationRows, preparedPrimitiveRows,
  createPrimitiveBondPreparation, revokePrimitiveBondPreparation, releasePrimitiveBondPreparationShifts, validatePrimitiveBondPreparation,
  preparedPrimitiveBondShifts } from '../src/render/prepared-primitive-inputs.js';

function fixture(count = 5) {
  const cell = createCell({ origin: [2, -3, 4], vectors: [10, 0, 0, 3, 8, 0, -2, 1, 7] });
  const positions = Float64Array.from({ length: count * 3 }, (_, i) => i === 0 ? -0 : i === 2 ? NaN : Math.sin(i) * 1e5);
  const fractional = Float64Array.from({ length: count * 3 }, (_, i) => i === 3 ? -0 : i === 5 ? NaN : Math.cos(i) / 7);
  const frame = { cell, positions, fractional };
  return { atomCount: count, frame, displayPositions: positions, displayFractional: fractional,
    periodicOrigin: [.125, 0, -.25], coordinateMode: 'wrapped' };
}

function publish(renderer, revision = 1) {
  renderer.preparedPrimitivePreparation = createPrimitivePreparation({ frame: renderer.frame,
    positions: renderer.displayPositions, fractional: renderer.displayFractional,
    periodicOrigin: renderer.periodicOrigin, coordinateMode: renderer.coordinateMode, displayRevision: revision });
  return renderer.preparedPrimitivePreparation;
}

function legacyPack(positions, pixels) {
  const result = new Float32Array(pixels * 4);
  for (let atom = 0; atom < positions.length / 3; atom++) {
    const source = atom * 3, target = atom * 4;
    result[target] = positions[source]; result[target + 1] = positions[source + 1]; result[target + 2] = positions[source + 2];
  }
  return result;
}

function bits(array) { return new Uint32Array(array.buffer, array.byteOffset, array.length); }

function layerFixture(renderer) {
  renderer.shareDisplayPreparation ??= true;
  const layer = Object.create(AtomPrimitiveLayer.prototype), uploads = [];
  Object.assign(layer, { width: 3, height: 2, sourceRenderer: renderer,
    colorSource: Uint8Array.from({ length: renderer.atomCount * 3 }, (_, i) => i * 11),
    textureDirty: { position: true, fractional: true, color: true, visibility: true },
    gl: { RGBA32F: 1, FLOAT: 2, RGBA8: 3, UNSIGNED_BYTE: 4, R8I: 5, BYTE: 6, RED_INTEGER: 7 },
    uploadTexture(index, values) { uploads.push({ index, values }); }, clearInstances() {} });
  return { layer, uploads };
}

test('two primitive contexts reuse bit-identical packed rows while uploading independent textures and styling', () => {
  const main = fixture(), preparation = publish(main), comparison = { ...main, preparedPrimitivePreparation: preparation };
  main.visibility = Uint8Array.of(255, 0, 255, 255, 255);
  comparison.visibility = Uint8Array.of(255, 255, 255, 0, 255);
  comparison.selectionVisibility = Uint8Array.of(255, 255, 0, 255, 255);
  const first = layerFixture(main), second = layerFixture(comparison);
  assert.equal(preparation.byteLength, 0, 'loading a frame without attached geometry allocates no mirrors');
  second.layer.colorSource = new Uint8Array(15).fill(123);
  second.layer.scalarColorInput = { colorOverrides: Uint8Array.of(0, 1, 0, 1, 0) };
  const sourceBits = new Uint8Array(main.displayPositions.buffer).slice();
  first.layer.flushTextures(); second.layer.flushTextures();
  assert.equal(first.layer.positionValues, second.layer.positionValues);
  assert.equal(first.layer.fractionalValues, second.layer.fractionalValues);
  assert.deepEqual(bits(first.layer.positionValues), bits(legacyPack(main.displayPositions, 6)));
  assert.deepEqual(bits(first.layer.fractionalValues), bits(legacyPack(main.displayFractional, 6)));
  assert.deepEqual(first.layer.visibilityValues, Int8Array.of(1, 0, 1, 1, 1, 0));
  assert.deepEqual(second.layer.visibilityValues, Int8Array.of(1, 1, -1, 0, 1, 0));
  assert.notEqual(first.layer.visibilityValues, second.layer.visibilityValues);
  assert.notEqual(first.layer.colorValues, second.layer.colorValues);
  assert.equal(first.layer.colorValues[0], 0); assert.equal(second.layer.colorValues[0], 123);
  assert.equal(second.layer.colorValues[7], 1);
  assert.deepEqual(first.uploads.map(row => row.index), [0, 2, 3, 1]);
  assert.deepEqual(second.uploads.map(row => row.index), [0, 2, 3, 1]);
  assert.deepEqual(new Uint8Array(main.displayPositions.buffer), sourceBits);
  const rows = preparedPrimitiveRows(main, 3, 2);
  assert.equal(rows, preparedPrimitiveRows(comparison, 3, 2));
  assert.equal(rows.byteLength, 6 * 4 * 4 * 2);
  assert.equal(preparation.byteLength, rows.byteLength);
});

test('primitive coordinate provenance checks every display input and keeps only one active texture layout', () => {
  const renderer = fixture(), preparation = publish(renderer);
  const original = preparedPrimitiveRows(renderer, 3, 2);
  assert.equal(original, preparedPrimitiveRows(renderer, 3, 2));
  assert.notEqual(preparedPrimitiveRows(renderer, 2, 3), original);
  assert.notEqual(preparedPrimitiveRows(renderer, 3, 2), original, 'evicted texture layouts are not retained in a map');
  for (const patch of [
    { frame: { ...renderer.frame } }, { atomCount: 4 },
    { displayPositions: renderer.displayPositions.slice() }, { displayFractional: renderer.displayFractional.slice() },
    { coordinateMode: 'unwrapped' }, { periodicOrigin: [.125, 0, -.5] },
    { preparedPrimitivePreparation: { ...preparation } },
  ]) assert.equal(preparedPrimitiveRows({ ...renderer, ...patch }, 3, 2), null);
  for (const [values, index, value] of [[renderer.frame.cell.vectors, 0, 11], [renderer.frame.cell.origin, 0, 3],
    [renderer.frame.cell.pbc, 1, false]]) {
    const old = values[index]; values[index] = value;
    assert.equal(preparedPrimitiveRows(renderer, 3, 2), null);
    values[index] = old;
  }
  renderer.frame.cell.triclinic = true;
  assert.equal(preparedPrimitiveRows(renderer, 3, 2), null);
  renderer.frame.cell.triclinic = false;
  assert.throws(() => preparation.textureRows(1, 1), /dimensions/);
  assert.throws(() => preparation.textureRows(1.5, 6), /dimensions/);
});

test('explicit same-array coordinate publications invalidate old rows without mutating the other view', () => {
  const renderer = fixture(), oldPreparation = publish(renderer), oldRows = preparedPrimitiveRows(renderer, 3, 2);
  const comparison = { ...renderer };
  const { layer } = layerFixture(renderer); layer.flushTextures();
  renderer.displayPositions[0] = 42; renderer.displayFractional[0] = .75;
  revokePrimitivePreparation(oldPreparation);
  assert.equal(preparedPrimitiveRows(comparison, 3, 2), null);
  assert.throws(() => oldPreparation.textureRows(3, 2), /obsolete/);
  publish(renderer, 2);
  layer.updatePositions(renderer); layer.flushTextures();
  assert.notEqual(layer.positionValues, oldRows.positionValues);
  assert.equal(layer.positionValues[0], 42); assert.equal(layer.fractionalValues[0], .75);
  assert.ok(Object.is(oldRows.positionValues[0], -0));
  // Rejecting provenance invokes private scratch, never edits a shared row.
  comparison.preparedPrimitivePreparation = oldPreparation;
  const secondary = layerFixture(comparison).layer;
  secondary.positionValues = secondary.sharedPositionValues = oldRows.positionValues;
  secondary.fractionalValues = secondary.sharedFractionalValues = oldRows.fractionalValues;
  secondary.flushTextures();
  assert.notEqual(secondary.positionValues, oldRows.positionValues);
  assert.equal(secondary.positionValues[0], 42);
  assert.ok(Object.is(oldRows.positionValues[0], -0));
});

test('visibility, selection, scalar overrides and clear never modify or retain shared coordinate scratch', () => {
  const renderer = fixture(); publish(renderer);
  const { layer } = layerFixture(renderer); layer.flushTextures();
  const positions = layer.positionValues, fractional = layer.fractionalValues;
  const original = new Uint8Array(positions.buffer).slice();
  renderer.visibility = new Uint8Array(5); renderer.selectionVisibility = new Uint8Array(5);
  layer.updateVisibility(renderer); layer.flushTextures();
  layer.updateColors(new Uint8Array(15)); layer.flushTextures();
  layer.updateScalarColorPreview({ colorOverrides: Uint8Array.of(1, 0, 1, 0, 1) }); layer.flushTextures();
  assert.equal(layer.positionValues, positions); assert.equal(layer.fractionalValues, fractional);
  assert.deepEqual(new Uint8Array(positions.buffer), original);
  layer.clear();
  for (const key of ['positionValues', 'fractionalValues', 'sharedPositionValues', 'sharedFractionalValues', 'sourceRenderer', 'colorSource']) {
    assert.equal(layer[key], null);
  }
  assert.deepEqual(new Uint8Array(positions.buffer), original);
});

test('shared bond shift preparation runs the exact triclinic oracle once and refreshes coordinate/data revisions', () => {
  const renderer = fixture(2);
  renderer.frame.positions = Float64Array.of(1, 2, 3, 9, 2, 3);
  renderer.displayPositions = Float64Array.of(1, 2, 3, -1, 2, 3);
  renderer.displayFractional = Float64Array.of(0, 0, 0, -1, 0, 0);
  publish(renderer);
  const bonds = { count: 1, indices: Uint32Array.of(0, 1), vectors: Float32Array.of(-2, 0, 0), shifts: Int32Array.of(-1, 0, 0) };
  renderer.preparedBondSnapshot = createPrimitiveBondPreparation({ frame: renderer.frame, bonds, bondRevision: 1 });
  assert.equal(renderer.preparedBondSnapshot.byteLength, 0);
  const comparison = { ...renderer }, validated = { ...bonds };
  let calls = 0;
  const calculate = (...args) => { calls++; return bondDisplayShifts(...args); };
  const first = preparedPrimitiveBondShifts(renderer, bonds, calculate);
  assert.equal(renderer.preparedBondSnapshot.byteLength, first.byteLength);
  assert.equal(first, preparedPrimitiveBondShifts(comparison, validated, calculate));
  assert.equal(calls, 1); assert.deepEqual(first, bondDisplayShifts(bonds, renderer.frame, renderer.displayPositions));
  const oldGeometry = renderer.preparedPrimitivePreparation;
  renderer.displayPositions[3] = 9; revokePrimitivePreparation(oldGeometry); publish(renderer, 2);
  const second = preparedPrimitiveBondShifts(renderer, bonds, calculate);
  assert.equal(calls, 2); assert.notEqual(second, first); assert.deepEqual([...second], [-1, 0, 0]);
  assert.equal(preparedPrimitiveBondShifts(comparison, bonds, calculate), null, 'an obsolete view cannot reuse old shifts');
  bonds.vectors[0] = 8;
  renderer.preparedBondSnapshot = createPrimitiveBondPreparation({ frame: renderer.frame, bonds, bondRevision: 2 });
  assert.deepEqual([...preparedPrimitiveBondShifts(renderer, bonds, calculate)], [0, 0, 0]); assert.equal(calls, 3);
  assert.equal(preparedPrimitiveBondShifts(renderer, { ...bonds, indices: bonds.indices.slice() }, calculate), null);
  renderer.frame.cell.vectors[0] = 11;
  assert.equal(preparedPrimitiveBondShifts(renderer, bonds, calculate), null);
});

test('bond tokens validate before assignment, reject forged publications and revoke across comparison views', () => {
  const renderer = fixture(2); publish(renderer);
  const bonds = { count: 1, indices: Uint32Array.of(0, 1), vectors: Float32Array.of(-2, 0, 0), shifts: new Int32Array(3) };
  const token = createPrimitiveBondPreparation({ frame: renderer.frame, bonds, bondRevision: 1 });
  assert.equal(validatePrimitiveBondPreparation(token, renderer, { ...bonds }), token);
  assert.throws(() => validatePrimitiveBondPreparation({ ...token }, renderer, bonds), /prepared bond/);
  assert.throws(() => validatePrimitiveBondPreparation(token, renderer, { ...bonds, count: 2 }), /prepared bond/);
  renderer.preparedBondSnapshot = token;
  const comparison = { ...renderer };
  revokePrimitiveBondPreparation(token);
  assert.throws(() => validatePrimitiveBondPreparation(token, comparison, bonds), /prepared bond/);
  assert.equal(preparedPrimitiveBondShifts(comparison, bonds, bondDisplayShifts), null);
});

test('a failed GL upload leaves a complete shared preparation reusable by the other context and a retry', () => {
  const renderer = fixture(), token = publish(renderer), comparison = { ...renderer };
  const first = layerFixture(renderer), second = layerFixture(comparison);
  first.layer.uploadTexture = () => { throw new Error('context lost'); };
  assert.throws(() => first.layer.flushTextures(), /context lost/);
  assert.equal(token.byteLength, 192);
  const positions = first.layer.positionValues;
  second.layer.flushTextures();
  assert.equal(second.layer.positionValues, positions);
  first.layer.uploadTexture = (index, values) => first.uploads.push({ index, values });
  first.layer.flushTextures();
  assert.equal(first.layer.positionValues, second.layer.positionValues);
  assert.deepEqual(first.layer.textureDirty, {});
  first.layer.clear();
  assert.equal(second.layer.positionValues, positions, 'closing one view cannot release the other view’s CPU input');
});

test('single-view coordinate updates reuse private scratch and retain no prepared row or transient bond-shift buffers', () => {
  const renderer = fixture(); renderer.shareDisplayPreparation = false;
  const first = publish(renderer), { layer } = layerFixture(renderer);
  layer.flushTextures();
  assert.equal(first.byteLength, 0);
  const positions = layer.positionValues, fractions = layer.fractionalValues;
  assert.equal(layer.sharedPositionValues, null); assert.equal(layer.sharedFractionalValues, null);
  renderer.displayPositions[0] = 123; renderer.displayFractional[0] = .5;
  revokePrimitivePreparation(first); const second = publish(renderer, 2);
  layer.updatePositions(renderer); layer.flushTextures();
  assert.equal(second.byteLength, 0);
  assert.equal(layer.positionValues, positions); assert.equal(layer.fractionalValues, fractions);
  assert.equal(positions[0], 123); assert.equal(fractions[0], .5);
  const bonds = { count: 1, indices: Uint32Array.of(0, 1), vectors: Float32Array.of(1, 0, 0), shifts: new Int32Array(3) };
  renderer.preparedBondSnapshot = createPrimitiveBondPreparation({ frame: renderer.frame, bonds, bondRevision: 1 });
  layer.bondOptions = { visible: true, radius: .08 }; layer.bondBuffers = {};
  layer.uploadInstances = () => {}; layer.uploadShifts = () => {};
  layer.setBonds(renderer, bonds);
  assert.equal(renderer.preparedBondSnapshot.byteLength, 0);
});

test('closing preparation sharing releases caches without mutating live rows and restores private scratch on update', () => {
  const renderer = fixture(), token = publish(renderer), { layer } = layerFixture(renderer);
  layer.flushTextures();
  const positions = layer.positionValues, fractions = layer.fractionalValues;
  const original = bits(positions).slice();
  releasePrimitivePreparationRows(token); renderer.shareDisplayPreparation = false;
  layer.releaseSharedPreparation();
  assert.equal(token.byteLength, 0);
  assert.equal(layer.positionValues, null); assert.equal(layer.fractionalValues, null);
  assert.deepEqual(layer.textureDirty, {}, 'already uploaded textures need no redundant close-time upload');
  assert.deepEqual(bits(positions), original);
  renderer.displayPositions[0] = 9;
  revokePrimitivePreparation(token); const next = publish(renderer, 2);
  layer.updatePositions(renderer); layer.flushTextures();
  assert.equal(next.byteLength, 0);
  assert.notEqual(layer.positionValues, positions); assert.notEqual(layer.fractionalValues, fractions);
  assert.equal(layer.positionValues[0], 9); assert.deepEqual(bits(positions), original);
  const bonds = { count: 1, indices: Uint32Array.of(0, 1), vectors: Float32Array.of(1, 0, 0), shifts: new Int32Array(3) };
  renderer.preparedBondSnapshot = createPrimitiveBondPreparation({ frame: renderer.frame, bonds, bondRevision: 1 });
  preparedPrimitiveBondShifts(renderer, bonds, bondDisplayShifts);
  assert.equal(renderer.preparedBondSnapshot.byteLength, 12);
  releasePrimitiveBondPreparationShifts(renderer.preparedBondSnapshot);
  assert.equal(renderer.preparedBondSnapshot.byteLength, 0);
});
