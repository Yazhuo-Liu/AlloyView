// Metallic radii in Angstroms for the elements most commonly encountered in
// AlloyView's target systems. The recommendation is only an initial UI value;
// coordination analysis always uses the explicit cutoff selected by the user.
const METALLIC_RADII = Object.freeze({
  Ag: 1.44, Al: 1.43, Au: 1.44, Co: 1.25, Cr: 1.28, Cu: 1.28,
  Fe: 1.24, Mg: 1.60, Mn: 1.27, Mo: 1.39, Nb: 1.46, Ni: 1.24,
  Pb: 1.75, Pd: 1.37, Pt: 1.39, Sn: 1.58, Ti: 1.47, V: 1.34,
  W: 1.39, Zn: 1.34, Zr: 1.60,
});

const FALLBACK_CUTOFF = 3.0;
const FIRST_SHELL_PADDING = 1.15;

export function recommendCoordinationCutoff(frame) {
  const labels = [...new Set(frame.typeLabels)];
  const radii = labels.map((label) => METALLIC_RADII[label]);
  if (labels.length === 0 || radii.some((radius) => !Number.isFinite(radius))) {
    return {
      value: FALLBACK_CUTOFF,
      method: 'fallback',
      message: '3.00 Å fallback: chemical element symbols are not available for every atom type.',
    };
  }

  // A single global cutoff must cover the largest possible pair in an alloy.
  // The 15% padding tolerates moderate strain/thermal motion without pretending
  // to be a phase-aware first-minimum determination from g(r).
  const largestPair = 2 * Math.max(...radii);
  const value = Number((Math.round(largestPair * FIRST_SHELL_PADDING / 0.05) * 0.05).toFixed(2));
  return {
    value,
    method: 'metallic-radii',
    message: `${value.toFixed(2)} Å estimate from ${labels.join('/')} metallic radii; verify against the first minimum of g(r).`,
  };
}
