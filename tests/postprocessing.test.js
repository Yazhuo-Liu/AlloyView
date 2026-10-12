import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { coordinationStatistics } from '../src/analysis/coordination-statistics.js';
import { summarizeWignerSeitz, summarizeWignerSeitzAsync } from '../src/analysis/wigner-seitz.js';
import { createExpressionScope, compileFrameExpression, evaluateExpression } from '../src/expressions.js';
import { crystalFrame } from './helpers/crystals.js';

function previousStatistics(values) {
  const counts = new Map(); let sum = 0;
  for (const value of values) { counts.set(value, (counts.get(value) ?? 0) + 1); sum += value; }
  return { histogram: [...counts].sort((a, b) => a[0] - b[0]).map(([coordination, count]) => ({ coordination, count })),
    meanCoordination: sum / values.length };
}

test('bounded coordination counters preserve Map keys, stable NaN ordering and exact row-order sums', async () => {
  const samples = [[], [12, 8, 12, 6, 8], [0, -0, NaN, 3, Infinity, NaN, -Infinity, -1, .5, 1024, 1e20],
    [1e16, 1, -1e16, 3], [NaN, 12, 4, NaN, 3, -0, .5]];
  let seed = 9;
  const choices = [-0, 0, 1, 2, 8, 12, 1023, 1024, 1e30, NaN, Infinity, -Infinity, -.5, 8.5];
  for (let run = 0; run < 100; run++) {
    const sample = [];
    for (let index = 0; index < 300; index++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; sample.push(choices[seed % choices.length]); }
    samples.push(sample);
  }
  for (const values of samples) {
    const expected = previousStatistics(values), actual = await coordinationStatistics(values);
    assert.deepEqual(actual.histogram, expected.histogram);
    assert.ok(Object.is(actual.meanCoordination, expected.meanCoordination));
  }
  const values = new Uint32Array(200_000).fill(12), controller = new AbortController();
  setTimeout(() => controller.abort(), 0);
  await assert.rejects(coordinationStatistics(values, controller.signal), { name: 'AbortError' });
  assert.ok(values.every(value => value === 12));
  await assert.rejects(coordinationStatistics(Uint32Array.of(8), controller.signal), { name: 'AbortError' });
});

test('expression numeric IDs retain signed zero and precision, while text and BigInt keep canonical conversion', () => {
  const base = crystalFrame('fcc', 1);
  for (const ids of [Float64Array.of(-0, 9007199254740991, NaN, Infinity), Uint32Array.of(0, 2 ** 32 - 1, 8, 12),
    [-0, '9007199254740991', '01', '1e2'], BigInt64Array.of(0n, 9007199254740993n, -2n, 7n)]) {
    const frame = { ...base, ids }, source = Array.from(ids), result = evaluateExpression(compileFrameExpression('ID', frame));
    const expected = source.map(id => {
      if (typeof id === 'bigint') return Number(id);
      if (typeof id === 'number') return id;
      const value = Number(String(id)); return String(id) !== '' && String(value) === String(id) ? value : NaN;
    });
    for (let index = 0; index < result.length; index++) assert.ok(Object.is(result[index], expected[index]));
    assert.deepEqual(Array.from(ids), source);
    const scope = createExpressionScope(frame), cached = scope.resolve('ID').load().data;
    assert.notEqual(cached, ids);
    assert.equal(scope.resolve('ID').load().data, cached, 'repeated binding reuses its private derived array');
  }
  const frame = { ...base, types: Uint16Array.of(0, 1, 2, 65535), typeLabels: ['Type 1', 'Type 7', 'Type 9007199254740991'] };
  assert.deepEqual(Array.from(evaluateExpression(compileFrameExpression('Type', frame))), [1, 7, 9007199254740991, NaN]);
  assert.deepEqual(Array.from(evaluateExpression(compileFrameExpression('Index', frame))), [0, 1, 2, 3]);
});

function summaryInputs(count, { shared = false, oneSite = false } = {}) {
  const allocate = (Type, length) => shared ? new Type(new SharedArrayBuffer(Type.BYTES_PER_ELEMENT * length)) : new Type(length);
  const siteIndex = allocate(Int32Array, count), currentTypes = allocate(Uint16Array, count), referenceTypes = allocate(Uint16Array, oneSite ? 1 : count);
  for (let atom = 0; atom < count; atom++) { siteIndex[atom] = oneSite ? 0 : Math.floor(atom / 2) * 2; currentTypes[atom] = atom % 2; }
  for (let site = 0; site < referenceTypes.length; site++) referenceTypes[site] = site % 2;
  return { siteIndex, siteCount: referenceTypes.length, currentTypes, currentTypeLabels: ['Fe', 'Ni'], referenceTypes, referenceTypeLabels: ['Ni', 'Fe'] };
}

test('asynchronous Wigner–Seitz summaries equal the synchronous oracle and yield inside highly occupied sites', async () => {
  for (const oneSite of [false, true]) {
    const input = summaryInputs(131_073, { oneSite }), expected = summarizeWignerSeitz(input); let yields = 0;
    const actual = await summarizeWignerSeitzAsync(input, { onYield() { yields++; } });
    assert.deepEqual(actual, expected);
    assert.ok(yields >= 8, 'all atom and site passes yield, including the inner shared-site loop');
    const controller = new AbortController();
    await assert.rejects(summarizeWignerSeitzAsync(input, { signal: controller.signal, onYield() { controller.abort(); } }), { name: 'AbortError' });
    assert.deepEqual(summarizeWignerSeitz(input), expected, 'cancellation leaves source arrays intact');
  }
});

function realPool(shared = false) {
  const messages = [], workers = [], terminations = [];
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 3 }, crossOriginIsolated: shared }, workerFactory: () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url)); workers.push(worker);
    return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfer) { messages.push({ kind: data.kind, fractional: data.fractional, transferCount: transfer?.length ?? 0 }); worker.postMessage(data, transfer); },
      terminate() { terminations.push(worker); worker.terminate(); } };
  } });
  return { pool, messages, workers, terminations };
}

function finalize(pool, input, { signal = new AbortController().signal, onPhase = () => {}, shared = false } = {}) {
  const { currentTypes, ...parameters } = input;
  return pool.runTask({ kind: 'wignerSeitzFinalize', ...parameters, types: currentTypes, siteDistance: new Float64Array(input.siteIndex.length),
    affineMapping: false, summaryRetainedBytes: currentTypes.byteLength + 2 * input.referenceTypes.byteLength
      + input.siteIndex.length * 25 + input.siteCount * 17 + 4 }, signal, signal, onPhase, shared);
}

test('real summary Worker transfers assignments only, preserves frame types and reuses warmed modules in private/shared modes', async () => {
  for (const shared of [false, true]) {
    const { pool, messages, workers, terminations } = realPool(shared), input = summaryInputs(131_073, { shared });
    const expected = summarizeWignerSeitz(input), canonicalTypes = input.currentTypes.slice(), referenceTypes = input.referenceTypes.slice();
    try {
      await pool.warmupCpu({ atomCount: 1, modules: ['ptm'] });
      const warmedHeapBytes = [...pool.slots][0].moduleHeapBytes.ptm;
      const result = await finalize(pool, input, { shared });
      for (const [name, value] of Object.entries(expected)) assert.deepEqual(result[name], value, name);
      assert.deepEqual(input.currentTypes, canonicalTypes); assert.deepEqual(input.referenceTypes, referenceTypes);
      assert.equal(result.nativeHeapBytes.ptm, warmedHeapBytes);
      const next = await finalize(pool, summaryInputs(8, { shared }), { shared });
      assert.equal(next.atomCount, 8); assert.equal(workers.length, 1); assert.equal(terminations.length, 0);
      const uploads = messages.filter(message => message.kind === 'wignerSeitzFinalize');
      assert.ok(uploads.every(message => message.fractional === undefined));
      assert.equal(uploads[0].transferCount, shared ? 1 : 4, 'shared assignments/types stay shared; private sources use owned copies');
      assert.equal(pool.cpuBudget.active, 0);
    } finally { pool.close(); }
  }
});

test('cancelling posted summary retains its CPU permit until ACK and keeps the same warm Worker for following work', async () => {
  const { pool, workers, messages, terminations } = realPool(), controller = new AbortController();
  try {
    await pool.warmupCpu({ atomCount: 1, modules: ['ptm'] });
    const first = finalize(pool, summaryInputs(300_000, { oneSite: true }), { signal: controller.signal,
      onPhase(phase) { if (phase === 'finalizing') controller.abort(); } });
    await assert.rejects(first, { name: 'AbortError' });
    assert.ok(pool.active.size >= 1, 'the posted job is still owned until the cancellation ACK');
    const summaryTask = [...pool.active].find(task => task.payload.kind === 'wignerSeitzFinalize');
    assert.equal(pool.cpuRetainedInputBytes(), summaryTask.payload.summaryRetainedBytes, 'transient tables remain charged after caller cancellation');
    const next = await finalize(pool, summaryInputs(16));
    assert.equal(next.atomCount, 16); assert.equal(workers.length, 1); assert.equal(terminations.length, 0);
    assert.ok(messages.some(message => message.kind === 'wignerSeitzCancel'));
    assert.equal(pool.active.size, 0);
    assert.equal(pool.cpuRetainedInputBytes(), 0, 'the ACK releases the transient table reservation');
  } finally { pool.close(); }
});

test('queued summary admission counts each task once and cancellation releases its reservation without a Worker', async () => {
  const { pool, workers } = realPool(), controller = new AbortController();
  const lease = await pool.cpuBudget.acquire(1);
  try {
    const pending = finalize(pool, summaryInputs(100_000), { signal: controller.signal });
    const task = [...pool.active][0];
    assert.equal(pool.cpuRetainedInputBytes(), task.payload.summaryRetainedBytes);
    pool.queue.push(task);
    assert.equal(pool.cpuRetainedInputBytes(), task.payload.summaryRetainedBytes, 'active and queued references do not double-count');
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(pool.cpuRetainedInputBytes(), 0); assert.equal(workers.length, 0);
    assert.equal(pool.active.size, 0); assert.equal(pool.queue.length, 0);
  } finally { lease.release(); pool.close(); }
});

test('summary memory admission rejects before allocating type copies or posting the finalizer', async () => {
  const { pool, messages } = realPool(), input = summaryInputs(100_000);
  pool.environment.performance = { memory: { jsHeapSizeLimit: 1024 * 1024 } };
  pool.analyzeCPU = async () => ({ siteIndex: input.siteIndex, siteDistance: new Float64Array(input.siteIndex.length), workerCount: 1,
    sharedMemory: false, chunkCount: 1, elapsedMs: 1 });
  const frame = { ...crystalFrame('fcc', 1), fractional: new Float64Array(input.siteIndex.length * 3), types: input.currentTypes, typeLabels: input.currentTypeLabels };
  try {
    await assert.rejects(pool.analyzeWignerSeitz(frame, { referenceFractional: frame.fractional, referenceCell: frame.cell,
      referenceTypes: input.referenceTypes, referenceTypeLabels: input.referenceTypeLabels }), /CPU memory budget/);
    assert.equal(messages.length, 0); assert.equal(input.siteIndex.length, 100_000);
    assert.equal(pool.controllers.size, 0);
  } finally { pool.close(); }
});
