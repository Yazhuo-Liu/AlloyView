import { NeighborSearch, NeighborBuffer, atomRange } from './neighbors.js';
import { MAX_NEIGHBORS_PER_ATOM } from './bonds.js';

// Resident search objects own immutable frame snapshots. Retaining one small
// pilot result avoids repeating the pilot for every dynamically scheduled chunk.
const candidateModes = new WeakMap();
const PILOT_ATOMS = 64;

/** AtomEye A3/geo.c geometric shear: use the most populous coordination,
 * normalize neighbor second moments by mean squared neighbor length / 3,
 * then evaluate one half of the symmetric Mises invariant. This measures
 * local neighbor geometry, rather than displacement from a reference frame.
 */
export function calculateLocalShear(frame, parameters = {}) {
  const count = frame.fractional.length / 3, { startAtom, endAtom } = atomRange(count, parameters);
  const globalParameters = { ...parameters, startAtom: 0, endAtom: count };
  const coordinationResult = calculateLocalShearPreparation(frame, globalParameters);
  const mode = modalCoordination(coordinationResult.histogram);
  const fusedMetrics = mode === coordinationResult.candidateCoordinationMode;
  if (!fusedMetrics) delete coordinationResult.metrics;
  const metrics = fusedMetrics ? coordinationResult : calculateLocalShearMetrics(frame, { ...globalParameters,
    coordinationMode: mode, verifiedCoordinationMode: true });
  const normalization = metrics.normalizationParticipants ? metrics.normalizationSum / metrics.normalizationParticipants / 3 : NaN;
  const meanMetric = metrics.metricSum.map((value) => value / count / normalization);
  const final = finalizeLocalShear(metrics.metrics.subarray(startAtom * 6, endAtom * 6), { ...parameters, normalization, meanMetric,
    startAtom, endAtom });
  return { ...final, coordination: coordinationResult.coordination.slice(startAtom, endAtom), coordinationMode: mode, normalization, meanMetric,
    averageCoordination: coordinationResult.coordinationSum / count, averageShear: shearInvariant(meanMetric), warning: null };
}

/** The pilot is a performance hint, never the coordination definition. The
 * complete histogram returned with these candidate moments must be checked
 * before using them; a mismatch requires the exact metrics pass below. */
export function calculateLocalShearPreparation(frame, parameters = {}) {
  validateCutoff(parameters.cutoff);
  const search = frame.neighborSearch ?? new NeighborSearch(frame), count = frame.fractional.length / 3;
  let cached = frame.immutableAnalysisFrame ? candidateModes.get(search) : null;
  if (!cached || cached.cutoff !== parameters.cutoff) {
    const scratch = new NeighborBuffer(), histogram = [], samples = Math.min(PILOT_ATOMS, count);
    for (let index = 0; index < samples; index++) {
      const atom = Math.floor(index * count / samples), neighbors = boundedNeighbors(search, atom, parameters.cutoff, scratch);
      histogram[neighbors.length] = (histogram[neighbors.length] ?? 0) + 1;
    }
    const mode = modalCoordination(histogram);
    // Mixed environments are unlikely to benefit from speculative moments.
    // Only a dominant pilot gets the fast path; the full histogram below is
    // still authoritative even when every pilot atom agrees.
    cached = { cutoff: parameters.cutoff, mode: histogram[mode] >= samples * .75 ? mode : -1 };
    if (frame.immutableAnalysisFrame) candidateModes.set(search, cached);
  }
  // A logical partition may migrate between Workers with different cache
  // histories. Never mix moments computed with two candidate modes.
  if (cached.mode < 0 || (parameters.reductionInput
    && parameters.reductionInput.candidateCoordinationMode !== cached.mode)) {
    const result = calculateLocalShearCoordination({ ...frame, neighborSearch: search }, parameters);
    const previous = parameters.reductionInput;
    if (previous) for (let index = 0; index < previous.histogram.length; index++) {
      result.histogram[index] = (result.histogram[index] ?? 0) + previous.histogram[index];
    }
    return { ...result, coordinationSum: result.coordinationSum + (previous?.coordinationSum ?? 0),
      metrics: new Float64Array(0), metricSum: new Array(6).fill(0), normalizationSum: 0, normalizationParticipants: 0,
      candidateCoordinationMode: -1, candidateMetricsAborted: true };
  }
  const result = calculateLocalShearMetrics({ ...frame, neighborSearch: search }, { ...parameters,
    coordinationMode: Math.max(0, cached.mode), collectCoordination: true,
    guardCandidateMetrics: !cached.verified });
  return { ...result, candidateCoordinationMode: result.candidateMetricsAborted ? -1 : cached.mode };
}

export function calculateLocalShearCoordination(frame, { cutoff, onPhase = () => {}, onAtoms = () => {}, ...range } = {}) {
  validateCutoff(cutoff);
  const count = frame.fractional.length / 3, { startAtom, endAtom } = atomRange(count, range);
  onPhase('indexing');
  const search = (frame.neighborSearch ?? new NeighborSearch(frame)), coordination = new Uint32Array(endAtom - startAtom), histogram = [];
  let coordinationSum = 0;
  const scratch = new NeighborBuffer();
  onPhase('analyzing');
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    const neighbors = boundedNeighbors(search, atom, cutoff, scratch);
    coordination[atom - startAtom] = neighbors.length;
    coordinationSum += neighbors.length;
    histogram[neighbors.length] = (histogram[neighbors.length] ?? 0) + 1;
    if ((atom - startAtom + 1) % 256 === 0) onAtoms(atom - startAtom + 1, endAtom - startAtom);
  }
  onAtoms(endAtom - startAtom, endAtom - startAtom);
  return { startAtom, endAtom, coordination, histogram: Array.from(histogram, (value) => value ?? 0), coordinationSum };
}

export function calculateLocalShearMetrics(frame, { cutoff, coordinationMode, reductionInput, collectCoordination = false,
  guardCandidateMetrics = true, verifiedCoordinationMode = false,
  onPhase = () => {}, onAtoms = () => {}, ...range } = {}) {
  validateCutoff(cutoff);
  const count = frame.fractional.length / 3, { startAtom, endAtom } = atomRange(count, range);
  if (!Number.isInteger(coordinationMode) || coordinationMode < 0) throw new Error('Invalid geometric shear coordination.');
  onPhase('indexing');
  const search = (frame.neighborSearch ?? new NeighborSearch(frame));
  // Only the exact fallback receives a mode from the complete global
  // histogram. An immutable snapshot can reuse that small fact next time;
  // preparation still verifies its complete histogram before using moments.
  if (!collectCoordination && verifiedCoordinationMode && frame.immutableAnalysisFrame) {
    candidateModes.set(search, { cutoff, mode: coordinationMode, verified: true });
  }
  const metrics = new Float64Array((endAtom - startAtom) * 6);
  const metricSum = reductionInput?.metricSum.slice() ?? new Array(6).fill(0);
  let normalizationSum = reductionInput?.normalizationSum ?? 0, normalizationParticipants = reductionInput?.normalizationParticipants ?? 0;
  const coordination = collectCoordination ? new Uint32Array(endAtom - startAtom) : null;
  const histogram = collectCoordination ? reductionInput?.histogram?.slice() ?? [] : null;
  let coordinationSum = reductionInput?.coordinationSum ?? 0;
  let candidateMetricsAborted = false, blockCandidates = 0;
  const scratch = new NeighborBuffer();
  onPhase('analyzing');
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    const neighbors = boundedNeighbors(search, atom, cutoff, scratch);
    if (collectCoordination) {
      coordination[atom - startAtom] = neighbors.length;
      coordinationSum += neighbors.length;
      histogram[neighbors.length] = (histogram[neighbors.length] ?? 0) + 1;
      // A misleading pilot must not cost a complete extra tensor pass. A
      // heterogeneous 128-atom block can abandon the candidate early. This
      // only forces the exact second pass; the full histogram still decides
      // the mode, including when the candidate was actually correct globally.
      if (guardCandidateMetrics && !candidateMetricsAborted) {
        if (neighbors.length === coordinationMode) blockCandidates++;
        if ((atom - startAtom + 1) % 128 === 0) {
          if (blockCandidates < 64) candidateMetricsAborted = true;
          blockCandidates = 0;
        }
      }
    }
    if (candidateMetricsAborted) {
      if ((atom - startAtom + 1) % 256 === 0) onAtoms(atom - startAtom + 1, endAtom - startAtom);
      continue;
    }
    const order = coordinationMode ? neighbors.sortedIndices() : null;
    const participants = Math.min(coordinationMode, neighbors.length), offset = (atom - startAtom) * 6;
    for (let index = 0; index < participants; index += 1) {
      const row = order[index], x = neighbors.xs[row], y = neighbors.ys[row], z = neighbors.zs[row],
        distanceSquared = neighbors.distanceSquared[row];
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
  return { startAtom, endAtom, metrics: candidateMetricsAborted ? new Float64Array(0) : metrics, metricSum, normalizationSum, normalizationParticipants,
    ...(collectCoordination ? { coordination, histogram: Array.from(histogram, value => value ?? 0), coordinationSum, candidateMetricsAborted } : {}) };
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
function boundedNeighbors(search, atom, cutoff, neighbors) {
  search.collect(atom, cutoff, neighbors, MAX_NEIGHBORS_PER_ATOM + 1);
  if (neighbors.length > MAX_NEIGHBORS_PER_ATOM) throw new Error('Too many geometric shear neighbors; reduce the cutoff.');
  return neighbors;
}
