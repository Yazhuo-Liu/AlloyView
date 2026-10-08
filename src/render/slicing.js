import { invert3 } from '../data/model.js';
import { cross, dot, normalize, subtract } from './math.js';

export const MAX_SLICES = 16;
// A slab is two opposite half-spaces, so shaders reserve two per slice.
export const MAX_SLICE_PLANES = MAX_SLICES * 2;
export const SLICE_EPSILON = 1e-5;
// Lengths are in the structure's unit (Å). New planes sweep in 1 Å steps and
// new slabs are 2 Å thick until the user or (h k l) indices choose otherwise.
export const DEFAULT_SLICE_STEP = 1;
export const DEFAULT_SLAB_THICKNESS = 2;
export const MIN_SLICE_LENGTH = 1e-6;
export const MAX_SLICE_LENGTH = 1e15;
export const MAX_MILLER_INDEX = 1_000_000;

const CELL_EDGES = [
  [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
  [2, 6], [4, 5], [4, 6], [3, 7], [5, 7], [6, 7],
];

// The normal is Cartesian and normalized independently of the position. A
// position of d therefore always means n·r = d, in the structure's length unit.
export function normalizeSliceNormal(values) {
  if (!values || values.length !== 3 || Array.from(values).some(value => !Number.isFinite(value))) {
    throw new Error('A slice normal requires three finite numbers.');
  }
  const maximum = Math.max(...Array.from(values, Math.abs));
  if (maximum < 1e-12) throw new Error('A slice normal must have a nonzero length.');
  const scaled = Array.from(values, value => value / maximum);
  const length = Math.hypot(...scaled);
  return scaled.map(value => value / length);
}

export function validateSlice(slice, index = 0) {
  if (!slice || typeof slice !== 'object') throw new Error('A slice must be an object.');
  const normal = normalizeSliceNormal(slice.normal);
  if (!Number.isFinite(slice.position)) throw new Error('The slice position must be a finite number.');
  const side = slice.side ?? 'negative';
  if (side !== 'negative' && side !== 'positive') throw new Error('Choose the negative or positive side of the slice.');
  if (slice.enabled !== undefined && typeof slice.enabled !== 'boolean') throw new Error('Slice enabled must be true or false.');
  const id = slice.id ?? `slice-${index}`;
  const name = slice.name ?? `Slice ${index}`;
  if (typeof id !== 'string' || !id.trim() || id.length > 128) throw new Error('A slice requires a nonempty identifier.');
  if (typeof name !== 'string' || !name.trim() || name.length > 128) throw new Error('A slice name must contain 1 to 128 characters.');
  if (slice.slab !== undefined && typeof slice.slab !== 'boolean') throw new Error('Slice slab must be true or false.');
  const thickness = validateSliceLength(slice.thickness ?? DEFAULT_SLAB_THICKNESS, 'slab thickness');
  return { id, name, normal, position: slice.position, enabled: slice.enabled ?? true, side, slab: slice.slab ?? false, thickness };
}

/** Steps and slab thicknesses are positive lengths in Å. */
export function validateSliceLength(value, label = 'length') {
  if (typeof value !== 'number' || !(value >= MIN_SLICE_LENGTH && value <= MAX_SLICE_LENGTH)) {
    throw new Error(`The ${label} must be a number from ${MIN_SLICE_LENGTH} to ${MAX_SLICE_LENGTH} Å.`);
  }
  return value;
}

export function validateSlices(slices) {
  if (!Array.isArray(slices)) throw new Error('Slices must be an array.');
  if (slices.length > MAX_SLICES) throw new Error(`Use at most ${MAX_SLICES} slices.`);
  const normalized = slices.map(validateSlice);
  if (new Set(normalized.map(slice => slice.id)).size !== normalized.length) throw new Error('Slice identifiers must be unique.');
  return normalized;
}

// Accepts normalized slices, as returned by validateSlice(s). Rendering and
// picking keep the atom when its center belongs to every enabled half-space,
// or lies within half a slab's thickness of a slab's plane.
export function pointVisible(point, slices, epsilon = SLICE_EPSILON) {
  for (const slice of slices) {
    if (!slice.enabled) continue;
    const distance = dot(slice.normal, point) - slice.position;
    if (slice.slab ? Math.abs(distance) > slice.thickness / 2 + epsilon
      : slice.side === 'positive' ? distance < -epsilon : distance > epsilon) return false;
  }
  return true;
}

/** Enabled slices as half-spaces n · r ≤ w, the form every shader tests. A
 * slab keeping |n · r − d| ≤ t/2 becomes n · r ≤ d + t/2 and −n · r ≤ t/2 − d,
 * so several slabs and half-spaces still intersect. */
export function sliceHalfSpaces(slices) {
  const halfSpaces = [];
  for (const slice of slices) {
    if (!slice.enabled) continue;
    if (slice.slab) {
      const half = slice.thickness / 2;
      halfSpaces.push({ normal: [...slice.normal], offset: slice.position + half });
      halfSpaces.push({ normal: slice.normal.map(value => value * -1), offset: (slice.position - half) * -1 });
    } else {
      const direction = slice.side === 'positive' ? -1 : 1;
      halfSpaces.push({ normal: slice.normal.map(value => value * direction), offset: slice.position * direction });
    }
  }
  return halfSpaces;
}

/** Move a plane by whole steps along its normal without changing its side. */
export function stepSlicePosition(position, step, count = 1) {
  if (!Number.isFinite(position) || !Number.isInteger(count)) throw new Error('Step a finite plane position by whole steps.');
  const next = position + count * validateSliceLength(step, 'step');
  if (!Number.isFinite(next)) throw new Error('The stepped plane position is not finite.');
  return next;
}

export function flippedSliceSide(side) {
  return side === 'positive' ? 'negative' : 'positive';
}

export function validateMillerIndices(indices) {
  if (!indices || indices.length !== 3 || !Array.from(indices).every(value =>
    Number.isSafeInteger(value) && Math.abs(value) <= MAX_MILLER_INDEX)) {
    throw new Error(`Miller indices must be three integers from -${MAX_MILLER_INDEX} to ${MAX_MILLER_INDEX}.`);
  }
  if (Array.from(indices).every(value => value === 0)) throw new Error('Miller indices cannot all be zero.');
  return Array.from(indices, value => value + 0);
}

/** The (h k l) lattice planes of a cell with rows a₁, a₂, a₃ are
 * G · (r − o) = m for integers m, where G = h b₁ + k b₂ + l b₃ and
 * bᵢ · aⱼ = δᵢⱼ (no 2π factor). The bᵢ are the columns of the inverse cell
 * matrix, which holds for triclinic cells. The planes' unit normal is G/|G|
 * and their spacing is d = 1/|G|, in the cell's length unit (Å). */
export function millerPlane(indices, cellVectors) {
  const [h, k, l] = validateMillerIndices(indices);
  if (!cellVectors || cellVectors.length !== 9) throw new Error('Miller indices require a cell with three vectors.');
  const inverse = invert3(cellVectors);
  const reciprocal = [0, 1, 2].map(axis => inverse[axis * 3] * h + inverse[axis * 3 + 1] * k + inverse[axis * 3 + 2] * l);
  const length = Math.hypot(...reciprocal);
  if (!Number.isFinite(length) || !(length > 0)) throw new Error('These Miller indices do not define a plane in this cell.');
  return { indices: [h, k, l], normal: reciprocal.map(value => value / length), spacing: 1 / length, reciprocal };
}

/** Position d = n · o + m d_hkl of the lattice plane nearest a point. */
export function nearestLatticePlanePosition({ normal, spacing }, origin, point) {
  const base = dot(normal, origin);
  return base + Math.round((dot(normal, point) - base) / spacing) * spacing;
}

export function projectBoundsOnNormal(normal, { minimum, maximum }) {
  const unit = normalizeSliceNormal(normal);
  let lower = 0, upper = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    const first = minimum[axis] * unit[axis], last = maximum[axis] * unit[axis];
    lower += Math.min(first, last);
    upper += Math.max(first, last);
  }
  return { minimum: lower, maximum: upper };
}

// The vertex order is the bit-mask order used by data/model.cellVertices, so
// intersecting the actual twelve cell edges also handles a tilted cell.
export function planeCellPolygon(slice, vertices) {
  if (!vertices || vertices.length !== 24) return [];
  const { normal, position } = validateSlice(slice);
  const points = Array.from({ length: 8 }, (_, index) => Array.from(vertices.slice(index * 3, index * 3 + 3)));
  const distances = points.map(point => dot(normal, point) - position);
  const extent = Math.max(...[0, 1, 2].map(axis => Math.max(...points.map(point => point[axis]))
    - Math.min(...points.map(point => point[axis]))));
  const epsilon = Math.max(1, extent) * 1e-8;
  const intersections = [];
  const include = point => {
    if (!intersections.some(existing => Math.hypot(...subtract(existing, point)) <= epsilon)) intersections.push(point);
  };
  for (const [a, b] of CELL_EDGES) {
    const first = distances[a], last = distances[b];
    if (Math.abs(first) <= epsilon) include(points[a]);
    if (Math.abs(last) <= epsilon) include(points[b]);
    if ((first < -epsilon && last > epsilon) || (first > epsilon && last < -epsilon)) {
      const fraction = first / (first - last);
      include(points[a].map((value, axis) => value + fraction * (points[b][axis] - value)));
    }
  }
  if (intersections.length < 3) return [];
  const center = [0, 1, 2].map(axis => intersections.reduce((sum, point) => sum + point[axis], 0) / intersections.length);
  const referenceAxis = normal.reduce((smallest, value, axis) => Math.abs(value) < Math.abs(normal[smallest]) ? axis : smallest, 0);
  const reference = [0, 0, 0];
  reference[referenceAxis] = 1;
  const horizontal = normalize(cross(normal, reference)), vertical = cross(normal, horizontal);
  return intersections.sort((a, b) => {
    const relativeA = subtract(a, center), relativeB = subtract(b, center);
    return Math.atan2(dot(relativeA, vertical), dot(relativeA, horizontal))
      - Math.atan2(dot(relativeB, vertical), dot(relativeB, horizontal));
  });
}

export function planeBoxPolygon(slice, { minimum, maximum }) {
  const vertices = new Float64Array(24);
  for (let mask = 0; mask < 8; mask += 1) {
    for (let axis = 0; axis < 3; axis += 1) vertices[mask * 3 + axis] = mask & (1 << axis) ? maximum[axis] : minimum[axis];
  }
  return planeCellPolygon(slice, vertices);
}

// Sutherland–Hodgman against one half-space n · r ≤ w. Boundary points within
// epsilon are kept, matching the atom test.
function clipPolygon(polygon, { normal, offset }, epsilon) {
  const clipped = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index], next = polygon[(index + 1) % polygon.length];
    const first = dot(normal, current) - offset, last = dot(normal, next) - offset;
    if (first <= epsilon) clipped.push(current);
    if ((first < -epsilon && last > epsilon) || (first > epsilon && last < -epsilon)) {
      const fraction = first / (first - last);
      clipped.push(current.map((value, axis) => value + fraction * (next[axis] - value)));
    }
  }
  return clipped.length >= 3 ? clipped : [];
}

/** Where each enabled plane, or both faces of a slab, meets the cell, clipped
 * to the region kept by every other enabled slice. */
export function sliceOutlinePolygons(slices, vertices, epsilon = SLICE_EPSILON) {
  const halfSpaces = sliceHalfSpaces(slices);
  const polygons = [];
  halfSpaces.forEach(({ normal, offset }, index) => {
    let polygon = planeCellPolygon({ normal, position: offset }, vertices);
    for (let other = 0; other < halfSpaces.length && polygon.length; other += 1) {
      if (other !== index) polygon = clipPolygon(polygon, halfSpaces[other], epsilon);
    }
    if (polygon.length >= 3) polygons.push(polygon);
  });
  return polygons;
}

/** Closed outlines as GL_LINES endpoint pairs. */
export function sliceOutlineSegments(slices, vertices) {
  const polygons = sliceOutlinePolygons(slices, vertices);
  const segments = new Float32Array(polygons.reduce((sum, polygon) => sum + polygon.length, 0) * 6);
  let cursor = 0;
  for (const polygon of polygons) {
    polygon.forEach((point, index) => {
      segments.set(point, cursor);
      segments.set(polygon[(index + 1) % polygon.length], cursor + 3);
      cursor += 6;
    });
  }
  return segments;
}
