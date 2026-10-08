import { canonicalAtomNumber } from './data/atom-ids.js';
import { determinant3 } from './data/model.js';
import { importedVectorComponents } from './vector-settings.js';

/** A small arithmetic language for per-atom properties and selections.
 * Text is tokenized and parsed into a plain syntax tree, names are bound to a
 * frame through explicit Maps, and the tree is interpreted one operation at a
 * time over typed arrays. No user text is ever run as JavaScript, and lookups
 * never index ordinary objects, so names such as `constructor` are unknown. */

export const MAX_EXPRESSION_LENGTH = 4096;
/** Parentheses, function calls, unary operators, conditionals and powers. */
export const MAX_EXPRESSION_NESTING = 64;
/** Including long operator chains such as `a + b + c + …`. */
export const MAX_EXPRESSION_DEPTH = 256;
const MAX_QUOTED_LENGTH = 256;

export class ExpressionError extends Error {
  constructor(message, { position = null, length = 1, code = 'syntax', text = '', hint = '' } = {}) {
    super(`${message}${position === null ? '' : ` at ${expressionLocation(text, position)}`}.${hint ? ` ${hint}` : ''}`);
    this.name = 'ExpressionError';
    this.detail = message; this.position = position; this.length = length; this.code = code;
  }
}

/** One-based column, plus a line number for multi-line text. */
export function expressionLocation(text, position) {
  const before = String(text).slice(0, position);
  const line = before.split('\n').length;
  const column = position - before.lastIndexOf('\n');
  return line > 1 ? `line ${line}, column ${column}` : `column ${column}`;
}

const UNARY_FUNCTIONS = new Map([
  ['abs', Math.abs], ['sqrt', Math.sqrt], ['exp', Math.exp], ['log', Math.log], ['log10', Math.log10],
  ['sin', Math.sin], ['cos', Math.cos], ['tan', Math.tan], ['asin', Math.asin], ['acos', Math.acos], ['atan', Math.atan],
  ['floor', Math.floor], ['ceil', Math.ceil],
  // C round(): halves move away from zero, unlike Math.round(-2.5) === -2.
  ['round', value => value < 0 ? -Math.round(-value) : Math.round(value)],
  ['isnan', value => value !== value ? 1 : 0],
]);
const BINARY_FUNCTIONS = new Map([['atan2', 'atan2'], ['pow', '^']]);
const VARIADIC_FUNCTIONS = new Map([['min', 'min'], ['max', 'max']]);
export const EXPRESSION_FUNCTIONS = Object.freeze([...UNARY_FUNCTIONS.keys(), ...BINARY_FUNCTIONS.keys(), ...VARIADIC_FUNCTIONS.keys()]);

const OPERATORS = ['<=', '>=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '^', '(', ')', ',', '?', ':', '<', '>', '!'];
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const NAME = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*(?:\[\d+\])*/y;

export function tokenizeExpression(text) {
  if (typeof text !== 'string') throw new ExpressionError('Expressions must be text');
  if (text.length > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionError(`Expressions are limited to ${MAX_EXPRESSION_LENGTH.toLocaleString('en-US')} characters`, { code: 'limit' });
  }
  const tokens = [];
  const fail = (message, position, length = 1, hint = '') => new ExpressionError(message, { position, length, text, hint });
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') { index++; continue; }
    const start = index;
    NUMBER.lastIndex = index; NAME.lastIndex = index;
    let match;
    if ((character >= '0' && character <= '9') || character === '.') {
      match = NUMBER.exec(text);
      if (!match) throw fail(`Unexpected “${character}”`, start);
      index = NUMBER.lastIndex;
      if (/[A-Za-z0-9_.]/.test(text[index] ?? '')) {
        const end = /[A-Za-z0-9_.]*/y; end.lastIndex = index; end.exec(text);
        throw fail(`Invalid number “${text.slice(start, end.lastIndex)}”`, start, end.lastIndex - start);
      }
      tokens.push({ type: 'number', value: Number(match[0]), position: start, length: index - start });
    } else if ((match = NAME.exec(text))) {
      index = NAME.lastIndex;
      tokens.push({ type: 'name', value: match[0], quoted: false, position: start, length: index - start });
    } else if (character === '`' || character === '"' || character === '\'') {
      const end = text.indexOf(character, index + 1);
      const newline = text.indexOf('\n', index + 1);
      const kind = character === '`' ? 'property name' : 'text';
      if (end < 0 || (newline >= 0 && newline < end)) throw fail(`Unclosed ${kind} starting with ${character}`, start);
      const value = text.slice(index + 1, end);
      if (!value || value.length > MAX_QUOTED_LENGTH) throw fail(`Quoted ${kind} must contain 1–${MAX_QUOTED_LENGTH} characters`, start, end + 1 - start);
      index = end + 1;
      tokens.push(character === '`' ? { type: 'name', value, quoted: true, position: start, length: index - start }
        : { type: 'string', value, position: start, length: index - start });
    } else {
      const operator = OPERATORS.find(candidate => text.startsWith(candidate, index));
      if (!operator) {
        const hint = character === '=' ? 'Use == to compare values.' : character === '&' ? 'Use && for “and”.'
          : character === '|' ? 'Use || for “or”.' : '';
        throw fail(`Unexpected “${String.fromCodePoint(text.codePointAt(index))}”`, start, 1, hint);
      }
      index += operator.length;
      tokens.push({ type: 'operator', value: operator, position: start, length: operator.length });
    }
  }
  tokens.push({ type: 'end', value: '', position: text.length, length: 0 });
  return tokens;
}

/** Precedence, loosest first: ?: (right), ||, &&, == != (unchained),
 * < <= > >= (unchained), + -, * / %, unary - + !, ^ (right). `-2^2` is -4. */
export function parseExpression(text) {
  const tokens = tokenizeExpression(text);
  let cursor = 0, nesting = 0;
  const fail = (message, token, options = {}) => new ExpressionError(message, { position: token.position, length: Math.max(1, token.length), text, ...options });
  const peek = () => tokens[cursor];
  const isOperator = value => peek().type === 'operator' && peek().value === value;
  const describe = token => token.type === 'end' ? 'the end of the expression' : token.type === 'number' ? `number ${text.slice(token.position, token.position + token.length)}`
    : token.type === 'string' ? 'quoted text' : `“${token.value}”`;
  function nested(parse) {
    if (++nesting > MAX_EXPRESSION_NESTING) throw fail(`Expressions can nest at most ${MAX_EXPRESSION_NESTING} levels`, peek(), { code: 'limit' });
    try { return parse(); } finally { nesting--; }
  }
  function expect(value, context) {
    if (isOperator(value)) return tokens[cursor++];
    throw fail(`Expected “${value}” ${context} but found ${describe(peek())}`, peek());
  }
  function conditional() {
    const condition = or();
    if (!isOperator('?')) return condition;
    const token = tokens[cursor++];
    const whenTrue = nested(conditional);
    expect(':', 'in a conditional (condition ? value : otherwise)');
    const whenFalse = nested(conditional);
    return { type: 'conditional', condition, whenTrue, whenFalse, position: token.position };
  }
  function leftAssociative(operators, operand) {
    return () => {
      let left = operand();
      while (peek().type === 'operator' && operators.includes(peek().value)) {
        const token = tokens[cursor++];
        left = { type: 'binary', operator: token.value, left, right: operand(), position: token.position };
      }
      return left;
    };
  }
  function unchained(operators, operand) {
    return () => {
      const left = operand();
      if (!(peek().type === 'operator' && operators.includes(peek().value))) return left;
      const token = tokens[cursor++];
      const node = { type: 'binary', operator: token.value, left, right: operand(), position: token.position };
      if (peek().type === 'operator' && operators.includes(peek().value)) {
        throw fail('Comparisons cannot be chained', peek(), { hint: 'Combine them with && or ||, for example 1 < x && x < 2.' });
      }
      return node;
    };
  }
  const multiplicative = leftAssociative(['*', '/', '%'], unary);
  const additive = leftAssociative(['+', '-'], multiplicative);
  const relational = unchained(['<', '<=', '>', '>='], additive);
  const equality = unchained(['==', '!='], relational);
  const and = leftAssociative(['&&'], equality);
  const or = leftAssociative(['||'], and);
  function unary() {
    if (peek().type === 'operator' && ['-', '+', '!'].includes(peek().value)) {
      const token = tokens[cursor++];
      return { type: 'unary', operator: token.value, operand: nested(unary), position: token.position };
    }
    return power();
  }
  function power() {
    const base = primary();
    if (!isOperator('^')) return base;
    const token = tokens[cursor++];
    return { type: 'binary', operator: '^', left: base, right: nested(unary), position: token.position };
  }
  function primary() {
    const token = peek();
    if (token.type === 'number') { cursor++; return { type: 'number', value: token.value, position: token.position }; }
    if (token.type === 'string') { cursor++; return { type: 'string', value: token.value, position: token.position, length: token.length }; }
    if (token.type === 'name') {
      cursor++;
      if (!token.quoted && isOperator('(')) return call(token);
      return { type: 'variable', name: token.value, quoted: token.quoted, position: token.position, length: token.length };
    }
    if (isOperator('(')) {
      cursor++;
      const inner = nested(conditional);
      expect(')', 'to close “(”');
      return inner;
    }
    if (token.type === 'end') throw fail('The expression ends where a value is expected', token);
    throw fail(`Expected a value but found ${describe(token)}`, token);
  }
  function call(token) {
    const name = token.value.toLowerCase();
    if (!UNARY_FUNCTIONS.has(name) && !BINARY_FUNCTIONS.has(name) && !VARIADIC_FUNCTIONS.has(name)) {
      throw fail(`Unknown function “${token.value}”`, token, { code: 'unknown', hint: suggestionHint(token.value, EXPRESSION_FUNCTIONS.map(item => `${item}()`)) });
    }
    cursor++;
    const parameters = nested(() => {
      const list = [];
      if (isOperator(')')) return list;
      for (;;) {
        list.push(conditional());
        if (!isOperator(',')) return list;
        cursor++;
      }
    });
    expect(')', `to close ${name}(`);
    const count = parameters.length;
    const expected = UNARY_FUNCTIONS.has(name) ? 1 : BINARY_FUNCTIONS.has(name) ? 2 : null;
    if (expected !== null && count !== expected) {
      throw fail(`${name}() takes ${expected} argument${expected === 1 ? '' : 's'}, not ${count}`, token, { code: 'arguments' });
    }
    if (expected === null && count < 2) throw fail(`${name}() needs at least 2 arguments, not ${count}`, token, { code: 'arguments' });
    if (UNARY_FUNCTIONS.has(name)) return { type: 'function', name, operand: parameters[0], position: token.position };
    const operator = BINARY_FUNCTIONS.get(name) ?? VARIADIC_FUNCTIONS.get(name);
    return parameters.slice(1).reduce((left, right) => ({ type: 'binary', operator, left, right, position: token.position }), parameters[0]);
  }

  if (peek().type === 'end') throw fail('Enter an expression', peek(), { code: 'empty' });
  const root = conditional();
  if (peek().type !== 'end') {
    const token = peek();
    throw fail(`Unexpected ${describe(token)}`, token, { hint: token.type === 'operator' ? '' : 'Is an operator missing?' });
  }
  const references = [];
  // Iterative traversal: depth and quoted-text rules hold for any accepted input.
  const stack = [[root, 1, null]];
  while (stack.length) {
    const [node, depth, parent] = stack.pop();
    if (depth > MAX_EXPRESSION_DEPTH) throw fail(`Expressions can contain at most ${MAX_EXPRESSION_DEPTH} nested operations`, { position: node.position, length: 1 }, { code: 'limit' });
    if (node.type === 'variable') references.push({ name: node.name, quoted: node.quoted, position: node.position, length: node.length });
    if (node.type === 'string' && !(parent?.type === 'binary' && ['==', '!='].includes(parent.operator)
        && [parent.left, parent.right].some(side => side.type === 'variable'))) {
      throw fail('Quoted text can only be compared with Type', node, { code: 'type', hint: 'For example: Type == "Ni".' });
    }
    for (const child of [node.operand, node.left, node.right, node.condition, node.whenTrue, node.whenFalse]) {
      if (child) stack.push([child, depth + 1, node]);
    }
  }
  return Object.freeze({ text, root, references: Object.freeze(references) });
}

// Names of built-in quantities. Lookups are case-insensitive; the first name
// is the canonical spelling shown in suggestions and documentation.
const ATOM_BUILTINS = [
  ...['X', 'Y', 'Z'].map((axis, index) => ({ names: [`Position.${axis}`], source: 'positions', axis: index })),
  ...['X', 'Y', 'Z'].map((axis, index) => ({ names: [`ReducedPosition.${axis}`], source: 'fractional', axis: index })),
  { names: ['Type', 'ParticleType'], source: 'type' },
  { names: ['ID', 'ParticleIdentifier'], source: 'id' },
  { names: ['Index', 'ParticleIndex'], source: 'index' },
  ...['X', 'Y', 'Z'].map((axis, index) => ({ names: [`Velocity.${axis}`], source: 'velocity', axis: index })),
  { names: ['Velocity.Magnitude'], source: 'speed' },
];
const SCALAR_BUILTINS = ['N', 'CellVolume', 'CellLength.A', 'CellLength.B', 'CellLength.C', 'Timestep', 'Frame', 'pi', 'inf'];
/** Short names for analysis outputs, used only when no column has that name. */
export const EXPRESSION_ALIASES = Object.freeze(new Map([['csp', 'centralSymmetry'], ['centrosymmetry', 'centralSymmetry']]));
export const EXPRESSION_BUILTIN_NAMES = Object.freeze([...ATOM_BUILTINS.flatMap(entry => entry.names), ...SCALAR_BUILTINS]);
const RESERVED = new Set([...EXPRESSION_BUILTIN_NAMES, ...EXPRESSION_ALIASES.keys()].map(name => name.toLowerCase()));

/** Built-in variable names and aliases cannot name computed properties. */
export function isReservedExpressionName(name) { return RESERVED.has(String(name).toLowerCase()); }

/** LAMMPS numbers types itself; labels "Type 3" keep that number. Element
 * names and mixed labels use their 1-based order in the frame's type list. */
export function expressionTypeNumbers(typeLabels = []) {
  const numeric = typeLabels.map(label => /^Type (\d+)$/.exec(label));
  return typeLabels.length && numeric.every(Boolean) ? numeric.map(match => Number(match[1])) : typeLabels.map((_, index) => index + 1);
}

const derivedCache = new WeakMap();
function derived(owner, key, create) {
  let entries = derivedCache.get(owner);
  if (!entries) derivedCache.set(owner, entries = new Map());
  if (!entries.has(key)) entries.set(key, create());
  return entries.get(key);
}

/** Variables of one frame. `properties` defaults to every frame property;
 * computed properties pass the ones that precede them. */
export function createExpressionScope(frame, { properties = frame?.properties ?? [] } = {}) {
  const count = frame?.ids?.length ?? 0;
  if (!Number.isSafeInteger(count) || count < 1) throw new ExpressionError('Open a structure before evaluating expressions', { code: 'frame' });
  const velocity = importedVectorComponents(frame, 'velocity');
  const hasVelocity = Boolean(velocity?.every(property => property.data?.length === count));
  const builtins = new Map();
  for (const entry of ATOM_BUILTINS) {
    if ((entry.source === 'velocity' || entry.source === 'speed') && !hasVelocity) continue;
    for (const name of entry.names) builtins.set(name.toLowerCase(), { ...entry, name: entry.names[0] });
  }
  for (const name of SCALAR_BUILTINS) builtins.set(name.toLowerCase(), { name, scalar: true });
  const usable = properties.filter(property => property?.data?.length === count && typeof property.name === 'string');
  const exact = new Map(), folded = new Map();
  for (const property of usable) {
    if (!exact.has(property.name)) exact.set(property.name, property);
    const key = property.name.toLowerCase();
    folded.set(key, [...(folded.get(key) ?? []), property]);
  }
  const typeLabels = frame.typeLabels ?? [];
  const lengths = [0, 3, 6].map(offset => Math.hypot(frame.cell.vectors[offset], frame.cell.vectors[offset + 1], frame.cell.vectors[offset + 2]));
  const scalarValues = new Map([['n', count], ['cellvolume', Math.abs(determinant3(frame.cell.vectors))],
    ['celllength.a', lengths[0]], ['celllength.b', lengths[1]], ['celllength.c', lengths[2]],
    ['timestep', Number.isFinite(frame.timestep) ? frame.timestep : typeof frame.timestep === 'bigint' ? Number(frame.timestep) : NaN],
    ['frame', Number.isSafeInteger(frame.frameIndex) ? frame.frameIndex : 0], ['pi', Math.PI], ['inf', Infinity]]);

  function atom(name, inputs, load, extra = {}) { return { kind: 'atom', name, inputs, load, ...extra }; }
  function bindBuiltin(entry) {
    if (entry.scalar) {
      const value = scalarValues.get(entry.name.toLowerCase());
      return { kind: 'scalar', name: entry.name, value, inputs: [value] };
    }
    switch (entry.source) {
      case 'positions': case 'fractional': {
        const data = frame[entry.source];
        return atom(entry.name, [data], () => ({ data, stride: 3, offset: entry.axis }));
      }
      case 'type': {
        const types = frame.types;
        return atom(entry.name, [types, typeLabels.length, ...typeLabels], () => {
          const numbers = expressionTypeNumbers(typeLabels);
          const data = derived(types, `type:${JSON.stringify(numbers)}`, () => Float64Array.from(types, type => numbers[type] ?? NaN));
          return { data, stride: 1, offset: 0 };
        }, { types, typeLabels });
      }
      case 'id': {
        const ids = frame.ids;
        return atom(entry.name, [ids], () => ({ data: derived(ids, 'id', () => Float64Array.from(ids, id => {
          const value = typeof id === 'bigint' ? Number(id) : canonicalAtomNumber(id);
          return value === undefined ? NaN : value;
        })), stride: 1, offset: 0 }));
      }
      case 'index':
        return atom(entry.name, [count], () => ({ data: derived(frame.ids, `index:${count}`, () => Float64Array.from({ length: count }, (_, index) => index)), stride: 1, offset: 0 }));
      case 'velocity': {
        const data = velocity[entry.axis].data;
        return atom(entry.name, [data], () => ({ data, stride: 1, offset: 0 }));
      }
      default: {
        const sources = velocity.map(property => property.data);
        return atom(entry.name, sources, () => ({ data: derived(sources[0], 'speed', () => {
          const data = new Float64Array(count);
          for (let index = 0; index < count; index++) data[index] = Math.hypot(sources[0][index], sources[1][index], sources[2][index]);
          return data;
        }), stride: 1, offset: 0 }));
      }
    }
  }
  function bindProperty(property) {
    return atom(property.name, [property.data], () => ({ data: property.data, stride: 1, offset: 0 }), { property });
  }
  function propertyByName(name) {
    if (exact.has(name)) return exact.get(name);
    const matches = folded.get(name.toLowerCase()) ?? [];
    if (matches.length > 1) return { ambiguous: matches.map(property => property.name) };
    return matches[0] ?? null;
  }

  return Object.freeze({
    count, frame, typeLabels,
    /** A binding, `{ ambiguous: names }`, or null. Quoted names only name columns. */
    resolve(name, { quoted = false } = {}) {
      const lower = name.toLowerCase();
      if (!quoted && builtins.has(lower)) return bindBuiltin(builtins.get(lower));
      let property = propertyByName(name);
      if (!property && !quoted && EXPRESSION_ALIASES.has(lower)) property = propertyByName(EXPRESSION_ALIASES.get(lower));
      if (property?.ambiguous) return property;
      return property ? bindProperty(property) : null;
    },
    /** Variable names in this frame, built-ins first. */
    names() {
      const seen = new Set(), result = [];
      for (const { name } of builtins.values()) if (!seen.has(name)) { seen.add(name); result.push(name); }
      for (const property of usable) if (!seen.has(property.name)) { seen.add(property.name); result.push(property.name); }
      for (const [alias, target] of EXPRESSION_ALIASES) if (folded.has(target.toLowerCase())) result.push(alias.toUpperCase());
      return result;
    },
    hasVelocity,
  });
}

/** Resolve names against a scope. Unknown variables list close matches. */
export function bindExpression(parsed, scope, { strictTypeLabels = false } = {}) {
  const text = parsed.text, inputs = [];
  const fail = (message, node, options = {}) => new ExpressionError(message, { position: node.position, length: node.length ?? 1, text, ...options });
  function variable(node) {
    const binding = scope.resolve(node.name, { quoted: node.quoted });
    if (binding?.ambiguous) {
      throw fail(`“${node.name}” matches several properties (${binding.ambiguous.join(', ')})`, node,
        { code: 'ambiguous', hint: 'Write the name with its exact capitalization.' });
    }
    if (binding) { inputs.push(...binding.inputs); return binding; }
    const lower = node.name.toLowerCase();
    if (!node.quoted && lower.startsWith('velocity.') && ATOM_BUILTINS.some(entry => entry.names[0].toLowerCase() === lower)) {
      throw fail(`${node.name} requires imported velocity components such as vx, vy and vz`, node, { code: 'missing' });
    }
    const target = EXPRESSION_ALIASES.get(lower);
    throw fail(`Unknown ${node.quoted ? 'property' : 'variable'} “${node.name}”`, node, {
      code: target && !node.quoted ? 'missing' : 'unknown',
      hint: target && !node.quoted ? `${node.name} reads ${target}; calculate it first.` : suggestionHint(node.name, scope.names()),
    });
  }
  function bind(node) {
    switch (node.type) {
      case 'number': return { type: 'constant', value: node.value };
      case 'variable': {
        const binding = variable(node);
        return binding.kind === 'scalar' ? { type: 'constant', value: binding.value } : { type: 'atom', binding };
      }
      case 'unary': {
        const operand = bind(node.operand);
        if (node.operator === '+') return operand;
        return fold({ type: 'unary', operator: node.operator, operand });
      }
      case 'function': return fold({ type: 'function', name: node.name, apply: UNARY_FUNCTIONS.get(node.name), operand: bind(node.operand) });
      case 'conditional': return fold({ type: 'conditional', condition: bind(node.condition), whenTrue: bind(node.whenTrue), whenFalse: bind(node.whenFalse) });
      case 'binary': {
        const text = [node.left, node.right].find(side => side.type === 'string');
        if (text) return typeMatch(node, text, text === node.left ? node.right : node.left);
        return fold({ type: 'binary', operator: node.operator, left: bind(node.left), right: bind(node.right) });
      }
      default: throw fail('Quoted text can only be compared with Type', node, { code: 'type' });
    }
  }
  function typeMatch(node, label, other) {
    const binding = other.type === 'variable' ? variable(other) : null;
    if (!binding?.types) throw fail('Quoted text can only be compared with Type', label, { code: 'type', hint: 'For example: Type == "Ni".' });
    const labels = binding.typeLabels;
    let lookup = Uint8Array.from(labels, item => item === label.value ? 1 : 0);
    if (!lookup.includes(1)) lookup = Uint8Array.from(labels, item => item.toLowerCase() === label.value.toLowerCase() ? 1 : 0);
    if (strictTypeLabels && !lookup.includes(1)) {
      throw fail(`No atom type is named “${label.value}” in this frame`, label, { code: 'type', hint: labels.length ? `Types: ${labels.slice(0, 12).join(', ')}${labels.length > 12 ? ', …' : ''}.` : '' });
    }
    return { type: 'typeMatch', binding, lookup, negate: node.operator === '!=' };
  }
  const root = bind(parsed.root);
  return Object.freeze({ root, inputs: Object.freeze(inputs), count: scope.count, text });
}

/** Evaluate to a fresh per-atom Float64Array. Scalars fill every atom. */
export function evaluateExpression(bound) {
  const context = evaluationContext(bound.count);
  const result = run(bound.root, context);
  if (typeof result === 'number') return new Float64Array(bound.count).fill(result);
  if (result.owned) return result.data;
  const output = new Float64Array(bound.count);
  const { data, stride, offset } = result;
  for (let index = 0; index < output.length; index++) output[index] = data[offset + index * stride];
  return output;
}

/** Atoms whose value is true: nonzero and not NaN. */
export function evaluateSelection(bound) {
  const values = evaluateExpression(bound);
  const mask = new Uint8Array(bound.count);
  for (let index = 0; index < mask.length; index++) { const value = values[index]; mask[index] = value !== 0 && value === value ? 1 : 0; }
  return mask;
}

/** Parse, bind and evaluate against one frame. */
export function compileFrameExpression(text, frame, options = {}) {
  const parsed = parseExpression(text);
  return bindExpression(parsed, createExpressionScope(frame, options), options);
}

function evaluationContext(count) {
  const free = [];
  return {
    count,
    take: () => free.pop() ?? new Float64Array(count),
    release(value) { if (value?.owned) free.push(value.data); },
  };
}

function constantVector(value) { return { data: Float64Array.of(value), stride: 0, offset: 0, owned: false }; }
function owned(data) { return { data, stride: 1, offset: 0, owned: true }; }

/** Constant subexpressions are evaluated once with the same loops. */
function fold(node) {
  const children = [node.operand, node.left, node.right, node.condition, node.whenTrue, node.whenFalse].filter(Boolean);
  if (!children.every(child => child.type === 'constant')) return node;
  const value = run(node, evaluationContext(1));
  return { type: 'constant', value: typeof value === 'number' ? value : value.data[value.offset] };
}

function run(node, context) {
  switch (node.type) {
    case 'constant': return node.value;
    case 'atom': { const { data, stride, offset } = node.binding.load(); return { data, stride, offset, owned: false }; }
    case 'typeMatch': {
      const output = context.take(), types = node.binding.types, lookup = node.lookup, negate = node.negate ? 1 : 0;
      for (let index = 0; index < context.count; index++) output[index] = (lookup[types[index]] | 0) ^ negate;
      return owned(output);
    }
    case 'unary': case 'function': {
      const operand = vector(run(node.operand, context));
      const output = operand.owned ? operand.data : context.take();
      const { data, stride, offset } = operand, count = context.count;
      if (node.type === 'function') {
        const apply = node.apply;
        for (let index = 0; index < count; index++) output[index] = apply(data[offset + index * stride]);
      } else if (node.operator === '-') {
        for (let index = 0; index < count; index++) output[index] = -data[offset + index * stride];
      } else {
        for (let index = 0; index < count; index++) { const value = data[offset + index * stride]; output[index] = value !== 0 && value === value ? 0 : 1; }
      }
      return owned(output);
    }
    case 'binary': {
      const left = vector(run(node.left, context)), right = vector(run(node.right, context));
      const output = left.owned ? left.data : right.owned ? right.data : context.take();
      binaryLoop(node.operator, output, left, right, context.count);
      if (left.owned && right.owned) context.release(right);
      return owned(output);
    }
    case 'conditional': {
      const condition = vector(run(node.condition, context)), whenTrue = vector(run(node.whenTrue, context)), whenFalse = vector(run(node.whenFalse, context));
      const candidates = [condition, whenTrue, whenFalse];
      const target = candidates.find(item => item.owned);
      const output = target ? target.data : context.take();
      const c = condition.data, cs = condition.stride, co = condition.offset;
      const t = whenTrue.data, ts = whenTrue.stride, to = whenTrue.offset;
      const f = whenFalse.data, fs = whenFalse.stride, fo = whenFalse.offset;
      for (let index = 0; index < context.count; index++) {
        const value = c[co + index * cs];
        output[index] = value !== 0 && value === value ? t[to + index * ts] : f[fo + index * fs];
      }
      for (const item of candidates) if (item !== target) context.release(item);
      return owned(output);
    }
    default: throw new Error(`Internal expression node ${node.type}.`);
  }
}

function vector(value) { return typeof value === 'number' ? constantVector(value) : value; }

// One loop per operator keeps the inner loop free of per-element dispatch.
// Scalars are length-1 arrays read with stride 0.
function binaryLoop(operator, output, left, right, count) {
  const a = left.data, as = left.stride, ao = left.offset, b = right.data, bs = right.stride, bo = right.offset;
  switch (operator) {
    case '+': for (let i = 0; i < count; i++) output[i] = a[ao + i * as] + b[bo + i * bs]; return;
    case '-': for (let i = 0; i < count; i++) output[i] = a[ao + i * as] - b[bo + i * bs]; return;
    case '*': for (let i = 0; i < count; i++) output[i] = a[ao + i * as] * b[bo + i * bs]; return;
    case '/': for (let i = 0; i < count; i++) output[i] = a[ao + i * as] / b[bo + i * bs]; return;
    case '%': for (let i = 0; i < count; i++) output[i] = a[ao + i * as] % b[bo + i * bs]; return;
    case '^': for (let i = 0; i < count; i++) output[i] = Math.pow(a[ao + i * as], b[bo + i * bs]); return;
    case 'atan2': for (let i = 0; i < count; i++) output[i] = Math.atan2(a[ao + i * as], b[bo + i * bs]); return;
    case 'min': for (let i = 0; i < count; i++) output[i] = Math.min(a[ao + i * as], b[bo + i * bs]); return;
    case 'max': for (let i = 0; i < count; i++) output[i] = Math.max(a[ao + i * as], b[bo + i * bs]); return;
    // Every comparison involving NaN is false, including !=.
    case '<': for (let i = 0; i < count; i++) output[i] = a[ao + i * as] < b[bo + i * bs] ? 1 : 0; return;
    case '<=': for (let i = 0; i < count; i++) output[i] = a[ao + i * as] <= b[bo + i * bs] ? 1 : 0; return;
    case '>': for (let i = 0; i < count; i++) output[i] = a[ao + i * as] > b[bo + i * bs] ? 1 : 0; return;
    case '>=': for (let i = 0; i < count; i++) output[i] = a[ao + i * as] >= b[bo + i * bs] ? 1 : 0; return;
    case '==': for (let i = 0; i < count; i++) output[i] = a[ao + i * as] === b[bo + i * bs] ? 1 : 0; return;
    case '!=': for (let i = 0; i < count; i++) { const x = a[ao + i * as], y = b[bo + i * bs]; output[i] = x !== y && x === x && y === y ? 1 : 0; } return;
    case '&&': for (let i = 0; i < count; i++) { const x = a[ao + i * as], y = b[bo + i * bs]; output[i] = x !== 0 && x === x && y !== 0 && y === y ? 1 : 0; } return;
    case '||': for (let i = 0; i < count; i++) { const x = a[ao + i * as], y = b[bo + i * bs]; output[i] = (x !== 0 && x === x) || (y !== 0 && y === y) ? 1 : 0; } return;
    default: throw new Error(`Internal expression operator ${operator}.`);
  }
}

/** Up to five candidates by edit distance, prefix or substring. */
export function closeMatches(name, candidates, limit = 5) {
  const target = String(name).toLowerCase();
  const scored = [];
  for (const candidate of new Set(candidates)) {
    const lower = candidate.toLowerCase();
    const distance = editDistance(target, lower);
    const related = lower.includes(target) || (target.length >= 3 && target.includes(lower) && lower.length >= 3);
    if (distance <= Math.max(1, Math.floor(target.length / 3)) || related) scored.push([related ? Math.min(distance, 1) : distance, candidate]);
  }
  return scored.sort((first, second) => first[0] - second[0] || first[1].localeCompare(second[1], 'en')).slice(0, limit).map(([, candidate]) => candidate);
}

function suggestionHint(name, candidates) {
  const matches = closeMatches(name, candidates);
  return matches.length ? `Did you mean ${matches.join(', ')}?` : '';
}

/** Optimal string alignment distance: a swapped pair counts as one edit. */
function editDistance(first, second) {
  if (Math.abs(first.length - second.length) > 8) return Infinity;
  const rows = [Array.from({ length: second.length + 1 }, (_, index) => index)];
  for (let row = 1; row <= first.length; row++) {
    const current = rows[row] = [row];
    for (let column = 1; column <= second.length; column++) {
      const cost = first[row - 1] === second[column - 1] ? 0 : 1;
      current[column] = Math.min(rows[row - 1][column] + 1, current[column - 1] + 1, rows[row - 1][column - 1] + cost);
      if (row > 1 && column > 1 && first[row - 1] === second[column - 2] && first[row - 2] === second[column - 1]) {
        current[column] = Math.min(current[column], rows[row - 2][column - 2] + 1);
      }
    }
  }
  return rows[first.length][second.length];
}
