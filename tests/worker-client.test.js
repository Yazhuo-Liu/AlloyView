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

  terminate() {}
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
