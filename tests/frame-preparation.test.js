import assert from 'node:assert/strict';
import test from 'node:test';
import { framePreparationSignal } from '../src/data/frame-preparation.js';
import { CpuBudget } from '../src/analysis/cpu-budget.js';
import { StructureWorkerClient } from '../src/worker-client.js';

class FakeWorker {
  constructor() { this.messages = []; this.listeners = new Map(); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  postMessage(message) { this.messages.push(message); }
  terminate() {}
}

test('cancelling foreground navigation during property attachment prevents subsequent physical replication', async () => {
  const previousWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 3 } } });
  const client = new StructureWorkerClient(() => {}, { cpuBudget: budget });
  try {
    const navigation = new AbortController();
    const signal = framePreparationSignal(navigation.signal);
    let finishAttachment;
    const attachment = new Promise(resolve => { finishAttachment = resolve; });
    // Parsing has already resolved. Imported-property attachment yields before
    // the navigation is cancelled, exactly when a replication listener is
    // unable to observe the already-delivered abort event by itself.
    const prepared = attachment.then(() => client.replicate({}, [2, 1, 1], { signal }));
    navigation.abort();
    finishAttachment();
    await assert.rejects(prepared, { name: 'AbortError' });
    assert.equal(signal.aborted, true);
    assert.equal(client.replicationWorker, undefined, 'cancelled preparation creates no replication Worker');
    assert.equal(client.pending.size, 0);
    assert.equal(budget.active, 0);
    assert.equal(budget.queue.length, 0);
  } finally { client.close(); globalThis.Worker = previousWorker; }
});

test('source and physical-replication changes invalidate preparation without a separate abort event', () => {
  let current = true;
  const signal = framePreparationSignal(undefined, () => current);
  assert.equal(signal.aborted, false);
  current = false;
  assert.equal(signal.aborted, true);
});

test('preparation forwards abort notifications registered before cancellation', () => {
  const navigation = new AbortController();
  const signal = framePreparationSignal(navigation.signal);
  let notifications = 0;
  const listener = () => { notifications++; };
  signal.addEventListener('abort', listener);
  navigation.abort();
  signal.removeEventListener('abort', listener);
  assert.equal(notifications, 1);
  assert.equal(signal.aborted, true);
});
