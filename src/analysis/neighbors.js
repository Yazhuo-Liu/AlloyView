import { cellFaceHeights, determinant3 } from '../data/model.js';

/** Fractional linked cells with explicit periodic images, including self images.
 * A local environment must retain distinct images in small simulation cells.
 * Queries inspect a complete sphere before keeping the nearest neighbors.
 */
export class NeighborSearch {
  constructor({ fractional, cell }, { sharedMemory = false, reuseCoordinates = false } = {}) {
    this.count = fractional.length / 3;
    if (!Number.isInteger(this.count) || this.count < 1) throw new Error('Analysis requires at least one atom.');
    this.cell = cell;
    this.heights = cellFaceHeights(cell);
    if (this.heights.some((height) => !Number.isFinite(height) || height <= 0)) {
      throw new Error('Neighbor search requires a finite, non-singular cell.');
    }
    const allocate = (Type, length) => sharedMemory ? new Type(new SharedArrayBuffer(length * Type.BYTES_PER_ELEMENT)) : new Type(length);
    // Only a transferred, Worker-owned Float64 snapshot may share storage.
    // Public callers and shared source arrays keep separate immutable inputs.
    if (reuseCoordinates && (!(fractional instanceof Float64Array) || !(fractional.buffer instanceof ArrayBuffer) || sharedMemory)) {
      throw new Error('In-place neighbor wrapping requires private Float64 coordinates.');
    }
    // Keep image-bearing coordinates authoritative for later analyses (e.g.
    // non-affine Wigner-Seitz mapping between different cells). Reuse only
    // coordinates whose periodic components are already normalized.
    const normalized = reuseCoordinates && !fractional.some((value, index) => cell.pbc[index % 3]
      && (value < 0 || value >= 1 || Object.is(value, -0)));
    this.coordinates = normalized ? fractional : allocate(Float64Array, fractional.length);
    this.minimum = [0, 0, 0];
    this.span = [1, 1, 1];
    for (let axis = 0; axis < 3; axis += 1) {
      let minimum = Infinity;
      let maximum = -Infinity;
      for (let atom = 0; atom < this.count; atom += 1) {
        const value = fractional[atom * 3 + axis];
        if (!Number.isFinite(value)) throw new Error(`Atom ${atom + 1} has a non-finite coordinate.`);
        if (!normalized) this.coordinates[atom * 3 + axis] = cell.pbc[axis] ? value - Math.floor(value) : value;
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
    this.nearestRadii = new Map();
    this.heads = allocate(Int32Array, this.dimensions.reduce((a, b) => a * b, 1)).fill(-1);
    this.next = allocate(Int32Array, this.count);
    for (let atom = 0; atom < this.count; atom += 1) {
      const bin = this.flatten(this.binIndex(this.coordinates[atom * 3], 0),
        this.binIndex(this.coordinates[atom * 3 + 1], 1), this.binIndex(this.coordinates[atom * 3 + 2], 2));
      this.next[atom] = this.heads[bin];
      this.heads[bin] = atom;
    }
  }

  /** Immutable transport descriptor. On isolated hosts the linked arrays are
   * allocated once in a Worker and every resident Worker reads the same SABs.
   * Per-query scratch and the radius cache always stay private to a Worker. */
  exportIndex() {
    return Object.fromEntries(['count', 'cell', 'heights', 'minimum', 'span',
      'initialRadius', 'dimensions', 'coordinates', 'heads', 'next'].map(name => [name, this[name]]));
  }

  static fromIndex(index) {
    if (!index || !(index.coordinates instanceof Float64Array) || !(index.heads instanceof Int32Array)
        || !(index.next instanceof Int32Array) || index.coordinates.length !== index.count * 3
        || index.next.length !== index.count || index.heads.length !== index.dimensions?.reduce((a, b) => a * b, 1)) {
      throw new Error('The resident neighbor index is incomplete.');
    }
    const search = Object.assign(Object.create(NeighborSearch.prototype), index);
    search.nearestRadii = new Map();
    return search;
  }

  binIndex(value, axis) {
    return Math.max(0, Math.min(this.dimensions[axis] - 1,
      Math.floor((value - this.minimum[axis]) / this.span[axis] * this.dimensions[axis])));
  }

  flatten(x, y, z) {
    return (x * this.dimensions[1] + y) * this.dimensions[2] + z;
  }

  /** A first radius whose sphere is expected to hold 1.3× the requested
   * neighbors. The general initial radius expects about 17 atoms, so 18 PTM
   * neighbors usually failed the first pass and searched again at 1.6×. Any
   * sphere holding at least the requested count yields the same sorted
   * nearest neighbors, so this changes only the work, never the result. */
  nearestRadius(needed) {
    let radius = this.nearestRadii.get(needed);
    if (radius !== undefined) return radius;
    radius = Math.max(this.initialRadius, this.initialRadius / 1.6 * Math.cbrt(3 * 1.3 * needed / (4 * Math.PI)));
    // Thin cells keep the original start rather than reach the image budget.
    if (this.imageBudget(radius) > 100_000) radius = this.initialRadius;
    this.nearestRadii.set(needed, radius);
    return radius;
  }

  imageBudget(radius) {
    let product = 1;
    for (let axis = 0; axis < 3; axis++) if (this.cell.pbc[axis]) product *= Math.ceil(2 * (radius / this.heights[axis] + 1e-12)) + 1;
    return product;
  }

  nearest(atom, count) {
    if (!Number.isInteger(count) || count < 1) throw new Error('Invalid nearest-neighbor count.');
    const needed = this.cell.pbc.some(Boolean) ? count : Math.min(count, this.count - 1);
    if (needed === 0) return [];
    let radius = this.nearestRadius(needed);
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

  /** Bins overlapping [center − bound, center + bound] along one axis, as
   * [first, last, wrap]: visit first..last, reducing modulo the dimension when
   * `wrap` is set. The visiting order matches an explicit index list. */
  binRange(center, bound, axis, output) {
    const dimension = this.dimensions[axis], periodic = this.cell.pbc[axis];
    const width = this.span[axis] / dimension;
    const lo = Math.floor((center - bound - this.minimum[axis]) / width);
    const hi = Math.floor((center + bound - this.minimum[axis]) / width);
    if (periodic && hi - lo + 1 >= dimension) { output[0] = 0; output[1] = dimension - 1; output[2] = 0; }
    else if (periodic) { output[0] = lo; output[1] = hi; output[2] = 1; }
    else { output[0] = Math.max(0, lo); output[1] = Math.min(dimension - 1, hi); output[2] = 0; }
    return output;
  }

  /** Every image within `radius` of `atom`. This runs for every candidate of
   * every atom in most analyses, so the inner loops keep values in scalars
   * rather than allocating per candidate; the arithmetic is unchanged. */
  within(atom, radius, limit = Infinity) {
    if (!Number.isFinite(radius) || radius <= 0) throw new Error('The neighbor radius must be positive and finite.');
    const coordinates = this.coordinates, h = this.cell.vectors, pbc = this.cell.pbc;
    const b0 = radius / this.heights[0] + 1e-12, b1 = radius / this.heights[1] + 1e-12, b2 = radius / this.heights[2] + 1e-12;
    const cx = coordinates[atom * 3], cy = coordinates[atom * 3 + 1], cz = coordinates[atom * 3 + 2];
    const [x0, x1, xWrap] = this.binRange(cx, b0, 0, this.rangeX ??= new Int32Array(3));
    const [y0, y1, yWrap] = this.binRange(cy, b1, 1, this.rangeY ??= new Int32Array(3));
    const [z0, z1, zWrap] = this.binRange(cz, b2, 2, this.rangeZ ??= new Int32Array(3));
    const [dx, dy, dz] = this.dimensions;
    // Prevent pathological cells from spending unbounded time enumerating images.
    if (this.imageBudget(radius) > 100_000) throw new Error('The cell is too thin for this neighbor search; use a less skewed cell.');
    const p0 = pbc[0], p1 = pbc[1], p2 = pbc[2];
    const h0 = h[0], h1 = h[1], h2 = h[2], h3 = h[3], h4 = h[4], h5 = h[5], h6 = h[6], h7 = h[7], h8 = h[8];
    const neighbors = [];
    const radiusSquared = radius * radius;
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) {
      const bx = xWrap ? (ix % dx + dx) % dx : ix, by = yWrap ? (iy % dy + dy) % dy : iy, bz = zWrap ? (iz % dz + dz) % dz : iz;
      for (let other = this.heads[(bx * dy + by) * dz + bz]; other >= 0; other = this.next[other]) {
        const d0 = coordinates[other * 3] - cx, d1 = coordinates[other * 3 + 1] - cy, d2 = coordinates[other * 3 + 2] - cz;
        const aLo = p0 ? Math.ceil(-b0 - d0) : 0, aHi = p0 ? Math.floor(b0 - d0) : 0;
        const bLo = p1 ? Math.ceil(-b1 - d1) : 0, bHi = p1 ? Math.floor(b1 - d1) : 0;
        const cLo = p2 ? Math.ceil(-b2 - d2) : 0, cHi = p2 ? Math.floor(b2 - d2) : 0;
        for (let a = aLo; a <= aHi; a += 1) {
          for (let b = bLo; b <= bHi; b += 1) {
            for (let c = cLo; c <= cHi; c += 1) {
              if (other === atom && a === 0 && b === 0 && c === 0) continue;
              const da = d0 + a, db = d1 + b, dc = d2 + c;
              const x = da * h0 + db * h3 + dc * h6;
              const y = da * h1 + db * h4 + dc * h7;
              const z = da * h2 + db * h5 + dc * h8;
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
