// Descriptors own only preparation metadata. Coordinate and radius arrays are
// read-only to consumers; explicit public setters are the mutation boundary.
// Revocation is private and does not retain the publishing renderer or frame.
const publications = new WeakMap();

/** Float32 vertex mirrors exist only while display preparation is shared.
 * Each context still uploads its own GL buffers. No mirror duplicates an
 * already-Float32 source, and an explicit setter creates a fresh instance. */
export function createPreparedDisplayUploads(positions, fractional) {
  let positionValues = null, fractionalValues = null;
  const convert = values => values instanceof Float32Array ? values : Float32Array.from(values);
  return Object.freeze({
    positions() { return positionValues ??= convert(positions); },
    fractional() { return fractionalValues ??= convert(fractional); },
    get byteLength() {
      return (positionValues && positionValues !== positions ? positionValues.byteLength : 0)
        + (fractionalValues && fractionalValues !== fractional ? fractionalValues.byteLength : 0);
    },
  });
}

function sameValues(left, right) {
  return left?.length === right?.length && Array.from(left).every((value, index) => Object.is(value, right[index]));
}

export function createPreparedDisplay(values) {
  const cell = values.frame.cell;
  const snapshot = Object.freeze({ ...values,
    periodicOrigin: Object.freeze(Array.from(values.periodicOrigin)),
    sourceBounds: Object.freeze({ minimum: Object.freeze([...values.sourceBounds.minimum]),
      maximum: Object.freeze([...values.sourceBounds.maximum]) }),
    get uploadByteLength() { return values.uploadCoordinates?.byteLength ?? 0; },
  });
  publications.set(snapshot, { valid: true, cell: {
    origin: Array.from(cell.origin), vectors: Array.from(cell.vectors), pbc: Array.from(cell.pbc), triclinic: Boolean(cell.triclinic),
  } });
  return snapshot;
}

export function revokePreparedDisplay(snapshot) {
  const publication = publications.get(snapshot);
  if (publication) publication.valid = false;
}

/** O(1) metadata validation. Per-atom scans belong to the publishing setter. */
export function validatePreparedDisplay(snapshot, frame, positions, coordinateMode, { radii, periodicOrigin } = {}) {
  const publication = publications.get(snapshot), count = frame?.ids?.length;
  if (!publication?.valid || snapshot.frame !== frame || snapshot.rawDisplayPositions !== positions
      || snapshot.coordinateMode !== coordinateMode || snapshot.atomCount !== count
      || snapshot.displayPositions?.length !== count * 3 || snapshot.displayFractional?.length !== count * 3
      || snapshot.rawDisplayPositions?.length !== count * 3
      || !sameValues(publication.cell.origin, frame.cell.origin)
      || !sameValues(publication.cell.vectors, frame.cell.vectors)
      || !sameValues(publication.cell.pbc, frame.cell.pbc)
      || publication.cell.triclinic !== Boolean(frame.cell.triclinic)
      || (periodicOrigin && !sameValues(snapshot.periodicOrigin, periodicOrigin))
      || (radii && (snapshot.atomRadii !== radii || radii.length !== count))) {
    throw new Error('The prepared display snapshot does not match the current coordinates, cell, or radii.');
  }
  return snapshot;
}
