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
import { fccScrewFrame } from '../../tests/helpers/dislocations.js';

const root = resolve(import.meta.dirname, '../..');
const options = { '--baseline-ref': 'ea9245d', '--baseline-dir': '', '--current-dir': '',
  '--dataset': 'all', '--repetitions': '3', '--kernel': 'both', '--threads': '1',
  '--circuit': '14', '--stretch': '9', '--diagnostics': 'yes', '--diagnostics-only': 'no', '--output': '' };
for (let index = 2; index < process.argv.length; index += 2) {
  assert.ok(Object.hasOwn(options, process.argv[index]) && process.argv[index + 1],
    'Use --baseline-ref HEX [--baseline-dir DIR] [--current-dir DIR] --dataset all|hea|fe|nigb|screw --repetitions 1..10 --kernel serial|threaded|both --threads 1..64 --circuit 3..100 --stretch 0..100 --diagnostics yes|no --diagnostics-only yes|no [--output FILE]');
  options[process.argv[index]] = process.argv[index + 1];
}
assert.match(options['--baseline-ref'], /^[a-f\d]{7,40}$/i);
assert.ok(['all', 'hea', 'fe', 'nigb', 'screw'].includes(options['--dataset']));
assert.ok(['serial', 'threaded', 'both'].includes(options['--kernel']));
assert.ok(['yes', 'no'].includes(options['--diagnostics']));
assert.ok(['yes', 'no'].includes(options['--diagnostics-only']));
const repetitions = Number(options['--repetitions']), threads = Number(options['--threads']);
const circuit = Number(options['--circuit']), stretch = Number(options['--stretch']);
const diagnosticsOnly = options['--diagnostics-only'] === 'yes';
assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
assert.ok(Number.isInteger(threads) && threads >= 1 && threads <= 64);
assert.ok(Number.isInteger(circuit) && circuit >= 3 && circuit <= 100);
assert.ok(Number.isInteger(stretch) && stretch >= 0 && stretch <= 100);
assert.ok(!diagnosticsOnly || options['--diagnostics'] === 'yes', 'Diagnostic-only mode requires --diagnostics yes.');
const baseline = execFileSync('git', ['rev-parse', '--verify', `${options['--baseline-ref']}^{commit}`],
  { cwd: root, encoding: 'utf8' }).trim();
const temporary = await mkdtemp(join(tmpdir(), 'alloyview-dxa-k4-'));
const baselineDirectory = options['--baseline-dir'] ? resolve(root, options['--baseline-dir']) : temporary;
const currentDirectory = options['--current-dir'] ? resolve(root, options['--current-dir']) : join(root, 'src/analysis');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => {
  const sorted = values.toSorted((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const cpuModel = (await readFile('/proc/cpuinfo', 'utf8').catch(() => '')).match(/^model name\s*:\s*(.+)$/m)?.[1] ?? 'unknown';
const cpuQuota = (await readFile('/sys/fs/cgroup/cpu.max', 'utf8').catch(() => 'unknown')).trim();
const downstreamPhases = new Set(['Build tessellation edges', 'Assign crystal clusters',
  'Map edges to the ideal lattice', 'Construct crystal interface mesh',
  'Trace Burgers circuits and dislocation lines', 'Connect dislocation junctions',
  'Generate defect mesh', 'Smooth and coarsen dislocation lines', 'Serialize dislocation network', 'DXA complete']);
const report = { complete: false, generatedAt: new Date().toISOString(), baseline,
  command: process.argv.slice(1), runtime: process.version, cpuModel, logicalCpus: availableParallelism(), cpuQuota,
  repetitions: diagnosticsOnly ? 0 : repetitions, warmupsPerModuleAndFixture: diagnosticsOnly ? 0 : 1,
  diagnosticsOnly, parameters: { circuit, stretch }, requestedDownstreamThreads: threads,
  baselineDirectory: options['--baseline-dir'] || 'git archive artifacts',
  currentDirectory, protocol: [
    diagnosticsOnly ? 'Diagnostic-only mode: one extraction per version and fixture; no warmups or formal measurements. Inner diagnostic wall times are not performance comparisons.'
      : 'One warmup per retained module and fixture; alternating baseline/current measured order.',
    'Serial local analysis, clusters and Delaunay in both versions. Threaded kernels use the requested count only from edge construction onward, including mesh classification and preparation.',
    'Complete native extraction includes native graph release; excludes input upload, startup, JSON parsing and hash comparison.',
    'Every complete scientific result (all labels, clusters, points, junctions and Burgers vectors) has an exact SHA-256 match. Only parallel-work counters are omitted.',
    'Module.onDxaProfile is null in every timed run. Optional inner timings/counters come from separate untimed extractions checked against the same scientific hash.',
    'Wasm memory values are retained heap capacities, not live allocation or browser/Worker peak RSS. Diagnostic byte counters describe only named data structures.',
    'This fixed-topology protocol does not measure whole-pipeline multi-threaded Delaunay performance.'
  ], kernels: [] };
const persist = async () => {
  if (options['--output']) await writeFile(resolve(root, options['--output']), `${JSON.stringify(report, null, 2)}\n`);
};
const fixtures = [['hea', 'hea-fcc-screw.dump', parseLammpsFrame, 1], ['fe', 'Fe_disloc_loop.dump', parseLammpsFrame, 3],
  ['nigb', 'NiGB_minimized.cfg', parseCfg, 1]].filter(([name]) => options['--dataset'] === 'all' || name === options['--dataset']);
const frames = [];
for (const [name, filename, parse, lattice] of fixtures) {
  let frame = parse(await readFile(join(root, 'examples', filename), 'utf8'), filename);
  if (name === 'nigb') frame = await replicateFrame(frame, [1, 1, 2]);
  frames.push({ name, frame, lattice });
}
// Keep "all" restricted to the three real fixtures used in prior measurements.
// This separate elongated screw fixture exercises dense interface-face batches.
if (options['--dataset'] === 'screw') {
  const parameters = { nx: 8, ny: 10, nz: 38 };
  frames.push({ name: 'screw', frame: fccScrewFrame(parameters), lattice: 1,
    generatedFixture: { generator: 'fccScrewFrame', parameters,
      scope: 'Elastic FCC screw displacement with free X/Y and periodic Z; not a relaxed dislocation core.' } });
}

try {
  for (const mode of ['serial', 'threaded'].filter(mode => options['--kernel'] === 'both' || mode === options['--kernel'])) {
    const basename = `dxa-kernel${mode === 'threaded' ? '-threaded' : ''}`;
    const downstreamThreads = mode === 'threaded' ? threads : 1;
    const artifacts = { baseline: {}, current: {} }, states = [];
    for (const extension of ['mjs', 'wasm']) {
      const filename = `${basename}.${extension}`;
      if (!options['--baseline-dir']) {
        const bytes = execFileSync('git', ['show', `${baseline}:src/analysis/${filename}`],
          { cwd: root, maxBuffer: 32 * 1024 ** 2 });
        await writeFile(join(baselineDirectory, filename), bytes);
      }
      artifacts.baseline[filename] = hash(await readFile(join(baselineDirectory, filename)));
      artifacts.current[filename] = hash(await readFile(join(currentDirectory, filename)));
    }
    const kernelReport = { mode, downstreamThreads, artifacts, datasets: [] };
    report.kernels.push(kernelReport);
    try {
      for (const [version, directory] of [['baseline', baselineDirectory], ['current', currentDirectory]]) {
        const factory = (await import(pathToFileURL(join(directory, `${basename}.mjs`)))).default;
        const state = { version, kernel: null, stages: [], phase: null, last: 0 };
        state.kernel = await factory({ wasmBinary: await readFile(join(directory, `${basename}.wasm`)),
          dxaPoolSize: downstreamThreads - 1, onDxaProgress(phase) {
            const now = performance.now();
            if (state.phase) state.stages.push({ phase: state.phase, ms: now - state.last });
            state.phase = phase; state.last = now;
            state.kernel._alloy_dxa_set_threads(downstreamPhases.has(phase) ? downstreamThreads : 1);
          } });
        states.push(state);
      }
      for (const { name, frame, lattice, generatedFixture } of frames) {
        const xyz = dxaCartesianCoordinates(frame);
        const pbc = frame.cell.pbc.reduce((mask, value, axis) => mask | (value ? 1 << axis : 0), 0);
        const prepared = states.map(state => {
          const kernel = state.kernel, positions = kernel._malloc(xyz.byteLength), cell = kernel._malloc(96);
          assert.ok(positions && cell);
          kernel.HEAPF64.set(xyz, positions / 8);
          kernel.HEAPF64.set(frame.cell.vectors, cell / 8); kernel.HEAPF64.set(frame.cell.origin, cell / 8 + 9);
          return { state, positions, cell };
        });
        const entry = { fixture: name, atoms: xyz.length / 3, replication: name === 'nigb' ? [1, 1, 2] : [1, 1, 1],
          ...(generatedFixture ? { generatedFixture } : {}), runs: [], diagnostics: {} };
        kernelReport.datasets.push(entry);
        let reference;
        const run = ({ state, positions, cell }, kind) => {
          const kernel = state.kernel;
          let diagnostic = null, callbacks = 0;
          kernel.onDxaProfile = kind === 'diagnostic' ? value => { diagnostic = value; callbacks++; } : null;
          state.phase = null; state.stages = [];
          kernel._alloy_dxa_reset_cancel(); kernel._alloy_dxa_set_threads(1);
          const heapCapacityBytesBefore = kernel.HEAPU8.byteLength;
          try {
            const started = performance.now();
            const pointer = kernel._alloy_dxa_analyze(positions, xyz.length / 3, cell, pbc, lattice, circuit, stretch, 0, 1, 2.5);
            const elapsedMs = performance.now() - started;
            const ended = performance.now();
            if (state.phase) state.stages.push({ phase: state.phase, ms: ended - state.last });
            assert.ok(pointer, kernel.UTF8ToString(kernel._alloy_dxa_last_error()));
            const heapCapacityBytesAfter = kernel.HEAPU8.byteLength;
            const raw = JSON.parse(kernel.UTF8ToString(pointer)); delete raw.parallelEdgePasses;
            const scienceSha256 = hash(JSON.stringify(raw)); reference ??= scienceSha256;
            assert.equal(scienceSha256, reference, `${name}/${mode}/${state.version}/${kind}: complete scientific output must match`);
            if (kind === 'diagnostic') {
              assert.ok(callbacks <= 1, 'A complete extraction emits at most one diagnostic snapshot.');
              if (diagnosticsOnly) assert.equal(callbacks, 1, `${state.version}: diagnostic-only comparison requires instrumented artifacts.`);
              if (diagnostic) assert.equal(diagnostic.overflow, false, 'Diagnostic capacity must retain all recorded phases/counters.');
              entry.diagnostics[state.version] = { available: diagnostic !== null, scienceSha256,
                diagnosticElapsedMs: elapsedMs, heapCapacityBytesBefore, heapCapacityBytesAfter, ...diagnostic };
              console.error(`${name}/${mode}/${downstreamThreads} downstream threads ${state.version}: diagnostic ${diagnostic ? 'captured' : 'unavailable'}`);
            } else if (kind === 'measured') {
              assert.equal(callbacks, 0, 'Timed runs must not enable inner diagnostic clocks.');
              entry.runs.push({ version: state.version, elapsedMs, scienceSha256,
                heapCapacityBytesBefore, heapCapacityBytesAfter, stages: state.stages });
              console.error(`${name}/${mode}/${downstreamThreads} downstream threads ${state.version}: ${elapsedMs.toFixed(2)} ms`);
            }
          } finally { kernel.onDxaProfile = null; kernel._alloy_dxa_dispose(); }
        };
        try {
          if (!diagnosticsOnly) {
            for (const item of prepared) run(item, 'warmup');
            for (let repetition = 0; repetition < repetitions; repetition++)
              for (const item of repetition % 2 ? prepared.toReversed() : prepared) run(item, 'measured');
            entry.summary = Object.fromEntries(states.map(({ version }) => {
              const runs = entry.runs.filter(run => run.version === version);
              const phases = [...new Set(runs.flatMap(run => run.stages.map(stage => stage.phase)))];
              return [version, { elapsedMs: median(runs.map(run => run.elapsedMs)),
                heapCapacityBytes: Math.max(...runs.map(run => run.heapCapacityBytesAfter)),
                stageMediansMs: Object.fromEntries(phases.map(phase => [phase,
                  median(runs.map(run => run.stages.filter(stage => stage.phase === phase).reduce((total, stage) => total + stage.ms, 0)))])) }];
            }));
          }
          if (options['--diagnostics'] === 'yes') for (const item of prepared) run(item, 'diagnostic');
          await persist();
        } finally {
          for (const { state, positions, cell } of prepared) { state.kernel._free(positions); state.kernel._free(cell); }
        }
      }
    } finally { for (const { kernel } of states) kernel.PThread?.terminateAllThreads(); }
  }
  report.complete = true;
  await persist();
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
