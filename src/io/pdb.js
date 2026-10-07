import { createCell, validateFrame } from '../data/model.js';
import { coordinatesForCell, inferNonperiodicCell } from './xyz.js';
import { lineText, scanLineBytes } from './text-lines.js';

export async function indexPdb(blob, onProgress = () => {}, options = {}) {
  const startedAt = performance.now();
  const frames = [];
  const header = [];
  let currentHeader = '';
  let active = null;
  let implicitAtoms = 0;
  let modelAtoms = 0;
  let explicitModels = false;
  await scanLineBytes(blob, (bytes, from, to, start, end) => {
    const record = recordName(bytes, from, to);
    if (record === 'MODEL') {
      if (active) throw pdbError('MODEL records must be separated by ENDMDL.');
      if (implicitAtoms) throw pdbError('Atom records before the first MODEL cannot be combined with a model trajectory.');
      explicitModels = true;
      active = { start, end: null, header: currentHeader };
      modelAtoms = 0;
    } else if (record === 'ENDMDL') {
      if (!active) throw pdbError('ENDMDL has no preceding MODEL.');
      if (!modelAtoms) throw pdbError('A MODEL contains no atom records.');
      active.end = end;
      frames.push(active);
      active = null;
    } else if (record === 'ATOM' || record === 'HETATM') {
      if (explicitModels && !active) throw pdbError('Atom records must occur inside MODEL/ENDMDL blocks.');
      if (active) modelAtoms += 1;
      else implicitAtoms += 1;
    } else if (!active && (record === 'CRYST1' || record === 'TITLE')) {
      header.push(lineText(bytes.subarray(from, to)));
      currentHeader = header.join('\n');
    }
  }, onProgress, options);
  if (active) throw pdbError('The last MODEL is missing ENDMDL.');
  if (!explicitModels && implicitAtoms) frames.push({ start: 0, end: blob.size });
  if (!frames.length) throw pdbError('The file contains no ATOM or HETATM records.');
  return { frames, header: explicitModels ? header.join('\n') : '', indexMs: performance.now() - startedAt };
}

const INDEXED_RECORDS = ['MODEL', 'ENDMDL', 'ATOM', 'HETATM', 'CRYST1', 'TITLE']
  .map(name => ({ name, bytes: Uint8Array.from(name, character => character.charCodeAt(0)) }));
const isAsciiSpace = byte => byte === 32 || (byte >= 9 && byte <= 13);

// The record the indexer uses, or '', from the trimmed first six characters
// of a line's text. UTF-8 decodes ASCII bytes to the same characters, so an
// ASCII prefix is compared without decoding it.
function recordName(bytes, from, to) {
  let first = from, last = Math.min(to, from + 6);
  for (let index = first; index < last; index++) {
    if (bytes[index] >= 0x80) return lineText(bytes.subarray(from, to)).slice(0, 6).trim();
  }
  while (first < last && isAsciiSpace(bytes[first])) first++;
  while (last > first && isAsciiSpace(bytes[last - 1])) last--;
  search: for (const record of INDEXED_RECORDS) {
    if (record.bytes.length !== last - first) continue;
    for (let index = 0; index < record.bytes.length; index++) if (bytes[first + index] !== record.bytes[index]) continue search;
    return record.name;
  }
  return '';
}

export async function readPdbFrame(blob, indexed, index, sourceName = 'trajectory.pdb') {
  if (!Number.isInteger(index) || index < 0 || index >= indexed.frames.length) {
    throw new Error(`PDB trajectory frame ${index} is outside the available range.`);
  }
  const descriptor = indexed.frames[index];
  const text = await blob.slice(descriptor.start, descriptor.end).text();
  const header = descriptor.header ?? indexed.header;
  const frame = parsePdbFrame(header ? `${header}\n${text}` : text, sourceName);
  frame.frameIndex = index;
  return frame;
}

export function parsePdbFrame(text, sourceName = 'structure.pdb') {
  const startedAt = performance.now();
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  const atoms = [];
  const titles = [];
  let cell = null;
  let timestep = null;
  let models = 0;
  for (const line of lines) {
    const record = line.slice(0, 6).trim();
    if (record === 'CRYST1') cell = parseCrystalCell(line);
    else if (record === 'TITLE') titles.push(line.slice(10).trim());
    else if (record === 'MODEL') {
      models += 1;
      if (models > 1) throw pdbError('Use the indexed trajectory reader for files containing multiple MODEL records.');
      const value = line.slice(10, 14).trim();
      if (value) timestep = integer(value, 'MODEL number');
    } else if (record === 'ATOM' || record === 'HETATM') {
      // PDB alternate conformations overlap. Display the primary (blank/A)
      // conformer; its serial number remains the stable atom identity.
      const alternate = line[16] ?? ' ';
      if (alternate !== ' ' && alternate !== 'A') continue;
      const id = integer(line.slice(6, 11).trim(), 'atom serial');
      if (id <= 0) throw pdbError('Atom serial numbers must be positive.');
      const position = [30, 38, 46].map((offset) => finite(line.slice(offset, offset + 8).trim(), 'atom coordinate'));
      const species = elementLabel(line);
      atoms.push({ id, position, species,
        occupancy: optionalNumber(line.slice(54, 60)),
        bfactor: optionalNumber(line.slice(60, 66)),
      });
    }
  }
  if (!atoms.length) throw pdbError('The structure contains no primary ATOM or HETATM records.');
  const count = atoms.length;
  const ids = new Float64Array(count);
  const types = new Uint16Array(count);
  const rawPositions = new Float32Array(count * 3);
  const typeLabels = [];
  const typeMap = new Map();
  const seenIds = new Set();
  const properties = ['occupancy', 'bfactor'].map((name) => ({ name, unit: name === 'bfactor' ? 'Å²' : '', data: new Float32Array(count) }));
  for (let atom = 0; atom < count; atom += 1) {
    const value = atoms[atom];
    if (seenIds.has(value.id)) throw pdbError(`Atom serial ${value.id} occurs more than once in the primary conformer.`);
    seenIds.add(value.id);
    ids[atom] = value.id;
    if (!typeMap.has(value.species)) {
      typeMap.set(value.species, typeLabels.length);
      typeLabels.push(value.species);
    }
    types[atom] = typeMap.get(value.species);
    rawPositions.set(value.position, atom * 3);
    properties[0].data[atom] = value.occupancy;
    properties[1].data[atom] = value.bfactor;
  }
  cell ??= inferNonperiodicCell(rawPositions);
  const coordinates = coordinatesForCell(rawPositions, cell, 'PDB');
  return validateFrame({ ids, idSource: 'explicit', types, typeLabels,
    ...coordinates, cell, properties, timestep, title: sourceName,
    pdbTitle: titles.join(' '), sourceFormat: 'pdb', parseMs: performance.now() - startedAt });
}

function parseCrystalCell(line) {
  const [a, b, c] = [6, 15, 24].map((offset) => finite(line.slice(offset, offset + 9).trim(), 'CRYST1 length'));
  const [alpha, beta, gamma] = [33, 40, 47].map((offset) => finite(line.slice(offset, offset + 7).trim(), 'CRYST1 angle'));
  if ([a, b, c].some((value) => value <= 0) || [alpha, beta, gamma].some((value) => value <= 0 || value >= 180)) {
    throw pdbError('CRYST1 requires positive lengths and angles between 0 and 180 degrees.');
  }
  const radians = Math.PI / 180;
  const cosAlpha = Math.cos(alpha * radians);
  const cosBeta = Math.cos(beta * radians);
  const cosGamma = Math.cos(gamma * radians);
  const sinGamma = Math.sin(gamma * radians);
  const cx = c * cosBeta;
  const cy = c * (cosAlpha - cosBeta * cosGamma) / sinGamma;
  const czSquared = c * c - cx * cx - cy * cy;
  if (!(czSquared > 0)) throw pdbError('CRYST1 angles do not define a nonzero-volume cell.');
  return createCell({ vectors: [a, 0, 0, b * cosGamma, b * sinGamma, 0, cx, cy, Math.sqrt(czSquared)],
    pbc: [true, true, true], triclinic: [alpha, beta, gamma].some((angle) => Math.abs(angle - 90) > 1e-10) });
}

function elementLabel(line) {
  const explicit = line.slice(76, 78).trim();
  const name = line.slice(12, 16);
  const letters = name.replace(/[^A-Za-z]/g, '');
  const value = explicit || (name.startsWith(' ') || /^\d/.test(name) ? letters.slice(0, 1) : letters.slice(0, 2));
  if (!/^[A-Za-z]{1,2}$/.test(value)) throw pdbError(`Cannot infer an element from atom name “${name}”.`);
  return value[0].toUpperCase() + value.slice(1).toLowerCase();
}

function integer(value, label) {
  const number = Number(value);
  if (!value || !Number.isSafeInteger(number)) throw pdbError(`${label} must be a safe integer: ${value}. Hybrid-36 serials are not supported.`);
  return number;
}

function finite(value, label) {
  const number = Number(value);
  if (!value || !Number.isFinite(number)) throw pdbError(`${label} must be a finite number: ${value}.`);
  return number;
}

function optionalNumber(value) { return value.trim() ? finite(value.trim(), 'atom property') : NaN; }
function pdbError(message) { return new Error(`PDB parsing failed: ${message}`); }
