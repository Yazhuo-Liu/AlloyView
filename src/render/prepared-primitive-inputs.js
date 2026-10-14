// These descriptors belong to one explicitly prepared display snapshot. They
// share CPU rows between views, never textures, GL buffers, or mutable styling.
// A new public coordinate setter creates a new descriptor even if its arrays
// were edited in place. There is no identity cache spanning source frames.
const coordinatePreparations = new WeakSet();
const coordinateTokens = new WeakMap();
const coordinateRowsRelease = new WeakMap();
const bondPreparations = new WeakSet();
const bondShiftsRelease = new WeakMap();
const revokedCoordinates = new WeakSet();
const revokedBonds = new WeakSet();

function cellSignature(cell) {
  return Object.freeze([
    ...cell.vectors, ...cell.origin, ...cell.pbc, Boolean(cell.triclinic),
  ]);
}

function sameCell(signature, cell) {
  if (!cell || cell.vectors?.length !== 9 || cell.origin?.length !== 3 || cell.pbc?.length !== 3) return false;
  for (let i = 0; i < 9; i++) if (!Object.is(signature[i], cell.vectors[i])) return false;
  for (let i = 0; i < 3; i++) {
    if (!Object.is(signature[9 + i], cell.origin[i]) || signature[12 + i] !== cell.pbc[i]) return false;
  }
  return signature[15] === Boolean(cell.triclinic);
}

export function createPrimitivePreparation({ frame, positions, fractional, periodicOrigin = [0, 0, 0],
  coordinateMode = 'wrapped', displayRevision }) {
  if (!frame?.cell || !ArrayBuffer.isView(positions) || !ArrayBuffer.isView(fractional)
    || positions.length !== fractional.length || positions.length % 3
    || periodicOrigin.length !== 3) throw new Error('Invalid primitive coordinate preparation.');
  const count = positions.length / 3, signature = cellSignature(frame.cell);
  const origin = Object.freeze(Array.from(periodicOrigin));
  let rows = null;
  const preparation = Object.freeze({
    frame, positions, fractional, count, periodicOrigin: origin, coordinateMode, displayRevision,
    get byteLength() { return rows?.byteLength ?? 0; },
    matches(renderer) {
      const current = renderer.preparedPrimitivePreparation ?? renderer.preparedDisplaySnapshot?.primitivePreparation;
      return !revokedCoordinates.has(preparation) && current === preparation && renderer.frame === frame && renderer.atomCount === count
        && positions.length === count * 3 && fractional.length === count * 3
        && renderer.displayPositions === positions
        && (renderer.displayFractional ?? renderer.frame.fractional) === fractional
        && (renderer.coordinateMode ?? 'wrapped') === coordinateMode
        && (renderer.periodicOrigin ?? [0, 0, 0]).every((value, axis) => Object.is(value, origin[axis]))
        && sameCell(signature, renderer.frame.cell);
    },
    textureRows(width, height) {
      if (revokedCoordinates.has(preparation)) throw new Error('The primitive coordinate preparation is obsolete.');
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
        || !Number.isSafeInteger(width * height) || width * height < count) {
        throw new Error('Invalid primitive texture dimensions.');
      }
      if (rows?.width === width && rows.height === height) return rows;
      // Keep one active layout. Contexts with different texture limits can
      // retain their own current rows without creating an unbounded map here.
      const positionValues = new Float32Array(width * height * 4);
      const fractionalValues = new Float32Array(width * height * 4);
      for (let atom = 0; atom < count; atom++) {
        const source = atom * 3, target = atom * 4;
        positionValues[target] = positions[source];
        positionValues[target + 1] = positions[source + 1];
        positionValues[target + 2] = positions[source + 2];
        fractionalValues[target] = fractional[source];
        fractionalValues[target + 1] = fractional[source + 1];
        fractionalValues[target + 2] = fractional[source + 2];
      }
      rows = Object.freeze({ width, height, positionValues, fractionalValues,
        byteLength: positionValues.byteLength + fractionalValues.byteLength });
      return rows;
    },
  });
  coordinatePreparations.add(preparation);
  coordinateTokens.set(preparation, Symbol('primitive-coordinate-revision'));
  coordinateRowsRelease.set(preparation, () => { rows = null; });
  return preparation;
}

export function revokePrimitivePreparation(preparation) {
  if (coordinatePreparations.has(preparation)) {
    revokedCoordinates.add(preparation);
    releasePrimitivePreparationRows(preparation);
  }
}

export function releasePrimitivePreparationRows(preparation) {
  coordinateRowsRelease.get(preparation)?.();
}

export function preparedPrimitiveRows(renderer, width, height) {
  const preparation = renderer.preparedPrimitivePreparation ?? renderer.preparedDisplaySnapshot?.primitivePreparation;
  if (!coordinatePreparations.has(preparation) || !preparation.matches(renderer)) return null;
  return preparation.textureRows(width, height);
}

export function createPrimitiveBondPreparation({ frame, bonds, bondRevision }) {
  const signature = cellSignature(frame.cell);
  let coordinateToken = null, shifts = null;
  const preparation = Object.freeze({
    frame, bonds, bondRevision,
    get byteLength() { return shifts?.byteLength ?? 0; },
    matches(renderer, result, beforeAssignment = false) {
      return !revokedBonds.has(preparation) && (beforeAssignment || renderer.preparedBondSnapshot === preparation)
        && renderer.frame === frame
        && result.count === bonds.count && result.indices === bonds.indices && result.vectors === bonds.vectors
        && result.shifts === bonds.shifts && sameCell(signature, renderer.frame.cell);
    },
    displayShifts(geometry, calculate) {
      if (revokedBonds.has(preparation) || !coordinatePreparations.has(geometry)
        || revokedCoordinates.has(geometry) || geometry.frame !== frame) return null;
      const token = coordinateTokens.get(geometry);
      if (coordinateToken !== token) {
        shifts = calculate(bonds, frame, geometry.positions);
        // Retain only a provenance token, not the preceding origin's entire
        // coordinate snapshot and packed rows when bonds remain hidden.
        coordinateToken = token;
      }
      return shifts;
    },
  });
  bondPreparations.add(preparation);
  bondShiftsRelease.set(preparation, () => { coordinateToken = shifts = null; });
  return preparation;
}

export function revokePrimitiveBondPreparation(preparation) {
  if (bondPreparations.has(preparation)) {
    revokedBonds.add(preparation);
    releasePrimitiveBondPreparationShifts(preparation);
  }
}

export function releasePrimitiveBondPreparationShifts(preparation) {
  bondShiftsRelease.get(preparation)?.();
}

export function validatePrimitiveBondPreparation(preparation, renderer, bonds) {
  if (!bondPreparations.has(preparation) || !bonds || !preparation.matches(renderer, bonds, true)) {
    throw new Error('The prepared bond snapshot does not match the current bonds or cell.');
  }
  return preparation;
}

export function preparedPrimitiveBondShifts(renderer, bonds, calculate) {
  const geometry = renderer.preparedPrimitivePreparation ?? renderer.preparedDisplaySnapshot?.primitivePreparation;
  const preparation = renderer.preparedBondSnapshot;
  if (!coordinatePreparations.has(geometry) || !geometry.matches(renderer)
    || !bondPreparations.has(preparation) || !preparation.matches(renderer, bonds)) return null;
  return preparation.displayShifts(geometry, calculate);
}
