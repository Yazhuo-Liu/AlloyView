import { createCell, fractionalToCartesian } from '../../src/data/model.js';

export function crystalFrame(kind, repeat = 3, lattice = 4) {
  let basis, unit;
  if (['fcc', 'diamond'].includes(kind)) {
    basis = [[0, 0, 0], [0, .5, .5], [.5, 0, .5], [.5, .5, 0]];
    if (kind === 'diamond') basis.push(...basis.map((site) => site.map((value) => value + .25)));
    unit = [lattice, 0, 0, 0, lattice, 0, 0, 0, lattice];
  } else if (kind === 'bcc') {
    basis = [[0, 0, 0], [.5, .5, .5]];
    unit = [lattice, 0, 0, 0, lattice, 0, 0, 0, lattice];
  } else if (kind === 'sc') {
    basis = [[0, 0, 0]];
    unit = [lattice, 0, 0, 0, lattice, 0, 0, 0, lattice];
  } else if (['hcp', 'hex-diamond'].includes(kind)) {
    // Primitive hexagonal cell, ideal c/a and AB stacking.
    basis = [[0, 0, 0], [2 / 3, 1 / 3, .5]];
    if (kind === 'hex-diamond') basis.push([0, 0, 3 / 8], [2 / 3, 1 / 3, 7 / 8]);
    unit = [lattice, 0, 0, -lattice / 2, Math.sqrt(3) * lattice / 2, 0, 0, 0, Math.sqrt(8 / 3) * lattice];
  } else throw new Error('Unknown fixture crystal.');
  const fractional = [];
  for (let i = 0; i < repeat; i += 1) for (let j = 0; j < repeat; j += 1) for (let k = 0; k < repeat; k += 1) {
    for (const [a, b, c] of basis) fractional.push((i + a) / repeat, (j + b) / repeat, (k + c) / repeat);
  }
  const cell = createCell({ vectors: unit.map((value) => value * repeat), triclinic: ['hcp', 'hex-diamond'].includes(kind) });
  const coordinates = Float64Array.from(fractional);
  const count = coordinates.length / 3;
  return { fractional: coordinates, cell, ids: Uint32Array.from({ length: count }, (_, i) => i + 1),
    positions: fractionalToCartesian(coordinates, cell), types: new Uint16Array(count), typeLabels: ['X'], properties: [] };
}
