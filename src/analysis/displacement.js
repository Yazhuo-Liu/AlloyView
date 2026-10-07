import { cellFaceHeights, fractionalToCartesian, invert3 } from '../data/model.js';
import { createReferenceMappingAsync } from './reference-strain.js';
import { yieldToMain } from '../task-yield.js';

const MAX_IMAGE_CANDIDATES = 100_000;
const derivedCartesianPositions = new WeakMap();

/** Cartesian current − reference displacement, matched by explicit atom IDs.
 * When both frames have generated row IDs, equal atom counts permit a row-order
 * fallback. This assumes the source keeps atom order stable between frames.
 * Cell deformation and origin changes contribute to displacement: no affine
 * cell remapping is applied. Minimum images use the current triclinic metric.
 * Unmatched current atoms remain NaN; they do not produce arrow fragments.
 * Disable minimumImage when trajectory coordinates have already been unwrapped.
 */
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
    referenceMapping, currentPositions, referencePositions, minimumImage, mappingMode };
}

/** Reusable double-precision geometry for CPU worker ranges and sparse GPU
 * image corrections. Matching is already complete when this helper runs.
 */
export function prepareDisplacementCalculation(frame, parameters) {
  const { referenceMapping, currentPositions, referencePositions, minimumImage = true, mappingMode = 'id' } = parameters;
  if (typeof minimumImage !== 'boolean') throw new Error('The displacement minimum-image option must be a boolean.');
  const count = coordinateCount(frame), referenceCount = referencePositions?.length / 3;
  if (!(referenceMapping instanceof Int32Array) || referenceMapping.length !== count
    || currentPositions?.length !== count * 3 || !Number.isInteger(referenceCount) || referenceCount < 1) {
    throw new Error('Displacement coordinates or atom mapping are incomplete.');
  }
  if (mappingMode !== 'id' && mappingMode !== 'row-order') throw new Error('The displacement mapping mode is invalid.');
  for (const atom of referenceMapping) if (atom < -1 || atom >= referenceCount) throw new Error('Displacement mapping is outside the reference frame.');
  const inverse = minimumImage ? invert3(frame.cell.vectors) : null;
  const orthogonal = minimumImage && orthogonalBasis(frame.cell.vectors);
  const heights = minimumImage && !orthogonal ? cellFaceHeights(frame.cell) : null;
  return { frame, referenceMapping, currentPositions, referencePositions, minimumImage, mappingMode,
    inverse, orthogonal, heights, change: new Float64Array(3) };
}

/** Synchronous atom ranges run inside CPU workers without repeating ID maps. */
export function calculatePreparedDisplacements(frame, parameters, { signal, onProgress = () => {} } = {}) {
  const context = parameters.preparedContext ?? prepareDisplacementCalculation(frame, parameters);
  if (context.frame !== frame || context.referenceMapping !== parameters.referenceMapping
    || context.currentPositions !== parameters.currentPositions || context.referencePositions !== parameters.referencePositions
    || context.minimumImage !== (parameters.minimumImage ?? true)) throw new Error('The prepared displacement context does not match these inputs.');
  const count = context.referenceMapping.length;
  const startAtom = parameters.startAtom ?? 0, endAtom = parameters.endAtom ?? count;
  if (!Number.isInteger(startAtom) || !Number.isInteger(endAtom) || startAtom < 0 || endAtom > count || endAtom < startAtom) {
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
      const components = vectors.subarray(index * 3, index * 3 + 3);
      magnitudes[index] = components.every(Number.isFinite) ? Math.hypot(...components) : NaN;
    }
    if ((index + 1) % 2048 === 0) onProgress({ phase: 'displacement', completed: index + 1, total: endAtom - startAtom });
  }
  throwIfAborted(signal);
  onProgress({ phase: 'displacement', completed: endAtom - startAtom, total: endAtom - startAtom });
  return { vectors, magnitudes, matched, unmatched: endAtom - startAtom - matched, referenceMapping: context.referenceMapping,
    minimumImage: context.minimumImage, mappingMode: context.mappingMode, startAtom, endAtom };
}

function calculateDisplacementAtom(context, atom, vectors, offset) {
  const { referenceMapping, currentPositions, referencePositions, change, minimumImage, frame, inverse, heights, orthogonal } = context;
  const referenceAtom = referenceMapping[atom];
  if (referenceAtom < 0) return false;
  for (let axis = 0; axis < 3; axis += 1) {
    change[axis] = currentPositions[atom * 3 + axis] - referencePositions[referenceAtom * 3 + axis];
    if (!Number.isFinite(change[axis])) throw new Error('Displacement requires finite atom coordinates.');
  }
  if (minimumImage) resolveMinimumImage(change, frame.cell, inverse, heights, orthogonal);
  vectors.set(change, offset);
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
 * when the basis vectors are not orthogonal.
 */
export function minimumImageDisplacement(displacement, cell) {
  if (displacement?.length !== 3 || !Array.from(displacement).every(Number.isFinite)) {
    throw new Error('A displacement requires three finite Cartesian components.');
  }
  const result = Float64Array.from(displacement);
  const orthogonal = orthogonalBasis(cell.vectors);
  resolveMinimumImage(result, cell, invert3(cell.vectors), orthogonal ? null : cellFaceHeights(cell), orthogonal);
  return result;
}

function orthogonalBasis(h) {
  return [[0, 3], [0, 6], [3, 6]].every(([a, b]) => h[a] * h[b] + h[a + 1] * h[b + 1] + h[a + 2] * h[b + 2] === 0);
}

function resolveMinimumImage(change, cell, inverse, heights, orthogonal) {
  if (!cell.pbc.some(Boolean)) return;
  const fractional = [0, 1, 2].map(axis => change[0] * inverse[axis]
    + change[1] * inverse[3 + axis] + change[2] * inverse[6 + axis]);
  const h = cell.vectors;
  // In an orthogonal metric each periodic component minimizes independently.
  // This common case avoids a candidate lattice-image search for every atom.
  if (orthogonal) {
    for (let axis = 0; axis < 3; axis += 1) if (cell.pbc[axis]) fractional[axis] -= Math.round(fractional[axis]);
    for (let axis = 0; axis < 3; axis += 1) change[axis] = fractional[0] * h[axis]
      + fractional[1] * h[3 + axis] + fractional[2] * h[6 + axis];
    return;
  }
  const shifts = fractional.map((value, axis) => cell.pbc[axis] ? -Math.round(value) : 0);
  const squaredLength = (a, b, c) => (a * h[0] + b * h[3] + c * h[6]) ** 2
    + (a * h[1] + b * h[4] + c * h[7]) ** 2 + (a * h[2] + b * h[5] + c * h[8]) ** 2;
  let best = squaredLength(...fractional.map((value, axis) => value + shifts[axis]));
  const radius = Math.sqrt(best);
  // A vector's fractional component cannot exceed its length divided by that
  // cell's face height. This bounds all images that could beat the initial one.
  const bounds = fractional.map((value, axis) => cell.pbc[axis]
    ? [Math.ceil(-radius / heights[axis] - value - 1e-12), Math.floor(radius / heights[axis] - value + 1e-12)] : [0, 0]);
  if (bounds.reduce((budget, [lo, hi]) => budget * (hi - lo + 1), 1) > MAX_IMAGE_CANDIDATES) {
    throw new Error('The cell is too thin to resolve displacement periodic images.');
  }
  for (let a = bounds[0][0]; a <= bounds[0][1]; a += 1) {
    for (let b = bounds[1][0]; b <= bounds[1][1]; b += 1) {
      for (let c = bounds[2][0]; c <= bounds[2][1]; c += 1) {
        const distance = squaredLength(fractional[0] + a, fractional[1] + b, fractional[2] + c);
        if (distance < best) { best = distance; shifts[0] = a; shifts[1] = b; shifts[2] = c; }
      }
    }
  }
  for (let axis = 0; axis < 3; axis += 1) change[axis] = (fractional[0] + shifts[0]) * h[axis]
    + (fractional[1] + shifts[1]) * h[3 + axis] + (fractional[2] + shifts[2]) * h[6 + axis];
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Displacement cancelled.', 'AbortError');
}

