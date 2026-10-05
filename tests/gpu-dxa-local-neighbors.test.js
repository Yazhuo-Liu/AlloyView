import test from 'node:test';
import assert from 'node:assert/strict';
import { createCell, fractionalToCartesian, invert3 } from '../src/data/model.js';
import { prepareDxaLocalNeighborCoordinates } from '../src/analysis/gpu/dxa-local-neighbors.js';

function imageAliasFixture() {
  const cell = createCell({ origin: [100, -200, 300],
    vectors: [16, 0, 0, 2.25, 16, 0, .75, .4, 16], triclinic: true });
  const fractional = new Float64Array([0, 0, 0, .5, .25, 0, .25, .5, .75]);
  const frame = { fractional, cell }, coordinates = fractionalToCartesian(fractional, cell,
    new Float64Array(fractional.length));
  // Native inverse-cell wrapping can move zero-boundary atoms to image +1.
  const offsets = [[1, 1, 1], [0, 0, 1], [0, 0, 0]];
  for (let atom = 0; atom < offsets.length; atom++) for (let axis = 0; axis < 3; axis++) {
    for (let component = 0; component < 3; component++) {
      coordinates[atom * 3 + component] += offsets[atom][axis] * cell.vectors[axis * 3 + component];
    }
  }
  return { frame, coordinates, offsets };
}

test('native Cartesian image aliases align a translated triclinic frame without changing binary64 inputs', async () => {
  const { frame, coordinates, offsets } = imageAliasFixture();
  const original = coordinates.slice(), packed = await prepareDxaLocalNeighborCoordinates(frame,
    coordinates, invert3(frame.cell.vectors));
  const view = new DataView(packed.buffer);
  assert.equal(packed.byteLength, offsets.length * 36);
  for (let atom = 0; atom < offsets.length; atom++) for (let axis = 0; axis < 3; axis++) {
    assert.equal(view.getFloat64((atom * 9 + axis * 2) * 4, true), original[atom * 3 + axis]);
    assert.equal(view.getInt32((atom * 9 + 6 + axis) * 4, true), offsets[atom][axis]);
  }
  assert.deepEqual(coordinates, original);
});

test('explicit application atom images produce the same native image aliases as canonical fractional coordinates', async () => {
  const { frame, coordinates } = imageAliasFixture();
  const expected = await prepareDxaLocalNeighborCoordinates(frame, coordinates);
  const explicit = { ...frame, fractional: frame.fractional.slice() };
  for (let index = 0; index < explicit.fractional.length; index++) {
    explicit.fractional[index] += [2, -3, 1][index % 3];
  }
  assert.deepEqual(await prepareDxaLocalNeighborCoordinates(explicit, coordinates), expected);
});

test('nonperiodic axes reject whole-cell image aliases and origin precision loss cannot reach the GPU classifier', async () => {
  const { frame, coordinates } = imageAliasFixture();
  const open = { ...frame, cell: { ...frame.cell, pbc: [false, true, true] } };
  await assert.rejects(prepareDxaLocalNeighborCoordinates(open, coordinates),
    { name: 'GpuUnavailableError' });
  const cell = createCell({ origin: [1e16, 0, 0], vectors: [8, 0, 0, 0, 8, 0, 0, 0, 8] });
  const lossy = { fractional: new Float64Array([.1, .2, .3]), cell };
  const rounded = fractionalToCartesian(lossy.fractional, cell, new Float64Array(3));
  await assert.rejects(prepareDxaLocalNeighborCoordinates(lossy, rounded),
    { name: 'GpuUnavailableError' });
});

test('native neighbor source preparation rejects malformed or cancelled input', async () => {
  const { frame, coordinates } = imageAliasFixture();
  const malformed = coordinates.slice(); malformed[1] = NaN;
  await assert.rejects(prepareDxaLocalNeighborCoordinates(frame, malformed), /finite/);
  await assert.rejects(prepareDxaLocalNeighborCoordinates(frame, coordinates, new Float32Array(9)), /inverse cell/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareDxaLocalNeighborCoordinates(frame, coordinates, undefined,
    { signal: controller.signal }), { name: 'AbortError' });
});
