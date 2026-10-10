/** Command scripts: a small line-oriented language over the keyboard command
 * registry.
 *
 *   # comment
 *   command argument "quoted argument" 12.5
 *   repeat 4
 *     camera orbit 90 0
 *   end
 *
 * A script is tokenized, compiled against a fixed command table into inert
 * instruction records, and executed by a switch over those records. Script
 * text is never evaluated as code: names are looked up in Maps and Sets,
 * arguments are numbers, quoted strings or words checked against each
 * command's schema, and the only effects are the host callbacks listed in
 * runScript(). Sizes, loops, waits, exports and run time are bounded. */

export const SCRIPT_LIMITS = Object.freeze({
  maxLength: 20_000,
  maxLines: 2_000,
  maxLineLength: 400,
  maxArguments: 24,
  maxStringLength: 256,
  maxRepeatCount: 10_000,
  maxRepeatDepth: 8,
  maxCommands: 100_000,
  maxWaitSeconds: 60,
  maxRunSeconds: 1_800,
  maxExports: 100,
});
export const MAX_SCRIPT_PROBLEMS = 50;
export const SCRIPT_VIEWS = Object.freeze(['front', 'back', 'left', 'right', 'top', 'bottom']);
export const SCRIPT_PROJECTIONS = Object.freeze(['perspective', 'orthographic']);
export const DEFAULT_SCRIPT_GEAR = 5;
const DEGREES = Math.PI / 180;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.()+-]{0,99}$/;

/** A problem at a 1-based line and column; position is the 0-based offset in
 * the script text and length the number of characters to highlight. */
export class ScriptError extends Error {
  constructor(message, where = {}) {
    super(message);
    this.name = 'ScriptError';
    this.line = where.line ?? null; this.column = where.column ?? null;
    this.position = where.position ?? null; this.length = Math.max(1, where.length ?? 1);
    this.detail = message;
  }
}

function problem(message, where) {
  return { message, line: where.line, column: where.column, position: where.position, length: Math.max(1, where.length ?? 1) };
}
const located = (message, where) => new ScriptError(message, where);

/** Split one line into word, number and string tokens. Throws ScriptError. */
function tokenizeLine(text, line, offset) {
  const tokens = [];
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (character === ' ' || character === '\t') { index++; continue; }
    if (character === '#') break;
    const where = { line, column: index + 1, position: offset + index };
    if (character === '"') {
      let value = '', cursor = index + 1, closed = false;
      for (; cursor < text.length; cursor++) {
        const next = text[cursor];
        if (next === '\\') {
          const escaped = text[cursor + 1];
          if (escaped !== '"' && escaped !== '\\') throw located('Only \\" and \\\\ are escapes inside quotes.', { line, column: cursor + 1, position: offset + cursor, length: 2 });
          value += escaped; cursor++;
        } else if (next === '"') { closed = true; break; } else value += next;
      }
      if (!closed) throw located('This quoted text has no closing quote.', { ...where, length: text.length - index });
      const length = cursor + 1 - index;
      if (value.length > SCRIPT_LIMITS.maxStringLength) throw located(`Quoted text is limited to ${SCRIPT_LIMITS.maxStringLength} characters.`, { ...where, length });
      const after = text[cursor + 1];
      if (after !== undefined && after !== ' ' && after !== '\t' && after !== '#') throw located('Put a space after the closing quote.', { line, column: cursor + 2, position: offset + cursor + 1 });
      tokens.push({ type: 'string', value, raw: text.slice(index, cursor + 1), ...where, length });
      index = cursor + 1;
      continue;
    }
    let end = index;
    while (end < text.length && text[end] !== ' ' && text[end] !== '\t' && text[end] !== '#' && text[end] !== '"') end++;
    if (text[end] === '"') throw located('Put a space before a quoted argument.', { line, column: end + 1, position: offset + end });
    const raw = text.slice(index, end);
    if (raw.length > SCRIPT_LIMITS.maxStringLength) throw located(`Arguments are limited to ${SCRIPT_LIMITS.maxStringLength} characters.`, { ...where, length: raw.length });
    if (NUMBER.test(raw)) {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw located(`${raw} is not a finite number.`, { ...where, length: raw.length });
      tokens.push({ type: 'number', value, raw, ...where, length: raw.length });
    } else tokens.push({ type: 'word', value: raw, raw, ...where, length: raw.length });
    index = end;
  }
  return tokens;
}

function numberArgument(token, name, { minimum = -Infinity, maximum = Infinity, integer = false, nonzero = false } = {}) {
  if (token.type !== 'number') throw located(`${name} must be a number, not “${token.raw}”.`, token);
  const value = token.value;
  if ((integer && !Number.isSafeInteger(value)) || value < minimum || value > maximum || (nonzero && value === 0)) {
    throw located(`${name} must be ${integer ? 'a whole number' : 'a number'} from ${minimum} to ${maximum}${nonzero ? ', not 0' : ''}.`, token);
  }
  return value;
}

function choiceArgument(token, name, choices) {
  if (token.type === 'number' || !choices.includes(token.value)) throw located(`${name} must be one of: ${choices.join(', ')}.`, token);
  return token.value;
}

function textArgument(token, name) {
  if (token.type === 'number') return token.raw;
  if (!token.value.length) throw located(`${name} is empty.`, token);
  return token.value;
}

function expectCount(statement, minimum, maximum, usage) {
  const count = statement.args.length;
  if (count < minimum) throw located(`Usage: ${usage}`, { ...statement.nameToken, length: statement.length });
  if (count > maximum) throw located(`Too many arguments. Usage: ${usage}`, statement.args[maximum]);
}

const CAMERA_SET_KEYS = Object.freeze({
  azimuth: { count: 1, read: ([token]) => ({ yaw: numberArgument(token, 'azimuth', { minimum: -36000, maximum: 36000 }) * DEGREES }) },
  elevation: { count: 1, read: ([token]) => ({ pitch: numberArgument(token, 'elevation', { minimum: -36000, maximum: 36000 }) * DEGREES }) },
  roll: { count: 1, read: ([token]) => ({ roll: numberArgument(token, 'roll', { minimum: -36000, maximum: 36000 }) * DEGREES }) },
  distance: { count: 1, read: ([token]) => ({ distance: numberArgument(token, 'distance', { minimum: 0.02, maximum: 1e9 }) }) },
  fov: { count: 1, read: ([token]) => ({ fov: numberArgument(token, 'fov', { minimum: 1, maximum: 175 }) * DEGREES }) },
  'field-height': { count: 1, read: ([token]) => ({ orthographicScale: numberArgument(token, 'field-height', { minimum: 0.001, maximum: 1e9 }) / 2 }) },
  center: { count: 3, read: tokens => ({ center: tokens.map((token, axis) => numberArgument(token, `center ${'xyz'[axis]}`, { minimum: -1e9, maximum: 1e9 })) }) },
  projection: { count: 1, read: ([token]) => ({ projectionMode: choiceArgument(token, 'projection', SCRIPT_PROJECTIONS) }) },
  upright: { count: 1, read: ([token]) => ({ constrainUp: choiceArgument(token, 'upright', ['on', 'off']) === 'on' }) },
});

/** Built-in commands. compile() validates one statement and returns an inert
 * instruction; the interpreter decides what each instruction does. */
const BUILTIN_COMMANDS = new Map([
  ['frame', { usage: 'frame <n|first|last|next|prev>', summary: 'Show a trajectory frame (numbered from 1) and wait for its analyses.',
    compile(statement) {
      expectCount(statement, 1, 1, this.usage);
      const [token] = statement.args;
      if (token.type === 'number') return { op: 'frame', target: 'index', index: numberArgument(token, 'The frame number', { minimum: 1, maximum: 1e9, integer: true }) - 1 };
      return { op: 'frame', target: choiceArgument(token, 'The frame', ['first', 'last', 'next', 'prev']) };
    } }],
  ['camera', { usage: 'camera <view|reset|orbit|roll|zoom|pan|set> …', summary: 'Move the camera; see the camera commands below.',
    compile(statement) {
      expectCount(statement, 1, Infinity, this.usage);
      const [action, ...rest] = statement.args;
      const count = (minimum, maximum, usage) => expectCount({ ...statement, args: rest }, minimum, maximum, usage);
      const kind = choiceArgument(action, 'The camera action', ['view', 'reset', 'orbit', 'roll', 'zoom', 'pan', 'set']);
      if (kind === 'view') { count(1, 1, 'camera view <front|back|left|right|top|bottom>'); return { op: 'view', view: choiceArgument(rest[0], 'The view', SCRIPT_VIEWS) }; }
      if (kind === 'reset') { count(0, 0, 'camera reset'); return { op: 'camera-reset' }; }
      if (kind === 'orbit') {
        count(2, 2, 'camera orbit <azimuth°> <elevation°>');
        return { op: 'orbit', yaw: numberArgument(rest[0], 'The azimuth change', { minimum: -3600, maximum: 3600 }) * DEGREES,
          pitch: numberArgument(rest[1], 'The elevation change', { minimum: -3600, maximum: 3600 }) * DEGREES };
      }
      if (kind === 'roll') { count(1, 1, 'camera roll <degrees>'); return { op: 'roll', angle: numberArgument(rest[0], 'The roll', { minimum: -3600, maximum: 3600 }) * DEGREES }; }
      if (kind === 'zoom') { count(1, 1, 'camera zoom <factor>'); return { op: 'zoom', factor: numberArgument(rest[0], 'The zoom factor', { minimum: 0.01, maximum: 100 }) }; }
      if (kind === 'pan') {
        count(2, 2, 'camera pan <right> <up>');
        return { op: 'pan', right: numberArgument(rest[0], 'The pan to the right', { minimum: -1e6, maximum: 1e6 }),
          up: numberArgument(rest[1], 'The pan upward', { minimum: -1e6, maximum: 1e6 }) };
      }
      count(2, Infinity, 'camera set <azimuth|elevation|roll|distance|fov|field-height|center|projection|upright> <value> …');
      const patch = {}, seen = new Set();
      for (let index = 0; index < rest.length;) {
        const key = rest[index];
        const definition = key.type === 'word' && Object.hasOwn(CAMERA_SET_KEYS, key.value) ? CAMERA_SET_KEYS[key.value] : null;
        if (!definition) throw located(`“${key.raw}” is not a camera setting. Use ${Object.keys(CAMERA_SET_KEYS).join(', ')}.`, key);
        if (seen.has(key.value)) throw located(`${key.value} is set twice.`, key);
        seen.add(key.value);
        const values = rest.slice(index + 1, index + 1 + definition.count);
        if (values.length < definition.count) throw located(`${key.value} needs ${definition.count} value${definition.count > 1 ? 's' : ''}.`, key);
        Object.assign(patch, definition.read(values));
        index += 1 + definition.count;
      }
      if (patch.constrainUp === true && patch.roll !== undefined && patch.roll !== 0) throw located('A roll needs “upright off”.', rest.find(token => token.value === 'roll'));
      if (patch.constrainUp === true && patch.pitch !== undefined && Math.abs(patch.pitch) > Math.PI / 2 + 1e-12) {
        throw located('With “upright on” the elevation must be from −90 to 90.', rest.find(token => token.value === 'elevation'));
      }
      // A roll is only visible once the upright constraint is released.
      if (patch.roll !== undefined && patch.roll !== 0 && patch.constrainUp === undefined) patch.constrainUp = false;
      return { op: 'camera-set', patch };
    } }],
  ['projection', { usage: 'projection <perspective|orthographic>', summary: 'Choose the projection.',
    compile(statement) { expectCount(statement, 1, 1, this.usage); return { op: 'projection', mode: choiceArgument(statement.args[0], 'The projection', SCRIPT_PROJECTIONS) }; } }],
  ['gear', { usage: 'gear <0–9>', summary: 'Step size for the keyboard commands in this script; 5 is 1×, each gear doubles.',
    compile(statement) { expectCount(statement, 1, 1, this.usage); return { op: 'gear', gear: numberArgument(statement.args[0], 'The gear', { minimum: 0, maximum: 9, integer: true }) }; } }],
  ['wait', { usage: 'wait <seconds>', summary: `Pause for up to ${SCRIPT_LIMITS.maxWaitSeconds} seconds.`,
    compile(statement) { expectCount(statement, 1, 1, this.usage); return { op: 'wait', seconds: numberArgument(statement.args[0], 'The wait', { minimum: 0, maximum: SCRIPT_LIMITS.maxWaitSeconds }) }; } }],
  ['wait-analyses', { usage: 'wait-analyses', summary: 'Wait until the analyses of the displayed frame have finished.',
    compile(statement) { expectCount(statement, 0, 0, this.usage); return { op: 'wait-analyses' }; } }],
  ['color-by', { usage: 'color-by <quantity>', summary: 'Color atoms by a quantity of the Color by list, such as type, coordination or "c_pe".',
    compile(statement) { expectCount(statement, 1, 1, this.usage); return { op: 'color-by', quantity: textArgument(statement.args[0], 'The quantity') }; } }],
  ['tool', { usage: 'tool <id|none>', summary: 'Open a tool panel, or close the open one.',
    compile(statement, context) {
      expectCount(statement, 1, 1, this.usage);
      const [token] = statement.args, id = textArgument(token, 'The tool');
      if (id !== 'none' && context.tools && !context.tools.has(id)) throw located(`Unknown tool “${id}”. Tools: ${[...context.tools].join(', ')}, none.`, token);
      return { op: 'tool', tool: id };
    } }],
  ['slice', { usage: 'slice step <±n>', summary: 'Move the selected cutting plane by n of its steps.',
    compile(statement) {
      expectCount(statement, 2, 2, this.usage);
      choiceArgument(statement.args[0], 'The slice action', ['step']);
      return { op: 'slice-step', count: numberArgument(statement.args[1], 'The number of steps', { minimum: -1000, maximum: 1000, integer: true, nonzero: true }) };
    } }],
  ['export', { usage: 'export png [name]', summary: 'Download a PNG with the current image settings.',
    compile(statement) {
      expectCount(statement, 1, 2, this.usage);
      choiceArgument(statement.args[0], 'The export format', ['png']);
      const token = statement.args[1];
      if (!token) return { op: 'export-png', name: null };
      const name = textArgument(token, 'The file name').replace(/\.png$/i, '');
      if (!FILE_NAME.test(name) || name.includes('..')) throw located('File names use letters, digits, spaces and _ . ( ) + - only, at most 100 characters.', token);
      return { op: 'export-png', name };
    } }],
  ['keyframe', { usage: 'keyframe [seconds|clear]', summary: 'Add the current view to the camera path, at a time or after the last keyframe; clear removes all keyframes.',
    compile(statement) {
      expectCount(statement, 0, 1, this.usage);
      const [token] = statement.args;
      if (!token) return { op: 'keyframe', time: null };
      if (token.type !== 'number') { choiceArgument(token, 'The keyframe argument', ['clear']); return { op: 'keyframe-clear' }; }
      return { op: 'keyframe', time: numberArgument(token, 'The keyframe time', { minimum: 0, maximum: 3600 }) };
    } }],
]);
const STRUCTURE_WORDS = Object.freeze(['repeat', 'end']);

/** Command names and usages for the in-app reference and documentation. */
export function scriptCommandReference() {
  return [...[...BUILTIN_COMMANDS].map(([name, { usage, summary }]) => ({ name, usage, summary })),
    { name: 'repeat', usage: 'repeat <n> … end', summary: `Run the enclosed lines n times (up to ${SCRIPT_LIMITS.maxRepeatCount.toLocaleString('en-US')}, nested up to ${SCRIPT_LIMITS.maxRepeatDepth} deep).` }];
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

function suggestion(name, candidates) {
  let best = null, bestDistance = Math.max(1, Math.floor(name.length / 4)) + 1;
  for (const candidate of candidates) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) { best = candidate; bestDistance = distance; }
  }
  return best;
}

/**
 * Check a script without running it and compile it to instructions.
 * `registry` lists the keyboard command ids that are valid command names and
 * `tools` the tool ids accepted by `tool`. Returns the program, every problem
 * found (one per line at most) and static bounds on what a run can do.
 */
export function compileScript(text, { registry = [], tools = null, limits = SCRIPT_LIMITS } = {}) {
  const problems = [], program = [];
  const stats = { lines: 0, statements: 0, steps: 0, waitSeconds: 0, exports: 0, keyframes: 0 };
  const fail = (message, where) => { if (problems.length < MAX_SCRIPT_PROBLEMS) problems.push(problem(message, where)); };
  if (typeof text !== 'string') { fail('The script is not text.', { line: 1, column: 1, position: 0 }); return { program, problems, stats }; }
  if (text.length > limits.maxLength) {
    fail(`Scripts are limited to ${limits.maxLength.toLocaleString('en-US')} characters; this one has ${text.length.toLocaleString('en-US')}.`, { line: 1, column: 1, position: 0 });
    return { program, problems, stats };
  }
  const registryIds = registry instanceof Set ? registry : new Set(registry);
  const context = { tools: tools === null ? null : tools instanceof Set ? tools : new Set(tools) };
  const names = [...BUILTIN_COMMANDS.keys(), ...STRUCTURE_WORDS, ...registryIds];
  // Each open repeat keeps its own body and the multiplier of its iterations.
  const stack = [{ body: program, multiplier: 1, where: null }];
  let line = 0, offset = 0;
  while (offset <= text.length) {
    let end = offset;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++;
    const content = text.slice(offset, end);
    const next = text[end] === '\r' && text[end + 1] === '\n' ? end + 2 : end + 1;
    line++;
    if (line > limits.maxLines) { fail(`Scripts are limited to ${limits.maxLines.toLocaleString('en-US')} lines.`, { line, column: 1, position: offset }); break; }
    const where = { line, column: 1, position: offset, length: Math.max(1, content.length) };
    try {
      if (content.length > limits.maxLineLength) throw located(`Lines are limited to ${limits.maxLineLength} characters.`, where);
      const control = /[\x00-\x08\x0b-\x1f\x7f]/.exec(content);
      if (control) throw located('Control characters are not allowed in scripts.', { line, column: control.index + 1, position: offset + control.index });
      const tokens = tokenizeLine(content, line, offset);
      if (tokens.length) {
        const [nameToken, ...args] = tokens;
        if (nameToken.type !== 'word') throw located('A line starts with a command name.', nameToken);
        if (args.length > limits.maxArguments) throw located(`Commands take at most ${limits.maxArguments} arguments.`, args[limits.maxArguments]);
        const last = tokens.at(-1);
        const statement = { name: nameToken.value, nameToken, args, line, column: nameToken.column, position: nameToken.position,
          length: last.position + last.length - nameToken.position };
        const top = stack.at(-1);
        stats.statements++;
        if (statement.name === 'repeat') {
          expectCount(statement, 1, 1, 'repeat <n> … end');
          const count = numberArgument(args[0], 'The repeat count', { minimum: 1, maximum: limits.maxRepeatCount, integer: true });
          if (stack.length > limits.maxRepeatDepth) throw located(`Repeats nest at most ${limits.maxRepeatDepth} deep.`, nameToken);
          const instruction = { op: 'repeat', count, body: [], line, column: statement.column, position: statement.position, length: statement.length };
          top.body.push(instruction);
          // One step per iteration, so even empty loops count against the limit.
          stats.steps += top.multiplier * count;
          stack.push({ body: instruction.body, multiplier: top.multiplier * count, where: statement });
        } else if (statement.name === 'end') {
          expectCount(statement, 0, 0, 'end');
          if (stack.length === 1) throw located('This “end” has no matching “repeat”.', nameToken);
          stack.pop();
        } else {
          let instruction;
          // Map lookups: names such as constructor or __proto__ are simply unknown.
          const builtin = BUILTIN_COMMANDS.get(statement.name);
          if (builtin) instruction = builtin.compile(statement, context);
          else if (registryIds.has(statement.name)) {
            expectCount(statement, 0, 0, statement.name);
            instruction = { op: 'registry', id: statement.name };
          } else {
            const hint = suggestion(statement.name, names);
            throw located(`Unknown command “${statement.name}”.${hint ? ` Did you mean “${hint}”?` : ''}`, nameToken);
          }
          Object.assign(instruction, { line, column: statement.column, position: statement.position, length: statement.length });
          top.body.push(instruction);
          stats.steps += top.multiplier;
          if (instruction.op === 'wait') stats.waitSeconds += top.multiplier * instruction.seconds;
          if (instruction.op === 'export-png' || (instruction.op === 'registry' && instruction.id === 'image.png')) stats.exports += top.multiplier;
          if (instruction.op === 'keyframe') stats.keyframes += top.multiplier;
        }
      }
    } catch (error) {
      if (!(error instanceof ScriptError)) throw error;
      fail(error.detail, error);
    }
    offset = next;
  }
  stats.lines = line;
  for (const open of stack.slice(1)) fail('This “repeat” has no matching “end”.', open.where);
  const whole = { line: 1, column: 1, position: 0, length: 1 };
  if (!problems.length) {
    if (stats.steps > limits.maxCommands) fail(`This script would run ${stats.steps.toLocaleString('en-US')} commands; the limit is ${limits.maxCommands.toLocaleString('en-US')}.`, whole);
    if (stats.waitSeconds > limits.maxRunSeconds) fail(`This script waits ${Math.round(stats.waitSeconds).toLocaleString('en-US')} s in total; a run is limited to ${limits.maxRunSeconds.toLocaleString('en-US')} s.`, whole);
    if (stats.exports > limits.maxExports) fail(`This script would download ${stats.exports.toLocaleString('en-US')} images; the limit is ${limits.maxExports} per run.`, whole);
  }
  problems.sort((a, b) => a.position - b.position);
  return { program: problems.length ? [] : program, problems, stats };
}

function abortError() { return new DOMException('The script was stopped.', 'AbortError'); }

function defaultSleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    // A zero wait only yields. A message task, unlike a timer, is not slowed
    // to one per second while the tab is in the background.
    if (milliseconds <= 0 && typeof MessageChannel === 'function') {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = () => { port1.close(); if (signal?.aborted) reject(abortError()); else resolve(); };
      port2.postMessage(null);
      return;
    }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, milliseconds);
    const stop = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Run a compiled program. The host supplies the effects:
 *   command(id, { gear, scale })  a keyboard registry command; false = unavailable
 *   getFrameInfo() → { index, count }, showFrame(index) → shown?, lastFrame() → index
 *   setView(name), resetCamera(), orbit(yaw, pitch), roll(angle), zoom(factor),
 *   pan(right, up), setCamera(patch), setProjection(mode)
 *   colorBy(name), openTool(id), sliceStep(count), exportPng(name),
 *   addKeyframe(time|null), clearKeyframes(), waitForAnalyses({ signal })
 * Angles are radians. Host errors are reported with the line that caused them.
 */
export async function runScript(program, host, { signal = null, limits = SCRIPT_LIMITS, onStep = null,
  now = () => performance.now(), sleep = defaultSleep } = {}) {
  if (!Array.isArray(program)) throw new TypeError('runScript needs a compiled program.');
  const started = now();
  const state = { steps: 0, exports: 0, gear: DEFAULT_SCRIPT_GEAR, lastYield: started };
  const deadline = started + limits.maxRunSeconds * 1000;

  async function checkpoint(instruction) {
    if (signal?.aborted) throw abortError();
    if (++state.steps > limits.maxCommands) throw located(`Stopped after ${limits.maxCommands.toLocaleString('en-US')} commands.`, instruction);
    const time = now();
    if (time > deadline) throw located(`Stopped after ${limits.maxRunSeconds.toLocaleString('en-US')} s, the longest a script may run.`, instruction);
    // Keep the page responsive, and Stop effective, during long loops.
    if (time - state.lastYield > 12) { await sleep(0, signal); state.lastYield = now(); }
  }

  async function frame(instruction) {
    const info = host.getFrameInfo();
    let index;
    if (instruction.target === 'index') index = instruction.index;
    else if (instruction.target === 'first') index = 0;
    else if (instruction.target === 'last') index = await host.lastFrame({ signal });
    else index = info.index + (instruction.target === 'next' ? 1 : -1);
    const count = host.getFrameInfo().count;
    if (index < 0) throw new Error('This is already the first frame.');
    if (index >= count) throw new Error(instruction.target === 'next' ? `This is already the last frame (${count}).` : `Frame ${index + 1} does not exist; the trajectory has ${count} frame${count === 1 ? '' : 's'}.`);
    if (await host.showFrame(index, { signal }) === false) throw new Error(`Frame ${index + 1} could not be shown.`);
  }

  async function exportImage(run) {
    if (++state.exports > limits.maxExports) throw new Error(`A script downloads at most ${limits.maxExports} images per run.`);
    await run();
  }

  async function step(instruction) {
    switch (instruction.op) {
      case 'registry': {
        const scale = 2 ** (state.gear - DEFAULT_SCRIPT_GEAR);
        const run = async () => { if (await host.command(instruction.id, { gear: state.gear, scale, signal }) === false) throw new Error(`“${instruction.id}” is not available now.`); };
        if (instruction.id === 'image.png') await exportImage(run); else await run();
        break;
      }
      case 'frame': await frame(instruction); break;
      case 'view': await host.setView(instruction.view); break;
      case 'camera-reset': await host.resetCamera(); break;
      case 'orbit': await host.orbit(instruction.yaw, instruction.pitch); break;
      case 'roll': await host.roll(instruction.angle); break;
      case 'zoom': await host.zoom(instruction.factor); break;
      case 'pan': await host.pan(instruction.right, instruction.up); break;
      case 'camera-set': await host.setCamera({ ...instruction.patch, ...(instruction.patch.center ? { center: [...instruction.patch.center] } : {}) }); break;
      case 'projection': await host.setProjection(instruction.mode); break;
      case 'gear': state.gear = instruction.gear; break;
      case 'wait': await sleep(instruction.seconds * 1000, signal); state.lastYield = now(); break;
      case 'wait-analyses': await host.waitForAnalyses({ signal }); state.lastYield = now(); break;
      case 'color-by': await host.colorBy(instruction.quantity); break;
      case 'tool': await host.openTool(instruction.tool); break;
      case 'slice-step': await host.sliceStep(instruction.count); break;
      case 'export-png': await exportImage(() => host.exportPng(instruction.name)); break;
      case 'keyframe': await host.addKeyframe(instruction.time); break;
      case 'keyframe-clear': await host.clearKeyframes(); break;
      default: throw new Error('Unknown instruction.');
    }
  }

  async function runBlock(block) {
    for (const instruction of block) {
      await checkpoint(instruction);
      onStep?.({ line: instruction.line, steps: state.steps });
      if (instruction.op === 'repeat') {
        for (let iteration = 0; iteration < instruction.count; iteration++) {
          if (iteration) await checkpoint(instruction);
          await runBlock(instruction.body);
        }
        continue;
      }
      try { await step(instruction); }
      catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw abortError();
        if (error instanceof ScriptError) throw error;
        throw located(error?.message ?? String(error), instruction);
      }
      if (signal?.aborted) throw abortError();
    }
  }

  await runBlock(program);
  return { steps: state.steps, exports: state.exports, elapsedMs: now() - started };
}

/** “Line 3, column 7: message” for status lines and alerts. */
export function formatScriptProblem(error) {
  const detail = error.detail ?? error.message;
  return error.line ? `Line ${error.line}${error.column > 1 ? `, column ${error.column}` : ''}: ${detail}` : detail;
}

export const MAX_SAVED_SCRIPTS = 16;
export const MAX_SCRIPT_NAME_LENGTH = 64;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function createSavedScript({ id = 'script-1', name = 'Script 1', text = '' } = {}) { return { id, name, text }; }

/** Validate saved scripts for a configuration. Text is stored verbatim and is
 * only ever compiled by compileScript(); loading never runs a script. */
export function normalizeScriptState(value, { path = 'settings.extensions.scripts' } = {}) {
  const fail = (where, message) => { throw new Error(`Invalid AlloyView configuration: ${where} ${message}.`); };
  const record = (input, where, keys) => {
    if (input === null || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(where, 'must be an object');
    for (const key of Object.keys(input)) if (FORBIDDEN_KEYS.has(key) || !keys.includes(key)) fail(`${where}.${key}`, 'is not a supported setting');
    return input;
  };
  const input = record(value ?? {}, path, ['scripts', 'selectedId']);
  const scripts = input.scripts ?? [];
  if (!Array.isArray(scripts) || scripts.length > MAX_SAVED_SCRIPTS) fail(`${path}.scripts`, `must contain 0–${MAX_SAVED_SCRIPTS} entries`);
  const normalized = scripts.map((item, index) => {
    const entryPath = `${path}.scripts[${index}]`, entry = record(item, entryPath, ['id', 'name', 'text']);
    const id = entry.id ?? `script-${index + 1}`;
    if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || FORBIDDEN_KEYS.has(id)) fail(`${entryPath}.id`, 'must be a short identifier');
    const name = entry.name ?? `Script ${index + 1}`;
    if (typeof name !== 'string' || !name.trim() || name.length > MAX_SCRIPT_NAME_LENGTH || /[\x00-\x1f\x7f]/.test(name)) {
      fail(`${entryPath}.name`, `must be a name of at most ${MAX_SCRIPT_NAME_LENGTH} characters without control characters`);
    }
    const text = entry.text ?? '';
    if (typeof text !== 'string' || text.length > SCRIPT_LIMITS.maxLength || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) {
      fail(`${entryPath}.text`, `must be text of at most ${SCRIPT_LIMITS.maxLength} characters; only tabs and line breaks are allowed as control characters`);
    }
    return createSavedScript({ id, name, text });
  });
  if (new Set(normalized.map(script => script.id)).size !== normalized.length) fail(`${path}.scripts`, 'contains duplicate IDs');
  const selectedId = input.selectedId ?? normalized[0]?.id ?? null;
  if (selectedId !== null && !normalized.some(script => script.id === selectedId)) fail(`${path}.selectedId`, 'must identify a saved script');
  return { scripts: normalized, selectedId };
}
