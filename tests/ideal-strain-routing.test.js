import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { calculatePtm, PTM_FIELDS } from '../src/analysis/ptm.js';
import { STRAIN_FIELDS } from '../src/analysis/atomic-strain.js';
import { crystalFrame } from './helpers/crystals.js';

function neighborsFor(frame) {
  const search = new NeighborSearch(frame), count = search.count;
  const result = { counts: new Uint8Array(count), indices: new Uint32Array(count * 18),
    vectors: new Float64Array(count * 54), maxNeighbors: 18, startAtom: 0, endAtom: count, sourceAtomCount: count };
  for (let atom = 0; atom < count; atom++) {
    const neighbors = search.nearest(atom, 18);
    result.counts[atom] = neighbors.length;
    neighbors.forEach((neighbor, rank) => {
      const index = atom * 18 + rank;
      result.indices[index] = neighbor.atom;
      result.vectors.set([neighbor.x, neighbor.y, neighbor.z], index * 3);
    });
  }
  return result;
}

function harness({ neighborError, tensorError } = {}) {
  const frame = crystalFrame('fcc', 2), table = neighborsFor(frame), calls = [];
  const fit = Object.fromEntries(Object.entries(PTM_FIELDS).map(([field, [Type, stride]]) => [field, new Type(frame.types.length * stride)]));
  const tensor = Object.fromEntries(STRAIN_FIELDS.map(field => [field, new Float32Array(frame.types.length)]));
  const gpuBackend = { supports: kind => ['strain', 'ptmNeighbors'].includes(kind), close() {},
    async analyze(_frame, parameters, options) {
      calls.push({ backend: 'gpu', parameters });
      if (parameters.kind === 'ptmNeighbors' && neighborError) throw neighborError;
      if (parameters.kind === 'strain' && tensorError) throw tensorError;
      options.onProgress({ phase: 'complete', completedAtoms: frame.types.length });
      return parameters.kind === 'ptmNeighbors' ? { ...table, engine: 'webgpu-ptm-neighbors' }
        : { ...tensor, referenceBackend: 'gpu', engine: 'webgpu-strain' };
    } };
  const pool = new AnalysisPool({ gpuBackend, ptmNeighborBackend: 'gpu' });
  pool.setGpuEnabled(true);
  pool.analyzeCPU = async (_frame, parameters, options) => {
    calls.push({ backend: 'cpu', parameters });
    options.onProgress({ phase: 'complete', completedAtoms: frame.types.length });
    return parameters.kind === 'ptm' ? { ...fit, workerCount: 2, elapsedMs: 5, engine: 'ptm-wasm-worker-pool×2' }
      : { ...tensor, engine: 'js-worker' };
  };
  const parameters = { kind: 'strain', references: { 0: { structure: 1, a: 3.52 } }, flags: 31 };
  return { frame, table, fit, pool, calls, parameters };
}

test('fresh ideal strain prepares GPU neighbors, fits CPU templates, and applies the reference and tensor on GPU', async () => {
  const { frame, table, fit, pool, calls, parameters } = harness(), progress = [];
  try {
    const result = await pool.analyze(frame, parameters, { frameIndex: 4, onProgress: update => progress.push(update) });
    assert.deepEqual(calls.map(call => [call.backend, call.parameters.kind]), [['gpu', 'ptmNeighbors'], ['cpu', 'ptm'], ['gpu', 'strain']]);
    assert.strictEqual(calls[1].parameters.preparedNeighbors.vectors, table.vectors);
    assert.strictEqual(calls[2].parameters.ptmInput.structures, fit.structures);
    assert.equal(result.neighborBackend, 'gpu'); assert.equal(result.ptmBackend, 'cpu');
    assert.equal(result.referenceBackend, 'gpu'); assert.equal(result.tensorBackend, 'gpu');
    assert.equal(result.engine, 'webgpu-ptm-neighbors+ptm-wasm-worker-pool×2+webgpu-strain');
    assert.equal(result.ptmWorkerCount, 2); assert.equal(result.warning, null);
    assert.deepEqual(progress.map(update => update.stage), ['ptm-neighbors', 'ptm-fit', 'strain-tensor']);
    assert.deepEqual(progress.map(update => update.completedAtoms), [frame.types.length, frame.types.length * 2, frame.types.length * 3]);
    assert.ok(progress.every(update => update.totalAtoms === frame.types.length * 3));
  } finally { pool.close(); }
});

test('neighbor and tensor failures fall back independently and preserve the completed template fit', async () => {
  for (const options of [{ neighborError: new Error('unsupported thin cell') }, { tensorError: new Error('device lost') },
    { neighborError: new Error('host table budget'), tensorError: new Error('device lost') }]) {
    const { frame, pool, calls, parameters } = harness(options);
    try {
      const result = await pool.analyze(frame, parameters);
      assert.equal(result.neighborBackend, options.neighborError ? 'cpu' : 'gpu');
      assert.equal(result.tensorBackend, options.tensorError ? 'cpu' : 'gpu');
      assert.equal(result.referenceBackend, result.tensorBackend);
      assert.match(result.fallbackReason, new RegExp((options.neighborError ?? options.tensorError).message));
      assert.equal(calls.filter(call => call.backend === 'cpu' && call.parameters.kind === 'ptm').length, 1);
      const fit = calls.find(call => call.backend === 'gpu' && call.parameters.kind === 'strain').parameters.ptmInput;
      if (options.tensorError) assert.strictEqual(calls.at(-1).parameters.ptmInput, fit, 'CPU tensor fallback reuses the fit');
      assert.equal(Boolean(calls.find(call => call.parameters.kind === 'ptm').parameters.preparedNeighbors), !options.neighborError);
    } finally { pool.close(); }
  }
});

test('editing ideal references with cached PTM inputs skips both geometric stages', async () => {
  const { frame, fit, pool, calls, parameters } = harness(), progress = [];
  try {
    const result = await pool.analyze(frame, { ...parameters, references: { 0: { structure: 1, a: 3.6 } }, ptmInput: fit },
      { onProgress: update => progress.push(update) });
    assert.deepEqual(calls.map(call => [call.backend, call.parameters.kind]), [['gpu', 'strain']]);
    assert.strictEqual(calls[0].parameters.ptmInput, fit);
    assert.equal(result.neighborBackend, undefined, 'cached fitting does not claim newly computed GPU neighbors');
    assert.equal(result.referenceBackend, 'gpu');
    assert.equal(progress[0].totalAtoms, frame.types.length);
  } finally { pool.close(); }
});

test('cancellation at either GPU stage never queues CPU fallback or another stage', async () => {
  for (const stage of ['neighborError', 'tensorError']) {
    const { frame, pool, calls, parameters } = harness({ [stage]: new DOMException('cancelled', 'AbortError') });
    try {
      await assert.rejects(pool.analyze(frame, parameters), { name: 'AbortError' });
      assert.equal(calls.length, stage === 'neighborError' ? 1 : 3);
      assert.equal(calls.filter(call => call.backend === 'cpu' && call.parameters.kind === 'strain').length, 0);
    } finally { pool.close(); }
  }
});

test('invalid reference and template inputs reject before allocating GPU neighbors', async () => {
  const { frame, pool, calls, parameters } = harness();
  try {
    for (const invalid of [{ references: { 0: { structure: 1, a: 0 } } }, { flags: 0 }, { rmsdCutoff: -1 }]) {
      await assert.rejects(pool.analyze(frame, { ...parameters, ...invalid }));
    }
    assert.equal(calls.length, 0);
  } finally { pool.close(); }
});

test('real CPU fitting through the pool consumes prepared neighbors without detaching canonical tables', async () => {
  const { Worker } = await import('node:worker_threads');
  const frame = crystalFrame('hcp', 2), preparedNeighbors = neighborsFor(frame);
  const original = preparedNeighbors.vectors.slice();
  const expected = await calculatePtm(frame, { flags: 255 });
  for (const shared of [false, true]) {
    const pool = new AnalysisPool({ environment: { crossOriginIsolated: shared }, workerFactory: () => {
      const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
      return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
        postMessage(data, transfer) { worker.postMessage(data, transfer); }, terminate() { worker.terminate(); } };
    } });
    try {
      const actual = await pool.analyze(frame, { kind: 'ptm', preparedNeighbors, flags: 255 });
      for (const field of Object.keys(PTM_FIELDS)) assert.deepEqual(actual[field], expected[field], `${shared}/${field}`);
      assert.equal(actual.sharedMemory, shared);
      assert.deepEqual(preparedNeighbors.vectors, original);
      assert.ok(frame.fractional.byteLength > 0 && preparedNeighbors.indices.byteLength > 0);
    } finally { pool.close(); }
  }
});

test('parallel PTM dispatch slices ordinary private tables, retains multishell source rows, and shares isolated tables', async () => {
  const { Worker } = await import('node:worker_threads');
  const frame = crystalFrame('fcc', 11), preparedNeighbors = neighborsFor(frame), atomCount = frame.types.length;
  const expected = await calculatePtm(frame, { flags: 255 });
  for (const [shared, flags] of [[false, 31], [false, 255], [true, 255]]) {
    const payloads = [];
    const pool = new AnalysisPool({ environment: { crossOriginIsolated: shared, navigator: { hardwareConcurrency: 4 } },
      workerFactory: () => {
        const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
        return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
          postMessage(data, transfer) {
            const table = data.preparedNeighbors;
            payloads.push({ fitStart: data.startAtom, fitEnd: data.endAtom, ...(table ? {
              start: table.startAtom, end: table.endAtom, counts: table.counts.length,
              sourceCount: table.sourceAtomCount, buffer: table.vectors.buffer } : {}) });
            if (table) {
              assert.equal(table.vectors.buffer instanceof SharedArrayBuffer, shared);
              if (!shared) assert.notStrictEqual(table.vectors.buffer, preparedNeighbors.vectors.buffer);
              assert.deepEqual(table.vectors, preparedNeighbors.vectors.subarray(table.startAtom * 54, table.endAtom * 54));
            }
            worker.postMessage(data, transfer);
          }, terminate() { worker.terminate(); } };
      } });
    try {
      const result = await pool.analyze(frame, { kind: 'ptm', preparedNeighbors, flags });
      assert.equal(result.workerCount, 2);
      assert.equal(payloads.length, result.chunkCount);
      assert.ok(payloads.length > result.workerCount, 'bounded chunks dynamically reuse resident fitters');
      const tables = payloads.filter(payload => payload.buffer);
      assert.ok(tables.every(payload => payload.sourceCount === atomCount));
      if (!shared && flags === 31) {
        assert.equal(tables.length, result.chunkCount, 'ordinary private neighbor tables transfer only each chunk rows');
        const sorted = tables.sort((a, b) => a.start - b.start);
        assert.equal(sorted[0].start, 0); assert.equal(sorted.at(-1).end, atomCount);
        assert.ok(sorted.every((payload, index) => payload.start === payload.fitStart && payload.end === payload.fitEnd
          && (index === 0 || payload.start === sorted[index - 1].end)));
        assert.equal(tables.reduce((sum, payload) => sum + payload.counts, 0), atomCount);
      } else {
        assert.equal(tables.length, result.workerCount, 'full source tables upload once per resident fitter');
        assert.ok(tables.every(payload => payload.start === 0 && payload.end === atomCount && payload.counts === atomCount));
        if (shared) assert.strictEqual(tables[0].buffer, tables[1].buffer);
      }
      for (const field of Object.keys(PTM_FIELDS)) assert.deepEqual(result[field], expected[field], `${shared}/${flags}/${field}`);
      assert.ok(preparedNeighbors.vectors.byteLength > 0);
    } finally { pool.close(); }
  }
});
