import { determinant3 } from '../data/model.js';
import { isElementSymbol } from '../data/chemical-elements.js';
import { PARSER_CHECKPOINT_MASK, runParserSteps, runParserStepsAsync } from './cooperative-parser.js';

export const STRUCTURE_EXPORT_FORMATS = Object.freeze([
  Object.freeze({ value: 'cif', label: 'CIF · expanded P1 cell' }),
  Object.freeze({ value: 'poscar', label: 'VASP POSCAR' }),
]);
export const MAX_STRUCTURE_EXPORT_ATOMS = 4_000_000;
export const MAX_STRUCTURE_EXPORT_BYTES = 256 * 1024 ** 2;
const error = message => new Error(`Structure export: ${message}`);

/** Export the actual analysis frame, including physical replication. Display
 * origin shifts, hiding, slicing and display-only repetitions are deliberately
 * not inputs. CIF describes the metric in its conventional Cartesian basis;
 * POSCAR retains the source lattice-vector orientation. Neither file format
 * stores an arbitrary Cartesian cell origin. */
export function createStructureExport(frame, options = {}) {
  return downloadResult(runParserSteps(formatStructureSteps(frame, options)));
}

export async function createStructureExportAsync(frame, options = {}, execution = {}) {
  return downloadResult(await runParserStepsAsync(formatStructureSteps(frame, options), execution));
}

/** Text helpers are useful for downstream tools and round-trip validation.
 * Downloads use Blob parts directly, avoiding a second full-size string. */
export function structureExportText(frame, options = {}) {
  return runParserSteps(formatStructureSteps(frame, options)).parts.join('');
}

export async function structureExportTextAsync(frame, options = {}, execution = {}) {
  return (await runParserStepsAsync(formatStructureSteps(frame, options), execution)).parts.join('');
}

function downloadResult({ parts, ...metadata }) {
  return { ...metadata, blob: new Blob(parts, { type: 'text/plain;charset=utf-8' }) };
}

function property(frame, names, count) {
  const matches = (frame.properties ?? []).filter(entry => names.includes(entry.name));
  if (matches.length > 1) throw error(`ambiguous property columns: ${names.join(' / ')}.`);
  const entry = matches[0];
  if (entry && (!entry.data || entry.data.length !== count || entry.categories)) {
    throw error(`“${entry.name}” must contain one numeric value per atom.`);
  }
  return entry?.data ?? null;
}

function number(value) { return Object.is(value, -0) ? '0' : String(value); }
function optionalNumber(value) { return Number.isNaN(value) ? '?' : number(value); }

function* formatStructureSteps(frame, { format = 'cif', stem = 'structure', title, maxBytes = MAX_STRUCTURE_EXPORT_BYTES } = {}) {
  if (!STRUCTURE_EXPORT_FORMATS.some(choice => choice.value === format)) throw error('choose CIF or POSCAR.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_STRUCTURE_EXPORT_BYTES) {
    throw error(`the text budget must be between 1 and ${MAX_STRUCTURE_EXPORT_BYTES} bytes.`);
  }
  const count = frame?.types?.length;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_STRUCTURE_EXPORT_ATOMS
      || frame.fractional?.length !== count * 3 || frame.positions?.length !== count * 3
      || !Array.isArray(frame.typeLabels) || !frame.typeLabels.length || frame.typeLabels.length > 65_536) {
    throw error(`a complete structure with 1–${MAX_STRUCTURE_EXPORT_ATOMS.toLocaleString('en-US')} atoms is required.`);
  }
  const cell = frame.cell;
  if (!cell || cell.vectors?.length !== 9 || cell.origin?.length !== 3 || cell.pbc?.length !== 3
      || [...cell.vectors, ...cell.origin].some(value => !Number.isFinite(value))
      || !Number.isFinite(determinant3(cell.vectors)) || !(Math.abs(determinant3(cell.vectors)) > 0)) {
    throw error('the lattice must be finite and nonsingular.');
  }
  if (cell.pbc.some(value => value !== true)) {
    throw error('CIF and POSCAR describe periodic crystals; all three cell axes must be periodic.');
  }
  // Even the shortest coordinate rows exceed this lower bound. Reject before
  // allocating grouped indices for a source that cannot fit the text budget.
  if (count * 6 > maxBytes) throw error('the structure exceeds the export text budget.');
  const occupancy = property(frame, ['occupancy'], count);
  const uiso = format === 'cif' ? property(frame, ['Uiso', 'uiso', 'U_iso_or_equiv'], count) : null;
  const biso = format === 'cif' ? property(frame, ['Biso', 'biso', 'bfactor', 'B_iso_or_equiv'], count) : null;
  const flags = format === 'poscar' ? ['X', 'Y', 'Z'].map(axis => property(frame, [`selectiveDynamics${axis}`], count)) : [];
  if (flags.some(Boolean) && !flags.every(Boolean)) throw error('POSCAR needs all three selective-dynamics columns, or none.');
  if (format === 'poscar' && frame.crystal?.disordered) {
    throw error('POSCAR requires an ordered structure; resolve partial occupancy or disorder into a specific atomic configuration first.');
  }
  const species = [], speciesIndex = new Map(), typeToSpecies = new Int32Array(frame.typeLabels.length).fill(-1);
  const populations = new Uint32Array(frame.typeLabels.length);
  for (let atom = 0; atom < count; atom++) {
    if ((atom & PARSER_CHECKPOINT_MASK) === 0) yield;
    const type = frame.types[atom];
    if (!Number.isInteger(type) || type < 0 || type >= frame.typeLabels.length) throw error(`atom ${atom + 1} has an invalid species index.`);
    if (typeToSpecies[type] === -1) {
      const label = frame.typeLabels[type];
      if (!isElementSymbol(label)) throw error(`“${label}” is not a known element symbol; assign chemical elements before exporting a crystal.`);
      if (!speciesIndex.has(label)) { speciesIndex.set(label, species.length); species.push(label); }
      typeToSpecies[type] = speciesIndex.get(label);
    }
    populations[typeToSpecies[type]]++;
    for (let axis = 0; axis < 3; axis++) {
      if (!Number.isFinite(frame.fractional[atom * 3 + axis]) || !Number.isFinite(frame.positions[atom * 3 + axis])) {
        throw error(`atom ${atom + 1} has a non-finite coordinate.`);
      }
    }
    const occupation = occupancy ? occupancy[atom] : 1;
    if (typeof occupation !== 'number' || !(Number.isNaN(occupation) || Number.isFinite(occupation) && occupation >= 0 && occupation <= 1)) {
      throw error(`atom ${atom + 1} has an invalid occupancy; use a number from 0 to 1, or NaN for unknown CIF occupancy.`);
    }
    if (format === 'poscar' && occupation !== 1) {
      throw error('POSCAR cannot represent partial or unknown occupancy; resolve it into an ordered atomic configuration first.');
    }
    for (const values of [uiso, biso]) {
      if (values && (typeof values[atom] !== 'number' || !Number.isFinite(values[atom]) && !Number.isNaN(values[atom]))) {
        throw error(`atom ${atom + 1} has an invalid atomic displacement parameter.`);
      }
    }
    for (const values of flags) {
      if (values && values[atom] !== 0 && values[atom] !== 1) throw error('selective-dynamics columns must contain only 0 (fixed) or 1 (free).');
    }
  }

  const parts = [], encoder = new TextEncoder();
  let bytes = 0;
  const append = text => {
    bytes += encoder.encode(text).byteLength;
    if (bytes > maxBytes) throw error(`the structure exceeds the ${Math.round(maxBytes / 1024 ** 2)} MiB export text budget.`);
    parts.push(text);
  };
  const cleanTitle = String(title ?? frame.comment ?? frame.title ?? 'AlloyView structure').replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 4096);
  const safeStem = String(stem).split(/[\\/]/).at(-1).replace(/\.(cif|vasp|poscar)$/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'structure';
  const reverseC = format === 'cif' && determinant3(cell.vectors) < 0;
  // A CIF reader constructs a right-handed conventional basis. Reversing
  // both c and its reduced coordinate before encoding a left-handed input
  // changes only the basis, preserving physical handedness (not a mirror).
  const h = reverseC ? Float64Array.from(cell.vectors, (value, index) => index >= 6 ? -value : value) : cell.vectors;
  if (format === 'cif') {
    const lengths = [0, 3, 6].map(offset => Math.hypot(h[offset], h[offset + 1], h[offset + 2]));
    const angle = (first, second) => {
      const a = first * 3, b = second * 3;
      // Normalize before multiplying to avoid overflowing the dot product.
      const cosine = [0, 1, 2].reduce((sum, axis) => sum + (h[a + axis] / lengths[first]) * (h[b + axis] / lengths[second]), 0);
      return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
    };
    const angles = [angle(1, 2), angle(0, 2), angle(0, 1)];
    if (lengths.some(value => !Number.isFinite(value) || value <= 0) || angles.some(value => !Number.isFinite(value) || value <= 0 || value >= 180)) {
      throw error('the cell metric cannot be represented by finite CIF lengths and angles.');
    }
    append(`data_alloyview\n# ${cleanTitle}\n# Complete physical cell; no display-only repeats, shifts, slices or visibility filters.\n`
      + '# Expanded sites are written in P1.\n'
      + (reverseC ? '# Left-handed source basis: c and fractional z are reversed to preserve crystal handedness.\n'
        : '# Fractional coordinates and cell metric are retained.\n')
      + lengths.map((value, index) => `_cell_length_${'abc'[index]} ${number(value)}\n`).join('')
      + angles.map((value, index) => `_cell_angle_${['alpha', 'beta', 'gamma'][index]} ${number(value)}\n`).join('')
      + "_space_group_name_H-M_alt 'P 1'\n_space_group_IT_number 1\nloop_\n_space_group_symop_operation_xyz\n'x,y,z'\n"
      + 'loop_\n_atom_site_label\n_atom_site_type_symbol\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\n_atom_site_occupancy\n'
      + (uiso ? '_atom_site_U_iso_or_equiv\n' : '') + (biso ? '_atom_site_B_iso_or_equiv\n' : ''));
    const labels = new Uint32Array(species.length);
    for (let start = 0; start < count; start += 1024) {
      yield;
      let chunk = '';
      for (let atom = start; atom < Math.min(count, start + 1024); atom++) {
        const index = typeToSpecies[frame.types[atom]], symbol = species[index], offset = atom * 3;
        chunk += `${symbol}${++labels[index]} ${symbol} ${number(frame.fractional[offset])} ${number(frame.fractional[offset + 1])} ${number(reverseC ? -frame.fractional[offset + 2] : frame.fractional[offset + 2])} ${optionalNumber(occupancy ? occupancy[atom] : 1)}`
          + (uiso ? ` ${optionalNumber(uiso[atom])}` : '') + (biso ? ` ${optionalNumber(biso[atom])}` : '') + '\n';
      }
      append(chunk);
    }
  } else {
    const selective = flags.every(Boolean);
    append(`${cleanTitle}\n1.0\n` + [0, 3, 6].map(offset => `${number(h[offset])} ${number(h[offset + 1])} ${number(h[offset + 2])}\n`).join('')
      + `${species.join(' ')}\n${species.map((_, index) => populations[index]).join(' ')}\n${selective ? 'Selective dynamics\n' : ''}Direct\n`);
    // Counting sort groups species in O(N), preserving order within each
    // species and avoiding a full scan for every element in a large alloy.
    const starts = new Uint32Array(species.length);
    for (let index = 1; index < species.length; index++) starts[index] = starts[index - 1] + populations[index - 1];
    const ordered = new Uint32Array(count);
    for (let atom = 0; atom < count; atom++) {
      if ((atom & PARSER_CHECKPOINT_MASK) === 0) yield;
      ordered[starts[typeToSpecies[frame.types[atom]]]++] = atom;
    }
    for (let start = 0; start < count; start += 1024) {
      yield;
      let chunk = '';
      for (let index = start; index < Math.min(count, start + 1024); index++) {
        const atom = ordered[index], offset = atom * 3;
        chunk += `${number(frame.fractional[offset])} ${number(frame.fractional[offset + 1])} ${number(frame.fractional[offset + 2])}`
          + (selective ? flags.map(values => values[atom] ? ' T' : ' F').join('') : '') + '\n';
      }
      append(chunk);
    }
  }
  return { parts, filename: format === 'cif' ? `${safeStem}.cif` : `${safeStem}.POSCAR`, format, atomCount: count };
}
