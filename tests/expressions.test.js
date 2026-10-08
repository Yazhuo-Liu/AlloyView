import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  bindExpression, closeMatches, compileFrameExpression, createExpressionScope, evaluateExpression, evaluateSelection,
  expressionTypeNumbers, ExpressionError, MAX_EXPRESSION_DEPTH, MAX_EXPRESSION_LENGTH, MAX_EXPRESSION_NESTING,
  parseExpression, tokenizeExpression,
} from '../src/expressions.js';

function frame(overrides = {}) {
  return {
    ids: Float64Array.of(10, 20, 30, 40), types: Uint16Array.of(0, 1, 0, 1), typeLabels: ['Ni', 'Fe'],
    positions: Float32Array.of(0, 0, 0, 1, 2, 3, 4.5, 5, 6, 7, 8, 9.25),
    fractional: Float32Array.of(0, 0, 0, 0.1, 0.2, 0.3, 0.45, 0.5, 0.6, 0.7, 0.8, 0.925),
    cell: { origin: Float64Array.of(0, 0, 0), vectors: Float64Array.of(10, 0, 0, 0, 10, 0, 0, 0, 10), pbc: [true, true, true], triclinic: false },
    timestep: 500, frameIndex: 2,
    properties: [
      { name: 'centralSymmetry', unit: '', data: Float32Array.of(1, 9, NaN, 12), analysisKind: 'centrosymmetry' },
      { name: 'c_pe', unit: 'eV', data: Float64Array.of(-1, -2, -3, -4) },
      { name: 'structureType', data: Uint8Array.of(1, 3, 0, 1), categories: [{ id: 0, label: 'Other' }] },
    ],
    ...overrides,
  };
}

const values = (text, target = frame(), options = {}) => Array.from(evaluateExpression(compileFrameExpression(text, target, options)));
const scalar = text => values(text)[0];
function rejects(text, pattern, { position, code, target = frame(), options = { strictTypeLabels: true } } = {}) {
  let error;
  try { compileFrameExpression(text, target, options); } catch (caught) { error = caught; }
  assert.ok(error instanceof ExpressionError, `${text} should fail with an ExpressionError`);
  assert.match(error.message, pattern, text);
  if (position !== undefined) assert.equal(error.position, position, `${text} error position`);
  if (code !== undefined) assert.equal(error.code, code, `${text} error code`);
  return error;
}

test('numbers, precedence and associativity follow the documented grammar', () => {
  assert.deepEqual(tokenizeExpression('1e3 .5 2. 1.5E-2').slice(0, 4).map(token => token.value), [1000, 0.5, 2, 0.015]);
  for (const [text, expected] of [
    ['1 + 2 * 3', 7], ['(1 + 2) * 3', 9], ['10 - 4 - 3', 3], ['16 / 4 / 2', 2], ['7 % 3', 1], ['-7 % 3', -1],
    ['2^3^2', 512], ['(2^3)^2', 64], ['-2^2', -4], ['2^-1', 0.5], ['- -3', 3], ['+4', 4],
    ['1 < 2 == 1', 1], ['2 > 1 != 0', 1], ['1 || 0 && 0', 1], ['(1 || 0) && 0', 0], ['!0', 1], ['!!5', 1], ['!3 + 1', 1],
    ['0 ? 1 : 0 ? 2 : 3', 3], ['1 ? 0 ? 4 : 5 : 6', 5], ['1 + 1 ? 7 : 8', 7], ['2 >= 2 && 3 <= 3 && 4 > 3 && 1 < 2', 1],
    ['min(4, -1, 3)', -1], ['max(1, 9, 2, 8)', 9], ['pow(2, 10)', 1024], ['atan2(1, 1) * 4 / pi', 1],
    ['abs(-2) + sqrt(16) + exp(0) + log(1) + log10(1000)', 10], ['floor(-1.5) + ceil(1.2)', 0],
    ['round(2.5) + round(-2.5) + round(-0.4)', 0], ['round(1.5) * 10 + round(-1.5)', 18],
    ['sin(0) + cos(0) + tan(0) + asin(0) + acos(1) + atan(0)', 1], ['isnan(0/0) + isnan(1)', 1],
    ['SQRT(9)', 3], ['Pi > 3.14 && PI < 3.15', 1], ['inf > 1e308', 1],
  ]) assert.equal(scalar(text), expected, text);
});

test('IEEE results, NaN comparisons and truthiness are explicit', () => {
  assert.equal(scalar('1/0'), Infinity);
  assert.equal(scalar('-1/0'), -Infinity);
  assert.ok(Number.isNaN(scalar('0/0')));
  assert.ok(Number.isNaN(scalar('5 % 0')));
  assert.ok(Number.isNaN(scalar('(-8)^(1/3)')));
  // Every comparison with NaN is false, including !=; NaN itself is false.
  for (const text of ['0/0 < 1', '0/0 > 1', '0/0 <= 1', '0/0 >= 1', '0/0 == 0/0', '0/0 != 1', '1 != 0/0', '0/0 && 1', '1 && 0/0']) assert.equal(scalar(text), 0, text);
  assert.equal(scalar('!(0/0)'), 1);
  assert.equal(scalar('(0/0) || 1'), 1);
  assert.equal(scalar('0/0 ? 1 : 2'), 2);
  assert.ok(Number.isNaN(scalar('min(1, 0/0)')));
  assert.deepEqual(values('CSP > 8'), [0, 1, 0, 1]);
  assert.deepEqual(values('CSP != 9'), [1, 0, 0, 1]);
  assert.deepEqual(values('!(CSP > 8)'), [1, 0, 1, 0]);
  assert.deepEqual(values('isnan(CSP)'), [0, 0, 1, 0]);
  assert.deepEqual(Array.from(evaluateSelection(compileFrameExpression('CSP', frame()))), [1, 1, 0, 1]);
  assert.deepEqual(Array.from(evaluateSelection(compileFrameExpression('c_pe + 2', frame()))), [1, 0, 1, 1]);
});

test('per-atom built-ins, properties, aliases and scalar constants', () => {
  const target = frame();
  assert.deepEqual(values('Position.X', target), [0, 1, 4.5, 7]);
  assert.deepEqual(values('position.z + POSITION.Y', target), [0, 5, 11, 17.25]);
  assert.deepEqual(values('ReducedPosition.Z', target), Array.from(Float32Array.of(0, 0.3, 0.6, 0.925)));
  assert.deepEqual(values('Type', target), [1, 2, 1, 2]);
  assert.deepEqual(values('ParticleType == 2', target), [0, 1, 0, 1]);
  assert.deepEqual(values('Type == "Fe"', target), [0, 1, 0, 1]);
  assert.deepEqual(values('"Ni" != Type', target), [0, 1, 0, 1]);
  assert.deepEqual(values("Type == 'fe'", target), [0, 1, 0, 1], 'labels fall back to case-insensitive matches');
  assert.deepEqual(values('ID / 10 + Index', target), [1, 3, 5, 7]);
  assert.deepEqual(values('ParticleIdentifier == 30', target), [0, 0, 1, 0]);
  assert.deepEqual(values('N + CellVolume + CellLength.A + Timestep + Frame', target), Array(4).fill(4 + 1000 + 10 + 500 + 2));
  assert.deepEqual(values('c_PE', target), [-1, -2, -3, -4], 'property names are case-insensitive');
  assert.deepEqual(values('csp > 8 && StructureType == 1', target), [0, 0, 0, 1]);
  assert.deepEqual(values('centrosymmetry', target).map(String), ['1', '9', 'NaN', '12']);
  assert.deepEqual(values('2 * 3 + N', target), [10, 10, 10, 10], 'constant subexpressions fill every atom');
  const copy = evaluateExpression(compileFrameExpression('c_pe', target));
  assert.notEqual(copy, target.properties[1].data, 'a bare variable returns a fresh array');
  assert.ok(copy instanceof Float64Array);

  // LAMMPS numeric labels keep their numbers; element and mixed labels use list order.
  assert.deepEqual(expressionTypeNumbers(['Type 1', 'Type 3', 'Type 7']), [1, 3, 7]);
  assert.deepEqual(expressionTypeNumbers(['Ni', 'Fe']), [1, 2]);
  assert.deepEqual(expressionTypeNumbers(['Type 2', 'Fe']), [1, 2]);
  assert.deepEqual(values('Type', frame({ typeLabels: ['Type 1', 'Type 3'] })), [1, 3, 1, 3]);
  assert.deepEqual(values('Type == "Type 3"', frame({ typeLabels: ['Type 1', 'Type 3'] })), [0, 1, 0, 1]);

  const strings = frame({ ids: ['7', 'copy:1', 9, '09'] });
  assert.deepEqual(values('ID', strings).map(String), ['7', 'NaN', '9', 'NaN'], 'non-numeric IDs read as NaN');

  const velocity = frame({ properties: [...frame().properties, ...['vx', 'vy', 'vz'].map((name, axis) => ({ name, unit: 'Å/ps', data: Float64Array.of(3 * (axis === 0), 0, 0, 4 * (axis === 1)) }))] });
  assert.deepEqual(values('Velocity.Magnitude', velocity), [3, 0, 0, 4]);
  assert.deepEqual(values('Velocity.X + vy', velocity), [3, 0, 0, 4]);
  rejects('Velocity.X > 1', /requires imported velocity components/, { code: 'missing', position: 0 });
});

test('quoted names, exact capitalization and shadowing rules', () => {
  const target = frame({ properties: [
    { name: 'c_s[1]', data: Float64Array.of(1, 2, 3, 4) }, { name: 'v_stress xx', data: Float64Array.of(5, 6, 7, 8) },
    { name: 'N', data: Float64Array.of(9, 9, 9, 9) }, { name: 'Energy', data: Float64Array.of(1, 1, 1, 1) },
    { name: 'energy', data: Float64Array.of(2, 2, 2, 2) }, { name: 'ENERGY', data: Float64Array.of(3, 3, 3, 3) },
    { name: 'centralSymmetry', data: Float64Array.of(0, 0, 0, 0) }, { name: 'csp', data: Float64Array.of(4, 4, 4, 4) },
  ] });
  assert.deepEqual(values('c_s[1] * 2', target), [2, 4, 6, 8]);
  assert.deepEqual(values('`v_stress xx` - 4', target), [1, 2, 3, 4]);
  assert.deepEqual(values('N', target), [4, 4, 4, 4], 'built-ins win unquoted');
  assert.deepEqual(values('`N`', target), [9, 9, 9, 9], 'backquotes always name columns');
  assert.deepEqual(values('energy + Energy', target), [3, 3, 3, 3], 'exact capitalization wins');
  assert.deepEqual(values('CSP', target), [4, 4, 4, 4], 'a real column wins over an alias');
  rejects('eNeRgY', /matches several properties \(Energy, energy, ENERGY\)/, { target, code: 'ambiguous' });
  rejects('`Position.X`', /Unknown property “Position.X”/, { target, code: 'unknown' });
});

test('errors name the problem, its column and close matches', () => {
  rejects('CPS > 8', /^Unknown variable “CPS” at column 1\. Did you mean CSP\?$/, { position: 0, code: 'unknown' });
  rejects('Positon.X + 1', /Did you mean Position\.X/, { position: 0 });
  rejects('2 * sqr(4)', /Unknown function “sqr” at column 5\. Did you mean sqrt\(\)\?/, { position: 4, code: 'unknown' });
  rejects('sqrt(1, 2)', /sqrt\(\) takes 1 argument, not 2 at column 1/, { code: 'arguments' });
  rejects('atan2(1)', /atan2\(\) takes 2 arguments, not 1/, { code: 'arguments' });
  rejects('min(1)', /min\(\) needs at least 2 arguments, not 1/, { code: 'arguments' });
  rejects('abs()', /abs\(\) takes 1 argument, not 0/);
  rejects('1 < CSP < 9', /Comparisons cannot be chained at column 9\. Combine them with && or \|\|/, { position: 8 });
  rejects('1 == 1 == 1', /cannot be chained/);
  rejects('CSP = 8', /Unexpected “=” at column 5\. Use == to compare values\./, { position: 4 });
  rejects('CSP > 8 & Type == 1', /Use && for “and”/);
  rejects('(1 + 2', /Expected “\)” to close “\(” but found the end of the expression at column 7/, { position: 6 });
  rejects('1 +', /The expression ends where a value is expected at column 4/, { position: 3 });
  rejects('1 2', /Unexpected number 2 at column 3\. Is an operator missing\?/, { position: 2 });
  rejects('CSP 8', /Unexpected number 8/);
  rejects(')', /Expected a value but found “\)” at column 1/);
  rejects('   ', /Enter an expression/, { code: 'empty' });
  rejects('1e+', /Invalid number “1e” at column 1/);
  rejects('2x', /Invalid number “2x”/);
  rejects('1.2.3', /Invalid number “1.2.3”/);
  rejects('CSP > 8 # comment', /Unexpected “#” at column 9/);
  rejects('a\n  + $', /Unexpected “\$” at line 2, column 5/, { position: 6 });
  rejects('"Ni" + 1', /Quoted text can only be compared with Type at column 1/, { code: 'type' });
  rejects('CSP == "Ni"', /Quoted text can only be compared with Type/, { code: 'type' });
  rejects('"Ni" == "Ni"', /Quoted text can only be compared with Type/);
  rejects('Type == "Xx"', /No atom type is named “Xx” in this frame at column 9\. Types: Ni, Fe\./, { position: 8, code: 'type' });
  assert.deepEqual(values('Type == "Xx"'), [0, 0, 0, 0], 'frame application treats an absent label as no match');
  rejects('Type == "Ni', /Unclosed text/);
  rejects('`c_pe', /Unclosed property name/);
  rejects('``', /Quoted property name must contain/);
  const error = rejects('CPS', /CPS/);
  assert.equal(error.detail, 'Unknown variable “CPS”');
  assert.equal(error.length, 3);
  assert.deepEqual(closeMatches('cps', ['CSP', 'c_pe', 'pi']), ['CSP']);
  assert.deepEqual(closeMatches('central', ['centralSymmetry', 'Position.X']), ['centralSymmetry']);
});

test('length, nesting and depth limits stop pathological input', () => {
  rejects('1'.padEnd(MAX_EXPRESSION_LENGTH + 1, ' '), /limited to 4,096 characters/, { code: 'limit' });
  assert.equal(scalar(`1${' '.repeat(MAX_EXPRESSION_LENGTH - 1)}`), 1);
  assert.equal(scalar(`${'('.repeat(MAX_EXPRESSION_NESTING - 1)}1${')'.repeat(MAX_EXPRESSION_NESTING - 1)}`), 1);
  rejects(`${'('.repeat(MAX_EXPRESSION_NESTING + 1)}1${')'.repeat(MAX_EXPRESSION_NESTING + 1)}`, /nest at most 64 levels/, { code: 'limit' });
  rejects(`${'-'.repeat(MAX_EXPRESSION_NESTING + 1)}1`, /nest at most/, { code: 'limit' });
  rejects(`${'abs('.repeat(MAX_EXPRESSION_NESTING + 1)}1${')'.repeat(MAX_EXPRESSION_NESTING + 1)}`, /nest at most/, { code: 'limit' });
  assert.equal(scalar(Array(200).fill('1').join('+')), 200);
  rejects(Array(MAX_EXPRESSION_DEPTH + 2).fill('1').join('+'), /at most 256 nested operations/, { code: 'limit' });
  rejects(`min(${Array(MAX_EXPRESSION_DEPTH + 2).fill('1').join(',')})`, /at most 256 nested operations/);
});

test('names never reach JavaScript globals, prototypes or code evaluation', async () => {
  for (const name of ['constructor', '__proto__', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'globalThis', 'window', 'process', 'this', 'eval', 'Function']) {
    rejects(name, /Unknown variable/, { code: 'unknown' });
    rejects(`${name}(1)`, /Unknown function/, { code: 'unknown' });
    rejects(`\`${name}\``, /Unknown property/, { code: 'unknown' });
  }
  rejects('Position.constructor', /Unknown variable/);
  rejects('c_pe.constructor', /Unknown variable/);
  rejects('alert`1`', /Unexpected “1” at column 6/);
  // A property named like a prototype member is an ordinary column.
  const target = frame({ properties: [{ name: 'constructor', data: Float64Array.of(1, 2, 3, 4) }] });
  assert.deepEqual(values('constructor * 2', target), [2, 4, 6, 8]);
  assert.equal(Object.prototype.polluted, undefined);
  const source = await readFile(new URL('../src/expressions.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\beval\s*\(|new\s+Function|\bFunction\s*\(|\bwith\s*\(|import\s*\(/);
});

test('binding reports inputs by identity for caching and rejects missing frames', () => {
  const target = frame();
  const bound = bindExpression(parseExpression('c_pe + Position.X + N'), createExpressionScope(target));
  assert.ok(bound.inputs.includes(target.properties[1].data));
  assert.ok(bound.inputs.includes(target.positions));
  assert.ok(bound.inputs.includes(4));
  assert.throws(() => createExpressionScope({ ids: [], properties: [] }), /Open a structure/);
  const parsed = parseExpression('a + `b c` * a');
  assert.deepEqual(parsed.references.map(reference => [reference.name, reference.quoted]).sort(), [['a', false], ['a', false], ['b c', true]]);
  assert.equal(Object.isFrozen(parsed), true);
});

test('evaluation handles one million atoms with reused buffers', () => {
  const count = 1_000_000;
  const target = {
    ids: Float64Array.from({ length: count }, (_, index) => index + 1), types: new Uint16Array(count), typeLabels: ['Fe'],
    positions: Float32Array.from({ length: count * 3 }, (_, index) => index % 7), fractional: new Float32Array(count * 3),
    cell: { origin: new Float64Array(3), vectors: Float64Array.of(100, 0, 0, 0, 100, 0, 0, 0, 100), pbc: [true, true, true] },
    properties: [{ name: 'pe', data: Float64Array.from({ length: count }, (_, index) => -index / count) }],
  };
  const started = performance.now();
  const result = evaluateExpression(compileFrameExpression('sqrt(Position.X^2 + Position.Y^2 + Position.Z^2) * (pe < -0.5 ? 2 : 1)', target));
  const elapsed = performance.now() - started;
  assert.equal(result.length, count);
  assert.equal(result[count - 1], Math.sqrt(((count * 3 - 3) % 7) ** 2 + ((count * 3 - 2) % 7) ** 2 + ((count * 3 - 1) % 7) ** 2) * 2);
  assert.ok(elapsed < 5000, `evaluation took ${elapsed.toFixed(0)} ms`);
});
