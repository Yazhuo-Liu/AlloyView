import { PARSER_CHECKPOINT_MASK, runParserSteps, runParserStepsAsync, splitParserLines } from './cooperative-parser.js';
import { cartesianToFractionalSteps, collectFrameSummarySteps, fractionalToCartesianSteps } from './cooperative-coordinates.js';
import { createCell, determinant3, validateFrame } from '../data/model.js';
import { attachFrameSummary } from '../data/frame-summary.js';
import { isElementSymbol } from '../data/chemical-elements.js';

const poscarError = (message) => new Error(`POSCAR: ${message}`);
export const MAX_POSCAR_ATOMS = 4_000_000;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;
const tokensOf = line => String(line ?? '').split('!')[0].trim().split(/\s+/).filter(Boolean);
const numberOf = token => NUMBER.test(token) ? Number(token.replace(/[dD]/, 'e')) : NaN;
const isCounts = tokens => tokens.length > 0 && tokens.every(token => /^\d+$/.test(token));

/** True when text has the POSCAR layout: a scale line, three lattice rows,
 * then species names and/or atom counts followed by a coordinate mode. */
export function looksLikePoscar(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/, 9).map(tokensOf);
  if (lines.length < 7) return false;
  const numbers = tokens => tokens.length > 0 && tokens.every(token => Number.isFinite(numberOf(token)));
  const scale = lines[1];
  if (!numbers(scale) || ![1, 3].includes(scale.length)) return false;
  if (![2, 3, 4].every(index => lines[index].length >= 3 && numbers(lines[index].slice(0, 3)))) return false;
  let cursor = 6;
  if (!isCounts(lines[5])) {
    if (!lines[5].length || !lines[5].every(token => /^[A-Za-z][\w./+-]*$/.test(token)) || !isCounts(lines[6] ?? [])) return false;
    cursor += 1;
  }
  if (/^s/i.test(lines[cursor]?.[0] ?? '')) cursor += 1;
  const mode = lines[cursor] ?? [];
  // Numeric XYZ species can resemble lattice/count rows, but a coordinate
  // mode must not itself be an XYZ species followed by three coordinates.
  return /^[cdk]/i.test(mode[0] ?? '') && !(mode.length >= 4 && numbers(mode.slice(1, 4)));
}

/** Parse a VASP POSCAR or CONTCAR structure (one configuration). Atoms are
 * numbered in file order; all axes are periodic. Velocities and predictor
 * blocks after the coordinates are ignored. */
export function parsePoscar(text, sourceName = 'POSCAR') {
  return runParserSteps(parsePoscarSteps(text, sourceName));
}

export function parsePoscarAsync(text, sourceName = 'POSCAR', options = {}) {
  return runParserStepsAsync(parsePoscarSteps(text, sourceName), options);
}

function* parsePoscarSteps(text, sourceName) {
  const startedAt = performance.now();
  const lines = yield* splitParserLines(text);
  const comment = lines[0]?.trim() ?? '';
  const values = (index, label) => {
    const tokens = tokensOf(lines[index]);
    const numbers = tokens.map(numberOf);
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
    if (scale[0] === 0 || !Number.isFinite(volume) || !(volume > 0)) throw poscarError('the scale factor and lattice must give a finite non-zero volume.');
    // A negative factor is the target cell volume in Å³.
    const factor = scale[0] > 0 ? scale[0] : Math.cbrt(-scale[0] / volume);
    factors = [factor, factor, factor];
  }
  const vectors = lattice.map((value, index) => value * factors[index % 3]);
  if (vectors.some(value => !Number.isFinite(value)) || !Number.isFinite(determinant3(vectors)) || !(Math.abs(determinant3(vectors)) > 0)) {
    throw poscarError('the scaled lattice must give a finite non-zero volume.');
  }

  let cursor = 5;
  let species = tokensOf(lines[cursor]);
  if (isCounts(species)) species = null;
  else cursor += 1;
  const countTokens = tokensOf(lines[cursor]);
  if (!isCounts(countTokens)) throw poscarError(`line ${cursor + 1}: expected the number of atoms of each species.`);
  const counts = countTokens.map(Number);
  cursor += 1;
  // VASP 5 potentials may be written as "Fe_pv" or "Fe/abc"; keep the element.
  species = species?.map(name => {
    const element = name.split(/[_/]/)[0];
    return isElementSymbol(element) ? element : name;
  }) ?? null;
  if (species && species.length !== counts.length) throw poscarError(`${species.length} species names but ${counts.length} counts.`);
  if (!species) {
    // VASP 4 files often list the species in the comment line.
    const words = tokensOf(comment).filter(isElementSymbol);
    species = words.length === counts.length ? words : counts.map((_, index) => `Type ${index + 1}`);
  }
  const count = counts.reduce((sum, value) => sum + value, 0);
  if (counts.some(value => !Number.isSafeInteger(value)) || !Number.isSafeInteger(count) || count > MAX_POSCAR_ATOMS) {
    throw poscarError(`atom counts must be safe integers and the structure must not exceed ${MAX_POSCAR_ATOMS.toLocaleString('en-US')} atoms.`);
  }
  if (species.length > 65_536) throw poscarError('too many species for the atom-type representation.');
  if (count < 1) throw poscarError('the structure contains no atoms.');

  let mode = (lines[cursor] ?? '').trim();
  const selective = /^s/i.test(mode);
  if (selective) { cursor += 1; mode = (lines[cursor] ?? '').trim(); }
  if (!/^[cdk]/i.test(mode)) throw poscarError(`line ${cursor + 1}: expected “Direct” or “Cartesian”.`);
  const cartesian = /^[ck]/i.test(mode);
  cursor += 1;
  if (count > lines.length - cursor) throw poscarError(`declares ${count} atoms, but there are fewer coordinate rows.`);

  const raw = new Float64Array(count * 3);
  const flags = selective ? ['X', 'Y', 'Z'].map(axis => ({ name: `selectiveDynamics${axis}`, unit: '', data: new Float32Array(count) })) : [];
  for (let atom = 0; atom < count; atom += 1, cursor += 1) {
    if ((atom & PARSER_CHECKPOINT_MASK) === 0) yield;
    const tokens = tokensOf(lines[cursor]);
    if (tokens.length < (selective ? 6 : 3)) throw poscarError(`line ${cursor + 1}: atom ${atom + 1} needs three coordinates${selective ? ' and three T/F flags' : ''}.`);
    for (let axis = 0; axis < 3; axis += 1) {
      const value = numberOf(tokens[axis]);
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
  let positions;
  if (cartesian) {
    positions = new Float64Array(raw.length);
    for (let index = 0; index < raw.length; index++) {
      if ((index & PARSER_CHECKPOINT_MASK) === 0) yield;
      positions[index] = raw[index] * factors[index % 3];
    }
  } else positions = yield* fractionalToCartesianSteps(raw, cell, new Float64Array(raw.length));

  const typeIndex = new Map(), typeLabels = [], types = new Uint16Array(count);
  let atom = 0;
  counts.forEach((speciesCount, index) => {
    const name = species[index];
    if (!typeIndex.has(name)) { typeIndex.set(name, typeLabels.length); typeLabels.push(name); }
    types.fill(typeIndex.get(name), atom, atom + speciesCount);
    atom += speciesCount;
  });
  const ids = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    if ((index & PARSER_CHECKPOINT_MASK) === 0) yield;
    ids[index] = index + 1;
  }
  // Keep double precision for DFT positions. In Direct mode the original
  // reduced coordinates are authoritative: do not lose bits in an inverse
  // Cartesian transform before displaying or exporting the crystal.
  const rawFractional = cartesian ? yield* cartesianToFractionalSteps(positions, cell, new Float64Array(raw.length)) : raw;
  const fractional = new Float64Array(raw.length);
  let imageFlags = null;
  for (let index = 0; index < raw.length; index++) {
    if ((index & PARSER_CHECKPOINT_MASK) === 0) yield;
    const value = rawFractional[index];
    if (!Number.isFinite(value) || !Number.isFinite(positions[index])) throw poscarError('scaled coordinates must remain finite.');
    let image = Math.floor(value), wrapped = value - image;
    // Tiny negative values can round up to exactly 1 during subtraction.
    if (wrapped === 1) { wrapped = 0; image += 1; }
    if (image < -2_147_483_648 || image > 2_147_483_647) throw poscarError('coordinate image exceeds the signed 32-bit range.');
    fractional[index] = wrapped;
    if (image !== 0 && !imageFlags) imageFlags = new Int32Array(raw.length);
    if (imageFlags) imageFlags[index] = image;
  }
  const normalizedPositions = yield* fractionalToCartesianSteps(fractional, cell, new Float64Array(raw.length));
  const coordinates = { fractional, positions: normalizedPositions,
    ...(imageFlags ? { imageFlags, unwrappedPositions: positions, unwrapSource: 'coordinates' } : {}) };
  const summary = yield* collectFrameSummarySteps(types, normalizedPositions, typeLabels.length);
  return attachFrameSummary(validateFrame({
    ids, idSource: 'row-order', types, typeLabels, ...coordinates, cell,
    properties: flags, timestep: null, title: sourceName, sourceFormat: 'poscar', comment,
    crystal: { format: 'poscar', selectiveDynamics: selective }, parseMs: performance.now() - startedAt,
  }), summary);
}
