import { dot } from './math.js';
import { MIN_SLICE_LENGTH, millerPlane, validateSliceLength } from './slicing.js';

/** Prefer open cell directions; fully periodic or unspecified cells let the
 * user trim any direction, including a surface separated by periodic vacuum. */
export function boundarySliceAxes(cell) {
  const axes = [0, 1, 2].map(axis => cell?.pbc?.[axis] === false);
  return axes.some(Boolean) ? axes : [true, true, true];
}

/** Build ordinary editable slabs that trim a physical distance from both
 * outer faces of each chosen cell direction. Atom bounds use all displayed
 * source coordinates, independent of visibility or existing slices. Replicas
 * extend the outer bounds analytically; their internal seams are not trimmed.
 * Nothing is published or mutated if any requested direction cannot fit. */
export function createBoundarySlices({ cell, positions, repetitions = [1, 1, 1] } = {}, {
  thickness, axes = [true, true, true], reference = 'atoms',
} = {}) {
  validateSliceLength(thickness, 'boundary trim thickness');
  if (!['atoms', 'cell'].includes(reference)) throw new Error('Choose atom bounds or cell faces for boundary trimming.');
  if (!axes || axes.length !== 3 || !Array.from(axes).every(value => typeof value === 'boolean') || !axes.some(Boolean)) {
    throw new Error('Choose at least one cell direction for boundary trimming.');
  }
  if (!cell?.vectors || cell.vectors.length !== 9 || !Array.from(cell.vectors).every(Number.isFinite)
    || !cell.origin || cell.origin.length !== 3 || !Array.from(cell.origin).every(Number.isFinite)) {
    throw new Error('Boundary trimming requires a finite cell with three vectors and an origin.');
  }
  if (!repetitions || repetitions.length !== 3
    || !Array.from(repetitions).every(count => Number.isSafeInteger(count) && count >= 1)) {
    throw new Error('Boundary trimming requires three positive integer repeat counts.');
  }
  if (reference === 'atoms' || positions !== undefined) {
    if (!positions || !Number.isSafeInteger(positions.length) || !positions.length || positions.length % 3) {
      throw new Error('Boundary trimming requires complete atom coordinates.');
    }
    for (let index = 0; index < positions.length; index++) {
      if (!Number.isFinite(positions[index])) throw new Error('Boundary trimming requires finite atom coordinates.');
    }
  }
  const slices = [];
  for (let axis = 0; axis < 3; axis++) {
    if (!axes[axis]) continue;
    const { normal, spacing } = millerPlane([0, 1, 2].map(index => Number(index === axis)), cell.vectors);
    let lower, upper;
    if (reference === 'cell') {
      lower = dot(normal, cell.origin);
      upper = lower + spacing * repetitions[axis];
    } else {
      lower = Infinity; upper = -Infinity;
      for (let index = 0; index < positions.length; index += 3) {
        const projected = normal[0] * positions[index] + normal[1] * positions[index + 1] + normal[2] * positions[index + 2];
        lower = Math.min(lower, projected); upper = Math.max(upper, projected);
      }
      for (let replicaAxis = 0; replicaAxis < 3; replicaAxis++) {
        const offset = (repetitions[replicaAxis] - 1)
          * (normal[0] * cell.vectors[replicaAxis * 3] + normal[1] * cell.vectors[replicaAxis * 3 + 1]
            + normal[2] * cell.vectors[replicaAxis * 3 + 2]);
        lower += Math.min(0, offset); upper += Math.max(0, offset);
      }
    }
    const remaining = upper - lower - 2 * thickness;
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(remaining)) {
      throw new Error('The boundary extent is not finite.');
    }
    if (remaining < MIN_SLICE_LENGTH) {
      throw new Error(`The boundary trim thickness leaves no slab in direction ${'abc'[axis]}. Choose a smaller thickness.`);
    }
    validateSliceLength(remaining, 'remaining boundary slab thickness');
    slices.push({ normal, position: lower / 2 + upper / 2, side: 'negative', slab: true,
      thickness: remaining, name: `Boundary ${'abc'[axis]} · ${thickness} Å`, showGizmo: false });
  }
  return slices;
}
