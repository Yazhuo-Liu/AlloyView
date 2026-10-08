import {
  cartesianToFractional,
  createCell,
  fractionalToCartesian,
  validateFrame,
  wrapFractional,
} from '../data/model.js';
import {
  AsciiRowReader,
  FALLBACK,
  NUMBER,
  SKIP,
  TEXT,
  asBytes,
  decodeText,
  isByteInput,
  lineStartAfter,
  parseBytesWithFallback,
} from './ascii-rows.js';

const TIMESTEP_MARKER = new TextEncoder().encode('ITEM: TIMESTEP');
const WRAPPED_COORDINATE_SETS = [
  { names: ['x', 'y', 'z'], scaled: false },
  { names: ['xs', 'ys', 'zs'], scaled: true },
];
const UNWRAPPED_COORDINATE_SETS = [
  { names: ['xu', 'yu', 'zu'], scaled: false },
  { names: ['xsu', 'ysu', 'zsu'], scaled: true },
];
const COORDINATE_SETS = [...WRAPPED_COORDINATE_SETS, ...UNWRAPPED_COORDINATE_SETS];
const IMAGE_COLUMNS = ['ix', 'iy', 'iz'];
const RESERVED_COLUMNS = new Set([
  'id', 'type', 'element',
  ...COORDINATE_SETS.flatMap((set) => set.names),
  ...IMAGE_COLUMNS,
]);

export async function indexLammpsDump(blob, onProgress = () => {}, { onFrame = () => {}, chunkSize = 4 * 1024 * 1024, signal } = {}) {
  const startedAt = performance.now();
  const overlap = TIMESTEP_MARKER.length + 1;
  const offsets = [];
  const seen = new Set();
  let tail = new Uint8Array(0);

  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    if (signal?.aborted) throw new DOMException('Trajectory indexing cancelled.', 'AbortError');
    const end = Math.min(blob.size, offset + chunkSize);
    const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    const combined = new Uint8Array(tail.length + chunk.length);
    combined.set(tail);
    combined.set(chunk, tail.length);
    const baseOffset = offset - tail.length;

    const last = combined.length - TIMESTEP_MARKER.length;
    for (let index = combined.indexOf(TIMESTEP_MARKER[0]); index >= 0 && index <= last; index = combined.indexOf(TIMESTEP_MARKER[0], index + 1)) {
      if (index > 0 && combined[index - 1] !== 10) continue;
      let matches = true;
      for (let markerIndex = 1; markerIndex < TIMESTEP_MARKER.length; markerIndex += 1) {
        if (combined[index + markerIndex] !== TIMESTEP_MARKER[markerIndex]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        const absolute = baseOffset + index;
        if (absolute >= 0 && !seen.has(absolute)) {
          seen.add(absolute);
          if (offsets.length) onFrame({ start: offsets[offsets.length - 1], end: absolute, index: offsets.length - 1 });
          offsets.push(absolute);
        }
      }
    }

    tail = combined.slice(Math.max(0, combined.length - overlap));
    onProgress({ loaded: end, total: blob.size });
  }

  offsets.sort((left, right) => left - right);
  if (offsets.length === 0 || offsets[0] !== 0) {
    throw dumpError('The file does not begin with “ITEM: TIMESTEP”.');
  }
  onFrame({ start: offsets[offsets.length - 1], end: blob.size, index: offsets.length - 1 });
  return { offsets, indexMs: performance.now() - startedAt };
}

export async function readLammpsFrame(blob, offsets, frameIndex, sourceName = 'trajectory.dump') {
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= offsets.length) {
    throw new Error(`Trajectory frame ${frameIndex} is outside the range 0..${offsets.length - 1}.`);
  }
  const end = frameIndex + 1 < offsets.length ? offsets[frameIndex + 1] : blob.size;
  const bytes = new Uint8Array(await blob.slice(offsets[frameIndex], end).arrayBuffer());
  return parseLammpsFrame(bytes, sourceName);
}

/**
 * Parse one dump frame from its text or from its UTF-8 bytes. The atom rows
 * of bytes are read directly when possible (see ascii-rows.js). Otherwise, and
 * for every malformed frame, the bytes are decoded and parsed as text, so the
 * result and any error message do not depend on the input type.
 */
export function parseLammpsFrame(input, sourceName = 'trajectory.dump') {
  const startedAt = performance.now();
  if (!isByteInput(input)) return parseLammpsText(input, sourceName, startedAt);
  return parseBytesWithFallback(
    asBytes(input),
    (bytes) => parseLammpsBytes(bytes, sourceName, startedAt),
    (text) => parseLammpsText(text, sourceName, startedAt),
  );
}

function parseLammpsText(text, sourceName, startedAt) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = readDumpHeader(lines);
  const atoms = createDumpAtoms(header);
  readDumpRowsText(lines, header, atoms);
  return finishDumpFrame(header, atoms, sourceName, startedAt);
}

// The header occupies the first nine lines. Decoding only those bytes yields
// the same lines as decoding the frame: a UTF-8 sequence never spans a line
// feed, and the leading BOM is removed in both cases.
const HEADER_LINES = 9;

function parseLammpsBytes(bytes, sourceName, startedAt) {
  const atomStart = lineStartAfter(bytes, HEADER_LINES);
  if (atomStart < 0) return null;
  const lines = decodeText(bytes.subarray(0, atomStart)).replace(/^\uFEFF/, '').split(/\r?\n/);
  const header = readDumpHeader(lines);
  if (header.cursor !== HEADER_LINES) return null;
  const atoms = createDumpAtoms(header);
  readDumpRowsBytes(bytes, atomStart, header, atoms);
  return finishDumpFrame(header, atoms, sourceName, startedAt);
}

function readDumpHeader(lines) {
  let cursor = 0;

  expectHeader(lines, cursor, 'ITEM: TIMESTEP');
  cursor += 1;
  const timestep = integerValue(lines[cursor], cursor, 'timestep', { allowNegative: true });
  cursor += 1;
  expectHeader(lines, cursor, 'ITEM: NUMBER OF ATOMS');
  cursor += 1;
  const count = integerValue(lines[cursor], cursor, 'atom count');
  if (count <= 0) throw dumpError(`Line ${cursor + 1}: the atom count must be greater than zero.`);
  cursor += 1;

  const boxHeader = lines[cursor]?.trim() ?? '';
  if (!boxHeader.startsWith('ITEM: BOX BOUNDS')) {
    throw dumpError(`Line ${cursor + 1}: expected “ITEM: BOX BOUNDS”; found “${boxHeader}”.`);
  }
  const boxTokens = boxHeader.slice('ITEM: BOX BOUNDS'.length).trim().split(/\s+/).filter(Boolean);
  if (boxTokens.includes('abc') || boxTokens.includes('origin')) {
    throw dumpError('LAMMPS general triclinic “abc origin” output is not supported. Export the restricted triclinic xy/xz/yz format instead.');
  }
  const triclinic = ['xy', 'xz', 'yz'].every((token) => boxTokens.includes(token));
  const hasSomeTilt = ['xy', 'xz', 'yz'].some((token) => boxTokens.includes(token));
  if (hasSomeTilt && !triclinic) throw dumpError('BOX BOUNDS tilt labels must include xy, xz, and yz together.');
  const boundaryFlags = boxTokens.filter((token) => /^[pfsm]{2}$/i.test(token));
  if (boundaryFlags.length !== 3) {
    throw dumpError('BOX BOUNDS must provide three boundary flags, for example “pp pp pp”.');
  }
  cursor += 1;

  const bounds = [];
  for (let dimension = 0; dimension < 3; dimension += 1, cursor += 1) {
    const tokens = (lines[cursor] ?? '').trim().split(/\s+/).filter(Boolean);
    const expected = triclinic ? 3 : 2;
    if (tokens.length !== expected) {
      throw dumpError(`Line ${cursor + 1}: ${triclinic ? 'triclinic' : 'orthogonal'} bounds require ${expected} numeric values.`);
    }
    bounds.push(tokens.map((value) => finiteValue(value, cursor, 'cell bound')));
  }
  const cell = createDumpCell(bounds, boundaryFlags, triclinic);

  const atomHeader = lines[cursor]?.trim() ?? '';
  if (!atomHeader.startsWith('ITEM: ATOMS ')) {
    throw dumpError(`Line ${cursor + 1}: expected “ITEM: ATOMS …” followed by column names.`);
  }
  const columns = atomHeader.slice('ITEM: ATOMS '.length).trim().split(/\s+/);
  if (new Set(columns).size !== columns.length) throw dumpError('ITEM: ATOMS contains duplicate column names.');
  const columnIndex = new Map(columns.map((name, index) => [name, index]));
  if (!columnIndex.has('id')) throw dumpError('ITEM: ATOMS is missing the required id column.');
  if (!columnIndex.has('type')) throw dumpError('ITEM: ATOMS is missing the required numeric type column.');
  assertCompleteCoordinateSets(columnIndex);
  const wrappedCoordinateSet = WRAPPED_COORDINATE_SETS.find((set) => set.names.every((name) => columnIndex.has(name)));
  const unwrappedCoordinateSet = UNWRAPPED_COORDINATE_SETS.find((set) => set.names.every((name) => columnIndex.has(name)));
  if (!wrappedCoordinateSet && !unwrappedCoordinateSet) {
    throw dumpError('Coordinate columns must provide one complete set of x/y/z, xu/yu/zu, xs/ys/zs, or xsu/ysu/zsu.');
  }
  const imageColumnCount = IMAGE_COLUMNS.filter((name) => columnIndex.has(name)).length;
  if (imageColumnCount > 0 && imageColumnCount < IMAGE_COLUMNS.length) {
    throw dumpError('Image flags must provide ix, iy, and iz together; partial image flags cannot be used to unwrap coordinates.');
  }
  const hasImageFlags = imageColumnCount === IMAGE_COLUMNS.length;
  cursor += 1;

  return {
    cursor, timestep, count, cell, columns, columnIndex,
    wrappedCoordinateSet, unwrappedCoordinateSet, hasImageFlags,
  };
}

function createDumpAtoms({ count, columns, columnIndex, wrappedCoordinateSet, unwrappedCoordinateSet, hasImageFlags }) {
  const propertyNames = columns.filter((name) => !RESERVED_COLUMNS.has(name));
  const wrappedValues = wrappedCoordinateSet ? new Float32Array(count * 3) : null;
  const unwrappedValues = unwrappedCoordinateSet ? new Float32Array(count * 3) : null;
  return {
    propertyNames,
    ids: new Float64Array(count),
    rawTypes: new Float64Array(count),
    types: new Uint16Array(count),
    wrappedValues,
    unwrappedValues,
    imageFlags: hasImageFlags ? new Int32Array(count * 3) : null,
    properties: propertyNames.map((name) => ({ name, unit: '', data: new Float32Array(count) })),
    elements: columnIndex.has('element') ? new Array(count) : null,
    // Column positions are fixed for the frame; resolve them once rather
    // than per atom.
    coordinateReaders: [[wrappedCoordinateSet, wrappedValues], [unwrappedCoordinateSet, unwrappedValues]]
      .filter(([coordinateSet]) => coordinateSet)
      .map(([coordinateSet, values]) => ({ values, names: coordinateSet.names, columns: coordinateSet.names.map(name => columnIndex.get(name)) })),
  };
}

function readDumpRowsText(lines, { cursor: firstLine, count, columns, columnIndex }, atoms) {
  const { propertyNames, ids, rawTypes, imageFlags, properties, elements, coordinateReaders } = atoms;
  const idSet = new Set();
  const idColumn = columnIndex.get('id'), typeColumn = columnIndex.get('type'), elementColumn = columnIndex.get('element');
  const imageColumns = IMAGE_COLUMNS.map(name => columnIndex.get(name));
  const propertyColumns = propertyNames.map(name => columnIndex.get(name));
  // Keep the per-atom loop free of allocations.
  for (let atom = 0, cursor = firstLine; atom < count; atom += 1, cursor += 1) {
    // After trim(), splitting on whitespace yields an empty token only for an empty line.
    const line = (lines[cursor] ?? '').trim();
    const tokens = line === '' ? [] : line.split(/\s+/);
    if (tokens.length !== columns.length) {
      throw dumpError(`Line ${cursor + 1} (atom ${atom + 1}): expected ${columns.length} columns; found ${tokens.length}.`);
    }
    const id = integerValue(tokens[idColumn], cursor, 'id');
    if (idSet.has(id)) throw dumpError(`Line ${cursor + 1}: atom ID ${id} is duplicated.`);
    idSet.add(id);
    ids[atom] = id;
    const rawType = integerValue(tokens[typeColumn], cursor, 'type');
    if (rawType <= 0) throw dumpError(`Line ${cursor + 1}: type must be a positive integer.`);
    rawTypes[atom] = rawType;
    if (elements) elements[atom] = tokens[elementColumn];
    for (const { values, names, columns: coordinateColumns } of coordinateReaders) {
      for (let component = 0; component < 3; component += 1) {
        values[atom * 3 + component] = finiteValue(tokens[coordinateColumns[component]], cursor, names[component]);
      }
    }
    if (imageFlags) {
      for (let component = 0; component < 3; component += 1) {
        const name = IMAGE_COLUMNS[component];
        const image = integerValue(tokens[imageColumns[component]], cursor, name, { allowNegative: true });
        if (image < -2_147_483_648 || image > 2_147_483_647) {
          throw dumpError(`Line ${cursor + 1}: ${name} is outside the supported 32-bit image-flag range.`);
        }
        imageFlags[atom * 3 + component] = image;
      }
    }
    for (let property = 0; property < properties.length; property += 1) {
      properties[property].data[atom] = finiteValue(tokens[propertyColumns[property]], cursor, propertyNames[property]);
    }
  }
}

// Fills the same arrays as readDumpRowsText. Wherever that loop would throw,
// this one throws FALLBACK instead, and the text parser reports the error.
// Reserved columns that the frame does not use (for example xs/ys/zs next to
// x/y/z) are skipped without conversion, as in the text loop.
function readDumpRowsBytes(bytes, start, { count, columns, columnIndex }, atoms) {
  const { propertyNames, ids, rawTypes, imageFlags, properties, elements, coordinateReaders } = atoms;
  const columnCount = columns.length;
  const kinds = new Uint8Array(columnCount).fill(SKIP);
  const idColumn = columnIndex.get('id'), typeColumn = columnIndex.get('type'), elementColumn = columnIndex.get('element');
  kinds[idColumn] = NUMBER;
  kinds[typeColumn] = NUMBER;
  if (elements) kinds[elementColumn] = TEXT;
  // Finite real columns: [column, stride, offset] with their target arrays.
  const realColumns = [];
  const realTargets = [];
  for (const { values, columns: coordinateColumns } of coordinateReaders) {
    coordinateColumns.forEach((column, component) => {
      realColumns.push(column, 3, component);
      realTargets.push(values);
    });
  }
  propertyNames.forEach((name, property) => {
    realColumns.push(columnIndex.get(name), 1, 0);
    realTargets.push(properties[property].data);
  });
  for (let index = 0; index < realColumns.length; index += 3) kinds[realColumns[index]] = NUMBER;
  const real = Int32Array.from(realColumns);
  const realCount = realTargets.length;
  const imageColumns = Int32Array.from(IMAGE_COLUMNS, (name) => columnIndex.get(name) ?? 0);
  if (imageFlags) for (const column of imageColumns) kinds[column] = NUMBER;

  // IDs below the map limit are checked for duplicates in a byte map, larger
  // ones in a Set. Together they find exactly the duplicates that the Set of
  // the text loop finds; both treat -0 and 0 as the same ID.
  const seenLimit = Math.min(count * 4 + 64, 1 << 26);
  const seen = new Uint8Array(seenLimit);
  const largeIds = new Set();
  const values = new Float64Array(columnCount);
  const texts = new Array(columnCount).fill('');
  const reader = new AsciiRowReader(bytes, start);
  for (let atom = 0; atom < count; atom += 1) {
    if (reader.readRow(kinds, values, texts) !== columnCount) throw FALLBACK;
    const id = values[idColumn];
    if (!Number.isSafeInteger(id) || id < 0) throw FALLBACK;
    if (id < seenLimit) {
      if (seen[id] !== 0) throw FALLBACK;
      seen[id] = 1;
    } else {
      if (largeIds.has(id)) throw FALLBACK;
      largeIds.add(id);
    }
    ids[atom] = id;
    const type = values[typeColumn];
    if (!Number.isSafeInteger(type) || type <= 0) throw FALLBACK;
    rawTypes[atom] = type;
    if (elements) elements[atom] = texts[elementColumn];
    for (let index = 0; index < realCount; index += 1) {
      const value = values[real[index * 3]];
      if (!Number.isFinite(value)) throw FALLBACK;
      realTargets[index][atom * real[index * 3 + 1] + real[index * 3 + 2]] = value;
    }
    if (imageFlags) {
      for (let component = 0; component < 3; component += 1) {
        const image = values[imageColumns[component]];
        if (!Number.isSafeInteger(image) || image < -2_147_483_648 || image > 2_147_483_647) throw FALLBACK;
        imageFlags[atom * 3 + component] = image;
      }
    }
  }
}

function finishDumpFrame(header, atoms, sourceName, startedAt) {
  const { count, cell, timestep, wrappedCoordinateSet, unwrappedCoordinateSet } = header;
  const { ids, rawTypes, types, wrappedValues, unwrappedValues, imageFlags, properties, elements } = atoms;
  const rawTypeLabels = [...new Set(rawTypes)].sort((left, right) => left - right);
  if (rawTypeLabels.length > 65_535) throw dumpError('The file contains more than 65,535 atom types, which the current data layout cannot represent.');
  const typeMap = new Map(rawTypeLabels.map((value, index) => [value, index]));
  const typeLabels = rawTypeLabels.map((value) => `Type ${value}`);
  const elementByType = new Map();
  for (let atom = 0; atom < count; atom += 1) {
    const typeIndex = typeMap.get(rawTypes[atom]);
    types[atom] = typeIndex;
    if (elements) {
      const previous = elementByType.get(rawTypes[atom]);
      if (previous && previous !== elements[atom]) {
        throw dumpError(`Type ${rawTypes[atom]} maps to both element “${previous}” and “${elements[atom]}”.`);
      }
      elementByType.set(rawTypes[atom], elements[atom]);
      typeLabels[typeIndex] = elements[atom];
    }
  }

  const sourceCoordinateSet = wrappedCoordinateSet ?? unwrappedCoordinateSet;
  const sourceValues = wrappedValues ?? unwrappedValues;
  const sourceFractional = coordinateSetToFractional(sourceCoordinateSet, sourceValues, cell);
  const fractional = wrapFractional(sourceFractional, cell.pbc);
  const positions = fractionalToCartesian(fractional, cell);

  let unwrappedPositions = null;
  let unwrapSource = null;
  if (unwrappedCoordinateSet) {
    const unwrappedFractional = coordinateSetToFractional(unwrappedCoordinateSet, unwrappedValues, cell);
    unwrappedPositions = unwrappedCoordinateSet.scaled
      ? fractionalToCartesian(unwrappedFractional, cell)
      : unwrappedValues;
    unwrapSource = unwrappedCoordinateSet.names.join('/');
  } else if (imageFlags && wrappedCoordinateSet) {
    const unwrappedFractional = addImageFlags(sourceFractional, imageFlags);
    unwrappedPositions = fractionalToCartesian(unwrappedFractional, cell);
    unwrapSource = 'ix/iy/iz';
  }

  return validateFrame({
    ids,
    types,
    typeLabels,
    positions,
    fractional,
    unwrappedPositions,
    imageFlags,
    cell,
    properties,
    timestep,
    title: `${sourceName} · ${timestep}`,
    sourceFormat: 'lammps-dump',
    coordinateColumns: {
      wrapped: wrappedCoordinateSet?.names ?? null,
      unwrapped: unwrappedCoordinateSet?.names ?? null,
    },
    unwrapSource,
    parseMs: performance.now() - startedAt,
  });
}

function assertCompleteCoordinateSets(columnIndex) {
  for (const set of COORDINATE_SETS) {
    const present = set.names.filter((name) => columnIndex.has(name));
    if (present.length > 0 && present.length < set.names.length) {
      const missing = set.names.filter((name) => !columnIndex.has(name));
      throw dumpError(`Coordinate set ${set.names.join('/')} is incomplete; missing ${missing.join(', ')}.`);
    }
  }
}

function coordinateSetToFractional(coordinateSet, values, cell) {
  return coordinateSet.scaled ? values : cartesianToFractional(values, cell);
}

function addImageFlags(fractional, imageFlags) {
  const unwrapped = new Float32Array(fractional.length);
  for (let index = 0; index < fractional.length; index += 1) unwrapped[index] = fractional[index] + imageFlags[index];
  return unwrapped;
}

function createDumpCell(bounds, boundaryFlags, triclinic) {
  let origin;
  let vectors;
  if (!triclinic) {
    const [x, y, z] = bounds;
    if (!(x[1] > x[0] && y[1] > y[0] && z[1] > z[0])) throw dumpError('Every upper cell bound must be greater than its lower bound.');
    origin = [x[0], y[0], z[0]];
    vectors = [x[1] - x[0], 0, 0, 0, y[1] - y[0], 0, 0, 0, z[1] - z[0]];
  } else {
    const [[xloBound, xhiBound, xy], [yloBound, yhiBound, xz], [zlo, zhi, yz]] = bounds;
    const xlo = xloBound - Math.min(0, xy, xz, xy + xz);
    const xhi = xhiBound - Math.max(0, xy, xz, xy + xz);
    const ylo = yloBound - Math.min(0, yz);
    const yhi = yhiBound - Math.max(0, yz);
    if (!(xhi > xlo && yhi > ylo && zhi > zlo)) throw dumpError('The cell has a non-positive length after converting its tilt factors.');
    origin = [xlo, ylo, zlo];
    vectors = [xhi - xlo, 0, 0, xy, yhi - ylo, 0, xz, yz, zhi - zlo];
  }
  return createCell({
    origin,
    vectors,
    pbc: boundaryFlags.map((flag) => flag.toLowerCase() === 'pp'),
    triclinic,
  });
}

function expectHeader(lines, cursor, expected) {
  const actual = lines[cursor]?.trim() ?? '';
  if (actual !== expected) throw dumpError(`Line ${cursor + 1}: expected “${expected}”; found “${actual}”.`);
}

function finiteValue(value, lineIndex, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw dumpError(`${label} on line ${lineIndex + 1} is not a finite number: “${value}”. Non-numeric custom columns are not supported.`);
  }
  return number;
}

function integerValue(value, lineIndex, label, { allowNegative = false } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (!allowNegative && number < 0)) {
    throw dumpError(`${label} on line ${lineIndex + 1} must be a ${allowNegative ? '' : 'non-negative '}safe integer: “${value}”.`);
  }
  return number;
}

function dumpError(message) {
  return new Error(`LAMMPS dump parsing failed: ${message}`);
}
