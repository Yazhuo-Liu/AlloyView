import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { createCell, fractionalToCartesian } from '../src/data/model.js';
import { minimumImageDisplacement } from '../src/analysis/displacement.js';
import { ATOM_ANTISITE, ATOM_INTERSTITIAL, ATOM_REGULAR, SITE_ANTISITE, SITE_INTERSTITIAL, SITE_REGULAR, SITE_VACANCY,
  WignerSeitzSites, assignWignerSeitzSites, calculateWignerSeitz, siteTypeOccupancy, summarizeWignerSeitz,
  typeOccupancyMatrix, wignerSeitzQueryMapping, wignerSeitzSitePositions } from '../src/analysis/wigner-seitz.js';
import { crystalFrame } from './helpers/crystals.js';

const RESULT_ARRAYS = ['siteIndex', 'siteDistance', 'siteOccupancy', 'siteClass', 'siteAtomOffsets', 'siteAtoms', 'defectSites',
  'atomOccupancy', 'atomClass', 'atomSiteType'];
const COUNTS = ['atomCount', 'siteCount', 'vacancyCount', 'interstitialCount', 'antisiteCount', 'multiplyOccupiedSites', 'sharedSiteAtoms', 'regularSiteCount'];

function assertIdentical(actual, expected, label = '') {
  for (const name of RESULT_ARRAYS) {
    assert.equal(actual[name].constructor, expected[name].constructor, `${label}${name} type`);
    assert.equal(actual[name].length, expected[name].length, `${label}${name} length`);
    for (let index = 0; index < expected[name].length; index += 1) {
      assert.ok(Object.is(actual[name][index], expected[name][index]), `${label}${name}[${index}]: ${actual[name][index]} vs ${expected[name][index]}`);
    }
  }
  for (const name of COUNTS) assert.equal(actual[name], expected[name], `${label}${name}`);
  assert.deepEqual(actual.typeSummary, expected.typeSummary, `${label}typeSummary`);
}

/** Deterministic pseudo-random sequence for thermal noise. */
function random(seed = 1) {
  let state = seed;
  return () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
}

/** A copy of `frame` with selected rows removed, extra Cartesian atoms added
 * and optional per-atom types; positions follow from reduced coordinates. */
function edited(frame, { remove = [], add = [], types = null, noise = 0, seed = 3 } = {}) {
  const rand = random(seed), removed = new Set(remove), rows = [];
  for (let atom = 0; atom < frame.ids.length; atom += 1) if (!removed.has(atom)) rows.push(atom);
  const count = rows.length + add.length, fractional = new Float64Array(count * 3), atomTypes = new Uint16Array(count);
  const inverse = cartesianInverse(frame.cell);
  rows.forEach((atom, index) => {
    for (let axis = 0; axis < 3; axis += 1) fractional[index * 3 + axis] = frame.fractional[atom * 3 + axis];
    atomTypes[index] = types?.[atom] ?? frame.types[atom];
  });
  add.forEach(({ position, type = 0 }, offset) => {
    const index = rows.length + offset;
    fractional.set(inverse(position), index * 3);
    atomTypes[index] = type;
  });
  if (noise) {
    for (let index = 0; index < fractional.length; index += 1) {
      const axis = index % 3, length = Math.hypot(frame.cell.vectors[axis * 3], frame.cell.vectors[axis * 3 + 1], frame.cell.vectors[axis * 3 + 2]);
      fractional[index] += (rand() - .5) * 2 * noise / length;
    }
  }
  return { ...frame, ids: Uint32Array.from({ length: count }, (_, atom) => atom + 1), fractional, types: atomTypes,
    positions: fractionalToCartesian(fractional, frame.cell, new Float64Array(count * 3)), properties: [] };
}

function cartesianInverse(cell) {
  const [a0, a1, a2, b0, b1, b2, c0, c1, c2] = cell.vectors;
  const det = a0 * (b1 * c2 - b2 * c1) - a1 * (b0 * c2 - b2 * c0) + a2 * (b0 * c1 - b1 * c0);
  return ([px, py, pz]) => {
    const x = px - cell.origin[0], y = py - cell.origin[1], z = pz - cell.origin[2];
    return [(x * (b1 * c2 - b2 * c1) - y * (b0 * c2 - b2 * c0) + z * (b0 * c1 - b1 * c0)) / det,
      -(x * (a1 * c2 - a2 * c1) - y * (a0 * c2 - a2 * c0) + z * (a0 * c1 - a1 * c0)) / det,
      (x * (a1 * b2 - a2 * b1) - y * (a0 * b2 - a2 * b0) + z * (a0 * b1 - a1 * b0)) / det];
  };
}

/** B2 (CsCl) ordering: Fe on cube corners, Ni at cube centers. */
function b2Frame(repeat = 3, lattice = 2.87) {
  const frame = crystalFrame('bcc', repeat, lattice);
  return { ...frame, types: Uint16Array.from({ length: frame.ids.length }, (_, atom) => atom % 2), typeLabels: ['Fe', 'Ni'] };
}

// Float64 Cartesian site position (the fixture's positions array is Float32).
const sitePosition = (frame, site) => Array.from(fractionalToCartesian(frame.fractional.subarray(site * 3, site * 3 + 3), frame.cell, new Float64Array(3)));

test('a perfect crystal compared with itself or with small thermal noise has no defects', () => {
  for (const kind of ['fcc', 'bcc', 'hcp']) {
    const reference = crystalFrame(kind, 4, kind === 'bcc' ? 2.87 : 3.6);
    const self = calculateWignerSeitz(reference, reference);
    assert.deepEqual([self.vacancyCount, self.interstitialCount, self.antisiteCount], [0, 0, 0], kind);
    assert.ok(self.siteIndex.every((site, atom) => site === atom), `${kind} atoms keep their own sites`);
    assert.ok(self.siteDistance.every(distance => distance === 0), `${kind} identical cells use the identity mapping`);
    assert.ok(self.atomOccupancy.every(value => value === 1) && self.atomClass.every(value => value === ATOM_REGULAR));
    const noisy = calculateWignerSeitz(edited(reference, { noise: .3 }), reference);
    assert.deepEqual([noisy.vacancyCount, noisy.interstitialCount, noisy.antisiteCount, noisy.defectSites.length], [0, 0, 0, 0], `${kind} with noise`);
    assert.ok(noisy.siteIndex.every((site, atom) => site === atom));
  }
});

test('a removed atom leaves one vacancy at its site; other atoms keep their sites', () => {
  const reference = b2Frame(3), current = edited(reference, { remove: [17], noise: .1 });
  const result = calculateWignerSeitz(current, reference);
  assert.equal(result.atomCount, reference.ids.length - 1);
  assert.deepEqual([result.vacancyCount, result.interstitialCount, result.antisiteCount], [1, 0, 0]);
  assert.deepEqual(Array.from(result.defectSites), [17]);
  assert.equal(result.siteClass[17], SITE_VACANCY);
  assert.equal(result.siteOccupancy[17], 0);
  assert.equal(result.siteAtomOffsets[18] - result.siteAtomOffsets[17], 0);
  assert.ok(result.atomClass.every(value => value === ATOM_REGULAR));
  const ni = result.typeSummary.find(row => row.label === 'Ni');
  assert.deepEqual({ ...ni }, { label: 'Ni', sites: 27, atoms: 26, vacancies: 1, antisites: 0, antisiteAtoms: 0, sharedSiteAtoms: 0 });
  // Site positions in the current frame equal the reference positions here.
  assert.deepEqual(Array.from(wignerSeitzSitePositions(reference.fractional, reference.cell, current.cell, [17])), sitePosition(reference, 17));
});

test('an added atom near a site makes one interstitial; both atoms on that site are marked', () => {
  const reference = b2Frame(3), [x, y, z] = sitePosition(reference, 8);
  const current = edited(reference, { add: [{ position: [x + .7, y + .4, z], type: 0 }] });
  const result = calculateWignerSeitz(current, reference);
  assert.deepEqual([result.vacancyCount, result.interstitialCount, result.antisiteCount, result.multiplyOccupiedSites], [0, 1, 0, 1]);
  assert.equal(result.siteOccupancy[8], 2);
  assert.equal(result.siteClass[8], SITE_INTERSTITIAL);
  const added = current.ids.length - 1;
  assert.equal(result.siteIndex[added], 8);
  assert.ok(Math.abs(result.siteDistance[added] - Math.hypot(.7, .4)) < 1e-12);
  assert.deepEqual(Array.from(result.siteAtoms.subarray(result.siteAtomOffsets[8], result.siteAtomOffsets[9])), [8, added]);
  for (const atom of [8, added]) assert.equal(result.atomClass[atom], ATOM_INTERSTITIAL);
  assert.equal(result.atomOccupancy[added], 2);
  assert.equal(result.sharedSiteAtoms, 2);
  assert.equal(result.atomCount - result.siteCount, result.interstitialCount - result.vacancyCount);
});

test('swapped types are two antisites; per-type occupancy counts the current elements', () => {
  const reference = b2Frame(3), types = Array.from(reference.types);
  [types[4], types[5]] = [types[5], types[4]];
  const result = calculateWignerSeitz(edited(reference, { types }), reference);
  assert.deepEqual([result.vacancyCount, result.interstitialCount, result.antisiteCount], [0, 0, 2]);
  assert.deepEqual(Array.from(result.defectSites), [4, 5]);
  assert.equal(result.siteClass[4], SITE_ANTISITE);
  assert.equal(result.atomClass[4], ATOM_ANTISITE);
  assert.equal(result.atomSiteType[4], 0);
  const fe = result.typeSummary.find(row => row.label === 'Fe'), ni = result.typeSummary.find(row => row.label === 'Ni');
  assert.equal(fe.antisites, 1); assert.equal(ni.antisites, 1); assert.equal(fe.antisiteAtoms, 1); assert.equal(ni.antisiteAtoms, 1);
  assert.deepEqual(Array.from(siteTypeOccupancy(result, 4, edited(reference, { types }).types, 2)), [0, 1]);
  const matrix = typeOccupancyMatrix(result, edited(reference, { types }).types, 2);
  assert.deepEqual(Array.from(matrix.subarray(8, 12)), [0, 1, 1, 0]);
  assert.equal(matrix.reduce((sum, value) => sum + value, 0), result.atomCount);
});

test('types are compared by label when the frames number their types differently', () => {
  const reference = b2Frame(2);
  const relabeled = { ...reference, types: Uint16Array.from(reference.types, type => 1 - type), typeLabels: ['Ni', 'Fe'] };
  const same = calculateWignerSeitz(relabeled, reference);
  assert.equal(same.antisiteCount, 0);
  const foreign = { ...reference, typeLabels: ['Fe', 'Cu'] };
  const result = calculateWignerSeitz(foreign, reference);
  assert.equal(result.antisiteCount, reference.ids.length / 2, 'an element absent from the reference never matches a site');
  assert.deepEqual(result.typeLabels, ['Fe', 'Ni', 'Cu']);
  assert.equal(result.typeSummary[2].antisiteAtoms, reference.ids.length / 2);
});

test('atoms across periodic boundaries reach the nearest periodic image of a site', () => {
  const reference = crystalFrame('sc', 4, 3), current = edited(reference, {});
  // Site 0 is at the origin; move its atom just across the lower x, y and z faces.
  current.fractional.set([.99, .995, .999], 0);
  const result = calculateWignerSeitz(current, reference);
  assert.equal(result.siteIndex[0], 0);
  assert.ok(Math.abs(result.siteDistance[0] - Math.hypot(.12, .06, .012)) < 1e-12);
  assert.equal(result.vacancyCount, 0);
  // With open axes, the same atom stays at the far face and joins a different site.
  const open = { ...reference, cell: createCell({ vectors: reference.cell.vectors, pbc: [false, false, false] }) };
  const openResult = calculateWignerSeitz({ ...current, cell: open.cell }, open);
  assert.notEqual(openResult.siteIndex[0], 0);
  assert.equal(openResult.vacancyCount, 1);
});

test('triclinic and mixed periodic cells agree with an exhaustive minimum-image search', () => {
  const rand = random(11);
  for (const [vectors, pbc] of [
    [[10, 0, 0, 6, 8, 0, 3, 4, 9], [true, true, true]],
    [[9, 0, 0, -7, 6, 0, 2, -3, 7], [true, true, true]],
    [[11, 0, 0, 5, 9, 0, 4, 5, 10], [true, true, false]],
    [[8, 1, 0, 2, 9, 1, -3, 2, 10], [false, true, true]],
  ]) {
    const cell = createCell({ vectors, pbc, origin: [1, -2, .5] });
    const sites = Float64Array.from({ length: 90 }, () => rand() * 1.1 - .05);
    const reference = { fractional: sites, cell, types: new Uint16Array(30), typeLabels: ['X'], ids: Uint32Array.from({ length: 30 }, (_, i) => i + 1) };
    const atoms = Float64Array.from({ length: 300 }, (_, index) => pbc[index % 3] ? rand() : rand() * 1.6 - .3);
    const frame = { fractional: atoms, cell, types: new Uint16Array(100), typeLabels: ['X'], ids: Uint32Array.from({ length: 100 }, (_, i) => i + 1) };
    const result = calculateWignerSeitz(frame, reference);
    const sitePositions = fractionalToCartesian(sites, cell, new Float64Array(90)), atomPositions = fractionalToCartesian(atoms, cell, new Float64Array(300));
    for (let atom = 0; atom < 100; atom += 1) {
      let best = Infinity;
      for (let site = 0; site < 30; site += 1) {
        const change = [0, 1, 2].map(axis => atomPositions[atom * 3 + axis] - sitePositions[site * 3 + axis]);
        best = Math.min(best, Math.hypot(...minimumImageDisplacement(change, cell)));
      }
      assert.ok(Math.abs(result.siteDistance[atom] - best) < 1e-9, `${pbc} atom ${atom}: ${result.siteDistance[atom]} vs ${best}`);
    }
  }
});

test('affine mapping removes spurious defects of a homogeneously strained cell', () => {
  const reference = crystalFrame('fcc', 4, 3.6);
  const strained = { ...reference, cell: createCell({ vectors: [14.4 * 1.2, 0, 0, 1.5, 14.4 * .95, 0, 0, 0, 14.4 * 1.1], origin: [.4, 0, 0] }) };
  const plain = calculateWignerSeitz(strained, reference);
  assert.ok(plain.vacancyCount > 0 && plain.vacancyCount === plain.interstitialCount, 'without mapping, strain moves atoms onto other sites');
  const mapped = calculateWignerSeitz(strained, reference, { affineMapping: true });
  assert.deepEqual([mapped.vacancyCount, mapped.interstitialCount, mapped.antisiteCount], [0, 0, 0]);
  assert.ok(mapped.siteIndex.every((site, atom) => site === atom));
  assert.ok(mapped.siteDistance.every(distance => distance === 0), 'mapped reduced coordinates coincide with the sites');
  // Mapped site positions follow the current cell; unmapped ones stay at reference positions.
  const mappedPosition = wignerSeitzSitePositions(reference.fractional, reference.cell, strained.cell, [5], { affineMapping: true });
  assert.deepEqual(Array.from(mappedPosition), Array.from(fractionalToCartesian(reference.fractional.subarray(15, 18), strained.cell, new Float64Array(3))));
  const mapping = wignerSeitzQueryMapping(strained.cell, reference.cell, false);
  assert.equal(mapping.identity, false);
  assert.ok(Math.abs(mapping.matrix[0] - 1.2) < 1e-12 && Math.abs(mapping.offset[0] - .4 / 14.4) < 1e-12);
});

test('equal distances choose the lower site index, independent of search order', () => {
  const reference = crystalFrame('sc', 4, 4);
  const sites = new WignerSeitzSites(reference.fractional, reference.cell);
  // Midway between sites 0 (0,0,0) and 16 (1/4,0,0): both at exactly 2 Å.
  assert.equal(sites.nearest(.125, 0, 0), 0); assert.equal(sites.bestD2, 4);
  // Equidistant from the eight corners of a cube: the lowest of them wins.
  assert.equal(sites.nearest(.125, .125, .125), 0); assert.equal(sites.bestD2, 12);
  // Across the periodic boundary, sites 48 (3/4,0,0) and 0 (via its +a image) tie.
  assert.equal(sites.nearest(.875, 0, 0), 0);
  const result = calculateWignerSeitz({ ...reference, fractional: Float64Array.of(.125, 0, 0, .875, 0, 0), types: new Uint16Array(2), ids: Uint32Array.of(1, 2) }, reference);
  assert.deepEqual(Array.from(result.siteIndex), [0, 0]);
  assert.equal(result.siteOccupancy[0], 2);
  // Duplicate reference sites: the lower index always wins the exact tie.
  const duplicate = Float64Array.of(.5, .5, .5, .1, .1, .1, .5, .5, .5);
  const index = new WignerSeitzSites(duplicate, reference.cell);
  assert.equal(index.nearest(.5, .5, .5), 0);
  assert.equal(index.nearest(.52, .5, .5), 0);
});

test('atoms far outside an open boundary go to the closest surface site', () => {
  const reference = crystalFrame('sc', 4, 3);
  const cell = createCell({ vectors: [12, 0, 0, 2, 12, 0, 3, 1, 12], pbc: [true, true, false] });
  const slab = { ...reference, cell };
  const sites = new WignerSeitzSites(slab.fractional, cell);
  const site = sites.nearest(.3, .6, 40);
  const top = [];
  for (let index = 0; index < 64; index += 1) if (slab.fractional[index * 3 + 2] === .75) top.push(index);
  assert.ok(top.includes(site));
  assert.ok(sites.visits < 200, `the open-axis bound keeps the search local (${sites.visits} cells)`);
});

test('different atom counts, range assignment and input validation', () => {
  const reference = crystalFrame('bcc', 3, 2.87);
  const current = edited(reference, { remove: [0, 1, 2], add: [{ position: [1, 1, 1] }], noise: .05 });
  const full = assignWignerSeitzSites(current, { referenceFractional: reference.fractional, referenceCell: reference.cell });
  const first = assignWignerSeitzSites(current, { referenceFractional: reference.fractional, referenceCell: reference.cell, startAtom: 0, endAtom: 20 });
  const rest = assignWignerSeitzSites(current, { referenceFractional: reference.fractional, referenceCell: reference.cell, startAtom: 20, endAtom: current.ids.length });
  assert.deepEqual([...first.siteIndex, ...rest.siteIndex], Array.from(full.siteIndex));
  assert.deepEqual([...first.siteDistance, ...rest.siteDistance], Array.from(full.siteDistance));
  assert.equal(full.siteCount, reference.ids.length);
  assert.throws(() => calculateWignerSeitz({ ...current, cell: createCell({ vectors: reference.cell.vectors, pbc: [true, true, false] }) }, reference),
    /same periodic boundary axes/);
  assert.throws(() => calculateWignerSeitz(current, { ...reference, fractional: new Float64Array(0) }), /at least one reference site/);
  const broken = edited(reference, {}); broken.fractional[4] = NaN;
  assert.throws(() => calculateWignerSeitz(broken, reference), /Atom 2 has a non-finite coordinate/);
  assert.throws(() => summarizeWignerSeitz({ siteIndex: Int32Array.of(5), siteCount: 2, currentTypes: new Uint16Array(1), currentTypeLabels: ['X'],
    referenceTypes: new Uint16Array(2), referenceTypeLabels: ['X'] }), /outside the reference sites/);
  assert.throws(() => calculateWignerSeitz(current, reference, { affineMapping: 'yes' }), /must be a boolean/);
});

function workerFactory() {
  return () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfer) { worker.postMessage(data, transfer); }, terminate() { worker.terminate(); } };
  };
}

function poolInputs() {
  const reference = b2Frame(10);
  const types = Array.from(reference.types);
  [types[100], types[101]] = [types[101], types[100]];
  const [x, y, z] = sitePosition(reference, 300);
  const current = edited(reference, { remove: [7, 900], add: [{ position: [x + .6, y, z + .5], type: 1 }, { position: [3.1, 4.2, 5.3] }], types, noise: .2 });
  current.fractional = Float32Array.from(current.fractional);
  return { reference, current };
}

test('Worker pool assignments and summaries equal the direct calculation, privately and with shared memory', async () => {
  const { reference, current } = poolInputs();
  for (const affineMapping of [false, true]) {
    const direct = calculateWignerSeitz(current, reference, { affineMapping });
    for (const sharedMemory of [false, true]) {
      const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: sharedMemory }, workerFactory: workerFactory() });
      pool.setGpuEnabled(true);
      const progress = [];
      try {
        const result = await pool.analyze(current, { kind: 'wignerSeitz', referenceFractional: reference.fractional, referenceCell: reference.cell,
          referenceTypes: reference.types, referenceTypeLabels: reference.typeLabels, affineMapping }, { onProgress: update => progress.push(update) });
        assertIdentical(result, direct, `${sharedMemory ? 'shared' : 'private'} ${affineMapping ? 'mapped' : 'plain'}: `);
        assert.equal(result.backend, 'cpu'); assert.equal(result.gpuRequested, true);
        assert.equal(result.sharedMemory, sharedMemory);
        assert.ok(result.workerCount >= 1 && result.chunkCount >= result.workerCount);
        assert.equal(progress.at(-1).completedAtoms, current.ids.length);
        assert.deepEqual([result.vacancyCount, result.antisiteCount], [direct.vacancyCount, 2]);
        assert.equal(pool.active.size, 0);
      } finally { pool.close(); }
    }
  }
});

test('cancelling a Wigner–Seitz calculation rejects promptly and keeps the pool usable', async () => {
  const { reference, current } = poolInputs();
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 2 } }, workerFactory: workerFactory() });
  const controller = new AbortController();
  try {
    const parameters = { kind: 'wignerSeitz', referenceFractional: reference.fractional, referenceCell: reference.cell,
      referenceTypes: reference.types, referenceTypeLabels: reference.typeLabels, affineMapping: false };
    const first = pool.analyze(current, parameters, { signal: controller.signal, onProgress(update) { if (update.completedAtoms > 0) controller.abort(); } });
    const cancellation = assert.rejects(first, { name: 'AbortError' });
    const small = crystalFrame('fcc', 2);
    const next = pool.analyze(small, { ...parameters, referenceFractional: small.fractional, referenceCell: small.cell, referenceTypes: small.types, referenceTypeLabels: small.typeLabels });
    await cancellation;
    const result = await next;
    assert.equal(result.vacancyCount, 0);
    assert.ok(result.siteIndex.every((site, atom) => site === atom));
    await assert.rejects(pool.analyze(current, { ...parameters, referenceCell: createCell({ vectors: reference.cell.vectors, pbc: [true, false, true] }) }),
      /same periodic boundary axes/);
    assert.equal(pool.active.size, 0);
  } finally { pool.close(); }
});
