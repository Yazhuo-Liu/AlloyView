import assert from 'node:assert/strict';
import test from 'node:test';

import { StructureWorkerClient } from '../src/worker-client.js';

class FakeWorker {
  constructor() {
    this.listeners = new Map();
    this.messages = [];
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() { this.terminated = true; }
}

test('load accepts a single File and preserves the legacy single-file message', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const client = new StructureWorkerClient();
    const file = new File(['Number of particles = 1'], 'structure.cfg');
    const pending = client.load(file);
    assert.deepEqual(client.worker.messages[0].payload.files, [file]);
    assert.equal(client.worker.messages[0].payload.file, file);
    client.handleMessage({ id: 1, ok: true, result: {} });
    await pending;
    client.close();
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('load retains every file in a FileList-like selection', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const client = new StructureWorkerClient();
    const files = [new File(['first'], 'frame.1.cfg'), new File(['second'], 'frame.2.cfg')];
    const pending = client.load({ 0: files[0], 1: files[1], length: 2 });
    assert.deepEqual(client.worker.messages[0].payload.files, files);
    assert.equal(client.worker.messages[0].payload.file, undefined);
    client.handleMessage({ id: 1, ok: true, result: {} });
    await pending;
    client.close();
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('a failed postMessage does not leave a pending request behind', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const client = new StructureWorkerClient();
    client.worker.postMessage = () => { throw new DOMException('Cannot clone this file', 'DataCloneError'); };
    await assert.rejects(client.load(new File(['data'], 'data.cfg')), /Cannot clone/);
    assert.equal(client.pending.size, 0);
    client.close();
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('background frame requests do not surface progress in the blocking UI', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const progress = [];
    const client = new StructureWorkerClient((event) => progress.push(event));

    const background = client.frame(39, { reportProgress: false });
    client.handleMessage({ id: 1, event: 'progress', stage: 'sequence-unwrap', loaded: 40, total: 40 });
    assert.deepEqual(progress, []);
    client.handleMessage({ id: 1, ok: true, result: { frame: {}, index: 39 } });
    await background;

    const foreground = client.frame(4);
    client.handleMessage({ id: 2, event: 'progress', stage: 'sequence-unwrap', loaded: 5, total: 5 });
    assert.equal(progress.length, 1);
    client.handleMessage({ id: 2, ok: true, result: { frame: {}, index: 4 } });
    await foreground;
    client.close();
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('reset rejects pending loads/frames, ignores old Workers and allows a fresh source', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const progress = [], client = new StructureWorkerClient(event => progress.push(event));
    const oldWorker = client.worker;
    const pending = client.load(new File(['first'], 'first.cfg'));
    const background = client.frame(39, { reportProgress: false });
    const cancelled = Promise.all([assert.rejects(pending, { name: 'AbortError' }), assert.rejects(background, { name: 'AbortError' })]);
    client.reset();
    await cancelled;
    assert.equal(oldWorker.terminated, true);
    assert.equal(client.pending.size, 0);
    assert.equal(client.worker, null, 'home holds no parsed structure Worker');
    const next = client.load(new File(['second'], 'second.cfg'));
    const id = client.worker.messages[0].id;
    assert.notEqual(client.worker, oldWorker);
    oldWorker.listeners.get('message')({ data: { id, event: 'progress' } });
    oldWorker.listeners.get('error')({ message: 'stale failure' });
    assert.deepEqual(progress, []);
    assert.equal(client.pending.size, 1);
    client.handleMessage({ id, ok: true, result: { title: 'second' } });
    assert.deepEqual(await next, { title: 'second' });
    client.close();
  } finally { globalThis.Worker = originalWorker; }
});

test('cancelling prefetch rejects only speculative requests while preserving analysis and foreground consumers', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const client = new StructureWorkerClient();
    const background = client.frame(5, { background: true, reportProgress: false, speculative: true });
    const foreground = client.frame(90);
    const analysis = client.frame(12, { background: true, reportProgress: false });
    const cancelled = assert.rejects(background, { name: 'AbortError' });
    client.cancelPrefetch();
    await cancelled;
    assert.equal(client.pending.size, 2);
    assert.ok(client.worker.messages.some(message => message.type === 'cancel-frame' && message.payload.id === 1));
    client.handleMessage({ id: 2, ok: true, result: { index: 90 } });
    assert.deepEqual(await foreground, { index: 90 });
    client.handleMessage({ id: 3, ok: true, result: { index: 12 } });
    assert.deepEqual(await analysis, { index: 12 });
    client.close();
  } finally { globalThis.Worker = originalWorker; }
});

test('frame AbortSignals cancel the actual Worker request and ignore its late response', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const client = new StructureWorkerClient();
    const controller = new AbortController();
    const frame = client.frame(10, { signal: controller.signal });
    const rejected = assert.rejects(frame, { name: 'AbortError' });
    controller.abort();
    await rejected;
    assert.equal(client.pending.size, 0);
    assert.equal(client.worker.messages.at(-1).type, 'cancel-frame');
    client.handleMessage({ id: 1, ok: true, result: { index: 10 } });
    assert.equal(client.pending.size, 0);
    client.close();
  } finally { globalThis.Worker = originalWorker; }
});

test('source indexing updates are tied to the current load and remain available after its first-frame result', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const updates = [];
    const client = new StructureWorkerClient(() => {}, { onSourceInfo: info => updates.push(info) });
    const loaded = client.load(new File(['xyz'], 'trajectory.xyz'));
    const loadId = client.loadId;
    assert.equal(client.worker.messages[0].payload.incremental, true);
    client.handleMessage({ event: 'source-info', loadId, result: { frameCount: 1, indexComplete: false } });
    client.handleMessage({ id: loadId, ok: true, result: { frameCount: 1 } });
    await loaded;
    client.handleMessage({ event: 'source-info', loadId, result: { frameCount: 20, indexComplete: true } });
    assert.equal(client.sourceInfo.frameCount, 20);
    const next = client.load(new File(['cfg'], 'new.cfg'));
    client.handleMessage({ event: 'source-info', loadId, result: { frameCount: 99 } });
    assert.equal(client.sourceInfo, null);
    assert.equal(updates.length, 2);
    client.handleMessage({ id: client.loadId, ok: true, result: {} });
    await next;
    client.close();
  } finally { globalThis.Worker = originalWorker; }
});

test('reset cancels a replication waiting for CPU capacity before it can recreate stale Workers', async () => {
  const { CpuBudget } = await import('../src/analysis/cpu-budget.js');
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 3 } } });
    const occupied = await budget.acquire(1);
    const client = new StructureWorkerClient(() => {}, { cpuBudget: budget });
    const replication = client.replicate({}, [2, 1, 1]);
    const rejected = assert.rejects(replication, { name: 'AbortError' });
    assert.equal(budget.queue.length, 1);
    client.reset();
    await rejected;
    occupied.release();
    assert.equal(budget.active, 0);
    assert.equal(budget.queue.length, 0);
    assert.equal(client.replicationWorker, null);
    client.close();
  } finally { globalThis.Worker = originalWorker; }
});

test('replication cancellation preserves the CPU lease until its reusable Worker acknowledges', async () => {
  const { CpuBudget } = await import('../src/analysis/cpu-budget.js');
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 3 } } });
    const client = new StructureWorkerClient(() => {}, { cpuBudget: budget });
    const controller = new AbortController();
    const replication = client.replicate({}, [2, 1, 1], { signal: controller.signal });
    const rejected = assert.rejects(replication, { name: 'AbortError' });
    await new Promise(resolve => setImmediate(resolve));
    const worker = client.replicationWorker;
    const id = worker.messages[0].id;
    assert.equal(budget.active, 1);
    controller.abort();
    await rejected;
    assert.equal(budget.active, 1, 'current replication chunk has not acknowledged cancellation');
    assert.equal(client.pending.size, 1);
    client.handleMessage({ id, ok: false, name: 'AbortError', error: 'Replication cancelled.' }, worker);
    assert.equal(budget.active, 0);
    assert.equal(client.pending.size, 0);
    const next = client.replicate({}, [3, 1, 1]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.replicationWorker, worker);
    client.handleMessage({ id: worker.messages.at(-1).id, ok: true, result: { frame: { atoms: 3 } } }, worker);
    assert.deepEqual(await next, { atoms: 3 });
    assert.equal(budget.active, 0);
    client.close();
  } finally { globalThis.Worker = originalWorker; }
});

test('cancelling an index-completion wait detaches the subscriber while source indexing continues', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const client = new StructureWorkerClient();
    const controller = new AbortController();
    const completion = client.waitForIndex({ signal: controller.signal });
    const rejected = assert.rejects(completion, { name: 'AbortError' });
    controller.abort();
    await rejected;
    assert.equal(client.pending.size, 0);
    assert.equal(client.worker.terminated, undefined);
    assert.equal(client.worker.messages[0].type, 'index-complete');
    const next = client.frame(0);
    client.handleMessage({ id: 2, ok: true, result: { index: 0 } });
    assert.deepEqual(await next, { index: 0 });
    client.close();
  } finally { globalThis.Worker = originalWorker; }
});

test('same-frame consumers promote one Worker request and cancel independently without cancelling a time series', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const progress = [], client = new StructureWorkerClient(message => progress.push(message));
    const prefetchController = new AbortController(), navigationController = new AbortController();
    const prefetch = client.frame(7, { reportProgress: false, speculative: true, signal: prefetchController.signal });
    const series = client.frame(7, { reportProgress: false });
    const navigation = client.frame(7, { signal: navigationController.signal });
    assert.equal(client.worker.messages.filter(message => message.type === 'frame').length, 1);
    assert.deepEqual(client.worker.messages.at(-1), { type: 'promote-frame', payload: { id: 1 } });
    const cancelled = Promise.all([assert.rejects(prefetch, { name: 'AbortError' }), assert.rejects(navigation, { name: 'AbortError' })]);
    client.cancelPrefetch(); navigationController.abort();
    await cancelled;
    assert.equal(client.worker.messages.filter(message => message.type === 'cancel-frame').length, 0);
    assert.equal(client.pending.size, 1);
    client.handleMessage({ id: 1, event: 'progress', stage: 'sequence-unwrap', loaded: 1, total: 2 });
    assert.equal(progress.length, 1);
    const result = { frame: { positions: new Float64Array([1, 2, 3]) }, index: 7 };
    client.handleMessage({ id: 1, ok: true, result });
    assert.equal(await series, result);
    assert.equal(client.frameRequests.entries.size, 0);
    client.close();
  } finally { globalThis.Worker = originalWorker; }
});

test('frame identities include source and processing settings while equivalent option order shares a parse', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const client = new StructureWorkerClient();
    const first = client.frame(2, { trajectory: { smoothing: 3, inferredUnwrap: true } });
    const same = client.frame(2, { trajectory: { inferredUnwrap: true, smoothing: 3 } });
    const different = client.frame(2, { trajectory: { smoothing: 5, inferredUnwrap: true } });
    assert.equal(client.worker.messages.filter(message => message.type === 'frame').length, 2);
    const rejected = Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(same, { name: 'AbortError' }), assert.rejects(different, { name: 'AbortError' })]);
    const loaded = client.load(new File(['xyz'], 'new.xyz'));
    await rejected;
    const fresh = client.frame(2, { trajectory: { smoothing: 3, inferredUnwrap: true } });
    const id = client.worker.messages.at(-1).id;
    client.handleMessage({ id: 1, ok: true, result: { source: 'stale' } });
    assert.equal(client.frameRequests.entries.size, 1);
    client.handleMessage({ id, ok: true, result: { source: 'fresh' } });
    assert.deepEqual(await fresh, { source: 'fresh' });
    client.handleMessage({ id: client.loadId, ok: true, result: {} }); await loaded;
    client.close();
  } finally { globalThis.Worker = originalWorker; }
});

test('the last cancelling frame consumer sends exactly one parser cancel and late replies stay obsolete', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const client = new StructureWorkerClient(), one = new AbortController(), two = new AbortController();
    const first = client.frame(2, { signal: one.signal });
    const second = client.frame(2, { signal: two.signal });
    const rejected = Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })]);
    one.abort(); assert.equal(client.pending.size, 1);
    two.abort(); await rejected;
    assert.equal(client.worker.messages.filter(message => message.type === 'cancel-frame').length, 1);
    const retry = client.frame(2);
    client.handleMessage({ id: 1, ok: true, result: { old: true } });
    assert.equal(client.pending.size, 1);
    client.handleMessage({ id: 2, ok: true, result: { new: true } });
    assert.deepEqual(await retry, { new: true });
    client.close();
  } finally { globalThis.Worker = originalWorker; }
});

test('a foreground join promotes an already queued physical-replication dependency without restarting it', async () => {
  const { CpuBudget } = await import('../src/analysis/cpu-budget.js');
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 3 } } });
    const occupied = await budget.acquire(1), unrelated = budget.acquire(1, { priority: -10 });
    const client = new StructureWorkerClient(() => {}, { cpuBudget: budget });
    const owner = new AbortController();
    const replication = client.replicate({}, [2, 1, 1], { background: true, signal: owner.signal });
    assert.equal(budget.queue[0].priority, -10);
    client.promoteReplication(owner.signal);
    assert.equal(budget.queue[0].priority, 20);
    occupied.release(); await new Promise(resolve => setImmediate(resolve));
    const worker = client.replicationWorker;
    assert.equal(worker.messages.filter(message => message.type === 'replicate').length, 1);
    client.handleMessage({ id: worker.messages[0].id, ok: true, result: { frame: { atoms: 2 } } }, worker);
    assert.deepEqual(await replication, { atoms: 2 });
    assert.equal(client.replicationPreparations.size, 0);
    (await unrelated).release();
    assert.equal(budget.active, 0);
    client.close();
  } finally { globalThis.Worker = originalWorker; }
});
