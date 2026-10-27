import { createCell } from './model.js';
import { MAX_PHYSICAL_REPLICATION_ATOMS } from './replicate.js';
import { normalizeRepetitions } from './replication.js';

/** Apply the physical cell/count transformation without constructing atoms.
 * Smoothing must be performed by the normal frame path before calling this.
 * A missing cell (plain XYZ or PDB) cannot be inferred from its header. */
export function processedFrameHeader(header, { physical = false, repetitions = [1, 1, 1] } = {}) {
  if (!header || header.headerUnavailable || !header.cell) return header;
  if (!physical) return header;
  const count = header.atomCount;
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Physical replication requires a positive atom count.');
  const repeats = normalizeRepetitions(repetitions, header.cell.pbc);
  for (let axis = 0; axis < 3; axis++) {
    if (!header.cell.pbc[axis] && Number(repetitions[axis]) !== 1) throw new Error('Physical replication is only available along periodic cell directions.');
  }
  const atomCount = count * repeats.reduce((product, value) => product * value, 1);
  if (atomCount > MAX_PHYSICAL_REPLICATION_ATOMS) {
    throw new Error(`Physical replication would create ${atomCount.toLocaleString('en-US')} atoms; the limit is ${MAX_PHYSICAL_REPLICATION_ATOMS.toLocaleString('en-US')}.`);
  }
  const vectors = Float64Array.from(header.cell.vectors, (value, index) => value * repeats[Math.floor(index / 3)]);
  const cell = createCell({ origin: header.cell.origin, vectors, pbc: header.cell.pbc, triclinic: header.cell.triclinic });
  return { ...header, atomCount, cell };
}
