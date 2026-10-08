import { cellFaceHeights, determinant3, invert3 } from '../data/model.js';
import { atomRange, NeighborSearch } from './neighbors.js';
import { yieldToMain } from '../task-yield.js';

export const REFERENCE_STRAIN_FIELDS = Object.freeze([
  'referenceShearStrain', 'referenceHydrostaticStrain', 'referenceVolumeChange',
  'referenceE11', 'referenceE22', 'referenceE33', 'referenceE12', 'referenceE13', 'referenceE23',
  ...Array.from({ length: 9 }, (_, k) => `referenceF${Math.floor(k / 3) + 1}${k % 3 + 1}`),
  'referenceD2min',
]);

/** Non-affine squared displacement D²min = Σ |d − F·D|² over the fitted
 * neighbors (OVITO's definition, not divided by the neighbor count). It is
 * expanded as Σ|d|² − 2 Σ F∘C + Σ (F A Fᵀ)ᵢᵢ with C = Σ d Dᵀ and A = Σ D Dᵀ,
 * the sums the fit already holds; the GPU shader uses the same expansion.
 * Residuals below 1e-10 of Σ|d|² are rounding and become zero. */
export function nonAffineSquaredDisplacement(F, covariance, crossCovariance, squaredLengths) {
  let fc = 0, faf = 0;
  for (let k = 0; k < 9; k += 1) fc += F[k] * crossCovariance[k];
  for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) {
    let fa = 0;
    for (let k = 0; k < 3; k += 1) fa += F[row * 3 + k] * covariance[k * 3 + column];
    faf += fa * F[row * 3 + column];
  }
  const value = squaredLengths - 2 * fc + faf;
  return Math.abs(value) <= squaredLengths * 1e-10 ? 0 : Math.max(0, value);
}

const numericalZero = value => Math.abs(value) < 1e-12 ? 0 : value;
const MAX_REFERENCE_NEIGHBORS = 100_000;

/** Match trajectory atoms by explicit IDs, allowing additions/removals. CFG row
 * numbers are synthesized IDs and cannot establish cross-frame correspondence.
 */
export function createReferenceMapping(currentFrame, referenceFrame) {
  assertStableCorrespondence(currentFrame, referenceFrame);
  const currentIds = checkedIds(currentFrame);
  const referenceIds = checkedIds(referenceFrame);
  const byId = new Map();
  for (let atom = 0; atom < referenceIds.length; atom += 1) byId.set(String(referenceIds[atom]), atom);
  return Int32Array.from(currentIds, id => byId.get(String(id)) ?? -1);
}

/** The same preparation with periodic browser yields, so matching large ID
 * arrays does not block the Cancel button before analysis Workers are started.
 */
export async function createReferenceMappingAsync(currentFrame, referenceFrame, {
  signal, onProgress = () => {},
} = {}) {
  throwIfAborted(signal);
  assertStableCorrespondence(currentFrame, referenceFrame);
  const currentIds = idArray(currentFrame), referenceIds = idArray(referenceFrame);
  const byId = new Map(), seen = new Set(), mapping = new Int32Array(currentIds.length);
  const total = currentIds.length + referenceIds.length;
  const checkpoint = async (completed) => {
    onProgress({ completed, total });
    await yieldToMain();
    throwIfAborted(signal);
  };
  for (let atom = 0; atom < referenceIds.length; atom += 1) {
    const id = referenceIds[atom];
    const key = String(id);
    assertUniqueId(id, byId.has(key));
    byId.set(key, atom);
    if ((atom + 1) % 65_536 === 0) await checkpoint(atom + 1);
  }
  if (referenceIds.length % 65_536 !== 0) await checkpoint(referenceIds.length);
  for (let atom = 0; atom < currentIds.length; atom += 1) {
    const id = currentIds[atom];
    const key = String(id);
    assertUniqueId(id, seen.has(key));
    seen.add(key);
    mapping[atom] = byId.get(key) ?? -1;
    if ((atom + 1) % 65_536 === 0) await checkpoint(referenceIds.length + atom + 1);
  }
  throwIfAborted(signal);
  onProgress({ completed: total, total });
  return mapping;
}

function assertStableCorrespondence(currentFrame, referenceFrame) {
  if (currentFrame === referenceFrame) return;
  for (const frame of [currentFrame, referenceFrame]) {
    if (frame.idSource === 'row-order' || (frame.sourceFormat === 'cfg' && frame.idSource !== 'explicit')) {
      throw new Error('Reference-frame strain requires explicit stable atom IDs; CFG row numbers cannot match atoms between frames.');
    }
  }
}

function idArray(frame) {
  const count = frame.fractional?.length / 3;
  if (!Number.isInteger(count) || count < 1 || frame.ids?.length !== count) {
    throw new Error('Reference-frame strain requires an atom ID for every atom.');
  }
  return frame.ids;
}

function checkedIds(frame) {
  const ids = idArray(frame);
  const seen = new Set();
  for (const id of ids) {
    const key = String(id);
    assertUniqueId(id, seen.has(key));
    seen.add(key);
  }
  return ids;
}

function assertUniqueId(id, repeated) {
  const valid = typeof id === 'number' ? Number.isSafeInteger(id)
    : typeof id === 'string' && id.length > 0 && !/[\x00-\x1f\x7f]/.test(id);
  if (!valid || repeated) throw new Error('Reference-frame strain requires unique integer atom IDs or stable string IDs.');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
}


/** Unweighted local least-squares deformation: r(current) ~= F r(reference).
 * Neighbors and cutoff belong to the reference configuration. Image changes
 * are resolved in the full triclinic metric, keeping distinct reference images
 * in primitive cells. Periodic relative motion must remain within the nearest
 * image of its reference bond; a wrapped trajectory cannot resolve larger slips.
 *
 * Unlike ideal-lattice PTM strain, this calculation follows atom IDs and can use
 * an arbitrary reference configuration. Undefined fits remain NaN silently.
 */
export function calculateReferenceStrain(frame, {
  referenceFractional, referenceCell, referenceMapping, cutoff,
  preparedContext = null, onPhase = () => {}, onAtoms = () => {}, ...range
} = {}) {
  const startedAt = performance.now();
  if (!Number.isFinite(cutoff) || cutoff <= 0) throw new Error('Reference-strain cutoff must be positive and finite.');
  const count = frame.fractional.length / 3;
  const { startAtom, endAtom } = atomRange(count, range);
  if (preparedContext && (preparedContext.frame !== frame || preparedContext.referenceFractional !== referenceFractional
    || preparedContext.referenceCell !== referenceCell || preparedContext.referenceMapping !== referenceMapping)) {
    throw new Error('Reference-strain prepared context does not match its inputs.');
  }
  onPhase('indexing');
  const { inverseMapping, search, referenceInverse, currentHeights, currentFractional }
    = preparedContext ?? prepareReferenceStrainContext(frame, { referenceFractional, referenceCell, referenceMapping });
  const length = endAtom - startAtom;
  const result = Object.fromEntries(REFERENCE_STRAIN_FIELDS.map(name => [name, new Float32Array(length).fill(NaN)]));
  const covariance = new Float64Array(9), crossCovariance = new Float64Array(9);
  const inverse = new Float64Array(9), F = new Float64Array(9), E = new Float64Array(9);
  const currentVector = new Float64Array(3), change = new Float64Array(3);
  let incomplete = 0;
  let lastProgressAt = performance.now();
  onPhase('analyzing');
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    const index = atom - startAtom;
    if (index % 512 === 0 && performance.now() - lastProgressAt >= 150) {
      onAtoms(index, length);
      lastProgressAt = performance.now();
    }
    const referenceAtom = referenceMapping[atom];
    if (referenceAtom < 0) { incomplete += 1; continue; }
    covariance.fill(0);
    crossCovariance.fill(0);
    let neighbors = 0, squaredLengths = 0;
    const referenceNeighbors = search.within(referenceAtom, cutoff, MAX_REFERENCE_NEIGHBORS + 1);
    if (referenceNeighbors.length > MAX_REFERENCE_NEIGHBORS) {
      throw new Error('Too many reference-strain neighbors; reduce the cutoff.');
    }
    for (const neighbor of referenceNeighbors) {
      const other = inverseMapping[neighbor.atom];
      if (other < 0) continue;
      const r = [neighbor.x, neighbor.y, neighbor.z];
      for (let axis = 0; axis < 3; axis += 1) {
        const currentDifference = currentFractional[other * 3 + axis] - currentFractional[atom * 3 + axis];
        const referenceDifference = search.coordinates[neighbor.atom * 3 + axis] - search.coordinates[referenceAtom * 3 + axis];
        change[axis] = currentDifference - referenceDifference;
      }
      minimumImageChange(change, frame.cell, currentHeights);
      // Recover the reference image from its full vector instead of discarding
      // image information with a second minimum-image operation on the bond.
      for (let axis = 0; axis < 3; axis += 1) {
        currentVector[axis] = change[axis] + r[0] * referenceInverse[axis]
          + r[1] * referenceInverse[3 + axis] + r[2] * referenceInverse[6 + axis];
      }
      const [a, b, c] = currentVector;
      const h = frame.cell.vectors;
      currentVector[0] = a * h[0] + b * h[3] + c * h[6];
      currentVector[1] = a * h[1] + b * h[4] + c * h[7];
      currentVector[2] = a * h[2] + b * h[5] + c * h[8];
      squaredLengths += currentVector[0] * currentVector[0] + currentVector[1] * currentVector[1] + currentVector[2] * currentVector[2];
      for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) {
        covariance[row * 3 + column] += r[row] * r[column];
        crossCovariance[row * 3 + column] += currentVector[row] * r[column];
      }
      neighbors += 1;
    }
    if (neighbors < 3 || !invertCovariance(covariance, inverse)) { incomplete += 1; continue; }
    for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) {
      let value = 0;
      for (let k = 0; k < 3; k += 1) value += crossCovariance[row * 3 + k] * inverse[k * 3 + column];
      F[row * 3 + column] = numericalZero(value);
    }
    const volume = determinant3(F);
    if (!Number.isFinite(volume) || volume <= 0) { incomplete += 1; continue; }
    for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) {
      let value = 0;
      for (let k = 0; k < 3; k += 1) value += F[k * 3 + row] * F[k * 3 + column];
      E[row * 3 + column] = numericalZero((value - (row === column ? 1 : 0)) / 2);
    }
    const hydrostatic = (E[0] + E[4] + E[8]) / 3;
    const deviatoricNorm = E.reduce((sum, value, k) => sum + (value - (k % 4 === 0 ? hydrostatic : 0)) ** 2, 0);
    result.referenceShearStrain[index] = numericalZero(Math.sqrt(deviatoricNorm / 2));
    result.referenceHydrostaticStrain[index] = numericalZero(hydrostatic);
    result.referenceVolumeChange[index] = numericalZero(volume - 1);
    for (const [name, k] of [['referenceE11', 0], ['referenceE22', 4], ['referenceE33', 8],
      ['referenceE12', 1], ['referenceE13', 2], ['referenceE23', 5]]) result[name][index] = E[k];
    for (let k = 0; k < 9; k += 1) result[`referenceF${Math.floor(k / 3) + 1}${k % 3 + 1}`][index] = F[k];
    result.referenceD2min[index] = nonAffineSquaredDisplacement(F, covariance, crossCovariance, squaredLengths);
  }
  onAtoms(length, length);
  return { ...result, startAtom, endAtom, incomplete, warning: null, elapsedMs: performance.now() - startedAt };
}

/** Reuse the double-precision index and correspondence for sparse GPU
 * corrections, instead of rebuilding the complete frame for each atom. */
export function prepareReferenceStrainContext(frame, { referenceFractional, referenceCell, referenceMapping, referenceSearch }) {
  const count = frame.fractional.length / 3;
  const referenceCount = referenceFractional?.length / 3;
  if (!Number.isInteger(referenceCount) || referenceCount < 1 || referenceMapping?.length !== count) {
    throw new Error('Reference-strain coordinates or atom mapping are incomplete.');
  }
  if (!referenceCell?.pbc || referenceCell.pbc.some((periodic, axis) => periodic !== frame.cell.pbc[axis])) {
    throw new Error('Reference and current frames must use the same periodic boundary axes.');
  }
  const inverseMapping = new Int32Array(referenceCount).fill(-1);
  for (let atom = 0; atom < count; atom += 1) {
    const reference = referenceMapping[atom];
    if (!Number.isInteger(reference) || reference < -1 || reference >= referenceCount
        || (reference >= 0 && inverseMapping[reference] >= 0)) {
      throw new Error('Reference-strain atom mapping must be one-to-one and within the reference frame.');
    }
    if (reference >= 0) inverseMapping[reference] = atom;
  }

  const search = referenceSearch ?? new NeighborSearch({ fractional: referenceFractional, cell: referenceCell });
  const referenceInverse = invert3(referenceCell.vectors);
  const currentHeights = cellFaceHeights(frame.cell);
  const currentFractional = Float64Array.from(frame.fractional, (value, k) => {
    if (!Number.isFinite(value)) throw new Error('Reference-frame strain requires finite current coordinates.');
    return frame.cell.pbc[k % 3] ? value - Math.floor(value) : value;
  });
  return { frame, referenceFractional, referenceCell, referenceMapping, inverseMapping, search,
    referenceInverse, currentHeights, currentFractional };
}

// Scale first so the singularity threshold is independent of the input units.
function invertCovariance(matrix, output) {
  const scale = Math.max(matrix[0], matrix[4], matrix[8]);
  if (!Number.isFinite(scale) || scale <= 0) return false;
  const [a, b, c, d, e, f, g, h, i] = Array.from(matrix, value => value / scale);
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || determinant <= 1e-12) return false;
  const factor = 1 / (scale * determinant);
  output.set([(e * i - f * h) * factor, (c * h - b * i) * factor, (b * f - c * e) * factor,
    (f * g - d * i) * factor, (a * i - c * g) * factor, (c * d - a * f) * factor,
    (d * h - e * g) * factor, (b * g - a * h) * factor, (a * e - b * d) * factor]);
  return true;
}

function minimumImageChange(change, cell, heights) {
  const h = cell.vectors;
  const shifts = Array.from(change, (value, axis) => cell.pbc[axis] ? -Math.round(value) : 0);
  const squaredLength = (a, b, c) => (a * h[0] + b * h[3] + c * h[6]) ** 2
    + (a * h[1] + b * h[4] + c * h[7]) ** 2 + (a * h[2] + b * h[5] + c * h[8]) ** 2;
  let best = squaredLength(...change.map((value, axis) => value + shifts[axis]));
  // Face heights bound every candidate no longer than the initial valid image.
  // Fractional rounding alone is insufficient in a highly skewed cell.
  const radius = Math.sqrt(best);
  const bounds = Array.from(change, (value, axis) => cell.pbc[axis]
    ? [Math.ceil(-radius / heights[axis] - value - 1e-12), Math.floor(radius / heights[axis] - value + 1e-12)]
    : [0, 0]);
  if (bounds.reduce((budget, [lo, hi]) => budget * (hi - lo + 1), 1) > 100_000) {
    throw new Error('The cell is too thin to resolve reference-strain periodic images.');
  }
  for (let a = bounds[0][0]; a <= bounds[0][1]; a += 1) {
    for (let b = bounds[1][0]; b <= bounds[1][1]; b += 1) {
      for (let c = bounds[2][0]; c <= bounds[2][1]; c += 1) {
        const distance = squaredLength(change[0] + a, change[1] + b, change[2] + c);
        if (distance < best) { best = distance; shifts[0] = a; shifts[1] = b; shifts[2] = c; }
      }
    }
  }
  for (let axis = 0; axis < 3; axis += 1) change[axis] += shifts[axis];
}
