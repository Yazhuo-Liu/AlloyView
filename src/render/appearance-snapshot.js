import { canonicalAtomNumber } from '../data/atom-ids.js';
import { yieldToMain } from '../shared/task-yield.js';

const MIB = 1024 ** 2;
const MAX_DENSE_IDS = 8 * MIB;
const CONTEXT_KEYS = ['sourceKey', 'processingKey', 'settingsKey', 'colorMode'];

function drain(iterator) {
  let step;
  do { step = iterator.next(); } while (!step.done);
  return step.value;
}

function sliceOptions({ budgetMs = 8, now = () => performance.now() } = {}) {
  return { budgetMs: Math.max(0, Number(budgetMs) || 0), now, started: now(), rows: 0 };
}

function shouldYield(slice) {
  return slice && (++slice.rows & 2047) === 0 && slice.now() - slice.started >= slice.budgetMs;
}

async function drainAsync(iterator, { signal, yieldTask = yieldToMain } = {}, slice, isCurrent = () => true) {
  for (;;) {
    if (signal?.aborted) throw new DOMException('Appearance preparation cancelled.', 'AbortError');
    if (!isCurrent()) { iterator.return(); return null; }
    const step = iterator.next();
    if (step.done) return step.value;
    await yieldTask(); slice.started = slice.now();
  }
}

function compatible(a, b) {
  return a && b && CONTEXT_KEYS.every(key => a[key] !== undefined && Object.is(a[key], b[key]));
}

function stableFrame(frame) {
  // Physical replication retains its source idSource and creates unique,
  // compound IDs. Generated row numbers are never evidence of correspondence.
  return frame?.idSource === 'explicit' && frame.ids && frame.types?.length === frame.ids.length
    && Array.isArray(frame.typeLabels);
}

function validId(id) {
  return typeof id === 'number' ? Number.isSafeInteger(id)
    : typeof id === 'string' && id.length > 0 && !/[\x00-\x1f\x7f]/.test(id);
}

function idKey(id) { return canonicalAtomNumber(id) ?? id; }

/** Dense integer IDs use a bounded typed lookup instead of a per-atom Map.
 * Sparse or compound IDs keep the same textual identity used by selections. */
function* indexIds(ids, maxBytes = Infinity, slice = null) {
  let minimum = Infinity, maximum = -Infinity;
  const numeric = ArrayBuffer.isView(ids) && !(ids instanceof DataView)
    && !(ids instanceof BigInt64Array) && !(ids instanceof BigUint64Array);
  if (numeric) {
    for (const id of ids) {
      if (!validId(id)) return null;
      minimum = Math.min(minimum, id); maximum = Math.max(maximum, id);
      if (shouldYield(slice)) yield;
    }
    const length = maximum - minimum + 1;
    if (Number.isSafeInteger(length) && length <= MAX_DENSE_IDS && length <= ids.length * 4 + 1024) {
      if (length * Int32Array.BYTES_PER_ELEMENT > maxBytes) return null;
      const table = new Int32Array(length);
      for (let index = 0; index < ids.length; index++) {
        const offset = ids[index] - minimum;
        if (table[offset]) return null;
        table[offset] = index + 1;
        if (shouldYield(slice)) yield;
      }
      return { table, minimum, bytes: table.byteLength,
        get(id) { const value = canonicalAtomNumber(id), offset = value - minimum;
          return Number.isSafeInteger(offset) && offset >= 0 && offset < table.length ? table[offset] - 1 : -1; } };
    }
  }
  const map = new Map();
  let bytes = 0;
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    if (!validId(id)) return null;
    const key = idKey(id);
    if (map.has(key)) return null;
    bytes += 48 + (typeof key === 'string' ? key.length * 2 : 0);
    if (bytes > maxBytes) return null;
    map.set(key, index);
    if (shouldYield(slice)) yield;
  }
  return { bytes, get: id => map.get(idKey(id)) ?? -1 };
}

function copyArray(value) {
  return value == null ? null : value.slice();
}

function retainedBytes(value, seen = new Set(), buffers = new Set()) {
  if (typeof value === 'string') return 16 + value.length * 2;
  if (!value || typeof value !== 'object' || seen.has(value)) return 0;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    if (buffers.has(value.buffer)) return 0;
    buffers.add(value.buffer); return value.buffer.byteLength;
  }
  if (Array.isArray(value)) return value.reduce((sum, item) => sum +
    (typeof item === 'string' ? 16 + item.length * 2 : typeof item === 'number' ? 8 : retainedBytes(item, seen, buffers)), 0);
  return Object.values(value).reduce((sum, item) => sum + retainedBytes(item, seen, buffers), 0);
}

function copyLegend(legend) {
  if (!legend) return null;
  // Detach metadata as well as data; a later legend edit must not mutate a
  // saved display. The clone is display-only and never enters frame.properties.
  return structuredClone(legend);
}

function* remapLegend(snapshot, frame, mapping, unmatched, frameIndex, slice = null) {
  const source = snapshot.palette.legend;
  if (!source) return null;
  const legend = { ...source, atomCount: frame.ids.length, preview: true,
    sourceFrameIndex: snapshot.frameIndex, targetFrameIndex: frameIndex, pendingCount: unmatched };
  if (source.property) {
    const data = source.property.data;
    // New atoms have no old scientific value. Float containers represent that
    // absence with NaN; integer category arrays need a floating copy only then.
    const ArrayType = unmatched && !(data instanceof Float32Array || data instanceof Float64Array)
      ? Float64Array : data.constructor;
    const mapped = Array.isArray(data) ? new Array(mapping.length).fill(NaN) : new ArrayType(mapping.length);
    if (!Array.isArray(mapped) && (mapped instanceof Float32Array || mapped instanceof Float64Array)) mapped.fill(NaN);
    for (let atom = 0; atom < mapping.length; atom++) {
      if (mapping[atom] >= 0) mapped[atom] = data[mapping[atom]];
      if (shouldYield(slice)) yield;
    }
    legend.property = { ...source.property, data: mapped, preview: true };
    if (source.items) {
      const counts = new Map(), listed = new Set((source.property.categories ?? []).map(item => item.id));
      for (let atom = 0; atom < mapping.length; atom++) {
        if (mapping[atom] >= 0) {
          const value = mapped[atom], key = Number.isFinite(value) ? value : 'NaN';
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        if (shouldYield(slice)) yield;
      }
      let unlisted = 0;
      for (const [value, count] of counts) if (typeof value === 'number' && value > 0 && Number.isInteger(value) && !listed.has(value)) unlisted += count;
      legend.items = source.items.map(item => ({ ...item, count: item.id === 'other' && source.property.unlistedCategories
        ? unlisted : counts.get(item.id) ?? 0 }));
    }
  } else if (source.atomTypes && source.items) {
    const counts = new Map();
    for (const type of frame.types) {
      const label = frame.typeLabels[type]; counts.set(label, (counts.get(label) ?? 0) + 1);
      if (shouldYield(slice)) yield;
    }
    legend.items = source.items.map(item => ({ ...item, count: counts.get(item.label) ?? 0 }));
  }
  return legend;
}

/** A small byte-bounded cache of completed APPEARANCES, not scientific data.
 * `context` must provide sourceKey, processingKey, settingsKey and colorMode.
 * Keys are immutable primitives/references; mutable UI Sets must be represented
 * in settingsKey. Returned arrays are immutable display inputs.
 */
export function createAppearanceSnapshots({ maxBytes = 32 * MIB, maxEntries = 3 } = {}) {
  if (!Number.isFinite(maxBytes) || maxBytes < 0 || !Number.isInteger(maxEntries) || maxEntries < 0) {
    throw new Error('Appearance snapshot limits must be non-negative.');
  }
  const snapshots = [];
  let bytes = 0, generation = 0, captureRequest = 0, latestCommittedCapture = 0;
  function clear() { snapshots.length = 0; bytes = 0; generation++; }
  function* captureSteps({ frame, palette, visibility = null, radii = null, context, frameIndex = frame?.frameIndex },
    slice = null, epoch = generation, request = ++captureRequest) {
    if (!stableFrame(frame) || !compatible(context, context) || !palette?.colors || !palette.legend
      || palette.legend.preview || palette.colors.length !== frame.ids.length * 3
      || visibility && visibility.length !== frame.ids.length || radii && radii.length !== frame.ids.length
      || palette.legend.property && palette.legend.property.data?.length !== frame.ids.length
      || maxEntries === 0 || maxBytes === 0) return null;
    // Preflight the known allocations before copying a potentially huge frame.
    const estimated = retainedBytes([frame.ids, frame.types, palette.colors, visibility, radii, palette.legend]);
    if (estimated > maxBytes) return null;
    const ids = copyArray(frame.ids), lookup = yield* indexIds(ids, maxBytes - estimated, slice);
    if (!lookup) return null;
    const snapshot = { ids, lookup, types: copyArray(frame.types), typeLabels: frame.typeLabels.slice(),
      frameIndex, context: Object.fromEntries(CONTEXT_KEYS.map(key => [key, context[key]])),
      palette: { colors: copyArray(palette.colors), legend: copyLegend(palette.legend) },
      visibility: copyArray(visibility), radii: copyArray(radii) };
    snapshot.bytes = retainedBytes([snapshot.ids, snapshot.types, snapshot.palette, snapshot.visibility, snapshot.radii, snapshot.typeLabels]) + lookup.bytes;
    if (snapshot.bytes > maxBytes || epoch !== generation || request < latestCommittedCapture) return null;
    latestCommittedCapture = request;
    // Replace the same saved frame/settings rather than growing on every UI
    // notification. Nearest completed appearances otherwise remain a small LRU.
    const previous = snapshots.findIndex(entry => entry.frameIndex === frameIndex && compatible(entry.context, context));
    if (previous >= 0) { bytes -= snapshots[previous].bytes; snapshots.splice(previous, 1); }
    while (snapshots.length && (snapshots.length >= maxEntries || bytes + snapshot.bytes > maxBytes)) bytes -= snapshots.shift().bytes;
    snapshots.push(snapshot); bytes += snapshot.bytes;
    return snapshot;
  }
  function* previewSteps({ frame, context, fallbackPalette, fallbackVisibility = null, fallbackRadii = null,
    frameIndex = frame?.frameIndex } = {}, slice = null, epoch = generation) {
    if (!stableFrame(frame) || !compatible(context, context) || !fallbackPalette?.colors
      || fallbackPalette.colors.length !== frame.ids.length * 3
      || fallbackVisibility && fallbackVisibility.length !== frame.ids.length
      || fallbackRadii && fallbackRadii.length !== frame.ids.length) return null;
    const snapshot = snapshots.findLast(entry => compatible(entry.context, context));
    if (!snapshot) return null;
    // Most trajectories keep explicit IDs and species in the same order.
    // Equality with our already-validated private ID snapshot proves target
    // uniqueness too, avoiding a second large lookup and RGB/property copies.
    let identity = frame.ids.length === snapshot.ids.length;
    for (let atom = 0; identity && atom < frame.ids.length; atom++) {
      identity = Object.is(frame.ids[atom], snapshot.ids[atom])
        && snapshot.typeLabels[snapshot.types[atom]] === frame.typeLabels[frame.types[atom]];
      if (shouldYield(slice)) yield;
    }
    if (identity) {
      const mapping = new Int32Array(frame.ids.length);
      for (let atom = 0; atom < mapping.length; atom++) {
        mapping[atom] = atom;
        if (shouldYield(slice)) yield;
      }
      const source = snapshot.palette.legend;
      const legend = { ...source, preview: true, sourceFrameIndex: snapshot.frameIndex,
        targetFrameIndex: frameIndex, pendingCount: 0,
        ...(source.property ? { property: { ...source.property, preview: true } } : {}) };
      if (epoch !== generation) return null;
      return { preview: true, reliable: true, palette: { colors: snapshot.palette.colors, legend },
        visibility: snapshot.visibility, radii: snapshot.radii ?? fallbackRadii, mapping, unmatchedCount: 0,
        matchedCount: mapping.length, sourceFrameIndex: snapshot.frameIndex, targetFrameIndex: frameIndex };
    }
    // Checking target uniqueness is essential even when all its IDs appeared
    // in the source. A duplicated ID must never inherit two atoms' appearance.
    if (!(yield* indexIds(frame.ids, maxBytes, slice))) return null;
    const propertyBytes = snapshot.palette.legend.property
      ? frame.ids.length * Math.max(8, snapshot.palette.legend.property.data.BYTES_PER_ELEMENT ?? 8) : 0;
    if (frame.ids.length * (4 + 3 + 1 + (fallbackRadii || snapshot.radii ? 4 : 0)) + propertyBytes > maxBytes) return null;
    const mapping = new Int32Array(frame.ids.length);
    let unmatchedCount = 0;
    for (let atom = 0; atom < mapping.length; atom++) {
      let source = snapshot.lookup.get(frame.ids[atom]);
      // An atom whose species changed receives its current default appearance.
      if (source >= 0 && snapshot.typeLabels[snapshot.types[source]] !== frame.typeLabels[frame.types[atom]]) source = -1;
      mapping[atom] = source;
      if (source < 0) unmatchedCount++;
      if (shouldYield(slice)) yield;
    }
    if (mapping.length && unmatchedCount === mapping.length) return null;
    const colors = copyArray(fallbackPalette.colors);
    const visibility = copyArray(fallbackVisibility) ?? new Uint8Array(frame.ids.length).fill(255);
    // Without current default radii, do not invent a zero radius for new IDs.
    const radii = fallbackRadii ? copyArray(fallbackRadii) : snapshot.radii && unmatchedCount === 0
      ? new snapshot.radii.constructor(frame.ids.length) : null;
    for (let atom = 0; atom < mapping.length; atom++) {
      const source = mapping[atom];
      if (source >= 0) {
        const a = atom * 3, b = source * 3;
        colors[a] = snapshot.palette.colors[b]; colors[a + 1] = snapshot.palette.colors[b + 1]; colors[a + 2] = snapshot.palette.colors[b + 2];
        visibility[atom] = snapshot.visibility?.[source] ?? 255;
        if (radii && snapshot.radii) radii[atom] = snapshot.radii[source];
      }
      if (shouldYield(slice)) yield;
    }
    const legend = yield* remapLegend(snapshot, frame, mapping, unmatchedCount, frameIndex, slice);
    if (epoch !== generation) return null;
    return { preview: true, reliable: true, palette: { colors, legend }, visibility, radii, mapping,
      unmatchedCount, matchedCount: mapping.length - unmatchedCount,
      sourceFrameIndex: snapshot.frameIndex, targetFrameIndex: frameIndex };
  }
  return {
    capture: args => drain(captureSteps(args)),
    preview: args => drain(previewSteps(args)),
    /** Time-sliced variants share every mapping rule with the sync API. The
     * caller can supply signal, budgetMs, now and yieldTask for navigation. */
    captureAsync(args, options = {}) {
      const slice = sliceOptions(options), epoch = generation, request = ++captureRequest;
      return drainAsync(captureSteps(args, slice, epoch, request), options, slice,
        () => epoch === generation && request >= latestCommittedCapture);
    },
    previewAsync(args, options = {}) {
      const slice = sliceOptions(options), epoch = generation;
      return drainAsync(previewSteps(args, slice, epoch), options, slice, () => epoch === generation);
    },
    clear,
    get stats() { return { entries: snapshots.length, bytes, maxBytes, maxEntries }; },
  };
}

/** Only the selected property's immutable inputs affect its appearance. Do not
 * pass the full frame.properties array: unrelated results append to that array.
 * Mutable sets/ranges/styles belong in settingsKey, which the app versions.
 */
export function displayDependencyStamp({ frame, colorMode, property = null, coordinateMode,
  settingsKey, appearanceKey, visibilityInputs = [], orientationInputs = [] } = {}) {
  return [frame, colorMode, coordinateMode, settingsKey, appearanceKey,
    property?.data, property?.categories, property?.displayName, property?.unit,
    property?.unlistedCategories, property?.autoRangeRelativeTolerance,
    ...visibilityInputs, ...orientationInputs];
}

export function sameDisplayDependencies(a, b) {
  return Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
}

export function createDisplayDependencyTracker() {
  let previous = null;
  return {
    changed(inputs) {
      const current = displayDependencyStamp(inputs), changed = !sameDisplayDependencies(previous, current);
      previous = current; return changed;
    },
    clear() { previous = null; },
  };
}
