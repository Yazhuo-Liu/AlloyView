import { parsePoscar, parsePoscarAsync, looksLikePoscar, MAX_POSCAR_ATOMS } from './poscar.js';
import { splitParserLines, PARSER_CHECKPOINT_MASK } from './cooperative-parser.js';
import { runCooperativeSteps, runCooperativeStepsAsync } from '../shared/cooperative-steps.js';
import { cartesianToFractionalSteps, collectFrameSummarySteps } from './cooperative-coordinates.js';
import { attachFrameSummary } from '../data/frame-summary.js';
import { createCell, determinant3, validateFrame } from '../data/model.js';
import { ELEMENT_SYMBOLS } from '../data/chemical-elements.js';
import { validateVolumetricDataset, VOLUMETRIC_LIMITS } from '../data/volumetric-grid.js';

export const BOHR_ANGSTROM = 0.529177210903;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?$/;
const INTEGER = /^[+-]?\d+$/;
const error = message => new Error(`Volumetric data: ${message}`);
const tokens = line => String(line ?? '').trim().split(/\s+/).filter(Boolean);
const numeric = token => NUMBER.test(token) ? Number(token.replace(/[dD]/, 'e')) : NaN;
const integer = token => INTEGER.test(token) && Number.isSafeInteger(Number(token)) ? Number(token) : NaN;
const finite = (token, label) => {
  const value = numeric(token);
  if (!Number.isFinite(value)) throw error(`${label} is not a finite number.`);
  return value;
};

function inputText(input) {
  const text = String(input).replace(/^\uFEFF/, '');
  if (text.length > VOLUMETRIC_LIMITS.textCharacters) throw error('the file exceeds the 256 Mi-character text budget.');
  if (text.includes('\0')) throw error('binary input is not a text volumetric file.');
  return text;
}

/** Cube has two free-text comments, an atom-count/origin row and three signed
 * grid-size/vector rows. Detection only reads the header; parsing is strict. */
export function looksLikeCube(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/, 7);
  if (!hasCubeHeader(lines)) return false;
  const sizes = [3, 4, 5].map(index => integer(tokens(lines[index])[0]));
  const steps = [3, 4, 5].flatMap(index => tokens(lines[index]).slice(1).map(numeric));
  if (!sizes.every(size => Math.sign(size) === Math.sign(sizes[0]))
      || !Number.isFinite(determinant3(steps)) || determinant3(steps) === 0) return false;
  // Numeric XYZ species/coordinates can resemble the first six Cube rows.
  // When available, the first atom must have Cube's distinct five columns.
  if (lines[6]?.trim() && integer(tokens(lines[2])[0]) !== 0) {
    const atom = tokens(lines[6]);
    if (atom.length !== 5 || !(integer(atom[0]) >= 0 && integer(atom[0]) <= ELEMENT_SYMBOLS.length)
        || !atom.slice(1).every(token => Number.isFinite(numeric(token)))) return false;
  }
  return true;
}
function hasCubeHeader(lines) {
  if (lines.length < 6) return false;
  const atom = tokens(lines[2]);
  if (![4, 5].includes(atom.length) || !Number.isFinite(integer(atom[0]))
      || !atom.slice(1, 4).every(token => Number.isFinite(numeric(token)))) return false;
  return [3, 4, 5].every(index => {
    const row = tokens(lines[index]);
    return row.length === 4 && Number.isFinite(integer(row[0])) && integer(row[0]) !== 0
      && row.slice(1).every(token => Number.isFinite(numeric(token)));
  });
}

/** Conventional VASP filenames identify physical units; a renamed file cannot
 * distinguish density, potential and ELF from these identical numeric layouts. */
export function inferVaspVolumeKind(sourceName = '') {
  const name = String(sourceName).replaceAll('\\', '/').split('/').at(-1).replace(/\.gz$/i, '');
  if (/(?:^|[._-])(?:CHGCAR|CHG)(?:$|[._-])/i.test(name)) return 'charge-density';
  if (/(?:^|[._-])LOCPOT(?:$|[._-])/i.test(name)) return 'potential';
  if (/(?:^|[._-])ELFCAR(?:$|[._-])/i.test(name)) return 'elf';
  return 'unknown';
}

export function looksLikeVaspVolume(text) {
  if (!looksLikePoscar(text)) return false;
  text = String(text).replace(/^\uFEFF/, '');
  try {
    const prefix = text.split(/\r?\n/, 10), atomEnd = vaspHeaderEnd(prefix, { requireComplete: false });
    // Inspect only the atom prefix and first following row. Splitting every
    // volumetric sample here would duplicate the full parser's line storage.
    let start = 0;
    for (let row = 0; row < atomEnd; row++) {
      const newline = text.indexOf('\n', start);
      if (newline < 0) return false;
      start = newline + 1;
    }
    while (start < text.length) {
      const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline;
      const row = tokens(text.slice(start, end));
      // Detection must not reject oversized dimensions: the volume parser
      // must report its budget error instead of silently loading only atoms.
      if (row.length) return row.length === 3 && row.every(token => integer(token) > 0);
      start = end + 1;
    }
    return false;
  } catch { return false; }
}

export function parseCube(text, sourceName = 'structure.cube', options = {}) {
  return runCooperativeSteps(cubeSteps(text, sourceName, options));
}
export function parseCubeAsync(text, sourceName = 'structure.cube', options = {}) {
  return runCooperativeStepsAsync(cubeSteps(text, sourceName, options), options);
}

export function parseVaspVolume(text, sourceName = 'vasp-volume', options = {}) {
  const prepared = runCooperativeSteps(prepareVaspSteps(text, sourceName, options));
  const frame = parsePoscar(prepared.header, sourceName);
  return runCooperativeSteps(vaspDataSteps(frame, prepared));
}
export async function parseVaspVolumeAsync(text, sourceName = 'vasp-volume', options = {}) {
  const prepared = await runCooperativeStepsAsync(prepareVaspSteps(text, sourceName, options), options);
  const frame = await parsePoscarAsync(prepared.header, sourceName, options);
  return runCooperativeStepsAsync(vaspDataSteps(frame, prepared), options);
}

function parseDimensions(row) {
  if (row.length !== 3 || row.some(token => !(integer(token) >= 1))) {
    throw error('a grid dimension row must contain exactly three positive integers.');
  }
  const dimensions = row.map(Number);
  sampleCount(dimensions);
  return dimensions;
}
function sampleCount(dimensions, fields = 1) {
  const count = dimensions.reduce((product, value) => product * value, 1);
  if (!Number.isSafeInteger(count) || count < 1 || count > VOLUMETRIC_LIMITS.samplesPerDataset) {
    throw error(`each grid is limited to ${VOLUMETRIC_LIMITS.samplesPerDataset.toLocaleString('en-US')} samples.`);
  }
  if (!Number.isSafeInteger(fields) || fields < 1 || fields > VOLUMETRIC_LIMITS.datasets
      || count * fields > VOLUMETRIC_LIMITS.totalSamples) throw error('the datasets exceed the combined sample budget.');
  return count;
}
function* nextNonemptySteps(lines, cursor) {
  while (cursor < lines.length && !lines[cursor].trim()) {
    if ((cursor & PARSER_CHECKPOINT_MASK) === 0) yield;
    cursor++;
  }
  return cursor;
}
function vaspHeaderEnd(lines, { requireComplete = true } = {}) {
  const headerTokens = line => tokens(String(line ?? '').split('!')[0]);
  let cursor = 5, counts = headerTokens(lines[cursor]);
  if (!counts.length || !counts.every(token => /^\d+$/.test(token))) counts = headerTokens(lines[++cursor]);
  if (!counts.length || !counts.every(token => /^\d+$/.test(token))) throw error('invalid VASP atom-count row.');
  const count = counts.reduce((sum, token) => sum + Number(token), 0);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_POSCAR_ATOMS) throw error('the VASP atom count is invalid or excessive.');
  cursor++;
  if (/^s/i.test(lines[cursor]?.trim() ?? '')) cursor++;
  if (!/^[cdk]/i.test(lines[cursor]?.trim() ?? '')) throw error('the VASP coordinate mode is missing.');
  const end = cursor + 1 + count;
  if (requireComplete && end > lines.length) throw error('incomplete VASP atom coordinates.');
  return end;
}
function* prepareVaspSteps(input, sourceName, options) {
  const startedAt = performance.now(), text = inputText(input), lines = yield* splitParserLines(text);
  const end = vaspHeaderEnd(lines), cursor = yield* nextNonemptySteps(lines, end);
  parseDimensions(tokens(lines[cursor]));
  const kind = options.kind ?? inferVaspVolumeKind(sourceName);
  if (!['charge-density', 'potential', 'elf', 'unknown'].includes(kind)) throw error('unknown VASP volumetric quantity.');
  // Only the atomic prefix enters POSCAR. Grid values and PAW augmentation
  // records cannot be misinterpreted as velocity or predictor coordinates.
  return { lines, cursor, header: lines.slice(0, end).join('\n'), sourceName, kind,
    kindSource: options.kind === undefined ? kind === 'unknown' ? 'unknown' : 'filename' : 'explicit', startedAt };
}

/** Read exactly one complete numeric record, rejecting extra values instead
 * of consuming the next grid/augmentation header as part of a damaged array. */
function* readNumericRecord(lines, cursor, count, accept) {
  let index = 0;
  while (index < count) {
    cursor = yield* nextNonemptySteps(lines, cursor);
    if (cursor >= lines.length) throw error(`incomplete numeric data: expected ${count} values, found ${index}.`);
    // A large grid may be written on one line. Iterate tokens without creating
    // an equally large JS string array, and retain cancellation checkpoints.
    for (const match of lines[cursor].matchAll(/\S+/g)) {
      if (index === count) throw error(`line ${cursor + 1} has more values than the declared grid or augmentation record.`);
      if ((index & PARSER_CHECKPOINT_MASK) === 0) yield;
      const value = finite(match[0], `value at line ${cursor + 1}`);
      accept?.(value, index); index++;
    }
    cursor++;
  }
  return cursor;
}

function* vaspDataSteps(frame, prepared) {
  const { lines, kind, kindSource, sourceName, startedAt } = prepared;
  let cursor = prepared.cursor;
  const dimensions = parseDimensions(tokens(lines[cursor++])), count = sampleCount(dimensions);
  const volume = Math.abs(determinant3(frame.cell.vectors));
  const steps = Float64Array.from(frame.cell.vectors, (value, index) => value / dimensions[Math.floor(index / 3)]);
  const datasets = [], warnings = [];
  for (;;) {
    sampleCount(dimensions, datasets.length + 1);
    const values = new Float64Array(count);
    cursor = yield* readNumericRecord(lines, cursor, count, (raw, index) => {
      const value = kind === 'charge-density' ? raw / volume : raw;
      if (!Number.isFinite(value)) throw error('density normalization exceeds the numerical range.');
      values[index] = value;
    });
    datasets.push({ id: `vasp-${datasets.length}`, name: '', kind,
      unit: kind === 'charge-density' ? 'e/Å³' : kind === 'potential' ? 'eV' : kind === 'elf' ? '' : 'file units',
      dimensions: [...dimensions], origin: new Float64Array(frame.cell.origin), steps: new Float64Array(steps),
      periodic: [true, true, true], values, sourceNormalization: kind === 'charge-density' ? 'raw / cell volume' : 'none' });
    // PAW augmentation values are not grid samples. Their explicit record
    // lengths let us skip them without interpreting a coincidental 3-integer
    // augmentation row as the next channel's dimension header.
    for (;;) {
      cursor = yield* nextNonemptySteps(lines, cursor);
      if (cursor >= lines.length) break;
      const augmentation = lines[cursor].trim().match(/^augmentation\s+occupancies\s+(\d+)\s+(\d+)\s*$/i);
      if (!augmentation) break;
      const atom = Number(augmentation[1]), length = Number(augmentation[2]);
      if (!Number.isSafeInteger(atom) || atom < 1 || atom > frame.ids.length
          || !Number.isSafeInteger(length) || length < 0 || length > VOLUMETRIC_LIMITS.samplesPerDataset) {
        throw error('invalid PAW augmentation record.');
      }
      cursor = yield* readNumericRecord(lines, cursor + 1, length);
    }
    if (cursor >= lines.length) break;
    const next = parseDimensions(tokens(lines[cursor++]));
    if (next.some((value, axis) => value !== dimensions[axis])) throw error('VASP field channels must use the same grid dimensions.');
  }
  if (kind !== 'unknown' && ![1, 2, 4].includes(datasets.length)) {
    throw error('VASP volumetric files must contain one scalar field, two spin fields, or four noncollinear fields.');
  }
  for (let index = 0; index < datasets.length; index++) {
    const dataset = datasets[index]; dataset.name = vaspFieldName(kind, index, datasets.length);
    validateVolumetricDataset(dataset);
    dataset.statistics = yield* gridStatisticsSteps(dataset);
  }
  if (kind === 'unknown') warnings.push('The VASP grid quantity is unknown. Values remain in file units; density normalization has not been applied. Use the conventional CHGCAR, CHG, LOCPOT or ELFCAR filename, or an explicit parser quantity.');
  frame.sourceFormat = 'vasp-volume'; frame.parseMs = performance.now() - startedAt;
  frame.volumetric = { format: 'vasp-volume', quantity: kind, kindSource, sourceName, datasets, warnings };
  return frame;
}
function vaspFieldName(kind, index, fields) {
  if (kind === 'charge-density') return index === 0 ? 'Electron density'
    : fields === 2 ? 'Magnetization density' : `Magnetization ${['X', 'Y', 'Z'][index - 1]}`;
  if (kind === 'potential') return fields === 1 ? 'Local potential'
    : fields === 2 ? `Local potential (spin ${index === 0 ? 'up' : 'down'})`
      : index === 0 ? 'Scalar potential' : `Spin potential ${['X', 'Y', 'Z'][index - 1]}`;
  if (kind === 'elf') return fields === 1 ? 'Electron localization function'
    : fields === 2 ? `ELF (spin ${index === 0 ? 'up' : 'down'})` : `ELF field ${index + 1}`;
  return `VASP field ${index + 1}`;
}

function* cubeSteps(input, sourceName, options) {
  const startedAt = performance.now(), text = inputText(input), lines = yield* splitParserLines(text);
  if (!hasCubeHeader(lines)) throw error('invalid Gaussian Cube header.');
  const comments = [lines[0], lines[1]], atomHeader = tokens(lines[2]);
  const signedAtoms = integer(atomHeader[0]), count = Math.abs(signedAtoms);
  if (count < 1 || count > MAX_POSCAR_ATOMS) throw error('Cube structures require at least one atom and a bounded atom count.');
  const rows = [3, 4, 5].map(index => tokens(lines[index])), signedSizes = rows.map(row => integer(row[0]));
  if (!signedSizes.every(value => Math.sign(value) === Math.sign(signedSizes[0]))) throw error('Cube voxel counts must use consistent Bohr/Å unit signs.');
  const dimensions = signedSizes.map(Math.abs), gridCount = sampleCount(dimensions);
  const factor = signedSizes[0] < 0 ? 1 : BOHR_ANGSTROM;
  const origin = Float64Array.from(atomHeader.slice(1, 4), token => finite(token, 'Cube origin') * factor);
  const steps = Float64Array.from(rows.flatMap(row => row.slice(1)), token => finite(token, 'Cube voxel vector') * factor);
  if (![...origin, ...steps].every(Number.isFinite) || !Number.isFinite(determinant3(steps)) || determinant3(steps) === 0) throw error('Cube voxel vectors must be finite and nonsingular.');
  let fields = atomHeader.length === 5 ? integer(atomHeader[4]) : 1;
  if (!Number.isSafeInteger(fields) || fields < 1) throw error('Cube NVAL must be a positive integer.');
  if (signedAtoms < 0 && fields !== 1) throw error('An orbital Cube uses its dataset-ID block, not a separate NVAL larger than one.');
  const ids = new Float64Array(count), types = new Uint16Array(count), positions = new Float64Array(count * 3);
  const charges = new Float64Array(count), typeLabels = [], species = new Map();
  let cursor = 6;
  if (count > lines.length - cursor) throw error('incomplete Cube atom table.');
  for (let atom = 0; atom < count; atom++, cursor++) {
    if ((atom & PARSER_CHECKPOINT_MASK) === 0) yield;
    const row = tokens(lines[cursor]);
    if (row.length !== 5) throw error(`Cube atom at line ${cursor + 1} needs atomic number, charge and three coordinates.`);
    const atomicNumber = integer(row[0]);
    if (!(atomicNumber >= 0 && atomicNumber <= ELEMENT_SYMBOLS.length)) throw error('Cube atomic numbers must be integers from 0 to 118.');
    const label = atomicNumber === 0 ? 'Type 0' : ELEMENT_SYMBOLS[atomicNumber - 1];
    if (!species.has(label)) { species.set(label, species.size); typeLabels.push(label); }
    ids[atom] = atom + 1; types[atom] = species.get(label); charges[atom] = finite(row[1], 'Cube nuclear charge');
    for (let axis = 0; axis < 3; axis++) positions[atom * 3 + axis] = finite(row[axis + 2], 'Cube atom coordinate') * factor;
  }
  let fieldIds = null;
  if (signedAtoms < 0) {
    cursor = yield* nextNonemptySteps(lines, cursor);
    const first = tokens(lines[cursor]); fields = integer(first[0]); sampleCount(dimensions, fields);
    const record = [];
    while (record.length < fields + 1) {
      if (cursor >= lines.length) throw error('incomplete Cube orbital dataset IDs.');
      const row = tokens(lines[cursor++]);
      for (const token of row) {
        const value = integer(token);
        if (!Number.isFinite(value)) throw error('Cube orbital dataset IDs must be integers.');
        record.push(value);
      }
      if (record.length > fields + 1) throw error('extra Cube orbital dataset IDs.');
      yield;
    }
    fieldIds = record.slice(1);
    if (new Set(fieldIds).size !== fields) throw error('Cube orbital dataset IDs must be unique.');
  }
  sampleCount(dimensions, fields);
  const datasets = Array.from({ length: fields }, (_, index) => ({ id: `cube-${fieldIds?.[index] ?? index}`,
    name: fieldIds ? `Orbital ${fieldIds[index]}` : fields === 1 ? 'Cube scalar field' : `Cube field ${index + 1}`,
    kind: 'unknown', unit: 'file units', dimensions: [...dimensions], origin: new Float64Array(origin), steps: new Float64Array(steps),
    periodic: [false, false, false], values: new Float64Array(gridCount), ...(fieldIds ? { orbitalId: fieldIds[index] } : {}) }));
  const [nx, ny, nz] = dimensions;
  cursor = yield* readNumericRecord(lines, cursor, gridCount * fields, (value, index) => {
    const field = index % fields, voxel = Math.floor(index / fields), x = Math.floor(voxel / (ny * nz));
    const y = Math.floor(voxel / nz) % ny, z = voxel % nz;
    datasets[field].values[x + nx * (y + ny * z)] = value;
  });
  if ((yield* nextNonemptySteps(lines, cursor)) !== lines.length) throw error('unexpected data after the complete Cube grid.');
  for (const dataset of datasets) {
    validateVolumetricDataset(dataset); dataset.statistics = yield* gridStatisticsSteps(dataset);
  }
  // The atom frame covers the sampled domain. A singleton axis uses one step
  // only to retain a nonsingular display cell; it still has zero open voxels.
  const vectors = Float64Array.from(steps, (value, index) => value * Math.max(1, dimensions[Math.floor(index / 3)] - 1));
  const cell = createCell({ origin, vectors, pbc: [false, false, false], triclinic: steps.some((value, index) => index % 4 !== 0 && value !== 0) });
  const fractional = yield* cartesianToFractionalSteps(positions, cell, new Float64Array(positions.length));
  const summary = yield* collectFrameSummarySteps(types, positions, typeLabels.length);
  return attachFrameSummary(validateFrame({ ids, idSource: 'row-order', types, typeLabels, positions, fractional, cell,
    properties: [{ name: 'nuclearCharge', unit: 'e', data: charges }], timestep: null, sourceFormat: 'cube', title: sourceName,
    comment: comments.join('\n'), parseMs: performance.now() - startedAt,
    volumetric: { format: 'cube', sourceName, sourceCoordinateUnit: factor === 1 ? 'Å' : 'bohr', comments, datasets,
      warnings: ['Cube does not declare the physical meaning or unit of its scalar values. Values remain in file units; only coordinates are converted to Å.'] },
  }), summary);
}

/** Periodic rectangle quadrature, open-axis trapezoidal quadrature. Integral
 * units are value-unit × Å³; only normalized CHGCAR charge integrates to e. */
function* gridStatisticsSteps(dataset) {
  const { values, dimensions: [nx, ny, nz], periodic } = dataset;
  let min = Infinity, max = -Infinity, sum = 0, correction = 0, weighted = 0, weightedCorrection = 0;
  for (let index = 0; index < values.length; index++) {
    if ((index & PARSER_CHECKPOINT_MASK) === 0) yield;
    const value = values[index]; min = Math.min(min, value); max = Math.max(max, value);
    const adjusted = value - correction, next = sum + adjusted; correction = (next - sum) - adjusted; sum = next;
    const x = index % nx, y = Math.floor(index / nx) % ny, z = Math.floor(index / (nx * ny));
    let weight = 1;
    if (!periodic[0]) weight *= nx === 1 ? 0 : x === 0 || x === nx - 1 ? 0.5 : 1;
    if (!periodic[1]) weight *= ny === 1 ? 0 : y === 0 || y === ny - 1 ? 0.5 : 1;
    if (!periodic[2]) weight *= nz === 1 ? 0 : z === 0 || z === nz - 1 ? 0.5 : 1;
    const term = value * weight - weightedCorrection, weightedNext = weighted + term;
    weightedCorrection = (weightedNext - weighted) - term; weighted = weightedNext;
  }
  const voxelVolume = Math.abs(determinant3(dataset.steps)), integral = weighted * voxelVolume;
  if (![sum, integral].every(Number.isFinite)) throw error('grid statistics exceed the numerical range.');
  return { min, max, mean: sum / values.length, sum, integral, voxelVolume, sampleCount: values.length,
    integralUnit: dataset.kind === 'charge-density' ? 'e' : `${dataset.unit || '1'}·Å³` };
}
