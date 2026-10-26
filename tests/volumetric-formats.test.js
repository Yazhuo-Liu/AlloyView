import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCube, parseCubeAsync, parseVaspVolume, parseVaspVolumeAsync,
  looksLikeCube, looksLikeVaspVolume, inferVaspVolumeKind, BOHR_ANGSTROM } from '../src/io/volumetric.js';
import { validateVolumetricDataset, volumetricCellDimensions, volumetricGridPosition, VOLUMETRIC_LIMITS } from '../src/data/volumetric-grid.js';

const close = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
function cube({ dimensions = [2, 2, 3], angstrom = true, atoms = 1, nval = '', orbital = '',
  origin = [0, 0, 0], steps = [1, 0, 0, 0, 1, 0, 0, 0, 1], values } = {}) {
  return ['Synthetic scalar fixture', 'x outer, z inner; no physical quantity implied',
    `${atoms} ${origin.join(' ')}${nval ? ` ${nval}` : ''}`,
    ...dimensions.map((count, axis) => `${angstrom ? -count : count} ${steps.slice(axis * 3, axis * 3 + 3).join(' ')}`),
    '8 6.0 0.25 0.5 0.75', ...(orbital ? [orbital] : []),
    (values ?? Array.from({ length: dimensions[0] }, (_, x) => Array.from({ length: dimensions[1] }, (_, y) => Array.from({ length: dimensions[2] }, (_, z) => x + 10 * y + 100 * z))).flat(2)).join(' '), ''].join('\n');
}
const poscar = ['Synthetic VASP grid fixture', '1', '2 0 0', '0 3 0', '0 0 4', 'H', '1', 'Direct', '.25 .5 .75', ''].join('\n');
function vasp(fields = [Array.from({ length: 8 }, (_, index) => 24 * (index + 1))], { dimensions = [2, 2, 2], augmentation = '' } = {}) {
  return poscar + fields.map(values => `\n${dimensions.join(' ')}\n${values.join(' ')}\n${augmentation}`).join('');
}

test('Cube coordinates honor units, scalar samples reorder from z-fastest to x-fastest, and open quadrature preserves a linear field', () => {
  const text = cube(), frame = parseCube(text, 'density.cube'), grid = frame.volumetric.datasets[0];
  assert.equal(looksLikeCube(text), true); assert.equal(looksLikeVaspVolume(text), false);
  assert.deepEqual(frame.typeLabels, ['O']); assert.equal(frame.sourceFormat, 'cube');
  assert.ok(frame.positions instanceof Float64Array); assert.deepEqual([...frame.positions], [.25, .5, .75]);
  assert.deepEqual(grid.dimensions, [2, 2, 3]); assert.deepEqual(grid.periodic, [false, false, false]);
  assert.deepEqual([...grid.values], [0, 1, 10, 11, 100, 101, 110, 111, 200, 201, 210, 211]);
  assert.equal(grid.unit, 'file units'); assert.equal(grid.kind, 'unknown');
  assert.deepEqual(volumetricCellDimensions(grid), [1, 1, 2]);
  close(grid.statistics.mean, 105.5); close(grid.statistics.integral, 211);
  assert.deepEqual([...volumetricGridPosition(grid, 1, 1, 2)], [1, 1, 2]);
  assert.match(frame.volumetric.warnings[0], /scalar values/);
  const atomicUnits = parseCube(cube({ angstrom: false, origin: [1, 2, 3] }));
  atomicUnits.positions.forEach((value, index) => close(value, [.25, .5, .75][index] * BOHR_ANGSTROM));
  assert.deepEqual([...atomicUnits.volumetric.datasets[0].origin], [1, 2, 3].map(value => value * BOHR_ANGSTROM));
  close(atomicUnits.volumetric.datasets[0].statistics.integral, 211 * BOHR_ANGSTROM ** 3);
});

test('Cube tilted grids retain their actual basis/origin without wrapping open atoms', () => {
  const frame = parseCube(cube({ origin: [2, -1, 3], steps: [2, 0, 0, .5, 3, 0, -.2, .6, 4] }));
  const grid = frame.volumetric.datasets[0];
  assert.deepEqual([...volumetricGridPosition(grid, 1, 1, 2)], [4.1, 3.2, 11]);
  assert.deepEqual(frame.cell.pbc, [false, false, false]);
  close(grid.statistics.voxelVolume, 24); close(grid.statistics.integral, 211 * 24);
  assert.deepEqual([...frame.positions], [.25, .5, .75]);
});

test('Cube detection rejects numeric XYZ rows, singular grid bases and mixed unit signs', () => {
  const xyz = '5\n1\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\n5 1 1 1\n';
  assert.equal(looksLikeCube(xyz), false);
  assert.equal(looksLikeCube(cube({ steps: [1, 0, 0, 1, 0, 0, 0, 0, 1] })), false);
  assert.equal(looksLikeCube(cube().replace('-2 0 1 0', '2 0 1 0')), false);
});

test('Cube positive NVAL and negative-atom orbital channels preserve every interleaved field and orbital ID', () => {
  const values = Array.from({ length: 8 }, (_, index) => [index, -index]).flat();
  for (const options of [{ nval: '2' }, { atoms: -1, orbital: '2 4\n9' }]) {
    const frame = parseCube(cube({ ...options, dimensions: [2, 2, 2], values }));
    const [first, second] = frame.volumetric.datasets;
    assert.equal(frame.volumetric.datasets.length, 2);
    assert.deepEqual([...first.values], [0, 4, 2, 6, 1, 5, 3, 7]);
    assert.deepEqual([...second.values], [0, 4, 2, 6, 1, 5, 3, 7].map(value => value ? -value : 0));
    if (options.orbital) { assert.equal(first.orbitalId, 4); assert.equal(second.orbitalId, 9); assert.equal(second.name, 'Orbital 9'); }
  }
});

test('CHGCAR samples divide by cell volume, preserve x-fastest order, and integrate to electron count', () => {
  const text = vasp(), frame = parseVaspVolume(text, 'CHGCAR'), grid = frame.volumetric.datasets[0];
  assert.equal(looksLikeVaspVolume(text), true); assert.equal(looksLikeVaspVolume(poscar), false);
  assert.equal(frame.sourceFormat, 'vasp-volume'); assert.deepEqual(frame.typeLabels, ['H']);
  assert.deepEqual(grid.dimensions, [2, 2, 2]); assert.deepEqual(volumetricCellDimensions(grid), [2, 2, 2]);
  assert.deepEqual([...grid.values], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...grid.steps], [1, 0, 0, 0, 1.5, 0, 0, 0, 2]);
  assert.equal(grid.unit, 'e/Å³'); assert.equal(grid.statistics.integralUnit, 'e');
  close(grid.statistics.integral, 108); close(grid.statistics.mean, 4.5);
  assert.equal(grid.statistics.integral, grid.values.reduce((sum, value) => sum + value, 0) * 3);
});

test('LOCPOT and ELFCAR retain their units/raw numbers; unnamed grids cannot silently become electron density', () => {
  const text = vasp();
  for (const [name, kind, unit] of [['LOCPOT', 'potential', 'eV'], ['ELFCAR.gz', 'elf', ''], ['renamed.vasp', 'unknown', 'file units']]) {
    const frame = parseVaspVolume(text, name), grid = frame.volumetric.datasets[0];
    assert.equal(grid.kind, kind); assert.equal(grid.unit, unit); close(grid.values[0], 24);
    assert.equal(inferVaspVolumeKind(name), kind);
    if (kind === 'unknown') assert.match(frame.volumetric.warnings[0], /normalization has not been applied/);
  }
  assert.equal(parseVaspVolume(text, 'renamed.vasp', { kind: 'charge-density' }).volumetric.datasets[0].values[0], 1);
  assert.equal(inferVaspVolumeKind('/path/Fe_CHGCAR.relaxed'), 'charge-density');
  assert.equal(inferVaspVolumeKind('CHGCARROT'), 'unknown');
});

test('VASP PAW augmentation arrays are skipped by exact count, never interpreted as spin-grid dimensions', () => {
  const augmentation = 'augmentation occupancies 1 3\n2 2 2\n';
  const text = vasp([new Array(8).fill(48), new Array(8).fill(-24)], { augmentation });
  const frame = parseVaspVolume(text, 'CHGCAR');
  assert.equal(frame.volumetric.datasets.length, 2);
  const [charge, magnetization] = frame.volumetric.datasets;
  assert.equal(charge.name, 'Electron density'); assert.equal(magnetization.name, 'Magnetization density');
  assert.ok(charge.values.every(value => value === 2)); assert.ok(magnetization.values.every(value => value === -1));
  close(charge.statistics.integral, 48); close(magnetization.statistics.integral, -24);
  const noncollinear = parseVaspVolume(vasp([0, 1, 2, 3].map(value => new Array(8).fill(24 * value))), 'CHGCAR');
  assert.deepEqual(noncollinear.volumetric.datasets.map(grid => grid.name), ['Electron density', 'Magnetization X', 'Magnetization Y', 'Magnetization Z']);
});

test('VASP scaling and tilted cells feed normalized grids through the complete POSCAR reader', () => {
  const text = vasp().replace('\n1\n2 0 0\n0 3 0\n0 0 4', '\n2\n2 0 0\n.5 3 0\n.2 .4 4');
  const frame = parseVaspVolume(text, 'CHGCAR'), grid = frame.volumetric.datasets[0];
  assert.deepEqual([...grid.steps], [2, 0, 0, .5, 3, 0, .2, .4, 4]);
  close(grid.values[0], 1 / 8); close(grid.statistics.integral, 108);
  const commented = vasp().replace('\n1\nDirect', '\n1 ! hydrogen atom\nDirect');
  assert.deepEqual(parseVaspVolume(commented, 'CHGCAR').volumetric.datasets[0].values,
    parseVaspVolume(vasp(), 'CHGCAR').volumetric.datasets[0].values);
  const fixedVolume = parseVaspVolume(vasp().replace('\n1\n2 0 0', '\n-48\n2 0 0'), 'CHGCAR');
  close(fixedVolume.volumetric.datasets[0].values[0], .5);
  close(fixedVolume.volumetric.datasets[0].statistics.integral, 108);
});

test('resource limits and damaged arrays fail before exposing partial or guessed volume data', () => {
  const base = cube();
  for (const [text, pattern] of [
    [base.replace('-2 0 1 0', '2 0 1 0'), /consistent/],
    [base.replace('0 100 200', '0 Infinity 200'), /finite/],
    [base.trim().split(/\s+/).slice(0, -1).join(' '), /header/],
    [cube({ atoms: 0 }), /at least one/],
    [cube({ dimensions: [VOLUMETRIC_LIMITS.samplesPerDataset + 1, 2, 2], values: [1] }), /limited/],
    [cube({ nval: '65' }), /combined/],
    [cube({ atoms: -1, orbital: '2 4 4' }), /unique/],
  ]) assert.throws(() => parseCube(text), pattern);
  assert.throws(() => parseVaspVolume(vasp([[1, 2]]), 'CHGCAR'), /incomplete/);
  assert.throws(() => parseVaspVolume(vasp([[1, 2, 3, 4, 5, 6, 7, 8, 9]]), 'CHGCAR'), /more values/);
  assert.throws(() => parseVaspVolume(vasp() + '\n1 2 3\n', 'CHGCAR'), /same grid/);
  assert.throws(() => parseVaspVolume(vasp() + '\naugmentation occupancies 99 1\n0', 'CHGCAR'), /augmentation/);
  assert.throws(() => parseVaspVolume(vasp([0, 1, 2].map(value => new Array(8).fill(value))), 'CHGCAR'), /one scalar/);
  assert.throws(() => parseCube(cube({ dimensions: [2, 2, 2], values: [1, 2] })), /incomplete/);
  assert.throws(() => parseCube(cube({ dimensions: [2, 2, 2], values: Array(9).fill(1) })), /more values/);
  const fortran = parseCube(cube({ dimensions: [2, 2, 2], values: Array(8).fill('1.25D+01') }));
  assert.ok(fortran.volumetric.datasets[0].values.every(value => value === 12.5));
});

test('shared grid validation distinguishes periodic voxels from open samples without scanning on the UI', () => {
  const grid = parseCube(cube({ dimensions: [1, 2, 2] })).volumetric.datasets[0];
  assert.deepEqual(volumetricCellDimensions(grid), [0, 1, 1]);
  assert.equal(grid.statistics.integral, 0);
  const malformed = { ...grid, values: grid.values.slice() }; malformed.values[0] = NaN;
  assert.equal(validateVolumetricDataset(malformed), malformed);
  assert.throws(() => validateVolumetricDataset(malformed, { scanValues: true }), /finite/);
  assert.throws(() => validateVolumetricDataset({ ...grid, periodic: [1, 1, 1] }), /flags/);
  assert.throws(() => validateVolumetricDataset({ ...grid, dimensions: [2, 2, 2] }), /sample count/);
});

test('asynchronous VASP/Cube parsing matches synchronous scientific data and cooperates with cancellation', async () => {
  for (const [parse, asyncParse, text, name] of [[parseCube, parseCubeAsync, cube(), 'test.cube'],
    [parseVaspVolume, parseVaspVolumeAsync, vasp(), 'CHGCAR']]) {
    const synchronous = parse(text, name), asynchronous = await asyncParse(text, name, { budgetMs: 0 });
    assert.deepEqual(asynchronous.positions, synchronous.positions);
    assert.deepEqual(asynchronous.volumetric, synchronous.volumetric);
    const controller = new AbortController(); let yielded = 0;
    await assert.rejects(asyncParse(text, name, { signal: controller.signal, budgetMs: 0,
      yieldControl: async () => { if (++yielded === 2) controller.abort(); } }), { name: 'AbortError' });
    assert.equal(yielded, 2);
  }
});

test('one-line grid data yields during numeric parsing and can cancel before its complete array is consumed', async () => {
  const text = cube({ dimensions: [17, 17, 17], values: Array(17 ** 3).fill(1) });
  const controller = new AbortController(); let yields = 0;
  await assert.rejects(parseCubeAsync(text, 'single-line.cube', { budgetMs: 0, signal: controller.signal,
    yieldControl: async () => { if (++yields === 4) controller.abort(); } }), { name: 'AbortError' });
  assert.equal(yields, 4);
});
