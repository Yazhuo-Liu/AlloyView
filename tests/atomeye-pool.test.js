import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { calculateBonds } from '../src/analysis/bonds.js';
import { calculateRdf } from '../src/analysis/rdf.js';
import { calculateLocalShear } from '../src/analysis/local-shear.js';
import { calculateReferenceStrain, REFERENCE_STRAIN_FIELDS } from '../src/analysis/reference-strain.js';
import { crystalFrame } from './helpers/crystals.js';

function workerFactory(stats) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    stats.created += 1; stats.active += 1; stats.maximum = Math.max(stats.maximum, stats.active);
    return { addEventListener(name, listener) { worker.on(name, (data) => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfers) { worker.postMessage(data, transfers); },
      terminate() { stats.active -= 1; worker.terminate(); } };
  };
}

test('parallel bond, RDF and geometric shear tasks share the six-worker budget and retain warm workers', async () => {
  const stats = { created: 0, active: 0, maximum: 0 };
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 16 } }, workerFactory: workerFactory(stats) });
  const frame = crystalFrame('sc', 17), phases = [];
  try {
    const [bonds, rdf, shear] = await Promise.all([
      pool.analyze(frame, { kind: 'bonds', cutoff: 4.01 }),
      pool.analyze(frame, { kind: 'rdf', cutoff: 4.01, bins: 32 }),
      pool.analyze(frame, { kind: 'localShear', cutoff: 4.01 }, { onProgress: (update) => phases.push(update) }),
    ]);
    assert.equal(bonds.workerCount, 2); assert.equal(rdf.workerCount, 2); assert.equal(shear.workerCount, 2);
    const directBonds = calculateBonds(frame, { cutoff: 4.01 });
    for (const name of ['indices', 'vectors', 'shifts', 'coordination']) assert.deepEqual(bonds[name], directBonds[name], name);
    assert.deepEqual(bonds.histogram, [{ coordination: 6, count: frame.types.length }]);
    assert.equal(bonds.meanCoordination, 6);
    const directRdf = calculateRdf(frame, { cutoff: 4.01, bins: 32 });
    for (const name of ['counts', 'values', 'radii', 'normalization']) assert.deepEqual(rdf[name], directRdf[name], name);
    assert.ok(shear.localShear.every((value) => Math.abs(value) < 1e-7));
    assert.equal(shear.coordinationMode, 6);
    assert.equal(stats.maximum, 6);
    assert.equal(pool.active.size, 0);
    assert.ok(phases.every((update, index) => !index || update.completedAtoms >= phases[index - 1].completedAtoms));
    assert.equal(phases.at(-1).completedAtoms, frame.types.length * 3);
    assert.deepEqual([...new Set(phases.map((update) => update.stage))], [0, 1, 2]);
    const created = stats.created;
    await pool.analyze(crystalFrame('fcc', 2), { kind: 'cna' });
    await pool.analyze(crystalFrame('bcc', 2), { kind: 'ptm' });
    assert.equal(stats.created, created, 'CNA and PTM reuse workers warmed by the new analyses');
    assert.ok(frame.fractional.byteLength > 0 && frame.types.byteLength > 0);
  } finally { pool.close(); }
  assert.equal(stats.active, 0);
});

test('geometric shear global reductions reproduce a distorted triclinic frame in copied and shared modes', async () => {
  const frame = crystalFrame('hcp', 14);
  frame.cell.vectors[0] *= 1.1;
  frame.fractional[0] += .01;
  const direct = calculateLocalShear(frame, { cutoff: 4.6, subtractMean: true });
  for (const sharedMemory of [false, true]) {
    const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: sharedMemory },
      workerFactory: workerFactory({ created: 0, active: 0, maximum: 0 }) });
    try {
      const result = await pool.analyze(frame, { kind: 'localShear', cutoff: 4.6, subtractMean: true });
      assert.equal(result.workerCount, 2);
      assert.equal(result.sharedMemory, sharedMemory);
      assert.equal(result.coordinationMode, direct.coordinationMode);
      assert.deepEqual(result.coordination, direct.coordination);
      assert.ok(Math.abs(result.normalization - direct.normalization) < 1e-9);
      for (let atom = 0; atom < direct.localShear.length; atom += 1) assert.ok(Math.abs(result.localShear[atom] - direct.localShear[atom]) < 1e-6);
    } finally { pool.close(); }
  }
});

test('reference-strain Workers copy immutable mappings and reference coordinates in both memory modes', async () => {
  const reference = crystalFrame('fcc', 11), frame = { ...reference, fractional: reference.fractional.slice(),
    cell: { ...reference.cell, vectors: reference.cell.vectors.slice() } };
  // Application frame metadata is GPU-cache-only. This deliberately cannot be
  // structured-cloned, so CPU routing proves that metadata is stripped.
  reference.displayOnlyCallback = () => {};
  frame.cell.vectors[0] *= 1.1;
  const mapping = Int32Array.from({ length: frame.types.length }, (_, index) => index);
  const parameters = { referenceFractional: reference.fractional, referenceCell: reference.cell, referenceMapping: mapping, cutoff: 3 };
  const original = reference.fractional.slice(), direct = calculateReferenceStrain(frame, parameters);
  for (const sharedMemory of [false, true]) {
    const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: sharedMemory },
      workerFactory: workerFactory({ created: 0, active: 0, maximum: 0 }) });
    try {
      const result = await pool.analyze(frame, { kind: 'referenceStrain', ...parameters,
        referenceFrame: reference, referenceFrameIndex: 0 });
      assert.equal(result.workerCount, 2);
      assert.equal(result.sharedMemory, sharedMemory);
      for (const field of REFERENCE_STRAIN_FIELDS) assert.deepEqual(result[field], direct[field], field);
      assert.deepEqual(reference.fractional, original);
      assert.ok(mapping.every((value, index) => value === index));
      assert.equal(result.warning, null);
    } finally { pool.close(); }
  }
});

test('global bond output cap rejects even when each worker partial fits separately', async () => {
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 } },
    workerFactory: workerFactory({ created: 0, active: 0, maximum: 0 }) });
  try {
    await assert.rejects(pool.analyze(crystalFrame('sc', 17), { kind: 'bonds', cutoff: 4.01, maxBonds: 10_000 }), /exceeds 10,000/);
    const result = await pool.analyze(crystalFrame('sc', 2), { kind: 'bonds', cutoff: 4.01 });
    assert.equal(result.count, 24);
  } finally { pool.close(); }
});

test('cancelling geometric shear prevents finalization and returns its bounded Worker after ACK', async () => {
  const stats = { created: 0, active: 0, maximum: 0 }, controller = new AbortController();
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 2 } }, workerFactory: workerFactory(stats) });
  let cancelled = null;
  const phases = [];
  const first = pool.analyze(crystalFrame('fcc', 16), { kind: 'localShear', cutoff: 3 }, {
    signal: controller.signal, onProgress(update) {
      phases.push(update);
      if (update.stage === 1 && update.completedAtoms > update.totalAtoms / 3 && update.completedAtoms < update.totalAtoms * 2 / 3) {
        cancelled = update; controller.abort();
      }
    },
  });
  const nextFrame = crystalFrame('fcc', 2);
  const second = pool.analyze(nextFrame, { kind: 'rdf', cutoff: 3, bins: 16 });
  try {
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    assert.equal(firstResult.status, 'rejected'); assert.equal(firstResult.reason.name, 'AbortError');
    assert.ok(cancelled);
    assert.ok(phases.every((update) => update.stage < 2));
    assert.equal(secondResult.status, 'fulfilled');
    assert.deepEqual(secondResult.value.counts, calculateRdf(nextFrame, { cutoff: 3, bins: 16 }).counts);
    const deadline = performance.now() + 5000;
    while (pool.active.size && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(pool.active.size, 0); assert.equal(pool.queue.length, 0); assert.equal(pool.controllers.size, 0);
    assert.equal(stats.created, 1, 'cancellation preserves the resident Worker');
    assert.equal(stats.maximum, 1);
  } finally { pool.close(); }
  assert.equal(stats.active, 0);
});
