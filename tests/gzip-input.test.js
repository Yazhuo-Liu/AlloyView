import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  detectNumberedStructureSequences,
  inferStructureFormatFromPath,
  isPotentialStructurePath,
} from '../src/io/file-sequences.js';
import { decompressToFile, isGzipFile, readFileBytes, readStructureHeader } from '../src/io/gzip.js';

const examples = new URL('../examples/', import.meta.url);
const example = async (name) => new Uint8Array(await readFile(new URL(name, examples)));
const gzipFile = (bytes, name) => new File([gzipSync(bytes)], name);

function assertSameFrame(actual, expected, label) {
  for (const key of ['ids', 'types', 'positions', 'fractional', 'unwrappedPositions', 'imageFlags']) {
    const left = actual[key], right = expected[key];
    if (!right) {
      assert.equal(left, right, `${label}: ${key}`);
      continue;
    }
    assert.equal(left.length, right.length, `${label}: ${key} length`);
    for (let index = 0; index < right.length; index += 1) {
      if (!Object.is(left[index], right[index])) assert.fail(`${label}: ${key}[${index}]`);
    }
  }
  assert.deepEqual(actual.typeLabels, expected.typeLabels, `${label}: typeLabels`);
  assert.deepEqual(actual.cell, expected.cell, `${label}: cell`);
  assert.deepEqual(actual.properties.map(({ name, unit, data }) => [name, unit, [...data]]),
    expected.properties.map(({ name, unit, data }) => [name, unit, [...data]]), `${label}: properties`);
  assert.equal(actual.title, expected.title, `${label}: title`);
}

test('gzip files are recognized by content and their headers are decompressed', async () => {
  const text = 'ITEM: TIMESTEP\n0\nITEM: NUMBER OF ATOMS\n1\n';
  const compressed = gzipFile(new TextEncoder().encode(text), 'no-extension');
  assert.equal(await isGzipFile(compressed), true);
  assert.equal(await isGzipFile(new File([text], 'plain.dump.gz')), false, 'a .gz name alone is not gzip');
  assert.equal(await isGzipFile(new File(['\x1f'], 'short')), false);
  assert.equal(await readStructureHeader(compressed), text);
  assert.equal(await readStructureHeader(compressed, 9), 'ITEM: TIM');
  assert.equal(await readStructureHeader(new File([text], 'plain.dump')), text);
  // A damaged stream yields the header decompressed before the damage.
  const damaged = gzipSync(new TextEncoder().encode(text.repeat(2000)));
  const truncated = new File([damaged.subarray(0, damaged.length - 20)], 'truncated.dump.gz');
  assert.ok((await readStructureHeader(truncated, 4096)).startsWith('ITEM: TIMESTEP'));
  await assert.rejects(readFileBytes(truncated), /could not be decompressed as a single gzip stream/);
});

test('decompressed trajectories keep random access across Blob parts', async () => {
  const bytes = await example('hea-fcc-screw.dump');
  const file = await decompressToFile(gzipFile(bytes, 'hea.dump.gz'), { partBytes: 100_003 });
  assert.equal(file.name, 'hea.dump.gz');
  assert.equal(file.size, bytes.length);
  for (const [start, end] of [[0, 10], [99_990, 100_020], [1_000_000, 1_400_011], [bytes.length - 7, bytes.length]]) {
    assert.deepEqual(new Uint8Array(await file.slice(start, end).arrayBuffer()), bytes.subarray(start, end));
  }
  const plain = new File([bytes], 'plain.dump');
  assert.equal(await decompressToFile(plain), plain, 'uncompressed files are used directly');
  assert.deepEqual(await readFileBytes(gzipFile(bytes, 'x.gz')), bytes);
});

test('concatenated gzip members are rejected with an explanation', async () => {
  const members = new File([gzipSync(Buffer.from('1\na\nFe 0 0 0\n')), gzipSync(Buffer.from('1\nb\nFe 1 1 1\n'))], 'two.xyz.gz');
  await assert.rejects(decompressToFile(members), /could not be decompressed as a single gzip stream/);
});

test('.gz names are candidates and form numbered sequences', () => {
  assert.equal(isPotentialStructurePath('run/traj.dump.gz'), true);
  assert.equal(isPotentialStructurePath('run/trajectory.gz'), true);
  assert.equal(inferStructureFormatFromPath('a.cfg.gz'), 'cfg');
  assert.equal(inferStructureFormatFromPath('a.lammpstrj.gz'), 'lammps-dump');
  assert.equal(inferStructureFormatFromPath('POSCAR.gz'), 'poscar');
  assert.equal(inferStructureFormatFromPath('relaxed.vasp.gz'), 'poscar');
  const entries = ['dump.200.gz', 'dump.100.gz', 'dump.1000.gz'].map((name) => ({ file: { name }, relativePath: `run/${name}`, format: 'lammps-dump' }));
  const [sequence] = detectNumberedStructureSequences(entries);
  assert.equal(sequence.pattern, 'run/dump.{number}.gz');
  assert.deepEqual(sequence.entries.map((entry) => entry.relativePath), ['run/dump.100.gz', 'run/dump.200.gz', 'run/dump.1000.gz']);
});

test('the structure Worker opens gzip structures, trajectories and sequences', async (t) => {
  let listener;
  const messages = [];
  const originalSelf = globalThis.self;
  globalThis.self = {
    addEventListener(type, callback) { listener = callback; },
    postMessage(message) { messages.push(message); },
  };
  try {
    await import('../src/workers/structure-worker.js');
    let id = 0;
    async function send(type, payload) {
      id += 1;
      await listener({ data: { id, type, payload } });
      const message = messages.find((entry) => entry.id === id && 'ok' in entry);
      assert.equal(message.ok, true, message.error);
      return message.result;
    }
    async function sendError(type, payload) {
      id += 1;
      await listener({ data: { id, type, payload } });
      const message = messages.find((entry) => entry.id === id && 'ok' in entry);
      assert.equal(message.ok, false);
      return message.error;
    }

    await t.test('single dump and CFG files match their uncompressed loads', async () => {
      for (const name of ['hea-fcc-screw.dump', 'NiGB_minimized.cfg']) {
        const bytes = await example(name);
        const expected = await send('load', { files: [new File([bytes], `${name}.gz`)] });
        // An extension that does not reveal the format: detection uses the
        // decompressed header.
        const loaded = await send('load', { files: [gzipFile(bytes, `${name}.gz`)] });
        assert.equal(loaded.format, expected.format);
        assert.equal(loaded.frameCount, 1);
        assertSameFrame(loaded.frame, expected.frame, name);
        const renamed = await send('load', { files: [gzipFile(bytes, 'structure.gz')] });
        assert.equal(renamed.format, expected.format);
      }
    });

    await t.test('a multi-frame gzip dump is indexed after decompression', async () => {
      const frame = new TextDecoder().decode(await example('hea-fcc-screw.dump'));
      const second = frame.replace(/^ITEM: TIMESTEP\n0\n/, 'ITEM: TIMESTEP\n500\n');
      const bytes = new TextEncoder().encode(frame + second);
      const loaded = await send('load', { files: [gzipFile(bytes, 'two.lammpstrj.gz')] });
      assert.equal(loaded.format, 'lammps-dump');
      assert.equal(loaded.frameCount, 2);
      const next = await send('frame', { index: 1 });
      assert.equal(next.frame.timestep, 500);
      assertSameFrame(next.frame, { ...loaded.frame, title: 'two.lammpstrj.gz · 500' }, 'second frame');
    });

    await t.test('numbered gzip dump and XYZ sequences concatenate their frames', async () => {
      const hea = await example('hea-fcc-screw.dump');
      const shifted = new TextEncoder().encode(new TextDecoder().decode(hea).replace(/^ITEM: TIMESTEP\n0\n/, 'ITEM: TIMESTEP\n9\n'));
      const loaded = await send('load', { files: [gzipFile(shifted, 'dump.10.gz'), new File([hea], 'dump.2')] });
      assert.equal(loaded.format, 'lammps-dump-sequence');
      assert.equal(loaded.frameCount, 2);
      assert.equal((await send('frame', { index: 1 })).frame.timestep, 9);
      const xyz = await send('load', { files: [
        gzipFile(new TextEncoder().encode('1\nthird\nC 3 0 0\n'), 'frame.10.xyz.gz'),
        gzipFile(new TextEncoder().encode('1\nfirst\nFe 1 0 0\n1\nsecond\nFe 2 0 0\n'), 'frame.2.xyz.gz'),
      ] });
      assert.equal(xyz.format, 'xyz-sequence');
      assert.equal(xyz.frameCount, 3);
      const third = await send('frame', { index: 2 });
      assert.equal(third.frame.typeLabels[0], 'C');
      assert.equal(third.frame.positions[0], 3);
    });

    await t.test('gzip CFG sequences unwrap like uncompressed ones, including backward access', async () => {
      const names = [0, 1, 2, 3].map((index) => `replica.${index}.cfg`);
      const contents = await Promise.all(names.map((name) => example(`fixed_end_climb/${name}`)));
      const plain = await send('load', { files: contents.map((bytes, index) => new File([bytes], names[index])) });
      const plainFrames = [];
      for (let index = 0; index < names.length; index += 1) plainFrames.push((await send('frame', { index })).frame);
      const loaded = await send('load', { files: contents.map((bytes, index) => gzipFile(bytes, `${names[index]}.gz`)) });
      assert.equal(loaded.format, 'cfg-sequence');
      assert.equal(loaded.frameCount, plain.frameCount);
      for (const index of [3, 1, 2, 0]) {
        const frame = (await send('frame', { index })).frame;
        assertSameFrame(frame, { ...plainFrames[index], title: `${names[index]}.gz` }, `replica ${index}`);
      }
    });

    await t.test('damaged gzip input reports a decompression error', async () => {
      const compressed = gzipSync(await example('hea-fcc-screw.dump'));
      const error = await sendError('load', { files: [new File([compressed.subarray(0, compressed.length >> 1)], 'broken.dump.gz')] });
      assert.match(error, /“broken\.dump\.gz” could not be decompressed as a single gzip stream/);
    });
  } finally {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  }
});
