import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { replicateFrame } from '../../src/data/replicate.js';
import { ReplicationIdCache, ReplicationIdsReceiver } from '../../src/data/replication-ids.js';
import { crystalFrame } from '../../tests/helpers/crystals.js';

// Measure cold layouts separately from trajectory reuse. Worker startup is
// warmed, but every measured reply constructs and clones the complete IDs.
const args = process.argv.slice(2), value = (flag, fallback) => {
  const index = args.indexOf(flag); return index < 0 ? fallback : args[index + 1];
};
const baseline = value('--baseline');
assert.ok(baseline, 'Pass --baseline PATH to the pre-optimization repository.');
const repeats = Number(value('--repetitions', 5)), cells = Number(value('--cells', 31));
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 15);
assert.ok(Number.isInteger(cells) && cells >= 1 && cells <= 40);
const previous = await import(pathToFileURL(resolve(baseline, 'src/data/replicate.js')));
const source = crystalFrame('fcc', cells), copies = [2, 2, 2];
const sources = [source, { ...source, ids: source.ids.slice().reverse() }], hashes = [];
const hash = frame => {
  const result = createHash('sha256');
  for (const field of ['types', 'fractional', 'positions', 'imageFlags', 'unwrappedPositions']) {
    const array = frame[field]; result.update(field);
    if (array) result.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  }
  return result.update(JSON.stringify({ ids: frame.ids, typeLabels: frame.typeLabels, cell: frame.cell,
    properties: frame.properties, physicalReplication: frame.physicalReplication })).digest('hex');
};
class MeasuredCache extends ReplicationIdCache {
  resetMeasurement() { this.prepareMs = 0; this.commitMs = 0; this.layouts = 0; }
  async prepare(...args) {
    const before = this.current, start = performance.now(), result = await super.prepare(...args);
    this.prepareMs += performance.now() - start;
    if (result !== before) this.layouts++;
    return result;
  }
  commit(...args) { const start = performance.now(); super.commit(...args); this.commitMs += performance.now() - start; }
}
const cache = new MeasuredCache(), versions = [previous.replicateFrame,
  (frame, repetitions, options) => replicateFrame(frame, repetitions, { ...options, idCache: cache })];
cache.resetMeasurement();
// Build both source layouts and warm the numerical code before timing.
for (let version = 0; version < 2; version++) for (let frame = 0; frame < 2; frame++) {
  const output = await versions[version](sources[frame], copies, { yieldTask: async () => {} });
  hashes[frame] ??= hash(output); assert.equal(hash(output), hashes[frame]);
}
const directCases = {};
for (const scenario of ['sourceReplacement', 'rowReorder']) {
  const samples = [[], []], prepareMs = [], commitMs = [], constructedLayouts = [];
  // A deterministic preceding layout ensures even the first rowReorder misses.
  await replicateFrame(sources[1], copies, { idCache: cache, yieldTask: async () => {} });
  for (let repeat = 0; repeat < repeats; repeat++) for (const version of repeat % 2 ? [1, 0] : [0, 1]) {
    const index = scenario === 'rowReorder' ? repeat % 2 : 0;
    if (version) {
      if (scenario === 'sourceReplacement') cache.clear();
      cache.resetMeasurement();
    }
    const start = performance.now();
    const output = await versions[version](sources[index], copies, { yieldTask: async () => {} });
    samples[version].push(performance.now() - start);
    assert.equal(hash(output), hashes[index]);
    if (version) {
      prepareMs.push(cache.prepareMs); commitMs.push(cache.commitMs); constructedLayouts.push(cache.layouts);
      assert.equal(cache.layouts, 1, 'Each cold measurement must construct a new ID layout.');
      assert.equal(cache.current.keys, null, 'Encoded source keys must be released after construction.');
      assert.notEqual(cache.current.sourceIds, sources[index].ids);
      assert.equal(cache.current.sourceBytes, source.ids.byteLength);
      assert.ok(Object.isFrozen(output.ids));
    }
  }
  directCases[scenario] = { samples, prepareMs, commitMs, constructedLayouts };
}
const allocation = { retainedIdsBytes: cache.current.bytes, sourceSnapshotBytes: cache.current.sourceBytes,
  sourceSnapshotArrays: 1, retainedExpandedIdArrays: 1, retainedEncodedKeyArrays: cache.current.keys === null ? 0 : 1 };
cache.clear();
function workerClient(moduleUrl) {
  const worker = new Worker(new URL('../../tests/helpers/node-replication-worker.mjs', import.meta.url), { workerData: { moduleUrl } });
  const pending = new Map(), receiver = new ReplicationIdsReceiver(); let sequence = 0;
  worker.on('message', message => {
    if (message.event) return;
    const request = pending.get(message.id); pending.delete(message.id);
    if (!message.ok) { request.reject(new Error(message.error)); return; }
    const wireIds = message.result.frame.ids?.length ?? 0, start = performance.now();
    const frame = receiver.restore(message.result, request.known);
    request.resolve({ frame, wireIds, restoreMs: performance.now() - start });
  });
  worker.on('error', error => { for (const request of pending.values()) request.reject(error); pending.clear(); });
  return { close: () => worker.terminate(), replicate: generation => {
    const id = ++sequence, known = receiver.current;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, known });
      worker.postMessage({ id, type: 'replicate', payload: { frame: source, repetitions: copies,
        sourceGeneration: generation, knownIdsToken: known?.token } });
    });
  } };
}
const workers = [workerClient(pathToFileURL(resolve(baseline, 'src/workers/replication-worker.js')).href),
  workerClient(new URL('../../src/workers/replication-worker.js', import.meta.url).href)];
const workerSamples = [[], []], pageRestoreMs = [[], []], workerPayloadIds = [[], []];
try {
  for (const worker of workers) assert.equal(hash((await worker.replicate(0)).frame), hashes[0]);
  for (let repeat = 0; repeat < repeats; repeat++) for (const version of repeat % 2 ? [1, 0] : [0, 1]) {
    const start = performance.now(), output = await workers[version].replicate(repeat + 1);
    workerSamples[version].push(performance.now() - start); pageRestoreMs[version].push(output.restoreMs);
    workerPayloadIds[version].push(output.wireIds);
    assert.equal(hash(output.frame), hashes[0]);
    assert.equal(output.wireIds, source.ids.length * 8, 'Source replacement must transmit every expanded ID.');
  }
} finally { await Promise.all(workers.map(worker => worker.close())); }
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const timing = samples => ({ samplesMs: { before: samples[0], after: samples[1] },
  mediansMs: { before: median(samples[0]), after: median(samples[1]) } });
console.log(JSON.stringify({ runtime: process.version, availableParallelism: availableParallelism(),
  cpuQuota: await readFile('/sys/fs/cgroup/cpu.max', 'utf8').then(text => text.trim()).catch(() => null),
  baseline: resolve(baseline), sourceAtoms: source.ids.length, replicatedAtoms: source.ids.length * 8,
  scientificHashes: hashes, allocation,
  direct: Object.fromEntries(Object.entries(directCases).map(([scenario, result]) => [scenario, {
    scope: 'Complete cold layout including validation, strings, geometry and summary; scheduler yields excluded',
    ...timing(result.samples), newLayoutCounts: result.constructedLayouts,
    afterIdPrepareMs: result.prepareMs, afterIdFreezeAndCommitMs: result.commitMs }])),
  workerSourceReplacement: { scope: 'Real Worker round trip with full ID construction/clone after every source generation change; module startup excluded',
    ...timing(workerSamples), pageRestoreMs: { before: pageRestoreMs[0], after: pageRestoreMs[1] },
    transmittedIds: { before: workerPayloadIds[0], after: workerPayloadIds[1] } } }, null, 2));
