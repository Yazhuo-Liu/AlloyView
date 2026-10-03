import { cross, dot, normalize, subtract } from './math.js';

export const MAX_SLICES = 16;
export const SLICE_EPSILON = 1e-5;

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
  return { id, name, normal, position: slice.position, enabled: slice.enabled ?? true, side };
}

export function validateSlices(slices) {
  if (!Array.isArray(slices)) throw new Error('Slices must be an array.');
  if (slices.length > MAX_SLICES) throw new Error(`Use at most ${MAX_SLICES} slices.`);
  const normalized = slices.map(validateSlice);
  if (new Set(normalized.map(slice => slice.id)).size !== normalized.length) throw new Error('Slice identifiers must be unique.');
  return normalized;
}

// Accepts normalized slices, as returned by validateSlice(s). Rendering and
// picking keep the atom when its center belongs to every enabled half-space.
export function pointVisible(point, slices, epsilon = SLICE_EPSILON) {
  for (const slice of slices) {
    if (!slice.enabled) continue;
    const distance = dot(slice.normal, point) - slice.position;
    if (slice.side === 'positive' ? distance < -epsilon : distance > epsilon) return false;
  }
  return true;
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
