import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateBondStatistics, calculateBondStatisticsAtom, validateBondStatisticsParameters,
  createBondStatisticsAccumulators, addBondStatisticsSample, mergeBondStatisticsPartials,
  mergeBondStatisticsMoment, finalizeBondStatistics, bondStatisticsHistogramBin,
} from '../src/analysis/bond-statistics.js';
import { calculateBonds } from '../src/analysis/bonds.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

function near(actual, expected, tolerance = 1e-7) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);
}

test('local Steinhardt Q4 and Q6 match conventional ideal FCC, HCP, BCC and SC values', () => {
  const references = [
    ['fcc', 3, 12, .19094065395649332, .5745242597140697],
    ['hcp', 4.01, 12, .09722222222222222, .48476168522368324],
    // The conventional BCC reference contains both the 8 first and 6 second neighbors.
    ['bcc', 4.01, 14, .03636964837266542, .5106882308569509],
    ['bcc', 3.6, 8, .5091750772173156, .6285393610547089],
    ['sc', 4.01, 6, .7637626158259734, .3535533905932738],
  ];
  for (const [kind, cutoff, neighbors, q4, q6] of references) {
    const frame = crystalFrame(kind, 2);
    const result = calculateBondStatistics(frame, { cutoff });
    assert.ok(result.coordination.every(value => value === neighbors), kind);
    for (const actual of result.q4) near(actual, q4);
    for (const actual of result.q6) near(actual, q6);
    assert.equal(result.lengthDistribution.total, frame.types.length * neighbors / 2);
    assert.equal(result.angleDistribution.total, frame.types.length * neighbors * (neighbors - 1) / 2);
    near(result.statistics.q4.mean, q4);
    near(result.statistics.q6.mean, q6);
    assert.ok(result.statistics.q4.stddev < 1e-12);
  }
});

test('primitive SC periodic self images give three lengths and 15 unordered central angles', () => {
  const result = calculateBondStatistics(crystalFrame('sc', 1), { cutoff: 4, lengthBins: 4, angleBins: 180 });
  assert.deepEqual([...result.lengthCounts], [0, 0, 0, 3]);
  assert.equal(result.angleCounts[90], 12);
  assert.equal(result.angleCounts[179], 3, '180-degree inclusive endpoint belongs to the final bin');
  assert.equal(result.angleCounts.reduce((sum, value) => sum + value, 0), 15);
  assert.deepEqual([...result.coordination], [6]);
  assert.equal(result.statistics.length.count, 3);
  assert.equal(result.statistics.length.mean, 4);
  assert.equal(result.statistics.length.stddev, 0);
  assert.equal(result.statistics.angle.mean, 108);
  assert.equal(result.statistics.angle.stddev, 36);
});

test('length/angle probabilities sum to one and densities integrate in Angstroms and degrees', () => {
  const result = calculateBondStatistics(crystalFrame('bcc', 3), { cutoff: 4.01, lengthBins: 73, angleBins: 91 });
  for (const distribution of [result.lengthDistribution, result.angleDistribution]) {
    near(distribution.probability.reduce((sum, value) => sum + value, 0), 1, 1e-12);
    near(distribution.density.reduce((sum, value, index) => sum + value * (distribution.edges[index + 1] - distribution.edges[index]), 0), 1, 1e-12);
    assert.equal(distribution.edges.length, distribution.counts.length + 1);
    assert.equal(distribution.counts.reduce((sum, value) => sum + value, 0), distribution.total);
  }
  assert.equal(result.lengthDistribution.unit, 'Å');
  assert.equal(result.angleDistribution.unit, '°');
  assert.equal(result.normalization.lengthCounting, 'unique-periodic-edges');
});

test('skewed mixed-PBC length geometry is the same physical graph as Bonds', () => {
  const frame = { fractional: Float64Array.from([.05, .05, .2, .95, .95, .2]), types: Uint16Array.from([0, 1]),
    cell: createCell({ vectors: [10, 0, 0, 4, 8, 0, 0, 0, 10], pbc: [true, true, false], triclinic: true }) };
  const original = frame.fractional.slice();
  const result = calculateBondStatistics(frame, { cutoff: 2 });
  assert.equal(result.lengthDistribution.total, calculateBonds(frame, { cutoff: 2 }).count);
  near(result.statistics.length.mean, Math.hypot(1.4, .8), 1e-12);
  assert.deepEqual([...result.coordination], [1, 1]);
  assert.deepEqual([...result.q4], [1, 1]);
  assert.deepEqual([...result.q6], [1, 1]);
  assert.equal(result.angleDistribution.total, 0);
  assert.deepEqual(frame.fractional, original, 'analysis does not wrap or overwrite source coordinates');
  frame.cell.pbc = [true, false, false];
  assert.equal(calculateBondStatistics(frame, { cutoff: 2 }).lengthDistribution.total, 0);
});

test('element-pair cutoffs select symmetric environments and can disable unlike bonds', () => {
  const frame = { fractional: Float64Array.from([.1, .1, .1, .2, .1, .1, .3, .1, .1]), types: Uint16Array.from([0, 1, 0]),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
  const result = calculateBondStatistics(frame, { cutoff: 1.1, pairCutoffs: [{ first: 0, second: 1, cutoff: 0 }, { first: 0, second: 0, cutoff: 2.1 }] });
  assert.equal(result.normalization.maximumCutoff, 2.1);
  assert.deepEqual([...result.coordination], [1, 0, 1]);
  assert.equal(result.lengthDistribution.total, 1);
  near(result.statistics.length.mean, 2);
  assert.ok(Number.isNaN(result.q4[1]));
  assert.equal(result.statistics.q4.count, 2);
});

test('isolated and zero-length environments have NaN order and empty, finite distributions', () => {
  const frame = { fractional: Float64Array.from([.1, .1, .1, .1, .1, .1]), types: new Uint16Array(2),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
  const result = calculateBondStatistics(frame, { cutoff: 1 });
  assert.ok(result.q4.every(Number.isNaN));
  assert.ok(result.q6.every(Number.isNaN));
  assert.equal(result.statistics.q4.count, 0);
  assert.ok(Number.isNaN(result.statistics.q4.mean));
  assert.equal(result.lengthDistribution.total, 0);
  assert.ok(result.lengthDistribution.probability.every(value => value === 0));
  assert.ok(result.angleDistribution.density.every(value => value === 0));
  assert.equal(result.warning, null);
});

test('Q4/Q6 and angle statistics are rotation invariant rather than axis projections', () => {
  const frame = crystalFrame('fcc', 2);
  const reference = calculateBondStatistics(frame, { cutoff: 3 });
  const angle = .617, sine = Math.sin(angle), cosine = Math.cos(angle);
  // Rotate all lattice vectors about z; fractions are unchanged.
  frame.cell = createCell({ vectors: Array.from(frame.cell.vectors).map((value, index, h) => {
    const row = index - index % 3;
    return index % 3 === 0 ? h[row] * cosine - h[row + 1] * sine
      : index % 3 === 1 ? h[row] * sine + h[row + 1] * cosine : value;
  }), triclinic: true });
  const rotated = calculateBondStatistics(frame, { cutoff: 3 });
  for (const name of ['q4', 'q6']) for (let atom = 0; atom < rotated[name].length; atom += 1) near(rotated[name][atom], reference[name][atom]);
  // acos is ill-conditioned at antiparallel pairs; f64 roundoff there produces
  // sub-microdegree variation even though the Legendre invariants are stable.
  near(rotated.statistics.angle.mean, reference.statistics.angle.mean, 1e-6);
  near(rotated.statistics.angle.stddev, reference.statistics.angle.stddev, 1e-6);
});

test('central ranges and sparse exact atom helpers retain all unique lengths and angles', () => {
  const frame = crystalFrame('hcp', 3), parameters = { cutoff: 4.01, lengthBins: 17, angleBins: 19 };
  const count = frame.types.length, middle = Math.floor(count / 2);
  const full = calculateBondStatistics(frame, parameters);
  const partials = [calculateBondStatistics(frame, { ...parameters, endAtom: middle }),
    calculateBondStatistics(frame, { ...parameters, startAtom: middle })];
  const merged = mergeBondStatisticsPartials(partials, {
    coordination: Uint32Array.from([...partials[0].coordination, ...partials[1].coordination]),
    q4: Float32Array.from([...partials[0].q4, ...partials[1].q4]),
    q6: Float32Array.from([...partials[0].q6, ...partials[1].q6]),
  });
  for (const field of ['lengthCounts', 'angleCounts', 'coordination', 'q4', 'q6']) assert.deepEqual(merged[field], full[field], field);
  for (const name of ['length', 'angle', 'q4', 'q6']) {
    assert.equal(merged.statistics[name].count, full.statistics[name].count);
    near(merged.statistics[name].mean, full.statistics[name].mean, 1e-12);
    near(merged.statistics[name].stddev, full.statistics[name].stddev, 1e-12);
  }
  const prepared = validateBondStatisticsParameters(frame, parameters), search = new NeighborSearch(frame);
  const accumulation = createBondStatisticsAccumulators(prepared);
  for (let atom = 0; atom < count; atom += 1) calculateBondStatisticsAtom(search, atom, prepared, accumulation);
  const sparse = finalizeBondStatistics({ ...accumulation, normalization: prepared.normalization });
  assert.deepEqual(sparse.lengthCounts, full.lengthCounts);
  assert.deepEqual(sparse.angleCounts, full.angleCounts);
});

test('wide histograms accumulate beyond u32 without wrapping and stable moments merge', () => {
  const prepared = validateBondStatisticsParameters(crystalFrame('sc', 1), { cutoff: 4 });
  const first = createBondStatisticsAccumulators(prepared), second = createBondStatisticsAccumulators(prepared);
  first.lengthCounts[1] = 0xffff_ffff;
  second.lengthCounts[1] = 29;
  const merged = mergeBondStatisticsPartials([{ ...first, normalization: prepared.normalization }, { ...second, normalization: prepared.normalization }]);
  assert.equal(merged.lengthCounts[1], 0x1_0000_001c);
  assert.equal(merged.lengthDistribution.total, 0x1_0000_001c);
  const a = createBondStatisticsAccumulators(prepared).moments.length, b = createBondStatisticsAccumulators(prepared).moments.length;
  addBondStatisticsSample(a, 1e9 + .001);
  addBondStatisticsSample(b, 1e9 + .002);
  mergeBondStatisticsMoment(a, b);
  near(a.mean, 1e9 + .0015, 2e-7);
  near(Math.sqrt(a.m2 / a.count), .0005, 1e-7);
});

test('cutoff, pair, bins and range validation rejects invalid scientific inputs', () => {
  const frame = crystalFrame('sc', 1);
  for (const cutoff of [NaN, Infinity, 0, -1]) assert.throws(() => calculateBondStatistics(frame, { cutoff }), /cutoff/);
  for (const bins of [0, 1.5, 4097, Infinity]) assert.throws(() => calculateBondStatistics(frame, { cutoff: 4, lengthBins: bins }), /bins/);
  assert.throws(() => calculateBondStatistics(frame, { cutoff: 4, endAtom: 0 }), /range/);
  assert.throws(() => calculateBondStatistics(frame, { cutoff: 4, pairCutoffs: [{ first: 0, second: 1, cutoff: 1 }, { first: 1, second: 0, cutoff: 2 }] }), /only one cutoff/);
  assert.throws(() => calculateBondStatistics(frame, { cutoff: 4, pairCutoffs: [null] }), /Invalid element-pair/);
  assert.throws(() => calculateBondStatistics({ ...frame, types: Float32Array.from([.5]) }, { cutoff: 4 }), /element type/);
  assert.equal(bondStatisticsHistogramBin(180, 180, 180), 179);
});

test('oversized local coordination is rejected without returning truncated angles or order', () => {
  const prepared = validateBondStatisticsParameters(crystalFrame('sc', 1), { cutoff: 1 });
  const search = { within: () => Array.from({ length: 1025 }, (_, index) => ({ atom: 0, x: .5, y: 0, z: 0,
    distanceSquared: .25, imageA: index + 1, imageB: 0, imageC: 0 })) };
  assert.throws(() => calculateBondStatisticsAtom(search, 0, prepared), /at most 1024 neighbors/);
});

test('analysis progress counts real processed central atoms and retains phase order', () => {
  const frame = crystalFrame('fcc', 4), phases = [], progress = [];
  calculateBondStatistics(frame, { cutoff: 3, onPhase: phase => phases.push(phase), onAtoms: processed => progress.push(processed) });
  assert.deepEqual(phases, ['indexing', 'analyzing']);
  assert.ok(progress.some(processed => processed > 0 && processed < frame.types.length));
  assert.equal(progress.at(-1), frame.types.length);
});
