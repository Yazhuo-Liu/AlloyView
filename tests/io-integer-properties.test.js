import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { parseXyzFrame } from '../src/io/xyz.js';
import { parseLammpsData } from '../src/io/lammps-data.js';
import { replicateFrame } from '../src/data/replicate.js';

const integers = [16_777_216, 16_777_217, 2_147_483_648, Number.MAX_SAFE_INTEGER];
const xyz = `${integers.length}\nLattice="10 0 0 0 10 0 0 0 10" Properties=species:S:1:pos:R:3:id:I:1:group:I:1:pair:I:2:energy:R:1:fixed:L:1\n`
  + integers.map((value, index) => `Fe ${index} 1 1 ${value} ${value} ${value} ${-value} 0.1 ${index % 2 ? 'F' : 'T'}`).join('\n') + '\n';
const data = `title\n${integers.length} atoms\n1 atom types\n0 10 xlo xhi\n0 10 ylo yhi\n0 10 zlo zhi\n\nAtoms # full\n\n`
  + integers.map((value, index) => `${value} ${value} 1 0.1 ${index} 1 1`).join('\n') + '\n';
const property = (frame, name) => frame.properties.find(entry => entry.name === name).data;

function checkIntegers(frame, name) {
  assert.deepEqual([...frame.ids], integers, 'native atom IDs remain exact');
  assert.ok(property(frame, name) instanceof Float64Array);
  assert.deepEqual([...property(frame, name)], integers, 'distinct integer categories remain distinct');
}

test('Extended XYZ text and bytes retain safe integer auxiliary precision and vector components', () => {
  for (const input of [xyz, new TextEncoder().encode(xyz)]) {
    const frame = parseXyzFrame(input);
    checkIntegers(frame, 'group');
    assert.deepEqual([...property(frame, 'pair_0')], integers);
    assert.deepEqual([...property(frame, 'pair_1')], integers.map(value => -value));
    assert.ok(property(frame, 'energy') instanceof Float32Array);
    assert.ok(property(frame, 'fixed') instanceof Float32Array);
    assert.deepEqual([...property(frame, 'fixed')], [1, 0, 1, 0]);
    const projected = parseXyzFrame(input, 'fixture.xyz', { projection: 'coordinates' });
    assert.deepEqual(projected.ids, frame.ids);
    assert.deepEqual(projected.properties, []);
  }
});

test('Extended XYZ full and coordinate reads reject integers beyond either safe limit', () => {
  for (const value of ['9007199254740992', '-9007199254740992', '1.5']) {
    const text = `1\nProperties=species:S:1:pos:R:3:group:I:1\nFe 0 0 0 ${value}\n`;
    for (const input of [text, new TextEncoder().encode(text)]) {
      for (const projection of ['full', 'coordinates']) {
        assert.throws(() => parseXyzFrame(input, 'fixture.xyz', { projection }), /requires safe integers/);
      }
    }
  }
});

test('LAMMPS data molecule IDs retain safe integers without changing real scalar storage', () => {
  const frame = parseLammpsData(data);
  checkIntegers(frame, 'mol');
  assert.ok(property(frame, 'q') instanceof Float32Array);
});

test('integer properties survive real parser Worker transfer and physical replication', async (t) => {
  const worker = new Worker(new URL('./helpers/node-frame-parser-worker.mjs', import.meta.url));
  t.after(() => worker.terminate());
  for (const [format, text, name] of [['xyz', xyz, 'group'], ['lammps-data', data, 'mol']]) {
    const message = once(worker, 'message');
    worker.postMessage({ id: format, type: 'parse', descriptor: { format, file: new File([text], 'fixture') } });
    const [result] = await message;
    assert.equal(result.ok, true, result.error);
    checkIntegers(result.frame, name);
    const expanded = await replicateFrame(result.frame, [2, 1, 1]);
    assert.ok(property(expanded, name) instanceof Float64Array);
    assert.deepEqual([...property(expanded, name)], [...integers, ...integers]);
  }
});
