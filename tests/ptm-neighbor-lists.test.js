import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { calculateAtomicStrain } from '../src/analysis/atomic-strain.js';
import { GRAIN_DISORDERED_NEIGHBORS, GRAIN_NEIGHBOR_SLOTS } from '../src/analysis/grains.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { calculatePtm, PTM_FIELDS, PTM_NEIGHBOR_LIST_FIELDS, PTM_TEMPLATE_NEIGHBORS, PTM_UNMATCHED_NEIGHBORS } from '../src/analysis/ptm.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';
import { axisAngleQuaternion, mulberry32, polycrystalFrame } from './helpers/polycrystal.js';

function assertIdentical(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let index = 0; index < expected.length; index += 1) {
    if (!Object.is(actual[index], expected[index])) assert.fail(`${label}[${index}]: ${actual[index]} !== ${expected[index]}`);
  }
}
const list = (ptm, atom) => Array.from(ptm.neighborIndices.subarray(atom * 16, atom * 16 + ptm.neighborCounts[atom]));
function noisy(frame, amplitude, seed) {
  const random = mulberry32(seed);
  return { ...frame, fractional: Float64Array.from(frame.fractional, value => value + (random() - .5) * amplitude) };
}
function tableFor(frame) {
  const search = new NeighborSearch(frame), count = search.count;
  const table = { counts: new Uint8Array(count), indices: new Uint32Array(count * 18), vectors: new Float64Array(count * 54),
    maxNeighbors: 18, sourceAtomCount: count, startAtom: 0, endAtom: count };
  for (let atom = 0; atom < count; atom += 1) {
    const neighbors = search.nearest(atom, 18);
    table.counts[atom] = neighbors.length;
    neighbors.forEach((neighbor, rank) => {
      table.indices[atom * 18 + rank] = neighbor.atom; table.vectors.set([neighbor.x, neighbor.y, neighbor.z], (atom * 18 + rank) * 3);
    });
  }
  return table;
}

test('the constants describe sixteen template slots and eight neighbors of an unmatched atom', () => {
  assert.equal(PTM_TEMPLATE_NEIGHBORS, 16); assert.equal(PTM_UNMATCHED_NEIGHBORS, 8);
  // The grain engine reads the same layout without importing the PTM kernel.
  assert.equal(GRAIN_NEIGHBOR_SLOTS, PTM_TEMPLATE_NEIGHBORS); assert.equal(GRAIN_DISORDERED_NEIGHBORS, PTM_UNMATCHED_NEIGHBORS);
  assert.deepEqual(Object.entries(PTM_NEIGHBOR_LIST_FIELDS).map(([name, [Type, stride]]) => [name, Type.name, stride]),
    [['neighborCounts', 'Uint8Array', 1], ['neighborIndices', 'Uint32Array', 16]]);
  assert.ok(!('neighborIndices' in PTM_FIELDS), 'the ordinary PTM outputs are unchanged');
});

test('matched atoms list the neighbors of their template and every PTM output is unchanged', async () => {
  for (const [kind, structure, expected, shell] of [['fcc', 1, 12, 12], ['hcp', 2, 12, 12], ['bcc', 3, 14, 14], ['sc', 5, 6, 6],
    ['diamond', 6, 16, 16], ['hex-diamond', 7, 16, 16]]) {
    const frame = noisy(crystalFrame(kind, 4, 3.6), .004, 7), search = new NeighborSearch(frame);
    const plain = await calculatePtm(frame, { flags: 255 }), lists = await calculatePtm(frame, { flags: 255, neighborLists: true });
    for (const field of Object.keys(PTM_FIELDS)) assertIdentical(lists[field], plain[field], `${kind} ${field}`);
    assert.ok(!('neighborIndices' in plain) && !('neighborSpan' in plain));
    assert.ok(lists.neighborCounts instanceof Uint8Array && lists.neighborIndices instanceof Uint32Array && lists.neighborSpan instanceof Float64Array);
    assert.equal(lists.neighborIndices.length, frame.fractional.length / 3 * 16);
    for (let atom = 0; atom < plain.structures.length; atom += 1) {
      assert.equal(plain.structures[atom], structure, kind);
      const neighbors = list(lists, atom);
      assert.equal(neighbors.length, expected, kind);
      assert.equal(new Set(neighbors).size, expected, 'no atom appears twice');
      assert.ok(!neighbors.includes(atom));
      // The template is the nearest coordination shell or shells. For the
      // diamond lattices it is the four bonded atoms, then the three other
      // bonded atoms of each of them.
      const nearest = (center, count) => search.nearest(center, count).map(neighbor => neighbor.atom);
      const template = kind.includes('diamond')
        ? [...nearest(atom, 4), ...nearest(atom, 4).flatMap(inner => nearest(inner, 4).filter(outer => outer !== atom))] : nearest(atom, shell);
      assert.deepEqual(neighbors.slice().sort((a, b) => a - b), template.sort((a, b) => a - b), `${kind} atom ${atom}`);
      if (kind.includes('diamond')) assert.deepEqual(neighbors.slice(0, 4).sort((a, b) => a - b), nearest(atom, 4).sort((a, b) => a - b), 'bonded atoms come first');
      assert.ok(lists.neighborIndices.subarray(atom * 16 + expected, atom * 16 + 16).every(index => index === 0), 'unused slots are zero');
    }
  }
});

test('template order follows the ideal template, so equivalent atoms list equivalent directions', async () => {
  // Ideal FCC: slot k of every atom points along the same lattice direction.
  const frame = crystalFrame('fcc', 4, 3.6), ptm = await calculatePtm(frame, { flags: 7, neighborLists: true });
  const direction = (atom, slot) => {
    const neighbor = ptm.neighborIndices[atom * 16 + slot];
    return [0, 1, 2].map(axis => { const d = frame.fractional[neighbor * 3 + axis] - frame.fractional[atom * 3 + axis]; return Math.round((d - Math.round(d)) * 8); });
  };
  for (let slot = 0; slot < 12; slot += 1) {
    const first = direction(0, slot);
    assert.equal(first.filter(component => component === 0).length, 1, 'a <110>/2 vector');
    for (let atom = 1; atom < frame.ids.length; atom += 17) assert.deepEqual(direction(atom, slot), first, `slot ${slot}`);
  }
});

test('unmatched and rejected atoms list their eight nearest neighbors by distance', async () => {
  const frame = noisy(crystalFrame('fcc', 4, 3.6), .004, 9), search = new NeighborSearch(frame);
  // An RMSD threshold no fit can meet rejects every atom.
  const rejected = await calculatePtm(frame, { flags: 7, rmsdCutoff: 1e-9, neighborLists: true });
  assert.ok(rejected.structures.every(type => type === 0));
  for (let atom = 0; atom < rejected.structures.length; atom += 1) {
    assert.deepEqual(list(rejected, atom), search.nearest(atom, 18).slice(0, 8).map(neighbor => neighbor.atom), `atom ${atom}`);
  }
  // No template to match at all: simple cubic atoms with only FCC enabled.
  const cubic = noisy(crystalFrame('sc', 4, 3), .004, 11), cubicSearch = new NeighborSearch(cubic);
  const unmatched = await calculatePtm(cubic, { flags: 1, neighborLists: true });
  assert.ok(unmatched.structures.every(type => type === 0));
  for (let atom = 0; atom < 64; atom += 5) assert.deepEqual(list(unmatched, atom), cubicSearch.nearest(atom, 18).slice(0, 8).map(neighbor => neighbor.atom));
  // Fewer atoms than neighbors in an open cell: everything there is.
  const few = { fractional: Float64Array.of(.1, .1, .1, .2, .1, .1, .1, .25, .1), cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
  const small = await calculatePtm(few, { neighborLists: true });
  assert.deepEqual([0, 1, 2].map(atom => list(small, atom)), [[1, 2], [0, 2], [0, 1]]);
  assertIdentical(small.neighborSpan, Float64Array.of(0, 0, 0), 'open cell span');
});

test('the neighbor span is the largest fractional extent of a listed neighbor along each periodic vector', async () => {
  // FCC neighbors are (a/2, a/2, 0): one eighth of a 4-cell box, one quarter of a 2-cell box.
  for (const [repeat, span] of [[4, .125], [2, .25], [1, .5]]) {
    const ptm = await calculatePtm(crystalFrame('fcc', repeat, 3.6), { flags: 7, neighborLists: true });
    for (const value of ptm.neighborSpan) assert.ok(Math.abs(value - span) < 1e-12, `${repeat}: ${value}`);
  }
  const frame = crystalFrame('fcc', 3, 3.6);
  frame.cell = createCell({ vectors: frame.cell.vectors, pbc: [true, false, true] });
  const mixed = await calculatePtm(frame, { flags: 7, neighborLists: true });
  assert.ok(Math.abs(mixed.neighborSpan[0] - 1 / 6) < 1e-12 && mixed.neighborSpan[1] === 0 && Math.abs(mixed.neighborSpan[2] - 1 / 6) < 1e-12);
  // A triclinic cell measures along its own vectors.
  const hexagonal = await calculatePtm(crystalFrame('hcp', 4, 3.2), { flags: 7, neighborLists: true });
  assert.ok(Math.abs(hexagonal.neighborSpan[0] - .25) < 1e-9 && Math.abs(hexagonal.neighborSpan[2] - .125) < 1e-9, Array.from(hexagonal.neighborSpan).join());
  await assert.rejects(calculatePtm(frame, { neighborLists: 1 }), /must be a boolean/);
});

test('atom ranges and prepared neighbor tables give the same lists', async () => {
  const frame = polycrystalFrame({ lattice: 'fcc', a: 3.6, box: [30, 22, 22], seeds: [[7.5, 11, 11], [22.5, 11, 11]],
    orientations: [[1, 0, 0, 0], axisAngleQuaternion([0, 0, 1], 25)], noise: .04, seed: 2 });
  const atoms = frame.ids.length, full = await calculatePtm(frame, { flags: 7, neighborLists: true });
  assert.ok(full.structures.includes(0) && full.structures.includes(1), 'matched and unmatched atoms');
  const startAtom = 211, endAtom = 640;
  const range = await calculatePtm(frame, { flags: 7, neighborLists: true, startAtom, endAtom });
  assertIdentical(range.neighborCounts, full.neighborCounts.subarray(startAtom, endAtom), 'range counts');
  assertIdentical(range.neighborIndices, full.neighborIndices.subarray(startAtom * 16, endAtom * 16), 'range indices');
  assert.ok(range.neighborSpan.every((value, axis) => value <= full.neighborSpan[axis]));
  const prepared = await calculatePtm(frame, { flags: 7, neighborLists: true, preparedNeighbors: tableFor(frame) });
  for (const field of [...Object.keys(PTM_FIELDS), 'neighborCounts', 'neighborIndices', 'neighborSpan']) assertIdentical(prepared[field], full[field], `prepared ${field}`);
  assert.equal(full.neighborCounts.length, atoms);
});

function nodeFactory() {
  return () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    return {
      addEventListener(name, listener) { worker.on(name, (data) => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transferables) { worker.postMessage(data, transferables); },
      terminate() { worker.terminate(); },
    };
  };
}

for (const isolated of [false, true]) {
  test(`pool Workers merge neighbor lists exactly${isolated ? ' with shared memory' : ''}`, async () => {
    const frame = polycrystalFrame({ lattice: 'bcc', a: 2.87, box: [60, 42, 42], seeds: [[15, 21, 21], [45, 21, 21]],
      orientations: [[1, 0, 0, 0], axisAngleQuaternion([1, 1, 0], 30)], noise: .03, seed: 4 });
    const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 5 }, performance: {}, crossOriginIsolated: isolated },
      workerFactory: nodeFactory() });
    try {
      const direct = await calculatePtm(frame, { flags: 7, neighborLists: true });
      const pooled = await pool.analyze(frame, { kind: 'ptm', flags: 7, rmsdCutoff: .1, neighborLists: true });
      assert.ok(pooled.workerCount > 1 && pooled.chunkCount > 1, 'several Workers and ranges');
      assert.equal(pooled.sharedMemory, isolated);
      for (const field of [...Object.keys(PTM_FIELDS), 'neighborCounts', 'neighborIndices', 'neighborSpan']) assertIdentical(pooled[field], direct[field], field);
      // Without the option the result has the seven ordinary outputs only.
      const plain = await pool.analyze(frame, { kind: 'ptm', flags: 7, rmsdCutoff: .1 });
      for (const field of Object.keys(PTM_FIELDS)) assertIdentical(plain[field], direct[field], `plain ${field}`);
      assert.ok(!('neighborIndices' in plain) && !('neighborCounts' in plain) && !('neighborSpan' in plain));
      // A strain run that fits PTM itself can carry the lists for a later grain analysis.
      const references = [{ structure: 3, a: 2.87 }];
      const strain = await pool.analyze(frame, { kind: 'strain', flags: 7, rmsdCutoff: .1, references, neighborLists: true });
      assertIdentical(strain.neighborIndices, direct.neighborIndices, 'strain neighbor indices');
      assertIdentical(strain.neighborSpan, direct.neighborSpan, 'strain neighbor span');
      const expected = await calculateAtomicStrain(frame, { flags: 7, rmsdCutoff: .1, references });
      assertIdentical(strain.atomicShearStrain, expected.atomicShearStrain, 'strain values are unchanged');
      const reused = await pool.analyze(frame, { kind: 'strain', flags: 7, rmsdCutoff: .1, references, neighborLists: true, ptmInput: direct });
      assertIdentical(reused.atomicShearStrain, expected.atomicShearStrain, 'strain from a supplied fit');
      assert.ok(!('neighborIndices' in reused), 'a supplied fit is not returned again');
    } finally { pool.close(); }
  });
}
