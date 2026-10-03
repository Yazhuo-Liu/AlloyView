import { cellFaceHeights, determinant3 } from '../data/model.js';
import { NeighborSearch, atomRange } from './neighbors.js';
import { MAX_NEIGHBORS_PER_ATOM } from './bonds.js';

/** Radial distribution with directed neighbor counts and exact spherical shell
 * volumes. The half-face-height limit prevents counting repeated atom images;
 * N(N-1), or the corresponding partial population, corrects finite systems.
 * Open boundaries require a separate surface correction and are rejected.
 */
export function calculateRdf(frame, { cutoff, bins = 100, firstType = null, secondType = null,
  onPhase = () => {}, onAtoms = () => {}, ...range } = {}) {
  const count = frame.fractional.length / 3;
  const { startAtom, endAtom } = atomRange(count, range);
  const normalization = rdfNormalization(frame, { cutoff, bins, firstType, secondType });
  onPhase('indexing');
  const search = new NeighborSearch(frame);
  const counts = new Float64Array(bins);
  onPhase('analyzing');
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    if (firstType === null || frame.types[atom] === firstType) {
      const neighbors = search.within(atom, cutoff, MAX_NEIGHBORS_PER_ATOM + 1);
      if (neighbors.length > MAX_NEIGHBORS_PER_ATOM) throw new Error('Too many RDF neighbors; reduce the cutoff.');
      for (const neighbor of neighbors) {
        if (neighbor.atom === atom || (secondType !== null && frame.types[neighbor.atom] !== secondType)) continue;
        const bin = Math.floor(Math.sqrt(neighbor.distanceSquared) / cutoff * bins);
        if (bin < bins) counts[bin] += 1;
      }
    }
    if ((atom - startAtom + 1) % 256 === 0) onAtoms(atom - startAtom + 1, endAtom - startAtom);
  }
  onAtoms(endAtom - startAtom, endAtom - startAtom);
  return { startAtom, endAtom, ...finalizeRdf(counts, normalization) };
}

export function rdfNormalization(frame, { cutoff, bins, firstType = null, secondType = null }) {
  const count = frame.fractional.length / 3;
  if (!frame.cell.pbc.every(Boolean)) throw new Error('Normalized RDF requires periodic boundaries along all three cell axes.');
  const maximumCutoff = Math.min(...cellFaceHeights(frame.cell)) / 2;
  if (!Number.isFinite(cutoff) || cutoff <= 0 || cutoff > maximumCutoff * (1 + 1e-12)) {
    throw new Error(`RDF cutoff must be positive and at most ${maximumCutoff.toPrecision(6)} (half the shortest cell face height).`);
  }
  if (!Number.isInteger(bins) || bins < 1 || bins > 4096) throw new Error('RDF requires 1–4096 histogram bins.');
  if (![firstType, secondType].every((type) => type === null || (Number.isInteger(type) && type >= 0))) throw new Error('Invalid RDF element selection.');
  if (!ArrayBuffer.isView(frame.types) || frame.types.length !== count) throw new Error('RDF requires one element type per atom.');
  let centerCount = 0, targetCount = 0, overlap = 0;
  for (const type of frame.types) {
    const center = firstType === null || type === firstType, target = secondType === null || type === secondType;
    centerCount += Number(center); targetCount += Number(target); overlap += Number(center && target);
  }
  const pairPopulation = centerCount * targetCount - overlap;
  if (pairPopulation <= 0) throw new Error('RDF requires at least one distinct selected atom pair.');
  return { method: 'periodic-finite-population', volume: Math.abs(determinant3(frame.cell.vectors)), cutoff, bins,
    maximumCutoff, firstType, secondType, centerCount, targetCount, pairPopulation, directedCounts: true };
}

export function finalizeRdf(counts, normalization) {
  const { bins, cutoff, volume, pairPopulation } = normalization;
  const radii = new Float64Array(bins), values = new Float64Array(bins), width = cutoff / bins;
  for (let bin = 0; bin < bins; bin += 1) {
    const lower = bin * width, upper = (bin + 1) * width;
    const shellVolume = 4 * Math.PI / 3 * (upper ** 3 - lower ** 3);
    radii[bin] = (lower + upper) / 2;
    values[bin] = counts[bin] * volume / (pairPopulation * shellVolume);
  }
  return { radii, values, counts, normalization, warning: null };
}
