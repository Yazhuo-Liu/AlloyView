import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { calculateLocalShear, calculateLocalShearCoordination, calculateLocalShearMetrics,
  calculateLocalShearPreparation, finalizeLocalShear, modalCoordination, shearInvariant } from '../src/analysis/local-shear.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { crystalFrame } from './helpers/crystals.js';

const fields = ['coordination', 'localShear', 'coordinationMode', 'normalization', 'meanMetric', 'averageCoordination', 'averageShear'];
function finish(coordination, metrics, parameters, count) {
  const normalization = metrics.normalizationParticipants ? metrics.normalizationSum / metrics.normalizationParticipants / 3 : NaN;
  const meanMetric = metrics.metricSum.map(value => value / count / normalization);
  return { ...finalizeLocalShear(metrics.metrics, { ...parameters, normalization, meanMetric }),
    coordination: coordination.coordination, coordinationMode: modalCoordination(coordination.histogram), normalization, meanMetric,
    averageCoordination: coordination.coordinationSum / count, averageShear: shearInvariant(meanMetric) };
}
function twoPass(frame, parameters) {
  const coordination = calculateLocalShearCoordination(frame, parameters);
  return finish(coordination, calculateLocalShearMetrics(frame, { ...parameters, coordinationMode: modalCoordination(coordination.histogram) }),
    parameters, frame.fractional.length / 3);
}
function identical(actual, expected) {
  for (const field of fields) {
    if (typeof expected[field] === 'number') assert.ok(Object.is(actual[field], expected[field]), field);
    else {
      assert.equal(actual[field].length, expected[field].length, field);
      for (let i = 0; i < expected[field].length; i++) assert.ok(Object.is(actual[field][i], expected[field][i]), `${field}[${i}]`);
    }
  }
}
function instrument(frame) {
  const search = new NeighborSearch(frame), collect = search.collect.bind(search);
  let queries = 0;
  return { frame: { ...frame, neighborSearch: Object.assign(search, { collect(...args) { queries++; return collect(...args); } }) },
    queries: () => queries, reset: () => { queries = 0; } };
}

test('verified dominant shells eliminate the second enumeration with bit-identical results', () => {
  for (const [kind, cutoff] of [['fcc', 3], ['bcc', 3.5], ['sc', .01]]) {
    const source = crystalFrame(kind, 5); source.fractional[4] += .001;
    const measured = instrument(source), parameters = { cutoff, subtractMean: true };
    const expected = twoPass(measured.frame, parameters);
    assert.equal(measured.queries(), 2 * source.types.length);
    measured.reset();
    const actual = calculateLocalShear(measured.frame, parameters);
    identical(actual, expected);
    assert.equal(measured.queries(), source.types.length + 64);
  }
});

function syntheticFrame(counts) {
  const frame = crystalFrame('sc', 1);
  frame.fractional = new Float64Array(counts.length * 3);
  frame.neighborSearch = { collect(atom, cutoff, buffer) {
    buffer.reserve(counts[atom]); buffer.length = counts[atom];
    for (let i = 0; i < buffer.length; i++) {
      buffer.atoms[i] = i; buffer.xs[i] = (i + 1) * .01; buffer.ys[i] = (atom % 5 + 1) * .03; buffer.zs[i] = (i % 3) * .02;
      buffer.distanceSquared[i] = buffer.xs[i] ** 2 + buffer.ys[i] ** 2 + buffer.zs[i] ** 2;
    }
  } };
  return frame;
}

test('adversarial pilot, tied populations, and mixed shells use the full histogram', () => {
  for (const counts of [
    Array.from({ length: 256 }, (_, i) => i % 4 ? 8 : 12), // Every pilot site disagrees with the true mode.
    Array.from({ length: 256 }, (_, i) => i < 128 ? 12 : 8), // Modal tie chooses the smaller coordination.
    Array.from({ length: 256 }, (_, i) => 6 + i % 5),
  ]) {
    const frame = syntheticFrame(counts), parameters = { cutoff: 1, subtractMean: true };
    const prepared = calculateLocalShearPreparation(frame, parameters);
    assert.notEqual(prepared.candidateCoordinationMode, modalCoordination(prepared.histogram));
    if (prepared.candidateCoordinationMode < 0) assert.equal(prepared.metrics.length, 0, 'mixed pilot does not send discarded tensor rows');
    identical(calculateLocalShear(frame, parameters), twoPass(frame, parameters));
  }
});

test('a locally rejected candidate remains rejected after chunk migration even when it is the true global mode', () => {
  const frame = syntheticFrame(Array.from({ length: 512 }, (_, i) => i < 128 ? 8 : 12));
  const parameters = { cutoff: 1, subtractMean: true };
  const first = calculateLocalShearPreparation(frame, { ...parameters, startAtom: 0, endAtom: 128 });
  assert.equal(first.candidateCoordinationMode, -1);
  assert.equal(first.candidateMetricsAborted, true);
  assert.equal(first.metrics.length, 0);
  const migrated = calculateLocalShearPreparation(frame, { ...parameters, startAtom: 128, endAtom: 256, reductionInput: first });
  assert.equal(migrated.candidateCoordinationMode, -1);
  assert.equal(migrated.metrics.length, 0);
  const otherPartition = calculateLocalShearPreparation(frame, { ...parameters, startAtom: 256, endAtom: 512 });
  assert.equal(otherPartition.candidateCoordinationMode, 12);
  assert.equal(modalCoordination(calculateLocalShearCoordination(frame, parameters).histogram), 12);
  identical(calculateLocalShear(frame, parameters), twoPass(frame, parameters));
  const late = syntheticFrame(Array.from({ length: 512 }, (_, i) => i < 384 ? 12 : 8));
  assert.equal(calculateLocalShearPreparation(late, { ...parameters, endAtom: 256 }).candidateCoordinationMode, 12);
  assert.equal(calculateLocalShearPreparation(late, { ...parameters, startAtom: 256 }).candidateCoordinationMode, -1);
  identical(calculateLocalShear(late, parameters), twoPass(late, parameters));
});

function workerFactory() {
  const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
  return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
    postMessage(data, transfers) { worker.postMessage(data, transfers); }, terminate() { void worker.terminate(); } };
}

test('migration from a cold pilot to a different verified mode discards the whole partition', () => {
  const counts = Array.from({ length: 512 }, (_, i) => i < 128 || i % 8 === 0 ? 12 : 8);
  const cold = { ...syntheticFrame(counts), immutableAnalysisFrame: true };
  const hot = { ...syntheticFrame(counts), immutableAnalysisFrame: true };
  const parameters = { cutoff: 1, subtractMean: true };
  const coordination = calculateLocalShearCoordination(hot, parameters);
  const coordinationMode = modalCoordination(coordination.histogram);
  assert.equal(coordinationMode, 8);
  calculateLocalShearMetrics(hot, { ...parameters, coordinationMode, verifiedCoordinationMode: true });
  const first = calculateLocalShearPreparation(cold, { ...parameters, endAtom: 128 });
  assert.equal(first.candidateCoordinationMode, 12);
  assert.equal(first.candidateMetricsAborted, false);
  const migrated = calculateLocalShearPreparation(hot, { ...parameters, startAtom: 128, reductionInput: first });
  assert.equal(modalCoordination(migrated.histogram), 8);
  assert.equal(migrated.candidateCoordinationMode, -1);
  assert.equal(migrated.candidateMetricsAborted, true);
  assert.equal(migrated.metrics.length, 0);
  assert.deepEqual(migrated.histogram, coordination.histogram);
  identical(calculateLocalShear(hot, parameters), twoPass(hot, parameters));
});

test('fused and mixed fallback Workers preserve the original reduction partitions in private and shared modes', async () => {
  const parameters = { cutoff: 3.15, subtractMean: true };
  for (const [noise, fused, noisyFraction, noisyOffset = 0] of [[.001, true, 1], [.02, false, 1],
    [.02, false, 1 / 8], [.02, false, 1 / 8, .75]]) for (const sharedMemory of [false, true]) {
    const frame = crystalFrame('fcc', 11);
    for (let i = Math.floor(frame.fractional.length * noisyOffset); i < frame.fractional.length * (noisyOffset + noisyFraction); i++) {
      frame.fractional[i] += Math.sin(i * 137) * noise;
    }
    const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: sharedMemory }, workerFactory });
    try {
      const coordination = await pool.analyzeCPU(frame, { ...parameters, kind: 'localShearCoordination' });
      const metrics = await pool.analyzeCPU(frame, { ...parameters, kind: 'localShearMetrics', coordinationMode: modalCoordination(coordination.histogram) });
      assert.equal(metrics.workerCount, 2);
      const expected = finish(coordination, metrics, parameters, frame.types.length);
      const actual = await pool.analyze(frame, { ...parameters, kind: 'localShear' });
      assert.equal(actual.fusedMetrics, fused);
      identical(actual, expected);
      if (!fused) {
        const repeated = await pool.analyze(frame, { ...parameters, kind: 'localShear' });
        assert.equal(repeated.fusedMetrics, true, 'complete-histogram mode is reusable for the same immutable snapshot/cutoff');
        identical(repeated, expected);
        frame.geometryRevision = 1;
        frame.fractional[0] += .0001;
        const changedRevision = await pool.analyze(frame, { ...parameters, kind: 'localShear' });
        assert.equal(changedRevision.fusedMetrics, false, 'a new immutable snapshot cannot inherit the verified mode');
        const revisedCoordination = await pool.analyzeCPU(frame, { ...parameters, kind: 'localShearCoordination' });
        const revisedMetrics = await pool.analyzeCPU(frame, { ...parameters, kind: 'localShearMetrics',
          coordinationMode: modalCoordination(revisedCoordination.histogram) });
        identical(changedRevision, finish(revisedCoordination, revisedMetrics, parameters, frame.types.length));
        const changedCutoff = await pool.analyze(frame, { ...parameters, cutoff: parameters.cutoff + .01, kind: 'localShear' });
        assert.equal(changedCutoff.fusedMetrics, false, 'a new cutoff needs full verification again');
      }
      assert.equal(pool.active.size, 0);
    } finally { pool.close(); }
  }
});

test('fusion declines an admission that would change floating-point reduction partitions', async () => {
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 } }, workerFactory });
  const frame = crystalFrame('fcc', 11), count = frame.types.length;
  let fusionBytes;
  const policy = pool.cpuResidentWorkerPolicy.bind(pool);
  pool.cpuResidentWorkerPolicy = (...args) => {
    const result = policy(...args);
    if (args[4] === 4096 && args[7]?.includeRetainedInputs === false) {
      fusionBytes ??= args[3];
      return { ...result, workerCount: args[3] === fusionBytes ? 1 : 2 };
    }
    return result;
  };
  try {
    assert.deepEqual(await pool.analyzeCPU(frame, { kind: 'localShearMetrics', cutoff: 3, collectCoordination: true }), { fusionUnavailable: true });
    assert.equal(pool.active.size, 0); assert.equal(pool.controllers.size, 0);
    assert.ok(fusionBytes > 8 * count);
  } finally { pool.close(); }
});

test('cold private admission includes the residency created by the original coordination pass', async () => {
  const source = crystalFrame('fcc', 14), count = 10_000;
  const frame = { fractional: source.fractional.slice(0, count * 3), cell: source.cell };
  for (let i = 0; i < frame.fractional.length; i++) {
    const value = frame.fractional[i] + Math.sin(i * 137) * .001;
    frame.fractional[i] = value - Math.floor(value);
  }
  const parameters = { cutoff: 3.15, subtractMean: true };
  const makePool = () => new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 6 },
    performance: { memory: { jsHeapSizeLimit: 6_000_000 } } }, workerFactory });
  const legacy = makePool(), current = makePool();
  try {
    const declined = await current.analyzeCPU(frame, { ...parameters, kind: 'localShearMetrics', collectCoordination: true });
    assert.deepEqual(declined, { fusionUnavailable: true });
    assert.equal(current.slots.size, 0, 'decline before speculative Worker residency');
    const coordination = await legacy.analyzeCPU(frame, { ...parameters, kind: 'localShearCoordination' });
    const metrics = await legacy.analyzeCPU(frame, { ...parameters, kind: 'localShearMetrics', coordinationMode: modalCoordination(coordination.histogram) });
    assert.equal(coordination.workerCount, 1);
    assert.equal(metrics.workerCount, 2, 'old coordination residency reduces the three-worker cold metrics estimate');
    const actual = await current.analyze(frame, { ...parameters, kind: 'localShear' });
    assert.equal(actual.fusedMetrics, false);
    identical(actual, finish(coordination, metrics, parameters, count));
  } finally { legacy.close(); current.close(); }
});
