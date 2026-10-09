import { MAX_TIME_SERIES, TIME_SERIES_DEFAULTS, TimeSeriesStore, collectFileSeries, normalizeTimeSeriesState, recordRegistry,
  seriesAxis, seriesFrames, timeSeriesTable } from './time-series.js';
import { renderTimeSeriesChart } from './render/time-series-chart.js';
import { serializeCsv } from './statistics-export.js';
import { downloadBlob } from './export-archive.js';
import { yieldToMain } from './task-yield.js';

const integer = value => Number(value).toLocaleString('en-US');
const HELP = 'File values (cell, strain, timestep, file columns) are read in the background. Analysis values are recorded when their analysis finishes on the displayed frame.';
const ANALYSIS_GROUPS = new Set(['CNA', 'PTM', 'DXA', 'Clusters', 'WignerSeitz', 'Symmetry', 'IdealStrain']);
const CONTROL_IDS = ['time-series-attribute', 'add-time-series-attribute', 'time-series-first', 'time-series-last', 'time-series-stride',
  'time-series-x-axis', 'time-series-separate', 'time-series-strain-reference', 'collect-time-series', 'visit-time-series',
  'export-time-series', 'clear-time-series'];

/** Time series of global attributes. File-derived attributes are computed
 * from frames read in the background; the displayed frame does not change.
 * Analysis-dependent attributes are recorded from the displayed frame each
 * time its attributes change (frame visits, playback, frame-image export, a
 * finished analysis). Visit frames steps the main view through the frames
 * still missing such values and returns to the original frame. */
export function initializeTimeSeries({ tools, attributes, getFrame, getFrameAt = async () => null, getFrameIndex = () => 0,
  getFrameCount = () => 1, ensureIndexed = async () => {}, getSourceVersion = () => 0, getFileName = () => 'structure',
  showFrame = async () => false, stopPlayback = () => {}, onEdit = () => {}, notify = () => {}, onDownload = downloadBlob,
  documentRoot = globalThis.document, now = () => performance.now() } = {}) {
  const $ = id => documentRoot?.getElementById(id) ?? null;
  const store = new TimeSeriesStore();
  let settings = normalizeTimeSeriesState({}), controlsEnabled = false, source = null, job = null, drawn = -1, drawTimer = null;
  let collected = false;
  // A series keeps its color while others are added or removed.
  const slots = new Map();

  function slotOf(name) {
    for (const key of slots.keys()) if (!settings.attributes.includes(key)) slots.delete(key);
    if (!slots.has(name)) {
      const used = new Set(slots.values());
      slots.set(name, Array.from({ length: MAX_TIME_SERIES }, (_, index) => index + 1).find(slot => !used.has(slot)) ?? 1);
    }
    return slots.get(name);
  }

  function syncSource() {
    const version = String(getSourceVersion());
    if (source !== version) { source = version; store.clear(); drawn = -1; }
  }

  function frames() { return seriesFrames(settings, Math.max(1, getFrameCount())); }

  // Before a frame provides an attribute, its group tells where it comes from.
  function kindOf(name) {
    return attributes.current()?.describe(name)?.kind ?? store.describe(name)?.kind
      ?? (ANALYSIS_GROUPS.has(name.split('.')[0]) ? 'analysis' : 'file');
  }

  function state(label, text) {
    if ($('time-series-state')) { $('time-series-state').textContent = label; $('time-series-state').classList.toggle('ready', label === 'Complete'); }
    if (text !== undefined && $('time-series-status')) $('time-series-status').textContent = text;
  }

  function updateControls() {
    const available = controlsEnabled && Boolean(getFrame());
    for (const id of CONTROL_IDS) if ($(id)) $(id).disabled = !available;
    if ($('add-time-series-attribute')) $('add-time-series-attribute').disabled = !available || settings.attributes.length >= MAX_TIME_SERIES;
    for (const id of ['collect-time-series', 'visit-time-series', 'clear-time-series', 'time-series-first', 'time-series-last', 'time-series-stride']) {
      if ($(id)) $(id).disabled ||= Boolean(job);
    }
    if ($('cancel-time-series')) $('cancel-time-series').disabled = !job;
    if ($('export-time-series')) $('export-time-series').disabled ||= !settings.attributes.length;
    if ($('visit-time-series')) $('visit-time-series').disabled ||= !settings.attributes.some(name => kindOf(name) === 'analysis');
    if ($('time-series-strain-reference')) $('time-series-strain-reference').max = String(Math.max(1, getFrameCount()));
  }

  function renderAttributeList() {
    const list = $('time-series-attribute-list');
    if (list) {
      list.replaceChildren(...settings.attributes.map(name => {
        const item = documentRoot.createElement('li'), key = documentRoot.createElement('span'), label = documentRoot.createElement('span');
        const kind = documentRoot.createElement('span'), remove = documentRoot.createElement('button');
        key.className = `series-key series-${slotOf(name)}`; label.textContent = name; label.className = 'time-series-name';
        const descriptor = attributes.current()?.describe(name);
        kind.className = 'time-series-kind'; kind.textContent = !descriptor && !store.describe(name) ? 'not in this frame' : kindOf(name) === 'analysis' ? 'analysis' : 'file';
        kind.title = kindOf(name) === 'analysis' ? 'Recorded when its analysis finishes on the displayed frame.' : 'Read from frames in the background.';
        remove.type = 'button'; remove.className = 'text-button'; remove.textContent = 'Remove'; remove.disabled = !controlsEnabled;
        remove.setAttribute('aria-label', `Remove ${name} from the time series`);
        remove.addEventListener('click', () => { onEdit(); settings.attributes = settings.attributes.filter(item => item !== name); changed(); });
        item.append(key, label, kind, remove); return item;
      }));
    }
    const options = $('time-series-attribute-options');
    const registry = attributes.current();
    if (options && registry) {
      const names = registry.list().map(entry => entry.name);
      const signature = names.join('\n');
      if (options.dataset.signature !== signature) {
        options.replaceChildren(...names.map(name => { const option = documentRoot.createElement('option'); option.value = name; return option; }));
        options.dataset.signature = signature;
      }
    }
  }

  function chartData() {
    const indices = frames(), axis = seriesAxis(store, indices, settings.xAxis);
    return { frames: indices, axis, series: settings.attributes.map(name => ({ name, unit: store.describe(name)?.unit ?? attributes.current()?.describe(name)?.unit ?? '',
      slot: slotOf(name), values: indices.map(frame => store.value(name, frame)) })) };
  }

  function summary(data = chartData()) {
    if (!settings.attributes.length) return 'Add an attribute to plot it against the frame number or timestep.';
    const total = data.frames.length;
    const missing = data.series.map(item => ({ name: item.name, count: item.values.reduce((sum, value) => sum + Number(!Number.isFinite(value)), 0) }))
      .filter(item => item.count);
    if (!missing.length) return `${integer(total)} frames · every value collected.`;
    const parts = missing.map(item => `${item.name} (${integer(item.count)} missing${kindOf(item.name) === 'analysis' ? ', analysis' : ''})`);
    const advice = missing.some(item => kindOf(item.name) === 'analysis')
      ? ' Analysis values appear as frames are displayed with the analysis enabled; Visit frames fills the rest.' : ' Read file values to fill them.';
    return `${integer(total)} frames · ${parts.join(', ')}.${advice}`;
  }

  function draw({ force = false } = {}) {
    clearTimeout(drawTimer); drawTimer = null;
    if (!force && drawn === store.revision) return;
    drawn = store.revision;
    const data = chartData();
    renderTimeSeriesChart($('time-series-chart'), data, { separatePanels: settings.separatePanels });
    if ($('time-series-results')) $('time-series-results').hidden = !settings.attributes.length;
    if (!job) {
      const complete = data.series.length && data.series.every(item => item.values.every(Number.isFinite));
      state(!data.series.some(item => item.values.some(Number.isFinite)) ? 'Not collected' : complete ? 'Complete' : 'Partial', summary(data));
    }
  }

  // Redraws during a collection are throttled to keep frame reading fast.
  function scheduleDraw() { if (!drawTimer) drawTimer = setTimeout(() => draw(), 200); }

  function changed() {
    syncSource(); renderAttributeList(); updateControls();
    record(attributes.current());
    draw({ force: true });
    tools?.setToolEnabled('timeSeries', settings.attributes.length > 0 && collected);
  }

  function record(registry) {
    syncSource();
    if (!registry || !settings.attributes.length || registry.frame !== getFrame()) return false;
    if (settings.attributes.some(name => /^strain\./i.test(name) && !registry.has(name))) attributes.requestReference();
    return recordRegistry(store, registry, getFrameIndex(), settings.attributes);
  }

  function readRange() {
    const read = (id, fallback) => { const value = $(id)?.valueAsNumber ?? Number($(id)?.value); return Number.isFinite(value) ? value : fallback; };
    const count = Math.max(1, getFrameCount());
    const first = read('time-series-first', settings.firstFrame + 1), last = read('time-series-last', (settings.lastFrame ?? count - 1) + 1);
    const stride = read('time-series-stride', settings.stride);
    if (![first, last, stride].every(Number.isInteger) || first < 1 || last < first || stride < 1) throw new Error('Choose a valid frame range and integer step.');
    settings.firstFrame = first - 1; settings.stride = stride;
    settings.lastFrame = last >= count ? null : last - 1;
  }

  function writeRange() {
    const count = Math.max(1, getFrameCount());
    // A value being typed is not replaced while frames load.
    const write = (id, value) => { const input = $(id); if (input && documentRoot.activeElement !== input) input.value = value; };
    write('time-series-first', String(settings.firstFrame + 1));
    write('time-series-last', String(Math.min(count, (settings.lastFrame ?? count - 1) + 1)));
    write('time-series-stride', String(settings.stride));
    for (const id of ['time-series-first', 'time-series-last']) if ($(id)) $(id).max = String(count);
    if ($('time-series-x-axis')) $('time-series-x-axis').value = settings.xAxis;
    if ($('time-series-separate')) $('time-series-separate').checked = settings.separatePanels;
    if ($('time-series-strain-reference') && documentRoot.activeElement !== $('time-series-strain-reference')) {
      $('time-series-strain-reference').value = String(attributes.getStrainReferenceFrame() + 1);
    }
  }

  function startJob(kind) {
    const controller = new AbortController();
    job = { kind, controller, source: String(getSourceVersion()) };
    updateControls();
    if ($('time-series-progress')) { $('time-series-progress').hidden = false; $('time-series-progress').value = 0; }
    return job;
  }

  function finishJob(task) {
    if (job !== task) return;
    job = null;
    if ($('time-series-progress')) $('time-series-progress').hidden = true;
    updateControls(); draw({ force: true });
  }

  /** Read file-derived values in the background. */
  async function collect({ automatic = false } = {}) {
    if (!getFrame() || job) return false;
    try { readRange(); } catch (error) { if (!automatic) notify(error.message); return false; }
    if (!automatic) onEdit();
    collected = true; tools?.setToolEnabled('timeSeries', settings.attributes.length > 0);
    const task = startJob('collect'), started = now();
    const current = () => job === task && !task.controller.signal.aborted && task.source === String(getSourceVersion());
    state('Reading…', 'Preparing the trajectory index…');
    try {
      await ensureIndexed({ signal: task.controller.signal });
      if (!current()) return false;
      syncSource();
      const names = settings.attributes.filter(name => kindOf(name) === 'file');
      if (names.some(name => name.startsWith('Strain.'))) await attributes.ensureReference({ signal: task.controller.signal });
      if (!current()) return false;
      const result = await collectFileSeries({ store, frames: frames(), names, signal: task.controller.signal,
        readFrame: (index, options) => getFrameAt(index, options),
        attributesFor: (frame, index) => attributes.forFrame(frame, index),
        onProgress: ({ done, total }) => {
          if (!current()) return;
          if ($('time-series-progress')) $('time-series-progress').value = total ? done / total : 1;
          state('Reading…', `Reading frame ${integer(done)} of ${integer(total)} in the background…`);
          scheduleDraw();
        },
        yieldEvery: yieldToMain });
      if (!current()) return false;
      record(attributes.current());
      finishJob(task);
      if ($('time-series-status')) $('time-series-status').textContent = `${summary()} Read ${integer(result.read)} frames in ${((now() - started) / 1000).toFixed(2)} s.`;
      return true;
    } catch (error) {
      if (error.name !== 'AbortError' && job === task) { notify(error.message); state('Failed', error.message); }
      return false;
    } finally {
      finishJob(task);
    }
  }

  /** Display each frame that lacks an analysis value, then return. */
  async function visit() {
    if (!getFrame() || job) return false;
    try { readRange(); } catch (error) { notify(error.message); return false; }
    onEdit(); stopPlayback();
    collected = true; tools?.setToolEnabled('timeSeries', settings.attributes.length > 0);
    const task = startJob('visit'), original = getFrameIndex();
    const current = () => job === task && !task.controller.signal.aborted && task.source === String(getSourceVersion());
    let interrupted = false, visited = 0;
    try {
      await ensureIndexed({ signal: task.controller.signal });
      if (!current()) return false;
      const names = settings.attributes.filter(name => kindOf(name) === 'analysis');
      const pending = frames().filter(index => names.some(name => !store.has(name, index)));
      for (const index of pending) {
        if (!current()) return false;
        state('Visiting…', `Displaying frame ${integer(index + 1)} · ${integer(visited)} of ${integer(pending.length)} visited`);
        if (!await showFrame(index) || getFrameIndex() !== index) { interrupted = current(); break; }
        if (!current()) return false;
        record(attributes.current());
        visited++;
        if ($('time-series-progress')) $('time-series-progress').value = visited / pending.length;
        scheduleDraw();
        await yieldToMain();
      }
      return !interrupted;
    } catch (error) {
      if (error.name !== 'AbortError' && job === task) notify(error.message);
      return false;
    } finally {
      const restore = task.source === String(getSourceVersion()) && !interrupted;
      finishJob(task);
      if (restore && getFrameIndex() !== original) await showFrame(original);
      if ($('time-series-status')) $('time-series-status').textContent = interrupted ? `Stopped after ${integer(visited)} frames: the displayed frame changed. ${summary()}`
        : `${summary()} Visited ${integer(visited)} frames.`;
    }
  }

  function cancel() {
    if (!job) return false;
    job.controller.abort(); const task = job; finishJob(task);
    state('Cancelled', `Stopped. ${summary()}`);
    return true;
  }

  function addAttribute() {
    const input = $('time-series-attribute'), name = input?.value.trim() ?? '';
    if (!name) return;
    if (settings.attributes.length >= MAX_TIME_SERIES) { notify(`Plot up to ${MAX_TIME_SERIES} attributes.`); return; }
    const registry = attributes.current(), canonical = registry?.describe(name)?.name ?? name;
    if (name.length > 256) { notify('Attribute names are limited to 256 characters.'); return; }
    if (settings.attributes.includes(canonical)) { notify(`${canonical} is already plotted.`); return; }
    if (!registry?.describe(name)) notify(`${name} is not available in this frame; it is plotted if other frames provide it.`);
    onEdit();
    settings.attributes.push(canonical); input.value = '';
    changed();
  }

  attributes.subscribe(registry => {
    if (record(registry)) scheduleDraw();
    renderAttributeList(); writeRange(); updateControls();
  });
  $('add-time-series-attribute')?.addEventListener('click', addAttribute);
  $('time-series-attribute')?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addAttribute(); } });
  for (const id of ['time-series-first', 'time-series-last', 'time-series-stride']) $(id)?.addEventListener('change', () => {
    try { readRange(); onEdit(); draw({ force: true }); } catch (error) { notify(error.message); writeRange(); }
  });
  $('time-series-x-axis')?.addEventListener('change', () => { onEdit(); settings.xAxis = $('time-series-x-axis').value === 'timestep' ? 'timestep' : 'frame'; draw({ force: true }); });
  $('time-series-separate')?.addEventListener('change', () => { onEdit(); settings.separatePanels = $('time-series-separate').checked; draw({ force: true }); });
  $('time-series-strain-reference')?.addEventListener('change', () => {
    const value = $('time-series-strain-reference').valueAsNumber;
    if (!Number.isInteger(value) || value < 1 || value > Math.max(1, getFrameCount())) {
      notify(`Choose a reference frame from 1 to ${Math.max(1, getFrameCount())}.`); writeRange(); return;
    }
    onEdit(); attributes.setStrainReferenceFrame(value - 1);
  });
  $('collect-time-series')?.addEventListener('click', () => { void collect(); });
  $('visit-time-series')?.addEventListener('click', () => { void visit(); });
  $('cancel-time-series')?.addEventListener('click', () => { cancel(); });
  $('clear-time-series')?.addEventListener('click', () => { onEdit(); store.clear(); record(attributes.current()); draw({ force: true }); });
  $('export-time-series')?.addEventListener('click', () => { void exportCsv(); });
  state('Not collected', HELP);

  async function exportCsv() {
    if (!settings.attributes.length) return null;
    const table = timeSeriesTable(store, settings.attributes, frames(), { fileName: getFileName() });
    const blob = new Blob([serializeCsv(table)], { type: 'text/csv' });
    await onDownload(blob, table.filename);
    return table;
  }

  return Object.freeze({
    collect, visit, cancel, exportCsv,
    refresh: () => { renderAttributeList(); writeRange(); updateControls(); },
    setEnabled(value) { controlsEnabled = Boolean(value); syncSource(); writeRange(); renderAttributeList(); updateControls(); draw({ force: true }); },
    /** Drop collected values and stop work, keeping the settings. */
    reset() { if (job) { job.controller.abort(); finishJob(job); } store.clear(); collected = false; tools?.setToolEnabled('timeSeries', false); draw({ force: true }); },
    isRunning: () => Boolean(job),
    hasSeries: () => settings.attributes.length > 0 && collected,
    getData: chartData,
    store,
    serialize: () => ({ ...settings, attributes: [...settings.attributes], autoCollect: collected }),
    async restore(saved, { isCurrent = () => true } = {}) {
      if (job) { job.controller.abort(); finishJob(job); }
      settings = normalizeTimeSeriesState(saved ?? { attributes: [...TIME_SERIES_DEFAULTS.attributes] });
      collected = false; store.clear();
      writeRange(); changed();
      if (saved?.autoCollect && getFrame() && isCurrent()) return collect({ automatic: true });
      return false;
    },
  });
}
