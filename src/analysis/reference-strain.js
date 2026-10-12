import { cellFaceHeights, determinant3, imageLatticeCell, invert3 } from '../data/model.js';
import { atomRange, NeighborSearch, NeighborBuffer } from './neighbors.js';
import { yieldToMain } from '../task-yield.js';
import { canonicalAtomNumber } from '../data/atom-ids.js';
import { cpuMemoryBudget } from './cpu-memory.js';

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

// Weak keys do not retain evicted reference frames. A retained lookup owns its
// snapshot: neither callers nor Workers can mutate the table behind another job.
const referenceIdLookups = new WeakMap();
const MAX_DENSE_ID_ENTRIES = 8 * 1024 * 1024;
const MAX_CACHED_ID_BYTES = 64 * 1024 * 1024;
const referenceIdRecency = new Map();
let cachedReferenceIdBytes = 0;
const ID_SLICE_ROWS = 65_536, ID_CLOCK_ROWS = 2048, ID_SLICE_MS = 8;

/** Match IDs before either CPU or GPU dispatch. Numeric typed IDs avoid text
 * conversion, using a bounded dense table when possible and a numeric Map for
 * sparse/large IDs. A cached reference lookup is checked against every source
 * ID on each visit; mutable typed arrays therefore cannot produce stale rows.
 * Main-thread slices allow Cancel and rendering to run during preparation.
 */
export async function createReferenceMappingAsync(currentFrame, referenceFrame, {
  signal, onProgress = () => {}, environment = globalThis,
} = {}) {
  throwIfAborted(signal);
  const cacheLimit = Math.min(MAX_CACHED_ID_BYTES, Math.floor(cpuMemoryBudget(environment) / 8));
  trimReferenceLookups(cacheLimit);
  assertStableCorrespondence(currentFrame, referenceFrame);
  const currentIds = idArray(currentFrame), referenceIds = idArray(referenceFrame);
  const total = currentIds.length + referenceIds.length;
  let sliceStarted = performance.now(), sliceRows = 0, completedRows = 0;
  const needsYield = () => {
    sliceRows += 1;
    return sliceRows >= ID_SLICE_ROWS || (sliceRows % ID_CLOCK_ROWS === 0 && performance.now() - sliceStarted >= ID_SLICE_MS);
  };
  const checkpoint = async completed => {
    completedRows = Math.max(completedRows, completed);
    onProgress({ completed: completedRows, total });
    await yieldToMain();
    throwIfAborted(signal);
    sliceRows = 0; sliceStarted = performance.now();
  };
  let lookup;
  if (numericTypedIds(referenceIds)) {
    lookup = referenceIdLookups.get(referenceIds);
    if (lookup) {
      let unchanged = lookup.snapshot.length === referenceIds.length;
      for (let atom = 0; unchanged && atom < referenceIds.length; atom += 1) {
        unchanged = lookup.snapshot[atom] === referenceIds[atom];
        if (needsYield()) await checkpoint(atom + 1);
      }
      if (!unchanged) { forgetReferenceLookup(referenceIds, lookup); lookup = null; }
      else touchReferenceLookup(lookup);
    }
    if (!lookup) {
      const snapshot = new Float64Array(referenceIds.length);
      let minimum = Infinity, maximum = -Infinity;
      for (let atom = 0; atom < referenceIds.length; atom += 1) {
        const id = referenceIds[atom];
        assertUniqueId(id, false);
        snapshot[atom] = id;
        if (id < minimum) minimum = id;
        if (id > maximum) maximum = id;
        if (needsYield()) await checkpoint(Math.floor((atom + 1) / 2));
      }
      const length = maximum - minimum + 1;
      const dense = Number.isSafeInteger(length) && length <= MAX_DENSE_ID_ENTRIES && length <= referenceIds.length * 4 + 1024;
      // Index + 1 leaves zero as the missing-ID sentinel without filling the
      // whole table. Subtracting a large, safe integer minimum is exact here.
      lookup = dense ? { snapshot, minimum, table: new Int32Array(length) }
        : { snapshot, byId: new Map() };
      for (let atom = 0; atom < snapshot.length; atom += 1) {
        const id = snapshot[atom];
        if (lookup.table) {
          const slot = id - minimum;
          assertUniqueId(id, lookup.table[slot] !== 0);
          lookup.table[slot] = atom + 1;
        } else {
          assertUniqueId(id, lookup.byId.has(id));
          lookup.byId.set(id, atom);
        }
        if (needsYield()) await checkpoint(Math.floor((snapshot.length + atom + 1) / 2));
      }
      const retainedBytes = snapshot.byteLength + (lookup.table?.byteLength ?? snapshot.length * 48);
      cacheReferenceLookup(referenceIds, lookup, retainedBytes, cacheLimit);
    }
  } else {
    // Keep the original text path for compound/string IDs. Only looking up
    // text against a numeric reference requires canonical numeric conversion.
    const byId = new Map();
    for (let atom = 0; atom < referenceIds.length; atom += 1) {
      const id = referenceIds[atom], key = String(id);
      assertUniqueId(id, byId.has(key));
      byId.set(key, atom);
      if (needsYield()) await checkpoint(atom + 1);
    }
    lookup = { byId, textual: true };
  }
  await checkpoint(referenceIds.length);
  const mapping = new Int32Array(currentIds.length), seen = new Set();
  const numeric = numericTypedIds(currentIds);
  const seenDense = numeric && lookup.table ? new Uint8Array(lookup.table.length) : null;
  for (let atom = 0; atom < currentIds.length; atom += 1) {
    const id = currentIds[atom], key = lookup.textual ? String(id) : numeric ? id : referenceIdKey(id);
    const slot = typeof key === 'number' && lookup.table ? key - lookup.minimum : -1;
    const inTable = Number.isInteger(slot) && slot >= 0 && slot < (lookup.table?.length ?? 0);
    const repeated = seenDense && inTable ? seenDense[slot] !== 0 : seen.has(key);
    assertUniqueId(id, repeated);
    if (seenDense && inTable) seenDense[slot] = 1; else seen.add(key);
    mapping[atom] = lookup.table ? (inTable ? lookup.table[slot] - 1 : -1) : (lookup.byId.get(key) ?? -1);
    if (needsYield()) await checkpoint(referenceIds.length + atom + 1);
  }
  throwIfAborted(signal);
  onProgress({ completed: total, total });
  return mapping;
}

// The weak LRU bounds all retained tables together, including dead references
// awaiting collection. It stores no source array or frame strongly. Engines
// without WeakRef simply rebuild instead of retaining an unbounded cache.
function cacheReferenceLookup(ids, lookup, bytes, limit) {
  if (typeof WeakRef !== 'function' || bytes > limit) return;
  const previous = referenceIdLookups.get(ids);
  if (previous) forgetReferenceLookup(ids, previous);
  while (cachedReferenceIdBytes + bytes > limit && referenceIdRecency.size > 0) {
    const oldest = referenceIdRecency.keys().next().value;
    forgetReferenceLookup(referenceIdRecency.get(oldest).ids.deref(), oldest);
  }
  referenceIdLookups.set(ids, lookup);
  referenceIdRecency.set(lookup, { ids: new WeakRef(ids), bytes });
  cachedReferenceIdBytes += bytes;
}

function trimReferenceLookups(limit) {
  for (const [entry, record] of referenceIdRecency) if (!record.ids.deref()) forgetReferenceLookup(null, entry);
  while (cachedReferenceIdBytes > limit && referenceIdRecency.size > 0) {
    const oldest = referenceIdRecency.keys().next().value;
    forgetReferenceLookup(referenceIdRecency.get(oldest).ids.deref(), oldest);
  }
}

/** Retained lookup bytes for frame/cache admission. Typed buffers are exact;
 * sparse Map entries use the same conservative 48-byte estimate as retention.
 * No frame properties, Worker payloads or calculated outputs are modified.
 */
export function referenceMappingCacheBytes(ids) {
  if (ids !== undefined) return referenceIdRecency.get(referenceIdLookups.get(ids))?.bytes ?? 0;
  trimReferenceLookups(MAX_CACHED_ID_BYTES);
  return cachedReferenceIdBytes;
}

function touchReferenceLookup(lookup) {
  const record = referenceIdRecency.get(lookup);
  if (record) { referenceIdRecency.delete(lookup); referenceIdRecency.set(lookup, record); }
}

function forgetReferenceLookup(ids, lookup) {
  const record = referenceIdRecency.get(lookup);
  if (record) { cachedReferenceIdBytes -= record.bytes; referenceIdRecency.delete(lookup); }
  if (ids && referenceIdLookups.get(ids) === lookup) referenceIdLookups.delete(ids);
}

function numericTypedIds(ids) {
  return ArrayBuffer.isView(ids) && typeof ids[0] === 'number';
}

function referenceIdKey(id) {
  const value = canonicalAtomNumber(id);
  return value === undefined ? String(id) : value;
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
 * sourceRepetitions (see wrappedSourceRepetitions) makes those images the
 * source lattice of a replicated wrapped frame, whose copies jump by source
 * vectors when their source atom wraps.
 *
 * Unlike ideal-lattice PTM strain, this calculation follows atom IDs and can use
 * an arbitrary reference configuration. Undefined fits remain NaN silently.
 */
export function calculateReferenceStrain(frame, {
  referenceFractional, referenceCell, referenceMapping, cutoff, sourceRepetitions = null,
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
  const { inverseMapping, search, referenceInverse, imageCell, imageHeights, imageScale, currentFractional }
    = preparedContext ?? prepareReferenceStrainContext(frame, { referenceFractional, referenceCell, referenceMapping, sourceRepetitions });
  const length = endAtom - startAtom;
  const result = Object.fromEntries(REFERENCE_STRAIN_FIELDS.map(name => [name, new Float32Array(length).fill(NaN)]));
  const covariance = new Float64Array(9), crossCovariance = new Float64Array(9);
  const inverse = new Float64Array(9), F = new Float64Array(9), E = new Float64Array(9);
  const currentVector = new Float64Array(3), change = new Float64Array(3), contextScratch = new NeighborBuffer();
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
    const referenceNeighbors = search.collect(referenceAtom, cutoff, contextScratch, MAX_REFERENCE_NEIGHBORS + 1);
    if (referenceNeighbors.length > MAX_REFERENCE_NEIGHBORS) {
      throw new Error('Too many reference-strain neighbors; reduce the cutoff.');
    }
    for (let neighborIndex = 0; neighborIndex < referenceNeighbors.length; neighborIndex++) {
      const neighborAtom = referenceNeighbors.atoms[neighborIndex];
      const other = inverseMapping[neighborAtom];
      if (other < 0) continue;
      const r0 = referenceNeighbors.xs[neighborIndex], r1 = referenceNeighbors.ys[neighborIndex], r2 = referenceNeighbors.zs[neighborIndex];
      for (let axis = 0; axis < 3; axis += 1) {
        const currentDifference = currentFractional[other * 3 + axis] - currentFractional[atom * 3 + axis];
        const referenceDifference = search.coordinates[neighborAtom * 3 + axis] - search.coordinates[referenceAtom * 3 + axis];
        change[axis] = currentDifference - referenceDifference;
      }
      minimumImageChange(change, imageCell, imageHeights, imageScale);
      // Recover the reference image from its full vector instead of discarding
      // image information with a second minimum-image operation on the bond.
      for (let axis = 0; axis < 3; axis += 1) {
        currentVector[axis] = change[axis] + r0 * referenceInverse[axis]
          + r1 * referenceInverse[3 + axis] + r2 * referenceInverse[6 + axis];
      }
      const [a, b, c] = currentVector;
      const h = frame.cell.vectors;
      currentVector[0] = a * h[0] + b * h[3] + c * h[6];
      currentVector[1] = a * h[1] + b * h[4] + c * h[7];
      currentVector[2] = a * h[2] + b * h[5] + c * h[8];
      squaredLengths += currentVector[0] * currentVector[0] + currentVector[1] * currentVector[1] + currentVector[2] * currentVector[2];
      covariance[0] += r0 * r0; crossCovariance[0] += currentVector[0] * r0;
      covariance[1] += r0 * r1; crossCovariance[1] += currentVector[0] * r1;
      covariance[2] += r0 * r2; crossCovariance[2] += currentVector[0] * r2;
      covariance[3] += r1 * r0; crossCovariance[3] += currentVector[1] * r0;
      covariance[4] += r1 * r1; crossCovariance[4] += currentVector[1] * r1;
      covariance[5] += r1 * r2; crossCovariance[5] += currentVector[1] * r2;
      covariance[6] += r2 * r0; crossCovariance[6] += currentVector[2] * r0;
      covariance[7] += r2 * r1; crossCovariance[7] += currentVector[2] * r1;
      covariance[8] += r2 * r2; crossCovariance[8] += currentVector[2] * r2;
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
 * corrections. Inputs belong to one immutable snapshot; shared normalized
 * coordinates and inverse mappings remain read-only and are checked exactly. */
export function prepareReferenceStrainContext(frame, { referenceFractional, referenceCell, referenceMapping, referenceSearch,
  sourceRepetitions = null, normalizedCurrentFractional = null, inverseMappingInput = null }) {
  const count = frame.fractional.length / 3;
  const referenceCount = referenceFractional?.length / 3;
  if (!Number.isInteger(referenceCount) || referenceCount < 1 || referenceMapping?.length !== count) {
    throw new Error('Reference-strain coordinates or atom mapping are incomplete.');
  }
  if (!referenceCell?.pbc || referenceCell.pbc.some((periodic, axis) => periodic !== frame.cell.pbc[axis])) {
    throw new Error('Reference and current frames must use the same periodic boundary axes.');
  }
  if (inverseMappingInput !== null && (!(inverseMappingInput instanceof Int32Array)
      || inverseMappingInput.length !== referenceCount)) {
    throw new Error('Reference-strain inverse mapping is incomplete.');
  }
  const inverseMapping = inverseMappingInput ?? new Int32Array(referenceCount).fill(-1);
  if (inverseMappingInput !== null) for (let reference = 0; reference < referenceCount; reference += 1) {
    const atom = inverseMapping[reference];
    if (atom < -1 || atom >= count || (atom >= 0 && referenceMapping[atom] !== reference)) {
      throw new Error('Reference-strain inverse mapping must match the atom mapping.');
    }
  }
  for (let atom = 0; atom < count; atom += 1) {
    const reference = referenceMapping[atom];
    if (!Number.isInteger(reference) || reference < -1 || reference >= referenceCount
        || (reference >= 0 && (inverseMappingInput !== null
          ? inverseMapping[reference] !== atom : inverseMapping[reference] >= 0))) {
      throw new Error('Reference-strain atom mapping must be one-to-one and within the reference frame.');
    }
    if (reference >= 0 && inverseMappingInput === null) inverseMapping[reference] = atom;
  }

  const search = referenceSearch ?? new NeighborSearch({ fractional: referenceFractional, cell: referenceCell });
  const referenceInverse = invert3(referenceCell.vectors);
  const imageCell = imageLatticeCell(frame.cell, sourceRepetitions);
  const imageHeights = cellFaceHeights(imageCell);
  const imageScale = sourceRepetitions ? Float64Array.from(sourceRepetitions) : null;
  if (normalizedCurrentFractional !== null && (!(normalizedCurrentFractional instanceof Float64Array)
      || normalizedCurrentFractional.length !== frame.fractional.length)) {
    throw new Error('Reference-strain normalized current coordinates are incomplete.');
  }
  let alreadyNormalized = frame.fractional instanceof Float64Array;
  for (let k = 0; k < frame.fractional.length; k += 1) {
    const value = frame.fractional[k];
    if (!Number.isFinite(value)) throw new Error('Reference-frame strain requires finite current coordinates.');
    const normalized = frame.cell.pbc[k % 3] ? value - Math.floor(value) : value;
    if (normalizedCurrentFractional !== null && !Object.is(normalizedCurrentFractional[k], normalized)) {
      throw new Error('Reference-strain normalized current coordinates must match the frame exactly.');
    }
    if (!Object.is(value, normalized)) alreadyNormalized = false;
  }
  const currentFractional = normalizedCurrentFractional ?? (alreadyNormalized ? frame.fractional
    : Float64Array.from(frame.fractional, (value, k) => frame.cell.pbc[k % 3] ? value - Math.floor(value) : value));
  return { frame, referenceFractional, referenceCell, referenceMapping, inverseMapping, search,
    referenceInverse, imageCell, imageHeights, imageScale, currentFractional };
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

// change is in reduced coordinates of the current cell. scale converts it to
// those of the image lattice (cell, heights) when that is a source cell.
function minimumImageChange(change, cell, heights, scale) {
  if (scale) for (let axis = 0; axis < 3; axis += 1) change[axis] *= scale[axis];
  const h = cell.vectors;
  const d0 = change[0], d1 = change[1], d2 = change[2];
  let s0 = cell.pbc[0] ? -Math.round(d0) : 0;
  let s1 = cell.pbc[1] ? -Math.round(d1) : 0;
  let s2 = cell.pbc[2] ? -Math.round(d2) : 0;
  const a0 = d0 + s0, b0 = d1 + s1, c0 = d2 + s2;
  let best = (a0 * h[0] + b0 * h[3] + c0 * h[6]) ** 2
    + (a0 * h[1] + b0 * h[4] + c0 * h[7]) ** 2 + (a0 * h[2] + b0 * h[5] + c0 * h[8]) ** 2;
  const radius = Math.sqrt(best);
  const lo0 = cell.pbc[0] ? Math.ceil(-radius / heights[0] - d0 - 1e-12) : 0;
  const hi0 = cell.pbc[0] ? Math.floor(radius / heights[0] - d0 + 1e-12) : 0;
  const lo1 = cell.pbc[1] ? Math.ceil(-radius / heights[1] - d1 - 1e-12) : 0;
  const hi1 = cell.pbc[1] ? Math.floor(radius / heights[1] - d1 + 1e-12) : 0;
  const lo2 = cell.pbc[2] ? Math.ceil(-radius / heights[2] - d2 - 1e-12) : 0;
  const hi2 = cell.pbc[2] ? Math.floor(radius / heights[2] - d2 + 1e-12) : 0;
  if (1 * (hi0 - lo0 + 1) * (hi1 - lo1 + 1) * (hi2 - lo2 + 1) > 100_000) {
    throw new Error('The cell is too thin to resolve reference-strain periodic images.');
  }
  for (let a = lo0; a <= hi0; a += 1) {
    for (let b = lo1; b <= hi1; b += 1) {
      for (let c = lo2; c <= hi2; c += 1) {
        const da = d0 + a, db = d1 + b, dc = d2 + c;
        const distance = (da * h[0] + db * h[3] + dc * h[6]) ** 2
          + (da * h[1] + db * h[4] + dc * h[7]) ** 2 + (da * h[2] + db * h[5] + dc * h[8]) ** 2;
        if (distance < best) { best = distance; s0 = a; s1 = b; s2 = c; }
      }
    }
  }
  change[0] += s0; change[1] += s1; change[2] += s2;
  if (scale) for (let axis = 0; axis < 3; axis += 1) change[axis] /= scale[axis];
}
