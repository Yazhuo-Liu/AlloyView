import { fractionalToCartesian } from './model.js';

/** Ordinary display follows the coordinates written in the source. Parsed
 * image counters are metadata until the user requests continuous positions. */
export function fileDisplayPositions(frame) {
  return frame?.filePositions ?? frame?.positions ?? null;
}

/** A source can supply continuous positions without reading another frame.
 * A boundary-rounding correction in filePositions alone is not crossing data. */
export function hasFileUnwrap(frame) {
  return Boolean(frame?.unwrappedPositions || frame?.imageFlags
    || (frame?.filePositions && frame?.unwrapSource === 'out-of-cell CFG coordinates'));
}

/** Materialize a single frame's authoritative coordinates on explicit demand.
 * This helper never reads a trajectory or infers a boundary crossing. */
export function ensureFileUnwrappedPositions(frame) {
  if (!frame || frame.unwrappedPositions) return frame?.unwrappedPositions ?? null;
  if (frame.filePositions && frame.unwrapSource === 'out-of-cell CFG coordinates') {
    frame.unwrappedPositions = frame.filePositions;
    return frame.unwrappedPositions;
  }
  if (!frame.imageFlags) return null;
  if (frame.imageFlags.length !== frame.fractional?.length) {
    throw new Error('Image flags do not match the frame coordinates.');
  }
  const continuous = Float64Array.from(frame.fractional, (value, index) => value + (frame.cell.pbc[index % 3] ? frame.imageFlags[index] : 0));
  frame.unwrappedPositions = fractionalToCartesian(continuous, frame.cell);
  return frame.unwrappedPositions;
}
