import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseCfg } from '../src/io/cfg.js';
import { indexLammpsDump, parseLammpsFrame, readLammpsFrame } from '../src/io/lammps-dump.js';

const root = new URL('../', import.meta.url);

test('extended AtomEye CFG preserves cell, atom count, properties, and fractional coordinates', async () => {
  const text = await readFile(new URL('examples/fcc-vacancy.cfg', root), 'utf8');
  const frame = parseCfg(text, 'fcc-vacancy.cfg');
  assert.equal(frame.ids.length, 31);
  assert.deepEqual([...frame.cell.vectors], [8.1, 0, 0, 0, 8.1, 0, 0, 0, 8.1]);
  assert.deepEqual(frame.typeLabels, ['Al']);
  assert.equal(frame.properties.find((property) => property.name === 'site_energy').unit, 'eV');
  assert.deepEqual([...frame.fractional.slice(0, 6)], [0, 0, 0, 0, 0.25, 0.25]);
  assert.deepEqual([...frame.positions.slice(3, 6)].map(round6), [0, 2.025, 2.025]);
});

test('LAMMPS-generated CFG promotes id and ix/iy/iz auxiliaries to frame semantics', async () => {
  const text = await readFile(new URL('100110.cfg', root), 'utf8');
  const frame = parseCfg(text, '100110.cfg');
  assert.equal(frame.ids.length, 7648);
  assert.equal(frame.ids[0], 12);
  assert.equal(new Set(frame.ids).size, 7648);
  assert.equal(Math.min(...frame.ids), 1);
  assert.equal(Math.max(...frame.ids), 7648);
  assert.deepEqual(frame.typeLabels, ['Ni']);
  assert.equal(frame.unwrapSource, 'ix/iy/iz');
  assert.ok(frame.unwrappedPositions);
  assert.ok(frame.imageFlags instanceof Int32Array);
  assert.deepEqual(frame.properties.map((property) => property.name), ['mass']);

  let crossedZ = 0;
  for (let atom = 0; atom < frame.ids.length; atom += 1) {
    const base = atom * 3;
    assert.ok(Math.abs(frame.unwrappedPositions[base] - frame.positions[base]) < 1e-5);
    assert.ok(Math.abs(frame.unwrappedPositions[base + 1] - frame.positions[base + 1]) < 1e-5);
    const deltaZ = frame.unwrappedPositions[base + 2] - frame.positions[base + 2];
    if (Math.abs(deltaZ + 9.95285) < 1e-4) crossedZ += 1;
    else assert.ok(Math.abs(deltaZ) < 1e-5, `unexpected z image displacement ${deltaZ}`);
  }
  assert.equal(crossedZ, 480);
  assert.equal([...frame.imageFlags].filter((value) => value === -1).length, 480);
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

test('restricted triclinic LAMMPS dump reconstructs true bounds and scaled positions', async () => {
  const text = await readFile(new URL('examples/bcc-trajectory.dump', root), 'utf8');
  const firstFrameText = text.slice(0, text.indexOf('ITEM: TIMESTEP', 1));
  const frame = parseLammpsFrame(firstFrameText, 'bcc-trajectory.dump');
  assert.equal(frame.ids.length, 16);
  assert.equal(frame.timestep, 0);
  assert.deepEqual([...frame.cell.origin], [0, 0, 0]);
  assert.deepEqual([...frame.cell.vectors].map(round6), [6.6, 0, 0, 0.5, 6.6, 0, 0.2, -0.3, 6.6]);
  assert.deepEqual([...frame.positions.slice(3, 6)].map(round6), [1.825, 1.575, 1.65]);
  assert.deepEqual(frame.typeLabels, ['Fe']);
  assert.equal(frame.properties[0].name, 'pe');
});

test('LAMMPS trajectory indexing returns frame slices without reading as one text value', async () => {
  const text = await readFile(new URL('examples/bcc-trajectory.dump', root), 'utf8');
  const blob = new Blob([text]);
  const { offsets } = await indexLammpsDump(blob);
  assert.equal(offsets.length, 2);
  const second = await readLammpsFrame(blob, offsets, 1, 'bcc-trajectory.dump');
  assert.equal(second.timestep, 100);
  assert.equal(second.ids[15], 16);
  assert.equal(round6(second.fractional[45]), 0.785);
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
