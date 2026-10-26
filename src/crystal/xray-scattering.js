import { XRAY_IT92_COEFFICIENTS } from './xray-scattering-data.js';

export const XRAY_SCATTERING_SYMBOLS = Object.freeze(Object.keys(XRAY_IT92_COEFFICIENTS));
// Gemmi documents the IT92 four-Gaussian approximation for sin(theta)/lambda
// strictly below 2 inverse angstroms; do not extrapolate a fit outside its range.
export const XRAY_SCATTERING_MAX_S = 2;
export const SCATTERING_MAX_S = XRAY_SCATTERING_MAX_S;

/** Immutable [a1,a2,a3,a4,b1,b2,b3,b4,c] for a neutral, identified atom.
 * No prefix matching: Type 1, Fe2+, numbered labels and unknown chemistry do
 * not silently acquire a neutral-atom structure factor. */
export function getXrayScatteringCoefficients(symbol) {
  if (typeof symbol !== 'string' || !Object.hasOwn(XRAY_IT92_COEFFICIENTS, symbol)) {
    throw new Error(`X-ray scattering: unsupported neutral element ${JSON.stringify(symbol)}. Use explicit element symbols H through Cf.`);
  }
  return XRAY_IT92_COEFFICIENTS[symbol];
}

/** Nonresonant elastic atomic amplitude in electrons:
 * f0(s) = Σ_j a_j exp(-b_j s²) + c, s = sin(theta)/lambda = |g|/2.
 * Coefficients are published fits; f0(0) is close to Z, not forced to equal Z.
 * Anomalous dispersion and ionic scattering factors are not included. */
export function xrayScatteringFactor(symbol, s) {
  const coefficients = getXrayScatteringCoefficients(symbol);
  if (!Number.isFinite(s) || s < 0 || s >= XRAY_SCATTERING_MAX_S) {
    throw new Error('X-ray scattering: sin(theta)/lambda must be finite and satisfy 0 ≤ s < 2 Å⁻¹.');
  }
  const squared = s * s;
  let value = coefficients[8];
  for (let j = 0; j < 4; j++) value += coefficients[j] * Math.exp(-coefficients[j + 4] * squared);
  if (!Number.isFinite(value) || value < 0) throw new Error('X-ray scattering: the tabulated fit produced an invalid amplitude.');
  return value;
}
