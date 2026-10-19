import { cellFaceHeights, fractionalToCartesian, imageLatticeCell, invert3, wrappedSourceRepetitions } from '../data/model.js';
import { createReferenceMappingAsync } from './reference-strain.js';
import { yieldToMain } from '../shared/task-yield.js';

const MAX_IMAGE_CANDIDATES = 100_000;
const derivedCartesianPositions = new WeakMap();
const preparedContexts = new WeakSet();

/** Cartesian current − reference displacement, matched by explicit atom IDs.
 * When both frames have generated row IDs, equal atom counts permit a row-order
 * fallback. This assumes the source keeps atom order stable between frames.
 * Cell deformation and origin changes contribute to displacement: no affine
 * cell remapping is applied. Minimum images use the current triclinic metric.
 * Physically replicated frames built from wrapped coordinates use the lattice
 * of their source cell instead: a wrapped atom jumps by a source vector, not
 * by a vector of the enlarged cell.
 * Unmatched current atoms remain NaN; they do not produce arrow fragments.
 * Disable minimumImage when trajectory coordinates have already been unwrapped.
 */
export const MAX_COLOR_TILES = 64;
export const COLOR_TILE_CATEGORIES = Object.freeze([
  { id: 0, label: 'Tile A', description: 'Even checkerboard tile in the reference frame', color: [232, 232, 232] },
  { id: 1, label: 'Tile B', description: 'Odd checkerboard tile in the reference frame', color: [70, 110, 190] },
].map(Object.freeze));

/** AtomEye-style color tiling: the checkerboard parity of each atom's
 * reference position, cut into `tiles` (a, b, c) pieces along the reference
 * cell vectors; 0 leaves an axis undivided. Unmatched atoms are NaN. Atoms
 * keep this label in later frames, so slip and shear show as offset tiles. */
export function colorTileLabels(referenceFrame, referenceMapping, tiles) {
  if (!Array.isArray(tiles) || tiles.length !== 3 || tiles.some(count => !Number.isInteger(count) || count < 0 || count > MAX_COLOR_TILES)) {
    throw new Error(`Color tiles need three integers from 0 to ${MAX_COLOR_TILES}.`);
  }
  const labels = new Float32Array(referenceMapping.length).fill(NaN), fractional = referenceFrame.fractional;
  for (let atom = 0; atom < referenceMapping.length; atom += 1) {
    const reference = referenceMapping[atom];
    if (reference < 0) continue;
    let tile = 0;
    // The tolerance keeps atoms on a tile boundary (0.5 with 2 tiles) together.
    for (let axis = 0; axis < 3; axis += 1) if (tiles[axis]) tile += Math.floor(tiles[axis] * fractional[reference * 3 + axis] + 1e-6);
    labels[atom] = ((tile % 2) + 2) % 2;
  }
  return labels;
}

export async function computeDisplacements(frame, reference, {
  minimumImage = true, signal, onProgress = () => {},
} = {}) {
  const parameters = await prepareDisplacements(frame, reference, { minimumImage, signal, onProgress, cacheDerivedPositions: false });
  const context = prepareDisplacementCalculation(frame, parameters);
  const { referenceMapping, mappingMode } = parameters;
  const count = referenceMapping.length, vectors = new Float32Array(count * 3).fill(NaN);
  let matched = 0, lastYieldAt = performance.now();
  for (let atom = 0; atom < count; atom += 1) {
    throwIfAborted(signal);
    if (calculateDisplacementAtom(context, atom, vectors, atom * 3)) matched += 1;
    if ((atom + 1) % 2048 === 0 || performance.now() - lastYieldAt >= 24) {
      onProgress({ phase: 'displacement', completed: atom + 1, total: count });
      await yieldToMain();
      lastYieldAt = performance.now();
    }
  }
  throwIfAborted(signal);
  onProgress({ phase: 'displacement', completed: count, total: count });
  return { vectors, matched, unmatched: count - matched, referenceMapping, minimumImage, mappingMode };
}

/** Match IDs once, before dispatching CPU ranges or GPU arithmetic. Cartesian
 * inputs retain the original precision, origin and unwrapped trajectory data.
 */
export async function prepareDisplacements(frame, reference, {
  minimumImage = true, signal, onProgress = () => {}, cacheDerivedPositions = true,
} = {}) {
  throwIfAborted(signal);
  if (typeof minimumImage !== 'boolean') throw new Error('The displacement minimum-image option must be a boolean.');
  const generated = [frame, reference].map(hasGeneratedIds);
  if (generated[0] !== generated[1]) {
    throw new Error('Displacement cannot match a frame with explicit atom IDs to a frame with generated row IDs.');
  }
  const mappingMode = generated[0] ? 'row-order' : 'id';
  let referenceMapping;
  if (mappingMode === 'row-order') {
    const count = coordinateCount(frame);
    if (coordinateCount(reference) !== count) {
      throw new Error('Row-order displacement requires the same atom count in the current and reference frames.');
    }
    referenceMapping = new Int32Array(count);
    for (let atom = 0; atom < count; atom += 1) {
      referenceMapping[atom] = atom;
      if ((atom + 1) % 65_536 === 0) {
        onProgress({ phase: 'matching', completed: atom + 1, total: count });
        await yieldToMain();
        throwIfAborted(signal);
      }
    }
    onProgress({ phase: 'matching', completed: count, total: count });
    throwIfAborted(signal);
  } else {
    try {
      referenceMapping = await createReferenceMappingAsync(frame, reference, {
        signal, onProgress: progress => onProgress({ ...progress, phase: 'matching' }),
      });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error(error.message.replaceAll('Reference-frame strain', 'Displacement'));
    }
  }
  const currentPositions = displacementPositions(frame, minimumImage, cacheDerivedPositions);
  const referencePositions = frame === reference ? currentPositions : displacementPositions(reference, minimumImage, cacheDerivedPositions);
  throwIfAborted(signal);
  return { referenceFrame: reference, referenceFractional: reference.fractional, referenceCell: reference.cell,
    referenceMapping, currentPositions, referencePositions, minimumImage, mappingMode,
    sourceRepetitions: minimumImage ? wrappedSourceRepetitions(frame, reference) : null };
}

/** Reusable double-precision geometry for CPU worker ranges and sparse GPU
 * image corrections. Matching is already complete when this helper runs.
 */
export function prepareDisplacementCalculation(frame, parameters) {
  const { referenceMapping, currentPositions, referencePositions, minimumImage = true, mappingMode = 'id',
    sourceRepetitions = null, sourceRange = null } = parameters;
  if (typeof minimumImage !== 'boolean') throw new Error('The displacement minimum-image option must be a boolean.');
  const count = sourceRange ? sourceRange.endAtom - sourceRange.startAtom : coordinateCount(frame);
  const referenceCount = sourceRange ? sourceRange.referenceCount : referencePositions?.length / 3;
  if (sourceRange && (!Number.isSafeInteger(sourceRange.totalAtoms) || sourceRange.totalAtoms < 1
      || !Number.isSafeInteger(sourceRange.startAtom) || !Number.isSafeInteger(sourceRange.endAtom)
      || sourceRange.startAtom < 0 || sourceRange.endAtom > sourceRange.totalAtoms || count < 0
      || referencePositions?.length !== count * 3)) throw new Error('The displacement source range is invalid.');
  if (!(referenceMapping instanceof Int32Array) || referenceMapping.length !== count
    || currentPositions?.length !== count * 3 || !Number.isInteger(referenceCount) || referenceCount < 1) {
    throw new Error('Displacement coordinates or atom mapping are incomplete.');
  }
  if (mappingMode !== 'id' && mappingMode !== 'row-order') throw new Error('The displacement mapping mode is invalid.');
  for (const atom of referenceMapping) if (atom < -1 || atom >= referenceCount) throw new Error('Displacement mapping is outside the reference frame.');
  const imageCell = minimumImage ? imageLatticeCell(frame.cell, sourceRepetitions) : null;
  const inverse = minimumImage ? invert3(imageCell.vectors) : null;
  const orthogonal = minimumImage && orthogonalBasis(imageCell.vectors);
  const heights = minimumImage && !orthogonal ? cellFaceHeights(imageCell) : null;
  const context = Object.freeze({ frame, referenceMapping, currentPositions, referencePositions, minimumImage, mappingMode,
    sourceRange: sourceRange ? Object.freeze({ ...sourceRange }) : null,
    sourceRepetitions: sourceRepetitions ? Object.freeze(Array.from(sourceRepetitions)) : null,
    imageCell, inverse, orthogonal, heights, change: new Float64Array(3) });
  preparedContexts.add(context);
  return context;
}

/** Synchronous atom ranges run inside CPU workers without repeating ID maps. */
export function calculatePreparedDisplacements(frame, parameters, { signal, onProgress = () => {} } = {}) {
  const context = parameters.preparedContext ?? prepareDisplacementCalculation(frame, parameters);
  if (!preparedContexts.has(context) || context.frame !== frame || context.referenceMapping !== parameters.referenceMapping
    || context.currentPositions !== parameters.currentPositions || context.referencePositions !== parameters.referencePositions
    || context.minimumImage !== (parameters.minimumImage ?? true) || context.mappingMode !== (parameters.mappingMode ?? 'id')
    || JSON.stringify(context.sourceRange) !== JSON.stringify(parameters.sourceRange ?? null)
    || JSON.stringify(context.sourceRepetitions) !== JSON.stringify(parameters.sourceRepetitions ?? null)) {
    throw new Error('The prepared displacement context does not match these inputs.');
  }
  const first = context.sourceRange?.startAtom ?? 0, last = context.sourceRange?.endAtom ?? context.referenceMapping.length;
  const startAtom = parameters.startAtom ?? first, endAtom = parameters.endAtom ?? last;
  if (!Number.isInteger(startAtom) || !Number.isInteger(endAtom) || startAtom < first || endAtom > last || endAtom < startAtom) {
    throw new Error('The displacement atom range is invalid.');
  }
  const vectors = new Float32Array((endAtom - startAtom) * 3).fill(NaN);
  const magnitudes = new Float64Array(endAtom - startAtom).fill(NaN);
  let matched = 0;
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    throwIfAborted(signal);
    const index = atom - startAtom;
    if (calculateDisplacementAtom(context, atom, vectors, index * 3)) {
      matched += 1;
      const offset = index * 3;
      const x = vectors[offset], y = vectors[offset + 1], z = vectors[offset + 2];
      magnitudes[index] = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? Math.hypot(x, y, z) : NaN;
    }
    if ((index + 1) % 2048 === 0) onProgress({ phase: 'displacement', completed: index + 1, total: endAtom - startAtom });
  }
  throwIfAborted(signal);
  onProgress({ phase: 'displacement', completed: endAtom - startAtom, total: endAtom - startAtom });
  return { vectors, magnitudes, matched, unmatched: endAtom - startAtom - matched, referenceMapping: context.referenceMapping,
    minimumImage: context.minimumImage, mappingMode: context.mappingMode, startAtom, endAtom };
}

function calculateDisplacementAtom(context, atom, vectors, offset) {
  const { referenceMapping, currentPositions, referencePositions, change, minimumImage, imageCell, inverse, heights, orthogonal } = context;
  const row = atom - (context.sourceRange?.startAtom ?? 0);
  const referenceAtom = referenceMapping[row];
  if (referenceAtom < 0) return false;
  for (let axis = 0; axis < 3; axis += 1) {
    change[axis] = currentPositions[row * 3 + axis] - referencePositions[(context.sourceRange ? row : referenceAtom) * 3 + axis];
    if (!Number.isFinite(change[axis])) throw new Error('Displacement requires finite atom coordinates.');
  }
  if (minimumImage) resolveMinimumImage(change, imageCell, inverse, heights, orthogonal);
  vectors[offset] = change[0]; vectors[offset + 1] = change[1]; vectors[offset + 2] = change[2];
  return true;
}

function hasGeneratedIds(frame) {
  return frame.idSource === 'row-order' || (frame.sourceFormat === 'cfg' && frame.idSource !== 'explicit');
}

function coordinateCount(frame) {
  const count = frame.fractional?.length / 3;
  if (!Number.isInteger(count) || count < 1 || (frame.ids && frame.ids.length !== count)) {
    throw new Error('Displacement coordinates or atom IDs do not match the atom count.');
  }
  return count;
}

function displacementPositions(frame, minimumImage, cacheDerivedPositions) {
  const count = coordinateCount(frame);
  let positions = !minimumImage && frame.unwrappedPositions ? frame.unwrappedPositions : frame.positions;
  if (!positions) {
    let derived = cacheDerivedPositions ? derivedCartesianPositions.get(frame) : null;
    if (!derived || derived.fractional !== frame.fractional || derived.cell !== frame.cell) {
      derived = { fractional: frame.fractional, cell: frame.cell,
        positions: fractionalToCartesian(frame.fractional, frame.cell, new Float64Array(count * 3)) };
      if (cacheDerivedPositions) derivedCartesianPositions.set(frame, derived);
    }
    positions = derived.positions;
  }
  if (positions.length !== count * 3) throw new Error('Displacement coordinates do not match the atom count.');
  return positions;
}

/** Return the shortest Cartesian image, including strongly skewed cells and
 * mixed periodic/open axes. Componentwise fractional rounding alone is wrong
 * when the basis vectors are not orthogonal. sourceRepetitions selects the
 * source lattice of a replicated wrapped frame (see imageLatticeCell).
 */
export function minimumImageDisplacement(displacement, cell, sourceRepetitions = null) {
  if (displacement?.length !== 3 || !Array.from(displacement).every(Number.isFinite)) {
    throw new Error('A displacement requires three finite Cartesian components.');
  }
  const result = Float64Array.from(displacement);
  const imageCell = imageLatticeCell(cell, sourceRepetitions);
  const orthogonal = orthogonalBasis(imageCell.vectors);
  resolveMinimumImage(result, imageCell, invert3(imageCell.vectors), orthogonal ? null : cellFaceHeights(imageCell), orthogonal);
  return result;
}

function orthogonalBasis(h) {
  return [[0, 3], [0, 6], [3, 6]].every(([a, b]) => h[a] * h[b] + h[a + 1] * h[b + 1] + h[a + 2] * h[b + 2] === 0);
}

function resolveMinimumImage(change, cell, inverse, heights, orthogonal) {
  const pbc = cell.pbc;
  if (!pbc[0] && !pbc[1] && !pbc[2]) return;
  let f0 = change[0] * inverse[0] + change[1] * inverse[3] + change[2] * inverse[6];
  let f1 = change[0] * inverse[1] + change[1] * inverse[4] + change[2] * inverse[7];
  let f2 = change[0] * inverse[2] + change[1] * inverse[5] + change[2] * inverse[8];
  const h = cell.vectors;
  // Orthogonal periodic components minimize independently. Keep Math.round
  // at half-cell ties and reconstruct from the same f64 fractional values.
  if (orthogonal) {
    if (pbc[0]) f0 -= Math.round(f0);
    if (pbc[1]) f1 -= Math.round(f1);
    if (pbc[2]) f2 -= Math.round(f2);
    change[0] = f0 * h[0] + f1 * h[3] + f2 * h[6];
    change[1] = f0 * h[1] + f1 * h[4] + f2 * h[7];
    change[2] = f0 * h[2] + f1 * h[5] + f2 * h[8];
    return;
  }
  if (![f0, f1, f2].every(Number.isFinite)) throw new Error('Displacement periodic-image coordinates are not finite.');
  let s0 = pbc[0] ? -Math.round(f0) : 0;
  let s1 = pbc[1] ? -Math.round(f1) : 0;
  let s2 = pbc[2] ? -Math.round(f2) : 0;
  if (![s0, s1, s2].every(Number.isSafeInteger)) throw new Error('Displacement periodic-image indices exceed the safe integer range.');
  let best = squaredImageLength(f0 + s0, f1 + s1, f2 + s2, h);
  const radius = Math.sqrt(best);
  if (!Number.isFinite(best) || !Number.isFinite(radius)) throw new Error('Displacement periodic-image distance is not finite.');
  // Face heights bound every candidate that can improve the initial image.
  // Retain a/b/c traversal and strict improvement so equal-distance ties do
  // not change when these temporary arrays become scalar locals.
  const lo0 = pbc[0] ? Math.ceil(-radius / heights[0] - f0 - 1e-12) : 0;
  const hi0 = pbc[0] ? Math.floor(radius / heights[0] - f0 + 1e-12) : 0;
  const lo1 = pbc[1] ? Math.ceil(-radius / heights[1] - f1 - 1e-12) : 0;
  const hi1 = pbc[1] ? Math.floor(radius / heights[1] - f1 + 1e-12) : 0;
  const lo2 = pbc[2] ? Math.ceil(-radius / heights[2] - f2 - 1e-12) : 0;
  const hi2 = pbc[2] ? Math.floor(radius / heights[2] - f2 + 1e-12) : 0;
  if (![lo0, hi0, lo1, hi1, lo2, hi2].every(Number.isSafeInteger)) throw new Error('Displacement periodic-image bounds exceed the safe integer range.');
  const spans = [hi0 - lo0 + 1, hi1 - lo1 + 1, hi2 - lo2 + 1];
  const candidates = spans[0] * spans[1] * spans[2];
  if (spans.some(span => span < 0 || span > MAX_IMAGE_CANDIDATES) || !Number.isFinite(candidates) || candidates > MAX_IMAGE_CANDIDATES) {
    throw new Error('The cell is too thin to resolve displacement periodic images.');
  }
  for (let a = lo0; a <= hi0; a += 1) for (let b = lo1; b <= hi1; b += 1) for (let c = lo2; c <= hi2; c += 1) {
    const distance = squaredImageLength(f0 + a, f1 + b, f2 + c, h);
    if (distance < best) { best = distance; s0 = a; s1 = b; s2 = c; }
  }
  change[0] = (f0 + s0) * h[0] + (f1 + s1) * h[3] + (f2 + s2) * h[6];
  change[1] = (f0 + s0) * h[1] + (f1 + s1) * h[4] + (f2 + s2) * h[7];
  change[2] = (f0 + s0) * h[2] + (f1 + s1) * h[5] + (f2 + s2) * h[8];
}

function squaredImageLength(a, b, c, h) {
  return (a * h[0] + b * h[3] + c * h[6]) ** 2
    + (a * h[1] + b * h[4] + c * h[7]) ** 2 + (a * h[2] + b * h[5] + c * h[8]) ** 2;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Displacement cancelled.', 'AbortError');
}

