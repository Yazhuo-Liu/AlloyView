import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCfg } from '../src/io/cfg.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';
import { parseXyzFrame } from '../src/io/xyz.js';

const { values } = parseArgs({ options: { atoms: { type: 'string', default: '100000' }, columns: { type: 'string', default: '24' }, samples: { type: 'string', default: '7' }, warmups: { type: 'string', default: '8' } } });
const atoms = Number(values.atoms), columns = Number(values.columns), samples = Number(values.samples), warmups = Number(values.warmups);
if (![atoms, columns, samples, warmups].every(Number.isSafeInteger) || atoms < 1 || columns < 0 || columns > 1024 || samples < 1 || warmups < 0) throw new Error('Use positive integer --atoms/--samples, non-negative --columns/--warmups; columns must be at most 1024.');
const encode = text => new TextEncoder().encode(text);
const names = Array.from({ length: columns }, (_, index) => `p_${index}`);
const properties = names.map((_, index) => (index % 2 ? '-2.5' : '1.25')).join(' ');
const rows = Array.from({ length: atoms }, (_, atom) => `${atom + 1} 1 .1 .2 .3${columns ? ` ${properties}` : ''}`).join('\n');
const dumped = encode(`ITEM: TIMESTEP\n0\nITEM: NUMBER OF ATOMS\n${atoms}\nITEM: BOX BOUNDS pp pp pp\n0 10\n0 10\n0 10\nITEM: ATOMS id type xs ys zs${columns ? ` ${names.join(' ')}` : ''}\n${rows}\n`);
const matrix = [1, 2, 3].flatMap(row => [1, 2, 3].map(column => `H0(${row},${column}) = ${row === column ? 10 : 0}`)).join('\n');
const cfg = encode(`Number of particles = ${atoms}\n${matrix}\n.NO_VELOCITY.\nentry_count = ${3 + columns}\n${names.map((name, index) => `auxiliary[${index}] = ${name}`).join('\n')}\n58.69\nNi\n${Array.from({ length: atoms }, () => `.1 .2 .3${columns ? ` ${properties}` : ''}`).join('\n')}\n`);
const xyz = encode(`${atoms}\nLattice="10 0 0 0 10 0 0 0 10" Properties=species:S:1:pos:R:3${columns ? `:${names.map(name => `${name}:R:1`).join(':')}` : ''}\n${Array.from({ length: atoms }, () => `Fe 1 2 3${columns ? ` ${properties}` : ''}`).join('\n')}\n`);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function retainedBytes(frame) {
  const buffers = new Set();
  for (const field of ['ids', 'types', 'positions', 'fractional', 'unwrappedPositions', 'imageFlags']) if (ArrayBuffer.isView(frame[field])) buffers.add(frame[field].buffer);
  for (const property of frame.properties) buffers.add(property.data.buffer);
  buffers.add(frame.cell.origin.buffer); buffers.add(frame.cell.vectors.buffer);
  return [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
}
function assertCoordinatesExact(parse, bytes, name) {
  // Scientific equivalence is checked outside every timed region. Typed
  // arrays retain their exact values, including signed zeros and NaNs.
  const full = parse(bytes, name, { projection: 'full' });
  const coordinate = parse(bytes, name, { projection: 'coordinates' });
  const { parseMs: fullParseMs, properties: fullScalarProperties, ...fullSource } = full;
  const { parseMs: coordinateParseMs, properties: coordinateScalarProperties, ...coordinateSource } = coordinate;
  assert.deepEqual(coordinateSource, fullSource, `${name}: source geometry and metadata must remain exact`);
  assert.deepEqual(coordinateScalarProperties, [], `${name}: coordinate projection must omit scalar arrays`);
}
function benchmark(parse, bytes, name) {
  const modes = [{ projection: 'full' }, { projection: 'coordinates' }];
  assertCoordinatesExact(parse, bytes, name);
  for (let warmup = 0; warmup < warmups; warmup++) for (const mode of modes) parse(bytes, name, mode);
  const timings = [[], []]; let fullBytes, coordinateBytes, fullProperties;
  for (let sample = 0; sample < samples; sample++) for (const modeIndex of sample % 2 ? [1, 0] : [0, 1]) {
    globalThis.gc?.();
    const started = performance.now();
    const frame = parse(bytes, name, modes[modeIndex]);
    timings[modeIndex].push(performance.now() - started);
    if (modeIndex === 0) { fullBytes = retainedBytes(frame); fullProperties = frame.properties.length; }
    else coordinateBytes = retainedBytes(frame);
  }
  return { name, exact: true, inputBytes: bytes.length, fullProperties, fullMs: median(timings[0]), coordinatesMs: median(timings[1]), fullRetainedBytes: fullBytes, coordinatesRetainedBytes: coordinateBytes,
    omittedPropertyBytes: fullBytes - coordinateBytes, samples: timings };
}
const cases = [[parseLammpsFrame, dumped, `synthetic dump ${atoms} atoms/${columns} properties`], [parseCfg, cfg, `synthetic CFG ${atoms} atoms/${columns} properties`], [parseXyzFrame, xyz, `synthetic XYZ ${atoms} atoms/${columns} properties`]];
for (const [name, parser] of [['Fe_disloc_loop.dump', parseLammpsFrame], ['hea-fcc-screw.dump', parseLammpsFrame], ['NiGB_minimized.cfg', parseCfg]]) cases.push([parser, new Uint8Array(await readFile(new URL(`../examples/${name}`, import.meta.url))), name]);
console.log(JSON.stringify({ node: process.version, atoms, columns, samples, warmups, scope: 'Synchronous complete row validation and source geometry parsing; excludes file I/O, Worker transport, smoothing and rendering. Retained bytes count actual distinct typed-array buffers, not process RSS.', results: cases.map(([parse, bytes, name]) => benchmark(parse, bytes, name)) }, null, 2));
