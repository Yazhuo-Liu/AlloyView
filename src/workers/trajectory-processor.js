import {
  INFERRED_UNWRAP_SOURCE, MAX_TRAJECTORY_LINE_VERTICES, SmoothingAccumulator, TrajectoryLineBuilder, TrajectoryUnwrapper,
  inferredUnwrappedPositions, smoothingWindow, trajectoryLineFrames,
} from '../data/trajectory-tools.js';
import { cpuMemoryBudget } from '../analysis/cpu-memory.js';
import { attachFrameSummary } from '../data/frame-summary.js';
import { ensureFileUnwrappedPositions } from '../data/coordinate-display.js';
import { yieldToEventLoop } from '../shared/task-yield.js';

/** Raw coordinates kept for reuse by neighbouring smoothing windows, the
 * unwrapping frontier and line sampling. It is a cache: any frame can be read
 * again, so eviction changes only speed, never results. */
export const TRAJECTORY_COORDINATE_BYTES = 192 * 1024 ** 2;
export const MAX_TRAJECTORY_COORDINATE_BYTES = 768 * 1024 ** 2;
const READ_AHEAD = 3;

/** Hints describe capacity, not free RAM. Use at most half the existing CPU
 * budget so source frames, parser outputs and native analyses retain room. */
export function trajectoryCoordinateBudgetLimit(environment = globalThis) {
  return Math.max(1, Math.min(MAX_TRAJECTORY_COORDINATE_BYTES, Math.floor(cpuMemoryBudget(environment) / 2)));
}

const cancelled = () => new DOMException('Trajectory processing cancelled.', 'AbortError');
const checkSignal = signal => { if (signal?.aborted) throw cancelled(); };
const PROCESSING_SLICE_MS = 10;

/** Cached coordinate reads resolve in microtasks. Periodically admit actual
 * Worker message tasks so cancellation/navigation can interrupt a long cached
 * scan. Small requests allocate no timer and never wait for an idle interval. */
function processingTimeSlice(signal) {
  let resumedAt = performance.now();
  return () => {
    checkSignal(signal);
    if (performance.now() - resumedAt < PROCESSING_SLICE_MS) return null;
    // Node's setImmediate keeps standalone benchmark/test processes alive;
    // browser Workers use a MessagePort task behind queued cancel messages.
    const nextTask = typeof globalThis.setImmediate === 'function'
      ? new Promise(resolve => globalThis.setImmediate(resolve)) : yieldToEventLoop();
    return nextTask.then(() => { resumedAt = performance.now(); checkSignal(signal); });
  };
}

function cloneCell(cell) {
  return { origin: Float64Array.from(cell.origin), vectors: Float64Array.from(cell.vectors),
    pbc: Array.from(cell.pbc, Boolean), triclinic: Boolean(cell.triclinic) };
}

/** Only what other frames' calculations read. A frame that will be
 * transferred to the page is copied; a frame read here is retained as is. */
function coordinateSnapshot(frame, index, copy, ids) {
  const owned = new Map();
  const own = value => {
    if (!value || !copy) return value;
    if (!owned.has(value)) owned.set(value, value.slice());
    return owned.get(value);
  };
  return {
    frameIndex: index,
    ids,
    idSource: frame.idSource,
    fractional: own(frame.fractional),
    cell: copy ? cloneCell(frame.cell) : frame.cell,
    unwrappedPositions: own(frame.unwrappedPositions) ?? null,
    filePositions: own(frame.filePositions) ?? null,
    imageFlags: own(frame.imageFlags) ?? null,
    unwrapSource: frame.unwrapSource,
    hasImages: Boolean(frame.imageFlags),
  };
}

function arrayBytes(value) {
  if (ArrayBuffer.isView(value)) return value.buffer.byteLength;
  if (!Array.isArray(value)) return 0;
  let bytes = value.length * 8;
  for (const item of value) bytes += typeof item === 'string' ? 16 + item.length * 2 : 8;
  return bytes;
}

function snapshotReferences(snapshot) {
  const references = new Map();
  for (const value of [snapshot.ids, snapshot.fractional, snapshot.unwrappedPositions, snapshot.filePositions, snapshot.imageFlags, snapshot.cell.origin, snapshot.cell.vectors]) {
    if (!value) continue;
    const identity = ArrayBuffer.isView(value) ? value.buffer : value;
    references.set(identity, arrayBytes(value));
  }
  return references;
}

function equalIds(first, second) {
  if (first === second) return true;
  if (first.constructor !== second.constructor || first.length !== second.length) return false;
  for (let index = 0; index < first.length; index += 1) if (!Object.is(first[index], second[index])) return false;
  return true;
}

function lowerBound(indices, value, start) {
  let first = start, last = indices.length;
  while (first < last) {
    const middle = first + Math.floor((last - first) / 2);
    if (indices[middle] < value) first = middle + 1; else last = middle;
  }
  return first;
}

function waitForRead(promise, signal) {
  if (!signal) return promise;
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Trajectory operations for one opened source, run beside the frame parser
 * pool. Integration for unwrapping is serialized and strictly ordered, so its
 * results never depend on which frames were requested or prefetched first.
 */
export class TrajectoryProcessor {
  constructor({ readFrame, getFrameCount, promoteRead, environment = globalThis, coordinateBudgetBytes = TRAJECTORY_COORDINATE_BYTES, eventBudgetBytes,
    coordinateBudgetLimitBytes = trajectoryCoordinateBudgetLimit(environment), readAhead = READ_AHEAD } = {}) {
    if (typeof readFrame !== 'function' || typeof getFrameCount !== 'function') throw new TypeError('A trajectory processor requires frame access.');
    if (!Number.isSafeInteger(coordinateBudgetBytes) || coordinateBudgetBytes < 1 ||
      !Number.isSafeInteger(coordinateBudgetLimitBytes) || coordinateBudgetLimitBytes < 1) {
      throw new RangeError('Trajectory coordinate cache budgets must be positive safe integers.');
    }
    if (!Number.isSafeInteger(readAhead) || readAhead < 0) throw new RangeError('Trajectory read-ahead must be a nonnegative safe integer.');
    this.readFrame = readFrame;
    this.promoteRead = promoteRead;
    this.getFrameCount = getFrameCount;
    this.coordinateBudgetLimitBytes = Math.min(MAX_TRAJECTORY_COORDINATE_BYTES, coordinateBudgetLimitBytes);
    this.baseCoordinateBudgetBytes = Math.min(coordinateBudgetBytes, this.coordinateBudgetLimitBytes);
    this.coordinateBudgetBytes = this.baseCoordinateBudgetBytes;
    this.readAhead = readAhead;
    this.unwrapper = new TrajectoryUnwrapper(eventBudgetBytes === undefined ? {} : { eventBudgetBytes });
    this.store = new Map();
    this.storeBytes = 0;
    this.references = new Map();
    this.idArrays = new Map();
    this.idCandidates = [];
    this.windows = new Set();
    this.cacheWindows = [];
    this.sortedIndices = [];
    this.indexStart = 0;
    this.lastWindow = null;
    this.lastCoordinateIndex = 0;
    this.coordinateSnapshotBytes = 0;
    this.idSnapshotBytes = 0;
    this.requestedCoordinateBytes = this.coordinateBudgetBytes;
    this.reading = new Map();
    this.lockTail = Promise.resolve();
    this.closed = false;
  }

  close() {
    this.closed = true;
    this.store.clear();
    this.reading.clear();
    this.references.clear();
    this.idArrays.clear();
    this.idCandidates = [];
    this.windows.clear();
    this.cacheWindows = [];
    this.sortedIndices = [];
    this.indexStart = 0;
    this.lastWindow = null;
    this.storeBytes = 0;
  }

  /** Intern only privately retained ID arrays; outgoing frames keep their
   * own IDs, so transfer to the page cannot detach any cached snapshot. */
  snapshotIds(ids, copy) {
    // Stable trajectories need one comparison, without per-atom keys or a
    // hash table. Bound the search when atom order changes between frames.
    for (let index = this.idCandidates.length - 1; index >= 0; index--) {
      const candidate = this.idCandidates[index];
      if (equalIds(candidate, ids)) return candidate;
    }
    return copy ? (ArrayBuffer.isView(ids) ? ids.slice() : Array.from(ids)) : ids;
  }

  beginWindow(index, window, frameCount, background) {
    const { first, last } = smoothingWindow(index, window, frameCount);
    const scope = { first, last: Math.min(frameCount - 1, last + 1 + this.readAhead) };
    this.windows.add(scope);
    if (!background || !this.lastWindow) this.lastWindow = scope;
    this.resizeCache();
    return scope;
  }

  resizeCache() {
    const windows = [...this.windows];
    if (this.lastWindow && !this.windows.has(this.lastWindow)) windows.push(this.lastWindow);
    const ordered = windows.sort((first, second) => first.first - second.first);
    const ranges = [];
    let frames = 0, last = -1;
    for (const window of ordered) {
      frames += Math.max(0, window.last - Math.max(window.first, last + 1) + 1);
      last = Math.max(last, window.last);
      const preceding = ranges.at(-1);
      if (preceding && window.first <= preceding.last + 1) preceding.last = Math.max(preceding.last, window.last);
      else ranges.push({ first: window.first, last: window.last });
    }
    this.cacheWindows = ranges;
    // The scope includes one extra frame and read-ahead beyond the window.
    // IDs count once for stable ordering; observed alternate orders count
    // separately rather than treating shared IDs as free memory.
    const desiredFrames = frames;
    let coordinateBytes = this.cacheDistance(this.lastCoordinateIndex) === 0 ? this.coordinateSnapshotBytes : 0;
    let idBytes = coordinateBytes ? this.idSnapshotBytes : 0;
    const idArrays = new Set();
    // Each smoothing interval is at most 2w + 2 + read-ahead frames. Never
    // scan all cached tiny frames to size a bounded averaging window.
    for (const range of ranges) for (let index = range.first; index <= range.last; index++) {
      const entry = this.store.get(index);
      if (entry) {
        coordinateBytes = Math.max(coordinateBytes, entry.coordinateBytes);
        idBytes = Math.max(idBytes, entry.idBytes);
        idArrays.add(entry.snapshot.ids);
      }
    }
    this.requestedCoordinateBytes = Math.max(this.baseCoordinateBudgetBytes,
      desiredFrames * coordinateBytes + Math.min(desiredFrames, Math.max(1, idArrays.size)) * idBytes);
    this.coordinateBudgetBytes = Math.min(this.coordinateBudgetLimitBytes, this.requestedCoordinateBytes);
    this.trimCache();
  }

  cacheDistance(index) {
    const windows = this.cacheWindows;
    if (!windows.length) return Math.abs(index - this.lastCoordinateIndex);
    let distance = Infinity;
    for (const { first, last } of windows) distance = Math.min(distance, index < first ? first - index : Math.max(0, index - last));
    return distance;
  }

  removeSnapshot(index, entry) {
    this.store.delete(index);
    const position = lowerBound(this.sortedIndices, index, this.indexStart);
    if (position === this.indexStart) {
      this.indexStart++;
      if (this.indexStart > 1024 && this.indexStart * 2 > this.sortedIndices.length) {
        this.sortedIndices = this.sortedIndices.slice(this.indexStart); this.indexStart = 0;
      }
    } else if (position === this.sortedIndices.length - 1) this.sortedIndices.pop();
    else this.sortedIndices.splice(position, 1);
    this.storeBytes -= 256;
    for (const [identity] of entry.references) {
      const retained = this.references.get(identity);
      if (--retained.count === 0) { this.storeBytes -= retained.bytes; this.references.delete(identity); }
    }
    const idCount = this.idArrays.get(entry.snapshot.ids) - 1;
    if (idCount) this.idArrays.set(entry.snapshot.ids, idCount);
    else {
      this.idArrays.delete(entry.snapshot.ids);
      const candidate = this.idCandidates.indexOf(entry.snapshot.ids);
      if (candidate >= 0) this.idCandidates.splice(candidate, 1);
    }
  }

  trimCache() {
    while (this.storeBytes > this.coordinateBudgetBytes && this.store.size) {
      let victim, greatestDistance = -1;
      const consider = index => {
        if (index === undefined) return;
        const distance = this.cacheDistance(index);
        if (distance > greatestDistance) { greatestDistance = distance; victim = index; }
      };
      consider(this.sortedIndices[this.indexStart]);
      consider(this.sortedIndices.at(-1));
      // Distance peaks at either outer endpoint or the midpoint of a gap
      // between preferred windows. Query only the two nearest stored keys.
      for (let index = 1; index < this.cacheWindows.length; index++) {
        const midpoint = this.cacheWindows[index - 1].last + (this.cacheWindows[index].first - this.cacheWindows[index - 1].last) / 2;
        const position = lowerBound(this.sortedIndices, midpoint, this.indexStart);
        consider(this.sortedIndices[position]);
        if (position > this.indexStart) consider(this.sortedIndices[position - 1]);
      }
      if (greatestDistance === 0) victim = this.store.keys().next().value;
      this.removeSnapshot(victim, this.store.get(victim));
    }
  }

  cacheLimit() {
    return this.requestedCoordinateBytes > this.coordinateBudgetLimitBytes
      ? { budgetBytes: this.coordinateBudgetBytes, requestedBytes: this.requestedCoordinateBytes, retainedBytes: this.storeBytes, retainedFrames: this.store.size }
      : null;
  }

  remember(index, frame, { copy = false } = {}) {
    this.lastCoordinateIndex = index;
    const existing = this.store.get(index);
    if (existing) {
      this.store.delete(index); this.store.set(index, existing);
      return existing.snapshot;
    }
    const snapshot = coordinateSnapshot(frame, index, copy, this.snapshotIds(frame.ids, copy));
    const references = snapshotReferences(snapshot);
    const entry = { snapshot, references, coordinateBytes: 0, idBytes: arrayBytes(snapshot.ids) };
    this.store.set(index, entry);
    if (this.indexStart === this.sortedIndices.length) { this.sortedIndices = [index]; this.indexStart = 0; }
    else if (index > this.sortedIndices.at(-1)) this.sortedIndices.push(index);
    else if (index < this.sortedIndices[this.indexStart] && this.indexStart) this.sortedIndices[--this.indexStart] = index;
    else this.sortedIndices.splice(lowerBound(this.sortedIndices, index, this.indexStart), 0, index);
    this.storeBytes += 256;
    let bytes = 256;
    const idIdentity = ArrayBuffer.isView(snapshot.ids) ? snapshot.ids.buffer : snapshot.ids;
    for (const [identity, referenceBytes] of references) {
      if (identity !== idIdentity) bytes += referenceBytes;
      const retained = this.references.get(identity);
      if (retained) retained.count++;
      else { this.references.set(identity, { count: 1, bytes: referenceBytes }); this.storeBytes += referenceBytes; }
    }
    this.idArrays.set(snapshot.ids, (this.idArrays.get(snapshot.ids) ?? 0) + 1);
    const candidate = this.idCandidates.indexOf(snapshot.ids);
    if (candidate >= 0) this.idCandidates.splice(candidate, 1);
    this.idCandidates.push(snapshot.ids);
    if (this.idCandidates.length > 4) this.idCandidates.shift();
    entry.coordinateBytes = this.coordinateSnapshotBytes = bytes;
    this.idSnapshotBytes = entry.idBytes;
    this.resizeCache();
    return snapshot;
  }

  /** Raw coordinates of one frame, read once even if several calculations ask. */
  async coordinates(index, { signal, background = true, priority } = {}) {
    for (;;) {
      checkSignal(signal);
      if (this.closed) throw cancelled();
      const stored = this.store.get(index);
      if (stored) { this.store.delete(index); this.store.set(index, stored); return stored.snapshot; }
      let pending = this.reading.get(index);
      if (!pending) {
        pending = this.readFrame(index, { signal, background, priority }).then(frame => {
          if (this.closed) throw cancelled();
          return this.remember(index, frame);
        }).finally(() => { if (this.reading.get(index) === pending) this.reading.delete(index); });
        pending.signal = signal;
        pending.priority = priority ?? (background ? -20 : 20);
        this.reading.set(index, pending);
      }
      const requestedPriority = priority ?? (background ? -20 : 20);
      if (pending.signal && requestedPriority > pending.priority) {
        this.promoteRead?.({ signal: pending.signal, priority: requestedPriority });
        pending.priority = requestedPriority;
      }
      try { const result = await waitForRead(pending, signal); checkSignal(signal); return result; }
      catch (error) {
        // A shared read may belong to a request that was cancelled meanwhile.
        if (error.name !== 'AbortError' || signal?.aborted || this.closed) throw error;
      }
    }
  }

  readAheadFrom(indices, options) {
    for (const index of indices) {
      if (this.store.has(index) || this.reading.has(index)) continue;
      this.coordinates(index, options).catch(() => {});
    }
  }

  async lock(task) {
    const previous = this.lockTail;
    let release;
    this.lockTail = new Promise(resolve => { release = resolve; });
    try { await previous; return await task(); }
    finally { release(); }
  }

  /** Extend the unwrapping frontier through `index`, one frame at a time. */
  async integrateTo(index, options = {}, onProgress = () => {}) {
    if (this.unwrapper.frontier >= index) return;
    await this.lock(async () => {
      const timeSlice = processingTimeSlice(options.signal);
      const start = this.unwrapper.frontier + 1;
      while (this.unwrapper.frontier < index) {
        checkSignal(options.signal);
        const next = this.unwrapper.frontier + 1;
        this.readAheadFrom(Array.from({ length: Math.max(0, Math.min(index, next + this.readAhead) - next) }, (_, offset) => next + offset + 1), options);
        const coordinates = await this.coordinates(next, options);
        this.unwrapper.append(next, coordinates);
        onProgress({ loaded: next - start + 1, total: index - start + 1 });
        const pause = timeSlice(); if (pause) await pause;
      }
    });
  }

  async imageFlagsAt(index, ids, options = {}, onProgress = () => {}) {
    await this.integrateTo(index, options, onProgress);
    if (this.unwrapper.canReconstruct(index)) return this.unwrapper.imageFlags(index, ids);
    // The crossing log exceeded its budget. Replay from the first frame
    // without retaining history; the result is the same, only slower.
    const replay = new TrajectoryUnwrapper({ eventBudgetBytes: 0 });
    const timeSlice = processingTimeSlice(options.signal);
    for (let frame = 0; frame <= index; frame += 1) {
      checkSignal(options.signal);
      this.readAheadFrom(Array.from({ length: Math.min(index, frame + this.readAhead) - frame }, (_, offset) => frame + offset + 1), options);
      replay.append(frame, await this.coordinates(frame, options));
      onProgress({ loaded: frame + 1, total: index + 1 });
      const pause = timeSlice(); if (pause) await pause;
    }
    return replay.imageFlags(index, ids);
  }

  /**
   * Apply the requested trajectory operations to a freshly parsed frame in
   * place. File image data always wins; inferred coordinates are attached as
   * `inferredUnwrap`, which only display paths read.
   */
  async prepare(frame, index, { unwrap = false, smoothing = 0, signal, background = false, onProgress = () => {} } = {}) {
    const window = Number(smoothing) || 0;
    if (unwrap || window > 0) ensureFileUnwrappedPositions(frame);
    const needsUnwrap = Boolean(unwrap) && !frame.unwrappedPositions;
    if (!needsUnwrap && window <= 0) return frame;
    const options = { signal, background: true, priority: background ? -20 : 20 };
    const frameCount = await this.getFrameCount({ atLeast: index + window + 1, signal });
    checkSignal(signal);
    const scope = window > 0 ? this.beginWindow(index, window, frameCount, background) : null;
    try {
      this.remember(index, frame, { copy: true });
      let inferred = null;
      if (needsUnwrap && frameCount > 1) {
        const imageFlags = await this.imageFlagsAt(index, frame.ids, options,
          progress => onProgress({ ...progress, stage: 'trajectory-unwrap' }));
        inferred = { imageFlags, unwrappedPositions: inferredUnwrappedPositions(frame.fractional, imageFlags, frame.cell) };
      }
      if (window > 0) {
        const { first, last } = smoothingWindow(index, window, frameCount);
        if (last > first) {
          const center = { frameIndex: index, ids: frame.ids, idSource: frame.idSource, fractional: frame.fractional,
            positions: frame.positions, cell: frame.cell, types: frame.types, typeLabels: frame.typeLabels };
          const accumulator = new SmoothingAccumulator(center);
          const timeSlice = processingTimeSlice(signal);
          for (let current = first; current <= last; current += 1) {
            checkSignal(signal);
            if (current === index) accumulator.add(center, { center: true });
            else {
              this.readAheadFrom(Array.from({ length: Math.min(last, current + this.readAhead) - current }, (_, offset) => current + offset + 1)
                .filter(value => value !== index), options);
              accumulator.add(await this.coordinates(current, options));
              onProgress({ loaded: current - first + 1, total: last - first + 1, stage: 'trajectory-smooth' });
            }
            const pause = timeSlice(); if (pause) await pause;
          }
          checkSignal(signal);
          const fileImages = frame.unwrappedPositions ? frame.imageFlags ?? null : null;
          const result = accumulator.finish({
            imageFlags: fileImages ?? inferred?.imageFlags ?? null,
            unwrappedPositions: fileImages ? null : frame.unwrappedPositions ?? null,
          });
          // File display has its own image convention: raw CFG positions
          // may be outside the box even when explicit image counters refer
          // to a different continuous image. Smooth that display alongside
          // the analysis geometry, without adding those counters to it.
          const filePositions = frame.filePositions && frame.filePositions !== frame.positions
            ? frame.filePositions === frame.unwrappedPositions ? result.unwrappedPositions
              : accumulator.finish({ imageFlags: null, unwrappedPositions: frame.filePositions }).unwrappedPositions
            : null;
          frame.fractional = result.fractional;
          frame.positions = result.positions;
          frame.cell = result.cell;
          // Replace aliases to the unsmoothed coordinates before transfer;
          // those arrays belong only to the raw-coordinate cache now.
          if (!result.unchanged) {
            // Smoothing replaces the source geometry. A raw-file display
            // buffer must not outlive those coordinate/cell replacements.
            if (filePositions) frame.filePositions = filePositions;
            else delete frame.filePositions;
            // Coordinate-only trajectory callers need no atom-type metadata.
            // Their smoothing result has no complete display summary.
            if (result.coordinateSummary) attachFrameSummary(frame, result.coordinateSummary);
            else delete frame.summary;
          }
          if (frame.unwrappedPositions) {
            frame.unwrappedPositions = result.unwrappedPositions;
            if (frame.imageFlags) frame.imageFlags = result.imageFlags;
          } else if (inferred) inferred = { imageFlags: result.imageFlags, unwrappedPositions: result.unwrappedPositions };
        }
        frame.smoothing = { window, firstFrame: first, lastFrame: last, frameCount: last - first + 1 };
        const limit = this.cacheLimit();
        if (limit) frame.smoothing.cacheLimited = limit;
      }
      if (inferred) frame.inferredUnwrap = { ...inferred, source: INFERRED_UNWRAP_SOURCE };
      return frame;
    } finally {
      if (scope) { this.windows.delete(scope); this.resizeCache(); }
    }
  }

  /** Inferred display coordinates for an already delivered frame. The same
   * preparation runs again on retained raw coordinates, so the result equals
   * what a fresh request with `unwrap` would have attached. */
  async inferredUnwrap(index, { smoothing = 0, signal, background = false, onProgress } = {}) {
    const raw = await this.coordinates(index, { signal, background: true, priority: background ? -20 : 20 });
    if (raw.unwrappedPositions || raw.hasImages) return null;
    const frame = { ...raw };
    await this.prepare(frame, index, { unwrap: true, smoothing, signal, background, onProgress });
    return frame.inferredUnwrap ?? null;
  }

  /** Polylines of the listed atoms over sampled frames. */
  async lines({ ids, first, last, stride, physicalReplication, inferMissingImages = true, maxVertices = MAX_TRAJECTORY_LINE_VERTICES }, { signal, onProgress = () => {} } = {}) {
    const frames = trajectoryLineFrames(first, last, stride);
    const builder = new TrajectoryLineBuilder(ids, frames, { maxVertices, physicalReplication, inferMissingImages });
    const frameCount = await this.getFrameCount({ atLeast: last + 1, signal });
    if (last >= frameCount) throw new Error(`Frame ${last + 1} is outside this ${frameCount}-frame trajectory.`);
    const options = { signal, background: true, priority: 10 };
    const timeSlice = processingTimeSlice(signal);
    for (let sample = 0; sample < frames.length; sample += 1) {
      checkSignal(signal);
      this.readAheadFrom(frames.slice(sample + 1, sample + 1 + this.readAhead), options);
      const frame = { ...await this.coordinates(frames[sample], options) };
      // Line generation explicitly needs continuous file coordinates, while
      // ordinary coordinate-cache entries may still defer that allocation.
      ensureFileUnwrappedPositions(frame);
      builder.add(frame);
      onProgress({ loaded: sample + 1, total: frames.length, stage: 'trajectory-lines' });
      const pause = timeSlice(); if (pause) await pause;
    }
    checkSignal(signal);
    return builder.finish();
  }
}
