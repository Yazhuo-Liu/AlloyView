import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as currentDxa from '../src/analysis/dxa.js';
import { replicateFrame } from '../src/data/replicate.js';
import { parseCfg } from '../src/io/cfg.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';

// Compare actual production Wasm pipelines with a read-only Git snapshot.
// Both modules keep their own kernel, growing pool and heap for the entire run.
// Pool startup and one full warm analysis are excluded at each thread count.
const ROOT = resolve(import.meta.dirname, '..');
const USAGE = 'node scripts/benchmark-dxa-compare.mjs [--baseline-ref HEX_COMMIT] '
  + '[--threads 1,2,4] [--dataset all|fe|nigb] [--repetitions 1..10]';

function parseOptions(args) {
  const options = { baselineRef: 'd6f9010', threads: [1, 2, 4], dataset: 'all', repetitions: 3 };
  const names = new Map([['--baseline-ref', 'baselineRef'], ['--threads', 'threads'],
    ['--dataset', 'dataset'], ['--repetitions', 'repetitions']]);
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' || flag === '-h') {
      assert.equal(args.length, 1, 'Use --help without other options.');
      return null;
    }
    assert.ok(names.has(flag), `Unknown option ${flag}. ${USAGE}`);
    assert.ok(!seen.has(flag), `Duplicate option ${flag}.`);
    seen.add(flag);
    const value = args[++index];
    assert.ok(value && !value.startsWith('--'), `Missing value for ${flag}.`);
    options[names.get(flag)] = value;
  }
  assert.match(options.baselineRef, /^[a-f\d]{7,40}$/i, 'Use --baseline-ref with a 7..40-character hexadecimal commit hash.');
  if (typeof options.threads === 'string') {
    assert.match(options.threads, /^\d+(?:,\d+)*$/, 'Use --threads with comma-separated integer counts.');
    options.threads = options.threads.split(',').map(Number);
  }
  assert.ok(options.threads.length && options.threads.every(count => Number.isSafeInteger(count) && count >= 1 && count <= 64),
    'Use --threads with a comma-separated sequence in 1..64.');
  assert.ok(['all', 'fe', 'nigb'].includes(options.dataset), 'Use --dataset all|fe|nigb.');
  options.repetitions = Number(options.repetitions);
  assert.ok(Number.isInteger(options.repetitions) && options.repetitions >= 1 && options.repetitions <= 10,
    'Use --repetitions 1..10.');
  return options;
}

function gitText(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

async function copyBaseline(ref, directory) {
  const commit = gitText(['rev-parse', '--verify', `${ref}^{commit}`]);
  const files = ['dxa.js', 'dxa-kernel.mjs', 'dxa-kernel.wasm',
    'dxa-kernel-threaded.mjs', 'dxa-kernel-threaded.wasm'];
  const filesSha256 = {};
  for (const filename of files) {
    const bytes = execFileSync('git', ['show', `${commit}:src/analysis/${filename}`],
      { cwd: ROOT, maxBuffer: 32 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] });
    filesSha256[filename] = hash(bytes);
    if (filename === 'dxa.js') {
      let source = bytes.toString('utf8');
      for (const [specifier, path] of [['../data/model.js', 'src/data/model.js'], ['./cpu-budget.js', 'src/analysis/cpu-budget.js']]) {
        const original = `'${specifier}'`;
        assert.equal(source.split(original).length - 1, 1, `Expected exactly one baseline import of ${specifier}.`);
        source = source.replace(original, JSON.stringify(pathToFileURL(join(ROOT, path)).href));
      }
      // .mjs makes the temporary wrapper an ES module without adding a package
      // or worktree. Relative kernel imports and Wasm URLs still use this dir.
      await writeFile(join(directory, 'dxa.mjs'), source);
    } else await writeFile(join(directory, filename), bytes);
  }
  return { commit, filesSha256, api: await import(pathToFileURL(join(directory, 'dxa.mjs')).href) };
}

function networkSignature(result) {
  const topology = result.segments.map(segment => ({ id: segment.id, family: segment.familyId,
    structureType: segment.structureType, closed: segment.closed, isInfinite: segment.isInfinite,
    pointCount: segment.points.length / 3, length: segment.length,
    burgersVector: segment.burgersVector, spatialBurgersVector: segment.spatialBurgersVector,
    burgersMagnitude: Math.hypot(...segment.burgersVector),
    spatialBurgersMagnitude: Math.hypot(...segment.spatialBurgersVector), junctions: segment.junctions }));
  // Coordinates are hashed, never printed; exact hashes can legitimately vary
  // with parallel Delaunay tie handling while the physical network agrees.
  const exactNetworkHash = hash(JSON.stringify(result.segments.map((segment, index) => ({
    ...topology[index], points: Array.from(segment.points),
  }))));
  return { atomLabelHash: hash(result.atomStructureTypes), structureCounts: result.structureCounts,
    segments: result.segments.length, totalLength: result.totalLength, families: result.counts,
    exactNetworkHash, topology };
}

function validateSignature(signature, result, entry, reference) {
  assert.ok(Number.isFinite(signature.totalLength) && signature.totalLength >= 0);
  if (reference) {
    assert.equal(signature.atomLabelHash, reference.atomLabelHash, 'Every atom label must agree between versions and thread counts.');
    assert.deepEqual(signature.structureCounts, reference.structureCounts);
    assert.deepEqual(signature.families, reference.families);
  }
  if (entry.id === 'fe') {
    assert.equal(signature.segments, 1, 'The Fe test must retain its single dislocation loop.');
    const segment = signature.topology[0];
    assert.equal(segment.family, 'half111');
    assert.equal(segment.structureType, 3);
    assert.equal(segment.closed, true);
    assert.equal(segment.isInfinite, false);
    assert.ok(Math.abs(segment.burgersMagnitude - Math.sqrt(3) / 2) < 1e-10,
      'The Fe loop must retain the dimensionless 1/2 <111> Burgers vector.');
    assert.ok(segment.spatialBurgersMagnitude > 2 && segment.spatialBurgersMagnitude < 3,
      'The spatial Burgers vector must remain in the physical Fe lattice scale (Å).');
    assert.ok(signature.totalLength > 100 && signature.totalLength < 108);
    assert.deepEqual(segment.junctions,
      [[{ segmentId: segment.id, end: 1 }], [{ segmentId: segment.id, end: 0 }]]);
    const points = result.segments[0].points;
    assert.ok(Math.hypot(points[0] - points.at(-3), points[1] - points.at(-2), points[2] - points.at(-1)) < 1e-6,
      'The finite Fe loop must close within the native coordinate tolerance.');
  } else {
    assert.equal(signature.segments, 0, 'The real replicated NiGB reference has no dislocation lines.');
    assert.equal(signature.totalLength, 0);
  }
}

function createBackend(name, api) {
  let generation;
  let cancelPointer;
  let previousBuffer;
  let bufferObjectChanges = 0;
  let initialBytes;
  let maximumBytes = 0;
  let finalBytes = 0;
  let analyses = 0;
  function onControl(control) {
    if (!control) return;
    assert.ok(control.cancelBuffer instanceof SharedArrayBuffer, `${name} must retain a shared Wasm heap.`);
    if (cancelPointer === undefined) cancelPointer = control.cancelPointer;
    else assert.equal(control.cancelPointer, cancelPointer, `${name} cancellation address must remain stable.`);
    if (previousBuffer && previousBuffer !== control.cancelBuffer) bufferObjectChanges++;
    previousBuffer = control.cancelBuffer;
  }
  function recordKernel(metadata) {
    if (generation === undefined) generation = metadata.kernelGeneration;
    else assert.equal(metadata.kernelGeneration, generation, `${name} must reuse its kernel across analyses.`);
    assert.ok(metadata.sharedMemory, `${name} must use its shared-memory production kernel: ${metadata.threadingFallback ?? 'no shared memory'}`);
    initialBytes ??= metadata.wasmMemoryBytes;
    maximumBytes = Math.max(maximumBytes, metadata.wasmMemoryBytes);
    finalBytes = metadata.wasmMemoryBytes;
    assert.equal(finalBytes, maximumBytes, `${name} must retain its allocated heap when changing concurrency.`);
  }
  return {
    name,
    api,
    async warmup(frame, workerCount) {
      const started = performance.now();
      const metadata = await api.warmupDxa({ atomCount: frame.ids.length, workerCount, onControl });
      recordKernel(metadata);
      assert.equal(metadata.workerCount, api.dxaWorkerCount(frame.ids.length, workerCount), metadata.threadingFallback);
      return { elapsedMs: performance.now() - started, ...metadata };
    },
    async analyze(frame, lattice, workerCount) {
      const started = performance.now();
      const result = await api.calculateDxa(frame, { lattice }, { workerCount, onControl });
      const wholeElapsedMs = performance.now() - started;
      recordKernel(result);
      analyses++;
      assert.equal(result.workerCount, api.dxaWorkerCount(frame.ids.length, workerCount), result.threadingFallback);
      assert.equal(result.backend, 'cpu');
      const nativeStageMs = result.stageTimings.reduce((sum, stage) => sum + stage.elapsedMs, 0);
      return { result, timing: { workerCount: result.workerCount, wholeElapsedMs, elapsedMs: result.elapsedMs, nativeStageMs,
        nativeWorkerCount: result.nativeWorkerCount, cpuOffloadUsed: result.cpuOffloadUsed,
        cpuStageWorkerCounts: result.cpuStageWorkerCounts, cpuStageTimings: result.cpuStageTimings,
        cpuStageFallbacks: result.cpuStageFallbacks,
        otherPipelineMs: wholeElapsedMs - nativeStageMs, stageTimings: result.stageTimings,
        kernelGeneration: result.kernelGeneration, poolSize: result.poolSize, wasmMemoryBytes: result.wasmMemoryBytes,
        rssMiB: process.memoryUsage().rss / 1024 ** 2 } };
    },
    retention() {
      return { kernelGeneration: generation, analyses, initialBytes, maximumBytes, finalBytes,
        stableCancelPointer: cancelPointer, bufferObjectChanges, kernelReused: true,
        heapRetainedAcrossConcurrencyChanges: true,
        note: 'SharedArrayBuffer objects may change when the same persistent Wasm memory grows.' };
    },
  };
}

function summarize(runs) {
  const version = name => {
    const selected = runs.filter(run => run.version === name);
    const phases = [...new Set(selected.flatMap(run => run.stageTimings.map(stage => stage.phase)))];
    return { wholeMedianMs: median(selected.map(run => run.wholeElapsedMs)),
      wholeMinimumMs: Math.min(...selected.map(run => run.wholeElapsedMs)),
      wholeMaximumMs: Math.max(...selected.map(run => run.wholeElapsedMs)),
      nativeStageMedianMs: median(selected.map(run => run.nativeStageMs)),
      otherPipelineMedianMs: median(selected.map(run => run.otherPipelineMs)),
      stages: phases.map(phase => ({ phase, medianMs: median(selected.flatMap(run => run.stageTimings
        .filter(stage => stage.phase === phase).map(stage => stage.elapsedMs))) })) };
  };
  const baseline = version('baseline'), current = version('current');
  return { baseline, current, speedup: baseline.wholeMedianMs / current.wholeMedianMs,
    improvementPercent: 100 * (1 - current.wholeMedianMs / baseline.wholeMedianMs),
    stageComparison: baseline.stages.map(stage => {
      const after = current.stages.find(candidate => candidate.phase === stage.phase);
      return { phase: stage.phase, baselineMedianMs: stage.medianMs, currentMedianMs: after?.medianMs,
        improvementPercent: after && 100 * (1 - after.medianMs / stage.medianMs) };
    }) };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (!options) { console.log(USAGE); return; }
  const directory = await mkdtemp(join(tmpdir(), 'alloyview-dxa-compare-'));
  let baseline;
  try {
    baseline = await copyBaseline(options.baselineRef, directory);
    const backends = [createBackend('baseline', baseline.api), createBackend('current', currentDxa)];
    const filesSha256 = {};
    for (const filename of Object.keys(baseline.filesSha256)) {
      filesSha256[filename] = hash(await readFile(join(ROOT, 'src/analysis', filename)));
    }
    const report = { runtime: `Node ${process.version}`, availableParallelism: availableParallelism(),
      backend: 'CPU Wasm pthreads', threads: options.threads, repetitions: options.repetitions,
      timingProtocol: 'One untimed analysis per version and thread count; alternating baseline/current measured order.',
      comparisonRules: 'Exact atom labels and serial total lengths; up to 1% parallel length variation from existing Delaunay ties.',
      baseline: { commit: baseline.commit, filesSha256: baseline.filesSha256 },
      current: { commit: gitText(['rev-parse', 'HEAD']), workingTreeStatus: gitText(['status', '--short']), filesSha256 },
      datasets: [] };
    const datasets = [
      { id: 'fe', filename: 'Fe_disloc_loop.dump', parse: parseLammpsFrame, replication: [1, 1, 1], lattice: 'bcc' },
      { id: 'nigb', filename: 'NiGB_minimized.cfg', parse: parseCfg, replication: [1, 1, 2], lattice: 'fcc' },
    ].filter(entry => options.dataset === 'all' || entry.id === options.dataset);
    for (const entry of datasets) {
      const source = entry.parse(await readFile(join(ROOT, 'examples', entry.filename), 'utf8'), entry.filename);
      const frame = entry.replication.every(value => value === 1) ? source : await replicateFrame(source, entry.replication);
      const row = { dataset: entry.id, filename: entry.filename, sourceAtoms: source.ids.length,
        realReplication: entry.replication, atoms: frame.ids.length, comparisons: [] };
      report.datasets.push(row);
      let scientificReference;
      let serialLength;
      function check(signature, result, workerCount) {
        validateSignature(signature, result, entry, scientificReference);
        scientificReference ??= signature;
        if (workerCount === 1) {
          serialLength ??= signature.totalLength;
          assert.equal(signature.totalLength, serialLength, 'Serial total length must agree exactly between versions and repeats.');
        } else assert.ok(Math.abs(signature.totalLength - scientificReference.totalLength)
          <= Math.max(1e-10, scientificReference.totalLength * 0.01), 'Parallel total length must stay within 1% of the reference.');
      }
      for (const workerCount of options.threads) {
        const comparison = { requestedThreads: workerCount,
          workerCount: currentDxa.dxaWorkerCount(frame.ids.length, workerCount), warmups: [], runs: [] };
        row.comparisons.push(comparison);
        for (const backend of backends) {
          const initialization = await backend.warmup(frame, workerCount);
          const { result, timing } = await backend.analyze(frame, entry.lattice, workerCount);
          const signature = networkSignature(result);
          check(signature, result, workerCount);
          comparison.warmups.push({ version: backend.name, initialization,
            untimedAnalysisMs: timing.wholeElapsedMs, signature });
        }
        for (let repetition = 0; repetition < options.repetitions; repetition++) {
          const order = repetition % 2 ? [...backends].reverse() : backends;
          const pair = [];
          for (const [orderIndex, backend] of order.entries()) {
            const { result, timing } = await backend.analyze(frame, entry.lattice, workerCount);
            const signature = networkSignature(result);
            check(signature, result, workerCount);
            pair.push(signature);
            comparison.runs.push({ version: backend.name, repetition, orderIndex, ...timing, signature });
            process.stderr.write(`${entry.id} ${timing.workerCount} threads ${backend.name} run ${repetition + 1}: `
              + `${timing.wholeElapsedMs.toFixed(1)} ms; ${signature.segments} segments, length ${signature.totalLength.toFixed(5)}\n`);
          }
          assert.equal(pair[0].atomLabelHash, pair[1].atomLabelHash);
          if (workerCount === 1) assert.equal(pair[0].totalLength, pair[1].totalLength);
          else assert.ok(Math.abs(pair[0].totalLength - pair[1].totalLength)
            <= Math.max(1e-10, pair[0].totalLength * 0.01), 'Paired parallel lengths must agree within 1%.');
        }
        comparison.summary = summarize(comparison.runs);
      }
    }
    report.retainedKernels = Object.fromEntries(backends.map(backend => [backend.name, backend.retention()]));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    const cleanup = await Promise.allSettled([currentDxa.releaseDxaKernels(), baseline?.api.releaseDxaKernels()]);
    await rm(directory, { recursive: true, force: true });
    const failed = cleanup.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

main().catch(error => {
  process.stderr.write(`DXA comparison failed: ${error.message}\n`);
  process.exitCode = 1;
});
