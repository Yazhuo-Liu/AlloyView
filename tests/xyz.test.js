import assert from 'node:assert/strict';
import test from 'node:test';
import { cartesianToFractional, fractionalToCartesian } from '../src/data/model.js';
import { indexXyz, parseXyzFrame, readXyzFrame } from '../src/io/xyz.js';

test('plain XYZ preserves Cartesian molecule positions and infers a nonsingular free cell', () => {
  const frame = parseXyzFrame('3\nwater\nO -1 0 0\nH 0 0 0\n1 0 1 0\n');
  assert.deepEqual(frame.typeLabels, ['O', 'H']);
  assert.deepEqual([...frame.types], [0, 1, 1]);
  assert.deepEqual([...frame.positions], [-1, 0, 0, 0, 0, 0, 0, 1, 0]);
  assert.deepEqual(frame.cell.pbc, [false, false, false]);
  assert.equal(frame.idSource, 'row-order');
  assert.ok(frame.cell.vectors[8] > 0);
  const roundtrip = fractionalToCartesian(frame.fractional, frame.cell);
  roundtrip.forEach((value, index) => assert.ok(Math.abs(value - frame.positions[index]) < 1e-6));
});

test('Extended XYZ reads row-vector triclinic cells, mixed PBC and typed vector scalars', () => {
  const frame = parseXyzFrame(`2\nLattice="4 0 0 1 5 0 0.5 0.2 6" pbc="T F T" Properties=species:S:1:pos:R:3:id:I:1:force:R:3:energy:R:1:fixed:L:1:label:S:1 Step=20\nFe 4.5 -1 1 91 1 2 3 -4 T "atom one"\nC 1 2 3 17 -1 -2 -3 NaN F "atom two"\n`);
  assert.deepEqual([...frame.cell.vectors], [4, 0, 0, 1, 5, 0, 0.5, 0.2, 6]);
  assert.deepEqual(frame.cell.pbc, [true, false, true]);
  assert.equal(frame.cell.triclinic, true);
  assert.equal(frame.idSource, 'explicit');
  assert.deepEqual([...frame.ids], [91, 17]);
  assert.deepEqual(frame.properties.map((property) => property.name), ['force_0', 'force_1', 'force_2', 'energy', 'fixed']);
  assert.deepEqual([...frame.properties[0].data], [1, -1]);
  assert.deepEqual([...frame.properties.at(-1).data], [1, 0]);
  assert.ok(Number.isNaN(frame.properties[3].data[1]));
  assert.deepEqual(frame.ignoredStringProperties, ['label']);
  assert.equal(frame.timestep, 20);
  const fractions = cartesianToFractional(frame.positions, frame.cell);
  for (let atom = 0; atom < 2; atom += 1) {
    assert.ok(fractions[atom * 3] >= 0 && fractions[atom * 3] < 1);
    assert.ok(fractions[atom * 3 + 2] >= 0 && fractions[atom * 3 + 2] < 1);
  }
  assert.ok(fractions[1] < 0, 'nonperiodic coordinate is not wrapped');
  assert.deepEqual([...frame.unwrappedPositions], [4.5, -1, 1, 1, 2, 3]);
  assert.equal(frame.unwrapSource, 'out-of-cell XYZ coordinates');
  assert.deepEqual([...frame.imageFlags], [1, 0, 0, 0, 0, 0]);
});

test('XYZ byte indexes survive UTF-8 comments, CRLF, tiny chunks and blank separators', async () => {
  const first = '1\r\n晶格 Fe\r\nFe 1 2 3\r\n';
  const second = '2\r\n\r\nC 0 0 0\r\nH 1 0 0';
  const blob = new Blob(['\uFEFF', first, '\r\n', second]);
  const progress = [];
  const indexed = await indexXyz(blob, (value) => progress.push(value), { chunkSize: 7 });
  assert.equal(indexed.offsets.length, 2);
  assert.equal(indexed.offsets[0], 0);
  assert.equal(indexed.offsets[1], new TextEncoder().encode(`\uFEFF${first}\r\n`).length);
  assert.equal((await readXyzFrame(blob, indexed.offsets, 0)).typeLabels[0], 'Fe');
  const frame = await readXyzFrame(blob, indexed.offsets, 1);
  assert.equal(frame.ids.length, 2);
  assert.equal(frame.frameIndex, 1);
  assert.equal(progress.at(-1).loaded, blob.size);
  await assert.rejects(readXyzFrame(blob, indexed.offsets, 2), /outside/);
});

test('Extended XYZ accepts atomic numbers and defaults a supplied lattice to periodic', () => {
  const frame = parseXyzFrame('1\nLattice="5 0 0 0 5 0 0 0 5" Properties=Z:I:1:pos:R:3\n26 1 2 3\n');
  assert.deepEqual(frame.typeLabels, ['Fe']);
  assert.deepEqual(frame.cell.pbc, [true, true, true]);
});

test('XYZ rejects malformed schemas, unsafe identities and incomplete frames', async () => {
  for (const [text, pattern] of [
    ['1\nProperties=species:S:1:pos:R:2\nFe 0 0\n', /pos:R:3/],
    ['1\npbc="T F F"\nFe 0 0 0\n', /require a Lattice/],
    ['1\npbc="F F"\nFe 0 0 0\n', /three boolean/],
    ['2\nProperties=species:S:1:pos:R:3:id:I:1\nFe 0 0 0 1\nFe 1 1 1 1\n', /duplicated/],
    ['1\nProperties=species:S:1:pos:R:3:id:I:1\nFe 0 0 0 9007199254740992\n', /invalid/],
    ['1\nProperties=species:S:1:pos:R:3:force:R:3:force_0:R:1\nFe 0 0 0 1 2 3 4\n', /duplicated/],
    ['1\ncomment\nFe NaN 0 0\n', /numeric/],
  ]) assert.throws(() => parseXyzFrame(text), pattern);
  await assert.rejects(indexXyz(new Blob(['2\ncomment\nFe 0 0 0\n'])), /truncated/);
  await assert.rejects(indexXyz(new Blob(['1\ncomment\n\n'])), /blank atom/);
  await assert.rejects(indexXyz(new Blob(['0\ncomment\n'])), /positive/);
  // Rows are blank exactly when trim() empties them, including Unicode spaces.
  for (const chunkSize of [2, 4096]) {
    await assert.rejects(indexXyz(new Blob(['1\ncomment\n\u00a0\u3000\r\n']), () => {}, { chunkSize }), /blank atom/);
    assert.deepEqual((await indexXyz(new Blob(['\u3000\n1\nc\n\u00a0é\n\u2028\n1\nc\n\u0000\n']), () => {}, { chunkSize })).offsets, [4, 17]);
  }
});
