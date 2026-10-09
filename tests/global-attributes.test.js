import assert from 'node:assert/strict';
import test from 'node:test';
import { attributeSegment, cellAngles, cellLengths, cellStrain, createAttributeRegistry } from '../src/global-attributes.js';
import { createGlobalAttributeSource, normalizeGlobalAttributeState } from '../src/global-attribute-source.js';
import { buildStatisticsTable } from '../src/statistics-export.js';
import { STRUCTURE_TYPES } from '../src/analysis/cna.js';
import { PTM_TYPES } from '../src/analysis/ptm.js';
import { DXA_STRUCTURE_TYPES } from '../src/dxa-tools.js';
import { createCell, determinant3 } from '../src/data/model.js';

/** Ten atoms in a triclinic cell with file, imported, analysis and expression columns. */
function analyzedFrame({ scale = 1 } = {}) {
  const cell = createCell({ vectors: [10 * scale, 0, 0, 3, 12, 0, 1, 2, 14] });
  const count = 10, ids = Uint32Array.from({ length: count }, (_, atom) => atom + 1);
  const structures = Uint8Array.from([1, 1, 1, 1, 1, 1, 0, 2, 2, 3]);
  return {
    ids, types: Uint16Array.from([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]), typeLabels: ['Ni', 'Al'], cell, timestep: 2500, frameIndex: 3,
    positions: new Float32Array(count * 3),
    properties: [
      { name: 'c_pe', unit: 'eV', data: Float32Array.from({ length: count }, (_, atom) => -4 - atom / 10) },
      { name: 'c_stress[1]', unit: 'bar', data: Float64Array.from([1, 2, 3, NaN, 5, 6, 7, 8, 9, Infinity]) },
      { name: 'charge', unit: 'e', externalImportId: 'import-1', data: new Float64Array(count).fill(0.25) },
      { name: 'structureType', displayName: 'Crystal structure (CNA)', unit: '', data: structures, categories: STRUCTURE_TYPES,
        analysisKind: 'cna', analysisKey: '{"mode":"adaptive"}' },
      { name: 'ptmStructureType', unit: '', data: Uint8Array.from([7, 7, 7, 0, 0, 0, 0, 0, 0, 0]), categories: PTM_TYPES,
        analysisKind: 'ptm', analysisKey: '{"flags":31}' },
      { name: 'vonMises', unit: 'GPa', data: Float64Array.from({ length: count }, (_, atom) => atom), analysisKind: 'expression', expression: 'id - 1' },
      { name: 'dxaStructureType', unit: '', data: new Uint8Array(count).fill(1), categories: DXA_STRUCTURE_TYPES, analysisKind: 'dxa', analysisKey: '{"lattice":"fcc"}' },
      { name: 'clusterId', unit: '', data: Uint32Array.from([1, 1, 1, 1, 1, 2, 2, 2, 3, 3]), analysisKind: 'clusters', analysisKey: '{"cutoff":3}' },
    ],
    atomeyeResults: {
      clusters: { result: { clusterCount: 3, largestSize: 5, percolatingCount: 1, includedAtoms: 10 } },
      wignerSeitz: { result: { vacancyCount: 2, interstitialCount: 1, antisiteCount: 4, siteCount: 11, referenceFrame: 0, affineMapping: false } },
    },
  };
}

const network = { totalLength: 42.5, density: 0.0021, volume: 1680, segments: [{}, {}, {}],
  counts: { shockley: { count: 2, length: 30 }, perfect: 1 }, familyLengths: { shockley: 30, perfect: 12.5 } };

test('cell geometry and engineering strain are exact for simple cells', () => {
  const reference = createCell({ vectors: [10, 0, 0, 0, 20, 0, 0, 0, 30] });
  const stretched = createCell({ vectors: [10.5, 0, 0, 0, 19, 0, 0, 0, 30] });
  assert.deepEqual(cellLengths(stretched), [10.5, 19, 30]);
  assert.deepEqual(cellAngles(reference), [90, 90, 90]);
  const strain = cellStrain(stretched, reference);
  assert.equal(strain.a, (10.5 - 10) / 10); assert.equal(strain.b, (19 - 20) / 20); assert.equal(strain.c, 0);
  assert.equal(strain.volumetric, (10.5 * 19 * 30 - 6000) / 6000);
  const hexagonal = createCell({ vectors: [3, 0, 0, -1.5, 1.5 * Math.sqrt(3), 0, 0, 0, 5] });
  const [alpha, beta, gamma] = cellAngles(hexagonal);
  assert.equal(alpha, 90); assert.equal(beta, 90); assert.ok(Math.abs(gamma - 120) < 1e-12);
  assert.equal(attributeSegment('Hex. diamond'), 'Hex_diamond');
  assert.equal(attributeSegment('L1₀'), 'L10');
  assert.equal(attributeSegment('1/2 ⟨111⟩'), '1_2_111');
  assert.equal(attributeSegment('—'), '_');
});

test('frame, cell, strain, fractions and means use stable names and units', () => {
  const frame = analyzedFrame({ scale: 1.02 }), reference = analyzedFrame().cell;
  const registry = createAttributeRegistry({ frame, frameIndex: 3, frameCount: 12, referenceCell: reference, referenceFrameIndex: 0, dxaNetwork: network });
  const value = name => registry.get(name)?.value;
  assert.equal(value('Frame'), 4); assert.equal(value('FrameCount'), 12); assert.equal(value('Timestep'), 2500);
  assert.equal(value('AtomCount'), 10);
  assert.equal(value('Cell.volume'), Math.abs(determinant3(frame.cell.vectors)));
  assert.equal(registry.get('Cell.volume').unit, 'Å³');
  assert.equal(value('Cell.a'), 10.2); assert.equal(value('Cell.b'), Math.hypot(3, 12)); assert.equal(registry.get('Cell.gamma').unit, '°');
  assert.equal(value('Strain.a'), (10.2 - 10) / 10); assert.equal(value('Strain.b'), 0);
  assert.ok(Math.abs(value('Strain.volumetric') - 0.02) < 1e-15);
  assert.equal(value('Strain.reference'), 1);
  assert.equal(value('CNA.FCC.count'), 6); assert.equal(value('CNA.FCC.fraction'), 0.6);
  assert.equal(value('CNA.Other.fraction'), 0.1); assert.equal(value('CNA.ICO.count'), 0);
  assert.equal(value('PTM.Hex_diamond.count'), 3);
  assert.equal(value('DXA.structure.FCC.fraction'), 1);
  assert.equal(value('Type.Al.fraction'), 0.4);
  assert.ok(Math.abs(value('Mean.c_pe') - (-4.45)) < 1e-6);
  assert.equal(value('Mean.c_stress[1]'), 41 / 8, 'means use finite values only');
  assert.equal(registry.get('Mean.c_stress[1]').unit, 'bar');
  assert.equal(value('Mean.vonMises'), 4.5);
  assert.equal(value('DXA.total_length'), 42.5); assert.equal(value('DXA.line_density'), 0.0021); assert.equal(value('DXA.segment_count'), 3);
  assert.equal(value('DXA.shockley.length'), 30); assert.equal(value('DXA.perfect.count'), 1);
  assert.equal(value('Clusters.cluster_count'), 3); assert.equal(value('Clusters.largest_size'), 5);
  assert.equal(value('WignerSeitz.vacancy_count'), 2); assert.equal(value('WignerSeitz.interstitial_count'), 1);
  // Kinds tell background collection what a frame read from the file can provide.
  for (const name of ['Frame', 'Timestep', 'Cell.a', 'Strain.a', 'Mean.c_pe', 'Mean.charge', 'Type.Ni.count']) assert.equal(registry.get(name).kind, 'file', name);
  for (const name of ['CNA.FCC.fraction', 'Mean.vonMises', 'DXA.total_length', 'Clusters.cluster_count', 'WignerSeitz.vacancy_count']) assert.equal(registry.get(name).kind, 'analysis', name);
  assert.equal(registry.get('CNA.FCC.fraction').signature, 'cna:{"mode":"adaptive"}');
  assert.equal(registry.get('Mean.vonMises').signature, 'expression:id - 1');
  assert.equal(registry.get('Strain.a').signature, 'reference:0');
  // Case-insensitive lookup; Map lookups never reach object members.
  assert.equal(value('cna.fcc.FRACTION'), 0.6);
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'Mean.constructor', '', null, 7]) assert.equal(registry.get(name), null, String(name));
  assert.equal(registry.get('Missing'), null);
});

test('attribute values equal the Statistics summary CSV rows they name', () => {
  const frame = analyzedFrame();
  const registry = createAttributeRegistry({ frame, frameIndex: 3, frameCount: 12, dxaNetwork: network });
  const snapshot = { frame, fileName: 'sample.dump', frameIndex: 3, results: { clusters: frame.atomeyeResults.clusters.result,
    wignerSeitz: frame.atomeyeResults.wignerSeitz.result }, dxaNetwork: network };
  const table = buildStatisticsTable(snapshot, 'summary'), rows = [...table.rows];
  let compared = 0;
  for (const entry of registry.list()) {
    if (!entry.csv) continue;
    const [analysis, metric, label] = entry.csv;
    if (analysis === 'context') {
      const column = table.columns.indexOf(metric);
      assert.ok(column >= 0, entry.name);
      assert.equal(rows[0][column], registry.get(entry.name).value, entry.name);
      compared++; continue;
    }
    const row = rows.find(item => item[3] === analysis && item[4] === metric && item[5] === label);
    assert.ok(row, `${entry.name} has a summary row ${entry.csv.join(' / ')}`);
    assert.ok(Object.is(row[6], registry.get(entry.name).value), `${entry.name}: ${row[6]} vs ${registry.get(entry.name).value}`);
    compared++;
  }
  assert.ok(compared > 60, `${compared} attributes compared`);
});

test('background registries exclude analysis results and stale DXA networks', () => {
  const frame = analyzedFrame();
  const fileOnly = createAttributeRegistry({ frame, frameIndex: 0, fileOnly: true, dxaNetwork: network });
  assert.ok(fileOnly.has('Mean.c_pe') && fileOnly.has('Mean.charge') && fileOnly.has('Cell.volume'));
  assert.equal(fileOnly.list().some(entry => entry.kind === 'analysis'), false);
  // A network without the frame's DXA structure output belongs to another frame.
  frame.properties = frame.properties.filter(property => property.name !== 'dxaStructureType');
  assert.equal(createAttributeRegistry({ frame, dxaNetwork: network }).has('DXA.total_length'), false);
  // No timestep and no reference: those names are absent rather than NaN.
  const plain = createAttributeRegistry({ frame: { ...frame, timestep: null } });
  assert.equal(plain.has('Timestep'), false); assert.equal(plain.has('Strain.a'), false); assert.equal(plain.has('FrameCount'), false);
  assert.equal(createAttributeRegistry({}).list().length, 0);
});

test('attribute values are computed lazily and once per registry', () => {
  const frame = analyzedFrame();
  let reads = 0;
  const data = frame.properties[0].data;
  frame.properties[0].data = new Proxy(data, { get(target, key) { if (key === Symbol.iterator) reads++; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  const registry = createAttributeRegistry({ frame });
  assert.equal(reads, 0);
  registry.get('Mean.c_pe'); registry.get('Mean.c_pe');
  assert.equal(reads, 1);
});

test('the attribute source reads the strain reference in the background and notifies once per burst', async () => {
  const frames = [analyzedFrame(), analyzedFrame({ scale: 1.01 }), analyzedFrame({ scale: 1.02 })];
  let index = 2, version = 'a';
  const read = [], scheduled = [];
  const source = createGlobalAttributeSource({ getFrame: () => frames[index], getFrameIndex: () => index, getFrameCount: () => frames.length,
    getFrameAt: async frameIndex => { read.push(frameIndex); return frames[frameIndex]; }, getSourceVersion: () => version,
    schedule: callback => scheduled.push(callback) });
  const seen = [];
  source.subscribe(registry => seen.push(registry));
  assert.equal(source.current().has('Strain.a'), false, 'the reference is not known yet');
  assert.deepEqual(read, [], 'nothing is read until strain is requested');
  source.requestReference(); source.requestReference();
  await source.ensureReference();
  assert.deepEqual(read, [0], 'one background read');
  assert.ok(Math.abs(source.current().get('Strain.a').value - 0.02) < 1e-15);
  source.refresh(); source.refresh(); source.refresh();
  while (scheduled.length) scheduled.shift()();
  assert.equal(seen.length, 1, 'one notification per burst');
  source.refresh(); while (scheduled.length) scheduled.shift()();
  assert.equal(seen.length, 1, 'an unchanged registry is not announced again');
  // The displayed reference frame is used directly.
  assert.equal(source.setStrainReferenceFrame(2), true);
  assert.equal(source.current().get('Strain.a').value, 0);
  assert.deepEqual(read, [0]);
  index = 1; version = 'b';
  await source.ensureReference();
  assert.deepEqual(read, [0, 2], 'a new source reads its own reference');
  assert.deepEqual(source.serialize(), { strainReferenceFrame: 2 });
  assert.deepEqual(normalizeGlobalAttributeState({}), { strainReferenceFrame: 0 });
  for (const value of [{ strainReferenceFrame: -1 }, { strainReferenceFrame: 1.5 }, { other: 1 }, [], null, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => normalizeGlobalAttributeState(value), /globalAttributes/);
  }
});
