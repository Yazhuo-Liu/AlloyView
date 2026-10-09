import {
  INFERRED_UNWRAP_SOURCE, MAX_TRAJECTORY_LINE_VERTICES, SmoothingAccumulator, TrajectoryLineBuilder, TrajectoryUnwrapper,
  inferredUnwrappedPositions, smoothingWindow, trajectoryLineFrames,
} from '../data/trajectory-tools.js';

/** Raw coordinates kept for reuse by neighbouring smoothing windows, the
 * unwrapping frontier and line sampling. It is a cache: any frame can be read
 * again, so eviction changes only speed, never results. */
export const TRAJECTORY_COORDINATE_BYTES = 192 * 1024 ** 2;
const READ_AHEAD = 3;

const cancelled = () => new DOMException('Trajectory processing cancelled.', 'AbortError');
const checkSignal = signal => { if (signal?.aborted) throw cancelled(); };

function cloneCell(cell) {
  return { origin: Float64Array.from(cell.origin), vectors: Float64Array.from(cell.vectors),
    pbc: Array.from(cell.pbc, Boolean), triclinic: Boolean(cell.triclinic) };
}

/** Only what other frames' calculations read. A frame that will be
 * transferred to the page is copied; a frame read here is retained as is. */
function coordinateSnapshot(frame, index, copy) {
  const own = value => value && (copy ? value.slice() : value);
  return {
    frameIndex: index,
    ids: copy ? (ArrayBuffer.isView(frame.ids) ? frame.ids.slice() : Array.from(frame.ids)) : frame.ids,
    idSource: frame.idSource,
    fractional: own(frame.fractional),
    cell: copy ? cloneCell(frame.cell) : frame.cell,
    unwrappedPositions: own(frame.unwrappedPositions) ?? null,
    hasImages: Boolean(frame.imageFlags),
  };
}

function snapshotBytes(snapshot) {
  let bytes = 256;
  for (const value of [snapshot.ids, snapshot.fractional, snapshot.unwrappedPositions]) {
    if (ArrayBuffer.isView(value)) bytes += value.byteLength;
    else if (Array.isArray(value)) bytes += value.length * 16;
  }
  return bytes;
}

/**
 * Trajectory operations for one opened source, run beside the frame parser
 * pool. Integration for unwrapping is serialized and strictly ordered, so its
 * results never depend on which frames were requested or prefetched first.
 */
export class TrajectoryProcessor {
  constructor({ readFrame, getFrameCount, coordinateBudgetBytes = TRAJECTORY_COORDINATE_BYTES, eventBudgetBytes,
    readAhead = READ_AHEAD } = {}) {
    if (typeof readFrame !== 'function' || typeof getFrameCount !== 'function') throw new TypeError('A trajectory processor requires frame access.');
    this.readFrame = readFrame;
    this.getFrameCount = getFrameCount;
    this.coordinateBudgetBytes = coordinateBudgetBytes;
    this.readAhead = readAhead;
    this.unwrapper = new TrajectoryUnwrapper(eventBudgetBytes === undefined ? {} : { eventBudgetBytes });
    this.store = new Map();
    this.storeBytes = 0;
    this.reading = new Map();
    this.lockTail = Promise.resolve();
    this.closed = false;
  }

  close() {
    this.closed = true;
    this.store.clear();
    this.reading.clear();
    this.storeBytes = 0;
  }

  remember(index, frame, { copy = false } = {}) {
    const existing = this.store.get(index);
    if (existing) {
      this.store.delete(index); this.store.set(index, existing);
      return existing.snapshot;
    }
    const snapshot = coordinateSnapshot(frame, index, copy), bytes = snapshotBytes(snapshot);
    this.store.set(index, { snapshot, bytes });
    this.storeBytes += bytes;
    // Keep the newest entry even when it alone exceeds the budget.
    while (this.storeBytes > this.coordinateBudgetBytes && this.store.size > 1) {
      const [oldest, entry] = this.store.entries().next().value;
      this.store.delete(oldest);
      this.storeBytes -= entry.bytes;
    }
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
        this.reading.set(index, pending);
      }
      try { return await pending; }
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
      const start = this.unwrapper.frontier + 1;
      while (this.unwrapper.frontier < index) {
        checkSignal(options.signal);
        const next = this.unwrapper.frontier + 1;
        this.readAheadFrom(Array.from({ length: Math.max(0, Math.min(index, next + this.readAhead) - next) }, (_, offset) => next + offset + 1), options);
        const coordinates = await this.coordinates(next, options);
        this.unwrapper.append(next, coordinates);
        onProgress({ loaded: next - start + 1, total: index - start + 1 });
      }
    });
  }

  async imageFlagsAt(index, ids, options = {}, onProgress = () => {}) {
    await this.integrateTo(index, options, onProgress);
    if (this.unwrapper.canReconstruct(index)) return this.unwrapper.imageFlags(index, ids);
    // The crossing log exceeded its budget. Replay from the first frame
    // without retaining history; the result is the same, only slower.
    const replay = new TrajectoryUnwrapper({ eventBudgetBytes: 0 });
    for (let frame = 0; frame <= index; frame += 1) {
      checkSignal(options.signal);
      this.readAheadFrom(Array.from({ length: Math.min(index, frame + this.readAhead) - frame }, (_, offset) => frame + offset + 1), options);
      replay.append(frame, await this.coordinates(frame, options));
      onProgress({ loaded: frame + 1, total: index + 1 });
    }
    return replay.imageFlags(index, ids);
  }

  /**
   * Apply the requested trajectory operations to a freshly parsed frame in
   * place. File image data always wins; inferred coordinates are attached as
   * `inferredUnwrap`, which only display paths read.
   */
  async prepare(frame, index, { unwrap = false, smoothing = 0, signal, background = false, onProgress = () => {} } = {}) {
    const needsUnwrap = Boolean(unwrap) && !frame.unwrappedPositions;
    const window = Number(smoothing) || 0;
    if (!needsUnwrap && window <= 0) return frame;
    const options = { signal, background: true, priority: background ? -20 : 20 };
    const frameCount = await this.getFrameCount({ atLeast: index + window + 1, signal });
    checkSignal(signal);
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
          positions: frame.positions, cell: frame.cell };
        const accumulator = new SmoothingAccumulator(center);
        for (let current = first; current <= last; current += 1) {
          checkSignal(signal);
          if (current === index) { accumulator.add(center, { center: true }); continue; }
          this.readAheadFrom(Array.from({ length: Math.min(last, current + this.readAhead) - current }, (_, offset) => current + offset + 1)
            .filter(value => value !== index), options);
          accumulator.add(await this.coordinates(current, options));
          onProgress({ loaded: current - first + 1, total: last - first + 1, stage: 'trajectory-smooth' });
        }
        checkSignal(signal);
        const fileImages = frame.unwrappedPositions ? frame.imageFlags ?? null : null;
        const result = accumulator.finish({
          imageFlags: fileImages ?? inferred?.imageFlags ?? null,
          unwrappedPositions: fileImages ? null : frame.unwrappedPositions ?? null,
        });
        frame.fractional = result.fractional;
        frame.positions = result.positions;
        frame.cell = result.cell;
        if (frame.unwrappedPositions) {
          frame.unwrappedPositions = result.unwrappedPositions;
          if (frame.imageFlags) frame.imageFlags = result.imageFlags;
        } else if (inferred) inferred = { imageFlags: result.imageFlags, unwrappedPositions: result.unwrappedPositions };
      }
      frame.smoothing = { window, firstFrame: first, lastFrame: last, frameCount: last - first + 1 };
    }
    if (inferred) frame.inferredUnwrap = { ...inferred, source: INFERRED_UNWRAP_SOURCE };
    return frame;
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
  async lines({ ids, first, last, stride, maxVertices = MAX_TRAJECTORY_LINE_VERTICES }, { signal, onProgress = () => {} } = {}) {
    const frames = trajectoryLineFrames(first, last, stride);
    const builder = new TrajectoryLineBuilder(ids, frames, { maxVertices });
    const frameCount = await this.getFrameCount({ atLeast: last + 1, signal });
    if (last >= frameCount) throw new Error(`Frame ${last + 1} is outside this ${frameCount}-frame trajectory.`);
    const options = { signal, background: true, priority: 10 };
    for (let sample = 0; sample < frames.length; sample += 1) {
      checkSignal(signal);
      this.readAheadFrom(frames.slice(sample + 1, sample + 1 + this.readAhead), options);
      builder.add(await this.coordinates(frames[sample], options));
      onProgress({ loaded: sample + 1, total: frames.length, stage: 'trajectory-lines' });
    }
    checkSignal(signal);
    return builder.finish();
  }
}
