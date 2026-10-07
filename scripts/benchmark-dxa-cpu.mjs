import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { calculateDxa, dxaWorkerCount, releaseDxaKernels, warmupDxa } from '../src/analysis/dxa.js';
import { replicateFrame } from '../src/data/replicate.js';
import { parseCfg } from '../src/io/cfg.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';

// Measure the actual whole-frame C++ pipeline in Node's Wasm pthreads. Pool
// growth is recorded separately, and warm runs retain the same module/heap.
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const parallelism = availableParallelism();
const defaultThreads = Math.min(64, Math.max(1, parallelism - 2));
const dataset = option('--dataset', 'all');
const threadSequence = option('--threads', `1,${defaultThreads},1`).split(',').map(Number);
const repetitions = Number(option('--repetitions', '2'));
assert.ok(['all', 'fe', 'nigb'].includes(dataset), 'Use --dataset all|fe|nigb.');
assert.ok(threadSequence.length && threadSequence.every(count => Number.isSafeInteger(count) && count >= 1 && count <= 64),
  'Use --threads with a comma-separated sequence in 1..64.');
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10, 'Use --repetitions 1..10.');

const datasets = [
  { id: 'fe', filename: 'Fe_disloc_loop.dump', parse: parseLammpsFrame, replication: [1, 1, 1], lattice: 'bcc' },
  { id: 'nigb', filename: 'NiGB_minimized.cfg', parse: parseCfg, replication: [1, 1, 2], lattice: 'fcc' },
].filter(entry => dataset === 'all' || entry.id === dataset);
const report = { runtime: `Node ${process.version}`, availableParallelism: parallelism,
  backend: 'CPU Wasm pthreads', threadSequence, repetitions, datasets: [] };

try {
  for (const entry of datasets) {
    const source = entry.parse(await readFile(new URL(`../examples/${entry.filename}`, import.meta.url), 'utf8'), entry.filename);
    const frame = entry.replication.every(value => value === 1) ? source : await replicateFrame(source, entry.replication);
    const row = { filename: entry.filename, sourceAtoms: source.ids.length, realReplication: entry.replication,
      atoms: frame.ids.length, warmups: [], runs: [] };
    report.datasets.push(row);
    let baseline;
    for (let sequenceIndex = 0; sequenceIndex < threadSequence.length; sequenceIndex++) {
      const workerCount = threadSequence[sequenceIndex];
      const expectedThreads = dxaWorkerCount(frame.ids.length, workerCount);
      const warmupStarted = performance.now();
      const ready = await warmupDxa({ atomCount: frame.ids.length, workerCount });
      row.warmups.push({ sequenceIndex, requestedThreads: workerCount, elapsedMs: performance.now() - warmupStarted, ...ready });
      for (let repetition = 0; repetition < repetitions; repetition++) {
        const result = await calculateDxa(frame, { lattice: entry.lattice }, { workerCount });
        assert.equal(result.workerCount, expectedThreads, result.threadingFallback);
        assert.equal(result.backend, 'cpu');
        assert.match(result.engine, /^Wasm CPU/);
        const atomLabelHash = createHash('sha256').update(result.atomStructureTypes).digest('hex');
        const signature = { segments: result.segments.length, structureCounts: result.structureCounts, atomLabelHash,
          totalLength: result.totalLength, families: result.counts,
          segmentTopology: result.segments.map(segment => ({ family: segment.familyId, structureType: segment.structureType,
            closed: segment.closed, isInfinite: segment.isInfinite, burgersMagnitude: Math.hypot(...segment.burgersVector),
            junctions: segment.junctions })) };
        if (!baseline) baseline = signature;
        assert.equal(signature.atomLabelHash, baseline.atomLabelHash, 'Every atom label must agree across concurrency changes.');
        if (entry.id === 'fe') {
          assert.equal(signature.segments, 1);
          assert.equal(signature.segmentTopology[0].family, 'half111');
          assert.equal(signature.segmentTopology[0].closed, true);
          assert.equal(signature.segmentTopology[0].isInfinite, false);
          assert.ok(Math.abs(signature.segmentTopology[0].burgersMagnitude - Math.sqrt(3) / 2) < 1e-10);
          assert.ok(signature.totalLength > 100 && signature.totalLength < 108);
          assert.deepEqual(signature.segmentTopology[0].junctions,
            [[{ segmentId: result.segments[0].id, end: 1 }], [{ segmentId: result.segments[0].id, end: 0 }]]);
        } else {
          assert.equal(signature.segments, 0, 'The real replicated NiGB reference has no dislocation lines.');
          assert.equal(signature.totalLength, 0);
        }
        const nativeStageMs = result.stageTimings.reduce((sum, stage) => sum + stage.elapsedMs, 0);
        const run = { sequenceIndex, repetition, requestedThreads: workerCount, workerCount: result.workerCount,
          backend: result.backend, engine: result.engine, threaded: result.threaded, sharedMemory: result.sharedMemory,
          nativeWorkerCount: result.nativeWorkerCount, cpuOffloadUsed: result.cpuOffloadUsed,
          cpuStageWorkerCounts: result.cpuStageWorkerCounts, cpuStageTimings: result.cpuStageTimings,
          cpuStageFallbacks: result.cpuStageFallbacks,
          elapsedMs: result.elapsedMs,
          nativeStageMs, otherPipelineMs: result.elapsedMs - nativeStageMs, stageTimings: result.stageTimings,
          kernelGeneration: result.kernelGeneration, poolSize: result.poolSize, wasmMemoryBytes: result.wasmMemoryBytes,
          rssMiB: process.memoryUsage().rss / 1024 ** 2, signature };
        row.runs.push(run);
        process.stderr.write(`${entry.id} ${result.workerCount} threads run ${repetition + 1}: ${result.elapsedMs.toFixed(1)} ms; `
          + `${signature.segments} segments, length ${signature.totalLength.toFixed(5)}\n`);
      }
    }
    assert.ok(row.runs.every(run => run.kernelGeneration === row.runs[0].kernelGeneration), 'Concurrency changes retain the kernel.');
  }
  console.log(JSON.stringify(report, null, 2));
} finally { await releaseDxaKernels(); }
