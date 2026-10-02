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
