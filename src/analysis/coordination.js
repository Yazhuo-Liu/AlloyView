import { cellFaceHeights } from '../data/model.js';

const MAX_BINS = 2_000_000;

/**
 * Cutoff coordination using linked cells in fractional coordinates.
 *
 * The decomposition follows the same physical invariants as AtomEye's
 * Neighborlist.c (fractional bins, cell face heights, PBC-wrapped bin
 * connectivity), but is an independent implementation with dynamic counts and
 * an image search that remains correct for restricted triclinic cells.
 */
export function calculateCoordination(frameLike, cutoff, range = {}) {
  const startedAt = performance.now();
  const { fractional, cell } = frameLike;
  const count = fractional.length / 3;
  if (!Number.isInteger(count) || count < 1) throw new Error('Coordination analysis requires at least one atom.');
  if (!Number.isFinite(cutoff) || cutoff <= 0) throw new Error('The cutoff radius must be a finite value greater than zero.');
  const startAtom = range.startAtom ?? 0;
  const endAtom = range.endAtom ?? count;
  if (!Number.isInteger(startAtom) || !Number.isInteger(endAtom)
      || startAtom < 0 || endAtom > count || startAtom >= endAtom) {
    throw new Error('The coordination atom range is invalid.');
  }

  const heights = cellFaceHeights(cell);
  const smallPeriodicAxes = Array.from(heights, (height, axis) => (
    cell.pbc[axis] && height < 2 * cutoff ? axis : -1
  ))
    .filter((axis) => axis >= 0);
  const dimensions = Array.from(heights, (height) => Math.max(1, Math.min(256, Math.floor(height / cutoff))));
  reduceBinCount(dimensions, Math.max(1, Math.min(MAX_BINS, count * 4)));
  const totalBins = dimensions[0] * dimensions[1] * dimensions[2];
  const heads = new Int32Array(totalBins);
  heads.fill(-1);
  const next = new Int32Array(count);
  const atomBins = new Int32Array(count);

  for (let atom = 0; atom < count; atom += 1) {
    const base = atom * 3;
    const indices = [0, 0, 0];
    for (let dimension = 0; dimension < 3; dimension += 1) {
      let value = fractional[base + dimension];
      if (!Number.isFinite(value)) throw new Error(`Atom ${atom + 1} has a non-finite fractional coordinate.`);
      if (cell.pbc[dimension]) value -= Math.floor(value);
      else value = Math.max(0, Math.min(1 - Number.EPSILON, value));
      indices[dimension] = Math.min(dimensions[dimension] - 1, Math.floor(value * dimensions[dimension]));
    }
    const bin = flattenBin(indices[0], indices[1], indices[2], dimensions);
    atomBins[atom] = bin;
    next[atom] = heads[bin];
    heads[bin] = atom;
  }

  const coordination = new Uint32Array(count);
  const neighborBins = new Int32Array(27);
  const cutoffSquared = cutoff * cutoff;
  const fractionalBounds = Array.from(heights, (height) => cutoff / height + 1e-12);
  let candidatePairs = 0;
  let acceptedPairs = 0;

  for (let atom = startAtom; atom < endAtom; atom += 1) {
    const [binX, binY, binZ] = expandBin(atomBins[atom], dimensions);
    let neighborBinCount = 0;
    for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
      const x = neighborIndex(binX + deltaX, dimensions[0], cell.pbc[0]);
      if (x < 0) continue;
      for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
        const y = neighborIndex(binY + deltaY, dimensions[1], cell.pbc[1]);
        if (y < 0) continue;
        for (let deltaZ = -1; deltaZ <= 1; deltaZ += 1) {
          const z = neighborIndex(binZ + deltaZ, dimensions[2], cell.pbc[2]);
          if (z < 0) continue;
          const bin = flattenBin(x, y, z, dimensions);
          let duplicate = false;
          for (let seen = 0; seen < neighborBinCount; seen += 1) {
            if (neighborBins[seen] === bin) {
              duplicate = true;
              break;
            }
          }
          if (!duplicate) neighborBins[neighborBinCount++] = bin;
        }
      }
    }

    for (let neighborBin = 0; neighborBin < neighborBinCount; neighborBin += 1) {
      for (let other = heads[neighborBins[neighborBin]]; other >= 0; other = next[other]) {
        if (other <= atom) continue;
        candidatePairs += 1;
        const distanceSquared = minimumImageDistanceSquared(
          fractional,
          atom,
          other,
          cell,
          fractionalBounds,
        );
        if (distanceSquared <= cutoffSquared) {
          coordination[atom] += 1;
          coordination[other] += 1;
          acceptedPairs += 1;
        }
      }
    }
  }

  return {
    coordination,
    elapsedMs: performance.now() - startedAt,
    candidatePairs,
    acceptedPairs,
    bins: dimensions,
    startAtom,
    endAtom,
    warning: smallPeriodicAxes.length > 0
      ? `The cell height along periodic axis ${smallPeriodicAxes.map((axis) => 'abc'[axis]).join(', ')} is less than twice the cutoff. Results count the closest image of each unique atom ID and do not count multiple periodic images of the same atom.`
      : null,
  };
}

/** Squared length of the shortest periodic image of second − first, or
 * +∞ when no image can lie within `fractionalBounds`. It runs for every
 * candidate pair, so it keeps values in scalars instead of allocating. */
export function minimumImageDistanceSquared(
  fractional,
  first,
  second,
  cell,
  fractionalBounds = null,
) {
  const baseFirst = first * 3;
  const baseSecond = second * 3;
  const d0 = fractional[baseSecond] - fractional[baseFirst];
  const d1 = fractional[baseSecond + 1] - fractional[baseFirst + 1];
  const d2 = fractional[baseSecond + 2] - fractional[baseFirst + 2];
  const pbc = cell.pbc;
  const bound0 = fractionalBounds ? fractionalBounds[0] : Number.POSITIVE_INFINITY;
  const bound1 = fractionalBounds ? fractionalBounds[1] : Number.POSITIVE_INFINITY;
  const bound2 = fractionalBounds ? fractionalBounds[2] : Number.POSITIVE_INFINITY;
  let a0 = 0, a1 = 0, b0 = 0, b1 = 0, c0 = 0, c1 = 0;
  if (pbc[0]) {
    const bound = Number.isFinite(bound0) ? bound0 : 1;
    a0 = Math.ceil(d0 - bound); a1 = Math.floor(d0 + bound);
    if (a0 > a1) return Number.POSITIVE_INFINITY;
  } else if (Number.isFinite(bound0) && Math.abs(d0) > bound0) return Number.POSITIVE_INFINITY;
  if (pbc[1]) {
    const bound = Number.isFinite(bound1) ? bound1 : 1;
    b0 = Math.ceil(d1 - bound); b1 = Math.floor(d1 + bound);
    if (b0 > b1) return Number.POSITIVE_INFINITY;
  } else if (Number.isFinite(bound1) && Math.abs(d1) > bound1) return Number.POSITIVE_INFINITY;
  if (pbc[2]) {
    const bound = Number.isFinite(bound2) ? bound2 : 1;
    c0 = Math.ceil(d2 - bound); c1 = Math.floor(d2 + bound);
    if (c0 > c1) return Number.POSITIVE_INFINITY;
  } else if (Number.isFinite(bound2) && Math.abs(d2) > bound2) return Number.POSITIVE_INFINITY;

  const h = cell.vectors;
  const h0 = h[0], h1 = h[1], h2 = h[2], h3 = h[3], h4 = h[4], h5 = h[5], h6 = h[6], h7 = h[7], h8 = h[8];
  let closest = Number.POSITIVE_INFINITY;
  for (let imageA = a0; imageA <= a1; imageA += 1) {
    const a = d0 - imageA;
    for (let imageB = b0; imageB <= b1; imageB += 1) {
      const b = d1 - imageB;
      for (let imageC = c0; imageC <= c1; imageC += 1) {
        const c = d2 - imageC;
        const x = a * h0 + b * h3 + c * h6;
        const y = a * h1 + b * h4 + c * h7;
        const z = a * h2 + b * h5 + c * h8;
        const squared = x * x + y * y + z * z;
        if (squared < closest) closest = squared;
      }
    }
  }
  return closest;
}

function reduceBinCount(dimensions, target) {
  while (dimensions[0] * dimensions[1] * dimensions[2] > target) {
    let largest = 0;
    if (dimensions[1] > dimensions[largest]) largest = 1;
    if (dimensions[2] > dimensions[largest]) largest = 2;
    dimensions[largest] = Math.max(1, Math.floor(dimensions[largest] / 2));
  }
}

function flattenBin(x, y, z, dimensions) {
  return (x * dimensions[1] + y) * dimensions[2] + z;
}

function expandBin(bin, dimensions) {
  const yz = dimensions[1] * dimensions[2];
  const x = Math.floor(bin / yz);
  const remainder = bin - x * yz;
  return [x, Math.floor(remainder / dimensions[2]), remainder % dimensions[2]];
}

function neighborIndex(value, count, periodic) {
  if (periodic) return (value % count + count) % count;
  return value >= 0 && value < count ? value : -1;
}
