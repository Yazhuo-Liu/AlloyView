import { createCell, fractionalToCartesian } from '../../src/data/model.js';
import { crystalFrame } from './crystals.js';

/** The atoms of `frame` for which keep(position, index) holds, with optional
 * new periodicity. Atom IDs are renumbered from 1. */
export function subsetFrame(frame, keep, pbc = frame.cell.pbc) {
  const atoms = [];
  for (let atom = 0; atom < frame.ids.length; atom += 1) if (keep(frame.positions.subarray(atom * 3, atom * 3 + 3), atom)) atoms.push(atom);
  const fractional = new Float64Array(atoms.length * 3), positions = new Float64Array(atoms.length * 3);
  atoms.forEach((atom, index) => {
    fractional.set(frame.fractional.subarray(atom * 3, atom * 3 + 3), index * 3);
    positions.set(frame.positions.subarray(atom * 3, atom * 3 + 3), index * 3);
  });
  return { ...frame, fractional, positions, ids: Uint32Array.from(atoms, (_, index) => index + 1), types: new Uint16Array(atoms.length),
    cell: { ...frame.cell, pbc: Array.from(pbc) }, properties: [], sourceAtoms: atoms };
}

/** Cubic FCC crystal with `repeat` conventional cells of lattice constant
 * `lattice` along each axis; positions are Float64. */
export function fccBlock(repeat = 12, lattice = 4) {
  const frame = crystalFrame('fcc', repeat, lattice);
  return { ...frame, positions: fractionalToCartesian(frame.fractional, frame.cell, new Float64Array(frame.fractional.length)) };
}

/** The same fractional coordinates in another cell (for sheared crystals). */
export function withCell(frame, vectors, { origin = [0, 0, 0], pbc = frame.cell.pbc } = {}) {
  const cell = createCell({ vectors, origin, pbc, triclinic: true });
  return { ...frame, cell, positions: fractionalToCartesian(frame.fractional, cell, new Float64Array(frame.fractional.length)) };
}

/** Minimum-image distance in an orthogonal cubic cell of edge `length`. */
export function periodicDistance(first, second, length) {
  return Math.hypot(...[0, 1, 2].map(axis => {
    const delta = first[axis] - second[axis];
    return delta - length * Math.round(delta / length);
  }));
}

export const sphereVolume = radius => 4 / 3 * Math.PI * radius ** 3;
export const sphereArea = radius => 4 * Math.PI * radius ** 2;
