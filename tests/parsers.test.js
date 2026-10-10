import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCfg } from '../src/io/cfg.js';
import { indexLammpsDump, parseLammpsFrame, readLammpsFrame } from '../src/io/lammps-dump.js';

const triclinicTrajectory = [0, 100].map(timestep => `ITEM: TIMESTEP
${timestep}
ITEM: NUMBER OF ATOMS
2
ITEM: BOX BOUNDS xy xz yz pp pp pp
0 7.3 0.5
-0.3 6.6 0.2
0 6.6 -0.3
ITEM: ATOMS id type element xs ys zs pe
1 1 Fe 0 0 0 -4.28
2 1 Fe ${timestep ? '0.3' : '0.25'} 0.25 0.25 -4.27
`).join('');

test('extended AtomEye CFG preserves cell, atom count, properties, and fractional coordinates', () => {
  const frame = parseCfg(`Number of particles = 2
A = 1.0 Angstrom
H0(1,1) = 8.1
H0(1,2) = 0
H0(1,3) = 0
H0(2,1) = 0
H0(2,2) = 8.1
H0(2,3) = 0
H0(3,1) = 0
H0(3,2) = 0
H0(3,3) = 8.1
.NO_VELOCITY.
entry_count = 4
auxiliary[0] = site_energy [eV]
26.9815385
Al
0 0 0 -3.1
0 0.25 0.25 -3.36
`, 'extended.cfg');
  assert.equal(frame.ids.length, 2);
  assert.deepEqual([...frame.cell.vectors], [8.1, 0, 0, 0, 8.1, 0, 0, 0, 8.1]);
  assert.deepEqual(frame.typeLabels, ['Al']);
  assert.equal(frame.properties.find((property) => property.name === 'site_energy').unit, 'eV');
  assert.deepEqual([...frame.fractional.slice(0, 6)], [0, 0, 0, 0, 0.25, 0.25]);
  assert.deepEqual([...frame.positions.slice(3, 6)].map(round6), [0, 2.025, 2.025]);
});

test('LAMMPS-generated CFG promotes id and ix/iy/iz auxiliaries to frame semantics', () => {
  const frame = parseCfg(`Number of particles = 2
H0(1,1) = 10
H0(1,2) = 0
H0(1,3) = 0
H0(2,1) = 0
H0(2,2) = 10
H0(2,3) = 0
H0(3,1) = 0
H0(3,2) = 0
H0(3,3) = 10
.NO_VELOCITY.
entry_count = 7
auxiliary[0] = ix
auxiliary[1] = iy
auxiliary[2] = iz
auxiliary[3] = id
58.6934
Ni
0.1 0.2 0.3 0 0 -1 12
0.4 0.5 0.6 0 0 0 1
`, 'lammps-generated.cfg');
  assert.deepEqual([...frame.ids], [12, 1]);
  assert.deepEqual(frame.typeLabels, ['Ni']);
  assert.equal(frame.unwrapSource, 'ix/iy/iz');
  assert.ok(frame.unwrappedPositions);
  assert.ok(frame.imageFlags instanceof Int32Array);
  assert.deepEqual(frame.properties.map((property) => property.name), ['mass']);
  assertArrayClose(frame.positions, [1, 2, 3, 4, 5, 6]);
  assertArrayClose(frame.unwrappedPositions, [1, 2, -7, 4, 5, 6]);
  assert.deepEqual([...frame.imageFlags], [0, 0, -1, 0, 0, 0]);
});

test('basic AtomEye CFG applies A and Transform to row-vector coordinates', () => {
  const frame = parseCfg(`Number of particles = 1
A = 2.0 Angstrom
H0(1,1) = 1
H0(1,2) = 0
H0(1,3) = 0
H0(2,1) = 0
H0(2,2) = 1
H0(2,3) = 0
H0(3,1) = 0
H0(3,2) = 0
H0(3,3) = 1
Transform(1,1) = 2
12.0 Cu 0.25 0.5 0.75 0 0 0
`);
  assert.deepEqual([...frame.cell.vectors], [4, 0, 0, 0, 2, 0, 0, 0, 2]);
  assert.deepEqual([...frame.positions], [1, 1, 1.5]);
});

test('CFG applies a symmetric Lagrangian eta deformation', () => {
  const frame = parseCfg(`Number of particles = 1
H0(1,1) = 2
H0(1,2) = 0
H0(1,3) = 0
H0(2,1) = 0
H0(2,2) = 2
H0(2,3) = 0
H0(3,1) = 0
H0(3,2) = 0
H0(3,3) = 2
eta(1,1) = 0.5
.NO_VELOCITY.
entry_count = 3
1.0
X
0.5 0.5 0.5
`);
  assert.equal(round6(frame.cell.vectors[0]), round6(2 * Math.sqrt(2)));
  assert.deepEqual([...frame.positions].map(round6), [round6(Math.sqrt(2)), 1, 1]);
});

test('CFG rejects incomplete rows rather than silently inventing atoms', () => {
  assert.throws(() => parseCfg(`Number of particles = 1
H0(1,1) = 1
`), /cell definition is incomplete/);
});

test('CFG wraps meaningful out-of-cell fractional coordinates and preserves an inferred unwrapped view', () => {
  const frame = parseCfg(`Number of particles = 1
H0(1,1) = 10
H0(1,2) = 0
H0(1,3) = 0
H0(2,1) = 0
H0(2,2) = 10
H0(2,3) = 0
H0(3,1) = 0
H0(3,2) = 0
H0(3,3) = 10
.NO_VELOCITY.
entry_count = 3
58.6934
Ni
1.2 -0.3 0.5
`);
  assertArrayClose(frame.fractional, [0.2, 0.7, 0.5]);
  assertArrayClose(frame.positions, [2, 7, 5]);
  assertArrayClose(frame.unwrappedPositions, [12, -3, 5]);
  assert.deepEqual([...frame.imageFlags], [1, -1, 0]);
  assert.equal(frame.unwrapSource, 'out-of-cell CFG coordinates');
});

test('CFG treats tiny boundary overshoot as floating-point noise, not crossing history', () => {
  const frame = parseCfg(`Number of particles = 1
H0(1,1) = 1
H0(1,2) = 0
H0(1,3) = 0
H0(2,1) = 0
H0(2,2) = 1
H0(2,3) = 0
H0(3,1) = 0
H0(3,2) = 0
H0(3,3) = 1
.NO_VELOCITY.
entry_count = 3
1
X
1.000001 -0.000001 0.5
`);
  assertArrayClose(frame.fractional, [0, 0, 0.5]);
  assert.equal(frame.unwrappedPositions, undefined);
  assert.equal(frame.imageFlags, undefined);
});

test('restricted triclinic LAMMPS dump reconstructs true bounds and scaled positions', () => {
  const text = triclinicTrajectory;
  const firstFrameText = text.slice(0, text.indexOf('ITEM: TIMESTEP', 1));
  const frame = parseLammpsFrame(firstFrameText, 'triclinic.dump');
  assert.equal(frame.ids.length, 2);
  assert.equal(frame.timestep, 0);
  assert.deepEqual([...frame.cell.origin], [0, 0, 0]);
  assert.deepEqual([...frame.cell.vectors].map(round6), [6.6, 0, 0, 0.5, 6.6, 0, 0.2, -0.3, 6.6]);
  assert.deepEqual([...frame.positions.slice(3, 6)].map(round6), [1.825, 1.575, 1.65]);
  assert.deepEqual(frame.typeLabels, ['Fe']);
  assert.equal(frame.properties[0].name, 'pe');
});

test('LAMMPS trajectory indexing returns frame slices without reading as one text value', async () => {
  const text = triclinicTrajectory;
  const blob = new Blob([text]);
  const { offsets } = await indexLammpsDump(blob);
  assert.equal(offsets.length, 2);
  const second = await readLammpsFrame(blob, offsets, 1, 'triclinic.dump');
  assert.equal(second.timestep, 100);
  assert.equal(second.ids[1], 2);
  assert.equal(round6(second.fractional[3]), 0.3);
});

test('LAMMPS parser explicitly rejects general triclinic cells', () => {
  assert.throws(() => parseLammpsFrame(`ITEM: TIMESTEP
0
ITEM: NUMBER OF ATOMS
1
ITEM: BOX BOUNDS abc origin pp pp pp
1 0 0 0
0 1 0 0
0 0 1 0
ITEM: ATOMS id type x y z
1 1 0 0 0
`), /general triclinic/);
});

test('LAMMPS parser rejects non-numeric scalar properties clearly', () => {
  assert.throws(() => parseLammpsFrame(`ITEM: TIMESTEP
0
ITEM: NUMBER OF ATOMS
1
ITEM: BOX BOUNDS pp pp pp
0 1
0 1
0 1
ITEM: ATOMS id type x y z phase
1 1 0 0 0 solid
`), /Non-numeric custom columns are not supported/);
});

test('LAMMPS image flags produce triclinic unwrapped positions while analysis coordinates stay wrapped', () => {
  const frame = parseLammpsFrame(`ITEM: TIMESTEP
0
ITEM: NUMBER OF ATOMS
1
ITEM: BOX BOUNDS xy xz yz pp pp pp
0 13 2
0 13 1
0 10 3
ITEM: ATOMS id type xs ys zs ix iy iz
1 1 0.2 0.3 0.4 1 -1 2
`);
  assert.deepEqual([...frame.cell.vectors], [10, 0, 0, 2, 10, 0, 1, 3, 10]);
  assert.deepEqual([...frame.cell.pbc], [true, true, true]);
  assert.deepEqual([...frame.fractional].map(round6), [0.2, 0.3, 0.4]);
  assert.deepEqual([...frame.positions].map(round6), [3, 4.2, 4]);
  assertArrayClose(frame.unwrappedPositions, [13, 0.2, 24]);
  assert.equal(frame.unwrapSource, 'ix/iy/iz');
  assert.deepEqual([...frame.imageFlags], [1, -1, 2]);
  assert.equal(frame.properties.length, 0);
});

test('LAMMPS explicit unwrapped coordinates are wrapped only along periodic axes', () => {
  const frame = parseLammpsFrame(`ITEM: TIMESTEP
0
ITEM: NUMBER OF ATOMS
1
ITEM: BOX BOUNDS pp ff ss
0 10
0 10
0 10
ITEM: ATOMS id type xu yu zu
1 1 10.2 -0.2 11
`);
  assert.deepEqual([...frame.cell.pbc], [true, false, false]);
  assert.deepEqual([...frame.fractional].map(round6), [0.02, -0.02, 1.1]);
  assert.deepEqual([...frame.positions].map(round6), [0.2, -0.2, 11]);
  assert.deepEqual([...frame.unwrappedPositions].map(round6), [10.2, -0.2, 11]);
  assert.equal(frame.unwrapSource, 'xu/yu/zu');
});

test('LAMMPS keeps wrapped and unwrapped coordinate columns as separate views', () => {
  const frame = parseLammpsFrame(`ITEM: TIMESTEP
0
ITEM: NUMBER OF ATOMS
1
ITEM: BOX BOUNDS pp pp pp
0 10
0 10
0 10
ITEM: ATOMS id type x y z xu yu zu
1 1 0.2 9.8 5 10.2 -0.2 5
`);
  assertArrayClose(frame.positions, [0.2, 9.8, 5]);
  assertArrayClose(frame.unwrappedPositions, [10.2, -0.2, 5]);
  assert.deepEqual(frame.coordinateColumns, {
    wrapped: ['x', 'y', 'z'],
    unwrapped: ['xu', 'yu', 'zu'],
  });
});

test('LAMMPS parser rejects partial image flags instead of guessing an unwrap', () => {
  assert.throws(() => parseLammpsFrame(`ITEM: TIMESTEP
0
ITEM: NUMBER OF ATOMS
1
ITEM: BOX BOUNDS pp pp pp
0 1
0 1
0 1
ITEM: ATOMS id type x y z ix iy
1 1 0.2 0.3 0.4 1 0
`), /Image flags must provide ix, iy, and iz together/);
});

function round6(value) { return Math.round(value * 1e6) / 1e6; }

function assertArrayClose(actual, expected, tolerance = 1e-5) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= tolerance,
      `value ${index}: expected ${expected[index]}, received ${actual[index]}`,
    );
  }
}

test('LAMMPS dump atoms carry explicit IDs, so ID-anchored data follows them across frames', async () => {
  const { parseExternalProperties } = await import('../src/io/external-properties.js');
  const dump = (timestep, rows) => `ITEM: TIMESTEP\n${timestep}\nITEM: NUMBER OF ATOMS\n2\nITEM: BOX BOUNDS pp pp pp\n0 4\n0 4\n0 4\nITEM: ATOMS id type x y z\n${rows}\n`;
  const first = parseLammpsFrame(dump(0, '7 1 0 0 0\n3 1 2 2 2')), second = parseLammpsFrame(new TextEncoder().encode(dump(1, '3 1 2 2 2\n7 1 0 0 0')));
  // Text and byte inputs both declare the file's own id column.
  assert.equal(first.idSource, 'explicit');
  assert.equal(second.idSource, 'explicit');
  const bundle = parseExternalProperties('id,score\n7,0.5\n3,1.5\n', { frameIds: first.ids, idSource: first.idSource, frameIndex: 0 });
  assert.equal(bundle.manifest.scope, 'all-frames');
});
