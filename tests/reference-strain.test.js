import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateReferenceStrain, createReferenceMapping, createReferenceMappingAsync, prepareReferenceStrainContext, REFERENCE_STRAIN_FIELDS } from '../src/analysis/reference-strain.js';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

function near(values, expected, tolerance = 2e-6) {
  assert.ok(values.length > 0);
  for (const value of values) assert.ok(Math.abs(value - expected) < tolerance, `${value} != ${expected}`);
}

function deform(frame, F) {
  const vectors = [];
  for (let vector = 0; vector < 3; vector += 1) for (let row = 0; row < 3; row += 1) {
    vectors.push(F.slice(row * 3, row * 3 + 3).reduce((sum, value, k) => sum + value * frame.cell.vectors[vector * 3 + k], 0));
  }
  return { ...frame, fractional: Float64Array.from(frame.fractional), cell: createCell({ vectors, pbc: frame.cell.pbc, triclinic: true }) };
}

function calculate(current, reference, cutoff = 3.3, parameters = {}) {
  return calculateReferenceStrain(current, { referenceFractional: reference.fractional, referenceCell: reference.cell,
    referenceMapping: createReferenceMapping(current, reference), cutoff, ...parameters });
}

for (const [kind, repeat, cutoff] of [['fcc', 3, 3.3], ['bcc', 3, 3.9], ['hcp', 3, 4.5], ['sc', 1, 4.2]]) {
  test(`reference strain is zero for undeformed ${kind}, including primitive-cell images`, () => {
    const reference = crystalFrame(kind, repeat);
    const result = calculate({ ...reference }, reference, cutoff);
    for (const field of REFERENCE_STRAIN_FIELDS) {
      const match = /^referenceF(\d)(\d)$/.exec(field);
      near(result[field], match && match[1] === match[2] ? 1 : 0);
    }
    assert.equal(result.incomplete, 0);
    assert.equal(result.warning, null);
  });
}

test('reference strain reproduces homogeneous isotropic and anisotropic stretches', () => {
  const reference = crystalFrame('fcc');
  for (const [x, y, z] of [[1.08, 1.08, 1.08], [1.03, .96, 1.12]]) {
    const F = [x, 0, 0, 0, y, 0, 0, 0, z];
    const result = calculate(deform(reference, F), reference);
    near(result.referenceE11, (x * x - 1) / 2);
    near(result.referenceE22, (y * y - 1) / 2);
    near(result.referenceE33, (z * z - 1) / 2);
    near(result.referenceVolumeChange, x * y * z - 1);
    near(result.referenceHydrostaticStrain, (x * x + y * y + z * z - 3) / 6);
    for (let k = 0; k < 9; k += 1) near(result[`referenceF${Math.floor(k / 3) + 1}${k % 3 + 1}`], F[k]);
  }
});

test('finite shear and rigid rotation use Green-Lagrange strain', () => {
  const reference = crystalFrame('fcc');
  const gamma = .2;
  const result = calculate(deform(reference, [1, gamma, 0, 0, 1, 0, 0, 0, 1]), reference);
  near(result.referenceE12, gamma / 2);
  near(result.referenceE22, gamma * gamma / 2);
  near(result.referenceHydrostaticStrain, gamma * gamma / 6);
  near(result.referenceShearStrain, Math.sqrt(gamma * gamma / 4 + gamma ** 4 / 12));
  near(result.referenceVolumeChange, 0);
  const angle = .83;
  const rotation = [Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle), 0, 0, 0, 1];
  const rotated = calculate(deform(reference, rotation), reference);
  for (const field of REFERENCE_STRAIN_FIELDS.filter(name => !name.startsWith('referenceF'))) near(rotated[field], 0);
  near(rotated.referenceF12, -Math.sin(angle));
  near(rotated.referenceF21, Math.sin(angle));
});

test('D²min vanishes for affine deformation and equals the direct non-affine residual otherwise', () => {
  const reference = crystalFrame('fcc', 3);
  const sheared = calculate(deform(reference, [1, 0.04, 0, 0, 1, 0, 0.02, 0, 0.97]), reference);
  assert.ok(sheared.referenceD2min.every(value => value === 0), 'homogeneous deformation has no non-affine residual');
  let seed = 5; const noise = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5) * 0.01;
  const current = { ...reference, fractional: reference.fractional.map(value => value + noise()) };
  const result = calculate(current, reference);
  const L = reference.cell.vectors[0], count = reference.ids.length, cutoff = 3.3;
  const image = (fractional, i, j, axis) => { const delta = fractional[j * 3 + axis] - fractional[i * 3 + axis]; return (delta - Math.round(delta)) * L; };
  for (const atom of [0, 17, 63, 107]) {
    const F = Array.from({ length: 9 }, (_, k) => result[`referenceF${Math.floor(k / 3) + 1}${k % 3 + 1}`][atom]);
    let direct = 0;
    for (let other = 0; other < count; other += 1) {
      if (other === atom) continue;
      const D = [0, 1, 2].map(axis => image(reference.fractional, atom, other, axis));
      if (Math.hypot(...D) > cutoff) continue;
      const d = [0, 1, 2].map(axis => image(current.fractional, atom, other, axis));
      for (let row = 0; row < 3; row += 1) direct += (d[row] - F[row * 3] * D[0] - F[row * 3 + 1] * D[1] - F[row * 3 + 2] * D[2]) ** 2;
    }
    assert.ok(direct > 1e-4, 'the perturbation is non-affine');
    assert.ok(Math.abs(result.referenceD2min[atom] - direct) <= 1e-4 * direct, `atom ${atom}: ${result.referenceD2min[atom]} vs ${direct}`);
  }
});

test('stable ID mapping follows reordered atoms and preserves changed fractional geometry', () => {
  const reference = crystalFrame('fcc');
  const transformed = deform(reference, [1.05, .08, 0, 0, .97, 0, 0, 0, 1]);
  const count = reference.ids.length;
  const current = { ...transformed, ids: Float64Array.from(reference.ids).reverse(),
    fractional: new Float64Array(reference.fractional.length) };
  for (let atom = 0; atom < count; atom += 1) {
    current.fractional.set(transformed.fractional.subarray((count - atom - 1) * 3, (count - atom) * 3), atom * 3);
  }
  const result = calculate(current, reference);
  const baseline = calculate(transformed, reference);
  assert.deepEqual([...createReferenceMapping(current, reference)], Array.from({ length: count }, (_, atom) => count - atom - 1));
  for (const field of REFERENCE_STRAIN_FIELDS) assert.deepEqual([...result[field]], [...baseline[field]].reverse());
});

test('periodic crossings and lattice-image coordinates preserve affine triclinic strain', () => {
  const reference = crystalFrame('hcp', 3);
  const current = deform(reference, [1.02, .12, .03, 0, .98, .05, 0, 0, 1.04]);
  const baseline = calculate(current, reference, 4.5);
  for (let atom = 0; atom < reference.ids.length; atom += 1) for (let axis = 0; axis < 3; axis += 1) {
    current.fractional[atom * 3 + axis] += [.49, -.23, .18][axis];
    if (atom % 3 === axis) current.fractional[atom * 3 + axis] += atom % 2 ? 2 : -3;
  }
  const crossed = calculate(current, reference, 4.5);
  for (const field of REFERENCE_STRAIN_FIELDS) {
    crossed[field].forEach((value, atom) => assert.ok(Math.abs(value - baseline[field][atom]) < 2e-6, field));
  }
});

test('open axes keep physical displacements instead of wrapping them', () => {
  const reference = crystalFrame('fcc', 3);
  reference.cell = createCell({ vectors: reference.cell.vectors, pbc: [false, false, false] });
  const stretch = 1.8;
  const current = { ...reference, fractional: Float64Array.from(reference.fractional, value => value * stretch) };
  const result = calculate(current, reference);
  near(result.referenceE11, (stretch ** 2 - 1) / 2);
  near(result.referenceE22, (stretch ** 2 - 1) / 2);
  near(result.referenceE33, (stretch ** 2 - 1) / 2);
  near(result.referenceVolumeChange, stretch ** 3 - 1);
});

test('a skew cell resolves non-affine image changes by the Cartesian metric', () => {
  const cell = createCell({ vectors: [10, 0, 0, 9, 1, 0, 0, 0, 10], pbc: [true, true, false], triclinic: true });
  // A central atom with six orthogonal physical neighbors at distance 0.1.
  const fractional = Float64Array.from([.5, .5, .5,
    .51, .5, .5, .49, .5, .5, .41, .6, .5, .59, .4, .5, .5, .5, .51, .5, .5, .49]);
  const reference = { cell, fractional, ids: new Int32Array([1, 2, 3, 4, 5, 6, 7]) };
  const current = { ...reference, fractional: Float64Array.from(fractional) };
  current.fractional[3] += .49;
  current.fractional[4] += .49;
  const result = calculate(current, reference, .15, { endAtom: 1 });
  // The shortest image change is (.49, -.51, 0), i.e. (.31, -.51, 0)
  // in Cartesian coordinates, rather than component-rounded (.49, .49, 0).
  near(result.referenceF11, 1 + .31 / .2);
  near(result.referenceF21, -.51 / .2);
  near(result.referenceF22, 1);
  near(result.referenceF33, 1);
  assert.equal(result.incomplete, 0);
});

test('added and missing atoms leave only undefined fits NaN without warning', () => {
  const reference = crystalFrame('fcc');
  const current = { ...reference, ids: Float64Array.from(reference.ids), fractional: Float64Array.from(reference.fractional) };
  current.ids[0] = 100000;
  const result = calculate(current, reference);
  for (const field of REFERENCE_STRAIN_FIELDS) assert.ok(Number.isNaN(result[field][0]), field);
  assert.equal(result.incomplete, 1);
  assert.equal(result.warning, null);
  near(result.referenceHydrostaticStrain.subarray(1), 0);
});

test('insufficient and coplanar local neighbors silently produce NaN', () => {
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] });
  const fractional = Float64Array.from([.4, .4, .5, .5, .4, .5, .4, .5, .5, .5, .5, .5]);
  const frame = { cell, fractional, positions: fractionalToCartesian(fractional, cell), ids: new Int32Array([1, 2, 3, 4]) };
  for (const cutoff of [.5, 2]) {
    const result = calculate(frame, frame, cutoff);
    for (const field of REFERENCE_STRAIN_FIELDS) assert.ok(result[field].every(Number.isNaN), field);
    assert.equal(result.incomplete, 4);
    assert.equal(result.warning, null);
  }
});

test('split worker ranges produce exactly the same strain and deformation arrays', () => {
  const reference = crystalFrame('bcc');
  const current = deform(reference, [1.03, .12, .03, 0, .98, .05, 0, 0, 1.04]);
  const full = calculate(current, reference, 3.9);
  const first = calculate(current, reference, 3.9, { endAtom: 20 });
  const last = calculate(current, reference, 3.9, { startAtom: 20 });
  for (const field of REFERENCE_STRAIN_FIELDS) assert.deepEqual([...first[field], ...last[field]], [...full[field]]);
  assert.equal(first.startAtom, 0);
  assert.equal(first.endAtom, 20);
  assert.equal(last.startAtom, 20);
  assert.equal(last.endAtom, reference.ids.length);
});

test('reference ID validation rejects synthesized IDs, duplicates and missing metadata', () => {
  const frame = crystalFrame('fcc');
  const synthesized = { ...frame, sourceFormat: 'cfg', idSource: 'row-order' };
  assert.throws(() => createReferenceMapping(synthesized, frame), /explicit stable atom IDs/);
  assert.throws(() => createReferenceMapping(frame, { ...frame, sourceFormat: 'cfg' }), /explicit stable atom IDs/);
  assert.deepEqual([...createReferenceMapping(synthesized, synthesized)], [...frame.ids].map((_, index) => index));
  const repeated = { ...frame, ids: Float64Array.from(frame.ids) };
  repeated.ids[0] = repeated.ids[1];
  assert.throws(() => createReferenceMapping(repeated, frame), /unique integer atom IDs/);
  assert.throws(() => createReferenceMapping({ ...frame, ids: undefined }, frame), /an atom ID for every atom/);
  assert.throws(() => createReferenceMapping({ ...frame, ids: Float64Array.from(frame.ids, id => id + .5) }, frame), /unique integer atom IDs/);
});

test('asynchronous reference mapping matches reorder, missing atoms and synchronous validation', async () => {
  const reference = crystalFrame('fcc');
  const current = { ...reference, ids: Float64Array.from(reference.ids).reverse() };
  current.ids[12] = 100000;
  const progress = [];
  const result = await createReferenceMappingAsync(current, reference, { onProgress: entry => progress.push(entry) });
  assert.deepEqual(result, createReferenceMapping(current, reference));
  assert.equal(result[12], -1);
  assert.deepEqual(progress.at(-1), { completed: reference.ids.length * 2, total: reference.ids.length * 2 });
  await assert.rejects(createReferenceMappingAsync({ ...current, idSource: 'row-order' }, reference), /explicit stable atom IDs/);
  await assert.rejects(createReferenceMappingAsync({ ...current, ids: new Float64Array(current.ids.length).fill(1) }, reference), /unique integer atom IDs/);
  const synthetic = { ...reference, sourceFormat: 'cfg', idSource: 'row-order' };
  assert.deepEqual(await createReferenceMappingAsync(synthetic, synthetic), createReferenceMapping(synthetic, synthetic));
});

test('asynchronous ID preparation yields to cancellation before finishing a large mapping', async () => {
  const count = 150_000;
  const reference = { fractional: new Float32Array(count * 3), ids: Float64Array.from({ length: count }, (_, atom) => atom + 1) };
  const current = { ...reference, ids: Float64Array.from(reference.ids).reverse() };
  const controller = new AbortController(), progress = [];
  const pending = createReferenceMappingAsync(current, reference, { signal: controller.signal, onProgress: entry => progress.push(entry) });
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.ok(progress.at(-1).completed < count * 2, 'abort occurs during mapping instead of waiting for its completion');
  await assert.rejects(createReferenceMappingAsync(current, reference, { signal: controller.signal }), error => error.name === 'AbortError');
});

test('reference strain validates cutoff, PBC correspondence and one-to-one mapping', () => {
  const frame = crystalFrame('fcc');
  assert.throws(() => calculate(frame, frame, NaN), /cutoff/);
  assert.throws(() => calculate(frame, frame, 0), /cutoff/);
  assert.throws(() => calculate(frame, { ...frame, cell: { ...frame.cell, pbc: [false, true, true] } }), /same periodic/);
  const mapping = createReferenceMapping(frame, frame);
  mapping[0] = mapping[1];
  assert.throws(() => calculate(frame, frame, 3.3, { referenceMapping: mapping }), /one-to-one/);
});

test('phase and atom progress callbacks report index construction and completed range', () => {
  const frame = crystalFrame('fcc');
  const phases = [], progress = [];
  calculate(frame, frame, 3.3, { startAtom: 12, endAtom: 31, onPhase: phase => phases.push(phase),
    onAtoms: (...values) => progress.push(values) });
  assert.deepEqual(phases, ['indexing', 'analyzing']);
  assert.deepEqual(progress.at(-1), [19, 19]);
});

test('reference contexts validate and reuse shared normalized coordinates and inverse mappings exactly', () => {
  const reference = crystalFrame('fcc', 2), current = { ...reference, fractional: reference.fractional.slice(), ids: reference.ids.slice() };
  current.fractional[0] = -0; current.fractional[4] += 2; current.fractional[8] -= 1;
  const referenceMapping = createReferenceMapping(current, reference);
  const normalized = new Float64Array(new SharedArrayBuffer(current.fractional.byteLength));
  const inverse = new Int32Array(new SharedArrayBuffer(reference.ids.length * 4)).fill(-1);
  for (let k = 0; k < normalized.length; k += 1) normalized[k] = current.fractional[k] - Math.floor(current.fractional[k]);
  for (let atom = 0; atom < referenceMapping.length; atom += 1) if (referenceMapping[atom] >= 0) inverse[referenceMapping[atom]] = atom;
  const parameters = { referenceFractional: reference.fractional, referenceCell: reference.cell, referenceMapping, cutoff: 3.3 };
  const original = current.fractional.slice();
  const context = prepareReferenceStrainContext(current, { ...parameters, normalizedCurrentFractional: normalized, inverseMappingInput: inverse });
  assert.equal(context.currentFractional, normalized); assert.equal(context.inverseMapping, inverse);
  const direct = calculateReferenceStrain(current, parameters);
  for (const startAtom of [0, 7, 19]) {
    const endAtom = Math.min(reference.ids.length, startAtom + 11);
    const result = calculateReferenceStrain(current, { ...parameters, preparedContext: context, startAtom, endAtom });
    for (const field of REFERENCE_STRAIN_FIELDS) assert.deepEqual(result[field], direct[field].slice(startAtom, endAtom));
  }
  assert.deepEqual(current.fractional, original);
  const invalid = normalized.slice(); invalid[0] = -0;
  assert.throws(() => prepareReferenceStrainContext(current, { ...parameters, normalizedCurrentFractional: invalid }), /match the frame exactly/);
  invalid[0] = 0; invalid[1] += 1e-15;
  assert.throws(() => prepareReferenceStrainContext(current, { ...parameters, normalizedCurrentFractional: invalid }), /match the frame exactly/);
  assert.throws(() => prepareReferenceStrainContext(current, { ...parameters, normalizedCurrentFractional: new Float32Array(normalized) }), /incomplete/);
  assert.throws(() => prepareReferenceStrainContext(current, { ...parameters, inverseMappingInput: new Uint32Array(inverse) }), /incomplete/);
  const malformed = inverse.slice(); malformed[0] = -1;
  assert.throws(() => prepareReferenceStrainContext(current, { ...parameters, inverseMappingInput: malformed }), /one-to-one/);
  malformed[0] = 1;
  assert.throws(() => prepareReferenceStrainContext(current, { ...parameters, inverseMappingInput: malformed }), /match the atom mapping/);
  const missing = referenceMapping.slice(); missing[2] = -1;
  assert.throws(() => prepareReferenceStrainContext(current, { ...parameters, referenceMapping: missing, inverseMappingInput: inverse }), /match the atom mapping/);
  const clean = prepareReferenceStrainContext(reference, { ...parameters, referenceMapping });
  assert.equal(clean.currentFractional, reference.fractional, 'an immutable normalized Float64 snapshot needs no copy');
  const copied = prepareReferenceStrainContext(current, parameters);
  assert.notEqual(copied.currentFractional, current.fractional, 'image-bearing coordinates remain authoritative and unchanged');
  assert.ok(Object.is(copied.currentFractional[0], 0));
});

test('shared normalized reference inputs preserve signed zero on open axes and reject duplicate mappings', () => {
  const frame = crystalFrame('fcc', 2);
  frame.cell = createCell({ vectors: frame.cell.vectors, pbc: [true, false, true] }); frame.fractional[1] = -0;
  const mapping = createReferenceMapping(frame, frame), inverse = Int32Array.from(mapping);
  const parameters = { referenceFractional: frame.fractional, referenceCell: frame.cell, referenceMapping: mapping };
  const context = prepareReferenceStrainContext(frame, { ...parameters, normalizedCurrentFractional: frame.fractional, inverseMappingInput: inverse });
  assert.ok(Object.is(context.currentFractional[1], -0));
  const bad = frame.fractional.slice(); bad[1] = 0;
  assert.throws(() => prepareReferenceStrainContext(frame, { ...parameters, normalizedCurrentFractional: bad }), /match the frame exactly/);
  mapping[2] = mapping[1];
  assert.throws(() => prepareReferenceStrainContext(frame, { ...parameters, inverseMappingInput: inverse }), /match the atom mapping|one-to-one/);
});
