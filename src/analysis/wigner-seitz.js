import { cellFaceHeights, determinant3, invert3 } from '../data/model.js';
import { atomRange } from './neighbors.js';

/** Per-atom classes, by the reference site an atom is assigned to. Atoms that
 * share a site are all interstitial, as in OVITO's atom output mode where
 * every atom of a doubly occupied site reports occupancy 2. */
export const WIGNER_SEITZ_ATOM_CLASSES = Object.freeze([
  { id: 0, label: 'Regular', description: 'Alone on a reference site of its own type', color: [188, 194, 204] },
  { id: 1, label: 'Interstitial', description: 'Shares its reference site with other atoms', color: [239, 108, 0] },
  { id: 2, label: 'Antisite', description: 'Alone on a reference site of another type', color: [41, 121, 255] },
].map(Object.freeze));

/** Reference-site classes, drawn as site markers. */
export const WIGNER_SEITZ_SITE_CLASSES = Object.freeze([
  { id: 0, label: 'Vacancy', description: 'No atom is assigned to the site', color: [236, 64, 160] },
  { id: 1, label: 'Regular', description: 'One atom of the site type', color: [150, 160, 176] },
  { id: 2, label: 'Interstitial', description: 'Two or more atoms are assigned to the site', color: [255, 167, 38] },
  { id: 3, label: 'Antisite', description: 'One atom of another type', color: [0, 188, 212] },
].map(Object.freeze));

export const SITE_VACANCY = 0, SITE_REGULAR = 1, SITE_INTERSTITIAL = 2, SITE_ANTISITE = 3;
export const ATOM_REGULAR = 0, ATOM_INTERSTITIAL = 1, ATOM_ANTISITE = 2;
const ATOM_CLASS_OF_SITE = Uint8Array.from([ATOM_REGULAR, ATOM_REGULAR, ATOM_INTERSTITIAL, ATOM_ANTISITE]);

// A query visits a few bins near a lattice site. These limits only stop
// pathological geometry (very thin cells, atoms far outside open boundaries).
const MAX_BIN_VISITS = 20_000_000;
const MAX_PASSES = 128;
const RELATIVE_MARGIN = 1e-9;
const BIN_SLACK = 1e-9;

/**
 * Linked cells over the reference sites in reduced coordinates. Periodic axes
 * are wrapped into [0, 1); open axes span the sites' own extent (at least one
 * cell length). Sites are sorted by bin, in ascending index within a bin.
 *
 * Squared distances use the Cholesky factor R of the metric, ordered with
 * periodic axes inside and open axes outside:
 *   |H Δ|² = (R00 Δ0 + R01 Δ1 + R02 Δ2)² + (R11 Δ1 + R12 Δ2)² + (R22 Δ2)².
 * Each term bounds one level of a nested bin search from below, so the search
 * follows tilted cells and visits only bins that can hold a closer site.
 */
export class WignerSeitzSites {
  constructor(referenceFractional, referenceCell) {
    const count = referenceFractional?.length / 3;
    if (!Number.isInteger(count) || count < 1) throw new Error('Wigner–Seitz analysis requires at least one reference site.');
    if (referenceCell?.vectors?.length !== 9 || referenceCell.pbc?.length !== 3) throw new Error('The Wigner–Seitz reference cell is incomplete.');
    this.count = count;
    this.vectors = Float64Array.from(referenceCell.vectors);
    this.pbc = Array.from(referenceCell.pbc, Boolean);
    this.heights = cellFaceHeights(referenceCell);
    if (Array.from(this.heights).some(height => !Number.isFinite(height) || height <= 0)) {
      throw new Error('Wigner–Seitz analysis requires a finite, non-singular reference cell.');
    }
    const wrapped = new Float64Array(count * 3);
    this.minimum = [0, 0, 0]; this.maximum = [1, 1, 1]; this.span = [1, 1, 1];
    for (let axis = 0; axis < 3; axis += 1) {
      let low = Infinity, high = -Infinity;
      for (let site = 0; site < count; site += 1) {
        const value = referenceFractional[site * 3 + axis];
        if (!Number.isFinite(value)) throw new Error(`Reference site ${site + 1} has a non-finite coordinate.`);
        const stored = this.pbc[axis] ? value - Math.floor(value) : value;
        wrapped[site * 3 + axis] = stored;
        if (stored < low) low = stored;
        if (stored > high) high = stored;
      }
      if (!this.pbc[axis]) {
        this.minimum[axis] = low; this.maximum[axis] = high;
        this.span[axis] = Math.max(1, high - low);
      }
    }
    const volume = Math.abs(determinant3(this.vectors)) * this.span[0] * this.span[1] * this.span[2];
    // About two sites per bin; a lattice point's nearest site lies within one bin length.
    this.binLength = Math.cbrt(2 * volume / count);
    this.dimensions = Array.from(this.heights, (height, axis) => Math.max(1, Math.min(1024, Math.floor(height * this.span[axis] / this.binLength))));
    while (this.dimensions[0] * this.dimensions[1] * this.dimensions[2] > Math.max(1, Math.min(4_000_000, 2 * count))) {
      const axis = this.dimensions.indexOf(Math.max(...this.dimensions));
      this.dimensions[axis] = Math.max(1, Math.floor(this.dimensions[axis] / 2));
    }
    this.width = this.span.map((span, axis) => span / this.dimensions[axis]);
    const [nx, ny, nz] = this.dimensions, binCount = nx * ny * nz;
    const bins = new Int32Array(count), offsets = new Int32Array(binCount + 1);
    for (let site = 0; site < count; site += 1) {
      const bin = (this.binIndex(wrapped[site * 3], 0) * ny + this.binIndex(wrapped[site * 3 + 1], 1)) * nz + this.binIndex(wrapped[site * 3 + 2], 2);
      bins[site] = bin; offsets[bin + 1] += 1;
    }
    for (let bin = 0; bin < binCount; bin += 1) offsets[bin + 1] += offsets[bin];
    const cursor = offsets.slice(0, binCount);
    this.offsets = offsets; this.order = new Int32Array(count); this.coordinates = new Float64Array(count * 3);
    for (let site = 0; site < count; site += 1) {
      const slot = cursor[bins[site]]++;
      this.order[slot] = site;
      this.coordinates[slot * 3] = wrapped[site * 3];
      this.coordinates[slot * 3 + 1] = wrapped[site * 3 + 1];
      this.coordinates[slot * 3 + 2] = wrapped[site * 3 + 2];
    }
    // Inner (periodic) to outer (open) axes; stable within each group.
    this.perm = [0, 1, 2].filter(axis => this.pbc[axis]).concat([0, 1, 2].filter(axis => !this.pbc[axis]));
    const column = axis => [this.vectors[axis * 3], this.vectors[axis * 3 + 1], this.vectors[axis * 3 + 2]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const [u0, u1, u2] = this.perm.map(column);
    const r00 = Math.sqrt(dot(u0, u0)), e0 = u0.map(value => value / r00);
    const r01 = dot(e0, u1), r02 = dot(e0, u2);
    const v1 = u1.map((value, k) => value - r01 * e0[k]), r11 = Math.sqrt(dot(v1, v1)), e1 = v1.map(value => value / r11);
    const r12 = dot(e1, u2);
    const v2 = u2.map((value, k) => value - r02 * e0[k] - r12 * e1[k]), r22 = Math.sqrt(dot(v2, v2));
    if (![r00, r11, r22].every(value => Number.isFinite(value) && value > 0)) throw new Error('The Wigner–Seitz reference cell is singular.');
    // Per-level constants (level 0 innermost), kept as scalars for the search loops.
    const [p0, p1, p2] = this.perm;
    Object.assign(this, { r00, r01, r02, r11, r12, r22, p0, p1, p2,
      n0: this.dimensions[p0], n1: this.dimensions[p1], n2: this.dimensions[p2],
      w0: this.width[p0], w1: this.width[p1], w2: this.width[p2],
      m0: this.minimum[p0], m1: this.minimum[p1], m2: this.minimum[p2],
      periodic0: this.pbc[p0], periodic1: this.pbc[p1], periodic2: this.pbc[p2],
      // Open-axis bins are clipped to the sites' extent, which keeps the
      // bounds tight for atoms far outside a free surface.
      top0: this.pbc[p0] ? Infinity : this.maximum[p0], top1: this.pbc[p1] ? Infinity : this.maximum[p1],
      top2: this.pbc[p2] ? Infinity : this.maximum[p2] });
    // Flattened bin index strides of each level's axis.
    const stride = [ny * nz, nz, 1];
    this.s0 = stride[p0]; this.s1 = stride[p1]; this.s2 = stride[p2];
    const scale = Math.max(...[0, 1, 2].map(axis => Math.hypot(...column(axis)) * this.span[axis]));
    this.tolerance = (1e-10 * scale) ** 2;
    this.bestSite = -1; this.bestD2 = Infinity; this.limit = Infinity; this.visits = 0;
    this.image = new Float64Array(3);
  }

  binIndex(value, axis) {
    return Math.max(0, Math.min(this.dimensions[axis] - 1, Math.floor((value - this.minimum[axis]) / this.span[axis] * this.dimensions[axis])));
  }

  /** Nearest site to reduced reference coordinates (q0, q1, q2), with periodic
   * components in [0, 1). Equal squared distances choose the lower site index.
   * Sets bestSite and bestD2 (the squared Cartesian distance in the reference
   * metric) and returns bestSite. */
  nearest(q0, q1, q2) {
    let outside = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      if (this.pbc[axis]) continue;
      const value = axis === 0 ? q0 : axis === 1 ? q1 : q2;
      const gap = Math.max(0, this.minimum[axis] - value, value - this.maximum[axis]) * this.heights[axis];
      if (gap > outside) outside = gap;
    }
    // Atoms outside open boundaries start from the distance to the site extent.
    let radius2 = this.binLength * this.binLength + outside * outside;
    this.bestSite = -1; this.bestD2 = Infinity; this.visits = 0;
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      this.limit = Math.min(radius2, this.bestD2);
      this.visit(q0, q1, q2);
      if (this.bestSite >= 0) {
        // Every site within the searched radius was examined.
        if (this.bestD2 <= radius2) return this.bestSite;
        radius2 = this.bestD2;
      } else radius2 *= 4;
      if (!Number.isFinite(radius2)) break;
    }
    throw new Error('Wigner–Seitz site search did not converge; check the reference cell and coordinates.');
  }

  visit(q0, q1, q2) {
    const { r00, r01, r02, r11, r12, r22, p0, p1, p2, n0, n1, n2, w0, w1, w2, m0, m1, m2,
      periodic0, periodic1, periodic2, top0, top1, top2, s0, s1, s2, tolerance, image } = this;
    const Q0 = p0 === 0 ? q0 : p0 === 1 ? q1 : q2, Q1 = p1 === 0 ? q0 : p1 === 1 ? q1 : q2, Q2 = p2 === 0 ? q0 : p2 === 1 ? q1 : q2;
    let B = this.limit + this.limit * RELATIVE_MARGIN + tolerance, k2lo, k2hi;
    {
      const reach = Math.sqrt(B) / r22;
      k2lo = Math.floor((Q2 - reach - m2) / w2 - BIN_SLACK); k2hi = Math.floor((Q2 + reach - m2) / w2 + BIN_SLACK);
      if (!periodic2) { k2lo = Math.max(0, k2lo); k2hi = Math.min(n2 - 1, k2hi); }
    }
    if (k2lo > k2hi) return;
    const c2 = Math.max(k2lo, Math.min(k2hi, Math.floor((Q2 - m2) / w2)));
    for (let step2 = 0; ; step2 += 1) {
      const j2 = (step2 + 1) >> 1;
      if (c2 - j2 < k2lo && c2 + j2 > k2hi) break;
      const k2 = step2 & 1 ? c2 + j2 : c2 - j2;
      if (k2 < k2lo || k2 > k2hi) continue;
      this.charge();
      const low2 = m2 + k2 * w2, d2lo = Q2 - Math.min(low2 + w2, top2), d2hi = Q2 - low2;
      const e2 = d2lo > 0 ? d2lo : d2hi < 0 ? -d2hi : 0;
      const t2 = (r22 * e2) * (r22 * e2);
      B = this.limit + this.limit * RELATIVE_MARGIN + tolerance;
      if (t2 > B) continue;
      const real2 = periodic2 ? ((k2 % n2) + n2) % n2 : k2, image2 = periodic2 ? (k2 - real2) / n2 : 0;
      const a1 = r12 * d2lo, b1 = r12 * d2hi, s1lo = Math.min(a1, b1), s1hi = Math.max(a1, b1);
      const reach1 = Math.sqrt(B - t2);
      let k1lo = Math.floor((Q1 - (reach1 - s1lo) / r11 - m1) / w1 - BIN_SLACK);
      let k1hi = Math.floor((Q1 + (reach1 + s1hi) / r11 - m1) / w1 + BIN_SLACK);
      if (!periodic1) { k1lo = Math.max(0, k1lo); k1hi = Math.min(n1 - 1, k1hi); }
      if (k1lo > k1hi) continue;
      const c1 = Math.max(k1lo, Math.min(k1hi, Math.floor((Q1 + (s1lo + s1hi) / 2 / r11 - m1) / w1)));
      for (let step1 = 0; ; step1 += 1) {
        const j1 = (step1 + 1) >> 1;
        if (c1 - j1 < k1lo && c1 + j1 > k1hi) break;
        const k1 = step1 & 1 ? c1 + j1 : c1 - j1;
        if (k1 < k1lo || k1 > k1hi) continue;
        this.charge();
        const low1 = m1 + k1 * w1, d1lo = Q1 - Math.min(low1 + w1, top1), d1hi = Q1 - low1;
        const l1lo = r11 * d1lo + s1lo, l1hi = r11 * d1hi + s1hi;
        const e1 = l1lo > 0 ? l1lo : l1hi < 0 ? -l1hi : 0;
        const t1 = t2 + e1 * e1;
        B = this.limit + this.limit * RELATIVE_MARGIN + tolerance;
        if (t1 > B) continue;
        const real1 = periodic1 ? ((k1 % n1) + n1) % n1 : k1, image1 = periodic1 ? (k1 - real1) / n1 : 0;
        const a01 = r01 * d1lo, b01 = r01 * d1hi, a02 = r02 * d2lo, b02 = r02 * d2hi;
        const s0lo = Math.min(a01, b01) + Math.min(a02, b02), s0hi = Math.max(a01, b01) + Math.max(a02, b02);
        const reach0 = Math.sqrt(B - t1);
        let k0lo = Math.floor((Q0 - (reach0 - s0lo) / r00 - m0) / w0 - BIN_SLACK);
        let k0hi = Math.floor((Q0 + (reach0 + s0hi) / r00 - m0) / w0 + BIN_SLACK);
        if (!periodic0) { k0lo = Math.max(0, k0lo); k0hi = Math.min(n0 - 1, k0hi); }
        if (k0lo > k0hi) continue;
        const c0 = Math.max(k0lo, Math.min(k0hi, Math.floor((Q0 + (s0lo + s0hi) / 2 / r00 - m0) / w0)));
        for (let step0 = 0; ; step0 += 1) {
          const j0 = (step0 + 1) >> 1;
          if (c0 - j0 < k0lo && c0 + j0 > k0hi) break;
          const k0 = step0 & 1 ? c0 + j0 : c0 - j0;
          if (k0 < k0lo || k0 > k0hi) continue;
          const low0 = m0 + k0 * w0, d0lo = Q0 - Math.min(low0 + w0, top0), d0hi = Q0 - low0;
          const l0lo = r00 * d0lo + s0lo, l0hi = r00 * d0hi + s0hi;
          const e0 = l0lo > 0 ? l0lo : l0hi < 0 ? -l0hi : 0;
          if (t1 + e0 * e0 > this.limit + this.limit * RELATIVE_MARGIN + tolerance) continue;
          this.charge();
          const real0 = periodic0 ? ((k0 % n0) + n0) % n0 : k0, image0 = periodic0 ? (k0 - real0) / n0 : 0;
          image[p0] = image0; image[p1] = image1; image[p2] = image2;
          this.scan(real0 * s0 + real1 * s1 + real2 * s2, q0, q1, q2);
        }
      }
    }
  }

  charge() {
    if (++this.visits > MAX_BIN_VISITS) {
      throw new Error('Wigner–Seitz site search exceeded its work limit; the reference cell may be too thin or an atom too far outside an open boundary.');
    }
  }

  /** The distance is a function of the query, the stored site coordinates and
   * the integer image only, so it is independent of the search order. */
  scan(bin, q0, q1, q2) {
    const h = this.vectors, coordinates = this.coordinates, order = this.order;
    const i0 = this.image[0], i1 = this.image[1], i2 = this.image[2];
    for (let slot = this.offsets[bin], end = this.offsets[bin + 1]; slot < end; slot += 1) {
      const da = q0 - coordinates[slot * 3] - i0, db = q1 - coordinates[slot * 3 + 1] - i1, dc = q2 - coordinates[slot * 3 + 2] - i2;
      const x = da * h[0] + db * h[3] + dc * h[6];
      const y = da * h[1] + db * h[4] + dc * h[7];
      const z = da * h[2] + db * h[5] + dc * h[8];
      const d2 = x * x + y * y + z * z;
      const site = order[slot];
      if (d2 < this.bestD2 || (d2 === this.bestD2 && site < this.bestSite)) {
        this.bestD2 = d2; this.bestSite = site;
        if (d2 < this.limit) this.limit = d2;
      }
    }
  }
}

/** Reduced reference coordinates of a current atom, q = M f + t, where f are
 * the atom's reduced current coordinates. With affine mapping, q = f: the
 * current cell is mapped onto the reference cell. Without it, q is the
 * atom's Cartesian position expressed in the reference cell,
 * M = H_ref⁻¹ H_cur and t = H_ref⁻¹ (o_cur − o_ref). Identical cells use the
 * identity in both modes, so a frame compared with itself has zero distances. */
export function wignerSeitzQueryMapping(currentCell, referenceCell, affineMapping = false) {
  const same = [0, 1, 2, 3, 4, 5, 6, 7, 8].every(k => currentCell.vectors[k] === referenceCell.vectors[k])
    && [0, 1, 2].every(k => (currentCell.origin?.[k] ?? 0) === (referenceCell.origin?.[k] ?? 0));
  if (affineMapping || same) return { identity: true, matrix: null, offset: null };
  const inverse = invert3(referenceCell.vectors), h = currentCell.vectors;
  const matrix = new Float64Array(9), offset = new Float64Array(3);
  for (let row = 0; row < 3; row += 1) for (let axis = 0; axis < 3; axis += 1) {
    matrix[row * 3 + axis] = h[row * 3] * inverse[axis] + h[row * 3 + 1] * inverse[3 + axis] + h[row * 3 + 2] * inverse[6 + axis];
  }
  const shift = [0, 1, 2].map(k => (currentCell.origin?.[k] ?? 0) - (referenceCell.origin?.[k] ?? 0));
  for (let axis = 0; axis < 3; axis += 1) offset[axis] = shift[0] * inverse[axis] + shift[1] * inverse[3 + axis] + shift[2] * inverse[6 + axis];
  return { identity: false, matrix, offset };
}

/** Site index and query mapping, built once per Worker and calculation. */
export function prepareWignerSeitzContext(frame, { referenceFractional, referenceCell, affineMapping = false } = {}) {
  if (typeof affineMapping !== 'boolean') throw new Error('The Wigner–Seitz affine mapping option must be a boolean.');
  if (!frame?.cell?.pbc || !referenceCell?.pbc) throw new Error('Wigner–Seitz analysis requires current and reference cells.');
  if ([0, 1, 2].some(axis => Boolean(frame.cell.pbc[axis]) !== Boolean(referenceCell.pbc[axis]))) {
    throw new Error('Reference and current frames must use the same periodic boundary axes.');
  }
  const sites = new WignerSeitzSites(referenceFractional, referenceCell);
  return { frame, referenceFractional, referenceCell, affineMapping, sites,
    mapping: wignerSeitzQueryMapping(frame.cell, referenceCell, affineMapping) };
}

/** Nearest reference site of every current atom in [startAtom, endAtom).
 * Atom ranges are independent, so Worker chunks equal the full calculation. */
export function assignWignerSeitzSites(frame, { referenceFractional, referenceCell, affineMapping = false,
  preparedContext = null, onAtoms = () => {}, ...range } = {}) {
  const startedAt = performance.now();
  const count = frame.fractional?.length / 3;
  if (!Number.isInteger(count) || count < 1) throw new Error('Wigner–Seitz analysis requires at least one current atom.');
  const { startAtom, endAtom } = atomRange(count, range);
  if (preparedContext && (preparedContext.frame !== frame || preparedContext.referenceFractional !== referenceFractional
    || preparedContext.referenceCell !== referenceCell || preparedContext.affineMapping !== affineMapping)) {
    throw new Error('The prepared Wigner–Seitz context does not match its inputs.');
  }
  const { sites, mapping } = preparedContext ?? prepareWignerSeitzContext(frame, { referenceFractional, referenceCell, affineMapping });
  const length = endAtom - startAtom, fractional = frame.fractional, pbc = sites.pbc;
  const siteIndex = new Int32Array(length), siteDistance = new Float64Array(length);
  const M = mapping.matrix, t = mapping.offset;
  let lastProgressAt = performance.now();
  for (let atom = startAtom; atom < endAtom; atom += 1) {
    const index = atom - startAtom;
    if (index % 1024 === 0 && performance.now() - lastProgressAt >= 150) { onAtoms(index, length); lastProgressAt = performance.now(); }
    const f0 = fractional[atom * 3], f1 = fractional[atom * 3 + 1], f2 = fractional[atom * 3 + 2];
    let q0 = f0, q1 = f1, q2 = f2;
    if (!mapping.identity) {
      q0 = t[0] + f0 * M[0] + f1 * M[3] + f2 * M[6];
      q1 = t[1] + f0 * M[1] + f1 * M[4] + f2 * M[7];
      q2 = t[2] + f0 * M[2] + f1 * M[5] + f2 * M[8];
    }
    if (!(Number.isFinite(q0) && Number.isFinite(q1) && Number.isFinite(q2))) throw new Error(`Atom ${atom + 1} has a non-finite coordinate.`);
    if (pbc[0]) q0 -= Math.floor(q0);
    if (pbc[1]) q1 -= Math.floor(q1);
    if (pbc[2]) q2 -= Math.floor(q2);
    siteIndex[index] = sites.nearest(q0, q1, q2);
    siteDistance[index] = Math.sqrt(sites.bestD2);
  }
  onAtoms(length, length);
  return { siteIndex, siteDistance, startAtom, endAtom, siteCount: sites.count, elapsedMs: performance.now() - startedAt };
}

/** Occupancies, classes and counts from complete site assignments. Element
 * types are compared by label, so the reference and current frames may number
 * their types differently. Integer counting in atom order is deterministic.
 *
 * - occupancy: atoms assigned to a site; vacancy: occupancy 0.
 * - interstitials: Σ (occupancy − 1) over sites with occupancy ≥ 2 (excess atoms).
 * - antisite: a site with occupancy 1 whose atom's type differs from the site type.
 * The atom count minus the site count equals interstitials minus vacancies. */
export function summarizeWignerSeitz({ siteIndex, siteCount, currentTypes, currentTypeLabels, referenceTypes, referenceTypeLabels }) {
  const atomCount = siteIndex?.length;
  if (!Number.isInteger(atomCount) || atomCount < 1 || !Number.isInteger(siteCount) || siteCount < 1) {
    throw new Error('Wigner–Seitz assignments are incomplete.');
  }
  if (!ArrayBuffer.isView(currentTypes) || currentTypes.length !== atomCount) throw new Error('Wigner–Seitz analysis requires one type per current atom.');
  if (!ArrayBuffer.isView(referenceTypes) || referenceTypes.length !== siteCount) throw new Error('Wigner–Seitz analysis requires one type per reference site.');
  if (!Array.isArray(currentTypeLabels) || !Array.isArray(referenceTypeLabels)) throw new Error('Wigner–Seitz analysis requires element labels.');
  const referenceByLabel = new Map();
  referenceTypeLabels.forEach((label, type) => { if (!referenceByLabel.has(String(label))) referenceByLabel.set(String(label), type); });
  const currentToReference = Int32Array.from(currentTypeLabels, label => referenceByLabel.get(String(label)) ?? -1);
  const labels = [...referenceTypeLabels.map(String)];
  for (const label of currentTypeLabels.map(String)) if (!labels.includes(label)) labels.push(label);
  const rowOfReference = Int32Array.from(referenceTypeLabels, label => labels.indexOf(String(label)));
  const rowOfCurrent = Int32Array.from(currentTypeLabels, label => labels.indexOf(String(label)));

  const siteOccupancy = new Uint32Array(siteCount);
  for (let atom = 0; atom < atomCount; atom += 1) {
    const site = siteIndex[atom];
    if (!(site >= 0 && site < siteCount)) throw new Error('A Wigner–Seitz assignment is outside the reference sites.');
    siteOccupancy[site] += 1;
  }
  // Atoms grouped by site in ascending atom order (a stable counting sort).
  const siteAtomOffsets = new Uint32Array(siteCount + 1);
  for (let site = 0; site < siteCount; site += 1) siteAtomOffsets[site + 1] = siteAtomOffsets[site] + siteOccupancy[site];
  const siteAtoms = new Uint32Array(atomCount), cursor = siteAtomOffsets.slice(0, siteCount);
  for (let atom = 0; atom < atomCount; atom += 1) siteAtoms[cursor[siteIndex[atom]]++] = atom;

  const rows = labels.map(label => ({ label, sites: 0, atoms: 0, vacancies: 0, antisites: 0, antisiteAtoms: 0, sharedSiteAtoms: 0 }));
  const siteTypeCounts = new Float64Array(referenceTypeLabels.length), atomTypeCounts = new Float64Array(currentTypeLabels.length);
  for (let site = 0; site < siteCount; site += 1) {
    const type = referenceTypes[site];
    if (!(type >= 0 && type < siteTypeCounts.length)) throw new Error('A reference site has an unknown type.');
    siteTypeCounts[type] += 1;
  }
  for (let atom = 0; atom < atomCount; atom += 1) {
    const type = currentTypes[atom];
    if (!(type >= 0 && type < atomTypeCounts.length)) throw new Error('A current atom has an unknown type.');
    atomTypeCounts[type] += 1;
  }
  siteTypeCounts.forEach((count, type) => { rows[rowOfReference[type]].sites += count; });
  atomTypeCounts.forEach((count, type) => { rows[rowOfCurrent[type]].atoms += count; });
  const siteClass = new Uint8Array(siteCount);
  let vacancyCount = 0, interstitialCount = 0, antisiteCount = 0, multiplyOccupiedSites = 0, sharedSiteAtoms = 0, defectSiteCount = 0;
  for (let site = 0; site < siteCount; site += 1) {
    const occupancy = siteOccupancy[site], type = referenceTypes[site];
    if (occupancy === 0) {
      siteClass[site] = SITE_VACANCY; vacancyCount += 1; rows[rowOfReference[type]].vacancies += 1;
    } else if (occupancy === 1) {
      const atomType = currentTypes[siteAtoms[siteAtomOffsets[site]]];
      if (currentToReference[atomType] === type) { siteClass[site] = SITE_REGULAR; continue; }
      siteClass[site] = SITE_ANTISITE; antisiteCount += 1;
      rows[rowOfReference[type]].antisites += 1; rows[rowOfCurrent[atomType]].antisiteAtoms += 1;
    } else {
      siteClass[site] = SITE_INTERSTITIAL; multiplyOccupiedSites += 1;
      interstitialCount += occupancy - 1; sharedSiteAtoms += occupancy;
      for (let slot = siteAtomOffsets[site]; slot < siteAtomOffsets[site + 1]; slot += 1) rows[rowOfCurrent[currentTypes[siteAtoms[slot]]]].sharedSiteAtoms += 1;
    }
    defectSiteCount += 1;
  }
  const defectSites = new Uint32Array(defectSiteCount);
  for (let site = 0, cursorIndex = 0; site < siteCount; site += 1) if (siteClass[site] !== SITE_REGULAR) defectSites[cursorIndex++] = site;
  const atomOccupancy = new Uint32Array(atomCount), atomClass = new Uint8Array(atomCount), atomSiteType = new Uint32Array(atomCount);
  for (let atom = 0; atom < atomCount; atom += 1) {
    const site = siteIndex[atom];
    atomOccupancy[atom] = siteOccupancy[site];
    atomClass[atom] = ATOM_CLASS_OF_SITE[siteClass[site]];
    atomSiteType[atom] = referenceTypes[site];
  }
  return { atomCount, siteCount, siteOccupancy, siteClass, siteAtomOffsets, siteAtoms, defectSites,
    atomOccupancy, atomClass, atomSiteType, vacancyCount, interstitialCount, antisiteCount, multiplyOccupiedSites,
    sharedSiteAtoms, regularSiteCount: siteCount - defectSiteCount, typeLabels: labels, typeSummary: rows,
    referenceTypeLabels: referenceTypeLabels.map(String), currentTypeLabels: currentTypeLabels.map(String) };
}

/** Assignments plus summary, shared by the direct and Worker pool paths. */
export function finishWignerSeitz(frame, { siteIndex, siteDistance, siteCount }, { referenceTypes, referenceTypeLabels, affineMapping = false }) {
  return { siteIndex, siteDistance, affineMapping, ...summarizeWignerSeitz({ siteIndex, siteCount,
    currentTypes: frame.types, currentTypeLabels: frame.typeLabels, referenceTypes, referenceTypeLabels }) };
}

/** Complete single-threaded calculation; the Worker pool returns identical arrays. */
export function calculateWignerSeitz(frame, reference, { affineMapping = false, onAtoms } = {}) {
  const assigned = assignWignerSeitzSites(frame, { referenceFractional: reference.fractional, referenceCell: reference.cell, affineMapping, onAtoms });
  return finishWignerSeitz(frame, assigned, { referenceTypes: reference.types, referenceTypeLabels: reference.typeLabels, affineMapping });
}

/** Per-type occupancy of one site: counts of assigned atoms by current type. */
export function siteTypeOccupancy(result, site, currentTypes, typeCount, output = new Uint32Array(typeCount)) {
  output.fill(0);
  for (let slot = result.siteAtomOffsets[site]; slot < result.siteAtomOffsets[site + 1]; slot += 1) output[currentTypes[result.siteAtoms[slot]]] += 1;
  return output;
}

/** Full sites × current types occupancy table (row-major). */
export function typeOccupancyMatrix(result, currentTypes, typeCount) {
  const matrix = new Uint32Array(result.siteCount * typeCount);
  for (let site = 0; site < result.siteCount; site += 1) {
    for (let slot = result.siteAtomOffsets[site]; slot < result.siteAtomOffsets[site + 1]; slot += 1) {
      matrix[site * typeCount + currentTypes[result.siteAtoms[slot]]] += 1;
    }
  }
  return matrix;
}

/** Cartesian positions of the given sites in the current frame. With affine
 * mapping (or identical cells) a site's reduced coordinates are placed in the
 * current cell; otherwise it keeps its reference Cartesian position. */
export function wignerSeitzSitePositions(referenceFractional, referenceCell, currentCell, sites, { affineMapping = false } = {}) {
  const cell = affineMapping ? currentCell : referenceCell;
  const { origin, vectors: h } = cell, positions = new Float64Array(sites.length * 3);
  const o0 = origin?.[0] ?? 0, o1 = origin?.[1] ?? 0, o2 = origin?.[2] ?? 0;
  for (let index = 0; index < sites.length; index += 1) {
    const site = sites[index], a = referenceFractional[site * 3], b = referenceFractional[site * 3 + 1], c = referenceFractional[site * 3 + 2];
    positions[index * 3] = o0 + a * h[0] + b * h[3] + c * h[6];
    positions[index * 3 + 1] = o1 + a * h[1] + b * h[4] + c * h[7];
    positions[index * 3 + 2] = o2 + a * h[2] + b * h[5] + c * h[8];
  }
  return positions;
}
