// External attributes are deliberately independent of structure coordinates.
// Parsing and atom-ID correspondence run in the persistent attribute Worker.
const MAX_COLUMNS = 4096;
const MAX_FILES = 256;
export const MAX_EXTERNAL_PROPERTY_BYTES = 512 * 1024 ** 2;
const BAD_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const RESERVED_NAMES = new Set([
  'id', 'ids', 'type', 'types', 'positions', 'fractional', 'cell', 'imageFlags', 'unwrappedPositions',
  'coordination', 'structureType', 'centralSymmetry', 'centralSymmetryStructureType', 'centralSymmetryNeighbors',
  'ptmStructureType', 'ptmRmsd', 'ptmDistance', 'idealStrainStructureType', 'dxaStructureType', 'localShear',
  'atomicShearStrain', 'atomicHydrostaticStrain', 'atomicVolumeChange',
  'bondQ4', 'bondQ6', 'bondStatisticsCoordination', 'atomicVolume', 'voronoiSurfaceArea',
  'voronoiCoordination', 'voronoiBoundaryFaces', 'voronoiMaxFaceOrder',
  'strainE11', 'strainE22', 'strainE33', 'strainE12', 'strainE13', 'strainE23',
  'referenceShearStrain', 'referenceHydrostaticStrain', 'referenceVolumeChange',
  'referenceE11', 'referenceE22', 'referenceE33', 'referenceE12', 'referenceE13', 'referenceE23',
  ...Array.from({ length: 9 }, (_, index) => `referenceF${Math.floor(index / 3) + 1}${index % 3 + 1}`),
  ...['X', 'Y', 'Z', 'Magnitude'].map(suffix => `displacement${suffix}`),
].map(name => name.toLowerCase()));
const ID_NAMES = new Set(['id', 'atom_id', 'atomid']);

export function validateExternalPropertyName(value, existingNames = []) {
  if (typeof value !== 'string') throw attributeError('Property names must be text.');
  const name = value.trim();
  if (!name || name.length > 256 || /[\x00-\x1f\x7f]/.test(name) || BAD_NAMES.has(name)) {
    throw attributeError('Property names must contain 1–256 printable characters.');
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) throw attributeError(`“${name}” is a built-in or analysis property. Choose another name.`);
  if (existingNames.some(existing => existing.toLowerCase() === name.toLowerCase())) {
    throw attributeError(`A property named “${name}” already exists. Choose another name.`);
  }
  return name;
}

/** A strict, data-free manifest used by portable configuration recipes. */
export function normalizeExternalPropertyState(value = {}) {
  checkRecord(value, ['files'], 'state');
  if (!Array.isArray(value.files ?? []) || (value.files?.length ?? 0) > MAX_FILES) throw attributeError(`State supports up to ${MAX_FILES} external files.`);
  const ids = new Set(), names = [];
  const files = (value.files ?? []).map(entry => {
    checkRecord(entry, ['id', 'file', 'mapping', 'scope', 'frameIndex', 'columns'], 'file manifest');
    if (typeof entry.id !== 'string' || !/^external-[a-zA-Z0-9_-]{1,80}$/.test(entry.id) || ids.has(entry.id)) throw attributeError('External file IDs must be unique.');
    ids.add(entry.id);
    checkRecord(entry.file, ['name', 'size', 'lastModified'], 'file metadata');
    const name = entry.file.name;
    if (typeof name !== 'string' || !name || name.length > 1024 || /[\\/\x00-\x1f]/.test(name)) throw attributeError('External file metadata requires a valid filename.');
    const file = { name, size: integer(entry.file.size, 'File size') };
    if (entry.file.lastModified !== undefined) file.lastModified = integer(entry.file.lastModified, 'File modification time');
    if (!['id', 'row-order'].includes(entry.mapping)) throw attributeError('Mapping must be id or row-order.');
    if (!['all-frames', 'single-frame'].includes(entry.scope)) throw attributeError('Scope must be all-frames or single-frame.');
    const frameIndex = integer(entry.frameIndex ?? 0, 'Frame index');
    if (!Array.isArray(entry.columns) || !entry.columns.length || entry.columns.length > MAX_COLUMNS) throw attributeError(`Each file needs 1–${MAX_COLUMNS} properties.`);
    const sourceNames = new Set();
    const columns = entry.columns.map(column => {
      checkRecord(column, ['sourceName', 'name', 'unit', 'enabled'], 'property');
      if (typeof column.sourceName !== 'string' || !column.sourceName || column.sourceName.length > 256 || sourceNames.has(column.sourceName)) throw attributeError('Source column names must be unique.');
      sourceNames.add(column.sourceName);
      const enabled = column.enabled === undefined ? true : column.enabled;
      if (typeof enabled !== 'boolean') throw attributeError('Property enabled flags must be boolean.');
      const name = validateExternalPropertyName(column.name, enabled ? names : []);
      if (enabled) names.push(name);
      const unit = column.unit ?? '';
      if (typeof unit !== 'string' || unit.length > 128 || /[\x00-\x1f]/.test(unit)) throw attributeError('Property units must be short printable text.');
      return { sourceName: column.sourceName, name, unit, enabled };
    });
    return { id: entry.id, file, mapping: entry.mapping, scope: entry.scope, frameIndex, columns };
  });
  return { files };
}

/** Parse plain .aux columns, whitespace headers, or a quoted CSV header. */
export function parseExternalProperties(text, {
  sourceName = 'attributes.aux', frameIds, idSource = 'row-order', frameIndex = 0,
  mapping = 'auto', names, existingNames = [], importId = 'external-1', fileMetadata,
} = {}) {
  if (typeof text !== 'string') throw attributeError('The external file must contain text.');
  if (!['auto', 'id', 'row-order'].includes(mapping)) throw attributeError('Choose automatic, atom ID, or row order mapping.');
  const baseline = checkedIds(frameIds, 'The structure');
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const records = [];
  let commentHeader = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const possible = line.slice(1).trim().replace(/^(?:columns?|properties)\s*:\s*/i, '');
      if (!records.length && !commentHeader && possible) commentHeader = possible;
      continue;
    }
    records.push({ line, number: index + 1 });
  }
  if (!records.length) throw attributeError('The file contains no attribute rows.');
  const csv = records[0].line.includes(',');
  const tokens = record => csv ? csvFields(record.line, record.number) : record.line.split(/\s+/);
  const first = tokens(records[0]);
  let header = first.every(isNumericToken) ? null : first;
  if (header) records.shift();
  else if (commentHeader) {
    const possible = csv ? csvFields(commentHeader, 1) : commentHeader.split(/\s+/);
    // Arbitrary comments are not headers. Explicit "columns:" or "properties:"
    // and headers with exactly the row width are accepted.
    if (possible.length === first.length && possible.some(token => !isNumericToken(token))) header = possible;
  }
  const width = header?.length ?? first.length;
  if (!width || width > MAX_COLUMNS + 1) throw attributeError(`At most ${MAX_COLUMNS} attribute columns are supported.`);
  if (!records.length) throw attributeError('The header is not followed by attribute rows.');
  if (records.length !== baseline.length) throw attributeError(`The file has ${records.length} attribute rows; the structure has ${baseline.length} atoms. Every atom needs exactly one row.`);
  if (header && new Set(header.map(name => name.trim().toLowerCase())).size !== width) throw attributeError('The header contains duplicate column names.');
  const idColumns = header ? header.flatMap((name, index) => ID_NAMES.has(name.trim().toLowerCase()) ? [index] : []) : [];
  if (idColumns.length > 1) throw attributeError('The header contains more than one atom ID column.');
  const idColumn = idColumns[0] ?? -1;
  const resolvedMapping = mapping === 'auto' ? idColumn >= 0 ? 'id' : 'row-order' : mapping;
  if (resolvedMapping === 'id' && idColumn < 0) throw attributeError('Atom ID mapping needs a header column named id, atom_id, or atomid.');
  const propertyIndices = Array.from({ length: width }, (_, index) => index).filter(index => index !== idColumn);
  if (!propertyIndices.length) throw attributeError('The file contains an atom ID column but no properties.');
  validateExternalPropertyAllocation(records.length, propertyIndices.length);
  if (names !== undefined && (!Array.isArray(names) || names.length !== propertyIndices.length)) throw attributeError('Provide one name per attribute column.');
  const usedNames = [...existingNames];
  const columns = propertyIndices.map((index, columnIndex) => {
    const sourceName = header?.[index]?.trim() || `aux_${columnIndex + 1}`;
    const unitMatch = sourceName.match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
    const name = validateExternalPropertyName(names?.[columnIndex] ?? (unitMatch ? unitMatch[1].trim() : sourceName), usedNames);
    usedNames.push(name);
    return { sourceName, name, unit: unitMatch?.[2]?.trim() ?? '', enabled: true, data: new Float64Array(records.length) };
  });
  const ids = resolvedMapping === 'id' ? new Array(records.length) : [...baseline];
  const seen = new Set();
  for (let row = 0; row < records.length; row++) {
    const values = tokens(records[row]);
    if (values.length !== width) throw attributeError(`Line ${records[row].number} has ${values.length} columns; expected ${width}.`);
    if (idColumn >= 0) {
      const id = parseId(values[idColumn], `Line ${records[row].number}`);
      if (seen.has(id)) throw attributeError(`Line ${records[row].number} repeats atom ID ${id}.`);
      seen.add(id);
      if (resolvedMapping === 'id') ids[row] = id;
    }
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      columns[columnIndex].data[row] = parseValue(values[propertyIndices[columnIndex]], records[row].number, columns[columnIndex].name);
    }
  }
  // A present ID column must match the structure even when row mapping was
  // explicitly selected, so ignored or misspelled IDs cannot silently pass.
  if (idColumn >= 0) {
    const baselineSet = new Set(baseline);
    for (const id of seen) if (!baselineSet.has(id)) throw attributeError(`Unknown atom ID ${id}; it is absent from the structure.`);
    for (const id of baseline) if (!seen.has(id)) throw attributeError(`Missing atom ID ${id}; every atom needs a row.`);
  }
  const metadata = fileMetadata ?? { name: sourceName, size: new TextEncoder().encode(text).length };
  const manifest = normalizeExternalPropertyState({ files: [{
    id: importId, file: metadata, mapping: resolvedMapping,
    scope: idSource === 'explicit' ? 'all-frames' : 'single-frame', frameIndex,
    columns: columns.map(({ data, ...column }) => column),
  }] }).files[0];
  return { manifest, ids, columns, byId: new Map(ids.map((id, index) => [id, index])) };
}

/** Produce fresh transferable arrays while retaining original columns. */
export function mapExternalProperties(bundle, frame, manifest = bundle.manifest) {
  if (manifest.scope === 'single-frame' && (frame.frameIndex ?? 0) !== manifest.frameIndex) return [];
  if (manifest.scope === 'all-frames' && frame.idSource !== 'explicit') throw attributeError(`“${manifest.file.name}” requires stable atom IDs in every frame.`);
  const ids = checkedIds(frame.ids, 'The frame');
  if (ids.length !== bundle.ids.length) throw attributeError(`“${manifest.file.name}” has ${bundle.ids.length} atoms; this frame has ${ids.length}.`);
  const mapping = new Uint32Array(ids.length);
  for (let atom = 0; atom < ids.length; atom++) {
    const source = bundle.byId.get(ids[atom]);
    if (source === undefined) throw attributeError(`Atom ID ${ids[atom]} has no attributes in “${manifest.file.name}”.`);
    mapping[atom] = source;
  }
  const byColumn = new Map(bundle.columns.map(column => [column.sourceName, column]));
  return manifest.columns.filter(column => column.enabled).map(column => {
    const source = byColumn.get(column.sourceName);
    if (!source) throw attributeError(`The reselected file is missing column “${column.sourceName}”.`);
    const data = Float64Array.from(mapping, row => source.data[row]);
    return { name: column.name, unit: column.unit, data, externalImportId: manifest.id,
      externalPropertySource: column.sourceName, externalFileName: manifest.file.name };
  });
}

export function validateExternalPropertyAllocation(atomCount, propertyCount) {
  if (!Number.isSafeInteger(atomCount) || atomCount < 0 || !Number.isSafeInteger(propertyCount) || propertyCount < 0
    || atomCount * propertyCount * Float64Array.BYTES_PER_ELEMENT > MAX_EXTERNAL_PROPERTY_BYTES) {
    throw attributeError(`Attribute arrays exceed the ${MAX_EXTERNAL_PROPERTY_BYTES / 1024 ** 2} MiB memory limit. Use fewer columns or atoms.`);
  }
}

function csvFields(line, number) {
  const fields = []; let field = '', quoted = false, closed = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') { field += '"'; index++; }
      else if (character === '"') { quoted = false; closed = true; }
      else field += character;
    } else if (character === ',') { fields.push(field.trim()); field = ''; closed = false; }
    else if (character === '"' && !field.trim() && !closed) { field = ''; quoted = true; }
    else if (closed && character.trim()) throw attributeError(`Line ${number} has text after a quoted CSV field.`);
    else field += character;
  }
  if (quoted) throw attributeError(`Line ${number} has an unclosed CSV quote. Multiline fields are not supported.`);
  fields.push(field.trim());
  return fields;
}

function isNumericToken(token) { return !token || /^(?:nan|[-+]?(?:inf(?:inity)?|(?:\d+\.?\d*|\.\d+)(?:[ed][-+]?\d+)?))$/i.test(token); }
function parseValue(token, line, name) {
  if (!token || /^nan$/i.test(token)) return NaN;
  if (!isNumericToken(token)) throw attributeError(`Line ${line}: “${name}” must be numeric or NaN.`);
  const value = Number(token.replace(/[dD]/, 'e'));
  if (!Number.isFinite(value)) throw attributeError(`Line ${line}: “${name}” is infinite or out of range.`);
  return value;
}
function parseId(token, context) {
  if (typeof token === 'string' && !token.trim()) throw attributeError(`${context} requires a non-empty atom ID.`);
  const value = typeof token === 'number' ? token : Number(token);
  if (!Number.isSafeInteger(value) || value < 0) throw attributeError(`${context} requires non-negative, finite, safe integer atom IDs.`);
  return value;
}
function checkedIds(input, context) {
  if (!input || !Number.isSafeInteger(input.length) || !input.length) throw attributeError(`${context} contains no atom IDs.`);
  const ids = Array.from(input, value => parseId(value, context));
  if (new Set(ids).size !== ids.length) throw attributeError(`${context} contains duplicate atom IDs.`);
  return ids;
}
function checkRecord(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw attributeError(`Invalid ${label}.`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw attributeError(`Unexpected ${label} key “${key}”; attribute values are kept in local files.`);
}
function integer(value, label) { if (!Number.isSafeInteger(value) || value < 0) throw attributeError(`${label} must be a non-negative safe integer.`); return value; }
function attributeError(message) { return new Error(`External attributes: ${message}`); }
