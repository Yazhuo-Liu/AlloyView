import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseWorkerCount } from '../src/analysis/coordination-pool.js';

test('coordination worker count scales with atom count and available cores', () => {
  const environment = { navigator: { hardwareConcurrency: 8 }, performance: {} };
  assert.equal(chooseWorkerCount(10_000, 120_000, environment), 1);
  assert.equal(chooseWorkerCount(100_000, 1_200_000, environment), 2);
  assert.equal(chooseWorkerCount(1_000_000, 12_000_000, environment), 6);
});

test('coordination worker count respects coordinate-copy memory pressure', () => {
  const environment = {
    navigator: { hardwareConcurrency: 16 },
    performance: { memory: { jsHeapSizeLimit: 128 * 1024 ** 2 } },
  };
  assert.equal(chooseWorkerCount(1_000_000, 12_000_000, environment), 1);
});
