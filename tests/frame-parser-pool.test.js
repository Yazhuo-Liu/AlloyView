import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameParserPool } from '../src/data/frame-parser-pool.js';
import { CpuBudget } from '../src/analysis/cpu-budget.js';

class ParserWorker {
  constructor() { this.listeners = new Map(); this.messages = []; }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  complete(frame = {}) { this.listeners.get('message')({ data: { id: this.messages.at(-1).id, ok: true, frame } }); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const workers = [];
  const pool = new FrameParserPool({ backgroundCount: 2, workerFactory: () => {
    const worker = new ParserWorker(); workers.push(worker); return worker;
  }, ...options });
  return { pool, workers };
}

test('prefetch parses concurrently and leaves a separate foreground lane available', async () => {
  const { pool, workers } = fixture();
  const bg1 = pool.parse({ index: 1 }, { background: true });
  const bg2 = pool.parse({ index: 2 }, { background: true });
  const bg3 = pool.parse({ index: 3 }, { background: true });
  const foreground = pool.parse({ index: 50 });
  await tick();
  assert.equal(workers.length, 3);
  assert.deepEqual(workers.map(worker => worker.messages[0].descriptor.index), [1, 2, 50]);
  workers[2].complete({ selected: true });
  assert.deepEqual(await foreground, { selected: true });
  workers[0].complete();
  await tick();
  assert.equal(workers[0].messages[1].descriptor.index, 3, 'idle background parser is reused');
  workers[1].complete(); workers[0].complete();
  await Promise.all([bg1, bg2, bg3]);
  pool.close();
});

test('cancelling prefetch removes queued work and reuses active parsers without disrupting foreground', async () => {
  const { pool, workers } = fixture({ backgroundCount: 1 });
  const controller = new AbortController();
  const bg1 = pool.parse({ index: 1 }, { background: true, signal: controller.signal });
  const bg2 = pool.parse({ index: 2 }, { background: true, signal: controller.signal });
  const foreground = pool.parse({ index: 20 });
  const failures = Promise.all([assert.rejects(bg1, { name: 'AbortError' }), assert.rejects(bg2, { name: 'AbortError' })]);
  await tick();
  controller.abort();
  await failures;
  assert.equal(workers[0].terminated, undefined, 'active parser remains reusable');
  assert.equal(workers[1].terminated, undefined);
  workers[1].complete({ requested: 20 });
  assert.deepEqual(await foreground, { requested: 20 });
  assert.equal(pool.queue.length, 0);
  const next = pool.parse({ index: 3 }, { background: true });
  await tick();
  assert.equal(workers.length, 2, 'cancellation creates no replacement Worker');
  workers[0].complete({ stale: true }); // A cancelled parser response only releases its slot.
  await tick();
  assert.equal(workers[0].messages.at(-1).descriptor.index, 3);
  workers[0].complete({ current: true });
  assert.deepEqual(await next, { current: true });
  pool.close();
});

test('parser jobs share the computation budget and foreground precedes queued speculative work', async () => {
  const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 3 } } });
  const { pool, workers } = fixture({ acquire: ({ background, signal }) => budget.acquire(1, { signal, priority: background ? -20 : 20 }) });
  const first = pool.parse({ index: 1 }, { background: true });
  const second = pool.parse({ index: 2 }, { background: true });
  const foreground = pool.parse({ index: 90 });
  await tick();
  assert.equal(workers.length, 1);
  assert.equal(budget.active, 1);
  workers[0].complete();
  await first; await tick();
  assert.equal(workers[1].messages[0].descriptor.index, 90);
  assert.equal(budget.active, 1);
  workers[1].complete();
  await foreground; await tick();
  assert.equal(workers[2].messages[0].descriptor.index, 2);
  workers[2].complete();
  await second;
  assert.equal(budget.active, 0);
  pool.close();
});

test('prefetch concurrency shrinks for large atom arrays', () => {
  const { pool } = fixture({ backgroundCount: 4 });
  pool.setAtomCount(1_000_000);
  assert.equal(pool.backgroundCount, 2);
  pool.setAtomCount(4_000_000);
  assert.equal(pool.backgroundCount, 1);
  pool.close();
});

test('an active cancelled parser retains its CPU lease until acknowledgement and then is reused', async () => {
  const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 3 } } });
  const { pool, workers } = fixture({ acquire: ({ priority, signal }) => budget.acquire(1, { signal, priority }) });
  const controller = new AbortController();
  const background = pool.parse({ index: 1 }, { background: true, signal: controller.signal });
  await tick();
  const rejected = assert.rejects(background, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.equal(budget.active, 1, 'numeric parse is still running');
  const foreground = pool.parse({ index: 50 });
  await tick();
  assert.equal(workers.length, 1);
  workers[0].complete({ discarded: true });
  await tick();
  assert.equal(workers[1].messages[0].descriptor.index, 50);
  assert.equal(budget.active, 1);
  workers[1].complete();
  await foreground;
  assert.equal(budget.active, 0);
  const next = pool.parse({ index: 2 }, { background: true });
  await tick();
  assert.equal(workers.length, 2);
  workers[0].complete({ reused: true });
  assert.deepEqual(await next, { reused: true });
  pool.close();
});

test('closing while a foreground parser awaits CPU capacity cancels cleanly without leaking permits', async () => {
  const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 3 } } });
  const occupied = await budget.acquire(1);
  const { pool, workers } = fixture({ acquire: ({ priority, signal }) => budget.acquire(1, { signal, priority }) });
  const frame = pool.parse({ index: 1 });
  const rejected = assert.rejects(frame, { name: 'AbortError' });
  await tick();
  assert.equal(budget.queue.length, 1);
  pool.close();
  await rejected;
  assert.equal(workers.length, 0);
  assert.equal(budget.queue.length, 0);
  occupied.release();
  assert.equal(budget.active, 0);
});
