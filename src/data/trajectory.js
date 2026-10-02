import { cartesianToFractional, fractionalToCartesian } from './model.js';

export function prepareSequenceBaseline(frame) {
  if (frame.idSource !== 'explicit') {
    throw new Error('A multi-CFG sequence requires an explicit per-atom id auxiliary so atoms can be matched safely between images.');
  }
  if (!frame.unwrappedPositions) {
    frame.unwrappedPositions = Float32Array.from(frame.positions);
    frame.imageFlags = new Int32Array(frame.ids.length * 3);
    frame.unwrapSource = 'sequence baseline';
  }
  return continuityState(frame, 0);
}

export function unwrapSequenceFrame(frame, previousState, index) {
  if (!previousState) throw new Error('Cannot unwrap a sequence frame without a preceding reference state.');
  if (frame.ids.length !== previousState.ids.length) {
    throw new Error(`CFG sequence frame ${index + 1} has ${frame.ids.length} atoms; expected ${previousState.ids.length}.`);
  }

  // Explicit image flags or out-of-cell CFG coordinates are authoritative.
  if (frame.unwrappedPositions) return continuityState(frame, index);

  const previousById = new Map();
  for (let atom = 0; atom < previousState.ids.length; atom += 1) {
    previousById.set(previousState.ids[atom], atom);
  }
  const unwrappedFractional = new Float64Array(frame.fractional.length);
  const imageFlags = new Int32Array(frame.fractional.length);
  for (let atom = 0; atom < frame.ids.length; atom += 1) {
    const previousAtom = previousById.get(frame.ids[atom]);
    if (previousAtom === undefined) {
      throw new Error(`CFG sequence frame ${index + 1} contains atom ID ${frame.ids[atom]}, which is absent from the preceding image.`);
    }
    for (let axis = 0; axis < 3; axis += 1) {
      const currentOffset = atom * 3 + axis;
      const previousOffset = previousAtom * 3 + axis;
      const current = frame.fractional[currentOffset];
      let displacement = current - previousState.wrappedFractional[previousOffset];
      if (frame.cell.pbc[axis]) displacement -= Math.round(displacement);
      const value = previousState.unwrappedFractional[previousOffset] + displacement;
      unwrappedFractional[currentOffset] = value;
      const image = Math.round(value - current);
      if (image < -2_147_483_648 || image > 2_147_483_647) {
        throw new Error(`CFG sequence frame ${index + 1} exceeds the supported image-flag range.`);
      }
      imageFlags[currentOffset] = image;
    }
  }
  frame.unwrappedPositions = fractionalToCartesian(unwrappedFractional, frame.cell);
  frame.imageFlags = imageFlags;
  frame.unwrapSource = 'sequence minimum-image inference';
  return continuityState(frame, index, unwrappedFractional);
}

function continuityState(frame, index, knownUnwrappedFractional = null) {
  let unwrappedFractional = knownUnwrappedFractional;
  if (!unwrappedFractional) {
    if (frame.imageFlags) {
      unwrappedFractional = Float64Array.from(
        frame.fractional,
        (value, offset) => value + frame.imageFlags[offset],
      );
    } else if (frame.unwrappedPositions) {
      unwrappedFractional = Float64Array.from(cartesianToFractional(frame.unwrappedPositions, frame.cell));
    } else {
      unwrappedFractional = Float64Array.from(frame.fractional);
    }
  }
  return {
    index,
    ids: Float64Array.from(frame.ids),
    wrappedFractional: Float32Array.from(frame.fractional),
    unwrappedFractional,
  };
}
