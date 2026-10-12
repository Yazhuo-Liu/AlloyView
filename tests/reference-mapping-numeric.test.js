import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createReferenceMapping, createReferenceMappingAsync, calculateReferenceStrain, REFERENCE_STRAIN_FIELDS, referenceMappingCacheBytes } from '../src/analysis/reference-strain.js';
import { prepareDisplacements, calculatePreparedDisplacements } from '../src/analysis/displacement.js';
import { prepareGpuReferenceParameters } from '../src/analysis/gpu/reference-strain.js';
import { prepareGpuDisplacementParameters } from '../src/analysis/gpu/displacement.js';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { crystalFrame } from './helpers/crystals.js';

const frameIds = ids => ({ ids, fractional: new Float64Array(ids.length * 3), idSource: 'explicit' });
const assertExact = (actual, expected, name) => {
  assert.equal(actual.length, expected.length, name);
  for (let row = 0; row < actual.length; row++) assert.ok(Object.is(actual[row], expected[row]), `${name}[${row}]: ${actual[row]} != ${expected[row]}`);
};

for (const [name, ids] of [
  ['Uint32 dense', Uint32Array.from([7, 1, 12, 9, 3])],
  ['Int32 signed dense', Int32Array.from([-3, 2, -1, 0, 1])],
  ['Float64 dense negative large', Float64Array.from([-Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER + 3, -Number.MAX_SAFE_INTEGER + 7])],
  ['Float64 dense positive large', Float64Array.from([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 3, Number.MAX_SAFE_INTEGER - 7])],
  ['Float64 sparse', Float64Array.from([-Number.MAX_SAFE_INTEGER, 7, Number.MAX_SAFE_INTEGER, 1e12])],
  ['mixed canonical strings', [7, '07', ' 7', 'NaN', 'Infinity', '-0', 0, 'atom:α', '1e+21', '1e21']],
]) test(`numeric mapping agrees with text identity for ${name}, including cache visits`, async () => {
  const reference = frameIds(ids), currentIds = Array.from(ids).reverse();
  currentIds.push('absent', '007', '9007199254740992');
  const current = frameIds(currentIds), expected = createReferenceMapping(current, reference);
  for (let pass = 0; pass < 3; pass++) assertExact(await createReferenceMappingAsync(current, reference), expected, name);
  const textual = frameIds(Array.from(ids, String));
  assertExact(await createReferenceMappingAsync(textual, reference), createReferenceMapping(textual, reference), 'text matches numeric');
});

test('dense and sparse typed reference caches detect every in-place ID replacement, reorder and duplicate', async () => {
  for (const ids of [Uint32Array.from([1, 2, 3, 4]), Float64Array.from([0, Number.MAX_SAFE_INTEGER, -100, 1e12])]) {
    const reference = frameIds(ids), current = frameIds(Float64Array.from(ids).reverse());
    assertExact(await createReferenceMappingAsync(current, reference), createReferenceMapping(current, reference), 'initial');
    reference.ids.reverse();
    assertExact(await createReferenceMappingAsync(current, reference), createReferenceMapping(current, reference), 'reordered');
    reference.ids[0] = 900;
    assertExact(await createReferenceMappingAsync(current, reference), createReferenceMapping(current, reference), 'replaced');
    current.ids[0] = 900;
    assertExact(await createReferenceMappingAsync(current, reference), createReferenceMapping(current, reference), 'changed current');
    const retained = reference.ids[0]; reference.ids[0] = reference.ids[1];
    await assert.rejects(createReferenceMappingAsync(current, reference), /requires unique integer atom IDs or stable string IDs/);
    reference.ids[0] = retained;
    assertExact(await createReferenceMappingAsync(current, reference), createReferenceMapping(current, reference), 'after failed validation');
  }
});

test('canonical numeric aliases keep exact duplicate and invalid-ID error messages', async () => {
  const good = frameIds(Uint32Array.from([1, 2, 3]));
  for (const ids of [[7, '7'], [-0, '0'], ['NaN', 'NaN'], ['atom', 'atom'],
    Float64Array.from([1, 1]), Float64Array.from([0, -0]), Float64Array.from([1, .5]),
    Float64Array.from([1, Number.MAX_SAFE_INTEGER + 1]), Float64Array.from([1, NaN]),
    Float64Array.from([1, Infinity]), [1, ''], [1, 'line\n'], [1, null], BigInt64Array.from([1n, 2n])]) {
    for (const [current, reference] of [[frameIds(ids), good], [good, frameIds(ids)]]) {
      let message;
      try { createReferenceMapping(current, reference); } catch (error) { message = error.message; }
      assert.ok(message);
      await assert.rejects(createReferenceMappingAsync(current, reference), error => error.message === message);
    }
  }
  for (const [current, reference] of [[{ ...good, ids: null }, good], [{ ...good, idSource: 'row-order' }, good]]) {
    let message;
    try { createReferenceMapping(current, reference); } catch (error) { message = error.message; }
    await assert.rejects(createReferenceMappingAsync(current, reference), error => error.message === message);
  }
});

test('random numeric and textual correspondence matches the original mapping without altering source arrays', async () => {
  let seed = 187;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let fixture = 0; fixture < 100; fixture++) {
    const count = 20 + random() % 100, base = fixture % 2 ? 1e12 : -100;
    const referenceIds = Float64Array.from({ length: count }, (_, row) => base + row * (fixture % 3 ? 1 : 1000000));
    for (let row = count - 1; row > 0; row--) { const next = random() % (row + 1); [referenceIds[row], referenceIds[next]] = [referenceIds[next], referenceIds[row]]; }
    const currentIds = Array.from(referenceIds, (id, row) => row % 3 ? id : String(id));
    currentIds.push('unmatched:' + fixture);
    const current = frameIds(currentIds), reference = frameIds(referenceIds), original = referenceIds.slice();
    assertExact(await createReferenceMappingAsync(current, reference), createReferenceMapping(current, reference), `fixture ${fixture}`);
    assertExact(referenceIds, original, 'source');
  }
});

test('cached reference verification and sparse current matching still yield to cancellation and recover', async () => {
  const count = 200_003, ids = Float64Array.from({ length: count }, (_, row) => row * 10000);
  const reference = frameIds(ids), current = frameIds(ids.slice().reverse());
  await createReferenceMappingAsync(current, reference);
  for (const abortAt of [0, count]) {
    const controller = new AbortController(), progress = [];
    await assert.rejects(createReferenceMappingAsync(current, reference, { signal: controller.signal, onProgress(update) {
      progress.push(update); if (update.completed > abortAt) controller.abort();
    } }), { name: 'AbortError' });
    assert.ok(progress.length && progress.at(-1).completed < count * 2);
    assert.ok(progress.every((value, row) => row === 0 || value.completed >= progress[row - 1].completed));
  }
  assertExact(await createReferenceMappingAsync(current, reference), createReferenceMapping(current, reference), 'recovery');
});

test('numeric reference cache reports retained bytes, bounds all live references, and shrinks for low-memory hosts', async () => {
  const count = 100_003, references = [], environment = { performance: { memory: { jsHeapSizeLimit: 64 * 1024 ** 2 } } };
  const limit = 4 * 1024 ** 2;
  for (let fixture = 0; fixture < 8; fixture++) {
    const reference = frameIds(Uint32Array.from({ length: count }, (_, row) => fixture * count + row));
    references.push(reference);
    await createReferenceMappingAsync(reference, reference, { environment });
    assert.equal(referenceMappingCacheBytes(reference.ids), count * 12);
    assert.ok(referenceMappingCacheBytes() <= limit);
  }
  assert.equal(referenceMappingCacheBytes(references[0].ids), 0, 'old tables are evicted even when callers retain every reference');
  const reference = references.at(-1);
  await createReferenceMappingAsync(reference, reference, { environment: { performance: { memory: { jsHeapSizeLimit: 1024 ** 2 } } } });
  assert.equal(referenceMappingCacheBytes(reference.ids), 0, 'a table above the reduced budget is not retained');
  assert.ok(referenceMappingCacheBytes() <= 65_536);
  const result = await createReferenceMappingAsync(reference, reference, { environment });
  assert.ok(result.every((value, row) => value === row));
  assert.equal(referenceMappingCacheBytes(reference.ids), count * 12);
});

for (const sharedMemory of [false, true]) test(`cached numeric matching feeds real CPU Workers and GPU input preparation (${sharedMemory ? 'shared' : 'copied'})`, async () => {
  const reference = crystalFrame('fcc', 11), frame = { ...reference, ids: reference.ids.slice(), fractional: reference.fractional.slice(), positions: reference.positions.slice() };
  [frame.ids[0], frame.ids[1]] = [frame.ids[1], frame.ids[0]];
  frame.ids[17] = 900000;
  const mapping = await createReferenceMappingAsync(frame, reference), originalIds = reference.ids.slice();
  const parameters = { referenceFrame: reference, referenceFractional: reference.fractional, referenceCell: reference.cell, referenceMapping: mapping, cutoff: 3 };
  const gpuReference = prepareGpuReferenceParameters(frame, parameters);
  const originalMapping = createReferenceMapping(frame, reference);
  assertExact(gpuReference.inverseMapping, prepareGpuReferenceParameters(frame, { ...parameters, referenceMapping: originalMapping }).inverseMapping, 'GPU inverse mapping');
  const displacement = await prepareDisplacements(frame, reference, { minimumImage: false });
  assertExact(displacement.referenceMapping, mapping, 'Displacement reused matching');
  assert.equal(prepareGpuDisplacementParameters(frame, displacement).context.referenceMapping, displacement.referenceMapping);
  let created = 0;
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: sharedMemory }, workerFactory() {
    created++;
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url));
    return { addEventListener(name, callback) { worker.on(name, value => callback(name === 'message' ? { data: value } : value)); },
      postMessage(data, transfer) { worker.postMessage(data, transfer); }, terminate() { worker.terminate(); } };
  } });
  try {
    const expected = calculateReferenceStrain(frame, { ...parameters, referenceMapping: originalMapping });
    const result = await pool.analyzeCPU(frame, { kind: 'referenceStrain', ...parameters });
    assert.equal(result.workerCount, 2);
    for (const name of REFERENCE_STRAIN_FIELDS) assertExact(result[name], expected[name], name);
    const expectedDisplacement = calculatePreparedDisplacements(frame, displacement);
    const actualDisplacement = await pool.analyzeCPU(frame, { kind: 'displacement', ...displacement });
    assertExact(actualDisplacement.vectors, expectedDisplacement.vectors, 'vectors');
    assertExact(actualDisplacement.magnitudes, expectedDisplacement.magnitudes, 'magnitudes');
    reference.ids.reverse();
    const next = await prepareDisplacements(frame, reference, { minimumImage: false });
    assertExact(next.referenceMapping, createReferenceMapping(frame, reference), 'mutated reference is refreshed');
    const repeated = await pool.analyzeCPU(frame, { kind: 'displacement', ...next });
    assertExact(repeated.vectors, calculatePreparedDisplacements(frame, next).vectors, 'refreshed Worker vectors');
    assert.equal(created, 2); assert.ok(originalIds.byteLength && reference.ids.byteLength && mapping.byteLength);
    assert.equal(pool.active.size, 0); assert.equal(pool.queue.length, 0);
  } finally { pool.close(); }
});
