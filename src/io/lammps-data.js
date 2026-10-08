import { createCell, validateFrame } from '../data/model.js';
import { coordinatesForCell } from './xyz.js';

// Column layouts of the Atoms section for the supported atom styles, after
// atom-ID. Three optional image-flag columns may follow every layout.
const ATOM_STYLES = Object.freeze({
  atomic: ['type', 'x', 'y', 'z'],
  charge: ['type', 'q', 'x', 'y', 'z'],
  molecular: ['mol', 'type', 'x', 'y', 'z'],
  bond: ['mol', 'type', 'x', 'y', 'z'],
  angle: ['mol', 'type', 'x', 'y', 'z'],
  full: ['mol', 'type', 'q', 'x', 'y', 'z'],
  sphere: ['type', 'diameter', 'density', 'x', 'y', 'z'],
  dipole: ['type', 'q', 'x', 'y', 'z', 'mux', 'muy', 'muz'],
});
const PROPERTY_COLUMNS = Object.freeze({ q: 'q', mol: 'mol', diameter: 'diameter', density: 'density', mux: 'mux', muy: 'muy', muz: 'muz' });

const dataError = (message) => new Error(`LAMMPS data: ${message}`);

/** True when text looks like a LAMMPS data file: after the free-text title,
 * the header declares an atom count and the box bounds. */
export function looksLikeLammpsData(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).slice(1, 200).map(line => stripComment(line).trim());
  return lines.some(line => /^\d+\s+atoms$/.test(line)) && lines.some(line => /\s+xlo\s+xhi$/.test(line));
}

/** Parse one LAMMPS data file (`write_data`, Atomsk, Packmol…). The title line
 * is ignored; boundaries are not stored in data files, so every axis is
 * periodic, as `read_data` assumes until a `boundary` command says otherwise. */
export function parseLammpsData(text, sourceName = 'LAMMPS data') {
  const startedAt = performance.now();
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const header = parseHeader(lines);
  const sections = splitSections(lines, header.end);
  const atoms = sections.get('Atoms');
  if (!atoms) throw dataError('the file has no Atoms section.');
  const labels = typeLabelsFromSections(sections, header.atomTypes);
  const style = atomStyle(atoms, header.atomTypes);
  const columns = ATOM_STYLES[style];
  const count = header.atoms;
  if (atoms.rows.length !== count) {
    throw dataError(`the header declares ${count} atoms, but the Atoms section has ${atoms.rows.length} rows.`);
  }
  const ids = new Float64Array(count), rawTypes = new Float64Array(count), raw = new Float64Array(count * 3);
  const propertyNames = columns.filter(name => PROPERTY_COLUMNS[name]);
  const propertyData = propertyNames.map(() => new Float32Array(count));
  let images = null;
  const rowById = new Map();
  atoms.rows.forEach(({ tokens, line }, atom) => {
    const hasImages = tokens.length === columns.length + 4;
    if (!hasImages && tokens.length !== columns.length + 1) {
      throw dataError(`line ${line + 1}: ${style} atoms need ${columns.length + 1} columns (or ${columns.length + 4} with image flags); found ${tokens.length}.`);
    }
    if (hasImages && !images) {
      if (atom > 0) throw dataError(`line ${line + 1}: image flags must be given for every atom or none.`);
      images = new Int32Array(count * 3);
    } else if (!hasImages && images) throw dataError(`line ${line + 1}: image flags must be given for every atom or none.`);
    const id = integer(tokens[0], line, 'atom ID');
    if (id <= 0 || rowById.has(id)) throw dataError(`line ${line + 1}: atom ID ${id} is not a unique positive integer.`);
    rowById.set(id, atom);
    ids[atom] = id;
    columns.forEach((column, index) => {
      const token = tokens[index + 1];
      if (column === 'type') rawTypes[atom] = typeNumber(token, labels, line, header.atomTypes);
      else if (column === 'x' || column === 'y' || column === 'z') raw[atom * 3 + 'xyz'.indexOf(column)] = finite(token, line, column);
      else propertyData[propertyNames.indexOf(column)][atom] = column === 'mol' ? integer(token, line, 'molecule ID') : finite(token, line, column);
    });
    if (images) for (let axis = 0; axis < 3; axis += 1) images[atom * 3 + axis] = integer(tokens[columns.length + 1 + axis], line, 'image flag');
  });

  const sortedTypes = [...new Set(rawTypes)].sort((left, right) => left - right);
  if (sortedTypes.length > 65_535) throw dataError('more than 65,535 atom types cannot be represented.');
  const typeIndex = new Map(sortedTypes.map((type, index) => [type, index]));
  const types = Uint16Array.from(rawTypes, type => typeIndex.get(type));
  const typeLabels = sortedTypes.map(type => labels.names.get(type) ?? `Type ${type}`);

  const properties = propertyNames.map((name, index) => ({ name, unit: '', data: propertyData[index] }));
  const masses = sections.get('Masses');
  if (masses) {
    const massByType = new Map(masses.rows.map(({ tokens, line }) => [typeNumber(tokens[0], labels, line, header.atomTypes), finite(tokens[1], line, 'mass')]));
    properties.push({ name: 'mass', unit: '', data: Float32Array.from(rawTypes, type => massByType.get(type) ?? NaN) });
  }
  const velocities = sections.get('Velocities');
  if (velocities) {
    if (velocities.rows.length !== count) throw dataError(`the Velocities section has ${velocities.rows.length} rows for ${count} atoms.`);
    const components = ['vx', 'vy', 'vz'].map(name => ({ name, unit: '', data: new Float32Array(count).fill(NaN) }));
    for (const { tokens, line } of velocities.rows) {
      if (tokens.length < 4) throw dataError(`line ${line + 1}: a velocity row needs an atom ID and three components.`);
      const atom = rowById.get(integer(tokens[0], line, 'atom ID'));
      if (atom === undefined) throw dataError(`line ${line + 1}: velocity for an unknown atom ID.`);
      components.forEach((component, axis) => { component.data[atom] = finite(tokens[axis + 1], line, component.name); });
    }
    properties.push(...components);
  }

  const cell = createCell({ origin: header.origin, vectors: header.vectors, pbc: [true, true, true], triclinic: header.triclinic });
  const coordinates = coordinatesForCell(raw, cell, 'LAMMPS data');
  if (images) {
    // Stored image flags count box crossings on top of any out-of-box offset.
    const imageFlags = coordinates.imageFlags ?? new Int32Array(count * 3);
    const unwrappedPositions = Float64Array.from(raw);
    for (let atom = 0; atom < count; atom += 1) {
      for (let image = 0; image < 3; image += 1) {
        const shift = images[atom * 3 + image];
        imageFlags[atom * 3 + image] += shift;
        for (let axis = 0; axis < 3; axis += 1) unwrappedPositions[atom * 3 + axis] += shift * cell.vectors[image * 3 + axis];
      }
    }
    Object.assign(coordinates, { imageFlags, unwrappedPositions, unwrapSource: 'image flags' });
  }
  return validateFrame({
    ids, idSource: 'explicit', types, typeLabels, ...coordinates, cell, properties,
    timestep: null, title: sourceName, sourceFormat: 'lammps-data', atomStyle: style,
    parseMs: performance.now() - startedAt,
  });
}

function parseHeader(lines) {
  const header = { atoms: null, atomTypes: null, bounds: [null, null, null], tilt: [0, 0, 0], triclinic: false, end: lines.length };
  for (let index = 1; index < lines.length; index += 1) {
    const line = stripComment(lines[index]).trim();
    if (!line) continue;
    if (/^[A-Za-z]/.test(line)) {
      if (/^(?:avec|bvec|cvec|abc\s+origin)\b/.test(line)) throw dataError('general triclinic boxes (avec/bvec/cvec) are not supported; write the data file with a restricted triclinic box.');
      header.end = index; break;
    }
    const tokens = line.split(/\s+/);
    let match;
    if ((match = /^(\d+)\s+atoms$/.exec(line))) header.atoms = Number(match[1]);
    else if ((match = /^(\d+)\s+atom\s+types$/.exec(line))) header.atomTypes = Number(match[1]);
    else if (tokens.length === 4 && /^[xyz]lo$/.test(tokens[2]) && tokens[3] === `${tokens[2][0]}hi`) {
      const axis = 'xyz'.indexOf(tokens[2][0]);
      header.bounds[axis] = [finite(tokens[0], index, `${tokens[2]}`), finite(tokens[1], index, `${tokens[3]}`)];
    } else if (tokens.length === 6 && tokens.slice(3).join(' ') === 'xy xz yz') {
      header.tilt = tokens.slice(0, 3).map((token, axis) => finite(token, index, ['xy', 'xz', 'yz'][axis]));
      header.triclinic = true;
    }
    // Other counts (bonds, angles, extra/per-atom, ellipsoids…) do not affect atoms.
  }
  if (!Number.isSafeInteger(header.atoms) || header.atoms < 1) throw dataError('the header does not declare a positive number of atoms.');
  if (!Number.isSafeInteger(header.atomTypes) || header.atomTypes < 1) throw dataError('the header does not declare the number of atom types.');
  if (header.bounds.some(bound => !bound)) throw dataError('the header must give xlo xhi, ylo yhi and zlo zhi.');
  const [[xlo, xhi], [ylo, yhi], [zlo, zhi]] = header.bounds;
  if (!(xhi > xlo && yhi > ylo && zhi > zlo)) throw dataError('every upper box bound must be greater than its lower bound.');
  const [xy, xz, yz] = header.tilt;
  header.origin = [xlo, ylo, zlo];
  header.vectors = [xhi - xlo, 0, 0, xy, yhi - ylo, 0, xz, yz, zhi - zlo];
  return header;
}

/** Sections start at a line beginning with a letter; their rows are the
 * following non-blank lines up to the next such line. */
function splitSections(lines, start) {
  const sections = new Map();
  let current = null;
  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index], line = stripComment(raw).trim();
    if (!line) continue;
    if (/^[A-Za-z]/.test(line)) {
      const name = line.replace(/\s+/g, ' ');
      if (sections.has(name)) throw dataError(`line ${index + 1}: the ${name} section appears twice.`);
      current = { name, hint: (/#\s*(\S+)/.exec(raw)?.[1] ?? '').toLowerCase(), line: index, rows: [] };
      sections.set(name, current);
      continue;
    }
    if (!current) throw dataError(`line ${index + 1}: data appears before any section keyword.`);
    current.rows.push({ tokens: line.split(/\s+/), comment: commentOf(raw), line: index });
  }
  return sections;
}

/** Type names come from an Atom Type Labels section, or from a single-word
 * comment after a mass (`1 55.845 # Fe`), as written by write_data and Atomsk. */
function typeLabelsFromSections(sections, atomTypes) {
  const names = new Map(), byLabel = new Map();
  const add = (type, name, line) => {
    if (!Number.isSafeInteger(type) || type < 1 || type > atomTypes) throw dataError(`line ${line + 1}: atom type ${type} is outside 1–${atomTypes}.`);
    names.set(type, name); byLabel.set(name, type);
  };
  for (const { tokens, line } of sections.get('Atom Type Labels')?.rows ?? []) {
    if (tokens.length !== 2) throw dataError(`line ${line + 1}: a type label row needs a type number and a label.`);
    add(integer(tokens[0], line, 'atom type'), tokens[1], line);
  }
  for (const { tokens, comment, line } of sections.get('Masses')?.rows ?? []) {
    if (/^\d+$/.test(tokens[0]) && !names.has(Number(tokens[0])) && /^[A-Za-z][A-Za-z0-9_+-]*$/.test(comment)) add(Number(tokens[0]), comment, line);
  }
  return { names, byLabel };
}

function atomStyle(section, atomTypes) {
  if (section.hint) {
    if (!ATOM_STYLES[section.hint]) throw dataError(`atom style “${section.hint}” is not supported; use atomic, charge, molecular, bond, angle, full, sphere or dipole.`);
    return section.hint;
  }
  // Without a style comment only the atomic layout is unambiguous.
  const width = section.rows[0]?.tokens.length;
  if (width === 5 || width === 8) return 'atomic';
  throw dataError(`the Atoms section has ${width} columns and no style comment; add one such as “Atoms # charge” (${atomTypes} types declared).`);
}

function typeNumber(token, labels, line, atomTypes) {
  const type = /^[+-]?\d+$/.test(token) ? Number(token) : labels.byLabel.get(token);
  if (type === undefined) throw dataError(`line ${line + 1}: unknown atom type label “${token}”.`);
  if (!Number.isSafeInteger(type) || type < 1 || type > atomTypes) throw dataError(`line ${line + 1}: atom type ${token} is outside 1–${atomTypes}.`);
  return type;
}

function stripComment(line) {
  const hash = line.indexOf('#');
  return hash < 0 ? line : line.slice(0, hash);
}

function commentOf(line) {
  const hash = line.indexOf('#');
  return hash < 0 ? '' : line.slice(hash + 1).trim();
}

function finite(token, line, label) {
  const value = Number(token);
  if (token === undefined || token === '' || !Number.isFinite(value)) throw dataError(`line ${line + 1}: ${label} is not a finite number: “${token}”.`);
  return value;
}

function integer(token, line, label) {
  const value = Number(token);
  if (!/^[+-]?\d+$/.test(token ?? '') || !Number.isSafeInteger(value)) throw dataError(`line ${line + 1}: ${label} must be an integer: “${token}”.`);
  return value;
}
