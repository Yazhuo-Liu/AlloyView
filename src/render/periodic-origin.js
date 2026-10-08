import { cartesianToFractional, fractionalToCartesian } from '../data/model.js';

/** Fractional display origin; this never changes the scientific cell origin. */
export function normalizePeriodicOrigin(origin = [0, 0, 0]) {
  if ((!Array.isArray(origin) && !ArrayBuffer.isView(origin)) || origin.length !== 3
      || !Array.from(origin).every(Number.isFinite)) {
    throw new Error('Periodic display origin requires three finite fractional coordinates.');
  }
  return Array.from(origin);
}

export function effectivePeriodicOrigin(origin, cell) {
  return normalizePeriodicOrigin(origin).map((value, axis) => cell.pbc[axis] ? value : 0);
}

/** Translate a continuous curve before cutting it at periodic boundaries.
 * Wrapping each individual knot would create artificial cell-spanning edges.
 */
export function translatePeriodicPoints(positions, cell, origin = [0, 0, 0]) {
  const offset = effectivePeriodicOrigin(origin, cell);
  if (offset.every(value => value === 0)) return positions;
  const vectors = cell.vectors;
  const shift = [0, 1, 2].map(axis => offset[0] * vectors[axis] + offset[1] * vectors[3 + axis] + offset[2] * vectors[6 + axis]);
  if (!shift.every(Number.isFinite)) throw new Error('Periodic display translation must remain finite.');
  const translated = new Float64Array(positions.length);
  for (let index = 0; index < positions.length; index += 1) translated[index] = positions[index] - shift[index % 3];
  return translated;
}

/** Return independent display arrays while retaining the source coordinates.
 * Only periodic axes move; open directions retain their fractional coordinate.
 */
export function periodicDisplayCoordinates(positions, cell, origin = [0, 0, 0], { wrap = true } = {}) {
  const offset = effectivePeriodicOrigin(origin, cell);
  const fractional = cartesianToFractional(positions, cell, new Float64Array(positions.length));
  for (let index = 0; index < fractional.length; index += 1) {
    const axis = index % 3;
    if (!cell.pbc[axis]) continue;
    const value = fractional[index] - offset[axis];
    fractional[index] = wrap ? value - Math.floor(value) : value;
  }
  const displayPositions = wrap
    ? fractionalToCartesian(fractional, cell, new Float64Array(positions.length))
    : translatePeriodicPoints(positions, cell, offset);
  return { positions: displayPositions, fractional };
}
