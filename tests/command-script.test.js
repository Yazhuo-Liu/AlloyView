import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileScript, formatScriptProblem, MAX_SAVED_SCRIPTS, normalizeScriptState, runScript, scriptCommandReference,
  ScriptError, SCRIPT_LIMITS } from '../src/command-script.js';

const REGISTRY = ['camera.yaw-left', 'camera.zoom-in', 'frames.next', 'image.png', 'interface.theme'];
const TOOLS = ['display', 'slice', 'cna', 'textLabels'];
const compile = (text, options = {}) => compileScript(text, { registry: REGISTRY, tools: TOOLS, ...options });
const DEGREE = Math.PI / 180;

/** A host that records calls; frames behave like a 5-frame trajectory. */
function recorder(overrides = {}) {
  const calls = [], state = { index: 0, count: 5 };
  const record = name => (...args) => { calls.push([name, ...args]); };
  const host = {
    command: (id, context) => { calls.push(['command', id, context.gear, context.scale]); return id !== 'frames.next'; },
    getFrameInfo: () => ({ ...state }), lastFrame: async () => state.count - 1,
    showFrame: async index => { calls.push(['showFrame', index]); state.index = index; return true; },
    setView: record('setView'), resetCamera: record('resetCamera'), orbit: record('orbit'), roll: record('roll'), zoom: record('zoom'),
    pan: record('pan'), setCamera: record('setCamera'), setProjection: record('setProjection'), colorBy: record('colorBy'),
    openTool: record('openTool'), sliceStep: record('sliceStep'), exportPng: record('exportPng'), addKeyframe: record('addKeyframe'),
    clearKeyframes: record('clearKeyframes'), waitForAnalyses: record('waitForAnalyses'), ...overrides,
  };
  return { host, calls, state };
}
const instantSleep = async (_milliseconds, signal) => { if (signal?.aborted) throw new DOMException('stopped', 'AbortError'); };

test('scripts compile to inert instructions for every command, with comments and quoting', () => {
  const { program, problems, stats } = compile([
    '# a comment line', '', '  frame 3   # trailing comment', 'frame last', 'camera view top', 'camera reset', 'camera orbit 90 -10.5',
    'camera roll 15', 'camera zoom 2', 'camera pan 1.5 -2e0', 'projection orthographic', 'gear 7', 'wait 0.25', 'wait-analyses',
    'color-by "Crystal structure (CNA)"', 'color-by c_pe', 'tool cna', 'tool none', 'slice step -2', 'export png', 'export png "view (1).png"',
    'keyframe', 'keyframe 4.5', 'keyframe clear', 'camera.yaw-left', 'interface.theme',
    'camera set azimuth 30 elevation 20 roll 5 distance 40 fov 35 field-height 12 center 1 2 3 projection perspective upright off',
  ].join('\n'));
  assert.deepEqual(problems, []);
  assert.equal(program.length, 25);
  const ops = program.map(instruction => instruction.op);
  assert.deepEqual(ops, ['frame', 'frame', 'view', 'camera-reset', 'orbit', 'roll', 'zoom', 'pan', 'projection', 'gear', 'wait', 'wait-analyses',
    'color-by', 'color-by', 'tool', 'tool', 'slice-step', 'export-png', 'export-png', 'keyframe', 'keyframe', 'keyframe-clear', 'registry', 'registry', 'camera-set']);
  assert.deepEqual({ target: program[0].target, index: program[0].index, line: program[0].line, column: program[0].column }, { target: 'index', index: 2, line: 3, column: 3 });
  assert.equal(program[4].yaw, 90 * DEGREE); assert.equal(program[4].pitch, -10.5 * DEGREE);
  assert.deepEqual([program[7].right, program[7].up], [1.5, -2]);
  assert.equal(program[12].quantity, 'Crystal structure (CNA)');
  assert.equal(program[18].name, 'view (1)');
  assert.deepEqual([program[19].time, program[20].time], [null, 4.5]);
  assert.deepEqual(program[24].patch, { yaw: 30 * DEGREE, pitch: 20 * DEGREE, roll: 5 * DEGREE, distance: 40, fov: 35 * DEGREE,
    orthographicScale: 6, center: [1, 2, 3], projectionMode: 'perspective', constrainUp: false });
  assert.deepEqual(stats, { lines: 27, statements: 25, steps: 25, waitSeconds: 0.25, exports: 2, keyframes: 2 });
  // Instructions are data only: no functions anywhere in a compiled program.
  const walk = value => { assert.notEqual(typeof value, 'function'); if (value && typeof value === 'object') Object.values(value).forEach(walk); };
  walk(program);
  // A roll releases the upright constraint unless the script says otherwise.
  assert.equal(compile('camera set roll 10').program[0].patch.constrainUp, false);
  assert.equal(compile('camera set roll 0').program[0].patch.constrainUp, undefined);
  // CRLF and tab separated input is accepted; positions index the original text.
  const windows = compile('wait 1\r\n\tframe\tnext\r\nbogus');
  assert.deepEqual(windows.problems.map(({ line, column, position, length }) => ({ line, column, position, length })), [{ line: 3, column: 1, position: 21, length: 5 }]);
  assert.equal('wait 1\r\n\tframe\tnext\r\nbogus'.slice(21, 26), 'bogus');
});

test('errors carry line, column, offset and length, one per line, and never produce a program', () => {
  const cases = [
    ['fly away', 1, 1, /Unknown command “fly”/],
    ['camera.yaw-lef', 1, 1, /Did you mean “camera\.yaw-left”/],
    ['frame', 1, 1, /Usage: frame/],
    ['frame 0', 1, 7, /whole number from 1/],
    ['frame 2.5', 1, 7, /whole number/],
    ['frame sideways', 1, 7, /first, last, next, prev/],
    ['frame 1 2', 1, 9, /Too many arguments/],
    ['camera view diagonal', 1, 13, /front, back, left, right, top, bottom/],
    ['camera orbit 10', 1, 1, /camera orbit <azimuth°> <elevation°>/],
    ['camera orbit ten 0', 1, 14, /must be a number, not “ten”/],
    ['camera zoom 0', 1, 13, /0\.01 to 100/],
    ['camera zoom 1e999', 1, 13, /not a finite number/],
    ['camera set bogus 1', 1, 12, /not a camera setting/],
    ['camera set fov 20 fov 30', 1, 19, /set twice/],
    ['camera set center 1 2', 1, 12, /center needs 3 values/],
    ['camera set upright on roll 10', 1, 23, /needs “upright off”/],
    ['camera set upright on elevation 120', 1, 23, /−90 to 90/],
    ['camera set fov 0.5', 1, 16, /from 1 to 175/],
    ['projection isometric', 1, 12, /perspective, orthographic/],
    ['gear 10', 1, 6, /0 to 9/],
    ['wait 61', 1, 6, /0 to 60/],
    ['wait -1', 1, 6, /0 to 60/],
    ['wait-analyses now', 1, 15, /Too many arguments/],
    ['tool warp', 1, 6, /Unknown tool “warp”/],
    ['slice step 0', 1, 12, /not 0/],
    ['slice flip 1', 1, 7, /must be one of: step/],
    ['export jpg', 1, 8, /must be one of: png/],
    ['export png ../secret', 1, 12, /File names use letters/],
    ['export png "a/b"', 1, 12, /File names use letters/],
    ['export png C:\\x', 1, 12, /File names use letters/],
    ['keyframe later', 1, 10, /must be one of: clear/],
    ['keyframe 4000', 1, 10, /0 to 3600/],
    ['camera.yaw-left 3', 1, 17, /Too many arguments/],
    ['color-by "unterminated', 1, 10, /no closing quote/],
    ['color-by "a\\nb"', 1, 12, /Only \\" and \\\\ are escapes/],
    ['color-by "a"b', 1, 13, /space after the closing quote/],
    ['color-by a"b"', 1, 11, /space before a quoted argument/],
    ['"frame" 1', 1, 1, /starts with a command name/],
    ['12 frame', 1, 1, /starts with a command name/],
    ['end', 1, 1, /no matching “repeat”/],
    ['repeat 2\nwait 1', 1, 1, /no matching “end”/],
    ['repeat 0\nend', 1, 8, /1 to 10000/],
    ['repeat\nend', 1, 1, /Usage: repeat/],
    ['wait 1\u0007', 1, 7, /Control characters/],
  ];
  for (const [text, line, column, pattern] of cases) {
    const { program, problems } = compile(text);
    assert.equal(program.length, 0, text);
    assert.ok(problems.length >= 1, text);
    assert.equal(problems[0].line, line, `${text}: line`);
    assert.equal(problems[0].column, column, `${text}: column ${JSON.stringify(problems[0])}`);
    assert.match(problems[0].message, pattern, text);
    assert.ok(problems[0].length >= 1 && Number.isInteger(problems[0].position));
  }
  const several = compile('frame 1\nfoo\n\nbar 2\nwait 1');
  assert.deepEqual(several.problems.map(item => [item.line, item.position]), [[2, 8], [4, 13]]);
  assert.equal(formatScriptProblem(several.problems[1]), 'Line 4: Unknown command “bar”.');
  assert.equal(formatScriptProblem(compile('frame 0').problems[0]), 'Line 1, column 7: The frame number must be a whole number from 1 to 1000000000.');
});

test('script text is data: property names and code are unknown commands or plain arguments', async () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'eval', 'alert(1)', 'window.location']) {
    const { program, problems } = compile(name);
    assert.equal(program.length, 0); assert.match(problems[0].message, /Unknown command/);
  }
  assert.match(compile('camera set constructor 1').problems[0].message, /not a camera setting/);
  assert.match(compile('camera set __proto__ 1').problems[0].message, /not a camera setting/);
  assert.match(compile('tool __proto__').problems[0].message, /Unknown tool/);
  // Code-like text in an argument reaches the host only as a string.
  globalThis.__scriptProbe = 0;
  const { program, problems } = compile('color-by "${globalThis.__scriptProbe = 1}"\ncolor-by `globalThis.__scriptProbe=2`\ncolor-by globalThis.__scriptProbe=3');
  assert.deepEqual(problems, []);
  const { host, calls } = recorder();
  await runScript(program, host, { sleep: instantSleep });
  assert.deepEqual(calls, [['colorBy', '${globalThis.__scriptProbe = 1}'], ['colorBy', '`globalThis.__scriptProbe=2`'], ['colorBy', 'globalThis.__scriptProbe=3']]);
  assert.equal(globalThis.__scriptProbe, 0);
  delete globalThis.__scriptProbe;
  // The module itself contains no dynamic code evaluation.
  const source = await readFile(new URL('../src/command-script.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\beval\s*\(|new\s+Function|\bFunction\s*\(|\bimport\s*\(|setTimeout\s*\(\s*['"`]/);
});

test('size, nesting, loop, wait and export limits are enforced before anything runs', () => {
  assert.match(compile('#'.repeat(SCRIPT_LIMITS.maxLength + 1)).problems[0].message, /limited to 20,000 characters/);
  assert.match(compile('\n'.repeat(SCRIPT_LIMITS.maxLines + 1)).problems[0].message, /limited to 2,000 lines/);
  assert.match(compile(`color-by ${'x'.repeat(SCRIPT_LIMITS.maxLineLength)}`).problems[0].message, /Lines are limited to 400/);
  assert.match(compile(`color-by ${'x'.repeat(SCRIPT_LIMITS.maxStringLength + 1)}`).problems[0].message, /limited to 256 characters/);
  assert.match(compile(`camera set ${'fov 20 '.repeat(13)}`).problems[0].message, /at most 24 arguments/);
  assert.match(compile('repeat 10001\nend').problems[0].message, /1 to 10000/);
  const nest = depth => `${'repeat 1\n'.repeat(depth)}${'end\n'.repeat(depth)}`;
  assert.deepEqual(compile(nest(SCRIPT_LIMITS.maxRepeatDepth)).problems, []);
  const tooDeep = compile(nest(SCRIPT_LIMITS.maxRepeatDepth + 1));
  assert.match(tooDeep.problems[0].message, /nest at most 8 deep/); assert.equal(tooDeep.problems[0].line, 9);
  // Nested loops multiply; even empty loops count once per iteration.
  assert.equal(compile('repeat 100\nrepeat 100\ngear 5\nend\nend').stats.steps, 100 + 100 * 100 + 100 * 100);
  assert.match(compile('repeat 400\nrepeat 400\ngear 5\nend\nend').problems[0].message, /would run 320,400 commands; the limit is 100,000/);
  assert.match(compile('repeat 10000\nrepeat 10000\nend\nend').problems[0].message, /would run 100,010,000 commands/);
  assert.match(compile('repeat 100\nwait 20\nend').problems[0].message, /waits 2,000 s in total/);
  assert.match(compile('repeat 51\nexport png\nimage.png\nend').problems[0].message, /would download 102 images; the limit is 100/);
  assert.deepEqual(compile('repeat 50\nexport png\nimage.png\nend').problems, []);
});

test('the interpreter calls the host in order with script-local gear and awaited frames', async () => {
  const { program, problems } = compile(['gear 7', 'camera.yaw-left', 'gear 5', 'camera.zoom-in', 'frame 2', 'frame next', 'frame prev', 'frame last', 'frame first',
    'repeat 2', '  camera orbit 45 0', '  repeat 2', '    export png shot', '  end', 'end', 'camera set center 1 2 3', 'keyframe', 'keyframe 3', 'keyframe clear',
    'slice step 3', 'wait-analyses', 'tool cna', 'color-by type', 'projection perspective', 'camera view left', 'camera roll -5', 'camera zoom 0.5', 'camera pan 1 2', 'camera reset'].join('\n'));
  assert.deepEqual(problems, []);
  const { host, calls } = recorder();
  const steps = [];
  const result = await runScript(program, host, { sleep: instantSleep, onStep: step => steps.push(step.line) });
  assert.deepEqual(calls, [['command', 'camera.yaw-left', 7, 4], ['command', 'camera.zoom-in', 5, 1], ['showFrame', 1], ['showFrame', 2], ['showFrame', 1],
    ['showFrame', 4], ['showFrame', 0], ['orbit', Math.PI / 4, 0], ['exportPng', 'shot'], ['exportPng', 'shot'], ['orbit', Math.PI / 4, 0], ['exportPng', 'shot'], ['exportPng', 'shot'],
    ['setCamera', { center: [1, 2, 3] }], ['addKeyframe', null], ['addKeyframe', 3], ['clearKeyframes'], ['sliceStep', 3], ['waitForAnalyses', { signal: null }],
    ['openTool', 'cna'], ['colorBy', 'type'], ['setProjection', 'perspective'], ['setView', 'left'], ['roll', -5 * DEGREE], ['zoom', 0.5], ['pan', 1, 2], ['resetCamera']]);
  assert.equal(result.exports, 4);
  assert.equal(result.steps, compile(program.length ? ['gear 7', 'camera.yaw-left', 'gear 5', 'camera.zoom-in', 'frame 2', 'frame next', 'frame prev', 'frame last', 'frame first',
    'repeat 2', 'camera orbit 45 0', 'repeat 2', 'export png shot', 'end', 'end', 'camera set center 1 2 3', 'keyframe', 'keyframe 3', 'keyframe clear',
    'slice step 3', 'wait-analyses', 'tool cna', 'color-by type', 'projection perspective', 'camera view left', 'camera roll -5', 'camera zoom 0.5', 'camera pan 1 2', 'camera reset'].join('\n') : '').stats.steps,
  'the static bound equals the executed count');
  assert.deepEqual(steps.slice(0, 5), [1, 2, 3, 4, 5]);
  // The compiled patch is copied, so a host cannot change the program.
  calls.find(call => call[0] === 'setCamera')[1].center[0] = 99;
  assert.equal(program.find(instruction => instruction.op === 'camera-set').patch.center[0], 1);
});

test('host failures and unavailable commands stop the script with the failing line', async () => {
  const run = async (text, overrides) => {
    const { program, problems } = compile(text); assert.deepEqual(problems, []);
    const { host, calls } = recorder(overrides);
    return { calls, error: await runScript(program, host, { sleep: instantSleep }).then(() => null, error => error) };
  };
  const unavailable = await run('camera.yaw-left\nframes.next\ncamera.zoom-in');
  assert.ok(unavailable.error instanceof ScriptError);
  assert.deepEqual([unavailable.error.line, unavailable.error.column, unavailable.error.position], [2, 1, 16]);
  assert.equal(formatScriptProblem(unavailable.error), 'Line 2: “frames.next” is not available now.');
  assert.equal(unavailable.calls.length, 2, 'the third command never runs');
  assert.match((await run('frame 6')).error.message, /Frame 6 does not exist; the trajectory has 5 frames/);
  assert.match((await run('frame prev')).error.message, /already the first frame/);
  assert.match((await run('frame last\nframe next')).error.message, /already the last frame \(5\)/);
  assert.match((await run('frame 2', { showFrame: async () => false })).error.message, /Frame 2 could not be shown/);
  const thrown = await run('wait 0\n  color-by missing', { colorBy: () => { throw new Error('No color quantity “missing”.'); } });
  assert.deepEqual([thrown.error.line, thrown.error.column, thrown.error.message], [2, 3, 'No color quantity “missing”.']);
  const rejected = await run('export png', { exportPng: async () => { throw new TypeError('canvas lost'); } });
  assert.ok(rejected.error instanceof ScriptError); assert.equal(rejected.error.line, 1);
});

test('run-time limits bound commands, exports and wall time even if the static check is bypassed', async () => {
  const { program } = compile('repeat 50\nexport png\nend');
  const { host, calls } = recorder();
  const exports = await runScript(program, host, { sleep: instantSleep, limits: { ...SCRIPT_LIMITS, maxExports: 3 } }).catch(error => error);
  assert.match(exports.message, /at most 3 images per run/);
  assert.equal(calls.filter(call => call[0] === 'exportPng').length, 3);
  const commands = await runScript(compile('repeat 1000\ngear 5\nend').program, recorder().host, { sleep: instantSleep, limits: { ...SCRIPT_LIMITS, maxCommands: 100 } }).catch(error => error);
  assert.match(commands.message, /Stopped after 100 commands/); assert.equal(commands.line, 1);
  let clock = 0;
  const waits = [];
  const timed = await runScript(compile('repeat 100\nwait 30\nend', { limits: { ...SCRIPT_LIMITS, maxRunSeconds: 1e9 } }).program, recorder().host, {
    now: () => clock, sleep: async milliseconds => { waits.push(milliseconds); clock += milliseconds; }, limits: { ...SCRIPT_LIMITS, maxRunSeconds: 100 } }).catch(error => error);
  assert.match(timed.message, /Stopped after 100 s/);
  assert.equal(waits.filter(milliseconds => milliseconds === 30_000).length, 4, 'the fifth wait starts after the deadline and is refused');
  await assert.rejects(() => runScript('frame 1', recorder().host), TypeError);
});

test('Stop aborts between commands, during waits and during host work, and yields in busy loops', async () => {
  // During a wait.
  const controller = new AbortController();
  const { program } = compile('camera.yaw-left\nwait 30\ncamera.zoom-in');
  const { host, calls } = recorder();
  const running = runScript(program, host, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.deepEqual(calls.map(call => call[1]), ['camera.yaw-left']);
  // Before the first command.
  const stopped = new AbortController(); stopped.abort();
  const idle = recorder();
  await assert.rejects(runScript(compile('camera.yaw-left').program, idle.host, { signal: stopped.signal }), { name: 'AbortError' });
  assert.equal(idle.calls.length, 0);
  // During host work: an AbortError from the host stays an AbortError.
  const third = new AbortController();
  const waiting = recorder({ waitForAnalyses: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))) });
  const pending = runScript(compile('wait-analyses\ncamera.zoom-in').program, waiting.host, { signal: third.signal });
  await new Promise(resolve => setTimeout(resolve, 5)); third.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(waiting.calls.length, 0);
  // A host that completes after Stop does not let the script continue.
  const fourth = new AbortController();
  const late = recorder({ colorBy: () => { fourth.abort(); } });
  await assert.rejects(runScript(compile('color-by type\ncamera.zoom-in').program, late.host, { signal: fourth.signal, sleep: instantSleep }), { name: 'AbortError' });
  assert.equal(late.calls.length, 0);
  // A long loop of cheap commands gives the event loop a turn so Stop can be clicked.
  let clock = 0, yields = 0;
  await runScript(compile('repeat 2000\ngear 5\nend').program, recorder().host, { now: () => (clock += 0.1), sleep: async () => { yields++; } });
  assert.ok(yields >= 10 && yields <= 60, `yields about every 12 ms: ${yields}`);
});

test('the reference lists every command and saved scripts validate for configurations', () => {
  const reference = scriptCommandReference();
  assert.deepEqual(reference.map(item => item.name), ['frame', 'camera', 'projection', 'gear', 'wait', 'wait-analyses', 'color-by', 'tool', 'slice', 'export', 'keyframe', 'repeat']);
  assert.ok(reference.every(item => item.usage.startsWith(item.name) && item.summary.length > 10));
  assert.deepEqual(normalizeScriptState(undefined), { scripts: [], selectedId: null });
  const state = normalizeScriptState({ scripts: [{ text: 'frame 1\n\tcamera view top' }, { id: 'tour', name: 'Tour', text: '' }] });
  assert.deepEqual(state, { scripts: [{ id: 'script-1', name: 'Script 1', text: 'frame 1\n\tcamera view top' }, { id: 'tour', name: 'Tour', text: '' }], selectedId: 'script-1' });
  // Text with syntax errors is kept as text; it is only ever compiled, never run on load.
  assert.equal(normalizeScriptState({ scripts: [{ text: 'this is not valid )(' }] }).scripts[0].text, 'this is not valid )(');
  const invalid = [
    [], { extra: 1 }, { scripts: {} }, { scripts: Array.from({ length: MAX_SAVED_SCRIPTS + 1 }, () => ({})) }, { scripts: [null] }, { scripts: [{ run: true }] },
    { scripts: [{ id: '__proto__' }] }, { scripts: [{ id: 'has space' }] }, { scripts: [{ id: 'a' }, { id: 'a' }] }, { scripts: [{ name: '' }] },
    { scripts: [{ name: 'x'.repeat(65) }] }, { scripts: [{ name: 'a\nb' }] }, { scripts: [{ text: 5 }] }, { scripts: [{ text: 'x'.repeat(SCRIPT_LIMITS.maxLength + 1) }] },
    { scripts: [{ text: 'bell\u0007' }] }, { scripts: [{ text: 'a\r\nb' }] }, { scripts: [{}], selectedId: 'missing' }, { scripts: [], autoRun: true },
    JSON.parse('{"scripts":[],"__proto__":{"x":1}}'),
  ];
  for (const value of invalid) assert.throws(() => normalizeScriptState(value), /Invalid AlloyView configuration: settings\.extensions\.scripts/, JSON.stringify(value));
});
