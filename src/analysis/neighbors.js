import { cellFaceHeights, determinant3 } from '../data/model.js';

/** Fractional linked cells with explicit periodic images, including self images.
 * A local environment must retain distinct images in small simulation cells.
 * Queries inspect a complete sphere before keeping the nearest neighbors.
 */
export class NeighborSearch {
  constructor({ fractional, cell }) {
    this.count = fractional.length / 3;
    if (!Number.isInteger(this.count) || this.count < 1) throw new Error('Analysis requires at least one atom.');
    this.cell = cell;
    this.heights = cellFaceHeights(cell);
    if (this.heights.some((height) => !Number.isFinite(height) || height <= 0)) {
      throw new Error('Neighbor search requires a finite, non-singular cell.');
    }
    this.coordinates = new Float64Array(fractional.length);
    this.minimum = [0, 0, 0];
    this.span = [1, 1, 1];
    for (let axis = 0; axis < 3; axis += 1) {
      let minimum = Infinity;
      let maximum = -Infinity;
      for (let atom = 0; atom < this.count; atom += 1) {
        const value = fractional[atom * 3 + axis];
        if (!Number.isFinite(value)) throw new Error(`Atom ${atom + 1} has a non-finite coordinate.`);
        this.coordinates[atom * 3 + axis] = cell.pbc[axis] ? value - Math.floor(value) : value;
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
      }
      if (!cell.pbc[axis]) {
        this.minimum[axis] = minimum;
        this.span[axis] = Math.max(1, maximum - minimum + 1e-10);
      }
    }
    const volume = Math.abs(determinant3(cell.vectors)) * this.span.reduce((a, b) => a * b, 1);
    this.initialRadius = 1.6 * Math.cbrt(volume / this.count);
    this.dimensions = Array.from(this.heights, (height, axis) => (
      Math.max(1, Math.min(256, Math.floor(height * this.span[axis] / this.initialRadius)))
    ));
    while (this.dimensions.reduce((a, b) => a * b, 1) > Math.min(2_000_000, this.count * 4)) {
      const axis = this.dimensions.indexOf(Math.max(...this.dimensions));
      this.dimensions[axis] = Math.max(1, Math.floor(this.dimensions[axis] / 2));
    }
    this.heads = new Int32Array(this.dimensions.reduce((a, b) => a * b, 1)).fill(-1);
    this.next = new Int32Array(this.count);
    for (let atom = 0; atom < this.count; atom += 1) {
      const indices = [0, 1, 2].map((axis) => this.binIndex(this.coordinates[atom * 3 + axis], axis));
      const bin = this.flatten(...indices);
      this.next[atom] = this.heads[bin];
      this.heads[bin] = atom;
    }
  }

  binIndex(value, axis) {
    return Math.max(0, Math.min(this.dimensions[axis] - 1,
      Math.floor((value - this.minimum[axis]) / this.span[axis] * this.dimensions[axis])));
  }

  flatten(x, y, z) {
    return (x * this.dimensions[1] + y) * this.dimensions[2] + z;
  }

  nearest(atom, count) {
    if (!Number.isInteger(count) || count < 1) throw new Error('Invalid nearest-neighbor count.');
    const needed = this.cell.pbc.some(Boolean) ? count : Math.min(count, this.count - 1);
    if (needed === 0) return [];
    let radius = this.initialRadius;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const neighbors = this.within(atom, radius);
      if (neighbors.length >= needed) {
        neighbors.sort((a, b) => a.distanceSquared - b.distanceSquared || a.atom - b.atom
          || a.x - b.x || a.y - b.y || a.z - b.z);
        return neighbors.slice(0, needed);
      }
      radius *= 1.6;
    }
    throw new Error('Neighbor search could not resolve this cell geometry. Check the cell and coordinates.');
  }

  within(atom, radius, limit = Infinity) {
    if (!Number.isFinite(radius) || radius <= 0) throw new Error('The neighbor radius must be positive and finite.');
    const bounds = Array.from(this.heights, (height) => radius / height + 1e-12);
    const center = Array.from(this.coordinates.subarray(atom * 3, atom * 3 + 3));
    const binAxes = bounds.map((bound, axis) => {
      const dimension = this.dimensions[axis];
      const width = this.span[axis] / dimension;
      const lo = Math.floor((center[axis] - bound - this.minimum[axis]) / width);
      const hi = Math.floor((center[axis] + bound - this.minimum[axis]) / width);
      if (this.cell.pbc[axis] && hi - lo + 1 >= dimension) return Array.from({ length: dimension }, (_, i) => i);
      const indices = [];
      const start = this.cell.pbc[axis] ? lo : Math.max(0, lo);
      const end = this.cell.pbc[axis] ? hi : Math.min(dimension - 1, hi);
      for (let i = start; i <= end; i += 1) {
        if (this.cell.pbc[axis]) indices.push((i % dimension + dimension) % dimension);
        else if (i >= 0 && i < dimension) indices.push(i);
      }
      return indices;
    });
    const h = this.cell.vectors;
    const neighbors = [];
    const radiusSquared = radius * radius;
    // Prevent pathological cells from spending unbounded time enumerating images.
    const imageBudget = bounds.reduce((product, bound, axis) => (
      product * (this.cell.pbc[axis] ? Math.ceil(2 * bound) + 1 : 1)
    ), 1);
    if (imageBudget > 100_000) throw new Error('The cell is too thin for this neighbor search; use a less skewed cell.');
    for (const bx of binAxes[0]) for (const by of binAxes[1]) for (const bz of binAxes[2]) {
      for (let other = this.heads[this.flatten(bx, by, bz)]; other >= 0; other = this.next[other]) {
        const difference = center.map((value, axis) => this.coordinates[other * 3 + axis] - value);
        const ranges = difference.map((value, axis) => this.cell.pbc[axis]
          ? [Math.ceil(-bounds[axis] - value), Math.floor(bounds[axis] - value)]
          : [0, 0]);
        for (let a = ranges[0][0]; a <= ranges[0][1]; a += 1) {
          for (let b = ranges[1][0]; b <= ranges[1][1]; b += 1) {
            for (let c = ranges[2][0]; c <= ranges[2][1]; c += 1) {
              if (other === atom && a === 0 && b === 0 && c === 0) continue;
              const da = difference[0] + a, db = difference[1] + b, dc = difference[2] + c;
              const x = da * h[0] + db * h[3] + dc * h[6];
              const y = da * h[1] + db * h[4] + dc * h[7];
              const z = da * h[2] + db * h[5] + dc * h[8];
              const distanceSquared = x * x + y * y + z * z;
              if (distanceSquared <= radiusSquared) {
                neighbors.push({ atom: other, x, y, z, distanceSquared, imageA: a, imageB: b, imageC: c });
                if (neighbors.length >= limit) return neighbors;
              }
            }
          }
        }
      }
    }
    return neighbors;
  }
}

export function atomRange(count, { startAtom = 0, endAtom = count } = {}) {
  if (!Number.isInteger(startAtom) || !Number.isInteger(endAtom)
      || startAtom < 0 || endAtom > count || startAtom >= endAtom) throw new Error('Invalid analysis atom range.');
  return { startAtom, endAtom };
}
