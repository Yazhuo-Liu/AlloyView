// Metallic radii for the primary alloy elements; covalent radii are used for
// light interstitials. Values are visualization defaults in angstroms, not
// pair-specific analysis cutoffs.
const ELEMENT_RADII = Object.freeze({
  H: 0.31, C: 0.76, N: 0.71, O: 0.66,
  Al: 1.43, Cr: 1.28, Cu: 1.28, Fe: 1.26, Mg: 1.60, Mn: 1.27,
  Mo: 1.39, Nb: 1.46, Ni: 1.24, Si: 1.11, Ti: 1.47, V: 1.34,
  W: 1.39, Zn: 1.34, Zr: 1.60, Co: 1.25, Ta: 1.46, Pb: 1.75,
});

const DEFAULT_RADIUS = 1.25;

export function radiiByType(frame) {
  const byType = frame.typeLabels.map((label) => ELEMENT_RADII[normalizeElement(label)] ?? DEFAULT_RADIUS);
  const radii = new Float32Array(frame.types.length);
  for (let atom = 0; atom < frame.types.length; atom += 1) radii[atom] = byType[frame.types[atom]] ?? DEFAULT_RADIUS;
  return radii;
}

export function radiusForElement(label) {
  return ELEMENT_RADII[normalizeElement(label)] ?? DEFAULT_RADIUS;
}

export function normalizeRadiusPercent(rawValue, {
  source = 'number',
  sliderMinimum = 20,
  sliderMaximum = 200,
  inputMinimum = 5,
  inputMaximum = 500,
} = {}) {
  if (String(rawValue).trim() === '') return null;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return null;
  const minimum = source === 'slider' ? sliderMinimum : inputMinimum;
  const maximum = source === 'slider' ? sliderMaximum : inputMaximum;
  const percentage = Math.max(minimum, Math.min(maximum, Math.round(parsed)));
  return {
    percentage,
    sliderPercentage: Math.max(sliderMinimum, Math.min(sliderMaximum, percentage)),
  };
}

function normalizeElement(label) {
  const match = String(label).trim().match(/^([A-Z][a-z]?)(?:\b|\d|$)/);
  return match?.[1] ?? '';
}
