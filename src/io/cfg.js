import {
  createCell,
  fractionalToCartesian,
  multiply3,
  validateFrame,
  wrapFractional,
} from '../data/model.js';

const NUMBER_PATTERN = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[EeDd][-+]?\\d+)?';
const IDENTITY = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const CFG_BOUNDARY_TOLERANCE = 1e-5;

export function parseCfg(text, sourceName = 'structure.cfg') {
  const startedAt = performance.now();
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const firstIndex = lines.findIndex((line) => line.trim() && !line.trim().startsWith('#'));
  if (firstIndex < 0) throw cfgError('The file is empty.');

  const countMatch = lines[firstIndex].trim().match(/^Number\s+of\s+particles\s*=\s*(\d+)\s*$/i);
  if (!countMatch) throw cfgError('The first non-comment line must be “Number of particles = N”.');
  const count = Number(countMatch[1]);
  if (!Number.isSafeInteger(count) || count <= 0) throw cfgError('The particle count must be a positive integer.');

  const h0 = new Float64Array(9);
  const h0Seen = new Set();
  const transform = Float64Array.from(IDENTITY);
  const eta = new Float64Array(9);
  const auxiliary = new Map();
  let lengthScale = 1;
  let entryCount = null;
  let noVelocity = false;
  let dataIndex = -1;

  for (let lineIndex = firstIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].trim();
    if (!line || line.startsWith('#')) continue;

    let match = line.match(new RegExp(`^A\\s*=\\s*(${NUMBER_PATTERN})(?:\\s+Angstrom)?`, 'i'));
    if (match) {
      lengthScale = finiteNumber(match[1], `A on line ${lineIndex + 1}`);
      if (lengthScale <= 0) throw cfgError(`Line ${lineIndex + 1}: A must be greater than zero.`);
      continue;
    }

    match = line.match(new RegExp(`^H0\\((\\d+),(\\d+)\\)\\s*=\\s*(${NUMBER_PATTERN})`, 'i'));
    if (match) {
      const row = Number(match[1]) - 1;
      const column = Number(match[2]) - 1;
      assertMatrixIndex(row, column, lineIndex);
      h0[row * 3 + column] = finiteNumber(match[3], `H0 on line ${lineIndex + 1}`);
      h0Seen.add(row * 3 + column);
      continue;
    }

    match = line.match(new RegExp(`^Transform\\((\\d+),(\\d+)\\)\\s*=\\s*(${NUMBER_PATTERN})`, 'i'));
    if (match) {
      const row = Number(match[1]) - 1;
      const column = Number(match[2]) - 1;
      assertMatrixIndex(row, column, lineIndex);
      transform[row * 3 + column] = finiteNumber(match[3], `Transform on line ${lineIndex + 1}`);
      continue;
    }

    match = line.match(new RegExp(`^eta\\((\\d+),(\\d+)\\)\\s*=\\s*(${NUMBER_PATTERN})`, 'i'));
    if (match) {
      const row = Number(match[1]) - 1;
      const column = Number(match[2]) - 1;
      assertMatrixIndex(row, column, lineIndex);
      const value = finiteNumber(match[3], `eta on line ${lineIndex + 1}`);
      eta[row * 3 + column] = value;
      eta[column * 3 + row] = value;
      continue;
    }

    if (/^\.NO_VELOCITY\.\s*$/i.test(line)) {
      noVelocity = true;
      continue;
    }

    match = line.match(/^entry_count\s*=\s*(\d+)\s*$/i);
    if (match) {
      entryCount = Number(match[1]);
      continue;
    }

    match = line.match(/^auxiliary\[(\d+)]\s*=\s*(.+)$/i);
    if (match) {
      const index = Number(match[1]);
      const description = match[2].trim();
      const unitMatch = description.match(/^(.*?)\s*\[([^\]]*)]\s*$/);
      auxiliary.set(index, {
        name: (unitMatch ? unitMatch[1] : description).trim() || `aux_${index}`,
        unit: unitMatch ? unitMatch[2].trim() : '',
      });
      continue;
    }

    if (/^R\s*=/.test(line)) continue;
    dataIndex = lineIndex;
    break;
  }

  if (h0Seen.size !== 9) {
    const missing = [...Array(9).keys()].filter((index) => !h0Seen.has(index))
      .map((index) => `H0(${Math.floor(index / 3) + 1},${index % 3 + 1})`);
    throw cfgError(`The cell definition is incomplete; missing ${missing.join(', ')}.`);
  }
  if (dataIndex < 0) throw cfgError('No atom data block was found.');

  const hasTransform = transform.some((value, index) => Math.abs(value - IDENTITY[index]) > 1e-12);
  const hasEta = eta.some((value) => Math.abs(value) > 1e-12);
  if (hasTransform && hasEta) {
    throw cfgError('A non-identity Transform combined with non-zero eta is not supported because their precedence is ambiguous in the upstream implementation.');
  }

  let vectors = hasEta ? multiply3(h0, symmetricSquareRoot(addIdentityTwice(eta))) : multiply3(h0, transform);
  vectors = Float64Array.from(vectors, (value) => value * lengthScale);
  const cell = createCell({
    vectors,
    pbc: [true, true, true],
    triclinic: hasOffDiagonal(vectors),
  });

  const parsed = entryCount === null
    ? parseBasicAtoms(lines, dataIndex, count)
    : parseExtendedAtoms(lines, dataIndex, count, entryCount, noVelocity, auxiliary);
  const rawFractional = parsed.fractional;
  const fractional = wrapCfgFractional(rawFractional, cell.pbc);
  const semantics = extractExtendedSemantics(parsed.properties, count);
  let unwrappedPositions;
  let imageFlags = semantics.imageFlags;
  let unwrapSource;
  if (semantics.imageFlags) {
    const unwrappedFractional = Float64Array.from(fractional);
    for (let atom = 0; atom < count; atom += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        unwrappedFractional[atom * 3 + axis] += semantics.imageFlags[atom * 3 + axis];
      }
    }
    unwrappedPositions = fractionalToCartesian(unwrappedFractional, cell);
    unwrapSource = 'ix/iy/iz';
  } else {
    imageFlags = inferCfgImageFlags(rawFractional, cell.pbc);
    if (imageFlags) {
      const unwrappedFractional = new Float64Array(fractional.length);
      for (let index = 0; index < fractional.length; index += 1) unwrappedFractional[index] = fractional[index] + imageFlags[index];
      unwrappedPositions = fractionalToCartesian(unwrappedFractional, cell);
      unwrapSource = 'out-of-cell CFG coordinates';
    }
  }
  const frame = validateFrame({
    ids: semantics.ids ?? rowOrderIds(count),
    types: parsed.types,
    typeLabels: parsed.typeLabels,
    idSource: semantics.ids ? 'explicit' : 'row-order',
    positions: fractionalToCartesian(fractional, cell),
    unwrappedPositions,
    imageFlags,
    unwrapSource,
    fractional,
    cell,
    properties: semantics.properties,
    timestep: null,
    title: sourceName,
    sourceFormat: 'cfg',
    parseMs: performance.now() - startedAt,
  });
  return frame;
}

function rowOrderIds(count) {
  const ids = new Float64Array(count);
  for (let index = 0; index < count; index += 1) ids[index] = index + 1;
  return ids;
}

function wrapCfgFractional(fractional, pbc) {
  const stabilized = new Float64Array(fractional.length);
  for (let index = 0; index < fractional.length; index += 1) {
    const value = fractional[index];
    if (!pbc[index % 3]) { stabilized[index] = value; continue; }
    const nearestInteger = Math.round(value);
    stabilized[index] = Math.abs(value - nearestInteger) <= CFG_BOUNDARY_TOLERANCE ? nearestInteger : value;
  }
  return wrapFractional(stabilized, pbc);
}

function inferCfgImageFlags(rawFractional, pbc) {
  let hasMeaningfulImage = false;
  const flags = new Int32Array(rawFractional.length);
  for (let index = 0; index < rawFractional.length; index += 1) {
    if (!pbc[index % 3]) continue;
    const value = rawFractional[index];
    if (value < -CFG_BOUNDARY_TOLERANCE || value > 1 + CFG_BOUNDARY_TOLERANCE) {
      const image = Math.floor(value);
      if (image < -2_147_483_648 || image > 2_147_483_647) {
        throw cfgError(`Fractional coordinate ${value} requires an unsupported image flag.`);
      }
      flags[index] = image;
      hasMeaningfulImage = true;
    }
  }
  return hasMeaningfulImage ? flags : undefined;
}

function parseBasicAtoms(lines, start, count) {
  const fractional = new Float64Array(count * 3);
  const types = new Uint16Array(count);
  const masses = new Float32Array(count);
  const velocity = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  const typeMap = new Map();
  let hasVelocity = null;
  let atom = 0;

  for (let index = start; index < lines.length && atom < count; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length !== 5 && tokens.length !== 8) {
      throw cfgError(`Line ${index + 1}: a basic CFG atom row must have 5 or 8 columns; found ${tokens.length}.`);
    }
    const rowHasVelocity = tokens.length === 8;
    if (hasVelocity !== null && hasVelocity !== rowHasVelocity) {
      throw cfgError(`Line ${index + 1}: atom rows with and without velocities cannot be mixed in one data block.`);
    }
    hasVelocity = rowHasVelocity;
    masses[atom] = finiteNumber(tokens[0], `mass on line ${index + 1}`);
    const symbol = validateSymbol(tokens[1], index);
    if (!typeMap.has(symbol)) typeMap.set(symbol, typeMap.size);
    types[atom] = typeMap.get(symbol);
    for (let component = 0; component < 3; component += 1) {
      fractional[atom * 3 + component] = finiteNumber(tokens[2 + component], `fractional coordinate on line ${index + 1}`);
      if (rowHasVelocity) velocity[component][atom] = finiteNumber(tokens[5 + component], `velocity on line ${index + 1}`);
    }
    atom += 1;
  }

  if (atom !== count) throw cfgError(`The atom data ended early: ${count} atoms were declared, but only ${atom} were read.`);
  const properties = [{ name: 'mass', unit: 'amu', data: masses }];
  if (hasVelocity) {
    for (let component = 0; component < 3; component += 1) {
      properties.push({ name: `velocity_${'xyz'[component]}`, unit: '', data: velocity[component] });
    }
  }
  return { fractional, types, typeLabels: [...typeMap.keys()], properties };
}

function parseExtendedAtoms(lines, start, count, entryCount, noVelocity, auxiliary) {
  const baseColumns = noVelocity ? 3 : 6;
  const auxiliaryCount = entryCount - baseColumns;
  if (entryCount < baseColumns || auxiliaryCount < 0) {
    throw cfgError(`entry_count=${entryCount} is inconsistent with a CFG layout ${noVelocity ? 'without' : 'with'} velocities.`);
  }
  for (const index of auxiliary.keys()) {
    if (index >= auxiliaryCount) throw cfgError(`auxiliary[${index}] exceeds the ${auxiliaryCount} auxiliary columns defined by entry_count.`);
  }

  const propertyDefinitions = [];
  if (!noVelocity) {
    for (const component of 'xyz') propertyDefinitions.push({ name: `velocity_${component}`, unit: '' });
  }
  for (let index = 0; index < auxiliaryCount; index += 1) {
    propertyDefinitions.push(auxiliary.get(index) ?? { name: `aux_${index}`, unit: '' });
  }
  const propertyData = propertyDefinitions.map((definition) => (
    ['id', 'ix', 'iy', 'iz'].includes(definition.name.toLowerCase())
      ? new Float64Array(count)
      : new Float32Array(count)
  ));
  const masses = new Float32Array(count);
  const fractional = new Float64Array(count * 3);
  const types = new Uint16Array(count);
  const typeMap = new Map();
  let currentMass = null;
  let currentSymbol = null;
  let atom = 0;

  for (let index = start; index < lines.length && atom < count; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);

    if (tokens.length === 1 && Number.isFinite(parseCfgNumber(tokens[0]))) {
      currentMass = parseCfgNumber(tokens[0]);
      continue;
    }
    if (tokens.length === 1 && /^[A-Za-z][A-Za-z0-9_+-]*$/.test(tokens[0])) {
      currentSymbol = validateSymbol(tokens[0], index);
      continue;
    }

    let first = 0;
    let rowMass = currentMass;
    let rowSymbol = currentSymbol;
    if (tokens.length === entryCount + 2) {
      rowMass = finiteNumber(tokens[0], `mass on line ${index + 1}`);
      rowSymbol = validateSymbol(tokens[1], index);
      first = 2;
    }
    if (tokens.length - first !== entryCount) {
      throw cfgError(`Line ${index + 1}: expected ${entryCount} numeric values; found ${tokens.length - first} columns.`);
    }
    if (rowMass === null || rowSymbol === null) {
      throw cfgError(`Line ${index + 1}: extended CFG data is missing a preceding mass or element/type declaration.`);
    }
    // Columns are validated in order; a failure discards the partial row.
    const x = finiteAtomValue(tokens[first], index), y = finiteAtomValue(tokens[first + 1], index), z = finiteAtomValue(tokens[first + 2], index);
    for (let property = 0; property < propertyData.length; property += 1) {
      propertyData[property][atom] = finiteAtomValue(tokens[first + 3 + property], index);
    }
    fractional[atom * 3] = x; fractional[atom * 3 + 1] = y; fractional[atom * 3 + 2] = z;
    masses[atom] = rowMass;
    if (!typeMap.has(rowSymbol)) typeMap.set(rowSymbol, typeMap.size);
    types[atom] = typeMap.get(rowSymbol);
    atom += 1;
  }

  if (atom !== count) throw cfgError(`The atom data ended early: ${count} atoms were declared, but only ${atom} were read.`);
  return {
    fractional,
    types,
    typeLabels: [...typeMap.keys()],
    properties: [
      { name: 'mass', unit: 'amu', data: masses },
      ...propertyDefinitions.map((definition, index) => ({ ...definition, data: propertyData[index] })),
    ],
  };
}

function extractExtendedSemantics(properties, count) {
  const byName = new Map();
  for (const property of properties) {
    const name = property.name.toLowerCase();
    if (!['id', 'ix', 'iy', 'iz'].includes(name)) continue;
    if (byName.has(name)) throw cfgError(`The auxiliary field “${name}” is defined more than once.`);
    byName.set(name, property);
  }

  const imageNames = ['ix', 'iy', 'iz'];
  const imageCount = imageNames.filter((name) => byName.has(name)).length;
  if (imageCount !== 0 && imageCount !== 3) {
    throw cfgError('Image flags must provide ix, iy, and iz together; a partial triplet cannot be unwrapped safely.');
  }

  let ids;
  if (byName.has('id')) {
    ids = Float64Array.from(byName.get('id').data);
    const seen = new Set();
    for (let atom = 0; atom < count; atom += 1) {
      const id = ids[atom];
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw cfgError(`Auxiliary id value ${id} at atom row ${atom + 1} is not a positive safe integer.`);
      }
      if (seen.has(id)) throw cfgError(`Auxiliary id value ${id} occurs more than once.`);
      seen.add(id);
    }
  }

  let imageFlags;
  if (imageCount === 3) {
    const imageColumns = imageNames.map((name) => byName.get(name).data);
    imageFlags = new Int32Array(count * 3);
    for (let axis = 0; axis < 3; axis += 1) {
      for (let atom = 0; atom < count; atom += 1) {
        const image = imageColumns[axis][atom];
        if (!Number.isSafeInteger(image) || image < -2_147_483_648 || image > 2_147_483_647) {
          throw cfgError(`Auxiliary ${imageNames[axis]} value ${image} at atom row ${atom + 1} is not a supported 32-bit integer.`);
        }
        imageFlags[atom * 3 + axis] = image;
      }
    }
  }

  return {
    ids,
    imageFlags,
    properties: properties.filter((property) => !byName.has(property.name.toLowerCase())),
  };
}

function symmetricSquareRoot(matrix) {
  const a = Float64Array.from(matrix);
  const eigenvectors = Float64Array.from(IDENTITY);
  for (let iteration = 0; iteration < 32; iteration += 1) {
    let p = 0;
    let q = 1;
    let largest = Math.abs(a[1]);
    for (const [row, column] of [[0, 2], [1, 2]]) {
      const value = Math.abs(a[row * 3 + column]);
      if (value > largest) [p, q, largest] = [row, column, value];
    }
    if (largest < 1e-14) break;
    const app = a[p * 3 + p];
    const aqq = a[q * 3 + q];
    const apq = a[p * 3 + q];
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);

    for (let k = 0; k < 3; k += 1) {
      if (k === p || k === q) continue;
      const akp = a[k * 3 + p];
      const akq = a[k * 3 + q];
      a[k * 3 + p] = a[p * 3 + k] = cosine * akp - sine * akq;
      a[k * 3 + q] = a[q * 3 + k] = sine * akp + cosine * akq;
    }
    a[p * 3 + p] = cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq;
    a[q * 3 + q] = sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq;
    a[p * 3 + q] = a[q * 3 + p] = 0;
    for (let k = 0; k < 3; k += 1) {
      const vkp = eigenvectors[k * 3 + p];
      const vkq = eigenvectors[k * 3 + q];
      eigenvectors[k * 3 + p] = cosine * vkp - sine * vkq;
      eigenvectors[k * 3 + q] = sine * vkp + cosine * vkq;
    }
  }

  const roots = [a[0], a[4], a[8]].map((value) => {
    if (value < -1e-10) throw cfgError('eta produces a physically invalid negative squared length.');
    return Math.sqrt(Math.max(0, value));
  });
  const result = new Float64Array(9);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      for (let eigen = 0; eigen < 3; eigen += 1) {
        result[row * 3 + column] += eigenvectors[row * 3 + eigen] * roots[eigen] * eigenvectors[column * 3 + eigen];
      }
    }
  }
  return result;
}

function addIdentityTwice(eta) {
  const result = Float64Array.from(eta, (value) => 2 * value);
  result[0] += 1;
  result[4] += 1;
  result[8] += 1;
  return result;
}

// Fortran exponents (1.0d-3) are rewritten only when present: replace() would
// return the token unchanged otherwise, so skipping it gives the same number.
function parseCfgNumber(value) {
  return Number(value.indexOf('d') < 0 && value.indexOf('D') < 0 ? value : value.replace(/[dD]/, 'e'));
}

function finiteNumber(value, label) {
  const parsed = parseCfgNumber(value);
  if (!Number.isFinite(parsed)) throw cfgError(`${label} is not a finite number: “${value}”.`);
  return parsed;
}

// As finiteNumber(value, `line ${lineIndex + 1}`), building the label only on failure.
function finiteAtomValue(value, lineIndex) {
  const parsed = parseCfgNumber(value);
  if (!Number.isFinite(parsed)) throw cfgError(`line ${lineIndex + 1} is not a finite number: “${value}”.`);
  return parsed;
}

function validateSymbol(value, lineIndex) {
  if (!/^[A-Za-z][A-Za-z0-9_+-]*$/.test(value)) {
    throw cfgError(`Line ${lineIndex + 1} has an invalid element/type symbol: “${value}”.`);
  }
  return value;
}

function assertMatrixIndex(row, column, lineIndex) {
  if (row < 0 || row > 2 || column < 0 || column > 2) {
    throw cfgError(`Matrix indices on line ${lineIndex + 1} must be in the range 1..3.`);
  }
}

function hasOffDiagonal(matrix) {
  return [1, 2, 3, 5, 6, 7].some((index) => Math.abs(matrix[index]) > 1e-12);
}

function cfgError(message) {
  return new Error(`CFG parsing failed: ${message}`);
}
