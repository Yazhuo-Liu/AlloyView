import { cellFaceHeights } from '../data/model.js';

const MAX_BINS = 2_000_000;
export const MAX_COORDINATION_IMAGE_CANDIDATES = 50_000;
const TIGHTEN_IMAGE_CANDIDATES = 125;

/** Build the immutable, cutoff-specific linked cells once for a resident frame.
 * The owner must rebuild the index when fractional coordinates change. Shared
 * backing stores let each Worker traverse the same lists without cloning them.
 */
export function createCoordinationIndex(frameLike, cutoff, { sharedMemory = false } = {}) {
  const { fractional, cell } = frameLike;
  const count = fractional.length / 3;
  validateInputs(count, cutoff);
  const heights = cellFaceHeights(cell);
  const dimensions = Array.from(heights, (height) => Math.max(1, Math.min(256, Math.floor(height / cutoff))));
  reduceBinCount(dimensions, Math.max(1, Math.min(MAX_BINS, count * 4)));
  const totalBins = dimensions[0] * dimensions[1] * dimensions[2];
  const allocate = (length) => sharedMemory && typeof SharedArrayBuffer === 'function'
    ? new Int32Array(new SharedArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT))
    : new Int32Array(length);
  const heads = allocate(totalBins);
  heads.fill(-1);
  const next = allocate(count);
  const atomBins = allocate(count);
  const indices = [0, 0, 0];
  for (let atom = 0; atom < count; atom += 1) {
    const base = atom * 3;
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
  return {
    version: 1, count, cutoff, heights, dimensions, heads, next, atomBins,
    cellVectors: Array.from(cell.vectors), pbc: Array.from(cell.pbc),
  };
}

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
  validateInputs(count, cutoff);
  const startAtom = range.startAtom ?? 0;
  const endAtom = range.endAtom ?? count;
  if (!Number.isInteger(startAtom) || !Number.isInteger(endAtom)
      || startAtom < 0 || endAtom > count || startAtom >= endAtom) {
    throw new Error('The coordination atom range is invalid.');
  }

  const index = range.coordinationIndex ?? createCoordinationIndex(frameLike, cutoff);
  if (index.version !== 1 || index.count !== count || index.cutoff !== cutoff
      || index.cellVectors.some((value, axis) => value !== cell.vectors[axis])
      || index.pbc.some((value, axis) => value !== cell.pbc[axis])) {
    throw new Error('The coordination index does not match the frame cell or cutoff.');
  }
  const { heights, dimensions, heads, next, atomBins } = index;
  const smallPeriodicAxes = Array.from(heights, (height, axis) => (
    cell.pbc[axis] && height < 2 * cutoff ? axis : -1
  ))
    .filter((axis) => axis >= 0);
  const compactOutput = range.compactOutput === true;
  const coordination = new Uint32Array(compactOutput ? endAtom - startAtom : count);
  const neighborBins = new Int32Array(27);
  const cutoffSquared = cutoff * cutoff;
  const fractionalBounds = Array.from(heights, (height) => cutoff / height + 1e-12);
  const duplicateBins = dimensions.some((dimension, axis) => cell.pbc[axis] && dimension < 3);
  const yzBins = dimensions[1] * dimensions[2];
  let previousBin = -1, neighborBinCount = 0;
  let candidatePairs = 0;
  let acceptedPairs = 0;

  for (let atom = startAtom; atom < endAtom; atom += 1) {
    const atomBin = atomBins[atom];
    if (atomBin !== previousBin) {
      previousBin = atomBin;
      const binX = Math.floor(atomBin / yzBins), remainder = atomBin - binX * yzBins;
      const binY = Math.floor(remainder / dimensions[2]), binZ = remainder % dimensions[2];
      neighborBinCount = 0;
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
            for (let seen = 0; duplicateBins && seen < neighborBinCount; seen += 1) {
              if (neighborBins[seen] === bin) {
                duplicate = true;
                break;
              }
            }
            if (!duplicate) neighborBins[neighborBinCount++] = bin;
          }
        }
      }
    }

    for (let neighborBin = 0; neighborBin < neighborBinCount; neighborBin += 1) {
      for (let other = heads[neighborBins[neighborBin]]; other >= 0; other = next[other]) {
        // A compact chunk owns only its own counts, so a pair with an atom
        // outside the chunk is measured from both sides; pairs inside the
        // chunk are measured once, as with full output.
        const inRange = !compactOutput || (other >= startAtom && other < endAtom);
        if (other === atom || (inRange && other < atom)) continue;
        const ownsPair = other > atom;
        if (ownsPair) candidatePairs += 1;
        const distanceSquared = minimumImageDistanceSquared(
          fractional,
          atom,
          other,
          cell,
          fractionalBounds,
          heights,
        );
        if (distanceSquared <= cutoffSquared) {
          if (!compactOutput) {
            coordination[atom] += 1;
            coordination[other] += 1;
          } else {
            coordination[atom - startAtom] += 1;
            if (inRange) coordination[other - startAtom] += 1;
          }
          if (ownsPair) acceptedPairs += 1;
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
    ...(compactOutput ? { compactOutput: true } : {}),
    warning: smallPeriodicAxes.length > 0
      ? `The cell height along periodic axis ${smallPeriodicAxes.map((axis) => 'abc'[axis]).join(', ')} is less than twice the cutoff. Results count the closest image of each unique atom ID and do not count multiple periodic images of the same atom.`
      : null,
  };
}

function validateInputs(count, cutoff) {
  if (!Number.isInteger(count) || count < 1) throw new Error('Coordination analysis requires at least one atom.');
  if (!Number.isFinite(cutoff) || cutoff <= 0) throw new Error('The cutoff radius must be a finite value greater than zero.');
  if (!Number.isFinite(cutoff * cutoff)) throw new Error('The cutoff radius is too large to represent its squared distance.');
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
  heights = null,
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
  const candidates = (a1 - a0 + 1) * (b1 - b0 + 1) * (c1 - c0 + 1);
  if (!(candidates <= TIGHTEN_IMAGE_CANDIDATES)
      || Math.abs(a0) > Number.MAX_SAFE_INTEGER || Math.abs(a1) > Number.MAX_SAFE_INTEGER
      || Math.abs(b0) > Number.MAX_SAFE_INTEGER || Math.abs(b1) > Number.MAX_SAFE_INTEGER
      || Math.abs(c0) > Number.MAX_SAFE_INTEGER || Math.abs(c1) > Number.MAX_SAFE_INTEGER) {
    // A larger cutoff must not enlarge the closest-image search. Any image
    // better than the rounded trial lies within this Cartesian radius and its
    // projections onto the cell-face normals. Keep the original traversal for
    // ordinary cutoffs, including boundary decisions and exact GPU corrections.
    const image0 = pbc[0] ? Math.round(d0) : 0, image1 = pbc[1] ? Math.round(d1) : 0,
      image2 = pbc[2] ? Math.round(d2) : 0;
    if (![image0, image1, image2].every(Number.isSafeInteger)) {
      throw new Error('Coordination periodic image coefficients exceed safe integer precision.');
    }
    const a = d0 - image0, b = d1 - image1, c = d2 - image2;
    const x = a * h0 + b * h3 + c * h6, y = a * h1 + b * h4 + c * h7,
      z = a * h2 + b * h5 + c * h8;
    const radius = Math.sqrt(x * x + y * y + z * z);
    if (!Number.isFinite(radius)) throw new Error('Coordination closest-image distance exceeds numerical limits.');
    heights ??= cellFaceHeights(cell);
    const conditioning = Math.max(Math.hypot(h0, h1, h2), Math.hypot(h3, h4, h5), Math.hypot(h6, h7, h8))
      / Math.min(heights[0], heights[1], heights[2]);
    if (conditioning <= 256) {
      // Cancellation in the volume/face calculation must not remove the trial
      // itself or a boundary image. Poorly conditioned cells retain the original
      // finite enumeration instead of trusting a tighter projection estimate.
      const padding = 1e-12 + 128 * Number.EPSILON * conditioning * conditioning;
      const tightened0 = Math.min(bound0, radius / heights[0] + padding);
      const tightened1 = Math.min(bound1, radius / heights[1] + padding);
      const tightened2 = Math.min(bound2, radius / heights[2] + padding);
      if (pbc[0]) {
        a0 = Math.max(a0, Math.min(Math.ceil(d0 - tightened0), image0));
        a1 = Math.min(a1, Math.max(Math.floor(d0 + tightened0), image0));
      }
      if (pbc[1]) {
        b0 = Math.max(b0, Math.min(Math.ceil(d1 - tightened1), image1));
        b1 = Math.min(b1, Math.max(Math.floor(d1 + tightened1), image1));
      }
      if (pbc[2]) {
        c0 = Math.max(c0, Math.min(Math.ceil(d2 - tightened2), image2));
        c1 = Math.min(c1, Math.max(Math.floor(d2 + tightened2), image2));
      }
    }
    const size = (a1 - a0 + 1) * (b1 - b0 + 1) * (c1 - c0 + 1);
    if (![a0, a1, b0, b1, c0, c1].every(Number.isSafeInteger)
        || a0 > a1 || b0 > b1 || c0 > c1 || !(size >= 1 && size <= MAX_COORDINATION_IMAGE_CANDIDATES)) {
      throw new Error('The cell is too thin to resolve coordination periodic images within the work limit.');
    }
  }
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

function neighborIndex(value, count, periodic) {
  if (periodic) return (value % count + count) % count;
  return value >= 0 && value < count ? value : -1;
}
