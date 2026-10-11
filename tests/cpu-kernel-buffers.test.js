import assert from 'node:assert/strict';
import test from 'node:test';
import { NeighborBuffer, NeighborSearch } from '../src/analysis/neighbors.js';
import { classify, classifyNeighborBuffer, calculateCna } from '../src/analysis/cna.js';
import { calculateBonds } from '../src/analysis/bonds.js';
import { calculateBondStatistics, calculateBondStatisticsAtom, createBondStatisticsAccumulators,
  validateBondStatisticsParameters, finalizeBondStatistics, prepareBondStatisticsContext,
  calculatePreparedBondStatistics, bondStatisticsScratchBytes } from '../src/analysis/bond-statistics.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

const fields = { atom: 'atoms', x: 'xs', y: 'ys', z: 'zs', distanceSquared: 'distanceSquared',
  imageA: 'imageA', imageB: 'imageB', imageC: 'imageC' };
const compare = (a, b) => a.distanceSquared - b.distanceSquared || a.atom - b.atom || a.x - b.x || a.y - b.y || a.z - b.z;

function equalRows(buffer, rows) {
  assert.equal(buffer.length, rows.length);
  for (let i = 0; i < rows.length; i += 1) for (const [property, column] of Object.entries(fields)) {
    assert.ok(Object.is(buffer[column][i], rows[i][property]), `${property}[${i}] must retain its exact value and sign`);
  }
}

function sortedNearest(search, atom, count) {
  const needed = search.cell.pbc.some(Boolean) ? count : Math.min(count, search.count - 1);
  if (!needed) return [];
  let radius = search.nearestRadius(needed);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const rows = search.within(atom, radius);
    if (rows.length >= needed) return rows.sort(compare).slice(0, needed);
    radius *= 1.6;
  }
  throw new Error('unresolved test environment');
}

test('owned neighbor columns preserve periodic image signs, stable ties and large nearest selections', () => {
  let seed = 22;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
  const frames = [crystalFrame('fcc', 1), crystalFrame('bcc', 2), crystalFrame('hcp', 1), crystalFrame('sc', 1)];
  for (const pbc of [[true, false, true], [false, false, false]]) frames.push({
    fractional: Float64Array.from({ length: 40 * 3 }, () => random() * 2 - .5),
    cell: createCell({ vectors: [10, 0, 0, 8, 3, 0, -2, 1, 10], pbc }),
  });
  for (const frame of frames) {
    const search = new NeighborSearch(frame), first = new NeighborBuffer(), second = new NeighborBuffer();
    for (const atom of [0, Math.floor(search.count / 2)]) {
      for (const limit of [1, 15, Infinity]) {
        equalRows(search.collect(atom, 4.5, first, limit), search.within(atom, 4.5, limit));
      }
      for (const count of [1, 12, 14, 18, 80]) {
        const expected = sortedNearest(search, atom, count);
        equalRows(search.nearestInto(atom, count, first), expected);
        search.collect((atom + 1) % search.count, 3.3, second);
        equalRows(first, expected, 'another independent query cannot overwrite owned rows');
        const otherSearch = NeighborSearch.fromIndex(search.exportIndex());
        otherSearch.nearestInto(atom, 18, second);
        equalRows(first, expected, 'a shared index has private query scratch');
      }
    }
  }
});

test('typed CNA shells retain the legacy graph classification and independent nested queries', () => {
  for (const [kind, expected] of [['fcc', 1], ['hcp', 2], ['bcc', 3]]) {
    const frame = crystalFrame(kind, 2), search = new NeighborSearch(frame), shell = new NeighborBuffer();
    assert.ok(calculateCna(frame).structures.every(value => value === expected));
    for (const atom of [0, Math.floor(search.count / 2)]) {
      for (const radius of [3.3, 4.01, 4.5]) {
        const rows = search.within(atom, radius, 15);
        search.collect(atom, radius, shell, 15);
        assert.equal(classifyNeighborBuffer(shell, radius), classify(rows, radius));
      }
    }
  }
});

test('private numeric element-pair lookups retain huge type identities and public mutable maps', () => {
  const values = [0, 1, 2 ** 26 - 1, 2 ** 26, 2 ** 32 - 1, 2 ** 32, Number.MAX_SAFE_INTEGER, 1e20];
  const frame = { fractional: Float64Array.from({ length: values.length * 3 }, (_, i) => i % 3 === 0 ? .05 * (1 + Math.floor(i / 3)) : .2),
    types: Float64Array.from(values), cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
  const pairCutoffs = values.flatMap((first, i) => values.slice(i).map((second, j) => ({ first, second, cutoff: (i + j) % 2 ? .6 : 0 })));
  const parameters = { cutoff: 1.1, pairCutoffs, lengthBins: 13, angleBins: 17 };
  const original = frame.fractional.slice(), types = frame.types.slice();
  const search = new NeighborSearch(frame), prepared = validateBondStatisticsParameters(frame, parameters);
  const accumulators = createBondStatisticsAccumulators(prepared);
  const q4 = new Float32Array(values.length), q6 = new Float32Array(values.length), coordination = new Uint32Array(values.length);
  for (let atom = 0; atom < values.length; atom += 1) {
    const local = calculateBondStatisticsAtom(search, atom, prepared, accumulators);
    q4[atom] = local.q4; q6[atom] = local.q6; coordination[atom] = local.coordination;
  }
  const oracle = finalizeBondStatistics({ ...accumulators, q4, q6, coordination, normalization: prepared.normalization });
  const actual = calculateBondStatistics(frame, parameters);
  for (const name of ['q4', 'q6', 'coordination', 'lengthCounts', 'angleCounts', 'statistics', 'moments']) assert.deepEqual(actual[name], oracle[name], name);
  assert.deepEqual(calculateBonds(frame, parameters).coordination, coordination);
  prepared.overrides.set('0:1', 0);
  assert.equal(prepared.overrides.get('0:1'), 0);
  const all = validateBondStatisticsParameters(frame, { cutoff: 1.1 });
  const before = calculateBondStatisticsAtom(search, 0, all).coordination;
  all.overrides.set('0:1', 0);
  assert.equal(calculateBondStatisticsAtom(search, 0, all).coordination, before - 1);
  assert.deepEqual(frame.fractional, original); assert.deepEqual(frame.types, types);
});

test('typed bond statistics keep ordered Welford moments identical to the object-shell oracle', () => {
  const reference = crystalFrame('fcc', 3);
  const frame = { ...reference, fractional: Float64Array.from(reference.fractional, (value, i) => value + Math.sin(i * .731) * .002),
    types: Uint16Array.from(reference.types, (_, i) => i % 3) };
  const parameters = { cutoff: 3.3, lengthBins: 27, angleBins: 37, pairCutoffs: [{ first: 0, second: 1, cutoff: 3.1 }] };
  const prepared = validateBondStatisticsParameters(frame, parameters), accumulated = createBondStatisticsAccumulators(prepared);
  const search = new NeighborSearch(frame);
  for (let atom = 0; atom < frame.types.length; atom += 1) calculateBondStatisticsAtom(search, atom, prepared, accumulated);
  const result = calculateBondStatistics(frame, parameters);
  assert.deepEqual(result.lengthCounts, accumulated.lengthCounts);
  assert.deepEqual(result.angleCounts, accumulated.angleCounts);
  assert.deepEqual(result.moments, accumulated.moments, 'range optimizations must not change sample accumulation order');
});

test('opaque bond scratch reports only its real buffers and nested ranges retain independent outputs', () => {
  const frame = crystalFrame('fcc', 3), parameters = { cutoff: 3.3 };
  const context = prepareBondStatisticsContext(frame, parameters);
  assert.equal(bondStatisticsScratchBytes({}), 0);
  assert.equal(bondStatisticsScratchBytes(context), 1024 * (4 + 8));
  const expected = calculateBondStatistics(frame, parameters);
  let nested = null;
  const actual = calculatePreparedBondStatistics(context, { onAtoms() {
    if (!nested) {
      nested = true;
      nested = calculatePreparedBondStatistics(context, { startAtom: 3, endAtom: 15 });
    }
  } });
  for (const field of ['q4', 'q6', 'coordination', 'lengthCounts', 'angleCounts', 'moments']) assert.deepEqual(actual[field], expected[field]);
  assert.deepEqual(nested.q4, expected.q4.slice(3, 15));
  assert.equal(bondStatisticsScratchBytes(context), 1024 * (4 + 8) + 32 * (4 + 7 * 8));
});

test('typed bond environments reject oversized coordination before enumerating truncated angles', () => {
  const frame = { fractional: Float64Array.from({ length: 1026 * 3 }, (_, k) => k % 3 === 0
    ? .3 + Math.floor(k / 3) * .00005 : .3), types: new Uint16Array(1026),
  cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
  assert.throws(() => calculateBondStatistics(frame, { cutoff: 1, endAtom: 1 }), /at most 1024 neighbors/);
});
