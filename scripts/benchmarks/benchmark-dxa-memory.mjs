import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { resolve } from 'node:path';
import { calculateDxa, estimateDxaMemory, releaseDxaKernels, runDxaKernelTask } from '../../src/analysis/dxa.js';
import { dxaMemoryBudget, DXA_WASM_MEMORY_LIMIT } from '../../src/analysis/dxa-memory.js';
import { parseCfg } from '../../src/io/cfg.js';

// Use --profile in a separate invocation: diagnostic traversals affect timing.
const options = { '--input': 'examples/100_tilt4_twist2.cfg', '--threads': '8', '--lattice': 'fcc' };
let profile = false;
for (let index = 2; index < process.argv.length; index++) {
  const name = process.argv[index];
  if (name === '--profile') { profile = true; continue; }
  assert.ok(Object.hasOwn(options, name) && process.argv[index + 1],
    'Use [--input FILE.cfg] [--threads N] [--lattice fcc|bcc|hcp] [--profile]');
  options[name] = process.argv[++index];
}
const workerCount = Number(options['--threads']);
assert.ok(Number.isSafeInteger(workerCount) && workerCount > 0);
const input = await readFile(resolve(options['--input']));
const frame = parseCfg(input, options['--input']);
const memory = () => ({ rssBytes: process.memoryUsage().rss,
  peakRssBytes: process.resourceUsage().maxRSS * 1024 });
const report = { runtime: process.version, input: options['--input'],
  inputSha256: createHash('sha256').update(input).digest('hex'), atoms: frame.ids.length,
  hostMemoryBytes: totalmem(), memoryBudgetBytes: dxaMemoryBudget(),
  memoryEstimateBytes: estimateDxaMemory(frame.ids.length), wasmMemoryLimitBytes: DXA_WASM_MEMORY_LIMIT,
  requestedWorkers: workerCount, profilingEnabled: profile,
  memoryDefinition: 'Wasm bytes are retained linear-memory capacity, not live allocations. RSS includes Node, input, JS copies and all pthreads; peak RSS is cumulative for this fresh process.',
  afterParsing: memory(), stages: [] };
try {
  if (profile) await runDxaKernelTask({ atomCount: frame.ids.length, workerCount }, module => {
    module.onDxaProfile = diagnostic => {
      assert.equal(diagnostic.overflow, false);
      report.memoryCounters = Object.fromEntries(Object.entries(diagnostic.counters)
        .filter(([key]) => /bytes|capacity|delaunay\.(primaryPoints|ghostPoints|totalPoints|totalCells)|edges\.count|mesh\.interface/i.test(key)));
    };
  });
  const result = await calculateDxa(frame, { lattice: options['--lattice'] }, {
    workerCount, onProgress: ({ phase }) => {
      report.stages.push({ phase, ...memory() });
      process.stderr.write(`${phase}: RSS ${(process.memoryUsage().rss / 1024 ** 2).toFixed(1)} MiB\n`);
    },
  });
  Object.assign(report, { elapsedMs: result.elapsedMs, workerCount: result.workerCount,
    wasmMemoryBytes: result.wasmMemoryBytes, ...memory(), stageTimings: result.stageTimings,
    segments: result.segments.length, totalLength: result.totalLength, structureCounts: result.structureCounts,
    atomLabelSha256: createHash('sha256').update(result.atomStructureTypes).digest('hex') });
  console.log(JSON.stringify(report, null, 2));
} finally { await releaseDxaKernels(); }
