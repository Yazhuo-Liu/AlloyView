// Optional comparison of grain segmentation with OVITO; not part of the application.
//
//   node scripts/research/ovito-grains-compare.mjs structures <directory>
//       writes the validation structures as LAMMPS dump files
//   node scripts/research/ovito-grains-compare.mjs compare <structure.dump> <reference directory> [--json report.json]
//       compares with the output of ovito-grains-oracle.py for that file:
//       the grain engine on OVITO's own PTM output, and AlloyView's PTM and grains end to end
//   node scripts/research/ovito-grains-compare.mjs fixture <bicrystal|twinFault> <reference directory>
//       writes tests/fixtures/grains-ovito-<name>.json from an oracle run on that fixture structure
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { calculatePtm } from '../../src/analysis/ptm.js';
import { buildGrainDendrogram, segmentGrains } from '../../src/analysis/grains.js';
import { latticeDisorientation } from '../../src/analysis/disorientation.js';
import { invert3 } from '../../src/data/model.js';
import { replicateFrame } from '../../src/data/replicate.js';
import { parseCfg } from '../../src/io/cfg.js';
import { parseLammpsFrame } from '../../src/io/lammps-dump.js';
import { GRAIN_FIXTURES } from '../../tests/helpers/grain-fixtures.js';
import { adjustedRandIndex, mulberry32, polycrystalDumpText, polycrystalFrame, randomQuaternion, stackedLayersFrame } from '../../tests/helpers/polycrystal.js';

const root = path.resolve(import.meta.dirname, '../..');
const [command, ...rest] = process.argv.slice(2);
const PTM_FLAGS = { FCC: 1, HCP: 2, BCC: 4, ICO: 8, SC: 16, CUBIC_DIAMOND: 32, HEX_DIAMOND: 64, GRAPHENE: 128 };

function randomGrains(count, box, seed) {
  const random = mulberry32(seed), seeds = [], orientations = [];
  for (let grain = 0; grain < count; grain += 1) { seeds.push(box.map(length => random() * length)); orientations.push(randomQuaternion(random)); }
  return { seeds, orientations };
}

async function writeStructures(directory) {
  await mkdir(directory, { recursive: true });
  const polycrystals = {
    'fcc-4grain': { lattice: 'fcc', a: 3.52, box: [60, 60, 40], ...randomGrains(4, [60, 60, 40], 11), noise: .05, seed: 5 },
    'bcc-6grain': { lattice: 'bcc', a: 2.87, box: [60, 60, 50], ...randomGrains(6, [60, 60, 50], 23), noise: .04, seed: 7 },
    'hcp-5grain': { lattice: 'hcp', a: 3.2, box: [70, 60, 55], ...randomGrains(5, [70, 60, 55], 31), noise: .04, seed: 9 },
    'mixed-3grain': { lattice: ['fcc', 'bcc', 'hcp'], a: 3.3, box: [60, 50, 50], ...randomGrains(3, [60, 50, 50], 57), noise: .04, seed: 17 },
    'fcc-8grain': { lattice: 'fcc', a: 3.61, box: [80, 80, 80], ...randomGrains(8, [80, 80, 80], 41), noise: .06, seed: 13 },
    'fcc-8grain-ideal': { lattice: 'fcc', a: 3.61, box: [60, 60, 60], ...randomGrains(8, [60, 60, 60], 43), noise: 0, seed: 13 },
    'fcc-100k': { lattice: 'fcc', a: 3.52, box: [106, 106, 106], ...randomGrains(8, [106, 106, 106], 71), noise: .05, seed: 19 },
  };
  const stacks = {
    'fcc-twin-fault': { steps: [...Array(8).fill(1), -1, ...Array(7).fill(1), ...Array(8).fill(-1), ...Array(6).fill(1)], nearest: 2.49, noise: .03, seed: 21 },
    'hcp-fcc-slab': { steps: [...Array(10).fill(0).flatMap(() => [1, -1]), ...Array(9).fill(1)], nearest: 2.95, noise: .03, seed: 23 },
  };
  const frames = { ...Object.fromEntries(Object.entries(polycrystals).map(([name, spec]) => [name, () => polycrystalFrame(spec)])),
    ...Object.fromEntries(Object.entries(stacks).map(([name, spec]) => [name, () => stackedLayersFrame(spec)])),
    ...Object.fromEntries(Object.entries(GRAIN_FIXTURES).map(([name, build]) => [`fixture-${name}`, build])) };
  for (const [name, build] of Object.entries(frames)) {
    const frame = build();
    await writeFile(path.join(directory, `${name}.dump`), polycrystalDumpText(frame));
    console.log(name, frame.ids.length);
  }
  // The example bicrystal is one lattice period thick: replicate it 1 × 1 × 2.
  const source = parseCfg(await readFile(path.join(root, 'examples/NiGB_minimized.cfg'), 'utf8'), 'NiGB_minimized.cfg');
  const frame = await replicateFrame(source, [1, 1, 2]), h = frame.cell.vectors, o = frame.cell.origin, atoms = frame.fractional.length / 3;
  const lines = ['ITEM: TIMESTEP', '0', 'ITEM: NUMBER OF ATOMS', String(atoms), 'ITEM: BOX BOUNDS pp pp pp',
    `${o[0]} ${o[0] + h[0]}`, `${o[1]} ${o[1] + h[4]}`, `${o[2]} ${o[2] + h[8]}`, 'ITEM: ATOMS id type element xs ys zs'];
  for (let atom = 0; atom < atoms; atom += 1) lines.push(`${atom + 1} 1 Ni ${frame.fractional[atom * 3]} ${frame.fractional[atom * 3 + 1]} ${frame.fractional[atom * 3 + 2]}`);
  await writeFile(path.join(directory, 'nigb-x2.dump'), `${lines.join('\n')}\n`);
  console.log('nigb-x2', atoms);
}

async function readReference(directory) {
  const meta = JSON.parse(await readFile(path.join(directory, 'meta.json'), 'utf8'));
  const read = async (name, Type) => {
    const bytes = await readFile(path.join(directory, name));
    return new Type(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  return { meta, read, positions: await read('positions.f64', Float64Array), structure: await read('structure.i32', Int32Array),
    orientation: await read('orientation.f32', Float32Array), counts: await read('neighbor_counts.u8', Uint8Array),
    indices: await read('neighbor_indices.u32', Uint32Array) };
}

function grainOptions(options) {
  return { algorithm: options.algorithm ?? 'automatic', mergeThreshold: Number(options.threshold ?? 0), minGrainSize: Number(options.minsize ?? 100),
    adoptOrphans: (options.orphans ?? '1') === '1', handleCoherentInterfaces: (options.interfaces ?? '1') === '1' };
}

/** The grain engine's input from OVITO's PTM output and positions. */
function ovitoInput(reference) {
  const { meta } = reference, atoms = meta.atoms, c = meta.cell;
  // OVITO's cell is 3 × 4, row-major: three cell vectors as columns, then the origin.
  const cell = { vectors: Float64Array.of(c[0][0], c[1][0], c[2][0], c[0][1], c[1][1], c[2][1], c[0][2], c[1][2], c[2][2]), pbc: meta.pbc };
  const origin = [c[0][3], c[1][3], c[2][3]], inverse = invert3(cell.vectors), fractional = new Float64Array(atoms * 3);
  for (let atom = 0; atom < atoms; atom += 1) {
    const x = reference.positions[atom * 3] - origin[0], y = reference.positions[atom * 3 + 1] - origin[1], z = reference.positions[atom * 3 + 2] - origin[2];
    for (let k = 0; k < 3; k += 1) fractional[atom * 3 + k] = x * inverse[k] + y * inverse[3 + k] + z * inverse[6 + k];
  }
  const orientations = new Float64Array(atoms * 4);
  for (let atom = 0; atom < atoms; atom += 1) { // (x, y, z, w) → (w, x, y, z)
    orientations[atom * 4] = reference.orientation[atom * 4 + 3];
    for (let k = 0; k < 3; k += 1) orientations[atom * 4 + 1 + k] = reference.orientation[atom * 4 + k];
  }
  return { structures: Uint8Array.from(reference.structure), orientations, neighborCounts: reference.counts, neighborIndices: reference.indices,
    neighborSpan: null, fractional, cell };
}

const maxDifference = (a, b) => { if (a.length !== b.length) return null; let d = 0; for (let i = 0; i < a.length; i += 1) d = Math.max(d, Math.abs(a[i] - b[i])); return d; };

async function compareVariant(reference, name, entry, input, label) {
  const atoms = reference.meta.atoms, options = grainOptions(entry.options), started = performance.now();
  const model = buildGrainDendrogram(input, { ...options, includeRegression: true }), result = segmentGrains(model, options);
  const ms = performance.now() - started;
  const theirGrain = await reference.read(`${name}.grain.i32`, Int32Array), theirSizes = await reference.read(`${name}.grain_sizes.i32`, Int32Array);
  const theirTypes = await reference.read(`${name}.grain_types.i32`, Int32Array), theirOrientations = await reference.read(`${name}.grain_orientations.f64`, Float64Array);
  // OVITO's grain IDs are matched to ours through the atoms.
  const forward = new Map(), backward = new Map();
  let partitionExact = true, idExact = true, theirUnassigned = 0;
  for (let atom = 0; atom < atoms; atom += 1) {
    const theirs = theirGrain[atom], mine = result.grainId[atom];
    if (theirs === 0) theirUnassigned += 1;
    if (theirs !== mine) idExact = false;
    if (!forward.has(theirs)) forward.set(theirs, mine); else if (forward.get(theirs) !== mine) partitionExact = false;
    if (!backward.has(mine)) backward.set(mine, theirs); else if (backward.get(mine) !== theirs) partitionExact = false;
  }
  if ((forward.get(0) ?? 0) !== 0) partitionExact = false;
  const row = { label, variant: name, ms: Math.round(ms), grainCount: [result.grainCount, entry.grainCount], threshold: [result.mergeThreshold, entry.autoThreshold],
    thresholdDifference: entry.autoThreshold == null ? null : Math.abs(result.mergeThreshold - entry.autoThreshold),
    partitionExact, idExact, adjustedRandIndex: adjustedRandIndex(result.grainId, theirGrain), unassigned: [result.unassignedAtoms, theirUnassigned] };
  if (partitionExact && result.grainCount === entry.grainCount) {
    // OVITO numbers grains by size before orphan adoption, AlloyView by the final size.
    const before = options.adoptOrphans ? segmentGrains(model, { ...options, adoptOrphans: false }) : result;
    row.idExactInUpstreamOrder = true;
    for (let atom = 0; atom < atoms && row.idExactInUpstreamOrder; atom += 1) if (before.grainId[atom] !== 0 && before.grainId[atom] !== theirGrain[atom]) row.idExactInUpstreamOrder = false;
    Object.assign(row, { sizeMismatches: 0, structureTypeMismatches: 0, rootStructureTypeMismatches: 0, orientationComponentDifference: 0, orientationDisorientationDegrees: 0 });
    for (const [theirs, mine] of forward) {
      if (!theirs) continue;
      if (theirSizes[theirs - 1] !== result.sizes[mine - 1]) row.sizeMismatches += 1;
      if (theirTypes[theirs - 1] !== result.structureTypes[mine - 1]) row.structureTypeMismatches += 1;
      if (theirTypes[theirs - 1] !== result.rootStructureTypes[mine - 1]) row.rootStructureTypeMismatches += 1;
      const q = theirOrientations.subarray((theirs - 1) * 4, theirs * 4), m = result.orientations.subarray((mine - 1) * 4, mine * 4), type = result.structureTypes[mine - 1];
      row.orientationComponentDifference = Math.max(row.orientationComponentDifference, Math.abs(m[0] - q[3]), Math.abs(m[1] - q[0]), Math.abs(m[2] - q[1]), Math.abs(m[3] - q[2]));
      row.orientationDisorientationDegrees = Math.max(row.orientationDisorientationDegrees,
        latticeDisorientation(type, type, Float64Array.of(q[3], q[0], q[1], q[2]), 0, Float64Array.from(m), 0));
    }
  }
  if (entry.tables['grains-log']) {
    const theirs = await reference.read(`${name}.grains-log.Log_merge_distance.f64`, Float64Array);
    const mine = Array.from(model.regression.logDistance).filter(value => value > 0);
    row.merges = [mine.length, theirs.length];
    row.logDistanceDifference = maxDifference(mine, theirs);
  }
  if (entry.tables['grains-merge']) {
    const columns = entry.tables['grains-merge'].columns.map(column => column.replace(/ /g, '_'));
    const distance = await reference.read(`${name}.grains-merge.${columns[0]}.f64`, Float64Array);
    row.plotPoints = [model.plot.distance.length, distance.length];
    row.plotDistanceDifference = maxDifference(model.plot.distance, distance);
  }
  return row;
}

async function compare(structurePath, directory) {
  const reference = await readReference(directory), { meta } = reference, atoms = meta.atoms;
  const frame = parseLammpsFrame(await readFile(structurePath, 'utf8'), path.basename(structurePath));
  const flags = meta.ptmTypes.reduce((mask, name) => mask | PTM_FLAGS[name], 0);
  const started = performance.now(), ptm = await calculatePtm(frame, { flags, rmsdCutoff: meta.rmsd, neighborLists: true });
  const report = { structure: path.basename(structurePath), atoms, ptmMs: Math.round(performance.now() - started),
    ptm: { structureMismatches: 0, orientationMaxDifference: 0, neighborOrderMismatches: 0, neighborSetMismatches: 0, positionMaxDifference: 0 }, rows: [] };
  for (let i = 0; i < atoms * 3; i += 1) report.ptm.positionMaxDifference = Math.max(report.ptm.positionMaxDifference, Math.abs(frame.positions[i] - reference.positions[i]));
  for (let atom = 0; atom < atoms; atom += 1) {
    if (ptm.structures[atom] !== reference.structure[atom]) { report.ptm.structureMismatches += 1; continue; }
    // Compared up to crystal symmetry: PTM may return either of two equivalents on a zone boundary.
    if (ptm.structures[atom] && ptm.structures[atom] !== 4) {
      // OVITO's single-precision quaternion is normalized first: the angle
      // formula reads a norm below one as a rotation of up to 0.05°.
      const theirs = Float64Array.of(reference.orientation[atom * 4 + 3], reference.orientation[atom * 4], reference.orientation[atom * 4 + 1], reference.orientation[atom * 4 + 2]);
      const norm = Math.hypot(...theirs);
      for (let k = 0; k < 4; k += 1) theirs[k] /= norm;
      report.ptm.orientationMaxDifference = Math.max(report.ptm.orientationMaxDifference,
        latticeDisorientation(ptm.structures[atom], ptm.structures[atom], theirs, 0, ptm.orientations, atom * 4));
    }
    const mine = Array.from(ptm.neighborIndices.subarray(atom * 16, atom * 16 + ptm.neighborCounts[atom]));
    const theirs = Array.from(reference.indices.subarray(atom * 16, atom * 16 + reference.counts[atom]));
    if (mine.join() !== theirs.join()) report.ptm.neighborOrderMismatches += 1;
    if (mine.slice().sort().join() !== theirs.slice().sort().join()) report.ptm.neighborSetMismatches += 1;
  }
  report.ptm.orientationMaxDifferenceUnit = 'degrees of disorientation';
  const inputs = [['engine on OVITO PTM', ovitoInput(reference)], ['end to end', { ...ptm, fractional: frame.fractional, cell: frame.cell }]];
  for (const [name, entry] of Object.entries(meta.variants)) {
    if (entry.error) { report.rows.push({ variant: name, ovitoError: entry.error }); continue; }
    for (const [label, input] of inputs) report.rows.push(await compareVariant(reference, name, entry, input, label));
  }
  return report;
}

/** A compact test fixture: OVITO's PTM output and its grains for each variant. */
async function writeFixture(name, directory) {
  const reference = await readReference(directory), { meta } = reference, atoms = meta.atoms;
  const frame = GRAIN_FIXTURES[name]();
  if (frame.ids.length !== atoms) throw new Error(`The oracle ran on ${atoms} atoms, the fixture structure has ${frame.ids.length}.`);
  // OVITO's text parser may differ from the written doubles in the last bit.
  for (let i = 0; i < atoms * 3; i += 1) if (!(Math.abs(frame.positions[i] - reference.positions[i]) < 1e-9)) throw new Error('The oracle positions differ from the fixture structure.');
  const pack = (Type, values) => { const typed = Type.from(values); return { type: Type.name, gzip: gzipSync(Buffer.from(typed.buffer), { level: 9 }).toString('base64') }; };
  const fixture = { description: `OVITO ${meta.ovito.join('.')} PolyhedralTemplateMatchingModifier (${meta.ptmTypes.join(', ')}; RMSD cutoff ${meta.rmsd}; orientations) and GrainSegmentationModifier on GRAIN_FIXTURES.${name} of tests/helpers/grain-fixtures.js. Written by scripts/research/ovito-grains-compare.mjs; orientations are (x, y, z, w).`,
    atoms, ptmTypes: meta.ptmTypes, rmsd: meta.rmsd,
    ptm: { structure: pack(Uint8Array, reference.structure), orientation: pack(Float32Array, reference.orientation),
      neighborCounts: pack(Uint8Array, reference.counts), neighborIndices: pack(Uint16Array, reference.indices) }, variants: {} };
  for (const [variant, entry] of Object.entries(meta.variants)) {
    if (entry.error) throw new Error(`OVITO failed for ${variant}: ${entry.error}`);
    const grain = await reference.read(`${variant}.grain.i32`, Int32Array);
    const record = { options: grainOptions(entry.options), grainCount: entry.grainCount, autoThreshold: entry.autoThreshold ?? null,
      grain: pack(Uint8Array, grain), sizes: Array.from(await reference.read(`${variant}.grain_sizes.i32`, Int32Array)),
      structureTypes: Array.from(await reference.read(`${variant}.grain_types.i32`, Int32Array)),
      orientations: Array.from(await reference.read(`${variant}.grain_orientations.f64`, Float64Array)) };
    if (entry.tables['grains-merge']) {
      const columns = entry.tables['grains-merge'].columns.map(column => column.replace(/ /g, '_'));
      record.plotDistance = Array.from(await reference.read(`${variant}.grains-merge.${columns[0]}.f64`, Float64Array));
      record.plotSize = Array.from(await reference.read(`${variant}.grains-merge.${columns[1]}.f64`, Float64Array));
    }
    if (entry.tables['grains-log']) record.logDistance = pack(Float64Array, await reference.read(`${variant}.grains-log.Log_merge_distance.f64`, Float64Array));
    fixture.variants[variant] = record;
  }
  const target = path.join(root, `tests/fixtures/grains-ovito-${name}.json`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(fixture)}\n`);
  console.log(target, atoms, 'atoms', Object.keys(fixture.variants).join(', '));
}

if (command === 'structures' && rest[0]) await writeStructures(rest[0]);
else if (command === 'compare' && rest[1]) {
  const report = await compare(rest[0], rest[1]), json = rest.indexOf('--json');
  if (json >= 0) await writeFile(rest[json + 1], JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
} else if (command === 'fixture' && GRAIN_FIXTURES[rest[0]] && rest[1]) await writeFixture(rest[0], rest[1]);
else { console.error('Usage: ovito-grains-compare.mjs structures <directory> | compare <structure.dump> <reference directory> [--json file] | fixture <bicrystal|twinFault> <reference directory>'); process.exitCode = 1; }
