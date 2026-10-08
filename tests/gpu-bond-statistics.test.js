import test from 'node:test';
import assert from 'node:assert/strict';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';
import { calculateBondStatistics, validateBondStatisticsParameters, createBondStatisticsAccumulators,
  finalizeBondStatistics } from '../src/analysis/bond-statistics.js';
import { analyzeGpuBondStatistics, correctGpuBondStatisticsPairs, bondStatisticsGpuBatchSize,
  GPU_BOND_STATISTICS_BATCH_ATOMS } from '../src/analysis/gpu/bond-statistics.js';
import { BOND_STATISTICS_ATOM_WORDS, BOND_STATISTICS_CORRECTION_WORDS,
  BOND_STATISTICS_FLAG_PRECISION, BOND_STATISTICS_FLAG_NEIGHBORS, MAX_GPU_BOND_STATISTICS_NEIGHBORS } from '../src/analysis/gpu/bond-statistics-shaders.js';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';

function exactRecords(frame, prepared) {
  const search = new NeighborSearch(frame), records = [];
  const push = (kind, atom, first, second) => {
    const row = new Int32Array(BOND_STATISTICS_CORRECTION_WORDS);
    row.set([kind, atom, first.atom, second?.atom ?? 0, first.imageA, first.imageB, first.imageC,
      second?.imageA ?? 0, second?.imageB ?? 0, second?.imageC ?? 0]);
    records.push(...new Uint32Array(row.buffer));
  };
  for (let atom = prepared.startAtom; atom < prepared.endAtom; atom++) {
    const neighbors = search.within(atom, prepared.maximumCutoff).filter(neighbor => {
      const a = frame.types[atom], b = frame.types[neighbor.atom];
      const limit = prepared.overrides.get(a <= b ? `${a}:${b}` : `${b}:${a}`) ?? prepared.cutoff;
      return limit > 0 && neighbor.distanceSquared > 1e-24 && neighbor.distanceSquared <= limit ** 2;
    });
    for (let first = 0; first < neighbors.length; first++) {
      const a = neighbors[first];
      const positive = a.imageA ? a.imageA > 0 : a.imageB ? a.imageB > 0 : a.imageC > 0;
      if (a.atom > atom || (a.atom === atom && positive)) push(0, atom, a);
      for (let second = first + 1; second < neighbors.length; second++) push(1, atom, a, neighbors[second]);
    }
  }
  return Uint32Array.from(records);
}

test('GPU bin corrections recover exact CPU shell counts for primitive FCC/BCC/HCP/SC images', async () => {
  for (const [kind, cutoff] of [['sc', 4.01], ['fcc', 3.1], ['bcc', 4.1], ['hcp', 4.1]]) {
    const frame = crystalFrame(kind, 1), options = { cutoff, lengthBins: 80, angleBins: 180 };
    const expected = calculateBondStatistics(frame, options), prepared = validateBondStatisticsParameters(frame, options);
    const output = createBondStatisticsAccumulators(prepared);
    await correctGpuBondStatisticsPairs(frame, prepared, exactRecords(frame, prepared), output);
    assert.deepEqual(output.lengthCounts, expected.lengthCounts, kind + ' lengths');
    assert.deepEqual(output.angleCounts, expected.angleCounts, kind + ' angles');
    const actual = finalizeBondStatistics({ ...output, normalization: prepared.normalization });
    for (const name of ['length', 'angle']) for (const key of ['count', 'min', 'max', 'mean', 'stddev']) {
      assert.ok(Math.abs(actual.statistics[name][key] - expected.statistics[name][key]) < 1e-10, `${kind} ${name} ${key}`);
    }
  }
});

test('GPU exact histogram records retain shifted triclinic, mixed-PBC, type overrides and ranged ownership', async () => {
  const frame = { fractional: Float64Array.from([3.05, -.95, .2, -2.05, 4.95, .2, .2, .2, .2]), types: Uint16Array.from([0, 1, 0]),
    cell: createCell({ vectors: [10, 0, 0, 4, 8, 0, 0, 0, 10], pbc: [true, true, false], triclinic: true }) };
  const options = { cutoff: 4.2, lengthBins: 21, angleBins: 36, startAtom: 1,
    pairCutoffs: [{ first: 1, second: 0, cutoff: 2.1 }] };
  const prepared = validateBondStatisticsParameters(frame, options), output = createBondStatisticsAccumulators(prepared);
  await correctGpuBondStatisticsPairs(frame, prepared, exactRecords(frame, prepared), output);
  const expected = calculateBondStatistics(frame, options);
  assert.deepEqual(output.lengthCounts, expected.lengthCounts); assert.deepEqual(output.angleCounts, expected.angleCounts);
});

function fakeRuntime({ flags = BOND_STATISTICS_FLAG_PRECISION, failRead = false, allocationFailure = false,
  abortController, overflowOnce = false } = {}) {
  const allocated = [], released = [], dispatches = [], preparations = [];
  const allocate = bytes => {
    if (allocationFailure && allocated.length === 1) throw new Error('allocation failed');
    const buffer = { data: new Uint8Array(bytes) }; allocated.push(buffer); return buffer;
  };
  const runtime = {
    async prepareNeighbors(frame, cutoff, { signal }) { signal?.throwIfAborted(); preparations.push([frame, cutoff]); return {}; },
    createBuffer: allocate,
    storageBuffer(values) { const buffer = allocate(values.byteLength); buffer.data.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)); return buffer; },
    neighborBindings(_context, extra) { return extra; },
    zeroBuffer(buffer, offset = 0, size = buffer.data.length - offset) { buffer.data.fill(0, offset, offset + size); },
    async run(_source, bindings, _count, options) {
      dispatches.push({ ...options });
      const words = new Uint32Array(bindings[1].data.buffer);
      for (let atom = options.startAtom; atom < options.endAtom; atom++) words[(atom - options.startAtom) * BOND_STATISTICS_ATOM_WORDS + 3] = flags;
      if (overflowOnce && dispatches.length === 1) new Uint32Array(bindings[3].data.buffer)[1] = 1;
      abortController?.abort();
    },
    async read(buffer, Type, length, { signal }) {
      signal?.throwIfAborted(); if (failRead) throw new Error('device lost');
      return new Type(buffer.data.buffer.slice(0, length * Type.BYTES_PER_ELEMENT));
    },
    disposeBuffers(buffers) { released.push(...buffers); },
  };
  return { runtime, allocated, released, dispatches, preparations };
}

test('GPU cutoff corrections use the CPU oracle and preserve typed rows, distributions and moments', async () => {
  const frame = crystalFrame('fcc', 1), options = { cutoff: Math.sqrt(8), lengthBins: 33, angleBins: 47, startAtom: 1 };
  const setup = fakeRuntime(), expected = calculateBondStatistics(frame, options);
  const actual = await analyzeGpuBondStatistics(setup.runtime, frame, options);
  for (const key of ['coordination', 'q4', 'q6', 'lengthCounts', 'angleCounts', 'statistics', 'normalization']) assert.deepEqual(actual[key], expected[key], key);
  assert.equal(actual.gpuCorrectionAtoms, frame.types.length - 1);
  assert.equal(setup.preparations.length, 1); assert.equal(setup.allocated.length, 4);
  assert.deepEqual(setup.released, setup.allocated);
});

test('GPU correction overflow retries smaller dispatches using the same device buffers and neighbor index', async () => {
  const frame = crystalFrame('fcc', 1), options = { cutoff: 3.1 };
  const setup = fakeRuntime({ overflowOnce: true });
  const actual = await analyzeGpuBondStatistics(setup.runtime, frame, options);
  assert.deepEqual(actual.angleCounts, calculateBondStatistics(frame, options).angleCounts);
  assert.equal(setup.preparations.length, 1); assert.equal(setup.allocated.length, 4);
  assert.equal(setup.dispatches.length, 3);
  assert.deepEqual(setup.dispatches.map(value => [value.startAtom, value.endAtom]), [[0, 4], [0, 2], [2, 4]]);
  assert.deepEqual(setup.released, setup.allocated);
});

test('GPU oversized environments request explicit CPU fallback, never truncated coordination', async () => {
  const setup = fakeRuntime({ flags: BOND_STATISTICS_FLAG_NEIGHBORS });
  await assert.rejects(analyzeGpuBondStatistics(setup.runtime, crystalFrame('sc', 1), { cutoff: 20 }),
    error => error.name === 'GpuUnavailableError' && /128 neighbors/.test(error.message));
  assert.deepEqual(setup.released, setup.allocated);
});

test('GPU bond statistics cancellation, partial allocation and read failures release all temporary buffers', async () => {
  for (const mode of ['cancel', 'allocation', 'read']) {
    const controller = new AbortController(), setup = fakeRuntime({ allocationFailure: mode === 'allocation',
      failRead: mode === 'read', abortController: mode === 'cancel' ? controller : undefined });
    await assert.rejects(analyzeGpuBondStatistics(setup.runtime, crystalFrame('fcc', 1), { cutoff: 3.1 }, { signal: controller.signal }),
      mode === 'cancel' ? { name: 'AbortError' } : mode === 'allocation' ? /allocation failed/ : /device lost/);
    assert.deepEqual(setup.released, setup.allocated);
  }
});

test('GPU bond statistics is registered on the persistent GPU client', () => {
  assert.equal(new GpuAnalysisClient().supports('bondStatistics'), true);
});

test('GPU batching prevents histogram and correction atomics from wrapping on large frames', () => {
  const maximumPairs = MAX_GPU_BOND_STATISTICS_NEIGHBORS * (MAX_GPU_BOND_STATISTICS_NEIGHBORS - 1) / 2;
  for (const count of [1, 10, 1000, 1_000_000, 0xffff_ffff]) {
    const batch = bondStatisticsGpuBatchSize(count);
    assert.ok(batch <= count && batch <= GPU_BOND_STATISTICS_BATCH_ATOMS);
    assert.ok(batch * maximumPairs <= 0xffff_ffff, 'a bin receiving every angle cannot wrap uint32');
    assert.ok(batch * (maximumPairs + MAX_GPU_BOND_STATISTICS_NEIGHBORS) <= 0xffff_ffff, 'the full precision-record counter cannot wrap uint32');
  }
});
