import { DxaClient } from './analysis/dxa-client.js';
import { MAX_SURFACE_SMOOTHING, SURFACE_MESH_DEFAULTS as ANALYSIS_DEFAULTS, suggestProbeRadius, surfaceMeshRegions } from './analysis/surface-mesh.js';
import { atomIdSet, hasAtomId } from './data/atom-ids.js';
import { downloadBlob } from './export-archive.js';
import { MESH_EXPORT_FORMATS, createMeshExport } from './io/mesh-export.js';
import { buildSurfaceDisplayMesh } from './render/surface-mesh-geometry.js';
import { SURFACE_MESH_DEFAULTS as STYLE_DEFAULTS, surfaceMeshDisplayState } from './render/surface-mesh-layer.js';

/** Which atoms enter the tessellation: every atom, the atoms the display
 * filters leave visible (slices do not count), or a named selection group. */
export const SURFACE_ATOM_MODES = Object.freeze(['all', 'visible', 'group']);
export const SURFACE_MESH_TOOL_DEFAULTS = Object.freeze({ radius: null, smoothingLevel: ANALYSIS_DEFAULTS.smoothingLevel,
  atoms: 'all', selectionGroupId: null, ...STYLE_DEFAULTS.surface });
const HELP = 'Uses every atom of the frame unless a restriction is chosen, including atoms hidden by slices.';
const REGION_ROWS = 8, VISIBILITY_DELAY_MS = 600;
const STYLE_FIELDS = { color: 'surface-mesh-color', interiorColor: 'surface-mesh-interior-color', capColor: 'surface-mesh-cap-color' };

const integer = value => Number(value).toLocaleString('en-US');
const format = (value, digits = 6) => Number.isFinite(value)
  ? Number(value).toLocaleString('en-US', { maximumSignificantDigits: digits }) : '—';
const percent = value => `${(100 * value).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
const duration = ms => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;

/** 32-bit FNV-1a of a mask, so a cached result is reused only for the same atoms. */
export function maskDigest(mask) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < mask.length; index += 1) hash = Math.imul(hash ^ (mask[index] ? 1 : 0), 0x01000193);
  return (hash >>> 0).toString(16);
}

/** Rows of the statistics table: [label, value, unit]. */
export function surfaceSummaryRows(result) {
  return [
    ['Surface area', format(result.surfaceArea), 'Å²'],
    ['Solid volume', `${format(result.filledVolume)} (${percent(result.filledFraction)})`, 'Å³'],
    ['Empty volume', `${format(result.emptyVolume)} (${percent(result.emptyFraction)})`, 'Å³'],
    ['Void volume', `${format(result.voidVolume)} (${percent(result.voidFraction)})`, 'Å³'],
    ['Solid regions', integer(result.filledRegionCount), ''],
    ['Empty regions', `${integer(result.emptyRegionCount)} (${integer(result.voidRegionCount)} voids)`, ''],
    ['Surface components', integer(result.surfaceComponentCount), ''],
    ['Specific surface area', format(result.specificSurfaceArea), 'Å⁻¹'],
  ];
}

/** Alpha-shape surface of the displayed frame. The result is cached per frame,
 * settings and atom restriction; display choices never recalculate. */
export function initializeSurfaceTools({ renderer, tools, client = new DxaClient(), getFrame, getFrames = () => [getFrame()],
  getSourceVersion = () => 0, getSelectionGroups = () => [], getVisibility = () => renderer?.visibility ?? null,
  getFileStem = () => 'structure', getFrameIndex = () => 0, onResultsChange = () => {}, onDisplayChange = () => {},
  onEdit = () => {}, notify = () => {}, onDownload = downloadBlob,
  setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = id => clearTimeout(id) }) {
  const $ = id => globalThis.document?.getElementById(id) ?? null;
  const job = { enabled: false, failed: false, queued: false, controller: null, serial: 0, cached: null, frame: null,
    settings: { ...SURFACE_MESH_TOOL_DEFAULTS } };
  const memberSerials = new WeakMap();
  let controlsEnabled = false, generation = 0, nextMemberSerial = 1, visibilityTimer = null, radiusEdited = false;

  function updateControls() {
    const available = controlsEnabled && Boolean(getFrame());
    for (const id of ['surface-mesh-radius', 'surface-mesh-smoothing', 'surface-mesh-selection', 'surface-mesh-suggest', 'surface-mesh-visible',
      'surface-mesh-caps', 'surface-mesh-opacity', ...Object.values(STYLE_FIELDS)]) if ($(id)) $(id).disabled = !available;
    if ($('run-surface-mesh')) $('run-surface-mesh').disabled = !available || Boolean(job.controller) || job.queued;
    if ($('cancel-surface-mesh')) $('cancel-surface-mesh').disabled = !available || (!job.enabled && !job.failed);
    for (const { id } of MESH_EXPORT_FORMATS) if ($(`export-surface-mesh-${id}`)) $(`export-surface-mesh-${id}`).disabled = !available || !job.cached?.result.faceCount;
  }

  function state(label, text = '') {
    if ($('surface-mesh-state')) {
      $('surface-mesh-state').textContent = label;
      $('surface-mesh-state').classList.toggle('ready', label === 'Calculated');
    }
    if (text && $('surface-mesh-status')) $('surface-mesh-status').textContent = text;
    updateControls();
  }

  function syncTool({ reveal = false } = {}) { tools?.setToolEnabled('surfaceMesh', job.enabled, { reveal }); }

  function updateSelectionOptions() {
    const select = $('surface-mesh-selection');
    if (!select) return;
    const root = select.ownerDocument ?? globalThis.document, groups = getSelectionGroups() ?? [];
    const option = (value, text) => { const item = root.createElement('option'); item.value = value; item.textContent = text; return item; };
    const options = [option('all', 'All atoms'), option('visible', 'Visible atoms'),
      ...groups.map(group => option(`group:${group.id}`, `${group.name} · ${integer(group.atomIds.length)} IDs`))];
    const { atoms, selectionGroupId } = job.settings;
    if (atoms === 'group' && !groups.some(group => group.id === selectionGroupId)) options.push(option(`group:${selectionGroupId}`, `Missing group (${selectionGroupId})`));
    select.replaceChildren(...options);
    select.value = atoms === 'group' ? `group:${selectionGroupId}` : atoms;
  }

  function atomChoice() {
    const value = $('surface-mesh-selection')?.value;
    if (value === undefined || value === null || value === '') return { atoms: job.settings.atoms, selectionGroupId: job.settings.selectionGroupId };
    if (value.startsWith('group:')) return { atoms: 'group', selectionGroupId: value.slice(6) };
    return { atoms: value === 'visible' ? 'visible' : 'all', selectionGroupId: null };
  }

  const numberInput = (id, fallback) => {
    const input = $(id);
    if (!input) return fallback;
    return input.value === '' ? NaN : input.valueAsNumber ?? Number(input.value);
  };

  function displaySettings() {
    const opacity = numberInput('surface-mesh-opacity', job.settings.opacity);
    const settings = { visible: $('surface-mesh-visible') ? Boolean($('surface-mesh-visible').checked) : job.settings.visible,
      caps: $('surface-mesh-caps') ? Boolean($('surface-mesh-caps').checked) : job.settings.caps,
      opacity: Number.isFinite(opacity) && opacity >= 0 && opacity <= 1 ? opacity : job.settings.opacity };
    for (const [name, id] of Object.entries(STYLE_FIELDS)) {
      const value = $(id)?.value;
      settings[name] = /^#[0-9a-f]{6}$/i.test(value ?? '') ? value.toLowerCase() : job.settings[name];
    }
    return settings;
  }

  /** Analysis settings from the panel; throws a message for invalid input. */
  function parameters() {
    const radius = numberInput('surface-mesh-radius', job.settings.radius);
    if (!Number.isFinite(radius) || radius <= 0) throw new Error('Enter a positive probe sphere radius.');
    const smoothingLevel = numberInput('surface-mesh-smoothing', job.settings.smoothingLevel);
    if (!Number.isInteger(smoothingLevel) || smoothingLevel < 0 || smoothingLevel > MAX_SURFACE_SMOOTHING) {
      throw new Error(`Enter a smoothing level from 0 to ${MAX_SURFACE_SMOOTHING}.`);
    }
    const choice = atomChoice();
    const group = choice.atoms === 'group' ? (getSelectionGroups() ?? []).find(item => item.id === choice.selectionGroupId) : null;
    if (choice.atoms === 'group' && !group) throw new Error('The selected atom group no longer exists. Choose another group or All atoms.');
    return { settings: { radius, smoothingLevel, ...choice }, group };
  }

  function memberSerial(atomIds) {
    if (!memberSerials.has(atomIds)) memberSerials.set(atomIds, nextMemberSerial++);
    return memberSerials.get(atomIds);
  }

  function atomMask(frame, settings, group) {
    if (settings.atoms === 'all') return null;
    const mask = new Uint8Array(frame.ids.length);
    if (settings.atoms === 'visible') {
      const visibility = getVisibility();
      if (visibility?.length !== mask.length) return null;
      for (let atom = 0; atom < mask.length; atom += 1) mask[atom] = visibility[atom] ? 1 : 0;
    } else {
      const members = atomIdSet(group.atomIds);
      for (let atom = 0; atom < mask.length; atom += 1) if (hasAtomId(members, frame.ids[atom])) mask[atom] = 1;
    }
    return mask;
  }

  function abort() {
    job.serial++;
    job.controller?.abort();
    job.controller = null;
    job.queued = false;
    if (visibilityTimer !== null) { clearTimer(visibilityTimer); visibilityTimer = null; }
    if ($('surface-mesh-progress')) $('surface-mesh-progress').hidden = true;
    updateControls();
  }

  function draw() {
    const cached = job.cached, frame = getFrame(), display = displaySettings();
    job.settings = { ...job.settings, ...display };
    if (!renderer?.setSurfaceMesh) return;
    const shown = cached && frame && job.frame === frame && renderer.frame === frame && cached.result.faceCount > 0;
    try {
      const entry = renderer.setSurfaceMesh('surface', shown ? cached.mesh : null, display);
      if ($('surface-mesh-display-status')) {
        $('surface-mesh-display-status').textContent = entry?.error ? `The surface cannot be displayed: ${entry.error}`
          : cached && !cached.result.faceCount ? (cached.result.spaceFilling ? 'The solid fills the whole cell: there is no surface to draw.'
            : 'No solid region was found: there is no surface to draw.') : '';
      }
    } catch (error) { notify(error.message); }
    onDisplayChange();
  }

  function clearView() {
    job.cached = null;
    if ($('surface-mesh-results')) $('surface-mesh-results').hidden = true;
    if ($('surface-mesh-summary')) $('surface-mesh-summary').textContent = '';
    if ($('surface-mesh-backend')) $('surface-mesh-backend').textContent = '—';
    if ($('surface-mesh-status')) $('surface-mesh-status').title = '';
    $('surface-mesh-table-body')?.replaceChildren();
    $('surface-mesh-region-body')?.replaceChildren();
    draw();
    updateControls();
  }

  function clearFrames() {
    for (const frame of new Set([...(getFrames() ?? []), getFrame(), job.frame])) {
      if (frame?.atomeyeResults) delete frame.atomeyeResults.surfaceMesh;
    }
    job.frame = null;
  }

  function cancel({ clearSettings = true, silent = false } = {}) {
    abort();
    job.enabled = false; job.failed = false;
    // Stop a queued or running job while keeping the warmed kernel.
    clearFrames(); clearView(); syncTool();
    state('Not calculated', HELP);
    if (!silent) onResultsChange({ clearSettings });
    return true;
  }

  function renderTables(result) {
    const root = $('surface-mesh-table-body')?.ownerDocument ?? globalThis.document;
    const cell = (tag, text) => { const item = root.createElement(tag); item.textContent = text; return item; };
    if ($('surface-mesh-table-body')) {
      $('surface-mesh-table-body').replaceChildren(...surfaceSummaryRows(result).map(([label, value, unit]) => {
        const row = root.createElement('tr'), heading = cell('th', label);
        heading.scope = 'row';
        row.append(heading, cell('td', value), cell('td', unit));
        return row;
      }));
    }
    if ($('surface-mesh-region-body')) {
      // Largest first within solid regions, voids and exterior space.
      const order = { filled: 0, void: 1, exterior: 2 };
      const regions = surfaceMeshRegions(result).sort((first, second) => order[first.kind] - order[second.kind] || second.volume - first.volume);
      $('surface-mesh-region-body').replaceChildren(...regions.slice(0, REGION_ROWS).map(region => {
        const row = root.createElement('tr');
        row.append(cell('td', String(region.id)), cell('td', region.kind === 'filled' ? 'Solid' : region.kind === 'void' ? 'Void' : 'Exterior'),
          cell('td', format(region.volume)), cell('td', format(region.surfaceArea)));
        return row;
      }));
      if ($('surface-mesh-region-caption')) {
        $('surface-mesh-region-caption').textContent = regions.length > REGION_ROWS
          ? `Showing ${REGION_ROWS} of ${integer(regions.length)} regions; the summary CSV lists all of them.` : '';
      }
    }
  }

  function showResult(cached, frame) {
    const { result } = cached;
    job.cached = cached; job.frame = frame; job.failed = false;
    cached.mesh ??= { vertices: result.vertices, triangles: result.triangles, spaceFilling: Boolean(result.spaceFilling) };
    if ($('surface-mesh-results')) $('surface-mesh-results').hidden = false;
    if ($('surface-mesh-summary')) {
      $('surface-mesh-summary').textContent = [`${integer(result.faceCount)} triangles`, `${integer(result.vertexCount)} vertices`,
        result.inputCount === result.atomCount ? `${integer(result.atomCount)} atoms` : `${integer(result.inputCount)} of ${integer(result.atomCount)} atoms`,
        `probe radius ${format(result.radius)} Å`, `smoothing ${result.smoothingLevel}`].join(' · ');
    }
    renderTables(result);
    const threads = result.workerCount ?? 1, backend = `Wasm CPU · ${integer(threads)} ${threads === 1 ? 'thread' : 'threads'}`;
    if ($('surface-mesh-backend')) $('surface-mesh-backend').textContent = backend;
    if ($('surface-mesh-status')) {
      $('surface-mesh-status').title = [result.threadingFallback ? `CPU threading fallback: ${result.threadingFallback}` : '',
        ...(result.stageTimings ?? []).map(stage => `${stage.phase}: ${duration(stage.elapsedMs)}`)].filter(Boolean).join('\n');
    }
    if ($('surface-mesh-progress')) { $('surface-mesh-progress').hidden = true; $('surface-mesh-progress').value = 1; }
    state('Calculated', `${backend} · ${duration(result.elapsedMs ?? 0)}`);
    draw();
    onResultsChange({ frame, clearSettings: false });
  }

  async function run({ automatic = false, isCurrent = () => true } = {}) {
    const frame = getFrame();
    if (!frame || !isCurrent()) return false;
    let prepared;
    try { prepared = parameters(); }
    catch (error) {
      abort(); job.failed = true;
      clearFrames(); clearView(); onResultsChange({ clearSettings: false });
      state('Failed', error.message);
      if (!automatic) notify(error.message);
      return false;
    }
    if (!automatic) onEdit();
    job.settings = { ...job.settings, ...prepared.settings };
    abort(); job.enabled = true; job.failed = false;
    syncTool({ reveal: !automatic });
    const request = job.serial, token = generation, source = getSourceVersion();
    const controller = new AbortController(); job.controller = controller; job.queued = false;
    const current = () => request === job.serial && token === generation && source === getSourceVersion()
      && frame === getFrame() && job.enabled && !controller.signal.aborted && isCurrent();
    const { settings, group } = prepared;
    const mask = atomMask(frame, settings, group);
    const key = JSON.stringify({ radius: settings.radius, smoothingLevel: settings.smoothingLevel, atoms: mask ? settings.atoms : 'all',
      selection: settings.atoms === 'group' ? [group.id, memberSerial(group.atomIds)] : mask ? maskDigest(mask) : null, sourceVersion: source });
    try {
      let cached = frame.atomeyeResults?.surfaceMesh;
      if (cached?.key !== key) {
        if (frame.atomeyeResults) delete frame.atomeyeResults.surfaceMesh;
        clearView(); job.frame = frame;
        state('Calculating…', `Preparing the surface of ${integer(frame.ids.length)} atoms…`);
        onResultsChange({ frame, clearSettings: false });
        const result = await client.surface(frame, { radius: settings.radius, smoothingLevel: settings.smoothingLevel }, {
          mask, signal: controller.signal,
          onProgress: progress => {
            if (!current()) return;
            const stage = String(progress.phase ?? 'Analyzing').replace(/[-_]/g, ' ');
            const done = progress.completedStages ?? 0, total = progress.totalStages ?? 6, threads = progress.workerCount ?? 1;
            if ($('surface-mesh-status')) $('surface-mesh-status').textContent = `${stage} · ${integer(threads)} ${threads === 1 ? 'thread' : 'threads'} · ${done} / ${total} stages`;
            const meter = $('surface-mesh-progress');
            if (meter) { meter.hidden = false; meter.value = Math.max(0, Math.min(1, done / total)); }
          },
        });
        if (!current()) return false;
        cached = { key, result };
        frame.atomeyeResults ??= {}; frame.atomeyeResults.surfaceMesh = cached;
      }
      if (!current()) return false;
      job.controller = null;
      showResult(cached, frame);
      return true;
    } catch (error) {
      if (!current() || error.name === 'AbortError') return false;
      job.controller = null; job.failed = true;
      if (frame.atomeyeResults) delete frame.atomeyeResults.surfaceMesh;
      clearView(); state('Failed', error.message);
      onResultsChange({ frame, clearSettings: false });
      if (!automatic) notify(error.message);
      return false;
    } finally {
      if (job.controller === controller) job.controller = null;
      updateControls();
    }
  }

  function showSuggestion(frame, { apply = false } = {}) {
    const suggestion = suggestProbeRadius(frame);
    if (apply && $('surface-mesh-radius')) $('surface-mesh-radius').value = String(suggestion.radius);
    if ($('surface-mesh-radius-help')) $('surface-mesh-radius-help').textContent = `Suggested: ${suggestion.message}`;
    return suggestion;
  }

  async function onFrame() {
    abort(); clearView();
    const frame = getFrame();
    if (frame) {
      // Keep an edited or saved radius; otherwise follow the suggestion.
      const input = $('surface-mesh-radius');
      showSuggestion(frame, { apply: Boolean(input) && (!input.value || (!job.enabled && !radiusEdited && job.settings.radius === null)) });
    }
    updateSelectionOptions();
    job.queued = job.enabled;
    updateControls();
    if (!job.enabled) { state('Not calculated', HELP); return false; }
    return run({ automatic: true });
  }

  function applySettings(settings) {
    if ($('surface-mesh-radius') && settings.radius !== null) $('surface-mesh-radius').value = String(settings.radius);
    if ($('surface-mesh-smoothing')) $('surface-mesh-smoothing').value = String(settings.smoothingLevel);
    if ($('surface-mesh-visible')) $('surface-mesh-visible').checked = settings.visible;
    if ($('surface-mesh-caps')) $('surface-mesh-caps').checked = settings.caps;
    if ($('surface-mesh-opacity')) $('surface-mesh-opacity').value = String(settings.opacity);
    for (const [name, id] of Object.entries(STYLE_FIELDS)) if ($(id)) $(id).value = settings[name];
    updateSelectionOptions();
    updateControls();
  }

  function reset() {
    generation++;
    cancel({ silent: true });
    job.settings = { ...SURFACE_MESH_TOOL_DEFAULTS };
    radiusEdited = false;
    if ($('surface-mesh-radius')) $('surface-mesh-radius').value = '';
    applySettings(job.settings);
    onResultsChange({ clearSettings: true });
  }

  function serialize() {
    const radius = numberInput('surface-mesh-radius', job.settings.radius), smoothingLevel = numberInput('surface-mesh-smoothing', job.settings.smoothingLevel);
    // A radius that only shows the suggestion is not a saved choice.
    return { enabled: job.enabled, radius: !job.enabled && !radiusEdited ? job.settings.radius
      : Number.isFinite(radius) && radius > 0 ? radius : job.settings.radius,
      smoothingLevel: Number.isInteger(smoothingLevel) && smoothingLevel >= 0 && smoothingLevel <= MAX_SURFACE_SMOOTHING ? smoothingLevel : job.settings.smoothingLevel,
      ...atomChoice(), ...displaySettings() };
  }

  async function restore(saved, { isCurrent = () => true } = {}) {
    if (!isCurrent()) return false;
    generation++;
    cancel({ clearSettings: false, silent: true });
    const settings = { ...SURFACE_MESH_TOOL_DEFAULTS, ...(saved ?? {}) };
    job.settings = { radius: settings.radius ?? null, smoothingLevel: settings.smoothingLevel,
      atoms: SURFACE_ATOM_MODES.includes(settings.atoms) ? settings.atoms : 'all', selectionGroupId: settings.selectionGroupId ?? null,
      visible: settings.visible !== false, caps: settings.caps !== false, opacity: settings.opacity,
      color: settings.color, interiorColor: settings.interiorColor, capColor: settings.capColor };
    radiusEdited = job.settings.radius !== null;
    applySettings(job.settings);
    const frame = getFrame();
    if (frame && job.settings.radius === null) showSuggestion(frame, { apply: true });
    job.enabled = Boolean(saved?.enabled); job.queued = job.enabled; syncTool();
    onResultsChange({ clearSettings: false });
    if (!job.enabled || !isCurrent()) return false;
    return run({ automatic: true, isCurrent });
  }

  function refreshSelectionGroups() {
    updateSelectionOptions();
    return job.enabled && job.settings.atoms === 'group' ? run({ automatic: true }) : Promise.resolve(false);
  }

  /** Display filters changed. A surface of the visible atoms is rebuilt once
   * the filters have settled, so dragging a legend limit starts one job. */
  function refreshVisibility() {
    if (!job.enabled || job.settings.atoms !== 'visible' || job.failed) return false;
    if (visibilityTimer !== null) clearTimer(visibilityTimer);
    visibilityTimer = setTimer(() => { visibilityTimer = null; if (job.enabled && job.settings.atoms === 'visible') void run({ automatic: true }); }, VISIBILITY_DELAY_MS);
    return true;
  }

  function exportMesh(format) {
    const cached = job.cached, frame = getFrame();
    if (!cached || !frame || job.frame !== frame) { notify('Construct the surface before exporting it.'); return null; }
    try {
      const display = displaySettings(), view = renderer?.frame === frame ? surfaceMeshDisplayState(renderer) : { origin: [0, 0, 0], translation: [0, 0, 0] };
      const mesh = buildSurfaceDisplayMesh(cached.mesh, frame.cell, { origin: view.origin, caps: display.caps, spaceFilling: cached.mesh.spaceFilling });
      const file = createMeshExport(mesh, format, { caps: display.caps, translation: view.translation,
        stem: `${getFileStem()}-frame-${getFrameIndex() + 1}-surface`, title: `AlloyView surface mesh, probe radius ${cached.result.radius} A` });
      onDownload(file.blob, file.filename);
      return file;
    } catch (error) { notify(error.message); return null; }
  }

  $('run-surface-mesh')?.addEventListener('click', () => { void run(); });
  $('cancel-surface-mesh')?.addEventListener('click', () => { onEdit(); cancel(); });
  $('surface-mesh-suggest')?.addEventListener('click', () => {
    const frame = getFrame();
    if (!frame) return;
    onEdit(); radiusEdited = false;
    showSuggestion(frame, { apply: true });
    if (job.enabled) void run({ automatic: true });
  });
  for (const id of ['surface-mesh-radius', 'surface-mesh-smoothing', 'surface-mesh-selection']) {
    $(id)?.addEventListener('change', () => {
      onEdit();
      if (id === 'surface-mesh-radius') radiusEdited = true;
      if (id === 'surface-mesh-selection') job.settings = { ...job.settings, ...atomChoice() };
      updateControls();
      if (job.enabled) void run({ automatic: true });
    });
  }
  for (const id of ['surface-mesh-visible', 'surface-mesh-caps', ...Object.values(STYLE_FIELDS)]) {
    $(id)?.addEventListener('change', () => { onEdit(); draw(); });
  }
  // Colors and opacity follow the pointer; nothing is recalculated.
  for (const id of ['surface-mesh-opacity', ...Object.values(STYLE_FIELDS)]) $(id)?.addEventListener('input', () => { onEdit(); draw(); });
  for (const { id } of MESH_EXPORT_FORMATS) $(`export-surface-mesh-${id}`)?.addEventListener('click', () => { exportMesh(id); });
  applySettings(job.settings);
  state('Not calculated', HELP);

  return Object.freeze({ run, onFrame, reset, cancel, serialize, restore, refreshSelectionGroups, refreshVisibility, exportMesh, redraw: draw,
    abortJobs: abort,
    isEnabled: () => job.enabled,
    /** Whether nothing was calculated or changed, so recipes need no entry. */
    isUntouched() {
      const saved = serialize();
      return !saved.enabled && Object.keys(SURFACE_MESH_TOOL_DEFAULTS).every(name => saved[name] === SURFACE_MESH_TOOL_DEFAULTS[name]);
    },
    setEnabled(value) { controlsEnabled = Boolean(value); updateSelectionOptions(); updateControls(); },
    getResult: () => job.cached?.result ?? null,
    pendingKinds: () => job.enabled && !job.failed && (job.controller || job.queued) ? ['surfaceMesh'] : [],
    failed: () => job.failed ? ['surfaceMesh'] : [],
  });
}
