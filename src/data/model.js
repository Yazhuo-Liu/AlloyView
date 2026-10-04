const EPSILON = 1e-12;

export function determinant3(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

export function invert3(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant = determinant3(matrix);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < EPSILON) {
    throw new Error('The cell matrix is singular (its volume is zero or nearly zero).');
  }
  const inverseDeterminant = 1 / determinant;
  return new Float64Array([
    (e * i - f * h) * inverseDeterminant,
    (c * h - b * i) * inverseDeterminant,
    (b * f - c * e) * inverseDeterminant,
    (f * g - d * i) * inverseDeterminant,
    (a * i - c * g) * inverseDeterminant,
    (c * d - a * f) * inverseDeterminant,
    (d * h - e * g) * inverseDeterminant,
    (b * g - a * h) * inverseDeterminant,
    (a * e - b * d) * inverseDeterminant,
  ]);
}

export function multiply3(left, right) {
  const output = new Float64Array(9);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      output[row * 3 + column] =
        left[row * 3] * right[column]
        + left[row * 3 + 1] * right[3 + column]
        + left[row * 3 + 2] * right[6 + column];
    }
  }
  return output;
}

export function fractionalToCartesian(fractional, cell, output = new Float32Array(fractional.length)) {
  const { origin, vectors } = cell;
  for (let atom = 0; atom < fractional.length / 3; atom += 1) {
    const index = atom * 3;
    const a = fractional[index];
    const b = fractional[index + 1];
    const c = fractional[index + 2];
    output[index] = origin[0] + a * vectors[0] + b * vectors[3] + c * vectors[6];
    output[index + 1] = origin[1] + a * vectors[1] + b * vectors[4] + c * vectors[7];
    output[index + 2] = origin[2] + a * vectors[2] + b * vectors[5] + c * vectors[8];
  }
  return output;
}

export function cartesianToFractional(positions, cell, output = new Float32Array(positions.length)) {
  const inverse = invert3(cell.vectors);
  const { origin } = cell;
  for (let atom = 0; atom < positions.length / 3; atom += 1) {
    const index = atom * 3;
    const x = positions[index] - origin[0];
    const y = positions[index + 1] - origin[1];
    const z = positions[index + 2] - origin[2];
    output[index] = x * inverse[0] + y * inverse[3] + z * inverse[6];
    output[index + 1] = x * inverse[1] + y * inverse[4] + z * inverse[7];
    output[index + 2] = x * inverse[2] + y * inverse[5] + z * inverse[8];
  }
  return output;
}

export function wrapFractional(fractional, pbc, output = new Float32Array(fractional.length)) {
  if (pbc.length !== 3) throw new Error('Internal error: PBC flags must contain three axes.');
  for (let index = 0; index < fractional.length; index += 1) {
    const value = fractional[index];
    output[index] = pbc[index % 3] ? value - Math.floor(value) : value;
  }
  return output;
}

export function cellVertices(cell) {
  const { origin: o, vectors: h } = cell;
  const vertices = new Float32Array(8 * 3);
  let cursor = 0;
  for (let mask = 0; mask < 8; mask += 1) {
    const a = mask & 1 ? 1 : 0;
    const b = mask & 2 ? 1 : 0;
    const c = mask & 4 ? 1 : 0;
    vertices[cursor] = o[0] + a * h[0] + b * h[3] + c * h[6];
    vertices[cursor + 1] = o[1] + a * h[1] + b * h[4] + c * h[7];
    vertices[cursor + 2] = o[2] + a * h[2] + b * h[5] + c * h[8];
    cursor += 3;
  }
  return vertices;
}

export function cellFaceHeights(cell) {
  const h = cell.vectors;
  const a = [h[0], h[1], h[2]];
  const b = [h[3], h[4], h[5]];
  const c = [h[6], h[7], h[8]];
  const volume = Math.abs(determinant3(h));
  if (volume < EPSILON) throw new Error('Cannot build neighbor bins for a zero-volume cell.');
  return new Float64Array([
    volume / vectorLength(cross(b, c)),
    volume / vectorLength(cross(c, a)),
    volume / vectorLength(cross(a, b)),
  ]);
}

export function createCell({ origin = [0, 0, 0], vectors, pbc = [true, true, true], triclinic = false }) {
  const normalized = {
    origin: Float64Array.from(origin),
    vectors: Float64Array.from(vectors),
    pbc: Array.from(pbc, Boolean),
    triclinic: Boolean(triclinic),
  };
  if (normalized.origin.length !== 3 || normalized.vectors.length !== 9 || normalized.pbc.length !== 3) {
    throw new Error('Internal error: a cell requires 3 origin values, 9 matrix values, and 3 PBC flags.');
  }
  if (Math.abs(determinant3(normalized.vectors)) < EPSILON) {
    throw new Error('The cell has zero volume and cannot be displayed or analyzed.');
  }
  return normalized;
}

export function validateFrame(frame) {
  const count = frame.ids?.length ?? 0;
  if (!Number.isInteger(count) || count <= 0) throw new Error('The structure contains no atoms.');
  if (frame.types.length !== count) throw new Error('The atom type array length does not match the atom count.');
  if (frame.positions.length !== count * 3 || frame.fractional.length !== count * 3) {
    throw new Error('The coordinate array length does not match the atom count.');
  }
  if (frame.unwrappedPositions && frame.unwrappedPositions.length !== count * 3) {
    throw new Error('The unwrapped coordinate array length does not match the atom count.');
  }
  if (frame.imageFlags && frame.imageFlags.length !== count * 3) {
    throw new Error('The image flag array length does not match the atom count.');
  }
  for (const property of frame.properties) {
    if (property.data.length !== count) throw new Error(`Per-atom property ${property.name} has an invalid length.`);
  }
  return frame;
}

export function frameTransferables(frame) {
  const transferables = [
    frame.types.buffer,
    frame.positions.buffer,
    frame.fractional.buffer,
    frame.cell.origin.buffer,
    frame.cell.vectors.buffer,
  ];
  if (ArrayBuffer.isView(frame.ids)) transferables.push(frame.ids.buffer);
  if (frame.unwrappedPositions) transferables.push(frame.unwrappedPositions.buffer);
  if (frame.imageFlags) transferables.push(frame.imageFlags.buffer);
  for (const property of frame.properties) if (ArrayBuffer.isView(property.data)) transferables.push(property.data.buffer);
  return [...new Set(transferables)];
}

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function vectorLength(vector) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}
