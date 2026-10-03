import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRdf, finalizeRdf } from '../src/analysis/rdf.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

function simpleFrame() {
  return { fractional: Float64Array.from([.1, .1, .1, .2, .1, .1, .35, .1, .1]), types: Uint16Array.from([0, 1, 0]),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }) };
}

test('RDF counts directed pairs and normalizes with exact shell volumes', () => {
  const result = calculateRdf(simpleFrame(), { cutoff: 4, bins: 4 });
  assert.deepEqual([...result.counts], [0, 4, 2, 0]);
  assert.deepEqual([...result.radii], [.5, 1.5, 2.5, 3.5]);
  assert.equal(result.normalization.pairPopulation, 6);
  assert.ok(Math.abs(result.values[1] - 4 * 1000 / (6 * 4 * Math.PI / 3 * 7)) < 1e-12);
});

test('RDF type pairs use same-type and cross-type population corrections', () => {
  const same = calculateRdf(simpleFrame(), { cutoff: 4, bins: 4, firstType: 0, secondType: 0 });
  const cross = calculateRdf(simpleFrame(), { cutoff: 4, bins: 4, firstType: 0, secondType: 1 });
  const reverse = calculateRdf(simpleFrame(), { cutoff: 4, bins: 4, firstType: 1, secondType: 0 });
  assert.deepEqual([...same.counts], [0, 0, 2, 0]);
  assert.equal(same.normalization.pairPopulation, 2);
  assert.deepEqual([...cross.counts], [0, 2, 0, 0]);
  assert.equal(cross.normalization.pairPopulation, 2);
  assert.deepEqual(cross.counts, reverse.counts);
  assert.deepEqual(cross.values, reverse.values);
});

test('split RDF ranges reproduce the full histogram in a triclinic cell', () => {
  const frame = crystalFrame('hcp', 3), count = frame.types.length, parameters = { cutoff: 4.01, bins: 31 };
  const full = calculateRdf(frame, parameters);
  const first = calculateRdf(frame, { ...parameters, endAtom: count / 2 });
  const second = calculateRdf(frame, { ...parameters, startAtom: count / 2 });
  const merged = Float64Array.from(first.counts, (value, index) => value + second.counts[index]);
  assert.deepEqual(merged, full.counts);
  assert.deepEqual(finalizeRdf(merged, full.normalization).values, full.values);
});

test('RDF rejects open boundaries, skew-cell overlong radius and invalid selections', () => {
  const frame = simpleFrame();
  frame.cell.pbc[2] = false;
  assert.throws(() => calculateRdf(frame, { cutoff: 4, bins: 10 }), /periodic boundaries/);
  frame.cell = createCell({ vectors: [10, 0, 0, 9, 1, 0, 0, 0, 10], triclinic: true });
  assert.throws(() => calculateRdf(frame, { cutoff: 1, bins: 10 }), /half the shortest cell face height/);
  assert.throws(() => calculateRdf(simpleFrame(), { cutoff: 4, bins: 0 }), /histogram bins/);
  assert.throws(() => calculateRdf(simpleFrame(), { cutoff: 4, bins: 10, firstType: 9 }), /distinct selected atom pair/);
  assert.equal(calculateRdf(simpleFrame(), { cutoff: 4, bins: 1 }).counts.length, 1);
});
