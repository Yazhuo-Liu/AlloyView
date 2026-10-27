import { createCell, determinant3, invert3, validateFrame } from '../data/model.js';
import { THERMAL_PROPERTY_NAMES, cifThermalToCartesian, thermalSymmetryTransform, transformThermalTensor, thermalEllipsoidAxes } from '../crystal/thermal-ellipsoids.js';
import { attachFrameSummary, createFrameSummaryAccumulator, includeFrameSummaryAtom } from '../data/frame-summary.js';
import { isElementSymbol } from '../data/chemical-elements.js';
import { resolveSpaceGroup } from '../crystal/space-groups.js';
import { PARSER_CHECKPOINT_MASK } from './cooperative-parser.js';
import { runCooperativeSteps, runCooperativeStepsAsync } from '../shared/cooperative-steps.js';

// The limits bound both token objects and the largest temporary expansion.
// They reject incomplete input rather than returning a truncated unit cell.
export const CIF_LIMITS = Object.freeze({ textCharacters: 32 * 1024 * 1024, tokens: 1_000_000,
  symmetryOperations: 384, expandedAtoms: 500_000, blocks: 1024 });
const error = message => new Error(`CIF: ${message}`);
const canonicalTag = tag => tag.toLowerCase().replaceAll('.', '_');
const missing = token => !token || token.value === '.' || token.value === '?';
const control = token => !token.quoted && (/^_/.test(token.value) || /^(?:data_|save_)/i.test(token.value)
  || /^(?:loop_|stop_|global_)$/i.test(token.value));
const CELL_TAGS = ['_cell_length_a', '_cell_length_b', '_cell_length_c', '_cell_angle_alpha', '_cell_angle_beta', '_cell_angle_gamma'];
const FRACTIONAL_TAGS = ['_atom_site_fract_x', '_atom_site_fract_y', '_atom_site_fract_z'];
const CARTESIAN_TAGS = ['_atom_site_cartn_x', '_atom_site_cartn_y', '_atom_site_cartn_z'];
const SYMMETRY_TAGS = ['_space_group_symop_operation_xyz', '_symmetry_equiv_pos_as_xyz'];
const DEDUP_SCALE = 10_000_000, DEDUP_TOLERANCE = 1 / DEDUP_SCALE;

/** Recognize the CIF container from a short file header. Parsing performs the
 * full dictionary/geometry checks; a filename is never a symmetry guess. */
export function looksLikeCif(text) {
  return /(?:^|\n)\s*data_\S*/i.test(String(text).replace(/^\uFEFF/, ''));
}

export function parseCif(text, sourceName = 'structure.cif', options = {}) {
  return runCooperativeSteps(parseCifSteps(text, sourceName, options));
}

export function parseCifAsync(text, sourceName = 'structure.cif', options = {}) {
  return runCooperativeStepsAsync(parseCifSteps(text, sourceName, options), options);
}

/** A CIF 1.x lexer. Quoted values and column-one semicolon fields retain
 * their contents; reserved words inside them are ordinary data. */
function* tokenize(text) {
  text = String(text).replace(/^\uFEFF/, '');
  if (text.length > CIF_LIMITS.textCharacters) throw error('the text exceeds the 32 Mi-character import budget.');
  if (text.includes('\0')) throw error('NUL bytes are not valid CIF text.');
  const tokens = [];
  let i = 0, line = 1, column = 1, checkpoint = 0;
  const advance = () => { if (text[i++] === '\n') { line++; column = 1; } else column++; };
  while (i < text.length) {
    if (i >= checkpoint) { checkpoint = i + 4096; yield; }
    const ch = text[i];
    if (/\s/.test(ch)) { advance(); continue; }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') {
        if (i >= checkpoint) { checkpoint = i + 4096; yield; }
        advance();
      }
      continue;
    }
    const firstLine = line;
    let value, quoted = false;
    if (ch === ';' && column === 1) {
      quoted = true; advance();
      const start = i;
      let end = -1;
      while (i < text.length) {
        if (i >= checkpoint) { checkpoint = i + 4096; yield; }
        if (text[i] === ';' && column === 1) { end = i; advance(); break; }
        advance();
      }
      if (end < 0) throw error(`line ${firstLine}: unterminated semicolon text field.`);
      value = text.slice(start, end).replace(/\r?\n$/, '').replace(/^\r?\n/, '');
      if (i < text.length && !/\s|#/.test(text[i])) throw error(`line ${line}: text follows a closing semicolon.`);
    } else if (ch === "'" || ch === '"') {
      quoted = true; advance();
      const start = i;
      let end = -1;
      while (i < text.length) {
        if (i >= checkpoint) { checkpoint = i + 4096; yield; }
        if (text[i] === '\n' || text[i] === '\r') throw error(`line ${firstLine}: quoted values cannot cross a line; use a semicolon field.`);
        if (text[i] === ch && (i + 1 === text.length || /\s/.test(text[i + 1]))) { end = i; advance(); break; }
        advance();
      }
      if (end < 0) throw error(`line ${firstLine}: unterminated quoted value.`);
      value = text.slice(start, end);
    } else {
      const start = i;
      while (i < text.length && !/\s/.test(text[i])) {
        if (i >= checkpoint) { checkpoint = i + 4096; yield; }
        advance();
      }
      value = text.slice(start, i);
    }
    tokens.push({ value, quoted, line: firstLine });
    if (tokens.length > CIF_LIMITS.tokens) throw error('the token count exceeds the import memory budget.');
  }
  return tokens;
}

function* parseBlocks(tokens) {
  const blocks = [], names = new Set();
  let cursor = 0, block = null, statements = 0;
  while (cursor < tokens.length) {
    if ((statements++ & PARSER_CHECKPOINT_MASK) === 0) yield;
    const token = tokens[cursor++], lower = token.value.toLowerCase();
    if (!token.quoted && lower.startsWith('data_')) {
      const name = token.value.slice(5);
      if (!name) throw error(`line ${token.line}: a data block requires a name.`);
      if (names.has(name.toLowerCase())) throw error(`duplicate data block “${name}”.`);
      names.add(name.toLowerCase());
      block = { name, items: new Map(), loops: [] }; blocks.push(block);
      if (blocks.length > CIF_LIMITS.blocks) throw error('too many data blocks.');
      continue;
    }
    if (!block) throw error(`line ${token.line}: expected a data_ block before its contents.`);
    if (!token.quoted && lower === 'loop_') {
      const tags = [], tagSet = new Set();
      while (cursor < tokens.length && !tokens[cursor].quoted && tokens[cursor].value.startsWith('_')) {
        if ((tags.length & PARSER_CHECKPOINT_MASK) === 0) yield;
        const tag = canonicalTag(tokens[cursor++].value);
        if (block.items.has(tag) || tagSet.has(tag)) throw error(`duplicate data name ${tag} in block ${block.name}.`);
        tags.push(tag); tagSet.add(tag);
      }
      if (!tags.length) throw error(`line ${token.line}: loop_ has no data names.`);
      const start = cursor;
      while (cursor < tokens.length && !control(tokens[cursor])) {
        cursor++;
        if ((cursor & PARSER_CHECKPOINT_MASK) === 0) yield;
      }
      if ((cursor - start) % tags.length) throw error(`line ${token.line}: loop values do not complete a row of ${tags.length} columns.`);
      const loop = { tags, values: tokens.slice(start, cursor), rows: (cursor - start) / tags.length };
      block.loops.push(loop);
      tags.forEach((tag, index) => block.items.set(tag, { loop, index }));
      if (tokens[cursor]?.value.toLowerCase() === 'stop_' && !tokens[cursor].quoted) cursor++;
      continue;
    }
    if (!token.quoted && lower.startsWith('_')) {
      const tag = canonicalTag(token.value);
      if (block.items.has(tag)) throw error(`duplicate data name ${tag} in block ${block.name}.`);
      const value = tokens[cursor++];
      if (!value || control(value)) throw error(`line ${token.line}: ${tag} has no value.`);
      block.items.set(tag, { token: value });
      continue;
    }
    if (!token.quoted && (lower.startsWith('save_') || lower === 'global_')) {
      throw error(`line ${token.line}: save/global dictionaries are not crystal data blocks.`);
    }
    throw error(`line ${token.line}: unexpected value “${token.value.slice(0, 80)}”.`);
  }
  return blocks;
}

function at(item, row = 0) {
  return item?.loop ? item.loop.values[row * item.loop.tags.length + item.index] : row === 0 ? item?.token : undefined;
}
function item(block, tags) {
  for (const tag of tags) if (block.items.has(tag)) return block.items.get(tag);
  return undefined;
}
function scalar(block, tags) {
  const result = item(block, Array.isArray(tags) ? tags : [tags]);
  if (result?.loop && result.loop.rows !== 1) throw error(`${Array.isArray(tags) ? tags[0] : tags} must have a single value.`);
  return at(result);
}
function stringValue(token) { return missing(token) ? null : token.value; }

function numberValue(token, label, { optional = false } = {}) {
  if (missing(token)) {
    if (optional) return NaN;
    throw error(`${label} is missing.`);
  }
  // Standard uncertainty is metadata, not a multiplier: 1.234(5)e2 = 123.4.
  const match = token.value.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\(\d+\))?([eEdD][+-]?\d+)?$/);
  const value = match ? Number(match[1] + (match[2]?.replace(/[dD]/, 'e') ?? '')) : NaN;
  if (!Number.isFinite(value)) throw error(`line ${token.line}: ${label} must be a finite number, got “${token.value}”.`);
  return value;
}

function makeCell(block) {
  const [a, b, c, alpha, beta, gamma] = CELL_TAGS.map(tag => numberValue(scalar(block, tag), tag));
  if ([a, b, c].some(value => value <= 0)) throw error('cell lengths must be positive.');
  if ([alpha, beta, gamma].some(value => value <= 0 || value >= 180)) throw error('cell angles must lie strictly between 0 and 180 degrees.');
  const rad = Math.PI / 180, ca = Math.cos(alpha * rad), cb = Math.cos(beta * rad), cg = Math.cos(gamma * rad), sg = Math.sin(gamma * rad);
  const cy = (ca - cb * cg) / sg, czSquared = 1 - cb * cb - cy * cy;
  if (!(czSquared > 1e-14) || !Number.isFinite(czSquared)) throw error('cell angles do not define a nonsingular three-dimensional cell.');
  const vectors = [a, 0, 0, b * cg, b * sg, 0, c * cb, c * cy, c * Math.sqrt(czSquared)];
  if (vectors.some(value => !Number.isFinite(value))) throw error('the cell geometry exceeds finite numeric limits.');
  return createCell({ vectors, pbc: [true, true, true], triclinic: [alpha, beta, gamma].some(value => Math.abs(value - 90) > 1e-10) });
}

function rational(term) {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:\/\d+)?$/.test(term)) return NaN;
  const [numerator, denominator = '1'] = term.split('/');
  return Number(numerator) / Number(denominator);
}

/** Compile only the affine fractional-coordinate grammar used by CIF.
 * Arbitrary names, function calls and JavaScript syntax never execute. */
export function parseCifSymmetryOperation(text) {
  const coordinates = String(text).toLowerCase().replace(/\s/g, '').split(',');
  if (coordinates.length !== 3 || String(text).length > 256) throw error(`invalid symmetry operation “${String(text).slice(0, 80)}”.`);
  const rotation = new Float64Array(9), translation = new Float64Array(3);
  coordinates.forEach((expression, axis) => {
    if (!expression || /[+-]{2}/.test(expression)) throw error(`invalid symmetry coordinate “${expression}”.`);
    const terms = expression.match(/[+-]?[^+-]+/g) ?? [];
    if (terms.join('') !== expression) throw error(`invalid symmetry coordinate “${expression}”.`);
    for (let term of terms) {
      const sign = term[0] === '-' ? -1 : 1;
      if (/^[+-]/.test(term)) term = term.slice(1);
      const variable = term.match(/^(?:(\d+)\*?)?([xyz])$/);
      if (variable) rotation[axis * 3 + 'xyz'.indexOf(variable[2])] += sign * Number(variable[1] ?? 1);
      else {
        const constant = rational(term);
        if (!Number.isFinite(constant) || Math.abs(constant) > 1e6) throw error(`unsupported symmetry term “${term}”.`);
        translation[axis] += sign * constant;
      }
    }
  });
  if (rotation.some(value => Math.abs(value) > 12) || Math.abs(Math.abs(determinant3(rotation)) - 1) > 1e-12) {
    throw error(`symmetry operation “${text}” must have an invertible integer rotation with determinant ±1.`);
  }
  return { rotation, translation };
}

function wrap(value) {
  const result = value - Math.floor(value);
  // A tiny negative input may subtract its floor and round to exactly 1.
  return result >= 1 ? 0 : result === 0 ? 0 : result;
}

function symmetry(block) {
  let name = stringValue(scalar(block, ['_space_group_name_h-m_alt', '_symmetry_space_group_name_h-m']));
  let hall = stringValue(scalar(block, '_space_group_name_hall'));
  const numberToken = scalar(block, ['_space_group_it_number', '_symmetry_int_tables_number']);
  let number = missing(numberToken) ? null : numberValue(numberToken, 'space-group number');
  if (number !== null && (!Number.isInteger(number) || number < 1 || number > 230)) throw error('space-group number must be an integer from 1 to 230.');
  const operationColumn = item(block, SYMMETRY_TAGS);
  let expressions = [], source = 'explicit';
  if (operationColumn) {
    const count = operationColumn.loop?.rows ?? 1;
    if (!count || count > CIF_LIMITS.symmetryOperations) throw error(`symmetry operations must contain 1–${CIF_LIMITS.symmetryOperations} entries.`);
    for (let row = 0; row < count; row++) {
      const token = at(operationColumn, row);
      if (missing(token)) throw error('a symmetry operation is unknown or missing.');
      expressions.push(token.value);
    }
  } else {
    const setting = stringValue(scalar(block, ['_space_group_it_coordinate_system_code', '_space_group_setting']));
    const entry = resolveSpaceGroup({ name, hall, number, setting });
    name ??= entry.shortName; hall ??= entry.hallSymbol; number ??= entry.number;
    source = entry.number === 1 ? 'P1' : entry.number === 2 ? 'P-1' : 'database';
    expressions = entry.operations;
  }
  const operations = [], seen = new Set();
  for (const expression of expressions) {
    const operation = parseCifSymmetryOperation(expression);
    const key = [...operation.rotation, ...operation.translation.map(wrap)].join(',');
    if (!seen.has(key)) { seen.add(key); operations.push({ ...operation, expression }); }
  }
  if (!operations.some(({ rotation, translation }) => rotation.every((value, index) => value === (index % 4 === 0 ? 1 : 0))
    && translation.every(value => Math.abs(value - Math.round(value)) < 1e-10))) {
    throw error('the symmetry list must include the identity operation x,y,z.');
  }
  return { name, hall, number, source, operations };
}

function element(token, label) {
  const value = stringValue(token) ?? label;
  const match = value?.match(/^([A-Z][a-z]?)(?=[0-9_+\-.]|$)/);
  const symbol = match?.[1];
  if (symbol && (isElementSymbol(symbol) || symbol === 'D' || symbol === 'T')) return symbol;
  throw error(`cannot identify an element from “${value ?? '?'}”; provide _atom_site_type_symbol.`);
}

function sameImage(first, second) {
  return first.every((value, axis) => {
    const distance = Math.abs(value - second[axis]);
    return Math.min(distance, 1 - distance) <= DEDUP_TOLERANCE;
  });
}

function addImage(buckets, point, onDuplicate) {
  const bins = point.map(value => Math.floor(value * DEDUP_SCALE));
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
    const key = [(bins[0] + a + DEDUP_SCALE) % DEDUP_SCALE, (bins[1] + b + DEDUP_SCALE) % DEDUP_SCALE, (bins[2] + c + DEDUP_SCALE) % DEDUP_SCALE].join(',');
    for (const previous of buckets.get(key) ?? []) if (sameImage(previous, point)) { onDuplicate?.(previous); return false; }
  }
  const key = bins.join(',');
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(point);
  return true;
}

function* anisotropicSites(items, cell) {
  const labels = items.get('_atom_site_aniso_label');
  const suffixes = ['11', '22', '33', '12', '13', '23'];
  const u = suffixes.map(suffix => items.get(`_atom_site_aniso_u_${suffix}`));
  const b = suffixes.map(suffix => items.get(`_atom_site_aniso_b_${suffix}`));
  if (![...u, ...b].some(Boolean)) return new Map();
  const columns = u.some(Boolean) ? u : b;
  if (!labels || columns.some(column => !column || column.loop !== labels.loop)) throw error('anisotropic displacement parameters require a label and all six Uij or Bij columns in one loop.');
  const result = new Map();
  for (let row = 0; row < (labels.loop?.rows ?? 1); row++) {
    if ((row & PARSER_CHECKPOINT_MASK) === 0) yield;
    const label = stringValue(at(labels, row));
    if (!label || result.has(label)) throw error('anisotropic displacement labels must be present and unique.');
    const values = columns.map(column => numberValue(at(column, row), `anisotropic displacement at ${label}`, { optional: true }));
    if (values.every(Number.isNaN)) { result.set(label, null); continue; }
    if (!values.every(Number.isFinite)) throw error(`anisotropic displacement at ${label} must have all six finite components or all six missing values.`);
    if (!u.some(Boolean)) for (let i = 0; i < 6; i++) values[i] /= 8 * Math.PI ** 2;
    const cartesian = cifThermalToCartesian(values, cell);
    try { thermalEllipsoidAxes(cartesian); } catch (cause) { throw error(`${label}: ${cause.message}`); }
    result.set(label, cartesian);
  }
  return result;
}

function* parseCifSteps(text, sourceName, options) {
  const startedAt = performance.now();
  const tokens = yield* tokenize(text), blocks = yield* parseBlocks(tokens);
  let candidates = blocks.filter(block => CELL_TAGS.every(tag => block.items.has(tag))
    && [...FRACTIONAL_TAGS, ...CARTESIAN_TAGS].some(tag => block.items.has(tag)));
  if (options.block !== undefined) {
    if (typeof options.block !== 'string') throw error('the requested data block must be its name.');
    candidates = candidates.filter(block => block.name.toLowerCase() === options.block.toLowerCase());
  }
  if (!candidates.length) throw error(options.block === undefined ? 'no data block contains complete cell parameters and atomic coordinates.' : `no crystal data block named “${options.block}”.`);
  if (candidates.length !== 1) throw error(`multiple crystal blocks (${candidates.map(block => block.name).join(', ')}); open one crystal block at a time or select its name with the parser's block option.`);
  const block = candidates[0], cell = makeCell(block), group = symmetry(block), items = block.items;
  const fractionalCoordinates = FRACTIONAL_TAGS.some(tag => items.has(tag));
  const coordinateTags = fractionalCoordinates ? FRACTIONAL_TAGS : CARTESIAN_TAGS;
  if (!coordinateTags.every(tag => items.has(tag))) throw error('atom sites require all three fractional or all three Cartesian coordinates.');
  const coordinateColumns = coordinateTags.map(tag => items.get(tag));
  const coordinateLoop = coordinateColumns[0].loop;
  if (coordinateColumns.some(column => column.loop !== coordinateLoop)) throw error('the three coordinate columns must belong to the same atom-site loop.');
  const count = coordinateLoop?.rows ?? 1;
  if (!count) throw error('the atom-site loop is empty.');
  const capacity = count * group.operations.length;
  if (!Number.isSafeInteger(capacity) || capacity > CIF_LIMITS.expandedAtoms) throw error(`symmetry expansion exceeds the ${CIF_LIMITS.expandedAtoms.toLocaleString('en-US')}-site import budget.`);
  const column = tag => {
    const found = items.get(tag);
    if (found && found.loop !== coordinateLoop) throw error(`${tag} must belong to the coordinate atom-site loop.`);
    return found;
  };
  const labelColumn = column('_atom_site_label'), elementColumn = column('_atom_site_type_symbol');
  if (!labelColumn && !elementColumn) throw error('atom sites need labels or type symbols to identify their elements.');
  const occupancyColumn = column('_atom_site_occupancy'), uisoColumn = column('_atom_site_u_iso_or_equiv'), bisoColumn = column('_atom_site_b_iso_or_equiv');
  const anisotropic = yield* anisotropicSites(items, cell);
  if (anisotropic.size && !labelColumn) throw error('anisotropic displacement parameters require atom-site labels.');
  const hasThermal = anisotropic.size > 0 || Boolean(uisoColumn || bisoColumn);
  const thermalOperations = hasThermal ? new Map(group.operations.map(operation => [operation, thermalSymmetryTransform(operation.rotation, cell)])) : null;
  const thermalComponents = hasThermal ? THERMAL_PROPERTY_NAMES.map(() => new Float64Array(capacity).fill(NaN)) : null;
  const thermalTransforms = hasThermal ? new Float32Array(capacity * 9) : null;
  let thermalCount = 0, thermalMaxRadius = 0;
  const seenLabels = new Set();
  const disorderColumns = ['_atom_site_disorder_assembly', '_atom_site_disorder_group'].map(column);
  const types = new Uint16Array(capacity), fractional = new Float64Array(capacity * 3), positions = new Float64Array(capacity * 3), ids = new Float64Array(capacity);
  const occupancy = new Float64Array(capacity), asymmetricSiteIndex = new Uint32Array(capacity);
  const uiso = uisoColumn ? new Float64Array(capacity) : null, biso = bisoColumn ? new Float64Array(capacity) : null;
  const typeLabels = [], typeMap = new Map(), siteLabels = [], inverse = fractionalCoordinates ? null : invert3(cell.vectors);
  const occupancySummary = { partial: 0, unknown: 0, zero: 0 };
  let expanded = 0, disordered = false, unknownOccupancy = false, attempts = 0;
  for (let site = 0; site < count; site++) {
    if ((site & PARSER_CHECKPOINT_MASK) === 0) yield;
    const label = stringValue(at(labelColumn, site)) ?? `${stringValue(at(elementColumn, site)) ?? 'Site'}${site + 1}`;
    if (anisotropic.size && seenLabels.has(label)) throw error('atom-site labels must be unique when anisotropic displacement parameters are supplied.');
    seenLabels.add(label);
    siteLabels.push(label);
    const symbol = element(at(elementColumn, site), label);
    if (!typeMap.has(symbol)) { typeMap.set(symbol, typeLabels.length); typeLabels.push(symbol); }
    const type = typeMap.get(symbol);
    let point = coordinateColumns.map((value, axis) => numberValue(at(value, site), `${coordinateTags[axis]} at site ${label}`));
    if (!fractionalCoordinates) point = [0, 1, 2].map(axis => point[0] * inverse[axis] + point[1] * inverse[3 + axis] + point[2] * inverse[6 + axis]);
    if (point.some(value => !Number.isFinite(value) || Math.abs(value) > 1e9)) throw error(`site ${label} has unsupported fractional-coordinate magnitude.`);
    const occupied = occupancyColumn ? numberValue(at(occupancyColumn, site), `occupancy at site ${label}`, { optional: true }) : 1;
    if (Number.isFinite(occupied) && (occupied < 0 || occupied > 1)) throw error(`occupancy at site ${label} must be between 0 and 1.`);
    if (!Number.isFinite(occupied)) unknownOccupancy = true;
    if (occupied !== 1 || disorderColumns.some(value => !missing(at(value, site)) && at(value, site).value !== '0')) disordered = true;
    const u = uiso ? numberValue(at(uisoColumn, site), `Uiso at site ${label}`, { optional: true }) : null;
    const b = biso ? numberValue(at(bisoColumn, site), `Biso at site ${label}`, { optional: true }) : null;
    const isotropic = Number.isFinite(u) ? u : Number.isFinite(b) ? b / (8 * Math.PI ** 2) : NaN;
    const tensor = anisotropic.get(label) ?? (isotropic >= 0 ? new Float64Array([isotropic, isotropic, isotropic, 0, 0, 0]) : null);
    const emitted = new Map();
    for (const operation of group.operations) {
      if ((attempts++ & PARSER_CHECKPOINT_MASK) === 0) yield;
      const transformed = [0, 1, 2].map(axis => wrap(operation.translation[axis]
        + operation.rotation[axis * 3] * point[0] + operation.rotation[axis * 3 + 1] * point[1] + operation.rotation[axis * 3 + 2] * point[2]));
      const rotated = tensor ? transformThermalTensor(tensor, thermalOperations.get(operation)) : null;
      transformed.thermalTensor = rotated;
      if (!addImage(emitted, transformed, previous => {
        if (rotated && previous.thermalTensor) {
          const scale = Math.max(...rotated.map(Math.abs), ...previous.thermalTensor.map(Math.abs), 1e-30);
          if (rotated.some((value, index) => Math.abs(value - previous.thermalTensor[index]) > 1e-6 * scale)) {
            throw error(`anisotropic displacement tensor at ${label} violates its special-position site symmetry.`);
          }
        }
      })) continue;
      const offset = expanded * 3;
      fractional.set(transformed, offset);
      for (let axis = 0; axis < 3; axis++) positions[offset + axis] = transformed[0] * cell.vectors[axis]
        + transformed[1] * cell.vectors[3 + axis] + transformed[2] * cell.vectors[6 + axis];
      if (![positions[offset], positions[offset + 1], positions[offset + 2]].every(Number.isFinite)) throw error('expanded Cartesian coordinates exceed numeric limits.');
      ids[expanded] = expanded + 1; types[expanded] = type; occupancy[expanded] = occupied; asymmetricSiteIndex[expanded] = site + 1;
      if (!Number.isFinite(occupied)) occupancySummary.unknown++;
      else if (occupied === 0) occupancySummary.zero++;
      else if (occupied < 1) occupancySummary.partial++;
      if (uiso) uiso[expanded] = u;
      if (biso) biso[expanded] = b;
      if (tensor) {
        const ellipsoid = thermalEllipsoidAxes(rotated);
        for (let k = 0; k < 6; k++) thermalComponents[k][expanded] = rotated[k];
        thermalTransforms.set(ellipsoid.axes, expanded * 9);
        if (ellipsoid.valid) thermalCount++;
        thermalMaxRadius = Math.max(thermalMaxRadius, ellipsoid.radius);
      }
      expanded++;
    }
  }
  for (const label of anisotropic.keys()) if (!seenLabels.has(label)) throw error(`anisotropic displacement label ${label} has no corresponding atom site.`);
  const compact = (array, stride = 1) => expanded === capacity ? array : array.slice(0, expanded * stride);
  const outputTypes = compact(types), outputPositions = compact(positions, 3), summary = createFrameSummaryAccumulator(typeLabels.length);
  for (let atom = 0; atom < expanded; atom++) {
    if ((atom & PARSER_CHECKPOINT_MASK) === 0) yield;
    includeFrameSummaryAtom(summary, outputTypes[atom], outputPositions, atom * 3);
  }
  const warnings = [];
  if (disordered) warnings.push('Disordered or partially occupied sites are retained as separate displayed sites. Atom analyses count sites and do not weight them by occupancy.');
  if (unknownOccupancy) warnings.push('Unknown occupancy values remain NaN; they are not replaced with full occupancy.');
  if (hasThermal && thermalCount < expanded) warnings.push(`${expanded - thermalCount} sites have missing, nonpositive or singular displacement tensors and retain ordinary atom spheres. Source displacement values are preserved.`);
  const properties = [{ name: 'occupancy', unit: '', data: compact(occupancy) }, { name: 'asymmetricSiteIndex', unit: '', data: compact(asymmetricSiteIndex) }];
  if (uiso) properties.push({ name: 'Uiso', unit: 'Å²', data: compact(uiso) });
  if (biso) properties.push({ name: 'Biso', unit: 'Å²', data: compact(biso) });
  if (thermalComponents) for (let k = 0; k < 6; k++) properties.push({ name: THERMAL_PROPERTY_NAMES[k], unit: 'Å²', data: compact(thermalComponents[k]) });
  return attachFrameSummary(validateFrame({
    ids: compact(ids), idSource: 'row-order', types: outputTypes, typeLabels, positions: outputPositions,
    fractional: compact(fractional, 3), cell, properties, timestep: null, title: sourceName, sourceFormat: 'cif', parseMs: performance.now() - startedAt,
    ...(thermalTransforms ? { thermalEllipsoids: { transforms: compact(thermalTransforms, 9), count: thermalCount, maxRadius: thermalMaxRadius } } : {}),
    crystal: { format: 'cif', block: block.name, spaceGroup: { name: group.name, number: group.number, hall: group.hall },
      symmetryOperations: group.operations.map(operation => operation.expression), symmetrySource: group.source,
      asymmetricSiteCount: count, expandedAtomCount: expanded, siteLabels, disordered, occupancySummary,
      formula: stringValue(scalar(block, ['_chemical_formula_sum', '_chemical_formula_structural'])),
      title: stringValue(scalar(block, ['_chemical_name_common', '_chemical_name_systematic'])), warnings },
  }), summary);
}
