import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { accumulateSpatialBins, binIndex, binningGeometry, calculateSpatialBins, finalizeSpatialBins, mergeSpatialBins,
  normalizeBinningLayout, MAX_TOTAL_BINS } from '../src/analysis/spatial-binning.js';
import { SpatialBinningClient } from '../src/binning-client.js';
import { createCell, determinant3, fractionalToCartesian } from '../src/data/model.js';

function random(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

/** Atoms at random reduced coordinates (optionally beyond the cell) and a
 * property with occasional NaN values. */
function randomFrame({ count = 2000, vectors = [20, 0, 0, 0, 16, 0, 0, 0, 12], pbc = [true, true, true], spread = [0, 1], seed = 7, origin = [0, 0, 0] } = {}) {
  const next = random(seed), cell = createCell({ origin, vectors, pbc, triclinic: true });
  const fractional = new Float64Array(count * 3);
  for (let index = 0; index < fractional.length; index++) fractional[index] = spread[0] + next() * (spread[1] - spread[0]);
  const values = Float64Array.from({ length: count }, (_, atom) => atom % 17 === 0 ? NaN : Math.sin(atom) * 3 + next());
  return { fractional, cell, positions: fractionalToCartesian(fractional, cell, new Float64Array(count * 3)),
    ids: Uint32Array.from({ length: count }, (_, atom) => atom + 1), values };
}

/** Independent reference: reduced coordinates from Cartesian positions with
 * reciprocal vectors, per-bin lists in atom order, then plain reductions. */
function bruteForce(frame, { axes, bins, values = null, mask = null, quantity = 'count', reduction = 'mean' }) {
  const h = frame.cell.vectors, row = index => [h[index * 3], h[index * 3 + 1], h[index * 3 + 2]];
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const det = determinant3(h), volume = Math.abs(det);
  const reciprocal = [0, 1, 2].map(axis => cross(row((axis + 1) % 3), row((axis + 2) % 3)).map(value => value / det));
  const binCount = bins.reduce((product, count) => product * count, 1), lists = Array.from({ length: binCount }, () => []);
  const counts = new Float64Array(binCount), skipped = new Float64Array(binCount);
  let outside = 0;
  for (let atom = 0; atom < frame.positions.length / 3; atom++) {
    if (mask && !mask[atom]) continue;
    const relative = [0, 1, 2].map(component => frame.positions[atom * 3 + component] - frame.cell.origin[component]);
    const indices = axes.map((axis, dimension) => {
      let s = relative.reduce((sum, value, component) => sum + value * reciprocal[axis][component], 0);
      if (frame.cell.pbc[axis]) s -= Math.floor(s);
      else if (s < 0 || s > 1) return -1;
      return Math.min(bins[dimension] - 1, Math.floor(s * bins[dimension]));
    });
    if (indices.some(index => index < 0)) { outside++; continue; }
    const bin = indices.length === 1 ? indices[0] : indices[0] * bins[1] + indices[1];
    counts[bin]++;
    if (!values) continue;
    if (Number.isFinite(values[atom])) lists[bin].push(values[atom]); else skipped[bin]++;
  }
  const output = new Float64Array(binCount);
  for (let bin = 0; bin < binCount; bin++) {
    const list = lists[bin];
    if (quantity === 'count') { output[bin] = counts[bin]; continue; }
    if (quantity === 'density') { output[bin] = counts[bin] / (volume / binCount); continue; }
    let sum = 0;
    for (const value of list) sum += value;
    if (reduction === 'sum') { output[bin] = sum; continue; }
    if (!list.length) { output[bin] = NaN; continue; }
    const mean = sum / list.length;
    if (reduction === 'mean') output[bin] = mean;
    else if (reduction === 'min') { let value = Infinity; for (const entry of list) if (entry < value) value = entry; output[bin] = value; }
    else if (reduction === 'max') { let value = -Infinity; for (const entry of list) if (entry > value) value = entry; output[bin] = value; }
    else { let squares = 0; for (const value of list) squares += (value - mean) ** 2; output[bin] = Math.sqrt(squares / list.length); }
  }
  return { values: output, counts, skipped, outside };
}

function assertIdentical(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let index = 0; index < expected.length; index++) {
    assert.ok(Object.is(actual[index], expected[index]), `${label}[${index}]: ${actual[index]} !== ${expected[index]}`);
  }
}

const QUANTITIES = [['count'], ['density'], ...['mean', 'sum', 'min', 'max', 'stddev'].map(reduction => ['property', reduction])];

test('orthogonal profiles and maps equal a brute-force reference for every quantity', () => {
  const frame = randomFrame({ origin: [-5, 3, 1] });
  for (const [axes, bins] of [[[0], [7]], [[2], [1]], [[1], [40]], [[0, 2], [5, 3]], [[2, 1], [4, 6]]]) {
    for (const [quantity, reduction] of QUANTITIES) {
      const result = calculateSpatialBins(frame, { axes, bins, quantity, reduction, values: frame.values });
      const expected = bruteForce(frame, { axes, bins, values: frame.values, quantity, reduction });
      const label = `${axes}/${bins} ${quantity} ${reduction ?? ''}`;
      assertIdentical(result.values, expected.values, label);
      assertIdentical(result.counts, expected.counts, `${label} counts`);
      if (quantity === 'property') assertIdentical(result.skipped, expected.skipped, `${label} skipped`);
      assert.equal(result.totals.binned, frame.ids.length);
    }
  }
});

test('triclinic cells bin in reduced coordinates: equal-volume slabs parallel to the other vectors', () => {
  const vectors = [18, 0, 0, 6, 15, 0, -4, 3, 11];
  const frame = randomFrame({ vectors, seed: 11, origin: [2, -1, 4] });
  for (const [axes, bins] of [[[0], [9]], [[1], [5]], [[2], [12]], [[0, 1], [6, 4]], [[1, 2], [3, 8]]]) {
    for (const [quantity, reduction] of QUANTITIES) {
      const result = calculateSpatialBins(frame, { axes, bins, quantity, reduction, values: frame.values });
      const expected = bruteForce(frame, { axes, bins, values: frame.values, quantity, reduction });
      assertIdentical(result.values, expected.values, `triclinic ${axes} ${quantity} ${reduction}`);
    }
  }
  const geometry = binningGeometry(frame.cell, { axes: [2], bins: [10] });
  const volume = Math.abs(determinant3(vectors));
  assert.equal(geometry.cellVolume, volume);
  assert.equal(geometry.binVolume, volume / 10);
  assert.equal(geometry.axisLengths[0], Math.hypot(-4, 3, 11));
  // The plane spacing along c is the cell height V / |a × b|, shorter than |c|.
  assert.ok(Math.abs(geometry.heights[0] - volume / Math.hypot(0, 0, 18 * 15)) < 1e-12);
  assert.ok(geometry.heights[0] < geometry.axisLengths[0]);
  const map = binningGeometry(frame.cell, { axes: ['a', 'b'], bins: [2, 2] });
  assert.ok(Math.abs(map.angle - Math.acos(6 / Math.hypot(6, 15)) * 180 / Math.PI) < 1e-9);
});

test('number density uses the true bin volume in atoms per cubic ångström', () => {
  // A 10 × 10 × 10 simple cubic crystal with a 2 Å lattice parameter.
  const repeat = 10, cell = createCell({ vectors: [20, 0, 0, 0, 20, 0, 0, 0, 20] });
  const fractional = new Float64Array(repeat ** 3 * 3);
  let cursor = 0;
  for (let i = 0; i < repeat; i++) for (let j = 0; j < repeat; j++) for (let k = 0; k < repeat; k++) {
    fractional[cursor++] = (i + 0.5) / repeat; fractional[cursor++] = (j + 0.5) / repeat; fractional[cursor++] = (k + 0.5) / repeat;
  }
  const frame = { fractional, cell };
  const profile = calculateSpatialBins(frame, { axes: [1], bins: [5], quantity: 'density' });
  assert.deepEqual([...profile.values], Array(5).fill(0.125));
  assert.deepEqual([...profile.counts], Array(5).fill(200));
  assert.equal(profile.binVolume, 1600);
  const map = calculateSpatialBins(frame, { axes: [0, 2], bins: [10, 5], quantity: 'density' });
  assert.equal(map.binVolume, 160);
  assert.ok(map.values.every(value => value === 0.125));
  // Density summed over bins times the bin volume recovers the binned atoms.
  const tilted = randomFrame({ vectors: [10, 0, 0, 3, 9, 0, 1, 2, 8], seed: 3 });
  const density = calculateSpatialBins(tilted, { axes: [0, 1], bins: [3, 7], quantity: 'density' });
  const recovered = density.values.reduce((sum, value) => sum + value * density.binVolume, 0);
  assert.ok(Math.abs(recovered - tilted.ids.length) < 1e-9);
});

test('periodic directions wrap, including values that round up to 1', () => {
  assert.equal(binIndex(-0.25, 4, true), 3);
  assert.equal(binIndex(1.25, 4, true), 1);
  assert.equal(binIndex(1, 4, true), 0);
  assert.equal(binIndex(-1e-17, 4, true), 3, 'a tiny negative coordinate wraps to the top bin');
  assert.equal(binIndex(1 - 2 ** -53, 3, true), 2);
  assert.equal(binIndex(NaN, 4, true), -2);
  assert.equal(binIndex(Infinity, 4, false), -2);
  const frame = randomFrame({ spread: [-2, 3], seed: 5 });
  for (const [quantity, reduction] of QUANTITIES) {
    const result = calculateSpatialBins(frame, { axes: [0, 1], bins: [4, 5], quantity, reduction, values: frame.values });
    assertIdentical(result.values, bruteForce(frame, { axes: [0, 1], bins: [4, 5], values: frame.values, quantity, reduction }).values, `wrapped ${quantity}`);
    assert.equal(result.totals.outside, 0);
  }
});

test('open directions use the cell extent, include its upper face and report atoms outside', () => {
  assert.equal(binIndex(1, 4, false), 3);
  assert.equal(binIndex(0, 4, false), 0);
  assert.equal(binIndex(-1e-9, 4, false), -1);
  assert.equal(binIndex(1 + 1e-9, 4, false), -1);
  const frame = randomFrame({ pbc: [false, true, false], spread: [-0.5, 1.5], seed: 9 });
  const result = calculateSpatialBins(frame, { axes: [0], bins: [8], quantity: 'count' });
  const expected = bruteForce(frame, { axes: [0], bins: [8] });
  assertIdentical(result.counts, expected.counts, 'open counts');
  assert.equal(result.totals.outside, expected.outside);
  assert.ok(result.totals.outside > 0);
  assert.equal(result.totals.binned + result.totals.outside, frame.ids.length);
  // Periodic b wraps every atom into the cell.
  assert.equal(calculateSpatialBins(frame, { axes: [1], bins: [8] }).totals.outside, 0);
  const map = calculateSpatialBins(frame, { axes: [0, 2], bins: [3, 3], quantity: 'density' });
  assert.equal(map.totals.outside, bruteForce(frame, { axes: [0, 2], bins: [3, 3] }).outside);
});

test('reductions skip and count non-finite values; empty bins report NaN statistics', () => {
  const cell = createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] });
  // Bin 0: 1, 2, NaN, 6 · bin 1: NaN, Infinity · bin 2: empty · bin 3: -4.
  const fractional = Float64Array.from([0.1, 0.5, 0.5, 0.2, 0.5, 0.5, 0.05, 0.5, 0.5, 0.15, 0.5, 0.5,
    0.3, 0.5, 0.5, 0.4, 0.5, 0.5, 0.9, 0.5, 0.5]);
  const values = Float64Array.from([1, 2, NaN, 6, NaN, Infinity, -4]);
  const frame = { fractional, cell };
  const reduce = reduction => calculateSpatialBins(frame, { axes: [0], bins: [4], quantity: 'property', reduction, values });
  const mean = reduce('mean');
  assert.deepEqual([...mean.counts], [4, 2, 0, 1]);
  assert.deepEqual([...mean.skipped], [1, 2, 0, 0]);
  assert.equal(mean.totals.skipped, 3);
  assert.deepEqual([...mean.values], [3, NaN, NaN, -4]);
  assert.deepEqual([...reduce('sum').values], [9, 0, 0, -4]);
  assert.deepEqual([...reduce('min').values], [1, NaN, NaN, -4]);
  assert.deepEqual([...reduce('max').values], [6, NaN, NaN, -4]);
  const deviation = reduce('stddev').values;
  assert.ok(Math.abs(deviation[0] - Math.sqrt(14 / 3)) < 1e-15);
  assert.deepEqual([...deviation.subarray(1)], [NaN, NaN, 0]);
  const counts = calculateSpatialBins(frame, { axes: [0], bins: [4], quantity: 'count' });
  assert.deepEqual([...counts.values], [4, 2, 0, 1]);
  assert.deepEqual([...counts.skipped], [0, 0, 0, 0], 'count and density do not read values');
});

test('selection masks restrict the binned population', () => {
  const frame = randomFrame({ seed: 21 });
  const mask = Uint8Array.from({ length: frame.ids.length }, (_, atom) => atom % 3 === 0 ? 1 : 0);
  for (const [quantity, reduction] of QUANTITIES) {
    const result = calculateSpatialBins(frame, { axes: [2, 0], bins: [6, 2], quantity, reduction, values: frame.values, mask });
    assertIdentical(result.values, bruteForce(frame, { axes: [2, 0], bins: [6, 2], values: frame.values, mask, quantity, reduction }).values, `masked ${quantity}`);
    assert.equal(result.totals.selected, Math.ceil(frame.ids.length / 3));
    assert.equal(result.totals.excluded, frame.ids.length - result.totals.selected);
  }
});

test('frame averages pool samples and average per-frame counts, densities and sums', () => {
  const first = randomFrame({ count: 500, seed: 1 }), second = randomFrame({ count: 800, seed: 2, vectors: [22, 0, 0, 0, 16, 0, 0, 0, 12] });
  const options = { axes: [0], bins: [6], stddev: true };
  const merged = mergeSpatialBins(mergeSpatialBins(null, accumulateSpatialBins(first, { ...options, values: first.values })),
    accumulateSpatialBins(second, { ...options, values: second.values }));
  assert.equal(merged.frames, 2);
  const count = finalizeSpatialBins(merged, { quantity: 'count' }), density = finalizeSpatialBins(merged, { quantity: 'density' });
  const single = [first, second].map(frame => calculateSpatialBins(frame, { axes: [0], bins: [6], quantity: 'density' }));
  for (let bin = 0; bin < 6; bin++) {
    assert.equal(count.values[bin], (single[0].counts[bin] + single[1].counts[bin]) / 2);
    assert.ok(Math.abs(density.values[bin] - (single[0].values[bin] + single[1].values[bin]) / 2) < 1e-15);
  }
  assert.equal(count.axisLengths[0], 21);
  // Pooled statistics over both frames' finite samples.
  const pooled = { fractional: Float64Array.from([...first.fractional, ...second.fractional]), cell: first.cell };
  const values = Float64Array.from([...first.values, ...second.values]);
  for (const reduction of ['mean', 'min', 'max', 'stddev']) {
    const direct = calculateSpatialBins(pooled, { axes: [0], bins: [6], quantity: 'property', reduction, values });
    const average = finalizeSpatialBins(merged, { quantity: 'property', reduction });
    for (let bin = 0; bin < 6; bin++) assert.ok(Math.abs(average.values[bin] - direct.values[bin]) < 1e-12, `${reduction} ${bin}`);
  }
  const sum = finalizeSpatialBins(merged, { quantity: 'property', reduction: 'sum' });
  const pooledSum = calculateSpatialBins(pooled, { axes: [0], bins: [6], quantity: 'property', reduction: 'sum', values });
  for (let bin = 0; bin < 6; bin++) assert.ok(Math.abs(sum.values[bin] - pooledSum.values[bin] / 2) < 1e-12);
  // One frame through the merge path is the single-frame result.
  const once = finalizeSpatialBins(mergeSpatialBins(null, accumulateSpatialBins(first, { ...options, values: first.values })), { quantity: 'property', reduction: 'stddev' });
  assertIdentical(once.values, calculateSpatialBins(first, { axes: [0], bins: [6], quantity: 'property', reduction: 'stddev', values: first.values }).values, 'single merge');
  assert.throws(() => mergeSpatialBins(merged, accumulateSpatialBins(first, { axes: [1], bins: [6] })), /different layouts/);
});

test('layouts reject invalid vectors and bin counts', () => {
  assert.deepEqual(normalizeBinningLayout({ axes: ['c', 'a'], bins: [3, 4] }), { axes: [2, 0], bins: [3, 4], binCount: 12 });
  assert.throws(() => normalizeBinningLayout({ axes: [0, 0], bins: [2, 2] }), /two different/);
  assert.throws(() => normalizeBinningLayout({ axes: ['d'], bins: [2] }), /a, b or c/);
  assert.throws(() => normalizeBinningLayout({ axes: [0], bins: [0] }), /1–4,096 bins/);
  assert.throws(() => normalizeBinningLayout({ axes: [0], bins: [2.5] }), /bins/);
  assert.throws(() => normalizeBinningLayout({ axes: [0, 1], bins: [4096, 4096] }), new RegExp(`${MAX_TOTAL_BINS.toLocaleString('en-US')}`));
  const frame = randomFrame({ count: 10 });
  assert.throws(() => accumulateSpatialBins(frame, { axes: [0], bins: [2], values: new Float64Array(3) }), /one value per atom/);
  assert.throws(() => finalizeSpatialBins(accumulateSpatialBins(frame, { axes: [0], bins: [2] }), { quantity: 'property' }), /Choose a property/);
});

function nodeWorkerFactory(created) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-binning-worker.mjs', import.meta.url));
    created.push(worker);
    return {
      addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfer) { worker.postMessage(data, transfer); },
      terminate() { void worker.terminate(); },
    };
  };
}

test('a real Worker returns results identical to the direct kernel and keeps source arrays', async t => {
  const created = [];
  const client = new SpatialBinningClient({ createWorker: nodeWorkerFactory(created), workerMinAtoms: 1 });
  t.after(() => client.dispose());
  const frame = randomFrame({ count: 5000, vectors: [18, 0, 0, 6, 15, 0, -4, 3, 11], pbc: [true, false, true], spread: [-0.2, 1.2], seed: 31 });
  const mask = Uint8Array.from({ length: 5000 }, (_, atom) => atom % 5 ? 1 : 0);
  for (const request of [{ axes: [0], bins: [37] }, { axes: [1, 2], bins: [9, 11], values: frame.values, stddev: true },
    { axes: [2], bins: [64], values: frame.values, mask, stddev: true }]) {
    const direct = accumulateSpatialBins(frame, request);
    const remote = await client.accumulate(frame, request);
    for (const name of ['counts', 'valid', 'skipped', 'sum', 'min', 'max', 'm2', 'densitySum']) {
      if (direct[name] === null) assert.equal(remote[name], null);
      else assertIdentical(remote[name], direct[name], `Worker ${name}`);
    }
    assert.deepEqual(remote.totals, direct.totals);
    for (const reduction of ['mean', 'sum', 'min', 'max', 'stddev']) {
      if (!request.values || (reduction === 'stddev' && !request.stddev)) continue;
      assertIdentical(finalizeSpatialBins(remote, { quantity: 'property', reduction }).values,
        finalizeSpatialBins(direct, { quantity: 'property', reduction }).values, `Worker ${reduction}`);
    }
  }
  assert.equal(created.length, 1, 'one Worker keeps the frame resident');
  assert.equal(frame.values.length, 5000, 'values are copied, not transferred');
  assert.equal(frame.fractional.length, 15000);
  // Cancelling terminates the Worker; the next request starts another one.
  const controller = new AbortController();
  const pending = client.accumulate(frame, { axes: [0], bins: [3] }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const inFlight = new AbortController();
  const running = client.accumulate(frame, { axes: [1], bins: [3] }, { signal: inFlight.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(client.pending.size, 1);
  inFlight.abort();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(client.worker, null);
  assertIdentical((await client.accumulate(frame, { axes: [0], bins: [3] })).counts, accumulateSpatialBins(frame, { axes: [0], bins: [3] }).counts, 'after cancel');
  assert.equal(created.length, 2, "only the in-flight cancellation replaced the Worker");
});

test('small frames bin directly; without Worker support every frame does', async () => {
  let created = 0;
  const client = new SpatialBinningClient({ createWorker: () => { created++; throw new Error('unused'); }, workerMinAtoms: 100 });
  const frame = randomFrame({ count: 50 });
  assert.equal(client.usesWorker(frame), false);
  const result = await client.accumulate(frame, { axes: [0], bins: [4] });
  assert.equal(result.totals.binned, 50);
  assert.equal(created, 0);
  const plain = new SpatialBinningClient({ createWorker: null, workerMinAtoms: 1 });
  assert.equal(plain.usesWorker(frame), false);
  plain.warm();
  await assert.rejects(plain.accumulate(frame, { axes: [0], bins: [4] }, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
