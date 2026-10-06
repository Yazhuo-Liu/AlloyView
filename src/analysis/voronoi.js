import createVoronoi from './voronoi-kernel.mjs';
import { determinant3, invert3 } from '../data/model.js';
import { NeighborSearch, atomRange } from './neighbors.js';
import { prepareVoronoiSelection, voronoiSelectionRange, expandVoronoiResult,
  mapVoronoiGeometry, compactVoronoiAtomIndices } from './voronoi-selection.js';

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

/** Allocate the reusable native cell and output buffers without tessellating
 * any atoms. The initialized module remains resident across source changes. */
export async function warmupVoronoi({ onPhase = () => {} } = {}) {
  const kernelReused = Boolean(kernelPromise);
  if (!kernelReused) onPhase('initializing');
  const kernel = await getKernel();
  growPlanes(kernel, 64); growFaces(kernel, 64); growGeometry(kernel, 64, 64, 256);
  kernel.module._alloy_voronoi_init(1);
  return { warmed: true, kernelReused };
}

/** Prepare only the immutable source index; no per-atom cells or statistics
 * are calculated until the foreground analysis requests them. */
export async function prepareVoronoiFrame(frame, { context, onContext = () => {}, onPhase = () => {} } = {}) {
  const warmed = await warmupVoronoi({ onPhase });
  if (!context) onPhase('indexing');
  const prepared = resolveContext(frame, context);
  onContext(prepared);
  return { ...warmed, indexReused: Boolean(context), atomCount: prepared.count };
}

function growPlanes(kernel, count) {
  if (count <= kernel.capacity) return;
  const { module } = kernel, capacity = Math.max(64, 2 ** Math.ceil(Math.log2(count)));
  const planes = module._malloc(capacity * 4 * 8), neighbors = module._malloc(capacity * 4), keep = module._malloc(capacity);
  if (!planes || !neighbors || !keep) {
    if (planes) module._free(planes);
    if (neighbors) module._free(neighbors);
    if (keep) module._free(keep);
    throw new Error('Voronoi plane allocation failed.');
  }
  if (kernel.planes) module._free(kernel.planes);
  if (kernel.neighbors) module._free(kernel.neighbors);
  if (kernel.keep) module._free(kernel.keep);
  Object.assign(kernel, { planes, neighbors, keep, capacity });
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

function growGeometry(kernel, vertexCount, faceCount, referenceCount) {
  kernel.geometrySizes ??= kernel.module._malloc(12);
  if (!kernel.geometrySizes) throw new Error('Voronoi geometry allocation failed.');
  for (const [name, count, stride] of [['vertices', vertexCount, 24], ['geometryOffsets', faceCount + 1, 4],
    ['geometryReferences', referenceCount, 4], ['geometryNeighbors', faceCount, 4]]) {
    const capacityName = `${name}Capacity`;
    if ((kernel[capacityName] ?? 0) >= count) continue;
    const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
    const pointer = kernel.module._malloc(capacity * stride);
    if (!pointer) throw new Error('Voronoi geometry allocation failed.');
    if (kernel[name]) kernel.module._free(kernel[name]);
    kernel[name] = pointer; kernel[capacityName] = capacity;
  }
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
export async function calculateVoronoi(frame, options = {}) {
  if (options.selectedTypes != null) {
    const selection = prepareVoronoiSelection(frame, options.selectedTypes), range = voronoiSelectionRange(selection, options);
    const result = await calculateVoronoiCore(selection.frame, { ...options, selectedTypes: null, ...range });
    return expandVoronoiResult(result, selection);
  }
  return calculateVoronoiCore(frame, options);
}

async function calculateVoronoiCore(frame, { faceAreaThreshold = 0, relativeFaceAreaThreshold = 0,
  bins = 50, onPhase = () => {}, onAtoms = () => {}, context, onContext = () => {}, skipStatistics = false, ...range } = {}) {
  validateVoronoiParameters({ faceAreaThreshold, relativeFaceAreaThreshold, bins });
  const startedAt = performance.now(), kernelReused = Boolean(kernelPromise);
  if (!kernelReused) onPhase('initializing');
  const kernel = await getKernel(), { module } = kernel;
  if (!context) onPhase('indexing');
  const indexReused = Boolean(context);
  const prepared = resolveContext(frame, context);
  onContext(prepared);
  const { search, count, cellVolume, scale, areaScale, volumeScale } = prepared;
  const { startAtom, endAtom } = atomRange(count, range), size = endAtom - startAtom;
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
    candidateCount += clipVoronoiCell(kernel, prepared, atom);
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
    faceAreaThreshold, relativeFaceAreaThreshold, candidateCount, kernelReused, indexReused,
    engine: 'voro++-wasm', elapsedMs: performance.now() - startedAt };
  return skipStatistics ? output : { ...output, ...finalizeVoronoiStatistics(output, { bins }) };
}

/** A selected-cell mesh, computed against the full structure without building
 * or retaining all atoms' vertex meshes. Vertices are Cartesian offsets from
 * the wrapped atom center; faces retain their polygon boundaries for outlines.
 */
export async function calculateVoronoiGeometry(frame, options = {}) {
  if (options.selectedTypes != null) {
    const selection = prepareVoronoiSelection(frame, options.selectedTypes),
      atomIndex = compactVoronoiAtomIndices(selection, [options.atomIndex])[0];
    return mapVoronoiGeometry(await calculateVoronoiGeometryCore(selection.frame, { ...options, atomIndex, selectedTypes: null }), selection);
  }
  return calculateVoronoiGeometryCore(frame, options);
}

async function calculateVoronoiGeometryCore(frame, { atomIndex, context,
  onPhase = () => {}, onAtoms = () => {}, onContext = () => {} } = {}) {
  const startedAt = performance.now(), kernelReused = Boolean(kernelPromise);
  onPhase('initializing');
  const kernel = await getKernel(), { module } = kernel;
  onPhase('indexing');
  const prepared = resolveContext(frame, context), { count, scale, search } = prepared;
  onContext(prepared);
  if (!Number.isInteger(atomIndex) || atomIndex < 0 || atomIndex >= count) {
    throw new Error('Voronoi geometry requires a valid atom index.');
  }
  growPlanes(kernel, 6);
  onPhase('analyzing'); onAtoms(0, 1);
  const candidateCount = clipVoronoiCell(kernel, prepared, atomIndex);
  growGeometry(kernel, 0, 0, 0);
  const faceCount = module._alloy_voronoi_geometry_sizes(kernel.geometrySizes);
  const vertexCount = module.HEAPU32[kernel.geometrySizes >> 2],
    referenceCount = module.HEAPU32[(kernel.geometrySizes >> 2) + 2];
  if (faceCount < 4 || vertexCount < 4 || referenceCount < 12) throw new Error('Voronoi geometry is incomplete.');
  growGeometry(kernel, vertexCount, faceCount, referenceCount);
  if (module._alloy_voronoi_geometry(kernel.vertices, kernel.geometryOffsets,
    kernel.geometryReferences, kernel.geometryNeighbors, kernel.verticesCapacity,
    kernel.geometryNeighborsCapacity, kernel.geometryReferencesCapacity) !== faceCount) {
    throw new Error('Voronoi geometry output failed.');
  }
  const vertices = module.HEAPF64.slice(kernel.vertices >> 3, (kernel.vertices >> 3) + vertexCount * 3);
  for (let index = 0; index < vertices.length; index++) vertices[index] *= scale;
  const faceOffsets = module.HEAPU32.slice(kernel.geometryOffsets >> 2, (kernel.geometryOffsets >> 2) + faceCount + 1),
    faceVertices = module.HEAPU32.slice(kernel.geometryReferences >> 2, (kernel.geometryReferences >> 2) + referenceCount),
    faceNeighbors = module.HEAP32.slice(kernel.geometryNeighbors >> 2, (kernel.geometryNeighbors >> 2) + faceCount),
    faceBoundary = Uint8Array.from(faceNeighbors, neighbor => Number(neighbor < 0));
  for (let face = 0; face < faceCount; face++) if (faceBoundary[face]) faceNeighbors[face] = -1;
  const fractional = search.coordinates.subarray(atomIndex * 3, atomIndex * 3 + 3),
    center = new Float64Array(3), vectors = frame.cell.vectors;
  for (let axis = 0; axis < 3; axis++) center[axis] = (frame.cell.origin?.[axis] ?? 0)
    + fractional[0] * vectors[axis] + fractional[1] * vectors[3 + axis] + fractional[2] * vectors[6 + axis];
  onAtoms(1, 1);
  return { atomIndex, center, vertices, faceOffsets, faceVertices, faceNeighbors, faceBoundary,
    candidateCount, kernelReused, indexReused: Boolean(context), engine: 'voro++-wasm-geometry',
    elapsedMs: performance.now() - startedAt };
}

/** One Worker chunk of selected polygon cells sharing a source index/kernel. */
export async function calculateVoronoiGeometryBatch(frame, { atomIndices = null, selectedTypes = null, context,
  onPhase = () => {}, onAtoms = () => {}, onContext = () => {} } = {}) {
  const startedAt = performance.now(), kernelReused = Boolean(kernelPromise), indexReused = Boolean(context),
    selection = prepareVoronoiSelection(frame, selectedTypes), indices = compactVoronoiAtomIndices(selection, atomIndices);
  if (!kernelReused) onPhase('initializing');
  await getKernel();
  if (!context) onPhase('indexing');
  const prepared = resolveContext(selection.frame, context);
  onContext(prepared); onPhase('analyzing'); onAtoms(0, indices.length);
  const cells = [];
  let candidateCount = 0;
  for (let index = 0; index < indices.length; index++) {
    const cell = await calculateVoronoiGeometryCore(selection.frame, { atomIndex: indices[index], context: prepared });
    cells.push(mapVoronoiGeometry(cell, selection)); candidateCount += cell.candidateCount;
    if (index && index % 64 === 0) onAtoms(index, indices.length);
  }
  onAtoms(indices.length, indices.length);
  return { cells, candidateCount, kernelReused, indexReused, engine: 'voro++-wasm-geometry-batch',
    elapsedMs: performance.now() - startedAt };
}

/** Build once per resident source snapshot; all central-atom chunks share it. */
export function createVoronoiContext(frame) {
  const search = new NeighborSearch(frame), count = search.count;
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
  return { frame, search, count, cellVolume, scale, areaScale, volumeScale, geometry, exactSingleSiteCell };
}

function resolveContext(frame, context) {
  if (context && (context.frame.fractional !== frame.fractional || context.frame.cell !== frame.cell)) {
    throw new Error('Voronoi context does not belong to this source snapshot.');
  }
  return context ?? createVoronoiContext(frame);
}

function clipVoronoiCell(kernel, prepared, atom) {
  const { module } = kernel;
  const { search, geometry, scale, areaScale, exactSingleSiteCell } = prepared;
  let candidateCount = 0;
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
    let neighbors = search.within(atom, radiusToSearch, MAX_CANDIDATES + 1);
    if (neighbors.length > MAX_CANDIDATES) throw new Error('Voronoi cell has too many candidate images; reduce the cell skew or thin-cell aspect ratio.');
    if (neighbors.length >= 256) {
      growPlanes(kernel, neighbors.length);
      for (let index = 0; index < neighbors.length; index++) {
        const neighbor = neighbors[index], offset = (kernel.planes >> 3) + index * 4;
        if (neighbor.distanceSquared < 1e-20 * areaScale) {
          throw new Error(`Voronoi is undefined for coincident atoms ${atom + 1} and ${neighbor.atom + 1}.`);
        }
        module.HEAPF64[offset] = neighbor.x / scale; module.HEAPF64[offset + 1] = neighbor.y / scale;
        module.HEAPF64[offset + 2] = neighbor.z / scale; module.HEAPF64[offset + 3] = neighbor.distanceSquared / areaScale;
      }
      module._alloy_voronoi_filter_planes(kernel.planes, kernel.keep, neighbors.length);
      neighbors = neighbors.filter((_, index) => module.HEAPU8[kernel.keep + index]);
    }
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
  return candidateCount;
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

export function initialGeometry(cell) {
  const inverse = invert3(cell.vectors), normals = [], lengths = [];
  for (let axis = 0; axis < 3; axis++) {
    const vector = cell.pbc[axis] ? Array.from(cell.vectors.subarray(axis * 3, axis * 3 + 3))
      : [inverse[axis], inverse[3 + axis], inverse[6 + axis]];
    const length = Math.hypot(...vector);
    normals.push(vector.map(value => value / length)); lengths.push(length);
  }
  return { normals, lengths, pbc: cell.pbc, inverseNormals: invert3(normals.flat()) };
}

export function initialCell({ normals, lengths, pbc, inverseNormals }, fractional, atom, scale) {
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
export function mergeVoronoiPartials(partials, atomCount, { bins = 50, consumePartials = false } = {}) {
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
  const faceCounts = sorted.map(partial => partial.faceAreas.length), result = {};
  // The finalizing Worker owns transferred partials. Assemble one field at a
  // time and release consumed input views, avoiding two complete face CSRs
  // being held live at once for million-atom structures. Public callers retain
  // their original partials unless they explicitly opt into consumption.
  for (const [name, [Type]] of Object.entries(VORONOI_FIELDS)) {
    result[name] = new Type(atomCount);
    for (const partial of sorted) {
      result[name].set(partial[name], partial.startAtom);
      if (consumePartials) delete partial[name];
    }
  }
  const faces = { faceOffsets: new Uint32Array(atomCount + 1), voronoiIndices: new Array(atomCount) };
  for (const [name, Type] of [['faceAreas', Float64Array], ['faceOrders', Uint32Array], ['faceNeighbors', Int32Array],
    ['faceBoundary', Uint8Array], ['faceAccepted', Uint8Array]]) {
    faces[name] = new Type(totalFaces);
    let fieldOffset = 0;
    for (let index = 0; index < sorted.length; index++) {
      const partial = sorted[index];
      faces[name].set(partial[name], fieldOffset); fieldOffset += faceCounts[index];
      if (consumePartials) delete partial[name];
    }
  }
  let offset = 0;
  for (let partialIndex = 0; partialIndex < sorted.length; partialIndex++) {
    const partial = sorted[partialIndex];
    for (let index = 0; index < partial.endAtom - partial.startAtom; index++) {
      faces.faceOffsets[partial.startAtom + index] = offset + partial.faceOffsets[index];
      faces.voronoiIndices[partial.startAtom + index] = partial.voronoiIndices[index];
    }
    offset += faceCounts[partialIndex];
    if (consumePartials) { delete partial.faceOffsets; delete partial.voronoiIndices; }
  }
  faces.faceOffsets[atomCount] = offset;
  const first = sorted[0], output = { ...result, ...faces, startAtom: 0, endAtom: atomCount,
    sourceAtomCount: atomCount, cellVolume: first.cellVolume, boundaryMode: first.boundaryMode,
    faceAreaThreshold: first.faceAreaThreshold, relativeFaceAreaThreshold: first.relativeFaceAreaThreshold,
    candidateCount: sorted.reduce((sum, partial) => sum + partial.candidateCount, 0),
    kernelInitializations: sorted.filter(partial => !partial.kernelReused).length, warning: null };
  output.indexBuilds = sorted.filter(partial => !partial.indexReused).length;
  output.frameUploads = sorted.filter(partial => partial.frameUploaded).length;
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
      minCoordination: coordinationStats.min, maxCoordination: coordinationStats.max,
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
