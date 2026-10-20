import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { replicateFrame } from '../src/data/replicate.js';
import { estimateFrameBytes } from '../src/data/cache-policy.js';
import { ReplicationIdCache, ReplicationIdsReceiver, retainedIdBytes } from '../src/data/replication-ids.js';
import { crystalFrame } from '../tests/helpers/crystals.js';

// A separate read-only export avoids measuring a moving baseline.
// node scripts/benchmark-replication-ids.mjs --baseline /tmp/baseline
const args = process.argv.slice(2), value = (flag, fallback) => {
  const index = args.indexOf(flag); return index < 0 ? fallback : args[index + 1];
};
const baseline = value('--baseline');
assert.ok(baseline, 'Pass --baseline PATH to the pre-optimization repository.');
const repeats = Number(value('--repetitions', 5)), cells = Number(value('--cells', 31));
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 15);
assert.ok(Number.isInteger(cells) && cells >= 1 && cells <= 40);
const previous = await import(pathToFileURL(resolve(baseline, 'src/data/replicate.js')));
const previousPolicy = await import(pathToFileURL(resolve(baseline, 'src/data/cache-policy.js')));
const source = crystalFrame('fcc', cells), copies = [2, 2, 2];
// Both snapshots share exact IDs while the second frame changes coordinates.
const moved = { ...source, ids: source.ids.slice(), fractional: source.fractional.slice(), positions: source.positions.slice() };
for (let i = 0; i < moved.fractional.length; i += 3) {
  moved.fractional[i] += .001;
  moved.positions[i] += .001 * source.cell.vectors[0];
}
const sources = [source, moved], expected = [], idCache = new ReplicationIdCache();
function signature(frame) {
  const hash = createHash('sha256');
  for (const field of ['types', 'fractional', 'positions', 'imageFlags', 'unwrappedPositions']) {
    const array = frame[field];
    hash.update(field);
    if (array) hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  }
  hash.update(JSON.stringify({ ids: frame.ids, typeLabels: frame.typeLabels, cell: frame.cell,
    properties: frame.properties, physicalReplication: frame.physicalReplication }));
  return hash.digest('hex');
}
const directTimes = [[], []], direct = [previous.replicateFrame,
  (frame, repetitions, options) => replicateFrame(frame, repetitions, { ...options, idCache })];
let frozenIds, last;
// Warm JIT separately. The measured direct loop excludes scheduler yields;
// the actual Worker loop below uses the production bounded-yield path.
for (let version = 0; version < 2; version++) for (let index = 0; index < 2; index++) {
  last = await direct[version](sources[index], copies, { yieldTask: async () => {} });
  expected[index] ??= signature(last); assert.equal(signature(last), expected[index]);
  if (version) frozenIds = last.ids;
}
for (let repeat = 0; repeat < repeats; repeat++) for (const version of repeat % 2 ? [1, 0] : [0, 1]) {
  const index = repeat % 2, start = performance.now();
  last = await direct[version](sources[index], copies, { yieldTask: async () => {} });
  directTimes[version].push(performance.now() - start);
  assert.equal(signature(last), expected[index], 'All IDs and scientific bytes must match the baseline.');
  if (version) assert.equal(last.ids, frozenIds, 'Warm replication must retain the same ID array.');
}
const reordered = { ...source, ids: source.ids.slice().reverse() }, invalidationTimes = [[], []];
let reorderedHash;
for (let version = 0; version < 2; version++) {
  const start = performance.now();
  last = await direct[version](reordered, copies, { yieldTask: async () => {} });
  invalidationTimes[version].push(performance.now() - start);
  reorderedHash ??= signature(last); assert.equal(signature(last), reorderedHash);
  if (version) assert.notEqual(last.ids, frozenIds, 'Reordered source IDs must create a different layout.');
}
last = null; frozenIds = null; idCache.clear();

function workerClient(moduleUrl) {
  const worker = new Worker(new URL('../tests/helpers/node-replication-worker.mjs', import.meta.url), { workerData: { moduleUrl } });
  const pending = new Map(), receiver = new ReplicationIdsReceiver(); let sequence = 0;
  worker.on('message', message => {
    if (message.event) return;
    const request = pending.get(message.id); pending.delete(message.id);
    if (!message.ok) { request.reject(new Error(message.error)); return; }
    const wireIds = message.result.frame.ids?.length ?? 0;
    request.resolve({ frame: receiver.restore(message.result, request.known), wireIds });
  });
  worker.on('error', error => { for (const request of pending.values()) request.reject(error); pending.clear(); });
  return { close: () => worker.terminate(), replicate: (frame, sourceGeneration = 1) => {
    const id = ++sequence, known = receiver.current;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, known });
      worker.postMessage({ id, type: 'replicate', payload: { frame, repetitions: copies,
        sourceGeneration, knownIdsToken: known?.token } });
    });
  } };
}
const workers = [workerClient(pathToFileURL(resolve(baseline, 'src/workers/replication-worker.js')).href),
  workerClient(new URL('../src/workers/replication-worker.js', import.meta.url).href)];
const workerTimes = [[], []], transmittedIds = [[], []];
const invalidatedWireIds = [[], []];
const observedIds = [new WeakSet(), new WeakSet()], distinctIdArrays = [0, 0];
let receiverIds, accountingFrame;
try {
  for (let version = 0; version < 2; version++) {
    const warm = await workers[version].replicate(source);
    assert.equal(signature(warm.frame), expected[0]);
    assert.equal(warm.wireIds, source.ids.length * 8, 'Initial Worker reply must include complete IDs.');
    if (version) receiverIds = warm.frame.ids;
  }
  for (let repeat = 0; repeat < repeats; repeat++) for (const version of repeat % 2 ? [1, 0] : [0, 1]) {
    const index = repeat % 2, start = performance.now();
    const result = await workers[version].replicate(sources[index]);
    workerTimes[version].push(performance.now() - start); transmittedIds[version].push(result.wireIds);
    if (!observedIds[version].has(result.frame.ids)) {
      observedIds[version].add(result.frame.ids); distinctIdArrays[version]++;
    }
    assert.equal(signature(result.frame), expected[index]);
    assert.equal(result.wireIds, version ? 0 : source.ids.length * 8);
    if (version) { assert.equal(result.frame.ids, receiverIds); accountingFrame = result.frame; }
  }
  // Changing ID order and then replacing the source must both invalidate the
  // protocol, even if the caller still advertises its previous ID token.
  for (const generation of [1, 2]) for (let version = 0; version < 2; version++) {
    const result = await workers[version].replicate(reordered, generation);
    assert.equal(signature(result.frame), reorderedHash);
    assert.equal(result.wireIds, source.ids.length * 8);
    invalidatedWireIds[version].push(result.wireIds);
    if (version) {
      assert.notEqual(result.frame.ids, receiverIds);
      receiverIds = result.frame.ids;
      const reused = await workers[version].replicate(reordered, generation);
      assert.equal(reused.wireIds, 0); assert.equal(reused.frame.ids, receiverIds);
      assert.equal(signature(reused.frame), reorderedHash);
    }
  }
} finally { await Promise.all(workers.map(worker => worker.close())); }

// Account the exact same frame in both implementations, including its summary,
// so improvements cannot come from skipping metadata or changing byte totals.
const byteTimes = [[], []], policies = [previousPolicy.estimateFrameBytes, estimateFrameBytes];
const accountedBytes = policies[0](accountingFrame);
for (const policy of policies) assert.equal(policy(accountingFrame), accountedBytes);
for (let repeat = 0; repeat < repeats; repeat++) for (const version of repeat % 2 ? [1, 0] : [0, 1]) {
  const start = performance.now();
  const bytes = policies[version](accountingFrame);
  byteTimes[version].push(performance.now() - start); assert.equal(bytes, accountedBytes);
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const timing = times => ({ samplesMs: { before: times[0], after: times[1] },
  mediansMs: { before: median(times[0]), after: median(times[1]) } });
console.log(JSON.stringify({ runtime: process.version, availableParallelism: availableParallelism(),
  cpuQuota: await readFile('/sys/fs/cgroup/cpu.max', 'utf8').then(text => text.trim()).catch(() => null),
  baseline: resolve(baseline), sourceAtoms: source.ids.length, replicatedAtoms: source.ids.length * 8,
  repetitions: copies, scientificHashes: expected,
  direct: { scope: 'Warm replication including validation and summary; scheduler yields excluded', ...timing(directTimes) },
  invalidation: { scope: 'Reordered source IDs direct rebuild; exact IDs/coordinate hash checked',
    scientificHash: reorderedHash, ...timing(invalidationTimes),
    workerPayloadIdsAfterReorderAndSourceReplacement: { before: invalidatedWireIds[0], after: invalidatedWireIds[1] } },
  worker: { scope: 'Real Worker round trip including source clone, production yields, result transfer and page ID restoration; startup excluded',
    ...timing(workerTimes), transmittedIds: { before: transmittedIds[0], after: transmittedIds[1] },
    distinctPageIdArraysAcrossMeasuredReplies: { before: distinctIdArrays[0], after: distinctIdArrays[1] },
    retainedWorkerIdLayoutBytes: retainedIdBytes(accountingFrame.ids),
    retainedWorkerSourceSnapshotBytes: source.ids.byteLength },
  accounting: { scope: 'Exact byte estimate of the same Worker result with all metadata',
    accountedBytes, ...timing(byteTimes) } }, null, 2));
