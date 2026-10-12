import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigurationRestoreQueue, settleConfigurationAnalyses } from '../src/configuration-restore.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}

test('a newer recipe waits for every earlier tool while its own analyses remain parallel', async () => {
  const queue = createConfigurationRestoreQueue(), firstTool = deferred(), secondTool = deferred();
  const started = [], state = { color: 'type', status: '' };
  let request = 1;
  const restore = (id, tasks) => queue.run(async () => {
    started.push(id); state.status = 'Restoring';
    await settleConfigurationAnalyses(tasks);
    if (id !== request) return false;
    state.color = `recipe-${id}`; state.status = 'Restored';
    return true;
  }, { isCurrent: () => id === request });
  const first = restore(1, [firstTool.promise, secondTool.promise]);
  await Promise.resolve();
  request = 2;
  const latest = restore(2, [Promise.resolve()]);
  firstTool.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(started, [1], 'the unfinished second tool keeps the first recipe in its slot');
  secondTool.resolve();
  assert.deepEqual(await Promise.all([first, latest]), [false, true]);
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(state, { color: 'recipe-2', status: 'Restored' });
});

test('superseded queued recipes and a changed source do not execute state mutations', async () => {
  const queue = createConfigurationRestoreQueue(), held = deferred(), ran = [];
  let request = 1, source = 1;
  const schedule = id => {
    const savedSource = source;
    return queue.run(async () => { ran.push(id); if (id === 1) await held.promise; }, {
      isCurrent: () => id === request && savedSource === source,
    });
  };
  const first = schedule(1); await Promise.resolve();
  request = 2; const skipped = schedule(2);
  request = 3; const obsoleteSource = schedule(3);
  source = 2; held.resolve();
  await Promise.all([first, skipped, obsoleteSource]);
  assert.deepEqual(ran, [1]);
  const valid = queue.run(() => ran.push(4)); await valid;
  assert.deepEqual(ran, [1, 4]);
});

test('a rejected tool cannot release its recipe ahead of a still running independent tool', async () => {
  const queue = createConfigurationRestoreQueue(), held = deferred(), failure = new Error('Rejected recipe tool');
  let nextStarted = false;
  const failed = queue.run(() => settleConfigurationAnalyses([Promise.reject(failure), held.promise]));
  const rejection = assert.rejects(failed, error => error === failure);
  const next = queue.run(() => { nextStarted = true; });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(nextStarted, false);
  held.resolve(); await rejection; await next;
  assert.equal(nextStarted, true, 'the queue recovers after the failed recipe has settled');
});

test('a synchronous recipe error does not block the next valid restoration', async () => {
  const queue = createConfigurationRestoreQueue();
  const failed = queue.run(() => { throw new Error('Invalid frame'); });
  const next = queue.run(() => 'valid');
  await assert.rejects(failed, /Invalid frame/);
  assert.equal(await next, 'valid');
});
