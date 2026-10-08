import { createCell, determinant3, fractionalToCartesian, validateFrame } from '../data/model.js';
import { coordinatesForCell } from './xyz.js';

const poscarError = (message) => new Error(`POSCAR: ${message}`);
const SYMBOL = /^[A-Z][a-z]?$/;

/** True when text has the POSCAR layout: a scale line, three lattice rows,
 * then species names and/or atom counts. */
export function looksLikePoscar(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).slice(0, 9).map(line => line.trim().split(/\s+/));
  if (lines.length < 7) return false;
  const numbers = tokens => tokens.length > 0 && tokens.every(token => Number.isFinite(Number(token)));
  const scale = lines[1].filter(token => !token.startsWith('!'));
  if (!numbers(scale) || ![1, 3].includes(scale.length)) return false;
  if (![2, 3, 4].every(index => lines[index].length >= 3 && numbers(lines[index].slice(0, 3)))) return false;
  const counts = tokens => tokens.length > 0 && tokens.every(token => /^\d+$/.test(token));
  return counts(lines[5]) || (lines[5].every(token => /^[A-Z][a-z]?\S*$/.test(token)) && counts(lines[6]));
}

/** Parse a VASP POSCAR or CONTCAR structure (one configuration). Atoms are
 * numbered in file order; all axes are periodic. Velocities and predictor
 * blocks after the coordinates are ignored. */
export function parsePoscar(text, sourceName = 'POSCAR') {
  const startedAt = performance.now();
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const comment = lines[0]?.trim() ?? '';
  const values = (index, label) => {
    const tokens = (lines[index] ?? '').trim().split(/\s+/).filter(token => token && !token.startsWith('!'));
    const numbers = tokens.map(Number);
    if (!tokens.length || numbers.some(value => !Number.isFinite(value))) throw poscarError(`line ${index + 1}: ${label} must be numeric.`);
    return numbers;
  };
  const scale = values(1, 'the scale factor');
  if (![1, 3].includes(scale.length)) throw poscarError('line 2: give one scale factor or three per-axis factors.');
  const lattice = [2, 3, 4].flatMap(index => {
    const row = values(index, 'a lattice vector');
    if (row.length < 3) throw poscarError(`line ${index + 1}: a lattice vector needs three components.`);
    return row.slice(0, 3);
  });
  // Per Cartesian component: one universal factor, or VASP 6's three factors.
  let factors;
  if (scale.length === 3) {
    if (scale.some(value => value <= 0)) throw poscarError('line 2: per-axis scale factors must be positive.');
    factors = scale;
  } else {
    const volume = Math.abs(determinant3(lattice));
    if (scale[0] === 0 || !(volume > 0)) throw poscarError('the scale factor and lattice must give a non-zero volume.');
    // A negative factor is the target cell volume in Å³.
    const factor = scale[0] > 0 ? scale[0] : Math.cbrt(-scale[0] / volume);
    factors = [factor, factor, factor];
  }
  const vectors = lattice.map((value, index) => value * factors[index % 3]);

  let cursor = 5;
  let species = (lines[cursor] ?? '').trim().split(/\s+/);
  const isCounts = tokens => tokens.length > 0 && tokens.every(token => /^\d+$/.test(token));
  if (isCounts(species)) species = null;
  else cursor += 1;
  const countTokens = (lines[cursor] ?? '').trim().split(/\s+/);
  if (!isCounts(countTokens)) throw poscarError(`line ${cursor + 1}: expected the number of atoms of each species.`);
  const counts = countTokens.map(Number);
  cursor += 1;
  // VASP 5 potentials may be written as "Fe_pv" or "Fe/abc"; keep the element.
  species = species?.map(name => name.split(/[_/]/)[0]) ?? null;
  if (species && species.length !== counts.length) throw poscarError(`${species.length} species names but ${counts.length} counts.`);
  if (!species) {
    // VASP 4 files often list the species in the comment line.
    const words = comment.split(/\s+/).filter(word => SYMBOL.test(word));
    species = words.length === counts.length ? words : counts.map((_, index) => `Type ${index + 1}`);
  }
  const count = counts.reduce((sum, value) => sum + value, 0);
  if (count < 1) throw poscarError('the structure contains no atoms.');

  let mode = (lines[cursor] ?? '').trim();
  const selective = /^s/i.test(mode);
  if (selective) { cursor += 1; mode = (lines[cursor] ?? '').trim(); }
  if (!/^[cdk]/i.test(mode)) throw poscarError(`line ${cursor + 1}: expected “Direct” or “Cartesian”.`);
  const cartesian = /^[ck]/i.test(mode);
  cursor += 1;

  const raw = new Float64Array(count * 3);
  const flags = selective ? ['X', 'Y', 'Z'].map(axis => ({ name: `selectiveDynamics${axis}`, unit: '', data: new Float32Array(count) })) : [];
  for (let atom = 0; atom < count; atom += 1, cursor += 1) {
    const tokens = (lines[cursor] ?? '').trim().split(/\s+/);
    if (tokens.length < (selective ? 6 : 3)) throw poscarError(`line ${cursor + 1}: atom ${atom + 1} needs three coordinates${selective ? ' and three T/F flags' : ''}.`);
    for (let axis = 0; axis < 3; axis += 1) {
      const value = Number(tokens[axis]);
      if (!Number.isFinite(value)) throw poscarError(`line ${cursor + 1}: coordinate “${tokens[axis]}” is not a finite number.`);
      raw[atom * 3 + axis] = value;
    }
    flags.forEach((flag, axis) => {
      const token = tokens[3 + axis].toUpperCase();
      if (token !== 'T' && token !== 'F') throw poscarError(`line ${cursor + 1}: selective-dynamics flags must be T or F.`);
      flag.data[atom] = token === 'T' ? 1 : 0;
    });
  }

  const cell = createCell({ vectors, pbc: [true, true, true], triclinic: vectors.some((value, index) => index % 4 !== 0 && value !== 0) });
  // Cartesian coordinates carry the same scaling as the lattice.
  const positions = cartesian ? raw.map((value, index) => value * factors[index % 3])
    : fractionalToCartesian(raw, cell, new Float64Array(raw.length));

  const typeIndex = new Map(), typeLabels = [], types = new Uint16Array(count);
  let atom = 0;
  counts.forEach((speciesCount, index) => {
    const name = species[index];
    if (!typeIndex.has(name)) { typeIndex.set(name, typeLabels.length); typeLabels.push(name); }
    types.fill(typeIndex.get(name), atom, atom + speciesCount);
    atom += speciesCount;
  });
  const ids = new Float64Array(count);
  for (let index = 0; index < count; index += 1) ids[index] = index + 1;
  return validateFrame({
    ids, idSource: 'row-order', types, typeLabels, ...coordinatesForCell(positions, cell, 'POSCAR'), cell,
    properties: flags, timestep: null, title: sourceName, sourceFormat: 'poscar', comment,
    parseMs: performance.now() - startedAt,
  });
}
