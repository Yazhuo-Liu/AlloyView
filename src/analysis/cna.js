import { NeighborSearch, atomRange } from './neighbors.js';

export const STRUCTURE_TYPES = Object.freeze([
  { id: 0, label: 'Other', description: 'Unrecognized or defective', color: [242, 242, 242] },
  { id: 1, label: 'FCC', description: 'Face-centered cubic', color: [102, 255, 102] },
  { id: 2, label: 'HCP', description: 'Hexagonal close-packed', color: [255, 102, 102] },
  { id: 3, label: 'BCC', description: 'Body-centered cubic', color: [102, 102, 255] },
  { id: 4, label: 'ICO', description: 'Icosahedral coordination', color: [242, 204, 51] },
]);

/** Independent CNA implementation following the published a-CNA shell scales.
 * References and signatures: docs/STRUCTURE_ANALYSIS.md.
 */
export function calculateCna(frame, { mode = 'adaptive', cutoff = 3, ...range } = {}) {
  const startedAt = performance.now();
  if (!['adaptive', 'fixed'].includes(mode)) throw new Error('Unknown CNA mode.');
  if (mode === 'fixed' && (!Number.isFinite(cutoff) || cutoff <= 0)) throw new Error('CNA cutoff must be positive and finite.');
  const search = (frame.neighborSearch ?? new NeighborSearch(frame));
  const { startAtom, endAtom } = atomRange(search.count, range);
  const structures = new Uint8Array(endAtom - startAtom);
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    if (mode === 'fixed') {
      // More than 14 neighbors cannot match any supported CNA signature.
      const neighbors = search.within(atom, cutoff, 15);
      structures[atom - startAtom] = classify(neighbors, cutoff);
      continue;
    }
    structures[atom - startAtom] = classifyAdaptiveEnvironment(search.nearest(atom, 14));
  }
  return { structures, startAtom, endAtom, elapsedMs: performance.now() - startedAt };
}

/** Adaptive CNA for one complete, distance-ordered nearest-neighbor shell.
 * Consumers can share their own NeighborSearch rather than building another
 * linked-cell index or launching a second analysis.
 */
export function classifyAdaptiveEnvironment(neighbors) {
  if (neighbors.length < 12) return 0;
  const closePacked = neighbors.slice(0, 12);
  const closePackedRadius = closePacked.reduce((sum, n) => sum + Math.sqrt(n.distanceSquared), 0)
    / 12 * (1 + Math.SQRT2) / 2;
  const closePackedType = classify(closePacked, closePackedRadius);
  if (closePackedType) return closePackedType;
  if (neighbors.length !== 14) return 0;
  const bccRadius = neighbors.reduce((sum, n, index) => (
    sum + Math.sqrt(n.distanceSquared) * (index < 8 ? 2 / Math.sqrt(3) : 1)
  ), 0) / 14 * (1 + Math.SQRT2) / 2;
  return classify(neighbors, bccRadius);
}

/** Classify a complete fixed-radius local environment. GPU kernels use this
 * exact double-precision reference only for numerically ambiguous atoms. */
export function classify(neighbors, radius) {
  const count = neighbors.length;
  if ((count !== 12 && count !== 14) || radius <= 0) return 0;
  const cutoffSquared = radius * radius;
  const bonds = new Uint16Array(count);
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      const dx = neighbors[i].x - neighbors[j].x;
      const dy = neighbors[i].y - neighbors[j].y;
      const dz = neighbors[i].z - neighbors[j].z;
      // Compare local displacement vectors; wrapping these bonds again would
      // incorrectly join different periodic images in small cells.
      if (dx * dx + dy * dy + dz * dz <= cutoffSquared) {
        bonds[i] |= 1 << j;
        bonds[j] |= 1 << i;
      }
    }
  }
  const signatures = new Map();
  for (let i = 0; i < count; i += 1) {
    const common = bonds[i];
    const commonCount = popcount(common);
    if (count === 12 ? commonCount !== 4 && commonCount !== 5 : commonCount !== 4 && commonCount !== 6) return 0;
    let bondCount = 0;
    let longestChain = 0;
    let remaining = common;
    while (remaining) {
      let frontier = remaining & -remaining;
      let visited = 0;
      let componentBonds = 0;
      while (frontier) {
        const bit = frontier & -frontier;
        const node = 31 - Math.clz32(bit);
        frontier &= ~bit;
        visited |= bit;
        const adjacent = bonds[node] & common;
        componentBonds += popcount(adjacent);
        frontier |= adjacent & ~visited;
      }
      remaining &= ~visited;
      componentBonds /= 2;
      bondCount += componentBonds;
      longestChain = Math.max(longestChain, componentBonds);
    }
    const signature = `${commonCount}${bondCount}${longestChain}`;
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  }
  if (count === 12) {
    if (signatures.get('421') === 12) return 1;
    if (signatures.get('421') === 6 && signatures.get('422') === 6) return 2;
    if (signatures.get('555') === 12) return 4;
  } else if (signatures.get('666') === 8 && signatures.get('444') === 6) return 3;
  return 0;
}

function popcount(value) {
  let count = 0;
  while (value) { value &= value - 1; count += 1; }
  return count;
}
