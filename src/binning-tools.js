import { SpatialBinningClient } from './binning-client.js';
import { BINNING_AXES, BINNING_REDUCTIONS, finalizeSpatialBins, mergeSpatialBins, normalizeBinningLayout } from './analysis/spatial-binning.js';
import { renderBinningChart } from './render/binning-chart.js';
import { BUILTIN_SCALAR_COLOR_MODES, ColorQuantityResolver, initialColorQuantities } from './render/color-quantities.js';
import { SCALAR_COLOR_SCHEMES } from './render/palette.js';
import { atomIdSet, hasAtomId } from './data/atom-ids.js';

export const BINNING_DEFAULTS = Object.freeze({ mode: '1d', axes: Object.freeze(['a', 'b']), bins: Object.freeze([50, 50]),
  quantity: 'density', property: null, reduction: 'mean', selectionGroupId: null, averageFrames: false, colorScheme: 'viridis' });
export const BINNING_REDUCTION_LABELS = Object.freeze({ mean: 'Mean', sum: 'Sum', min: 'Minimum', max: 'Maximum', stddev: 'Standard deviation' });
const CSV_REDUCTIONS = { mean: 'mean', sum: 'sum', min: 'minimum', max: 'maximum', stddev: 'population_stddev' };
const HELP = 'Bins the complete analyzed frame, including atoms hidden in the display.';
const CONTROL_IDS = ['binning-mode', 'binning-axis-1', 'binning-bins-1', 'binning-axis-2', 'binning-bins-2', 'binning-quantity',
  'binning-reduction', 'binning-selection', 'binning-average-frames', 'binning-color-scheme'];

const integer = value => Number(value).toLocaleString('en-US');
const format = (value, digits = 4) => Number.isFinite(value) ? value.toLocaleString('en-US', { maximumSignificantDigits: digits }) : '—';
const plural = (count, word) => `${integer(count)} ${word}${count === 1 ? '' : 's'}`;

/** Scalar quantities offered for binning: positions, speed and every
 * non-categorical property, keyed exactly as in Color by. */
export function binningQuantityOptions(frame) {
  if (!frame) return [];
  const categorical = new Set(frame.properties.filter(property => property.categories?.length).map(property => `property:${property.name}`));
  const seen = new Set();
  return initialColorQuantities(frame).filter(({ value }) => {
    if (categorical.has(value) || seen.has(value)
        || (value.startsWith('builtin:') && !BUILTIN_SCALAR_COLOR_MODES.includes(value))) return false;
    seen.add(value); return true;
  });
}

/** Spatial profiles and maps of a per-atom quantity. Single-frame results
 * follow the displayed frame; a trajectory average is independent of it and
 * is kept until the source, settings or selection change. */
export function initializeBinningTools({ tools, getFrame, getFrameAt = async () => null, getFrameCount = () => 1,
  ensureIndexed = async () => {}, getSourceVersion = () => 0, getFrameIndex = () => 0, getSelectionGroups = () => [],
  onEdit = () => {}, onResultsChange = () => {}, notify = () => {}, client = new SpatialBinningClient(),
  renderChart = renderBinningChart, now = () => performance.now() } = {}) {
  const $ = id => globalThis.document?.getElementById(id) ?? null;
  const job = { enabled: false, failed: false, controller: null, serial: 0, result: null, exported: null, signature: null,
    average: null, averaging: null, settings: { ...BINNING_DEFAULTS, axes: [...BINNING_DEFAULTS.axes], bins: [...BINNING_DEFAULTS.bins] } };
  const resolver = new ColorQuantityResolver();
  const memberSets = new WeakMap(), memberSerials = new WeakMap();
  let controlsEnabled = false, generation = 0, nextMemberSerial = 1, warmed = false;

  function state(label, text = '') {
    if ($('binning-state')) {
      $('binning-state').textContent = label;
      $('binning-state').classList.toggle('ready', label === 'Calculated');
    }
    if (text && $('binning-status')) $('binning-status').textContent = text;
    updateControls();
  }

  function syncTool({ reveal = false } = {}) { tools?.setToolEnabled('binning', job.enabled, { reveal }); }

  function currentSettings() {
    const read = (id, fallback) => $(id) ? $(id).value : fallback;
    const bins = index => {
      const input = $(`binning-bins-${index + 1}`);
      if (!input) return job.settings.bins[index];
      const value = input.value === '' ? NaN : input.valueAsNumber ?? Number(input.value);
      return Number.isFinite(value) ? value : NaN;
    };
    const quantityValue = $('binning-quantity')?.value || (job.settings.quantity === 'property' ? job.settings.property : job.settings.quantity);
    const quantity = quantityValue === 'count' || quantityValue === 'density' ? quantityValue : 'property';
    return { mode: read('binning-mode', job.settings.mode) === '2d' ? '2d' : '1d',
      axes: [read('binning-axis-1', job.settings.axes[0]), read('binning-axis-2', job.settings.axes[1])],
      bins: [bins(0), bins(1)], quantity, property: quantity === 'property' ? quantityValue || null : job.settings.property,
      reduction: read('binning-reduction', job.settings.reduction),
      selectionGroupId: ($('binning-selection') ? $('binning-selection').value : job.settings.selectionGroupId ?? '') || null,
      averageFrames: $('binning-average-frames') ? Boolean($('binning-average-frames').checked) : job.settings.averageFrames,
      colorScheme: read('binning-color-scheme', job.settings.colorScheme) };
  }

  function updateControls() {
    const available = controlsEnabled && Boolean(getFrame());
    const settings = currentSettings();
    for (const id of CONTROL_IDS) if ($(id)) $(id).disabled = !available;
    if ($('binning-second-axis')) $('binning-second-axis').hidden = settings.mode !== '2d';
    if ($('binning-reduction-field')) $('binning-reduction-field').hidden = settings.quantity !== 'property';
    if ($('binning-scheme-field')) $('binning-scheme-field').hidden = settings.mode !== '2d';
    if ($('binning-average-field')) $('binning-average-field').hidden = !(getFrameCount() > 1);
    if ($('run-binning')) {
      $('run-binning').disabled = !available || Boolean(job.controller) || Boolean(job.averaging);
      $('run-binning').textContent = settings.mode === '2d' ? 'Calculate map' : 'Calculate profile';
    }
    if ($('cancel-binning')) $('cancel-binning').disabled = !available || (!job.enabled && !job.failed);
    if ($('export-binning')) $('export-binning').textContent = settings.mode === '2d' ? 'Map CSV' : 'Profile CSV';
  }

  function option(root, value, text) { const item = root.createElement('option'); item.value = value; item.textContent = text; return item; }

  function updateQuantityOptions() {
    const select = $('binning-quantity');
    if (!select) return;
    const root = select.ownerDocument ?? globalThis.document;
    const chosen = job.settings.quantity === 'property' ? job.settings.property : job.settings.quantity;
    const entries = [['count', 'Atom count'], ['density', 'Number density [Å⁻³]'],
      ...binningQuantityOptions(getFrame()).map(({ value, label }) => [value, label])];
    // A saved quantity stays selected while a frame or analysis provides it.
    if (chosen && !entries.some(([value]) => value === chosen)) {
      entries.push([chosen, `${chosen.replace(/^property:/, '').replace(/^builtin:position:/, 'Position ')} (waiting for data…)`]);
    }
    // Rebuilding an unchanged list would close it while the user browses it.
    const signature = JSON.stringify(entries);
    if (select.dataset?.options !== signature) {
      select.replaceChildren(...entries.map(([value, text]) => option(root, value, text)));
      if (select.dataset) select.dataset.options = signature;
    }
    select.value = chosen ?? 'density';
  }

  function updateSelectionOptions() {
    const select = $('binning-selection');
    if (!select) return;
    const root = select.ownerDocument ?? globalThis.document;
    const groups = getSelectionGroups() ?? [], chosen = job.settings.selectionGroupId;
    const entries = [['', 'All atoms'], ...groups.map(group => [group.id, `${group.name} · ${integer(group.atomIds.length)} IDs`])];
    if (chosen !== null && !groups.some(group => group.id === chosen)) entries.push([chosen, `Missing group (${chosen})`]);
    const signature = JSON.stringify(entries);
    if (select.dataset?.options !== signature) {
      select.replaceChildren(...entries.map(([value, text]) => option(root, value, text)));
      if (select.dataset) select.dataset.options = signature;
    }
    select.value = chosen ?? '';
  }

  function updateSchemeOptions() {
    const select = $('binning-color-scheme');
    if (!select || select.options?.length) return;
    const root = select.ownerDocument ?? globalThis.document;
    select.replaceChildren(...SCALAR_COLOR_SCHEMES.map(({ value, label }) => option(root, value, label)));
    select.value = job.settings.colorScheme;
  }

  /** Validated settings; the request contains only what the kernel needs. */
  function prepare(settings = currentSettings()) {
    const dimensions = settings.mode === '2d' ? 2 : 1;
    const layout = normalizeBinningLayout({ axes: settings.axes.slice(0, dimensions), bins: settings.bins.slice(0, dimensions) });
    if (settings.quantity === 'property' && !settings.property) throw new Error('Choose a property to bin.');
    if (settings.quantity === 'property' && !BINNING_REDUCTIONS.includes(settings.reduction)) throw new Error('Choose how to reduce values in each bin.');
    const group = settings.selectionGroupId === null ? null : (getSelectionGroups() ?? []).find(item => item.id === settings.selectionGroupId);
    if (settings.selectionGroupId !== null && !group) throw new Error('The selected atom group no longer exists. Choose another group or All atoms.');
    if (!SCALAR_COLOR_SCHEMES.some(({ value }) => value === settings.colorScheme)) settings.colorScheme = BINNING_DEFAULTS.colorScheme;
    return { settings, layout, group,
      key: JSON.stringify({ axes: layout.axes, bins: layout.bins, quantity: settings.quantity,
        property: settings.quantity === 'property' ? settings.property : null,
        reduction: settings.quantity === 'property' ? settings.reduction : null,
        selection: group ? [group.id, memberSerial(group.atomIds)] : null }) };
  }

  function memberSerial(atomIds) {
    if (!memberSerials.has(atomIds)) memberSerials.set(atomIds, nextMemberSerial++);
    return memberSerials.get(atomIds);
  }

  function selectionMask(frame, group) {
    if (!group) return null;
    if (!memberSets.has(group.atomIds)) memberSets.set(group.atomIds, atomIdSet(group.atomIds));
    const members = memberSets.get(group.atomIds), mask = new Uint8Array(frame.ids.length);
    for (let atom = 0; atom < mask.length; atom++) if (hasAtomId(members, frame.ids[atom])) mask[atom] = 1;
    return mask;
  }

  /** The property for this frame, or null while it is not yet available. */
  function resolveProperty(frame, settings, quantityResolver = resolver) {
    if (settings.quantity !== 'property') return null;
    const property = quantityResolver.resolve(frame, settings.property, { coordinateMode: 'wrapped' });
    if (property?.categories?.length) throw new Error(`${property.displayName ?? property.name} is categorical; choose a numeric property.`);
    return property && property.data?.length === frame.ids.length ? property : null;
  }

  function describeQuantity(settings, property) {
    if (settings.quantity === 'count') return { valueLabel: 'Atom count', unit: '', csvName: 'count', zero: true };
    if (settings.quantity === 'density') return { valueLabel: 'Number density', unit: 'Å⁻³', csvName: 'number_density', zero: true };
    const label = property?.displayName ?? property?.name ?? settings.property;
    return { valueLabel: `${BINNING_REDUCTION_LABELS[settings.reduction]} ${label}`, unit: property?.unit ?? '',
      csvName: `${CSV_REDUCTIONS[settings.reduction]}(${property?.name?.replace(/^property:/, '') ?? settings.property})`,
      zero: settings.reduction === 'stddev' };
  }

  function request(layout, settings, values, mask) {
    return { axes: layout.axes, bins: layout.bins, values: settings.quantity === 'property' ? values : null, mask,
      stddev: settings.quantity === 'property' && settings.reduction === 'stddev' };
  }

  function abort() {
    job.serial++;
    job.controller?.abort();
    job.controller = null;
    if ($('binning-progress') && !job.averaging) $('binning-progress').hidden = true;
    updateControls();
  }

  function abortAverage() {
    job.averaging?.abort();
    job.averaging = null;
    if ($('binning-progress')) $('binning-progress').hidden = true;
  }

  function clearView() {
    job.result = null; job.exported = null;
    if ($('binning-results')) $('binning-results').hidden = true;
    if ($('binning-summary')) $('binning-summary').textContent = '';
    if ($('binning-geometry')) $('binning-geometry').textContent = '';
    if ($('binning-backend')) $('binning-backend').textContent = '—';
    $('binning-chart')?.replaceChildren();
    updateControls();
  }

  function cancel({ clearSettings = true, silent = false } = {}) {
    abort(); abortAverage();
    job.enabled = false; job.failed = false; job.signature = null; job.average = null;
    clearView(); syncTool();
    state('Not calculated', HELP);
    if (!silent) onResultsChange({ clearSettings });
    return true;
  }

  function fail(error, { automatic }) {
    job.failed = true;
    clearView(); state('Failed', error.message);
    if (!automatic) notify(error.message);
    onResultsChange({ clearSettings: false });
    return false;
  }

  function geometryText(result) {
    const axes = result.axes.map(axis => BINNING_AXES[axis]);
    const others = BINNING_AXES.filter((_, axis) => !result.axes.includes(axis));
    const parts = [];
    if (axes.length === 1) {
      const width = result.axisLengths[0] / result.bins[0], spacing = result.heights[0] / result.bins[0];
      // Only a tilt visible at the displayed precision is worth a remark.
      const tilted = Math.abs(result.heights[0] - result.axisLengths[0]) > 1e-4 * result.axisLengths[0];
      parts.push(`Each bin is a slab parallel to ${others.join(' and ')}, ${format(width)} Å wide along ${axes[0]} (|${axes[0]}| = ${format(result.axisLengths[0])} Å)`
        + (tilted ? `; because the cell is tilted, the perpendicular slab thickness is ${format(spacing)} Å.` : '.'));
    } else {
      parts.push(`Each bin is a column parallel to ${others[0]}, ${format(result.axisLengths[0] / result.bins[0])} × ${format(result.axisLengths[1] / result.bins[1])} Å along ${axes[0]} and ${axes[1]}.`);
      if (Math.abs(result.angle - 90) > 0.01) parts.push(`The map is drawn in reduced coordinates; ${axes[0]} and ${axes[1]} meet at ${format(result.angle)}°.`);
    }
    parts.push(`Bin volume ${format(result.binVolume)} Å³ (cell ${format(result.cellVolume)} Å³${result.frames > 1 ? ', averaged over frames' : ''}).`);
    result.axes.forEach((axis, index) => {
      if (!result.periodic[index]) parts.push(`${BINNING_AXES[axis]} is not periodic: bins span the cell from its origin to the opposite face.`);
    });
    return parts.join(' ');
  }

  function summaryText(result) {
    const totals = result.totals, frames = result.frames;
    const perFrame = value => frames > 1 ? format(value / frames, 6) : integer(value);
    const parts = [result.bins.length === 1 ? `${integer(result.bins[0])} bins along ${BINNING_AXES[result.axes[0]]}`
      : `${integer(result.bins[0])} × ${integer(result.bins[1])} bins along ${BINNING_AXES[result.axes[0]]} and ${BINNING_AXES[result.axes[1]]}`];
    parts.push(`${perFrame(totals.binned)} atoms binned${frames > 1 ? ' per frame' : ''}`);
    if (totals.excluded) parts.push(`${perFrame(totals.excluded)} outside ${result.selectionName ?? 'the selection'}`);
    if (totals.outside) parts.push(`${perFrame(totals.outside)} beyond open cell faces, not counted`);
    if (totals.invalid) parts.push(`${perFrame(totals.invalid)} with non-finite coordinates`);
    if (totals.skipped) parts.push(`${perFrame(totals.skipped)} non-finite values skipped`);
    parts.push(frames > 1 ? `averaged over ${plural(frames, 'frame')}` : `frame ${integer(result.frameIndex + 1)}`);
    return parts.join(' · ');
  }

  function show(result) {
    job.result = result; job.failed = false;
    job.exported = { ...result, valueName: result.csvName };
    if ($('binning-results')) $('binning-results').hidden = false;
    if ($('binning-summary')) $('binning-summary').textContent = summaryText(result);
    if ($('binning-geometry')) $('binning-geometry').textContent = geometryText(result);
    if ($('binning-chart-title')) $('binning-chart-title').textContent = `${result.valueLabel}${result.unit ? ` (${result.unit})` : ''}`;
    renderChart($('binning-chart'), result, { valueLabel: result.valueLabel, unit: result.unit, zero: result.zero,
      scheme: currentSettings().colorScheme });
    const backend = `${result.engine === 'worker' ? 'CPU · Worker' : 'CPU · main thread'}`;
    if ($('binning-backend')) $('binning-backend').textContent = backend;
    if ($('binning-progress')) { $('binning-progress').hidden = true; $('binning-progress').value = 1; }
    state('Calculated', `${backend} · ${format(result.elapsedMs / 1000, 3)} s`);
    onResultsChange({ clearSettings: false });
  }

  function decorate(partial, { prepared, property, frameIndex, elapsedMs, engine, averaged }) {
    const result = finalizeSpatialBins(partial, { quantity: prepared.settings.quantity, reduction: prepared.settings.reduction });
    return Object.assign(result, describeQuantity(prepared.settings, property), { frameIndex, averaged, elapsedMs, engine,
      propertyKey: prepared.settings.quantity === 'property' ? prepared.settings.property : null,
      selectionId: prepared.group?.id ?? null, selectionName: prepared.group?.name ?? null });
  }

  function signatureOf(frame, prepared, property) {
    return [frame, property?.data ?? null, prepared.key, String(getSourceVersion())];
  }

  function sameSignature(first, second) {
    return Boolean(first && second) && first.length === second.length && first.every((entry, index) => Object.is(entry, second[index]));
  }

  async function run({ automatic = false, isCurrent = () => true } = {}) {
    const frame = getFrame();
    if (!frame || !isCurrent()) return false;
    let prepared;
    try { prepared = prepare(); }
    catch (error) { abort(); abortAverage(); return fail(error, { automatic }); }
    if (!automatic) onEdit();
    job.settings = { ...prepared.settings, axes: [...prepared.settings.axes], bins: [...prepared.settings.bins] };
    job.enabled = true; job.failed = false;
    syncTool({ reveal: !automatic });
    if (!automatic) warm();
    if (prepared.settings.averageFrames && getFrameCount() > 1) return runAverage(prepared, { automatic, isCurrent });
    abortAverage(); job.average = null;
    let property;
    try { property = resolveProperty(frame, prepared.settings); }
    catch (error) { abort(); return fail(error, { automatic }); }
    const signature = signatureOf(frame, prepared, property);
    if (prepared.settings.quantity === 'property' && !property) {
      abort(); clearView(); job.signature = signature;
      state('Waiting', `Waiting for ${prepared.settings.property.replace(/^property:/, '')} in this frame. Calculate it, or choose another quantity.`);
      onResultsChange({ clearSettings: false });
      return false;
    }
    abort();
    job.signature = signature;
    const serial = job.serial, token = generation, source = getSourceVersion();
    const controller = new AbortController(); job.controller = controller;
    const current = () => serial === job.serial && token === generation && source === getSourceVersion() && frame === getFrame()
      && job.enabled && !controller.signal.aborted && isCurrent();
    state('Calculating…', `Binning frame ${integer(getFrameIndex() + 1)}…`);
    try {
      const started = now(), engine = client.usesWorker?.(frame) ? 'worker' : 'direct';
      const partial = await client.accumulate(frame, request(prepared.layout, prepared.settings, property?.data, selectionMask(frame, prepared.group)),
        { signal: controller.signal });
      if (!current()) return false;
      job.controller = null;
      show(decorate(partial, { prepared, property, frameIndex: getFrameIndex(), elapsedMs: now() - started, engine, averaged: false }));
      return true;
    } catch (error) {
      if (!current() || error.name === 'AbortError') return false;
      job.controller = null;
      return fail(error, { automatic });
    } finally {
      if (job.controller === controller) job.controller = null;
      updateControls();
    }
  }

  /** Frames are read in order and merged in that order, so the average is
   * reproducible. Only fields present in every parsed frame can be averaged. */
  async function runAverage(prepared, { automatic, isCurrent }) {
    abort();
    const source = String(getSourceVersion()), token = generation;
    const key = JSON.stringify([prepared.key, source]);
    if (job.average?.key === key) { show(job.average.result); return true; }
    if (job.averaging?.key === key) return job.averaging.promise;
    abortAverage();
    const controller = new AbortController(); controller.key = key;
    const current = () => job.averaging === controller && token === generation && source === String(getSourceVersion())
      && job.enabled && !controller.signal.aborted && isCurrent();
    clearView();
    state('Calculating…', 'Reading trajectory frames…');
    const task = (async () => {
      const started = now(), quantityResolver = new ColorQuantityResolver();
      let partial = null, property = null, engine = 'direct';
      try {
        await ensureIndexed({ signal: controller.signal });
        const frameCount = getFrameCount();
        const meter = $('binning-progress');
        if (meter) { meter.hidden = false; meter.value = 0; }
        for (let index = 0; index < frameCount; index++) {
          if (!current()) return false;
          if ($('binning-status')) $('binning-status').textContent = `Averaging frame ${integer(index + 1)} of ${integer(frameCount)}…`;
          const frame = await getFrameAt(index, { signal: controller.signal });
          if (!current()) return false;
          if (!frame) throw new Error(`Frame ${integer(index + 1)} could not be read for the average.`);
          const frameProperty = resolveProperty(frame, prepared.settings, quantityResolver);
          if (prepared.settings.quantity === 'property' && !frameProperty) {
            throw new Error(`${prepared.settings.property.replace(/^property:/, '')} is not available in frame ${integer(index + 1)}. Averages support positions, speed and columns read from the file; analysis and expression results exist only for the displayed frame.`);
          }
          property ??= frameProperty;
          if (client.usesWorker?.(frame)) engine = 'worker';
          const part = await client.accumulate(frame, request(prepared.layout, prepared.settings, frameProperty?.data, selectionMask(frame, prepared.group)),
            { signal: controller.signal });
          if (!current()) return false;
          partial = mergeSpatialBins(partial, part);
          if (meter) meter.value = (index + 1) / frameCount;
        }
        const result = decorate(partial, { prepared, property, frameIndex: getFrameIndex(), elapsedMs: now() - started, engine, averaged: true });
        job.average = { key, result }; job.averaging = null;
        job.signature = null;
        show(result);
        return true;
      } catch (error) {
        if (!current() || error.name === 'AbortError') return false;
        job.averaging = null;
        return fail(error, { automatic });
      } finally {
        if (job.averaging === controller) job.averaging = null;
        updateControls();
      }
    })();
    controller.promise = task;
    job.averaging = controller;
    updateControls();
    return task;
  }

  /** Called whenever atom properties, colors or selections may have changed.
   * Recalculates only when the binned inputs differ from the last request. */
  function refresh() {
    updateQuantityOptions(); updateSelectionOptions(); updateSchemeOptions();
    updateControls();
    if (!job.enabled || !getFrame() || job.averaging) return Promise.resolve(false);
    let prepared;
    try { prepared = prepare(); } catch { return Promise.resolve(false); }
    if (prepared.settings.averageFrames && getFrameCount() > 1) {
      return job.average?.key === JSON.stringify([prepared.key, String(getSourceVersion())]) ? Promise.resolve(false) : run({ automatic: true });
    }
    let property = null;
    try { property = resolveProperty(getFrame(), prepared.settings); } catch { return Promise.resolve(false); }
    if (sameSignature(job.signature, signatureOf(getFrame(), prepared, property))) return Promise.resolve(false);
    return run({ automatic: true });
  }

  async function onFrame() {
    abort();
    updateQuantityOptions(); updateSelectionOptions(); updateSchemeOptions();
    if (!job.enabled) { clearView(); state('Not calculated', HELP); return false; }
    // A trajectory average does not depend on the displayed frame; run()
    // reuses it, or the calculation in progress, while its key still matches.
    const settings = currentSettings();
    if (!(settings.averageFrames && getFrameCount() > 1)) { clearView(); return run({ automatic: true }); }
    // Frame display must not wait for a trajectory-wide calculation.
    void run({ automatic: true });
    return true;
  }

  function applySettings(settings) {
    updateSchemeOptions();
    if ($('binning-mode')) $('binning-mode').value = settings.mode;
    if ($('binning-axis-1')) $('binning-axis-1').value = settings.axes[0];
    if ($('binning-axis-2')) $('binning-axis-2').value = settings.axes[1];
    if ($('binning-bins-1')) $('binning-bins-1').value = String(settings.bins[0]);
    if ($('binning-bins-2')) $('binning-bins-2').value = String(settings.bins[1]);
    if ($('binning-reduction')) $('binning-reduction').value = settings.reduction;
    if ($('binning-average-frames')) $('binning-average-frames').checked = settings.averageFrames;
    if ($('binning-color-scheme')) $('binning-color-scheme').value = settings.colorScheme;
    updateQuantityOptions(); updateSelectionOptions(); updateControls();
  }

  function reset() {
    generation++;
    cancel({ silent: true });
    job.settings = { ...BINNING_DEFAULTS, axes: [...BINNING_DEFAULTS.axes], bins: [...BINNING_DEFAULTS.bins] };
    applySettings(job.settings);
    onResultsChange({ clearSettings: true });
  }

  function serialize() {
    const settings = currentSettings();
    if (settings.quantity === 'property' && !settings.property) Object.assign(settings, { quantity: job.settings.quantity, property: job.settings.property });
    const bins = settings.bins.map((count, index) => Number.isSafeInteger(count) && count >= 1 ? count : job.settings.bins[index]);
    return { enabled: job.enabled, mode: settings.mode, axes: BINNING_AXES.includes(settings.axes[0]) && BINNING_AXES.includes(settings.axes[1]) ? settings.axes : job.settings.axes,
      bins, quantity: settings.quantity, property: settings.quantity === 'property' ? settings.property : null,
      reduction: BINNING_REDUCTIONS.includes(settings.reduction) ? settings.reduction : job.settings.reduction,
      selectionGroupId: settings.selectionGroupId, averageFrames: settings.averageFrames, colorScheme: settings.colorScheme };
  }

  async function restore(saved, { isCurrent = () => true } = {}) {
    if (!isCurrent()) return false;
    generation++;
    cancel({ clearSettings: false, silent: true });
    const settings = { ...BINNING_DEFAULTS, ...(saved ?? {}) };
    job.settings = { mode: settings.mode, axes: [...settings.axes], bins: [...settings.bins], quantity: settings.quantity,
      property: settings.property ?? null, reduction: settings.reduction, selectionGroupId: settings.selectionGroupId ?? null,
      averageFrames: Boolean(settings.averageFrames), colorScheme: settings.colorScheme };
    applySettings(job.settings);
    job.enabled = Boolean(saved?.enabled); syncTool();
    onResultsChange({ clearSettings: false });
    if (!job.enabled || !isCurrent()) return false;
    return run({ automatic: true, isCurrent });
  }

  function warm() { if (!warmed) { warmed = true; client.warm?.(); } }

  for (const id of CONTROL_IDS) {
    $(id)?.addEventListener('change', () => {
      onEdit();
      const settings = currentSettings();
      if (id === 'binning-selection') job.settings.selectionGroupId = settings.selectionGroupId;
      if (id === 'binning-quantity') Object.assign(job.settings, { quantity: settings.quantity, property: settings.property });
      updateControls();
      if (id === 'binning-color-scheme') {
        job.settings.colorScheme = settings.colorScheme;
        if (job.result) renderChart($('binning-chart'), job.result, { valueLabel: job.result.valueLabel, unit: job.result.unit, zero: job.result.zero, scheme: settings.colorScheme });
        return;
      }
      if (job.enabled) void run({ automatic: true });
    });
  }
  $('run-binning')?.addEventListener('click', () => { void run(); });
  $('cancel-binning')?.addEventListener('click', () => { onEdit(); cancel(); });
  updateSchemeOptions();
  state('Not calculated', HELP);

  return Object.freeze({ run, refresh, onFrame, reset, cancel, serialize, restore, warm,
    abortJobs: abort,
    dispose() { abort(); abortAverage(); client.dispose?.(); },
    isEnabled: () => job.enabled,
    setEnabled(value) { controlsEnabled = Boolean(value); updateQuantityOptions(); updateSelectionOptions(); updateControls(); },
    getResult: () => job.result,
    /** The current result for the statistics CSV exporter. */
    exportResults: () => job.exported && (job.exported.averaged || job.exported.frameIndex === getFrameIndex()) ? { binning: job.exported } : {},
    failed: () => job.failed ? ['binning'] : [],
  });
}
