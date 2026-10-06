import { clearAnalysisResults, replaceAnalysisProperty } from './analysis/results.js';
import { analysisBackendLabel, analysisBackendDetails, analysisProgressText } from './analysis/status.js';
import { renderDistributionChart, renderStatisticsTable } from './render/distribution-chart.js';
import { initializeVoronoiResults } from './render/voronoi-results.js';

export const TOPOLOGY_PROPERTIES = Object.freeze({
  bondStatistics: Object.freeze([
    { key: 'q4', name: 'bondQ4', label: 'Steinhardt Q4', unit: '' },
    { key: 'q6', name: 'bondQ6', label: 'Steinhardt Q6', unit: '' },
    { key: 'coordination', name: 'bondStatisticsCoordination', label: 'Coordination (bond statistics)', unit: '' },
  ]),
  voronoi: Object.freeze([
    { key: 'atomicVolume', name: 'atomicVolume', label: 'Voronoi atomic volume', unit: 'Å³' },
    { key: 'voronoiSurfaceArea', name: 'voronoiSurfaceArea', label: 'Voronoi surface area', unit: 'Å²' },
    { key: 'voronoiCoordination', name: 'voronoiCoordination', label: 'Voronoi coordination', unit: '' },
    { key: 'voronoiBoundaryFaces', name: 'voronoiBoundaryFaces', label: 'Voronoi boundary faces', unit: '' },
    { key: 'voronoiMaxFaceOrder', name: 'voronoiMaxFaceOrder', label: 'Voronoi maximum face order', unit: '' },
  ]),
});

const DEFINITIONS = {
  bondStatistics: { prefix: 'bond-statistics', tool: 'bonds', property: 'bondQ6',
    fields: { lengthBins: 'bond-statistics-length-bins', angleBins: 'bond-statistics-angle-bins' },
    defaults: { lengthBins: 100, angleBins: 180 }, help: 'Uses the default and element-pair bond cutoffs above.' },
  voronoi: { prefix: 'voronoi', tool: 'voronoi', property: 'atomicVolume',
    fields: { faceAreaThreshold: 'voronoi-face-area-threshold', relativeFaceAreaThreshold: 'voronoi-relative-face-area-threshold' },
    defaults: { faceAreaThreshold: 0, relativeFaceAreaThreshold: 0, bins: 50, selectedTypes: null },
    help: 'Calculate using the checked element types, including their atoms hidden in the display.' },
};

const format = value => value !== null && value !== undefined && Number.isFinite(Number(value))
  ? Number(value).toLocaleString('en-US', { maximumSignificantDigits: 5 }) : '—';

/** Independent whole-frame metrics, with per-frame caches and shared CPU/GPU
 * Workers. Every reply is checked against its frame, source and request. */
export function initializeTopologyTools({ pool, tools, getFrame, getFrames = () => [getFrame()],
  getSourceVersion = () => 0, getFrameIndex = () => 0, getBondParameters = () => ({ cutoff: 3, pairCutoffs: [] }),
  getBondEnabled = () => Boolean(getFrame()?.atomeyeResults?.bonds),
  getColorChoiceVersion = () => 0, chooseProperty = () => {}, onResultsChange = () => {},
  notify = () => {}, onEdit = () => {}, onBeforeClear = () => {} }) {
  const $ = id => globalThis.document?.getElementById(id) ?? null;
  const voronoiView = initializeVoronoiResults({ getElement: $, chooseProperty });
  const jobs = Object.fromEntries(Object.keys(DEFINITIONS).map(kind => [kind,
    { enabled: false, failed: false, queued: false, controller: null, serial: 0, result: null, frame: null,
      settings: { ...DEFINITIONS[kind].defaults } }]));
  let controlsEnabled = false;
  let generation = 0;
  let typeFrame = null, typeChoices = [];

  function updateTypeControls() {
    const container = $('voronoi-type-options'), frame = getFrame(), selected = jobs.voronoi.settings.selectedTypes;
    const available = controlsEnabled && Boolean(frame);
    if (container && typeFrame !== frame) {
      typeFrame = frame; typeChoices = [];
      const root = container.ownerDocument;
      const counts = new Uint32Array(frame?.typeLabels?.length ?? 0);
      for (const type of frame?.types ?? []) counts[type]++;
      for (const [type, label] of (frame?.typeLabels ?? []).entries()) {
        const row = root.createElement('label'), input = root.createElement('input'), text = root.createElement('span');
        row.className = 'slice-toggle'; input.type = 'checkbox'; input.setAttribute('data-voronoi-type', label);
        text.textContent = `${label} · ${counts[type].toLocaleString('en-US')} atoms`;
        input.addEventListener('change', () => {
          const labels = typeChoices.filter(choice => choice.input.checked).map(choice => choice.label).sort();
          jobs.voronoi.settings.selectedTypes = labels.length === typeChoices.length ? null : labels;
          onEdit(); updateTypeControls();
          if (jobs.voronoi.enabled) void run('voronoi', { automatic: true });
        });
        row.append(input, text); typeChoices.push({ label, input, row });
      }
      container.replaceChildren(...typeChoices.map(choice => choice.row));
    }
    for (const choice of typeChoices) {
      choice.input.checked = selected === null || selected.includes(choice.label);
      choice.input.disabled = !available;
    }
    if ($('voronoi-type-summary')) $('voronoi-type-summary').textContent = selected === null ? 'All atoms'
      : selected.length ? selected.join(', ') : 'No types selected';
    for (const id of ['voronoi-select-all-types', 'voronoi-clear-types']) if ($(id)) $(id).disabled = !available;
  }

  function updateControls(kind) {
    const job = jobs[kind], definition = DEFINITIONS[kind], { prefix } = definition;
    const available = controlsEnabled && Boolean(getFrame());
    for (const id of Object.values(definition.fields)) if ($(id)) $(id).disabled = !available;
    if ($(`run-${prefix}`)) $(`run-${prefix}`).disabled = !available || Boolean(job.controller) || job.queued;
    if ($(`cancel-${prefix}`)) $(`cancel-${prefix}`).disabled = !available || (!job.enabled && !job.failed);
    if (kind === 'voronoi') { voronoiView.setEnabled(available && Boolean(job.result)); updateTypeControls(); }
  }

  function state(kind, label, text = '') {
    const { prefix } = DEFINITIONS[kind];
    if ($(`${prefix}-state`)) {
      $(`${prefix}-state`).textContent = label;
      $(`${prefix}-state`).classList.toggle('ready', label === 'Calculated');
    }
    if (text && $(`${prefix}-status`)) $(`${prefix}-status`).textContent = text;
    updateControls(kind);
  }

  function syncTool(kind, { reveal = false } = {}) {
    const { tool } = DEFINITIONS[kind];
    const enabled = jobs[kind].enabled || (kind === 'bondStatistics' && getBondEnabled());
    tools?.setToolEnabled(tool, Boolean(enabled), { reveal });
    return Boolean(enabled);
  }

  function parameters(kind) {
    const definition = DEFINITIONS[kind];
    const result = { ...jobs[kind].settings };
    for (const [name, id] of Object.entries(definition.fields)) {
      const input = $(id);
      result[name] = input ? (input.value === '' ? NaN : input.valueAsNumber ?? Number(input.value)) : result[name];
    }
    if (kind === 'bondStatistics') {
      if (![result.lengthBins, result.angleBins].every(value => Number.isInteger(value) && value >= 1 && value <= 4096)) {
        throw new Error('Use between 1 and 4096 bins for each bond distribution.');
      }
      const bonds = getBondParameters();
      if (!Number.isFinite(bonds?.cutoff) || bonds.cutoff <= 0) throw new Error('Enter a positive finite bond cutoff.');
      return { cutoff: bonds.cutoff, pairCutoffs: (bonds.pairCutoffs ?? []).map(entry => ({ ...entry })), ...result };
    }
    if (!Number.isFinite(result.faceAreaThreshold) || result.faceAreaThreshold < 0) {
      throw new Error('Enter a finite nonnegative minimum Voronoi face area.');
    }
    if (!Number.isFinite(result.relativeFaceAreaThreshold) || result.relativeFaceAreaThreshold < 0 || result.relativeFaceAreaThreshold > 1) {
      throw new Error('The minimum fraction of cell surface must be between 0 and 1.');
    }
    if (!Number.isInteger(result.bins) || result.bins < 1 || result.bins > 4096) {
      throw new Error('Use between 1 and 4096 bins for Voronoi distributions.');
    }
    if (result.selectedTypes !== null && !result.selectedTypes.length) throw new Error('Select at least one element type for Voronoi analysis.');
    return result;
  }

  function abort(kind) {
    const job = jobs[kind];
    job.serial++;
    job.controller?.abort();
    job.controller = null;
    job.queued = false;
    const progress = $(`${DEFINITIONS[kind].prefix}-progress`);
    if (progress) progress.hidden = true;
    updateControls(kind);
  }

  function abortJobs() { for (const kind of Object.keys(jobs)) abort(kind); }

  function clearView(kind) {
    const prefix = DEFINITIONS[kind].prefix;
    jobs[kind].result = null;
    if ($(`${prefix}-results`)) $(`${prefix}-results`).hidden = true;
    if ($(`${prefix}-summary`)) $(`${prefix}-summary`).textContent = '';
    if ($(`${prefix}-backend`)) $(`${prefix}-backend`).textContent = '—';
    if ($(`${prefix}-status`)) $(`${prefix}-status`).title = '';
    if (kind === 'voronoi') voronoiView.clear();
  }

  function clearFrames(kind) {
    const frames = new Set([...(getFrames() ?? []), getFrame(), jobs[kind].frame]);
    for (const frame of frames) {
      if (!frame) continue;
      clearAnalysisResults(frame, kind);
      if (frame.atomeyeResults) delete frame.atomeyeResults[kind];
    }
    jobs[kind].frame = null;
  }

  function cancel(kind, { clearSettings = true, silent = false } = {}) {
    if (!jobs[kind]) return false;
    onBeforeClear(kind, { clearSettings });
    abort(kind);
    jobs[kind].enabled = false; jobs[kind].failed = false;
    clearFrames(kind); clearView(kind); syncTool(kind);
    state(kind, 'Not calculated', DEFINITIONS[kind].help);
    if (!silent) onResultsChange({ kind, clearSettings });
    return true;
  }

  function showResult(kind, result, frame, key) {
    const job = jobs[kind], prefix = DEFINITIONS[kind].prefix;
    job.result = result; job.frame = frame; job.failed = false;
    for (const field of TOPOLOGY_PROPERTIES[kind]) {
      const data = result[field.key];
      if (!data || data.length !== frame.ids.length) continue;
      const autoRangeRelativeTolerance = result.autoRangeRelativeTolerance?.[field.key];
      replaceAnalysisProperty(frame, { name: field.name, displayName: field.label, unit: field.unit, data,
        analysisKind: kind, analysisKey: key, analysisMs: result.elapsedMs,
        analysisEngine: result.engine, analysisGpuRequested: Boolean(result.gpuRequested),
        ...(Number.isFinite(autoRangeRelativeTolerance) && autoRangeRelativeTolerance > 0 ? { autoRangeRelativeTolerance } : {}) });
    }
    if ($(`${prefix}-results`)) $(`${prefix}-results`).hidden = false;
    if (kind === 'bondStatistics') {
      const length = result.statistics?.length, angle = result.statistics?.angle;
      if ($(`${prefix}-summary`)) $(`${prefix}-summary`).textContent =
        `${format(length?.count ?? result.lengthDistribution?.total ?? 0)} bonds · mean ${format(length?.mean)} Å · ${format(angle?.count ?? result.angleDistribution?.total ?? 0)} angles · mean ${format(angle?.mean)}°`;
      renderDistributionChart($('bond-length-chart'), result.lengthDistribution, { label: 'Bond lengths', xLabel: 'Length' });
      renderDistributionChart($('bond-angle-chart'), result.angleDistribution, { label: 'Bond angles', xLabel: 'Angle' });
      renderStatisticsTable($('bond-order-chart'), Object.fromEntries(['q4', 'q6'].filter(name => result.statistics?.[name])
        .map(name => [name, result.statistics[name]])), { labels: { q4: 'Q4', q6: 'Q6' } });
    } else {
      const summary = result.summary ?? {};
      if ($(`${prefix}-summary`)) $(`${prefix}-summary`).textContent =
        `${format(summary.atomCount ?? frame.ids.length)} cells · mean volume ${format(summary.meanVolume)} Å³ · mean coordination ${format(summary.meanCoordination)} · ${format(summary.boundaryAtomCount ?? 0)} boundary atoms`;
      voronoiView.render(result);
    }
    const backend = { ...result, engine: result.engine ?? (result.backend === 'gpu' ? 'WebGPU' : 'CPU Workers') };
    const corrections = kind === 'voronoi' && result.gpuCorrectionAtoms > 0
      ? ` · ${format(result.gpuCorrectionAtoms)} cell${result.gpuCorrectionAtoms === 1 ? '' : 's'} corrected on CPU` : '';
    const displayBackend = kind === 'voronoi' ? { ...backend,
      engine: result.backend === 'gpu' ? 'WebGPU' : `CPU · ${format(result.workerCount ?? 1)} Worker${(result.workerCount ?? 1) === 1 ? '' : 's'}` } : backend;
    const backendLabel = `${analysisBackendLabel(displayBackend)}${corrections}`;
    if ($(`${prefix}-backend`)) $(`${prefix}-backend`).textContent = backendLabel;
    if ($(`${prefix}-status`)) $(`${prefix}-status`).title = `${analysisBackendDetails(backend)}${corrections}`;
    const progress = $(`${prefix}-progress`);
    if (progress) { progress.hidden = true; progress.value = 1; }
    state(kind, 'Calculated', `${backendLabel} · ${format((result.elapsedMs ?? 0) / 1000)} s`);
    onResultsChange({ kind, frame, clearSettings: false });
  }

  async function run(kind, { automatic = false, isCurrent = () => true } = {}) {
    const job = jobs[kind], frame = getFrame();
    if (!job || !frame || !isCurrent()) return false;
    let settings;
    try { settings = parameters(kind); }
    catch (error) {
      abort(kind); job.failed = true;
      if (kind === 'voronoi') { clearFrames(kind); clearView(kind); onResultsChange({ kind, clearSettings: false }); }
      state(kind, 'Failed', error.message);
      if (!automatic) notify(error.message);
      return false;
    }
    if (!automatic) onEdit();
    job.settings = Object.fromEntries(Object.keys(DEFINITIONS[kind].defaults).map(name => [name, settings[name]]));
    abort(kind); job.enabled = true; job.failed = false;
    syncTool(kind, { reveal: !automatic });
    const request = job.serial, token = generation, source = getSourceVersion(), colorChoice = getColorChoiceVersion();
    const controller = new AbortController(); job.controller = controller; job.queued = false;
    const current = () => request === job.serial && token === generation && source === getSourceVersion()
      && frame === getFrame() && job.enabled && !controller.signal.aborted && isCurrent();
    const key = JSON.stringify({ ...settings, sourceVersion: source, gpuRequested: Boolean(pool.gpuEnabled) });
    const prefix = DEFINITIONS[kind].prefix;
    try {
      let cached = frame.atomeyeResults?.[kind];
      if (cached?.key !== key) {
        clearAnalysisResults(frame, kind);
        if (frame.atomeyeResults) delete frame.atomeyeResults[kind];
        clearView(kind); job.frame = frame;
        state(kind, 'Calculating…', 'Waiting for available analysis Workers…');
        onResultsChange({ kind, frame, clearSettings: false });
        const result = await pool.analyze(frame, { kind, ...settings }, {
          signal: controller.signal, frameIndex: getFrameIndex(),
          onProgress: progress => {
            if (!current()) return;
            if ($(`${prefix}-status`)) $(`${prefix}-status`).textContent = analysisProgressText(progress, { frameIndex: getFrameIndex(), kind });
            if ($(`${prefix}-backend`)) $(`${prefix}-backend`).textContent = progress.backend === 'gpu'
              ? 'WebGPU' : `CPU · ${format(progress.workerCount ?? 1)} Workers`;
            const meter = $(`${prefix}-progress`);
            if (meter) {
              meter.hidden = false;
              const total = progress.totalAtoms ?? progress.total;
              const done = progress.completedAtoms ?? progress.completed;
              if (Number.isFinite(done) && total > 0) meter.value = Math.max(0, Math.min(1, done / total));
              else meter.removeAttribute('value');
            }
          },
        });
        if (!current()) return false;
        for (const field of TOPOLOGY_PROPERTIES[kind]) {
          if (!ArrayBuffer.isView(result[field.key]) || result[field.key].length !== frame.ids.length) {
            throw new Error(`The ${kind} output does not match the current atom population.`);
          }
        }
        cached = { key, result };
        frame.atomeyeResults ??= {}; frame.atomeyeResults[kind] = cached;
      }
      if (!current()) return false;
      job.controller = null;
      showResult(kind, cached.result, frame, key);
      if (!automatic && colorChoice === getColorChoiceVersion()) chooseProperty(DEFINITIONS[kind].property);
      return true;
    } catch (error) {
      if (!current() || error.name === 'AbortError') return false;
      job.controller = null; job.failed = true;
      clearAnalysisResults(frame, kind);
      if (frame.atomeyeResults) delete frame.atomeyeResults[kind];
      clearView(kind); state(kind, 'Failed', error.message);
      onResultsChange({ kind, frame, clearSettings: false });
      if (!automatic) notify(error.message);
      return false;
    } finally {
      if (job.controller === controller) job.controller = null;
      updateControls(kind);
    }
  }

  async function onFrame() {
    abortJobs();
    for (const kind of Object.keys(jobs)) {
      clearView(kind);
      jobs[kind].queued = jobs[kind].enabled;
      if (!jobs[kind].enabled) state(kind, 'Not calculated', DEFINITIONS[kind].help);
    }
    await Promise.all(Object.keys(jobs).filter(kind => jobs[kind].enabled).map(kind => run(kind, { automatic: true })));
  }

  function reset() {
    generation++;
    for (const kind of Object.keys(jobs)) {
      cancel(kind, { silent: true });
      jobs[kind].settings = { ...DEFINITIONS[kind].defaults };
      for (const [name, id] of Object.entries(DEFINITIONS[kind].fields)) if ($(id)) $(id).value = String(DEFINITIONS[kind].defaults[name]);
    }
    onResultsChange({ clearSettings: true });
  }

  function serialize() {
    return Object.fromEntries(Object.entries(DEFINITIONS).map(([kind, definition]) => [kind,
      { enabled: jobs[kind].enabled, ...Object.fromEntries(Object.entries(definition.defaults).map(([name, fallback]) => {
        if (name === 'selectedTypes') return [name, jobs[kind].settings.selectedTypes?.slice() ?? null];
        const input = $(definition.fields[name]);
        const value = input ? input.valueAsNumber : jobs[kind].settings[name];
        const valid = name.endsWith('Bins') || name === 'bins'
          ? Number.isInteger(value) && value >= 1 && value <= 4096
          : Number.isFinite(value) && value >= 0 && (name !== 'relativeFaceAreaThreshold' || value <= 1);
        return [name, valid ? value : jobs[kind].settings[name] ?? fallback];
      })) }]));
  }

  async function restore(saved, { isCurrent = () => true } = {}) {
    if (!saved || !isCurrent()) return;
    generation++; abortJobs();
    for (const [kind, definition] of Object.entries(DEFINITIONS)) {
      cancel(kind, { clearSettings: false, silent: true });
      const settings = saved[kind] ?? { enabled: false, ...definition.defaults };
      jobs[kind].settings = Object.fromEntries(Object.entries(definition.defaults).map(([name, fallback]) => [name, settings[name] ?? fallback]));
      for (const [name, id] of Object.entries(definition.fields)) if ($(id)) $(id).value = String(settings[name] ?? definition.defaults[name]);
      jobs[kind].enabled = Boolean(settings.enabled); jobs[kind].queued = jobs[kind].enabled; syncTool(kind);
    }
    onResultsChange({ clearSettings: false });
    await Promise.all(Object.keys(jobs).filter(kind => jobs[kind].enabled && isCurrent()).map(kind => run(kind, { automatic: true, isCurrent })));
  }

  function refreshBondParameters() {
    return jobs.bondStatistics.enabled ? run('bondStatistics', { automatic: true }) : Promise.resolve(false);
  }

  for (const [id, selection] of [['voronoi-select-all-types', null], ['voronoi-clear-types', []]]) {
    $(id)?.addEventListener('click', () => {
      jobs.voronoi.settings.selectedTypes = selection?.slice() ?? null;
      onEdit(); updateTypeControls();
      if (jobs.voronoi.enabled) void run('voronoi', { automatic: true });
    });
  }

  for (const [kind, definition] of Object.entries(DEFINITIONS)) {
    const { prefix } = definition;
    $(`run-${prefix}`)?.addEventListener('click', () => { void run(kind); });
    $(`cancel-${prefix}`)?.addEventListener('click', () => { onEdit(); cancel(kind); });
    for (const id of Object.values(definition.fields)) $(id)?.addEventListener('change', () => {
      onEdit();
      if (jobs[kind].enabled) void run(kind, { automatic: true });
    });
    state(kind, 'Not calculated', definition.help);
  }

  return Object.freeze({ run, onFrame, reset, abortJobs, cancel, serialize, restore, refreshBondParameters,
    syncBondEnabled: () => syncTool('bondStatistics'),
    isEnabled: kind => Boolean(jobs[kind]?.enabled),
    setEnabled(value) { controlsEnabled = Boolean(value); for (const kind of Object.keys(jobs)) updateControls(kind); },
    getResult: kind => jobs[kind]?.result ?? null,
    getPropertyKind: name => Object.keys(TOPOLOGY_PROPERTIES).find(kind => jobs[kind].enabled && !jobs[kind].failed
      && TOPOLOGY_PROPERTIES[kind].some(field => field.name === name)) ?? null,
    pendingKinds: () => Object.keys(jobs).filter(kind => jobs[kind].enabled && !jobs[kind].failed && (jobs[kind].controller || jobs[kind].queued)),
    pendingColorProperties: () => Object.keys(jobs).filter(kind => jobs[kind].enabled && !jobs[kind].failed)
      .flatMap(kind => TOPOLOGY_PROPERTIES[kind].map(field => ({ name: field.name, label: field.label }))),
    failed: () => Object.keys(jobs).filter(kind => jobs[kind].failed),
  });
}
