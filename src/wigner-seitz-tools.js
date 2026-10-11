import { clearAnalysisResults, replaceAnalysisProperty } from './analysis/results.js';
import { analysisBackendDetails, analysisBackendLabel, analysisProgressText } from './analysis/status.js';
import { colorsByType } from './render/palette.js';
import { SITE_VACANCY, WIGNER_SEITZ_ATOM_CLASSES, WIGNER_SEITZ_SITE_CLASSES, siteTypeOccupancy,
  wignerSeitzSitePositions } from './analysis/wigner-seitz.js';

export const WIGNER_SEITZ_PROPERTIES = Object.freeze([
  Object.freeze({ name: 'wsOccupancy', label: 'WS site occupancy' }),
  Object.freeze({ name: 'wsDefectClass', label: 'WS defect class' }),
  Object.freeze({ name: 'wsSiteType', label: 'WS site type' }),
  Object.freeze({ name: 'wsSiteIndex', label: 'WS site index' }),
  Object.freeze({ name: 'wsDistance', label: 'WS distance to site' }),
]);
/** Which reference sites are drawn: vacant ones, every site that is not
 * regularly occupied, or all sites (OVITO's "sites" output). */
export const WIGNER_SEITZ_MARKER_MODES = Object.freeze(['vacancies', 'defects', 'all']);
export const WIGNER_SEITZ_DEFAULTS = Object.freeze({ referenceFrame: 0, affineMapping: false, markers: 'vacancies',
  showMarkers: true, markerRadius: 0.6 });
const HELP = 'Every atom of the displayed frame is assigned to its nearest reference site, including hidden atoms.';
const MARKER_LABELS = { vacancies: 'vacant site', defects: 'defect site', all: 'site' };

const integer = value => Number(value).toLocaleString('en-US');
// The reference frame's arrays and marker sets belong to another frame; keep
// them outside the cached result so frame memory estimates do not count them.
const displayContexts = new WeakMap();
const plural = (count, word, many = `${word}s`) => `${integer(count)} ${count === 1 ? word : many}`;

/** Defect sites (vacant, multiply occupied and antisite) for the CSV export:
 * per-type occupancy by current element and positions in both frames. */
export function wignerSeitzExportSites(result, frame, reference, { affineMapping = false } = {}) {
  const sites = result.defectSites, typeCount = frame.typeLabels.length;
  const typeOccupancy = new Uint32Array(sites.length * typeCount), scratch = new Uint32Array(typeCount);
  for (let index = 0; index < sites.length; index += 1) typeOccupancy.set(siteTypeOccupancy(result, sites[index], frame.types, typeCount, scratch), index * typeCount);
  return {
    sites: Uint32Array.from(sites),
    ids: Array.from(sites, site => reference.ids?.[site] ?? site + 1),
    types: Array.from(sites, site => reference.typeLabels[reference.types[site]]),
    classes: Uint8Array.from(sites, site => result.siteClass[site]),
    occupancy: Uint32Array.from(sites, site => result.siteOccupancy[site]),
    typeLabels: frame.typeLabels.map(String), typeOccupancy,
    referencePositions: wignerSeitzSitePositions(reference.fractional, reference.cell, reference.cell, sites),
    currentPositions: wignerSeitzSitePositions(reference.fractional, reference.cell, frame.cell, sites, { affineMapping }),
  };
}

/** Site markers for one marker mode: Cartesian positions in the current frame
 * and the site-class colors. */
export function wignerSeitzMarkers(result, frame, reference, mode, { affineMapping = false } = {}) {
  if (!WIGNER_SEITZ_MARKER_MODES.includes(mode)) throw new Error('Choose vacant, defect or all sites for Wigner–Seitz markers.');
  const classes = result.siteClass;
  let sites;
  if (mode === 'all') sites = Uint32Array.from({ length: result.siteCount }, (_, site) => site);
  else if (mode === 'defects') sites = result.defectSites;
  else {
    sites = new Uint32Array(result.vacancyCount);
    for (let site = 0, cursor = 0; site < classes.length; site += 1) if (classes[site] === SITE_VACANCY) sites[cursor++] = site;
  }
  const colors = new Uint8Array(sites.length * 3);
  for (let index = 0; index < sites.length; index += 1) colors.set(WIGNER_SEITZ_SITE_CLASSES[classes[sites[index]]].color, index * 3);
  return { sites, positions: wignerSeitzSitePositions(reference.fractional, reference.cell, frame.cell, sites, { affineMapping }), colors };
}

/** Wigner–Seitz defect analysis against a chosen trajectory frame. Results are
 * cached per frame and settings; display options never recalculate. */
export function initializeWignerSeitzTools({ renderer, pool, tools, getFrame, getFrameAt = async () => null,
  getFrames = () => [getFrame()], getFrameCount = () => 1, getFrameIndex = () => 0, getSourceVersion = () => 0,
  getColorChoiceVersion = () => 0, chooseProperty = () => {}, onResultsChange = () => {}, onDisplayChange = () => {},
  notify = () => {}, onEdit = () => {}, onBeforeClear = () => {}, afterDisplayRefresh = callback => callback() }) {
  const $ = id => globalThis.document?.getElementById(id) ?? null;
  const job = { enabled: false, failed: false, queued: false, controller: null, serial: 0, cached: null, frame: null,
    settings: { ...WIGNER_SEITZ_DEFAULTS } };
  let controlsEnabled = false, generation = 0;

  function updateControls() {
    const available = controlsEnabled && Boolean(getFrame());
    for (const id of ['wigner-seitz-reference-frame', 'wigner-seitz-affine', 'wigner-seitz-markers', 'wigner-seitz-show-markers', 'wigner-seitz-marker-radius']) {
      if ($(id)) $(id).disabled = !available;
    }
    if ($('wigner-seitz-reference-frame')) $('wigner-seitz-reference-frame').max = String(Math.max(1, getFrameCount()));
    if ($('run-wigner-seitz')) $('run-wigner-seitz').disabled = !available || Boolean(job.controller) || job.queued;
    if ($('cancel-wigner-seitz')) $('cancel-wigner-seitz').disabled = !available || (!job.enabled && !job.failed);
    for (const id of ['wigner-seitz-color-class', 'wigner-seitz-color-occupancy']) if ($(id)) $(id).disabled = !available || !job.cached;
  }

  function state(label, text = '') {
    if ($('wigner-seitz-state')) {
      $('wigner-seitz-state').textContent = label;
      $('wigner-seitz-state').classList.toggle('ready', label === 'Calculated');
    }
    if (text && $('wigner-seitz-status')) $('wigner-seitz-status').textContent = text;
    updateControls();
  }

  function syncTool({ reveal = false } = {}) { tools?.setToolEnabled('wignerSeitz', job.enabled, { reveal }); }

  /** Settings from the panel; a frame number outside the source is an error. */
  function readSettings() {
    const settings = { ...job.settings };
    const frameInput = $('wigner-seitz-reference-frame');
    if (frameInput) {
      const value = frameInput.value === '' ? NaN : frameInput.valueAsNumber ?? Number(frameInput.value);
      if (!Number.isInteger(value) || value < 1 || value > getFrameCount()) throw new Error(`Choose a reference frame from 1 to ${integer(getFrameCount())}.`);
      settings.referenceFrame = value - 1;
    }
    if ($('wigner-seitz-affine')) settings.affineMapping = Boolean($('wigner-seitz-affine').checked);
    return { ...settings, ...displaySettings() };
  }

  function displaySettings() {
    const markers = $('wigner-seitz-markers')?.value ?? job.settings.markers;
    const radiusInput = $('wigner-seitz-marker-radius');
    const radius = radiusInput ? (radiusInput.value === '' ? NaN : radiusInput.valueAsNumber ?? Number(radiusInput.value)) : job.settings.markerRadius;
    return { markers: WIGNER_SEITZ_MARKER_MODES.includes(markers) ? markers : job.settings.markers,
      showMarkers: $('wigner-seitz-show-markers') ? Boolean($('wigner-seitz-show-markers').checked) : job.settings.showMarkers,
      markerRadius: Number.isFinite(radius) && radius >= 0.01 && radius <= 100 ? radius : job.settings.markerRadius };
  }

  function abort() {
    job.serial++;
    job.controller?.abort();
    job.controller = null;
    job.queued = false;
    if ($('wigner-seitz-progress')) $('wigner-seitz-progress').hidden = true;
    updateControls();
  }

  function clearMarkers() {
    if (!renderer?.siteMarkers) return;
    renderer.setSiteMarkers(null);
    onDisplayChange();
  }

  function clearView() {
    job.cached = null;
    if ($('wigner-seitz-results')) $('wigner-seitz-results').hidden = true;
    if ($('wigner-seitz-summary')) $('wigner-seitz-summary').textContent = '';
    if ($('wigner-seitz-backend')) $('wigner-seitz-backend').textContent = '—';
    if ($('wigner-seitz-status')) $('wigner-seitz-status').title = '';
    $('wigner-seitz-table-body')?.replaceChildren();
    clearMarkers();
    updateControls();
  }

  function clearFrames() {
    for (const frame of new Set([...(getFrames() ?? []), getFrame(), job.frame])) {
      if (!frame) continue;
      clearAnalysisResults(frame, 'wignerSeitz');
      if (frame.atomeyeResults) delete frame.atomeyeResults.wignerSeitz;
    }
    job.frame = null;
  }

  function cancel({ clearSettings = true, silent = false } = {}) {
    onBeforeClear('wignerSeitz', { clearSettings });
    abort();
    job.enabled = false; job.failed = false;
    clearFrames(); clearView(); syncTool();
    state('Not calculated', HELP);
    if (!silent) onResultsChange({ clearSettings });
    return true;
  }

  function renderTable(result) {
    const body = $('wigner-seitz-table-body');
    if (!body) return;
    const root = body.ownerDocument ?? globalThis.document;
    const cell = text => { const item = root.createElement('td'); item.textContent = text; return item; };
    const row = (label, values, className = '') => {
      const item = root.createElement('tr');
      if (className) item.className = className;
      const heading = root.createElement('th'); heading.scope = 'row'; heading.textContent = label;
      item.append(heading, ...values.map(value => cell(integer(value))));
      return item;
    };
    body.replaceChildren(...result.typeSummary.map(entry => row(entry.label, [entry.sites, entry.atoms, entry.vacancies, entry.antisites, entry.sharedSiteAtoms])),
      row('All', [result.siteCount, result.atomCount, result.vacancyCount, result.antisiteCount, result.sharedSiteAtoms], 'wigner-seitz-total'));
  }

  function updateMarkers() {
    const cached = job.cached, frame = getFrame();
    const context = cached && displayContexts.get(cached);
    if (!context || !frame || context.frame !== frame || renderer?.frame !== frame) { clearMarkers(); return; }
    const display = displaySettings();
    job.settings = { ...job.settings, ...display };
    let markers = context.markers.get(display.markers);
    if (!markers) {
      markers = wignerSeitzMarkers(cached.result, frame, context.reference, display.markers, { affineMapping: cached.result.affineMapping });
      context.markers.set(display.markers, markers);
    }
    try { renderer?.setSiteMarkers(markers.sites.length ? markers : null, { visible: display.showMarkers, radius: display.markerRadius }); }
    catch (error) { notify(error.message); }
    if ($('wigner-seitz-marker-status')) {
      $('wigner-seitz-marker-status').textContent = !display.showMarkers ? 'Site markers are hidden.'
        : `${plural(markers.sites.length, MARKER_LABELS[display.markers])} drawn at ${cached.result.affineMapping ? 'mapped' : 'reference'} positions.`;
    }
    onDisplayChange();
  }

  function showResult(cached, frame, current) {
    const { result } = cached;
    job.cached = cached; job.frame = frame; job.failed = false;
    const metadata = { analysisKind: 'wignerSeitz', analysisKey: cached.key, analysisMs: result.elapsedMs, analysisEngine: result.engine };
    const typeLegend = colorsByType({ types: new Uint8Array(0), typeLabels: result.referenceTypeLabels }).legend.items;
    // Color by expects plain numeric arrays; convert once per cached result.
    cached.outputs ??= { siteIndex: Uint32Array.from(result.siteIndex), distance: Float32Array.from(result.siteDistance) };
    replaceAnalysisProperty(frame, { name: 'wsOccupancy', displayName: 'WS site occupancy', unit: '', data: result.atomOccupancy, ...metadata });
    replaceAnalysisProperty(frame, { name: 'wsDefectClass', displayName: 'WS defect class', unit: '', data: result.atomClass,
      categories: WIGNER_SEITZ_ATOM_CLASSES, ...metadata });
    replaceAnalysisProperty(frame, { name: 'wsSiteType', displayName: 'WS site type', unit: '', data: result.atomSiteType,
      categories: typeLegend.map(({ id, label, color }) => ({ id, label, description: `Reference site of type ${label}`, color })), ...metadata });
    replaceAnalysisProperty(frame, { name: 'wsSiteIndex', displayName: 'WS site index', unit: '', data: cached.outputs.siteIndex, ...metadata });
    replaceAnalysisProperty(frame, { name: 'wsDistance', displayName: 'WS distance to site', unit: 'Å', data: cached.outputs.distance, ...metadata });
    if ($('wigner-seitz-results')) $('wigner-seitz-results').hidden = false;
    if ($('wigner-seitz-summary')) {
      $('wigner-seitz-summary').textContent = [plural(result.vacancyCount, 'vacancy', 'vacancies'),
        plural(result.interstitialCount, 'interstitial'), plural(result.antisiteCount, 'antisite'),
        `${integer(result.atomCount)} atoms on ${integer(result.siteCount)} sites of frame ${cached.referenceFrame + 1}`,
        result.affineMapping ? 'affine mapping' : 'no affine mapping'].join(' · ');
    }
    renderTable(result);
    const backend = analysisBackendLabel({ ...result, engine: `CPU · ${plural(result.workerCount ?? 1, 'Worker')}` });
    if ($('wigner-seitz-backend')) $('wigner-seitz-backend').textContent = backend;
    if ($('wigner-seitz-status')) $('wigner-seitz-status').title = analysisBackendDetails(result);
    if ($('wigner-seitz-progress')) { $('wigner-seitz-progress').hidden = true; $('wigner-seitz-progress').value = 1; }
    state('Updating display…');
    updateMarkers();
    onResultsChange({ frame, clearSettings: false });
    afterDisplayRefresh(() => {
      if (current() && job.cached === cached && job.frame === frame) {
        state('Calculated', `${backend} · ${((result.elapsedMs ?? 0) / 1000).toLocaleString('en-US', { maximumSignificantDigits: 3 })} s`);
      }
    });
  }

  async function run({ automatic = false, isCurrent = () => true } = {}) {
    const frame = getFrame();
    if (!frame || !isCurrent()) return false;
    let settings;
    try { settings = readSettings(); }
    catch (error) {
      abort(); job.failed = true;
      clearFrames(); clearView(); onResultsChange({ clearSettings: false });
      state('Failed', error.message);
      if (!automatic) notify(error.message);
      return false;
    }
    if (!automatic) onEdit();
    job.settings = settings;
    abort(); job.enabled = true; job.failed = false;
    syncTool({ reveal: !automatic });
    const request = job.serial, token = generation, source = getSourceVersion(), colorChoice = getColorChoiceVersion();
    const controller = new AbortController(); job.controller = controller;
    const current = () => request === job.serial && token === generation && source === getSourceVersion()
      && frame === getFrame() && job.enabled && !controller.signal.aborted && isCurrent();
    const { referenceFrame, affineMapping } = settings;
    const key = JSON.stringify({ referenceFrame, affineMapping, sourceVersion: source });
    try {
      let cached = frame.atomeyeResults?.wignerSeitz;
      if (cached?.key !== key) {
        clearAnalysisResults(frame, 'wignerSeitz');
        if (frame.atomeyeResults) delete frame.atomeyeResults.wignerSeitz;
        clearView(); job.frame = frame;
        state('Calculating…', `Loading reference frame ${referenceFrame + 1}…`);
        onResultsChange({ frame, clearSettings: false });
        const reference = referenceFrame === getFrameIndex() ? frame : await getFrameAt(referenceFrame);
        if (!current()) return false;
        if (!reference) throw new Error('The Wigner–Seitz reference frame is no longer available.');
        const result = await pool.analyze(frame, { kind: 'wignerSeitz', referenceFractional: reference.fractional, referenceCell: reference.cell,
          referenceTypes: reference.types, referenceTypeLabels: reference.typeLabels, affineMapping }, {
          signal: controller.signal, frameIndex: getFrameIndex(),
          onProgress: progress => {
            if (!current()) return;
            if ($('wigner-seitz-status')) $('wigner-seitz-status').textContent = analysisProgressText(progress, { frameIndex: getFrameIndex(), kind: 'wignerSeitz' });
            const meter = $('wigner-seitz-progress');
            if (meter) {
              meter.hidden = false;
              const total = progress.totalAtoms ?? progress.total, done = progress.completedAtoms ?? progress.completed;
              if (Number.isFinite(done) && total > 0) meter.value = Math.max(0, Math.min(1, done / total));
              else meter.removeAttribute('value');
            }
          },
        });
        if (!current()) return false;
        if (!ArrayBuffer.isView(result.siteIndex) || result.siteIndex.length !== frame.ids.length) {
          throw new Error('The Wigner–Seitz output does not match the current atom population.');
        }
        result.exportSites = wignerSeitzExportSites(result, frame, reference, { affineMapping });
        result.referenceFrame = referenceFrame;
        cached = { key, result, referenceFrame };
        displayContexts.set(cached, { frame, markers: new Map(),
          reference: { fractional: reference.fractional, cell: reference.cell, typeLabels: reference.typeLabels } });
        frame.atomeyeResults ??= {}; frame.atomeyeResults.wignerSeitz = cached;
      }
      if (!current()) return false;
      job.controller = null;
      showResult(cached, frame, current);
      if (!automatic && colorChoice === getColorChoiceVersion()) chooseProperty('wsDefectClass');
      return true;
    } catch (error) {
      if (!current() || error.name === 'AbortError') return false;
      job.controller = null; job.failed = true;
      clearAnalysisResults(frame, 'wignerSeitz');
      if (frame.atomeyeResults) delete frame.atomeyeResults.wignerSeitz;
      clearView(); state('Failed', error.message);
      onResultsChange({ frame, clearSettings: false });
      if (!automatic) notify(error.message);
      return false;
    } finally {
      if (job.controller === controller) job.controller = null;
      updateControls();
    }
  }

  async function onFrame() {
    abort(); clearView();
    updateControls();
    job.queued = job.enabled;
    if (!job.enabled) { state('Not calculated', HELP); return false; }
    return run({ automatic: true });
  }

  function applySettings(settings) {
    if ($('wigner-seitz-reference-frame')) $('wigner-seitz-reference-frame').value = String(settings.referenceFrame + 1);
    if ($('wigner-seitz-affine')) $('wigner-seitz-affine').checked = settings.affineMapping;
    if ($('wigner-seitz-markers')) $('wigner-seitz-markers').value = settings.markers;
    if ($('wigner-seitz-show-markers')) $('wigner-seitz-show-markers').checked = settings.showMarkers;
    if ($('wigner-seitz-marker-radius')) $('wigner-seitz-marker-radius').value = String(settings.markerRadius);
    updateControls();
  }

  function reset() {
    generation++;
    cancel({ silent: true });
    job.settings = { ...WIGNER_SEITZ_DEFAULTS };
    applySettings(job.settings);
    onResultsChange({ clearSettings: true });
  }

  function serialize() {
    let settings = job.settings;
    try { settings = { ...settings, ...readSettings() }; } catch { settings = { ...settings, ...displaySettings() }; }
    return { enabled: job.enabled, referenceFrame: settings.referenceFrame, affineMapping: settings.affineMapping,
      markers: settings.markers, showMarkers: settings.showMarkers, markerRadius: settings.markerRadius };
  }

  async function restore(saved, { isCurrent = () => true } = {}) {
    if (!isCurrent()) return false;
    generation++;
    cancel({ clearSettings: false, silent: true });
    const settings = { ...WIGNER_SEITZ_DEFAULTS, ...(saved ?? {}) };
    job.settings = { referenceFrame: settings.referenceFrame, affineMapping: settings.affineMapping === true,
      markers: WIGNER_SEITZ_MARKER_MODES.includes(settings.markers) ? settings.markers : WIGNER_SEITZ_DEFAULTS.markers,
      showMarkers: settings.showMarkers !== false, markerRadius: settings.markerRadius };
    applySettings(job.settings);
    job.enabled = Boolean(saved?.enabled); job.queued = job.enabled; syncTool();
    onResultsChange({ clearSettings: false });
    if (!job.enabled || !isCurrent()) return false;
    return run({ automatic: true, isCurrent });
  }

  const legend = $('wigner-seitz-marker-legend');
  if (legend) {
    const root = legend.ownerDocument ?? globalThis.document;
    legend.replaceChildren(...WIGNER_SEITZ_SITE_CLASSES.map(({ label, description, color }) => {
      const item = root.createElement('span'), swatch = root.createElement('i');
      item.setAttribute?.('role', 'listitem'); item.title = description;
      if (swatch.style) swatch.style.background = `rgb(${color.join(' ')})`;
      item.append(swatch, root.createTextNode?.(label) ?? label);
      return item;
    }));
  }
  $('run-wigner-seitz')?.addEventListener('click', () => { void run(); });
  $('cancel-wigner-seitz')?.addEventListener('click', () => { onEdit(); cancel(); });
  for (const id of ['wigner-seitz-reference-frame', 'wigner-seitz-affine']) {
    $(id)?.addEventListener('change', () => {
      onEdit();
      if (job.enabled) void run({ automatic: true });
    });
  }
  for (const id of ['wigner-seitz-markers', 'wigner-seitz-show-markers', 'wigner-seitz-marker-radius']) {
    $(id)?.addEventListener('change', () => { onEdit(); updateMarkers(); });
  }
  $('wigner-seitz-color-class')?.addEventListener('click', () => chooseProperty('wsDefectClass', { manual: true }));
  $('wigner-seitz-color-occupancy')?.addEventListener('click', () => chooseProperty('wsOccupancy', { manual: true }));
  state('Not calculated', HELP);

  return Object.freeze({ run, onFrame, reset, cancel, serialize, restore, updateMarkers,
    abortJobs: abort,
    isEnabled: () => job.enabled,
    setEnabled(value) { controlsEnabled = Boolean(value); updateControls(); },
    getResult: () => job.cached?.result ?? null,
    getPropertyKind: name => job.enabled && !job.failed && WIGNER_SEITZ_PROPERTIES.some(field => field.name === name) ? 'wignerSeitz' : null,
    pendingKinds: () => job.enabled && !job.failed && (job.controller || job.queued) ? ['wignerSeitz'] : [],
    pendingColorProperties: () => job.enabled && !job.failed ? WIGNER_SEITZ_PROPERTIES.map(({ name, label }) => ({ name, label })) : [],
    failed: () => job.failed ? ['wignerSeitz'] : [],
  });
}
