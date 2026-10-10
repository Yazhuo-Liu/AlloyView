import { compileScript, createSavedScript, formatScriptProblem, MAX_SAVED_SCRIPTS, MAX_SCRIPT_NAME_LENGTH, normalizeScriptState, runScript,
  scriptCommandReference, SCRIPT_LIMITS } from './command-script.js';
import { downloadBlob } from './export-archive.js';

const DEGREES = 180 / Math.PI;
const FRAME_STEPS = new Map([['frames.previous', -1], ['frames.next', 1]]);

const canvasPngBlob = canvas => new Promise((resolve, reject) => canvas.toBlob(
  blob => blob ? resolve(blob) : reject(new Error('Could not encode the image.')), 'image/png'));

/** One script, camera preview or movie export runs at a time. */
export function createAutomationLock() {
  let owner = null;
  return { owner: () => owner,
    acquire(name) { if (owner !== null) return null; owner = name; return () => { if (owner === name) owner = null; }; } };
}

const pauseFor = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException('Stopped.', 'AbortError')); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, milliseconds);
  const stop = () => { clearTimeout(timer); reject(new DOMException('Stopped.', 'AbortError')); };
  signal?.addEventListener('abort', stop, { once: true });
});

/** Resolve once `settled()` holds on two checks in a row, so that an analysis
 * which starts another one when it finishes is covered as well. */
export async function waitUntilSettled(settled, { signal = null, sleep = pauseFor, interval = 60 } = {}) {
  for (let quiet = 0; quiet < 2;) {
    if (signal?.aborted) throw new DOMException('Stopped.', 'AbortError');
    quiet = settled() ? quiet + 1 : 0;
    if (quiet < 2) await sleep(interval, signal);
  }
}

export const SCRIPT_EXAMPLES = Object.freeze([
  { id: 'views', label: 'Six standard views as PNG', text: ['# Download the six standard views of the displayed frame', 'camera view front', 'export png front',
    'camera view back', 'export png back', 'camera view left', 'export png left', 'camera view right', 'export png right',
    'camera view top', 'export png top', 'camera view bottom', 'export png bottom', 'camera reset'].join('\n') },
  { id: 'turntable', label: 'Turntable camera path', text: ['# Four keyframes a quarter turn apart; open Movie to preview or export them', 'keyframe clear', 'keyframe 0',
    'repeat 4', '  camera orbit 90 0', '  keyframe      # 2 s after the previous keyframe', 'end'].join('\n') },
  { id: 'frames', label: 'Image of the next five frames', text: ['# Step through the trajectory; each image waits for its frame\'s analyses', 'repeat 5', '  frame next', '  wait-analyses',
    '  export png', 'end'].join('\n') },
  { id: 'sweep', label: 'Sweep the selected slice', text: ['# Move the selected cutting plane ten steps forward and back', 'tool slice', 'repeat 10', '  slice step 1', '  wait 0.2', 'end',
    'slice step -10'].join('\n') },
  { id: 'approach', label: 'Orbit and zoom with shortcut names', text: ['# Keyboard command names work as commands; gear sets their step size', 'gear 7', 'repeat 9', '  camera.yaw-left', '  wait 0.1', 'end',
    'gear 5', 'camera zoom 1.5', 'camera roll 10', 'wait 1', 'camera reset'].join('\n') },
].map(Object.freeze));

/** A `camera set` line that reproduces the renderer's current view. */
export function cameraCommand(renderer) {
  const number = value => String(Number(value.toPrecision(12)));
  const center = renderer.target.map((value, axis) => value + renderer.pan[axis]);
  return ['camera set', 'azimuth', number(renderer.yaw * DEGREES), 'elevation', number(renderer.pitch * DEGREES),
    ...(renderer.constrainUp === false ? ['roll', number((renderer.roll ?? 0) * DEGREES)] : []),
    'distance', number(renderer.distance), 'fov', number(renderer.fov * DEGREES), 'field-height', number(2 * renderer.orthographicScale),
    'center', ...center.map(number), 'projection', renderer.projectionMode, 'upright', renderer.constrainUp === false ? 'off' : 'on'].join(' ');
}

/**
 * The effects a script may have, bound to the application. Everything a
 * script can do is listed here; there is no file, network or code access.
 */
export function createScriptHost({ renderer, registry, getFrameIndex, getFrameCount, showFrame, ensureIndexed = async () => {},
  getColorOptions = () => [], chooseColor = () => {}, tools = null, getSliceControls = () => null,
  captureImage = () => { throw new Error('Image export is unavailable.'); }, getImageName = () => 'alloyview', saveBlob = downloadBlob, encodeCanvas = canvasPngBlob,
  addKeyframe = () => {}, clearKeyframes = () => {}, analysesSettled = () => true, onEdit = () => {}, sleep = pauseFor } = {}) {
  const requireFrame = () => { if (!renderer.frame) throw new Error('No structure is displayed.'); };
  const camera = action => { requireFrame(); onEdit(); renderer.cancelSelectionGesture?.(); action(); renderer.requestRender(); };
  async function lastFrame({ signal } = {}) { await ensureIndexed({ signal }); return getFrameCount() - 1; }
  /** PNG with the current image settings; resolves once the download was started. */
  async function exportImage(name) {
    requireFrame();
    const canvas = captureImage();
    try { saveBlob(await encodeCanvas(canvas), `${name ?? getImageName()}.png`); }
    finally { canvas.width = canvas.height = 1; }
  }
  return {
    async command(id, { gear, scale, signal } = {}) {
      const command = registry?.byId.get(id);
      if (!command || command.enabled?.() === false) return false;
      // Frame and image commands are awaited here, so the next line sees their result.
      if (id === 'image.png') { await exportImage(null); return true; }
      if (FRAME_STEPS.has(id)) return showFrame(getFrameIndex() + FRAME_STEPS.get(id));
      if (id === 'frames.first') return showFrame(0);
      if (id === 'frames.last') return showFrame(await lastFrame({ signal }));
      command.handler?.({ event: null, gear, scale });
      return true;
    },
    getFrameInfo: () => ({ index: getFrameIndex(), count: getFrameCount() }),
    lastFrame,
    showFrame: index => showFrame(index),
    setView: name => camera(() => renderer.setView(name)),
    resetCamera: () => camera(() => renderer.resetCamera()),
    orbit: (yaw, pitch) => camera(() => renderer.orbitCamera(yaw, pitch)),
    roll: angle => camera(() => {
      // As for the roll shortcuts: release upright first so screen-up is preserved.
      if (renderer.constrainUp !== false) renderer.setCameraState({ constrainUp: false });
      renderer.setCameraState({ roll: (renderer.roll ?? 0) + angle });
    }),
    zoom: factor => camera(() => {
      const state = renderer.getCameraState();
      renderer.setCameraState(state.projectionMode === 'orthographic' ? { fieldWidth: Math.max(.001, state.fieldWidth / factor) }
        : { distance: Math.max(.02, state.distance / factor) });
    }),
    pan: (right, up) => camera(() => {
      const basis = renderer.cameraBasis();
      renderer.pan = renderer.pan.map((value, axis) => value + right * basis.right[axis] + up * basis.up[axis]);
    }),
    setCamera: patch => camera(() => {
      const { center, orthographicScale, ...orbit } = patch;
      // setCameraState validates the whole orbit edit before it changes anything.
      if (Object.keys(orbit).length) renderer.setCameraState(orbit);
      if (orthographicScale !== undefined) renderer.orthographicScale = orthographicScale;
      if (center) { renderer.target = [...center]; renderer.pan = [0, 0, 0]; }
    }),
    setProjection: mode => camera(() => renderer.setProjection(mode)),
    colorBy(name) {
      requireFrame();
      const options = getColorOptions(), wanted = name.toLowerCase(), plain = label => label.replace(/\s*\([^()]*…\)$/, '').toLowerCase();
      const match = options.find(option => option.value === name) ?? options.find(option => option.value === `property:${name}`)
        ?? options.find(option => option.label.toLowerCase() === wanted || plain(option.label) === wanted)
        ?? options.find(option => option.value.toLowerCase() === wanted || option.value.toLowerCase() === `property:${wanted}`);
      if (!match) {
        const names = options.map(option => option.value.replace(/^property:/, ''));
        throw new Error(`No color quantity “${name}”. Available: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}.`);
      }
      onEdit(); chooseColor(match.value);
    },
    openTool(id) {
      onEdit();
      if (id === 'none') { const active = tools?.getActiveTool(); if (active) tools.closeTool(active, { deactivate: false }); return; }
      if (!tools?.selectTool(id)) throw new Error(`Unknown tool “${id}”.`);
    },
    sliceStep(count) {
      requireFrame(); onEdit();
      if (!getSliceControls()?.stepSelected(count)) throw new Error('No cutting plane is selected, or the step leaves its allowed range.');
    },
    exportPng: name => exportImage(name),
    addKeyframe(time) { requireFrame(); onEdit(); addKeyframe({ time }); },
    clearKeyframes() { onEdit(); clearKeyframes(); },
    waitForAnalyses: ({ signal } = {}) => waitUntilSettled(analysesSettled, { signal, sleep }),
  };
}

/** The Scripts panel: an editor with live checking, Run and Stop, examples
 * and text-file import and export. Loading a script never runs it. */
export function initializeScriptControls({ host, registry, tools = null, lock = createAutomationLock(), getToolIds = () => null,
  getCameraCommand = () => '', getFileStem = () => 'alloyview', onEdit = () => {}, notify = () => {}, documentRoot = globalThis.document } = {}) {
  const $ = id => documentRoot?.getElementById(id) ?? null;
  const controls = { list: $('script-list'), add: $('add-script'), remove: $('delete-script'), name: $('script-name'), text: $('script-text'),
    error: $('script-error'), run: $('run-script'), stop: $('stop-script'), check: $('check-script'), status: $('script-status'), state: $('script-state'),
    example: $('script-example'), insertView: $('insert-script-view'), importButton: $('import-script'), exportButton: $('export-script'),
    file: $('script-file'), reference: $('script-reference') };
  if (documentRoot && !$('script-movie-styles')) {
    const stylesheet = documentRoot.createElement('link');
    stylesheet.id = 'script-movie-styles'; stylesheet.rel = 'stylesheet'; stylesheet.href = new URL('./script-movie.css', import.meta.url).href;
    documentRoot.head?.append(stylesheet);
  }
  let state = normalizeScriptState({}), enabled = false, running = null, sequence = 0, message = '', validateTimer = null, lastStatusAt = 0;
  const selected = () => state.scripts.find(script => script.id === state.selectedId) ?? null;
  const compileOptions = () => ({ registry: registry?.commands.map(command => command.id) ?? [], tools: getToolIds() });
  const compileCurrent = () => compileScript(controls.text?.value ?? selected()?.text ?? '', compileOptions());
  const node = (tag, text, className) => { const element = documentRoot.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };

  function setState(text, ready = false) {
    if (!controls.state) return;
    controls.state.textContent = text; controls.state.classList.toggle('ready', ready);
  }

  function showProblems(problems, { focus = false } = {}) {
    const [first] = problems;
    if (controls.error) {
      controls.error.textContent = first ? `${formatScriptProblem(first)}${problems.length > 1 ? ` (${problems.length - 1} more problem${problems.length > 2 ? 's' : ''})` : ''}` : '';
      controls.error.hidden = !first;
    }
    if (!controls.text) return;
    if (first) controls.text.setAttribute('aria-invalid', 'true'); else controls.text.removeAttribute('aria-invalid');
    if (first && focus && Number.isInteger(first.position) && controls.text.setSelectionRange) {
      controls.text.focus?.({ preventScroll: true });
      controls.text.setSelectionRange(first.position, Math.min(controls.text.value.length, first.position + first.length));
      // Bring the line into view in a long script.
      const lineHeight = Number.parseFloat(documentRoot.defaultView?.getComputedStyle?.(controls.text).lineHeight) || 16;
      controls.text.scrollTop = Math.max(0, (first.line - 3) * lineHeight);
    }
  }

  function describe(stats) {
    const parts = [`${stats.statements} line${stats.statements === 1 ? '' : 's'} with commands`, `up to ${stats.steps.toLocaleString('en-US')} commands run`];
    if (stats.exports) parts.push(`${stats.exports} image${stats.exports === 1 ? '' : 's'}`);
    if (stats.keyframes) parts.push(`${stats.keyframes} keyframe${stats.keyframes === 1 ? '' : 's'}`);
    if (stats.waitSeconds) parts.push(`${Number(stats.waitSeconds.toFixed(1))} s of waits`);
    return parts.join(', ');
  }

  function render() {
    const script = selected(), busy = running !== null, active = enabled && !busy;
    if (controls.list) {
      const options = state.scripts.map(item => [item.id, item.name]);
      const signature = JSON.stringify(options);
      if (controls.list.dataset.signature !== signature) {
        controls.list.replaceChildren(...(options.length ? options : [['', 'New script']]).map(([value, label]) => { const option = node('option', label); option.value = value; return option; }));
        controls.list.dataset.signature = signature;
      }
      controls.list.value = state.selectedId ?? '';
      controls.list.disabled = !active || state.scripts.length < 2;
    }
    if (controls.name && documentRoot.activeElement !== controls.name) controls.name.value = script?.name ?? '';
    if (controls.text && controls.text.value !== (script?.text ?? '') && documentRoot.activeElement !== controls.text) controls.text.value = script?.text ?? '';
    for (const element of [controls.name, controls.text, controls.example, controls.insertView, controls.importButton]) if (element) element.disabled = !active;
    if (controls.add) controls.add.disabled = !active || state.scripts.length >= MAX_SAVED_SCRIPTS;
    if (controls.remove) controls.remove.disabled = !active || !script;
    const hasText = Boolean((controls.text?.value ?? '').trim());
    if (controls.run) controls.run.disabled = !active || !hasText;
    if (controls.check) controls.check.disabled = !active || !hasText;
    if (controls.exportButton) controls.exportButton.disabled = busy || !hasText;
    if (controls.stop) controls.stop.disabled = !busy;
    if (controls.status) controls.status.textContent = message || (!enabled ? 'Open a structure to run scripts.'
      : hasText ? 'Run starts the script. Nothing runs when a script is opened, imported or restored.' : 'Type commands, or insert an example to start from.');
  }

  function validate({ focus = false } = {}) {
    const text = controls.text?.value ?? '';
    if (!text.trim()) { showProblems([]); return null; }
    const result = compileCurrent();
    showProblems(result.problems, { focus });
    return result;
  }

  function ensureScript() {
    let script = selected();
    if (script) return script;
    let id;
    do { id = `script-${++sequence}`; } while (state.scripts.some(item => item.id === id));
    script = createSavedScript({ id, name: `Script ${sequence}`, text: '' });
    state.scripts.push(script); state.selectedId = id;
    return script;
  }

  function readEditor() {
    if (running) return;
    onEdit();
    const script = ensureScript();
    script.text = (controls.text?.value ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').slice(0, SCRIPT_LIMITS.maxLength);
    const name = (controls.name?.value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, MAX_SCRIPT_NAME_LENGTH);
    if (name) script.name = name;
    message = '';
    render();
    clearTimeout(validateTimer);
    validateTimer = setTimeout(() => validate(), 200);
  }

  function setText(text) {
    if (controls.text) controls.text.value = text;
    readEditor(); clearTimeout(validateTimer); validate();
  }

  function addScript(name = null, text = '') {
    if (state.scripts.length >= MAX_SAVED_SCRIPTS) { notify(`Keep up to ${MAX_SAVED_SCRIPTS} scripts.`); return null; }
    onEdit();
    let id;
    do { id = `script-${++sequence}`; } while (state.scripts.some(item => item.id === id));
    const script = createSavedScript({ id, name: name ?? `Script ${sequence}`, text });
    state.scripts.push(script); state.selectedId = id; message = '';
    if (controls.text) controls.text.value = text;
    if (controls.name) controls.name.value = script.name;
    render(); validate();
    return script;
  }

  function deleteScript() {
    const script = selected();
    if (!script || running) return;
    onEdit();
    const index = state.scripts.indexOf(script);
    state.scripts.splice(index, 1);
    state.selectedId = state.scripts[Math.min(index, state.scripts.length - 1)]?.id ?? null;
    if (controls.text) controls.text.value = selected()?.text ?? '';
    if (controls.name) controls.name.value = selected()?.name ?? '';
    message = ''; render(); validate();
  }

  function insertText(text) {
    const input = controls.text;
    if (!input || input.disabled) return;
    const value = input.value, start = input.selectionStart ?? value.length;
    // Whole lines only: continue after the line the caret is in.
    const lineEnd = value.indexOf('\n', start), at = lineEnd < 0 ? value.length : lineEnd;
    const before = value.slice(0, at), after = value.slice(at);
    const next = `${before}${before && !before.endsWith('\n') ? '\n' : ''}${text}${after.startsWith('\n') || !after ? '' : '\n'}${after}`;
    if (next.length > SCRIPT_LIMITS.maxLength) { notify(`Scripts are limited to ${SCRIPT_LIMITS.maxLength.toLocaleString('en-US')} characters.`); return; }
    setText(next);
    const caret = before.length + (before && !before.endsWith('\n') ? 1 : 0) + text.length;
    input.focus?.({ preventScroll: true }); input.setSelectionRange?.(caret, caret);
  }

  async function run() {
    if (running || !enabled) return;
    const result = validate({ focus: true });
    if (!result) return;
    if (result.problems.length) { message = `Fix ${result.problems.length === 1 ? 'the problem' : `${result.problems.length} problems`} shown above before running.`; render(); return; }
    const release = lock.acquire('script');
    if (!release) { notify(lock.owner() === 'movie' ? 'Wait for the movie export or preview to finish first.' : 'Another script is running.'); return; }
    const controller = new AbortController(), task = { controller, line: 0 };
    running = task;
    tools?.setToolEnabled('scripts', true);
    message = 'Running…'; setState('Running…'); render();
    let failure = null;
    try {
      const outcome = await runScript(result.program, host, { signal: controller.signal, onStep: ({ line, steps }) => {
        task.line = line;
        const now = performance.now();
        if (now - lastStatusAt > 100 && controls.status) { lastStatusAt = now; controls.status.textContent = `Running line ${line} · ${steps.toLocaleString('en-US')} command${steps === 1 ? '' : 's'} so far`; }
      } });
      message = `Finished: ${outcome.steps.toLocaleString('en-US')} command${outcome.steps === 1 ? '' : 's'} in ${(outcome.elapsedMs / 1000).toFixed(1)} s${outcome.exports ? `, ${outcome.exports} image${outcome.exports === 1 ? '' : 's'} downloaded` : ''}.`;
      setState('Finished', true);
    } catch (error) {
      if (error?.name === 'AbortError') { message = `Stopped at line ${task.line || 1}.`; setState('Stopped'); }
      else {
        message = `Stopped by an error at line ${error.line ?? task.line}.`; setState('Failed');
        failure = { message: error.detail ?? error.message, line: error.line ?? task.line, column: error.column ?? 1, position: error.position ?? null, length: error.length ?? 1 };
      }
    } finally {
      running = null; release();
      tools?.setToolEnabled('scripts', false);
      render();
    }
    // The editor is enabled again here, so the failing command can take the focus.
    if (failure) showProblems([failure], { focus: true });
  }

  function stop() { running?.controller.abort(); }

  function check() {
    const result = validate({ focus: true });
    if (!result) return;
    message = result.problems.length ? `${result.problems.length} problem${result.problems.length === 1 ? '' : 's'} found; the first is selected in the editor.`
      : `No problems: ${describe(result.stats)}. Availability of frames, tools and quantities is checked while running.`;
    setState(result.problems.length ? 'Problems' : 'Checked', !result.problems.length);
    render();
  }

  async function importFile() {
    const [file] = controls.file?.files ?? [];
    if (controls.file) controls.file.value = '';
    if (!file) return;
    try {
      if (file.size > 4 * SCRIPT_LIMITS.maxLength) throw new Error(`Script files hold at most ${SCRIPT_LIMITS.maxLength.toLocaleString('en-US')} characters.`);
      const text = (await file.text()).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
      if (text.length > SCRIPT_LIMITS.maxLength) throw new Error(`Script files hold at most ${SCRIPT_LIMITS.maxLength.toLocaleString('en-US')} characters.`);
      if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new Error('This file is not plain text.');
      const name = file.name.replace(/\.[^.]+$/, '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, MAX_SCRIPT_NAME_LENGTH) || null;
      // An empty unsaved editor takes the import; otherwise it becomes a new script.
      const current = selected();
      if (current && !current.text.trim()) { current.name = name ?? current.name; if (controls.name) controls.name.value = current.name; setText(text); }
      else if (!addScript(name, text)) return;
      message = 'Imported. Review the commands, then select Run.'; setState('Imported'); render();
    } catch (error) { notify(error.message); }
  }

  function exportFile() {
    const text = controls.text?.value ?? '';
    if (!text.trim()) return;
    const name = (selected()?.name ?? 'script').replace(/[^A-Za-z0-9 _.()+-]/g, '_').trim() || 'script';
    downloadBlob(new Blob([text.replace(/\r\n?/g, '\n')], { type: 'text/plain' }), `${getFileStem()}-${name}.txt`);
  }

  function renderReference() {
    if (!controls.reference) return;
    const list = node('dl');
    for (const { usage, summary } of scriptCommandReference()) list.append(node('dt', usage), node('dd', summary));
    const sub = [['camera view <front|back|left|right|top|bottom>', 'A standard parallel view.'], ['camera reset', 'Frame the whole structure again.'],
      ['camera orbit <azimuth°> <elevation°>', 'Add to the azimuth and elevation.'], ['camera roll <degrees>', 'Roll about the viewing direction; releases Keep Z upward.'],
      ['camera zoom <factor>', 'Above 1 moves closer, below 1 farther.'], ['camera pan <right> <up>', 'Shift the view center in the screen plane, in length units.'],
      ['camera set <name> <value> …', 'Set azimuth, elevation, roll, distance, fov, field-height, center x y z, projection or upright on|off.']];
    const cameraList = node('dl');
    for (const [usage, summary] of sub) cameraList.append(node('dt', usage), node('dd', summary));
    const shortcuts = node('dl');
    for (const command of registry?.commands ?? []) shortcuts.append(node('dt', command.id), node('dd', command.label));
    controls.reference.replaceChildren(node('h4', 'Commands'), list, node('h4', 'Camera commands'), cameraList, node('h4', 'Keyboard command names'), shortcuts);
  }

  if (controls.example && controls.example.options.length <= 1) {
    for (const example of SCRIPT_EXAMPLES) { const option = node('option', example.label); option.value = example.id; controls.example.append(option); }
  }
  controls.text?.addEventListener('input', readEditor);
  controls.name?.addEventListener('change', readEditor);
  controls.list?.addEventListener('change', () => {
    if (running) return;
    state.selectedId = controls.list.value || null;
    if (controls.text) controls.text.value = selected()?.text ?? '';
    if (controls.name) controls.name.value = selected()?.name ?? '';
    message = ''; render(); validate();
  });
  controls.add?.addEventListener('click', () => addScript());
  controls.remove?.addEventListener('click', deleteScript);
  controls.run?.addEventListener('click', () => void run());
  controls.stop?.addEventListener('click', stop);
  controls.check?.addEventListener('click', check);
  controls.example?.addEventListener('change', () => {
    const example = SCRIPT_EXAMPLES.find(item => item.id === controls.example.value);
    controls.example.value = '';
    if (!example) return;
    const current = controls.text?.value ?? '';
    if (current.trim()) {
      const next = `${current.replace(/\n*$/, '\n\n')}${example.text}\n`;
      if (next.length > SCRIPT_LIMITS.maxLength) { notify(`Scripts are limited to ${SCRIPT_LIMITS.maxLength.toLocaleString('en-US')} characters.`); return; }
      setText(next);
    } else setText(`${example.text}\n`);
  });
  controls.insertView?.addEventListener('click', () => { const line = getCameraCommand(); if (line) insertText(line); });
  controls.importButton?.addEventListener('click', () => controls.file?.click());
  controls.file?.addEventListener('change', () => void importFile());
  controls.exportButton?.addEventListener('click', exportFile);
  controls.reference?.closest('details')?.addEventListener('toggle', renderReference, { once: true });
  render();

  return Object.freeze({
    run, stop, check, validate: () => compileCurrent(),
    isRunning: () => running !== null,
    setEnabled(value) { enabled = Boolean(value); if (!enabled) stop(); render(); },
    getState: () => ({ scripts: state.scripts.map(script => ({ ...script })), selectedId: state.selectedId }),
    /** Saved only when a script has text, so other configurations are unchanged. */
    serialize() { return state.scripts.some(script => script.text.trim()) ? { scripts: state.scripts.map(script => ({ ...script })), selectedId: state.selectedId } : undefined; },
    /** Replace all scripts with validated saved ones. Nothing is run. */
    restore(saved) {
      stop();
      state = normalizeScriptState(saved ?? {});
      // Saved IDs are free-form. Only suffixes of at most nine digits advance the
      // counter: at 2^53 and beyond ++sequence would stop changing and the
      // search for an unused ID would never end.
      sequence = Math.max(0, ...state.scripts.map(script => Number(/^script-(\d{1,9})$/.exec(script.id)?.[1] ?? 0)));
      if (controls.text) controls.text.value = selected()?.text ?? '';
      if (controls.name) controls.name.value = selected()?.name ?? '';
      message = state.scripts.length ? 'Scripts restored. Review the commands, then select Run.' : '';
      setState('Idle'); render(); validate();
    },
  });
}
