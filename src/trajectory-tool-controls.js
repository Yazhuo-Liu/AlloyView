import { MAX_SMOOTHING_WINDOW, MAX_TRAJECTORY_LINE_VERTICES, TRAJECTORY_LINE_DEFAULTS, trajectoryLineFrames, trajectoryLineVertexCount } from './data/trajectory-tools.js';
import { parseSelectionAtomIds } from './selection-groups.js';
import { SCALAR_COLOR_SCHEMES } from './render/palette.js';
import { normalizeTrajectoryLineOptions } from './render/trajectory-line-layer.js';

export const TRAJECTORY_SMOOTHING_DEFAULTS = Object.freeze({ enabled: false, window: 2 });
/** Explicit trajectory-line IDs kept in configuration JSON. Selection groups
 * store their own members; this bounds the separately typed list. */
export const MAX_TRAJECTORY_LINE_IDS = 100_000;
export const TRAJECTORY_LINE_SETTINGS_DEFAULTS = Object.freeze({ enabled: false, source: 'ids', selectionGroupId: null, atomIds: Object.freeze([]),
  firstFrame: 0, lastFrame: null, stride: 1, ...TRAJECTORY_LINE_DEFAULTS });

const integer = value => Number(value).toLocaleString('en-US');
const plural = (count, word) => `${integer(count)} ${word}${count === 1 ? '' : 's'}`;
const CONTROL_IDS = ['trajectory-smooth-enabled', 'trajectory-smooth-window', 'trajectory-lines-source', 'trajectory-lines-ids',
  'trajectory-lines-first', 'trajectory-lines-last', 'trajectory-lines-stride', 'trajectory-lines-color', 'trajectory-lines-width',
  'trajectory-lines-time', 'trajectory-lines-scheme', 'trajectory-lines-visible', 'generate-trajectory-lines'];

/**
 * Trajectory panel: inferred unwrapping status, smoothing settings that the
 * page applies as a frame-processing stage, and atom-path lines computed by
 * the structure Worker. Lines are independent of the displayed frame.
 */
export function initializeTrajectoryToolControls({ tools, renderer, worker, getFrame = () => null, getFrameIndex = () => 0,
  getFrameCount = () => 0, ensureIndexed = async () => {}, getSourceVersion = () => 0, getSelectionGroups = () => [],
  getCoordinateMode = () => 'wrapped', canInferUnwrap = () => false, onSmoothingChange = async () => {}, onLinesChange = () => {},
  onEdit = () => {}, notify = () => {}, setBusy = () => {} } = {}) {
  const $ = id => globalThis.document?.getElementById(id) ?? null;
  const smoothing = { ...TRAJECTORY_SMOOTHING_DEFAULTS };
  const lines = { settings: { ...TRAJECTORY_LINE_SETTINGS_DEFAULTS, atomIds: [] }, result: null, controller: null, serial: 0 };
  const unwrapRequests = new Map();
  let controlsEnabled = false, unwrapController = null, applyingSmoothing = false;

  const options = () => ({ visible: lines.settings.visible, color: lines.settings.color, width: lines.settings.width,
    colorByTime: lines.settings.colorByTime, colorScheme: lines.settings.colorScheme });

  function text(id, value) { if ($(id)) $(id).textContent = value; }

  function syncTool() { tools?.setToolEnabled('trajectory', smoothing.enabled || Boolean(lines.result)); }

  function populateSchemes() {
    const select = $('trajectory-lines-scheme');
    if (!select || select.options?.length) return;
    const root = select.ownerDocument ?? globalThis.document;
    select.replaceChildren(...SCALAR_COLOR_SCHEMES.map(({ value, label }) => {
      const option = root.createElement('option'); option.value = value; option.textContent = label; return option;
    }));
  }

  function updateSourceOptions() {
    const select = $('trajectory-lines-source');
    if (!select) return;
    const root = select.ownerDocument ?? globalThis.document;
    const groups = getSelectionGroups() ?? [], chosen = lines.settings.source === 'group' ? lines.settings.selectionGroupId : null;
    const entries = [['ids', 'Atom IDs below'], ...groups.map(group => [`group:${group.id}`, `${group.name} · ${plural(group.atomIds.length, 'ID')}`])];
    if (chosen !== null && !groups.some(group => group.id === chosen)) entries.push([`group:${chosen}`, `Missing group (${chosen})`]);
    const signature = JSON.stringify(entries);
    if (select.dataset?.options !== signature) {
      select.replaceChildren(...entries.map(([value, label]) => {
        const option = root.createElement('option'); option.value = value; option.textContent = label; return option;
      }));
      if (select.dataset) select.dataset.options = signature;
    }
    select.value = chosen === null ? 'ids' : `group:${chosen}`;
  }

  function writeControls() {
    populateSchemes();
    if ($('trajectory-smooth-enabled')) $('trajectory-smooth-enabled').checked = smoothing.enabled;
    if ($('trajectory-smooth-window')) $('trajectory-smooth-window').value = String(smoothing.window);
    const settings = lines.settings, frameCount = Math.max(1, getFrameCount());
    if ($('trajectory-lines-ids') && globalThis.document?.activeElement !== $('trajectory-lines-ids')) $('trajectory-lines-ids').value = settings.atomIds.join(' ');
    if ($('trajectory-lines-first')) { $('trajectory-lines-first').value = String(settings.firstFrame + 1); $('trajectory-lines-first').max = String(frameCount); }
    if ($('trajectory-lines-last')) { $('trajectory-lines-last').value = String((settings.lastFrame ?? frameCount - 1) + 1); $('trajectory-lines-last').max = String(frameCount); }
    if ($('trajectory-lines-stride')) $('trajectory-lines-stride').value = String(settings.stride);
    if ($('trajectory-lines-color')) $('trajectory-lines-color').value = settings.color;
    if ($('trajectory-lines-width')) $('trajectory-lines-width').value = String(settings.width);
    if ($('trajectory-lines-time')) $('trajectory-lines-time').checked = settings.colorByTime;
    if ($('trajectory-lines-scheme')) $('trajectory-lines-scheme').value = settings.colorScheme;
    if ($('trajectory-lines-visible')) $('trajectory-lines-visible').checked = settings.visible;
    updateSourceOptions();
    updateControls();
  }

  function updateControls() {
    const frame = getFrame(), multiFrame = getFrameCount() > 1;
    const available = controlsEnabled && Boolean(frame) && multiFrame;
    for (const id of CONTROL_IDS) if ($(id)) $(id).disabled = !available || (id === 'generate-trajectory-lines' && Boolean(lines.controller));
    if ($('trajectory-smooth-window')) $('trajectory-smooth-window').disabled ||= applyingSmoothing;
    if ($('trajectory-smooth-enabled')) $('trajectory-smooth-enabled').disabled ||= applyingSmoothing;
    if ($('trajectory-lines-ids-field')) $('trajectory-lines-ids-field').hidden = lines.settings.source !== 'ids';
    if ($('trajectory-lines-scheme-field')) $('trajectory-lines-scheme-field').hidden = !lines.settings.colorByTime;
    if ($('trajectory-lines-color-field')) $('trajectory-lines-color-field').hidden = lines.settings.colorByTime;
    if ($('cancel-trajectory-lines')) $('cancel-trajectory-lines').disabled = !lines.controller;
    if ($('clear-trajectory-lines')) $('clear-trajectory-lines').disabled = !lines.result;
    if ($('cancel-trajectory-unwrap')) $('cancel-trajectory-unwrap').disabled = !unwrapController;
    updateUnwrapStatus();
    updateSmoothingStatus();
  }

  function updateUnwrapStatus(message = null) {
    if (message !== null) { text('trajectory-unwrap-status', message); return; }
    if (unwrapController) return;
    const frame = getFrame();
    if (!frame) text('trajectory-unwrap-status', 'Open a trajectory to unwrap, smooth or trace atom paths.');
    else if (frame.unwrappedPositions) text('trajectory-unwrap-status', `This frame provides unwrapped coordinates (${frame.unwrapSource ?? 'file data'}); they take precedence over inference.`);
    else if (!canInferUnwrap()) {
      text('trajectory-unwrap-status', getFrameCount() > 1
        ? 'Inference is unavailable while Replicate atoms is on; the file has no image data.'
        : 'This structure has one frame and no image data, so unwrapped coordinates are unavailable.');
    } else if (frame.inferredUnwrap) text('trajectory-unwrap-status', `Unwrapped coordinates of frame ${getFrameIndex() + 1} were inferred from frames 1–${getFrameIndex() + 1} in order.`);
    else text('trajectory-unwrap-status', 'No image data in the file. Choosing Display → Coordinates → Unwrapped infers image counts from consecutive frames.');
  }

  function updateSmoothingStatus() {
    const frame = getFrame();
    if (applyingSmoothing) return;
    if (!smoothing.enabled) text('trajectory-smooth-status', 'Off. Displayed and analyzed coordinates are the file coordinates.');
    else if (frame?.smoothing) {
      const { firstFrame, lastFrame, frameCount } = frame.smoothing;
      text('trajectory-smooth-status', `Frame ${getFrameIndex() + 1} is the average of ${plural(frameCount, 'frame')} (${firstFrame + 1}–${lastFrame + 1}). Every analysis uses these coordinates.`);
    } else text('trajectory-smooth-status', `Averaging ±${smoothing.window} frames…`);
  }

  function readWindow() {
    const input = $('trajectory-smooth-window');
    const value = input ? Number(input.value) : smoothing.window;
    if (!Number.isInteger(value) || value < 1 || value > MAX_SMOOTHING_WINDOW) {
      throw new Error(`The smoothing half window must be a whole number of frames from 1 to ${MAX_SMOOTHING_WINDOW}.`);
    }
    return value;
  }

  async function changeSmoothing(next) {
    const changed = next.enabled !== smoothing.enabled || (next.enabled && next.window !== smoothing.window);
    Object.assign(smoothing, next);
    syncTool();
    if (!changed) { writeControls(); return; }
    applyingSmoothing = true;
    text('trajectory-smooth-status', smoothing.enabled ? `Averaging ±${smoothing.window} frames…` : 'Restoring file coordinates…');
    updateControls();
    try { await onSmoothingChange({ ...smoothing }); }
    finally { applyingSmoothing = false; writeControls(); }
  }

  async function editSmoothing() {
    onEdit();
    let window;
    try { window = readWindow(); }
    catch (error) { notify(error.message); writeControls(); return; }
    const enabled = Boolean($('trajectory-smooth-enabled')?.checked);
    try { await changeSmoothing({ enabled, window }); }
    catch (error) { if (error.name !== 'AbortError') notify(error.message); }
  }

  /** Request fields for frames; null keeps the pre-existing request exactly. */
  function frameRequestOptions() {
    const window = smoothing.enabled ? smoothing.window : 0;
    const unwrap = getCoordinateMode() === 'unwrapped' && canInferUnwrap();
    return window || unwrap ? { unwrap, smoothing: window } : null;
  }

  function needsInferredUnwrap(frame) {
    return Boolean(frame) && !frame.unwrappedPositions && !frame.inferredUnwrap && canInferUnwrap();
  }

  /** Attach inferred display coordinates to an already delivered frame. */
  async function ensureInferredUnwrap(frame, index, { signal, showProgress = true } = {}) {
    if (!needsInferredUnwrap(frame)) return Boolean(frame?.unwrappedPositions || frame?.inferredUnwrap);
    const source = getSourceVersion();
    let request = unwrapRequests.get(frame);
    if (!request) {
      unwrapController ??= new AbortController();
      const controller = unwrapController;
      request = worker.trajectoryUnwrap(index, { smoothing: frame.smoothing?.window ?? 0, signal: controller.signal,
        onProgress: ({ loaded, total, stage }) => {
          const label = stage === 'trajectory-smooth' ? 'Averaging frames' : 'Unwrapping frames';
          const message = `${label}… ${integer(loaded)} / ${integer(total)}`;
          if (unwrapController === controller) updateUnwrapStatus(message);
          if (showProgress) setBusy(message);
        } }).then(({ inferredUnwrap }) => {
        if (source !== getSourceVersion()) return false;
        if (inferredUnwrap?.imageFlags.length === frame.ids.length * 3) frame.inferredUnwrap = inferredUnwrap;
        return Boolean(frame.inferredUnwrap);
      }).finally(() => {
        unwrapRequests.delete(frame);
        if (unwrapController === controller && !unwrapRequests.size) unwrapController = null;
        setBusy(null);
        updateControls();
      });
      unwrapRequests.set(frame, request);
      updateControls();
    }
    if (!signal) return request;
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException('Unwrapping wait cancelled.', 'AbortError'));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      request.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  function cancelUnwrap() {
    unwrapController?.abort();
    unwrapController = null;
    unwrapRequests.clear();
    setBusy(null);
    updateControls();
  }

  function readLineRequest() {
    const frameCount = getFrameCount();
    const settings = readLineSettings();
    const ids = settings.source === 'group'
      ? (getSelectionGroups() ?? []).find(group => group.id === settings.selectionGroupId)?.atomIds
      : settings.atomIds;
    if (!ids) throw new Error('The chosen selection group no longer exists.');
    if (!ids.length) throw new Error(settings.source === 'group' ? 'The chosen selection group is empty.' : 'Enter at least one atom ID.');
    const last = settings.lastFrame ?? frameCount - 1;
    if (settings.firstFrame >= frameCount || last >= frameCount) throw new Error(`Choose frames from 1 to ${frameCount}.`);
    const frames = trajectoryLineFrames(settings.firstFrame, last, settings.stride);
    trajectoryLineVertexCount(ids.length, frames.length, MAX_TRAJECTORY_LINE_VERTICES);
    return { settings, request: { ids: Array.from(ids), first: settings.firstFrame, last, stride: settings.stride } };
  }

  /** Settings from the inputs, validated; shared IDs stay in their groups. */
  function readLineSettings() {
    const value = id => $(id)?.value;
    const source = value('trajectory-lines-source') ?? (lines.settings.source === 'group' ? `group:${lines.settings.selectionGroupId}` : 'ids');
    const integerField = (id, fallback, label) => {
      const raw = value(id);
      if (raw === undefined) return fallback;
      const number = Number(raw);
      if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive whole number.`);
      return number;
    };
    const first = integerField('trajectory-lines-first', lines.settings.firstFrame + 1, 'First frame') - 1;
    const lastInput = integerField('trajectory-lines-last', (lines.settings.lastFrame ?? Math.max(0, getFrameCount() - 1)) + 1, 'Last frame') - 1;
    const stride = integerField('trajectory-lines-stride', lines.settings.stride, 'Frame step');
    if (lastInput < first) throw new Error('The last frame must not precede the first frame.');
    const atomIds = $('trajectory-lines-ids') ? parseSelectionAtomIds($('trajectory-lines-ids').value) : lines.settings.atomIds;
    if (atomIds.length > MAX_TRAJECTORY_LINE_IDS) throw new Error(`Enter at most ${integer(MAX_TRAJECTORY_LINE_IDS)} atom IDs, or use a selection group.`);
    const display = normalizeTrajectoryLineOptions({
      visible: $('trajectory-lines-visible') ? $('trajectory-lines-visible').checked : lines.settings.visible,
      color: value('trajectory-lines-color') ?? lines.settings.color,
      width: value('trajectory-lines-width') === undefined ? lines.settings.width : Number(value('trajectory-lines-width')),
      colorByTime: $('trajectory-lines-time') ? $('trajectory-lines-time').checked : lines.settings.colorByTime,
      colorScheme: value('trajectory-lines-scheme') || lines.settings.colorScheme,
    }, lines.settings);
    return { ...lines.settings, ...display, enabled: lines.settings.enabled,
      source: source.startsWith('group:') ? 'group' : 'ids',
      selectionGroupId: source.startsWith('group:') ? source.slice(6) : null,
      atomIds, firstFrame: first, lastFrame: lastInput === getFrameCount() - 1 ? null : lastInput, stride };
  }

  async function generateLines({ isCurrent = () => true } = {}) {
    let prepared;
    try {
      await ensureIndexed();
      prepared = readLineRequest();
    } catch (error) {
      text('trajectory-lines-status', error.message);
      notify(error.message);
      return false;
    }
    lines.controller?.abort();
    const controller = new AbortController(), serial = ++lines.serial, source = getSourceVersion();
    lines.controller = controller;
    lines.settings = prepared.settings;
    const current = () => serial === lines.serial && source === getSourceVersion() && !controller.signal.aborted && isCurrent();
    text('trajectory-lines-status', 'Reading frames…');
    updateControls();
    try {
      const result = await worker.trajectoryLines(prepared.request, { signal: controller.signal,
        onProgress: ({ loaded, total }) => { if (current()) text('trajectory-lines-status', `Reading frame ${integer(loaded)} / ${integer(total)}…`); } });
      if (!current()) return false;
      lines.result = result;
      lines.settings = { ...lines.settings, enabled: true };
      renderer.setTrajectoryLines(result, options());
      onLinesChange();
      const missing = result.missingCount ? ` ${plural(result.missingCount, 'ID')} not found (${result.missingAtomIds.slice(0, 5).join(', ')}${result.missingCount > 5 ? ', …' : ''}).` : '';
      text('trajectory-lines-status', `${plural(result.lineCount, 'path')} · ${plural(result.vertexCount, 'point')} · frames ${prepared.request.first + 1}–${prepared.request.last + 1}, every ${plural(prepared.request.stride, 'frame')}.${missing}`);
      return true;
    } catch (error) {
      if (serial === lines.serial) text('trajectory-lines-status', error.name === 'AbortError' ? 'Cancelled.' : error.message);
      if (error.name !== 'AbortError' && current()) notify(error.message);
      return false;
    } finally {
      if (lines.controller === controller) lines.controller = null;
      syncTool();
      updateControls();
    }
  }

  function cancelLines() {
    lines.serial++;
    lines.controller?.abort();
    lines.controller = null;
    text('trajectory-lines-status', 'Cancelled.');
    updateControls();
  }

  function clearLines({ status = 'Generate lines to trace the chosen atoms.' } = {}) {
    lines.serial++;
    lines.controller?.abort();
    lines.controller = null;
    lines.result = null;
    lines.settings = { ...lines.settings, enabled: false };
    renderer.setTrajectoryLines(null, options());
    onLinesChange();
    text('trajectory-lines-status', status);
    syncTool();
    updateControls();
  }

  /** Appearance edits apply immediately; atom and frame choices are kept
   * for the next Generate. Neither recomputes the current paths. */
  function editSettings() {
    onEdit();
    try {
      const { enabled, ...settings } = readLineSettings();
      lines.settings = { ...settings, enabled: lines.settings.enabled };
      renderer.setTrajectoryLines(lines.result, options());
      onLinesChange();
    } catch (error) { notify(error.message); writeControls(); }
    updateControls();
  }

  $('trajectory-smooth-enabled')?.addEventListener('change', () => { void editSmoothing(); });
  $('trajectory-smooth-window')?.addEventListener('change', () => { if (smoothing.enabled) void editSmoothing(); else { onEdit(); try { smoothing.window = readWindow(); } catch (error) { notify(error.message); writeControls(); } } });
  for (const id of ['trajectory-lines-source', 'trajectory-lines-ids', 'trajectory-lines-first', 'trajectory-lines-last', 'trajectory-lines-stride',
    'trajectory-lines-color', 'trajectory-lines-width', 'trajectory-lines-time', 'trajectory-lines-scheme', 'trajectory-lines-visible']) {
    $(id)?.addEventListener(id === 'trajectory-lines-color' ? 'input' : 'change', editSettings);
  }
  $('generate-trajectory-lines')?.addEventListener('click', () => { onEdit(); void generateLines(); });
  $('cancel-trajectory-lines')?.addEventListener('click', () => { onEdit(); cancelLines(); });
  $('clear-trajectory-lines')?.addEventListener('click', () => { onEdit(); clearLines(); });
  $('cancel-trajectory-unwrap')?.addEventListener('click', () => { onEdit(); cancelUnwrap(); });
  writeControls();

  return {
    frameRequestOptions,
    needsInferredUnwrap,
    ensureInferredUnwrap,
    cancelUnwrap,
    generateLines,
    cancelLines,
    clearLines,
    smoothingWindow: () => smoothing.enabled ? smoothing.window : 0,
    getSmoothing: () => ({ ...smoothing }),
    /** Set smoothing without applying it; returns whether processing changed. */
    setSmoothing(next = TRAJECTORY_SMOOTHING_DEFAULTS) {
      const enabled = Boolean(next.enabled), window = next.window ?? smoothing.window;
      const changed = enabled !== smoothing.enabled || (enabled && window !== smoothing.window);
      Object.assign(smoothing, { enabled, window });
      syncTool(); writeControls();
      return changed;
    },
    setEnabled(enabled) { controlsEnabled = Boolean(enabled); writeControls(); },
    refresh: writeControls,
    onFrame() { updateControls(); },
    reset() {
      cancelUnwrap();
      lines.serial++;
      lines.controller?.abort();
      lines.controller = null;
      lines.result = null;
      lines.settings = { ...TRAJECTORY_LINE_SETTINGS_DEFAULTS, atomIds: [] };
      Object.assign(smoothing, TRAJECTORY_SMOOTHING_DEFAULTS);
      renderer.setTrajectoryLines(null, options());
      text('trajectory-lines-status', 'Generate lines to trace the chosen atoms.');
      syncTool();
      writeControls();
    },
    /** Closing the tool turns smoothing off and removes the lines. */
    async deactivate() {
      clearLines();
      if (smoothing.enabled) await changeSmoothing({ enabled: false, window: smoothing.window });
      syncTool();
    },
    serialize() {
      const settings = lines.settings;
      return {
        smoothing: { enabled: smoothing.enabled, window: smoothing.window },
        lines: { enabled: Boolean(lines.result), source: settings.source, selectionGroupId: settings.source === 'group' ? settings.selectionGroupId : null,
          atomIds: settings.source === 'ids' ? [...settings.atomIds] : [], firstFrame: settings.firstFrame, lastFrame: settings.lastFrame,
          stride: settings.stride, visible: settings.visible, color: settings.color, width: settings.width,
          colorByTime: settings.colorByTime, colorScheme: settings.colorScheme },
      };
    },
    /** Restore line settings, and recalculate the paths that were shown. */
    async restoreLines(saved, { isCurrent = () => true } = {}) {
      clearLines();
      if (!saved) { writeControls(); return true; }
      lines.settings = { ...TRAJECTORY_LINE_SETTINGS_DEFAULTS, ...saved, atomIds: [...(saved.atomIds ?? [])] };
      writeControls();
      if (!saved.enabled) return true;
      return generateLines({ isCurrent });
    },
    getLines: () => lines.result,
    isBusy: () => Boolean(lines.controller || unwrapController || applyingSmoothing),
  };
}
