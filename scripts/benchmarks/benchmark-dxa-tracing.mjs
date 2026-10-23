import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dxaCartesianCoordinates } from '../../src/analysis/dxa.js';
import { parseCfg } from '../../src/io/cfg.js';
import { parseLammpsFrame } from '../../src/io/lammps-dump.js';
import { replicateFrame } from '../../src/data/replicate.js';

// Retain both real Wasm heaps and alternate complete extractions. Serial
// Delaunay in both versions holds its pre-existing parallel tie choices fixed.
const root = resolve(import.meta.dirname, '../..');
const options = { '--baseline-ref': 'adb0648', '--dataset': 'all', '--repetitions': '3', '--kernel': 'both', '--output': '' };
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(Object.hasOwn(options, process.argv[i]) && process.argv[i + 1], 'Use --baseline-ref HEX --dataset all|hea|fe|nigb --repetitions 1..10 --kernel serial|threaded|both [--output FILE]');
  options[process.argv[i]] = process.argv[i + 1];
}
assert.match(options['--baseline-ref'], /^[a-f\d]{7,40}$/i);
assert.ok(['all', 'hea', 'fe', 'nigb'].includes(options['--dataset']));
assert.ok(['serial', 'threaded', 'both'].includes(options['--kernel']));
const repetitions = Number(options['--repetitions']);
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
const baseline = execFileSync('git', ['rev-parse', '--verify', `${options['--baseline-ref']}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
const directory = await mkdtemp(join(tmpdir(), 'alloyview-dxa-tracing-'));
const hash = value => createHash('sha256').update(value).digest('hex');
const median = values => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const cpuModel = (await readFile('/proc/cpuinfo', 'utf8').catch(() => '')).match(/^model name\s*:\s*(.+)$/m)?.[1] ?? 'unknown';
const cpuQuota = (await readFile('/sys/fs/cgroup/cpu.max', 'utf8').catch(() => 'unknown')).trim();
const report = { complete: false, generatedAt: new Date().toISOString(), baseline, runtime: process.version, cpuModel,
  logicalCpus: availableParallelism(), cpuQuota, repetitions,
  protocol: 'One warmup per retained module. Alternate baseline/current complete extractions. All stages use one thread to keep Delaunay geometry identical. Hash the complete native scientific result including every label, cluster, point, junction and Burgers vector; omit only parallel-work diagnostics. Times exclude startup and input upload.', kernels: [] };
const fixtures = [['hea', 'hea-fcc-screw.dump', parseLammpsFrame, 1], ['fe', 'Fe_disloc_loop.dump', parseLammpsFrame, 3],
  ['nigb', 'NiGB_minimized.cfg', parseCfg, 1]].filter(([name]) => options['--dataset'] === 'all' || name === options['--dataset']);
const frames = [];
for (const [name, file, parse, lattice] of fixtures) {
  let frame = parse(await readFile(join(root, 'examples', file), 'utf8'), file);
  if (name === 'nigb') frame = await replicateFrame(frame, [1, 1, 2]);
  frames.push({ name, frame, lattice });
}
try {
  for (const mode of ['serial', 'threaded'].filter(mode => options['--kernel'] === 'both' || mode === options['--kernel'])) {
    const basename = `dxa-kernel${mode === 'threaded' ? '-threaded' : ''}`;
    const artifacts = { baseline: {}, current: {} }, states = [];
    for (const extension of ['mjs', 'wasm']) {
      const filename = `${basename}.${extension}`;
      const bytes = execFileSync('git', ['show', `${baseline}:src/analysis/${filename}`], { cwd: root, maxBuffer: 32 * 1024 ** 2 });
      await writeFile(join(directory, filename), bytes);
      artifacts.baseline[filename] = hash(bytes);
      artifacts.current[filename] = hash(await readFile(join(root, 'src/analysis', filename)));
    }
    for (const version of ['baseline', 'current']) {
      const location = version === 'baseline' ? directory : join(root, 'src/analysis');
      const factory = (await import(pathToFileURL(join(location, `${basename}.mjs`)))).default;
      const state = { version, kernel: null, stages: [], phase: null, last: 0 };
      state.kernel = await factory({ wasmBinary: await readFile(join(location, `${basename}.wasm`)), dxaPoolSize: 0,
        onDxaProgress(phase) {
          const now = performance.now();
          if (state.phase) state.stages.push({ phase: state.phase, ms: now - state.last });
          state.phase = phase; state.last = now;
        } });
      states.push(state);
    }
    const kernelReport = { mode, artifacts, datasets: [] }; report.kernels.push(kernelReport);
    try {
      for (const { name, frame, lattice } of frames) {
        const xyz = dxaCartesianCoordinates(frame), pbc = frame.cell.pbc.reduce((mask, value, axis) => mask | (value ? 1 << axis : 0), 0);
        const prepared = states.map(state => {
          const kernel = state.kernel, positions = kernel._malloc(xyz.byteLength), cell = kernel._malloc(96);
          assert.ok(positions && cell); kernel.HEAPF64.set(xyz, positions / 8);
          kernel.HEAPF64.set(frame.cell.vectors, cell / 8); kernel.HEAPF64.set(frame.cell.origin, cell / 8 + 9);
          return { state, positions, cell };
        });
        const entry = { fixture: name, atoms: xyz.length / 3, runs: [] }; kernelReport.datasets.push(entry);
        let reference;
        const run = ({ state, positions, cell }, warmup) => {
          const kernel = state.kernel;
          state.phase = null; state.stages = []; kernel._alloy_dxa_reset_cancel(); kernel._alloy_dxa_set_threads(1);
          const started = performance.now();
          const pointer = kernel._alloy_dxa_analyze(positions, xyz.length / 3, cell, pbc, lattice, 14, 9, 0, 1, 2.5);
          const elapsedMs = performance.now() - started;
          assert.ok(pointer, kernel.UTF8ToString(kernel._alloy_dxa_last_error()));
          state.stages.push({ phase: state.phase, ms: performance.now() - state.last });
          const raw = JSON.parse(kernel.UTF8ToString(pointer)); delete raw.parallelEdgePasses;
          const scienceSha256 = hash(JSON.stringify(raw)); reference ??= scienceSha256;
          assert.equal(scienceSha256, reference, `${name}/${mode}/${state.version}: complete scientific output must match`);
          const tracingMs = state.stages.find(stage => stage.phase === 'Trace Burgers circuits and dislocation lines').ms;
          kernel._alloy_dxa_dispose();
          if (!warmup) {
            entry.runs.push({ version: state.version, elapsedMs, tracingMs, scienceSha256, stages: state.stages });
            console.error(`${name}/${mode} ${state.version}: trace ${tracingMs.toFixed(2)} ms, total ${elapsedMs.toFixed(2)} ms`);
          }
        };
        try {
          for (const state of prepared) run(state, true);
          for (let repeat = 0; repeat < repetitions; repeat++) for (const state of repeat % 2 ? prepared.toReversed() : prepared) run(state, false);
          entry.summary = Object.fromEntries(states.map(({ version }) => [version, Object.fromEntries(['elapsedMs', 'tracingMs']
            .map(key => [key, median(entry.runs.filter(run => run.version === version).map(run => run[key]))]))]));
          if (options['--output']) await writeFile(resolve(root, options['--output']), `${JSON.stringify(report, null, 2)}\n`);
        } finally {
          for (const { state, positions, cell } of prepared) { state.kernel._free(positions); state.kernel._free(cell); }
        }
      }
    } finally { for (const { kernel } of states) kernel.PThread?.terminateAllThreads(); }
  }
  report.complete = true;
  if (options['--output']) await writeFile(resolve(root, options['--output']), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
