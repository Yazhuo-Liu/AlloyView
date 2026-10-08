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
    stats.created = (stats.created ?? 0) + 1;
    stats.maximum = Math.max(stats.maximum, stats.active);
    return {
      addEventListener(name, listener) {
        worker.on(name, (data) => listener(name === 'message' ? { data } : data));
      },
      postMessage(data, transferables) { worker.postMessage(data, transferables); },
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
    assert.equal(pool.active.size, 0);
    assert.equal(stats.active, pool.idle.length, 'successful Workers remain available for reuse');
    assert.ok(frame.fractional.byteLength > 0, 'source buffers are retained');
  } finally { pool.close(); }
  assert.equal(stats.active, 0, 'closing the pool terminates its warm Workers');
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

test('Auto CSP merges per-atom shells across real Workers and reuses a warm PTM pool', async () => {
  const stats = { active: 0, maximum: 0 };
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 } }, workerFactory: nodeFactory(stats) });
  const frame = crystalFrame('fcc', 11);
  frame.fractional = frame.fractional.slice(3);
  const structureInput = calculateCna(frame).structures;
  const original = structureInput.slice();
  const phases = [];
  try {
    await pool.analyze(frame, { kind: 'ptm' });
    const created = stats.created;
    const result = await pool.analyze(frame, { kind: 'centrosymmetry', mode: 'auto', structureInput }, {
      onProgress: (progress) => phases.push(progress),
    });
    const direct = calculateCentrosymmetry(frame, { mode: 'auto' });
    assert.equal(result.workerCount, 2);
    assert.equal(stats.created, created, 'Auto can run on the Workers that previously ran PTM');
    for (const key of ['centrosymmetry', 'cspStructureTypes', 'cspNeighborCounts', 'cspSummary']) assert.deepEqual(result[key], direct[key], key);
    assert.deepEqual(structureInput, original, 'CNA labels are copied before transfer rather than detached');
    assert.ok(frame.fractional.byteLength > 0);
    assert.ok(phases.some((progress) => progress.completedAtoms > 0 && progress.completedAtoms < progress.totalAtoms));
    assert.ok(phases.every((progress, index) => !index || progress.completedAtoms >= phases[index - 1].completedAtoms));
    assert.equal(phases.at(-1).completedAtoms, frame.fractional.length / 3);
    assert.equal(result.warning, null);
  } finally { pool.close(); }
  assert.equal(stats.active, 0);
});

test('Auto CSP copies shared cached labels safely and leaves unknown structures NaN without warnings', async () => {
  const stats = { active: 0, maximum: 0 };
  const pool = new AnalysisPool({ environment: { crossOriginIsolated: true }, workerFactory: nodeFactory(stats) });
  const frame = crystalFrame('hcp', 2);
  const structureInput = calculateCna(frame).structures;
  try {
    const cached = await pool.analyze(frame, { kind: 'centrosymmetry', mode: 'auto', structureInput });
    const direct = calculateCentrosymmetry(frame, { mode: 'auto' });
    assert.equal(cached.sharedMemory, true);
    for (const key of ['centrosymmetry', 'cspStructureTypes', 'cspNeighborCounts', 'cspSummary']) assert.deepEqual(cached[key], direct[key], key);
    assert.ok(structureInput.every((type) => type === 2));
    const unknown = await pool.analyze(crystalFrame('sc', 2), { kind: 'centrosymmetry', mode: 'auto' });
    assert.ok(unknown.centrosymmetry.every(Number.isNaN));
    assert.equal(unknown.warning, null);
    assert.equal(unknown.cspSummary.unresolved, unknown.centrosymmetry.length);
    await assert.rejects(pool.analyze(frame, { kind: 'centrosymmetry', mode: 'auto', structureInput: new Uint8Array(1) }));
    await assert.rejects(pool.analyze(frame, { kind: 'centrosymmetry', mode: 'auto', structureInput: new Uint8Array(frame.ids.length).fill(5) }));
    assert.equal(stats.created, 1, 'invalid cached input never dispatches another Worker');
  } finally { pool.close(); }
});

test('real Auto CSP atom progress allows cancellation while an independent queued CNA completes', async () => {
  const stats = { active: 0, maximum: 0 };
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 2 } }, workerFactory: nodeFactory(stats) });
  const controller = new AbortController();
  let interrupted = null;
  const first = pool.analyze(crystalFrame('fcc', 16), { kind: 'centrosymmetry', mode: 'auto' }, {
    signal: controller.signal,
    onProgress(progress) {
      if (progress.completedAtoms > 0 && progress.completedAtoms < progress.totalAtoms) {
        interrupted = progress;
        controller.abort();
      }
    },
  });
  const nextFrame = crystalFrame('bcc', 2);
  const second = pool.analyze(nextFrame, { kind: 'cna' });
  try {
    const outcomes = await Promise.allSettled([first, second]);
    assert.equal(outcomes[0].status, 'rejected');
    assert.equal(outcomes[0].reason.name, 'AbortError');
    assert.equal(interrupted?.phase, 'analyzing');
    assert.equal(outcomes[1].status, 'fulfilled');
    assert.deepEqual(outcomes[1].value.structures, calculateCna(nextFrame).structures);
    assert.equal(stats.created, 1, 'bounded cancellation retains the Worker for the queued job');
    assert.equal(stats.maximum, 1);
    assert.equal(pool.active.size, 0);
  } finally { pool.close(); }
  assert.equal(stats.active, 0);
});

test('warm Workers reuse one Wasm kernel and rebuild neighbors for a different frame', async () => {
  const stats = { active: 0, maximum: 0 };
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 2 } }, workerFactory: nodeFactory(stats) });
  const fcc = crystalFrame('fcc', 3), bcc = crystalFrame('bcc', 3);
  const phases = [];
  try {
    const first = await pool.analyze(fcc, { kind: 'ptm' }, { onProgress: (progress) => phases.push(progress) });
    const second = await pool.analyze(bcc, { kind: 'ptm' });
    assert.equal(first.kernelInitializations, 1);
    assert.equal(second.kernelInitializations, 0);
    assert.equal(stats.created, 1, 'the second job uses the resident Worker');
    const direct = await calculatePtm(bcc);
    for (const field of Object.keys(PTM_FIELDS)) assert.deepEqual(second[field], direct[field], field);
    assert.ok(first.structures.every((type) => type === 1));
    assert.ok(second.structures.every((type) => type === 3), 'a reused kernel uses the new frame coordinates');
    assert.ok(['preparing', 'initializing', 'indexing', 'analyzing', 'complete'].every((phase) => phases.some((progress) => progress.phase === phase)));
    assert.equal(phases.at(-1).completed, phases.at(-1).total);
    assert.equal(phases.at(-1).initialized, 1);
    assert.equal(phases.at(-1).completedAtoms, fcc.ids.length);
    assert.ok(phases.every((progress, index) => !index || progress.completedAtoms >= phases[index - 1].completedAtoms));
    assert.ok(fcc.fractional.byteLength > 0 && bcc.fractional.byteLength > 0, 'input coordinates are never transferred away');
  } finally { pool.close(); }
  assert.equal(stats.active, 0);
});

test('non-isolated dispatch yields and transfers a private typed coordinate copy', async () => {
  const frame = crystalFrame('fcc', 2);
  const source = frame.fractional;
  const originalCoordinates = source.slice();
  const stats = { active: 0, maximum: 0 };
  const realFactory = nodeFactory(stats);
  let yielded = false, posted = false;
  const pool = new AnalysisPool({ environment: { crossOriginIsolated: false }, workerFactory: () => {
    const worker = realFactory();
    return { addEventListener: worker.addEventListener.bind(worker), terminate: worker.terminate.bind(worker),
      postMessage(data, transferables) {
        assert.ok(yielded, 'the main thread gets a turn before dispatch');
        assert.notEqual(data.fractional.buffer, source.buffer);
        assert.deepEqual(data.fractional, source);
        assert.deepEqual(transferables, [data.fractional.buffer, data.types.buffer]);
        worker.postMessage(data, transferables);
        assert.equal(data.fractional.byteLength, 0, 'the private copy is transferred, not cloned');
        posted = true;
      } };
  } });
  setTimeout(() => { yielded = true; }, 0);
  const pending = pool.analyze(frame, { kind: 'cna' });
  assert.equal(posted, false, 'postMessage must not synchronously clone all inputs in analyze');
  try {
    const result = await pending;
    assert.equal(posted, true);
    assert.deepEqual(source, originalCoordinates);
    assert.deepEqual(result.structures, calculateCna(frame).structures);
  } finally { pool.close(); }
});

test('real atom progress allows cancelling a running fit while a queued independent job continues', async () => {
  const stats = { active: 0, maximum: 0 };
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 2 } }, workerFactory: nodeFactory(stats) });
  const controller = new AbortController();
  let interruptedProgress = null;
  const first = pool.analyze(crystalFrame('fcc', 16), { kind: 'ptm' }, {
    signal: controller.signal,
    onProgress(progress) {
      if (progress.completedAtoms > 0 && progress.completedAtoms < progress.totalAtoms) {
        interruptedProgress = progress;
        controller.abort();
      }
    },
  });
  const secondFrame = crystalFrame('bcc', 2);
  const second = pool.analyze(secondFrame, { kind: 'cna' });
  try {
    const [cancelled, continued] = await Promise.allSettled([first, second]);
    assert.equal(cancelled.status, 'rejected');
    assert.equal(cancelled.reason.name, 'AbortError');
    assert.ok(interruptedProgress, 'the fit emits actual partial atom progress before its final result');
    assert.equal(interruptedProgress.phase, 'analyzing');
    assert.equal(continued.status, 'fulfilled');
    assert.deepEqual(continued.value.structures, calculateCna(secondFrame).structures);
    assert.equal(stats.created, 1, 'a cancelled bounded fit retains its Worker and Wasm kernel');
    assert.equal(stats.maximum, 1, 'the queued job respects the pool concurrency budget');
    assert.equal(pool.active.size, 0);
  } finally { pool.close(); }
  assert.equal(stats.active, 0);
});

test('closing during shared-memory preparation settles before any Worker is dispatched', async () => {
  let created = 0;
  const pool = new AnalysisPool({ environment: { crossOriginIsolated: true }, workerFactory: () => {
    created += 1;
    throw new Error('Must not dispatch after close');
  } });
  const pending = pool.analyze(crystalFrame('fcc', 2), { kind: 'ptm' });
  const outcome = assert.rejects(pending, { name: 'AbortError' });
  pool.close();
  await outcome;
  assert.equal(created, 0);
  assert.equal(pool.controllers.size, 0);
});

test('cancelling snapshot preparation prevents input transfer and Worker allocation', async () => {
  let posted = 0, terminated = 0;
  const pool = new AnalysisPool({ workerFactory: () => ({ addEventListener() {},
    postMessage() { posted += 1; }, terminate() { terminated += 1; } }) });
  const controller = new AbortController();
  const pending = pool.analyze(crystalFrame('fcc', 2), { kind: 'ptm' }, { signal: controller.signal });
  const outcome = assert.rejects(pending, { name: 'AbortError' });
  await Promise.resolve(); // The shared CPU lease is acquired before allocation.
  controller.abort();
  await outcome;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(posted, 0);
  assert.equal(terminated, 0);
  assert.equal(pool.idle.length, 0);
  pool.close();
});

test('reused Workers ignore old result and progress messages after a new task starts', async () => {
  const listeners = new Map(), posted = [];
  let created = 0;
  const pool = new AnalysisPool({ workerFactory: () => {
    created += 1;
    return { addEventListener(name, listener) { listeners.set(name, listener); },
      postMessage(data) { posted.push(data); }, terminate() {} };
  } });
  const frame = crystalFrame('fcc', 1);
  const first = pool.analyze(frame, { kind: 'cna' });
  while (!posted.length) await new Promise((resolve) => setTimeout(resolve, 0));
  const reply = (task, value) => listeners.get('message')({ data: { id: task.id, ok: true,
    result: { startAtom: 0, structures: new Uint8Array(frame.ids.length).fill(value) } } });
  reply(posted[0], 1);
  await first;
  const progress = [];
  const second = pool.analyze(frame, { kind: 'cna' }, { onProgress: (value) => progress.push(value) });
  while (posted.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  const updates = progress.length;
  listeners.get('message')({ data: { id: posted[0].id, phase: 'analyzing' } });
  reply(posted[0], 5);
  assert.equal(progress.length, updates, 'old progress must not update the new task');
  assert.equal(pool.active.size, 1, 'an old result must not settle the new request');
  reply(posted[1], 3);
  assert.ok((await second).structures.every((value) => value === 3));
  assert.equal(created, 1);
  pool.close();
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
    assert.equal(pool.active.size, 0);
    assert.equal(stats.active, pool.idle.length);
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
  await Promise.resolve(); // Cancel an allocated task and its lease waiter together.
  controller.abort();
  const results = await outcomes;
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.name === 'AbortError'));
  assert.equal(active, 0);
  assert.equal(started, 0, 'aborting snapshot copying prevents both Worker admissions');
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
