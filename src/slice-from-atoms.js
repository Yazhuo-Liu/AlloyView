import { cross, dot, subtract } from './render/math.js';
import { normalizeSliceNormal } from './render/slicing.js';

function point(value) {
  if (!value || value.length !== 3 || !Array.from(value).every(Number.isFinite)) {
    throw new TypeError('Pick atoms with three finite display coordinates.');
  }
  return Array.from(value);
}

function direction(first, second) {
  const difference = subtract(second, first);
  if (!difference.every(Number.isFinite) || Math.hypot(...difference) <= 1e-12) {
    throw new RangeError('Pick different atoms at distinct positions.');
  }
  return normalizeSliceNormal(difference);
}

function positionOnPlane(normal, value) {
  const position = dot(normal, value);
  if (!Number.isFinite(position)) throw new RangeError('The picked atom coordinates are too large to form a slice.');
  return position;
}

/** The perpendicular bisector keeps the second picked atom on its positive side. */
export function sliceBetweenAtoms(firstPoint, secondPoint) {
  const first = point(firstPoint), second = point(secondPoint);
  const normal = direction(first, second);
  const midpoint = first.map((component, axis) => component / 2 + second[axis] / 2);
  return { normal, position: positionOnPlane(normal, midpoint), side: 'positive' };
}

/** Pick order defines the right-hand normal: (second − first) × (third − first). */
export function sliceThroughAtoms(firstPoint, secondPoint, thirdPoint) {
  const first = point(firstPoint), second = point(secondPoint), third = point(thirdPoint);
  const normalCross = cross(direction(first, second), direction(first, third));
  if (Math.hypot(...normalCross) <= 1e-10) {
    throw new RangeError('Pick three distinct atoms that are not collinear.');
  }
  const normal = normalizeSliceNormal(normalCross);
  return { normal, position: positionOnPlane(normal, first), side: 'positive' };
}

/** Move a plane without changing its orientation, side, identity or display settings. */
export function sliceThroughAtom(slice, atomPoint) {
  const normal = normalizeSliceNormal(slice?.normal);
  return { ...slice, normal, position: positionOnPlane(normal, point(atomPoint)) };
}
