import { NeighborSearch, atomRange } from './neighbors.js';
import { MAX_NEIGHBORS_PER_ATOM } from './bonds.js';

export const CLUSTER_NEIGHBOR_MODES = Object.freeze(['cutoff', 'bonds']);

/** Union-find over atoms with the integer periodic image of each atom relative
 * to its parent. An edge (first, second, s) states that `second` at image s is
 * a neighbor of `first`: u(second) − u(first) = s for the unwrapped images u.
 * Joining two trees fixes their relative image; an edge inside one tree whose
 * shift disagrees closes a loop through a periodic boundary, so that cluster
 * is infinite (percolating). Union by size keeps trees shallow.
 */
class ImageForest {
  constructor(startAtom, endAtom, { record = true } = {}) {
    this.startAtom = startAtom;
    this.span = endAtom - startAtom;
    this.nodeCount = this.span;
    this.external = new Map();
    this.allocate(this.span + (record ? 64 : 0));
    for (let node = 0; node < this.span; node += 1) this.parent[node] = node;
    this.size.fill(1, 0, this.span);
    this.stack = new Int32Array(64);
    this.record = record;
    this.edgeCount = 0;
    this.pairs = new Int32Array(record ? 512 : 0);
    this.shifts = new Int32Array(record ? 768 : 0);
  }

  allocate(capacity) {
    const parent = new Int32Array(capacity), size = new Int32Array(capacity);
    const offset = new Int32Array(capacity * 3), flag = new Uint8Array(capacity);
    if (this.parent) { parent.set(this.parent); size.set(this.size); offset.set(this.offset); flag.set(this.flag); }
    Object.assign(this, { capacity, parent, size, offset, flag });
  }

  /** Dense nodes for the owned central range; neighbors outside it are added
   * on first use, so a chunk never allocates arrays for the whole frame. */
  node(atom) {
    const local = atom - this.startAtom;
    if (local >= 0 && local < this.span) return local;
    let node = this.external.get(atom);
    if (node !== undefined) return node;
    if (this.nodeCount === this.capacity) this.allocate(this.capacity * 2);
    node = this.nodeCount++;
    this.parent[node] = node; this.size[node] = 1;
    this.external.set(atom, node);
    return node;
  }

  /** Root of `node`. Path compression rewrites each visited offset relative
   * to the root, so afterwards offset[node] is u(node) − u(root). */
  find(node) {
    const parent = this.parent, offset = this.offset;
    let root = node, depth = 0;
    while (parent[root] !== root) {
      if (depth === this.stack.length) { const stack = new Int32Array(depth * 2); stack.set(this.stack); this.stack = stack; }
      this.stack[depth++] = root;
      root = parent[root];
    }
    for (let level = depth - 2; level >= 0; level -= 1) {
      const current = this.stack[level], above = this.stack[level + 1];
      offset[current * 3] += offset[above * 3];
      offset[current * 3 + 1] += offset[above * 3 + 1];
      offset[current * 3 + 2] += offset[above * 3 + 2];
      parent[current] = root;
    }
    return root;
  }

  add(first, second, shiftA, shiftB, shiftC) {
    const a = this.node(first), b = this.node(second);
    const rootA = this.find(a), rootB = this.find(b), offset = this.offset;
    const a0 = offset[a * 3], a1 = offset[a * 3 + 1], a2 = offset[a * 3 + 2];
    const b0 = offset[b * 3], b1 = offset[b * 3 + 1], b2 = offset[b * 3 + 2];
    if (rootA === rootB) {
      if (b0 - a0 === shiftA && b1 - a1 === shiftB && b2 - a2 === shiftC) return;
      // One inconsistent loop proves percolation; later ones add nothing.
      if (!this.flag[rootA]) { this.flag[rootA] = 1; this.emit(first, second, shiftA, shiftB, shiftC); }
      return;
    }
    // u(rootB) − u(rootA) = s + (u(a) − u(rootA)) − (u(b) − u(rootB)).
    const d0 = shiftA + a0 - b0, d1 = shiftB + a1 - b1, d2 = shiftC + a2 - b2;
    if (this.size[rootA] < this.size[rootB]) {
      this.parent[rootA] = rootB;
      offset[rootA * 3] = -d0; offset[rootA * 3 + 1] = -d1; offset[rootA * 3 + 2] = -d2;
      this.size[rootB] += this.size[rootA]; this.flag[rootB] |= this.flag[rootA];
    } else {
      this.parent[rootB] = rootA;
      offset[rootB * 3] = d0; offset[rootB * 3 + 1] = d1; offset[rootB * 3 + 2] = d2;
      this.size[rootA] += this.size[rootB]; this.flag[rootA] |= this.flag[rootB];
    }
    this.emit(first, second, shiftA, shiftB, shiftC);
  }

  emit(first, second, shiftA, shiftB, shiftC) {
    if (!this.record) return;
    if (this.edgeCount * 2 === this.pairs.length) {
      const pairs = new Int32Array(this.pairs.length * 2), shifts = new Int32Array(this.shifts.length * 2);
      pairs.set(this.pairs); shifts.set(this.shifts);
      this.pairs = pairs; this.shifts = shifts;
    }
    const edge = this.edgeCount++;
    this.pairs[edge * 2] = first; this.pairs[edge * 2 + 1] = second;
    this.shifts[edge * 3] = shiftA; this.shifts[edge * 3 + 1] = shiftB; this.shifts[edge * 3 + 2] = shiftC;
  }
}

function edgeRule(frame, { cutoff, pairCutoffs = [], neighborMode = 'cutoff' }, count) {
  if (!CLUSTER_NEIGHBOR_MODES.includes(neighborMode)) throw new Error('Cluster neighbors must use a cutoff or the bond cutoffs.');
  if (!Number.isFinite(cutoff) || cutoff <= 0) throw new Error('The cluster cutoff must be positive and finite.');
  if (!Array.isArray(pairCutoffs)) throw new Error('Element-pair cutoffs must be an array.');
  const overrides = new Map();
  let maximumCutoff = cutoff;
  for (const entry of pairCutoffs) {
    const { first, second, cutoff: value } = entry ?? {};
    if (![first, second].every((type) => Number.isInteger(type) && type >= 0 && type < 2 ** 20)
        || !Number.isFinite(value) || value < 0) throw new Error('Invalid element-pair cutoff.');
    const key = pairKey(first, second);
    if (overrides.has(key)) throw new Error('Each element pair can have only one cutoff.');
    overrides.set(key, value);
    maximumCutoff = Math.max(maximumCutoff, value);
  }
  const types = frame.types;
  if (overrides.size && (!ArrayBuffer.isView(types) || types.length !== count)) {
    throw new Error('Element-pair cutoffs require one element type per atom.');
  }
  const bonds = neighborMode === 'bonds';
  // The same acceptance as calculateBonds: a zero pair cutoff removes that
  // pair. Bond mode also follows its exclusion of coincident atoms; a plain
  // cutoff connects them.
  return { maximumCutoff, accepts(first, second, distanceSquared) {
    const pairCutoff = overrides.size ? overrides.get(pairKey(types[first], types[second])) ?? cutoff : cutoff;
    if (!pairCutoff || distanceSquared > pairCutoff ** 2) return false;
    return !(bonds && distanceSquared <= 1e-24);
  } };
}

function selectionMask(selection, count) {
  if (selection === null || selection === undefined) return null;
  if (!(selection instanceof Uint8Array) || selection.length !== count) {
    throw new Error('The cluster selection must contain one flag per atom.');
  }
  return selection;
}

/**
 * Accepted neighbor edges of central atoms [startAtom, endAtom), reduced to a
 * spanning forest plus at most one loop-closing edge per percolating tree.
 * Edges from different ranges then reproduce exactly the same connected
 * components, periodic images and percolation flags as the complete graph:
 * every omitted edge closes a loop with zero net image shift.
 */
export function calculateClusterEdges(frame, { cutoff, pairCutoffs = [], neighborMode = 'cutoff', clusterSelection = null,
  onPhase = () => {}, onAtoms = () => {}, ...range } = {}) {
  const startedAt = performance.now();
  const count = frame.fractional.length / 3;
  const { startAtom, endAtom } = atomRange(count, range);
  const rule = edgeRule(frame, { cutoff, pairCutoffs, neighborMode }, count);
  const selected = selectionMask(clusterSelection, count);
  onPhase('indexing');
  const search = frame.neighborSearch ?? new NeighborSearch(frame);
  onPhase('analyzing');
  const forest = new ImageForest(startAtom, endAtom);
  let acceptedEdges = 0;
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    if (!selected || selected[atom]) {
      const neighbors = search.within(atom, rule.maximumCutoff, MAX_NEIGHBORS_PER_ATOM + 1);
      if (neighbors.length > MAX_NEIGHBORS_PER_ATOM) throw new Error('Too many cluster neighbors; reduce the cutoff.');
      for (const neighbor of neighbors) {
        const other = neighbor.atom;
        // Each undirected edge once: from its lower atom, or for a periodic
        // self image, from the positive one of the opposite translations.
        if (other < atom || (other === atom && !positiveShift(neighbor.imageA, neighbor.imageB, neighbor.imageC))) continue;
        if (selected && !selected[other]) continue;
        if (!rule.accepts(atom, other, neighbor.distanceSquared)) continue;
        acceptedEdges += 1;
        forest.add(atom, other, neighbor.imageA, neighbor.imageB, neighbor.imageC);
      }
    }
    if ((atom - startAtom + 1) % 256 === 0) onAtoms(atom - startAtom + 1, endAtom - startAtom);
  }
  onAtoms(endAtom - startAtom, endAtom - startAtom);
  return { startAtom, endAtom, edgeCount: forest.edgeCount, pairs: forest.pairs.slice(0, forest.edgeCount * 2),
    shifts: forest.shifts.slice(0, forest.edgeCount * 3), acceptedEdges, elapsedMs: performance.now() - startedAt };
}

/**
 * Label connected components and measure them. The result depends only on
 * the edge set, not on its order or partitioning:
 * - clusters are first ordered by their smallest atom index; with
 *   `sortBySize`, IDs 1..N follow descending size, ties by that atom index;
 *   excluded atoms have ID 0;
 * - each finite cluster is unwrapped with its smallest-index atom at its
 *   wrapped position; sums run over atoms in index order;
 * - a percolating cluster has no unique unwrapping, so its center, radius of
 *   gyration and gyration tensor are NaN.
 * Masses weight centers and gyration when every included atom has a finite
 * positive mass; otherwise atoms have equal weight.
 */
export function finalizeClusters(frame, { edgePairs = new Int32Array(0), edgeShifts = new Int32Array(0), clusterSelection = null,
  clusterMasses = null, sortBySize = true, onPhase = () => {} } = {}) {
  const startedAt = performance.now();
  const { fractional, cell } = frame;
  const count = fractional.length / 3;
  if (!Number.isInteger(count) || count < 1) throw new Error('Cluster analysis requires at least one atom.');
  const selected = selectionMask(clusterSelection, count);
  const edgeCount = edgePairs.length / 2;
  if (!Number.isInteger(edgeCount) || edgeShifts.length !== edgeCount * 3) throw new Error('Cluster edges are incomplete.');
  onPhase('finalizing');
  let masses = null, warning = null;
  if (clusterMasses !== null && clusterMasses !== undefined) {
    if (!ArrayBuffer.isView(clusterMasses) || clusterMasses.length !== count) throw new Error('Atom masses must contain one value per atom.');
    masses = clusterMasses;
    for (let atom = 0; atom < count; atom += 1) {
      if ((!selected || selected[atom]) && !(Number.isFinite(masses[atom]) && masses[atom] > 0)) {
        masses = null;
        warning = `Atom ${atom + 1} has a mass that is not finite and positive; centers and radii of gyration use equal atom weights.`;
        break;
      }
    }
  }

  const forest = new ImageForest(0, count, { record: false });
  for (let edge = 0; edge < edgeCount; edge += 1) {
    const first = edgePairs[edge * 2], second = edgePairs[edge * 2 + 1];
    if (!(first >= 0 && first < count && second >= 0 && second < count)
        || (selected && !(selected[first] && selected[second]))) throw new Error('A cluster edge refers to an excluded or missing atom.');
    forest.add(first, second, edgeShifts[edge * 3], edgeShifts[edge * 3 + 1], edgeShifts[edge * 3 + 2]);
  }

  // Provisional clusters in order of their smallest atom; that atom anchors
  // the unwrapping, independent of which tree root union-find happened to keep.
  const clusterId = new Uint32Array(count);
  const rootCluster = new Int32Array(count).fill(-1);
  const firstAtoms = new Uint32Array(count), counts = new Uint32Array(count), anchors = new Int32Array(count * 3);
  const flags = new Uint8Array(count);
  let clusterCount = 0, includedAtoms = 0;
  const offset = forest.offset;
  for (let atom = 0; atom < count; atom += 1) {
    if (selected && !selected[atom]) continue;
    includedAtoms += 1;
    const root = forest.find(atom);
    let cluster = rootCluster[root];
    if (cluster < 0) {
      cluster = rootCluster[root] = clusterCount++;
      firstAtoms[cluster] = atom; flags[cluster] = forest.flag[root];
      anchors[cluster * 3] = offset[atom * 3]; anchors[cluster * 3 + 1] = offset[atom * 3 + 1]; anchors[cluster * 3 + 2] = offset[atom * 3 + 2];
    }
    counts[cluster] += 1;
    clusterId[atom] = cluster + 1;
  }

  const order = new Uint32Array(clusterCount);
  let largestSize = 0;
  for (let cluster = 0; cluster < clusterCount; cluster += 1) largestSize = Math.max(largestSize, counts[cluster]);
  if (sortBySize && clusterCount) {
    // Stable counting sort: descending size, then ascending smallest atom.
    const starts = new Uint32Array(largestSize + 1);
    for (let cluster = 0; cluster < clusterCount; cluster += 1) starts[largestSize - counts[cluster]] += 1;
    for (let bucket = 0, next = 0; bucket <= largestSize; bucket += 1) { const size = starts[bucket]; starts[bucket] = next; next += size; }
    for (let cluster = 0; cluster < clusterCount; cluster += 1) order[starts[largestSize - counts[cluster]]++] = cluster;
  } else for (let cluster = 0; cluster < clusterCount; cluster += 1) order[cluster] = cluster;
  const rank = new Uint32Array(clusterCount);
  for (let index = 0; index < clusterCount; index += 1) rank[order[index]] = index;

  const sizes = new Uint32Array(clusterCount), percolating = new Uint8Array(clusterCount), firstAtomIndices = new Uint32Array(clusterCount);
  for (let index = 0; index < clusterCount; index += 1) {
    sizes[index] = counts[order[index]]; percolating[index] = flags[order[index]]; firstAtomIndices[index] = firstAtoms[order[index]];
  }
  const totalWeights = new Float64Array(clusterCount), centers = new Float64Array(clusterCount * 3);
  const gyrationTensors = new Float64Array(clusterCount * 6), radiiOfGyration = new Float64Array(clusterCount);
  const clusterSize = new Float64Array(count);
  const { origin, vectors: h, pbc } = cell;
  const o0 = origin?.[0] ?? 0, o1 = origin?.[1] ?? 0, o2 = origin?.[2] ?? 0;
  const position = new Float64Array(3);
  // Wrapped exactly as NeighborSearch stores coordinates, plus the integer
  // image relative to the cluster's anchor atom.
  const unwrapped = (atom, cluster) => {
    let a = fractional[atom * 3], b = fractional[atom * 3 + 1], c = fractional[atom * 3 + 2];
    if (pbc[0]) a -= Math.floor(a);
    if (pbc[1]) b -= Math.floor(b);
    if (pbc[2]) c -= Math.floor(c);
    a += offset[atom * 3] - anchors[cluster * 3];
    b += offset[atom * 3 + 1] - anchors[cluster * 3 + 1];
    c += offset[atom * 3 + 2] - anchors[cluster * 3 + 2];
    position[0] = o0 + a * h[0] + b * h[3] + c * h[6];
    position[1] = o1 + a * h[1] + b * h[4] + c * h[7];
    position[2] = o2 + a * h[2] + b * h[5] + c * h[8];
  };
  for (let atom = 0; atom < count; atom += 1) {
    if (!clusterId[atom]) { clusterSize[atom] = NaN; continue; }
    const cluster = clusterId[atom] - 1, index = rank[cluster];
    clusterId[atom] = index + 1;
    clusterSize[atom] = sizes[index];
    const weight = masses ? masses[atom] : 1;
    totalWeights[index] += weight;
    if (percolating[index]) continue;
    unwrapped(atom, cluster);
    centers[index * 3] += weight * position[0];
    centers[index * 3 + 1] += weight * position[1];
    centers[index * 3 + 2] += weight * position[2];
  }
  for (let index = 0; index < clusterCount; index += 1) {
    for (let axis = 0; axis < 3; axis += 1) centers[index * 3 + axis] = percolating[index] ? NaN : centers[index * 3 + axis] / totalWeights[index];
  }
  for (let atom = 0; atom < count; atom += 1) {
    if (!clusterId[atom]) continue;
    const index = clusterId[atom] - 1;
    if (percolating[index]) continue;
    unwrapped(atom, order[index]);
    const weight = masses ? masses[atom] : 1;
    const dx = position[0] - centers[index * 3], dy = position[1] - centers[index * 3 + 1], dz = position[2] - centers[index * 3 + 2];
    const base = index * 6;
    gyrationTensors[base] += weight * dx * dx;
    gyrationTensors[base + 1] += weight * dy * dy;
    gyrationTensors[base + 2] += weight * dz * dz;
    gyrationTensors[base + 3] += weight * dx * dy;
    gyrationTensors[base + 4] += weight * dx * dz;
    gyrationTensors[base + 5] += weight * dy * dz;
  }
  let percolatingCount = 0;
  for (let index = 0; index < clusterCount; index += 1) {
    const base = index * 6;
    if (percolating[index]) {
      percolatingCount += 1;
      gyrationTensors.fill(NaN, base, base + 6);
      radiiOfGyration[index] = NaN;
      continue;
    }
    for (let component = 0; component < 6; component += 1) gyrationTensors[base + component] /= totalWeights[index];
    radiiOfGyration[index] = Math.sqrt(gyrationTensors[base] + gyrationTensors[base + 1] + gyrationTensors[base + 2]);
  }
  return {
    clusterId, clusterSize, clusterCount, includedAtoms, excludedAtoms: count - includedAtoms,
    sizes, totalWeights, centers, radiiOfGyration, gyrationTensors, percolating, firstAtoms: firstAtomIndices,
    largestSize, percolatingCount, weighting: masses ? 'mass' : 'uniform', sorted: Boolean(sortBySize),
    edgeCount, elapsedMs: performance.now() - startedAt, warning,
  };
}

/** Direct single-thread calculation; the Worker pool partitions only the
 * edge search and produces identical arrays. */
export function calculateClusters(frame, options = {}) {
  const startedAt = performance.now();
  const count = frame.fractional.length / 3;
  if (!Number.isInteger(count) || count < 1) throw new Error('Cluster analysis requires at least one atom.');
  const { startAtom: _start, endAtom: _end, onAtoms, onPhase, ...settings } = options;
  const edges = calculateClusterEdges(frame, { ...settings, onAtoms, onPhase, startAtom: 0, endAtom: count });
  const result = finalizeClusters(frame, { ...settings, onPhase, edgePairs: edges.pairs, edgeShifts: edges.shifts });
  return { ...result, acceptedEdges: edges.acceptedEdges, elapsedMs: performance.now() - startedAt, engine: 'js' };
}

// Numeric keys avoid a string per candidate. Larger type IDs cannot match a
// validated override, so they map to a key that is never stored.
function pairKey(first, second) {
  if (!(first < 2 ** 20 && second < 2 ** 20)) return -1;
  return first <= second ? first * 2 ** 20 + second : second * 2 ** 20 + first;
}
function positiveShift(a, b, c) { return a ? a > 0 : b ? b > 0 : c > 0; }
