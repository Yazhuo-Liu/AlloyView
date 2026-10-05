import assert from 'node:assert/strict';
import test from 'node:test';
import { CpuBudget, cpuWorkerLimit } from '../src/analysis/cpu-budget.js';

test('CPU budget follows reported cores minus two with a single-thread minimum', () => {
  for (const [cores, expected] of [[8, 6], [16, 14], [64, 62], [4, 2], [2, 1], [1, 1], [NaN, 1]]) {
    assert.equal(cpuWorkerLimit({ navigator: { hardwareConcurrency: cores } }), expected);
  }
  assert.equal(cpuWorkerLimit({}), 1);
});

test('mixed worker ranges and DXA share a weighted budget without starving a full-frame job', async () => {
  const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 8 } } });
  const ranges = await budget.acquire(2);
  let dxaGranted = false, rangeGranted = false;
  const dxa = budget.acquire(6).then(lease => { dxaGranted = true; return lease; });
  const nextRange = budget.acquire(1).then(lease => { rangeGranted = true; return lease; });
  await Promise.resolve();
  assert.equal(dxaGranted, false);
  assert.equal(rangeGranted, false);
  ranges.release();
  const lease = await dxa;
  assert.equal(budget.active, 6);
  assert.equal(rangeGranted, false);
  lease.release(); lease.release();
  (await nextRange).release();
  assert.equal(budget.active, 0);
});

test('foreground work precedes queued prewarming and aborted reservations release their place', async () => {
  const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 4 } } });
  const busy = await budget.acquire(2), controller = new AbortController();
  const abandoned = budget.acquire(2, { signal: controller.signal });
  const rejected = assert.rejects(abandoned, { name: 'AbortError' });
  const warm = budget.acquire(1, { priority: -1 });
  const foreground = budget.acquire(2);
  controller.abort(); await rejected;
  busy.release();
  const foregroundLease = await foreground;
  assert.equal(budget.active, 2);
  assert.equal(budget.queue.length, 1);
  foregroundLease.release(); (await warm).release();
  assert.equal(budget.active, 0);
});
