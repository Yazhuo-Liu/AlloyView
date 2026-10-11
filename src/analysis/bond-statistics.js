import { NeighborSearch, atomRange } from './neighbors.js';
import { MAX_NEIGHBORS_PER_ATOM } from './bonds.js';

// Angle enumeration is quadratic in local coordination. Refuse oversized
// environments rather than silently sampling or truncating their statistics.
export const MAX_BOND_STATISTICS_NEIGHBORS = 1024;
export const MAX_BOND_STATISTICS_BINS = 4096;
const preparedContexts = new WeakMap();

/** Common CPU/GPU contract for a cutoff-defined, periodic bond environment. */
export function validateBondStatisticsParameters(frame, {
  cutoff, pairCutoffs = [], lengthBins = 100, angleBins = 180, ...range
} = {}) {
  const prepared = validateBondStatisticsSchema(frame, { cutoff, pairCutoffs, lengthBins, angleBins, ...range });
  if (frame.types.some(type => !Number.isInteger(type) || type < 0)) {
    throw new Error('Bond statistics require one nonnegative integer element type per atom.');
  }
  return prepared;
}

/** Constant-size transport/schema checks; element values are checked once
 * when an immutable resident calculation context is prepared. */
export function validateBondStatisticsSchema(frame, {
  cutoff, pairCutoffs = [], lengthBins = 100, angleBins = 180, ...range
} = {}) {
  const atomCount = frame.fractional.length / 3;
  const limits = atomRange(atomCount, range);
  if (!Number.isFinite(cutoff) || cutoff <= 0) throw new Error('Bond statistics cutoff must be positive and finite.');
  if (![lengthBins, angleBins].every(value => Number.isInteger(value) && value >= 1 && value <= MAX_BOND_STATISTICS_BINS)) {
    throw new Error(`Bond statistics require 1–${MAX_BOND_STATISTICS_BINS} bins per distribution.`);
  }
  if (!ArrayBuffer.isView(frame.types) || frame.types instanceof DataView || frame.types.length !== atomCount) {
    throw new Error('Bond statistics require one nonnegative integer element type per atom.');
  }
  if (!Array.isArray(pairCutoffs)) throw new Error('Element-pair cutoffs must be an array.');
  const overrides = new Map();
  let maximumCutoff = cutoff;
  for (const entry of pairCutoffs) {
    if (!entry || ![entry.first, entry.second].every(value => Number.isInteger(value) && value >= 0)
        || !Number.isFinite(entry.cutoff) || entry.cutoff < 0) throw new Error('Invalid element-pair cutoff.');
    const key = pairKey(entry.first, entry.second);
    if (overrides.has(key)) throw new Error('Each element pair can have only one cutoff.');
    overrides.set(key, entry.cutoff);
    maximumCutoff = Math.max(maximumCutoff, entry.cutoff);
  }
  return { ...limits, atomCount, types: frame.types, cutoff, maximumCutoff, overrides, lengthBins, angleBins,
    normalization: { cutoff, maximumCutoff, lengthBins, angleBins, lengthRange: [0, maximumCutoff], angleRange: [0, 180],
      lengthCounting: 'unique-periodic-edges', angleCounting: 'unordered-neighbor-pairs',
      orderDefinition: 'local-Steinhardt-Q4-Q6' } };
}

export function createBondStatisticsAccumulators({ lengthBins, angleBins }) {
  return { lengthCounts: new Float64Array(lengthBins), angleCounts: new Float64Array(angleBins),
    moments: Object.fromEntries(['length', 'angle', 'q4', 'q6'].map(name => [name, emptyMoment()])) };
}

/** Welford accumulation keeps nearly identical crystal shells numerically
 * stable. These small accumulators can be merged independently of atom rows. */
export function addBondStatisticsSample(moment, value) {
  if (!Number.isFinite(value)) return;
  moment.count += 1;
  moment.min = Math.min(moment.min, value);
  moment.max = Math.max(moment.max, value);
  const delta = value - moment.mean;
  moment.mean += delta / moment.count;
  moment.m2 += delta * (value - moment.mean);
}

/** Half-open bins, with the inclusive upper endpoint in the final bin. */
export function bondStatisticsHistogramBin(value, maximum, bins) {
  return Math.max(0, Math.min(bins - 1, Math.floor(value / maximum * bins)));
}

/** Analyze one exact neighbor environment. The optional shared accumulator
 * avoids allocating histograms for each central atom and supports sparse GPU
 * precision corrections without rebuilding the linked-cell index. */
export function calculateBondStatisticsAtom(search, atom, prepared, output) {
  const { cutoff, maximumCutoff, overrides, types, lengthBins, angleBins } = prepared;
  const accumulated = output ?? createBondStatisticsAccumulators(prepared);
  const candidates = search.within(atom, maximumCutoff, MAX_NEIGHBORS_PER_ATOM + 1);
  if (candidates.length > MAX_NEIGHBORS_PER_ATOM) throw new Error('Too many bond neighbors; reduce the cutoff.');
  const neighbors = [];
  for (const neighbor of candidates) {
    const pairCutoff = overrides.get(pairKey(types[atom], types[neighbor.atom])) ?? cutoff;
    if (!pairCutoff || neighbor.distanceSquared > pairCutoff ** 2 || neighbor.distanceSquared <= 1e-24) continue;
    if (neighbors.length === MAX_BOND_STATISTICS_NEIGHBORS) {
      throw new Error(`Bond statistics support at most ${MAX_BOND_STATISTICS_NEIGHBORS} neighbors per atom; reduce the cutoff.`);
    }
    const length = Math.sqrt(neighbor.distanceSquared);
    neighbors.push({ ...neighbor, inverseLength: 1 / length });
    // Store every periodic edge once, including one of each pair of opposite
    // self images. This is the same ownership rule as the Bonds renderer.
    if (neighbor.atom > atom || (neighbor.atom === atom && positiveShift(neighbor.imageA, neighbor.imageB, neighbor.imageC))) {
      accumulated.lengthCounts[bondStatisticsHistogramBin(length, maximumCutoff, lengthBins)] += 1;
      addBondStatisticsSample(accumulated.moments.length, length);
    }
  }
  const coordination = neighbors.length;
  let legendre4 = coordination, legendre6 = coordination;
  for (let first = 0; first < coordination; first += 1) {
    const a = neighbors[first];
    for (let second = first + 1; second < coordination; second += 1) {
      const b = neighbors[second];
      const cosine = Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) * (a.inverseLength * b.inverseLength)));
      const angle = Math.acos(cosine) * 180 / Math.PI;
      accumulated.angleCounts[bondStatisticsHistogramBin(angle, 180, angleBins)] += 1;
      addBondStatisticsSample(accumulated.moments.angle, angle);
      const squared = cosine * cosine, fourth = squared * squared;
      legendre4 += (35 * fourth - 30 * squared + 3) / 4;
      legendre6 += (231 * fourth * squared - 315 * fourth + 105 * squared - 5) / 8;
    }
  }
  // The spherical-harmonic addition theorem gives Q_l^2 = sum_ij P_l / N^2.
  // Including diagonal terms and both ordered off-diagonal terms yields the
  // conventional local Q_l without selecting a coordinate orientation.
  const q4 = coordination ? Math.sqrt(Math.max(0, legendre4 / coordination ** 2)) : NaN;
  const q6 = coordination ? Math.sqrt(Math.max(0, legendre6 / coordination ** 2)) : NaN;
  addBondStatisticsSample(accumulated.moments.q4, q4);
  addBondStatisticsSample(accumulated.moments.q6, q6);
  return { coordination, q4, q6, ...(output ? {} : accumulated) };
}

/** Independent center ranges run in resident CPU workers. Positions and cell
 * remain authoritative; display replication and slices do not affect analysis. */
export function calculateBondStatistics(frame, { onPhase = () => {}, onAtoms = () => {}, momentInput, ...parameters } = {}) {
  const startedAt = performance.now();
  const result = calculatePreparedBondStatistics(prepareBondStatisticsContext(frame, parameters), { ...parameters, onPhase, onAtoms, momentInput });
  return { ...result, elapsedMs: performance.now() - startedAt };
}

/** Contexts belong to one validated, immutable Worker input set. They are
 * opaque so ordinary calculation options cannot bypass scientific checks. */
export function prepareBondStatisticsContext(frame, parameters = {}) {
  const context = Object.freeze({});
  preparedContexts.set(context, { frame, prepared: validateBondStatisticsParameters(frame, parameters) });
  return context;
}

export function calculatePreparedBondStatistics(context, { onPhase = () => {}, onAtoms = () => {}, momentInput, ...range } = {}) {
  const startedAt = performance.now();
  const retained = preparedContexts.get(context);
  if (!retained) throw new Error('The prepared bond-statistics context is invalid.');
  const { frame } = retained;
  const prepared = { ...retained.prepared, ...atomRange(retained.prepared.atomCount, range) };
  const { startAtom, endAtom } = prepared;
  onPhase('indexing');
  const search = (frame.neighborSearch ?? new NeighborSearch(frame));
  const output = createBondStatisticsAccumulators(prepared);
  if (momentInput) output.moments = structuredClone(momentInput);
  const coordination = new Uint32Array(endAtom - startAtom);
  const q4 = new Float32Array(endAtom - startAtom), q6 = new Float32Array(endAtom - startAtom);
  onPhase('analyzing');
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    const local = calculateBondStatisticsAtom(search, atom, prepared, output);
    coordination[atom - startAtom] = local.coordination;
    q4[atom - startAtom] = local.q4;
    q6[atom - startAtom] = local.q6;
    if ((atom - startAtom + 1) % 64 === 0) onAtoms(atom - startAtom + 1, endAtom - startAtom);
  }
  onAtoms(endAtom - startAtom, endAtom - startAtom);
  return finalizeBondStatistics({ startAtom, endAtom, coordination, q4, q6, ...output,
    normalization: prepared.normalization, elapsedMs: performance.now() - startedAt });
}

/** CPU and GPU use the same probability/density normalization and summaries.
 * Counts are raw sample counts; each nonempty probability distribution sums
 * to one, and the density integrates to one in the indicated length/angle unit. */
export function finalizeBondStatistics(raw) {
  const { normalization, lengthCounts, angleCounts, moments } = raw;
  return { ...raw,
    lengthDistribution: distribution(lengthCounts, normalization.maximumCutoff, 'Å'),
    angleDistribution: distribution(angleCounts, 180, '°'),
    statistics: Object.fromEntries(Object.entries(moments).map(([name, moment]) => [name, momentSummary(moment)])),
    warning: null };
}

export function mergeBondStatisticsPartials(partials, { coordination, q4, q6 } = {}) {
  if (!partials.length) throw new Error('Bond statistics require at least one partial result.');
  const normalization = partials[0].normalization;
  const output = createBondStatisticsAccumulators(normalization);
  for (const partial of partials) {
    if (partial.lengthCounts.length !== output.lengthCounts.length || partial.angleCounts.length !== output.angleCounts.length
        || partial.normalization.maximumCutoff !== normalization.maximumCutoff) throw new Error('Incompatible bond statistics histograms.');
    for (let bin = 0; bin < output.lengthCounts.length; bin += 1) output.lengthCounts[bin] += partial.lengthCounts[bin];
    for (let bin = 0; bin < output.angleCounts.length; bin += 1) output.angleCounts[bin] += partial.angleCounts[bin];
    for (const name of Object.keys(output.moments)) mergeBondStatisticsMoment(output.moments[name], partial.moments[name]);
  }
  return finalizeBondStatistics({ ...output, normalization, ...(coordination ? { coordination } : {}),
    ...(q4 ? { q4 } : {}), ...(q6 ? { q6 } : {}) });
}

function distribution(counts, maximum, unit) {
  const bins = counts.length, width = maximum / bins;
  const edges = Float64Array.from({ length: bins + 1 }, (_, index) => index * width);
  edges[bins] = maximum;
  const centers = Float64Array.from({ length: bins }, (_, index) => (index + .5) * width);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const probability = Float64Array.from(counts, count => total ? count / total : 0);
  const density = Float64Array.from(probability, value => value / width);
  return { centers, edges, counts, probability, density, unit, total };
}

function emptyMoment() { return { count: 0, min: Infinity, max: -Infinity, mean: 0, m2: 0 }; }

function momentSummary({ count, min, max, mean, m2 }) {
  return { count, min: count ? min : NaN, max: count ? max : NaN,
    mean: count ? mean : NaN, stddev: count ? Math.sqrt(Math.max(0, m2 / count)) : NaN };
}

export function mergeBondStatisticsMoment(target, source) {
  if (!source.count) return;
  if (!target.count) { Object.assign(target, source); return; }
  const count = target.count + source.count, delta = source.mean - target.mean;
  target.m2 += source.m2 + delta * delta * target.count * source.count / count;
  target.mean += delta * source.count / count;
  target.min = Math.min(target.min, source.min);
  target.max = Math.max(target.max, source.max);
  target.count = count;
}

function pairKey(first, second) { return first <= second ? `${first}:${second}` : `${second}:${first}`; }
function positiveShift(a, b, c) { return a ? a > 0 : b ? b > 0 : c > 0; }
