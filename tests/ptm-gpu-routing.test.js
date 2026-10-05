import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { calculatePtm, PTM_FIELDS } from '../src/analysis/ptm.js';
import { crystalFrame } from './helpers/crystals.js';

function neighborsFor(frame) {
  const search = new NeighborSearch(frame), count = search.count;
  const table = { counts: new Uint8Array(count), indices: new Uint32Array(count * 18),
    vectors: new Float64Array(count * 54), maxNeighbors: 18, startAtom: 0, endAtom: count, sourceAtomCount: count };
  for (let atom = 0; atom < count; atom++) {
    const neighbors = search.nearest(atom, 18);
    table.counts[atom] = neighbors.length;
    neighbors.forEach((neighbor, rank) => {
      const index = atom * 18 + rank;
      table.indices[index] = neighbor.atom;
      table.vectors.set([neighbor.x, neighbor.y, neighbor.z], index * 3);
    });
  }
  return table;
}

function harness({ supported = true, neighborError, neighborResult, afterNeighbors, fitError } = {}) {
  const frame = crystalFrame('fcc', 2), table = neighborsFor(frame), calls = [];
  const fit = Object.fromEntries(Object.entries(PTM_FIELDS).map(([field, [Type, stride]]) => [field, new Type(frame.types.length * stride)]));
  const gpuBackend = { supports: kind => supported && kind === 'ptmNeighbors', close() {},
    async analyze(inputFrame, parameters, options) {
      calls.push({ backend: 'gpu', frame: inputFrame, parameters, options });
      options.onProgress({ phase: 'indexing', completedAtoms: 0 });
      if (neighborError) throw neighborError;
      options.onProgress({ phase: 'complete', completedAtoms: table.counts.length });
      afterNeighbors?.();
      return neighborResult ?? { ...table, engine: 'webgpu-ptm-neighbors', arithmetic: 'f64' };
    } };
  const pool = new AnalysisPool({ gpuBackend });
  pool.setGpuEnabled(true);
  pool.analyzeCPU = async (inputFrame, parameters, options) => {
    calls.push({ backend: 'cpu', frame: inputFrame, parameters, options });
    options.onProgress({ phase: 'queued', completedAtoms: 0, totalAtoms: table.counts.length });
    if (fitError) throw fitError;
    options.onProgress({ phase: 'complete', completedAtoms: table.counts.length, totalAtoms: table.counts.length });
    return { ...fit, workerCount: 2, sharedMemory: true, kernelInitializations: 0, elapsedMs: 5,
      engine: 'ptm-wasm-worker-pool×2', warning: null };
  };
  return { frame, table, fit, pool, calls, parameters: { kind: 'ptm', flags: 127, rmsdCutoff: .1 } };
}

test('public PTM uses GPU neighbors then CPU fitting, retaining inputs and two-stage progress', async () => {
  const { frame, table, fit, pool, calls, parameters } = harness(), progress = [], controller = new AbortController();
  const source = frame.fractional.slice(), vectors = table.vectors.slice();
  delete frame.types; // PTM topology does not require per-element strain references.
  try {
    const result = await pool.analyze(frame, parameters, { signal: controller.signal, frameIndex: 7,
      onProgress: update => progress.push(update) });
    assert.deepEqual(calls.map(call => [call.backend, call.parameters.kind]), [['gpu', 'ptmNeighbors'], ['cpu', 'ptm']]);
    assert.strictEqual(calls[0].frame, frame);
    assert.equal(calls[0].options.frameIndex, 7);
    assert.strictEqual(calls[0].options.signal, controller.signal);
    assert.strictEqual(calls[1].options.signal, controller.signal);
    assert.equal(calls[1].parameters.flags, parameters.flags);
    assert.equal(calls[1].parameters.rmsdCutoff, parameters.rmsdCutoff);
    const prepared = calls[1].parameters.preparedNeighbors;
    for (const field of ['counts', 'indices', 'vectors']) assert.strictEqual(prepared[field], table[field]);
    assert.equal(prepared.engine, undefined);
    assert.equal(prepared.arithmetic, undefined);
    assert.equal(result.backend, 'hybrid');
    assert.equal(result.gpuRequested, true);
    assert.equal(result.neighborBackend, 'gpu');
    assert.equal(result.ptmBackend, 'cpu');
    assert.equal(result.ptmEngine, 'ptm-wasm-worker-pool×2');
    assert.equal(result.engine, 'webgpu-ptm-neighbors+ptm-wasm-worker-pool×2');
    assert.equal(result.workerCount, 2);
    assert.equal(result.ptmWorkerCount, 2);
    assert.equal(result.sharedMemory, true);
    assert.equal(result.kernelInitializations, 0);
    assert.equal(result.ptmElapsedMs, 5);
    assert.ok(result.neighborElapsedMs >= 0 && result.elapsedMs >= result.neighborElapsedMs);
    assert.equal(result.fallbackReason, undefined);
    assert.strictEqual(result.structures, fit.structures);
    assert.equal(result.vectors, undefined, 'temporary neighbor tables are not retained in the PTM result');
    assert.deepEqual(progress.map(update => [update.backend, update.stage]), [
      ['gpu', 'ptm-neighbors'], ['gpu', 'ptm-neighbors'], ['cpu', 'ptm-fit'], ['cpu', 'ptm-fit'],
    ]);
    assert.deepEqual(progress.map(update => update.completedAtoms), [0, table.counts.length, table.counts.length, table.counts.length * 2]);
    assert.ok(progress.every(update => update.totalAtoms === table.counts.length * 2));
    assert.deepEqual(frame.fractional, source);
    assert.deepEqual(table.vectors, vectors);
  } finally { pool.close(); }
});

test('GPU opt-out, unavailable neighbor kernels, and supplied tables keep CPU fitting', async () => {
  for (const mode of ['disabled', 'unsupported', 'supplied']) {
    const { frame, table, pool, calls, parameters } = harness({ supported: mode !== 'unsupported' }), progress = [];
    if (mode === 'disabled') pool.setGpuEnabled(false);
    if (mode === 'supplied') parameters.preparedNeighbors = table;
    try {
      const result = await pool.analyze(frame, parameters, { onProgress: update => progress.push(update) });
      assert.deepEqual(calls.map(call => [call.backend, call.parameters.kind]), [['cpu', 'ptm']]);
      assert.equal(result.backend, 'cpu');
      assert.equal(result.gpuRequested, mode !== 'disabled');
      assert.ok(progress.every(update => update.totalAtoms === table.counts.length));
      if (mode === 'unsupported') {
        assert.equal(result.neighborBackend, 'cpu');
        assert.equal(result.ptmBackend, 'cpu');
        assert.match(result.fallbackReason, /no GPU kernel/);
        assert.equal(progress[0].fallbackReason, result.fallbackReason);
      } else if (mode === 'supplied') {
        assert.strictEqual(calls[0].parameters.preparedNeighbors, table);
        assert.equal(result.neighborBackend, 'prepared');
        assert.equal(result.fallbackReason, undefined);
      }
    } finally { pool.close(); }
  }
});

test('GPU geometry, memory, and malformed-table failures fall back once with the original PTM settings', async () => {
  for (const options of [{ neighborError: new Error('unsupported thin cell') }, { neighborError: new Error('host table budget') },
    { neighborResult: { maxNeighbors: 18, counts: new Uint8Array(1), indices: new Uint32Array(18), vectors: new Float32Array(54) } }]) {
    const { frame, pool, calls, parameters } = harness(options), progress = [];
    try {
      const result = await pool.analyze(frame, parameters, { onProgress: update => progress.push(update) });
      assert.deepEqual(calls.map(call => [call.backend, call.parameters.kind]), [['gpu', 'ptmNeighbors'], ['cpu', 'ptm']]);
      assert.equal(calls[1].parameters.preparedNeighbors, undefined);
      assert.equal(calls[1].parameters.flags, 127);
      assert.equal(calls[1].parameters.rmsdCutoff, .1);
      assert.equal(result.backend, 'cpu');
      assert.equal(result.neighborBackend, 'cpu');
      assert.equal(result.ptmBackend, 'cpu');
      assert.equal(result.engine, 'ptm-wasm-worker-pool×2');
      assert.match(result.fallbackReason, /GPU PTM neighbors:/);
      assert.equal(result.neighborFallbackReason, result.fallbackReason);
      assert.equal(progress.at(-1).fallbackReason, result.fallbackReason);
      assert.equal(progress.at(-1).neighborFallbackReason, result.neighborFallbackReason);
      assert.equal(progress.at(-1).completedAtoms, frame.types.length * 2);
    } finally { pool.close(); }
  }
});

test('GPU cancellation, abort after preparation, and closing between stages never start CPU fitting', async () => {
  for (const mode of ['error', 'signal', 'close']) {
    const controller = new AbortController();
    let pool;
    const options = mode === 'error' ? { neighborError: new DOMException('cancelled', 'AbortError') }
      : { afterNeighbors: () => mode === 'signal' ? controller.abort() : pool.close() };
    const state = harness(options);
    ({ pool } = state);
    try {
      await assert.rejects(pool.analyze(state.frame, state.parameters, { signal: controller.signal }), { name: 'AbortError' });
      assert.deepEqual(state.calls.map(call => call.backend), ['gpu']);
    } finally { pool.close(); }
  }
});

test('invalid PTM settings reject before GPU preparation and CPU fit failures are not retried', async () => {
  const { frame, pool, calls, parameters } = harness();
  try {
    for (const invalid of [{ flags: 0 }, { flags: 256 }, { rmsdCutoff: -1 }, { rmsdCutoff: NaN }]) {
      await assert.rejects(pool.analyze(frame, { ...parameters, ...invalid }));
    }
    assert.equal(calls.length, 0);
  } finally { pool.close(); }
  const error = new Error('PTM worker allocation failed'), failed = harness({ fitError: error });
  try {
    await assert.rejects(failed.pool.analyze(failed.frame, failed.parameters), value => value === error);
    assert.deepEqual(failed.calls.map(call => call.backend), ['gpu', 'cpu']);
  } finally { failed.pool.close(); }
});

test('public hybrid PTM fits prepared GPU tables in real workers with CPU oracle parity and owned sources', async () => {
  const frame = crystalFrame('hcp', 2), table = neighborsFor(frame), vectors = table.vectors.slice(), fractional = frame.fractional.slice();
  delete frame.types;
  const expected = await calculatePtm(frame, { flags: 127, rmsdCutoff: .1 });
  for (const shared of [false, true]) {
    const gpuBackend = { supports: kind => kind === 'ptmNeighbors', close() {},
      async analyze(inputFrame, parameters, { frameIndex, onProgress }) {
        assert.strictEqual(inputFrame, frame);
        assert.equal(parameters.kind, 'ptmNeighbors');
        assert.equal(frameIndex, 6);
        onProgress({ phase: 'complete', completedAtoms: table.counts.length });
        return { ...table, engine: 'webgpu-ptm-neighbors' };
      } };
    const pool = new AnalysisPool({ gpuBackend, environment: { crossOriginIsolated: shared }, workerFactory: () => {
      const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
      return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
        postMessage(data, transfer) { worker.postMessage(data, transfer); }, terminate() { worker.terminate(); } };
    } });
    pool.setGpuEnabled(true);
    try {
      const actual = await pool.analyze(frame, { kind: 'ptm', flags: 127, rmsdCutoff: .1 }, { frameIndex: 6 });
      for (const field of Object.keys(PTM_FIELDS)) assert.deepEqual(actual[field], expected[field], `${shared}/${field}`);
      assert.equal(actual.backend, 'hybrid');
      assert.equal(actual.sharedMemory, shared);
      assert.equal(actual.neighborBackend, 'gpu');
      assert.equal(actual.ptmBackend, 'cpu');
      assert.deepEqual(frame.fractional, fractional);
      assert.deepEqual(table.vectors, vectors);
      assert.ok(table.indices.byteLength > 0 && table.counts.byteLength > 0);
    } finally { pool.close(); }
  }
});
