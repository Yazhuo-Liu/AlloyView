import assert from 'node:assert/strict';
import test from 'node:test';
import { compileScript, runScript } from '../src/command-script.js';
import { createConfiguration, parseConfiguration } from '../src/configuration.js';
import { KeyboardCommandRegistry } from '../src/keyboard-commands.js';
import { captureCamera } from '../src/camera-path.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';
import { cameraCommand, createAutomationLock, createScriptHost, SCRIPT_EXAMPLES } from '../src/script-controls.js';
import { BUILTIN_TOOLS } from '../src/tool-registry.js';

const DEGREE = Math.PI / 180;
const close = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label ?? 'value'}: ${actual} ≈ ${expected}`);

/** The real renderer camera code on a stub without WebGL. */
function stubRenderer() {
  const renderer = Object.create(WebGLRenderer.prototype);
  Object.assign(renderer, { frame: {}, canvas: { width: 800, height: 600 }, yaw: -0.62, pitch: 0.38, roll: 0, constrainUp: true, fov: 40 * DEGREE,
    target: [5, 5, 5], pan: [0, 0, 0], distance: 30, orthographicScale: 10, projectionMode: 'perspective', modelRadius: 8,
    sceneBounds: { minimum: [0, 0, 0], maximum: [10, 10, 10] }, renders: 0, cancelled: 0,
    requestRender() { this.renders++; }, cancelSelectionGesture() { this.cancelled++; }, onProjectionChange() {} });
  return renderer;
}

function application({ frameCount = 5 } = {}) {
  const renderer = stubRenderer(), log = [], app = { frame: 0, color: 'type', tool: 'display', pending: 0, saved: [], edits: 0 };
  const button = (id, label, enabled, handler) => ({ id, label, group: 'Test', bindings: [], enabled, handler });
  const registry = new KeyboardCommandRegistry([
    button('camera.yaw-left', 'Orbit left', () => Boolean(renderer.frame), ({ scale }) => { renderer.orbitCamera(5 * DEGREE * scale, 0); log.push(['yaw', scale]); }),
    button('frames.previous', 'Previous frame', () => app.frame > 0, () => log.push('clicked previous')),
    button('frames.next', 'Next frame', () => app.frame < frameCount - 1, () => log.push('clicked next')),
    button('frames.first', 'First frame', () => app.frame > 0, () => log.push('clicked first')),
    button('frames.last', 'Last frame', () => app.frame < frameCount - 1, () => log.push('clicked last')),
    button('image.png', 'Download PNG', () => true, () => log.push('clicked png')),
    button('interface.theme', 'Theme', undefined, context => log.push(['theme', context.event, context.gear])),
  ]);
  const tools = { getActiveTool: () => app.tool, selectTool: id => { if (!BUILTIN_TOOLS.some(tool => tool.id === id)) return false; app.tool = id; return true; },
    closeTool: (id, options) => { log.push(['close', id, options]); app.tool = null; } };
  const host = createScriptHost({ renderer, registry, tools,
    getFrameIndex: () => app.frame, getFrameCount: () => frameCount,
    showFrame: async index => { log.push(['frame', index]); app.frame = index; return true; }, ensureIndexed: async () => { log.push('indexed'); },
    getColorOptions: () => [{ value: 'type', label: 'Atom type' }, { value: 'property:c_pe', label: 'c_pe' }, { value: 'property:structureType', label: 'Crystal structure (CNA) (calculating…)' },
      { value: 'builtin:speed', label: 'Speed [Å/ps]' }],
    chooseColor: value => { app.color = value; },
    getSliceControls: () => ({ stepSelected: count => { log.push(['slice', count]); return count !== 7; } }),
    captureImage: () => { log.push('capture'); return { width: 640, height: 480 }; }, getImageName: () => `stem-frame-${app.frame + 1}`,
    encodeCanvas: async canvas => ({ type: 'image/png', size: canvas.width * canvas.height }), saveBlob: (blob, name) => app.saved.push([name, blob.size]),
    addKeyframe: options => log.push(['keyframe', options]), clearKeyframes: () => log.push('clear'),
    analysesSettled: () => app.pending-- <= 0, onEdit: () => { app.edits++; }, sleep: async () => { log.push('sleep'); } });
  const run = async text => {
    const { program, problems } = compileScript(text, { registry: registry.commands.map(command => command.id), tools: BUILTIN_TOOLS.map(tool => tool.id) });
    assert.deepEqual(problems, [], text);
    return runScript(program, host, { sleep: async () => {} });
  };
  return { renderer, registry, host, log, app, run };
}

test('camera commands act on the renderer like the view buttons, keys and Adjust view', async () => {
  const { renderer, run, app } = application();
  await run('camera view top');
  assert.deepEqual([renderer.yaw, renderer.pitch, renderer.projectionMode, renderer.constrainUp], [0, Math.PI / 2, 'orthographic', true]);
  await run('camera orbit 30 -20');
  close(renderer.yaw, 30 * DEGREE, 1e-12, 'azimuth'); close(renderer.pitch, 70 * DEGREE, 1e-12, 'elevation');
  await run('camera orbit 0 80');
  close(renderer.pitch, Math.PI / 2 - 0.008, 1e-12, 'upright orbits stop short of the pole');
  await run('camera zoom 2');
  assert.equal(renderer.orthographicScale, 5, 'parallel zoom halves the field');
  await run('projection perspective\ncamera zoom 4');
  assert.deepEqual([renderer.projectionMode, renderer.distance, renderer.orthographicScale], ['perspective', 7.5, 5]);
  await run('camera zoom 0.5');
  assert.equal(renderer.distance, 15);
  // Pan moves the center in the screen plane.
  await run('camera view front\ncamera pan 2 -3');
  renderer.pan.forEach((value, axis) => close(value, [2, 0, -3][axis], 1e-12, `front pan ${axis}`));
  // Roll releases the upright constraint and keeps the view direction.
  const direction = renderer.getCameraState().direction;
  await run('camera roll 30');
  assert.equal(renderer.constrainUp, false); close(renderer.roll, 30 * DEGREE, 1e-12, 'roll');
  renderer.getCameraState().direction.forEach((value, axis) => close(value, direction[axis], 1e-12, 'direction unchanged'));
  await run('camera roll -30\ncamera reset');
  assert.deepEqual([renderer.yaw, renderer.pitch, renderer.roll, renderer.constrainUp, renderer.target, renderer.pan], [-0.62, 0.38, 0, true, [5, 5, 5], [0, 0, 0]]);
  assert.ok(renderer.renders >= 10 && renderer.cancelled >= 10 && app.edits >= 10, 'every camera command redraws and counts as an edit');
});

test('camera set applies a whole view atomically and Insert current view round-trips it', async () => {
  const { renderer, run } = application();
  await run('camera set azimuth 40 elevation -25 distance 12 fov 55 field-height 9 center 1 2 3 projection orthographic');
  close(renderer.yaw, 40 * DEGREE, 1e-12, 'yaw'); close(renderer.pitch, -25 * DEGREE, 1e-12, 'pitch');
  assert.deepEqual([renderer.distance, renderer.orthographicScale, renderer.target, renderer.pan, renderer.projectionMode, renderer.constrainUp], [12, 4.5, [1, 2, 3], [0, 0, 0], 'orthographic', true]);
  close(renderer.fov, 55 * DEGREE, 1e-12, 'fov');
  await run('camera set roll 20 elevation 120');
  assert.equal(renderer.constrainUp, false); close(renderer.roll, 20 * DEGREE, 1e-12, 'roll'); close(renderer.pitch, 120 * DEGREE, 1e-12, 'free elevation');
  // Turning upright on folds a view beyond the pole back into range.
  await run('camera set upright on');
  assert.equal(renderer.constrainUp, true); assert.equal(renderer.roll, 0); close(renderer.pitch, 60 * DEGREE, 1e-12, 'folded elevation');
  // An invalid edit changes nothing, including the center and distance on the same line.
  const before = captureCamera(renderer);
  await assert.rejects(run('wait 0\ncamera set elevation 120 center 9 9 9 distance 77'), { name: 'ScriptError', line: 2, message: /Elevation must be between −90° and 90° while Z stays upright/ });
  assert.deepEqual(captureCamera(renderer), before);
  // The generated line restores every part of an upright and of a rolled view.
  for (const view of [{ yaw: 7.3, pitch: -1.1, roll: 0, constrainUp: true, distance: 44.5, fov: 0.31, orthographicScale: 3.25, target: [1.5, -2, 9], pan: [0.25, 0, -4], projectionMode: 'perspective' },
    { yaw: -2.2, pitch: 2.4, roll: -1.3, constrainUp: false, distance: 0.75, fov: 1.9, orthographicScale: 120, target: [0, 0, 0], pan: [3, 3, 3], projectionMode: 'orthographic' }]) {
    Object.assign(renderer, structuredClone(view));
    const line = cameraCommand(renderer);
    assert.match(line, /^camera set azimuth \S+ elevation \S+ (roll \S+ )?distance \S+ fov \S+ field-height \S+ center \S+ \S+ \S+ projection (perspective|orthographic) upright (on|off)$/);
    Object.assign(renderer, { yaw: 0, pitch: 0, roll: 0, constrainUp: true, distance: 30, fov: 0.7, orthographicScale: 10, target: [5, 5, 5], pan: [0, 0, 0], projectionMode: 'perspective' });
    await run(line);
    for (const key of ['yaw', 'pitch', 'roll', 'distance', 'fov', 'orthographicScale']) close(renderer[key], view[key], 1e-9 * Math.max(1, Math.abs(view[key])), key);
    assert.deepEqual([renderer.constrainUp, renderer.projectionMode], [view.constrainUp, view.projectionMode]);
    renderer.target.forEach((value, axis) => close(value + renderer.pan[axis], view.target[axis] + view.pan[axis], 1e-9, `center ${axis}`));
  }
});

test('keyboard names dispatch through the registry, with awaited frames and images', async () => {
  const { renderer, run, log, app } = application();
  await run('gear 7\ncamera.yaw-left\ngear 3\ncamera.yaw-left\ninterface.theme');
  close(renderer.yaw, -0.62 + 5 * DEGREE * (4 + 0.25), 1e-12, 'gear scales the step');
  assert.deepEqual(log, [['yaw', 4], ['yaw', 0.25], ['theme', null, 3]]);
  log.length = 0;
  await run('frames.next\nframes.next\nframes.previous\nframes.last\nframes.first\nimage.png');
  assert.deepEqual(log, [['frame', 1], ['frame', 2], ['frame', 1], 'indexed', ['frame', 4], ['frame', 0], 'capture'], 'frame commands await the frame instead of clicking a button');
  assert.deepEqual(app.saved, [['stem-frame-1.png', 640 * 480]]);
  await assert.rejects(run('frames.previous'), /“frames\.previous” is not available now/);
  await assert.rejects(run('frame last\nframes.next'), { line: 2, message: /“frames\.next” is not available now/ });
  // Without a structure the camera commands are unavailable or fail with a reason.
  renderer.frame = null;
  await assert.rejects(run('camera.yaw-left'), /not available now/);
  await assert.rejects(run('camera view top'), /No structure is displayed/);
  await assert.rejects(run('export png'), /No structure is displayed/);
});

test('colors, tools, slices, images, keyframes and analysis waits reach the application only through the host', async () => {
  const { run, log, app } = application();
  for (const [name, value] of [['type', 'type'], ['c_pe', 'property:c_pe'], ['"Atom type"', 'type'], ['"crystal structure (cna)"', 'property:structureType'], ['structureType', 'property:structureType'],
    ['property:c_pe', 'property:c_pe'], ['C_PE', 'property:c_pe'], ['builtin:speed', 'builtin:speed'], ['"Speed [Å/ps]"', 'builtin:speed']]) {
    await run(`color-by ${name}`); assert.equal(app.color, value, name);
  }
  await assert.rejects(run('color-by missing'), /No color quantity “missing”\. Available: type, c_pe, structureType, builtin:speed\./);
  await run('tool cna'); assert.equal(app.tool, 'cna');
  await run('tool none'); assert.deepEqual([app.tool, log.at(-1)], [null, ['close', 'cna', { deactivate: false }]]);
  await run('tool none'); assert.equal(log.filter(entry => entry[0] === 'close').length, 1, 'closing nothing is not an error');
  await run('slice step -4'); assert.deepEqual(log.at(-1), ['slice', -4]);
  await assert.rejects(run('slice step 7'), /No cutting plane is selected, or the step leaves its allowed range/);
  await run('frame 3\nexport png\nexport png "top view"');
  assert.deepEqual(app.saved, [['stem-frame-3.png', 307200], ['top view.png', 307200]]);
  await run('keyframe\nkeyframe 2.5\nkeyframe clear');
  assert.deepEqual(log.slice(-3), [['keyframe', { time: null }], ['keyframe', { time: 2.5 }], 'clear']);
  // Settled on two consecutive checks.
  log.length = 0; app.pending = 3;
  await run('wait-analyses');
  assert.deepEqual(log, ['sleep', 'sleep', 'sleep', 'sleep'], 'three busy checks, then two quiet ones');
});

test('the shipped examples compile, and one lock serializes scripts, previews and exports', () => {
  const registry = ['camera.yaw-left', 'camera.zoom-in', 'frames.next', 'image.png'];
  for (const example of SCRIPT_EXAMPLES) {
    const { problems, stats } = compileScript(example.text, { registry, tools: BUILTIN_TOOLS.map(tool => tool.id) });
    assert.deepEqual(problems, [], example.id); assert.ok(stats.statements >= 4 && example.label.length > 5);
  }
  const lock = createAutomationLock();
  const release = lock.acquire('script');
  assert.deepEqual([typeof release, lock.owner(), lock.acquire('movie'), lock.acquire('script')], ['function', 'script', null, null]);
  release(); release();
  assert.equal(lock.owner(), null);
  const movie = lock.acquire('movie'); assert.equal(lock.owner(), 'movie');
  release(); assert.equal(lock.owner(), 'movie', 'a stale release cannot free another owner');
  movie(); assert.equal(lock.owner(), null);
});

test('configurations carry scripts and the camera path only as validated data', () => {
  const camera = { yaw: 0.3, pitch: 0.2, roll: 0, fov: 0.7, constrainUp: true, target: [1, 2, 3], pan: [0, 0, 0], distance: 20, orthographicScale: 8, projectionMode: 'perspective' };
  const scripts = { scripts: [{ id: 'script-1', name: 'Tour', text: 'camera view top\nrepeat 2\n  camera orbit 90 0\nend\n' }, { id: 'script-2', name: 'Broken', text: 'this is not ) valid' }], selectedId: 'script-2' };
  const movie = { path: { keyframes: [{ time: 0, camera, frame: 0 }, { time: 2.5, camera: { ...camera, yaw: 2 }, frame: null }], easing: 'ease',
    frames: { mode: 'fit', first: 0, last: null, step: 1, rate: 10 } }, output: { format: 'webm-vp9', fps: 24, quality: 'best', bitrateMbps: 12, keyframeSeconds: 1 } };
  const recipe = createConfiguration({ settings: { extensions: { scripts, movie }, activeTool: 'movie' } });
  assert.deepEqual(recipe.settings.extensions.scripts, scripts);
  assert.deepEqual(recipe.settings.extensions.movie, movie);
  const restored = parseConfiguration(JSON.stringify(recipe));
  assert.deepEqual(restored.settings.extensions.scripts, scripts);
  assert.deepEqual(restored.settings.extensions.movie, movie);
  assert.equal(restored.settings.activeTool, 'movie');
  assert.equal(parseConfiguration(JSON.stringify(createConfiguration({ settings: { activeTool: 'scripts' } }))).settings.activeTool, 'scripts');
  // Recipes that do not use the features are unchanged.
  const plain = createConfiguration({});
  assert.equal('scripts' in plain.settings.extensions, false); assert.equal('movie' in plain.settings.extensions, false);
  const invalid = [
    value => { value.settings.extensions.scripts.autoRun = true; },
    value => { value.settings.extensions.scripts.scripts[0].run = 'now'; },
    value => { value.settings.extensions.scripts.scripts[0].text = 'x'.repeat(20_001); },
    value => { value.settings.extensions.scripts.scripts[0].text = 'bell\u0007'; },
    value => { value.settings.extensions.scripts.scripts[0].id = 'constructor'; },
    value => { value.settings.extensions.scripts.selectedId = 'nobody'; },
    value => { value.settings.extensions.scripts.scripts = Array.from({ length: 17 }, (_, index) => ({ id: `s${index}` })); },
    value => { value.settings.extensions.movie.path.keyframes[1].time = 0; },
    value => { value.settings.extensions.movie.path.keyframes[0].camera.distance = -1; },
    value => { value.settings.extensions.movie.path.keyframes[0].camera.pitch = 3; },
    value => { value.settings.extensions.movie.path.keyframes[0].onload = 'x'; },
    value => { value.settings.extensions.movie.path.frames.mode = 'everything'; },
    value => { value.settings.extensions.movie.output.fps = 500; },
    value => { value.settings.extensions.movie.output.format = 'exe'; },
    value => { value.settings.extensions.movie.command = 'export'; },
  ];
  for (const mutate of invalid) {
    const value = JSON.parse(JSON.stringify(recipe)); mutate(value);
    assert.throws(() => parseConfiguration(JSON.stringify(value)), /Invalid AlloyView configuration: settings\.extensions\.(scripts|movie)/, mutate.toString());
  }
});
