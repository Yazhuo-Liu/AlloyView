import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLammpsData } from '../src/io/lammps-data.js';
import { parsePoscar } from '../src/io/poscar.js';
import { detectStructureFormatHeader, inferStructureFormatFromPath, isPotentialStructurePath } from '../src/io/file-sequences.js';

const near = (actual, expected, tolerance = 1e-6) => {
  assert.equal(actual.length, expected.length);
  expected.forEach((value, index) => assert.ok(Math.abs(actual[index] - value) <= tolerance, `[${index}] ${actual[index]} != ${value}`));
};

const writeData = `LAMMPS data file via write_data, version 2Aug2023, timestep = 0, units = metal

4 atoms
2 atom types

0.0 4.05 xlo xhi
0.0 4.05 ylo yhi
0.0 4.05 zlo zhi

Masses

1 26.9815 # Al
2 58.6934 # Ni

Atoms # atomic

1 1 0 0 0 0 0 0
2 2 0 2.025 2.025 0 0 0
3 1 2.025 0 2.025 0 0 0
4 1 2.025 2.025 0 1 0 -1

Velocities

3 0.5 0 0
1 0.1 0 0
2 0.2 0 0
4 0.4 0 0
`;

test('LAMMPS data atomic style reads masses, type names, image flags and velocities', () => {
  const frame = parseLammpsData(writeData, 'data.AlNi');
  assert.equal(frame.sourceFormat, 'lammps-data');
  assert.deepEqual(frame.typeLabels, ['Al', 'Ni']);
  assert.deepEqual([...frame.types], [0, 1, 0, 0]);
  assert.deepEqual([...frame.ids], [1, 2, 3, 4]);
  assert.equal(frame.idSource, 'explicit');
  near(frame.positions, [0, 0, 0, 0, 2.025, 2.025, 2.025, 0, 2.025, 2.025, 2.025, 0]);
  near(frame.unwrappedPositions.subarray(9, 12), [6.075, 2.025, -4.05]);
  assert.deepEqual([...frame.imageFlags.subarray(9, 12)], [1, 0, -1]);
  const property = name => frame.properties.find(entry => entry.name === name).data;
  near(property('mass'), [26.9815, 58.6934, 26.9815, 26.9815], 1e-4);
  near(property('vx'), [0.1, 0.2, 0.5, 0.4], 1e-7);
  assert.deepEqual(frame.cell.pbc, [true, true, true]);
});

test('LAMMPS data supports style hints, tilt factors and type labels', () => {
  const charge = `Atomsk
2 atoms
1 atom types
0 5 xlo xhi
0 5 ylo yhi
0 5 zlo zhi
1.0 0.5 0.0 xy xz yz

Atoms # charge

1 1 -0.5 1 1 1
2 1 0.5 3 3 3
`;
  const frame = parseLammpsData(charge);
  assert.deepEqual([...frame.properties.find(entry => entry.name === 'q').data], [-0.5, 0.5]);
  assert.equal(frame.cell.triclinic, true);
  near(frame.cell.vectors, [5, 0, 0, 1, 5, 0, 0.5, 0, 5]);
  assert.deepEqual(frame.typeLabels, ['Type 1']);
  const full = `title
2 atoms
2 atom types
0 4 xlo xhi
0 4 ylo yhi
0 4 zlo zhi

Atom Type Labels

1 Fe
2 C

Atoms # full

7 3 Fe 0.0 1 1 1
9 3 C 0.1 2 2 2
`;
  const labeled = parseLammpsData(full);
  assert.deepEqual(labeled.typeLabels, ['Fe', 'C']);
  assert.deepEqual([...labeled.ids], [7, 9]);
  assert.deepEqual([...labeled.properties.find(entry => entry.name === 'mol').data], [3, 3]);
});

test('LAMMPS data rejects ambiguous or inconsistent input with specific messages', () => {
  const header = 'title\n2 atoms\n1 atom types\n0 4 xlo xhi\n0 4 ylo yhi\n0 4 zlo zhi\n\nAtoms\n\n';
  assert.throws(() => parseLammpsData(`${header}1 1 0 1 1 1\n2 1 0 2 2 2\n`), /no style comment.*Atoms # charge/);
  assert.throws(() => parseLammpsData(`${header}1 1 1 1 1\n`), /declares 2 atoms, but the Atoms section has 1/);
  assert.throws(() => parseLammpsData(`${header}1 1 1 1 1\n1 1 2 2 2\n`), /not a unique positive integer/);
  assert.throws(() => parseLammpsData(`${header}1 2 1 1 1\n2 1 2 2 2\n`), /outside 1–1/);
  assert.throws(() => parseLammpsData(header.replace('0 4 zlo zhi\n', '')), /zlo zhi/);
  assert.throws(() => parseLammpsData(`${header.replace('Atoms', 'Atoms # body')}1 1 1 1 1\n2 1 2 2 2\n`), /“body” is not supported/);
});

const cu3au = `Cu3Au L12
3.75
1.0 0.0 0.0
0.0 1.0 0.0
0.0 0.0 1.0
Au Cu_pv
1 3
Direct
0 0 0
0 0.5 0.5
0.5 0 0.5
0.5 0.5 0
`;

test('POSCAR reads VASP 5 species, direct coordinates and the scale factor', () => {
  const frame = parsePoscar(cu3au, 'POSCAR');
  assert.equal(frame.sourceFormat, 'poscar');
  assert.deepEqual(frame.typeLabels, ['Au', 'Cu']);
  assert.deepEqual([...frame.types], [0, 1, 1, 1]);
  assert.equal(frame.idSource, 'row-order');
  near(frame.cell.vectors, [3.75, 0, 0, 0, 3.75, 0, 0, 0, 3.75]);
  near(frame.positions, [0, 0, 0, 0, 1.875, 1.875, 1.875, 0, 1.875, 1.875, 1.875, 0]);
  const volume = parsePoscar(cu3au.replace('\n3.75\n', `\n${-(3.75 ** 3)}\n`));
  near(volume.cell.vectors, [3.75, 0, 0, 0, 3.75, 0, 0, 0, 3.75], 1e-9);
  const perAxis = parsePoscar(cu3au.replace('\n3.75\n', '\n2 3 4\n'));
  near(perAxis.cell.vectors, [2, 0, 0, 0, 3, 0, 0, 0, 4]);
});

test('POSCAR reads VASP 4 files, Cartesian coordinates and selective dynamics', () => {
  const vasp4 = `Au Cu
2.0
1 0 0
0 1 0
0 0 1
1 1
Selective dynamics
Cartesian
0 0 0 T T F
0.5 0.5 0.5 F F T
`;
  const frame = parsePoscar(vasp4);
  assert.deepEqual(frame.typeLabels, ['Au', 'Cu'], 'species come from the comment line');
  near(frame.positions, [0, 0, 0, 1, 1, 1]);
  assert.deepEqual([...frame.properties.find(entry => entry.name === 'selectiveDynamicsZ').data], [0, 1]);
  assert.deepEqual(parsePoscar(vasp4.replace('Au Cu', 'relaxed cell')).typeLabels, ['Type 1', 'Type 2']);
  assert.throws(() => parsePoscar(vasp4.replace('Cartesian', 'Fractional')), /Direct.*Cartesian/);
  assert.throws(() => parsePoscar(cu3au.replace('1 3', '1 2 1')), /2 species names but 3 counts/);
});

test('format detection recognizes data files and POSCAR without misreading other formats', () => {
  assert.equal(detectStructureFormatHeader(writeData), 'lammps-data');
  assert.equal(detectStructureFormatHeader(cu3au), 'poscar');
  assert.equal(detectStructureFormatHeader('2\nLattice="4 0 0 0 4 0 0 0 4"\nFe 0 0 0\nFe 2 2 2\n'), 'xyz');
  assert.equal(detectStructureFormatHeader('ITEM: TIMESTEP\n0\n'), 'lammps-dump');
  assert.equal(detectStructureFormatHeader('Number of particles = 2\n'), 'cfg');
  assert.equal(inferStructureFormatFromPath('runs/data.Fe'), 'lammps-data');
  assert.equal(inferStructureFormatFromPath('system.data'), 'lammps-data');
  assert.equal(inferStructureFormatFromPath('relax/CONTCAR'), 'poscar');
  assert.equal(inferStructureFormatFromPath('cell.vasp'), 'poscar');
  assert.equal(inferStructureFormatFromPath('mydata.dump'), 'lammps-dump');
  assert.ok(isPotentialStructurePath('relax/POSCAR'));
});
