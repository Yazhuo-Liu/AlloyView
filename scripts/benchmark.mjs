import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { calculateCoordination } from '../src/analysis/coordination.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';

const repetitions = process.env.ALLOYVIEW_BENCH_MILLION === '1' ? 63 : 29;
const expectedAtoms = repetitions ** 3 * 4;
const startedGeneration = performance.now();
const dump = makeFccDump(repetitions, 4.05);
const generationMs = performance.now() - startedGeneration;

const startedParse = performance.now();
const frame = parseLammpsFrame(dump, `fcc-${expectedAtoms}.dump`);
const parseMs = performance.now() - startedParse;
const analysis = calculateCoordination(frame, 3.0);
const histogram = {};
for (const count of analysis.coordination) histogram[count] = (histogram[count] ?? 0) + 1;

console.log(JSON.stringify({
  runtime: `Node ${process.version}`,
  platform: `${process.platform} ${process.arch}`,
  atoms: frame.ids.length,
  textMiB: dump.length / 1024 / 1024,
  drawMethod: 'not measured (Node benchmark has no browser graphics context)',
  generationMs,
  parseMs,
  coordinationMs: analysis.elapsedMs,
  candidatePairs: analysis.candidatePairs,
  bins: analysis.bins,
  coordinationHistogram: histogram,
  rssMiB: process.memoryUsage().rss / 1024 / 1024,
  heapUsedMiB: process.memoryUsage().heapUsed / 1024 / 1024,
}, null, 2));

function makeFccDump(repeat, lattice) {
  const length = repeat * lattice;
  const basis = [[0, 0, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 0.5, 0]];
  const lines = [
    'ITEM: TIMESTEP', '0', 'ITEM: NUMBER OF ATOMS', String(repeat ** 3 * 4),
    'ITEM: BOX BOUNDS pp pp pp', `0 ${length}`, `0 ${length}`, `0 ${length}`,
    'ITEM: ATOMS id type xs ys zs pe',
  ];
  let id = 1;
  for (let i = 0; i < repeat; i += 1) {
    for (let j = 0; j < repeat; j += 1) {
      for (let k = 0; k < repeat; k += 1) {
        for (const [x, y, z] of basis) {
          lines.push(`${id} 1 ${(i + x) / repeat} ${(j + y) / repeat} ${(k + z) / repeat} -3.36`);
          id += 1;
        }
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
