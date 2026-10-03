import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCna, classifyAdaptiveEnvironment } from '../src/analysis/cna.js';
import { calculateCentrosymmetry } from '../src/analysis/centrosymmetry.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

function mixedFrame() {
  const phases = [['fcc', 4, 0], ['bcc', 7, 35], ['hcp', 3, 80]];
  const positions = [];
  const offsets = [];
  for (const [kind, lattice, translation] of phases) {
    const frame = crystalFrame(kind, 4, lattice);
    offsets.push(positions.length / 3);
    for (let index = 0; index < frame.positions.length; index += 1) {
      positions.push(frame.positions[index] + (index % 3 === 0 ? translation : 0));
    }
  }
  return { fractional: Float64Array.from(positions, (value) => value / 128), offsets,
    cell: createCell({ vectors: [128, 0, 0, 0, 128, 0, 0, 0, 128], pbc: [false, false, false] }) };
}

test('Auto recognizes FCC, BCC and HCP per atom including primitive periodic cells', () => {
  for (const [kind, type, neighbors] of [['fcc', 1, 12], ['bcc', 3, 8], ['hcp', 2, 12]]) {
    for (const repeat of [1, 3]) {
      const frame = crystalFrame(kind, repeat);
      const result = calculateCentrosymmetry(frame, { mode: 'auto' });
      assert.ok(result.cspStructureTypes.every((value) => value === type), `${kind}/${repeat} recognition`);
      assert.ok(result.cspNeighborCounts.every((value) => value === neighbors));
      assert.deepEqual(result.centrosymmetry, calculateCentrosymmetry(frame, { neighbors }).centrosymmetry);
      assert.equal(result.cspSummary[kind], frame.ids.length);
      assert.equal(result.cspSummary.inferred, 0);
      assert.equal(result.cspSummary.unresolved, 0);
      if (kind === 'hcp') assert.ok(result.centrosymmetry.every((value) => value > .01), 'HCP retains intrinsic nonzero CSP');
      else assert.ok(result.centrosymmetry.every((value) => value < 1e-12));
    }
  }
});

test('Auto selects different shells in coexisting FCC, BCC and HCP regions', () => {
  const frame = mixedFrame();
  const result = calculateCentrosymmetry(frame, { mode: 'auto' });
  for (const [atom, type, neighbors] of [[84, 1, 12], [frame.offsets[1] + 42, 3, 8], [frame.offsets[2] + 42, 2, 12]]) {
    assert.equal(result.cspStructureTypes[atom], type);
    assert.equal(result.cspNeighborCounts[atom], neighbors);
    assert.equal(result.centrosymmetry[atom], calculateCentrosymmetry(frame, { neighbors, startAtom: atom, endAtom: atom + 1 }).centrosymmetry[0]);
  }
  assert.ok(result.cspSummary.fcc > 0 && result.cspSummary.bcc > 0 && result.cspSummary.hcp > 0);
  assert.equal(['fcc', 'hcp', 'bcc', 'other', 'ico'].reduce((sum, key) => sum + result.cspSummary[key], 0), result.centrosymmetry.length);
});

test('Auto preserves elevated finite CSP around FCC and BCC vacancies through local inference', () => {
  for (const [kind, neighbors] of [['fcc', 12], ['bcc', 8]]) {
    const frame = crystalFrame(kind, 4);
    frame.fractional = frame.fractional.slice(3);
    const result = calculateCentrosymmetry(frame, { mode: 'auto' });
    const manual = calculateCentrosymmetry(frame, { neighbors });
    const defective = [...result.cspStructureTypes].flatMap((type, atom) => type === 0 ? [atom] : []);
    assert.ok(defective.length > 0);
    assert.ok(defective.some((atom) => result.centrosymmetry[atom] > .001));
    assert.ok(defective.every((atom) => result.cspNeighborCounts[atom] === neighbors));
    assert.deepEqual(result.centrosymmetry, manual.centrosymmetry);
    assert.equal(result.cspSummary.inferred, defective.length);
    assert.equal(result.cspSummary.unresolved, 0);
    assert.equal(result.incomplete, 0);
  }
});

test('Auto retains raw Other and combines FCC/HCP shell votes while rejecting 8/12 ties', () => {
  const frame = crystalFrame('fcc', 3);
  const nearest = new NeighborSearch(frame).nearest(0, 14);
  const labels = new Uint8Array(frame.ids.length);
  nearest.forEach((neighbor, index) => { labels[neighbor.atom] = index < 7 ? 1 : 2; });
  const mixedClosePacked = calculateCentrosymmetry(frame, { mode: 'auto', structureInput: labels, endAtom: 1 });
  assert.equal(mixedClosePacked.cspStructureTypes[0], 0);
  assert.equal(mixedClosePacked.cspNeighborCounts[0], 12);
  assert.equal(mixedClosePacked.cspSummary.inferred, 1);
  assert.ok(Number.isFinite(mixedClosePacked.centrosymmetry[0]));
  nearest.slice(7).forEach((neighbor) => { labels[neighbor.atom] = 3; });
  const tied = calculateCentrosymmetry(frame, { mode: 'auto', structureInput: labels, endAtom: 1 });
  assert.equal(tied.cspNeighborCounts[0], 0);
  assert.equal(tied.cspSummary.inferred, 0);
  assert.equal(tied.cspSummary.unresolved, 1);
  assert.ok(Number.isNaN(tied.centrosymmetry[0]));
  labels[0] = 4;
  const ico = calculateCentrosymmetry(frame, { mode: 'auto', structureInput: labels, endAtom: 1 });
  assert.equal(ico.cspStructureTypes[0], 4);
  assert.equal(ico.cspNeighborCounts[0], 0, 'ICO never inherits a surrounding crystal shell');
  assert.ok(Number.isNaN(ico.centrosymmetry[0]));
});

test('wholly unrecognized Auto environments remain NaN without insufficient-neighbor warnings', () => {
  for (const frame of [crystalFrame('sc', 3), {
    fractional: new Float64Array([.5, .5, .5]),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }),
  }]) {
    const result = calculateCentrosymmetry(frame, { mode: 'auto' });
    assert.ok(result.centrosymmetry.every(Number.isNaN));
    assert.ok(result.cspNeighborCounts.every((count) => count === 0));
    assert.equal(result.cspSummary.unresolved, result.centrosymmetry.length);
    assert.equal(result.incomplete, 0);
  }
});

test('Auto is exactly invariant to disjoint ranges, including neighbor classification across a vacancy', () => {
  const frame = crystalFrame('fcc', 4);
  frame.fractional = frame.fractional.slice(3);
  const full = calculateCentrosymmetry(frame, { mode: 'auto' });
  const boundaries = [0, 1, 7, 59, 128, full.centrosymmetry.length];
  const partials = boundaries.slice(1).map((endAtom, index) => (
    calculateCentrosymmetry(frame, { mode: 'auto', startAtom: boundaries[index], endAtom })
  ));
  for (const key of ['centrosymmetry', 'cspStructureTypes', 'cspNeighborCounts']) {
    assert.deepEqual(partials.flatMap((result) => [...result[key]]), [...full[key]], key);
  }
  for (const key of Object.keys(full.cspSummary)) assert.equal(partials.reduce((sum, result) => sum + result.cspSummary[key], 0), full.cspSummary[key]);
});

test('cached adaptive CNA labels produce identical Auto results without mutating their input', () => {
  const frame = crystalFrame('bcc', 4);
  frame.fractional = frame.fractional.slice(3);
  const structures = calculateCna(frame).structures;
  const retained = structures.slice();
  const cached = calculateCentrosymmetry(frame, { mode: 'auto', structureInput: structures });
  const uncached = calculateCentrosymmetry(frame, { mode: 'auto' });
  for (const key of ['centrosymmetry', 'cspStructureTypes', 'cspNeighborCounts', 'cspSummary']) assert.deepEqual(cached[key], uncached[key]);
  assert.deepEqual(structures, retained);
  const search = new NeighborSearch(frame);
  assert.equal(classifyAdaptiveEnvironment(search.nearest(5, 14)), structures[5]);
});

test('Auto reports bounded actual atom progress and validates complete cached structure inputs', () => {
  const frame = crystalFrame('fcc', 4);
  const phases = [], progress = [];
  calculateCentrosymmetry(frame, { mode: 'auto', onPhase: (phase) => phases.push(phase), onAtoms: (processed, count) => progress.push({ processed, count }) });
  assert.deepEqual(phases, ['indexing', 'analyzing']);
  assert.ok(progress.some(({ processed }) => processed > 0 && processed < frame.ids.length));
  assert.equal(progress.at(-1).processed, frame.ids.length);
  assert.ok(progress.every(({ count }) => count === frame.ids.length));
  assert.throws(() => calculateCentrosymmetry(frame, { mode: 'PTM' }));
  assert.throws(() => calculateCentrosymmetry(frame, { mode: 'auto', structureInput: new Uint8Array(1) }));
  assert.throws(() => calculateCentrosymmetry(frame, { mode: 'auto', structureInput: new Float32Array(frame.ids.length) }));
  assert.throws(() => calculateCentrosymmetry(frame, { mode: 'auto', structureInput: new Uint8Array(frame.ids.length).fill(5) }));
  assert.throws(() => calculateCentrosymmetry(frame, { mode: 'manual', neighbors: 11 }));
});
