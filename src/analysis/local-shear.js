import { NeighborSearch, atomRange } from './neighbors.js';
import { MAX_NEIGHBORS_PER_ATOM } from './bonds.js';

/** AtomEye A3/geo.c geometric shear: use the most populous coordination,
 * normalize neighbor second moments by mean squared neighbor length / 3,
 * then evaluate one half of the symmetric Mises invariant. This measures
 * local neighbor geometry, rather than displacement from a reference frame.
 */
export function calculateLocalShear(frame, parameters = {}) {
  const count = frame.fractional.length / 3, { startAtom, endAtom } = atomRange(count, parameters);
  const globalParameters = { ...parameters, startAtom: 0, endAtom: count };
  const coordinationResult = calculateLocalShearCoordination(frame, globalParameters);
  const mode = modalCoordination(coordinationResult.histogram);
  const metrics = calculateLocalShearMetrics(frame, { ...globalParameters, coordinationMode: mode });
  const normalization = metrics.normalizationParticipants ? metrics.normalizationSum / metrics.normalizationParticipants / 3 : NaN;
  const meanMetric = metrics.metricSum.map((value) => value / count / normalization);
  const final = finalizeLocalShear(metrics.metrics.subarray(startAtom * 6, endAtom * 6), { ...parameters, normalization, meanMetric,
    startAtom, endAtom });
  return { ...final, coordination: coordinationResult.coordination.slice(startAtom, endAtom), coordinationMode: mode, normalization, meanMetric,
    averageCoordination: coordinationResult.coordinationSum / count, averageShear: shearInvariant(meanMetric), warning: null };
}

export function calculateLocalShearCoordination(frame, { cutoff, onPhase = () => {}, onAtoms = () => {}, ...range } = {}) {
  validateCutoff(cutoff);
  const count = frame.fractional.length / 3, { startAtom, endAtom } = atomRange(count, range);
  onPhase('indexing');
  const search = new NeighborSearch(frame), coordination = new Uint32Array(endAtom - startAtom), histogram = [];
  let coordinationSum = 0;
  onPhase('analyzing');
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    const neighbors = boundedNeighbors(search, atom, cutoff);
    coordination[atom - startAtom] = neighbors.length;
    coordinationSum += neighbors.length;
    histogram[neighbors.length] = (histogram[neighbors.length] ?? 0) + 1;
    if ((atom - startAtom + 1) % 256 === 0) onAtoms(atom - startAtom + 1, endAtom - startAtom);
  }
  onAtoms(endAtom - startAtom, endAtom - startAtom);
  return { startAtom, endAtom, coordination, histogram: Array.from(histogram, (value) => value ?? 0), coordinationSum };
}

export function calculateLocalShearMetrics(frame, { cutoff, coordinationMode, onPhase = () => {}, onAtoms = () => {}, ...range } = {}) {
  validateCutoff(cutoff);
  const count = frame.fractional.length / 3, { startAtom, endAtom } = atomRange(count, range);
  if (!Number.isInteger(coordinationMode) || coordinationMode < 0) throw new Error('Invalid geometric shear coordination.');
  onPhase('indexing');
  const search = new NeighborSearch(frame), metrics = new Float64Array((endAtom - startAtom) * 6), metricSum = new Array(6).fill(0);
  let normalizationSum = 0, normalizationParticipants = 0;
  onPhase('analyzing');
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    const neighbors = boundedNeighbors(search, atom, cutoff);
    neighbors.sort((a, b) => a.distanceSquared - b.distanceSquared || a.atom - b.atom || a.x - b.x || a.y - b.y || a.z - b.z);
    const participants = Math.min(coordinationMode, neighbors.length), offset = (atom - startAtom) * 6;
    for (let index = 0; index < participants; index += 1) {
      const { x, y, z, distanceSquared } = neighbors[index];
      metrics[offset] += x * x; metrics[offset + 1] += x * y; metrics[offset + 2] += x * z;
      metrics[offset + 3] += y * y; metrics[offset + 4] += y * z; metrics[offset + 5] += z * z;
      if (participants === coordinationMode) { normalizationSum += distanceSquared; normalizationParticipants += 1; }
    }
    for (let component = 0; component < 6; component += 1) {
      if (participants) metrics[offset + component] /= participants;
      metricSum[component] += metrics[offset + component];
    }
    if ((atom - startAtom + 1) % 256 === 0) onAtoms(atom - startAtom + 1, endAtom - startAtom);
  }
  onAtoms(endAtom - startAtom, endAtom - startAtom);
  return { startAtom, endAtom, metrics, metricSum, normalizationSum, normalizationParticipants };
}

export function finalizeLocalShear(metrics, { normalization, meanMetric, subtractMean = false, startAtom = 0,
  endAtom = startAtom + metrics.length / 6, onAtoms = () => {} }) {
  const count = metrics.length / 6, localShear = new Float32Array(count), tensor = new Array(6);
  if (!Number.isFinite(normalization) || normalization <= 0) localShear.fill(NaN);
  else for (let atom = 0; atom < count; atom += 1) {
    for (let component = 0; component < 6; component += 1) {
      tensor[component] = metrics[atom * 6 + component] / normalization - (subtractMean ? meanMetric[component] : 0);
    }
    localShear[atom] = shearInvariant(tensor);
    if ((atom + 1) % 4096 === 0) onAtoms(atom + 1, count);
  }
  onAtoms(count, count);
  return { startAtom, endAtom, localShear };
}

export function modalCoordination(histogram) {
  let mode = 0;
  for (let value = 1; value < histogram.length; value += 1) if ((histogram[value] ?? 0) > (histogram[mode] ?? 0)) mode = value;
  return mode;
}

export function shearInvariant([xx, xy, xz, yy, yz, zz]) {
  return Math.sqrt(xy ** 2 + xz ** 2 + yz ** 2 + ((xx - yy) ** 2 + (xx - zz) ** 2 + (yy - zz) ** 2) / 6) / 2;
}

function validateCutoff(cutoff) {
  if (!Number.isFinite(cutoff) || cutoff <= 0) throw new Error('Geometric shear cutoff must be positive and finite.');
}
function boundedNeighbors(search, atom, cutoff) {
  const neighbors = search.within(atom, cutoff, MAX_NEIGHBORS_PER_ATOM + 1);
  if (neighbors.length > MAX_NEIGHBORS_PER_ATOM) throw new Error('Too many geometric shear neighbors; reduce the cutoff.');
  return neighbors;
}
