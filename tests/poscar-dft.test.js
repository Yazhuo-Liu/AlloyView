import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikePoscar, MAX_POSCAR_ATOMS, parsePoscar, parsePoscarAsync } from '../src/io/poscar.js';
import { determinant3 } from '../src/data/model.js';
import { ELEMENT_SYMBOLS, isElementSymbol } from '../src/data/chemical-elements.js';

const input = `precise relaxed crystal
1
3.123456789012345 0.123456789012345 0
0.5 4.012345678901234 0.2
0.2 0.4 5.012345678901234
Fe_pv O
1 1
Selective dynamics
Direct
0.123456789012345 0.234567890123456 0.345678901234567 T F T
1.125 -0.125 0.625 F F T
`;

test('POSCAR keeps DFT fractional and Cartesian precision, images and selective flags', () => {
  const frame = parsePoscar(input);
  assert.ok(frame.fractional instanceof Float64Array);
  assert.ok(frame.positions instanceof Float64Array);
  assert.deepEqual([...frame.fractional], [0.123456789012345, 0.234567890123456, 0.345678901234567, 0.125, 0.875, 0.625]);
  assert.deepEqual([...frame.imageFlags], [0, 0, 0, 1, -1, 0]);
  assert.deepEqual(frame.typeLabels, ['Fe', 'O']);
  const h = frame.cell.vectors, f = frame.fractional;
  assert.equal(frame.positions[0], f[0] * h[0] + f[1] * h[3] + f[2] * h[6]);
  assert.equal(frame.unwrappedPositions[3], 1.125 * h[0] - 0.125 * h[3] + 0.625 * h[6]);
  assert.equal(frame.summary.positions, frame.positions);
  assert.deepEqual([...frame.summary.typeCounts], [1, 1]);
  assert.deepEqual([...frame.properties.find(property => property.name === 'selectiveDynamicsY').data], [0, 0]);
});

test('POSCAR accepts inline comments and Fortran exponents in detection and parsing', () => {
  const text = input.replace('\n1\n', '\n1D+0 ! universal scale factor\n')
    .replace('0.5 4.012', '5d-1 4.012').replace('0.2\n0.2', '0.2 ! b vector\n0.2')
    .replace('Fe_pv O\n', 'Fe_pv O ! potentials\n').replace('1 1\n', '1 1 ! counts\n')
    .replace('0.123456789012345 0.234', '1.23456789012345D-1 0.234')
    .replace('T F T\n', 'T F T ! Fe site\n');
  assert.equal(looksLikePoscar(text), true);
  const frame = parsePoscar(text), reference = parsePoscar(input);
  assert.deepEqual(frame.fractional, reference.fractional);
  assert.deepEqual(frame.cell.vectors, reference.cell.vectors);
});

test('POSCAR scales Cartesian axes of both tilted lattice and positions, and negative volume keeps handedness', () => {
  const cartesian = input.replace('\n1\n', '\n2 3 4\n').replace('\nDirect\n', '\nCartesian\n');
  const frame = parsePoscar(cartesian), source = parsePoscar(input);
  source.cell.vectors.forEach((value, index) => assert.equal(frame.cell.vectors[index], value * [2, 3, 4][index % 3]));
  // The first Cartesian position is in the cell and reconstructs to source precision.
  [0.123456789012345 * 2, 0.234567890123456 * 3, 0.345678901234567 * 4].forEach((value, index) => {
    assert.ok(Math.abs(frame.positions[index] - value) < 3e-15);
  });
  const negative = parsePoscar(input.replace('\n1\n', '\n-250\n').replace('3.123456789012345', '-3.123456789012345'));
  assert.ok(Math.abs(determinant3(negative.cell.vectors) + 250) < 1e-12);
});

test('POSCAR uses real element symbols only and retains unknown potential labels without inventing identities', () => {
  assert.equal(ELEMENT_SYMBOLS.length, 118);
  assert.equal(new Set(ELEMENT_SYMBOLS).size, 118);
  assert.equal(isElementSymbol('Og'), true);
  assert.equal(isElementSymbol('Xx'), false);
  assert.equal(isElementSymbol('fe'), false);
  assert.deepEqual(parsePoscar(input.replace('Fe_pv O', 'Xx_pv Unknown')).typeLabels, ['Xx_pv', 'Unknown']);
  const vasp4 = input.replace('precise relaxed crystal', 'Xx Qq').replace('Fe_pv O\n', '');
  assert.deepEqual(parsePoscar(vasp4).typeLabels, ['Type 1', 'Type 2']);
});

test('POSCAR rejects corrupt counts, overflowing coordinates and malformed selective flags before returning data', () => {
  for (const counts of ['9007199254740993 1', `${MAX_POSCAR_ATOMS} 1`]) {
    assert.throws(() => parsePoscar(input.replace('1 1\n', `${counts}\n`)), /must not exceed/);
  }
  assert.throws(() => parsePoscar(input.replace('1 1\n', '100 1\n')), /fewer coordinate rows/);
  assert.throws(() => parsePoscar(input.replace('T F T', 'T maybe T')), /flags must be T or F/);
  assert.throws(() => parsePoscar(input.replace('0.123456789012345 0.234', '0x10 0.234')), /not a finite number/);
  assert.throws(() => parsePoscar(input.replace('\n1\n', '\n1e308\n')), /finite non-zero volume/);
  assert.throws(() => parsePoscar(input.replace('1.125 -0.125', '2147483648 -0.125')), /32-bit range/);
});

test('POSCAR async parsing shares precision and error semantics and cooperatively cancels', async () => {
  const direct = parsePoscar(input), asyncFrame = await parsePoscarAsync(input, 'POSCAR', { budgetMs: 0 });
  assert.deepEqual(asyncFrame.fractional, direct.fractional);
  assert.deepEqual(asyncFrame.positions, direct.positions);
  const abort = new AbortController();
  let yields = 0;
  await assert.rejects(parsePoscarAsync(input, 'POSCAR', { signal: abort.signal, budgetMs: 0,
    yieldControl: async () => { yields++; abort.abort(); } }), { name: 'AbortError' });
  assert.equal(yields, 1);
});
