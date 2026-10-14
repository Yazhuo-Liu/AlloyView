import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { availableParallelism } from 'node:os';
import { GrainSegmentationClient } from '../src/grains-client.js';
import { CpuBudget } from '../src/analysis/cpu-budget.js';
import { calculatePtm } from '../src/analysis/ptm.js';
import { crystalFrame } from '../tests/helpers/crystals.js';

// End-to-end, warm JavaScript clustering only: PTM is prepared once outside
// timing. Each measured request rebuilds its model, so reuse cannot hide work.
// Workers, module imports and compilation warmup stay alive across all runs.
const repeats = Number(process.argv[2] ?? 30), samples = Number(process.argv[3] ?? 3);
const workerLimit = Number(process.argv[4] ?? Math.max(1, availableParallelism() - 2));
const forceSmall = process.argv[5] === '--force-small';
if (!Number.isInteger(repeats) || repeats < 4 || repeats > 40 || !Number.isInteger(samples) || samples < 1 || samples > 9
  || !Number.isInteger(workerLimit) || workerLimit < 1 || workerLimit > 32) {
  throw new Error('Usage: node scripts/benchmark-grain-pipeline.mjs [cell repeats 4–40] [samples 1–9] [CPU worker limit] [--force-small]');
}
const frame = crystalFrame('fcc', repeats, 3.52);
const ptm = await calculatePtm(frame, { flags: 1, neighborLists: true });
// Four spatial grains with symmetry-distinct rotations. Geometry and template
// neighbor graph are from real PTM; orientations are synthetic and disclosed.
for (let atom = 0; atom < ptm.structures.length; atom++) {
  const angle = Math.floor(frame.fractional[atom * 3] * 4) * 15 * Math.PI / 180;
  ptm.orientations[atom * 4] = Math.cos(angle / 2);
  ptm.orientations[atom * 4 + 1] = 0;
  ptm.orientations[atom * 4 + 2] = 0;
  ptm.orientations[atom * 4 + 3] = Math.sin(angle / 2);
}
const input = { ptm, fractional: frame.fractional, cell: frame.cell };
const created = [];
function factory(path) {
  return () => {
    const worker = new Worker(new URL(path, import.meta.url)); created.push(worker);
    return {
      addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
      postMessage(data, transfer) { worker.postMessage(data, transfer); },
      terminate() { void worker.terminate(); },
    };
  };
}
function client(limit, shared = false) {
  return new GrainSegmentationClient({
    cpuBudget: new CpuBudget({ environment: { navigator: { hardwareConcurrency: limit + 2 } } }),
    createWorker: factory('../tests/helpers/node-grains-worker.mjs'),
    createStageWorker: factory('../tests/helpers/node-grains-stage-worker.mjs'),
    environment: { crossOriginIsolated: shared },
  });
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const clients = [client(1), client(workerLimit), client(workerLimit, true)];
// Diagnostic admission for measuring messaging overhead below the application
// threshold. This never changes production scheduling or its memory bounds.
if (forceSmall) for (const backend of clients.slice(1)) {
  const admittedDegree = backend.stages.degree.bind(backend.stages);
  backend.stages.degree = (count, limit) => admittedDegree(Math.max(count, 65536), limit);
}
const names = ['serial', 'parallel-private', 'parallel-shared'];
const timings = Object.fromEntries(names.map(name => [name, []]));
let oracle;
try {
  for (let index = 0; index < clients.length; index++) {
    clients[index].warm(frame.ids.length);
    await clients[index].stages.warming?.promise;
    const result = await clients[index].segment(input);
    oracle ??= result;
    for (const key of ['grainId', 'sizes', 'orientations', 'structureTypes', 'rootStructureTypes', 'plot', 'mergeThreshold']) {
      assert.deepEqual(result[key], oracle[key], `${names[index]} ${key}`);
    }
  }
  for (let sample = 0; sample < samples; sample++) {
    const order = sample % 2 ? [2, 1, 0] : [0, 1, 2];
    for (const index of order) {
      const backend = clients[index]; backend.release();
      const startedAt = performance.now(), result = await backend.segment(input), wallMs = performance.now() - startedAt;
      assert.deepEqual(result.grainId, oracle.grainId);
      timings[names[index]].push({ wallMs, modelMs: result.modelMs, workerCount: result.workerCount });
    }
  }
  console.log(JSON.stringify({
    fixture: 'Ideal FCC geometry with four synthetic 15-degree orientation slabs; real PTM neighbor graph',
    atoms: frame.ids.length, samples, cpuWorkerLimit: workerLimit, hostAvailableParallelism: availableParallelism(),
    forceSmallParallelAdmission: forceSmall, grains: oracle.grainCount,
    excludes: ['PTM fitting', 'first Worker/module startup', 'rendering', 'GPU'],
    includes: ['private/shared stage snapshot preparation', 'Worker communication', 'stable graph merge and regression', 'orphan adoption and final readback'],
    timings, medianWallMs: Object.fromEntries(names.map(name => [name, median(timings[name].map(sample => sample.wallMs))])),
  }, null, 2));
} finally {
  clients.forEach(backend => backend.dispose());
  await Promise.all(created.map(worker => worker.terminate()));
}
