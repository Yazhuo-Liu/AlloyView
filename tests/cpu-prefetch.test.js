import assert from 'node:assert/strict';
import test from 'node:test';
import { CpuPrefetchScheduler } from '../src/data/cpu-prefetch.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function backends({ warmAnalysis, warmDxa } = {}) {
  const analysisCalls = [], dxaCalls = [];
  const analysisResources = {}, dxaResources = {};
  const pool = {
    async warmupCpu(options) {
      analysisCalls.push(options);
      if (warmAnalysis) await warmAnalysis(options);
      return analysisResources;
    },
  };
  const dxaClient = {
    async warmup(options) {
      dxaCalls.push(options);
      if (warmDxa) await warmDxa(options);
      return dxaResources;
    },
  };
  return { pool, dxaClient, analysisCalls, dxaCalls, analysisResources, dxaResources };
}

function frame(atomCount) { return { ids: { length: atomCount } }; }

test('CPU modules warm during indexing, grow with atom count, and check retained resources on frame visits', async () => {
  const resources = backends(), statuses = [];
  const scheduler = new CpuPrefetchScheduler({ ...resources, onStatus: status => statuses.push(status) });
  await scheduler.warmModules({ sourceKey: 'file A' });
  assert.equal(resources.analysisCalls[0].atomCount, 1);
  assert.equal(resources.dxaCalls[0].atomCount, 1);
  await scheduler.setFrame({ sourceKey: 'file A', frame: frame(8192) });
  assert.equal(resources.analysisCalls[1].coordinateBytes, 8192 * 24);
  assert.equal(resources.analysisCalls[1].frame, undefined, 'prewarm does not clone structure data');
  assert.equal(statuses.at(-1).results[0].status, resources.analysisResources);
  assert.equal(statuses.at(-1).results[1].status, resources.dxaResources);
  await scheduler.setFrame({ sourceKey: 'file A', frame: frame(8000) });
  assert.equal(resources.analysisCalls.length, 3);
  assert.equal(resources.dxaCalls.length, 3);
  await scheduler.setFrame({ sourceKey: 'file A', frame: frame(16384) });
  assert.equal(resources.analysisCalls.length, 4);
  assert.equal(statuses.at(-1).results[0].status, resources.analysisResources);
  assert.equal(statuses.at(-1).results[1].status, resources.dxaResources);
});

test('physical replication prewarms its projected atom count before geometry exists and commits without restarting', async () => {
  const started = deferred(), release = deferred();
  const resources = backends({ warmAnalysis: async options => {
    if (options.atomCount === 24000) { started.resolve(); await release.promise; }
  } });
  const scheduler = new CpuPrefetchScheduler(resources);
  await scheduler.setFrame({ sourceKey: 'A', frame: frame(12000) });
  const controller = new AbortController();
  const preparation = scheduler.setAtomCount({ sourceKey: 'A', atomCount: 24000, signal: controller.signal });
  await started.promise;
  const display = scheduler.setFrame({ sourceKey: 'A', frame: frame(24000) });
  assert.equal(preparation, display);
  assert.equal(resources.analysisCalls.at(-1).signal.aborted, false);
  assert.equal(resources.analysisCalls.length, 2);
  release.resolve();
  await display;
});

test('a larger target joins existing initialization instead of cancelling and recreating its modules', async () => {
  const release = deferred(), statuses = [];
  const resources = backends({ warmAnalysis: async options => {
    if (options.atomCount === 1) await release.promise;
  } });
  const scheduler = new CpuPrefetchScheduler({ ...resources, onStatus: status => statuses.push(status) });
  const indexing = scheduler.warmModules({ sourceKey: 'A' });
  const initializationSignal = resources.analysisCalls[0].signal;
  await scheduler.setFrame({ sourceKey: 'A', frame: frame(24000) });
  assert.equal(initializationSignal.aborted, false);
  const statusCount = statuses.length;
  release.resolve();
  await indexing;
  assert.equal(statuses.length, statusCount);
  assert.equal(statuses.at(-1).atomCount, 24000);
  assert.equal(statuses.at(-1).results[0].status, resources.analysisResources);
});

test('a source change suppresses stale preparation replies while retaining backend resource ownership', async () => {
  const old = deferred(), statuses = [];
  const resources = backends({ warmAnalysis: async options => {
    if (options.atomCount === 10000) await old.promise;
  } });
  const scheduler = new CpuPrefetchScheduler({ ...resources, onStatus: status => statuses.push(status) });
  const obsolete = scheduler.setFrame({ sourceKey: 'A', frame: frame(10000) });
  const previousSignal = resources.analysisCalls[0].signal;
  await scheduler.setFrame({ sourceKey: 'B', frame: frame(20000) });
  assert.equal(previousSignal.aborted, true);
  const statusCount = statuses.length;
  old.resolve();
  await obsolete;
  assert.equal(statuses.length, statusCount);
  assert.equal(statuses.at(-1).atomCount, 20000);
  assert.equal(statuses.at(-1).results[0].status, resources.analysisResources);
});

test('foreground preemption retries background warmup and finishes the reusable pool', async () => {
  let attempts = 0, yields = 0;
  const resources = backends({ warmAnalysis: async () => {
    attempts += 1;
    if (attempts === 1) throw new DOMException('Foreground calculation arrived.', 'AbortError');
  } });
  const statuses = [];
  const scheduler = new CpuPrefetchScheduler({ ...resources, onStatus: status => statuses.push(status),
    yieldBackground: async () => { yields += 1; } });
  await scheduler.setFrame({ sourceKey: 'A', frame: frame(10000) });
  assert.equal(attempts, 2);
  assert.equal(yields, 1);
  assert.equal(resources.dxaCalls.length, 1);
  assert.equal(statuses.at(-1).phase, 'ready');
});

test('cancelled replication stops preparation and permits warming the original frame again', async () => {
  const release = deferred(), statuses = [];
  const resources = backends({ warmAnalysis: async options => {
    if (options.atomCount === 40000) await release.promise;
  } });
  const scheduler = new CpuPrefetchScheduler({ ...resources, onStatus: status => statuses.push(status) });
  await scheduler.setFrame({ sourceKey: 'A', frame: frame(10000) });
  const controller = new AbortController();
  const cancelled = scheduler.setAtomCount({ sourceKey: 'A', atomCount: 40000, signal: controller.signal });
  controller.abort();
  assert.equal(resources.analysisCalls.at(-1).signal.aborted, true);
  await scheduler.setFrame({ sourceKey: 'A', frame: frame(10000) });
  const statusCount = statuses.length;
  release.resolve();
  await cancelled;
  assert.equal(statuses.length, statusCount);
  assert.equal(statuses.at(-1).atomCount, 10000);
});

test('background backend failures never reject structure loading and can be retried', async () => {
  let fail = true;
  const resources = backends({ warmDxa: async () => {
    if (fail) throw new Error('Threaded module unavailable.');
  } });
  const statuses = [];
  const scheduler = new CpuPrefetchScheduler({ ...resources, onStatus: status => statuses.push(status) });
  await scheduler.setFrame({ sourceKey: 'A', frame: frame(20000) });
  assert.equal(statuses.at(-1).phase, 'unavailable');
  assert.equal(statuses.at(-1).results[1].error.message, 'Threaded module unavailable.');
  fail = false;
  await scheduler.setFrame({ sourceKey: 'A', frame: frame(20000) });
  assert.equal(statuses.at(-1).phase, 'ready');
});

test('source clearing stops preparation without destroying worker or Wasm resources', async () => {
  const resources = backends(), statuses = [];
  resources.pool.close = resources.dxaClient.release = () => { throw new Error('Resource destruction is forbidden.'); };
  const scheduler = new CpuPrefetchScheduler({ ...resources, onStatus: status => statuses.push(status) });
  await scheduler.setFrame({ sourceKey: 'A', frame: frame(10000) });
  scheduler.clearSource();
  assert.equal(statuses.at(-1), null);
  await scheduler.setFrame({ sourceKey: 'B', frame: frame(10000) });
  assert.equal(resources.analysisCalls.length, 2);
  assert.equal(statuses.at(-1).results[0].status, resources.analysisResources);
  assert.equal(statuses.at(-1).results[1].status, resources.dxaResources);
});

test('invalid or already cancelled targets do not start background resources', async () => {
  const resources = backends(), scheduler = new CpuPrefetchScheduler(resources);
  for (const atomCount of [NaN, Infinity, 0, -1]) await scheduler.setAtomCount({ sourceKey: 'A', atomCount });
  const controller = new AbortController(); controller.abort();
  await scheduler.setAtomCount({ sourceKey: 'A', atomCount: 10000, signal: controller.signal });
  assert.equal(resources.analysisCalls.length, 0);
  assert.equal(resources.dxaCalls.length, 0);
});
