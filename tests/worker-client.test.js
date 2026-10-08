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

test('cancelling prefetch rejects background requests while preserving foreground requests', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  try {
    const client = new StructureWorkerClient();
    const background = client.frame(5, { background: true, reportProgress: false });
    const foreground = client.frame(90);
    const cancelled = assert.rejects(background, { name: 'AbortError' });
    client.cancelPrefetch();
    await cancelled;
    assert.equal(client.pending.size, 1);
    assert.ok(client.worker.messages.some(message => message.type === 'cancel-frame' && message.payload.id === 1));
    client.handleMessage({ id: 2, ok: true, result: { index: 90 } });
    assert.deepEqual(await foreground, { index: 90 });
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
