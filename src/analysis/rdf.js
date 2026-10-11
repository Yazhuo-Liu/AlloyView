import { cellFaceHeights, determinant3 } from '../data/model.js';
import { NeighborSearch, atomRange } from './neighbors.js';
import { MAX_NEIGHBORS_PER_ATOM } from './bonds.js';
const preparedContexts = new WeakMap();

/** Radial distribution with directed neighbor counts and exact spherical shell
 * volumes. The half-face-height limit prevents counting repeated atom images;
 * N(N-1), or the corresponding partial population, corrects finite systems.
 * Open boundaries require a separate surface correction and are rejected.
 */
export function calculateRdf(frame, { cutoff, bins = 100, firstType = null, secondType = null,
  onPhase = () => {}, onAtoms = () => {}, ...range } = {}) {
  return calculatePreparedRdf(prepareRdfContext(frame, { cutoff, bins, firstType, secondType }), { ...range, onPhase, onAtoms });
}

/** The optional normalization is an internal pool-to-Worker snapshot. The
 * public calculation always derives populations from its current inputs. */
export function prepareRdfContext(frame, parameters, normalization = rdfNormalization(frame, parameters)) {
  const schema = validateRdfParameters(frame, parameters);
  for (const name of ['cutoff', 'bins', 'firstType', 'secondType', 'maximumCutoff']) {
    if (normalization[name] !== schema[name]) throw new Error('The prepared RDF normalization does not match these inputs.');
  }
  const count = frame.fractional.length / 3;
  if (normalization.volume !== Math.abs(determinant3(frame.cell.vectors))
      || !['centerCount', 'targetCount'].every(name => Number.isInteger(normalization[name]) && normalization[name] >= 0 && normalization[name] <= count)
      || !Number.isFinite(normalization.pairPopulation) || normalization.pairPopulation <= 0
      || normalization.pairPopulation > normalization.centerCount * normalization.targetCount) {
    throw new Error('The prepared RDF populations are invalid.');
  }
  const context = Object.freeze({});
  preparedContexts.set(context, { frame, normalization: Object.freeze({ ...normalization }) });
  return context;
}

export function calculatePreparedRdf(context, { onPhase = () => {}, onAtoms = () => {}, ...range } = {}) {
  const retained = preparedContexts.get(context);
  if (!retained) throw new Error('The prepared RDF context is invalid.');
  const { frame, normalization } = retained;
  const { cutoff, bins, firstType, secondType } = normalization;
  const count = frame.fractional.length / 3;
  const { startAtom, endAtom } = atomRange(count, range);
  onPhase('indexing');
  const search = (frame.neighborSearch ?? new NeighborSearch(frame));
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

export function validateRdfParameters(frame, { cutoff, bins = 100, firstType = null, secondType = null } = {}) {
  const count = frame.fractional.length / 3;
  if (!frame.cell.pbc.every(Boolean)) throw new Error('Normalized RDF requires periodic boundaries along all three cell axes.');
  const maximumCutoff = Math.min(...cellFaceHeights(frame.cell)) / 2;
  if (!Number.isFinite(cutoff) || cutoff <= 0 || cutoff > maximumCutoff * (1 + 1e-12)) {
    throw new Error(`RDF cutoff must be positive and at most ${maximumCutoff.toPrecision(6)} (half the shortest cell face height).`);
  }
  if (!Number.isInteger(bins) || bins < 1 || bins > 4096) throw new Error('RDF requires 1–4096 histogram bins.');
  if (![firstType, secondType].every((type) => type === null || (Number.isInteger(type) && type >= 0))) throw new Error('Invalid RDF element selection.');
  if (!ArrayBuffer.isView(frame.types) || frame.types instanceof DataView || frame.types.length !== count) throw new Error('RDF requires one element type per atom.');
  return { cutoff, bins, firstType, secondType, maximumCutoff };
}

export function rdfNormalization(frame, parameters) {
  const { cutoff, bins, firstType, secondType, maximumCutoff } = validateRdfParameters(frame, parameters);
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
