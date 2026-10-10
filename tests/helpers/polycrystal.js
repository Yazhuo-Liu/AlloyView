import { createCell, fractionalToCartesian } from '../../src/data/model.js';

/** Deterministic uniform random numbers in [0, 1). */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniformly distributed unit quaternion (w, x, y, z), after Shoemake. */
export function randomQuaternion(random) {
  const u = random(), v = random() * 2 * Math.PI, w = random() * 2 * Math.PI;
  return [Math.sqrt(u) * Math.cos(w), Math.sqrt(1 - u) * Math.sin(v), Math.sqrt(1 - u) * Math.cos(v), Math.sqrt(u) * Math.sin(w)];
}

/** Unit quaternion for a rotation of `degrees` about `axis`. */
export function axisAngleQuaternion(axis, degrees) {
  const length = Math.hypot(...axis), half = degrees * Math.PI / 360, sine = Math.sin(half) / length;
  return [Math.cos(half), axis[0] * sine, axis[1] * sine, axis[2] * sine];
}

export function quaternionMultiply([a, b, c, d], [e, f, g, h]) {
  return [a * e - b * f - c * g - d * h, a * f + b * e + c * h - d * g, a * g - b * h + c * e + d * f, a * h + b * g - c * f + d * e];
}

export function rotateVector([w, x, y, z], [a, b, c]) {
  return [
    (1 - 2 * (y * y + z * z)) * a + 2 * (x * y - w * z) * b + 2 * (x * z + w * y) * c,
    2 * (x * y + w * z) * a + (1 - 2 * (x * x + z * z)) * b + 2 * (y * z - w * x) * c,
    2 * (x * z - w * y) * a + 2 * (y * z + w * x) * b + (1 - 2 * (x * x + y * y)) * c,
  ];
}

// Conventional cells aligned as PTM's templates are: cube axes along x, y, z;
// hexagonal a1 along x and c along z.
const LATTICES = {
  fcc: a => ({ vectors: [[a, 0, 0], [0, a, 0], [0, 0, a]], basis: [[0, 0, 0], [0, .5, .5], [.5, 0, .5], [.5, .5, 0]], nearest: a / Math.SQRT2 }),
  bcc: a => ({ vectors: [[a, 0, 0], [0, a, 0], [0, 0, a]], basis: [[0, 0, 0], [.5, .5, .5]], nearest: a * Math.sqrt(3) / 2 }),
  hcp: a => ({ vectors: [[a, 0, 0], [-a / 2, a * Math.sqrt(3) / 2, 0], [0, 0, a * Math.sqrt(8 / 3)]],
    basis: [[0, 0, 0], [2 / 3, 1 / 3, .5]], nearest: a }),
};

/**
 * Voronoi polycrystal in an orthogonal, fully periodic box. Each grain is a
 * rotated lattice around its seed; an atom belongs to the nearest seed image.
 * Atoms closer than `overlap` × the nearest-neighbor distance to an atom of
 * an earlier grain are removed, and every coordinate receives a uniform
 * displacement of up to ±`noise` Å. `lattice` may list one lattice per grain.
 *
 * Returns a frame plus `grainOf` (zero-based grain of each atom) and the
 * grain `orientations` as (w, x, y, z) rotating the lattice into the box.
 */
export function polycrystalFrame({ lattice = 'fcc', a = 3.6, box = [40, 40, 40], seeds, orientations, noise = 0, overlap = .7, seed = 1 }) {
  const random = mulberry32(seed), grains = seeds.length;
  const lattices = Array.from({ length: grains }, (_, grain) => LATTICES[Array.isArray(lattice) ? lattice[grain] : lattice](a));
  const points = [], grainOf = [];
  const minimumImage = (value, length) => value - length * Math.round(value / length);
  const reach = Math.hypot(...box) / 2;
  for (let grain = 0; grain < grains; grain += 1) {
    const { vectors, basis } = lattices[grain], q = orientations[grain];
    const spacing = Math.min(...vectors.map(vector => Math.hypot(...vector)));
    const range = Math.ceil(reach / spacing * 1.3) + 1;
    for (let i = -range; i <= range; i += 1) for (let j = -range; j <= range; j += 1) for (let k = -range; k <= range; k += 1) {
      for (const site of basis) {
        const n = [i + site[0], j + site[1], k + site[2]];
        const local = [0, 1, 2].map(axis => n[0] * vectors[0][axis] + n[1] * vectors[1][axis] + n[2] * vectors[2][axis]);
        const offset = rotateVector(q, local);
        // The atom must lie in the primary image of its own seed's cell…
        if (offset.some((value, axis) => Math.abs(value) > box[axis] / 2 || minimumImage(value, box[axis]) !== value)) continue;
        if (offset.some((value, axis) => value === -box[axis] / 2)) continue;
        const position = offset.map((value, axis) => seeds[grain][axis] + value);
        const own = Math.hypot(...offset);
        // …and be closer to it than to any other seed.
        let nearest = true;
        for (let other = 0; other < grains && nearest; other += 1) {
          if (other === grain) continue;
          const distance = Math.hypot(...position.map((value, axis) => minimumImage(value - seeds[other][axis], box[axis])));
          if (distance < own || (distance === own && other < grain)) nearest = false;
        }
        if (!nearest) continue;
        points.push(position.map((value, axis) => value - box[axis] * Math.floor(value / box[axis])));
        grainOf.push(grain);
      }
    }
  }
  // Remove atoms that overlap an atom kept earlier, using a cell list.
  const limit = overlap * Math.min(...lattices.map(entry => entry.nearest));
  const bins = box.map(length => Math.max(1, Math.floor(length / limit))), cells = new Map(), kept = [];
  const binOf = (value, axis) => Math.min(bins[axis] - 1, Math.floor(value / box[axis] * bins[axis]));
  for (let atom = 0; atom < points.length; atom += 1) {
    const point = points[atom], home = point.map(binOf);
    let free = true;
    for (let dx = -1; dx <= 1 && free; dx += 1) for (let dy = -1; dy <= 1 && free; dy += 1) for (let dz = -1; dz <= 1 && free; dz += 1) {
      const key = [(home[0] + dx + bins[0]) % bins[0], (home[1] + dy + bins[1]) % bins[1], (home[2] + dz + bins[2]) % bins[2]].join(',');
      for (const other of cells.get(key) ?? []) {
        if (grainOf[other] !== grainOf[atom]
            && Math.hypot(...point.map((value, axis) => minimumImage(value - points[other][axis], box[axis]))) < limit) { free = false; break; }
      }
    }
    if (!free) continue;
    const key = home.join(',');
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(atom);
    kept.push(atom);
  }
  const count = kept.length, fractional = new Float64Array(count * 3);
  kept.forEach((atom, index) => {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = (points[atom][axis] + (noise ? (random() * 2 - 1) * noise : 0)) / box[axis];
      fractional[index * 3 + axis] = value - Math.floor(value);
    }
  });
  const cell = createCell({ vectors: [box[0], 0, 0, 0, box[1], 0, 0, 0, box[2]] });
  return { fractional, cell, ids: Uint32Array.from({ length: count }, (_, index) => index + 1),
    positions: fractionalToCartesian(fractional, cell, new Float64Array(count * 3)), types: new Uint16Array(count), typeLabels: ['X'],
    properties: [], grainOf: Uint32Array.from(kept, atom => grainOf[atom]), orientations: orientations.map(q => [...q]) };
}

/**
 * Close-packed layers stacked along z in an orthogonal periodic box. `steps`
 * lists, for each layer, whether the next layer follows forward (+1: A → B →
 * C → A) or backward (−1). A run of equal steps is FCC, a change of direction
 * leaves one HCP layer (a coherent twin boundary), and a single reversed step
 * leaves two adjacent HCP layers (an intrinsic stacking fault). The sum of
 * the steps must be a multiple of three for the stack to close periodically.
 */
export function stackedLayersFrame({ steps, nearest = 2.5, nx = 14, ny = 8, noise = 0, seed = 1 }) {
  if (steps.reduce((sum, step) => sum + step, 0) % 3 !== 0) throw new Error('The stacking sequence does not close periodically.');
  const random = mulberry32(seed), layers = steps.length, spacing = nearest * Math.sqrt(2 / 3);
  const box = [nx * nearest, ny * nearest * Math.sqrt(3), layers * spacing], count = layers * nx * ny * 2;
  const fractional = new Float64Array(count * 3);
  let atom = 0, letter = 0;
  for (let layer = 0; layer < layers; layer += 1) {
    // Positions A, B and C differ by one third of the long diagonal.
    const shiftX = letter * nearest / 2, shiftY = letter * nearest * Math.sqrt(3) / 6;
    for (let i = 0; i < nx; i += 1) for (let j = 0; j < ny; j += 1) for (const [bx, by] of [[0, 0], [.5, .5]]) {
      const point = [(i + bx) * nearest + shiftX, (j + by) * nearest * Math.sqrt(3) + shiftY, (layer + .5) * spacing];
      for (let axis = 0; axis < 3; axis += 1) {
        const value = (point[axis] + (noise ? (random() * 2 - 1) * noise : 0)) / box[axis];
        fractional[atom * 3 + axis] = value - Math.floor(value);
      }
      atom += 1;
    }
    letter = (letter + steps[layer] + 3) % 3;
  }
  const cell = createCell({ vectors: [box[0], 0, 0, 0, box[1], 0, 0, 0, box[2]] });
  return { fractional, cell, ids: Uint32Array.from({ length: count }, (_, index) => index + 1),
    positions: fractionalToCartesian(fractional, cell, new Float64Array(count * 3)), types: new Uint16Array(count), typeLabels: ['X'],
    properties: [], atomsPerLayer: nx * ny * 2, layers };
}

/** LAMMPS dump text with full-precision Cartesian coordinates. */
export function polycrystalDumpText(frame, { element = 'Ni', timestep = 0 } = {}) {
  const [lx, , , , ly, , , , lz] = frame.cell.vectors;
  const lines = ['ITEM: TIMESTEP', String(timestep), 'ITEM: NUMBER OF ATOMS', String(frame.ids.length),
    'ITEM: BOX BOUNDS pp pp pp', `0 ${lx}`, `0 ${ly}`, `0 ${lz}`, 'ITEM: ATOMS id type element x y z'];
  for (let atom = 0; atom < frame.ids.length; atom += 1) {
    lines.push(`${frame.ids[atom]} 1 ${element} ${frame.positions[atom * 3]} ${frame.positions[atom * 3 + 1]} ${frame.positions[atom * 3 + 2]}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Adjusted Rand index of two labelings of the same atoms. */
export function adjustedRandIndex(first, second) {
  const pairs = n => n * (n - 1) / 2, table = new Map(), rows = new Map(), columns = new Map();
  for (let atom = 0; atom < first.length; atom += 1) {
    const key = `${first[atom]}:${second[atom]}`;
    table.set(key, (table.get(key) ?? 0) + 1);
    rows.set(first[atom], (rows.get(first[atom]) ?? 0) + 1);
    columns.set(second[atom], (columns.get(second[atom]) ?? 0) + 1);
  }
  let index = 0, rowSum = 0, columnSum = 0;
  for (const count of table.values()) index += pairs(count);
  for (const count of rows.values()) rowSum += pairs(count);
  for (const count of columns.values()) columnSum += pairs(count);
  const expected = rowSum * columnSum / pairs(first.length), maximum = (rowSum + columnSum) / 2;
  return maximum === expected ? 1 : (index - expected) / (maximum - expected);
}
