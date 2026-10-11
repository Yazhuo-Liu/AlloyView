import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisProgressReporter, createAtomProgressThrottle } from '../src/analysis/progress.js';
import { analysisProgressText } from '../src/analysis/status.js';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { crystalFrame } from './helpers/crystals.js';

function animationEnvironment() {
  let serial = 0;
  const frames = new Map(), timers = new Map();
  return { frames, timers, environment: {
    requestAnimationFrame: callback => { frames.set(++serial, callback); return serial; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: callback => { timers.set(++serial, callback); return serial; },
    clearTimeout: id => timers.delete(id),
  }, paint() { for (const callback of [...frames.values()]) callback(); },
  backgroundTick() { for (const callback of [...timers.values()]) callback(); } };
}
const analyzing = completedAtoms => ({ phase: 'analyzing', backend: 'cpu', completedAtoms, totalAtoms: 1000 });

test('browser progress keeps the first atom update and coalesces a burst before text formatting', () => {
  const clock = animationEnvironment(), values = [], reporter = createAnalysisProgressReporter(value => values.push(value), clock);
  reporter.report(analyzing(0)); reporter.report(analyzing(1));
  for (let atoms = 2; atoms <= 500; atoms++) reporter.report(analyzing(atoms));
  assert.deepEqual(values.map(value => value.completedAtoms), [0, 1]);
  assert.equal(clock.frames.size, 1); assert.equal(clock.timers.size, 1);
  clock.paint();
  assert.deepEqual(values.map(value => value.completedAtoms), [0, 1, 500]);
  assert.equal(clock.frames.size, 0); assert.equal(clock.timers.size, 0);
  reporter.close();
});

test('phase, hybrid backend and terminal changes bypass queued stale progress', () => {
  const clock = animationEnvironment(), values = [], reporter = createAnalysisProgressReporter(value => values.push(value), clock);
  reporter.report(analyzing(0)); reporter.report(analyzing(1)); reporter.report(analyzing(2));
  reporter.report({ ...analyzing(3), backend: 'gpu', stage: 'strain-tensor' });
  reporter.report({ ...analyzing(1000), phase: 'complete' });
  clock.paint();
  assert.deepEqual(values.map(value => [value.backend, value.phase, value.completedAtoms]),
    [['cpu', 'analyzing', 0], ['cpu', 'analyzing', 1], ['gpu', 'analyzing', 3], ['cpu', 'complete', 1000]]);
  reporter.close();
});

test('background tabs flush progress, while abort and close discard obsolete pending callbacks', () => {
  const clock = animationEnvironment(), controller = new AbortController(), values = [];
  const reporter = createAnalysisProgressReporter(value => values.push(value.completedAtoms), { ...clock, signal: controller.signal });
  reporter.report(analyzing(0)); reporter.report(analyzing(1)); reporter.report(analyzing(10));
  clock.backgroundTick(); assert.deepEqual(values, [0, 1, 10]);
  reporter.report(analyzing(20)); const lateCallback = [...clock.frames.values()][0];
  controller.abort(); lateCallback(); reporter.report(analyzing(30));
  assert.deepEqual(values, [0, 1, 10]);
  assert.equal(clock.frames.size + clock.timers.size, 0);
});

test('a final flush delivers the latest update and deferred callback failures remain observable', () => {
  const clock = animationEnvironment(), values = [], reporter = createAnalysisProgressReporter(value => {
    if (value.completedAtoms === 20) throw new Error('progress callback failed');
    values.push(value.completedAtoms);
  }, clock);
  reporter.report(analyzing(0)); reporter.report(analyzing(1)); reporter.report(analyzing(10));
  reporter.flush(); assert.deepEqual(values, [0, 1, 10]);
  reporter.report(analyzing(20)); clock.paint();
  assert.throws(() => reporter.flush(), /progress callback failed/);
  reporter.close(); assert.equal(clock.frames.size + clock.timers.size, 0);
});

test('non-browser progress stays synchronous and the formatter retains existing text', () => {
  const values = [], reporter = createAnalysisProgressReporter(value => values.push(value), { environment: {} });
  reporter.report(analyzing(0)); reporter.report(analyzing(1)); reporter.report(analyzing(2));
  assert.equal(values.length, 3);
  for (const atoms of [0, 1234, 999999, 1e12]) {
    const text = analysisProgressText({ ...analyzing(atoms), totalAtoms: atoms + 1000, backend: 'gpu' });
    assert.ok(text.includes(`${atoms.toLocaleString('en-US')} / ${(atoms + 1000).toLocaleString('en-US')} atoms`));
  }
  reporter.close();
});

test('Worker progress throttling spans short ranges but keeps independent analyses and the final range live', () => {
  let time = 0;
  const due = createAtomProgressThrottle({ now: () => time });
  assert.equal(due('analysis:1'), true);
  time = 10; assert.equal(due('analysis:1'), false);
  time = 20; assert.equal(due('analysis:1'), false);
  assert.equal(due('analysis:2'), true);
  time = 80; assert.equal(due('analysis:1'), true);
  time = 81; assert.equal(due('analysis:1', { final: true }), true);
});

for (const action of ['abort', 'close']) test(`cancelling from the final deferred GPU progress update rejects the public analysis (${action})`, async () => {
  const clock = animationEnvironment(), controller = new AbortController(), values = [];
  let cpuCalls = 0, gpuCalls = 0;
  const pool = new AnalysisPool({ environment: clock.environment, gpuBackend: {
    supports: kind => kind === 'coordination', close() {},
    async analyze(_frame, _parameters, { onProgress }) {
      gpuCalls++;
      for (const atoms of [0, 1, 2]) onProgress({ ...analyzing(atoms), backend: 'gpu' });
      return { engine: 'webgpu', coordination: new Uint32Array(4).fill(12) };
    },
  } });
  pool.setGpuEnabled(true);
  pool.analyzeCPU = async () => { cpuCalls++; throw new Error('Cancellation must not start CPU fallback.'); };
  try {
    await assert.rejects(pool.analyze(crystalFrame('fcc', 1), { kind: 'coordination', cutoff: 3 }, {
      signal: controller.signal, onProgress(update) {
        values.push(update.completedAtoms);
        if (update.completedAtoms === 2) {
          if (action === 'abort') controller.abort(); else pool.close();
        }
      },
    }), { name: 'AbortError' });
    assert.deepEqual(values, [0, 1, 2]);
    assert.equal(cpuCalls, 0); assert.equal(gpuCalls, 1);
    assert.equal(clock.frames.size + clock.timers.size, 0);
    if (action === 'abort') {
      const result = await pool.analyze(crystalFrame('fcc', 1), { kind: 'coordination', cutoff: 3 });
      assert.equal(result.backend, 'gpu'); assert.equal(gpuCalls, 2);
    }
  } finally { pool.close(); }
});

test('a synchronous GPU progress callback error rejects once without CPU fallback', async () => {
  const clock = animationEnvironment(), failure = new Error('UI progress failed');
  let cpuCalls = 0, gpuCalls = 0;
  const pool = new AnalysisPool({ environment: clock.environment, gpuBackend: {
    supports: kind => kind === 'coordination', close() {},
    async analyze(_frame, _parameters, { onProgress }) {
      gpuCalls++; onProgress({ ...analyzing(0), backend: 'gpu' });
      return { engine: 'webgpu', coordination: new Uint32Array(4).fill(12) };
    },
  } });
  pool.setGpuEnabled(true);
  pool.analyzeCPU = async () => { cpuCalls++; return { coordination: new Uint32Array(4).fill(12) }; };
  try {
    await assert.rejects(pool.analyze(crystalFrame('fcc', 1), { kind: 'coordination', cutoff: 3 }, {
      onProgress(update) { if (update.backend === 'gpu') throw failure; },
    }), error => error === failure);
    assert.equal(cpuCalls, 0); assert.equal(gpuCalls, 1);
    assert.equal(clock.frames.size + clock.timers.size, 0);
    assert.equal((await pool.analyze(crystalFrame('fcc', 1), { kind: 'coordination', cutoff: 3 })).backend, 'gpu');
  } finally { pool.close(); }
});
