import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStatisticsTable, csvCell, csvChunks, scalarStatistics, serializeCsv } from '../src/statistics-export.js';
import { createCell } from '../src/data/model.js';

function snapshot() {
  return { fileName: 'sample,"quoted".dump', frameIndex: 3,
    frame: { ids: ['9007199254740993', 22, 33], types: Uint16Array.from([0, 0, 1]), typeLabels: ['Fe', 'Ni'], timestep: 1200,
      cell: createCell({ vectors: [3, 0, 0, 1, 4, 0, 0, 0, 5], pbc: [true, false, true] }),
      positions: Float64Array.from([1.123456789012345, 0, -2e-15, 3, 4, 5, 6, 7, 8]),
      properties: [
        { name: 'energy,"total"', unit: 'eV', data: Float64Array.from([-2, -4, NaN]) },
        { name: 'coordination', analysisKind: 'coordination', data: Uint32Array.from([8, 8, 6]), histogram: [{ coordination: 6, count: 1 }, { coordination: 8, count: 2 }] },
        { name: 'bondCoordination', analysisKind: 'bonds', data: Uint32Array.from([12, 12, 8]) },
        { name: 'structureType', analysisKind: 'cna', categories: [{ id: 0, label: 'Other' }, { id: 1, label: 'FCC' }, { id: 3, label: 'BCC' }], data: Uint8Array.from([3, 3, 0]) },
        { name: 'ptmStructureType', analysisKind: 'ptm', categories: [{ id: 0, label: 'Other' }, { id: 1, label: 'FCC' }], data: Float64Array.from([1, 1, NaN]) },
      ] },
    selectionGroups: { groups: [{ id: 'selection-0', name: 'Loop core', atomIds: ['9007199254740993', 22, 99] }] },
    results: {},
  };
}
const rows = (data, kind) => [...buildStatisticsTable(data, kind).rows];
const payload = row => row.slice(3);

test('CSV quoting, scientific precision, missing values and CRLF remain lossless', () => {
  assert.equal(csvCell('a,"b"\nnext'), '"a,""b""\nnext"');
  const table = { columns: ['name', 'value'], rows: [['comma,quote"', 1.123456789012345], ['line\r\nnext', -2e-15], ['NaN', NaN], ['empty', null], ['positive', Infinity]] };
  const csv = serializeCsv(table);
  assert.equal(csv, 'name,value\r\n"comma,quote""",1.123456789012345\r\n"line\r\nnext",-2e-15\r\nNaN,NaN\r\nempty,\r\npositive,Infinity\r\n');
  assert.equal([...csvChunks(table, { chunkSize: 20 })].join(''), csv);
  assert.throws(() => serializeCsv({ columns: ['a'], rows: [[1, 2]] }), /headings/);
});

test('scalar statistics use population variance, keep missing counts and resolve large offsets', () => {
  assert.deepEqual(scalarStatistics([NaN, Infinity, -Infinity]), { count: 0, nanCount: 1, infiniteCount: 2, min: NaN, max: NaN, mean: NaN, stddev: NaN });
  const data = scalarStatistics([1e12 + 1, 1e12 + 2, 1e12 + 3, NaN]);
  assert.equal(data.mean, 1e12 + 2); assert.equal(data.stddev, Math.sqrt(2 / 3));
  assert.equal(data.count, 3); assert.equal(data.nanCount, 1);
});

test('all scalar inputs and completed analyses export without display rounding', () => {
  const data = snapshot(), table = buildStatisticsTable(data, 'properties');
  const energy = [...table.rows].find(row => row[4] === 'energy,"total"');
  assert.deepEqual(payload(energy).slice(0, 9), ['input', 'energy,"total"', 'eV', 2, 1, 0, -4, -2, -3]);
  assert.equal(energy.at(-1), 1);
  assert.equal(table.filename, 'sample,_quoted_-frame-4-properties.csv');
  assert.equal(rows(data, 'properties').length, 3);
});

test('population CSV includes input types, every classifier, empty categories and missing classifications', () => {
  const populations = rows(snapshot(), 'categories').map(payload);
  assert.deepEqual(populations.find(row => row[1] === 'atomType' && row[3] === 'Ni'), ['input', 'atomType', 1, 'Ni', 1, 1 / 3]);
  assert.deepEqual(populations.find(row => row[1] === 'structureType' && row[3] === 'FCC'), ['cna', 'structureType', 1, 'FCC', 0, 0]);
  assert.equal(populations.filter(row => row[1] === 'ptmStructureType').length, 3);
  const missing = populations.find(row => row[1] === 'ptmStructureType' && Number.isNaN(row[2]));
  assert.equal(missing[3], 'NaN'); assert.equal(missing[4], 1);
});

test('coordination CSV retains both unique-ID and periodic-image bond populations', () => {
  const populations = rows(snapshot(), 'coordination').map(payload);
  assert.deepEqual(populations, [['coordination', 'coordination', 6, 1, 1 / 3], ['coordination', 'coordination', 8, 2, 2 / 3],
    ['bonds', 'bondCoordination', 8, 1, 1 / 3], ['bonds', 'bondCoordination', 12, 2, 2 / 3]]);
});

test('per-atom CSV uses physical atom IDs and source coordinates, including NaN', () => {
  const data = snapshot(), table = buildStatisticsTable(data, 'atoms');
  const atomRows = [...table.rows];
  assert.equal(atomRows.length, 3); assert.equal(atomRows[0][3], '9007199254740993');
  assert.equal(atomRows[0][6], 1.123456789012345);
  assert.ok(table.columns.includes('energy,"total" [eV]'));
  assert.ok(serializeCsv(buildStatisticsTable(data, 'atoms')).includes('1.123456789012345,0,-2e-15,-2'));
  assert.ok(Number.isNaN(atomRows[2][9]));
});

test('RDF CSV retains directed counts, bin edges and normalization values', () => {
  const data = snapshot();
  data.results.rdf = { result: { radii: new Float64Array([.5, 1.5]), values: new Float64Array([.1, 1.1]), counts: new Float64Array([2, 6]),
    normalization: { cutoff: 2, bins: 2, method: 'periodic-finite-population', volume: 60, pairPopulation: 6 } } };
  assert.deepEqual(rows(data, 'rdf').map(payload), [[0, 1, .5, .1, 2], [1, 2, 1.5, 1.1, 6]]);
  const summary = rows(data, 'summary').map(payload);
  assert.ok(summary.some(row => row[0] === 'rdf' && row[1] === 'total_directed_pair_count' && row[3] === 8));
  assert.ok(summary.some(row => row[0] === 'rdf' && row[1] === 'cutoff' && row[4] === 'Å'));
});

test('DXA exports all families and line vectors, independent of line visibility', () => {
  const data = snapshot();
  data.dxaNetwork = { volume: 60, density: .2, totalLength: 12, counts: { perfect: 1, partial: 0 }, familyLengths: { perfect: 12, partial: 0 },
    segments: [{ id: 3, familyId: 'perfect', length: 12, burgersVector: [.5, .5, .5], spatialBurgersVector: [1, 2, 3], structureType: 3, clusterId: 2, isClosedLoop: true }] };
  const families = rows(data, 'dxa-summary').map(payload);
  assert.ok(families.some(row => row[0] === 'total_length' && row[1] === 'partial' && row[2] === 0));
  assert.deepEqual(families.find(row => row[0] === 'line_density' && row[1] === 'perfect'), ['line_density', 'perfect', .2, 'Å⁻²']);
  assert.deepEqual(rows(data, 'dxa-lines')[0].slice(3), [3, 'perfect', 12, .5, .5, .5, 1, 2, 3, 3, 2, true]);
});

function addBondStatistics(data) {
  const distribution = (unit, edges, centers, counts, probability, density) => ({ unit, edges, centers, counts, probability, density });
  data.results.bondStatistics = { q4: new Float32Array([.25, .5, NaN]), q6: new Float32Array([.5, .75, NaN]), coordination: new Uint32Array([4, 4, 0]),
    lengthDistribution: distribution('Å', [0, 1, 2], [.5, 1.5], [0, 4], [0, 1], [0, 1]),
    angleDistribution: distribution('°', [0, 90, 180], [45, 135], [3, 1], [.75, .25], [1 / 120, 1 / 360]),
    statistics: { length: { count: 4, min: 1, max: 2, mean: 1.5, stddev: .5 }, q4: { count: 2, min: .25, max: .5, mean: .375, stddev: .125 } },
    normalization: { cutoff: 2, angleCounting: 'unordered-neighbor-pairs' } };
}

test('bond distributions retain zero bins, counts, probabilities, density and units', () => {
  const data = snapshot(); addBondStatistics(data);
  assert.deepEqual(rows(data, 'bond-length').map(payload), [[0, 1, .5, 0, 0, 0], [1, 2, 1.5, 4, 1, 1]]);
  const angles = buildStatisticsTable(data, 'bond-angle');
  assert.equal(angles.columns.at(-1), 'probability_density [°⁻¹]');
  assert.equal([...angles.rows][0].at(-1), 1 / 120);
  assert.equal(rows(data, 'bond-order')[0][6], 2);
  assert.equal(rows(data, 'bond-order')[0][7], 1);
  assert.ok(Number.isNaN(rows(data, 'bond-order-atoms')[2].at(-1)));
});

function addVoronoi(data) {
  data.results.voronoi = { atomicVolume: Float64Array.from([10, 20, 30]), voronoiSurfaceArea: Float64Array.from([20, 30, 40]),
    voronoiCoordination: Uint32Array.from([6, 12, 14]), voronoiBoundaryFaces: Uint8Array.from([1, 0, 0]),
    voronoiMaxFaceOrder: Uint32Array.from([4, 6, 8]), voronoiIndices: ['<0,6,0,0>', '<0,0,12,0>', '<0,6,0,8>'],
    faceOffsets: Uint32Array.from([0, 2, 2, 3]), faceAreas: Float64Array.from([3, 4, 5]), faceOrders: Uint32Array.from([4, 4, 6]),
    faceNeighbors: Int32Array.from([-1, 1, 0]), faceBoundary: Uint8Array.from([1, 0, 0]), faceAccepted: Uint8Array.from([0, 1, 1]),
    statistics: { summary: { atomCount: 3, totalVolume: 60, cellVolume: 60, volumeError: 0, meanVolume: 20 },
      coordinationHistogram: [{ value: 6, count: 1, fraction: 1 / 3 }], volumeHistogram: [{ lower: 0, upper: 30, count: 3, fraction: 1 }],
      faceAreaHistogram: [{ lower: 0, upper: 6, count: 3, fraction: 1 }], indexCounts: [{ index: '<0,6,0,0>', count: 1, fraction: 1 / 3 }] } };
}

test('Voronoi exports complete indices, physical units, distributions and face CSR', () => {
  const data = snapshot(); addVoronoi(data);
  const atoms = buildStatisticsTable(data, 'voronoi-atoms');
  assert.equal([...atoms.rows].length, 3);
  assert.ok(serializeCsv(buildStatisticsTable(data, 'voronoi-atoms')).includes('"<0,6,0,0>"'));
  const distributions = rows(data, 'voronoi-distributions').map(payload);
  assert.deepEqual(distributions[1], ['atomic_volume', 0, 30, '', 3, 1, 'Å³']);
  assert.deepEqual(distributions[3], ['voronoi_index', '', '', '<0,6,0,0>', 1, 1 / 3, '']);
  const faces = rows(data, 'voronoi-faces').map(payload);
  assert.deepEqual(faces[0], ['9007199254740993', 1, 3, 4, '', 1, 0]);
  assert.deepEqual(faces[1], ['9007199254740993', 2, 4, 4, 22, 0, 1]);
  assert.deepEqual(faces[2], [33, 1, 5, 6, '9007199254740993', 0, 1]);
  // The worker-pool finalizer flattens statistics onto its final result; this
  // form must export the same populations as the nested standalone fixture.
  data.results.voronoi = { ...data.results.voronoi, ...data.results.voronoi.statistics };
  delete data.results.voronoi.statistics;
  assert.deepEqual(rows(data, 'voronoi-distributions').map(payload), distributions);
  assert.ok(rows(data, 'summary').some(row => row[3] === 'voronoi' && row[4] === 'meanVolume' && row[6] === 20));
});

test('type-filtered Voronoi CSV keeps selected source IDs and original neighbor IDs with compact statistics', () => {
  const data = snapshot();
  data.frame.types = Uint16Array.from([0, 1, 0]);
  const voronoi = data.results.voronoi = {
    selectedTypes: ['Fe'], analyzedAtomIndices: Uint32Array.of(0, 2),
    atomicVolume: Float64Array.of(25, NaN, 35), voronoiSurfaceArea: Float64Array.of(20, NaN, 30),
    voronoiCoordination: Float64Array.of(6, NaN, 8), voronoiBoundaryFaces: Float64Array.of(1, NaN, 0),
    voronoiMaxFaceOrder: Float64Array.of(4, NaN, 6), voronoiIndices: ['<0,6,0,0>', '', '<0,6,0,2>'],
    faceOffsets: Uint32Array.of(0, 2, 2, 4), faceAreas: Float64Array.of(2, 3, 4, 5),
    faceOrders: Uint32Array.of(4, 4, 6, 6), faceNeighbors: Int32Array.of(-1, 2, 0, 2),
    faceBoundary: Uint8Array.of(1, 0, 0, 0), faceAccepted: Uint8Array.of(0, 1, 1, 1),
    summary: { atomCount: 2, totalVolume: 60, cellVolume: 60, volumeError: 0, meanVolume: 30 },
    coordinationHistogram: [{ value: 6, count: 1, fraction: .5 }, { value: 8, count: 1, fraction: .5 }],
    volumeHistogram: [{ lower: 25, upper: 35, count: 2, fraction: 1 }],
    faceAreaHistogram: [{ lower: 3, upper: 5, count: 3, fraction: 1 }],
    indexCounts: [{ index: '<0,6,0,0>', count: 1, fraction: .5 }, { index: '<0,6,0,2>', count: 1, fraction: .5 }],
  };
  data.frame.properties.push({ name: 'voronoiCoordination', analysisKind: 'voronoi', data: voronoi.voronoiCoordination });
  const cells = rows(data, 'voronoi-atoms').map(payload);
  assert.deepEqual(cells, [['9007199254740993', 'Fe', 25, 20, 6, 1, 4, '<0,6,0,0>'], [33, 'Fe', 35, 30, 8, 0, 6, '<0,6,0,2>']]);
  const faces = rows(data, 'voronoi-faces').map(payload);
  assert.deepEqual(faces.map(row => row[0]), ['9007199254740993', '9007199254740993', 33, 33]);
  assert.deepEqual(faces.map(row => row[4]), ['', 33, '9007199254740993', 33]);
  const coordination = rows(data, 'coordination').map(payload).filter(row => row[0] === 'voronoi');
  assert.deepEqual(coordination, [['voronoi', 'voronoiCoordination', 6, 1, .5], ['voronoi', 'voronoiCoordination', 8, 1, .5]]);
  const summary = rows(data, 'summary').map(payload);
  assert.ok(summary.some(row => row[0] === 'input' && row[1] === 'atom_count' && row[3] === 3));
  assert.ok(summary.some(row => row[0] === 'voronoi' && row[1] === 'atomCount' && row[3] === 2));
  assert.ok(summary.some(row => row[0] === 'voronoi' && row[1] === 'selected_types' && row[3] === 'Fe'));
  assert.equal(rows(data, 'voronoi-distributions').map(payload).filter(row => row[0] === 'voronoi_index').reduce((sum, row) => sum + row[4], 0), 2);
  assert.deepEqual(Array.from(voronoi.analyzedAtomIndices), [0, 2]);
  assert.ok(Number.isNaN(voronoi.atomicVolume[1]));
});

test('explicit all-site Voronoi index mapping preserves legacy CSV exactly and invalid maps fail', () => {
  const data = snapshot(); addVoronoi(data);
  const original = ['voronoi-atoms', 'voronoi-faces', 'voronoi-distributions', 'summary'].map(kind => serializeCsv(buildStatisticsTable(data, kind)));
  data.results.voronoi.analyzedAtomIndices = Uint32Array.of(0, 1, 2);
  data.results.voronoi.selectedTypes = null;
  const mapped = ['voronoi-atoms', 'voronoi-faces', 'voronoi-distributions', 'summary'].map(kind => serializeCsv(buildStatisticsTable(data, kind)));
  assert.deepEqual(mapped, original);
  data.results.voronoi.analyzedAtomIndices = Uint32Array.of(3);
  assert.throws(() => serializeCsv(buildStatisticsTable(data, 'voronoi-atoms')), /source atom population/);
  assert.throws(() => serializeCsv(buildStatisticsTable(data, 'voronoi-faces')), /source atom population/);
});

test('overall summary includes selections, all classifiers, scalar uncertainties and topology', () => {
  const data = snapshot(); addBondStatistics(data); addVoronoi(data);
  data.frame.properties.push({ name: 'centralSymmetry', unit: '', data: Float32Array.from([0, .2, NaN]), analysisKind: 'centrosymmetry', cspSummary: { bcc: 2, inferred: 1, unresolved: 1 } });
  const summary = rows(data, 'summary').map(payload);
  assert.ok(summary.some(row => row[0] === 'input' && row[1] === 'cell_volume' && row[3] === 60));
  assert.ok(summary.some(row => row[0] === 'selections' && row[1] === 'matched_atom_count' && row[3] === 2));
  assert.ok(summary.some(row => row[0] === 'selections' && row[1] === 'absent_atom_count' && row[3] === 1));
  assert.ok(summary.some(row => row[0] === 'input' && row[1] === 'energy,"total".nan_count' && row[3] === 1));
  assert.ok(summary.some(row => row[0] === 'centrosymmetry' && row[1] === 'auto_structure_population' && row[2] === 'inferred' && row[3] === 1));
  assert.ok(summary.some(row => row[0] === 'bondStatistics' && row[1] === 'length.mean' && row[3] === 1.5 && row[4] === 'Å'));
  assert.ok(summary.some(row => row[0] === 'voronoi' && row[1] === 'voronoi_index.population' && row[2] === '<0,6,0,0>'));
});

test('exporting unavailable results fails explicitly rather than creating empty plausible data', () => {
  const data = snapshot();
  assert.throws(() => buildStatisticsTable(data, 'rdf'), /Calculate RDF/);
  assert.throws(() => buildStatisticsTable(data, 'bond-length'), /Calculate bond statistics/);
  assert.throws(() => buildStatisticsTable(data, 'voronoi-atoms'), /Calculate Voronoi/);
  assert.throws(() => buildStatisticsTable(data, 'unknown'), /Unknown statistics/);
  assert.throws(() => buildStatisticsTable({ frame: { ids: [] } }), /Open a structure/);
});
