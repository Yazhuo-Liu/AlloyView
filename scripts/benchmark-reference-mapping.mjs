import assert from 'node:assert/strict';
import { createReferenceMappingAsync, referenceMappingCacheBytes } from '../src/analysis/reference-strain.js';
import { yieldToMain } from '../src/shared/task-yield.js';

// The pre-C8 asynchronous text path, kept here as a performance and identity
// oracle. Scientific regression tests exercise invalid inputs independently.
async function originalMapping(current, reference, { onProgress = () => {} } = {}) {
  const byId = new Map(), seen = new Set(), mapping = new Int32Array(current.ids.length);
  const total = reference.ids.length + current.ids.length;
  for (let row = 0; row < reference.ids.length; row++) {
    const key = String(reference.ids[row]);
    if (byId.has(key)) throw new Error('Duplicate reference ID.');
    byId.set(key, row);
    if ((row + 1) % 65_536 === 0) { onProgress({ completed: row + 1, total }); await yieldToMain(); }
  }
  if (reference.ids.length % 65_536) { onProgress({ completed: reference.ids.length, total }); await yieldToMain(); }
  for (let row = 0; row < current.ids.length; row++) {
    const key = String(current.ids[row]);
    if (seen.has(key)) throw new Error('Duplicate current ID.');
    seen.add(key); mapping[row] = byId.get(key) ?? -1;
    if ((row + 1) % 65_536 === 0) { onProgress({ completed: reference.ids.length + row + 1, total }); await yieldToMain(); }
  }
  onProgress({ completed: total, total });
  return mapping;
}

const count = Number(process.argv.find(value => value.startsWith('--atoms='))?.split('=')[1] ?? 1_000_000);
assert.ok(Number.isSafeInteger(count) && count > 0 && count <= 4_000_000);
const environment = { navigator: { hardwareConcurrency: 16 } };
const measurements = [];
for (const mode of ['dense', 'sparse']) {
  globalThis.gc?.();
  const ids = Float64Array.from({ length: count }, (_, row) => mode === 'dense' ? row + 1 : row * 10000 + 1);
  const reference = { fractional: new Float32Array(count * 3), ids }, current = { ...reference, ids: ids.slice().reverse() };
  current.ids[17] += mode === 'dense' ? count * 10 : 1;
  const source = ids.slice();
  let expected;
  for (const [name, calculate] of [['original text', originalMapping], ['numeric cold', createReferenceMappingAsync], ['numeric warm', createReferenceMappingAsync]]) {
    globalThis.gc?.();
    const started = performance.now();
    let progress = 0;
    const mapping = await calculate(current, reference, { environment, onProgress() { progress++; } });
    const elapsedMs = performance.now() - started;
    if (expected) for (let row = 0; row < count; row++) assert.ok(Object.is(mapping[row], expected[row]), `Mapping ${mode} row ${row}`);
    else expected = mapping;
    assert.deepEqual(ids, source);
    measurements.push({ mode, name, atoms: count, elapsedMs, progressNotifications: progress, referenceLookupBytes: referenceMappingCacheBytes(reference.ids), totalRetainedLookupBytes: referenceMappingCacheBytes() });
  }
}
console.log(JSON.stringify({ runtime: process.version, platform: process.platform, cacheMemoryEnvironment: environment, measurements }, null, 2));
