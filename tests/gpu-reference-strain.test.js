import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateReferenceStrain, createReferenceMapping, prepareReferenceStrainContext, REFERENCE_STRAIN_FIELDS } from '../src/analysis/reference-strain.js';
import { analyzeGpuReferenceStrain, prepareGpuReferenceParameters } from '../src/analysis/gpu/reference-strain.js';
import { crystalFrame } from './helpers/crystals.js';
import { createCell } from '../src/data/model.js';

const parametersFor = (frame, reference = frame, cutoff = 3.1) => ({ referenceFrame: reference, referenceFractional: reference.fractional,
  referenceCell: reference.cell, referenceMapping: createReferenceMapping(frame, reference), cutoff });

test('GPU reference mapping handles reordered and missing atoms without losing canonical frame identity', () => {
  const reference = crystalFrame('fcc', 1), frame = { ...reference, ids: new Uint32Array([4, 2, 99, 1]) };
  const parameters = parametersFor(frame, reference);
  const prepared = prepareGpuReferenceParameters(frame, parameters);
  assert.deepEqual([...prepared.inverseMapping], [3, 1, -1, 0]);
  assert.equal(prepared.referenceFrame, reference);
  const settings = new Uint32Array(prepared.settings);
  assert.deepEqual([...settings.subarray(0, 4)], [4, 0, 4, 0x7fc00000]);
  assert.equal(new Float32Array(prepared.settings)[24], reference.cell.vectors[0]);
});

test('GPU reference input rejects duplicate correspondence, mismatched PBC and inconsistent cached identities', () => {
  const frame = crystalFrame('fcc', 1), parameters = parametersFor(frame);
  assert.throws(() => prepareGpuReferenceParameters(frame, { ...parameters, referenceMapping: new Int32Array(4) }), /one-to-one/);
  assert.throws(() => prepareGpuReferenceParameters(frame, { ...parameters, referenceMapping: Int32Array.from([0, 1, 2, 9]) }), /within the reference/);
  assert.throws(() => prepareGpuReferenceParameters(frame, { ...parameters,
    referenceCell: createCell({ vectors: frame.cell.vectors, pbc: [false, true, true] }) }), /same periodic/);
  assert.throws(() => prepareGpuReferenceParameters(frame, { ...parameters, referenceFrame: { ...frame, fractional: frame.fractional.slice() } }), /match the reference/);
});

test('prepared double-precision reference contexts preserve every field for repeated sparse ranges', () => {
  const reference = crystalFrame('hcp', 3, 2.5), frame = { ...reference, fractional: reference.fractional.slice(),
    cell: createCell({ vectors: [...reference.cell.vectors].map((value, index) => value * (index % 3 === 2 ? 1.03 : 1.01)), triclinic: true }) };
  frame.fractional[0] += .01;
  const parameters = parametersFor(frame, reference, 2.8);
  const full = calculateReferenceStrain(frame, parameters), preparedContext = prepareReferenceStrainContext(frame, parameters);
  for (const atom of [0, 1, 7, frame.ids.length - 1]) {
    const result = calculateReferenceStrain(frame, { ...parameters, preparedContext, startAtom: atom, endAtom: atom + 1 });
    for (const field of REFERENCE_STRAIN_FIELDS) assert.equal(result[field][0], full[field][atom], field);
  }
  assert.throws(() => calculateReferenceStrain({ ...frame }, { ...parameters, preparedContext }), /does not match/);
});

test('GPU sparse reference corrections reuse the CPU context and preserve every Float32 field', async () => {
  const frame = crystalFrame('fcc', 1), parameters = parametersFor(frame), expected = calculateReferenceStrain(frame, parameters);
  const flat = new Float32Array(REFERENCE_STRAIN_FIELDS.length * frame.ids.length);
  REFERENCE_STRAIN_FIELDS.forEach((field, index) => flat.set(expected[field], index * frame.ids.length));
  flat[0] = 99;
  const runtime = fakeRuntime(frame, flat, new Uint32Array([2, 1, 1, 1]));
  const actual = await analyzeGpuReferenceStrain(runtime, frame, parameters);
  for (const field of REFERENCE_STRAIN_FIELDS) assert.deepEqual(actual[field], expected[field], field);
  assert.equal(actual.correctedAtoms, 1);
  assert.equal(actual.incomplete, 0); assert.equal(actual.warning, null);
  assert.equal(runtime.disposed.length, 5);
  assert.equal(runtime.unpinned, 1);
  assert.ok(parameters.referenceMapping.byteLength > 0 && frame.fractional.byteLength > 0);
});

test('GPU reference unknown correspondences stay NaN silently without CPU correction', async () => {
  const frame = crystalFrame('fcc', 1), parameters = { ...parametersFor(frame), referenceMapping: new Int32Array(4).fill(-1) };
  const runtime = fakeRuntime(frame, new Float32Array(72).fill(NaN), new Uint32Array(4));
  const actual = await analyzeGpuReferenceStrain(runtime, frame, parameters);
  for (const field of REFERENCE_STRAIN_FIELDS) assert.ok(actual[field].every(Number.isNaN));
  assert.equal(actual.correctedAtoms, 0); assert.equal(actual.incomplete, 4); assert.equal(actual.warning, null);
});

test('GPU reference failure and cancellation release temporary buffers and both frame pins', async () => {
  const frame = crystalFrame('fcc', 1), runtime = fakeRuntime(frame, new Float32Array(72), new Uint32Array(4));
  runtime.run = async () => { throw new DOMException('Cancelled.', 'AbortError'); };
  await assert.rejects(analyzeGpuReferenceStrain(runtime, frame, parametersFor(frame)), { name: 'AbortError' });
  assert.equal(runtime.disposed.length, 5); assert.equal(runtime.unpinned, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(analyzeGpuReferenceStrain(runtime, frame, parametersFor(frame), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(runtime.unpinned, 1, 'an already cancelled job allocates and pins nothing');
});

function fakeRuntime(frame, flat, flags) {
  return {
    disposed: [], unpinned: 0,
    pinFrames() { return () => { this.unpinned += 1; }; },
    async prepareFrameBuffers() { return { positionsBuffer: {} }; },
    async prepareNeighbors() { return { atomCount: frame.ids.length, configBuffer: {}, positionsBuffer: {}, headsBuffer: {}, nextBuffer: {} }; },
    storageBuffer(array) { return { array }; }, createBuffer(bytes) { return { bytes }; }, async run() {},
    async read(_buffer, Type) { return Type === Float32Array ? flat : flags; },
    disposeBuffers(buffers) { this.disposed.push(...buffers); },
  };
}
