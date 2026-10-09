import { canonicalAtomNumber } from './atom-ids.js';
import { cartesianToFractional, createCell, fractionalToCartesian, invert3 } from './model.js';

/** Label shown beside display coordinates inferred by `TrajectoryUnwrapper`. */
export const INFERRED_UNWRAP_SOURCE = 'inferred from adjacent frames';
/** Crossing records kept for random access behind the integration frontier. */
export const DEFAULT_UNWRAP_EVENT_BYTES = 256 * 1024 ** 2;
export const MAX_SMOOTHING_WINDOW = 50;
/** Each trajectory-line vertex costs 16 bytes in the Worker result and the
 * WebGL buffer (x, y, z and the time parameter as float32). Two million
 * vertices bound both copies to 32 MiB, plus the same again while building. */
export const MAX_TRAJECTORY_LINE_VERTICES = 2_000_000;
export const TRAJECTORY_LINE_DEFAULTS = Object.freeze({ visible: true, color: '#ff9f1c', width: 2, colorByTime: false, colorScheme: 'viridis' });
/** Line widths are CSS pixels in the viewport. */
export const MIN_TRAJECTORY_LINE_WIDTH = 0.5;
export const MAX_TRAJECTORY_LINE_WIDTH = 16;

function idKey(id) {
  if (typeof id === 'number') return id;
  const value = canonicalAtomNumber(id);
  return value === undefined ? String(id) : value;
}

function sameIds(left, right) {
  if (!left || left.length !== right.length) return false;
  for (let index = 0; index < right.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function copyIds(ids) {
  return ArrayBuffer.isView(ids) ? ids.slice() : Array.from(ids);
}

// Integer IDs below this bound use a typed lookup table (4 bytes per possible
// ID) instead of a hash map; larger or textual IDs fall back to a Map.
const DENSE_ID_MINIMUM = 1 << 21;
const denseIdLimit = count => Math.max(DENSE_ID_MINIMUM, count * 4);
const denseValue = id => {
  const value = typeof id === 'number' ? id : canonicalAtomNumber(id);
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : -1;
};

/** ID → index lookup assigned in insertion order. */
class IdIndex {
  constructor() { this.dense = new Int32Array(0); this.map = null; this.size = 0; }

  get(id) {
    if (this.map) return this.map.get(idKey(id));
    const value = denseValue(id);
    const index = value >= 0 && value < this.dense.length ? this.dense[value] : -1;
    return index >= 0 ? index : undefined;
  }

  add(id) {
    const index = this.size++;
    if (!this.map) {
      const value = denseValue(id);
      if (value >= 0 && value < denseIdLimit(this.size)) {
        if (value >= this.dense.length) {
          const grown = new Int32Array(Math.min(denseIdLimit(this.size), Math.max(value + 1, this.dense.length * 2, 1024))).fill(-1);
          grown.set(this.dense);
          this.dense = grown;
        }
        this.dense[value] = index;
        return index;
      }
      // Every earlier key was a dense integer, which is its own map key.
      this.map = new Map();
      for (let key = 0; key < this.dense.length; key += 1) if (this.dense[key] >= 0) this.map.set(key, this.dense[key]);
      this.dense = null;
    }
    this.map.set(idKey(id), index);
    return index;
  }

  /** A lookup over one frame's IDs; duplicate IDs are rejected. */
  static of(ids) {
    const index = new IdIndex();
    for (const id of ids) {
      if (index.get(id) !== undefined) throw new Error(`Atom ID ${String(id)} occurs twice in one frame.`);
      index.add(id);
    }
    return index;
  }
}

function checkCoordinates(frame, label) {
  const count = frame?.ids?.length;
  if (!Number.isSafeInteger(count) || count < 1 || frame.fractional?.length !== count * 3) {
    throw new Error(`${label} requires one ID and three reduced coordinates per atom.`);
  }
  if (frame.cell?.pbc?.length !== 3 || frame.cell.vectors?.length !== 9) throw new Error(`${label} requires a simulation cell.`);
  return count;
}

/**
 * Infer periodic image counts from wrapped coordinates, integrating frames in
 * their trajectory order. Between consecutive frames each atom moves by the
 * minimum-image reduced displacement on every periodic axis, so crossings in
 * either direction, triclinic cells and changing cells are handled per axis.
 * Atoms are matched by ID; an atom absent from some frames is compared with
 * its last observed position. State is incremental: appending frame k never
 * revisits frames before it, and frames behind the frontier are recovered
 * from the recorded crossings rather than reprocessed.
 */
export class TrajectoryUnwrapper {
  constructor({ eventBudgetBytes = DEFAULT_UNWRAP_EVENT_BYTES } = {}) {
    if (!Number.isFinite(eventBudgetBytes) || eventBudgetBytes < 0) throw new Error('The unwrap event budget must be nonnegative.');
    this.eventBudgetBytes = eventBudgetBytes;
    this.frontier = -1;
    this.slotCount = 0;
    this.capacity = 0;
    this.index = new IdIndex();
    this.last = new Float64Array(0);
    this.image = new Int32Array(0);
    this.stamp = new Int32Array(0);
    this.mark = new Int32Array(0);
    this.events = new Map();
    this.eventBytes = 0;
    this.oldestEvents = 1;
    this.previous = null;
    this.frameStamp = 0;
  }

  /** Frames before this index can no longer be reconstructed from the log. */
  get reconstructibleFrom() { return Math.max(0, this.oldestEvents - 1); }

  canReconstruct(index) {
    return Number.isInteger(index) && index >= this.reconstructibleFrom && index <= this.frontier;
  }

  grow(count) {
    if (count <= this.capacity) return;
    const capacity = Math.max(count, Math.ceil(this.capacity * 1.5), 1024);
    const last = new Float64Array(capacity * 3), image = new Int32Array(capacity * 3);
    const stamp = new Int32Array(capacity), mark = new Int32Array(capacity);
    last.set(this.last); image.set(this.image); stamp.set(this.stamp); mark.set(this.mark);
    Object.assign(this, { last, image, stamp, mark, capacity });
  }

  /** Slots are assigned in first-seen order. A frame in the previous
   * frame's order reuses its slots without any lookup. */
  mapIds(ids, { create = false } = {}) {
    const count = ids.length;
    if (this.previous && sameIds(this.previous.ids, ids)) return this.previous.slots;
    const slots = new Int32Array(count);
    for (let index = 0; index < count; index += 1) {
      let slot = this.index.get(ids[index]);
      if (slot === undefined) {
        if (!create) throw new Error(`Atom ID ${String(ids[index])} has not been integrated.`);
        slot = this.index.add(ids[index]);
        this.slotCount = slot + 1;
        this.grow(this.slotCount);
        this.stamp[slot] = -1;
      }
      slots[index] = slot;
    }
    return slots;
  }

  append(index, frame) {
    if (index !== this.frontier + 1) throw new Error(`Unwrapping must continue at frame ${this.frontier + 2}; received frame ${index + 1}.`);
    const count = checkCoordinates(frame, 'Trajectory unwrapping');
    const { ids, fractional } = frame, pbc = frame.cell.pbc;
    const slots = this.mapIds(ids, { create: true });
    // Validate before changing any state, so a malformed frame cannot leave
    // the integration half applied.
    const stamp = ++this.frameStamp;
    for (let atom = 0; atom < count; atom += 1) {
      const slot = slots[atom];
      if (this.mark[slot] === stamp) throw new Error(`Trajectory unwrapping found atom ID ${String(ids[atom])} twice in frame ${index + 1}.`);
      this.mark[slot] = stamp;
      for (let axis = 0; axis < 3; axis += 1) {
        if (!Number.isFinite(fractional[atom * 3 + axis])) throw new Error(`Trajectory unwrapping found a non-finite coordinate in frame ${index + 1}.`);
      }
    }
    let events = new Int32Array(64), eventCount = 0;
    for (let atom = 0; atom < count; atom += 1) {
      const slot = slots[atom], base = slot * 3, offset = atom * 3;
      // A first appearance starts at image zero; later frames step from the
      // last observed position, even after frames in which the atom was absent.
      const fresh = this.stamp[slot] < 0;
      this.stamp[slot] = stamp;
      for (let axis = 0; axis < 3; axis += 1) {
        const value = fractional[offset + axis];
        if (!fresh && pbc[axis]) {
          const shift = Math.round(value - this.last[base + axis]);
          if (shift !== 0) {
            // Int32 wraps only after two billion crossings of one axis.
            this.image[base + axis] -= shift;
            if (eventCount + 2 > events.length) { const grown = new Int32Array(events.length * 2); grown.set(events); events = grown; }
            events[eventCount++] = base + axis;
            events[eventCount++] = -shift;
          }
        }
        this.last[base + axis] = value;
      }
    }
    this.previous = { ids: copyIds(ids), slots };
    this.frontier = index;
    if (index > 0) {
      const record = events.slice(0, eventCount);
      this.events.set(index, record);
      this.eventBytes += record.byteLength;
      while (this.eventBytes > this.eventBudgetBytes && this.oldestEvents <= this.frontier) {
        this.eventBytes -= this.events.get(this.oldestEvents)?.byteLength ?? 0;
        this.events.delete(this.oldestEvents);
        this.oldestEvents += 1;
      }
    }
    return eventCount / 2;
  }

  /** Image counts by slot at a frame behind the frontier: undo later crossings. */
  slotImagesAt(index) {
    if (!this.canReconstruct(index)) throw new Error(`Frame ${index + 1} is outside the retained unwrapping history.`);
    if (index === this.frontier) return this.image;
    const images = this.image.slice(0, this.slotCount * 3);
    for (let frame = this.frontier; frame > index; frame -= 1) {
      const events = this.events.get(frame);
      for (let cursor = 0; cursor < events.length; cursor += 2) images[events[cursor]] -= events[cursor + 1];
    }
    return images;
  }

  /** Image flags for the given IDs at an integrated frame, in their order. */
  imageFlags(index, ids) {
    const slots = this.mapIds(ids), images = this.slotImagesAt(index);
    const output = new Int32Array(ids.length * 3);
    for (let atom = 0; atom < slots.length; atom += 1) {
      const base = slots[atom] * 3;
      output[atom * 3] = images[base]; output[atom * 3 + 1] = images[base + 1]; output[atom * 3 + 2] = images[base + 2];
    }
    return output;
  }
}

/** Cartesian coordinates of wrapped reduced coordinates moved by whole images. */
export function inferredUnwrappedPositions(fractional, imageFlags, cell) {
  if (imageFlags.length !== fractional.length) throw new Error('Image flags do not match the coordinate count.');
  const unwrapped = new Float64Array(fractional.length);
  for (let index = 0; index < unwrapped.length; index += 1) unwrapped[index] = fractional[index] + imageFlags[index];
  return fractionalToCartesian(unwrapped, cell);
}

/** Map every center atom to a row of another frame by stable ID (-1 if absent). */
export function matchAtomRows(centerIds, otherIds, { centerIdSource, otherIdSource } = {}) {
  const count = centerIds.length, rows = new Int32Array(count);
  if (sameIds(centerIds, otherIds)) {
    for (let atom = 0; atom < count; atom += 1) rows[atom] = atom;
    return rows;
  }
  if ((centerIdSource === 'row-order' || otherIdSource === 'row-order') && centerIds.length !== otherIds.length) {
    throw new Error('Frames without explicit atom IDs must contain the same atoms in the same order.');
  }
  const lookup = IdIndex.of(otherIds);
  for (let atom = 0; atom < count; atom += 1) rows[atom] = lookup.get(centerIds[atom]) ?? -1;
  return rows;
}

/**
 * Average one frame's coordinates over a window of frames. Every frame is
 * added in ascending frame order (including the center), so the sums and
 * therefore the results are reproducible. Displacements are taken relative
 * to the center in reduced coordinates with the minimum image on its periodic
 * axes, so a vibrating atom near a boundary averages to a point beside it,
 * not to the middle of the cell. The cell vectors and origin are averaged
 * with equal weights; the averaged reduced coordinates are placed in that
 * averaged cell. Atoms absent from a frame are averaged over the frames that
 * contain them.
 */
export class SmoothingAccumulator {
  constructor(center) {
    this.count = checkCoordinates(center, 'Trajectory smoothing');
    this.center = center;
    this.sums = new Float64Array(this.count * 3);
    this.counts = new Uint32Array(this.count).fill(1);
    this.vectors = new Float64Array(9);
    this.origin = new Float64Array(3);
    this.frames = 0;
    this.neighbors = 0;
  }

  add(frame, { center = false } = {}) {
    for (let index = 0; index < 9; index += 1) this.vectors[index] += frame.cell.vectors[index];
    for (let index = 0; index < 3; index += 1) this.origin[index] += frame.cell.origin[index];
    this.frames += 1;
    if (center) return;
    checkCoordinates(frame, 'Trajectory smoothing');
    this.neighbors += 1;
    const rows = matchAtomRows(this.center.ids, frame.ids,
      { centerIdSource: this.center.idSource, otherIdSource: frame.idSource });
    const pbc = this.center.cell.pbc, reference = this.center.fractional, other = frame.fractional;
    for (let atom = 0; atom < this.count; atom += 1) {
      const row = rows[atom];
      if (row < 0) continue;
      this.counts[atom] += 1;
      for (let axis = 0; axis < 3; axis += 1) {
        let displacement = other[row * 3 + axis] - reference[atom * 3 + axis];
        if (pbc[axis]) displacement -= Math.round(displacement);
        this.sums[atom * 3 + axis] += displacement;
      }
    }
  }

  /** Coordinates and cell for the smoothed center. A window that contains
   * only the center returns its own arrays unchanged. */
  finish({ imageFlags = this.center.imageFlags ?? null, unwrappedPositions = this.center.unwrappedPositions ?? null } = {}) {
    const center = this.center;
    if (!this.neighbors) {
      return { fractional: center.fractional, positions: center.positions ?? fractionalToCartesian(center.fractional, center.cell),
        cell: center.cell, imageFlags, unwrappedPositions, frames: Math.max(1, this.frames), unchanged: true };
    }
    if (this.frames < 1) throw new Error('Trajectory smoothing requires the center frame.');
    const cell = createCell({ origin: Array.from(this.origin, value => value / this.frames),
      vectors: Array.from(this.vectors, value => value / this.frames), pbc: center.cell.pbc, triclinic: center.cell.triclinic });
    const pbc = center.cell.pbc, count = this.count;
    let centerImages = imageFlags;
    if (!centerImages && unwrappedPositions) {
      const reduced = cartesianToFractional(unwrappedPositions, center.cell, new Float64Array(count * 3));
      centerImages = new Int32Array(count * 3);
      for (let index = 0; index < reduced.length; index += 1) {
        centerImages[index] = pbc[index % 3] ? Math.round(reduced[index] - center.fractional[index]) : 0;
      }
    }
    const fractional = new Float32Array(count * 3), continuous = centerImages ? new Float64Array(count * 3) : null;
    const flags = centerImages ? new Int32Array(count * 3) : null;
    for (let atom = 0; atom < count; atom += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const index = atom * 3 + axis, raw = center.fractional[index];
        const mean = raw + this.sums[index] / this.counts[atom];
        // Keep the center's image convention: a wrapped center stays wrapped.
        const shift = pbc[axis] ? Math.floor(mean) - Math.floor(raw) : 0;
        fractional[index] = mean - shift;
        if (continuous) {
          continuous[index] = mean + centerImages[index];
          flags[index] = centerImages[index] + shift;
        }
      }
    }
    return {
      fractional,
      positions: fractionalToCartesian(fractional, cell),
      cell,
      imageFlags: imageFlags ? flags : null,
      unwrappedPositions: continuous ? fractionalToCartesian(continuous, cell) : null,
      frames: this.frames,
      unchanged: false,
    };
  }
}

/** Smooth `center` with the other frames of its window (any order). */
export function smoothTrajectoryFrame(center, others = [], options = {}) {
  const accumulator = new SmoothingAccumulator(center);
  const frames = [{ frame: center, center: true, index: center.frameIndex ?? 0 },
    ...others.map(frame => ({ frame, center: false, index: frame.frameIndex ?? 0 }))]
    .sort((left, right) => left.index - right.index || Number(right.center) - Number(left.center));
  for (const entry of frames) accumulator.add(entry.frame, { center: entry.center });
  return accumulator.finish(options);
}

/** The inclusive window of frame indices, truncated at the trajectory ends. */
export function smoothingWindow(index, window, frameCount) {
  if (!Number.isInteger(window) || window < 0 || window > MAX_SMOOTHING_WINDOW) {
    throw new Error(`The smoothing window must be an integer from 0 to ${MAX_SMOOTHING_WINDOW}.`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= frameCount) throw new Error(`Frame ${index + 1} is outside the trajectory.`);
  return { first: Math.max(0, index - window), last: Math.min(frameCount - 1, index + window) };
}

/** Sampled frame indices: first, first + stride, … up to and including last. */
export function trajectoryLineFrames(first, last, stride) {
  if (![first, last, stride].every(Number.isSafeInteger) || first < 0 || last < first || stride < 1) {
    throw new Error('Trajectory lines require a frame range with first ≤ last and a positive stride.');
  }
  return Array.from({ length: Math.floor((last - first) / stride) + 1 }, (_, sample) => first + sample * stride);
}

/** Check the vertex budget before any frame is read. */
export function trajectoryLineVertexCount(atomCount, sampleCount, maxVertices = MAX_TRAJECTORY_LINE_VERTICES) {
  const vertices = atomCount * sampleCount;
  if (!Number.isSafeInteger(vertices) || vertices > maxVertices) {
    throw new RangeError(`Trajectory lines would need ${atomCount.toLocaleString('en-US')} atoms × ${sampleCount.toLocaleString('en-US')} frames = ${vertices.toLocaleString('en-US')} points; the limit is ${maxVertices.toLocaleString('en-US')}. Select fewer atoms, a shorter range or a larger frame step.`);
  }
  return vertices;
}

/**
 * Continuous paths of selected atoms over sampled frames. A frame's own
 * unwrapped coordinates (image flags or unwrapped columns) are used where
 * present; otherwise each step adds the minimum-image reduced displacement
 * since the previous sample of that atom. Samples must be added in order.
 */
export class TrajectoryLineBuilder {
  constructor(atomIds, frames, { maxVertices = MAX_TRAJECTORY_LINE_VERTICES } = {}) {
    const ids = Array.from(atomIds ?? []);
    if (!ids.length) throw new Error('Choose at least one atom for trajectory lines.');
    if (!Array.isArray(frames) || !frames.length) throw new Error('Trajectory lines require at least one sampled frame.');
    trajectoryLineVertexCount(ids.length, frames.length, maxVertices);
    this.atomIds = ids;
    this.frames = frames;
    this.lookup = new IdIndex();
    for (const id of ids) {
      if (this.lookup.get(id) !== undefined) throw new Error(`Atom ID ${String(id)} is listed twice.`);
      this.lookup.add(id);
    }
    const atoms = ids.length, samples = frames.length;
    this.points = new Float64Array(atoms * samples * 3);
    this.present = new Uint8Array(atoms * samples);
    this.wrapped = new Float64Array(atoms * 3);
    this.continuous = new Float64Array(atoms * 3);
    this.started = new Uint8Array(atoms);
    this.next = 0;
    this.previous = null;
  }

  rowsFor(ids) {
    if (this.previous && sameIds(this.previous.ids, ids)) return this.previous.rows;
    const rows = new Int32Array(this.atomIds.length).fill(-1);
    for (let row = 0; row < ids.length; row += 1) {
      const atom = this.lookup.get(ids[row]);
      if (atom === undefined) continue;
      if (rows[atom] >= 0) throw new Error(`Atom ID ${String(ids[row])} occurs twice in one frame.`);
      rows[atom] = row;
    }
    this.previous = { ids: copyIds(ids), rows };
    return rows;
  }

  add(frame) {
    if (this.next >= this.frames.length) throw new Error('All trajectory-line samples have already been added.');
    checkCoordinates(frame, 'Trajectory lines');
    const sample = this.next++, samples = this.frames.length;
    const rows = this.rowsFor(frame.ids), cell = frame.cell, pbc = cell.pbc, h = cell.vectors, origin = cell.origin;
    const unwrapped = frame.unwrappedPositions?.length === frame.fractional.length ? frame.unwrappedPositions : null;
    const inverse = unwrapped ? invert3(h) : null;
    const u = [0, 0, 0];
    for (let atom = 0; atom < rows.length; atom += 1) {
      const row = rows[atom];
      if (row < 0) continue;
      const base = atom * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        const value = frame.fractional[row * 3 + axis];
        if (unwrapped) {
          const x = unwrapped[row * 3] - origin[0], y = unwrapped[row * 3 + 1] - origin[1], z = unwrapped[row * 3 + 2] - origin[2];
          u[axis] = x * inverse[axis] + y * inverse[3 + axis] + z * inverse[6 + axis];
        } else if (!this.started[atom]) u[axis] = value;
        else {
          let displacement = value - this.wrapped[base + axis];
          if (pbc[axis]) displacement -= Math.round(displacement);
          u[axis] = this.continuous[base + axis] + displacement;
        }
        this.wrapped[base + axis] = value;
        this.continuous[base + axis] = u[axis];
      }
      this.started[atom] = 1;
      const point = (atom * samples + sample) * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        this.points[point + axis] = unwrapped ? unwrapped[row * 3 + axis]
          : origin[axis] + u[0] * h[axis] + u[1] * h[3 + axis] + u[2] * h[6 + axis];
      }
      this.present[atom * samples + sample] = 1;
    }
  }

  /** Vertices are (x, y, z, t). t is the normalized frame position; the last
   * vertex of each polyline stores −(1 + t), so no segment joins two atoms. */
  finish() {
    const atoms = this.atomIds.length, samples = this.frames.length;
    const span = this.frames[samples - 1] - this.frames[0];
    const times = this.frames.map(frame => span > 0 ? (frame - this.frames[0]) / span : 0);
    let vertexCount = 0;
    const lineAtomIds = [], lineOffsets = [0];
    for (let atom = 0; atom < atoms; atom += 1) {
      let present = 0;
      for (let sample = 0; sample < samples; sample += 1) present += this.present[atom * samples + sample];
      if (present < 2) continue;
      vertexCount += present;
      lineAtomIds.push(this.atomIds[atom]);
      lineOffsets.push(vertexCount);
    }
    const vertices = new Float32Array(vertexCount * 4);
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
    let cursor = 0;
    for (let atom = 0; atom < atoms; atom += 1) {
      let present = 0;
      for (let sample = 0; sample < samples; sample += 1) present += this.present[atom * samples + sample];
      if (present < 2) continue;
      let written = 0;
      for (let sample = 0; sample < samples; sample += 1) {
        if (!this.present[atom * samples + sample]) continue;
        written += 1;
        const point = (atom * samples + sample) * 3;
        for (let axis = 0; axis < 3; axis += 1) {
          const value = this.points[point + axis];
          vertices[cursor * 4 + axis] = value;
          minimum[axis] = Math.min(minimum[axis], value);
          maximum[axis] = Math.max(maximum[axis], value);
        }
        vertices[cursor * 4 + 3] = written === present ? -1 - times[sample] : times[sample];
        cursor += 1;
      }
    }
    const missing = this.atomIds.filter((_, atom) => !this.started[atom]);
    return {
      vertices, vertexCount, lineCount: lineAtomIds.length,
      lineAtomIds, lineOffsets: Uint32Array.from(lineOffsets),
      frames: Int32Array.from(this.frames), missingAtomIds: missing.slice(0, 32), missingCount: missing.length,
      bounds: vertexCount ? { minimum, maximum } : null,
    };
  }
}

/** Decode a vertex time written by `TrajectoryLineBuilder.finish`. */
export function trajectoryVertexTime(value) {
  return value < 0 ? -value - 1 : value;
}
