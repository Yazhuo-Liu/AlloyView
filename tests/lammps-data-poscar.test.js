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

const labeledMasses = `title
2 atoms
2 atom types
1 bonds
1 bond types
0 4 xlo xhi
0 4 ylo yhi
0 4 zlo zhi

Atom Type Labels

1 Fe
2 C

Masses

Fe 55.845
2 12.011

PairIJ Coeffs

Fe Fe 0.1 2
Fe C 0.2 3
C C 0.3 4

Atoms # molecular

7 1 C 1 1 1
9 1 Fe 2 2 2

Bonds

1 1 7 9

Velocities

9 0.2 0 0
7 0.1 0 0
`;

test('LAMMPS data preserves labeled mass rows and skips coefficient and topology sections', () => {
  const frame = parseLammpsData(labeledMasses);
  assert.deepEqual(frame.typeLabels, ['Fe', 'C']);
  assert.deepEqual([...frame.types], [1, 0]);
  near(frame.properties.find(entry => entry.name === 'mass').data, [12.011, 55.845], 1e-4);
  near(frame.properties.find(entry => entry.name === 'vx').data, [0.1, 0.2]);
  const allLabels = parseLammpsData(labeledMasses.replace('2 12.011', 'C 12.011'));
  near(allLabels.properties.find(entry => entry.name === 'mass').data, [12.011, 55.845], 1e-4);
});

test('LAMMPS data reports unknown mass labels instead of silently discarding their rows', () => {
  assert.throws(() => parseLammpsData(labeledMasses.replace('Fe 55.845', 'Zn 55.845')), /unknown atom type label “Zn”/);
  for (const mass of ['NaN', 'Infinity', '12bad', 'bad']) {
    assert.throws(() => parseLammpsData(labeledMasses.replace('Fe 55.845', `Fe ${mass}`)), /mass is not a finite number/);
  }
  assert.throws(() => parseLammpsData(`${labeledMasses}\nMasses\n\n1 55.845\n`), /Masses section appears twice/);
});

test('LAMMPS data skips CMAP and custom fix sections without consuming atom or mass rows', () => {
  const atoms = Array.from({ length: 5 }, (_, index) => `${index + 1} 1 ${index} 0 0`).join('\n');
  const cmap = `title\n5 atoms\n1 atom types\n0 10 xlo xhi\n0 10 ylo yhi\n0 10 zlo zhi\n\nAtoms # atomic\n\n${atoms}\n\nCMAP\n\n1 1 1 2 3 4 5\n`;
  assert.equal(parseLammpsData(cmap).ids.length, 5);
  for (const nextSection of ['PairIJ Coeffs', 'Bonds', null]) {
    const extension = '\nMy Custom Section\n\n1 2 3\n';
    const text = nextSection ? labeledMasses.replace(`\n${nextSection}\n`, `${extension}\n${nextSection}\n`) : labeledMasses + extension;
    const frame = parseLammpsData(text);
    assert.deepEqual([...frame.ids], [7, 9]);
    near(frame.properties.find(entry => entry.name === 'mass').data, [12.011, 55.845], 1e-4);
    near(frame.properties.find(entry => entry.name === 'vx').data, [0.1, 0.2]);
  }
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

test('LAMMPS data rejects duplicate velocity IDs while allowing reordered complete rows', () => {
  assert.throws(() => parseLammpsData(writeData.replace('3 0.5 0 0', '1 0.5 0 0')), /duplicate velocity for atom ID 1/);
  const velocities = parseLammpsData(writeData).properties.find(property => property.name === 'vx').data;
  near(velocities, [0.1, 0.2, 0.5, 0.4]);
});

test('LAMMPS data validates image ranges before storage and after out-of-cell normalization', () => {
  const single = (x, image) => `title\n1 atoms\n1 atom types\n0 10 xlo xhi\n0 10 ylo yhi\n0 10 zlo zhi\n\nAtoms # atomic\n\n1 1 ${x} 0 0 ${image} 0 0\n`;
  for (const image of [-2_147_483_649, 2_147_483_648]) {
    assert.throws(() => parseLammpsData(single(1, image)), /image flag.*32-bit range/);
  }
  for (const [x, image] of [[11, 2_147_483_647], [-1, -2_147_483_648]]) {
    assert.throws(() => parseLammpsData(single(x, image)), /image flag.*32-bit range/);
  }
  for (const [x, image, expected] of [[1, -2_147_483_648, -2_147_483_648], [1, 2_147_483_647, 2_147_483_647], [11, 2_147_483_646, 2_147_483_647], [-1, -2_147_483_647, -2_147_483_648]]) {
    const frame = parseLammpsData(single(x, image));
    assert.equal(frame.imageFlags[0], expected);
    assert.equal(frame.unwrappedPositions[0], x + 10 * image);
    assert.ok(Math.abs(frame.positions[0] + 10 * expected - frame.unwrappedPositions[0]) < 1e-5);
  }
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

test('numeric POSCAR titles retain VASP 4/5 and coordinate-mode detection', () => {
  for (const title of ['123', '1']) {
    for (const species of ['Au Cu_pv\n', '']) {
      for (const mode of ['Direct', 'Cartesian', 'K', 'selective dynamics\ndirect', 'Selective dynamics\nK']) {
        const text = cu3au.replace('Cu3Au L12', title).replace('Au Cu_pv\n', species).replace('Direct', mode);
        const withFlags = /^selective/i.test(mode) ? text.replace(/^(0(?:\.5)?(?: 0(?:\.5)?){2})$/gm, '$1 T T T') : text;
        assert.equal(detectStructureFormatHeader(withFlags), 'poscar', `${title}, ${species}, ${mode}`);
        assert.equal(parsePoscar(withFlags, 'POSCAR').ids.length, 4);
      }
    }
  }
});
