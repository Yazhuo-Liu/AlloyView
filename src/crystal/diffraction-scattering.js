import { ELECTRON_C4322_COEFFICIENTS, NEUTRON92_SCATTERING_LENGTHS } from './diffraction-scattering-data.js';

export const ELECTRON_SCATTERING_SYMBOLS = Object.freeze(Object.keys(ELECTRON_C4322_COEFFICIENTS));
// Gemmi's shorthand element entries for these species actually specify the
// isotopes 99Tc, 147Pm, 226Ra, 231Pa, 237Np, 243Am and 244Cm. This API does not
// silently substitute an isotope for an unspecified elemental composition.
const isotopeSpecificElements = new Set(['Tc', 'Pm', 'Ra', 'Pa', 'Np', 'Am', 'Cm']);
export const NEUTRON_SCATTERING_SYMBOLS = Object.freeze(Object.keys(NEUTRON92_SCATTERING_LENGTHS)
  .filter(symbol => !isotopeSpecificElements.has(symbol)));
// ITC 2011 table 4.3.2.2 explicitly fits neutral atoms up to 2 Å⁻¹.
export const ELECTRON_SCATTERING_MAX_S = 2;

/** Immutable [a1..a5,b1..b5] for a neutral, identified atom. No constant term,
 * atomic-number fallback or Mott–Bethe subtraction is involved. */
export function getElectronScatteringCoefficients(symbol) {
  if (typeof symbol !== 'string' || !Object.hasOwn(ELECTRON_C4322_COEFFICIENTS, symbol)) {
    throw new Error(`Electron scattering: unsupported neutral element ${JSON.stringify(symbol)}. Use explicit element symbols H through Cf.`);
  }
  return ELECTRON_C4322_COEFFICIENTS[symbol];
}

/** Neutral-atom elastic amplitude in Å, under the kinematical approximation:
 * fe(s) = Σ_j a_j exp(-b_j s²), s = sin(theta)/lambda = |g|/2 in Å⁻¹.
 * This direct five-Gaussian fit is finite at s=0. It does not model dynamical
 * electron diffraction, ionic potentials or multiple scattering. */
export function electronScatteringFactor(symbol, s) {
  const coefficients = getElectronScatteringCoefficients(symbol);
  if (!Number.isFinite(s) || s < 0 || s > ELECTRON_SCATTERING_MAX_S) {
    throw new Error('Electron scattering: sin(theta)/lambda must be finite and satisfy 0 ≤ s ≤ 2 Å⁻¹.');
  }
  const squared = s * s;
  let value = 0;
  for (let j = 0; j < 5; j++) value += coefficients[j] * Math.exp(-coefficients[j + 5] * squared);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Electron scattering: the tabulated fit produced an invalid amplitude.');
  return value;
}

/** Signed real bound coherent nuclear scattering length in fm. Element labels
 * use the source table's elemental composition; explicit D is deuterium, not
 * natural hydrogen. Zero-coded unavailable rows are rejected, never guessed.
 * Absorption, incoherent scattering and magnetic scattering are not included. */
export function getNeutronScatteringLength(symbol) {
  if (isotopeSpecificElements.has(symbol)) {
    throw new Error(`Neutron scattering: ${symbol} requires an explicit isotope choice; its tabulated default is not a natural-element mixture. Isotope-specific scattering is currently supported only for D (deuterium).`);
  }
  if (typeof symbol !== 'string' || !Object.hasOwn(NEUTRON92_SCATTERING_LENGTHS, symbol)) {
    throw new Error(`Neutron scattering: no tabulated coherent length for ${JSON.stringify(symbol)}. Use a supported element symbol or explicit D (deuterium); other isotope labels are not supported.`);
  }
  return NEUTRON92_SCATTERING_LENGTHS[symbol];
}

/** The nonresonant coherent nuclear amplitude is independent of s. */
export function neutronScatteringFactor(symbol, s) {
  const value = getNeutronScatteringLength(symbol);
  if (!Number.isFinite(s) || s < 0) throw new Error('Neutron scattering: sin(theta)/lambda must be finite and nonnegative.');
  return value;
}

/** Relativistic de Broglie wavelength in Å from kinetic energy in keV.
 * λ = hc / sqrt(E (E + 2 m_e c²)); exact SI h, c, e, and CODATA 2022 m_e.
 * Energy changes diffraction angles. C4322's common relativistic amplitude
 * multiplier cancels in normalized intensities and is not applied here. */
export function electronWavelengthFromEnergy(energyKeV) {
  if (!Number.isFinite(energyKeV) || energyKeV <= 0) throw new Error('Electron kinetic energy must be finite and positive, in keV.');
  const planck = 6.62607015e-34;
  const speedOfLight = 299792458;
  const elementaryCharge = 1.602176634e-19;
  const electronMass = 9.1093837139e-31;
  const energyJ = energyKeV * 1000 * elementaryCharge;
  // Factoring the square root avoids overflowing E(E+2mc²) for valid inputs.
  const momentumC = Math.sqrt(energyJ) * Math.sqrt(energyJ + 2 * electronMass * speedOfLight * speedOfLight);
  const wavelength = planck * speedOfLight / momentumC * 1e10;
  if (!Number.isFinite(wavelength) || wavelength <= 0) throw new Error('Electron kinetic energy cannot be represented as a finite positive wavelength.');
  return wavelength;
}
