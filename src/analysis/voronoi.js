import createVoronoi from './voronoi-kernel.mjs';
import { determinant3, invert3 } from '../data/model.js';
import { NeighborSearch, atomRange } from './neighbors.js';

export const VORONOI_FIELDS = Object.freeze({
  atomicVolume: [Float64Array, 1],
  voronoiSurfaceArea: [Float64Array, 1],
  voronoiCoordination: [Uint32Array, 1],
  voronoiBoundaryFaces: [Uint8Array, 1],
  voronoiMaxFaceOrder: [Uint32Array, 1],
});

const MAX_CANDIDATES = 1_000_000;
let kernelPromise;
let resident;

async function getKernel() {
  if (!kernelPromise) kernelPromise = (async () => {
    let options = {};
    if (typeof process === 'object' && process.versions?.node) {
      const { readFile } = await import('node:fs/promises');
      options = { wasmBinary: await readFile(new URL('./voronoi-kernel.wasm', import.meta.url)) };
    }
    const module = await createVoronoi(options);
    resident = { module, capacity: 0, planes: 0, neighbors: 0, areas: 0, orders: 0,
      faceNeighbors: 0, faceCapacity: 0, summary: module._malloc(16) };
    if (!resident.summary) throw new Error('Voronoi output allocation failed.');
    return resident;
  })().catch(error => { kernelPromise = undefined; throw error; });
  return kernelPromise;
}

function growPlanes(kernel, count) {
  if (count <= kernel.capacity) return;
  const { module } = kernel, capacity = Math.max(64, 2 ** Math.ceil(Math.log2(count)));
  const planes = module._malloc(capacity * 4 * 8), neighbors = module._malloc(capacity * 4);
  if (!planes || !neighbors) {
    if (planes) module._free(planes);
    if (neighbors) module._free(neighbors);
    throw new Error('Voronoi plane allocation failed.');
  }
  if (kernel.planes) module._free(kernel.planes);
  if (kernel.neighbors) module._free(kernel.neighbors);
  Object.assign(kernel, { planes, neighbors, capacity });
}

function growFaces(kernel, count) {
  if (count <= kernel.faceCapacity) return;
  const { module } = kernel, faceCapacity = Math.max(64, 2 ** Math.ceil(Math.log2(count)));
  const areas = module._malloc(faceCapacity * 8), orders = module._malloc(faceCapacity * 4),
    faceNeighbors = module._malloc(faceCapacity * 4);
  if (!areas || !orders || !faceNeighbors) {
    for (const pointer of [areas, orders, faceNeighbors]) if (pointer) module._free(pointer);
    throw new Error('Voronoi face allocation failed.');
  }
  for (const name of ['areas', 'orders', 'faceNeighbors']) if (kernel[name]) module._free(kernel[name]);
  Object.assign(kernel, { areas, orders, faceNeighbors, faceCapacity });
}

export function validateVoronoiParameters({ faceAreaThreshold = 0, relativeFaceAreaThreshold = 0,
  bins = 50 } = {}) {
  if (!Number.isFinite(faceAreaThreshold) || faceAreaThreshold < 0) {
    throw new Error('Voronoi face-area threshold must be finite and non-negative.');
  }
  if (!Number.isFinite(relativeFaceAreaThreshold) || relativeFaceAreaThreshold < 0
      || relativeFaceAreaThreshold > 1) throw new Error('Voronoi relative face-area threshold must be between 0 and 1.');
  if (!Number.isInteger(bins) || bins < 1 || bins > 4096) throw new Error('Voronoi statistics require 1–4096 histogram bins.');
}

/** Actual unweighted Voronoi cells: bisectors to all relevant atomic images.
 * Open directions use the finite simulation-cell domain. No neighbor cutoff
 * changes this geometry: a search completes only once it covers twice the
 * farthest remaining cell vertex, so any omitted bisector lies outside it.
 */
export async function calculateVoronoi(frame, { faceAreaThreshold = 0, relativeFaceAreaThreshold = 0,
  bins = 50, onPhase = () => {}, onAtoms = () => {}, ...range } = {}) {
  validateVoronoiParameters({ faceAreaThreshold, relativeFaceAreaThreshold, bins });
  const startedAt = performance.now(), kernelReused = Boolean(kernelPromise);
  onPhase('initializing');
  const kernel = await getKernel(), { module } = kernel;
  onPhase('indexing');
  const search = new NeighborSearch(frame), count = search.count;
  const { startAtom, endAtom } = atomRange(count, range), size = endAtom - startAtom;
  const cellVolume = Math.abs(determinant3(frame.cell.vectors));
  const scale = Math.cbrt(cellVolume / count), areaScale = scale ** 2, volumeScale = scale ** 3;
  const geometry = initialGeometry(frame.cell);
  // A one-site orthogonal Bravais lattice has exactly the six axis-image
  // bisectors used to initialize its cell. Other lattice images have redundant
  // planes. Proving completeness by a large sphere would needlessly enumerate
  // millions of images when one repeat direction is extremely thin.
  const exactSingleSiteCell = count === 1 && frame.cell.pbc.every(Boolean)
    && orthogonalBasis(frame.cell.vectors);
  // Reject out-of-domain nonperiodic atoms instead of inventing an infinite
  // volume or silently enlarging the domain. PBC fractions are wrapped above.
  for (let atom = 0; atom < count; atom++) for (let axis = 0; axis < 3; axis++) {
    const value = search.coordinates[atom * 3 + axis];
    if (!frame.cell.pbc[axis] && (value < -1e-10 || value > 1 + 1e-10)) {
      throw new Error(`Voronoi requires nonperiodic atom ${atom + 1} to lie inside the simulation cell.`);
    }
  }
  const result = Object.fromEntries(Object.entries(VORONOI_FIELDS).map(([name, [Type]]) => [name, new Type(size)]));
  const faceOffsets = new Uint32Array(size + 1), faceAreas = [], faceOrders = [],
    faceNeighbors = [], faceBoundary = [], faceAccepted = [], voronoiIndices = new Array(size);
  let candidateCount = 0;
  growPlanes(kernel, 6);
  onPhase('analyzing');
  onAtoms(0, size);
  let lastProgressAt = performance.now();
  for (let atom = startAtom; atom < endAtom; atom++) {
    const index = atom - startAtom;
    const { planes, ids, radius } = initialCell(geometry, search.coordinates.subarray(atom * 3, atom * 3 + 3), atom, scale);
    module._alloy_voronoi_init(radius / scale);
    module.HEAPF64.set(planes, kernel.planes >> 3);
    module.HEAP32.set(ids, kernel.neighbors >> 2);
    if (!module._alloy_voronoi_clip(kernel.planes, kernel.neighbors, 6)) {
      throw new Error(`Voronoi initialization failed for atom ${atom + 1}.`);
    }
    let previousRadiusSquared = -1;
    let farthestRadius = Math.sqrt(module._alloy_voronoi_radius_squared()) * scale;
    let radiusToSearch = Math.min(search.initialRadius, 2 * farthestRadius * (1 + 1e-10));
    let complete = exactSingleSiteCell;
    for (let attempt = 0; !complete && attempt < 48; attempt++) {
      const neighbors = search.within(atom, radiusToSearch, MAX_CANDIDATES + 1);
      if (neighbors.length > MAX_CANDIDATES) throw new Error('Voronoi cell has too many candidate images; reduce the cell skew or thin-cell aspect ratio.');
      neighbors.sort((a, b) => a.distanceSquared - b.distanceSquared || a.atom - b.atom
        || a.imageA - b.imageA || a.imageB - b.imageB || a.imageC - b.imageC);
      growPlanes(kernel, Math.max(6, neighbors.length));
      let planeCount = 0;
      for (const neighbor of neighbors) {
        if (neighbor.distanceSquared < 1e-20 * areaScale) {
          throw new Error(`Voronoi is undefined for coincident atoms ${atom + 1} and ${neighbor.atom + 1}.`);
        }
        if (neighbor.distanceSquared <= previousRadiusSquared * (1 - 1e-12)) continue;
        // Current vertices already lie within the initial bound. Sorting lets
        // us omit farther planes without changing the final polyhedron.
        if (neighbor.distanceSquared > 4 * farthestRadius ** 2 * (1 + 1e-10)) break;
        const offset = (kernel.planes >> 3) + planeCount * 4;
        module.HEAPF64[offset] = neighbor.x / scale;
        module.HEAPF64[offset + 1] = neighbor.y / scale;
        module.HEAPF64[offset + 2] = neighbor.z / scale;
        module.HEAPF64[offset + 3] = neighbor.distanceSquared / areaScale;
        module.HEAP32[(kernel.neighbors >> 2) + planeCount] = neighbor.atom;
        planeCount++;
      }
      candidateCount += planeCount;
      if (planeCount && !module._alloy_voronoi_clip(kernel.planes, kernel.neighbors, planeCount)) {
        throw new Error(`Voronoi cell vanished for atom ${atom + 1}; check coincident coordinates.`);
      }
      farthestRadius = Math.sqrt(module._alloy_voronoi_radius_squared()) * scale;
      if (radiusToSearch >= 2 * farthestRadius * (1 - 1e-10)) { complete = true; break; }
      previousRadiusSquared = radiusToSearch ** 2;
      radiusToSearch = Math.min(radiusToSearch * 1.8, 2 * farthestRadius * (1 + 1e-10));
    }
    if (!complete) throw new Error(`Voronoi neighbor search could not complete cell ${atom + 1}.`);
    const faces = module._alloy_voronoi_summary(kernel.summary);
    if (faces < 0) throw new Error('Voronoi topology output is inconsistent.');
    growFaces(kernel, faces);
    if (module._alloy_voronoi_faces(kernel.areas, kernel.orders, kernel.faceNeighbors, kernel.faceCapacity) !== faces) {
      throw new Error('Voronoi face output failed.');
    }
    const volume = module.HEAPF64[kernel.summary >> 3] * volumeScale,
      surface = module.HEAPF64[(kernel.summary >> 3) + 1] * areaScale;
    if (!(volume > 0) || !Number.isFinite(surface)) throw new Error(`Voronoi cell ${atom + 1} has invalid geometry.`);
    result.atomicVolume[index] = volume;
    result.voronoiSurfaceArea[index] = surface;
    const orders = new Map();
    for (let face = 0; face < faces; face++) {
      const area = module.HEAPF64[(kernel.areas >> 3) + face] * areaScale,
        order = module.HEAPU32[(kernel.orders >> 2) + face],
        neighbor = module.HEAP32[(kernel.faceNeighbors >> 2) + face];
      const boundary = neighbor < 0;
      const accepted = !boundary && area > faceAreaThreshold && area / surface > relativeFaceAreaThreshold;
      faceAreas.push(area); faceOrders.push(order); faceNeighbors.push(boundary ? -1 : neighbor);
      faceBoundary.push(Number(boundary)); faceAccepted.push(Number(accepted));
      if (boundary) result.voronoiBoundaryFaces[index]++;
      if (accepted) {
        result.voronoiCoordination[index]++;
        result.voronoiMaxFaceOrder[index] = Math.max(result.voronoiMaxFaceOrder[index], order);
        orders.set(order, (orders.get(order) ?? 0) + 1);
      }
    }
    voronoiIndices[index] = indexLabel(orders);
    faceOffsets[index + 1] = faceAreas.length;
    if (index && index % 64 === 0 && performance.now() - lastProgressAt >= 100) {
      onAtoms(index, size); lastProgressAt = performance.now();
    }
  }
  onAtoms(size, size);
  const output = { ...result, faceOffsets, faceAreas: Float64Array.from(faceAreas),
    faceOrders: Uint32Array.from(faceOrders), faceNeighbors: Int32Array.from(faceNeighbors),
    faceBoundary: Uint8Array.from(faceBoundary), faceAccepted: Uint8Array.from(faceAccepted),
    voronoiIndices, startAtom, endAtom, sourceAtomCount: count, cellVolume,
    boundaryMode: frame.cell.pbc.every(Boolean) ? 'periodic' : 'finite-cell',
    faceAreaThreshold, relativeFaceAreaThreshold, candidateCount, kernelReused,
    engine: 'voro++-wasm', elapsedMs: performance.now() - startedAt };
  return { ...output, ...finalizeVoronoiStatistics(output, { bins }) };
}

function orthogonalBasis(vectors) {
  for (let first = 0; first < 3; first++) for (let second = first + 1; second < 3; second++) {
    const dot = vectors[first * 3] * vectors[second * 3]
      + vectors[first * 3 + 1] * vectors[second * 3 + 1]
      + vectors[first * 3 + 2] * vectors[second * 3 + 2];
    // Exact zero is intentional: a nearly orthogonal lattice may introduce
    // genuine tiny faces, and must retain the general geometric search.
    if (dot !== 0) return false;
  }
  return true;
}

function initialGeometry(cell) {
  const inverse = invert3(cell.vectors), normals = [], lengths = [];
  for (let axis = 0; axis < 3; axis++) {
    const vector = cell.pbc[axis] ? Array.from(cell.vectors.subarray(axis * 3, axis * 3 + 3))
      : [inverse[axis], inverse[3 + axis], inverse[6 + axis]];
    const length = Math.hypot(...vector);
    normals.push(vector.map(value => value / length)); lengths.push(length);
  }
  return { normals, lengths, pbc: cell.pbc, inverseNormals: invert3(normals.flat()) };
}

function initialCell({ normals, lengths, pbc, inverseNormals }, fractional, atom, scale) {
  const lower = [], upper = [], planes = new Float64Array(24), ids = new Int32Array(6);
  for (let axis = 0; axis < 3; axis++) {
    const position = Math.max(0, Math.min(1, fractional[axis]));
    lower[axis] = pbc[axis] ? -lengths[axis] / 2 : -position / lengths[axis];
    upper[axis] = pbc[axis] ? lengths[axis] / 2 : (1 - position) / lengths[axis];
    for (let side = 0; side < 2; side++) {
      const offset = (axis * 2 + side) * 4, sign = side ? 1 : -1;
      for (let component = 0; component < 3; component++) planes[offset + component] = normals[axis][component] * sign;
      planes[offset + 3] = 2 * (side ? upper[axis] : -lower[axis]) / scale;
      ids[axis * 2 + side] = pbc[axis] ? atom : -10 - axis * 2 - side;
    }
  }
  let radius = 0;
  for (let mask = 0; mask < 8; mask++) {
    const rhs = [0, 1, 2].map(axis => mask & (1 << axis) ? upper[axis] : lower[axis]);
    const point = [0, 1, 2].map(row => inverseNormals[row * 3] * rhs[0]
      + inverseNormals[row * 3 + 1] * rhs[1] + inverseNormals[row * 3 + 2] * rhs[2]);
    radius = Math.max(radius, Math.hypot(...point));
  }
  return { planes, ids, radius: radius * (1 + 1e-6) + scale * 1e-6 };
}

function indexLabel(orders) {
  const maximum = Math.max(6, ...orders.keys());
  return `<${Array.from({ length: maximum - 2 }, (_, index) => orders.get(index + 3) ?? 0).join(',')}>`;
}

/** Merge disjoint central-atom ranges without discarding full face topology. */
export function mergeVoronoiPartials(partials, atomCount, { bins = 50 } = {}) {
  if (!Number.isInteger(atomCount) || atomCount < 1) throw new Error('Invalid Voronoi atom count.');
  const sorted = [...partials].sort((a, b) => a.startAtom - b.startAtom);
  let nextAtom = 0, totalFaces = 0;
  for (const partial of sorted) {
    if (partial.startAtom !== nextAtom || partial.endAtom <= partial.startAtom || partial.endAtom > atomCount) {
      throw new Error('Voronoi partial ranges must cover every atom exactly once.');
    }
    nextAtom = partial.endAtom; totalFaces += partial.faceAreas.length;
  }
  if (nextAtom !== atomCount) throw new Error('Voronoi partial ranges are incomplete.');
  const result = Object.fromEntries(Object.entries(VORONOI_FIELDS).map(([name, [Type]]) => [name, new Type(atomCount)]));
  const faces = { faceOffsets: new Uint32Array(atomCount + 1), faceAreas: new Float64Array(totalFaces),
    faceOrders: new Uint32Array(totalFaces), faceNeighbors: new Int32Array(totalFaces),
    faceBoundary: new Uint8Array(totalFaces), faceAccepted: new Uint8Array(totalFaces), voronoiIndices: new Array(atomCount) };
  let offset = 0;
  for (const partial of sorted) {
    for (const name of Object.keys(result)) result[name].set(partial[name], partial.startAtom);
    for (const name of ['faceAreas', 'faceOrders', 'faceNeighbors', 'faceBoundary', 'faceAccepted']) faces[name].set(partial[name], offset);
    for (let index = 0; index < partial.endAtom - partial.startAtom; index++) {
      faces.faceOffsets[partial.startAtom + index] = offset + partial.faceOffsets[index];
      faces.voronoiIndices[partial.startAtom + index] = partial.voronoiIndices[index];
    }
    offset += partial.faceAreas.length;
  }
  faces.faceOffsets[atomCount] = offset;
  const first = sorted[0], output = { ...result, ...faces, startAtom: 0, endAtom: atomCount,
    sourceAtomCount: atomCount, cellVolume: first.cellVolume, boundaryMode: first.boundaryMode,
    faceAreaThreshold: first.faceAreaThreshold, relativeFaceAreaThreshold: first.relativeFaceAreaThreshold,
    candidateCount: sorted.reduce((sum, partial) => sum + partial.candidateCount, 0),
    kernelInitializations: sorted.filter(partial => !partial.kernelReused).length, warning: null };
  return { ...output, ...finalizeVoronoiStatistics(output, { bins }) };
}

export function finalizeVoronoiStatistics(result, { bins = 50 } = {}) {
  validateVoronoiParameters({ bins });
  const count = result.atomicVolume.length, volumeStats = arrayStats(result.atomicVolume),
    surfaceStats = arrayStats(result.voronoiSurfaceArea), coordinationStats = arrayStats(result.voronoiCoordination);
  const coordination = new Map(), indices = new Map();
  let boundaryAtomCount = 0, neighborFaceCount = 0, acceptedFaceCount = 0;
  for (let atom = 0; atom < count; atom++) {
    const value = result.voronoiCoordination[atom], label = result.voronoiIndices[atom];
    coordination.set(value, (coordination.get(value) ?? 0) + 1);
    indices.set(label, (indices.get(label) ?? 0) + 1);
    boundaryAtomCount += Number(result.voronoiBoundaryFaces[atom] > 0);
  }
  for (let face = 0; face < result.faceAreas.length; face++) {
    neighborFaceCount += Number(!result.faceBoundary[face]); acceptedFaceCount += Number(result.faceAccepted[face]);
  }
  const completeDomain = count === result.sourceAtomCount && result.startAtom === 0;
  return {
    summary: { atomCount: count, totalVolume: volumeStats.sum, cellVolume: result.cellVolume,
      volumeError: completeDomain ? (volumeStats.sum - result.cellVolume) / result.cellVolume : null,
      meanVolume: volumeStats.mean, minVolume: volumeStats.min, maxVolume: volumeStats.max,
      meanSurfaceArea: surfaceStats.mean, meanCoordination: coordinationStats.mean,
      boundaryAtomCount, neighborFaceCount, acceptedFaceCount, boundaryMode: result.boundaryMode },
    coordinationHistogram: [...coordination].sort((a, b) => a[0] - b[0])
      .map(([value, population]) => ({ value, count: population, fraction: population / count })),
    volumeHistogram: histogram(result.atomicVolume, bins),
    // Each atom's face is one observation; shared interior faces occur twice.
    // Boundary faces are excluded so face statistics describe atom neighbors.
    faceAreaHistogram: histogram(result.faceAreas, bins, face => !result.faceBoundary[face]),
    indexCounts: [...indices].map(([index, population]) => ({ index, count: population, fraction: population / count }))
      .sort((a, b) => b.count - a.count || a.index.localeCompare(b.index)),
  };
}

function arrayStats(values) {
  let sum = 0, compensation = 0, min = Infinity, max = -Infinity;
  for (const value of values) {
    const corrected = value - compensation, next = sum + corrected;
    compensation = (next - sum) - corrected; sum = next;
    min = Math.min(min, value); max = Math.max(max, value);
  }
  return { sum, min, max, mean: sum / values.length };
}

function histogram(values, bins, include = () => true) {
  let min = Infinity, max = -Infinity, population = 0;
  for (let index = 0; index < values.length; index++) if (include(index)) {
    min = Math.min(min, values[index]); max = Math.max(max, values[index]); population++;
  }
  if (!population) return [];
  if (max - min <= 1e-12 * Math.max(1, Math.abs(min), Math.abs(max))) {
    return [{ lower: min, upper: max, count: population, fraction: 1 }];
  }
  const width = (max - min) / bins, counts = new Uint32Array(bins);
  for (let index = 0; index < values.length; index++) if (include(index)) {
    counts[Math.min(bins - 1, Math.floor((values[index] - min) / width))]++;
  }
  return Array.from(counts, (count, index) => ({ lower: min + index * width,
    upper: min + (index + 1) * width, count, fraction: count / population }));
}
