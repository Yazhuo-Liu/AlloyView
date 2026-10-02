import { NeighborSearch, atomRange } from './neighbors.js';

/** AtomEye-style normalized, disjoint greedy opposite-vector pairing.
 * This is dimensionless, not the conventional CSP in square angstroms.
 */
export function calculateCentrosymmetry(frame, { neighbors = 12, ...range } = {}) {
  const startedAt = performance.now();
  if (!Number.isInteger(neighbors) || neighbors < 2 || neighbors > 32 || neighbors % 2 !== 0) {
    throw new Error('Central symmetry requires an even neighbor count between 2 and 32.');
  }
  const search = new NeighborSearch(frame);
  const { startAtom, endAtom } = atomRange(search.count, range);
  const centrosymmetry = new Float32Array(endAtom - startAtom).fill(NaN);
  let incomplete = 0;
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    const shell = search.nearest(atom, neighbors);
    if (shell.length < neighbors) { incomplete += 1; continue; }
    const denominator = 2 * shell.reduce((sum, n) => sum + n.distanceSquared, 0);
    if (denominator <= 0) { incomplete += 1; continue; }
    const used = new Uint8Array(neighbors);
    let sum = 0;
    for (let i = 0; i < neighbors; i += 1) {
      if (used[i]) continue;
      let best = -1;
      let minimum = Infinity;
      for (let j = i + 1; j < neighbors; j += 1) {
        if (used[j]) continue;
        const x = shell[i].x + shell[j].x;
        const y = shell[i].y + shell[j].y;
        const z = shell[i].z + shell[j].z;
        const value = x * x + y * y + z * z;
        if (value < minimum) { minimum = value; best = j; }
      }
      used[i] = used[best] = 1;
      sum += minimum;
    }
    centrosymmetry[atom - startAtom] = sum / denominator;
  }
  return { centrosymmetry, incomplete, startAtom, endAtom, elapsedMs: performance.now() - startedAt };
}
