import { DxaClient } from './analysis/dxa-client.js';
import { DXA_DEFAULTS, DXA_FAMILIES, validateDxaParameters } from './analysis/dxa.js';

const $ = id => document.getElementById(id);
const PARAMETER_FIELDS = {
  lattice: 'dxa-lattice', trialCircuitLength: 'dxa-trial-length',
  circuitStretchability: 'dxa-stretchability', lineSmoothingIterations: 'dxa-smoothing',
  linePointInterval: 'dxa-point-interval', onlyPerfectDislocations: 'dxa-perfect-only',
};
const toHex = color => `#${Array.from(color, value => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
const duration = ms => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
const integer = value => Number(value).toLocaleString('en-US');

/** DXA owns one whole-frame Worker job and a line network, separately from
 * per-atom color analyses. Frame edits invalidate in-flight Worker replies. */
export function initializeDxaTools({ renderer, tools, getFrame, getSourceVersion,
  getGpuEnabled = () => false, onEdit = () => {}, onDisplayChange = () => {},
  onMemoryChange = () => {}, notify = () => {}, client = new DxaClient() }) {
  let enabled = false, controlsEnabled = false, controller = null, request = 0;
  let network = null, failure = false, radius = 0.25;
  let visibleFamilies = new Set(), familyColors = new Map(), cachedResult = null;

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

  function clearNetwork() {
    network = null;
    $('dxa-results').hidden = true;
    $('dxa-summary').textContent = '';
    $('dxa-status').title = '';
    draw();
    onMemoryChange();
  }

  function abortJobs() {
    request++;
    controller?.abort();
    controller = null;
    updateControls();
  }

  function cancel() {
    abortJobs(); enabled = false; failure = false;
    // Stop the job and clear its display while retaining reusable backend memory.
    void client.release?.();
    cachedResult = null;
    tools.setToolEnabled('dxa', false);
    clearNetwork(); state('Not calculated');
    $('dxa-status').textContent = 'Extract lines and Burgers vectors from the complete structure.';
  }

  function showResult(result) {
    network = result; failure = false;
    $('dxa-results').hidden = false;
    state('Calculated', true);
    const count = result.segments?.length ?? 0;
    const length = Number(result.totalLength ?? 0), density = Number(result.density ?? 0);
    $('dxa-summary').textContent = `${integer(count)} segments · ${length.toPrecision(5)} Å total length · ${density.toExponential(3)} Å⁻² density`;
    $('dxa-status').textContent = `${result.engine ?? 'CPU / Wasm'} · ${duration(result.elapsedMs ?? 0)}${result.gpuFallback ? ' · CPU fallback' : ''}`;
    $('dxa-status').title = [...(result.stageFallbacks?.length
      ? result.stageFallbacks.map(entry => `${entry.stage} CPU fallback: ${entry.reason}`)
      : [result.fallbackReason ?? result.gpuFallbackReason]),
      ...(result.stageTimings ?? []).map(stage => `${stage.phase}: ${duration(stage.elapsedMs)}`),
      ...(result.gpuStages?.length ? [`GPU stages: ${result.gpuStages.join(', ')}`] : []),
    ].filter(Boolean).join('\n');
    renderFamilies(); draw(); onMemoryChange();
  }

  async function run({ automatic = false } = {}) {
    const frame = getFrame();
    if (!frame) return false;
    let settings;
    try { settings = parameters(); }
    catch (error) {
      abortJobs(); failure = true; clearNetwork(); state('Failed');
      $('dxa-status').textContent = error.message;
      if (!automatic) notify(error.message);
      return false;
    }
    if (!automatic) onEdit();
    abortJobs(); enabled = true; failure = false;
    tools.setToolEnabled('dxa', true);
    clearNetwork();
    const serial = request, sourceVersion = getSourceVersion();
    const current = () => serial === request && frame === getFrame() && sourceVersion === getSourceVersion() && enabled;
    const gpuEnabled = Boolean(getGpuEnabled());
    const key = JSON.stringify({ ...settings, gpuEnabled }), cached = cachedResult;
    if (cached?.frame === frame && cached.key === key) { showResult(cached.result); return true; }
    // Global line graphs can be large. Keep only the latest frame/result,
    // rather than adding unaccounted graph arrays to the trajectory cache.
    cachedResult = null;
    const job = new AbortController(); controller = job;
    state('Calculating…');
    $('dxa-status').textContent = `Preparing ${gpuEnabled ? 'GPU-accelerated' : 'CPU'} DXA for ${integer(frame.ids.length)} atoms…`;
    try {
      const result = await client.analyze(frame, { ...settings, gpuEnabled }, {
        signal: job.signal,
        onProgress: progress => {
          if (!current() || job.signal.aborted) return;
          const stage = String(progress.phase ?? 'Analyzing').replace(/[-_]/g, ' ');
          const done = progress.completedStages ?? 0, total = progress.totalStages ?? 12;
          const backend = progress.backend === 'gpu' ? 'GPU' : progress.backend === 'hybrid' ? 'CPU + GPU' : 'CPU';
          const threads = backend === 'CPU' && progress.workerCount > 1 ? ` · ${progress.workerCount} threads` : '';
          const completion = Number.isFinite(progress.totalTetrahedra) && progress.totalTetrahedra > 0
            ? `${integer(progress.completedTetrahedra ?? 0)} / ${integer(progress.totalTetrahedra)} tetrahedra`
            : progress.backend === 'gpu' && String(progress.phase).startsWith('dxa-local') && progress.totalAtoms > 0
              ? `${integer(progress.processedAtoms ?? progress.completedAtoms ?? 0)} / ${integer(progress.totalAtoms)} atoms`
            : `${done} / ${total} stages`;
          $('dxa-status').textContent = `${stage} · ${backend}${threads} · ${completion}`;
        },
      });
      if (!current() || job.signal.aborted) return false;
      cachedResult = { frame, key, result };
      controller = null; showResult(result); return true;
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
    return { enabled, ...parameters(), radius,
      visibleFamilies: [...visibleFamilies], familyColors: [...familyColors].map(([family, color]) => ({ family, color })) };
  }

  async function restore(saved, { isCurrent = () => true } = {}) {
    if (!saved || !isCurrent()) return;
    cancel(); writeParameters(saved); radius = saved.radius;
    $('dxa-line-radius').value = String(radius);
    resetFamilies();
    visibleFamilies = new Set(saved.visibleFamilies);
    familyColors = new Map(saved.familyColors.map(({ family, color }) => [family, color]));
    renderFamilies();
    if (saved.enabled && getFrame() && isCurrent()) await run({ automatic: true });
  }

  function reset() {
    cancel(); writeParameters(DXA_DEFAULTS); radius = 0.25;
    $('dxa-line-radius').value = String(radius); resetFamilies(); renderFamilies();
  }

  $('run-dxa').addEventListener('click', () => { void run(); });
  $('cancel-dxa').addEventListener('click', () => { onEdit(); cancel(); });
  for (const id of Object.values(PARAMETER_FIELDS)) $(id).addEventListener('change', () => {
    onEdit();
    if (id === 'dxa-lattice') { resetFamilies(); renderFamilies(); }
    if (enabled) void run({ automatic: true });
  });
  $('dxa-line-radius').addEventListener('change', () => {
    const value = $('dxa-line-radius').valueAsNumber;
    if (!Number.isFinite(value) || value <= 0) { $('dxa-line-radius').value = String(radius); notify('Enter a positive line radius.'); return; }
    onEdit(); radius = value; draw();
  });
  reset();
  return Object.freeze({ run, onFrame, cancel, abortJobs, reset, serialize, restore,
    setEnabled(value) { controlsEnabled = Boolean(value); updateControls(); },
    failed: () => enabled && failure,
  });
}
