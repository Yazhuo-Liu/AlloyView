import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { byteParserStatistics } from '../src/io/ascii-rows.js';
import { parseCfg } from '../src/io/cfg.js';
import { parseLammpsFrame, readLammpsFrame } from '../src/io/lammps-dump.js';
import { parseXyzFrame } from '../src/io/xyz.js';

// The byte parsers must give exactly the text parsers' frames and error
// messages. Text input still takes the text path, so comparing the two input
// types compares the two implementations.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function outcome(parse) {
  try {
    return { frame: parse() };
  } catch (error) {
    return { error: error.message };
  }
}

function assertIdentical(actual, expected, path = 'frame') {
  if (Object.is(actual, expected)) return;
  if (ArrayBuffer.isView(expected)) {
    assert.equal(actual?.constructor, expected.constructor, `${path} type`);
    assert.equal(actual.length, expected.length, `${path} length`);
    for (let index = 0; index < expected.length; index += 1) {
      if (!Object.is(actual[index], expected[index])) assert.fail(`${path}[${index}]: ${actual[index]} !== ${expected[index]}`);
    }
    return;
  }
  if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', `${path} is an object`);
    const keys = Object.keys(expected).filter((key) => key !== 'parseMs');
    assert.deepEqual(Object.keys(actual).filter((key) => key !== 'parseMs').sort(), [...keys].sort(), `${path} keys`);
    for (const key of keys) assertIdentical(actual[key], expected[key], `${path}.${key}`);
    return;
  }
  assert.fail(`${path}: ${String(actual)} !== ${String(expected)}`);
}

/** Parse `text` as text and as its UTF-8 bytes; both must agree. Returns
 * whether the byte parser handled the input without the text fallback. */
function assertSameParse(parse, text, label = JSON.stringify(text).slice(0, 120)) {
  const bytes = encoder.encode(text);
  const expected = outcome(() => parse(decoder.decode(bytes)));
  const fallbacks = byteParserStatistics.fallbacks;
  const actual = outcome(() => parse(bytes));
  if ('error' in expected || 'error' in actual) {
    assert.equal(actual.error, expected.error, label);
  } else {
    assertIdentical(actual.frame, expected.frame, label);
  }
  return byteParserStatistics.fallbacks === fallbacks;
}

const parseDump = (input) => parseLammpsFrame(input, 'test.dump');
const parseCfgFile = (input) => parseCfg(input, 'test.cfg');
const parseXyz = (input) => parseXyzFrame(input, 'test.xyz');

function dump(rows, columns = 'id type x y z c_pe', { header = 'pp pp pp', count = rows.length } = {}) {
  return `ITEM: TIMESTEP\n10\nITEM: NUMBER OF ATOMS\n${count}\nITEM: BOX BOUNDS ${header}\n0 10\n0 10\n0 10\nITEM: ATOMS ${columns}\n${rows.join('\n')}\n`;
}

function extendedCfg(body, { entries = 4, auxiliary = ['id'], count = 2 } = {}) {
  const lines = [`Number of particles = ${count}`, 'A = 1 Angstrom'];
  for (let row = 1; row <= 3; row += 1) for (let column = 1; column <= 3; column += 1) lines.push(`H0(${row},${column}) = ${row === column ? 10 : 0} A`);
  lines.push('.NO_VELOCITY.', `entry_count = ${entries}`, ...auxiliary.map((name, index) => `auxiliary[${index}] = ${name}`));
  return `${lines.join('\n')}\n${body}`;
}

const NUMERIC_TOKENS = [
  '0', '-0', '+0', '-0.0', '00', '0e5', '-0e-999', '.5', '-.5', '+.5', '5.', '5.e3', '1e5', '1E+05', '1e-5', '15e0',
  '1e22', '1e23', '1e-22', '1e-23', '9007199254740991', '9007199254740993', '12345678901234567890',
  '0.1234567890123456789', '1.7976931348623157e308', '1e309', '4.9e-324', '1e-400', '6.76363272498885e-18',
  '-4.5228192891668655e+01', '0x10', '0X1f', '-0x10', '0b101', '0o17', 'inf', 'nan', 'NaN', 'Infinity', '-Infinity',
  '1d-3', '1D+2', 'd5', '1e', '1e+', 'e5', '.', '-', '+', '--1', '1..2', '1.2.3', '1_000', '1,5', '1x', '000123',
  '-000.000e+000', '123456789012345', '1234567890123456', '0.00000000000000000000001', '2147483648', '-2147483649',
];

test('every numeric token gives the text parsers’ value or error', () => {
  for (const token of NUMERIC_TOKENS) {
    for (const column of ['x', 'c_pe', 'id', 'type', 'ix']) {
      const columns = column === 'ix' ? 'id type x y z ix iy iz' : 'id type x y z c_pe';
      const values = { id: '1', type: '1', x: '0.5', y: '0.5', z: '0.5', c_pe: '-3.2', ix: '0', iy: '0', iz: '0' };
      values[column] = token;
      const row = columns.split(' ').map((name) => values[name]).join(' ');
      assertSameParse(parseDump, dump([row, row.replace(/^1 /, '2 ')], columns), `dump ${column}=${token}`);
    }
    assertSameParse(parseCfgFile, extendedCfg(`58.69\nNi\n${token} 0.5 0.5 1\n0.25 ${token} 0.25 2\n`), `cfg ${token}`);
    assertSameParse(parseCfgFile, extendedCfg(`${token}\nNi\n0.5 0.5 0.5 1\n0.25 0.25 0.25 2\n`), `cfg mass ${token}`);
    assertSameParse(parseXyz, `2\nProperties=species:S:1:pos:R:3:energy:R:1:count:I:1\nFe ${token} 0 0 ${token} 1\nNi 1 1 1 2 ${token}\n`, `xyz ${token}`);
  }
});

test('plain decimal rows are read from bytes without the text fallback', () => {
  assert.ok(assertSameParse(parseDump, dump(['1 1 0.5 -2.25e-3 +7 -0', '2 2 1.0E+1 .5 5. 1e-22'])));
  assert.ok(assertSameParse(parseDump, dump(['3 1 Fe 0 0 0', '1 2 Ni 1 1 1'], 'id type element x y z')));
  assert.ok(assertSameParse(parseCfgFile, extendedCfg('58.69\nNi\n0.1 0.2 0.3 1\n# comment\n\n26.98\nAl\n0.4 0.5 0.6 2\n')));
  assert.ok(assertSameParse(parseCfgFile, extendedCfg('58.69 Ni 0.1 0.2 0.3 1\n26.98 Al 0.4 0.5 0.6 2\n')));
  assert.ok(assertSameParse(parseCfgFile, extendedCfg('58.69\nNi\n0.1d0 0.2 0.3 1\n0.4 0.5 0.6 2\n')), 'Fortran exponent');
  assert.ok(assertSameParse(parseXyz, '2\nLattice="5 0 0 0 5 0 0 0 5" Properties=species:S:1:pos:R:3:id:I:1:fixed:L:1:tag:S:1\nFe 1 2 3 7 T a\nC 1.5 2 1d0 9 false b\n\n'));
  assert.ok(assertSameParse(parseXyz, '2\nProperties=Z:I:1:pos:R:3:energy:R:1\n26 0 0 0 nan\n28 1 1 1 NaN\n'));
  const basic = `Number of particles = 2\nA = 1 Angstrom\n${[1, 2, 3].flatMap((row) => [1, 2, 3].map((column) => `H0(${row},${column}) = ${row === column ? 4 : 0}`)).join('\n')}\n`;
  assert.ok(assertSameParse(parseCfgFile, `${basic}63.5 Cu 0 0 0 1 2 3\n63.5 Cu 0.5 0.5 0.5 4 5 6\n`));
});

test('odd whitespace, CRLF, BOM and non-ASCII separators keep the text results', () => {
  const rows = ['1 1 0.5 0.25 0.75 -1.5', '2 1 0.1 0.2 0.3 2.5'];
  const separators = [' ', '\t', '  \t ', '\u000b', '\f', '\r', '\u00a0', '\u2028', '\u3000', '\uFEFF', '\u0085', '\u001c'];
  for (const separator of separators) {
    const variant = rows.map((row) => row.replaceAll(' ', separator));
    assertSameParse(parseDump, dump(variant), `dump separator ${JSON.stringify(separator)}`);
    assertSameParse(parseCfgFile, extendedCfg(`58.69\nNi\n${['0.1', '0.2', '0.3', '1'].join(separator)}\n0.4 0.5 0.6 2\n`), `cfg separator ${JSON.stringify(separator)}`);
    assertSameParse(parseXyz, `2\nc\nFe${separator}0 0 0\nNi 1${separator}1 1\n`, `xyz separator ${JSON.stringify(separator)}`);
  }
  const text = dump(rows);
  for (const variant of [
    text.replaceAll('\n', '\r\n'), `\uFEFF${text}`, `\uFEFF\uFEFF${text}`, text.replaceAll('\n', ' \t\n'),
    text.replace(/\n(?=\d)/g, '\n   '), text.trimEnd(), `${text}\n\nextra lines after the atoms\n`,
  ]) assertSameParse(parseDump, variant);
  assertSameParse(parseXyz, '\n\r\n1\nüñïcode comment\nFe 0 0 0\r\n  \n');
  assertSameParse(parseXyz, '\uFEFF1\nc\nFe 0 0 0\n');
  assertSameParse(parseXyz, '1\nc\nFe 0 0 0\n\u00a0\n');
  assertSameParse(parseXyz, '2\nProperties=species:S:1:pos:R:3:label:S:1\nFe 0 0 0 "two words"\nNi 1 1 1 \'x\'\n');
  assertSameParse(parseCfgFile, extendedCfg('58.69\r\nNi\r\n0.1 0.2 0.3 1\r\n\u00a0# indented comment\r\n0.4 0.5 0.6 2\r\n'));
});

test('malformed rows report the text parsers’ messages', () => {
  const malformed = [
    dump(['1 1 0.5 0.5 0.5 1', '2 1 0.5 0.5 1']),
    dump(['1 1 0.5 0.5 0.5 1', '2 1 0.5 0.5 0.5 1 9']),
    dump(['1 1 0.5 0.5 0.5 1', '', '2 1 0.5 0.5 0.5 1']),
    dump(['1 1 0.5 0.5 0.5 1', '1 1 0.5 0.5 0.5 1']),
    dump(['1 0 0.5 0.5 0.5 1', '2 1 0.5 0.5 0.5 1']),
    dump(['1 1.5 0.5 0.5 0.5 1', '2 1 0.5 0.5 0.5 1']),
    dump(['-0 1 0.5 0.5 0.5 1', '0 1 0.5 0.5 0.5 1']),
    dump(['1 1 Fe 0 0 0', '2 1 Ni 0 0 0'], 'id type element x y z'),
    dump(['1 1 0 0 0 2147483648 0 0', '2 1 0 0 0 0 0 0'], 'id type x y z ix iy iz'),
    dump(['1 1 0.5 0.5 0.5 abc', '2 1 0.5 0.5 0.5 1']),
    dump(['1 1 0.5 0.5 0.5 1'], 'id type x y z c_pe', { count: 2 }),
    dump(['1 1 0.5 0.5 0.5 1', '2 1 0.5 0.5 0.5 1']).replace('ITEM: ATOMS', 'ITEM: ATOM'),
    extendedCfg('58.69\nNi\n0.1 0.2 0.3\n'),
    extendedCfg('0.1 0.2 0.3 1\n'),
    extendedCfg('58.69\n1Ni\n0.1 0.2 0.3 1\n'),
    extendedCfg('58.69\nNi\n0.1 0.2 0.3 1\n'),
    extendedCfg('58.69\nNi\n0.1 0.2 0.3 0\n0.1 0.2 0.3 0\n'),
    extendedCfg('x Ni 0.1 0.2 0.3 1\n58.69 2 0.1 0.2 0.3 2\n'),
    '1\nc\nFe 0 0\n', '2\nc\nFe 0 0 0\n', '1\nc\nFe 0 0 0\nextra\n', '1\nc\n1Fe 0 0 0\n', '1\nc\n200 0 0 0\n',
    '2\nProperties=species:S:1:pos:R:3:id:I:1\nFe 0 0 0 4\nFe 1 1 1 4\n',
    '1\nProperties=species:S:1:pos:R:3:fixed:L:1\nFe 0 0 0 yes\n',
    '1\nProperties=species:S:1:pos:R:3:count:I:1\nFe 0 0 0 1.5\n',
  ];
  for (const text of malformed) {
    const parse = text.startsWith('ITEM') ? parseDump : text.startsWith('Number') ? parseCfgFile : parseXyz;
    assertSameParse(parse, text);
  }
});

test('randomized rows agree with the text parsers', () => {
  let seed = 20261007;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const token = (plain) => (random() < 0.1 ? pick(NUMERIC_TOKENS) : plain);
  const join = (tokens) => tokens.map((value, index) => (index ? pick([' ', ' ', ' ', '\t', '  ', '\r', '\u00a0']) : '') + value).join('');
  let byteParsed = 0;
  for (let index = 0; index < 400; index += 1) {
    const count = 1 + Math.floor(random() * 5);
    const rows = Array.from({ length: count }, (_, atom) => join([
      token(String(atom + 1)), token(String(1 + Math.floor(random() * 2))), token((random() * 10).toFixed(6)),
      token((random() * 10).toExponential(4)), token(String(random() * 10)), token((random() - 0.5).toPrecision(3)),
    ]));
    if (assertSameParse(parseDump, dump(rows))) byteParsed += 1;
    const cfgRows = Array.from({ length: count }, (_, atom) => `${token('58.69')}\n${pick(['Ni', 'Al'])}\n${join([token(random().toFixed(5)), token(String(random())), token('0.5'), token(String(atom + 1))])}`);
    if (assertSameParse(parseCfgFile, extendedCfg(`${cfgRows.join('\n')}\n`, { count }))) byteParsed += 1;
    const xyzRows = Array.from({ length: count }, () => join([pick(['Fe', 'Ni']), token(String(random())), token('1'), token('-2.5e-1'), token('0')]));
    if (assertSameParse(parseXyz, `${count}\nProperties=species:S:1:pos:R:3:energy:R:1\n${xyzRows.join('\n')}\n`)) byteParsed += 1;
  }
  assert.ok(byteParsed > 120, `the byte parser handled ${byteParsed} of 1200 inputs`);
});

test('bundled examples give identical frames from bytes and from text', async () => {
  const examples = new URL('../examples/', import.meta.url);
  for (const name of ['hea-fcc-screw.dump', 'fe-bcc-carbon-inclusion.dump', 'Fe_disloc_loop.dump']) {
    const bytes = new Uint8Array(await readFile(new URL(name, examples)));
    const fallbacks = byteParserStatistics.fallbacks;
    const frame = await readLammpsFrame(new Blob([bytes]), [0], 0, name);
    assert.equal(byteParserStatistics.fallbacks, fallbacks, `${name} is read from bytes`);
    assertIdentical(frame, parseLammpsFrame(decoder.decode(bytes), name), name);
  }
  const cfgNames = ['NiGB_minimized.cfg', ...(await readdir(new URL('fixed_end_climb/', examples))).map((name) => `fixed_end_climb/${name}`)];
  for (const name of cfgNames) {
    const bytes = new Uint8Array(await readFile(new URL(name, examples)));
    const fallbacks = byteParserStatistics.fallbacks;
    const frame = parseCfg(bytes, name);
    assert.equal(byteParserStatistics.fallbacks, fallbacks, `${name} is read from bytes`);
    assertIdentical(frame, parseCfg(decoder.decode(bytes), name), name);
  }
});
