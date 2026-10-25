import { invert3 } from '../data/model.js';
import { createFrameSummaryAccumulator, includeFrameSummaryAtom } from '../data/frame-summary.js';
import { PARSER_CHECKPOINT_MASK } from './cooperative-parser.js';

// Parser-only counterparts of the model/summary passes. Keep their arithmetic
// order and Float32 storage identical; checkpoints add no numeric operations.
export function* fractionalToCartesianSteps(fractional, cell, output = new Float32Array(fractional.length)) {
  const { origin, vectors } = cell;
  for (let atom = 0; atom < fractional.length / 3; atom++) {
    if ((atom & PARSER_CHECKPOINT_MASK) === 0) yield;
    const index = atom * 3, a = fractional[index], b = fractional[index + 1], c = fractional[index + 2];
    output[index] = origin[0] + a * vectors[0] + b * vectors[3] + c * vectors[6];
    output[index + 1] = origin[1] + a * vectors[1] + b * vectors[4] + c * vectors[7];
    output[index + 2] = origin[2] + a * vectors[2] + b * vectors[5] + c * vectors[8];
  }
  return output;
}

export function* cartesianToFractionalSteps(positions, cell, output = new Float32Array(positions.length)) {
  const inverse = invert3(cell.vectors), { origin } = cell;
  for (let atom = 0; atom < positions.length / 3; atom++) {
    if ((atom & PARSER_CHECKPOINT_MASK) === 0) yield;
    const index = atom * 3, x = positions[index] - origin[0], y = positions[index + 1] - origin[1], z = positions[index + 2] - origin[2];
    output[index] = x * inverse[0] + y * inverse[3] + z * inverse[6];
    output[index + 1] = x * inverse[1] + y * inverse[4] + z * inverse[7];
    output[index + 2] = x * inverse[2] + y * inverse[5] + z * inverse[8];
  }
  return output;
}

export function* wrapFractionalSteps(fractional, pbc, output = new Float32Array(fractional.length)) {
  if (pbc.length !== 3) throw new Error('Internal error: PBC flags must contain three axes.');
  for (let index = 0; index < fractional.length; index++) {
    if ((index & PARSER_CHECKPOINT_MASK) === 0) yield;
    const value = fractional[index];
    output[index] = pbc[index % 3] ? value - Math.floor(value) : value;
  }
  return output;
}

export function* collectFrameSummarySteps(types, positions, typeCount) {
  const summary = createFrameSummaryAccumulator(typeCount);
  for (let atom = 0; atom < types.length; atom++) {
    if ((atom & PARSER_CHECKPOINT_MASK) === 0) yield;
    includeFrameSummaryAtom(summary, types[atom], positions, atom * 3);
  }
  return summary;
}

export function* fractionalToCartesianSummarySteps(fractional, cell, types, typeCount) {
  const positions = new Float32Array(fractional.length), summary = createFrameSummaryAccumulator(typeCount);
  const { origin, vectors } = cell;
  for (let atom = 0; atom < types.length; atom++) {
    if ((atom & PARSER_CHECKPOINT_MASK) === 0) yield;
    const offset = atom * 3, a = fractional[offset], b = fractional[offset + 1], c = fractional[offset + 2];
    positions[offset] = origin[0] + a * vectors[0] + b * vectors[3] + c * vectors[6];
    positions[offset + 1] = origin[1] + a * vectors[1] + b * vectors[4] + c * vectors[7];
    positions[offset + 2] = origin[2] + a * vectors[2] + b * vectors[5] + c * vectors[8];
    includeFrameSummaryAtom(summary, types[atom], positions, offset);
  }
  return { positions, summary };
}

export function* someParserValues(values, test) {
  for (let index = 0; index < values.length; index++) {
    if ((index & PARSER_CHECKPOINT_MASK) === 0) yield;
    if (test(values[index], index)) return true;
  }
  return false;
}
