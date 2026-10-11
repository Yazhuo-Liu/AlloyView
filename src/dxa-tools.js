import { DxaClient } from './analysis/dxa-client.js';
import { DXA_DEFAULTS, DXA_DEFECT_MESH_SMOOTHING, DXA_FAMILIES, DXA_LATTICES, validateDxaParameters } from './analysis/dxa.js';
import { clearAnalysisResults, replaceAnalysisProperty } from './analysis/results.js';
import { downloadBlob } from './export-archive.js';
import { createMeshExport } from './io/mesh-export.js';
import { buildSurfaceDisplayMesh } from './render/surface-mesh-geometry.js';
import { SURFACE_MESH_DEFAULTS, surfaceMeshDisplayState } from './render/surface-mesh-layer.js';

export const DXA_STRUCTURE_PROPERTY = 'dxaStructureType';
export const DXA_STRUCTURE_LABEL = 'Crystal structure (DXA)';
// DXA's native lattice IDs differ from CNA/PTM for the diamond classes.
// Keep this vocabulary tied to the same lattice IDs used by the DXA kernel.
const structureColors = { 0: [242, 242, 242], 1: [102, 255, 102], 2: [255, 102, 102],
  3: [102, 102, 255], 4: [19, 160, 254], 5: [254, 137, 0] };
export const DXA_STRUCTURE_TYPES = Object.freeze([
  { id: 0, label: 'Other', description: 'Unresolved local crystal structure' },
  ...DXA_LATTICES.toSorted((a, b) => a.kernelId - b.kernelId).map(lattice => ({
    id: lattice.kernelId, label: lattice.label, description: lattice.label,
  })),
].map(type => Object.freeze({ ...type, color: Object.freeze(structureColors[type.id]) })));

const $ = id => document.getElementById(id);
const PARAMETER_FIELDS = {
  lattice: 'dxa-lattice', trialCircuitLength: 'dxa-trial-length',
  circuitStretchability: 'dxa-stretchability', lineSmoothingIterations: 'dxa-smoothing',
  linePointInterval: 'dxa-point-interval', onlyPerfectDislocations: 'dxa-perfect-only',
};
/** The optional defect mesh: OVITO's surface around the regions that are not
 * the reference crystal and were not resolved into dislocation lines. */
export const DXA_DEFECT_MESH_DEFAULTS = Object.freeze({ enabled: false, smoothingLevel: DXA_DEFECT_MESH_SMOOTHING, ...SURFACE_MESH_DEFAULTS.dxaDefect });
const DEFECT_STYLE_FIELDS = { color: 'dxa-defect-mesh-color', interiorColor: 'dxa-defect-mesh-interior-color', capColor: 'dxa-defect-mesh-cap-color' };
const toHex = color => `#${Array.from(color, value => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
const duration = ms => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
const integer = value => Number(value).toLocaleString('en-US');

/** DXA owns one whole-frame Worker job, its line network and the existing
 * per-atom structure output. Frame edits invalidate in-flight Worker replies. */
export function initializeDxaTools({ renderer, tools, getFrame, getSourceVersion,
  onEdit = () => {}, onDisplayChange = () => {},
  getColorMode = () => 'type', getColorChoiceVersion = () => 0, onResultsChange = () => {},
  onMemoryChange = () => {}, notify = () => {}, client = new DxaClient(),
  getFileStem = () => 'structure', getFrameIndex = () => 0, onDownload = downloadBlob,
  afterDisplayRefresh = callback => callback() }) {
  let enabled = false, controlsEnabled = false, controller = null, request = 0;
  let network = null, failure = false, radius = 0.25;
  let visibleFamilies = new Set(), familyColors = new Map(), cachedResult = null;
  let atomStructureFrame = null, colorDefaultPending = true;
  let defectMesh = { ...DXA_DEFECT_MESH_DEFAULTS };
  // Display meshes of results, so that redrawing never rebuilds geometry.
  const defectDisplays = new WeakMap();

  /** Defect mesh settings from the panel; panels without these controls
   * keep the stored values (the mesh is off by default). */
  function readDefectMesh() {
    const level = $('dxa-defect-mesh-smoothing')?.valueAsNumber, opacity = $('dxa-defect-mesh-opacity')?.valueAsNumber;
    const next = { ...defectMesh,
      enabled: $('dxa-defect-mesh') ? Boolean($('dxa-defect-mesh').checked) : defectMesh.enabled,
      smoothingLevel: Number.isInteger(level) && level >= 0 && level <= 100 ? level : defectMesh.smoothingLevel,
      visible: $('dxa-defect-mesh-visible') ? Boolean($('dxa-defect-mesh-visible').checked) : defectMesh.visible,
      caps: $('dxa-defect-mesh-caps') ? Boolean($('dxa-defect-mesh-caps').checked) : defectMesh.caps,
      opacity: Number.isFinite(opacity) && opacity >= 0 && opacity <= 1 ? opacity : defectMesh.opacity };
    for (const [name, id] of Object.entries(DEFECT_STYLE_FIELDS)) {
      const value = $(id)?.value;
      if (/^#[0-9a-f]{6}$/i.test(value ?? '')) next[name] = value.toLowerCase();
    }
    defectMesh = next;
    return next;
  }

  function writeDefectMesh() {
    if ($('dxa-defect-mesh')) $('dxa-defect-mesh').checked = defectMesh.enabled;
    if ($('dxa-defect-mesh-smoothing')) $('dxa-defect-mesh-smoothing').value = String(defectMesh.smoothingLevel);
    if ($('dxa-defect-mesh-visible')) $('dxa-defect-mesh-visible').checked = defectMesh.visible;
    if ($('dxa-defect-mesh-caps')) $('dxa-defect-mesh-caps').checked = defectMesh.caps;
    if ($('dxa-defect-mesh-opacity')) $('dxa-defect-mesh-opacity').value = String(defectMesh.opacity);
    for (const [name, id] of Object.entries(DEFECT_STYLE_FIELDS)) if ($(id)) $(id).value = defectMesh[name];
  }

  /** The mesh of a result as the renderer takes it. OVITO displays the defect
   * mesh with reversed orientation: its solid side is the defect region. */
  function defectDisplay(result) {
    const mesh = result?.defectMesh;
    if (!mesh?.triangles?.length) return null;
    if (!defectDisplays.has(mesh)) defectDisplays.set(mesh, { vertices: mesh.vertices, triangles: mesh.triangles, reverse: true, spaceFilling: false });
    return defectDisplays.get(mesh);
  }

  function describeDefectMesh() {
    const controls = $('dxa-defect-mesh-controls'), summary = $('dxa-defect-mesh-summary'), mesh = network?.defectMesh;
    if (controls) controls.hidden = !mesh || !defectMesh.enabled;
    if (!summary) return;
    summary.textContent = !mesh ? '' : mesh.error ? `The defect mesh could not be generated: ${mesh.error}`
      : !mesh.triangleCount ? (mesh.defectCellCount ? 'No defect mesh: every defect region was resolved into dislocation lines.' : 'No defect mesh: the structure contains no defect region.')
        : `${integer(mesh.triangleCount)} triangles · ${Number(mesh.surfaceArea ?? 0).toPrecision(5)} Å² surface area · smoothing ${mesh.smoothingLevel}`;
  }

  function parameters() {
    return validateDxaParameters(Object.fromEntries(Object.entries(PARAMETER_FIELDS).map(([key, id]) => {
      const field = $(id);
      return [key, key === 'lattice' ? field.value
        : key === 'onlyPerfectDislocations' ? field.checked : field.valueAsNumber];
    })));
  }

  function writeParameters(value) {
    for (const [key, id] of Object.entries(PARAMETER_FIELDS)) {
      if (key === 'onlyPerfectDislocations') $(id).checked = Boolean(value[key]);
      else $(id).value = String(value[key]);
    }
  }

  function families() { return DXA_FAMILIES[$('dxa-lattice').value] ?? []; }

  function resetFamilies() {
    visibleFamilies = new Set(families().map(family => family.id));
    familyColors = new Map(families().map(family => [family.id, toHex(family.color)]));
  }

  function updateControls() {
    for (const id of [...Object.values(PARAMETER_FIELDS), 'dxa-line-radius']) $(id).disabled = !controlsEnabled;
    for (const id of ['dxa-defect-mesh', 'dxa-defect-mesh-smoothing', 'dxa-defect-mesh-visible', 'dxa-defect-mesh-caps', 'dxa-defect-mesh-opacity',
      ...Object.values(DEFECT_STYLE_FIELDS)]) if ($(id)) $(id).disabled = !controlsEnabled;
    for (const id of ['export-dxa-defect-mesh-stl', 'export-dxa-defect-mesh-ply']) if ($(id)) $(id).disabled = !controlsEnabled || !network?.defectMesh?.triangleCount;
    $('run-dxa').disabled = !controlsEnabled || Boolean(controller);
    $('cancel-dxa').disabled = !controlsEnabled || (!enabled && !failure);
    for (const input of $('dxa-families').querySelectorAll('input')) input.disabled = !controlsEnabled;
  }

  function state(text, ready = false) {
    $('dxa-state').textContent = text;
    $('dxa-state').classList.toggle('ready', ready);
    updateControls();
  }

  function draw() {
    renderer.setDislocationNetwork(network, {
      enabled: Boolean(network) && enabled, radius,
      visibleFamilies: [...visibleFamilies], familyColors: Object.fromEntries(familyColors),
    });
    const style = readDefectMesh(), shown = Boolean(network) && enabled && style.enabled;
    try {
      renderer.setSurfaceMesh?.('dxaDefect', shown ? defectDisplay(network) : null, { visible: style.visible, caps: style.caps, opacity: style.opacity,
        color: style.color, interiorColor: style.interiorColor, capColor: style.capColor });
    } catch (error) { notify(error.message); }
    describeDefectMesh();
    updateControls();
    onDisplayChange();
  }

  function renderFamilies() {
    const container = $('dxa-families');
    container.replaceChildren();
    for (const family of families()) {
      const row = document.createElement('div'); row.className = 'legend-item';
      const toggle = document.createElement('input'); toggle.type = 'checkbox';
      toggle.checked = visibleFamilies.has(family.id);
      toggle.setAttribute('aria-label', `Show ${family.label} dislocations`);
      const color = document.createElement('input'); color.type = 'color';
      color.value = familyColors.get(family.id) ?? toHex(family.color);
      color.setAttribute('aria-label', `${family.label} line color`);
      color.style.width = '26px'; color.style.height = '22px'; color.style.padding = '0';
      const name = document.createElement('span'); name.textContent = family.label;
      const count = document.createElement('span'); count.className = 'legend-count';
      const members = network?.counts?.[family.id];
      count.textContent = integer(typeof members === 'object' ? members.count ?? 0
        : members ?? network?.segments?.filter(segment => (segment.familyId ?? segment.family) === family.id).length ?? 0);
      toggle.addEventListener('change', () => {
        onEdit();
        if (toggle.checked) visibleFamilies.add(family.id); else visibleFamilies.delete(family.id);
        draw();
      });
      color.addEventListener('input', () => { onEdit(); familyColors.set(family.id, color.value); draw(); });
      row.append(toggle, color, name, count); container.append(row);
    }
    updateControls();
  }

  function clearNetwork({ clearSettings = false } = {}) {
    const hadResult = Boolean(network || atomStructureFrame);
    network = null;
    if (atomStructureFrame) clearAnalysisResults(atomStructureFrame, 'dxa');
    atomStructureFrame = null;
    $('dxa-results').hidden = true;
    $('dxa-summary').textContent = '';
    $('dxa-status').title = '';
    if (hadResult || clearSettings) onResultsChange({ clearSettings });
    draw();
    onMemoryChange(getFrame());
  }

  function abortJobs() {
    request++;
    controller?.abort();
    controller = null;
    updateControls();
  }

  function cancel({ clearSettings = true } = {}) {
    abortJobs(); enabled = false; failure = false;
    // Stop the job and clear its display while retaining reusable backend memory.
    void client.release?.();
    cachedResult = null;
    colorDefaultPending = true;
    tools.setToolEnabled('dxa', false);
    clearNetwork({ clearSettings }); state('Not calculated');
    $('dxa-status').textContent = 'Extract lines and Burgers vectors from the complete structure.';
  }

  function showResult(result, frame, key, selectStructures, current) {
    network = result; failure = false;
    if (result.atomStructureTypes) {
      replaceAnalysisProperty(frame, { name: DXA_STRUCTURE_PROPERTY, displayName: DXA_STRUCTURE_LABEL,
        data: result.atomStructureTypes, categories: DXA_STRUCTURE_TYPES, unit: '',
        analysisKind: 'dxa', analysisKey: key, analysisMs: result.elapsedMs,
        analysisEngine: result.engine, analysisWorkerCount: result.workerCount ?? 1 });
      atomStructureFrame = frame;
      colorDefaultPending = false;
    }
    $('dxa-results').hidden = false;
    state('Updating display…');
    const count = result.segments?.length ?? 0;
    const length = Number(result.totalLength ?? 0), density = Number(result.density ?? 0);
    $('dxa-summary').textContent = `${integer(count)} segments · ${length.toPrecision(5)} Å total length · ${density.toExponential(3)} Å⁻² density`;
    const workers = result.workerCount ?? 1;
    const nativeWorkers = result.nativeWorkerCount ?? workers;
    const concurrency = result.cpuOffloadUsed
      ? `global ${integer(nativeWorkers)} ${nativeWorkers === 1 ? 'thread' : 'threads'} · local stages up to ${integer(workers)} Workers`
      : `${integer(nativeWorkers)} ${nativeWorkers === 1 ? 'thread' : 'threads'}`;
    $('dxa-status').textContent = `Wasm CPU · ${concurrency} · ${duration(result.elapsedMs ?? 0)}${result.threadingFallback ? ' · single-thread fallback' : ''}${result.cpuStageFallbacks?.length ? ' · local-stage fallback' : ''}`;
    $('dxa-status').title = [result.threadingFallback ? `CPU threading fallback: ${result.threadingFallback}` : '',
      ...(result.cpuOffloadUsed ? [
        `Global extraction: ${integer(nativeWorkers)} ${nativeWorkers === 1 ? 'CPU thread' : 'CPU threads'}`,
        `Local crystal identification: ${integer(result.cpuStageWorkerCounts?.local ?? 1)} CPU Workers`,
        `Tetrahedron classification: ${integer(result.cpuStageWorkerCounts?.tetrahedra ?? 1)} CPU Workers`,
      ] : []),
      ...(result.cpuStageFallbacks ?? []).map(fallback => `CPU ${fallback.stage} fallback: ${fallback.reason}`),
      ...(result.cpuStageTimings ?? []).map(stage => `CPU ${stage.stage} offload: ${duration(stage.elapsedMs)} · ${integer(stage.workerCount)} Workers · ${(Number(stage.copiedBytes ?? 0) / 1024 ** 2).toFixed(2)} MiB copied · ${integer(stage.kernelInitializations ?? 0)} kernel initializations`),
      ...(result.stageTimings ?? []).map(stage => `${stage.phase}: ${duration(stage.elapsedMs)}`),
    ].filter(Boolean).join('\n');
    onResultsChange({ selectProperty: selectStructures && atomStructureFrame ? DXA_STRUCTURE_PROPERTY : null });
    renderFamilies(); draw(); onMemoryChange(frame);
    afterDisplayRefresh(() => { if (current() && network === result) state('Calculated', true); });
  }

  async function run({ automatic = false, isCurrent = () => true } = {}) {
    const frame = getFrame();
    if (!frame || !isCurrent()) return false;
    let settings;
    try { settings = parameters(); }
    catch (error) {
      abortJobs(); failure = true; clearNetwork(); state('Failed');
      $('dxa-status').textContent = error.message;
      if (!automatic) notify(error.message);
      return false;
    }
    if (!automatic) onEdit();
    const colorChoice = getColorChoiceVersion();
    const selectStructures = !automatic && colorDefaultPending && getColorMode() === 'type';
    const shouldSelectStructures = () => selectStructures && colorChoice === getColorChoiceVersion() && getColorMode() === 'type';
    abortJobs(); enabled = true; failure = false;
    tools.setToolEnabled('dxa', true);
    clearNetwork();
    const serial = request, sourceVersion = getSourceVersion();
    const current = () => serial === request && frame === getFrame() && sourceVersion === getSourceVersion() && enabled && isCurrent();
    // The defect mesh is requested apart from the DXA parameters: lines and
    // structure labels are the same with and without it. A cached result is
    // reused unless a mesh is wanted that it does not contain.
    const meshRequest = readDefectMesh().enabled ? { smoothingLevel: defectMesh.smoothingLevel } : null;
    const key = JSON.stringify(settings), cached = cachedResult;
    if (cached?.frame === frame && cached.key === key
      && (!meshRequest || cached.result.defectMesh?.smoothingLevel === meshRequest.smoothingLevel)) {
      showResult(cached.result, frame, key, shouldSelectStructures(), current); return true;
    }
    // Global line graphs can be large. Keep only the latest frame/result,
    // rather than adding unaccounted graph arrays to the trajectory cache.
    cachedResult = null;
    const job = new AbortController(); controller = job;
    state('Calculating…');
    $('dxa-status').textContent = `Preparing CPU DXA for ${integer(frame.ids.length)} atoms…`;
    try {
      const result = await client.analyze(frame, settings, {
        signal: job.signal, ...(meshRequest ? { defectMesh: meshRequest } : {}),
        onProgress: progress => {
          if (!current() || job.signal.aborted) return;
          const stage = String(progress.phase ?? 'Analyzing').replace(/[-_]/g, ' ');
          const done = progress.completedStages ?? 0, total = progress.totalStages ?? 11;
          const workers = progress.workerCount ?? 1;
          const concurrency = progress.cpuStage
            ? `${integer(workers)} ${workers === 1 ? 'Worker' : 'Workers'} · global ${integer(progress.nativeWorkerCount ?? 1)} thread`
            : `${integer(workers)} ${workers === 1 ? 'thread' : 'threads'}`;
          $('dxa-status').textContent = `${stage} · CPU · ${concurrency} · ${done} / ${total} stages`;
          if (progress.threadingFallback) $('dxa-status').title = `CPU threading fallback: ${progress.threadingFallback}`;
        },
      });
      if (!current() || job.signal.aborted) return false;
      cachedResult = { frame, key, result };
      controller = null; showResult(result, frame, key, shouldSelectStructures(), current); return true;
    } catch (error) {
      if (!current() || job.signal.aborted || error.name === 'AbortError') return false;
      controller = null; failure = true; clearNetwork(); state('Failed');
      $('dxa-status').textContent = error.message;
      if (!automatic) notify(error.message);
      return false;
    } finally {
      if (controller === job) controller = null;
      updateControls();
    }
  }

  async function onFrame() {
    abortJobs(); clearNetwork();
    if (!enabled) { state('Not calculated'); return; }
    state('Queued');
    await run({ automatic: true });
  }

  function serialize() {
    const mesh = readDefectMesh();
    return { enabled, ...parameters(), radius,
      visibleFamilies: [...visibleFamilies], familyColors: [...familyColors].map(([family, color]) => ({ family, color })),
      // Untouched defect mesh settings are left out, as in recipes saved
      // before the mesh existed.
      ...(Object.keys(DXA_DEFECT_MESH_DEFAULTS).some(name => mesh[name] !== DXA_DEFECT_MESH_DEFAULTS[name]) ? { defectMesh: { ...mesh } } : {}) };
  }

  async function restore(saved, { isCurrent = () => true } = {}) {
    if (!saved || !isCurrent()) return;
    // Configuration color filters have already been restored by the caller.
    // Replace DXA's computed result without discarding those saved choices.
    cancel({ clearSettings: false }); writeParameters(saved); radius = saved.radius;
    defectMesh = { ...DXA_DEFECT_MESH_DEFAULTS, ...(saved.defectMesh ?? {}) };
    writeDefectMesh();
    $('dxa-line-radius').value = String(radius);
    resetFamilies();
    visibleFamilies = new Set(saved.visibleFamilies);
    familyColors = new Map(saved.familyColors.map(({ family, color }) => [family, color]));
    renderFamilies();
    if (saved.enabled && getFrame() && isCurrent()) await run({ automatic: true, isCurrent });
  }

  function reset() {
    cancel(); writeParameters(DXA_DEFAULTS); radius = 0.25;
    defectMesh = { ...DXA_DEFECT_MESH_DEFAULTS };
    writeDefectMesh();
    $('dxa-line-radius').value = String(radius); resetFamilies(); renderFamilies();
  }

  function exportDefectMesh(format) {
    const frame = getFrame(), mesh = defectDisplay(network);
    if (!frame || !mesh) { notify('Extract dislocations with the defect mesh before exporting it.'); return null; }
    try {
      const style = readDefectMesh(), view = renderer.frame === frame ? surfaceMeshDisplayState(renderer) : { origin: [0, 0, 0], translation: [0, 0, 0] };
      const display = buildSurfaceDisplayMesh(mesh, frame.cell, { origin: view.origin, caps: style.caps, reverse: true });
      const file = createMeshExport(display, format, { caps: style.caps, translation: view.translation,
        stem: `${getFileStem()}-frame-${getFrameIndex() + 1}-dxa-defect-mesh`, title: 'AlloyView DXA defect mesh' });
      onDownload(file.blob, file.filename);
      return file;
    } catch (error) { notify(error.message); return null; }
  }

  $('run-dxa').addEventListener('click', () => { void run(); });
  $('cancel-dxa').addEventListener('click', () => { onEdit(); cancel(); });
  for (const id of Object.values(PARAMETER_FIELDS)) $(id).addEventListener('change', () => {
    onEdit();
    if (id === 'dxa-lattice') { resetFamilies(); renderFamilies(); }
    if (enabled) void run({ automatic: true });
  });
  // Requesting the mesh or changing its smoothing needs a new extraction;
  // switching it off only hides it. Styles never recalculate.
  for (const id of ['dxa-defect-mesh', 'dxa-defect-mesh-smoothing']) $(id)?.addEventListener('change', () => {
    onEdit();
    const wanted = readDefectMesh().enabled;
    if (enabled && wanted && network?.defectMesh?.smoothingLevel !== defectMesh.smoothingLevel) void run({ automatic: true });
    else draw();
  });
  for (const id of ['dxa-defect-mesh-visible', 'dxa-defect-mesh-caps', ...Object.values(DEFECT_STYLE_FIELDS)]) {
    $(id)?.addEventListener('change', () => { onEdit(); draw(); });
  }
  for (const id of ['dxa-defect-mesh-opacity', ...Object.values(DEFECT_STYLE_FIELDS)]) $(id)?.addEventListener('input', () => { onEdit(); draw(); });
  $('export-dxa-defect-mesh-stl')?.addEventListener('click', () => { exportDefectMesh('stl'); });
  $('export-dxa-defect-mesh-ply')?.addEventListener('click', () => { exportDefectMesh('ply'); });
  $('dxa-line-radius').addEventListener('change', () => {
    const value = $('dxa-line-radius').valueAsNumber;
    if (!Number.isFinite(value) || value <= 0) { $('dxa-line-radius').value = String(radius); notify('Enter a positive line radius.'); return; }
    onEdit(); radius = value; draw();
  });
  reset();
  return Object.freeze({ run, onFrame, cancel, abortJobs, reset, serialize, restore, exportDefectMesh,
    pendingColorProperties: () => enabled && !failure ? [{ name: DXA_STRUCTURE_PROPERTY, label: DXA_STRUCTURE_LABEL }] : [],
    setEnabled(value) { controlsEnabled = Boolean(value); updateControls(); },
    failed: () => enabled && failure,
  });
}
