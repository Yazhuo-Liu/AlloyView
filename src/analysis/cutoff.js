import { ELEMENT_LATTICES } from './lattice.js';

// Keep AlloyView's original metallic-radius recommendations stable. The
// recommendation is an initial UI value; coordination always uses the explicit
// cutoff selected by the user, rather than silently using pair-specific values.
const METALLIC_RADII = Object.freeze({
  Ag: 1.44, Al: 1.43, Au: 1.44, Co: 1.25, Cr: 1.28, Cu: 1.28,
  Fe: 1.24, Mg: 1.60, Mn: 1.27, Mo: 1.39, Nb: 1.46, Ni: 1.24,
  Pb: 1.75, Pd: 1.37, Pt: 1.39, Sn: 1.58, Ti: 1.47, V: 1.34,
  W: 1.39, Zn: 1.34, Zr: 1.60,
});

const FALLBACK_CUTOFF = 3.0;
const FIRST_SHELL_PADDING = 1.15;
const LATTICE_SOURCE = 'ASE 3.26.0 reference-state lattice parameters';
const ELEMENT_NAMES = Object.freeze({
  Ag: 'Silver', Al: 'Aluminium', Au: 'Gold', Be: 'Beryllium', Ca: 'Calcium',
  Cd: 'Cadmium', Co: 'Cobalt', Cr: 'Chromium', Cu: 'Copper', Fe: 'Iron',
  Hf: 'Hafnium', Ir: 'Iridium', Li: 'Lithium', Mg: 'Magnesium',
  Mn: 'Manganese', Mo: 'Molybdenum', Na: 'Sodium', Nb: 'Niobium',
  Ni: 'Nickel', Os: 'Osmium', Pb: 'Lead', Pd: 'Palladium', Pt: 'Platinum',
  Re: 'Rhenium', Rh: 'Rhodium', Ru: 'Ruthenium', Sc: 'Scandium', Sn: 'Tin',
  Ta: 'Tantalum', Ti: 'Titanium', V: 'Vanadium', W: 'Tungsten',
  Y: 'Yttrium', Zn: 'Zinc', Zr: 'Zirconium',
});

function paddedCutoff(distance) {
  return Number((Math.round(distance * FIRST_SHELL_PADDING / 0.05) * 0.05).toFixed(2));
}

function latticeFirstShellDistance(reference) {
  if (reference.structure === 1) return reference.a / Math.SQRT2;
  if (reference.structure === 3) return Math.sqrt(3) * reference.a / 2;
  // Nonideal HCP c/a ratios split the twelve neighbors into basal and
  // interlayer distances. Include both groups in this editable starting value.
  if (reference.structure === 2) {
    return Math.max(reference.a, Math.hypot(reference.a / Math.sqrt(3), reference.c / 2));
  }
  throw new Error('Unsupported coordination cutoff reference lattice.');
}

// Symbols are deliberately explicit: element recognition must come from file
// metadata, not a filename, a numeric atom type, or a similar-looking label.
// Values are heuristics (15% padding, rounded to 0.05 Å), not measured minima
// of g(r). New presets use the same referenced lattice data as ideal strain.
export const COORDINATION_CUTOFF_PRESETS = Object.freeze(
  Object.entries(ELEMENT_NAMES).map(([symbol, name]) => {
    const radius = METALLIC_RADII[symbol];
    const usesRadius = Number.isFinite(radius);
    const reference = ELEMENT_LATTICES[symbol];
    let cutoff = paddedCutoff(usesRadius ? 2 * radius : latticeFirstShellDistance(reference));
    // For BCC, the second shell is only 15.5% farther away. Rounding a new
    // first-shell preset up must not accidentally include that shell (Li).
    if (!usesRadius && reference.structure === 3 && cutoff >= reference.a) {
      cutoff = Number((Math.floor((reference.a - 1e-9) / 0.05) * 0.05).toFixed(2));
    }
    return Object.freeze({
      symbol,
      name,
      cutoff,
      method: usesRadius ? 'metallic-radii' : 'lattice-reference',
      source: usesRadius ? 'AlloyView metallic-radius estimate (2r)' : LATTICE_SOURCE,
    });
  }),
);

const PRESETS_BY_SYMBOL = new Map(COORDINATION_CUTOFF_PRESETS.map(preset => [preset.symbol, preset]));

export function coordinationCutoffPresetForElement(label) {
  const symbol = typeof label === 'string' ? label.trim() : '';
  return PRESETS_BY_SYMBOL.get(symbol) ?? null;
}

function presentElementLabels(frame) {
  const labels = frame?.typeLabels ?? [];
  // Frame parsers may retain labels for types absent from this frame. Such
  // labels must not force an alloy suggestion or an unknown-element fallback.
  if (frame?.types && Number.isInteger(frame.types.length)) {
    const present = new Set();
    let unknownType = false;
    for (const type of frame.types) {
      if (Number.isInteger(type) && type >= 0 && type < labels.length) present.add(type);
      else unknownType = true;
      // Once all declared types occur, the available-element set is complete;
      // common single-element frames therefore inspect just their first atom.
      if (present.size === labels.length) break;
    }
    const active = labels.filter((_, type) => present.has(type));
    if (unknownType) active.push('');
    return [...new Set(active.map(label => typeof label === 'string' ? label.trim() : ''))];
  }
  return [...new Set(labels.map(label => typeof label === 'string' ? label.trim() : ''))];
}

export function inferCoordinationCutoffPreset(frame) {
  const elements = presentElementLabels(frame);
  const presets = elements.map(coordinationCutoffPresetForElement);
  const mixed = elements.length > 1;
  if (presets.length === 0 || presets.some(preset => preset === null)) {
    return {
      symbol: null,
      elements,
      mixed,
      value: FALLBACK_CUTOFF,
      method: 'fallback',
      message: '3.00 Å fallback: chemical element symbols are not available for every atom type.',
    };
  }

  // Preserve the existing global-cutoff rule for alloys: select the largest
  // constituent estimate. Its symbol identifies the preset used, not a claim
  // that every atom in a mixed structure is that element.
  const selected = presets.reduce((largest, preset) => preset.cutoff > largest.cutoff ? preset : largest);
  const method = presets.every(preset => preset.method === 'metallic-radii')
    ? 'metallic-radii'
    : presets.every(preset => preset.method === 'lattice-reference') ? 'lattice-reference' : 'element-presets';
  const description = method === 'metallic-radii' ? 'metallic radii' : 'element reference distances';
  return {
    symbol: selected.symbol,
    elements,
    mixed,
    value: selected.cutoff,
    method,
    message: `${selected.cutoff.toFixed(2)} Å estimate from ${elements.join('/')} ${description}${mixed ? `; uses the largest constituent preset (${selected.symbol})` : ''}; verify against the first minimum of g(r).`,
  };
}

export function recommendCoordinationCutoff(frame) {
  const { value, method, message } = inferCoordinationCutoffPreset(frame);
  return { value, method, message };
}
