import { invert3 } from '../data/model.js';

// Standard crystallographic displacement convention:
// exp[-2π² Σ h_i h_j a*_i a*_j U_ij]. Cell vectors are rows.
export const THERMAL_COMPONENTS = Object.freeze(['xx', 'yy', 'zz', 'xy', 'xz', 'yz']);
export const THERMAL_PROPERTY_NAMES = Object.freeze(THERMAL_COMPONENTS.map(name => `displacementU${name}`));
export const THERMAL_DEFAULTS = Object.freeze({ enabled: false, probability: 0.5, opacity: 0.8 });
const matrix = u => [u[0], u[3], u[4], u[3], u[1], u[5], u[4], u[5], u[2]];
const components = m => new Float64Array([m[0], m[4], m[8], (m[1] + m[3]) / 2, (m[2] + m[6]) / 2, (m[5] + m[7]) / 2]);
const transpose = a => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
function multiply(a, b) {
  const out = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return out;
}
export function transformThermalTensor(u, transform) {
  return components(multiply(multiply(transform, matrix(u)), transpose(transform)));
}
function crystallographicBasis(cell) {
  const h = cell.vectors ?? cell, inverse = invert3(h);
  const reciprocal = [0, 1, 2].map(i => Math.hypot(inverse[i], inverse[3 + i], inverse[6 + i]));
  return [h[0] * reciprocal[0], h[3] * reciprocal[1], h[6] * reciprocal[2],
    h[1] * reciprocal[0], h[4] * reciprocal[1], h[7] * reciprocal[2],
    h[2] * reciprocal[0], h[5] * reciprocal[1], h[8] * reciprocal[2]];
}
export function cifThermalToCartesian(u, cell) { return transformThermalTensor(u, crystallographicBasis(cell)); }
export function cartesianThermalToCif(u, cell) { return transformThermalTensor(u, invert3(crystallographicBasis(cell))); }
export function thermalSymmetryTransform(rotation, cell) {
  const h = transpose(cell.vectors ?? cell);
  return multiply(multiply(h, rotation), invert3(h));
}
export function rotateThermalTensor(u, rotation, cell) {
  return transformThermalTensor(u, thermalSymmetryTransform(rotation, cell));
}

/** Original Jacobi diagonalization of a real symmetric 3×3 covariance matrix. */
export function thermalEllipsoidAxes(u) {
  if (u.length !== 6 || !Array.from(u).every(Number.isFinite)) throw new Error('Thermal displacement tensors require six finite components.');
  const a = matrix(u), v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const scale = Math.max(...a.map(Math.abs));
  if (scale === 0) return { axes: new Float32Array(9), radius: 0, valid: false };
  for (let i = 0; i < 9; i++) a[i] /= scale;
  for (let iteration = 0; iteration < 32; iteration++) {
    let p = 0, q = 1;
    for (const [i, j] of [[0, 2], [1, 2]]) if (Math.abs(a[i * 3 + j]) > Math.abs(a[p * 3 + q])) { p = i; q = j; }
    const apq = a[p * 3 + q];
    if (Math.abs(apq) < 2e-15) break;
    const theta = 0.5 * Math.atan2(2 * apq, a[q * 3 + q] - a[p * 3 + p]);
    const c = Math.cos(theta), s = Math.sin(theta), app = a[p * 3 + p], aqq = a[q * 3 + q];
    for (let k = 0; k < 3; k++) if (k !== p && k !== q) {
      const akp = a[k * 3 + p], akq = a[k * 3 + q];
      a[k * 3 + p] = a[p * 3 + k] = c * akp - s * akq;
      a[k * 3 + q] = a[q * 3 + k] = s * akp + c * akq;
    }
    a[p * 3 + p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q * 3 + q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p * 3 + q] = a[q * 3 + p] = 0;
    for (let k = 0; k < 3; k++) {
      const vp = v[k * 3 + p], vq = v[k * 3 + q];
      v[k * 3 + p] = c * vp - s * vq; v[k * 3 + q] = s * vp + c * vq;
    }
  }
  const eigenvalues = [a[0], a[4], a[8]];
  if (eigenvalues.some(value => value < -1e-10)) throw new Error('Thermal displacement tensor is not positive semidefinite.');
  // Singular ellipsoids have no volume and cannot be rendered as closed surfaces.
  if (eigenvalues.some(value => value <= 0)) return { axes: new Float32Array(9), radius: 0, valid: false };
  const axes = new Float32Array(9);
  for (let axis = 0; axis < 3; axis++) for (let k = 0; k < 3; k++) axes[axis * 3 + k] = v[k * 3 + axis] * Math.sqrt(eigenvalues[axis] * scale);
  if (!Array.from(axes).every(Number.isFinite)) throw new Error('Thermal ellipsoid exceeds the supported display range.');
  return { axes, radius: Math.sqrt(Math.max(...eigenvalues) * scale), valid: true };
}

// CDF of χ₃ using the convergent incomplete-gamma series (no external library).
function chi3Cdf(x) {
  const z = x / 2;
  let term = 1 / 1.5, sum = term;
  for (let n = 1; n < 200; n++) { term *= z / (1.5 + n); sum += term; if (term < sum * 1e-16) break; }
  return Math.min(1, Math.exp(-z + 1.5 * Math.log(z) - Math.log(Math.sqrt(Math.PI) / 2)) * sum);
}
export function thermalProbabilityScale(probability) {
  if (!Number.isFinite(probability) || probability < 0.01 || probability > 0.99) throw new Error('Thermal probability must be between 1% and 99%.');
  let low = 0, high = 32;
  for (let i = 0; i < 60; i++) { const middle = (low + high) / 2; if (chi3Cdf(middle) < probability) low = middle; else high = middle; }
  return Math.sqrt((low + high) / 2);
}
