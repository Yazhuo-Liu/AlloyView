// Grain segmentation of a polycrystal from PTM structure types, lattice
// orientations and template neighbor lists.
//
// A JavaScript port of the grain segmentation modifier of OVITO 3.9.4:
// GrainSegmentationEngine.{h,cpp}, NodePairSampling.cpp, ThresholdSelection.h
// and DisjointSet.h (Copyright 2023 OVITO GmbH, Germany; Copyright 2020 Peter
// Mahler Larsen), used under the MIT option of OVITO's GPLv3-or-MIT dual
// license. The pinned sources and their license are in third_party/grains;
// the notice shipped with the build is licenses/GrainSegmentation-MIT.txt.
// Method: P. M. Larsen et al., "Robust structural identification via
// polyhedral template matching" and T. Bonald et al., "Hierarchical graph
// clustering using node pair sampling" (arXiv:1806.01664).
//
// The arithmetic keeps the upstream operand order. Where upstream leaves an
// order unspecified (thread scheduling, unstable sorts, hash-set iteration,
// heap ties) this port fixes one, so results are deterministic; see
// docs/features/grains.md for every such choice.

import { invert3 } from '../data/model.js';
import { interfacialDisorientation, latticeDisorientation, mapOntoTarget, NO_DISORIENTATION } from './disorientation.js';

export const GRAIN_ALGORITHMS = Object.freeze(['automatic', 'manual', 'mst']);
export const GRAIN_DEFAULTS = Object.freeze({ algorithm: 'automatic', mergeThreshold: 0, minGrainSize: 100,
  adoptOrphans: true, handleCoherentInterfaces: true });
/** Default threshold of the minimum spanning tree, in degrees. OVITO shares
 * one threshold field, 0 by default, between its manual algorithms. */
export const GRAIN_DEFAULT_MST_THRESHOLD = 2;
/** Neighbor bonds at or above this disorientation, in degrees, never join the graph. */
export const GRAIN_MISORIENTATION_LIMIT = 4;
/** Merges of clusters smaller than this are left out of the merge plot. */
export const GRAIN_MIN_PLOT_SIZE = 20;
/** Residuals within this many median absolute deviations of the fit are inliers. */
export const GRAIN_THRESHOLD_CUTOFF = 1.5;
export const MAX_GRAIN_SIZE_LIMIT = 2 ** 31 - 1;
/** Slots per atom in the PTM neighbor lists, and the neighbors an unmatched
 * atom contributes (OVITO's MAX_DISORDERED_NEIGHBORS). They equal
 * PTM_TEMPLATE_NEIGHBORS and PTM_UNMATCHED_NEIGHBORS of ptm.js; this module
 * does not import the PTM kernel, so Workers that only cluster stay light. */
export const GRAIN_NEIGHBOR_SLOTS = 16;
export const GRAIN_DISORDERED_NEIGHBORS = 8;

const OTHER = 0, FCC = 1, HCP = 2, CUBIC_DIAMOND = 6, HEX_DIAMOND = 7;
const NONE = -1;
// FLOATTYPE_EPSILON of OVITO's double-precision build.
const SPAN_EPSILON = 1e-12;

export function validateGrainParameters({ algorithm = GRAIN_DEFAULTS.algorithm, mergeThreshold = GRAIN_DEFAULTS.mergeThreshold,
  minGrainSize = GRAIN_DEFAULTS.minGrainSize, adoptOrphans = GRAIN_DEFAULTS.adoptOrphans,
  handleCoherentInterfaces = GRAIN_DEFAULTS.handleCoherentInterfaces } = {}) {
  if (!GRAIN_ALGORITHMS.includes(algorithm)) throw new Error('Choose a grain algorithm: automatic, manual or minimum spanning tree.');
  if (typeof mergeThreshold !== 'number' || !Number.isFinite(mergeThreshold) || Math.abs(mergeThreshold) > 1e6) {
    throw new Error('The grain merge threshold must be a finite number.');
  }
  if (algorithm === 'mst' && mergeThreshold < 0) throw new Error('The minimum spanning tree threshold is a disorientation in degrees and cannot be negative.');
  if (!Number.isInteger(minGrainSize) || minGrainSize < 1 || minGrainSize > MAX_GRAIN_SIZE_LIMIT) {
    throw new Error('The minimum grain size must be a positive whole number of atoms.');
  }
  if (typeof adoptOrphans !== 'boolean' || typeof handleCoherentInterfaces !== 'boolean') {
    throw new Error('Grain orphan adoption and coherent-interface handling must be on or off.');
  }
  return { algorithm, mergeThreshold, minGrainSize, adoptOrphans, handleCoherentInterfaces };
}

/** Union–find with path halving and union by size (OVITO's DisjointSet). */
export class DisjointSet {
  constructor(count) {
    this.parents = new Uint32Array(count);
    this.sizes = new Uint32Array(count);
    this.clear();
  }

  clear() {
    for (let index = 0; index < this.parents.length; index += 1) this.parents[index] = index;
    this.sizes.fill(1);
  }

  find(index) {
    const parents = this.parents;
    let x = parents[index];
    while (x !== parents[x]) {
      parents[x] = parents[parents[x]];
      x = parents[x];
    }
    parents[index] = x;
    return x;
  }

  /** The root of the larger set survives; the first argument's on a tie. */
  merge(first, second) {
    const a = this.find(first), b = this.find(second);
    if (a === b) return a;
    if (this.sizes[a] < this.sizes[b]) {
      this.parents[a] = b;
      this.sizes[b] += this.sizes[a];
      return b;
    }
    this.parents[b] = a;
    this.sizes[a] += this.sizes[b];
    return a;
  }

  size(index) { return this.sizes[index]; }
}

/** Stable ascending order of `count` non-negative doubles. Their IEEE 754 bit
 * patterns sort like the values, so four 16-bit counting passes suffice. */
export function stableAscendingOrder(keys, count = keys.length) {
  let order = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) order[index] = index;
  if (count < 2) return order;
  let radix = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 && keys instanceof Float64Array && keys.byteOffset % 4 === 0;
  // NaN, negative values and −0 do not sort by their bit patterns.
  for (let index = 0; radix && index < count; index += 1) if (!(keys[index] > 0) && !Object.is(keys[index], 0)) radix = false;
  if (!radix) return order.sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : a - b));
  const words = new Uint32Array(keys.buffer, keys.byteOffset, count * 2), counts = new Uint32Array(65536);
  let scratch = new Uint32Array(count);
  for (let pass = 0; pass < 4; pass += 1) {
    const word = pass >> 1, shift = (pass & 1) * 16;
    counts.fill(0);
    for (let index = 0; index < count; index += 1) counts[(words[index * 2 + word] >>> shift) & 65535] += 1;
    if (counts[(words[word] >>> shift) & 65535] === count) continue;
    let total = 0;
    for (let bucket = 0; bucket < 65536; bucket += 1) { const size = counts[bucket]; counts[bucket] = total; total += size; }
    for (let index = 0; index < count; index += 1) {
      const item = order[index];
      scratch[counts[(words[item * 2 + word] >>> shift) & 65535]++] = item;
    }
    [order, scratch] = [scratch, order];
  }
  return order;
}

/** Binary min-heap of appended records, ordered by key and then by insertion. */
class RecordQueue {
  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.first = new Uint32Array(capacity);
    this.second = new Uint32Array(capacity);
    this.heap = new Uint32Array(capacity);
    this.records = 0;
    this.length = 0;
  }

  grow() {
    const capacity = this.keys.length * 2;
    for (const name of ['keys', 'first', 'second', 'heap']) {
      const larger = new this[name].constructor(capacity);
      larger.set(this[name]);
      this[name] = larger;
    }
  }

  before(a, b) { return this.keys[a] < this.keys[b] || (this.keys[a] === this.keys[b] && a < b); }

  push(key, first, second) {
    // Popped records are not reused; restart numbering once the heap drains.
    if (this.length === 0) this.records = 0;
    if (this.records === this.keys.length) this.grow();
    const record = this.records++;
    this.keys[record] = key; this.first[record] = first; this.second[record] = second;
    const heap = this.heap;
    let position = this.length++;
    while (position > 0) {
      const parent = (position - 1) >> 1;
      if (!this.before(record, heap[parent])) break;
      heap[position] = heap[parent];
      position = parent;
    }
    heap[position] = record;
  }

  /** Remove and return the record with the smallest key. */
  pop() {
    const heap = this.heap, top = heap[0], last = heap[--this.length];
    let position = 0;
    for (;;) {
      let child = position * 2 + 1;
      if (child >= this.length) break;
      if (child + 1 < this.length && this.before(heap[child + 1], heap[child])) child += 1;
      if (!this.before(heap[child], last)) break;
      heap[position] = heap[child];
      position = child;
    }
    if (this.length) heap[position] = last;
    return top;
  }
}

function typedInput(value, Type, length, name) {
  if (!(value instanceof Type) || value.length !== length) throw new Error(`Grain segmentation requires ${name} for every atom.`);
  return value;
}

const AXES = 'ABC';
function thinCellError(axis) {
  return new Error(`The cell is too short along cell vector ${AXES[axis]} for grain segmentation: an atom has its own periodic image, or two images of one atom, among its neighbors. Replicate the structure along ${AXES[axis]} first.`);
}

/** One bond per atom pair (a < b) for every neighbor b in the PTM list of a,
 * as OVITO builds them: the relation is the list of the lower-indexed atom. */
function createNeighborBonds({ atomCount, structures, neighborCounts, neighborIndices, neighborSpan, fractional, cell }) {
  for (let axis = 0; axis < 3; axis += 1) {
    if (cell.pbc[axis] && neighborSpan && neighborSpan[axis] >= .5 + SPAN_EPSILON) throw thinCellError(axis);
  }
  let count = 0;
  for (let atom = 0; atom < atomCount; atom += 1) {
    const row = atom * GRAIN_NEIGHBOR_SLOTS;
    const length = structures[atom] === OTHER ? Math.min(neighborCounts[atom], GRAIN_DISORDERED_NEIGHBORS) : neighborCounts[atom];
    if (length > GRAIN_NEIGHBOR_SLOTS) throw new Error('Grain segmentation found an invalid PTM neighbor list.');
    for (let slot = 0; slot < length; slot += 1) {
      const neighbor = neighborIndices[row + slot];
      if (neighbor >= atomCount) throw new Error('Grain segmentation found a PTM neighbor outside the structure.');
      if (neighbor > atom) count += 1;
    }
  }
  const a = new Uint32Array(count), b = new Uint32Array(count), lengths = new Float64Array(count);
  const inverse = invert3(cell.vectors), h = cell.vectors, pbc = cell.pbc;
  let bond = 0;
  for (let atom = 0; atom < atomCount; atom += 1) {
    const row = atom * GRAIN_NEIGHBOR_SLOTS;
    const length = structures[atom] === OTHER ? Math.min(neighborCounts[atom], GRAIN_DISORDERED_NEIGHBORS) : neighborCounts[atom];
    for (let slot = 0; slot < length; slot += 1) {
      const neighbor = neighborIndices[row + slot];
      // The same atom twice, or the atom itself, means two periodic images
      // share one list. Upstream then fails with "Graph has self loops".
      let repeated = neighbor === atom;
      for (let earlier = 0; earlier < slot && !repeated; earlier += 1) repeated = neighborIndices[row + earlier] === neighbor;
      if (repeated) throw thinCellError(shortestPeriodicAxis(cell, inverse));
      if (neighbor < atom) continue;
      let d0 = fractional[neighbor * 3] - fractional[atom * 3], d1 = fractional[neighbor * 3 + 1] - fractional[atom * 3 + 1],
        d2 = fractional[neighbor * 3 + 2] - fractional[atom * 3 + 2];
      if (pbc[0]) d0 -= Math.round(d0);
      if (pbc[1]) d1 -= Math.round(d1);
      if (pbc[2]) d2 -= Math.round(d2);
      const x = d0 * h[0] + d1 * h[3] + d2 * h[6], y = d0 * h[1] + d1 * h[4] + d2 * h[7], z = d0 * h[2] + d1 * h[5] + d2 * h[8];
      a[bond] = atom; b[bond] = neighbor; lengths[bond] = Math.sqrt(x * x + y * y + z * z);
      bond += 1;
    }
  }
  return { a, b, lengths, count };
}

/** The periodic cell vector with the smallest perpendicular width. */
function shortestPeriodicAxis(cell, inverse) {
  let best = 0, smallest = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    if (!cell.pbc[axis]) continue;
    const height = 1 / Math.hypot(inverse[axis], inverse[3 + axis], inverse[6 + axis]);
    if (height < smallest) { smallest = height; best = axis; }
  }
  return best;
}

/** Which way a cubic/hexagonal interface bond points, as (parent, defect). */
class InterfaceHandler {
  constructor(structures) {
    const counts = new Float64Array(9);
    for (const type of structures) counts[type] += 1;
    this.parentFcc = counts[FCC] >= counts[HCP];
    this.parentCubicDiamond = counts[CUBIC_DIAMOND] >= counts[HEX_DIAMOND];
    this.pair = new Uint32Array(2);
  }

  parentPhase(defectType) {
    if (defectType === HCP) return FCC;
    if (defectType === FCC) return HCP;
    return defectType === HEX_DIAMOND ? CUBIC_DIAMOND : HEX_DIAMOND;
  }

  /** Order (a, b) as (parent phase, defect phase); false for any other pair. */
  reorder(a, b, types) {
    const sa = types[a], sb = types[b];
    let flipped;
    if (sa === FCC && sb === HCP) flipped = !this.parentFcc;
    else if (sa === HCP && sb === FCC) flipped = this.parentFcc;
    else if (sa === CUBIC_DIAMOND && sb === HEX_DIAMOND) flipped = !this.parentCubicDiamond;
    else if (sa === HEX_DIAMOND && sb === CUBIC_DIAMOND) flipped = this.parentCubicDiamond;
    else return false;
    this.pair[0] = flipped ? b : a; this.pair[1] = flipped ? a : b;
    return true;
  }
}

/** Relabel the minority phase of coherent interfaces (HCP layers of stacking
 * faults and twin boundaries in FCC, or the reverse; likewise for diamond) as
 * the parent phase, each atom taking the parent-phase orientation equivalent
 * to its own. Atoms are converted outward from the parent phase, smallest
 * interfacial disorientation first. */
function rotateInterfaceAtoms(input, bonds, types, orientations) {
  const { neighborCounts, neighborIndices } = input;
  const handler = new InterfaceHandler(input.structures), queue = new RecordQueue(), rotated = new Float64Array(4);
  const interfaceAngle = (a, b) => {
    if (!handler.reorder(a, b, types)) return Infinity;
    const parent = handler.pair[0], defect = handler.pair[1];
    const parentIsCubic = types[parent] === FCC || types[parent] === CUBIC_DIAMOND;
    return interfacialDisorientation(parentIsCubic, orientations, parent * 4, orientations, defect * 4, rotated, 0);
  };
  for (let bond = 0; bond < bonds.count; bond += 1) {
    const angle = interfaceAngle(bonds.a[bond], bonds.b[bond]);
    if (angle < GRAIN_MISORIENTATION_LIMIT) queue.push(angle, handler.pair[0], handler.pair[1]);
  }
  let converted = 0;
  while (queue.length) {
    const record = queue.pop();
    // Either atom may have been converted since this bond was queued.
    if (!(interfaceAngle(queue.first[record], queue.second[record]) < GRAIN_MISORIENTATION_LIMIT)) continue;
    const atom = handler.pair[1];
    types[atom] = handler.parentPhase(types[atom]);
    orientations.set(rotated, atom * 4);
    converted += 1;
    const row = atom * GRAIN_NEIGHBOR_SLOTS;
    for (let slot = 0; slot < neighborCounts[atom]; slot += 1) {
      const neighbor = neighborIndices[row + slot];
      const angle = interfaceAngle(atom, neighbor);
      if (angle < GRAIN_MISORIENTATION_LIMIT) queue.push(angle, handler.pair[0], handler.pair[1]);
    }
  }
  return converted;
}

function isCrystallineBond(typeA, typeB, handleCoherentInterfaces) {
  if (typeA === OTHER || typeB === OTHER) return false;
  if (typeA === typeB) return true;
  if (!handleCoherentInterfaces) return false;
  return (typeA === FCC && typeB === HCP) || (typeA === HCP && typeB === FCC)
    || (typeA === CUBIC_DIAMOND && typeB === HEX_DIAMOND) || (typeA === HEX_DIAMOND && typeB === CUBIC_DIAMOND);
}

/** exp(−d²/3), with d < 10⁻⁵° counted as zero (upstream's guard against an
 * endless merge loop in ideal crystals). */
export function grainEdgeWeight(disorientation) {
  if (disorientation < 1e-5) disorientation = 0;
  return Math.exp(-1 / 3 * disorientation * disorientation);
}

const target = new Float64Array(4), mapped = new Float64Array(4);
/** Add cluster orientation sum `child` to `parent` after mapping it to the
 * symmetry equivalent closest to the parent. The norm of each sum is its
 * cluster's weight. Returns their disorientation in radians. */
function accumulateOrientation(structure, sums, parent, child) {
  const p = parent * 4, c = child * 4;
  // OVITO's quaternion is (x, y, z, w); its norm adds in that order.
  const parentNorm = Math.sqrt(sums[p + 1] * sums[p + 1] + sums[p + 2] * sums[p + 2] + sums[p + 3] * sums[p + 3] + sums[p] * sums[p]);
  const childNorm = Math.sqrt(sums[c + 1] * sums[c + 1] + sums[c + 2] * sums[c + 2] + sums[c + 3] * sums[c + 3] + sums[c] * sums[c]);
  for (let k = 0; k < 4; k += 1) { target[k] = sums[p + k] / parentNorm; mapped[k] = sums[c + k] / childNorm; }
  if (structure === OTHER) return NO_DISORIENTATION;
  const angle = mapOntoTarget(structure, target, 0, mapped, 0);
  for (let k = 0; k < 4; k += 1) sums[p + k] += mapped[k] * childNorm;
  return angle;
}

/** Growable list of merges: the two cluster representatives, the merge
 * distance and the orientation sum of the merged cluster. */
class Dendrogram {
  constructor(capacity) {
    this.a = new Uint32Array(capacity); this.b = new Uint32Array(capacity);
    this.distance = new Float64Array(capacity); this.orientation = new Float64Array(capacity * 4);
    this.count = 0;
  }

  add(a, b, distance, sums) {
    const index = this.count++;
    this.a[index] = a; this.b[index] = b; this.distance[index] = distance;
    for (let k = 0; k < 4; k += 1) this.orientation[index * 4 + k] = sums[a * 4 + k];
  }
}

/** Weighted graph whose nodes are clusters. Adjacency is a doubly linked list
 * of half-edges per node; edge e has half-edges 2e and 2e + 1, which share a
 * weight. Upstream keeps a red-black tree per node; the merge order depends
 * only on the nearest neighbor of each node, which is the same either way. */
class ClusterGraph {
  constructor(nodeCount, edgeCapacity) {
    this.nodeWeight = new Float64Array(nodeCount);
    this.degree = new Uint32Array(nodeCount);
    this.head = new Int32Array(nodeCount).fill(NONE);
    this.active = new Uint8Array(nodeCount);
    this.activeCount = 0;
    this.cursor = 0;
    this.mark = new Int32Array(nodeCount).fill(NONE);
    this.next = new Int32Array(edgeCapacity * 2);
    this.previous = new Int32Array(edgeCapacity * 2);
    this.opposite = new Uint32Array(edgeCapacity * 2);
    this.weight = new Float64Array(edgeCapacity);
    this.edges = 0;
    this.nearest = NONE;
  }

  link(node, half) {
    const first = this.head[node];
    this.previous[half] = NONE; this.next[half] = first;
    if (first !== NONE) this.previous[first] = half;
    this.head[node] = half;
    this.degree[node] += 1;
  }

  unlink(node, half) {
    const before = this.previous[half], after = this.next[half];
    if (before === NONE) this.head[node] = after; else this.next[before] = after;
    if (after !== NONE) this.previous[after] = before;
    this.degree[node] -= 1;
  }

  addEdge(u, v, weight) {
    if (this.degree[u] === 0) { this.active[u] = 1; this.activeCount += 1; }
    this.nodeWeight[u] += weight;
    if (this.degree[v] === 0) { this.active[v] = 1; this.activeCount += 1; }
    this.nodeWeight[v] += weight;
    const edge = this.edges++;
    this.weight[edge] = weight;
    this.opposite[edge * 2] = v; this.link(u, edge * 2);
    this.opposite[edge * 2 + 1] = u; this.link(v, edge * 2 + 1);
  }

  removeNode(node) {
    if (this.active[node]) { this.active[node] = 0; this.activeCount -= 1; }
  }

  /** The lowest-indexed remaining node. Upstream takes the first element of
   * a hash set, an order the C++ standard leaves to the library. */
  nextNode() {
    while (!this.active[this.cursor]) this.cursor += 1;
    return this.cursor;
  }

  /** Sets `nearest` to the neighbor v minimizing w(v) / w(a, v), the lowest
   * index on ties, and returns the distance w(a) w(v) / w(a, v). */
  nearestNeighbor(a) {
    let minimum = Number.MAX_VALUE, nearest = NONE;
    for (let half = this.head[a]; half !== NONE; half = this.next[half]) {
      const v = this.opposite[half], d = this.nodeWeight[v] / this.weight[half >> 1];
      if (d < minimum) { minimum = d; nearest = v; }
      else if (d === minimum) nearest = nearest === NONE || v < nearest ? v : nearest;
    }
    this.nearest = nearest;
    return minimum * this.nodeWeight[a];
  }

  /** Merge two adjacent nodes into the one with more neighbors (the first on
   * a tie) and return it. Edges to a common neighbor add their weights. */
  contractEdge(a, b) {
    if (this.degree[b] > this.degree[a]) { const swap = a; a = b; b = swap; }
    const { mark, next, opposite, weight } = this;
    for (let half = this.head[a]; half !== NONE; half = next[half]) mark[opposite[half]] = half;
    const joining = mark[b];
    this.unlink(a, joining); this.unlink(b, joining ^ 1);
    mark[b] = NONE;
    for (let half = this.head[b]; half !== NONE;) {
      const following = next[half], v = opposite[half], twin = half ^ 1, existing = mark[v];
      this.unlink(b, half);
      if (existing !== NONE) {
        weight[existing >> 1] += weight[half >> 1];
        this.unlink(v, twin);
      } else {
        this.link(a, half);
        opposite[twin] = a;
      }
      half = following;
    }
    for (let half = this.head[a]; half !== NONE; half = next[half]) mark[opposite[half]] = NONE;
    this.removeNode(b);
    this.nodeWeight[a] += this.nodeWeight[b];
    return a;
  }
}

/** Agglomerative clustering by node pair sampling, with nearest-neighbor chains. */
function nodePairSamplingClustering(graph, types, sums, dendrogram, report) {
  const totalWeight = 1, chain = [];
  // The chain revisits a node only after a merge, so the work is linear in
  // the node count. The bound turns a non-terminating input into an error.
  let budget = 64 * graph.activeCount + 1024, merges = 0;
  while (graph.activeCount) {
    chain.push(graph.nextNode());
    while (chain.length) {
      if (--budget < 0) throw new Error('Grain clustering did not converge for this structure.');
      const a = chain.pop(), distance = graph.nearestNeighbor(a), b = graph.nearest;
      if (b === NONE) graph.removeNode(a); // The last node of a connected component.
      else if (chain.length) {
        const c = chain.pop();
        if (b === c) {
          const parent = graph.contractEdge(a, b), child = parent === a ? b : a;
          accumulateOrientation(types[parent], sums, parent, child);
          dendrogram.add(parent, child, distance / totalWeight, sums);
          if ((++merges & 4095) === 0) report(merges);
        } else { chain.push(c, a, b); }
      } else chain.push(a, b);
    }
  }
}

/** Single-linkage clustering: join clusters along bonds of increasing disorientation. */
function minimumSpanningTreeClustering(bonds, order, types, handleCoherentInterfaces, sums, dendrogram, report) {
  const sets = new DisjointSet(types.length);
  for (let index = 0; index < order.length; index += 1) {
    const bond = order[index], angle = bonds.disorientation[bond];
    if (!(angle < GRAIN_MISORIENTATION_LIMIT)) break;
    const first = sets.find(bonds.a[bond]), second = sets.find(bonds.b[bond]);
    if (first !== second && isCrystallineBond(types[bonds.a[bond]], types[bonds.b[bond]], handleCoherentInterfaces)) {
      const parent = sets.merge(first, second), child = parent === first ? second : first;
      accumulateOrientation(types[parent], sums, parent, child);
      dendrogram.add(parent, child, angle, sums);
    }
    if ((index & 65535) === 0) report(index);
  }
}

function median(values) {
  const sorted = Float64Array.from(values).sort(), n = sorted.length;
  return n % 2 === 0 ? (sorted[n / 2] + sorted[n / 2 - 1]) / 2 : sorted[(n - 1) / 2];
}

/** Robust line through (log merge size, log merge distance), weighted by
 * merge size: 100 rounds of iteratively reweighted least squares for least
 * absolute deviations (OVITO's ThresholdSelection::Regressor). Merges inside
 * a grain follow this line; merges across grain boundaries lie above it. */
export function fitMergeDistances(mergeSizes, distances, count = mergeSizes.length) {
  const xs = new Float64Array(count), ys = new Float64Array(count), residuals = new Float64Array(count);
  if (count === 0) return { gradient: 0, intercept: 0, deviation: 0, xs, ys, residuals };
  const weights = new Float64Array(count);
  for (let i = 0; i < count; i += 1) { weights[i] = mergeSizes[i]; xs[i] = Math.log(mergeSizes[i]); ys[i] = Math.log(distances[i]); }
  const w = Float64Array.from(weights);
  let gradient = 0, intercept = 0;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    let sum = 0;
    for (let i = 0; i < count; i += 1) sum += w[i];
    for (let i = 0; i < count; i += 1) w[i] /= sum;
    let xMean = 0, yMean = 0;
    for (let i = 0; i < count; i += 1) { xMean += w[i] * xs[i]; yMean += w[i] * ys[i]; }
    let sumXX = 0, sumXY = 0;
    for (let i = 0; i < count; i += 1) {
      sumXX += w[i] * (xs[i] - xMean) * (xs[i] - xMean);
      sumXY += w[i] * (xs[i] - xMean) * (ys[i] - yMean);
    }
    gradient = sumXY / sumXX;
    intercept = yMean - gradient * xMean;
    for (let i = 0; i < count; i += 1) {
      const r = Math.abs(ys[i] - (gradient * xs[i] + intercept));
      residuals[i] = r;
      w[i] = weights[i] / (1e-4 < r ? r : 1e-4);
    }
  }
  return { gradient, intercept, deviation: median(residuals), xs, ys, residuals };
}

/** The largest log distance among merges within `cutoff` median absolute
 * deviations above the fitted line; never below zero, as upstream. */
export function suggestMergeThreshold(fit, cutoff = GRAIN_THRESHOLD_CUTOFF) {
  let threshold = 0;
  for (let i = 0; i < fit.xs.length; i += 1) {
    const residual = fit.ys[i] - (fit.xs[i] * fit.gradient + fit.intercept);
    if (residual < cutoff * fit.deviation && threshold < fit.ys[i]) threshold = fit.ys[i];
  }
  return threshold;
}

function validateInput(input) {
  const atomCount = input?.structures?.length;
  if (!Number.isInteger(atomCount) || atomCount < 1) throw new Error('Grain segmentation requires PTM structure types.');
  typedInput(input.structures, Uint8Array, atomCount, 'PTM structure types');
  typedInput(input.orientations, Float64Array, atomCount * 4, 'PTM orientations');
  typedInput(input.neighborCounts, Uint8Array, atomCount, 'PTM neighbor lists');
  typedInput(input.neighborIndices, Uint32Array, atomCount * GRAIN_NEIGHBOR_SLOTS, 'PTM neighbor lists');
  if (!(input.fractional instanceof Float64Array || input.fractional instanceof Float32Array) || input.fractional.length !== atomCount * 3) {
    throw new Error('Grain segmentation requires coordinates for every atom.');
  }
  if (input.neighborSpan !== undefined && input.neighborSpan !== null && input.neighborSpan.length !== 3) {
    throw new Error('Grain segmentation requires the neighbor span of each cell vector.');
  }
  if (input.cell?.vectors?.length !== 9 || input.cell.pbc?.length !== 3) throw new Error('Grain segmentation requires a simulation cell.');
  for (const type of input.structures) if (type > 8) throw new Error('Grain segmentation found an unknown PTM structure type.');
  return atomCount;
}

/**
 * First stage: neighbor bonds, disorientations and the complete merge
 * sequence. The returned model answers any merge threshold, minimum grain
 * size and orphan setting through segmentGrains without repeating this work.
 * The automatic and manual algorithms share one model; the minimum spanning
 * tree needs its own.
 *
 * input: { structures, orientations (w, x, y, z), neighborCounts,
 *   neighborIndices, neighborSpan, fractional, cell } from calculatePtm with
 *   neighborLists: true.
 */
export function buildGrainDendrogram(input, { algorithm = GRAIN_DEFAULTS.algorithm,
  handleCoherentInterfaces = GRAIN_DEFAULTS.handleCoherentInterfaces, includeRegression = false, onProgress = () => {} } = {}) {
  ({ algorithm, handleCoherentInterfaces } = validateGrainParameters({ algorithm, handleCoherentInterfaces }));
  const atomCount = validateInput(input), structures = input.structures;
  onProgress('bonds', 0);
  const bonds = createNeighborBonds({ ...input, atomCount });

  // OVITO stores the PTM orientation in single precision before the grain
  // modifier reads it; unmatched atoms carry a null quaternion.
  const sourceOrientations = new Float32Array(atomCount * 4);
  for (let atom = 0; atom < atomCount; atom += 1) {
    if (structures[atom] === OTHER) continue;
    for (let k = 0; k < 4; k += 1) sourceOrientations[atom * 4 + k] = input.orientations[atom * 4 + k];
  }
  const types = Uint8Array.from(structures), orientations = Float64Array.from(sourceOrientations);
  onProgress('interfaces', 0);
  const convertedAtoms = handleCoherentInterfaces ? rotateInterfaceAtoms(input, bonds, types, orientations) : 0;

  onProgress('disorientation', 0);
  bonds.disorientation = new Float64Array(bonds.count);
  for (let bond = 0; bond < bonds.count; bond += 1) {
    const a = bonds.a[bond], b = bonds.b[bond];
    bonds.disorientation[bond] = latticeDisorientation(types[a], types[b], orientations, a * 4, orientations, b * 4);
    if ((bond & 262143) === 0) onProgress('disorientation', bond / bonds.count);
  }
  // Ascending disorientation, ties in bond order (upstream sort is unstable).
  const order = stableAscendingOrder(bonds.disorientation, bonds.count);

  const graphClustering = algorithm !== 'mst';
  let crystallineAtoms = 0;
  for (let atom = 0; atom < atomCount; atom += 1) if (types[atom] !== OTHER) crystallineAtoms += 1;
  const sums = Float64Array.from(orientations), merges = new Dendrogram(Math.max(1, crystallineAtoms));
  onProgress('merging', 0);
  let graphEdges = 0;
  if (graphClustering) {
    let edgeCount = 0;
    for (let bond = 0; bond < bonds.count; bond += 1) {
      if (bonds.disorientation[bond] < GRAIN_MISORIENTATION_LIMIT && isCrystallineBond(types[bonds.a[bond]], types[bonds.b[bond]], handleCoherentInterfaces)) edgeCount += 1;
    }
    const graph = new ClusterGraph(atomCount, edgeCount);
    // Weights are added to each node in ascending disorientation, so ties add
    // equal weights and the sums do not depend on their order.
    for (let index = 0; index < order.length; index += 1) {
      const bond = order[index], angle = bonds.disorientation[bond];
      if (!(angle < GRAIN_MISORIENTATION_LIMIT)) break;
      if (isCrystallineBond(types[bonds.a[bond]], types[bonds.b[bond]], handleCoherentInterfaces)) graph.addEdge(bonds.a[bond], bonds.b[bond], grainEdgeWeight(angle));
    }
    graphEdges = graph.edges;
    const total = Math.max(1, graph.activeCount);
    nodePairSamplingClustering(graph, types, sums, merges, done => onProgress('merging', done / total));
  } else {
    minimumSpanningTreeClustering(bonds, order, types, handleCoherentInterfaces, sums, merges,
      done => onProgress('merging', done / Math.max(1, order.length)));
  }

  onProgress('threshold', 0);
  // Ascending merge distance; ties keep creation order, in which a cluster's
  // own merges always precede the merge that consumes it.
  const mergeCount = merges.count, mergeOrder = stableAscendingOrder(merges.distance, mergeCount);
  const dendrogram = { count: mergeCount, a: new Uint32Array(mergeCount), b: new Uint32Array(mergeCount),
    distance: new Float64Array(mergeCount), orientation: new Float64Array(mergeCount * 4),
    size: new Uint32Array(mergeCount), mergeSize: new Float64Array(mergeCount) };
  const sets = new DisjointSet(atomCount);
  let plotted = 0;
  for (let index = 0; index < mergeCount; index += 1) {
    const source = mergeOrder[index], a = merges.a[source], b = merges.b[source];
    dendrogram.a[index] = a; dendrogram.b[index] = b; dendrogram.distance[index] = merges.distance[source];
    for (let k = 0; k < 4; k += 1) dendrogram.orientation[index * 4 + k] = merges.orientation[source * 4 + k];
    const sa = sets.size(sets.find(a)), sb = sets.size(sets.find(b));
    dendrogram.size[index] = Math.min(sa, sb);
    dendrogram.mergeSize[index] = 2 / (1 / sa + 1 / sb); // Harmonic mean.
    sets.merge(a, b);
    if (dendrogram.size[index] >= GRAIN_MIN_PLOT_SIZE) plotted += 1;
  }

  // The merge plot: distance against the size of the smaller merged cluster.
  const plot = { distance: new Float64Array(plotted), size: new Uint32Array(plotted),
    unit: graphClustering ? 'log' : 'degrees' };
  for (let index = 0, point = 0; index < mergeCount; index += 1) {
    if (dendrogram.size[index] < GRAIN_MIN_PLOT_SIZE) continue;
    plot.distance[point] = graphClustering ? Math.log(dendrogram.distance[index]) : dendrogram.distance[index];
    plot.size[point++] = dendrogram.size[index];
  }
  let suggestedThreshold = null, regression = null;
  if (graphClustering) {
    const fit = fitMergeDistances(dendrogram.mergeSize, dendrogram.distance, mergeCount);
    suggestedThreshold = suggestMergeThreshold(fit);
    regression = { gradient: fit.gradient, intercept: fit.intercept, deviation: fit.deviation,
      ...(includeRegression ? { logMergeSize: fit.xs, logDistance: fit.ys } : {}) };
  }
  onProgress('threshold', 1);
  return { atomCount, graphClustering, handleCoherentInterfaces, structures, sourceOrientations, types,
    bonds: { count: bonds.count, a: bonds.a, b: bonds.b, lengths: bonds.lengths, order }, dendrogram, plot,
    suggestedThreshold, regression, crystallineAtoms, convertedAtoms, graphEdges };
}

/** Assign every atom still without a grain to the grain reached by the
 * shortest path of neighbor bonds, measured by summed bond length. */
function adoptOrphanAtoms(model, grainId, sizes) {
  const { atomCount, bonds } = model, { a, b, lengths, order } = bonds;
  // Bonds with an orphan end, listed under both of their atoms.
  const offsets = new Uint32Array(atomCount + 1);
  for (let index = 0; index < order.length; index += 1) {
    const bond = order[index];
    if (grainId[a[bond]] === 0 || grainId[b[bond]] === 0) { offsets[a[bond] + 1] += 1; offsets[b[bond] + 1] += 1; }
  }
  for (let atom = 0; atom < atomCount; atom += 1) offsets[atom + 1] += offsets[atom];
  const cursor = offsets.slice(0, atomCount), neighbors = new Uint32Array(offsets[atomCount]), spans = new Float64Array(offsets[atomCount]);
  const queue = new RecordQueue();
  for (let index = 0; index < order.length; index += 1) {
    const bond = order[index], first = a[bond], second = b[bond], grainA = grainId[first], grainB = grainId[second];
    if (grainA !== 0 && grainB !== 0) continue;
    neighbors[cursor[first]] = second; spans[cursor[first]++] = lengths[bond];
    neighbors[cursor[second]] = first; spans[cursor[second]++] = lengths[bond];
    if (grainA !== 0) queue.push(lengths[bond], grainA, second);
    else if (grainB !== 0) queue.push(lengths[bond], grainB, first);
  }
  let adopted = 0;
  while (queue.length) {
    const record = queue.pop(), grain = queue.first[record], atom = queue.second[record], length = queue.keys[record];
    if (grainId[atom] !== 0) continue;
    grainId[atom] = grain;
    sizes[grain - 1] += 1;
    adopted += 1;
    for (let entry = offsets[atom]; entry < offsets[atom + 1]; entry += 1) {
      if (grainId[neighbors[entry]] === 0) queue.push(length + spans[entry], grain, neighbors[entry]);
    }
  }
  return adopted;
}

/**
 * Second stage: apply merges up to the threshold, discard small clusters,
 * number grains by size and optionally adopt orphan atoms.
 *
 * mergeThreshold is a log merge distance for the manual algorithm and a
 * disorientation in degrees for the minimum spanning tree; the automatic
 * algorithm ignores it and uses model.suggestedThreshold.
 */
export function segmentGrains(model, options = {}) {
  const { algorithm, mergeThreshold, minGrainSize, adoptOrphans } = validateGrainParameters({
    ...options, algorithm: options.algorithm ?? (model.graphClustering ? 'automatic' : 'mst'),
    handleCoherentInterfaces: model.handleCoherentInterfaces });
  if ((algorithm !== 'mst') !== model.graphClustering) throw new Error('This merge sequence was built for another grain algorithm.');
  const { atomCount, structures, types, dendrogram } = model;
  const appliedThreshold = algorithm === 'automatic' ? model.suggestedThreshold : mergeThreshold;
  const limit = algorithm === 'mst' ? Math.log(appliedThreshold) : appliedThreshold;
  const mean = Float64Array.from(model.sourceOrientations), sets = new DisjointSet(atomCount);
  let appliedMerges = 0;
  for (let index = 0; index < dendrogram.count; index += 1) {
    if (Math.log(dendrogram.distance[index]) > limit) break;
    sets.merge(dendrogram.a[index], dendrogram.b[index]);
    const root = sets.find(dendrogram.a[index]);
    for (let k = 0; k < 4; k += 1) mean[root * 4 + k] = dendrogram.orientation[index * 4 + k];
    appliedMerges += 1;
  }

  // Number the clusters that remain grains, in order of their root atom.
  const remapping = new Uint32Array(atomCount), roots = [];
  for (let atom = 0; atom < atomCount; atom += 1) {
    if (sets.find(atom) !== atom) continue;
    if (sets.size(atom) < minGrainSize || structures[atom] === OTHER) continue;
    roots.push(atom);
    remapping[atom] = roots.length;
  }
  const grainCount = roots.length, grainId = new Uint32Array(atomCount), initialSizes = new Uint32Array(grainCount);
  for (let atom = 0; atom < atomCount; atom += 1) {
    const grain = remapping[sets.find(atom)];
    grainId[atom] = grain;
    if (grain !== 0) initialSizes[grain - 1] += 1;
  }

  // Largest grain first; equal sizes keep the order of their root atoms.
  const bySize = (counts, a, b) => counts[b] - counts[a] || a - b;
  let ranking = Array.from({ length: grainCount }, (_, index) => index).sort((a, b) => bySize(initialSizes, a, b));
  const renumber = () => {
    const newId = new Uint32Array(grainCount + 1);
    ranking.forEach((old, index) => { newId[old + 1] = index + 1; });
    for (let atom = 0; atom < atomCount; atom += 1) grainId[atom] = newId[grainId[atom]];
  };
  renumber();
  let sizes = Uint32Array.from(ranking, old => initialSizes[old]), rankedRoots = ranking.map(old => roots[old]);
  let adoptedAtoms = 0;
  if (adoptOrphans && grainCount > 0) {
    adoptedAtoms = adoptOrphanAtoms(model, grainId, sizes);
    // Upstream keeps the numbering from before adoption, which can leave the
    // list slightly out of size order. Rank again by the final sizes.
    ranking = Array.from({ length: grainCount }, (_, index) => index).sort((a, b) => bySize(sizes, a, b));
    if (ranking.some((old, index) => old !== index)) {
      renumber();
      sizes = Uint32Array.from(ranking, old => sizes[old]);
      rankedRoots = ranking.map(old => rankedRoots[old]);
    }
  }

  const structureTypes = new Uint8Array(grainCount), rootStructureTypes = new Uint8Array(grainCount);
  const orientations = new Float64Array(grainCount * 4);
  let assignedAtoms = 0;
  rankedRoots.forEach((root, index) => {
    // The lattice the grain was merged in, which its orientation refers to.
    structureTypes[index] = types[root];
    // What OVITO lists: the PTM type of the root atom, possibly the minority phase.
    rootStructureTypes[index] = structures[root];
    const w = mean[root * 4], x = mean[root * 4 + 1], y = mean[root * 4 + 2], z = mean[root * 4 + 3];
    const norm = Math.sqrt(x * x + y * y + z * z + w * w);
    orientations[index * 4] = w / norm; orientations[index * 4 + 1] = x / norm;
    orientations[index * 4 + 2] = y / norm; orientations[index * 4 + 3] = z / norm;
    assignedAtoms += sizes[index];
  });
  return { grainId, grainCount, sizes, structureTypes, rootStructureTypes, orientations,
    algorithm, handleCoherentInterfaces: model.handleCoherentInterfaces,
    mergeThreshold: appliedThreshold, suggestedThreshold: model.suggestedThreshold, minGrainSize, adoptOrphans,
    appliedMerges, mergeCount: dendrogram.count, adoptedAtoms, assignedAtoms, unassignedAtoms: atomCount - assignedAtoms,
    largestSize: grainCount ? sizes[0] : 0, meanSize: grainCount ? assignedAtoms / grainCount : 0,
    crystallineAtoms: model.crystallineAtoms, convertedAtoms: model.convertedAtoms, bondCount: model.bonds.count,
    graphEdges: model.graphEdges, plot: model.plot, regression: model.regression };
}

/** Both stages. The result also carries `model`, which segmentGrains accepts
 * again for other thresholds, minimum sizes and orphan settings. */
export function calculateGrains(input, options = {}) {
  const parameters = validateGrainParameters(options);
  const startedAt = performance.now();
  const model = buildGrainDendrogram(input, { ...parameters, includeRegression: options.includeRegression, onProgress: options.onProgress });
  const result = segmentGrains(model, parameters);
  return { ...result, model, elapsedMs: performance.now() - startedAt };
}

/** Rotation angle in degrees and unit axis of a unit quaternion (w, x, y, z)
 * taken with w ≥ 0; the axis of the identity is reported as [0, 0, 1]. */
export function quaternionAxisAngle(quaternion, offset = 0) {
  let w = quaternion[offset], x = quaternion[offset + 1], y = quaternion[offset + 2], z = quaternion[offset + 3];
  if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
  const sine = Math.hypot(x, y, z);
  if (!(sine > 1e-12)) return { angle: 0, axis: [0, 0, 1] };
  return { angle: 2 * Math.atan2(sine, w) * 180 / Math.PI, axis: [x / sine, y / sine, z / sine] };
}

/** Bunge Euler angles (φ1, Φ, φ2) in degrees, Z–X–Z, of the passive rotation
 * g = R(q)ᵀ that takes sample coordinates to crystal coordinates. PTM's
 * quaternion actively rotates the ideal lattice into the sample frame, so
 * R(q) = Z(φ1) X(Φ) Z(φ2). φ1 and φ2 lie in [0, 360), Φ in [0, 180]. */
export function quaternionBungeEuler(quaternion, offset = 0) {
  const w = quaternion[offset], x = quaternion[offset + 1], y = quaternion[offset + 2], z = quaternion[offset + 3];
  const degrees = 180 / Math.PI, wrap = angle => { const turn = angle * degrees % 360; return turn < 0 ? turn + 360 : turn; };
  // Elements of R(q): r[row][column].
  const r02 = 2 * (x * z + w * y), r12 = 2 * (y * z - w * x), r22 = 1 - 2 * (x * x + y * y);
  const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x);
  const sinePhi = Math.hypot(r02, r12);
  if (sinePhi < 1e-9) {
    // Φ = 0 or 180°: only φ1 ± φ2 is defined; report it as φ1.
    const r00 = 1 - 2 * (y * y + z * z), r10 = 2 * (x * y + w * z);
    return [wrap(Math.atan2(r10, r00)), r22 > 0 ? 0 : 180, 0];
  }
  return [wrap(Math.atan2(r02, -r12)), Math.atan2(sinePhi, r22) * degrees, wrap(Math.atan2(r20, r21))];
}
