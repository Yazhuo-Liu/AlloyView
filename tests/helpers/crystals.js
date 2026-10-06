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

export function cfgText(frame, { element = 'Al', mass = 26.9815385 } = {}) {
  const properties = frame.properties ?? [];
  const lines = [`Number of particles = ${frame.ids.length}`, 'A = 1.0 Angstrom'];
  for (let row = 0; row < 3; row += 1) for (let column = 0; column < 3; column += 1) {
    lines.push(`H0(${row + 1},${column + 1}) = ${frame.cell.vectors[row * 3 + column]} A`);
  }
  lines.push('.NO_VELOCITY.', `entry_count = ${3 + properties.length}`);
  properties.forEach((property, index) => lines.push(`auxiliary[${index}] = ${property.name}${property.unit ? ` [${property.unit}]` : ''}`));
  lines.push(String(mass), element);
  for (let atom = 0; atom < frame.ids.length; atom += 1) {
    lines.push([...frame.fractional.subarray(atom * 3, atom * 3 + 3), ...properties.map(property => property.data[atom])].join(' '));
  }
  return `${lines.join('\n')}\n`;
}

export function dumpText(frames, { element = 'Fe' } = {}) {
  return frames.map((frame, index) => {
    const properties = frame.properties ?? [];
    const [lx, , , xy, ly, , xz, yz, lz] = frame.cell.vectors;
    const [ox, oy, oz] = frame.cell.origin;
    const tilted = xy !== 0 || xz !== 0 || yz !== 0;
    const bounds = tilted ? [
      [ox + Math.min(0, xy, xz, xy + xz), ox + lx + Math.max(0, xy, xz, xy + xz), xy],
      [oy + Math.min(0, yz), oy + ly + Math.max(0, yz), xz], [oz, oz + lz, yz],
    ] : [[ox, ox + lx], [oy, oy + ly], [oz, oz + lz]];
    const lines = ['ITEM: TIMESTEP', frame.timestep ?? index * 100, 'ITEM: NUMBER OF ATOMS', frame.ids.length,
      `ITEM: BOX BOUNDS ${tilted ? 'xy xz yz ' : ''}${frame.cell.pbc.map(periodic => periodic ? 'pp' : 'ff').join(' ')}`,
      ...bounds.map(bound => bound.join(' ')),
      `ITEM: ATOMS id type element xs ys zs${properties.map(property => ` ${property.name}`).join('')}`];
    for (let atom = 0; atom < frame.ids.length; atom += 1) {
      lines.push([frame.ids[atom], 1, element, ...frame.fractional.subarray(atom * 3, atom * 3 + 3),
        ...properties.map(property => property.data[atom])].join(' '));
    }
    return `${lines.join('\n')}\n`;
  }).join('');
}
