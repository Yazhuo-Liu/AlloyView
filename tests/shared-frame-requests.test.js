import assert from 'node:assert/strict';
import test from 'node:test';
import { SharedFrameRequests } from '../src/data/shared-frame-requests.js';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('processed frames share parsing and replication but retain independent consumer cancellation', async () => {
  const requests = new SharedFrameRequests();
  const source = deferred(), preparation = deferred();
  const prefetch = new AbortController(), series = new AbortController(), navigation = new AbortController();
  let parses = 0, preparations = 0, promotions = 0, operation;
  const start = entry => {
    operation = entry; parses++;
    entry.promote = () => promotions++;
    return source.promise.then(async frame => { preparations++; await preparation.promise; return frame; });
  };
  const first = requests.join('source:revision:frame:replicas', { background: true, speculative: true, signal: prefetch.signal }, start);
  const second = requests.join('source:revision:frame:replicas', { background: true, signal: series.signal }, start);
  const third = requests.join('source:revision:frame:replicas', { cacheFrame: true, signal: navigation.signal }, start);
  assert.equal(parses, 1);
  assert.equal(promotions, 1);
  assert.equal(operation.cacheFrame, true);
  const failures = Promise.all([assert.rejects(first, { name: 'AbortError' }), assert.rejects(third, { name: 'AbortError' })]);
  requests.cancelSpeculative(); navigation.abort();
  await failures;
  assert.equal(operation.controller.signal.aborted, false, 'time series still owns the operation');
  source.resolve({ atoms: 100 }); await tick();
  assert.equal(preparations, 1);
  preparation.resolve();
  assert.deepEqual(await second, { atoms: 100 });
  assert.equal(requests.entries.size, 0);
});

test('speculative consumers in a moved window stay alive and only the last departing consumer cancels parsing', async () => {
  const requests = new SharedFrameRequests(), tasks = new Map();
  const start = entry => { const task = deferred(); tasks.set(entry.key, { ...task, entry }); return task.promise; };
  const kept = requests.join('next', { background: true, speculative: true }, start);
  const dropped = requests.join('distant', { background: true, speculative: true }, start);
  const rejected = assert.rejects(dropped, { name: 'AbortError' });
  requests.cancelSpeculative({ keepKeys: new Set(['next']) }); await rejected;
  assert.equal(tasks.get('distant').entry.controller.signal.aborted, true);
  assert.equal(tasks.get('next').entry.controller.signal.aborted, false);
  tasks.get('next').resolve(7); assert.equal(await kept, 7);
  tasks.get('distant').resolve(99); await tick();
  assert.equal(requests.entries.size, 0);
});

test('source and processing invalidation aborts old owners and late completion cannot remove a fresh entry', async () => {
  const requests = new SharedFrameRequests(), obsolete = deferred(), current = deferred();
  let oldEntry;
  const old = requests.join('frame', {}, entry => { oldEntry = entry; return obsolete.promise; });
  const rejected = assert.rejects(old, { name: 'AbortError' });
  requests.clear(); await rejected;
  assert.equal(oldEntry.controller.signal.aborted, true);
  const next = requests.join('frame', {}, () => current.promise);
  obsolete.resolve({ source: 'old' }); await tick();
  assert.equal(requests.entries.size, 1);
  current.resolve({ source: 'new' });
  assert.deepEqual(await next, { source: 'new' });
  assert.equal(requests.entries.size, 0);
});

test('already aborted consumers allocate nothing and startup failures release every subscriber', async () => {
  const requests = new SharedFrameRequests(), controller = new AbortController();
  controller.abort();
  await assert.rejects(requests.join('never', { signal: controller.signal }, () => { throw new Error('must not start'); }), { name: 'AbortError' });
  assert.equal(requests.entries.size, 0);
  await assert.rejects(requests.join('bad', {}, () => { throw new Error('Cannot clone file'); }), /Cannot clone/);
  assert.equal(requests.entries.size, 0);
});
