import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { parseCfg, parseCfgAsync } from '../src/io/cfg.js';
import { parseLammpsFrame, parseLammpsFrameAsync } from '../src/io/lammps-dump.js';
import { parseXyzFrame, parseXyzFrameAsync } from '../src/io/xyz.js';
import { parsePdbFrame, parsePdbFrameAsync } from '../src/io/pdb.js';
import { parseLammpsData, parseLammpsDataAsync } from '../src/io/lammps-data.js';
import { parsePoscar, parsePoscarAsync } from '../src/io/poscar.js';
import { FrameParserPool } from '../src/data/frame-parser-pool.js';
import { CpuBudget } from '../src/analysis/cpu-budget.js';
import { readFileBytes } from '../src/io/gzip.js';
import { runParserStepsAsync, splitParserLines } from '../src/io/cooperative-parser.js';

const encode = text => new TextEncoder().encode(text);
const matrix = 'H0(1,1) = 10\nH0(1,2) = 0\nH0(1,3) = 0\nH0(2,1) = 2\nH0(2,2) = 10\nH0(2,3) = 0\nH0(3,1) = 0\nH0(3,2) = 1\nH0(3,3) = 10\n';
const pdbRow = id => `ATOM  ${String(id).padStart(5)}  FE  FE A   1       1.500   2.500   3.500  1.00 12.50          Fe\n`;
const fixtures = [
  ['CFG', parseCfg, parseCfgAsync, count => `Number of particles = ${count}\n${matrix}.NO_VELOCITY.\nentry_count = 8\nauxiliary[0] = id\nauxiliary[1] = ix\nauxiliary[2] = iy\nauxiliary[3] = iz\nauxiliary[4] = energy\n55.845\nFe\n` + Array.from({length: count}, (_, i) => `1.2 .3 .4 ${i + 1} 2 -1 0 -3.5\n`).join('')],
  ['dump', parseLammpsFrame, parseLammpsFrameAsync, count => `ITEM: TIMESTEP\n17\nITEM: NUMBER OF ATOMS\n${count}\nITEM: BOX BOUNDS xy xz yz pp ff pp\n0 12 2\n0 11 0\n0 10 1\nITEM: ATOMS id type element x y z ix iy iz energy\n` + Array.from({length: count}, (_, i) => `${i + 1} 1 Fe 12.5 3.5 -2.5 2 -1 0 -3.5\n`).join('')],
  ['XYZ', parseXyzFrame, parseXyzFrameAsync, count => `${count}\nLattice="10 0 0 2 10 0 0 1 10" pbc="T F T" Step=17 Properties=species:S:1:pos:R:3:id:I:1:energy:R:1\n` + Array.from({length: count}, (_, i) => `Fe 12.5 3.5 -2.5 ${i + 1} -3.5\n`).join('')],
  ['PDB', parsePdbFrame, parsePdbFrameAsync, count => 'CRYST1   10.000   10.000   10.000  90.00  90.00  90.00 P 1           1\n' + Array.from({length: count}, (_, i) => pdbRow(i + 1)).join('')],
  ['data', parseLammpsData, parseLammpsDataAsync, count => `LAMMPS fixture\n${count} atoms\n1 atom types\n0 10 xlo xhi\n0 10 ylo yhi\n0 10 zlo zhi\n\nMasses\n\n1 55.845 # Fe\n\nAtoms # atomic\n\n` + Array.from({length: count}, (_, i) => `${i + 1} 1 12.5 3.5 -2.5 2 -1 0\n`).join('')],
  ['POSCAR', parsePoscar, parsePoscarAsync, count => `Fe\n1\n10 0 0\n2 10 0\n0 1 10\nFe\n${count}\nSelective dynamics\nDirect\n` + '1.2 .3 -.4 T F T\n'.repeat(count)],
];

const comparable = frame => { const { parseMs, ...result } = frame; return result; };

for (const [name, sync, async, text] of fixtures) {
  test(`${name} cooperative execution is exactly equivalent and can stop between numeric chunks`, async () => {
    const input = text(3073);
    for (const source of name === 'CFG' || name === 'dump' || name === 'XYZ' ? [input, encode(input)] : [input]) {
      for (const options of [{}, {projection: 'coordinates', deferUnwrap: true}]) {
        let yields = 0;
        const actual = await async(source, 'fixture', {...options, budgetMs: 0, yieldControl: async () => { yields++; }});
        assert.deepEqual(comparable(actual), comparable(sync(source, 'fixture', options)));
        assert.ok(yields >= 3, 'large numeric blocks checkpoint independently of file I/O');
        const controller = new AbortController(); let checkpoints = 0;
        await assert.rejects(async(source, 'fixture', {...options, signal: controller.signal, budgetMs: 0,
          yieldControl: async () => { if (++checkpoints === 3) controller.abort(); }}), {name: 'AbortError'});
        assert.equal(checkpoints, 3, 'abort exits at the first observed cancellation checkpoint');
        assert.deepEqual(comparable(await async(source, 'fixture', options)), comparable(sync(source, 'fixture', options)), 'cancelled partial state cannot affect the next parse');
      }
    }
  });
}

test('text fallback remains cancellable and retains the synchronous format error', async () => {
  const input = fixtures[2][3](5000).replace('Fe 12.5', 'Fe\u00a012.5');
  assert.deepEqual(comparable(await parseXyzFrameAsync(encode(input))), comparable(parseXyzFrame(input)));
  const invalid = input.replace(' 2 -3.5', ' 1 -3.5');
  let message;
  try { parseXyzFrame(invalid); } catch (error) { message = error.message; }
  assert.ok(message);
  await assert.rejects(parseXyzFrameAsync(encode(invalid)), {message});
  const controller = new AbortController(); let checkpoints = 0;
  await assert.rejects(parseXyzFrameAsync(encode(input), 'fixture', {signal: controller.signal, budgetMs: 0,
    yieldControl: async () => { if (++checkpoints === 5) controller.abort(); }}), {name: 'AbortError'});
});

test('default time slices deliver real timer cancellation for every supported format', async () => {
  for (const [name, , async, text] of fixtures) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 0);
    try { await assert.rejects(async(text(50_000), name, {signal: controller.signal}), {name: 'AbortError'}, name); }
    finally { clearTimeout(timer); }
  }
});

test('cooperative line splitting preserves CRLF, BOM, final blanks and signed numeric text', async () => {
  for (const text of ['', '\uFEFF', 'a\r\nb\n', '\uFEFFa\r\nb\r', '\n\n', '-0\n1d-3\r\n']) {
    const expected = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    assert.deepEqual(await runParserStepsAsync(splitParserLines(text)), expected);
  }
});

test('file reads honor cancellation before and after Blob I/O and during gzip streaming', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readFileBytes(new File(['unused'], 'unused.cfg'), {signal: controller.signal}), {name: 'AbortError'});
  const duringRead = new AbortController();
  const file = {arrayBuffer: async () => { duringRead.abort(); return new ArrayBuffer(0); }};
  await assert.rejects(readFileBytes(file, {signal: duringRead.signal}), {name: 'AbortError'});
  const compressed = new File([gzipSync('a'.repeat(2_000_000))], 'compressed.cfg.gz');
  const streaming = new AbortController();
  const timer = setTimeout(() => streaming.abort(), 0);
  try { await assert.rejects(readFileBytes(compressed, {signal: streaming.signal}), {name: 'AbortError'}); }
  finally { clearTimeout(timer); }
});

test('cancelled large parse acknowledges in its retained Worker before the next foreground frame', async () => {
  const budget = new CpuBudget({environment: {navigator: {hardwareConcurrency: 3}}});
  const workers = [], replies = [];
  const pool = new FrameParserPool({acquire: ({priority, signal}) => budget.acquire(1, {priority, signal}),
    workerFactory: () => {
      const native = new Worker(new URL('./helpers/node-frame-parser-worker.mjs', import.meta.url));
      const worker = {
        addEventListener(name, callback) { native.on(name, data => { if (name === 'message') replies.push(data); callback(name === 'message' ? {data} : data); }); },
        postMessage(message) { native.postMessage(message); },
        terminate() { return native.terminate(); },
      };
      workers.push(worker); return worker;
    }});
  try {
    await pool.warm();
    const controller = new AbortController();
    const source = new File([fixtures[2][3](500_000)], 'large.xyz');
    const cancelled = pool.parse({format: 'xyz', file: source, index: 50}, {signal: controller.signal});
    const rejected = assert.rejects(cancelled, {name: 'AbortError'});
    await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort();
    await rejected;
    assert.equal(budget.active, 1, 'abort does not release a running Worker permit before ACK');
    const next = await pool.parse({format: 'xyz', file: new File([fixtures[2][3](2)], 'next.xyz'), index: 150});
    assert.equal(next.frameIndex, 150);
    assert.equal(next.ids.length, 2);
    assert.equal(workers.length, 1, 'foreground Worker and imported modules survive cancellation');
    assert.ok(replies.some(reply => !reply.ok && reply.name === 'AbortError'), 'Worker observes cancellation instead of completing the discarded large numeric parse');
    assert.equal(budget.active, 0);
  } finally { pool.close(); }
});
