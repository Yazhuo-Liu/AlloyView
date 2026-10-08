import { determinant3 } from '../data/model.js';

/** Spatial binning in reduced (fractional) coordinates. A bin along cell
 * vector a covers reduced coordinates [k/n, (k+1)/n): for a tilted cell it is a
 * slab parallel to b and c, and every bin has the same volume, V/n. Two binned
 * vectors give columns parallel to the third vector, each of volume V/(n₁n₂).
 *
 * Periodic directions wrap into [0, 1). Open directions use the cell extent
 * [0, 1], including its upper face, and count atoms beyond it as outside.
 * Sums run over atoms in row order, so results are deterministic and do not
 * depend on where they are calculated (main thread or Worker). */
export const BINNING_AXES = Object.freeze(['a', 'b', 'c']);
export const BINNING_QUANTITIES = Object.freeze(['count', 'density', 'property']);
export const BINNING_REDUCTIONS = Object.freeze(['mean', 'sum', 'min', 'max', 'stddev']);
export const MAX_BINS_PER_AXIS = 4096;
export const MAX_TOTAL_BINS = 1 << 20;
/** Bins of an empty frame or before any frame have no atoms. */
const PARTIAL_ARRAYS = ['counts', 'valid', 'skipped', 'sum', 'min', 'max', 'm2', 'densitySum'];

/** Validate binned vectors and bin counts. Axes are 0, 1 or 2 (a, b, c). */
export function normalizeBinningLayout({ axes, bins } = {}) {
  if (!Array.isArray(axes) || axes.length < 1 || axes.length > 2) throw new Error('Choose one or two cell vectors to bin along.');
  const normalizedAxes = axes.map(axis => typeof axis === 'string' ? BINNING_AXES.indexOf(axis) : axis);
  if (normalizedAxes.some(axis => !Number.isInteger(axis) || axis < 0 || axis > 2)) throw new Error('Bins follow the cell vectors a, b or c.');
  if (new Set(normalizedAxes).size !== normalizedAxes.length) throw new Error('Choose two different cell vectors for a two-dimensional map.');
  if (!Array.isArray(bins) || bins.length !== normalizedAxes.length
    || bins.some(count => !Number.isSafeInteger(count) || count < 1 || count > MAX_BINS_PER_AXIS)) {
    throw new Error(`Use 1–${MAX_BINS_PER_AXIS.toLocaleString('en-US')} bins along each cell vector.`);
  }
  const binCount = bins.reduce((product, count) => product * count, 1);
  if (binCount > MAX_TOTAL_BINS) throw new Error(`A map may contain at most ${MAX_TOTAL_BINS.toLocaleString('en-US')} bins.`);
  return { axes: normalizedAxes, bins: [...bins], binCount };
}

/** Bin geometry from the cell: lengths and perpendicular heights of the binned
 * vectors, the cell volume and the common volume of every bin. */
export function binningGeometry(cell, layout) {
  const { axes, bins, binCount } = normalizeBinningLayout(layout);
  const vectors = cell?.vectors;
  if (!vectors || vectors.length !== 9 || Array.prototype.some.call(vectors, value => !Number.isFinite(value))) {
    throw new Error('Spatial binning requires a finite simulation cell.');
  }
  const cellVolume = Math.abs(determinant3(vectors));
  if (!(cellVolume > 0)) throw new Error('Spatial binning requires a cell with nonzero volume.');
  const row = axis => [vectors[axis * 3], vectors[axis * 3 + 1], vectors[axis * 3 + 2]];
  const axisLengths = axes.map(axis => Math.hypot(...row(axis)));
  // The spacing of planes of constant reduced coordinate: V / |b × c| for a.
  const heights = axes.map(axis => {
    const [first, second] = [row((axis + 1) % 3), row((axis + 2) % 3)];
    return cellVolume / Math.hypot(first[1] * second[2] - first[2] * second[1],
      first[2] * second[0] - first[0] * second[2], first[0] * second[1] - first[1] * second[0]);
  });
  const angle = axes.length === 2
    ? Math.acos(Math.max(-1, Math.min(1, row(axes[0]).reduce((sum, value, index) => sum + value * row(axes[1])[index], 0)
      / (axisLengths[0] * axisLengths[1])))) * 180 / Math.PI : null;
  return { axes, bins, binCount, cellVolume, binVolume: cellVolume / binCount, axisLengths, heights, angle,
    periodic: axes.map(axis => Boolean(cell.pbc?.[axis])) };
}

function finiteArray(values, count, label) {
  if (values === null || values === undefined) return null;
  if (typeof values.length !== 'number' || values.length !== count) throw new Error(`${label} must contain one value per atom.`);
  return values;
}

/**
 * Accumulate one frame. `values` (one per atom) enables the property
 * statistics; non-finite values are skipped and counted per bin. `mask`
 * restricts the population (nonzero entries are included). The second pass
 * for `stddev` sums squared deviations from each bin's mean.
 */
export function accumulateSpatialBins(frame, { axes, bins, values = null, mask = null, stddev = false } = {}) {
  const geometry = binningGeometry(frame?.cell, { axes, bins });
  const fractional = frame?.fractional;
  const atomCount = fractional?.length / 3;
  if (!Number.isSafeInteger(atomCount)) throw new Error('Spatial binning requires reduced coordinates for every atom.');
  const data = finiteArray(values, atomCount, 'The binned property');
  const selection = finiteArray(mask, atomCount, 'The selection mask');
  const { binCount } = geometry;
  const counts = new Float64Array(binCount);
  const valid = data ? new Float64Array(binCount) : null, skipped = data ? new Float64Array(binCount) : null;
  const sum = data ? new Float64Array(binCount) : null;
  const min = data ? new Float64Array(binCount).fill(Infinity) : null, max = data ? new Float64Array(binCount).fill(-Infinity) : null;
  const binOf = data && stddev ? new Int32Array(atomCount).fill(-1) : null;
  const [first, second = -1] = geometry.axes, [firstBins, secondBins = 1] = geometry.bins;
  const [firstPeriodic, secondPeriodic = false] = geometry.periodic;
  let selected = 0, invalid = 0, outside = 0, binned = 0, skippedTotal = 0;
  for (let atom = 0; atom < atomCount; atom++) {
    if (selection && !selection[atom]) continue;
    selected++;
    const row = binIndex(fractional[atom * 3 + first], firstBins, firstPeriodic);
    const column = second < 0 ? 0 : binIndex(fractional[atom * 3 + second], secondBins, secondPeriodic);
    if (row === -2 || column === -2) { invalid++; continue; }
    if (row < 0 || column < 0) { outside++; continue; }
    const bin = row * secondBins + column;
    counts[bin]++; binned++;
    if (!data) continue;
    const value = data[atom];
    if (typeof value !== 'number' || !Number.isFinite(value)) { skipped[bin]++; skippedTotal++; continue; }
    valid[bin]++; sum[bin] += value;
    if (value < min[bin]) min[bin] = value;
    if (value > max[bin]) max[bin] = value;
    if (binOf) binOf[atom] = bin;
  }
  let m2 = null;
  if (binOf) {
    const mean = new Float64Array(binCount);
    for (let bin = 0; bin < binCount; bin++) mean[bin] = valid[bin] ? sum[bin] / valid[bin] : 0;
    m2 = new Float64Array(binCount);
    for (let atom = 0; atom < atomCount; atom++) {
      const bin = binOf[atom];
      if (bin < 0) continue;
      const deviation = data[atom] - mean[bin];
      m2[bin] += deviation * deviation;
    }
  }
  const densitySum = new Float64Array(binCount);
  for (let bin = 0; bin < binCount; bin++) densitySum[bin] = counts[bin] / geometry.binVolume;
  return { axes: geometry.axes, bins: geometry.bins, binCount, frames: 1, hasValues: Boolean(data),
    counts, valid, skipped, sum, min, max, m2, densitySum,
    cellVolumeSum: geometry.cellVolume, axisLengthSum: geometry.axisLengths, heightSum: geometry.heights,
    angle: geometry.angle, periodic: geometry.periodic,
    totals: { atoms: atomCount, selected, excluded: atomCount - selected, invalid, outside, binned, skipped: skippedTotal } };
}

/** Bin of one reduced coordinate: −1 outside an open cell, −2 non-finite. A
 * wrapped value that rounds up to 1 belongs to the last bin, as does an atom
 * exactly on the upper face of an open direction. */
export function binIndex(value, bins, periodic) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return -2;
  let reduced = value;
  if (periodic) reduced -= Math.floor(reduced);
  else if (reduced < 0 || reduced > 1) return -1;
  const bin = Math.floor(reduced * bins);
  return bin < bins ? bin : bins - 1;
}

/** Combine frames in order. Counts, sums and totals add; minima and maxima
 * combine; squared deviations use the pairwise update of Chan et al., so the
 * pooled standard deviation does not need the atoms again. */
export function mergeSpatialBins(first, second) {
  if (!first) return second;
  if (!second) return first;
  if (first.binCount !== second.binCount || first.axes.join() !== second.axes.join() || first.bins.join() !== second.bins.join()
    || first.hasValues !== second.hasValues || Boolean(first.m2) !== Boolean(second.m2)) throw new Error('Spatial bins from different layouts cannot be combined.');
  const output = { ...first, frames: first.frames + second.frames,
    cellVolumeSum: first.cellVolumeSum + second.cellVolumeSum,
    axisLengthSum: first.axisLengthSum.map((value, index) => value + second.axisLengthSum[index]),
    heightSum: first.heightSum.map((value, index) => value + second.heightSum[index]),
    angle: first.angle === null ? null : (first.angle * first.frames + second.angle * second.frames) / (first.frames + second.frames),
    totals: Object.fromEntries(Object.entries(first.totals).map(([name, value]) => [name, value + second.totals[name]])) };
  for (const name of PARTIAL_ARRAYS) if (first[name]) output[name] = new Float64Array(first[name]);
  for (let bin = 0; bin < first.binCount; bin++) {
    output.counts[bin] += second.counts[bin];
    output.densitySum[bin] += second.densitySum[bin];
    if (!first.hasValues) continue;
    const before = first.valid[bin], added = second.valid[bin];
    if (first.m2 && before && added) {
      const delta = second.sum[bin] / added - first.sum[bin] / before;
      output.m2[bin] += second.m2[bin] + delta * delta * before * added / (before + added);
    } else if (first.m2) output.m2[bin] += second.m2[bin];
    output.valid[bin] += added; output.skipped[bin] += second.skipped[bin]; output.sum[bin] += second.sum[bin];
    if (second.min[bin] < output.min[bin]) output.min[bin] = second.min[bin];
    if (second.max[bin] > output.max[bin]) output.max[bin] = second.max[bin];
  }
  return output;
}

/**
 * Per-bin values of an accumulated frame or frame average:
 * count and density are per-frame averages; sum is the average per-frame sum;
 * mean, minimum, maximum and population standard deviation pool every finite
 * sample, and are NaN for bins without one. Counts are atoms per frame.
 */
export function finalizeSpatialBins(partial, { quantity = 'count', reduction = 'mean' } = {}) {
  if (!BINNING_QUANTITIES.includes(quantity)) throw new Error(`Unknown binning quantity: ${quantity}`);
  if (quantity === 'property' && !BINNING_REDUCTIONS.includes(reduction)) throw new Error(`Unknown binning reduction: ${reduction}`);
  if (quantity === 'property' && !partial.hasValues) throw new Error('Choose a property to reduce in each bin.');
  if (quantity === 'property' && reduction === 'stddev' && !partial.m2) throw new Error('Standard deviations need squared deviations.');
  const { binCount, frames } = partial;
  const values = new Float64Array(binCount), counts = new Float64Array(binCount), skipped = new Float64Array(binCount);
  for (let bin = 0; bin < binCount; bin++) {
    counts[bin] = partial.counts[bin] / frames;
    if (partial.skipped) skipped[bin] = partial.skipped[bin] / frames;
    const valid = partial.valid?.[bin] ?? 0;
    values[bin] = quantity === 'count' ? partial.counts[bin] / frames
      : quantity === 'density' ? partial.densitySum[bin] / frames
        : reduction === 'sum' ? partial.sum[bin] / frames
          : !valid ? NaN
            : reduction === 'mean' ? partial.sum[bin] / valid
              : reduction === 'min' ? partial.min[bin]
                : reduction === 'max' ? partial.max[bin]
                  : Math.sqrt(Math.max(0, partial.m2[bin] / valid));
  }
  const cellVolume = partial.cellVolumeSum / frames;
  return { axes: [...partial.axes], bins: [...partial.bins], binCount, frames, quantity,
    reduction: quantity === 'property' ? reduction : null, values, counts, skipped,
    cellVolume, binVolume: cellVolume / binCount,
    axisLengths: partial.axisLengthSum.map(value => value / frames), heights: partial.heightSum.map(value => value / frames),
    angle: partial.angle, periodic: [...partial.periodic], totals: { ...partial.totals } };
}

/** Lower, upper and center of one bin along a binned vector: reduced
 * coordinates and distances along the vector from the cell origin, in Å. */
export function binBounds(result, dimension, index) {
  const count = result.bins[dimension], length = result.axisLengths[dimension];
  const lower = index / count, upper = (index + 1) / count, center = (index + 0.5) / count;
  return { lower, upper, center, lowerLength: lower * length, upperLength: upper * length, centerLength: center * length };
}

/** Convenience for one frame. */
export function calculateSpatialBins(frame, { axes, bins, quantity = 'count', reduction = 'mean', values = null, mask = null } = {}) {
  const partial = accumulateSpatialBins(frame, { axes, bins, values: quantity === 'property' ? values : null, mask,
    stddev: quantity === 'property' && reduction === 'stddev' });
  return finalizeSpatialBins(partial, { quantity, reduction });
}
