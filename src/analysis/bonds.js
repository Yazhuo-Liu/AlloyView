import { NeighborSearch, NeighborBuffer, atomRange } from './neighbors.js';

export const MAX_BONDS = 1_000_000;
export const MAX_NEIGHBORS_PER_ATOM = 100_000;

/** Unique undirected edges of a periodic graph. A vector starts at the wrapped
 * first atom and ends at the indicated image of the second atom. Self images
 * are valid edges; only one of the opposite translations is stored.
 */
export function calculateBonds(frame, { cutoff, pairCutoffs = [], maxBonds = MAX_BONDS, onPhase = () => {},
  onAtoms = () => {}, ...range } = {}) {
  const startedAt = performance.now();
  const count = frame.fractional.length / 3;
  const { startAtom, endAtom } = atomRange(count, range);
  if (!Number.isFinite(cutoff) || cutoff <= 0) throw new Error('Bond cutoff must be positive and finite.');
  if (!Number.isInteger(maxBonds) || maxBonds < 1 || maxBonds > MAX_BONDS) {
    throw new Error(`Bond output is limited to ${MAX_BONDS.toLocaleString('en-US')} edges.`);
  }
  if (!ArrayBuffer.isView(frame.types) || frame.types.length !== count) throw new Error('Bonds require one element type per atom.');
  if (!Array.isArray(pairCutoffs)) throw new Error('Element-pair cutoffs must be an array.');
  const overrides = new Map();
  let maximumCutoff = cutoff;
  for (const entry of pairCutoffs) {
    const { first, second, cutoff: value } = entry;
    if (![first, second].every((type) => Number.isInteger(type) && type >= 0)
        || !Number.isFinite(value) || value < 0) throw new Error('Invalid element-pair cutoff.');
    const key = pairKey(first, second);
    if (overrides.has(key)) throw new Error('Each element pair can have only one cutoff.');
    overrides.set(key, value);
    maximumCutoff = Math.max(maximumCutoff, value);
  }
  onPhase('indexing');
  const search = (frame.neighborSearch ?? new NeighborSearch(frame));
  onPhase('analyzing');
  const coordination = new Uint32Array(endAtom - startAtom);
  let capacity = Math.min(256, maxBonds), length = 0;
  let indices = new Uint32Array(capacity * 2), vectors = new Float32Array(capacity * 3), shifts = new Int32Array(capacity * 3);
  const scratch = new NeighborBuffer();
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    const neighbors = search.collect(atom, maximumCutoff, scratch, MAX_NEIGHBORS_PER_ATOM + 1);
    if (neighbors.length > MAX_NEIGHBORS_PER_ATOM) throw new Error('Too many bond neighbors; reduce the cutoff.');
    for (let i = 0; i < neighbors.length; i++) {
      const other = neighbors.atoms[i];
      const pairCutoff = overrides.size ? overrides.get(pairKey(frame.types[atom], frame.types[other])) ?? cutoff : cutoff;
      if (!pairCutoff || neighbors.distanceSquared[i] > pairCutoff ** 2 || neighbors.distanceSquared[i] <= 1e-24) continue;
      coordination[atom - startAtom] += 1;
      if (other < atom) continue;
      if (other === atom && !positiveShift(neighbors.imageA[i], neighbors.imageB[i], neighbors.imageC[i])) continue;
      if (length === maxBonds) throw new Error(`Bond output exceeds ${maxBonds.toLocaleString('en-US')} edges; reduce the cutoff.`);
      if (length === capacity) {
        capacity = Math.min(maxBonds, capacity * 2);
        const nextIndices = new Uint32Array(capacity * 2), nextVectors = new Float32Array(capacity * 3), nextShifts = new Int32Array(capacity * 3);
        nextIndices.set(indices); nextVectors.set(vectors); nextShifts.set(shifts);
        indices = nextIndices; vectors = nextVectors; shifts = nextShifts;
      }
      indices[length * 2] = atom; indices[length * 2 + 1] = other;
      vectors[length * 3] = neighbors.xs[i]; vectors[length * 3 + 1] = neighbors.ys[i]; vectors[length * 3 + 2] = neighbors.zs[i];
      shifts[length * 3] = neighbors.imageA[i]; shifts[length * 3 + 1] = neighbors.imageB[i]; shifts[length * 3 + 2] = neighbors.imageC[i];
      length += 1;
    }
    if ((atom - startAtom + 1) % 256 === 0) onAtoms(atom - startAtom + 1, endAtom - startAtom);
  }
  onAtoms(endAtom - startAtom, endAtom - startAtom);
  return { startAtom, endAtom, indices: indices.slice(0, length * 2), vectors: vectors.slice(0, length * 3),
    shifts: shifts.slice(0, length * 3), count: length, coordination, elapsedMs: performance.now() - startedAt, warning: null };
}

function pairKey(first, second) {
  if (Number.isInteger(first) && Number.isInteger(second) && first >= 0 && second >= 0 && first < 2 ** 26 && second < 2 ** 26) {
    return first <= second ? first * 2 ** 26 + second : second * 2 ** 26 + first;
  }
  return first <= second ? `${first}:${second}` : `${second}:${first}`;
}
function positiveShift(a, b, c) { return a ? a > 0 : b ? b > 0 : c > 0; }
