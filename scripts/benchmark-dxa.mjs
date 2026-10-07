import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { calculateDxa, dxaWorkerCount, releaseDxaKernels } from '../src/analysis/dxa.js';
import { replicateFrame } from '../src/data/replicate.js';
import { parseCfg } from '../src/io/cfg.js';

const workersIndex = process.argv.indexOf('--workers');
const workerCount = workersIndex < 0 ? 1 : Number(process.argv[workersIndex + 1]);
assert.ok(Number.isInteger(workerCount) && workerCount >= 1 && workerCount <= 64, 'Use --workers 1..64.');
const filename = 'NiGB_minimized.cfg';
const frame = await replicateFrame(parseCfg(await readFile(new URL(`../examples/${filename}`, import.meta.url), 'utf8'), filename), [1, 1, 2]);
const runs = [];
try {
  for (const temperature of ['cold', 'warm']) {
    const result = await calculateDxa(frame, {}, { workerCount });
    assert.equal(result.workerCount, dxaWorkerCount(frame.ids.length, workerCount), result.threadingFallback);
    assert.equal(result.backend, 'cpu');
    assert.match(result.engine, /^Wasm CPU/);
    runs.push({ temperature, workerCount: result.workerCount, engine: result.engine, threaded: result.threaded,
      sharedMemory: result.sharedMemory, poolSize: result.poolSize, kernelGeneration: result.kernelGeneration,
      nativeWorkerCount: result.nativeWorkerCount, cpuOffloadUsed: result.cpuOffloadUsed,
      cpuStageWorkerCounts: result.cpuStageWorkerCounts, cpuStageTimings: result.cpuStageTimings,
      cpuStageFallbacks: result.cpuStageFallbacks,
      wasmMemoryBytes: result.wasmMemoryBytes, elapsedMs: result.elapsedMs,
      stageTimings: result.stageTimings, segments: result.segments.length, totalLength: result.totalLength,
      structureCounts: result.structureCounts, rssMiB: process.memoryUsage().rss / 1024 ** 2 });
  }
  console.log(JSON.stringify({ runtime: `Node ${process.version}`, availableParallelism: availableParallelism(),
    filename, realReplication: [1, 1, 2], atoms: frame.ids.length, backend: 'CPU Wasm', runs }, null, 2));
} finally { await releaseDxaKernels(); }
