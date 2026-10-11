import assert from 'node:assert/strict';
import test from 'node:test';
import { StructureWorkerClient } from '../src/worker-client.js';
import { CpuBudget } from '../src/analysis/cpu-budget.js';

class FakeWorker {
  static all = [];
  constructor() { this.listeners = new Map(); this.messages = []; FakeWorker.all.push(this); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  emit(data) { this.listeners.get('message')({ data }); }
}
const file = name => new File(['1\nframe\nFe 0 0 0\n'], name);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, options = {}) {
  const original = globalThis.Worker;
  globalThis.Worker = FakeWorker; FakeWorker.all = [];
  const client = new StructureWorkerClient(() => {}, options);
  t.after(() => { client.close(); globalThis.Worker = original; });
  const result = { format: 'xyz', frameCount: 8, frame: { title: 'original' } };
  const load = client.load(file('original.xyz'));
  client.worker.emit({ id: client.loadId, ok: true, result });
  await load;
  client.sourceInfo = { format: 'xyz', frameCount: 8, indexComplete: true };
  return client;
}
function firstFrame(client, result = { format: 'xyz', frameCount: 12, frame: { title: 'replacement' } }) {
  const candidate = client.stagedSource.candidate;
  const worker = candidate.worker;
  worker.emit({ event: 'source-info', loadId: candidate.loadId, result: { format: result.format, frameCount: result.frameCount, indexComplete: false } });
  worker.emit({ id: candidate.loadId, ok: true, result });
  return worker;
}

test('a malformed candidate preserves the real old backend, index, identity and uncached readers', async t => {
  const client = await fixture(t);
  const worker = client.worker, generation = client.sourceGeneration, info = client.sourceInfo;
  const read = client.frame(7, { background: true });
  const readId = worker.messages.at(-1).id;
  const pending = client.prepareSource(file('bad.xyz'));
  const rejected = assert.rejects(pending, /incomplete atom row/);
  const candidate = client.stagedSource.candidate;
  candidate.worker.emit({ id: candidate.loadId, ok: false, error: 'incomplete atom row' });
  await rejected;
  assert.equal(client.worker, worker);
  assert.equal(worker.terminated, undefined);
  assert.equal(candidate.worker, null, 'only the candidate backend was disposed');
  assert.equal(client.sourceGeneration, generation);
  assert.equal(client.sourceInfo, info);
  worker.emit({ id: readId, ok: true, result: { frame: { title: 'uncached original frame' }, index: 7 } });
  assert.equal((await read).frame.title, 'uncached original frame');
});

test('a ready candidate remains private until explicit commit and forwards subsequent index updates', async t => {
  const updates = [], client = await fixture(t, { onSourceInfo: info => updates.push(info) });
  const worker = client.worker, oldInfo = client.sourceInfo;
  const pending = client.prepareSource(file('next.xyz'));
  const nextWorker = firstFrame(client);
  const prepared = await pending;
  assert.equal(client.worker, worker);
  assert.equal(client.sourceInfo, oldInfo);
  assert.deepEqual(updates, []);
  assert.equal(prepared.sourceInfo.frameCount, 12);
  assert.equal(prepared.commit().frame.title, 'replacement');
  assert.equal(client.worker, nextWorker);
  assert.equal(worker.terminated, true);
  assert.equal(nextWorker.terminated, undefined);
  nextWorker.emit({ event: 'source-info', loadId: client.loadId, result: { format: 'xyz', frameCount: 30, indexComplete: true } });
  assert.equal(client.sourceInfo.frameCount, 30);
  assert.equal(prepared.sourceInfo, client.sourceInfo);
  assert.equal(updates.length, 1);
  const read = client.frame(29);
  const id = nextWorker.messages.at(-1).id;
  nextWorker.emit({ id, ok: true, result: { index: 29, frame: { title: 'new uncached frame' } } });
  assert.equal((await read).frame.title, 'new uncached frame');
  prepared.cancel();
  assert.equal(nextWorker.terminated, undefined, 'finally disposing the transaction does not close the committed source');
});

test('both source parsers share one CPU quota and rejecting the candidate releases only its lease', async t => {
  const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 4 } } });
  const client = await fixture(t, { cpuBudget: budget });
  const worker = client.worker;
  worker.emit({ event: 'cpu-acquire', leaseId: 1, background: false });
  await tick();
  assert.equal(budget.active, 1);
  const pending = client.prepareSource(file('bad.xyz'));
  const rejected = assert.rejects(pending, /bad candidate/);
  const candidate = client.stagedSource.candidate, nextWorker = candidate.worker;
  nextWorker.emit({ event: 'cpu-acquire', leaseId: 1, background: false });
  await tick();
  assert.equal(budget.active, 2, 'matching local lease IDs belong to separate source clients');
  nextWorker.emit({ id: candidate.loadId, ok: false, error: 'bad candidate' });
  await rejected;
  assert.equal(budget.active, 1);
  assert.equal(client.cpuLeases.size, 1);
  worker.emit({ event: 'cpu-release', leaseId: 1 });
  assert.equal(budget.active, 0);
});

test('commit adopts an admitted and a queued candidate lease without releasing native work early', async t => {
  const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 4 } } });
  const client = await fixture(t, { cpuBudget: budget });
  const pending = client.prepareSource(file('next.xyz'));
  const candidate = client.stagedSource.candidate;
  const nextWorker = candidate.worker;
  nextWorker.emit({ event: 'cpu-acquire', leaseId: 1, background: false });
  nextWorker.emit({ event: 'cpu-acquire', leaseId: 2, background: false });
  nextWorker.emit({ event: 'cpu-acquire', leaseId: 3, background: false });
  await tick();
  assert.equal(budget.active, 2);
  assert.equal(budget.queue.length, 1);
  firstFrame(client);
  const prepared = await pending;
  prepared.commit();
  assert.equal(budget.active, 2);
  assert.equal(client.cpuLeases.size, 3);
  nextWorker.emit({ event: 'cpu-release', leaseId: 1 });
  await tick();
  assert.equal(budget.active, 2);
  assert.ok(nextWorker.messages.some(message => message.type === 'cpu-granted' && message.payload.leaseId === 3));
  nextWorker.emit({ event: 'cpu-release', leaseId: 2 });
  nextWorker.emit({ event: 'cpu-release', leaseId: 3 });
  assert.equal(budget.active, 0);
  assert.equal(client.cpuLeases.size, 0);
});

test('cancel while a candidate waits for CPU capacity leaves the old source usable and allocates no stale permits', async t => {
  const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 3 } } });
  const client = await fixture(t, { cpuBudget: budget });
  const blocking = await budget.acquire(1), worker = client.worker, controller = new AbortController();
  const pending = client.prepareSource(file('next.xyz'), { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  const candidate = client.stagedSource.candidate, nextWorker = candidate.worker;
  nextWorker.emit({ event: 'cpu-acquire', leaseId: 1, background: false });
  await tick();
  assert.equal(budget.queue.length, 1);
  controller.abort();
  await rejected;
  await tick();
  assert.equal(client.worker, worker);
  assert.equal(worker.terminated, undefined);
  assert.equal(nextWorker.terminated, true);
  assert.equal(budget.queue.length, 0);
  blocking.release();
  assert.equal(budget.active, 0);
});

test('a cancelled ready candidate cannot commit or resurrect its source after a later selection', async t => {
  const client = await fixture(t);
  const worker = client.worker;
  const pending = client.prepareSource(file('one.xyz'));
  const firstWorker = firstFrame(client);
  const first = await pending;
  const replacement = client.prepareSource(file('two.xyz'));
  assert.equal(firstWorker.terminated, true);
  assert.throws(() => first.commit(), { name: 'AbortError' });
  const secondWorker = firstFrame(client);
  const second = await replacement;
  firstWorker.emit({ event: 'source-info', loadId: 1, result: { format: 'xyz', frameCount: 99, indexComplete: true } });
  assert.equal(client.worker, worker);
  second.commit();
  assert.equal(client.worker, secondWorker);
  assert.equal(client.sourceInfo.frameCount, 12);
});

test('source close cancels an in-flight candidate and every active source reader', async t => {
  const client = await fixture(t);
  const worker = client.worker;
  const frame = client.frame(7);
  const pending = client.prepareSource(file('next.xyz'));
  const nextWorker = client.stagedSource.candidate.worker;
  const rejected = Promise.all([assert.rejects(frame, { name: 'AbortError' }), assert.rejects(pending, { name: 'AbortError' })]);
  client.reset();
  await rejected;
  assert.equal(worker.terminated, true);
  assert.equal(nextWorker.terminated, true);
  assert.equal(client.worker, null);
  assert.equal(client.pending.size, 0);
  assert.equal(client.stagedSource, null);
});

test('candidate transport failure cleans its own worker and a later successful retry replaces the same old backend', async t => {
  const client = await fixture(t);
  const worker = client.worker;
  const postMessage = FakeWorker.prototype.postMessage;
  FakeWorker.prototype.postMessage = function() { throw new DOMException('Candidate cannot clone file', 'DataCloneError'); };
  try { await assert.rejects(client.prepareSource(file('bad.xyz')), /cannot clone/); }
  finally { FakeWorker.prototype.postMessage = postMessage; }
  assert.equal(client.worker, worker);
  assert.equal(worker.terminated, undefined);
  assert.equal(client.stagedSource, null);
  const pending = client.prepareSource(file('next.xyz'));
  const nextWorker = firstFrame(client);
  (await pending).commit();
  assert.equal(client.worker, nextWorker);
  assert.equal(worker.terminated, true);
});
