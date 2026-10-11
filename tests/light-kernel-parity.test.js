import assert from 'node:assert/strict';
import test from 'node:test';
import { createCell, cartesianToFractional } from '../src/data/model.js';
import { minimumImageDisplacement, prepareDisplacements, calculatePreparedDisplacements } from '../src/analysis/displacement.js';
import { calculateAtomicStrain, STRAIN_FIELDS } from '../src/analysis/atomic-strain.js';

function frame(positions, cell) {
  return { positions, cell, ids: Int32Array.from({ length: positions.length / 3 }, (_, atom) => atom + 1), idSource: 'explicit',
    fractional: cartesianToFractional(positions, cell, new Float64Array(positions.length)) };
}

function exact(actual, expected) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index++) assert.ok(Object.is(actual[index], expected[index]), `component ${index}: ${actual[index]} != ${expected[index]}`);
}

test('triclinic displacement retains closest-image tie order and double-precision boundary values', () => {
  const cell = createCell({ vectors: [10, 0, 0, 9, 1, 0, .7, -.8, 10], triclinic: true, pbc: [true, true, true] });
  // Equal-distance images keep the original a/b/c traversal winner; values on
  // either side of the half-cell boundary keep their original f64 residuals.
  for (const [input, expected] of [
    [[9.31, .49, 1], [.3099999999999998, -.51, 1]],
    [[5, 0, 0], [2, 3, 0]], [[-5, 0, 0], [2, 3, 0]],
    [[4.999999999999, 0, 0], [2.9999999999990017, 2, 0]],
    [[5.000000000001, 0, 0], [-2.9999999999990017, -2, 0]],
    [[0, .5, 5], [.3000000000000005, .30000000000000004, -5]],
    [[0, -.5, -5], [-.3000000000000005, -.30000000000000004, 5]],
    [[91.23, -8.41, 10.23], [1.5299999999999996, 1.3900000000000001, .23000000000000131]],
  ]) exact(minimumImageDisplacement(input, cell), expected);
});

test('prepared displacement keeps F32-rounded magnitudes, signed zero and bounded cancellation checkpoints', async () => {
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] });
  const reference = frame(new Float64Array(4096 * 3), cell), current = frame(reference.positions.slice(), cell);
  current.positions.set([.13, .24, .35, -0, 0, -0, 3e38, 3e38, 3e38]);
  const parameters = await prepareDisplacements(current, reference, { minimumImage: false });
  parameters.referenceMapping[4095] = -1;
  const result = calculatePreparedDisplacements(current, parameters);
  exact(result.vectors.subarray(3, 6), [-0, 0, -0]);
  assert.equal(result.magnitudes[0], Math.hypot(Math.fround(.13), Math.fround(.24), Math.fround(.35)));
  assert.equal(result.magnitudes[2], Math.hypot(Math.fround(3e38), Math.fround(3e38), Math.fround(3e38)));
  assert.ok(result.magnitudes[2] > 3.4028235e38 && Number.isFinite(result.magnitudes[2]));
  assert.ok(Number.isNaN(result.magnitudes[4095]));
  const controller = new AbortController(), checkpoints = [];
  assert.throws(() => calculatePreparedDisplacements(current, parameters, { signal: controller.signal, onProgress(update) {
    checkpoints.push(update.completed); controller.abort();
  } }), { name: 'AbortError' });
  assert.deepEqual(checkpoints, [2048]);
  assert.equal(current.positions.byteLength, reference.positions.byteLength);
});

test('cached ideal strain scratch stays independent across species, invalid rows, ranges and reference edits', async () => {
  const gamma = .06, shear = [1, gamma, 0, 0, 1, 0, 0, 0, 1], count = 6;
  const frame = { fractional: new Float64Array(count * 3), types: Uint16Array.of(0, 1, 0, 1, 0, 1) };
  const references = [{ structure: 5, a: 1 }, { structure: 2, a: 1, c: Math.sqrt(8 / 3) }];
  const ptmInput = { structures: Uint8Array.of(5, 2, 5, 2, 5, 2), scales: Float64Array.of(1, 1, 1, -1, Infinity, 1),
    deformation: Float64Array.from([...shear, ...shear, ...shear, ...shear.map(value => -value), ...shear, ...shear]) };
  ptmInput.deformation[2 * 9 + 4] = NaN;
  const before = ptmInput.deformation.slice(), result = await calculateAtomicStrain(frame, { references, ptmInput });
  assert.equal(result.incomplete, 2);
  const expected = { atomicShearStrain: Math.fround(Math.sqrt(gamma ** 2 / 4 + gamma ** 4 / 12)),
    atomicHydrostaticStrain: Math.fround(gamma ** 2 / 6), atomicVolumeChange: 0,
    strainE11: 0, strainE22: Math.fround(gamma ** 2 / 2), strainE33: 0, strainE12: Math.fround(gamma / 2), strainE13: 0, strainE23: 0 };
  const ranged = await calculateAtomicStrain(frame, { references, ptmInput, startAtom: 3, endAtom: 6 });
  for (const name of STRAIN_FIELDS) {
    for (const atom of [0, 1, 3, 5]) assert.equal(result[name][atom], expected[name], `${name}, atom ${atom}`);
    for (const atom of [2, 4]) assert.ok(Number.isNaN(result[name][atom]));
    exact(ranged[name], result[name].subarray(3));
  }
  assert.deepEqual(ptmInput.deformation, before);
  references[0] = { structure: 5, a: .5 };
  const edited = await calculateAtomicStrain(frame, { references, ptmInput });
  assert.equal(edited.atomicVolumeChange[0], 7);
  assert.equal(edited.atomicVolumeChange[1], 0);
});
