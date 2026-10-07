import { cartesianToFractional, createCell, fractionalToCartesian, validateFrame, wrapFractional } from '../data/model.js';
import { isBlankLine, lineText, scanLineBytes } from './text-lines.js';

const ELEMENTS = 'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ');

export async function indexXyz(blob, onProgress = () => {}, options = {}) {
  const startedAt = performance.now();
  const offsets = [];
  let stage = 'count';
  let remaining = 0;
  // Atom rows are only counted and checked for content; only count lines
  // are decoded.
  await scanLineBytes(blob, (bytes, from, to, start) => {
    if (stage === 'count') {
      if (isBlankLine(bytes, from, to)) return;
      remaining = atomCount(lineText(bytes.subarray(from, to)));
      offsets.push(start);
      stage = 'comment';
    } else if (stage === 'comment') {
      stage = 'atoms';
    } else {
      if (isBlankLine(bytes, from, to)) throw xyzError(`Frame ${offsets.length} has a blank atom row.`);
      remaining -= 1;
      if (!remaining) stage = 'count';
    }
  }, onProgress, options);
  if (offsets.length === 0) throw xyzError('The file contains no XYZ frames.');
  if (stage !== 'count') throw xyzError(`Frame ${offsets.length} is truncated; a comment and all declared atom rows are required.`);
  return { offsets, indexMs: performance.now() - startedAt };
}

export async function readXyzFrame(blob, offsets, index, sourceName = 'trajectory.xyz') {
  if (!Number.isInteger(index) || index < 0 || index >= offsets.length) {
    throw new Error(`XYZ trajectory frame ${index} is outside the available range.`);
  }
  const end = offsets[index + 1] ?? blob.size;
  const frame = parseXyzFrame(await blob.slice(offsets[index], end).text(), sourceName);
  frame.frameIndex = index;
  return frame;
}

export function parseXyzFrame(text, sourceName = 'structure.xyz') {
  const startedAt = performance.now();
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  let cursor = 0;
  while (!lines[cursor]?.trim() && cursor < lines.length) cursor += 1;
  const count = atomCount(lines[cursor]);
  cursor += 1;
  if (cursor >= lines.length) throw xyzError('The comment line is missing.');
  const comment = lines[cursor++];
  const metadata = commentMetadata(comment);
  const fields = parseFields(metadata.Properties);
  const speciesField = fields.find((field) => ['species', 'element', 'Z'].includes(field.name));
  const positionField = fields.find((field) => field.name === 'pos');
  const idField = fields.find((field) => field.name === 'id');
  if (!speciesField || speciesField.width !== 1) throw xyzError('Properties must provide species:S:1 or Z:I:1.');
  if ((speciesField.name === 'Z' && speciesField.type !== 'I') || (speciesField.name !== 'Z' && speciesField.type !== 'S')) throw xyzError('Species labels must use type S and atomic numbers must use type I.');
  if (!positionField || positionField.type !== 'R' || positionField.width !== 3) throw xyzError('Properties must provide pos:R:3.');
  if (idField && (idField.width !== 1 || !['I', 'R'].includes(idField.type))) throw xyzError('The id property must be a single numeric column.');
  const propertyFields = fields.filter((field) => ![speciesField, positionField, idField].includes(field) && field.type !== 'S');
  const properties = propertyFields.flatMap((field) => Array.from({ length: field.width }, (_, component) => ({
    name: field.width === 1 ? field.name : `${field.name}_${component}`,
    unit: '', data: new Float32Array(count), field, component,
  })));
  if (new Set(properties.map((property) => property.name)).size !== properties.length) throw xyzError('Flattened numeric property names are duplicated.');
  const ids = new Float64Array(count);
  const types = new Uint16Array(count);
  const positions = new Float32Array(count * 3);
  const typeLabels = [];
  const typeMap = new Map();
  const seenIds = new Set();
  const columnCount = fields.reduce((sum, field) => sum + field.width, 0);
  for (let atom = 0; atom < count; atom += 1, cursor += 1) {
    const tokens = tokenizeRow(lines[cursor] ?? '');
    if (tokens.length !== columnCount) throw xyzError(`Atom row ${atom + 1} requires ${columnCount} columns; found ${tokens.length}.`);
    const species = speciesLabel(tokens[speciesField.offset], speciesField.name === 'Z');
    if (!typeMap.has(species)) {
      if (typeLabels.length >= 65_535) throw xyzError('More than 65,535 atom types cannot be represented.');
      typeMap.set(species, typeLabels.length);
      typeLabels.push(species);
    }
    types[atom] = typeMap.get(species);
    for (let axis = 0; axis < 3; axis += 1) positions[atom * 3 + axis] = numeric(tokens[positionField.offset + axis], `position at atom ${atom + 1}`);
    const id = idField ? numeric(tokens[idField.offset], `id at atom ${atom + 1}`) : atom + 1;
    if (!Number.isSafeInteger(id) || id <= 0 || seenIds.has(id)) throw xyzError(`Atom row ${atom + 1} has an invalid or duplicated positive integer id: ${id}.`);
    ids[atom] = id;
    seenIds.add(id);
    for (const property of properties) {
      const token = tokens[property.field.offset + property.component];
      const value = property.field.type === 'L' ? booleanValue(token) : numeric(token, property.name, { allowNaN: true });
      if (property.field.type === 'I' && !Number.isSafeInteger(value)) throw xyzError(`Property ${property.name} requires safe integers.`);
      property.data[atom] = value;
    }
  }
  if (lines.slice(cursor).some((line) => line.trim())) throw xyzError('Unexpected data after the declared atom rows.');
  const cell = cellFromMetadata(metadata, positions);
  const coordinates = coordinatesForCell(positions, cell, 'XYZ');
  return validateFrame({
    ids, idSource: idField ? 'explicit' : 'row-order', types, typeLabels,
    ...coordinates, cell,
    properties: properties.map(({ field, component, ...property }) => property),
    timestep: metadata.Step !== undefined ? numeric(metadata.Step, 'Step') : null,
    title: sourceName, sourceFormat: 'xyz', comment,
    ignoredStringProperties: fields.filter((field) => field.type === 'S' && field !== speciesField).map((field) => field.name),
    parseMs: performance.now() - startedAt,
  });
}

export function coordinatesForCell(rawPositions, cell, format) {
  const rawFractional = cartesianToFractional(rawPositions, cell, new Float64Array(rawPositions.length));
  const fractional = wrapFractional(rawFractional, cell.pbc);
  const positions = cell.pbc.some(Boolean) ? fractionalToCartesian(fractional, cell) : rawPositions;
  const hasImages = rawFractional.some((value, index) => cell.pbc[index % 3] && (value < 0 || value >= 1));
  if (!hasImages) return { positions, fractional };
  const imageFlags = new Int32Array(rawPositions.length);
  for (let index = 0; index < rawFractional.length; index += 1) {
    const image = cell.pbc[index % 3] ? Math.floor(rawFractional[index]) : 0;
    if (image < -2_147_483_648 || image > 2_147_483_647) throw new Error(`${format} coordinates exceed the supported image-flag range.`);
    imageFlags[index] = image;
  }
  return { positions, fractional, imageFlags, unwrappedPositions: rawPositions, unwrapSource: `out-of-cell ${format} coordinates` };
}

export function inferNonperiodicCell(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 1) {
    const axis = index % 3;
    min[axis] = Math.min(min[axis], positions[index]);
    max[axis] = Math.max(max[axis], positions[index]);
  }
  const padding = min.map((value, axis) => Math.max(0.5, (max[axis] - value) * 0.025));
  const lengths = min.map((value, axis) => max[axis] - value + 2 * padding[axis]);
  return createCell({ origin: min.map((value, axis) => value - padding[axis]),
    vectors: [lengths[0], 0, 0, 0, lengths[1], 0, 0, 0, lengths[2]], pbc: [false, false, false] });
}

function cellFromMetadata(metadata, positions) {
  const pbcTokens = metadata.pbc?.trim().split(/\s+/);
  if (pbcTokens && pbcTokens.length !== 3) throw xyzError('pbc requires three boolean flags.');
  if (metadata.Lattice === undefined) {
    if (pbcTokens?.some((token) => booleanValue(token))) {
      throw xyzError('Periodic pbc flags require a Lattice matrix.');
    }
    return inferNonperiodicCell(positions);
  }
  const vectors = metadata.Lattice.trim().split(/\s+/).map((token) => numeric(token, 'Lattice'));
  if (vectors.length !== 9) throw xyzError('Lattice requires nine values, grouped as the three cell vectors.');
  const pbc = pbcTokens ? pbcTokens.map((token) => Boolean(booleanValue(token))) : [true, true, true];
  return createCell({ vectors, pbc, triclinic: [1, 2, 3, 5, 6, 7].some((index) => Math.abs(vectors[index]) > 1e-12) });
}

function commentMetadata(comment) {
  const result = {};
  const pattern = /(?:^|\s)([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  for (const match of comment.matchAll(pattern)) result[match[1]] = match[2] ?? match[3] ?? match[4];
  return result;
}

function parseFields(schema) {
  if (schema === undefined) return [{ name: 'species', type: 'S', width: 1, offset: 0 }, { name: 'pos', type: 'R', width: 3, offset: 1 }];
  const tokens = schema.split(':');
  if (tokens.length % 3 !== 0) throw xyzError('Properties must contain name:type:width triplets.');
  const fields = [];
  const names = new Set();
  let offset = 0;
  for (let index = 0; index < tokens.length; index += 3) {
    const [name, type, rawWidth] = tokens.slice(index, index + 3);
    const width = Number(rawWidth);
    if (!name || names.has(name) || !['S', 'R', 'I', 'L'].includes(type) || !Number.isSafeInteger(width) || width <= 0 || width > 1024) {
      throw xyzError('Properties contains a duplicate name, unsupported type, or invalid width.');
    }
    fields.push({ name, type, width, offset });
    names.add(name);
    offset += width;
  }
  return fields;
}

function tokenizeRow(line) {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function speciesLabel(token, atomicNumber = false) {
  if (atomicNumber || /^\d+$/.test(token ?? '')) {
    const index = Number(token);
    if (!Number.isSafeInteger(index) || index < 1 || index > ELEMENTS.length) throw xyzError(`Invalid atomic number: ${token}.`);
    return ELEMENTS[index - 1];
  }
  if (!/^[A-Za-z][A-Za-z0-9_+-]*$/.test(token ?? '')) throw xyzError(`Invalid species label: ${token}.`);
  return token;
}

function atomCount(value) {
  if (!/^\s*\d+\s*$/.test(value ?? '')) throw xyzError('Each frame must begin with a positive integer atom count.');
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count <= 0) throw xyzError('The atom count must be a positive safe integer.');
  return count;
}

function booleanValue(value) {
  if (/^(?:t|true|1)$/i.test(value)) return 1;
  if (/^(?:f|false|0)$/i.test(value)) return 0;
  throw xyzError(`Invalid boolean value: ${value}.`);
}

function numeric(value, label, { allowNaN = false } = {}) {
  const number = Number(String(value).replace(/[dD]/, 'e'));
  if (!String(value).trim() || (!Number.isFinite(number) && !(allowNaN && /^nan$/i.test(value)))) throw xyzError(`${label} is not a supported numeric value: ${value}.`);
  return number;
}

function xyzError(message) { return new Error(`XYZ parsing failed: ${message}`); }
