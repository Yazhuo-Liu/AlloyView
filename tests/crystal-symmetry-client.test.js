import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { CpuBudget } from '../src/analysis/cpu-budget.js';
import { CrystalSymmetryClient } from '../src/analysis/crystal-symmetry-client.js';
import { crystalFrame } from './helpers/crystals.js';

const budget = () => new CpuBudget({ environment: { navigator: { hardwareConcurrency: 3 } } });
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for symmetry Worker.'); await new Promise(resolve => setImmediate(resolve)); }
}
class FakeWorker {
  constructor() { this.listeners = new Map(); this.messages = []; }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  postMessage(message, transfer) { this.messages.push(structuredClone(message, { transfer })); }
  emit(type, value) { for (const callback of this.listeners.get(type) ?? []) callback(value); }
  reply(message = this.messages.at(-1), result = {}) { this.emit('message', { data: { id: message.id, ok: true, result } }); }
  terminate() { this.terminated = true; }
}

test('real global symmetry Worker retains its native memory and budget without detaching displayed geometry', async t => {
  const workers = [], cpuBudget = budget();
  const client = new CrystalSymmetryClient({ cpuBudget, workerFactory: () => {
    const worker = new NodeWorker(new URL('./helpers/node-crystal-symmetry-worker.mjs', import.meta.url)); workers.push(worker);
    return { addEventListener(type, callback) { worker.on(type, event => callback(type === 'message' ? { data: event } : event)); },
      postMessage(message, transfer) { worker.postMessage(message, transfer); }, terminate() { worker.terminate(); } };
  } });
  t.after(() => client.dispose());
  const frame = crystalFrame('fcc', 1), before = structuredClone(frame);
  Object.defineProperty(frame, 'analysisCache', { get() { throw new Error('Do not copy unrelated analysis caches.'); }, enumerable: true });
  await client.warm(); const result = await client.analyze(frame); client.clear();
  const next = await client.analyze(crystalFrame('bcc', 1));
  assert.equal(result.number, 225); assert.equal(next.number, 229); assert.equal(workers.length, 1);
  assert.ok(next.memoryBytes >= result.memoryBytes);
  assert.deepEqual(frame.fractional, before.fractional); assert.deepEqual(frame.types, before.types); assert.deepEqual(frame.positions, before.positions);
  assert.equal(cpuBudget.active, 0);
});

test('cancelling native symmetry holds its CPU lease until ACK and retains the same Worker for queued work', async t => {
  const worker = new FakeWorker(), cpuBudget = budget(), client = new CrystalSymmetryClient({ cpuBudget, workerFactory: () => worker });
  t.after(() => client.dispose());
  const abort = new AbortController();
  const first = client.analyze(crystalFrame('fcc', 1), {}, { signal: abort.signal });
  await until(() => worker.messages.length === 1);
  const rejected = assert.rejects(first, { name: 'AbortError' }); abort.abort(); await rejected;
  assert.equal(cpuBudget.active, 1); assert.equal(worker.terminated, undefined);
  const second = client.analyze(crystalFrame('bcc', 1));
  assert.equal(worker.messages.length, 1);
  worker.reply(worker.messages[0], { obsolete: true });
  await until(() => worker.messages.length === 2);
  worker.reply(worker.messages[1], { number: 229 }); assert.equal((await second).number, 229);
  assert.equal(cpuBudget.active, 0);
});

test('queued cancellation never allocates a Worker; changed disorder is revalidated before dispatch', async t => {
  const worker = new FakeWorker(), cpuBudget = budget(), client = new CrystalSymmetryClient({ cpuBudget, workerFactory: () => worker });
  t.after(() => client.dispose());
  const lease = await cpuBudget.acquire(), abort = new AbortController();
  const cancelled = client.analyze(crystalFrame('fcc', 1), {}, { signal: abort.signal });
  const rejected = assert.rejects(cancelled, { name: 'AbortError' }); abort.abort(); await rejected;
  await until(() => !client.active); assert.equal(client.worker, null);
  const frame = crystalFrame('bcc', 1), invalid = client.analyze(frame);
  frame.crystal = { disordered: true }; lease.release();
  await assert.rejects(invalid, /disordered/); assert.equal(worker.messages.length, 0); assert.equal(cpuBudget.active, 0);
});

test('fatal errors retire only the broken Worker and recover queued requests', async t => {
  const workers = [], cpuBudget = budget();
  const client = new CrystalSymmetryClient({ cpuBudget, workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  t.after(() => client.dispose());
  const first = client.analyze(crystalFrame('fcc', 1));
  await until(() => workers[0]?.messages.length === 1);
  const second = client.analyze(crystalFrame('bcc', 1));
  const rejected = assert.rejects(first, /failed/); workers[0].emit('error', { message: 'native failed' }); await rejected;
  await until(() => workers[1]?.messages.length === 1);
  assert.equal(workers[0].terminated, true); workers[0].reply();
  workers[1].reply(undefined, { number: 229 }); assert.equal((await second).number, 229);
  assert.equal(cpuBudget.active, 0);
});
