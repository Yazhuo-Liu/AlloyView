import { THERMAL_DEFAULTS } from '../../crystal/thermal-ellipsoids.js';
import { normalizeThermalOptions } from '../../render/thermal-ellipsoid-layer.js';
import { determinant3 } from '../../data/model.js';
import { analysisBackendLabel, analysisBackendDetails, analysisProgressText } from '../../analysis/status.js';

export const CRYSTAL_TOOL_DEFAULTS = Object.freeze({
  cutoff: 3, centerTypes: null, neighborTypes: null, visible: true,
  color: '#3b82f6', opacity: 0.35, showEdges: true,
});
const HELP = 'Construct convex polyhedra from neighboring atom positions within the cutoff. Periodic images are included; display hiding does not remove neighbors.';
const count = value => Number(value).toLocaleString('en-US');
const numeric = value => Number.isFinite(value) ? Number(value.toPrecision(7)).toString() : '—';
const copyLabels = values => values === null ? null : [...values];
const copySettings = settings => ({ ...settings, centerTypes: copyLabels(settings.centerTypes), neighborTypes: copyLabels(settings.neighborTypes) });

/** Actual cell geometry, independent of the declared crystallographic setting. */
export function crystalCellMetrics(cell) {
  const h = cell?.vectors;
  if (!h || h.length !== 9 || !Array.from(h).every(Number.isFinite)) return null;
  const lengths = [0, 3, 6].map(offset => Math.hypot(h[offset], h[offset + 1], h[offset + 2]));
  if (lengths.some(length => length <= 0)) return null;
  const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1,
    (h[a * 3] * h[b * 3] + h[a * 3 + 1] * h[b * 3 + 1] + h[a * 3 + 2] * h[b * 3 + 2]) / (lengths[a] * lengths[b])))) * 180 / Math.PI;
  return { lengths, angles: [angle(1, 2), angle(0, 2), angle(0, 1)], volume: Math.abs(determinant3(h)) };
}

/** Crystal inspection is available immediately; polyhedra remain opt-in. */
export function initializeCrystalTools({ renderer, tools, pool, getFrame, getSourceVersion = () => 0,
  getFrameIndex = () => 0, onEdit = () => {}, onDisplayChange = () => {}, onResultsChange = () => {},
  notify = () => {}, onExport = null, onExportStatistics = null }) {
  const $ = id => globalThis.document?.getElementById(id) ?? null;
  const job = { enabled: false, failed: false, controller: null, serial: 0, result: null, frame: null,
    settings: copySettings(CRYSTAL_TOOL_DEFAULTS) };
  let controlsEnabled = false, exportBusy = false, generation = 0;
  let thermalSettings = { ...THERMAL_DEFAULTS };
  const typeInputs = new Map();

  function updateControls() {
    const available = controlsEnabled && Boolean(getFrame());
    for (const id of ['crystal-cutoff', 'crystal-visible', 'crystal-color', 'crystal-opacity', 'crystal-edges']) {
      if ($(id)) $(id).disabled = !available;
    }
    const thermal = getFrame()?.thermalEllipsoids;
    for (const id of ['thermal-enabled', 'thermal-probability', 'thermal-opacity']) if ($(id)) $(id).disabled = !available || !thermal?.count;
    if ($('thermal-status')) $('thermal-status').textContent = thermal?.count
      ? `${count(thermal.count)} sites have positive-definite displacement tensors. Ellipsoids replace their atom spheres; sites without valid tensors keep ordinary spheres.`
      : 'No renderable displacement tensors in this structure. Import CIF anisotropic Uij/Bij or isotropic Uiso/Biso values.';
    for (const inputs of typeInputs.values()) for (const input of inputs) input.disabled = !available || input.missingType;
    if ($('run-crystal')) $('run-crystal').disabled = !available || Boolean(job.controller);
    if ($('cancel-crystal')) $('cancel-crystal').disabled = !available || (!job.enabled && !job.failed);
    for (const format of ['cif', 'poscar']) {
      if ($(`export-crystal-${format}`)) $(`export-crystal-${format}`).disabled = !available || exportBusy || !onExport;
    }
    if ($('export-crystal-statistics')) $('export-crystal-statistics').disabled = !available || exportBusy || !job.result || !onExportStatistics;
  }

  function state(label, text) {
    if ($('crystal-state')) {
      $('crystal-state').textContent = label;
      $('crystal-state').classList.toggle('ready', label === 'Calculated');
    }
    if (text !== undefined && $('crystal-status')) $('crystal-status').textContent = text;
    updateControls();
  }

  function syncTool({ reveal = false } = {}) { tools?.setToolEnabled('crystal', job.enabled || thermalSettings.enabled, { reveal }); }

  function updateFrameInfo() {
    const frame = getFrame(), metrics = crystalCellMetrics(frame?.cell), crystal = frame?.crystal;
    if ($('crystal-cell-lengths')) $('crystal-cell-lengths').textContent = metrics ? metrics.lengths.map(numeric).join(' · ') : '—';
    if ($('crystal-cell-angles')) $('crystal-cell-angles').textContent = metrics ? metrics.angles.map(numeric).join(' · ') : '—';
    if ($('crystal-cell-volume')) $('crystal-cell-volume').textContent = metrics ? numeric(metrics.volume) : '—';
    const group = crystal?.spaceGroup;
    const spaceGroup = [group?.name, Number.isInteger(group?.number) ? `No. ${group.number}` : null].filter(Boolean).join(' · ');
    if ($('crystal-space-group')) $('crystal-space-group').textContent = spaceGroup || 'Not declared';
    if ($('crystal-space-group')) $('crystal-space-group').title = group?.hall ? `Hall symbol: ${group.hall}` : '';
    if ($('crystal-sites')) {
      const sites = Number.isInteger(crystal?.asymmetricSiteCount)
        ? `Source file: ${count(crystal.asymmetricSiteCount)} asymmetric sites → ${count(crystal.expandedAtomCount ?? frame.ids.length)} symmetry-expanded sites. ` : '';
      const replication = frame?.physicalReplication?.repetitions;
      $('crystal-sites').textContent = frame ? `${sites}${count(frame.ids.length)} atoms in the current structure.`
        + (replication ? ` Physical replication: ${replication.join(' × ')}.` : '') : 'Open a crystal structure to inspect its cell.';
    }
    if ($('crystal-symmetry')) {
      const operations = crystal?.symmetryOperations?.length;
      $('crystal-symmetry').textContent = operations
        ? `${count(operations)} ${crystal.symmetrySource === 'explicit' ? 'file-supplied' : 'space-group'} symmetry operation${operations === 1 ? '' : 's'} applied during import. The space group describes the source file and is not reassessed after replication or other modifications. CIF export writes the current positions in P1.`
        : 'Space-group labels are read from the file, not inferred from the displayed geometry. CIF export writes the current positions in P1.';
    }
    if ($('crystal-warnings')) {
      const warnings = Array.isArray(crystal?.warnings) ? crystal.warnings : [];
      $('crystal-warnings').textContent = warnings.length ? `Source-file notes: ${warnings.join(' ')}` : '';
      $('crystal-warnings').hidden = warnings.length === 0;
    }
    if ($('crystal-occupancy-note')) $('crystal-occupancy-note').hidden = !frame?.properties?.some(property => property.name === 'occupancy');
  }

  function renderTypeOptions(key, id) {
    const container = $(id), doc = container?.ownerDocument ?? globalThis.document;
    if (!container || !doc) return;
    const labels = (getFrame()?.typeLabels ?? []).map(String);
    const selected = job.settings[key];
    // Keep an explicit choice even when it is absent from the current frame.
    const choices = [...new Set([...labels, ...(selected ?? [])])];
    const inputs = [], rows = [];
    const makeChoice = (label, value, checked, missing = false, all = false) => {
      const row = doc.createElement('label'), input = doc.createElement('input'), span = doc.createElement('span');
      row.className = 'slice-toggle'; input.type = 'checkbox'; input.checked = checked;
      input.value = value; input.missingType = missing; span.textContent = `${label}${missing ? ' (absent)' : ''}`;
      row.append(input, span); rows.push(row); inputs.push(input);
      input.addEventListener('change', () => {
        if (all) job.settings[key] = input.checked ? null : [];
        else {
          const next = new Set(job.settings[key] ?? labels);
          if (input.checked) next.add(value); else next.delete(value);
          job.settings[key] = [...next];
        }
        onEdit(); renderTypeOptions(key, id); updateControls();
        if (job.enabled) void run({ automatic: true });
      });
    };
    makeChoice('All types', '*', selected === null, false, true);
    for (const label of choices) makeChoice(label, label, selected === null || selected.includes(label), !labels.includes(label));
    container.replaceChildren(...rows); typeInputs.set(key, inputs);
  }

  function updateTypeOptions() {
    renderTypeOptions('centerTypes', 'crystal-center-types');
    renderTypeOptions('neighborTypes', 'crystal-neighbor-types');
    updateControls();
  }

  function readSettings() {
    const cutoff = $('crystal-cutoff') ? $('crystal-cutoff').valueAsNumber : job.settings.cutoff;
    return { ...copySettings(job.settings), cutoff: Number.isFinite(cutoff) && cutoff > 0 ? cutoff : job.settings.cutoff,
      visible: $('crystal-visible') ? $('crystal-visible').checked : job.settings.visible,
      showEdges: $('crystal-edges') ? $('crystal-edges').checked : job.settings.showEdges,
      color: $('crystal-color')?.value || job.settings.color,
      opacity: $('crystal-opacity') ? Number($('crystal-opacity').value) : job.settings.opacity };
  }

  function draw() {
    const { visible, color, opacity, showEdges } = job.settings;
    renderer?.setCoordinationPolyhedra(job.frame === getFrame() ? job.result : null, { visible, color, opacity, showEdges });
    renderer?.setThermalEllipsoids?.(getFrame()?.thermalEllipsoids ?? null, thermalSettings);
    onDisplayChange();
  }

  function clearView() {
    // Charge the currently retained geometry to the normal frame/cache budget,
    // but never retain meshes for previously visited trajectory frames.
    if (job.result && job.frame?.atomeyeResults?.coordinationPolyhedra === job.result) {
      delete job.frame.atomeyeResults.coordinationPolyhedra;
    }
    job.result = null; job.frame = null;
    if ($('crystal-results')) $('crystal-results').hidden = true;
    if ($('crystal-summary')) $('crystal-summary').textContent = '';
    if ($('crystal-backend')) $('crystal-backend').textContent = '—';
    draw(); updateControls();
  }

  function abort() {
    job.serial++; job.controller?.abort(); job.controller = null;
    if ($('crystal-progress')) $('crystal-progress').hidden = true;
    updateControls();
  }

  function cancel({ clearSettings = true, silent = false } = {}) {
    abort(); job.enabled = false; job.failed = false;
    clearView(); syncTool(); state('Not calculated', HELP);
    if (!silent) onResultsChange({ clearSettings });
    return true;
  }

  async function run({ automatic = false, isCurrent = () => true } = {}) {
    const frame = getFrame();
    if (!frame || !isCurrent()) return false;
    abort(); clearView();
    const cutoff = $('crystal-cutoff') ? $('crystal-cutoff').valueAsNumber : job.settings.cutoff;
    if (!Number.isFinite(cutoff) || cutoff <= 0 || cutoff > 1e6) {
      job.failed = true; state('Failed', 'The cutoff must be a positive finite length no larger than 1,000,000 Å.');
      onResultsChange({ frame, clearSettings: false });
      return false;
    }
    if (!automatic) onEdit();
    job.settings = { ...readSettings(), cutoff }; job.enabled = true; job.failed = false;
    syncTool({ reveal: !automatic });
    const controller = new AbortController(), serial = job.serial, token = generation, source = getSourceVersion();
    job.controller = controller;
    const current = () => serial === job.serial && token === generation && source === getSourceVersion()
      && frame === getFrame() && job.enabled && !controller.signal.aborted && isCurrent();
    state('Calculating…', 'Waiting for available analysis Workers…');
    onResultsChange({ frame, clearSettings: false });
    try {
      const resolveTypes = labels => labels === null ? null
        : frame.typeLabels.flatMap((label, index) => labels.includes(String(label)) ? [index] : []);
      const result = await pool.analyze(frame, { kind: 'coordinationPolyhedra', cutoff,
        centerTypes: resolveTypes(job.settings.centerTypes), neighborTypes: resolveTypes(job.settings.neighborTypes) }, {
        signal: controller.signal, frameIndex: getFrameIndex(),
        onProgress: progress => {
          if (!current()) return;
          if ($('crystal-status')) $('crystal-status').textContent = analysisProgressText(progress, { kind: 'coordinationPolyhedra', frameIndex: getFrameIndex() });
          if ($('crystal-backend')) $('crystal-backend').textContent = `CPU · ${count(progress.workerCount ?? 1)} Workers`;
          const meter = $('crystal-progress');
          if (meter) {
            meter.hidden = false;
            const total = progress.totalAtoms ?? progress.total, done = progress.completedAtoms ?? progress.completed;
            if (Number.isFinite(done) && total > 0) meter.value = Math.max(0, Math.min(1, done / total));
            else meter.removeAttribute('value');
          }
        },
      });
      if (!current()) return false;
      if (!Array.isArray(result.cells) || !result.summary || result.summary.constructed !== result.cells.length) {
        throw new Error('The coordination polyhedra result is incomplete.');
      }
      job.controller = null; job.result = result; job.frame = frame;
      frame.atomeyeResults ??= {};
      frame.atomeyeResults.coordinationPolyhedra = result;
      const summary = result.summary;
      if ($('crystal-summary')) $('crystal-summary').textContent = `${count(summary.constructed)} polyhedra from ${count(summary.selected)} centers. `
        + `${count(summary.undercoordinated)} centers have fewer than four neighbors; ${count(summary.coplanar)} have coplanar neighbors. `
        + `Sum of polyhedron volumes: ${numeric(summary.volumeSum)} Å³. Polyhedra may overlap; this is not a space-filling volume.`;
      if ($('crystal-results')) $('crystal-results').hidden = false;
      if ($('crystal-backend')) {
        $('crystal-backend').textContent = result.engine ? analysisBackendLabel(result) : 'CPU Workers';
        $('crystal-backend').title = result.engine ? analysisBackendDetails(result) : '';
      }
      if ($('crystal-progress')) $('crystal-progress').hidden = true;
      draw(); state('Calculated', 'Neighbor hulls retain their true atomic positions. Changing display settings reuses the calculated geometry.');
      onResultsChange({ frame, clearSettings: false });
      return true;
    } catch (error) {
      if (!current() || error.name === 'AbortError') return false;
      job.controller = null; job.failed = true; clearView();
      if ($('crystal-progress')) $('crystal-progress').hidden = true;
      state('Failed', error.message); onResultsChange({ frame, clearSettings: false });
      if (!automatic) notify(error.message);
      return false;
    } finally {
      if (job.controller === controller) job.controller = null;
      updateControls();
    }
  }

  async function onFrame() {
    abort(); clearView(); updateFrameInfo(); updateTypeOptions();
    if (!job.enabled || !getFrame()) { state('Not calculated', HELP); return false; }
    return run({ automatic: true });
  }

  function applyThermalSettings() {
    if ($('thermal-enabled')) $('thermal-enabled').checked = thermalSettings.enabled;
    if ($('thermal-probability')) $('thermal-probability').value = String(thermalSettings.probability * 100);
    if ($('thermal-probability-value')) $('thermal-probability-value').textContent = `${Math.round(thermalSettings.probability * 100)}%`;
    if ($('thermal-opacity')) $('thermal-opacity').value = String(thermalSettings.opacity);
    if ($('thermal-opacity-value')) $('thermal-opacity-value').textContent = `${Math.round(thermalSettings.opacity * 100)}%`;
  }

  function applySettings() {
    const s = job.settings;
    if ($('crystal-cutoff')) $('crystal-cutoff').value = String(s.cutoff);
    if ($('crystal-visible')) $('crystal-visible').checked = s.visible;
    if ($('crystal-edges')) $('crystal-edges').checked = s.showEdges;
    if ($('crystal-color')) $('crystal-color').value = s.color;
    if ($('crystal-opacity')) $('crystal-opacity').value = String(s.opacity);
    if ($('crystal-opacity-value')) $('crystal-opacity-value').textContent = `${Math.round(s.opacity * 100)}%`;
    applyThermalSettings();
    updateTypeOptions();
  }

  function reset() {
    thermalSettings = { ...THERMAL_DEFAULTS };
    generation++; cancel({ silent: true }); job.settings = copySettings(CRYSTAL_TOOL_DEFAULTS);
    applySettings(); updateFrameInfo(); onResultsChange({ clearSettings: true });
  }

  function serialize() { return { enabled: job.enabled, ...readSettings(),
    ...(Object.keys(THERMAL_DEFAULTS).some(key => thermalSettings[key] !== THERMAL_DEFAULTS[key]) ? { thermalEllipsoids: { ...thermalSettings } } : {}) }; }

  async function restore(saved, { isCurrent = () => true } = {}) {
    if (!isCurrent()) return false;
    generation++; cancel({ clearSettings: false, silent: true });
    thermalSettings = normalizeThermalOptions(saved?.thermalEllipsoids ?? THERMAL_DEFAULTS);
    job.settings = copySettings({ ...CRYSTAL_TOOL_DEFAULTS, ...(saved ?? {}) });
    delete job.settings.thermalEllipsoids;
    delete job.settings.enabled;
    applySettings(); updateFrameInfo(); job.enabled = Boolean(saved?.enabled); syncTool(); draw();
    onResultsChange({ clearSettings: false });
    return job.enabled && isCurrent() ? run({ automatic: true, isCurrent }) : false;
  }

  async function exportData(action) {
    if (exportBusy || !controlsEnabled || !getFrame() || !action) return;
    exportBusy = true; updateControls();
    try { await action(); } catch (error) { if (error.name !== 'AbortError') notify(error.message); }
    finally { exportBusy = false; updateControls(); }
  }

  for (const id of ['thermal-enabled', 'thermal-probability', 'thermal-opacity']) $(id)?.addEventListener(id === 'thermal-enabled' ? 'change' : 'input', () => {
    try { thermalSettings = normalizeThermalOptions({ enabled: $('thermal-enabled')?.checked ?? false,
      probability: Number($('thermal-probability')?.value ?? 50) / 100, opacity: Number($('thermal-opacity')?.value ?? 0.8) }); }
    catch (error) { notify(error.message); return; }
    onEdit(); applyThermalSettings(); syncTool(); draw();
  });
  $('run-crystal')?.addEventListener('click', () => { void run(); });
  $('cancel-crystal')?.addEventListener('click', () => { onEdit(); cancel(); });
  $('crystal-cutoff')?.addEventListener('change', () => {
    onEdit(); if (job.enabled) void run({ automatic: true });
  });
  for (const id of ['crystal-visible', 'crystal-color', 'crystal-opacity', 'crystal-edges']) {
    $(id)?.addEventListener(id === 'crystal-opacity' || id === 'crystal-color' ? 'input' : 'change', () => {
      const next = readSettings();
      if (!/^#[0-9a-f]{6}$/i.test(next.color) || !Number.isFinite(next.opacity) || next.opacity < 0 || next.opacity > 1) return;
      job.settings = next; onEdit();
      if ($('crystal-opacity-value')) $('crystal-opacity-value').textContent = `${Math.round(next.opacity * 100)}%`;
      draw();
    });
  }
  for (const format of ['cif', 'poscar']) $(`export-crystal-${format}`)?.addEventListener('click', () => { void exportData(onExport && (() => onExport(format))); });
  $('export-crystal-statistics')?.addEventListener('click', () => { if (job.result) void exportData(onExportStatistics && (() => onExportStatistics(job.result))); });
  applySettings(); updateFrameInfo(); state('Not calculated', HELP);

  return Object.freeze({ run, onFrame, cancel, reset, serialize, restore, redraw: draw, abortJobs: abort,
    setEnabled(value) { controlsEnabled = Boolean(value); updateFrameInfo(); updateTypeOptions(); },
    setExportBusy(value) { exportBusy = Boolean(value); updateControls(); },
    isEnabled: () => job.enabled || thermalSettings.enabled,
    getResult: () => job.result,
    pendingKinds: () => job.enabled && !job.failed && job.controller ? ['coordinationPolyhedra'] : [],
    failed: () => job.failed ? ['crystal'] : [],
    isUntouched() {
      const saved = serialize();
      return !saved.enabled && !saved.thermalEllipsoids && Object.keys(CRYSTAL_TOOL_DEFAULTS).every(key => JSON.stringify(saved[key]) === JSON.stringify(CRYSTAL_TOOL_DEFAULTS[key]));
    },
  });
}
