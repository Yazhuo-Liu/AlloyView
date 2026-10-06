import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isReadableLocalFile } from '../src/io/local-files.js';
import { cfgText, crystalFrame, dumpText } from './helpers/crystals.js';

test('Worker parses current and previously cached load messages', async (t) => {
  let listener;
  const messages = [];
  const originalSelf = globalThis.self;
  globalThis.self = {
    addEventListener(type, callback) { assert.equal(type, 'message'); listener = callback; },
    postMessage(message) { messages.push(message); },
  };
  try {
    await import('../src/workers/structure-worker.js');
    const cfg = new File([cfgText(crystalFrame('fcc', 2, 4.05))], 'crystal.cfg');
    const bcc = crystalFrame('bcc', 1, 3.3);
    const dump = new File([dumpText([bcc, bcc])], 'trajectory.dump');
    let id = 0;
    async function send(type, payload) {
      id += 1;
      await listener({ data: { id, type, payload } });
      return messages.find((message) => message.id === id && 'ok' in message);
    }
    for (const [name, payload] of [
      ['current files array', { files: [cfg] }],
      ['legacy single file', { file: cfg }],
      ['legacy array in file field', { file: [cfg] }],
    ]) {
      await t.test(name, async () => {
        const result = await send('load', payload);
        assert.equal(result.ok, true, result.error);
        assert.equal(result.result.frameCount, 1);
        assert.equal(result.result.frame.ids.length, 32);
      });
    }
    await t.test('cloned browser files use read APIs without constructor identity', async () => {
      const blob = structuredClone(cfg);
      const file = {
        name: cfg.name, size: blob.size,
        slice: blob.slice.bind(blob), text: blob.text.bind(blob), arrayBuffer: blob.arrayBuffer.bind(blob),
      };
      assert.equal(file instanceof Blob, false);
      assert.equal(isReadableLocalFile(file), true);
      const result = await send('load', { files: [file] });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.result.frame.ids.length, 32);
    });
    await t.test('LAMMPS indexing and on-demand frames survive legacy loads', async () => {
      const loaded = await send('load', { file: dump });
      assert.equal(loaded.ok, true, loaded.error);
      assert.ok(loaded.result.frameCount > 1);
      const frame = await send('frame', { index: loaded.result.frameCount - 1 });
      assert.equal(frame.ok, true, frame.error);
      assert.equal(frame.result.index, loaded.result.frameCount - 1);
    });
    await t.test('legacy sequence messages retain all frames', async () => {
      const loaded = await send('load', { file: [
        new File([await readFile(new URL('../examples/fixed_end_climb/replica.1.cfg', import.meta.url))], 'replica.1.cfg'),
        new File([await readFile(new URL('../examples/fixed_end_climb/replica.0.cfg', import.meta.url))], 'replica.0.cfg'),
      ] });
      assert.equal(loaded.ok, true, loaded.error);
      assert.equal(loaded.result.frameCount, 2);
      const frame = await send('frame', { index: 1 });
      assert.equal(frame.ok, true, frame.error);
    });
    await t.test('invalid selections are still rejected', async () => {
      for (const payload of [{}, { files: [] }, { file: { name: 'fake.cfg', size: 123 } }]) {
        const result = await send('load', payload);
        assert.equal(result.ok, false);
        assert.match(result.error, /No valid local file/);
      }
    });
    await t.test('XYZ trajectory loading indexes frames and preserves typed properties', async () => {
      const xyz = new File(['1\nfirst frame\nFe 0 0 0\n1\nProperties=species:S:1:pos:R:3:id:I:1:force:R:3\nFe 1 2 3 72 4 5 6\n'], 'trajectory.extxyz');
      const loaded = await send('load', { files: [xyz] });
      assert.equal(loaded.ok, true, loaded.error);
      assert.equal(loaded.result.format, 'xyz');
      assert.equal(loaded.result.frameCount, 2);
      assert.equal(loaded.result.frame.idSource, 'row-order');
      const next = await send('frame', { index: 1 });
      assert.equal(next.ok, true, next.error);
      assert.equal(next.result.frame.ids[0], 72);
      assert.equal(next.result.frame.properties[2].name, 'force_2');
      assert.equal(next.result.frame.properties[2].data[0], 6);
    });
    await t.test('numbered XYZ files concatenate their internal trajectories', async () => {
      const loaded = await send('load', { files: [
        new File(['1\nthird\nC 3 0 0\n'], 'frame.10.xyz'),
        new File(['1\nfirst\nFe 1 0 0\n1\nsecond\nFe 2 0 0\n'], 'frame.2.xyz'),
      ] });
      assert.equal(loaded.ok, true, loaded.error);
      assert.equal(loaded.result.format, 'xyz-sequence');
      assert.equal(loaded.result.frameCount, 3);
      const frame = await send('frame', { index: 2 });
      assert.equal(frame.ok, true, frame.error);
      assert.equal(frame.result.frame.typeLabels[0], 'C');
      assert.equal(frame.result.frame.positions[0], 3);
    });
    await t.test('PDB models are indexed inside the Worker and can be loaded as sequences', async () => {
      const pdbAtom = 'ATOM      7  CA  ALA A   1       1.000   2.000   3.000  1.00 12.50           C  ';
      const models = new File([`MODEL        1\n${pdbAtom}\nENDMDL\nMODEL        2\n${pdbAtom}\nENDMDL\n`], 'model.0.pdb');
      const loaded = await send('load', { files: [models] });
      assert.equal(loaded.ok, true, loaded.error);
      assert.equal(loaded.result.format, 'pdb');
      assert.equal(loaded.result.frameCount, 2);
      const next = await send('frame', { index: 1 });
      assert.equal(next.ok, true, next.error);
      assert.equal(next.result.frame.timestep, 2);
      assert.equal(next.result.frame.ids[0], 7);
      const sequence = await send('load', { files: [new File([pdbAtom], 'model.1.pdb'), models] });
      assert.equal(sequence.ok, true, sequence.error);
      assert.equal(sequence.result.format, 'pdb-sequence');
      assert.equal(sequence.result.frameCount, 3);
      assert.equal((await send('frame', { index: 2 })).ok, true);
    });
  } finally {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  }
});
