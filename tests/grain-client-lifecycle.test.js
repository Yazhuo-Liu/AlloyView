import assert from 'node:assert/strict';
import test from 'node:test';
import { GrainSegmentationClient } from '../src/grains-client.js';
import { CpuBudget } from '../src/analysis/cpu-budget.js';

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function until(condition) {
  const deadline = performance.now() + 2000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, 'the expected Worker or admission state became available');
    await nextTurn();
  }
}

class FakeWorker {
  constructor(onPost = () => {}) {
    this.listeners = new Map(); this.messages = []; this.terminated = false; this.onPost = onPost;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener); this.listeners.set(type, listeners);
  }
  postMessage(message) {
    this.messages.push(message); this.onPost(this, message);
  }
  emit(type, data) {
    for (const listener of this.listeners.get(type) ?? []) listener(type === 'message' ? { data } : data);
  }
  terminate() { this.terminated = true; }
}

function input(count = 4) {
  return {
    ptm: { structures: new Uint8Array(count), orientations: new Float32Array(count * 4),
      neighborCounts: new Uint8Array(count), neighborIndices: new Uint32Array(count * 16) },
    fractional: new Float64Array(count * 3),
    cell: { vectors: [100, 0, 0, 0, 100, 0, 0, 0, 100], pbc: [true, true, true] },
  };
}

function budget() { return new CpuBudget({ environment: { navigator: { hardwareConcurrency: 5 } } }); }
const emptyBonds = () => ({ a: new Uint32Array(), b: new Uint32Array(), lengths: new Float64Array(), count: 0 });
const done = (worker, message) => queueMicrotask(() => worker.emit('message', {
  id: message.id, ok: true, result: { modelReused: false, grainCount: 0 },
}));

for (const failedStage of [false, true]) test(`a failed ${failedStage ? 'error' : 'result'} stage reply settles the job and permits a fresh coordinator`, { timeout: 5000 }, async t => {
  const workers = [], cpuBudget = budget(); let stageSignal;
  const client = new GrainSegmentationClient({ cpuBudget, createWorker: () => {
    const first = workers.length === 0;
    const worker = new FakeWorker((self, message) => {
      if (message.type === 'grains') {
        if (!first) done(self, message);
        else queueMicrotask(() => self.emit('message', { id: message.id,
          stageRequest: { stage: 'bonds', length: 4, requestId: 1 } }));
      }
      if (message.type === 'stage-result' && first) throw new Error('Stage reply could not be cloned.');
    });
    workers.push(worker); return worker;
  } });
  t.after(() => client.dispose());
  client.stages.run = async (...args) => {
    stageSignal = args.at(-1);
    if (failedStage) throw new Error('Stage computation failed.');
    return emptyBonds();
  };
  await assert.rejects(client.segment(input()), /Stage reply could not be cloned/);
  assert.equal(workers[0].terminated, true);
  assert.equal(stageSignal.aborted, true, 'the failed coordinator cancels its helper-stage signal');
  const reply = workers[0].messages.find(message => message.type === 'stage-result');
  if (failedStage) assert.equal(reply.error, 'Stage computation failed.');
  else assert.equal(reply.result.count, 0);
  assert.equal(cpuBudget.active, 0); assert.equal(client.pending.size, 0);
  assert.equal((await client.segment(input())).worker, true);
  assert.equal(workers.length, 2); assert.equal(cpuBudget.active, 0);
});

test('a coordinator messageerror cancels posted ranges but retains their CPU lease until every ACK', { timeout: 5000 }, async t => {
  const coordinators = [], helpers = [], cpuBudget = budget(), source = input(70000);
  const client = new GrainSegmentationClient({ cpuBudget, environment: { crossOriginIsolated: true },
    createStageWorker: () => { const worker = new FakeWorker(); helpers.push(worker); return worker; },
    createWorker: () => {
      const first = coordinators.length === 0;
      const worker = new FakeWorker((self, message) => {
        if (message.type !== 'grains') return;
        if (!first) done(self, message);
        else queueMicrotask(() => self.emit('message', { id: message.id,
          stageRequest: { stage: 'bonds', length: source.ptm.structures.length, requestId: 1 } }));
      });
      coordinators.push(worker); return worker;
    } });
  t.after(() => client.dispose());
  let settled = false;
  const operation = client.segment(source);
  operation.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(operation, /Coordinator could not deserialize/);
  await until(() => helpers.length === 2 && helpers.every(worker => worker.messages.some(message => message.stage === 'bonds')));
  assert.equal(cpuBudget.active, 3);
  coordinators[0].emit('messageerror', { message: 'Coordinator could not deserialize its reply.' });
  await nextTurn();
  assert.equal(coordinators[0].terminated, true);
  assert.ok(helpers.every(worker => worker.messages.some(message => message.cancel)), 'all posted ranges receive cancellation');
  assert.ok(helpers.every(worker => !worker.terminated), 'ACK-capable helper Workers remain reusable');
  assert.equal(settled, false); assert.equal(cpuBudget.active, 3);
  let admitted = false;
  const nextPermit = cpuBudget.acquire(1).then(permit => { admitted = true; return permit; });
  const acknowledge = worker => {
    const posted = worker.messages.find(message => message.stage === 'bonds');
    worker.emit('message', { id: posted.id, ok: false, error: 'Grain stage cancelled.' });
  };
  acknowledge(helpers[0]); await nextTurn();
  assert.equal(settled, false); assert.equal(admitted, false); assert.equal(cpuBudget.active, 3);
  acknowledge(helpers[1]); await rejected;
  const permit = await nextPermit; permit.release();
  assert.equal(cpuBudget.active, 0); assert.equal(client.pending.size, 0); assert.equal(client.stages.pending.size, 0);
  assert.equal((await client.segment(source)).worker, true);
  assert.equal(coordinators.length, 2); assert.equal(helpers.length, 2); assert.equal(cpuBudget.active, 0);
});

test('dispose aborts an active request and every queued request without recreating Workers', { timeout: 5000 }, async () => {
  const workers = [], cpuBudget = budget();
  const client = new GrainSegmentationClient({ cpuBudget, createWorker: () => {
    const worker = new FakeWorker(); workers.push(worker); return worker;
  } });
  const source = input(), active = client.segment(source), queued = client.segment(source);
  const rejectedActive = assert.rejects(active, { name: 'AbortError' });
  const rejectedQueued = assert.rejects(queued, { name: 'AbortError' });
  await until(() => client.pending.size === 1);
  assert.equal(cpuBudget.active, 1); assert.equal(workers.length, 1);
  client.dispose();
  await Promise.all([rejectedActive, rejectedQueued]);
  await nextTurn();
  assert.equal(workers.length, 1); assert.equal(workers[0].terminated, true);
  assert.equal(cpuBudget.active, 0); assert.equal(cpuBudget.queue.length, 0); assert.equal(client.requests.size, 0);
  await assert.rejects(client.segment(source), { name: 'AbortError' });
  client.warm(32768); assert.equal(workers.length, 1, 'a disposed client cannot restart through warmup');
});

test('dispose cancels a CPU admission waiter before it can construct a Worker', { timeout: 5000 }, async () => {
  const cpuBudget = budget(), held = await cpuBudget.acquire(cpuBudget.limit), workers = [];
  const client = new GrainSegmentationClient({ cpuBudget, createWorker: () => {
    const worker = new FakeWorker(); workers.push(worker); return worker;
  } });
  const rejected = assert.rejects(client.segment(input()), { name: 'AbortError' });
  await until(() => cpuBudget.queue.length === 1);
  client.dispose(); await rejected;
  assert.equal(cpuBudget.queue.length, 0); assert.equal(cpuBudget.active, cpuBudget.limit, 'the unrelated lease is retained');
  held.release(); await nextTurn();
  assert.equal(cpuBudget.active, 0); assert.equal(workers.length, 0); assert.equal(client.requests.size, 0);
});

for (const outcome of ['complete', 'cancel', 'dispose']) test(`panel prewarming during a grain snapshot defers safely through ${outcome}`, { timeout: 2000 }, async t => {
  const helpers = [], cpuBudget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 10 } } });
  const source = input(70000), controller = new AbortController();
  const client = new GrainSegmentationClient({ cpuBudget,
    createStageWorker: () => {
      const worker = new FakeWorker((self, message) => {
        const result = message.warm ? { warmed: true }
          : message.stage === 'bonds' ? emptyBonds() : new Float64Array(message.end - message.first);
        queueMicrotask(() => self.emit('message', { id: message.id, ok: true, result }));
      });
      helpers.push(worker); return worker;
    },
    createWorker: () => {
      let id;
      return new FakeWorker((self, message) => {
        if (message.type === 'grains') {
          id = message.id;
          queueMicrotask(() => self.emit('message', { id, stageRequest: { stage: 'bonds', length: 70000, requestId: 1 } }));
        } else if (message.type === 'stage-result') {
          assert.equal(message.error, undefined);
          if (message.requestId === 1) queueMicrotask(() => self.emit('message', { id, stageRequest: {
            stage: 'disorientation', input: { a: new Uint32Array(), b: new Uint32Array(), types: source.ptm.structures,
              orientations: source.ptm.orientations }, length: 0, requestId: 2 } }));
          else if (message.requestId === 2) queueMicrotask(() => self.emit('message', { id, stageRequest: { stage: 'serial', requestId: 3 } }));
          else done(self, { id });
        }
      });
    },
  });
  let releaseSnapshot, enteredSnapshot;
  const copying = new Promise(resolve => { enteredSnapshot = resolve; });
  const resume = new Promise(resolve => { releaseSnapshot = resolve; });
  const snapshot = client.stages.snapshot.bind(client.stages);
  let first = true;
  client.stages.snapshot = async (...args) => {
    const result = await snapshot(...args);
    if (first) { first = false; enteredSnapshot(); await resume; }
    return result;
  };
  t.after(() => { releaseSnapshot(); client.dispose(); });
  const operation = client.segment(source, {}, { signal: controller.signal });
  operation.catch(() => {});
  const rejected = outcome === 'complete' ? null : assert.rejects(operation, { name: 'AbortError' });
  await copying;
  assert.equal(cpuBudget.active, 6, 'the foreground stage leaves room for a background permit');
  client.warm(source.ptm.structures.length);
  await nextTurn();
  assert.equal(helpers.length, 0, 'opening the panel cannot claim a helper while its snapshot is being copied');
  assert.equal(cpuBudget.active, 6, 'deferred warmup consumes no extra permit');
  if (outcome === 'cancel') controller.abort();
  else if (outcome === 'dispose') client.dispose();
  releaseSnapshot();
  if (rejected) await rejected;
  else assert.equal((await operation).worker, true, 'the next disorientation stage also completes');
  await client.stages.warming?.promise;
  assert.equal(cpuBudget.active, 0); assert.equal(cpuBudget.queue.length, 0);
  assert.equal(client.requests.size, 0); assert.equal(client.stages.pending.size, 0);
  if (outcome === 'dispose') assert.equal(helpers.length, 0, 'disposal discards deferred warmup');
  else {
    assert.equal(helpers.length, 5);
    assert.ok(client.stages.slots.every(slot => slot.warmed), 'all requested helpers stay ready for the next calculation');
    assert.ok(helpers.every(worker => !worker.terminated));
    const warmMessages = helpers.flatMap(worker => worker.messages.filter(message => message.warm));
    assert.equal(warmMessages.length, outcome === 'cancel' ? 5 : 0,
      'cancelled snapshot preparation still prewarms its helpers; completed ranges already loaded their modules');
  }
});
