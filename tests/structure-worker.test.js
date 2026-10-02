import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isReadableLocalFile } from '../src/io/local-files.js';

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
    const cfg = new File([await readFile(new URL('../examples/fcc-vacancy.cfg', import.meta.url))], 'fcc-vacancy.cfg');
    const dump = new File([await readFile(new URL('../examples/bcc-trajectory.dump', import.meta.url))], 'bcc-trajectory.dump');
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
        assert.equal(result.result.frame.ids.length, 31);
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
      assert.equal(result.result.frame.ids.length, 31);
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
  } finally {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  }
});
