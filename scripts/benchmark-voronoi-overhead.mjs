import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { crystalFrame } from '../tests/helpers/crystals.js';
import { parseCfg } from '../src/io/cfg.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';
import * as current from '../src/analysis/voronoi.js';
import { materializeVoronoiIndices } from '../src/analysis/voronoi-indices.js';

// Run against a separate read-only export of the baseline, not a live branch.
// Example: node scripts/benchmark-voronoi-overhead.mjs --baseline /tmp/baseline
const args = process.argv.slice(2), value = (flag, fallback) => {
  const index = args.indexOf(flag); return index < 0 ? fallback : args[index + 1];
};
const baseline = value('--baseline');
assert.ok(baseline, 'Pass --baseline PATH to a checkout/export of the pre-optimization repository.');
const previous = await import(pathToFileURL(resolve(baseline, 'src/analysis/voronoi.js')));
const repeats = Number(value('--repetitions', 7)), dataset = value('--dataset', 'fcc');
const workerCount = Number(value('--workers', 2)), sharedMemory = value('--shared', 'true') === 'true';
assert.ok(Number.isInteger(repeats) && repeats >= 3 && repeats <= 15);
assert.ok(Number.isInteger(workerCount) && workerCount >= 1 && workerCount <= 8);
assert.ok(['fcc', 'nigb', 'fe'].includes(dataset));
const frame = dataset === 'fcc' ? crystalFrame('fcc', 12) : dataset === 'nigb'
  ? parseCfg(await readFile(new URL('../examples/NiGB_minimized.cfg', import.meta.url), 'utf8'))
  : parseLammpsFrame(await readFile(new URL('../examples/Fe_disloc_loop.dump', import.meta.url), 'utf8'));
const atomCount = frame.fractional.length / 3, endAtom = Math.min(atomCount, Number(value('--atoms', atomCount)));
assert.ok(Number.isInteger(endAtom) && endAtom > 0);
const fields = [...Object.keys(current.VORONOI_FIELDS), 'faceOffsets', 'faceAreas', 'faceOrders', 'faceNeighbors', 'faceBoundary', 'faceAccepted'];
const statistics = ['voronoiIndices', 'summary', 'coordinationHistogram', 'volumeHistogram', 'faceAreaHistogram', 'indexCounts'];
function signature(result) {
  const hash = createHash('sha256');
  for (const field of fields) hash.update(result[field]);
  for (const field of statistics) hash.update(JSON.stringify(result[field]));
  return hash.digest('hex');
}
const contexts = [previous.createVoronoiContext(frame), current.createVoronoiContext(frame)];
const versions = [previous, current], times = [[], []];
let expected, last;
// Warm native code and resident indices separately; only foreground kernel,
// face assembly, labels and statistics are timed below.
for (let version = 0; version < 2; version++) {
  const result = await versions[version].calculateVoronoi(frame, { context: contexts[version], endAtom });
  expected ??= signature(result); assert.equal(signature(result), expected);
  process.stderr.write(`${dataset}: resident ${version ? 'after' : 'before'} warmup complete\n`);
}
for (let repeat = 0; repeat < repeats; repeat++) {
  for (const version of repeat % 2 ? [1, 0] : [0, 1]) {
    const start = performance.now();
    last = await versions[version].calculateVoronoi(frame, { context: contexts[version], endAtom });
    times[version].push(performance.now() - start);
    assert.equal(signature(last), expected, 'Every scientific output byte, label and summary must match the baseline.');
    process.stderr.write(`${dataset}: resident ${version ? 'after' : 'before'} ${repeat + 1}/${repeats}, ${times[version].at(-1).toFixed(1)} ms\n`);
  }
}

// Complete warmed foreground runs include actual Worker dispatch, all face
// transfers, finalization and the final public-label expansion. A partial
// central range cannot go through the public pool without changing its API,
// so --atoms intentionally skips this full-frame section.
const poolTimes = [[], []], poolMetadata = [];
if (endAtom === atomCount) {
  const terminations = [], pools = [];
  try {
    for (const root of [resolve(baseline), fileURLToPath(new URL('..', import.meta.url))]) {
      const { AnalysisPool } = await import(pathToFileURL(resolve(root, 'src/analysis/analysis-pool.js')));
      const workerModule = pathToFileURL(resolve(root, 'src/workers/analysis-worker.js')).href;
      const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: workerCount + 2 },
        crossOriginIsolated: sharedMemory }, workerFactory: () => {
        const worker = new Worker(`
          const { parentPort } = require('node:worker_threads');
          globalThis.self = {
            addEventListener: (_name, listener) => parentPort.on('message', data => listener({ data })),
            postMessage: (data, transfers) => parentPort.postMessage(data, transfers),
          };
          import(${JSON.stringify(workerModule)}).catch(error => { throw error; });
        `, { eval: true });
        return {
          addEventListener: (name, listener) => worker.on(name, data => listener(name === 'message' ? { data } : data)),
          postMessage: (data, transfers) => worker.postMessage(data, transfers),
          terminate: () => { terminations.push(worker.terminate()); },
        };
      } });
      pools.push(pool);
      await pool.prepareCpuFrame(frame);
      const result = await pool.analyzeCPU(frame, { kind: 'voronoi' });
      assert.equal(signature(result), expected);
      process.stderr.write(`${dataset}: real Worker pool ${pools.length === 1 ? 'before' : 'after'} warmup complete\n`);
    }
    for (let repeat = 0; repeat < repeats; repeat++) for (const version of repeat % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      const result = await pools[version].analyzeCPU(frame, { kind: 'voronoi' });
      poolTimes[version].push(performance.now() - start);
      assert.equal(signature(result), expected);
      assert.equal(result.kernelInitializations, 0); assert.equal(result.indexBuilds, 0);
      poolMetadata[version] = { workerCount: result.workerCount, sharedMemory: result.sharedMemory,
        chunkCount: result.chunkCount, kernelInitializations: result.kernelInitializations, indexBuilds: result.indexBuilds };
      process.stderr.write(`${dataset}: real Worker pool ${version ? 'after' : 'before'} ${repeat + 1}/${repeats}, ${poolTimes[version].at(-1).toFixed(1)} ms\n`);
    }
  } finally {
    for (const pool of pools) pool.close();
    await Promise.allSettled(terminations);
  }
}

// Isolate the three transport hops eliminated by label IDs. Transferable IDs
// follow the actual worker protocol; final public string-array expansion is
// included in the compact timing. Building each input is outside the timing.
const cloneAtoms = Number(value('--clone-atoms', 1_000_000));
assert.ok(Number.isInteger(cloneAtoms) && cloneAtoms > 0 && cloneAtoms <= 5_000_000);
const labels = Array.from(new Set(last.voronoiIndices));
const legacy = Array.from({ length: cloneAtoms }, (_, atom) => labels[atom % labels.length]);
const cloneTimes = [[], []];
for (let repeat = -1; repeat < repeats; repeat++) for (const version of repeat % 2 ? [1, 0] : [0, 1]) {
  let result = version ? { voronoiIndexIds: Uint32Array.from({ length: cloneAtoms }, (_, atom) => atom % labels.length),
    voronoiIndexLabels: labels } : { voronoiIndices: legacy };
  const start = performance.now();
  for (let hop = 0; hop < 3; hop++) result = structuredClone(result, version ? { transfer: [result.voronoiIndexIds.buffer] } : undefined);
  if (version) materializeVoronoiIndices(result);
  const elapsed = performance.now() - start;
  if (repeat >= 0) cloneTimes[version].push(elapsed);
  assert.deepEqual(result.voronoiIndices, legacy);
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({ runtime: process.version, availableParallelism: availableParallelism(),
  cpuQuota: await readFile('/sys/fs/cgroup/cpu.max', 'utf8').then(text => text.trim()).catch(() => null),
  baseline: resolve(baseline), dataset, sourceAtoms: atomCount, analyzedAtoms: endAtom, scientificHash: expected,
  repetitions: repeats, order: 'One warmup per implementation; repetitions alternate AB then BA',
  verification: { fields, statistics, everySampleEqual: true },
  kernel: { scope: 'Resident CPU Voro++ kernel + typed face assembly + topology labels + statistics; index/first Wasm initialization excluded',
    samplesMs: { before: times[0], after: times[1] }, mediansMs: { before: median(times[0]), after: median(times[1]) } },
  pool: endAtom !== atomCount ? { skipped: '--atoms limits the direct calculation to a partial central range' }
    : { scope: 'Full-frame warmed real Worker pool, all three transport hops and finalization, public labels expanded',
      requestedWorkers: workerCount, metadata: { before: poolMetadata[0], after: poolMetadata[1] },
      samplesMs: { before: poolTimes[0], after: poolTimes[1] }, mediansMs: { before: median(poolTimes[0]), after: median(poolTimes[1]) } },
  transport: { scope: 'Three native structured-clone hops, transferable compact IDs; final public string expansion included; no thread scheduling',
    atoms: cloneAtoms, uniqueLabels: labels.length, perHopStrings: { before: cloneAtoms, after: labels.length },
    compactIdBytes: cloneAtoms * 4, samplesMs: { before: cloneTimes[0], after: cloneTimes[1] },
    mediansMs: { before: median(cloneTimes[0]), after: median(cloneTimes[1]) } } }, null, 2));
