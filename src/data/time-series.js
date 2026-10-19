import { MAX_ATTRIBUTE_NAME_LENGTH } from '../properties/global-attributes.js';

/** Per-frame values of chosen global attributes. Points are keyed by frame
 * index and by the settings that produced them: each value carries its
 * attribute's signature (for example a CNA parameter key or the strain
 * reference frame), and a value with a new signature discards that
 * attribute's older points, so a curve never mixes analysis settings. */

export const MAX_TIME_SERIES = 8;
export const MAX_TIME_SERIES_FRAMES = 100_000;
export const TIME_SERIES_DEFAULTS = Object.freeze({ attributes: Object.freeze(['Cell.volume']), firstFrame: 0, lastFrame: null, stride: 1,
  xAxis: 'frame', separatePanels: false });
const HEADER_ATTRIBUTES = new Set(['Frame', 'FrameCount', 'Timestep', 'AtomCount', 'NumberDensity', 'Cell.volume',
  'Cell.a', 'Cell.b', 'Cell.c', 'Cell.alpha', 'Cell.beta', 'Cell.gamma',
  'Strain.reference', 'Strain.a', 'Strain.b', 'Strain.c', 'Strain.volumetric']);

/** Only these quantities are determined without visiting atom columns. A
 * mixed request (for example Cell.volume + Mean.energy) uses one full read. */
export function isHeaderSeries(names) { return names.length > 0 && names.every(name => HEADER_ATTRIBUTES.has(name)); }
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class TimeSeriesStore {
  constructor() { this.clear(); }

  clear() {
    this.series = new Map();
    this.timesteps = new Map();
    // Frames read in the background whose file lacks an attribute (for
    // example a timestep in CFG), so a repeated collection skips them.
    this.unavailable = new Map();
    this.revision = (this.revision ?? 0) + 1;
  }

  markUnavailable(name, frameIndex) {
    if (!this.unavailable.has(name)) this.unavailable.set(name, new Set());
    this.unavailable.get(name).add(frameIndex);
  }

  /** Drop values and missing-frame observations when their source columns change. */
  invalidate(names) {
    let changed = false;
    for (const name of names) {
      changed = this.series.delete(name) || changed;
      changed = this.unavailable.delete(name) || changed;
    }
    if (changed) this.revision++;
    return changed;
  }

  /** True when a background read of this frame needs nothing for this name. */
  settled(name, frameIndex) { return this.has(name, frameIndex) || (this.unavailable.get(name)?.has(frameIndex) ?? false); }

  /** entries: [{ name, value, unit, signature, kind }]. Non-numeric values are ignored. */
  record(frameIndex, entries, { timestep } = {}) {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) return false;
    let changed = false;
    if (timestep !== undefined && timestep !== null && Number.isFinite(Number(timestep)) && this.timesteps.get(frameIndex) !== Number(timestep)) {
      this.timesteps.set(frameIndex, Number(timestep)); changed = true;
    }
    for (const { name, value, unit = '', signature = '', kind = 'file' } of entries) {
      if (typeof name !== 'string') continue;
      // A value without identified analysis settings cannot be combined with
      // earlier frames, even when a caller bypasses the attribute registry.
      if (kind === 'analysis' && (typeof signature !== 'string' || !signature.trim() || /^[^:]+:\s*$/.test(signature))) {
        changed = this.series.delete(name) || changed;
        this.unavailable.delete(name);
        continue;
      }
      if (typeof value !== 'number') continue;
      let series = this.series.get(name);
      if (!series || series.signature !== signature) {
        series = { name, unit, kind, signature, points: new Map() };
        // A newly imported column can first appear after every background
        // frame was marked missing. Its first value must reopen those reads.
        this.unavailable.delete(name);
        this.series.set(name, series); changed = true;
      }
      series.unit = unit; series.kind = kind;
      if (!Object.is(series.points.get(frameIndex), value)) { series.points.set(frameIndex, value); changed = true; }
    }
    if (changed) this.revision++;
    return changed;
  }

  value(name, frameIndex) { return this.series.get(name)?.points.get(frameIndex); }
  has(name, frameIndex) { return this.series.get(name)?.points.has(frameIndex) ?? false; }
  describe(name) { return this.series.get(name) ?? null; }
}

/** Frame indices first, first + stride, …, at most last. */
export function seriesFrames({ firstFrame = 0, lastFrame = null, stride = 1 } = {}, frameCount = 1) {
  const last = Math.min(frameCount - 1, lastFrame ?? frameCount - 1);
  if (!Number.isSafeInteger(firstFrame) || !Number.isSafeInteger(stride) || stride < 1 || firstFrame < 0 || last < firstFrame) return [];
  const frames = [];
  for (let index = firstFrame; index <= last && frames.length < MAX_TIME_SERIES_FRAMES; index += stride) frames.push(index);
  return frames;
}

/**
 * Read frames in the background and record file-derived attributes.
 * readFrame(index, { signal }) returns the frame without displaying it;
 * attributesFor(frame, index) returns its registry. Only frames that lack a
 * requested value are read. Cancellation throws an AbortError.
 */
export async function collectFileSeries({ store, frames, names, readFrame, readHeader = null, attributesFor, signal, onProgress = () => {},
  headerConcurrency = 3, yieldEvery = () => Promise.resolve() } = {}) {
  const pending = frames.filter(index => names.some(name => !store.settled(name, index)));
  const headerOnly = typeof readHeader === 'function' && isHeaderSeries(names);
  const concurrency = headerOnly ? Math.max(1, Math.min(4, Math.floor(headerConcurrency) || 1)) : 1;
  const controller = headerOnly ? new AbortController() : null;
  const abort = () => controller?.abort();
  signal?.addEventListener?.('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const readSignal = controller?.signal ?? signal;
  let read = 0, recorded = 0;
  async function readInput(index) {
    if (readSignal?.aborted) throw abortError();
    let frame = headerOnly ? await readHeader(index, { signal: readSignal }) : null;
    if (readSignal?.aborted) throw abortError();
    if (!headerOnly || frame?.headerUnavailable) frame = await readFrame(index, { signal: readSignal });
    if (readSignal?.aborted) throw abortError();
    if (!frame) throw new Error(`Frame ${index + 1} could not be read.`);
    return frame;
  }
  // A bounded rolling window uses the retained parser lanes; never launch a
  // request for every trajectory frame. Resolve failures into queue values so
  // an out-of-order error cannot become an unhandled promise rejection.
  const queue = [];
  let requested = 0;
  const fill = () => {
    while (queue.length < concurrency && requested < pending.length) {
      const index = pending[requested++];
      queue.push(readInput(index).then(frame => ({ frame }), error => ({ error })));
    }
  };
  try {
    onProgress({ done: 0, total: pending.length });
    fill();
    for (const index of pending) {
      if (signal?.aborted) throw abortError();
      const { frame, error } = await queue.shift();
      if (error) throw error;
      if (signal?.aborted) throw abortError();
      const registry = attributesFor(frame, index);
      const entries = [], missing = [];
      for (const name of names) {
        const entry = registry.get(name);
        if (entry?.kind === 'file' && typeof entry.value === 'number') entries.push({ ...entry, name });
        else missing.push(name);
      }
      recorded += entries.length;
      store.record(index, entries, { timestep: frame.timestep });
      for (const name of missing) store.markUnavailable(name, index);
      onProgress({ done: ++read, total: pending.length, frameIndex: index });
      await yieldEvery();
      fill();
    }
    return { read, recorded };
  } finally {
    signal?.removeEventListener?.('abort', abort);
    controller?.abort();
  }
}

/** Record available values of the displayed frame's registry. */
export function recordRegistry(store, registry, frameIndex, names) {
  if (!registry) return false;
  const entries = [];
  for (const name of names) {
    const entry = registry.get(name);
    if (entry && typeof entry.value === 'number') entries.push({ ...entry, name });
    else {
      const descriptor = registry.describe(name);
      // Explicitly unidentified results invalidate older points instead of
      // presenting those points as belonging to the newly computed result.
      if (descriptor?.unavailableReason) entries.push({ ...descriptor, name });
    }
  }
  return store.record(frameIndex, entries, { timestep: registry.frame?.timestep });
}

/** X values: one-based frame numbers, or timesteps when every frame in the
 * range has one. */
export function seriesAxis(store, frames, xAxis = 'frame') {
  const timesteps = xAxis === 'timestep' && frames.length && frames.every(index => store.timesteps.has(index));
  return { kind: timesteps ? 'timestep' : 'frame', label: timesteps ? 'Timestep' : 'Frame',
    values: frames.map(index => timesteps ? store.timesteps.get(index) : index + 1) };
}

/** A CSV table in the Statistics CSV conventions: context columns, then
 * one column per attribute with its unit; missing points are empty cells. */
export function timeSeriesTable(store, names, frames, { fileName = 'structure' } = {}) {
  const columns = ['source_file', 'frame_number', 'timestep', ...names.map(name => {
    const unit = store.describe(name)?.unit;
    return unit ? `${name} [${unit}]` : name;
  })];
  const rows = frames.map(index => [fileName, index + 1, store.timesteps.get(index) ?? '',
    ...names.map(name => store.has(name, index) ? store.value(name, index) : '')]);
  const stem = (String(fileName || 'structure').split(/[\\/]/).at(-1).replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'structure').slice(0, 180);
  return { kind: 'time-series', columns, rows, filename: `${stem}-time-series.csv` };
}

/** Validated shared settings. Attribute names are plain strings resolved
 * through the registry; they are never used as object keys. */
export function normalizeTimeSeriesState(value, { path = 'settings.extensions.timeSeries' } = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'must be an object');
  const keys = ['attributes', 'firstFrame', 'lastFrame', 'stride', 'xAxis', 'separatePanels', 'autoCollect'];
  for (const key of Object.keys(value)) if (FORBIDDEN_KEYS.has(key) || !keys.includes(key)) fail(`${path}.${key}`, 'is not a supported setting');
  const attributes = value.attributes ?? [...TIME_SERIES_DEFAULTS.attributes];
  if (!Array.isArray(attributes) || attributes.length > MAX_TIME_SERIES) fail(`${path}.attributes`, `must contain 0–${MAX_TIME_SERIES} entries`);
  const names = attributes.map((name, index) => {
    if (typeof name !== 'string' || !name || name.length > MAX_ATTRIBUTE_NAME_LENGTH || /[\x00-\x1f\x7f]/.test(name)) {
      fail(`${path}.attributes[${index}]`, `must be an attribute name of 1–${MAX_ATTRIBUTE_NAME_LENGTH} characters`);
    }
    return name;
  });
  if (new Set(names).size !== names.length) fail(`${path}.attributes`, 'contains duplicates');
  const integer = (key, fallback, minimum) => {
    const item = value[key] ?? fallback;
    if (!Number.isSafeInteger(item) || item < minimum) fail(`${path}.${key}`, `must be an integer of at least ${minimum}`);
    return item;
  };
  const firstFrame = integer('firstFrame', 0, 0), stride = integer('stride', 1, 1);
  const lastFrame = value.lastFrame === undefined || value.lastFrame === null ? null : integer('lastFrame', 0, 0);
  if (lastFrame !== null && lastFrame < firstFrame) fail(`${path}.lastFrame`, 'must not precede the first frame');
  const xAxis = value.xAxis ?? 'frame';
  if (!['frame', 'timestep'].includes(xAxis)) fail(`${path}.xAxis`, 'is unsupported');
  for (const key of ['separatePanels', 'autoCollect']) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail(`${path}.${key}`, 'must be true or false');
  return { attributes: names, firstFrame, lastFrame, stride, xAxis, separatePanels: Boolean(value.separatePanels), autoCollect: Boolean(value.autoCollect) };
}

function fail(path, message) { throw new Error(`Invalid AlloyView configuration: ${path} ${message}.`); }
function abortError() { return new DOMException('Time series collection cancelled.', 'AbortError'); }
