import { PARSER_CHECKPOINT_MASK, parseInputSteps, splitParserLines } from './cooperative-parser.js';
import { runCooperativeSteps, runCooperativeStepsAsync } from '../shared/cooperative-steps.js';
import { cartesianToFractionalSteps, fractionalToCartesianSteps, fractionalToCartesianSummarySteps, wrapFractionalSteps, collectFrameSummarySteps, someParserValues } from './cooperative-coordinates.js';
import { createCell, validateFrame } from '../data/model.js';
import { attachFrameSummary } from '../data/frame-summary.js';
import {
  AsciiRowReader,
  FALLBACK,
  NUMBER,
  SKIP,
  TEXT,
  isAsciiBlank,
  lineStartAfter,
  readHeaderLines,
} from './ascii-rows.js';
import { isBlankLine, lineText, scanLineBytes } from './text-lines.js';

const ELEMENTS = 'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ');

export async function indexXyz(blob, onProgress = () => {}, options = {}) {
  const startedAt = performance.now();
  const offsets = [];
  let stage = 'count';
  let remaining = 0;
  // Atom rows are only counted and checked for content; only count lines
  // are decoded.
  await scanLineBytes(blob, (bytes, from, to, start, end) => {
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
      if (!remaining) {
        stage = 'count';
        options.onFrame?.({ start: offsets[offsets.length - 1], end, index: offsets.length - 1 });
      }
    }
  }, onProgress, options);
  if (offsets.length === 0) throw xyzError('The file contains no XYZ frames.');
  if (stage !== 'count') throw xyzError(`Frame ${offsets.length} is truncated; a comment and all declared atom rows are required.`);
  return { offsets, indexMs: performance.now() - startedAt };
}

export async function readXyzFrame(blob, offsets, index, sourceName = 'trajectory.xyz', options = {}) {
  if (!Number.isInteger(index) || index < 0 || index >= offsets.length) {
    throw new Error(`XYZ trajectory frame ${index} is outside the available range.`);
  }
  const end = offsets[index + 1] ?? blob.size;
  const frame = await parseXyzFrameAsync(new Uint8Array(await blob.slice(offsets[index], end).arrayBuffer()), sourceName, options);
  frame.frameIndex = index;
  return frame;
}

/**
 * Parse one XYZ frame from its text or from its UTF-8 bytes. The atom rows of
 * bytes are read directly when possible (see ascii-rows.js). Otherwise, and
 * for every malformed frame, the bytes are decoded and parsed as text, so the
 * result and any error message do not depend on the input type.
 * Internal coordinate-only reads validate every column but omit unrelated
 * scalar buffers; IDs and image-flag auxiliaries keep their full semantics.
 */
export function parseXyzFrame(input, sourceName = 'structure.xyz', options = {}) {
  return runCooperativeSteps(parseXyzSteps(input, sourceName, options));
}

export function parseXyzFrameAsync(input, sourceName = 'structure.xyz', options = {}) {
  return runCooperativeStepsAsync(parseXyzSteps(input, sourceName, options), options);
}

function* parseXyzSteps(input, sourceName, { projection = 'full' }) {
  const startedAt = performance.now();
  return yield* parseInputSteps(input,
    bytes => parseXyzBytes(bytes, sourceName, startedAt, projection),
    text => parseXyzText(String(text), sourceName, startedAt, projection));
}

function* parseXyzText(text, sourceName, startedAt, projection) {
  const lines = yield* splitParserLines(text);
  const header = readXyzHeader(lines, lines.length, projection);
  const atoms = createXyzAtoms(header);
  yield* readXyzRowsText(lines, header, atoms);
  return yield* finishXyzFrame(header, atoms, sourceName, startedAt);
}

function* parseXyzBytes(bytes, sourceName, startedAt, projection) {
  const header = readHeaderLines(bytes, (lines, usableLines) => readXyzHeader(lines, usableLines, projection));
  if (!header) return null;
  const start = lineStartAfter(bytes, header.cursor);
  // A quoted token may contain blanks (see tokenizeRow); leave quotes to the
  // text parser.
  if (start < 0 || bytes.indexOf(34, start) >= 0 || bytes.indexOf(39, start) >= 0) return null;
  const atoms = createXyzAtoms(header);
  const end = yield* readXyzRowsBytes(bytes, start, header, atoms);
  if (!isAsciiBlank(bytes, end)) return null;
  return yield* finishXyzFrame(header, atoms, sourceName, startedAt);
}

// Reads the count and comment lines. Only the first `usableLines` lines are
// known when the caller decoded just the start of the data; if the header
// continues beyond them, this returns null and the caller decodes more.
export function readXyzHeader(lines, usableLines = lines.length, projection = 'full') {
  let cursor = 0;
  while (!lines[cursor]?.trim() && cursor < lines.length) cursor += 1;
  if (cursor + 1 >= usableLines && usableLines < lines.length) return null;
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
    // Integer auxiliaries may encode identities/categories, so retain the
    // same safe-integer precision as native atom IDs.
    unit: '', data: projection === 'coordinates' ? null : field.type === 'I' ? new Float64Array(count) : new Float32Array(count), field, component,
  })));
  if (new Set(properties.map((property) => property.name)).size !== properties.length) throw xyzError('Flattened numeric property names are duplicated.');
  return { cursor, count, comment, metadata, fields, speciesField, positionField, idField, properties };
}

function createXyzAtoms({ count, fields }) {
  return {
    ids: new Float64Array(count),
    types: new Uint16Array(count),
    positions: new Float32Array(count * 3),
    typeLabels: [],
    typeMap: new Map(),
    columnCount: fields.reduce((sum, field) => sum + field.width, 0),
  };
}

function* readXyzRowsText(lines, { cursor: firstLine, count, speciesField, positionField, idField, properties }, atoms) {
  const { ids, types, positions, typeLabels, typeMap, columnCount } = atoms;
  const seenIds = new Set();
  let cursor = firstLine;
  for (let atom = 0; atom < count; atom += 1, cursor += 1) {
    if ((atom & PARSER_CHECKPOINT_MASK) === 0) yield;
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
      if (property.data) property.data[atom] = value;
    }
  }
  for (; cursor < lines.length; cursor++) {
    if ((cursor & PARSER_CHECKPOINT_MASK) === 0) yield;
    if (lines[cursor].trim()) throw xyzError('Unexpected data after the declared atom rows.');
  }
}

// Byte-level counterpart of readXyzRowsText: the same arrays, and FALLBACK
// wherever that loop would throw (see ascii-rows.js). Returns the position
// after the last row.
function* readXyzRowsBytes(bytes, start, { count, speciesField, positionField, idField, properties }, atoms) {
  const { ids, types, positions, typeLabels, typeMap, columnCount } = atoms;
  const kinds = new Uint8Array(columnCount).fill(SKIP);
  kinds[speciesField.offset] = TEXT;
  for (let axis = 0; axis < 3; axis += 1) kinds[positionField.offset + axis] = NUMBER;
  if (idField) kinds[idField.offset] = NUMBER;
  const propertyCount = properties.length;
  const propertyColumns = new Int32Array(propertyCount);
  // 0: real (NaN allowed), 1: integer, 2: logical
  const propertyTypes = new Uint8Array(propertyCount);
  properties.forEach((property, index) => {
    const column = property.field.offset + property.component;
    propertyColumns[index] = column;
    propertyTypes[index] = property.field.type === 'L' ? 2 : property.field.type === 'I' ? 1 : 0;
    kinds[column] = property.field.type === 'L' ? TEXT : NUMBER;
  });
  const propertyData = properties.map((property) => property.data);
  const values = new Float64Array(columnCount);
  const texts = new Array(columnCount).fill('');
  const atomicNumbers = speciesField.name === 'Z';
  const labels = new Map();
  let lastToken = null;
  let lastType = 0;
  // IDs below the map limit are checked for duplicates in a byte map, larger
  // ones in a Set; together they find exactly the duplicates of the text loop.
  const seenLimit = Math.min(count * 4 + 64, 1 << 26);
  const seen = new Uint8Array(seenLimit);
  const largeIds = new Set();
  const reader = new AsciiRowReader(bytes, start, { fortranExponents: true });
  for (let atom = 0; atom < count; atom += 1) {
    if ((atom & PARSER_CHECKPOINT_MASK) === 0) yield;
    if (reader.readRow(kinds, values, texts) !== columnCount) throw FALLBACK;
    const token = texts[speciesField.offset];
    if (token !== lastToken) {
      let species = labels.get(token);
      if (species === undefined) {
        try {
          species = speciesLabel(token, atomicNumbers);
        } catch {
          throw FALLBACK;
        }
        labels.set(token, species);
      }
      if (!typeMap.has(species)) {
        if (typeLabels.length >= 65_535) throw FALLBACK;
        typeMap.set(species, typeLabels.length);
        typeLabels.push(species);
      }
      lastToken = token;
      lastType = typeMap.get(species);
    }
    types[atom] = lastType;
    for (let axis = 0; axis < 3; axis += 1) {
      const coordinate = values[positionField.offset + axis];
      if (!Number.isFinite(coordinate)) throw FALLBACK;
      positions[atom * 3 + axis] = coordinate;
    }
    let id = atom + 1;
    if (idField) {
      id = values[idField.offset];
      if (!Number.isSafeInteger(id) || id <= 0) throw FALLBACK;
      if (id < seenLimit) {
        if (seen[id] !== 0) throw FALLBACK;
        seen[id] = 1;
      } else {
        if (largeIds.has(id)) throw FALLBACK;
        largeIds.add(id);
      }
    }
    ids[atom] = id;
    for (let property = 0; property < propertyCount; property += 1) {
      const column = propertyColumns[property];
      let value;
      if (propertyTypes[property] === 2) {
        value = logicalValue(texts[column]);
        if (value < 0) throw FALLBACK;
      } else {
        value = values[column];
        // A non-finite value came from the text conversion, so texts[column]
        // holds its token.
        if (!Number.isFinite(value) && !/^nan$/i.test(texts[column])) throw FALLBACK;
        if (propertyTypes[property] === 1 && !Number.isSafeInteger(value)) throw FALLBACK;
      }
      if (propertyData[property]) propertyData[property][atom] = value;
    }
  }
  return reader.position;
}

function* finishXyzFrame(header, atoms, sourceName, startedAt) {
  const { metadata, fields, speciesField, idField, properties, comment } = header;
  const { ids, types, positions, typeLabels } = atoms;
  const summaryOutput = { types, typeCount: typeLabels.length };
  const cell = yield* cellFromMetadataSteps(metadata, positions, summaryOutput);
  const coordinates = yield* coordinatesForCellSteps(positions, cell, 'XYZ', summaryOutput);
  return attachFrameSummary(validateFrame({
    ids, idSource: idField ? 'explicit' : 'row-order', types, typeLabels,
    ...coordinates, cell,
    properties: properties.filter(property => property.data).map(({ field, component, ...property }) => property),
    timestep: parseXyzTimestep(metadata),
    title: sourceName, sourceFormat: 'xyz', comment,
    ignoredStringProperties: fields.filter((field) => field.type === 'S' && field !== speciesField).map((field) => field.name),
    parseMs: performance.now() - startedAt,
  }), summaryOutput.summary);
}

export function parseXyzTimestep(metadata) {
  return metadata.Step !== undefined ? numeric(metadata.Step, 'Step') : null;
}

export function coordinatesForCell(rawPositions, cell, format, summaryOutput) {
  return runCooperativeSteps(coordinatesForCellSteps(rawPositions, cell, format, summaryOutput));
}

export function* coordinatesForCellSteps(rawPositions, cell, format, summaryOutput) {
  const rawFractional = (yield* cartesianToFractionalSteps(rawPositions, cell, new Float64Array(rawPositions.length)));
  const fractional = (yield* wrapFractionalSteps(rawFractional, cell.pbc));
  let positions = rawPositions;
  if (cell.pbc.some(Boolean)) {
    if (summaryOutput) {
      const result = (yield* fractionalToCartesianSummarySteps(fractional, cell, summaryOutput.types, summaryOutput.typeCount));
      positions = result.positions;
      summaryOutput.summary = result.summary;
    } else positions = (yield* fractionalToCartesianSteps(fractional, cell));
  } else if (summaryOutput && !summaryOutput.summary) summaryOutput.summary = (yield* collectFrameSummarySteps(summaryOutput.types, positions, summaryOutput.typeCount));
  const hasImages = yield* someParserValues(rawFractional, (value, index) => cell.pbc[index % 3] && (value < 0 || value >= 1));
  if (!hasImages) return { positions, fractional };
  const imageFlags = new Int32Array(rawPositions.length);
  for (let index = 0; index < rawFractional.length; index += 1) {
    if ((index & PARSER_CHECKPOINT_MASK) === 0) yield;
    const image = cell.pbc[index % 3] ? Math.floor(rawFractional[index]) : 0;
    if (image < -2_147_483_648 || image > 2_147_483_647) throw new Error(`${format} coordinates exceed the supported image-flag range.`);
    imageFlags[index] = image;
  }
  return { positions, fractional, imageFlags, unwrappedPositions: rawPositions, unwrapSource: `out-of-cell ${format} coordinates` };
}

export function inferNonperiodicCell(positions, summaryOutput) {
  return runCooperativeSteps(inferNonperiodicCellSteps(positions, summaryOutput));
}

export function* inferNonperiodicCellSteps(positions, summaryOutput) {
  // Free structures already need a bounds pass to infer their cell. Count
  // types there too, and reuse the same extrema for later display.
  if (summaryOutput) summaryOutput.summary = (yield* collectFrameSummarySteps(summaryOutput.types, positions, summaryOutput.typeCount));
  const min = summaryOutput?.summary.minimum ?? [Infinity, Infinity, Infinity];
  const max = summaryOutput?.summary.maximum ?? [-Infinity, -Infinity, -Infinity];
  if (!summaryOutput) for (let index = 0; index < positions.length; index += 1) {
    if ((index & PARSER_CHECKPOINT_MASK) === 0) yield;
    const axis = index % 3;
    min[axis] = Math.min(min[axis], positions[index]);
    max[axis] = Math.max(max[axis], positions[index]);
  }
  const padding = min.map((value, axis) => Math.max(0.5, (max[axis] - value) * 0.025));
  const lengths = min.map((value, axis) => max[axis] - value + 2 * padding[axis]);
  return createCell({ origin: min.map((value, axis) => value - padding[axis]),
    vectors: [lengths[0], 0, 0, 0, lengths[1], 0, 0, 0, lengths[2]], pbc: [false, false, false] });
}

export function cellFromMetadata(metadata, positions, summaryOutput) {
  return runCooperativeSteps(cellFromMetadataSteps(metadata, positions, summaryOutput));
}

export function* cellFromMetadataSteps(metadata, positions, summaryOutput) {
  const pbcTokens = metadata.pbc?.trim().split(/\s+/);
  if (pbcTokens && pbcTokens.length !== 3) throw xyzError('pbc requires three boolean flags.');
  if (metadata.Lattice === undefined) {
    if (pbcTokens?.some((token) => booleanValue(token))) {
      throw xyzError('Periodic pbc flags require a Lattice matrix.');
    }
    return yield* inferNonperiodicCellSteps(positions, summaryOutput);
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
  const logical = logicalValue(value);
  if (logical < 0) throw xyzError(`Invalid boolean value: ${value}.`);
  return logical;
}

function logicalValue(value) {
  if (/^(?:t|true|1)$/i.test(value)) return 1;
  if (/^(?:f|false|0)$/i.test(value)) return 0;
  return -1;
}

function numeric(value, label, { allowNaN = false } = {}) {
  const number = Number(String(value).replace(/[dD]/, 'e'));
  if (!String(value).trim() || (!Number.isFinite(number) && !(allowNaN && /^nan$/i.test(value)))) throw xyzError(`${label} is not a supported numeric value: ${value}.`);
  return number;
}

function xyzError(message) { return new Error(`XYZ parsing failed: ${message}`); }
