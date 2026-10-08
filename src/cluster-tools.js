import { clearAnalysisResults, replaceAnalysisProperty } from './analysis/results.js';
import { analysisBackendLabel, analysisBackendDetails, analysisProgressText } from './analysis/status.js';
import { atomIdSet, hasAtomId } from './data/atom-ids.js';

export const CLUSTER_PROPERTIES = Object.freeze([
  Object.freeze({ key: 'clusterId', name: 'clusterId', label: 'Cluster ID' }),
  Object.freeze({ key: 'clusterSize', name: 'clusterSize', label: 'Cluster size' }),
]);

/** Distinct hues for cluster IDs 1, 2, … in turn. None is gray, which marks
 * atoms outside the analyzed group (ID 0). Sizes sort IDs, so neighboring
 * large clusters receive the most different early colors. */
export const CLUSTER_COLORS = Object.freeze([
  [230, 25, 75], [60, 180, 75], [255, 225, 25], [0, 130, 200], [245, 130, 48], [145, 30, 180],
  [70, 240, 240], [240, 50, 230], [210, 245, 60], [250, 190, 212], [0, 128, 128], [220, 190, 255],
  [170, 110, 40], [128, 0, 0], [170, 255, 195], [128, 128, 0], [255, 215, 180], [100, 100, 255],
].map(color => Object.freeze(color)));
export const CLUSTER_EXCLUDED_COLOR = Object.freeze([128, 128, 128]);
/** Clusters listed individually in the color legend; others share one entry. */
export const CLUSTER_LEGEND_LIMIT = 20;
const UNLISTED_CLUSTERS = Object.freeze({ label: 'Cluster', legendLabel: 'Other clusters', colors: CLUSTER_COLORS });
const DEFAULTS = Object.freeze({ neighborMode: 'cutoff', cutoff: null, selectionGroupId: null, sortBySize: true });
const HELP = 'Calculate on the complete structure, including atoms hidden in the display.';
const TABLE_ROWS = 10, TABLE_STEP = 100;

export function clusterColor(id) {
  return id > 0 ? CLUSTER_COLORS[(id - 1) % CLUSTER_COLORS.length] : CLUSTER_EXCLUDED_COLOR;
}

/** Legend categories: excluded atoms, then the first clusters by ID. */
export function clusterCategories(result, limit = CLUSTER_LEGEND_LIMIT) {
  const categories = [];
  if (result.excludedAtoms > 0) {
    categories.push({ id: 0, label: 'Not analyzed', description: 'Atoms outside the selected group', color: CLUSTER_EXCLUDED_COLOR });
  }
  for (let id = 1; id <= Math.min(result.clusterCount, limit); id += 1) {
    const size = result.sizes[id - 1];
    categories.push({ id, label: `Cluster ${id}`, color: clusterColor(id),
      description: `${size.toLocaleString('en-US')} atom${size === 1 ? '' : 's'}${result.percolating[id - 1] ? ', connected through periodic boundaries' : ''}` });
  }
  return categories;
}

const format = (value, digits = 5) => Number.isFinite(value)
  ? Number(value).toLocaleString('en-US', { maximumSignificantDigits: digits }) : '—';
const integer = value => Number(value).toLocaleString('en-US');

/** Connected components of the cutoff neighbor graph, recalculated for each
 * displayed frame. Results are cached per frame, settings and group content. */
export function initializeClusterTools({ pool, tools, getFrame, getFrames = () => [getFrame()],
  getSourceVersion = () => 0, getFrameIndex = () => 0, getBondParameters = () => null, getSelectionGroups = () => [],
  getColorChoiceVersion = () => 0, chooseProperty = () => {}, onResultsChange = () => {}, notify = () => {},
  onEdit = () => {}, onBeforeClear = () => {} }) {
  const $ = id => globalThis.document?.getElementById(id) ?? null;
  const job = { enabled: false, failed: false, queued: false, controller: null, serial: 0, result: null, frame: null,
    settings: { ...DEFAULTS } };
  const memberSerials = new WeakMap();
  let controlsEnabled = false, generation = 0, tableRows = TABLE_ROWS, nextMemberSerial = 1;

  function updateControls() {
    const available = controlsEnabled && Boolean(getFrame());
    for (const id of ['clusters-neighbor-mode', 'clusters-cutoff', 'clusters-selection', 'clusters-sort']) if ($(id)) $(id).disabled = !available;
    if ($('clusters-cutoff-field')) $('clusters-cutoff-field').hidden = neighborMode() === 'bonds';
    if ($('clusters-bond-help')) $('clusters-bond-help').hidden = neighborMode() !== 'bonds';
    if ($('run-clusters')) $('run-clusters').disabled = !available || Boolean(job.controller) || job.queued;
    if ($('cancel-clusters')) $('cancel-clusters').disabled = !available || (!job.enabled && !job.failed);
    for (const id of ['clusters-color-id', 'clusters-color-size']) if ($(id)) $(id).disabled = !available || !job.result;
  }

  function neighborMode() { return $('clusters-neighbor-mode')?.value || job.settings.neighborMode; }

  function state(label, text = '') {
    if ($('clusters-state')) {
      $('clusters-state').textContent = label;
      $('clusters-state').classList.toggle('ready', label === 'Calculated');
    }
    if (text && $('clusters-status')) $('clusters-status').textContent = text;
    updateControls();
  }

  function syncTool({ reveal = false } = {}) { tools?.setToolEnabled('clusters', job.enabled, { reveal }); }

  /** Group choices follow the named selections; a saved group that no
   * longer exists stays visible so the failure explains itself. */
  function updateSelectionOptions() {
    const select = $('clusters-selection');
    if (!select) return;
    const root = select.ownerDocument ?? globalThis.document;
    const groups = getSelectionGroups() ?? [];
    const chosen = job.settings.selectionGroupId;
    const option = (value, text) => { const item = root.createElement('option'); item.value = value; item.textContent = text; return item; };
    const options = [option('', 'All atoms'), ...groups.map(group => option(group.id, `${group.name} · ${integer(group.atomIds.length)} IDs`))];
    if (chosen !== null && !groups.some(group => group.id === chosen)) options.push(option(chosen, `Missing group (${chosen})`));
    select.replaceChildren(...options);
    select.value = chosen ?? '';
  }

  function cutoffInput() {
    const input = $('clusters-cutoff');
    if (!input) return job.settings.cutoff;
    const value = input.value === '' ? NaN : input.valueAsNumber ?? Number(input.value);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function parameters() {
    const mode = neighborMode();
    if (!['cutoff', 'bonds'].includes(mode)) throw new Error('Choose cutoff or bond neighbors for clusters.');
    const sortBySize = $('clusters-sort') ? Boolean($('clusters-sort').checked) : job.settings.sortBySize;
    const selectionGroupId = ($('clusters-selection') ? $('clusters-selection').value : job.settings.selectionGroupId ?? '') || null;
    const ownCutoff = cutoffInput();
    let cutoff = ownCutoff, pairCutoffs = [];
    if (mode === 'bonds') {
      const bonds = getBondParameters();
      if (!Number.isFinite(bonds?.cutoff) || bonds.cutoff <= 0) throw new Error('Enter a positive finite default cutoff in Bonds.');
      cutoff = bonds.cutoff;
      pairCutoffs = (bonds.pairCutoffs ?? []).map(entry => ({ first: entry.first, second: entry.second, cutoff: entry.cutoff }));
    } else if (cutoff === null) throw new Error('Enter a positive finite cluster cutoff.');
    const group = selectionGroupId === null ? null : (getSelectionGroups() ?? []).find(item => item.id === selectionGroupId);
    if (selectionGroupId !== null && !group) throw new Error('The selected atom group no longer exists. Choose another group or All atoms.');
    return { settings: { neighborMode: mode, cutoff: ownCutoff ?? job.settings.cutoff, selectionGroupId, sortBySize },
      request: { neighborMode: mode, cutoff, pairCutoffs, sortBySize }, group };
  }

  function memberSerial(atomIds) {
    if (!memberSerials.has(atomIds)) memberSerials.set(atomIds, nextMemberSerial++);
    return memberSerials.get(atomIds);
  }

  function selectionMask(frame, group) {
    if (!group) return null;
    const members = atomIdSet(group.atomIds), mask = new Uint8Array(frame.ids.length);
    for (let atom = 0; atom < mask.length; atom += 1) if (hasAtomId(members, frame.ids[atom])) mask[atom] = 1;
    return mask;
  }

  function massProperty(frame) {
    return frame.properties.find(property => property.name === 'mass' && !property.categories && !property.analysisKind
      && ArrayBuffer.isView(property.data) && property.data.length === frame.ids.length) ?? null;
  }

  function abort() {
    job.serial++;
    job.controller?.abort();
    job.controller = null;
    job.queued = false;
    if ($('clusters-progress')) $('clusters-progress').hidden = true;
    updateControls();
  }

  function clearView() {
    job.result = null;
    if ($('clusters-results')) $('clusters-results').hidden = true;
    if ($('clusters-summary')) $('clusters-summary').textContent = '';
    if ($('clusters-backend')) $('clusters-backend').textContent = '—';
    if ($('clusters-status')) $('clusters-status').title = '';
    $('clusters-table-body')?.replaceChildren();
    if ($('clusters-show-more')) $('clusters-show-more').hidden = true;
    updateControls();
  }

  function clearFrames() {
    for (const frame of new Set([...(getFrames() ?? []), getFrame(), job.frame])) {
      if (!frame) continue;
      clearAnalysisResults(frame, 'clusters');
      if (frame.atomeyeResults) delete frame.atomeyeResults.clusters;
    }
    job.frame = null;
  }

  function cancel({ clearSettings = true, silent = false } = {}) {
    onBeforeClear('clusters', { clearSettings });
    abort();
    job.enabled = false; job.failed = false;
    clearFrames(); clearView(); syncTool();
    state('Not calculated', HELP);
    if (!silent) onResultsChange({ clearSettings });
    return true;
  }

  function renderTable(result) {
    const body = $('clusters-table-body');
    if (!body) return;
    const root = body.ownerDocument ?? globalThis.document;
    const cell = (text, className) => { const item = root.createElement('td'); item.textContent = text; if (className) item.className = className; return item; };
    const rows = [];
    for (let index = 0; index < Math.min(tableRows, result.clusterCount); index += 1) {
      const row = root.createElement('tr');
      const id = root.createElement('td'), swatch = root.createElement('i');
      swatch.className = 'legend-swatch';
      if (swatch.style) swatch.style.background = `rgb(${clusterColor(index + 1).join(' ')})`;
      id.append(swatch, root.createTextNode?.(String(index + 1)) ?? String(index + 1));
      const periodic = Boolean(result.percolating[index]);
      const center = periodic ? 'Periodic' : Array.from(result.centers.subarray(index * 3, index * 3 + 3), value => format(value)).join(', ');
      row.append(id, cell(integer(result.sizes[index])), cell(periodic ? '—' : format(result.radiiOfGyration[index])), cell(center, periodic ? 'cluster-periodic' : ''));
      if (periodic) row.title = 'This cluster connects to its own periodic image; its center and radius of gyration are undefined.';
      rows.push(row);
    }
    body.replaceChildren(...rows);
    const remaining = result.clusterCount - Math.min(tableRows, result.clusterCount);
    if ($('clusters-show-more')) {
      $('clusters-show-more').hidden = remaining <= 0;
      $('clusters-show-more').textContent = `Show ${integer(Math.min(TABLE_STEP, remaining))} more of ${integer(remaining)}`;
    }
    if ($('clusters-table-caption')) {
      $('clusters-table-caption').textContent = `Showing ${integer(Math.min(tableRows, result.clusterCount))} of ${integer(result.clusterCount)} clusters${result.sorted ? ', largest first' : ''}. Export the complete table as CSV.`;
    }
  }

  function showResult(result, frame, key, cutoff) {
    job.result = result; job.frame = frame; job.failed = false;
    // No GPU kernel exists, so the GPU preference is not recorded as a request.
    const metadata = { analysisKind: 'clusters', analysisKey: key, analysisMs: result.elapsedMs, analysisEngine: result.engine,
      analysisCutoff: cutoff };
    replaceAnalysisProperty(frame, { name: 'clusterId', displayName: 'Cluster ID', unit: '', data: result.clusterId,
      categories: clusterCategories(result), unlistedCategories: UNLISTED_CLUSTERS, ...metadata });
    replaceAnalysisProperty(frame, { name: 'clusterSize', displayName: 'Cluster size', unit: '', data: result.clusterSize, ...metadata });
    if ($('clusters-results')) $('clusters-results').hidden = false;
    if ($('clusters-summary')) {
      const parts = [`${integer(result.clusterCount)} cluster${result.clusterCount === 1 ? '' : 's'}`,
        `largest ${integer(result.largestSize)} atom${result.largestSize === 1 ? '' : 's'}`];
      if (result.percolatingCount) parts.push(`${integer(result.percolatingCount)} connected through periodic boundaries`);
      parts.push(result.excludedAtoms ? `${integer(result.includedAtoms)} of ${integer(frame.ids.length)} atoms analyzed` : 'all atoms analyzed');
      parts.push(result.weighting === 'mass' ? 'mass-weighted centers' : 'equal atom weights');
      $('clusters-summary').textContent = parts.join(' · ');
    }
    renderTable(result);
    const backend = analysisBackendLabel({ ...result, engine: `CPU · ${integer(result.workerCount ?? 1)} Worker${(result.workerCount ?? 1) === 1 ? '' : 's'}` });
    if ($('clusters-backend')) $('clusters-backend').textContent = backend;
    if ($('clusters-status')) $('clusters-status').title = analysisBackendDetails(result);
    if ($('clusters-progress')) { $('clusters-progress').hidden = true; $('clusters-progress').value = 1; }
    state('Calculated', `${backend} · ${format((result.elapsedMs ?? 0) / 1000)} s${result.warning ? ` · ${result.warning}` : ''}`);
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
    job.settings = prepared.settings;
    abort(); job.enabled = true; job.failed = false;
    syncTool({ reveal: !automatic });
    const request = job.serial, token = generation, source = getSourceVersion(), colorChoice = getColorChoiceVersion();
    const controller = new AbortController(); job.controller = controller; job.queued = false;
    const current = () => request === job.serial && token === generation && source === getSourceVersion()
      && frame === getFrame() && job.enabled && !controller.signal.aborted && isCurrent();
    const mass = massProperty(frame);
    const { group, request: settings } = prepared;
    const key = JSON.stringify({ ...settings, selection: group ? [group.id, memberSerial(group.atomIds)] : null,
      massWeighted: Boolean(mass), sourceVersion: source });
    try {
      let cached = frame.atomeyeResults?.clusters;
      if (cached?.key !== key) {
        clearAnalysisResults(frame, 'clusters');
        if (frame.atomeyeResults) delete frame.atomeyeResults.clusters;
        clearView(); job.frame = frame; tableRows = TABLE_ROWS;
        state('Calculating…', 'Waiting for available analysis Workers…');
        onResultsChange({ frame, clearSettings: false });
        const result = await pool.analyze(frame, { kind: 'clusters', ...settings, clusterSelection: selectionMask(frame, group),
          clusterMasses: mass?.data ?? null }, {
          signal: controller.signal, frameIndex: getFrameIndex(),
          onProgress: progress => {
            if (!current()) return;
            if ($('clusters-status')) $('clusters-status').textContent = progress.stage === 'cluster-labels'
              ? `Labeling clusters for frame ${getFrameIndex() + 1}…` : analysisProgressText(progress, { frameIndex: getFrameIndex(), kind: 'clusters' });
            if ($('clusters-backend')) $('clusters-backend').textContent = `CPU · ${integer(progress.workerCount ?? 1)} Workers`;
            const meter = $('clusters-progress');
            if (meter) {
              meter.hidden = false;
              const total = progress.totalAtoms ?? progress.total, done = progress.completedAtoms ?? progress.completed;
              if (progress.stage === 'cluster-labels') meter.removeAttribute('value');
              else if (Number.isFinite(done) && total > 0) meter.value = Math.max(0, Math.min(1, done / total));
              else meter.removeAttribute('value');
            }
          },
        });
        if (!current()) return false;
        if (!ArrayBuffer.isView(result.clusterId) || result.clusterId.length !== frame.ids.length
            || !ArrayBuffer.isView(result.clusterSize) || result.clusterSize.length !== frame.ids.length) {
          throw new Error('The cluster output does not match the current atom population.');
        }
        cached = { key, result, cutoff: settings.cutoff };
        frame.atomeyeResults ??= {}; frame.atomeyeResults.clusters = cached;
      } else tableRows = Math.max(TABLE_ROWS, tableRows);
      if (!current()) return false;
      job.controller = null;
      showResult(cached.result, frame, key, cached.cutoff);
      if (!automatic && colorChoice === getColorChoiceVersion()) chooseProperty('clusterId');
      return true;
    } catch (error) {
      if (!current() || error.name === 'AbortError') return false;
      job.controller = null; job.failed = true;
      clearAnalysisResults(frame, 'clusters');
      if (frame.atomeyeResults) delete frame.atomeyeResults.clusters;
      clearView(); state('Failed', error.message);
      onResultsChange({ frame, clearSettings: false });
      if (!automatic) notify(error.message);
      return false;
    } finally {
      if (job.controller === controller) job.controller = null;
      updateControls();
    }
  }

  async function onFrame({ suggestedCutoff } = {}) {
    abort(); clearView();
    const input = $('clusters-cutoff');
    // Keep an edited or saved radius; otherwise follow the element suggestion.
    if (input && (!input.value || (!job.enabled && job.settings.cutoff === null && suggestedCutoff))) input.value = String(suggestedCutoff ?? 3);
    updateSelectionOptions();
    job.queued = job.enabled;
    if (!job.enabled) { state('Not calculated', HELP); return false; }
    return run({ automatic: true });
  }

  function reset() {
    generation++;
    cancel({ silent: true });
    job.settings = { ...DEFAULTS };
    applySettings(job.settings);
    onResultsChange({ clearSettings: true });
  }

  function applySettings(settings) {
    if ($('clusters-neighbor-mode')) $('clusters-neighbor-mode').value = settings.neighborMode;
    if ($('clusters-cutoff') && settings.cutoff !== null) $('clusters-cutoff').value = String(settings.cutoff);
    if ($('clusters-sort')) $('clusters-sort').checked = settings.sortBySize;
    updateSelectionOptions();
    updateControls();
  }

  function serialize() {
    const mode = neighborMode();
    return { enabled: job.enabled, neighborMode: ['cutoff', 'bonds'].includes(mode) ? mode : job.settings.neighborMode,
      cutoff: cutoffInput() ?? job.settings.cutoff,
      selectionGroupId: ($('clusters-selection') ? $('clusters-selection').value : job.settings.selectionGroupId ?? '') || null,
      sortBySize: $('clusters-sort') ? Boolean($('clusters-sort').checked) : job.settings.sortBySize };
  }

  async function restore(saved, { isCurrent = () => true } = {}) {
    if (!isCurrent()) return false;
    generation++;
    cancel({ clearSettings: false, silent: true });
    const settings = { ...DEFAULTS, ...(saved ?? {}) };
    job.settings = { neighborMode: settings.neighborMode, cutoff: settings.cutoff ?? null,
      selectionGroupId: settings.selectionGroupId ?? null, sortBySize: settings.sortBySize !== false };
    applySettings(job.settings);
    job.enabled = Boolean(saved?.enabled); job.queued = job.enabled; syncTool();
    onResultsChange({ clearSettings: false });
    if (!job.enabled || !isCurrent()) return false;
    return run({ automatic: true, isCurrent });
  }

  function refreshBondParameters() {
    return job.enabled && neighborMode() === 'bonds' ? run({ automatic: true }) : Promise.resolve(false);
  }

  function refreshSelectionGroups() {
    updateSelectionOptions();
    return job.enabled && job.settings.selectionGroupId !== null ? run({ automatic: true }) : Promise.resolve(false);
  }

  $('run-clusters')?.addEventListener('click', () => { tableRows = TABLE_ROWS; void run(); });
  $('cancel-clusters')?.addEventListener('click', () => { onEdit(); cancel(); });
  for (const id of ['clusters-neighbor-mode', 'clusters-cutoff', 'clusters-selection', 'clusters-sort']) {
    $(id)?.addEventListener('change', () => {
      onEdit();
      if (id === 'clusters-selection') job.settings.selectionGroupId = $(id).value || null;
      updateControls();
      if (job.enabled) void run({ automatic: true });
    });
  }
  $('clusters-show-more')?.addEventListener('click', () => {
    if (!job.result) return;
    tableRows += TABLE_STEP;
    renderTable(job.result);
  });
  $('clusters-color-id')?.addEventListener('click', () => chooseProperty('clusterId', { manual: true }));
  $('clusters-color-size')?.addEventListener('click', () => chooseProperty('clusterSize', { manual: true }));
  state('Not calculated', HELP);

  return Object.freeze({ run, onFrame, reset, cancel, serialize, restore, refreshBondParameters, refreshSelectionGroups,
    abortJobs: abort,
    isEnabled: () => job.enabled,
    // Bonds keeps an edited cutoff across frames while clusters depend on it.
    usesBondCutoffs: () => job.enabled && neighborMode() === 'bonds',
    setEnabled(value) { controlsEnabled = Boolean(value); updateSelectionOptions(); updateControls(); },
    getResult: () => job.result,
    getPropertyKind: name => job.enabled && !job.failed && CLUSTER_PROPERTIES.some(field => field.name === name) ? 'clusters' : null,
    pendingKinds: () => job.enabled && !job.failed && (job.controller || job.queued) ? ['clusters'] : [],
    pendingColorProperties: () => job.enabled && !job.failed ? CLUSTER_PROPERTIES.map(({ name, label }) => ({ name, label })) : [],
    failed: () => job.failed ? ['clusters'] : [],
  });
}
