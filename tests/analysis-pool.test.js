import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { calculateCna } from '../src/analysis/cna.js';
import { calculateCentrosymmetry } from '../src/analysis/centrosymmetry.js';
import { calculateCoordination } from '../src/analysis/coordination.js';
import { calculatePtm, PTM_FIELDS } from '../src/analysis/ptm.js';
import { calculateAtomicStrain, STRAIN_FIELDS } from '../src/analysis/atomic-strain.js';
import { crystalFrame } from './helpers/crystals.js';

function nodeFactory(stats) {
  return () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    stats.active += 1;
    stats.maximum = Math.max(stats.maximum, stats.active);
    return {
      addEventListener(name, listener) {
        worker.on(name, (data) => listener(name === 'message' ? { data } : data));
      },
      postMessage(data) { worker.postMessage(data); },
      terminate() { stats.active -= 1; worker.terminate(); },
    };
  };
}

test('real Worker ranges merge correctly across concurrent CNA, CSP and coordination jobs', async () => {
  const stats = { active: 0, maximum: 0 };
  const environment = { navigator: { hardwareConcurrency: 4 }, performance: {}, crossOriginIsolated: false };
  const pool = new AnalysisPool({ environment, workerFactory: nodeFactory(stats) });
  const frame = crystalFrame('fcc', 11);
  try {
    const [cna, csp, coordination] = await Promise.all([
      pool.analyze(frame, { kind: 'cna' }),
      pool.analyze(frame, { kind: 'centrosymmetry', neighbors: 12 }),
      pool.analyze(frame, { kind: 'coordination', cutoff: 3.5 }),
    ]);
    assert.equal(cna.workerCount, 2);
    assert.equal(csp.workerCount, 2);
    assert.deepEqual(cna.structures, calculateCna(frame).structures);
    assert.deepEqual(csp.centrosymmetry, calculateCentrosymmetry(frame).centrosymmetry);
    assert.deepEqual(coordination.coordination, calculateCoordination(frame, 3.5).coordination);
    assert.equal(stats.maximum, pool.limit);
    assert.equal(stats.active, 0);
    assert.ok(frame.fractional.byteLength > 0, 'source buffers are retained');
  } finally { pool.close(); }
});

test('isolated Worker mode preserves Float64 coordinates and matches copied results', async () => {
  const frame = crystalFrame('bcc', 2);
  const pool = new AnalysisPool({ environment: { crossOriginIsolated: true }, workerFactory: nodeFactory({ active: 0, maximum: 0 }) });
  try {
    const result = await pool.analyze(frame, { kind: 'cna' });
    assert.equal(result.sharedMemory, true);
    assert.deepEqual(result.structures, calculateCna(frame).structures);
  } finally { pool.close(); }
});

test('parallel PTM and fresh strain merge real Wasm Worker outputs including matrix strides', async () => {
  const stats = { active: 0, maximum: 0 };
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 } }, workerFactory: nodeFactory(stats) });
  const frame = crystalFrame('fcc', 11);
  const parameters = { flags: 31, rmsdCutoff: .1, references: [{ structure: 1, a: 3.9 }] };
  try {
    const [ptm, strain] = await Promise.all([
      pool.analyze(frame, { kind: 'ptm', ...parameters }),
      pool.analyze(frame, { kind: 'strain', ...parameters }),
    ]);
    assert.equal(ptm.workerCount, 2);
    assert.equal(strain.workerCount, 2);
    assert.match(ptm.engine, /ptm-wasm/);
    const direct = await calculateAtomicStrain(frame, parameters);
    for (const field of [...Object.keys(PTM_FIELDS), ...STRAIN_FIELDS]) assert.deepEqual(strain[field], direct[field], field);
    for (const field of Object.keys(PTM_FIELDS)) assert.deepEqual(ptm[field], direct[field], field);
    assert.equal(stats.maximum, pool.limit);
    assert.equal(stats.active, 0);
  } finally { pool.close(); }
});

test('cached strain shares typed PTM inputs safely and reuses fits for an edited lattice', async () => {
  const pool = new AnalysisPool({ environment: { crossOriginIsolated: true }, workerFactory: nodeFactory({ active: 0, maximum: 0 }) });
  const frame = crystalFrame('bcc', 3), ptmInput = await calculatePtm(frame);
  const parameters = { ptmInput, references: [{ structure: 3, a: 4.1 }] };
  try {
    const result = await pool.analyze(frame, { kind: 'strain', ...parameters });
    const direct = await calculateAtomicStrain(frame, parameters);
    for (const field of STRAIN_FIELDS) assert.deepEqual(result[field], direct[field], field);
    assert.equal(result.sharedMemory, true);
    assert.equal('deformation' in result, false);
    assert.ok(ptmInput.structures.every(type => type === 3), 'source arrays remain available');
  } finally { pool.close(); }
});

test('unmatched strain remains NaN without reporting an analysis warning', async () => {
  const pool = new AnalysisPool({ workerFactory: nodeFactory({ active: 0, maximum: 0 }) });
  const frame = crystalFrame('fcc', 2);
  try {
    const result = await pool.analyze(frame, { kind: 'strain', references: [{ structure: 3, a: 4 }], flags: 31 });
    assert.ok(result.atomicShearStrain.every(Number.isNaN));
    assert.equal(result.warning, null);
  } finally { pool.close(); }
});

test('cancelling running and queued tasks rejects promptly and releases all slots', async () => {
  let active = 0, started = 0;
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 2 } }, workerFactory: () => {
    active += 1;
    started += 1;
    return { addEventListener() {}, postMessage() {}, terminate() { active -= 1; } };
  } });
  const controller = new AbortController();
  const frame = crystalFrame('bcc');
  const first = pool.analyze(frame, { kind: 'cna' }, { signal: controller.signal });
  const second = pool.analyze(frame, { kind: 'centrosymmetry' }, { signal: controller.signal });
  const outcomes = Promise.allSettled([first, second]);
  controller.abort();
  const results = await outcomes;
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.name === 'AbortError'));
  assert.equal(active, 0);
  assert.equal(started, 1, 'aborting a running task must not start its already-cancelled queued successor');
  assert.equal(pool.queue.length, 0);
  assert.equal(pool.active.size, 0);
  pool.close();
});

test('Worker construction and analysis errors release slots for subsequent jobs', async () => {
  let fail = true;
  const goodFactory = nodeFactory({ active: 0, maximum: 0 });
  const pool = new AnalysisPool({ workerFactory: () => {
    if (fail) { fail = false; throw new Error('Worker startup failed'); }
    return goodFactory();
  } });
  const frame = crystalFrame('fcc', 1);
  try {
    await assert.rejects(pool.analyze(frame, { kind: 'cna' }), /startup failed/);
    await assert.rejects(pool.analyze(frame, { kind: 'unknown' }), /Unknown analysis/);
    const result = await pool.analyze(frame, { kind: 'cna' });
    assert.ok(result.structures.every((value) => value === 1));
  } finally { pool.close(); }
});

test('closing the pool settles outstanding requests instead of leaving promises pending', async () => {
  const pool = new AnalysisPool({ workerFactory: () => ({ addEventListener() {}, postMessage() {}, terminate() {} }) });
  const pending = pool.analyze(crystalFrame('bcc', 1), { kind: 'cna' });
  const outcome = assert.rejects(pending, { name: 'AbortError' });
  pool.close();
  await outcome;
  await assert.rejects(pool.analyze(crystalFrame('fcc'), { kind: 'cna' }), /closed/);
});
