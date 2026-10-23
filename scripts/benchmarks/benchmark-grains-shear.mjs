import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { crystalFrame } from '../../tests/helpers/crystals.js';
import { GRAIN_FIXTURES, loadGrainFixture, ovitoGrainInput } from '../../tests/helpers/grain-fixtures.js';
import { calculatePtm } from '../../src/analysis/ptm.js';
import { NeighborSearch } from '../../src/analysis/neighbors.js';
import { createCell } from '../../src/data/model.js';

// Baseline is an external, read-only checkout. All result comparisons happen
// outside timing; measured pairs alternate order after independent warmups.
const baseline = resolve(process.argv[2] ?? '/tmp/alloyview-perf-baseline-adb0648');
const repeat = Number(process.argv[3] ?? 20), samples = Number(process.argv[4] ?? 5);
const workerLimit = Number(process.argv[5] ?? 4), mode = process.argv[6] ?? 'all';
const sharedMemory = process.argv[7] === 'shared';
if (!Number.isInteger(repeat) || repeat < 6 || repeat > 40 || !Number.isInteger(samples) || samples < 1 || samples > 15
  || !Number.isInteger(workerLimit) || workerLimit < 1 || workerLimit > 12 || !['all', 'grains', 'shear'].includes(mode)) {
  throw new Error('Usage: node scripts/benchmarks/benchmark-grains-shear.mjs BASELINE [repeats 6–40] [samples 1–15] [Workers 1–12] [all|grains|shear] [shared]');
}
const current = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const moduleAt = (root, relative) => import(pathToFileURL(join(root, relative)));
const roots = [baseline, current], names = ['baseline', 'current'];
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const output = { baseline, repeat, samples, warmupRuns: 3, workerLimit, sharedMemory, results: [] };

if (mode !== 'shear') {
  const modules = await Promise.all(roots.map(root => moduleAt(root, 'src/analysis/grains.js')));
  output.defectModelComparisons = [];
  for (const name of ['bicrystal', 'twinFault']) {
    const fixture = await loadGrainFixture(name), input = ovitoGrainInput(fixture, GRAIN_FIXTURES[name]());
    for (const algorithm of ['automatic', 'mst']) {
      const parameters = { algorithm, includeRegression: true };
      const models = modules.map(module => module.buildGrainDendrogram(input, parameters));
      assert.deepEqual(models[1], models[0], `${name}/${algorithm}: complete defect model`);
      assert.deepEqual(modules[1].segmentGrains(models[1], parameters), modules[0].segmentGrains(models[0], parameters));
      output.defectModelComparisons.push({ fixture: name, algorithm, atoms: input.structures.length, exact: true });
    }
  }
  const frame = crystalFrame('fcc', repeat, 3.52), ptm = await calculatePtm(frame, { flags: 1, neighborLists: true });
  // Real PTM geometry and neighbors; synthetic four-slab orientations keep
  // grain boundaries controlled while exercising the serial merge graph.
  for (let atom = 0; atom < ptm.structures.length; atom++) {
    const angle = Math.floor(frame.fractional[atom * 3] * 4) * 15 * Math.PI / 180;
    ptm.orientations.set([Math.cos(angle / 2), 0, 0, Math.sin(angle / 2)], atom * 4);
  }
  const input = { ...ptm, fractional: frame.fractional, cell: frame.cell };
  for (const algorithm of ['automatic', 'mst']) {
    const parameters = { algorithm, includeRegression: true }, times = [[], []];
    const warm = modules.map(module => module.buildGrainDendrogram(input, parameters));
    assert.deepEqual(warm[1], warm[0], `${algorithm}: entire model`);
    const expected = modules[0].segmentGrains(warm[0], parameters);
    assert.deepEqual(modules[1].segmentGrains(warm[1], parameters), expected, `${algorithm}: segmentation`);
    for (let run = 1; run < output.warmupRuns; run++) for (let i = 0; i < modules.length; i++) {
      const model = modules[i].buildGrainDendrogram(input, parameters);
      assert.deepEqual(model, warm[0]); assert.deepEqual(modules[i].segmentGrains(model, parameters), expected);
    }
    for (let sample = 0; sample < samples; sample++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
      const stages = {}, started = performance.now();
      const model = modules[index].buildGrainDendrogram(input, { ...parameters, onProgress(stage) { stages[stage] ??= performance.now(); } });
      const done = performance.now(), result = modules[index].segmentGrains(model, parameters), ended = performance.now();
      times[index].push({ modelMs: done - started, mergeMs: stages.threshold - stages.merging,
        thresholdMs: done - stages.threshold, totalMs: ended - started });
      assert.deepEqual(model, warm[0], `${algorithm}: measured entire model`);
      assert.deepEqual(result, expected, `${algorithm}: measured segmentation`);
    }
    const medians = Object.fromEntries(names.map((name, i) => [name,
      Object.fromEntries(['modelMs', 'mergeMs', 'thresholdMs', 'totalMs'].map(field => [field, median(times[i].map(row => row[field]))]))]));
    const result = { kind: `grains-${algorithm}`, atoms: frame.types.length, bonds: warm[0].bonds.count,
      merges: warm[0].dendrogram.count, exactEntireModels: true, exactEntireSegmentations: true, medians,
      samples: Object.fromEntries(names.map((name, i) => [name, times[i]])) };
    {
      // Count removed traversals/finds in untimed instrumented copies.
      // Production code and the timed modules above contain no counters.
      const directory = await mkdtemp(join(tmpdir(), 'alloyview-grain-count-'));
      try {
        result.operationCounts = {};
        for (let i = 0; i < roots.length; i++) {
          const sourcePath = join(roots[i], 'src/analysis/grains.js'), source = await readFile(sourcePath, 'utf8');
          const clear = 'for (let half = this.head[a]; half !== NONE; half = next[half]) mark[opposite[half]] = NONE;';
          if (i === 0) assert.ok(source.includes(clear), 'baseline graph clear loop for instrumentation');
          assert.ok(source.includes('find(index) {'), 'union–find method for instrumentation');
          const instrumented = source.replace(clear, 'for (let half = this.head[a]; half !== NONE; half = next[half]) { clearVisits++; mark[opposite[half]] = NONE; }')
            .replace('find(index) {', 'find(index) { findCalls++;')
            .replace(/from '([^']+)'/g, (_, specifier) => `from '${new URL(specifier, pathToFileURL(sourcePath)).href}'`)
            + '\nexport let clearVisits = 0, findCalls = 0;\n';
          const filename = join(directory, `count-${i}.mjs`); await writeFile(filename, instrumented);
          const counted = await import(pathToFileURL(filename));
          assert.deepEqual(counted.buildGrainDendrogram(input, parameters), warm[0]);
          result.operationCounts[names[i]] = { adjacencyClearVisits: counted.clearVisits, findCalls: counted.findCalls };
          if (i === 1) result.addedStampBytes = algorithm === 'automatic' && source.includes('markGeneration')
            ? frame.types.length * Uint32Array.BYTES_PER_ELEMENT : 0;
        }
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
    output.results.push(result);
  }
}

function mixedFrame(repeats, fccFraction = 1 / 3, pilotTrap = false) {
  const coordinates = [], fcc = [[0, 0, 0], [0, .5, .5], [.5, 0, .5], [.5, .5, 0]], bcc = [[0, 0, 0], [.5, .5, .5]];
  for (let x = 0; x < repeats; x++) for (let y = 0; y < repeats; y++) for (let z = 0; z < repeats; z++) {
    for (const site of x < repeats * fccFraction ? fcc : bcc) coordinates.push((x + site[0]) / repeats, (y + site[1]) / repeats, (z + site[2]) / repeats);
  }
  const fractional = Float64Array.from(coordinates), count = fractional.length / 3;
  const frame = { fractional, cell: createCell({ vectors: [4 * repeats, 0, 0, 0, 4 * repeats, 0, 0, 0, 4 * repeats] }), types: new Uint16Array(count) };
  if (pilotTrap) {
    const selected = [];
    // Interior FCC rows have twelve neighbors. Reorder only atom identities
    // so every deterministic pilot row is FCC while the bulk remains BCC.
    for (let atom = 0; atom < count && selected.length < 64; atom++) if (fractional[atom * 3] > 1 / repeats
      && fractional[atom * 3] < fccFraction - 1 / repeats) selected.push(atom);
    assert.equal(selected.length, 64, 'fixture needs 64 interior FCC rows');
    const used = new Set(selected), rest = Array.from({ length: count }, (_, i) => i).filter(i => !used.has(i));
    const pilotRows = new Map(selected.map((atom, i) => [Math.floor(i * count / 64), atom]));
    const reordered = new Float64Array(fractional.length); let offset = 0;
    for (let atom = 0; atom < count; atom++) { const source = pilotRows.get(atom) ?? rest[offset++]; reordered.set(fractional.subarray(source * 3, source * 3 + 3), atom * 3); }
    frame.fractional = reordered;
  }
  return frame;
}
const scientificFields = ['localShear', 'coordination', 'coordinationMode', 'normalization', 'meanMetric', 'averageCoordination', 'averageShear'];
function identicalShear(actual, expected) {
  for (const field of scientificFields) {
    if (typeof expected[field] === 'number') assert.ok(Object.is(actual[field], expected[field]), field);
    else { assert.equal(actual[field].length, expected[field].length, field);
      for (let i = 0; i < expected[field].length; i++) assert.ok(Object.is(actual[field][i], expected[field][i]), `${field}[${i}]`); }
  }
}
if (mode !== 'grains') {
  const modules = await Promise.all(roots.map(root => moduleAt(root, 'src/analysis/analysis-pool.js')));
  const direct = await Promise.all(roots.map(root => moduleAt(root, 'src/analysis/local-shear.js')));
  const fixtures = [ ['fcc', crystalFrame('fcc', repeat), 3], ['bcc', crystalFrame('bcc', repeat), 3.5],
    ['mixed', mixedFrame(repeat), 3.6], ['pilot-mismatch', mixedFrame(Math.max(18, repeat), 1 / 6, true), 3.6] ];
  for (const [fixture, frame, cutoff] of fixtures) {
    const created = [], parameters = { kind: 'localShear', cutoff, subtractMean: true };
    const pools = modules.map((module, i) => new module.AnalysisPool({ environment: {
      navigator: { hardwareConcurrency: workerLimit + 2 }, crossOriginIsolated: sharedMemory }, workerFactory: () => {
      const worker = new Worker(pathToFileURL(join(roots[i], 'tests/helpers/node-analysis-worker.mjs'))); created.push(worker);
      return { addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
        postMessage(data, transfers) { worker.postMessage(data, transfers); }, terminate() { void worker.terminate(); } };
    } }));
    try {
      // Prepare Workers/indexes without learning a global coordination mode.
      // Record the first real request separately from repeated immutable-frame
      // calculations so a cold fallback is not hidden by the verified cache.
      for (const pool of pools) await pool.analyzeCPU(frame, { kind: 'localShearMetrics', cutoff, coordinationMode: 0 });
      const firstStart = performance.now(), expected = await pools[0].analyze(frame, parameters), firstBaselineMs = performance.now() - firstStart;
      const secondStart = performance.now(), warm = await pools[1].analyze(frame, parameters), firstCurrentMs = performance.now() - secondStart;
      identicalShear(warm, expected);
      for (let run = 1; run < output.warmupRuns; run++) for (const pool of pools) identicalShear(await pool.analyze(frame, parameters), expected);
      const times = [[], []]; let measuredFusedMetrics;
      for (let sample = 0; sample < samples; sample++) for (const i of sample % 2 ? [1, 0] : [0, 1]) {
        const started = performance.now(), actual = await pools[i].analyze(frame, parameters), elapsed = performance.now() - started;
        identicalShear(actual, expected);
        if (i === 1) measuredFusedMetrics = actual.fusedMetrics;
        times[i].push(elapsed);
      }
      let freshSnapshots;
      if (fixture === 'mixed' || fixture === 'pilot-mismatch') {
        const freshTimes = [[], []], fused = [];
        for (let sample = 0; sample < 3; sample++) {
          const next = { ...frame, fractional: frame.fractional.slice(), geometryRevision: sample + 1 };
          // Snapshot reuse compares coordinate values, not array identities.
          // Change a real coordinate to model a new trajectory frame after JIT
          // warmup, without changing the fixture's coordination populations.
          next.fractional[0] += (sample + 1) * 1e-8;
          const actual = [];
          for (const i of sample % 2 ? [1, 0] : [0, 1]) {
            const started = performance.now();
            actual[i] = await pools[i].analyze(next, parameters);
            freshTimes[i].push(performance.now() - started);
          }
          identicalShear(actual[1], actual[0]);
          assert.equal(actual[1].fusedMetrics, false, 'new mixed snapshot must fully verify its mode');
          fused.push(actual[1].fusedMetrics);
        }
        freshSnapshots = { samples: Object.fromEntries(names.map((name, i) => [name, freshTimes[i]])),
          medianWallMs: Object.fromEntries(names.map((name, i) => [name, median(freshTimes[i])])),
          fusedMetrics: fused, exactAllScientificFields: true };
      }
      const queries = [];
      for (const module of direct) {
        const search = new NeighborSearch(frame), collect = search.collect.bind(search); let count = 0;
        search.collect = (...args) => { count++; return collect(...args); };
        module.calculateLocalShear({ ...frame, neighborSearch: search }, parameters); queries.push(count);
      }
      output.results.push({ kind: `shear-${fixture}`, atoms: frame.types.length, workers: warm.workerCount,
        firstRequestFusedMetrics: warm.fusedMetrics, fusedMetrics: measuredFusedMetrics,
        firstPreparedRequestMs: { baseline: firstBaselineMs, current: firstCurrentMs },
        ...(freshSnapshots ? { freshSnapshots } : {}),
        coordinationMode: warm.coordinationMode, exactAllScientificFields: true,
        directColdNeighborQueries: Object.fromEntries(names.map((name, i) => [name, queries[i]])),
        medianWallMs: Object.fromEntries(names.map((name, i) => [name, median(times[i])])),
        samples: Object.fromEntries(names.map((name, i) => [name, times[i]])) });
    } finally { pools.forEach(pool => pool.close()); await Promise.all(created.map(worker => worker.terminate())); }
  }
}
console.log(JSON.stringify(output, null, 2));
