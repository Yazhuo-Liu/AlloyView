// Radical (power, Laguerre) Voronoi radii shared by the CPU and GPU engines and
// the analysis panel. No Wasm/native dependencies.
//
// The face between sites i and j lies on |x − pᵢ|² − rᵢ² = |x − pⱼ|² − rⱼ².
// Relative to pᵢ, with d = pⱼ − pᵢ, that is the plane x·d = (|d|² + rᵢ² − rⱼ²)/2,
// the perpendicular bisector shifted by (rᵢ² − rⱼ²)/(2|d|) along d. Equal radii
// give exactly the ordinary bisector, so the Voronoi tessellation is a special case.

import { radiusForElement } from '../render/atomic-radii.js';

/** Per-atom radii must be finite and nonnegative, one per tessellation site. */
export function validateVoronoiRadii(radii, count) {
  if (!ArrayBuffer.isView(radii) && !Array.isArray(radii)) throw new Error('Radical Voronoi radii must be a numeric array.');
  if (radii.length !== count) throw new Error(`Radical Voronoi needs one radius per analyzed atom (${count}), not ${radii.length}.`);
  for (let atom = 0; atom < count; atom++) {
    const value = radii[atom];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`Radical Voronoi radius of analyzed atom ${atom + 1} must be finite and nonnegative.`);
    }
  }
}

/** Squared radii in Å² and in the kernel's dimensionless length units. */
export function radicalWeights(radii, areaScale) {
  const count = radii.length, squared = new Float64Array(count), weights = new Float64Array(count);
  let minRadius = Infinity, maxRadius = -Infinity, maxSquared = 0;
  for (let atom = 0; atom < count; atom++) {
    const radius = radii[atom], value = radius * radius;
    squared[atom] = value; weights[atom] = value / areaScale;
    minRadius = Math.min(minRadius, radius); maxRadius = Math.max(maxRadius, radius); maxSquared = Math.max(maxSquared, value);
  }
  return { squared, weights, maxSquared, maxWeight: maxSquared / areaScale, minRadius, maxRadius };
}

/** A radical plane of site j cuts the cell of site i only if some cell vertex
 * v satisfies v·d > (|d|² + rᵢ² − rⱼ²)/2. With |v| ≤ R and rⱼ ≤ r_max this
 * needs |d|² − 2R|d| − (r_max² − rᵢ²) < 0, so every relevant site lies within
 * R + √(R² + r_max² − rᵢ²). Equal radii give the unweighted bound 2R. */
export function radicalReach(farthest, spreadSquared) {
  return farthest + Math.sqrt(farthest * farthest + Math.max(0, spreadSquared));
}

/** Expand a per-type radius table, keyed by type label, to the source atoms. */
export function voronoiRadiiForTypes(frame, typeRadii = []) {
  const count = frame.fractional.length / 3, byLabel = new Map();
  for (const entry of typeRadii ?? []) byLabel.set(entry.label, entry.radius);
  const labels = frame.typeLabels ?? [], byType = labels.map(label => byLabel.has(label) ? byLabel.get(label) : radiusForElement(label));
  const radii = new Float64Array(count);
  for (let atom = 0; atom < count; atom++) {
    const type = frame.types?.[atom];
    if (!Number.isInteger(type) || type < 0 || type >= byType.length) throw new Error(`Atom ${atom + 1} has no labeled type for a per-type radius.`);
    radii[atom] = byType[type];
  }
  return radii;
}

/** A content fingerprint for cache keys; weighted and unweighted results, or
 * results for different radii, never share an entry. */
export function voronoiRadiiFingerprint(radii) {
  if (radii == null) return null;
  const values = Float64Array.from(radii), words = new Uint32Array(values.buffer);
  let first = 0x811c9dc5, second = 0x01000193 ^ values.length;
  for (let index = 0; index < words.length; index++) {
    first = Math.imul(first ^ words[index], 0x01000193) >>> 0;
    second = Math.imul(second ^ words[words.length - 1 - index], 0x5bd1e995) >>> 0;
  }
  return `${values.length}:${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}
