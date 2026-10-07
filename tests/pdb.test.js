import assert from 'node:assert/strict';
import test from 'node:test';
import { determinant3 } from '../src/data/model.js';
import { indexPdb, parsePdbFrame, readPdbFrame } from '../src/io/pdb.js';

function atom({ id = 1, name = ' CA ', element = 'C', position = [1, 2, 3], alt = ' ', occupancy = 1, bfactor = 12.5, record = 'ATOM' } = {}) {
  return `${record.padEnd(6)}${String(id).padStart(5)} ${name.padEnd(4)}${alt}ALA A   1    ${position.map((value) => value.toFixed(3).padStart(8)).join('')}${occupancy.toFixed(2).padStart(6)}${bfactor.toFixed(2).padStart(6)}          ${element.padStart(2)}  `;
}

function crystal(a = 4, b = 5, c = 6, alpha = 90, beta = 90, gamma = 60) {
  return `CRYST1${[a, b, c].map((value) => value.toFixed(3).padStart(9)).join('')}${[alpha, beta, gamma].map((value) => value.toFixed(2).padStart(7)).join('')} P 1           1`;
}

test('PDB parses primary conformers, stable serials, species and atom scalars', () => {
  const frame = parsePdbFrame([atom({ id: 9, element: '', name: ' CA ' }), atom({ id: 10, name: 'CA  ', element: '', record: 'HETATM', alt: 'A' }), atom({ id: 11, alt: 'B' })].join('\n'));
  assert.equal(frame.ids.length, 2);
  assert.deepEqual([...frame.ids], [9, 10]);
  assert.equal(frame.idSource, 'explicit');
  assert.deepEqual(frame.typeLabels, ['C', 'Ca']);
  assert.deepEqual(frame.cell.pbc, [false, false, false]);
  assert.deepEqual(frame.properties.map((property) => property.name), ['occupancy', 'bfactor']);
  assert.equal(frame.properties[1].data[0], 12.5);
});

test('PDB CRYST1 reconstructs skew lattice vectors and periodicity', () => {
  const frame = parsePdbFrame(`${crystal()}\n${atom()}\nEND\n`);
  const h = frame.cell.vectors;
  assert.equal(h[0], 4);
  assert.ok(Math.abs(h[3] - 2.5) < 1e-10);
  assert.ok(Math.abs(h[4] - 5 * Math.sqrt(3) / 2) < 1e-10);
  assert.ok(Math.abs(h[8] - 6) < 1e-10);
  assert.deepEqual(frame.cell.pbc, [true, true, true]);
  assert.equal(frame.cell.triclinic, true);
  assert.ok(determinant3(h) > 0);
});

test('PDB MODEL trajectories retain global cell metadata through byte-indexed frame reads', async () => {
  const blob = new Blob([`${crystal()}\r\nTITLE     测试 structure\r\nMODEL        1\r\n${atom()}\r\nENDMDL\r\nMODEL        2\r\n${atom({ position: [2, 3, 4] })}\r\nENDMDL\r\nEND`]);
  const indexed = await indexPdb(blob, () => {}, { chunkSize: 11 });
  assert.equal(indexed.frames.length, 2);
  const frame = await readPdbFrame(blob, indexed, 1, 'models.pdb');
  assert.equal(frame.timestep, 2);
  assert.equal(frame.frameIndex, 1);
  assert.equal(frame.cell.triclinic, true);
  assert.equal(frame.pdbTitle, '测试 structure');
  assert.equal(frame.title, 'models.pdb');
  frame.positions.forEach((value, index) => assert.ok(Math.abs(value - [2, 3, 4][index]) < 1e-5));
  await assert.rejects(readPdbFrame(blob, indexed, -1), /outside/);
});

test('PDB rejects duplicate serials, invalid cells and malformed model blocks', async () => {
  assert.throws(() => parsePdbFrame(`${atom()}\n${atom()}`), /more than once/);
  assert.throws(() => parsePdbFrame(`${crystal(4, 5, 6, 10, 10, 170)}\n${atom()}`), /nonzero-volume/);
  assert.throws(() => parsePdbFrame(atom({ id: 'A0001' })), /Hybrid-36/);
  await assert.rejects(indexPdb(new Blob([`MODEL        1\n${atom()}\n`])), /missing ENDMDL/);
  await assert.rejects(indexPdb(new Blob([`MODEL        1\nENDMDL\n`])), /no atom/);
  await assert.rejects(indexPdb(new Blob([`ENDMDL\n${atom()}`])), /no preceding/);
  // Record names are the trimmed first six characters of each line's text.
  for (const chunkSize of [3, 4096]) {
    const index = text => indexPdb(new Blob([text]), () => {}, { chunkSize });
    assert.deepEqual((await index('MODEL 1\n\u00a0ATOM\nENDMDL\n')).frames.map(frame => [frame.start, frame.end]), [[0, 22]]);
    assert.equal((await index(` MODEL 1\n${atom()}\nENDMDL\t\r\n`)).frames[0].end, 19 + atom().length);
    await assert.rejects(index('MODEL 1\nATOMé\nENDMDL\n'), /no atom/);
    await assert.rejects(index(`MODEL 1\n${atom()}\n ENDMDL\n`), /missing ENDMDL/);
  }
});

test('PDB model indexes snapshot preceding CRYST1 metadata instead of applying a later cell', async () => {
  const blob = new Blob([`${crystal(4)}\nMODEL        1\n${atom()}\nENDMDL\n${crystal(8)}\nMODEL        2\n${atom()}\nENDMDL\n`]);
  const indexed = await indexPdb(blob);
  assert.equal((await readPdbFrame(blob, indexed, 0)).cell.vectors[0], 4);
  assert.equal((await readPdbFrame(blob, indexed, 1)).cell.vectors[0], 8);
});
