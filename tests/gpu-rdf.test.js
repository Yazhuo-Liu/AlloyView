import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRdf, rdfNormalization } from '../src/analysis/rdf.js';
import { correctGpuRdfPairs, rdfGpuBatchSize, rdfPrecisionMargin, analyzeGpuRdf } from '../src/analysis/gpu/rdf.js';
import { MAX_NEIGHBORS_PER_ATOM } from '../src/analysis/bonds.js';
import { createCell } from '../src/data/model.js';

function fixture() {
  return {
    fractional: Float64Array.from([.1, .1, .1, .2, .1, .1, .35, .1, .1]),
    types: Uint16Array.from([0, 1, 0]),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }),
  };
}

function directedPairs(count) {
  const pairs = [];
  for (let atom = 0; atom < count; atom += 1) {
    for (let other = 0; other < count; other += 1) if (atom !== other) pairs.push(atom, other);
  }
  return Uint32Array.from(pairs);
}

test('RDF GPU corrections classify shell-boundary pairs with CPU precision and element populations', async () => {
  const frame = fixture();
  for (const selection of [{}, { firstType: 0, secondType: 1 }, { firstType: 0, secondType: 0 }]) {
    const parameters = { cutoff: 4, bins: 4, ...selection };
    const counts = new Float64Array(4);
    await correctGpuRdfPairs(frame, rdfNormalization(frame, parameters), directedPairs(frame.types.length), counts);
    assert.deepEqual(counts, calculateRdf(frame, parameters).counts);
  }
});

test('RDF GPU corrections use exact skew-cell images and wrapping for unwrapped source positions', async () => {
  const frame = {
    fractional: Float64Array.from([3.99, -.99, .3, -2.01, 4.01, .3, .5, .5, .5, .01, .05, .3]),
    types: Uint16Array.from([0, 0, 1, 1]),
    cell: createCell({ vectors: [10, 0, 0, 4, 8, 0, 3, 2, 9], triclinic: true }),
  };
  const parameters = { cutoff: 3.51, bins: 23 };
  const counts = new Float64Array(parameters.bins);
  await correctGpuRdfPairs(frame, rdfNormalization(frame, parameters), directedPairs(frame.types.length), counts);
  assert.deepEqual(counts, calculateRdf(frame, parameters).counts);
});

test('RDF excludes exact-cutoff pairs and self images, retaining distinct overlapping atom IDs', async () => {
  const frame = fixture();
  frame.fractional = Float64Array.from([0, 0, 0, .5, 0, 0, 0, 0, 0]);
  const parameters = { cutoff: 5, bins: 10 };
  const counts = new Float64Array(parameters.bins);
  const pairs = Uint32Array.from([...directedPairs(3), 0, 0, 1, 1, 2, 2]);
  await correctGpuRdfPairs(frame, rdfNormalization(frame, parameters), pairs, counts);
  assert.deepEqual(counts, calculateRdf(frame, parameters).counts);
  assert.equal(counts[0], 2);
  assert.equal(counts.reduce((sum, value) => sum + value, 0), 2);
});

test('RDF batches bound atomic u32 counts for the full 129,904-atom example and dense systems', () => {
  for (const count of [2, 3, 4096, 129_904, 4_000_000]) {
    const batch = rdfGpuBatchSize(count);
    assert.ok(batch >= 1 && batch <= count);
    assert.ok(batch * Math.min(MAX_NEIGHBORS_PER_ATOM, count - 1) <= 0xffff_ffff);
  }
  const frame = fixture();
  const firstMargin = rdfPrecisionMargin(frame, 4);
  assert.ok(firstMargin > 0 && firstMargin < .01);
  frame.cell.vectors[0] *= 100;
  assert.ok(rdfPrecisionMargin(frame, 4) > firstMargin);
});

test('RDF GPU mapping failure and cancellation release temporary buffers', async () => {
  for (const abort of [false, true]) {
    const frame = fixture(), controller = new AbortController();
    const allocated = [], released = [];
    const runtime = {
      async prepareNeighbors() { return {}; },
      createBuffer() { const buffer = {}; allocated.push(buffer); return buffer; },
      storageBuffer() { const buffer = {}; allocated.push(buffer); return buffer; },
      neighborBindings(_context, buffers) { return buffers; },
      async zeroBuffer() {},
      async run() { if (abort) controller.abort(); },
      async read(_buffer, _Type, _length, { signal }) {
        signal.throwIfAborted();
        throw new Error('GPU device lost');
      },
      disposeBuffers(buffers) { released.push(...buffers); },
    };
    await assert.rejects(() => analyzeGpuRdf(runtime, frame, { cutoff: 4, bins: 4 }, { signal: controller.signal }),
      abort ? { name: 'AbortError' } : /GPU device lost/);
    assert.deepEqual(released, allocated);
  }
});

test('RDF type values outside the GPU integer encoding fall back before uploading', async () => {
  const runtime = { prepareNeighbors() { throw new Error('Unexpected GPU upload'); } };
  const frame = fixture();
  frame.types = Float64Array.from([.5, .5, 0]);
  assert.ok(calculateRdf(frame, { cutoff: 4 }).counts.length);
  await assert.rejects(() => analyzeGpuRdf(runtime, frame, { cutoff: 4 }), { name: 'GpuUnavailableError' });
  frame.types = Uint32Array.from([0xffff_ffff, 0, 0]);
  assert.ok(calculateRdf(frame, { cutoff: 4, firstType: 0xffff_ffff }).counts.length);
  await assert.rejects(() => analyzeGpuRdf(runtime, frame, { cutoff: 4, firstType: 0xffff_ffff }), { name: 'GpuUnavailableError' });
});
