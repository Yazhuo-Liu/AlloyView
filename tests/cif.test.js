import test from 'node:test';
import assert from 'node:assert/strict';
import { CIF_LIMITS, looksLikeCif, parseCif, parseCifAsync, parseCifSymmetryOperation } from '../src/io/cif.js';
import { determinant3 } from '../src/data/model.js';

const cell = `_cell_length_a 5.6402(1)
_cell_length_b 5.6402
_cell_length_c 5.6402
_cell_angle_alpha 90
_cell_angle_beta 90
_cell_angle_gamma 90`;
const siteHeader = `loop_
_atom_site_label
_atom_site_type_symbol
_atom_site_fract_x
_atom_site_fract_y
_atom_site_fract_z`;
const simple = `data_crystal\n${cell}\n${siteHeader}\nNa1 Na 0 0 0\nCl1 Cl .5 .5 .5\n`;
const property = (frame, name) => frame.properties.find(column => column.name === name)?.data;
const close = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const symmetryLoop = operations => `loop_\n_space_group_symop_id\n_space_group_symop_operation_xyz\n${operations.map((op, index) => `${index + 1} '${op}'`).join('\n')}\n`;

function cubicFaceCenteredOperations() {
  const permutations = ['xyz', 'xzy', 'yxz', 'yzx', 'zxy', 'zyx'];
  const translations = [[0, 0, 0], [0, 1, 1], [1, 0, 1], [1, 1, 0]];
  return translations.flatMap(translation => permutations.flatMap(permutation => Array.from({ length: 8 }, (_, sign) =>
    [...permutation].map((axis, index) => `${sign & (1 << index) ? '-' : ''}${axis}${translation[index] ? '+1/2' : ''}`).join(','))));
}

test('CIF expands the complete Fm-3m NaCl cell and collapses special positions per asymmetric site', () => {
  const operations = cubicFaceCenteredOperations();
  assert.equal(operations.length, 192);
  const frame = parseCif(simple.replace(siteHeader,
    `_space_group_name_H-M_alt 'F m -3 m'\n_space_group_IT_number 225\n${symmetryLoop(operations)}${siteHeader}`), 'NaCl.cif');
  assert.deepEqual(frame.typeLabels, ['Na', 'Cl']);
  assert.equal(frame.ids.length, 8);
  assert.deepEqual([...frame.summary.typeCounts], [4, 4]);
  assert.deepEqual([...property(frame, 'asymmetricSiteIndex')], [1, 1, 1, 1, 2, 2, 2, 2]);
  assert.deepEqual([...property(frame, 'occupancy')], Array(8).fill(1));
  assert.equal(frame.crystal.symmetryOperations.length, 192);
  assert.equal(frame.crystal.spaceGroup.number, 225);
  assert.equal(frame.crystal.asymmetricSiteCount, 2);
  assert.equal(frame.crystal.expandedAtomCount, 8);
  assert.equal(frame.crystal.symmetrySource, 'explicit');
  assert.equal(frame.title, 'NaCl.cif');
  const nearest = Math.min(...Array.from({ length: 4 }, (_, offset) => {
    let squared = 0;
    for (let axis = 0; axis < 3; axis++) {
      const delta = frame.fractional[(offset + 4) * 3 + axis] - frame.fractional[axis];
      squared += (delta - Math.round(delta)) ** 2;
    }
    return Math.sqrt(squared) * 5.6402;
  }));
  close(nearest, 2.8201);
});

test('CIF preserves double precision, uncertainty values and skew cells with case-insensitive dotted tags', () => {
  const text = simple.replaceAll('_cell_', '_CELL.').replace('5.6402(1)', '3.12345678901234(5)')
    .replace('_CELL.angle_gamma 90', '_CELL.angle_gamma 120')
    .replace('Na1 Na 0 0 0', 'Na1 Na 0.123456789012345(1) 2.34567890123456e-1 -0.345678901234567')
    .replaceAll('_atom_site_', '_Atom_Site.');
  const frame = parseCif(text);
  assert.ok(frame.fractional instanceof Float64Array);
  assert.ok(frame.positions instanceof Float64Array);
  assert.equal(frame.cell.vectors[0], 3.12345678901234);
  assert.deepEqual([...frame.fractional.slice(0, 3)], [0.123456789012345, 0.234567890123456, 1 - 0.345678901234567]);
  close(frame.cell.vectors[3], -2.8201);
  close(determinant3(frame.cell.vectors), 3.12345678901234 * 5.6402 ** 2 * Math.sin(Math.PI * 2 / 3));
  assert.equal(frame.summary.positions, frame.positions);
  assert.equal(frame.crystal.symmetrySource, 'P1');
});

test('P-1 name, Hall symbol or IT number expands general sites and retains inversion-center sites once', () => {
  for (const declaration of ["_space_group_name_H-M_alt 'P -1'", "_space_group_name_Hall '-P 1'", '_space_group_IT_number 2']) {
    const frame = parseCif(simple.replace(siteHeader, `${declaration}\n${siteHeader}`)
      .replace('Na1 Na 0 0 0', 'Na1 Na .1 .2 .3'));
    assert.equal(frame.ids.length, 3);
    assert.deepEqual([...frame.fractional.slice(0, 6)], [.1, .2, .3, .9, .8, .7]);
    assert.deepEqual([...property(frame, 'asymmetricSiteIndex')], [1, 1, 2]);
    assert.equal(frame.crystal.symmetrySource, 'P-1');
  }
});

test('safe affine symmetry parsing handles hexagonal axes and screw translations without evaluating code', () => {
  const operation = parseCifSymmetryOperation('-y, x-y, z+1/3');
  assert.deepEqual([...operation.rotation], [0, -1, 0, 1, -1, 0, 0, 0, 1]);
  assert.deepEqual([...operation.translation], [0, 0, 1 / 3]);
  const frame = parseCif(simple.replace(siteHeader, `${symmetryLoop(['x,y,z', '-y,x-y,z+1/3', '-x+y,-x,z+2/3'])}${siteHeader}`)
    .replace('Na1 Na 0 0 0', 'Na1 Na .1 .2 .3'));
  assert.equal(frame.ids.length, 6);
  const expected = [.1, .2, .3, .8, .9, .3 + 1 / 3, .1, .9, .3 + 2 / 3];
  expected.forEach((value, index) => close(frame.fractional[index], value));
  for (const invalid of ['x,y,globalThis.pwned=1', 'x,y,z;alert(1)', 'x,y,sin(z)', 'x,y,0', 'x,y,z+1/0', 'x,y,z++1', 'x/2,y,z', '999x,y,z', 'x,y']) {
    assert.throws(() => parseCifSymmetryOperation(invalid), /CIF:/);
  }
  assert.equal(globalThis.pwned, undefined);
});

test('duplicate symmetry images wrap at periodic boundaries without merging distinct disordered input sites', () => {
  const text = simple.replace(siteHeader, `${symmetryLoop(['x,y,z', '-x,-y,-z', 'x+1,y,z'])}${siteHeader}\n_atom_site_occupancy\n_atom_site_U_iso_or_equiv\n_atom_site_B_iso_or_equiv`)
    .replace('Na1 Na 0 0 0', 'Na1 Na 0 0 0 .5 .012(2) 0.947')
    .replace('Cl1 Cl .5 .5 .5', 'K1 K 0 0 0 .5 ? .');
  const frame = parseCif(text);
  assert.equal(frame.ids.length, 2);
  assert.equal(frame.crystal.symmetryOperations.length, 2);
  assert.deepEqual([...frame.positions], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...property(frame, 'occupancy')], [.5, .5]);
  assert.deepEqual([...property(frame, 'asymmetricSiteIndex')], [1, 2]);
  assert.deepEqual([...property(frame, 'Uiso')], [.012, NaN]);
  assert.deepEqual([...property(frame, 'Biso')], [.947, NaN]);
  assert.equal(frame.crystal.disordered, true);
  assert.deepEqual(frame.crystal.occupancySummary, { partial: 2, unknown: 0, zero: 0 });
  assert.match(frame.crystal.warnings[0], /count sites/);
});

test('unknown and zero occupancy retain sites and remain distinct from absent full occupancy', () => {
  const frame = parseCif(simple.replace(siteHeader, `${siteHeader}\n_atom_site_occupancy`)
    .replace('Na1 Na 0 0 0', 'Na1 Na 0 0 0 ?').replace('Cl1 Cl .5 .5 .5', 'Cl1 Cl .5 .5 .5 0'));
  assert.deepEqual([...property(frame, 'occupancy')], [NaN, 0]);
  assert.deepEqual(frame.crystal.occupancySummary, { partial: 0, unknown: 1, zero: 1 });
  assert.match(frame.crystal.warnings.join(' '), /not replaced with full occupancy/);
  assert.deepEqual([...property(parseCif(simple), 'occupancy')], [1, 1]);
  const disorder = parseCif(simple.replace(siteHeader, `${siteHeader}\n_atom_site_disorder_group`)
    .replace('Na1 Na 0 0 0', 'Na1 Na 0 0 0 1').replace('Cl1 Cl .5 .5 .5', 'Cl1 Cl .5 .5 .5 .'));
  assert.equal(disorder.crystal.disordered, true);
});

test('CIF Cartesian sites use the full skew inverse, chemical symbols and source labels', () => {
  const fractional = simple.replace('_cell_angle_gamma 90', '_cell_angle_gamma 120')
    .replace('Na1 Na 0 0 0', 'Na1 Na .12 .23 .34');
  const reference = parseCif(fractional);
  const text = fractional.replaceAll('_atom_site_fract_', '_atom_site_Cartn_')
    .replace('Na1 Na .12 .23 .34', `Na1 Na ${[...reference.positions.slice(0, 3)].join(' ')}`)
    .replace('Cl1 Cl .5 .5 .5', `Cl1 Cl ${[...reference.positions.slice(3, 6)].join(' ')}`);
  const frame = parseCif(text);
  frame.fractional.forEach((value, index) => close(value, reference.fractional[index]));
  frame.positions.forEach((value, index) => close(value, reference.positions[index]));
  const labelsOnly = parseCif(simple.replace('_atom_site_type_symbol\n', '').replace('Na1 Na ', 'Na1 ').replace('Cl1 Cl ', 'Cl1 '));
  assert.deepEqual(labelsOnly.typeLabels, ['Na', 'Cl']);
  assert.deepEqual(parseCif(simple.replace('Na1 Na ', 'Iron1 Fe3+ ')).typeLabels, ['Fe', 'Cl']);
});

test('CIF quotes, comments, semicolon fields and aliases preserve metadata and lexical boundaries', () => {
  const text = `\uFEFF# a comment mentions loop_ data_false\r\ndata_sample\r\n${cell}\n` +
    `_chemical_name_common\n;A title with #, 'quotes', and\ndata_inside\nloop_\n;\n` +
    `_chemical_formula_sum 'Na Cl'\n_unknown_tag 'don't split this'\n` +
    `${symmetryLoop(['x,y,z']).replace('_space_group_symop_operation_xyz', '_symmetry_equiv_pos_as_xyz')}${siteHeader}\n` +
    `'Na1' Na 0 0 0 # comment\n"Cl1" Cl .5 .5 .5\n`;
  assert.equal(looksLikeCif(text), true);
  const frame = parseCif(text);
  assert.equal(frame.ids.length, 2);
  assert.equal(frame.crystal.title, "A title with #, 'quotes', and\ndata_inside\nloop_");
  assert.equal(frame.crystal.formula, 'Na Cl');
  assert.deepEqual(frame.crystal.siteLabels, ['Na1', 'Cl1']);
  assert.equal(looksLikeCif('2\nXYZ comment\nFe 0 0 0'), false);
});

test('multiple CIF crystal blocks require explicit selection while metadata-only blocks are ignored', () => {
  const single = `data_publication\n_publ_title 'Two structures'\n${simple}`;
  assert.equal(parseCif(single).crystal.block, 'crystal');
  const two = single + simple.replace('data_crystal', 'data_second').replace('Na1 Na ', 'K1 K ');
  assert.throws(() => parseCif(two), /multiple crystal blocks/);
  assert.deepEqual(parseCif(two, 'multiple.cif', { block: 'SECOND' }).typeLabels, ['K', 'Cl']);
  assert.throws(() => parseCif(two, 'multiple.cif', { block: 'absent' }), /no crystal data block/);
});

test('missing nontrivial symmetry is rejected instead of silently showing only the asymmetric unit', () => {
  for (const declaration of ["_space_group_name_H-M_alt 'F m -3 m'", '_symmetry_Int_Tables_number 225', "_space_group_name_Hall '-F 4 2 3'"])
    assert.throws(() => parseCif(simple.replace(siteHeader, `${declaration}\n${siteHeader}`)), /needs explicit.*asymmetric unit/);
  assert.throws(() => parseCif(simple.replace(siteHeader, `_space_group_IT_number 1\n_space_group_name_H-M_alt 'P -1'\n${siteHeader}`)), /needs explicit/);
  assert.throws(() => parseCif(simple.replace(siteHeader, `${symmetryLoop(['-x,-y,-z'])}${siteHeader}`)), /identity operation/);
});

test('CIF rejects malformed data and geometry without returning partial atoms', () => {
  const corruptions = [
    [simple.replace('Cl1 Cl .5 .5 .5', 'Cl1 Cl .5 .5'), /complete a row/],
    [simple.replace('_cell_length_b', '_cell_length_a'), /duplicate data name/],
    [simple.replace('_cell_length_a 5.6402(1)', '_cell_length_a ?'), /missing/],
    [simple.replace('_cell_length_b 5.6402', '_cell_length_b -1'), /lengths must be positive/],
    [simple.replace('_cell_angle_gamma 90', '_cell_angle_gamma 180'), /angles must lie/],
    [simple.replace('_cell_angle_alpha 90', '_cell_angle_alpha 170').replace('_cell_angle_beta 90', '_cell_angle_beta 10'), /nonsingular/],
    [simple.replace('Na1 Na 0 0 0', 'Na1 Na NaN 0 0'), /finite number/],
    [simple.replace('Na1 Na 0 0 0', 'Na1 Na ? 0 0'), /missing/],
    [simple.replace('Na1 Na 0 0 0', 'Na1 Xx 0 0 0'), /identify an element/],
    [simple.replace('Na1 Na 0 0 0', "'unterminated Na 0 0 0"), /quoted values cannot cross/],
    [simple + '_title\n;never closed', /unterminated semicolon/],
    [simple.replace('_atom_site_fract_z', '_unused'), /all three/],
    [simple.replace('_cell_length_a 5.6402(1)', '_cell_length_a 1e309'), /finite number/],
    [simple.replace('Na1 Na 0 0 0', 'Na1 Na 1e20 0 0'), /coordinate magnitude/],
  ];
  for (const [input, pattern] of corruptions) assert.throws(() => parseCif(input), pattern);
  assert.throws(() => parseCif(simple.replace(siteHeader, `${siteHeader}\n_atom_site_occupancy`)
    .replace('Na1 Na 0 0 0', 'Na1 Na 0 0 0 1.1').replace('Cl1 Cl .5 .5 .5', 'Cl1 Cl .5 .5 .5 1')), /between 0 and 1/);
});

test('CIF budgets stop excessive symmetry and expanded allocations before emitting a truncated cell', () => {
  const operations = Array.from({ length: CIF_LIMITS.symmetryOperations }, (_, index) => `x+${index}/${CIF_LIMITS.symmetryOperations},y,z`);
  assert.throws(() => parseCif(simple.replace(siteHeader, `${symmetryLoop([...operations, 'x+1/777,y,z'])}${siteHeader}`)), /symmetry operations must contain/);
  const sites = Math.floor(CIF_LIMITS.expandedAtoms / operations.length) + 1;
  const input = `data_large\n${cell}\n${symmetryLoop(operations)}${siteHeader}\n` +
    Array.from({ length: sites }, (_, index) => `Na${index} Na 0 0 0`).join('\n');
  assert.throws(() => parseCif(input), /expansion exceeds/);
});

test('CIF async parsing shares scientific results and cooperatively cancels long comments and symmetry-bearing input', async () => {
  const reference = parseCif(simple), asyncFrame = await parseCifAsync(simple, 'structure.cif', { budgetMs: 0 });
  for (const key of ['positions', 'fractional', 'properties', 'crystal', 'types', 'ids']) assert.deepEqual(asyncFrame[key], reference[key]);
  const abort = new AbortController();
  let yields = 0;
  await assert.rejects(parseCifAsync(`#${'c'.repeat(50_000)}\n${simple}`, 'long.cif', {
    signal: abort.signal, budgetMs: 0, yieldControl: async () => { if (++yields === 3) abort.abort(); },
  }), { name: 'AbortError' });
  assert.equal(yields, 3);
  const controller = new AbortController();
  // Cancellation also stays available past the initial lexical checkpoints.
  let ticks = 0;
  const input = simple.replace(siteHeader, `${symmetryLoop(cubicFaceCenteredOperations())}${siteHeader}`);
  await assert.rejects(parseCifAsync(input, 'expanded.cif', { signal: controller.signal, budgetMs: 0,
    yieldControl: async () => { if (++ticks === 7) controller.abort(); },
  }), { name: 'AbortError' });
  assert.equal(ticks, 7);
});
