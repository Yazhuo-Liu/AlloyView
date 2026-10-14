import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { parseCfg } from '../src/io/cfg.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';
import { parseXyzFrame } from '../src/io/xyz.js';
import { parsePdbFrame } from '../src/io/pdb.js';
import { parseFrameDescriptor } from '../src/workers/frame-parser.js';
import { FrameParserPool } from '../src/data/frame-parser-pool.js';
import { CpuBudget } from '../src/analysis/cpu-budget.js';
import { decompressToFile } from '../src/io/gzip.js';

const encode = text => new TextEncoder().encode(text);
const projected = { projection: 'coordinates' };
const count = 3;
const matrix = 'H0(1,1) = 9\nH0(1,2) = 0\nH0(1,3) = 0\nH0(2,1) = 2\nH0(2,2) = 10\nH0(2,3) = 0\nH0(3,1) = -1\nH0(3,2) = 3\nH0(3,3) = 11\n';
const cfg = (body, { entries = 8, names = ['id', 'ix', 'iy', 'iz', 'energy'], velocity = false, count: n = count } = {}) =>
  `Number of particles = ${n}\n${matrix}${velocity ? '' : '.NO_VELOCITY.\n'}entry_count = ${entries}\n`
  + names.map((name, index) => `auxiliary[${index}] = ${name}`).join('\n') + `\n${body}`;
const dump = (columns, rows, pbc = 'pp ff pp') => `ITEM: UNITS\nmetal\nITEM: TIMESTEP\n17\nITEM: TIME\n2.75\nITEM: NUMBER OF ATOMS\n${rows.length}\nITEM: BOX BOUNDS xy xz yz ${pbc}\n-5 15 2\n-3 17 -1\n4 24 3\nITEM: ATOMS ${columns}\n${rows.join('\n')}\n`;
const pdbRow = (id, x, y, z, species = 'Fe', { alt = ' ', occupancy = '.50', bfactor = '12.5' } = {}) =>
  `ATOM  ${String(id).padStart(5)}  FE ${alt}FE A   1    ${[x, y, z].map(value => Number(value).toFixed(3).padStart(8)).join('')}${occupancy.padStart(6)}${bfactor.padStart(6)}          ${species.padStart(2)}\n`;
const crystal = 'CRYST1    9.000   10.000   11.000  70.00  80.00  60.00 P 1           1\n';

function withoutProperties(frame) {
  const { parseMs, ...rest } = frame;
  return { ...rest, properties: [] };
}
function sameProjection(parse, input, label = '') {
  const full = parse(input, 'fixture');
  const coordinate = parse(input, 'fixture', projected);
  assert.deepEqual(withoutProperties(coordinate), withoutProperties(full), label);
  assert.deepEqual(coordinate.properties, [], `${label}: unrelated properties omitted`);
  return full;
}
function sameError(parse, input) {
  let expected;
  try { parse(input, 'fixture'); } catch (error) { expected = error.message; }
  assert.ok(expected, 'fixture must actually fail full parsing');
  assert.throws(() => parse(input, 'fixture', projected), { message: expected });
}

// Direct affine equations are independent of the parser's fused tail and
// retain its documented Float32 rounding at each stored coordinate stage.
function exactDumpOracle(frame, source, { scaled, images, explicit, explicitScaled } = {}) {
  const { origin: o, vectors: h, pbc } = frame.cell;
  const raw = Float32Array.from(source.flat());
  for (let atom = 0; atom < source.length; atom++) {
    const offset = atom * 3;
    let a = raw[offset], b = raw[offset + 1], c = raw[offset + 2];
    if (!scaled) {
      c = Math.fround((raw[offset + 2] - o[2]) / h[8]);
      // The inverse multiplication sums x/y/z, rather than recursively using
      // already-rounded reduced coordinates; use the unrounded inverse here.
      const z = raw[offset + 2] - o[2], y = raw[offset + 1] - o[1], x = raw[offset] - o[0];
      b = Math.fround(y / h[4] - z * h[7] / (h[4] * h[8]));
      a = Math.fround(x / h[0] - y * h[3] / (h[0] * h[4]) + z * (h[3] * h[7] - h[6] * h[4]) / (h[0] * h[4] * h[8]));
    }
    const reduced = [a, b, c].map((value, axis) => Math.fround(pbc[axis] ? value - Math.floor(value) : value));
    assert.deepEqual(Array.from(frame.fractional.subarray(offset, offset + 3)), reduced);
    const cartesian = values => [0, 1, 2].map(axis => Math.fround(o[axis] + values[0] * h[axis] + values[1] * h[3 + axis] + values[2] * h[6 + axis]));
    assert.deepEqual(Array.from(frame.positions.subarray(offset, offset + 3)), cartesian(reduced));
    if (explicit) {
      const values = Array.from(Float32Array.from(explicit[atom]));
      assert.deepEqual(Array.from(frame.unwrappedPositions.subarray(offset, offset + 3)), explicitScaled ? cartesian(values) : values);
    } else if (images) {
      const values = [a, b, c].map((value, axis) => Math.fround(value + images[atom][axis]));
      assert.deepEqual(Array.from(frame.unwrappedPositions.subarray(offset, offset + 3)), cartesian(values));
    }
  }
}

test('coordinate dump projection preserves ID/type sorting, mixed PBC, Float32 geometry and authoritative unwrapped coordinates', () => {
  const source = [[-12.1234567, 123.98765, 33.00001], [0, -0, -1000.4444], [20.3333333, 8.7654321, 4.123456789]];
  const images = [[-2, 3, 1], [11, -7, 3], [11, 13, -17]];
  const explicit = [[1.23456789, 20.123456, -0], [33.333333, -44.444444, 55.555555], [-111, 2.0000001, -300.00001]];
  for (const columns of ['x y z', 'xs ys zs', 'xu yu zu', 'xsu ysu zsu']) for (const pbc of ['pp ff pp', 'ff pp ff', 'pp pp pp', 'ff ff ff']) {
    const alreadyUnwrapped = columns.startsWith('xu') || columns.startsWith('xsu');
    for (const extra of alreadyUnwrapped ? [''] : ['', 'xu yu zu', 'xsu ysu zsu']) {
      const text = dump(`id type element ${columns} ix iy iz${extra ? ` ${extra}` : ''} energy stress`, source.map((row, atom) =>
        [9007199254740989 + atom, atom === 1 ? 9007199254740991 : 1, atom === 1 ? 'Ni' : 'Fe', ...row, ...images[atom], ...(extra ? explicit[atom] : []), -3.5, -0].map(value => Object.is(value, -0) ? '-0' : value).join(' ')), pbc);
      for (const input of [text, encode(text)]) {
        sameProjection(parseLammpsFrame, input);
        const frame = parseLammpsFrame(input, 'fixture', projected);
        // Scaled paths use independent direct equations exactly. The Cartesian
        // inverse is covered bit-for-bit against full parsing above and by the
        // existing unfused parser-tail oracle (inverse expression rounding can
        // differ despite being mathematically equivalent).
        if (columns.startsWith('xs')) exactDumpOracle(frame, source, { scaled: true, images,
          explicit: alreadyUnwrapped ? source : extra ? explicit : null,
          explicitScaled: alreadyUnwrapped || extra.startsWith('xsu') });
      }
    }
  }
});

test('coordinate CFG/XYZ/PDB projection retains all geometry, stable IDs, semantic auxiliaries and metadata', () => {
  const cases = [
    [parseCfg, cfg('58.69\nNi\n.98 .1 .2 91 0 -2 3 -4.5\n.02 .2 .3 99 1 0 0 0\n.3 .4 .5 9007199254740991 0 0 0 1\n')],
    [parseCfg, cfg('58.69 Ni -.1 .2 1.2 1 2 3 91 0 -2 3 -4.5\n26.9 Al .2 .3 .4 0 0 0 99 1 0 0 0\n58.69 Ni .3 .4 .5 -1 -2 -3 100 0 0 0 1\n', { entries: 11, velocity: true })],
    [parseCfg, `Number of particles = 3\n${matrix}58.69 Ni -.1 .2 1.2 1 2 3\n26.9 Al .2 .3 .4 0 0 0\n58.69 Ni .3 .4 .5 -1 -2 -3\n`],
    [parseXyzFrame, '3\nLattice="9 0 0 2 10 0 -1 3 11" pbc="T F T" Step=17 Properties=species:S:1:pos:R:3:id:I:1:v:R:3:fixed:L:1:count:I:1:tag:S:1\nFe -2.3 44.5 23.5 91 1 2 3 T 7 a\nNi 1 2 3 99 NaN nan 0 false 8 b\nFe 0 0 0 100 -0 0 0 1 9 c\n'],
    [parseXyzFrame, '2\nplain molecule\nFe -2.5 0 0\nNi 100 2 1\n'],
    [parseXyzFrame, '1\nProperties=species:S:1:pos:R:3:tag:S:1:energy:R:1\nFe 0 0 0 "two words" -1\n'],
    [parsePdbFrame, `${crystal}MODEL        17\n${pdbRow(91, -2.3, 4.5, 23.5)}${pdbRow(99, 1, 2, 3, 'Ni')}${pdbRow(100, 0, 0, 0)}${pdbRow(101, 0, 0, 0, 'Fe', { alt: 'B' })}ENDMDL\n`],
    [parsePdbFrame, `${pdbRow(1, -2.5, 0, 0)}${pdbRow(2, 100, 2, 1)}`],
  ];
  for (const [parse, text] of cases) {
    const variants = parse === parsePdbFrame ? [text, `\uFEFF${text.replaceAll('\n', '\r\n')}`] : [text, encode(text), encode(`\uFEFF${text.replaceAll('\n', '\r\n')}`)];
    for (const variant of variants) sameProjection(parse, variant);
  }
});

test('coordinate projections validate omitted numeric properties and preserve exact full-parser errors', () => {
  for (const token of ['abc', 'Infinity', '-Infinity', 'nan', '1e309', '1d-3', '0x10', '-0', '1.5', '9007199254740993']) {
    const cases = [
      [parseLammpsFrame, dump('id type xs ys zs energy', [`1 1 .1 .2 .3 ${token}`])],
      [parseCfg, cfg(`58.69\nNi\n.1 .2 .3 ${token}\n`, { count: 1, entries: 4, names: ['energy'] })],
      [parseCfg, cfg(`58.69\nNi\n.1 .2 .3 ${token}\n`, { count: 1, entries: 4, names: ['id'] })],
      [parseXyzFrame, `1\nProperties=species:S:1:pos:R:3:energy:R:1\nFe 0 0 0 ${token}\n`],
      [parseXyzFrame, `1\nProperties=species:S:1:pos:R:3:count:I:1\nFe 0 0 0 ${token}\n`],
      [parseXyzFrame, `1\nProperties=species:S:1:pos:R:3:fixed:L:1\nFe 0 0 0 ${token}\n`],
    ];
    for (const [parse, text] of cases) for (const input of [text, encode(text)]) {
      try { parse(input); } catch { sameError(parse, input); continue; }
      sameProjection(parse, input);
    }
  }
  const malformed = [
    [parseCfg, cfg('58.69\nNi\n.1 .2 .3 1 2\n', { count: 1, entries: 5, names: ['id', 'ID'] })],
    [parseCfg, cfg('58.69\nNi\n.1 .2 .3 1\n', { count: 1, entries: 4, names: ['ix'] })],
    [parseCfg, cfg('58.69\nNi\n.1 .2 .3 1 0 0 2147483648\n', { count: 1, entries: 7, names: ['id', 'ix', 'iy', 'iz'] })],
    [parseXyzFrame, '1\nProperties=species:S:1:pos:R:3:a:R:2:a_0:R:1\nFe 0 0 0 1 2 3\n'],
    [parseXyzFrame, '1\nProperties=species:S:1:pos:R:3:fixed:L:1\nFe 0 0 0 true extra\n'],
    [parseLammpsFrame, dump('id type element xs ys zs energy', ['1 1 Fe .1 .2 .3 0', '2 1 Ni .1 .2 .3 1'])],
    [parseLammpsFrame, dump('id type xs ys zs energy', ['1 1 .1 .2 .3 0']) + 'extra\n'],
    [parsePdbFrame, pdbRow(1, 0, 0, 0, 'Fe', { occupancy: 'bad' })],
    [parsePdbFrame, pdbRow(1, 0, 0, 0, 'Fe', { bfactor: 'bad' })],
    [parsePdbFrame, pdbRow(1, 0, 0, 0) + pdbRow(1, 1, 2, 3)],
  ];
  for (const [parse, text] of malformed) for (const input of parse === parsePdbFrame ? [text] : [text, encode(text)]) sameError(parse, input);
});

test('coordinate-only readers omit property buffer allocation instead of parsing full frames and discarding them', () => {
  const n = 137, props = Array.from({ length: 12 }, (_, index) => `field_${index}`);
  const fixtures = [
    [parseLammpsFrame, dump(`id type xs ys zs ${props.join(' ')}`, Array.from({ length: n }, (_, atom) => `${atom + 1} 1 .1 .2 .3 ${props.map(() => '1').join(' ')}`))],
    [parseCfg, cfg(`58.69\nNi\n${Array.from({ length: n }, () => `.1 .2 .3 ${props.map(() => '1').join(' ')}`).join('\n')}\n`, { count: n, entries: 15, names: props })],
    [parseXyzFrame, `${n}\nProperties=species:S:1:pos:R:3:${props.map(name => `${name}:R:1`).join(':')}\n${Array.from({ length: n }, () => `Fe 1 2 3 ${props.map(() => '1').join(' ')}`).join('\n')}\n`],
    [parsePdbFrame, Array.from({ length: n }, (_, atom) => pdbRow(atom + 1, 1, 2, 3)).join('')],
  ];
  const Original = globalThis.Float32Array;
  const allocations = [];
  globalThis.Float32Array = new Proxy(Original, { construct(target, args) { allocations.push(args[0]); return Reflect.construct(target, args); } });
  try {
    for (const [parse, text] of fixtures) for (const input of parse === parsePdbFrame ? [text] : [text, encode(text)]) {
      allocations.length = 0;
      parse(input);
      const fullArrays = allocations.filter(length => length === n).length;
      assert.ok(fullArrays >= (parse === parsePdbFrame ? 2 : 12));
      allocations.length = 0;
      parse(input, 'fixture', projected);
      assert.equal(allocations.filter(length => length === n).length, 0, 'no N-sized scalar property buffers allocated');
    }
  } finally { globalThis.Float32Array = Original; }
});

test('bundled Fe/HEA dumps and CFG examples preserve exact source coordinates and semantic arrays', async () => {
  for (const [name, parse] of [['Fe_disloc_loop.dump', parseLammpsFrame], ['hea-fcc-screw.dump', parseLammpsFrame], ['NiGB_minimized.cfg', parseCfg]]) {
    const input = new Uint8Array(await readFile(new URL(`../examples/${name}`, import.meta.url)));
    sameProjection(parse, input, name);
  }
});

test('coordinate descriptor parsing handles gzip CFG and decompressed indexed dump byte ranges', async () => {
  const cfgText = cfg('58.69\nNi\n.1 .2 .3 1 0 0 0 -4\n.2 .3 .4 2 1 0 0 -3\n.3 .4 .5 3 0 0 0 -2\n');
  const cfgFile = new File([gzipSync(encode(cfgText))], 'structure.cfg.gz');
  const fullCfg = await parseFrameDescriptor({ format: 'cfg', file: cfgFile, index: 9 });
  const slimCfg = await parseFrameDescriptor({ format: 'cfg', file: cfgFile, index: 9, ...projected });
  assert.deepEqual(withoutProperties(slimCfg), withoutProperties(fullCfg));
  const dumpText = dump('id type xs ys zs energy', ['1 1 .1 .2 .3 -4']);
  const prefix = 'garbage preceding indexed frame\n';
  const dumpFile = await decompressToFile(new File([gzipSync(encode(prefix + dumpText))], 'trajectory.dump.gz'));
  const full = await parseFrameDescriptor({ format: 'lammps-dump', file: dumpFile, start: prefix.length, index: 19 });
  const slim = await parseFrameDescriptor({ format: 'lammps-dump', file: dumpFile, start: prefix.length, index: 19, ...projected });
  assert.deepEqual(withoutProperties(slim), withoutProperties(full));
  assert.equal(slim.frameIndex, 19);
  await assert.rejects(parseFrameDescriptor({ format: 'cfg', file: cfgFile, projection: 'unsafe' }), /Unsupported frame projection/);
});

test('single-frame data/POSCAR coordinate requests use an explicit complete-parser validation fallback', async () => {
  const cases = [
    ['lammps-data', 'title\n1 atoms\n1 atom types\n0 4 xlo xhi\n0 4 ylo yhi\n0 4 zlo zhi\n\nMasses\n\n1 55.8\n\nAtoms # atomic\n\n1 1 1 2 3\n\nVelocities\n\n1 1 2 3\n', 'data.Fe'],
    ['poscar', 'Fe\n1\n4 0 0\n0 4 0\n0 0 4\nFe\n1\nSelective dynamics\nDirect\n.1 .2 .3 T F T\n', 'POSCAR'],
  ];
  for (const [format, text, name] of cases) {
    const file = new File([text], name);
    const full = await parseFrameDescriptor({ format, file });
    const coordinate = await parseFrameDescriptor({ format, file, ...projected });
    assert.deepEqual(withoutProperties(coordinate), withoutProperties(full));
    assert.deepEqual(coordinate.properties, []);
    const invalid = new File([text.replace(format === 'poscar' ? '.1 .2 .3' : '1 1 2 3\n', format === 'poscar' ? '.1 .2 bad' : '1 1 bad 3\n')], name);
    let error;
    try { await parseFrameDescriptor({ format, file: invalid }); } catch (caught) { error = caught.message; }
    assert.ok(error);
    await assert.rejects(parseFrameDescriptor({ format, file: invalid, ...projected }), { message: error });
  }
});

test('real persistent parser Workers mix full/coordinate modes without detaching sources or leaking CPU permits', async () => {
  const workers = [];
  const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 4 } } });
  const pool = new FrameParserPool({ backgroundCount: 1, acquire: ({ signal, priority }) => budget.acquire(1, { signal, priority }), workerFactory() {
    const native = new Worker(new URL('./helpers/node-frame-parser-worker.mjs', import.meta.url));
    const worker = { addEventListener(name, listener) { native.on(name, value => listener(name === 'message' ? { data: value } : value)); }, postMessage(...args) { native.postMessage(...args); }, terminate() { return native.terminate(); } };
    workers.push(worker); return worker;
  } });
  const text = dump('id type xs ys zs energy', ['1 1 .1 .2 .3 -4', '2 1 .4 .5 .6 -3']);
  const file = new File([text], 'trajectory.dump');
  try {
    const full = await pool.parse({ format: 'lammps-dump', file, index: 0 });
    const slim = await pool.parse({ format: 'lammps-dump', file, index: 0, ...projected });
    assert.equal(workers.length, 1);
    assert.deepEqual(withoutProperties(slim), withoutProperties(full));
    const header = await pool.parse({ format: 'lammps-dump', file, index: 0, projection: 'header' });
    assert.equal(header.headerOnly, true);
    assert.equal(header.atomCount, full.ids.length);
    assert.deepEqual(header.cell, full.cell);
    assert.equal(header.timestep, full.timestep);
    assert.equal(header.ids, undefined);
    assert.equal(header.positions, undefined);
    assert.equal(header.properties, undefined);
    assert.equal(workers.length, 1, 'header requests share the same warm parser');
    assert.equal(full.properties[0].data.byteLength, 8, 'preceding complete result remains owned by caller');
    assert.equal(await file.text(), text);
    assert.equal(budget.active, 0);
    const badFile = new File([text.replace('-4', 'abc')], 'bad.dump');
    await assert.rejects(pool.parse({ format: 'lammps-dump', file: badFile, ...projected }), /Non-numeric custom columns/);
    const again = await pool.parse({ format: 'lammps-dump', file });
    assert.equal(again.properties.length, 1);
    assert.equal(workers.length, 1, 'scientific parse failure retains warm Worker');
    assert.equal(budget.active, 0);
    const controller = new AbortController();
    const heavy = new File([dump('id type xs ys zs energy', Array.from({ length: 30_000 }, (_, atom) => `${atom + 1} 1 .1 .2 .3 -4`))], 'heavy.dump');
    const cancelled = pool.parse({ format: 'lammps-dump', file: heavy, ...projected }, { signal: controller.signal });
    const rejected = assert.rejects(cancelled, { name: 'AbortError' });
    while (!pool.slots[0].task?.started) await Promise.resolve();
    controller.abort();
    assert.equal(budget.active, 1, 'cancelled synchronous parse retains CPU permit until acknowledgement');
    await rejected;
    const afterCancel = await pool.parse({ format: 'lammps-dump', file });
    assert.equal(afterCancel.properties.length, 1);
    assert.equal(workers.length, 1, 'cancellation preserves the same parser Worker');
    assert.equal(budget.active, 0);
  } finally { pool.close(); }
});
