import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { parseCfg } from '../src/io/cfg.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';

// Real analysis Workers, full source structures, unchanged periodic geometry.
// --module-root allows a saved pre-change checkout to run the same benchmark.
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const dataset = option('--dataset', 'all');
const workerCounts = option('--workers', '1,2,4').split(',').map(Number);
const repetitions = Number(option('--repetitions', '2'));
const sharedMemory = option('--shared', 'true') === 'true';
const root = resolve(option('--module-root', fileURLToPath(new URL('..', import.meta.url))));
assert.ok(['all', 'fe', 'nigb'].includes(dataset), 'Use --dataset all|fe|nigb.');
assert.ok(workerCounts.length && workerCounts.every(count => Number.isInteger(count) && count >= 1 && count <= 64),
  'Use --workers with comma-separated counts in 1..64.');
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10, 'Use --repetitions 1..10.');
const { AnalysisPool } = await import(pathToFileURL(resolve(root, 'src/analysis/analysis-pool.js')));
const workerModule = pathToFileURL(resolve(root, 'src/workers/analysis-worker.js')).href;
const scientificFields = ['atomicVolume', 'voronoiSurfaceArea', 'voronoiCoordination', 'voronoiBoundaryFaces',
  'voronoiMaxFaceOrder', 'faceOffsets', 'faceAreas', 'faceOrders', 'faceNeighbors', 'faceBoundary', 'faceAccepted'];
const report = { runtime: `Node ${process.version}`, availableParallelism: availableParallelism(),
  cpuQuota: await readFile('/sys/fs/cgroup/cpu.max', 'utf8').then(value => value.trim()).catch(() => null),
  backend: 'CPU Worker pool / Voro++ Wasm', moduleRoot: root, workerCounts, sharedMemory, repetitions, datasets: [] };

for (const entry of [
  { id: 'nigb', filename: 'NiGB_minimized.cfg', parse: parseCfg },
  { id: 'fe', filename: 'Fe_disloc_loop.dump', parse: parseLammpsFrame },
].filter(entry => dataset === 'all' || entry.id === dataset)) {
  const frame = entry.parse(await readFile(new URL(`../examples/${entry.filename}`, import.meta.url), 'utf8'), entry.filename);
  const row = { filename: entry.filename, atoms: frame.ids.length, runs: [] };
  report.datasets.push(row);
  let baseline;
  for (const requestedWorkers of workerCounts) {
    const terminations = [];
    const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: requestedWorkers + 2 },
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
    try {
      for (let repetition = 0; repetition < repetitions; repetition++) {
        const result = await pool.analyze(frame, { kind: 'voronoi' });
        const hash = createHash('sha256');
        for (const field of scientificFields) hash.update(result[field]);
        hash.update(JSON.stringify(result.voronoiIndices));
        const signature = hash.digest('hex');
        baseline ??= signature;
        assert.equal(signature, baseline, 'Concurrency and resident reuse must preserve every scientific output byte.');
        assert.ok(Math.abs(result.summary.volumeError) < 1e-10, 'Cells must conserve the full simulation-cell volume.');
        const run = { requestedWorkers, workerCount: result.workerCount, repetition, elapsedMs: result.elapsedMs,
          kernelInitializations: result.kernelInitializations, indexBuilds: result.indexBuilds ?? null,
          frameUploads: result.frameUploads ?? null, chunkCount: result.chunkCount ?? result.workerCount,
          scheduling: result.scheduling ?? 'static', volumeError: result.summary.volumeError,
          rssMiB: process.memoryUsage().rss / 1024 ** 2, scientificHash: signature };
        row.runs.push(run);
        process.stderr.write(`${entry.id}: ${run.workerCount} Workers, run ${repetition + 1}, ${run.elapsedMs.toFixed(1)} ms, `
          + `${run.chunkCount} chunks, ${run.indexBuilds ?? '?'} index builds, ${run.frameUploads ?? '?'} frame uploads\n`);
      }
    } finally {
      pool.close();
      await Promise.allSettled(terminations);
      globalThis.gc?.();
    }
  }
}
console.log(JSON.stringify(report, null, 2));
