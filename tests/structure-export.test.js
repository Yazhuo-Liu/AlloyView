import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePoscar } from '../src/io/poscar.js';
import { parseCif } from '../src/io/cif.js';
import { createStructureExport, createStructureExportAsync, structureExportText } from '../src/io/structure-export.js';
import { replicateFrame } from '../src/data/replicate.js';
import { determinant3 } from '../src/data/model.js';

const source = () => parsePoscar(`DFT crystal
1
3.123456789012345 0.125 0.25
0.5 4.012345678901234 0.2
0.2 0.4 5.012345678901234
O Fe O
1 1 1
Selective dynamics
Direct
0.123456789012345 0.234567890123456 0.345678901234567 T F T
0.7 0.6 0.5 F F T
0.3 0.2 0.1 T T F
`);

test('POSCAR export groups elements stably and retains full lattice, coordinate and selective-dynamics precision', async () => {
  const frame = source(), original = structuredClone(frame);
  const result = createStructureExport(frame, { format: 'poscar', stem: '/tmp/my crystal.cif' });
  assert.equal(result.filename, 'my_crystal.POSCAR');
  assert.equal(result.atomCount, 3);
  const restored = parsePoscar(await result.blob.text());
  assert.deepEqual(restored.cell.vectors, frame.cell.vectors);
  assert.deepEqual(restored.typeLabels, ['O', 'Fe']);
  const reordered = [0, 2, 1];
  assert.deepEqual([...restored.fractional], reordered.flatMap(atom => [...frame.fractional.subarray(atom * 3, atom * 3 + 3)]));
  for (const property of restored.properties) {
    const input = frame.properties.find(entry => entry.name === property.name).data;
    assert.deepEqual([...property.data], reordered.map(atom => input[atom]));
  }
  assert.deepEqual(frame, original);
});

test('CIF export uses P1 complete sites with unique labels and retains unknown occupancy and isotropic parameters', async () => {
  const frame = source();
  frame.properties.push({ name: 'occupancy', data: new Float64Array([0.5, NaN, 1]) },
    { name: 'Uiso', data: new Float64Array([0.0123456789012345, NaN, 0]) },
    { name: 'Biso', data: new Float64Array([0.2, 0.3, 0.4]) });
  const result = createStructureExport(frame, { format: 'cif' }), text = await result.blob.text();
  assert.equal(result.filename, 'structure.cif');
  assert.match(text, /_space_group_IT_number 1\n/);
  assert.match(text, /'x,y,z'\n/);
  assert.match(text, /O1 O 0.123456789012345 0.234567890123456 0.345678901234567 0.5 0.0123456789012345 0.2/);
  assert.match(text, /Fe1 Fe 0.7 0.6 0.5 \? \? 0.3/);
  assert.match(text, /O2 O 0.3 0.2 0.1 1 0 0.4/);
  assert.doesNotMatch(text, /selectiveDynamics|NaN/);
  const restored = parseCif(text);
  assert.deepEqual(restored.fractional, frame.fractional);
  assert.deepEqual(restored.typeLabels, frame.typeLabels);
  for (const name of ['occupancy', 'Uiso', 'Biso']) {
    assert.deepEqual(restored.properties.find(property => property.name === name).data,
      frame.properties.find(property => property.name === name).data);
  }
  // CIF stores a conventional lattice basis, so compare its invariant metric
  // rather than the Cartesian orientation of the original POSCAR vectors.
  const metric = vectors => [0, 1, 2].flatMap(first => [0, 1, 2].map(second =>
    [0, 1, 2].reduce((sum, axis) => sum + vectors[first * 3 + axis] * vectors[second * 3 + axis], 0)));
  const expected = metric(frame.cell.vectors);
  metric(restored.cell.vectors).forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 2e-14));
});

test('structure export includes physical repetitions and ignores display-only state and visibility', async () => {
  const frame = source();
  frame.displayOrigin = [0.25, 0.5, 0.75];
  frame.visibilityMask = new Uint8Array(3);
  frame.displayRepetitions = [4, 4, 4];
  assert.equal(parsePoscar(structureExportText(frame, { format: 'poscar' })).types.length, 3);
  const replicated = await replicateFrame(frame, [2, 1, 1]);
  const restored = parsePoscar(structureExportText(replicated, { format: 'poscar' }));
  assert.equal(restored.types.length, 6);
  assert.deepEqual(restored.cell.vectors, replicated.cell.vectors);
});

test('CIF export changes a left-handed cell basis without reflecting the physical crystal', () => {
  const frame = parsePoscar(`chiral basis\n1\n3 0 0\n0 4 0\n0 0 -5\nC\n4\nDirect\n0 0 0\n0.1 0 0\n0 0.1 0\n0 0 -0.1\n`);
  const restored = parseCif(structureExportText(frame, { format: 'cif' }));
  assert.ok(determinant3(frame.cell.vectors) < 0);
  assert.ok(determinant3(restored.cell.vectors) > 0);
  // Image-aware coordinates retain the positive z arm. Without the paired
  // basis/coordinate sign change CIF would mirror it onto the negative arm.
  const positions = restored.unwrappedPositions ?? restored.positions;
  assert.ok(Math.abs(positions[11] - 0.5) < 1e-14);
  assert.ok(Math.abs(positions[3] - 0.3) < 1e-14);
  assert.ok(Math.abs(positions[7] - 0.4) < 1e-14);
});

test('POSCAR refuses partial, unknown and explicitly disordered structures instead of silently making them ordered', () => {
  for (const value of [0, 0.5, NaN]) {
    const frame = source();
    frame.properties.push({ name: 'occupancy', data: new Float64Array([1, value, 1]) });
    assert.throws(() => createStructureExport(frame, { format: 'poscar' }), /partial or unknown occupancy/);
  }
  const frame = source();
  frame.crystal.disordered = true;
  assert.throws(() => createStructureExport(frame, { format: 'poscar' }), /ordered structure/);
  assert.doesNotThrow(() => createStructureExport(frame, { format: 'cif' }));
});

test('structure exports reject missing element identity, malformed coordinates, nonperiodic cells and incomplete flags', () => {
  for (const format of ['poscar', 'cif']) {
    let frame = source(); frame.typeLabels[0] = 'Type 1';
    assert.throws(() => createStructureExport(frame, { format }), /not a known element/);
    frame = source(); frame.fractional[2] = Infinity;
    assert.throws(() => createStructureExport(frame, { format }), /non-finite coordinate/);
    frame = source(); frame.cell.pbc[2] = false;
    assert.throws(() => createStructureExport(frame, { format }), /all three cell axes/);
    frame = source(); frame.types[0] = 999;
    assert.throws(() => createStructureExport(frame, { format }), /invalid species index/);
  }
  const frame = source(); frame.properties.pop();
  assert.throws(() => createStructureExport(frame, { format: 'poscar' }), /all three selective-dynamics/);
  assert.throws(() => createStructureExport(source(), { format: 'xyz' }), /choose CIF or POSCAR/);
  assert.throws(() => createStructureExport(source(), { maxBytes: 10 }), /text budget/);
});

test('structure formatting asynchronously preserves input buffers, matches synchronous output and can cancel', async () => {
  const frame = source(), before = structuredClone(frame);
  for (const format of ['poscar', 'cif']) {
    const sync = createStructureExport(frame, { format }), asyncResult = await createStructureExportAsync(frame, { format }, { budgetMs: 0 });
    assert.equal(await asyncResult.blob.text(), await sync.blob.text());
  }
  const abort = new AbortController();
  let yielded = false;
  await assert.rejects(createStructureExportAsync(frame, { format: 'poscar' }, { signal: abort.signal, budgetMs: 0,
    yieldControl: async () => { yielded = true; abort.abort(); } }), { name: 'AbortError' });
  assert.equal(yielded, true);
  assert.deepEqual(frame, before);
});
