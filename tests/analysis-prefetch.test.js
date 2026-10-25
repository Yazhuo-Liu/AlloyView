import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisPrefetchScheduler } from '../src/application/analysis-prefetch.js';
import { createCell } from '../src/data/model.js';
import { createVisibleAnalysisRequests } from '../src/application/visible-analysis-requests.js';

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const frame = (index = 0) => ({ frameIndex: index, ids: Uint32Array.of(1, 2), types: Uint16Array.of(0, 0),
  fractional: Float64Array.of(.1, .2, .3, .4, .5, .6), positions: Float64Array.of(1, 2, 3, 4, 5, 6),
  cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }), properties: [] });

function harness(options = {}) {
  let nextId = 0, busy = false;
  const timers = new Map(), calls = [], promotions = [];
  const pool = { gpuEnabled: false, gpuBackend: { fallbackGeneration: 0 }, canReuseRoutingResult: () => true,
    promoteAnalysis: signal => promotions.push(signal),
    cancelBackgroundAnalyses() {},
    analyze(target, parameters, request) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      calls.push({ target, parameters, request, resolve, reject });
      return promise;
    } };
  const scheduler = new AnalysisPrefetchScheduler({ pool, isIdle: () => !busy,
    schedule: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    cancelSchedule: id => timers.delete(id), ...options });
  scheduler.setSourceKey('source:1');
  return { scheduler, pool, calls, promotions, timers, setBusy: value => { busy = value; },
    async tick() {
      const [id, timer] = timers.entries().next().value ?? [];
      assert.ok(timer, 'a background timer exists'); timers.delete(id); timer.callback(); await flush();
    } };
}

test('visible prediction waits for idle resources and does not publish scientific properties', async () => {
  const { scheduler, calls, tick, setBusy, timers } = harness();
  const target = frame(1); let reads = 0;
  setBusy(true);
  scheduler.schedule({ frameIndex: 1, getFrame: async () => { reads++; return target; }, requests: [{ kind: 'cna', mode: 'adaptive' }] });
  assert.equal(calls.length, 0);
  await tick(); assert.equal(reads, 0); assert.equal(timers.size, 1);
  setBusy(false); await tick(); assert.equal(reads, 1); assert.equal(calls.length, 1);
  assert.equal(calls[0].request.background, true);
  const result = { structures: Uint8Array.of(1, 1), backend: 'cpu', engine: 'js-worker' };
  calls[0].resolve(result); await flush();
  assert.deepEqual(target.properties, [], 'prediction never inserts current-frame values or metadata');
  const foreground = await scheduler.analyze(target, { mode: 'adaptive', kind: 'cna' });
  assert.equal(foreground, result); assert.equal(calls.length, 1); assert.equal(scheduler.stats.cacheHits, 1);
  assert.equal(scheduler.cache.values().next().value.frame, undefined, 'completed cache does not strongly retain the parsed frame');
});

test('a foreground request promotes and joins its running prediction without restarting it', async () => {
  const { scheduler, calls, promotions, tick } = harness();
  const target = frame(1), parameters = { kind: 'ptm', flags: 31, rmsdCutoff: .1 };
  scheduler.schedule({ frameIndex: 1, getFrame: async () => target, requests: [parameters] });
  await tick(); assert.equal(calls.length, 1);
  scheduler.cancel({ keepFrameIndex: 1 });
  const foreground = scheduler.analyze(target, parameters, { frameIndex: 1 });
  assert.equal(calls.length, 1); assert.deepEqual(promotions, [calls[0].request.signal]);
  const result = { structures: Uint8Array.of(1, 2), backend: 'cpu' };
  calls[0].resolve(result);
  assert.equal(await foreground, result); assert.equal(scheduler.stats.joined, 1);
});

test('a request promoted before pool dispatch starts at foreground priority', async () => {
  const { scheduler, calls } = harness();
  const target = frame(1), parameters = { kind: 'cna', mode: 'adaptive' };
  const entry = scheduler.start(target, parameters, { frameIndex: 1, background: true });
  const foreground = scheduler.analyze(target, parameters);
  await flush(); assert.equal(calls[0].request.background, false);
  calls[0].resolve({ structures: Uint8Array.of(1, 1) });
  await foreground; await entry.promise;
});

test('cancelled speculation does not cancel a foreground subscriber, and consumers cancel independently', async () => {
  const { scheduler, calls, tick } = harness();
  const target = frame(2), parameters = { kind: 'coordination', cutoff: 3 };
  scheduler.schedule({ frameIndex: 2, getFrame: async () => target, requests: [parameters] });
  await tick();
  const first = new AbortController(), second = new AbortController();
  const abandoned = scheduler.analyze(target, parameters, { signal: first.signal });
  const retained = scheduler.analyze(target, parameters, { signal: second.signal });
  const rejected = assert.rejects(abandoned, { name: 'AbortError' });
  scheduler.cancel(); first.abort();
  assert.equal(calls[0].request.signal.aborted, false, 'second foreground subscriber still owns the work');
  await rejected;
  const result = { coordination: Uint32Array.of(4, 5), backend: 'cpu' };
  calls[0].resolve(result); assert.equal(await retained, result);
});

test('abandoning the final foreground owner cancels its now-unneeded prediction', async () => {
  const { scheduler, calls, tick } = harness();
  const target = frame(1), parameters = { kind: 'cna', mode: 'adaptive' };
  scheduler.schedule({ frameIndex: 1, getFrame: async () => target, requests: [parameters] });
  await tick();
  const controller = new AbortController();
  const foreground = scheduler.analyze(target, parameters, { signal: controller.signal });
  const rejected = assert.rejects(foreground, { name: 'AbortError' });
  scheduler.cancel(); controller.abort(); await rejected;
  assert.equal(calls[0].request.signal.aborted, true);
  calls[0].resolve({ structures: Uint8Array.of(1, 1) }); await flush();
  assert.equal(scheduler.cache.size, 0);
});

test('source changes reject late results and cancel obsolete target reads', async () => {
  const { scheduler, calls, tick } = harness();
  const target = frame(1); let readSignal;
  scheduler.schedule({ frameIndex: 1, getFrame: async (_, options) => { readSignal = options.signal; return target; }, requests: [{ kind: 'cna' }] });
  await tick(); scheduler.setSourceKey('source:2');
  assert.equal(readSignal.aborted, true); assert.equal(calls[0].request.signal.aborted, true);
  calls[0].resolve({ structures: Uint8Array.of(1, 1) }); await flush();
  assert.equal(scheduler.cache.size, 0); assert.equal(scheduler.pending.size, 0);
});

test('changing prediction target cancels the old read even when a different target is retained', async () => {
  const { scheduler, tick } = harness();
  let oldSignal;
  scheduler.schedule({ frameIndex: 1, getFrame: (_, options) => { oldSignal = options.signal; return new Promise(() => {}); }, requests: [{ kind: 'cna' }] });
  await tick();
  scheduler.schedule({ frameIndex: 9, getFrame: async () => frame(9), requests: [{ kind: 'cna' }] });
  assert.equal(oldSignal.aborted, true);
  scheduler.cancel();
});

test('full parameter, geometry and backend keys prevent stale result reuse', async () => {
  const { scheduler, calls, pool } = harness();
  const target = frame(1);
  async function compute(parameters) {
    const pending = scheduler.analyze(target, parameters); await flush();
    const call = calls.at(-1), result = { values: Float32Array.of(calls.length, 0), backend: 'cpu' };
    call.resolve(result); return pending;
  }
  await compute({ kind: 'coordination', cutoff: 3 });
  await compute({ kind: 'coordination', cutoff: 4 });
  target.geometryRevision = 1; await compute({ kind: 'coordination', cutoff: 4 });
  target.cell.vectors[0] = 11; await compute({ kind: 'coordination', cutoff: 4 });
  target.fractional = target.fractional.slice(); await compute({ kind: 'coordination', cutoff: 4 });
  pool.gpuEnabled = true; await compute({ kind: 'coordination', cutoff: 4 });
  pool.gpuBackend.fallbackGeneration++; await compute({ kind: 'coordination', cutoff: 4 });
  assert.equal(calls.length, 7);
  const before = calls.length;
  await scheduler.analyze(target, { cutoff: 4, kind: 'coordination' });
  assert.equal(calls.length, before, 'plain parameter key order does not change semantics');
});

test('array inputs are keyed by immutable identity, not just lengths', async () => {
  const { scheduler, calls } = harness(); const target = frame(1);
  const first = scheduler.analyze(target, { kind: 'centrosymmetry', mode: 'auto', structureInput: Uint8Array.of(1, 1) }); await flush();
  calls[0].resolve({ centrosymmetry: Float32Array.of(0, 0) }); await first;
  const second = scheduler.analyze(target, { kind: 'centrosymmetry', mode: 'auto', structureInput: Uint8Array.of(1, 1) }); await flush();
  assert.equal(calls.length, 2); calls[1].resolve({ centrosymmetry: Float32Array.of(0, 0) }); await second;
});

test('bounded cache charges aliased backing buffers once and evicts least recently used entries', async () => {
  const { scheduler, calls } = harness({ byteBudget: 128, maxEntries: 2 });
  const target = frame(1);
  async function add(cutoff, bytes = 64) {
    const pending = scheduler.analyze(target, { kind: 'coordination', cutoff }); await flush();
    const buffer = new ArrayBuffer(bytes), result = { values: new Uint8Array(buffer), alias: new Uint8Array(buffer) };
    calls.at(-1).resolve(result); await pending; return result;
  }
  await add(1); const retained = await add(2);
  assert.equal(scheduler.cacheBytes, 128);
  await scheduler.analyze(target, { kind: 'coordination', cutoff: 2 });
  await add(3); assert.equal(scheduler.cache.size, 2); assert.equal(scheduler.cacheBytes, 128);
  assert.equal(await scheduler.analyze(target, { kind: 'coordination', cutoff: 2 }), retained);
  const before = calls.length;
  await add(1); assert.equal(calls.length, before + 1, 'oldest entry was actually evicted');
  await add(9, 129); assert.equal(scheduler.cache.size, 2, 'oversize result is not retained');
  scheduler.configure({ byteBudget: 64 }); assert.equal(scheduler.cacheBytes, 64);
});

test('CNA and PTM dependency chains can precompute exact input arrays without publishing them', async () => {
  const { scheduler, calls, tick } = harness(); const target = frame(1);
  scheduler.schedule({ frameIndex: 1, getFrame: async () => target, requests: () => [
    { kind: 'cna', mode: 'adaptive' },
    { parameters: results => ({ kind: 'centrosymmetry', mode: 'auto', structureInput: results[0].structures }) },
    { kind: 'ptm', flags: 31, rmsdCutoff: .1 },
    { parameters: results => ({ kind: 'strain', flags: 31, references: [{ type: 0, structure: 1, latticeConstant: 4 }], ptmInput: results[2] }) },
  ] });
  await tick(); const structures = Uint8Array.of(1, 1);
  calls[0].resolve({ structures }); await flush();
  assert.equal(calls[1].parameters.structureInput, structures);
  calls[1].resolve({ centrosymmetry: Float32Array.of(0, 0) }); await flush();
  const ptm = { structures, scales: Float64Array.of(1, 1), deformation: new Float64Array(18) };
  calls[2].resolve(ptm); await flush(); assert.equal(calls[3].parameters.ptmInput, ptm);
  calls[3].resolve({ atomicShearStrain: Float32Array.of(0, 0) }); await flush();
  assert.deepEqual(target.properties, []);
  const before = calls.length;
  await scheduler.analyze(target, calls[1].parameters); assert.equal(calls.length, before);
  await scheduler.analyze(target, { ...calls[3].parameters,
    ptmInput: { ...ptm, key: 'published UI fit metadata', orientations: new Float64Array(8) } });
  assert.equal(calls.length, before, 'decorated current-frame PTM uses the exact same scientific tensor inputs');
});

test('routing policy refusal recomputes instead of hiding a requested fresh backend probe', async () => {
  const { scheduler, calls, pool } = harness(); const target = frame();
  const first = scheduler.analyze(target, { kind: 'cna' }); await flush(); calls[0].resolve({ structures: Uint8Array.of(1, 1) }); await first;
  pool.canReuseRoutingResult = () => false;
  const second = scheduler.analyze(target, { kind: 'cna' }); await flush(); assert.equal(calls.length, 2);
  calls[1].resolve({ structures: Uint8Array.of(1, 1) }); await second;
});

test('a cached progress callback can cancel or fail without returning a successful result', async () => {
  const { scheduler, calls } = harness(); const target = frame();
  const first = scheduler.analyze(target, { kind: 'cna' }); await flush(); calls[0].resolve({ structures: Uint8Array.of(1, 1) }); await first;
  const controller = new AbortController();
  await assert.rejects(scheduler.analyze(target, { kind: 'cna' }, { signal: controller.signal, onProgress: () => controller.abort() }), { name: 'AbortError' });
  await assert.rejects(scheduler.analyze(target, { kind: 'cna' }, { onProgress: () => { throw new Error('UI failed'); } }), /UI failed/);
});

test('revisiting a formally calculated frame reuses its scientific input instead of predicting duplicate work', async () => {
  const { scheduler, calls, tick } = harness(); const target = frame(1), structures = Uint8Array.of(1, 1);
  target.properties.push({ name: 'structureType', analysisKind: 'cna', analysisKey: JSON.stringify({ mode: 'adaptive' }),
    analysisGpuRequested: false, data: structures });
  scheduler.schedule({ frameIndex: 1, getFrame: async () => target,
    requests: frame => createVisibleAnalysisRequests({ frame, quantity: 'property:centralSymmetry', gpuRequested: false,
      analyses: { cna: { enabled: true, parameters: { mode: 'adaptive' } }, centrosymmetry: { enabled: true, parameters: { mode: 'auto' } } } }) });
  await tick(); assert.equal(calls.length, 1); assert.equal(calls[0].parameters.kind, 'centrosymmetry');
  assert.equal(calls[0].parameters.structureInput, structures); assert.equal(scheduler.stats.reusedFrameResults, 1);
  calls[0].resolve({ centrosymmetry: Float32Array.of(0, 0) }); await flush();
  assert.equal(target.properties.length, 1, 'the predicted CSP does not publish a scientific property');
});

test('foreground transaction barrier waits for a cancelled raw backend lifetime', async () => {
  const { scheduler, calls } = harness(); const controller = new AbortController();
  const foreground = scheduler.analyze(frame(1), { kind: 'cna' }, { signal: controller.signal });
  const rejected = assert.rejects(foreground, { name: 'AbortError' });
  await flush(); controller.abort(); await rejected;
  assert.equal(calls[0].request.signal.aborted, true);
  let settled = false;
  const barrier = scheduler.settleForeground().then(results => { settled = true; return results; });
  await flush(); assert.equal(settled, false, 'consumer cancellation does not pretend the raw computation has settled');
  calls[0].resolve({ structures: Uint8Array.of(1, 1) });
  const results = await barrier; assert.equal(settled, true); assert.equal(results.length, 1);
  assert.equal(results[0].status, 'rejected'); assert.equal(scheduler.foregroundLifetimes.size, 0);
});

test('source clearing keeps dispatched foreground lifetimes in the transaction barrier', async () => {
  const { scheduler, calls } = harness();
  const foreground = scheduler.analyze(frame(1), { kind: 'coordination', cutoff: 3 });
  const rejected = assert.rejects(foreground, { name: 'AbortError' });
  await flush(); scheduler.clearSource();
  assert.equal(scheduler.pending.size, 0); assert.equal(scheduler.foregroundLifetimes.size, 1);
  let settled = false;
  const barrier = scheduler.settleForeground().then(() => { settled = true; });
  await flush(); assert.equal(settled, false);
  calls[0].resolve({ coordination: Uint32Array.of(4, 5) });
  await rejected; await barrier; assert.equal(settled, true);
});

test('promoted predictions join the strict barrier, while pure predictions do not', async () => {
  const { scheduler, calls, tick } = harness(); const target = frame(1), parameters = { kind: 'cna' };
  scheduler.schedule({ frameIndex: 1, getFrame: async () => target, requests: [parameters] });
  await tick(); assert.equal(scheduler.foregroundLifetimes.size, 0);
  assert.deepEqual(await scheduler.settleForeground(), [], 'unrequested background prediction cannot block a recipe');
  const controller = new AbortController(), foreground = scheduler.analyze(target, parameters, { signal: controller.signal });
  const rejected = assert.rejects(foreground, { name: 'AbortError' });
  scheduler.cancel(); controller.abort(); await rejected;
  let settled = false; const barrier = scheduler.settleForeground().then(() => { settled = true; });
  await flush(); assert.equal(settled, false);
  calls[0].resolve({ structures: Uint8Array.of(1, 1) }); await barrier;
});

test('foreground barrier snapshots existing owners without waiting for later work', async () => {
  const { scheduler, calls } = harness();
  const first = scheduler.analyze(frame(1), { kind: 'cna' }); await flush();
  const barrier = scheduler.settleForeground();
  const second = scheduler.analyze(frame(2), { kind: 'cna' }); await flush();
  calls[0].resolve({ structures: Uint8Array.of(1, 1) }); await first; await barrier;
  assert.equal(scheduler.foregroundLifetimes.size, 1, 'new foreground work is not part of the earlier transaction');
  calls[1].resolve({ structures: Uint8Array.of(1, 1) }); await second;
});

test('nonpredictable delegated foreground analyses also participate in the explicit barrier', async () => {
  const { scheduler, calls } = harness();
  const foreground = scheduler.analyze(frame(1), { kind: 'voronoi' });
  let settled = false; const barrier = scheduler.settleForeground().then(() => { settled = true; });
  await flush(); assert.equal(settled, false);
  calls[0].resolve({ volume: Float32Array.of(1, 1) }); await foreground; await barrier;
  assert.equal(scheduler.foregroundLifetimes.size, 0);
});

test('a foreground scope records its calls before dispatch and ignores earlier unrelated work', async () => {
  const { scheduler, calls } = harness();
  const unrelated = scheduler.analyze(frame(0), { kind: 'cna' }); await flush();
  const scope = scheduler.createForegroundScope();
  const owned = scheduler.analyze(frame(1), { kind: 'cna' });
  let settled = false; const barrier = scope.settle().then(() => { settled = true; });
  await flush(); assert.equal(calls.length, 2); assert.equal(settled, false);
  calls[1].resolve({ structures: Uint8Array.of(1, 1) }); await owned; await barrier;
  assert.equal(scheduler.foregroundLifetimes.size, 1, 'earlier unrelated raw work does not hold the recipe scope');
  calls[0].resolve({ structures: Uint8Array.of(1, 1) }); await unrelated;
});

test('a foreground scope survives source clearing and waits for a cancelled raw owner', async () => {
  const { scheduler, calls } = harness(), scope = scheduler.createForegroundScope(), controller = new AbortController();
  const owned = scheduler.analyze(frame(1), { kind: 'cna' }, { signal: controller.signal });
  const rejected = assert.rejects(owned, { name: 'AbortError' });
  await flush(); controller.abort(); await rejected; scheduler.clearSource();
  let settled = false; const barrier = scope.settle().then(results => { settled = true; return results; });
  await flush(); assert.equal(settled, false);
  calls[0].resolve({ structures: Uint8Array.of(1, 1) });
  const results = await barrier; assert.equal(results[0].status, 'rejected');
  assert.equal(scheduler.foregroundScopes.size, 0);
});

test('scopes record foreground promotion, exclude pure prediction, and close idempotently', async () => {
  const { scheduler, calls, tick } = harness(), target = frame(1), parameters = { kind: 'cna' };
  const emptyScope = scheduler.createForegroundScope();
  scheduler.schedule({ frameIndex: 1, getFrame: async () => target, requests: [parameters] }); await tick();
  assert.deepEqual(await emptyScope.settle(), [], 'pure speculative work is not foreground transaction work');
  const scope = scheduler.createForegroundScope(), promoted = scheduler.analyze(target, parameters);
  const barrier = scope.settle(); assert.equal(scope.settle(), barrier, 'settle closes a scope once');
  const later = scheduler.analyze(frame(2), { kind: 'coordination', cutoff: 3 }); await flush();
  calls[0].resolve({ structures: Uint8Array.of(1, 1) }); await promoted; await barrier;
  assert.equal(scheduler.foregroundLifetimes.size, 1, 'later user requests do not extend the closed scope');
  calls[1].resolve({ coordination: Uint32Array.of(4, 5) }); await later;
});
