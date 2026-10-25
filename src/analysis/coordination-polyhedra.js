import { NeighborSearch, NeighborBuffer, atomRange } from './neighbors.js';

export const MAX_POLYHEDRON_NEIGHBORS = 64;
export const MAX_POLYHEDRA = 100_000;
export const MAX_POLYHEDRA_BYTES = 128 * 1024 * 1024;
const MAX_CANDIDATES = 4096;
const EPSILON = 128 * Number.EPSILON;
const MIN_RELIABLE_THICKNESS = 1e-7;
const MAX_QUERY_IMAGE_TESTS = 2_000_000;
const MAX_QUERY_BINS = 250_000;

export function validateCoordinationPolyhedraParameters({ cutoff, centerTypes = null, neighborTypes = null,
  maxCells = MAX_POLYHEDRA } = {}) {
  if (!Number.isFinite(cutoff) || cutoff <= 0 || !Number.isFinite(cutoff * cutoff)) {
    throw new Error('Coordination polyhedra need a positive finite cutoff.');
  }
  for (const [name, types] of [['Center', centerTypes], ['Neighbor', neighborTypes]]) {
    if (types !== null && (!Array.isArray(types) || types.length > 4096
      || types.some(type => !Number.isSafeInteger(type) || type < 0) || new Set(types).size !== types.length)) {
      throw new Error(`${name} types must be distinct nonnegative integer type IDs, or all types.`);
    }
  }
  if (!Number.isInteger(maxCells) || maxCells < 1 || maxCells > MAX_POLYHEDRA) {
    throw new Error(`Coordination polyhedra are limited to ${MAX_POLYHEDRA.toLocaleString('en-US')} cells.`);
  }
}

/** Convex hulls of the selected neighbors, not Voronoi/Wigner-Seitz cells.
 * Vertices are local Cartesian vectors anchored at the original center atom.
 * Periodic copies remain distinct neighbors, including same-ID images.
 * The caller's frame and a resident shared neighbor index stay immutable. */
export function calculateCoordinationPolyhedra(frame, { cutoff, centerTypes = null, neighborTypes = null,
  maxCells = MAX_POLYHEDRA, onPhase = () => {}, onAtoms = () => {}, signal, ...range } = {}) {
  const startedAt = performance.now();
  validateCoordinationPolyhedraParameters({ cutoff, centerTypes, neighborTypes, maxCells });
  const count = frame.fractional.length / 3, { startAtom, endAtom } = atomRange(count, range);
  if (!ArrayBuffer.isView(frame.types) || frame.types instanceof DataView || frame.types.length !== count) {
    throw new Error('Coordination polyhedra require one element type per atom.');
  }
  throwIfAborted(signal);
  const centers = centerTypes === null ? null : new Set(centerTypes), neighbors = neighborTypes === null ? null : new Set(neighborTypes);
  onPhase('indexing');
  const search = frame.neighborSearch ?? new NeighborSearch(frame), scratch = new NeighborBuffer();
  const searchGuard = createSearchGuard(search, cutoff);
  const coordination = new Uint32Array(endAtom - startAtom);
  const volumes = new Float64Array(endAtom - startAtom).fill(NaN), surfaceAreas = new Float64Array(endAtom - startAtom).fill(NaN);
  const cells = [], summary = emptyPolyhedraSummary();
  let geometryBytes = 0;
  onPhase('analyzing');
  for (let atom = startAtom; atom < endAtom; atom++) {
    throwIfAborted(signal);
    if (centers === null || centers.has(frame.types[atom])) {
      summary.selected++;
      if (neighbors?.size !== 0) searchGuard(atom);
      const candidates = neighbors?.size === 0 ? { length: 0 } : search.collect(atom, cutoff, scratch, MAX_CANDIDATES + 1);
      if (candidates.length > MAX_CANDIDATES) throw new Error('Too many coordination-polyhedron candidates; reduce the cutoff.');
      const points = [];
      let bondLengthMin = Infinity, bondLengthMax = 0, bondLengthMean = 0;
      for (let row = 0; row < candidates.length; row++) {
        if (neighbors !== null && !neighbors.has(frame.types[candidates.atoms[row]])) continue;
        // Coincident sites cannot define a bond direction or a hull vertex.
        if (candidates.distanceSquared[row] === 0) continue;
        points.push([candidates.xs[row], candidates.ys[row], candidates.zs[row]]);
        const distance = Math.sqrt(candidates.distanceSquared[row]);
        bondLengthMin = Math.min(bondLengthMin, distance); bondLengthMax = Math.max(bondLengthMax, distance);
        bondLengthMean += (distance - bondLengthMean) / points.length;
        if (points.length > MAX_POLYHEDRON_NEIGHBORS) {
          throw new Error(`A coordination polyhedron has more than ${MAX_POLYHEDRON_NEIGHBORS} neighbors; reduce the cutoff or select neighbor elements.`);
        }
      }
      coordination[atom - startAtom] = points.length;
      const hull = convexPolyhedron(points);
      if (hull.reason) summary[hull.reason]++;
      else {
        if (cells.length === maxCells) throw new Error('Too many coordination polyhedra; select fewer center elements.');
        const cell = { atomIndex: atom, coordination: points.length, bondLengthMin, bondLengthMax, bondLengthMean, ...hull };
        // Include the cell object, typed-array views and bounded scalar metadata,
        // not just their payloads, in the retained geometry budget.
        geometryBytes += 512 + cell.vertices.byteLength + cell.faceOffsets.byteLength + cell.faceVertices.byteLength;
        if (geometryBytes > MAX_POLYHEDRA_BYTES) throw new Error('Coordination polyhedra exceed the geometry memory limit; select fewer centers.');
        cells.push(cell); volumes[atom - startAtom] = cell.volume; surfaceAreas[atom - startAtom] = cell.surfaceArea;
        summary.constructed++; summary.volumeSum += cell.volume; summary.surfaceAreaSum += cell.surfaceArea;
      }
    }
    if ((atom - startAtom + 1) % 32 === 0) onAtoms(atom - startAtom + 1, endAtom - startAtom);
  }
  summary.skipped = summary.undercoordinated + summary.coplanar;
  onAtoms(endAtom - startAtom, endAtom - startAtom);
  return { startAtom, endAtom, cells, coordination, volumes, surfaceAreas, summary, geometryBytes,
    elapsedMs: performance.now() - startedAt, warning: null };
}

export function emptyPolyhedraSummary() {
  return { selected: 0, constructed: 0, undercoordinated: 0, coplanar: 0, skipped: 0, volumeSum: 0, surfaceAreaSum: 0 };
}

function throwIfAborted(signal) {
  if (signal?.aborted) { const error = new Error('Analysis cancelled.'); error.name = 'AbortError'; throw error; }
}
function subtract(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function length(a) { return Math.hypot(...a); }

/** collect's accepted-row cap does not bound unsuccessful periodic image
 * tests. Bound its exact linked-bin stencil before entering the Cartesian
 * image loops. Small crystals need no extra traversal at all. */
function createSearchGuard(search, radius) {
  const imageBudget = search.imageBudget(radius);
  if (!Number.isFinite(imageBudget) || imageBudget > 100_000) {
    return () => { throw new Error('The cell is too thin for this neighbor search; use a less skewed cell.'); };
  }
  if (search.count * imageBudget <= MAX_QUERY_IMAGE_TESTS && search.heads.length <= MAX_QUERY_BINS) return () => {};
  const ranges = [new Int32Array(3), new Int32Array(3), new Int32Array(3)];
  const bounds = Array.from(search.heights, height => radius / height + 1e-12);
  const [dx, dy, dz] = search.dimensions;
  const fail = () => { throw new Error('Coordination-polyhedron neighbor search exceeds its candidate work budget; reduce the cutoff or use a less skewed cell.'); };
  return atom => {
    for (let axis = 0; axis < 3; axis++) search.binRange(search.coordinates[atom * 3 + axis], bounds[axis], axis, ranges[axis]);
    const [[x0, x1, xWrap], [y0, y1, yWrap], [z0, z1, zWrap]] = ranges;
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > MAX_QUERY_BINS) fail();
    let candidates = 0;
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) {
      const x = xWrap ? (ix % dx + dx) % dx : ix, y = yWrap ? (iy % dy + dy) % dy : iy, z = zWrap ? (iz % dz + dz) % dz : iz;
      for (let other = search.heads[(x * dy + y) * dz + z]; other >= 0; other = search.next[other]) {
        if (++candidates * imageBudget > MAX_QUERY_IMAGE_TESTS) fail();
      }
    }
  };
}

/** Incremental 3D hull with coplanar triangles reunited into true polygon
 * faces. The small bounded neighbor shell keeps this O(n * faces), rather
 * than testing every point against every possible vertex triple. */
function convexPolyhedron(source) {
  if (source.length < 4) return { reason: 'undercoordinated' };
  const scale = Math.max(...source.map(length));
  if (!Number.isFinite(scale) || scale === 0) return { reason: 'undercoordinated' };
  const points = [], original = [];
  for (const point of source) {
    const normalized = point.map(value => value / scale);
    if (!points.some(other => length(subtract(other, normalized)) <= EPSILON)) {
      points.push(normalized); original.push(point);
    }
  }
  if (points.length < 4) return { reason: 'undercoordinated' };
  const a = 0;
  let b = 1, c = -1, d = -1, farthest = 0;
  for (let i = 1; i < points.length; i++) {
    const distance = length(subtract(points[i], points[a]));
    if (distance > farthest) { farthest = distance; b = i; }
  }
  const line = subtract(points[b], points[a]);
  farthest = 0;
  for (let i = 0; i < points.length; i++) {
    const area = length(cross(line, subtract(points[i], points[a])));
    if (area > farthest) { farthest = area; c = i; }
  }
  if (c < 0 || farthest <= EPSILON * length(line)) return { reason: 'coplanar' };
  const normal = cross(line, subtract(points[c], points[a])), normalLength = length(normal);
  farthest = 0;
  for (let i = 0; i < points.length; i++) {
    const distance = Math.abs(dot(normal, subtract(points[i], points[a]))) / normalLength;
    if (distance > farthest) { farthest = distance; d = i; }
  }
  if (d < 0 || farthest <= EPSILON) return { reason: 'coplanar' };
  // Polygon merging uses Float64 plane tests. For a finite almost-planar
  // shell their absolute uncertainty can dominate its physical volume even
  // though the hull remains topologically closed. Do not publish that value
  // as a valid 3D coordination cell (or silently relabel it planar).
  if (farthest < MIN_RELIABLE_THICKNESS) {
    throw new Error('Coordination-polyhedron thickness is too small for a reliable volume; the neighbors are nearly coplanar.');
  }
  const inside = [0, 1, 2].map(axis => (points[a][axis] + points[b][axis] + points[c][axis] + points[d][axis]) / 4);
  function triangle(i, j, k) {
    let n = cross(subtract(points[j], points[i]), subtract(points[k], points[i]));
    const norm = length(n);
    if (norm <= EPSILON * EPSILON) return null;
    if (dot(n, subtract(inside, points[i])) > 0) { [j, k] = [k, j]; n = n.map(value => -value); }
    n = n.map(value => value / norm);
    return { vertices: [i, j, k], normal: n, offset: dot(n, points[i]) };
  }
  let triangles = [[a, b, c], [a, d, b], [a, c, d], [b, d, c]].map(indices => triangle(...indices));
  for (let index = 0; index < points.length; index++) {
    if ([a, b, c, d].includes(index)) continue;
    const horizon = new Map(), retained = [];
    for (const face of triangles) {
      if (dot(face.normal, points[index]) - face.offset <= EPSILON) { retained.push(face); continue; }
      const ids = face.vertices;
      for (let edge = 0; edge < 3; edge++) {
        const first = ids[edge], second = ids[(edge + 1) % 3];
        if (!horizon.delete(second * MAX_POLYHEDRON_NEIGHBORS + first)) {
          horizon.set(first * MAX_POLYHEDRON_NEIGHBORS + second, [first, second]);
        }
      }
    }
    if (!horizon.size) continue;
    for (const [first, second] of horizon.values()) {
      const face = triangle(first, second, index);
      if (face) retained.push(face);
    }
    triangles = retained;
  }
  const planes = [];
  for (const face of triangles) {
    let plane = planes.find(other => length(cross(other.normal, face.normal)) <= EPSILON * 8
      && dot(other.normal, face.normal) > 0 && Math.abs(other.offset - face.offset) <= EPSILON * 8);
    if (!plane) { plane = { normal: face.normal, offset: face.offset, vertices: new Set() }; planes.push(plane); }
    for (const index of face.vertices) plane.vertices.add(index);
  }
  const faces = planes.map(plane => polygonHull([...plane.vertices], points, plane.normal));
  const used = [...new Set(faces.flat())].sort((first, second) => first - second);
  const edges = new Map();
  for (const face of faces) for (let corner = 0; corner < face.length; corner++) {
    const first = face[corner], second = face[(corner + 1) % face.length];
    const key = Math.min(first, second) * MAX_POLYHEDRON_NEIGHBORS + Math.max(first, second);
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  if (used.length - edges.size + faces.length !== 2 || [...edges.values()].some(count => count !== 2)) {
    throw new Error('Coordination-polyhedron faces are numerically ambiguous. Adjust the cutoff or check coincident sites.');
  }
  const remap = new Map(used.map((index, row) => [index, row]));
  const vertices = Float64Array.from(used.flatMap(index => original[index]));
  const faceOffsets = new Uint32Array(faces.length + 1), faceVertices = [];
  let volume = 0, surfaceArea = 0;
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
    const face = faces[faceIndex], first = points[face[0]], firstLocal = subtract(first, inside);
    for (let corner = 1; corner + 1 < face.length; corner++) {
      const second = points[face[corner]], third = points[face[corner + 1]];
      surfaceArea += length(cross(subtract(second, first), subtract(third, first))) * scale ** 2 / 2;
      volume += dot(firstLocal, cross(subtract(second, inside), subtract(third, inside))) * scale ** 3 / 6;
    }
    faceVertices.push(...face.map(index => remap.get(index)));
    faceOffsets[faceIndex + 1] = faceVertices.length;
  }
  if (!Number.isFinite(volume) || !Number.isFinite(surfaceArea) || volume <= 0) {
    throw new Error('Coordination-polyhedron geometry exceeds numerical precision. Check the cell and cutoff.');
  }
  return { vertices, faceOffsets, faceVertices: Uint32Array.from(faceVertices), volume, surfaceArea };
}

function polygonHull(indices, points, normal) {
  const drop = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
  const axes = [0, 1, 2].filter(axis => axis !== drop), [x, y] = axes;
  indices.sort((a, b) => points[a][x] - points[b][x] || points[a][y] - points[b][y]);
  const turn = (a, b, c) => (points[b][x] - points[a][x]) * (points[c][y] - points[a][y])
    - (points[b][y] - points[a][y]) * (points[c][x] - points[a][x]);
  const lower = [], upper = [];
  for (const index of indices) {
    while (lower.length >= 2 && turn(lower.at(-2), lower.at(-1), index) <= EPSILON) lower.pop();
    lower.push(index);
  }
  for (let i = indices.length - 1; i >= 0; i--) {
    const index = indices[i];
    while (upper.length >= 2 && turn(upper.at(-2), upper.at(-1), index) <= EPSILON) upper.pop();
    upper.push(index);
  }
  lower.pop(); upper.pop();
  const result = lower.concat(upper);
  if (result.length < 3) throw new Error('Coordination-polyhedron face is numerically degenerate.');
  if (dot(cross(subtract(points[result[1]], points[result[0]]), subtract(points[result[2]], points[result[0]])), normal) < 0) result.reverse();
  return result;
}
