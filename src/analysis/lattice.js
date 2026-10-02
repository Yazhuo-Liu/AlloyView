// Conventional lattice parameters in Å: ASE 3.26.0 reference-state data.
// https://gitlab.com/ase/ase/-/blob/3.26.0/ase/data/__init__.py
// These are editable reference values, not predictions for an alloy/temperature.
export const ELEMENT_LATTICES = Object.freeze({
  Al: { structure: 1, a: 4.05 }, Cu: { structure: 1, a: 3.61 },
  Ni: { structure: 1, a: 3.52 }, Ag: { structure: 1, a: 4.09 },
  Au: { structure: 1, a: 4.08 }, Pb: { structure: 1, a: 4.95 },
  Pd: { structure: 1, a: 3.89 }, Pt: { structure: 1, a: 3.92 },
  Fe: { structure: 3, a: 2.87 }, Cr: { structure: 3, a: 2.88 },
  W: { structure: 3, a: 3.16 }, Mo: { structure: 3, a: 3.15 },
  Nb: { structure: 3, a: 3.30 }, Ta: { structure: 3, a: 3.31 },
  V: { structure: 3, a: 3.02 }, Li: { structure: 3, a: 3.49 },
  Mg: { structure: 2, a: 3.21, c: 3.21 * 1.624 }, Ti: { structure: 2, a: 2.95, c: 2.95 * 1.588 },
  Zn: { structure: 2, a: 2.66, c: 2.66 * 1.856 }, Co: { structure: 2, a: 2.51, c: 2.51 * 1.622 },
  Zr: { structure: 2, a: 3.23, c: 3.23 * 1.593 }, Hf: { structure: 2, a: 3.20, c: 3.20 * 1.582 },
  Si: { structure: 6, a: 5.43 }, Ge: { structure: 6, a: 5.66 },
  C: { structure: 6, a: 3.57 }, Be: { structure: 2, a: 2.29, c: 2.29 * 1.567 },
  Na: { structure: 3, a: 4.23 }, Ca: { structure: 1, a: 5.58 }, Po: { structure: 5, a: 3.35 },
  Rh: { structure: 1, a: 3.80 }, Ir: { structure: 1, a: 3.84 },
  Ru: { structure: 2, a: 2.70, c: 2.70 * 1.584 }, Os: { structure: 2, a: 2.74, c: 2.74 * 1.579 },
  Re: { structure: 2, a: 2.76, c: 2.76 * 1.615 }, Cd: { structure: 2, a: 2.98, c: 2.98 * 1.886 },
  Sc: { structure: 2, a: 3.31, c: 3.31 * 1.594 }, Y: { structure: 2, a: 3.65, c: 3.65 * 1.571 },
});

export const STRAIN_STRUCTURES = [1, 2, 3, 5, 6, 7];
export function referenceForElement(label) {
  const symbol = String(label).trim().match(/^([A-Z][a-z]?)(?:\b|\d|$)/)?.[1];
  const preset = ELEMENT_LATTICES[symbol];
  return preset ? { element: symbol, ...preset } : { element: '', structure: 1, a: null };
}

export function validateReferences(references, types) {
  for (const type of new Set(types)) {
    const reference = references[type];
    if (!reference || !STRAIN_STRUCTURES.includes(reference.structure)
      || !Number.isFinite(reference.a) || reference.a <= 0) {
      throw new Error(`Enter a positive reference lattice constant a for atom type ${type + 1}.`);
    }
    if ([2, 7].includes(reference.structure) && (!Number.isFinite(reference.c) || reference.c <= 0)) {
      throw new Error(`Enter a positive reference lattice constant c for hexagonal atom type ${type + 1}.`);
    }
  }
}
