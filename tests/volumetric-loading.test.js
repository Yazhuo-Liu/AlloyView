import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { parseFrameDescriptor } from '../src/workers/frame-parser.js';
import { detectStructureFormatHeader, inferStructureFormatFromPath } from '../src/io/file-sequences.js';
import { frameTransferables } from '../src/data/model.js';

const poscar = ['Synthetic loading fixture', '1', '2 0 0', '0 2 0', '0 0 2', 'H', '1', 'Direct', '.5 .5 .5', ''].join('\n');
const vasp = `${poscar}\n2 2 2\n8 16 24 32 40 48 56 64\n`;
const cube = ['Synthetic loading fixture', 'Scalar values in arbitrary file units',
  '1 0 0 0', '-2 1 0 0', '-2 0 1 0', '-2 0 0 1', '1 1 .5 .5 .5', '0 4 2 6 1 5 3 7', ''].join('\n');

test('VASP header classification uses conventional names and full parsing upgrades a renamed POSCAR grid', async () => {
  assert.equal(detectStructureFormatHeader(poscar, 'CHGCAR'), 'vasp-volume');
  assert.equal(detectStructureFormatHeader(poscar, 'LOCPOT.gz'), 'vasp-volume');
  assert.equal(detectStructureFormatHeader(poscar, 'renamed.vasp'), 'poscar');
  for (const name of ['CHGCAR', 'LOCPOT', 'ELFCAR', 'density.chgcar.gz']) {
    assert.equal(inferStructureFormatFromPath(name), 'vasp-volume');
  }
  const named = await parseFrameDescriptor({ file: new File([vasp], 'CHGCAR'), format: 'vasp-volume' });
  assert.deepEqual([...named.volumetric.datasets[0].values], [1, 2, 3, 4, 5, 6, 7, 8]);
  const renamed = await parseFrameDescriptor({ file: new File([vasp], 'renamed.vasp'), format: 'poscar' });
  assert.equal(renamed.sourceFormat, 'vasp-volume');
  assert.equal(renamed.volumetric.datasets[0].kind, 'unknown');
  assert.deepEqual([...renamed.volumetric.datasets[0].values], [8, 16, 24, 32, 40, 48, 56, 64]);
  assert.equal((await parseFrameDescriptor({ file: new File([poscar], 'POSCAR'), format: 'poscar' })).volumetric, undefined);
  const excessive = `${poscar}\n1000000 1000000 1000000\n1\n`;
  await assert.rejects(parseFrameDescriptor({ file: new File([excessive], 'renamed.vasp'), format: 'poscar' }), /limited/);
});

test('Cube plain/gzip frame parsing retains all samples, while coordinate projections omit volume payloads', async () => {
  const plain = await parseFrameDescriptor({ file: new File([cube], 'test.cube'), format: 'cube' });
  const compressed = await parseFrameDescriptor({ file: new File([gzipSync(cube)], 'test.cube.gz'), format: 'cube' });
  assert.deepEqual(compressed.volumetric.datasets, plain.volumetric.datasets);
  assert.deepEqual([...plain.volumetric.datasets[0].values], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(inferStructureFormatFromPath('test.cube.gz'), 'cube');
  const coordinates = await parseFrameDescriptor({ file: new File([cube], 'test.cube'), format: 'cube', projection: 'coordinates' });
  assert.equal(coordinates.volumetric, undefined); assert.deepEqual(coordinates.positions, plain.positions);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(parseFrameDescriptor({ file: new File([cube], 'test.cube'), format: 'cube' }, { signal: abort.signal }), { name: 'AbortError' });
});

test('volume samples, basis and origin use unique transferable buffers across a real structured clone', async () => {
  const frame = await parseFrameDescriptor({ file: new File([vasp], 'CHGCAR'), format: 'vasp-volume' });
  const source = frame.volumetric.datasets[0], transfer = frameTransferables(frame);
  for (const field of ['values', 'steps', 'origin']) assert.ok(transfer.includes(source[field].buffer), field);
  assert.equal(transfer.length, new Set(transfer).size);
  const received = structuredClone(frame, { transfer });
  assert.equal(source.values.byteLength, 0);
  assert.deepEqual([...received.volumetric.datasets[0].values], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...received.volumetric.datasets[0].steps], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
});

test('the structure Worker opens and revisits named/renamed/gzip volumetric files without discarding the grids', async () => {
  const previousSelf = globalThis.self, messages = []; let listener, nextId = 0;
  globalThis.self = { addEventListener(type, callback) { listener = callback; }, postMessage(message, transfer) {
    messages.push({ message, transfer });
  } };
  try {
    await import('../src/workers/structure-worker.js');
    async function send(type, payload) {
      const id = ++nextId; await listener({ data: { id, type, payload } });
      const reply = messages.find(item => item.message.id === id && 'ok' in item.message);
      assert.equal(reply?.message.ok, true, reply?.message.error);
      return reply;
    }
    for (const [name, content, format] of [['CHGCAR', vasp, 'vasp-volume'], ['renamed.vasp', vasp, 'vasp-volume'], ['test.cube.gz', gzipSync(cube), 'cube']]) {
      const { message: loaded, transfer } = await send('load', { files: [new File([content], name)] });
      assert.equal(loaded.result.format, format); assert.equal(loaded.result.frameCount, 1);
      assert.ok(transfer.includes(loaded.result.frame.volumetric.datasets[0].values.buffer));
      const { message: revisited } = await send('frame', { index: 0 });
      assert.deepEqual(revisited.result.frame.volumetric, loaded.result.frame.volumetric);
    }
  } finally {
    if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf;
  }
});

test('the analytic bundled examples retain two electrons and symmetric signed lobes', async () => {
  const chargeText = await readFile(new URL('../examples/volumetric/CHGCAR', import.meta.url));
  const charge = await parseFrameDescriptor({ file: new File([chargeText], 'CHGCAR'), format: 'vasp-volume' });
  assert.ok(Math.abs(charge.volumetric.datasets[0].statistics.integral - 2) < 1e-12);
  assert.equal(charge.ids.length, 2);
  const cubeText = await readFile(new URL('../examples/volumetric/analytic-p-field.cube', import.meta.url));
  const field = (await parseFrameDescriptor({ file: new File([cubeText], 'analytic-p-field.cube'), format: 'cube' })).volumetric.datasets[0];
  assert.equal(field.statistics.min, -field.statistics.max);
  assert.ok(Math.abs(field.statistics.integral) < 1e-12);
});
