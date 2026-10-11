import { clearAnalysisResults, replaceAnalysisProperty } from './analysis/results.js';
import { analysisProgressText } from './analysis/status.js';
import { GRAIN_ALGORITHMS, GRAIN_DEFAULTS, GRAIN_DEFAULT_MST_THRESHOLD, quaternionAxisAngle, validateGrainParameters } from './analysis/grains.js';
import { determinant3 } from './data/model.js';
import { DISTINCT_CATEGORY_COLORS } from './render/palette.js';
import { renderGrainMergeChart } from './render/grain-merge-chart.js';
import { GRAIN_ORIENTATION_COLOR_MODES } from './render/orientation-colors.js';

export const GRAIN_PROPERTIES = Object.freeze([Object.freeze({ key: 'grainId', name: 'grainId', label: 'Grain ID' })]);
/** Distinct hues for grain IDs 1, 2, … in turn; sizes order the IDs, so the
 * largest grains receive the most different colors. Atoms of no grain are gray. */
export const GRAIN_COLORS = DISTINCT_CATEGORY_COLORS;
export const GRAIN_NONE_COLOR = Object.freeze([128, 128, 128]);
/** Grains listed individually in the color legend; others share one entry. */
export const GRAIN_LEGEND_LIMIT = 20;
export const GRAIN_STRUCTURE_LABELS = Object.freeze(['Other', 'FCC', 'HCP', 'BCC', 'ICO', 'SC', 'Diamond', 'Hex. diamond', 'Graphene']);
const UNLISTED_GRAINS = Object.freeze({ label: 'Grain', legendLabel: 'Other grains', colors: GRAIN_COLORS });
const DEFAULTS = Object.freeze({ ...GRAIN_DEFAULTS, mstThreshold: GRAIN_DEFAULT_MST_THRESHOLD });
const HELP = 'Uses the templates and RMSD threshold chosen in PTM, on the complete structure including hidden atoms.';
const TABLE_ROWS = 10, TABLE_STEP = 100;
const STAGES = Object.freeze({ bonds: 'Building neighbor bonds…', interfaces: 'Resolving coherent interfaces…',
  disorientation: 'Calculating disorientations…', merging: 'Merging clusters…', threshold: 'Choosing the merge threshold…', grains: 'Forming grains…' });

export function grainColor(id) {
  return id > 0 ? GRAIN_COLORS[(id - 1) % GRAIN_COLORS.length] : GRAIN_NONE_COLOR;
}

/** Legend categories: atoms of no grain, then the first grains by ID. */
export function grainCategories(result, limit = GRAIN_LEGEND_LIMIT) {
  const categories = [];
  if (result.unassignedAtoms > 0) categories.push({ id: 0, label: 'No grain', description: 'Atoms that belong to no grain', color: GRAIN_NONE_COLOR });
  for (let id = 1; id <= Math.min(result.grainCount, limit); id += 1) {
    const size = result.sizes[id - 1];
    categories.push({ id, label: `Grain ${id}`, color: grainColor(id),
      description: `${size.toLocaleString('en-US')} atom${size === 1 ? '' : 's'}, ${GRAIN_STRUCTURE_LABELS[result.structureTypes[id - 1]] ?? 'Other'}` });
  }
  return categories;
}

/** Volume of each grain in Å³: summed Voronoi atomic volumes when that
 * analysis covers every atom, otherwise atoms × mean atomic volume of a
 * fully periodic cell. Null when neither is defined. */
export function grainVolumes(frame, result) {
  const atomCount = result.grainId.length, volumes = new Float64Array(result.grainCount);
  const voronoi = frame.properties?.find(property => property.name === 'atomicVolume' && property.data?.length === atomCount);
  if (voronoi && !Array.prototype.some.call(voronoi.data, value => !Number.isFinite(value))) {
    for (let atom = 0; atom < atomCount; atom += 1) if (result.grainId[atom]) volumes[result.grainId[atom] - 1] += voronoi.data[atom];
    return { volumes, source: 'voronoi' };
  }
  if (!frame.cell?.pbc?.every(Boolean)) return null;
  const mean = Math.abs(determinant3(frame.cell.vectors)) / atomCount;
  for (let grain = 0; grain < result.grainCount; grain += 1) volumes[grain] = result.sizes[grain] * mean;
  return { volumes, source: 'mean' };
}

/** The automatic threshold is exactly the distance of the last merge it
 * admits. Shown with four decimals, it is rounded up so that entering the
 * displayed number as a manual threshold admits the same merges. */
export function displayedGrainThreshold(value) {
  return Number.isFinite(value) ? Math.ceil(value * 1e4 - 1e-9) / 1e4 + 0 : NaN;
}

const format = (value, digits = 5) => Number.isFinite(value)
  ? Number(value).toLocaleString('en-US', { maximumSignificantDigits: digits }) : '—';
const integer = value => Number(value).toLocaleString('en-US');

/** Grain segmentation of the displayed frame, recalculated on frame changes.
 * PTM supplies structure types, orientations and neighbor lists; `client`
 * runs the clustering in its Worker. Results are cached per frame and settings. */
export function initializeGrainTools({ client, tools, getFrame, getFrames = () => [getFrame()],
  getSourceVersion = () => 0, getFrameIndex = () => 0, getPtmParameters = () => ({ flags: 31, rmsdCutoff: .1 }),
  ensurePtm, releasePtm = () => {}, getColorChoiceVersion = () => 0, chooseProperty = () => {}, chooseColorMode = () => {},
  onResultsChange = () => {}, notify = () => {}, onEdit = () => {}, afterDisplayRefresh = callback => callback() }) {
  const $ = id => globalThis.document?.getElementById(id) ?? null;
  const job = { enabled: false, failed: false, queued: false, controller: null, serial: 0, result: null, frame: null,
    settings: { ...DEFAULTS } };
  let controlsEnabled = false, generation = 0, tableRows = TABLE_ROWS;

  function algorithm() {
    const value = $('grains-algorithm')?.value || job.settings.algorithm;
    return GRAIN_ALGORITHMS.includes(value) ? value : job.settings.algorithm;
  }

  /** The threshold field holds the manual log distance, the minimum spanning
   * tree disorientation, or, read-only, the automatically chosen value. */
  function syncThresholdField() {
    const mode = algorithm(), input = $('grains-threshold');
    if ($('grains-threshold-label')) $('grains-threshold-label').textContent = mode === 'mst' ? 'Disorientation threshold'
      : mode === 'manual' ? 'Merge threshold (log distance)' : 'Merge threshold (automatic)';
    if ($('grains-threshold-unit')) $('grains-threshold-unit').textContent = mode === 'mst' ? '°' : 'log d';
    if (!input) return;
    const automatic = job.result?.algorithm === 'automatic' ? job.result.mergeThreshold : job.result?.suggestedThreshold;
    input.value = mode === 'mst' ? String(job.settings.mstThreshold)
      : mode === 'manual' ? String(job.settings.mergeThreshold)
        : Number.isFinite(automatic) ? String(displayedGrainThreshold(automatic)) : '';
    if (input.placeholder !== undefined) input.placeholder = mode === 'automatic' ? 'Calculated' : '';
  }

  function updateControls() {
    const available = controlsEnabled && Boolean(getFrame());
    for (const id of ['grains-algorithm', 'grains-min-size', 'grains-orphans', 'grains-interfaces']) if ($(id)) $(id).disabled = !available;
    if ($('grains-threshold')) $('grains-threshold').disabled = !available || algorithm() === 'automatic';
    if ($('run-grains')) $('run-grains').disabled = !available || Boolean(job.controller) || job.queued;
    if ($('cancel-grains')) $('cancel-grains').disabled = !available || (!job.enabled && !job.failed);
    for (const id of ['grains-color-id', 'grains-color-ipf', 'grains-color-rodrigues']) if ($(id)) $(id).disabled = !available || !job.result;
  }

  function state(label, text = '') {
    if ($('grains-state')) {
      $('grains-state').textContent = label;
      $('grains-state').classList.toggle('ready', label === 'Calculated');
    }
    if (text && $('grains-status')) $('grains-status').textContent = text;
    updateControls();
  }

  function syncTool({ reveal = false } = {}) { tools?.setToolEnabled('grains', job.enabled, { reveal }); }

  function numberInput(id) {
    const input = $(id);
    if (!input) return undefined;
    return input.value === '' ? NaN : input.valueAsNumber ?? Number(input.value);
  }

  /** Read the controls. The field of the automatic algorithm is an output, so
   * the stored manual and minimum-spanning-tree thresholds stay as they are. */
  function parameters() {
    const mode = algorithm(), typed = numberInput('grains-threshold');
    const settings = { ...job.settings, algorithm: mode,
      minGrainSize: numberInput('grains-min-size') ?? job.settings.minGrainSize,
      adoptOrphans: $('grains-orphans') ? Boolean($('grains-orphans').checked) : job.settings.adoptOrphans,
      handleCoherentInterfaces: $('grains-interfaces') ? Boolean($('grains-interfaces').checked) : job.settings.handleCoherentInterfaces };
    if (typed !== undefined && mode === 'manual') settings.mergeThreshold = typed;
    if (typed !== undefined && mode === 'mst') settings.mstThreshold = typed;
    const request = validateGrainParameters({ algorithm: mode, mergeThreshold: mode === 'mst' ? settings.mstThreshold : settings.mergeThreshold,
      minGrainSize: settings.minGrainSize, adoptOrphans: settings.adoptOrphans, handleCoherentInterfaces: settings.handleCoherentInterfaces });
    return { settings, request, ptm: getPtmParameters() };
  }

  function abort() {
    job.serial++;
    job.controller?.abort();
    job.controller = null;
    job.queued = false;
    if ($('grains-progress')) $('grains-progress').hidden = true;
    updateControls();
  }

  function clearView() {
    job.result = null;
    if ($('grains-results')) $('grains-results').hidden = true;
    if ($('grains-summary')) $('grains-summary').textContent = '';
    if ($('grains-backend')) $('grains-backend').textContent = '—';
    $('grains-table-body')?.replaceChildren();
    $('grains-chart')?.replaceChildren();
    if ($('grains-show-more')) $('grains-show-more').hidden = true;
    syncThresholdField();
    updateControls();
  }

  function clearFrames() {
    for (const frame of new Set([...(getFrames() ?? []), getFrame(), job.frame])) {
      if (!frame) continue;
      clearAnalysisResults(frame, 'grains');
      if (frame.atomeyeResults) delete frame.atomeyeResults.grains;
    }
    job.frame = null;
  }

  function cancel({ clearSettings = true, silent = false } = {}) {
    abort();
    job.enabled = false; job.failed = false;
    clearFrames(); clearView(); syncTool();
    releasePtm(); client.release?.();
    state('Not calculated', HELP);
    if (!silent) onResultsChange({ clearSettings });
    return true;
  }

  function renderTable(result) {
    const body = $('grains-table-body');
    if (!body) return;
    const root = body.ownerDocument ?? globalThis.document;
    const cell = text => { const item = root.createElement('td'); item.textContent = text; return item; };
    const rows = [];
    for (let index = 0; index < Math.min(tableRows, result.grainCount); index += 1) {
      const row = root.createElement('tr');
      const id = root.createElement('td'), swatch = root.createElement('i');
      swatch.className = 'legend-swatch';
      if (swatch.style) swatch.style.background = `rgb(${grainColor(index + 1).join(' ')})`;
      id.append(swatch, root.createTextNode?.(String(index + 1)) ?? String(index + 1));
      const { angle, axis } = quaternionAxisAngle(result.orientations, index * 4);
      const q = Array.from(result.orientations.subarray(index * 4, index * 4 + 4));
      row.append(id, cell(integer(result.sizes[index])), cell(GRAIN_STRUCTURE_LABELS[result.structureTypes[index]] ?? 'Other'),
        cell(`${format(angle, 4)}° about [${axis.map(value => (Math.abs(value) < 5e-4 ? 0 : value).toFixed(3)).join(', ')}]`));
      row.title = `Mean orientation quaternion (w, x, y, z): ${q.map(value => value.toFixed(6)).join(', ')}`;
      rows.push(row);
    }
    body.replaceChildren(...rows);
    const remaining = result.grainCount - Math.min(tableRows, result.grainCount);
    if ($('grains-show-more')) {
      $('grains-show-more').hidden = remaining <= 0;
      $('grains-show-more').textContent = `Show ${integer(Math.min(TABLE_STEP, remaining))} more of ${integer(remaining)}`;
    }
    if ($('grains-table-caption')) {
      $('grains-table-caption').textContent = result.grainCount
        ? `Showing ${integer(Math.min(tableRows, result.grainCount))} of ${integer(result.grainCount)} grains, largest first. The CSV also lists quaternions, Euler angles and volumes.`
        : 'No grain reaches the minimum size. Lower it, or check the PTM templates and RMSD threshold.';
    }
  }

  function renderChart(result) {
    // Clicking the plot sets the threshold of the two manual algorithms.
    const onSelect = result.algorithm === 'automatic' ? null : value => {
      const input = $('grains-threshold');
      if (!input || input.disabled) return;
      const rounded = Number(value.toPrecision(5));
      input.value = String(result.algorithm === 'mst' ? Math.max(0, rounded) : rounded);
      onEdit();
      void run({ automatic: true });
    };
    renderGrainMergeChart($('grains-chart'), result.plot, { threshold: result.mergeThreshold, onSelect });
    if ($('grains-chart-caption')) {
      $('grains-chart-caption').textContent = result.plot.unit === 'degrees'
        ? 'Each point joins two clusters along their least disoriented bond. Click the plot to set the threshold.'
        : result.algorithm === 'automatic'
          ? 'Merges inside a grain follow a line in log distance against log size; the threshold is the largest distance still on that line.'
          : 'Each point joins two clusters. Click the plot to set the threshold; the automatic value is '
            + `${format(result.suggestedThreshold, 6)}.`;
    }
  }

  function showResult(cached, frame, key, current) {
    const { result } = cached;
    job.result = result; job.frame = frame; job.failed = false;
    const metadata = { analysisKind: 'grains', analysisKey: key, analysisMs: result.totalMs, analysisEngine: result.engine };
    replaceAnalysisProperty(frame, { name: 'grainId', displayName: 'Grain ID', unit: '', data: result.grainId,
      categories: grainCategories(result), unlistedCategories: UNLISTED_GRAINS, ...metadata });
    if ($('grains-results')) $('grains-results').hidden = false;
    if ($('grains-summary')) {
      const parts = [`${integer(result.grainCount)} grain${result.grainCount === 1 ? '' : 's'}`];
      if (result.grainCount) parts.push(`mean ${format(result.meanSize, 4)} atoms`, `largest ${integer(result.largestSize)}`);
      parts.push(result.unassignedAtoms ? `${integer(result.unassignedAtoms)} atoms in no grain` : 'every atom in a grain');
      if (result.adoptedAtoms) parts.push(`${integer(result.adoptedAtoms)} orphan atoms adopted`);
      if (result.convertedAtoms) parts.push(`${integer(result.convertedAtoms)} interface atoms joined to their parent phase`);
      parts.push(result.algorithm === 'mst' ? `threshold ${format(result.mergeThreshold, 6)}°` : `threshold ${format(result.mergeThreshold, 6)}`);
      $('grains-summary').textContent = parts.join(' · ');
    }
    syncThresholdField();
    renderChart(result); renderTable(result);
    if ($('grains-backend')) $('grains-backend').textContent = result.engine;
    if ($('grains-progress')) { $('grains-progress').hidden = true; $('grains-progress').value = 1; }
    state('Updating display…');
    onResultsChange({ frame, clearSettings: false });
    afterDisplayRefresh(() => {
      if (current() && job.result === result && job.frame === frame) {
        state('Calculated', `${result.engine} · ${format((result.totalMs ?? 0) / 1000, 3)} s`
          + (result.ptmReused ? ' · reused the PTM fit' : '') + (result.modelReused ? ' · reused the merge sequence' : ''));
      }
    });
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
    job.settings = prepared.settings;
    abort(); job.enabled = true; job.failed = false;
    syncTool({ reveal: !automatic });
    const request = job.serial, token = generation, source = getSourceVersion(), colorChoice = getColorChoiceVersion();
    const controller = new AbortController(); job.controller = controller; job.queued = false;
    const current = () => request === job.serial && token === generation && source === getSourceVersion()
      && frame === getFrame() && job.enabled && !controller.signal.aborted && isCurrent();
    const key = JSON.stringify({ ...prepared.request, ptm: prepared.ptm, sourceVersion: source });
    const meter = $('grains-progress');
    try {
      let cached = frame.atomeyeResults?.grains;
      if (cached?.key !== key) {
        clearAnalysisResults(frame, 'grains');
        if (frame.atomeyeResults) delete frame.atomeyeResults.grains;
        clearView(); job.frame = frame; tableRows = TABLE_ROWS;
        state('Calculating…', 'Waiting for the PTM fit…');
        onResultsChange({ frame, clearSettings: false });
        const startedAt = performance.now();
        if (meter) { meter.hidden = false; meter.removeAttribute('value'); }
        const fitted = await ensurePtm(frame, { signal: controller.signal, onProgress: progress => {
          if (!current()) return;
          if ($('grains-status')) $('grains-status').textContent = analysisProgressText(progress, { frameIndex: getFrameIndex(), kind: 'ptm' });
          const total = progress.totalAtoms ?? progress.total, done = progress.completedAtoms ?? progress.completed;
          // The PTM fit is the first half of the bar; clustering the second.
          if (meter && Number.isFinite(done) && total > 0) meter.value = Math.max(0, Math.min(.5, .5 * done / total));
        } });
        if (!current()) return false;
        const ptmMs = performance.now() - startedAt;
        if ($('grains-status')) $('grains-status').textContent = STAGES.bonds;
        const segmented = await client.segment({ ptm: fitted.ptm, fractional: frame.fractional, cell: frame.cell }, prepared.request, {
          signal: controller.signal,
          onProgress: (stage, fraction) => {
            if (!current()) return;
            if ($('grains-status')) $('grains-status').textContent = STAGES[stage] ?? 'Finding grains…';
            const order = Object.keys(STAGES).indexOf(stage);
            if (meter && order >= 0) meter.value = .5 + .5 * (order + Math.max(0, Math.min(1, fraction || 0))) / Object.keys(STAGES).length;
          },
        });
        if (!current()) return false;
        if (!ArrayBuffer.isView(segmented.grainId) || segmented.grainId.length !== frame.ids.length) {
          throw new Error('The grain output does not match the current atom population.');
        }
        const result = { ...segmented, ptmMs, ptmReused: Boolean(fitted.reused), ptmKey: fitted.ptm.key, totalMs: performance.now() - startedAt,
          engine: `${fitted.reused ? 'PTM (reused)' : fitted.engine ?? 'PTM'} + ${segmented.worker ? 'CPU · 1 Worker' : 'CPU · main thread'}` };
        const estimate = grainVolumes(frame, result);
        if (estimate) { result.volumes = estimate.volumes; result.volumeSource = estimate.source; }
        cached = { key, result };
        frame.atomeyeResults ??= {}; frame.atomeyeResults.grains = cached;
      } else tableRows = Math.max(TABLE_ROWS, tableRows);
      if (!current()) return false;
      job.controller = null;
      showResult(cached, frame, key, current);
      if (!automatic && colorChoice === getColorChoiceVersion()) chooseProperty('grainId');
      return true;
    } catch (error) {
      if (!current() || error.name === 'AbortError') return false;
      job.controller = null; job.failed = true;
      clearAnalysisResults(frame, 'grains');
      if (frame.atomeyeResults) delete frame.atomeyeResults.grains;
      clearView(); state('Failed', error.message);
      onResultsChange({ frame, clearSettings: false });
      if (!automatic) notify(error.message);
      return false;
    } finally {
      if (job.controller === controller) job.controller = null;
      if (meter && !job.controller) meter.hidden = true;
      updateControls();
    }
  }

  async function onFrame() {
    abort(); clearView();
    job.queued = job.enabled;
    if (!job.enabled) { state('Not calculated', HELP); return false; }
    return run({ automatic: true });
  }

  function applySettings(settings) {
    if ($('grains-algorithm')) $('grains-algorithm').value = settings.algorithm;
    if ($('grains-min-size')) $('grains-min-size').value = String(settings.minGrainSize);
    if ($('grains-orphans')) $('grains-orphans').checked = settings.adoptOrphans;
    if ($('grains-interfaces')) $('grains-interfaces').checked = settings.handleCoherentInterfaces;
    syncThresholdField();
    updateControls();
  }

  function reset() {
    generation++;
    cancel({ silent: true });
    job.settings = { ...DEFAULTS };
    applySettings(job.settings);
    onResultsChange({ clearSettings: true });
  }

  /** Settings as shown, falling back to the last valid value of a field
   * that is empty or out of range, so a recipe is always valid. */
  function serialize() {
    const mode = algorithm(), typed = numberInput('grains-threshold'), size = numberInput('grains-min-size');
    const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e6;
    return { enabled: job.enabled, algorithm: mode,
      mergeThreshold: mode === 'manual' && finite(typed) ? typed : job.settings.mergeThreshold,
      mstThreshold: mode === 'mst' && finite(typed) && typed >= 0 ? typed : job.settings.mstThreshold,
      minGrainSize: Number.isInteger(size) && size >= 1 && size <= 2 ** 31 - 1 ? size : job.settings.minGrainSize,
      adoptOrphans: $('grains-orphans') ? Boolean($('grains-orphans').checked) : job.settings.adoptOrphans,
      handleCoherentInterfaces: $('grains-interfaces') ? Boolean($('grains-interfaces').checked) : job.settings.handleCoherentInterfaces };
  }

  async function restore(saved, { isCurrent = () => true } = {}) {
    if (!isCurrent()) return false;
    generation++;
    cancel({ clearSettings: false, silent: true });
    const settings = { ...DEFAULTS, ...(saved ?? {}) };
    job.settings = { algorithm: settings.algorithm, mergeThreshold: settings.mergeThreshold, mstThreshold: settings.mstThreshold,
      minGrainSize: settings.minGrainSize, adoptOrphans: settings.adoptOrphans !== false,
      handleCoherentInterfaces: settings.handleCoherentInterfaces !== false };
    applySettings(job.settings);
    job.enabled = Boolean(saved?.enabled); job.queued = job.enabled; syncTool();
    onResultsChange({ clearSettings: false });
    if (!job.enabled || !isCurrent()) return false;
    return run({ automatic: true, isCurrent });
  }

  /** The PTM templates or RMSD threshold changed. */
  function refreshPtmParameters() {
    return job.enabled ? run({ automatic: true }) : Promise.resolve(false);
  }

  $('run-grains')?.addEventListener('click', () => { tableRows = TABLE_ROWS; void run(); });
  $('cancel-grains')?.addEventListener('click', () => { onEdit(); cancel(); });
  $('grains-algorithm')?.addEventListener('change', () => {
    onEdit();
    // Start manual editing from the automatic value when none was entered.
    const suggested = job.result?.suggestedThreshold;
    if (algorithm() === 'manual' && job.settings.mergeThreshold === DEFAULTS.mergeThreshold && Number.isFinite(suggested)) {
      job.settings.mergeThreshold = displayedGrainThreshold(suggested);
    }
    syncThresholdField(); updateControls();
    if (job.enabled) void run({ automatic: true });
  });
  for (const id of ['grains-threshold', 'grains-min-size', 'grains-orphans', 'grains-interfaces']) {
    $(id)?.addEventListener('change', () => {
      onEdit();
      updateControls();
      if (job.enabled) void run({ automatic: true });
    });
  }
  $('grains-show-more')?.addEventListener('click', () => {
    if (!job.result) return;
    tableRows += TABLE_STEP;
    renderTable(job.result);
  });
  $('grains-color-id')?.addEventListener('click', () => chooseProperty('grainId', { manual: true }));
  $('grains-color-ipf')?.addEventListener('click', () => chooseColorMode(GRAIN_ORIENTATION_COLOR_MODES[0]));
  $('grains-color-rodrigues')?.addEventListener('click', () => chooseColorMode(GRAIN_ORIENTATION_COLOR_MODES[1]));
  applySettings(job.settings);
  state('Not calculated', HELP);

  return Object.freeze({ run, onFrame, reset, cancel, serialize, restore, refreshPtmParameters,
    abortJobs: abort,
    warm: () => client.warm?.(),
    dispose() { abort(); client.dispose?.(); },
    isEnabled: () => job.enabled,
    setEnabled(value) { controlsEnabled = Boolean(value); updateControls(); },
    getResult: () => job.result,
    getPropertyKind: name => job.enabled && !job.failed && GRAIN_PROPERTIES.some(field => field.name === name) ? 'grains' : null,
    pendingKinds: () => job.enabled && !job.failed && (job.controller || job.queued) ? ['grains'] : [],
    pendingColorProperties: () => job.enabled && !job.failed ? GRAIN_PROPERTIES.map(({ name, label }) => ({ name, label })) : [],
    /** Orientation color modes to offer while a result is still on its way. */
    pendingColorModes: () => job.enabled && !job.failed ? [
      { value: GRAIN_ORIENTATION_COLOR_MODES[0], label: 'Grain orientation · inverse pole figure' },
      { value: GRAIN_ORIENTATION_COLOR_MODES[1], label: 'Grain orientation · Rodrigues RGB' }] : [],
    failed: () => job.failed ? ['grains'] : [],
  });
}
