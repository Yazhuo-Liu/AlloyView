import { analysisValidationError } from '../errors.js';

// Constant-size identity checks. An indexed trajectory frame is immutable for
// one geometryRevision, including when it is reparsed after CPU cache eviction.
// In-place edits of coordinate/type arrays must increment geometryRevision or
// call invalidateFrame(); reading millions of values before every GPU job would
// defeat resident-input reuse. Weak snapshots do not retain evicted CPU frames.
export function gpuFrameSnapshot(frame) {
  const revision = frame.geometryRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw analysisValidationError(new Error('GPU geometryRevision must be a nonnegative safe integer.'));
  }
  const cell = frame.cell;
  const values = [revision, frame.fractional?.length, frame.types?.length, frame.positions?.length, frame.unwrappedPositions?.length, cell?.triclinic];
  for (let index = 0; index < 9; index++) values.push(cell?.vectors?.[index]);
  for (let index = 0; index < 3; index++) values.push(cell?.origin?.[index] ?? 0);
  for (let index = 0; index < 3; index++) values.push(cell?.pbc?.[index]);
  return { values, fractional: frame.fractional, types: frame.types,
    positions: frame.positions, unwrappedPositions: frame.unwrappedPositions,
    typeLabels: frame.typeLabels };
}

export function sameGpuFrameMetadata(left, right) {
  return left.values.every((value, index) => Object.is(value, right.values[index]));
}

export function sameGpuFrameArrays(left, right) {
  return left.fractional === right.fractional && left.types === right.types
    && left.positions === right.positions && left.unwrappedPositions === right.unwrappedPositions
    && left.typeLabels === right.typeLabels;
}
