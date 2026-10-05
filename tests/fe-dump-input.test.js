import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { indexLammpsDump, parseLammpsFrame, readLammpsFrame } from '../src/io/lammps-dump.js';

test('Fe dislocation-loop dump preserves native IDs, triclinic coordinates, image flags, and scalar properties', async () => {
  const data = await readFile(new URL('../examples/Fe_disloc_loop.dump', import.meta.url));
  const blob = new Blob([data]);
  const progress = [];
  const { offsets } = await indexLammpsDump(blob, (event) => progress.push(event));
  assert.deepEqual(offsets, [0]);
  assert.equal(progress.at(-1).loaded, data.length);
  assert.ok(progress.length > 1, 'the example exercises indexing across multiple chunks');

  const frame = await readLammpsFrame(blob, offsets, 0, 'Fe_disloc_loop.dump');
  assert.equal(frame.timestep, 11524);
  assert.equal(frame.ids.length, 60229);
  assert.equal(new Set(frame.ids).size, 60229);
  assert.equal(Math.min(...frame.ids), 1);
  assert.equal(Math.max(...frame.ids), 60229);
  assert.deepEqual([...frame.ids.slice(0, 5)], [24, 82, 75, 3, 4]);
  assert.equal(frame.ids.at(-1), 5129);
  assert.deepEqual(frame.typeLabels, ['Type 1']);
  assert.ok(frame.types.every((type) => type === 0));
  assert.deepEqual(frame.cell.pbc, [true, true, true]);
  assert.equal(frame.cell.triclinic, true);
  assertArrayClose(frame.cell.origin, [-45.14223299859098, -44.10552147446405, -43.11001062557283], 1e-10);
  assertArrayClose(frame.cell.vectors, [
    90.28446599718195, 0, 0,
    -0.001020185952279249, 88.2110429489281, 0,
    -0.08493970712540132, -0.058389933694939146, 86.22002125114567,
  ], 1e-10);
  assert.deepEqual(frame.coordinateColumns, { wrapped: ['x', 'y', 'z'], unwrapped: null });
  assert.equal(frame.unwrapSource, 'ix/iy/iz');
  assert.ok(frame.imageFlags instanceof Int32Array);
  assert.equal(frame.unwrappedPositions.length, 60229 * 3);
  assert.ok(frame.fractional.every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
  assert.ok(frame.positions.every(Number.isFinite));
  assert.ok(frame.unwrappedPositions.every(Number.isFinite));
  assertArrayClose(frame.positions.slice(0, 3), [-42.8314268, -42.1039606, -42.2842469]);
  assert.deepEqual([...frame.imageFlags.slice(-3)], [-1, 0, -1]);
  assertArrayClose(frame.unwrappedPositions.slice(-3), [
    45.0547107 - 90.28446599718195 + 0.08493970712540132,
    42.0436921 + 0.058389933694939146,
    43.1095355 - 86.22002125114567,
  ]);

  assert.deepEqual(frame.properties.map(({ name }) => name), [
    'c_atom_pe',
    'c_atom_stress[1]', 'c_atom_stress[2]', 'c_atom_stress[3]',
    'c_atom_stress[4]', 'c_atom_stress[5]', 'c_atom_stress[6]',
    'd2_lat_x[1]', 'd2_lat_x[2]', 'd2_lat_x[3]',
    'd2_ref_x[1]', 'd2_ref_x[2]', 'd2_ref_x[3]',
    'i_group_inters',
  ]);
  for (const property of frame.properties) {
    assert.equal(property.data.length, 60229, property.name);
    assert.ok(property.data.every(Number.isFinite), property.name);
  }
  assertArrayClose([frame.properties[0].data[0]], [-8.2409]);
  assertArrayClose(frame.properties.slice(7, 10).map(({ data }) => data[0]), [-42.8246, -42.0989, -42.1486]);
  const interstitialGroup = frame.properties.at(-1).data;
  assert.ok(interstitialGroup.every((value) => value === 0 || value === 1));
  assert.ok(interstitialGroup.includes(1));
});

test('missing LAMMPS elements keep sorted numeric type labels regardless of source filename', () => {
  const text = dumpRows('id type x y z', [
    '4 26 0 0 0',
    '2 1 1 1 1',
    '1 99 2 2 2',
    '3 26 3 3 3',
  ]);
  for (const filename of ['Fe_disloc_loop.dump', 'Fe.dump', 'Cu.lammpstrj']) {
    const frame = parseLammpsFrame(text, filename);
    assert.deepEqual(frame.typeLabels, ['Type 1', 'Type 26', 'Type 99']);
    assert.deepEqual([...frame.types], [1, 0, 2, 1]);
  }
});

test('explicit consistent LAMMPS elements supply labels and inconsistent mappings are rejected', () => {
  const frame = parseLammpsFrame(dumpRows('id type element x y z', [
    '1 2 Fe 0 0 0',
    '2 1 Cu 1 1 1',
    '3 2 Fe 2 2 2',
  ]));
  assert.deepEqual(frame.typeLabels, ['Cu', 'Fe']);
  assert.deepEqual([...frame.types], [1, 0, 1]);
  assert.throws(() => parseLammpsFrame(dumpRows('id type element x y z', [
    '1 1 Fe 0 0 0',
    '2 1 Cu 1 1 1',
  ])), /Type 1 maps to both element/);
});

test('LAMMPS numeric types retain safe integer identifiers beyond the signed 32-bit range', () => {
  const frame = parseLammpsFrame(dumpRows('id type x y z', [
    '1 4294967297 0 0 0',
    '2 1 1 1 1',
    '3 2147483648 2 2 2',
    '4 9007199254740991 3 3 3',
    '5 4294967297 4 4 4',
  ]));
  assert.deepEqual(frame.typeLabels, [
    'Type 1', 'Type 2147483648', 'Type 4294967297', 'Type 9007199254740991',
  ]);
  assert.deepEqual([...frame.types], [2, 0, 1, 3, 2]);
});

test('LAMMPS rejects zero, negative, fractional, non-finite, and unsafe numeric types', () => {
  for (const type of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', 'Fe']) {
    assert.throws(() => parseLammpsFrame(dumpRows('id type x y z', [`1 ${type} 0 0 0`])),
      /type.*(?:positive|safe) integer/, type);
  }
});

function dumpRows(columns, rows) {
  return `ITEM: TIMESTEP\n0\nITEM: NUMBER OF ATOMS\n${rows.length}\nITEM: BOX BOUNDS pp pp pp\n0 10\n0 10\n0 10\nITEM: ATOMS ${columns}\n${rows.join('\n')}\n`;
}

function assertArrayClose(actual, expected, tolerance = 2e-5) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    assert.ok(Math.abs(actual[index] - expected[index]) <= tolerance,
      `value ${index}: expected ${expected[index]}, received ${actual[index]}`);
  }
}
