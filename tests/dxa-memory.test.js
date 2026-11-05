import assert from 'node:assert/strict';
import test from 'node:test';
import { DXA_MAX_MEMORY_BUDGET, DXA_WASM_MEMORY_LIMIT, dxaMemoryBudget } from '../src/analysis/dxa-memory.js';

const GiB = 1024 ** 3;

test('DXA uses 80% of device RAM hints up to the 16 GiB whole-job budget', () => {
  assert.equal(DXA_WASM_MEMORY_LIMIT, 4 * GiB);
  assert.equal(DXA_MAX_MEMORY_BUDGET, 16 * GiB);
  for (const deviceMemory of [.25, .5, 1, 2, 4, 8, 32, 310]) {
    const budget = dxaMemoryBudget({ navigator: { deviceMemory } });
    assert.equal(budget, Math.floor(Math.min(deviceMemory * GiB * .8, 16 * GiB)));
    assert.ok(Number.isSafeInteger(budget));
    assert.ok(budget > 0 && budget <= DXA_MAX_MEMORY_BUDGET);
  }
  const sampleEstimate = 32 * 1024 ** 2 + 752_330 * 3_072;
  assert.ok(dxaMemoryBudget({ navigator: { deviceMemory: 4 } }) > sampleEstimate,
    'the 752,330-atom sample fits the default budget on a reported 4 GiB device');
  assert.ok(dxaMemoryBudget({ navigator: { deviceMemory: 2 } }) < sampleEstimate,
    'small-device hints still restrict admission');
});

test('missing or invalid device RAM hints use the whole-job budget, distinct from kernel capacity', () => {
  assert.equal(dxaMemoryBudget({}), DXA_MAX_MEMORY_BUDGET);
  assert.ok(dxaMemoryBudget({}) > DXA_WASM_MEMORY_LIMIT);
  for (const deviceMemory of [undefined, null, 0, -1, NaN, Infinity, -Infinity, 'unknown']) {
    assert.equal(dxaMemoryBudget({ navigator: { deviceMemory } }), DXA_MAX_MEMORY_BUDGET);
  }
});

test('DXA does not mistake JavaScript heap limits or core counts for physical RAM', () => {
  const environment = { navigator: { deviceMemory: 8, hardwareConcurrency: 2 },
    performance: { memory: { jsHeapSizeLimit: 64 * 1024 ** 2 } } };
  assert.equal(dxaMemoryBudget(environment), Math.floor(8 * GiB * .8));
  assert.equal(dxaMemoryBudget({ ...environment, navigator: { hardwareConcurrency: 2 } }),
    DXA_MAX_MEMORY_BUDGET);
  assert.equal(dxaMemoryBudget({ ...environment, navigator: { deviceMemory: .5, hardwareConcurrency: 128 } }),
    Math.floor(.5 * GiB * .8));
});
