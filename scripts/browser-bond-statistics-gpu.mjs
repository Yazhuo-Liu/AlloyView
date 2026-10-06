import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// Real WGSL and the CPU worker implementation are compared here. Software
// adapters verify scientific parity; their timings do not establish GPU speed.
const report = await withWebGpuBrowser(async ({ evaluate, adapter }) => {
  const rows = await evaluate(`(${runBondStatisticsChecks.toString()})()`, { timeoutMs: 360_000 });
  return { adapter, softwareValidation: useSoftwareAdapter(true), rows };
}, { software: useSoftwareAdapter(true) });
console.log(JSON.stringify(report, null, 2));

async function runBondStatisticsChecks() {
  const [{ AnalysisPool }, { crystalFrame }, { createCell, fractionalToCartesian }, { calculateBondStatistics }] = await Promise.all([
    import('./src/analysis/analysis-pool.js'), import('./tests/helpers/crystals.js'), import('./src/data/model.js'), import('./src/analysis/bond-statistics.js'),
  ]);
  const cpu = new AnalysisPool(), gpu = new AnalysisPool();
  cpu.setGpuEnabled(false); gpu.setGpuEnabled(true);
  const rows = [], check = (condition, message) => { if (!condition) throw new Error(message); };
  const compare = (actual, expected, tolerance, name) => {
    check(actual.length === expected.length, name + ' lengths differ');
    let maximumError = 0;
    for (let index = 0; index < actual.length; index++) {
      if (Number.isNaN(actual[index]) && Number.isNaN(expected[index])) continue;
      const error = Math.abs(actual[index] - expected[index]); maximumError = Math.max(maximumError, error);
      check(Number.isFinite(error) && error <= tolerance,
        name + ' differs at ' + index + ': GPU ' + actual[index] + ', CPU ' + expected[index]);
    }
    return maximumError;
  };
  const run = async (label, frame, options, { requireGpu = true } = {}) => {
    const before = frame.fractional.slice(), parameters = { kind: 'bondStatistics', ...options };
    const expected = options.startAtom !== undefined || options.endAtom !== undefined
      ? calculateBondStatistics(frame, parameters) : await cpu.analyze(frame, parameters), progress = [];
    const actual = await gpu.analyze(frame, parameters, { onProgress: update => progress.push(update) });
    check(!requireGpu || actual.backend === 'gpu', label + ': silently fell back ' + actual.fallbackReason);
    if (!requireGpu) check(actual.backend === 'cpu' && actual.fallbackReason, label + ': requires explicit CPU fallback');
    compare(frame.fractional, before, 0, label + ' source coordinates');
    compare(actual.coordination, expected.coordination, 0, label + ' coordination');
    compare(actual.lengthCounts, expected.lengthCounts, 0, label + ' length shell counts');
    compare(actual.angleCounts, expected.angleCounts, 0, label + ' angle shell counts');
    const errors = { q4: compare(actual.q4, expected.q4, 5e-5, label + ' Q4'),
      q6: compare(actual.q6, expected.q6, 5e-5, label + ' Q6') };
    for (const name of ['lengthDistribution', 'angleDistribution']) {
      for (const field of ['edges', 'centers', 'probability', 'density']) compare(actual[name][field], expected[name][field], 1e-12, label + ' ' + name + ' ' + field);
      check(actual[name].total === expected[name].total, label + ' ' + name + ' total');
    }
    for (const name of ['length', 'angle', 'q4', 'q6']) {
      const first = actual.statistics[name], second = expected.statistics[name];
      check(first.count === second.count, label + ' ' + name + ' sample count');
      for (const field of ['min', 'max', 'mean', 'stddev']) {
        if (Number.isNaN(first[field]) && Number.isNaN(second[field])) continue;
        check(Math.abs(first[field] - second[field]) < (name === 'angle' ? 5e-4 : 5e-5),
          label + ' ' + name + ' ' + field + ' differs: ' + first[field] + ' vs ' + second[field]);
      }
    }
    check(progress.some(update => update.phase === 'analyzing' && update.completedAtoms > 0), label + ': missing progress');
    rows.push({ label, atoms: frame.fractional.length / 3, backend: actual.backend, engine: actual.engine,
      errors, gpuCorrectionAtoms: actual.gpuCorrectionAtoms ?? 0, correctedPairs: actual.correctedPairs ?? 0,
      inputReused: actual.inputReused ?? null, gpuInputReused: actual.gpuInputReused ?? null,
      fallbackReason: actual.fallbackReason ?? null });
    return actual;
  };
  try {
    const fcc = crystalFrame('fcc', 4, 3.52);
    await run('FCC first shell', fcc, { cutoff: 2.8, lengthBins: 47, angleBins: 180 });
    const reused = await run('FCC resident buffers reused with new bins', fcc, { cutoff: 2.8, lengthBins: 70, angleBins: 127 });
    check(reused.inputReused && reused.gpuInputReused, 'Repeated analysis must reuse uploaded frame and device');
    await run('Primitive FCC repeated periodic images', crystalFrame('fcc', 1, 3.52), { cutoff: 2.8 });
    await run('Primitive SC self images', crystalFrame('sc', 1, 2), { cutoff: 2.1 });
    await run('BCC first two shells', crystalFrame('bcc', 3, 2.86), { cutoff: 3.1, lengthBins: 80, angleBins: 180 });
    await run('Triclinic HCP', crystalFrame('hcp', 3, 2.5), { cutoff: 2.7, lengthBins: 41, angleBins: 73 });
    const distorted = crystalFrame('fcc', 2, 3.52);
    distorted.cell = createCell({ vectors: [7.04, .17, -.09, .4, 7.12, .15, -.11, .04, 6.96], triclinic: true });
    distorted.fractional[0] += .009; distorted.fractional[5] -= .007;
    distorted.positions = fractionalToCartesian(distorted.fractional, distorted.cell);
    await run('Skew distorted crystal', distorted, { cutoff: 3.05, lengthBins: 110, angleBins: 360 });
    const mixed = crystalFrame('fcc', 2, 3.52);
    mixed.cell = createCell({ vectors: mixed.cell.vectors, pbc: [true, false, true] });
    for (let atom = 0; atom < mixed.types.length; atom++) {
      mixed.types[atom] = atom % 2; mixed.fractional[atom * 3] += atom % 3 - 1;
    }
    await run('Mixed PBC wrapped coordinates and pair overrides', mixed, { cutoff: 3.6,
      pairCutoffs: [{ first: 0, second: 0, cutoff: 0 }, { first: 0, second: 1, cutoff: 2.8 }], lengthBins: 90, angleBins: 180 });
    await run('Central-atom output range', fcc, { cutoff: 2.8, startAtom: 5, endAtom: 17 });
    const boundary = { fractional: Float64Array.from([.1, .1, .1, .2, .1, .1, .35, .1, .1]),
      ids: Uint32Array.from([1, 2, 3]), types: new Uint16Array(3),
      cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
    await run('Exact cutoff membership', boundary, { cutoff: 1, lengthBins: 100, angleBins: 180 });
    await run('Exact length shell boundaries', boundary, { cutoff: 2, lengthBins: 4, angleBins: 180 });
    const empty = { ...boundary, fractional: Float64Array.from([.1, .1, .1, .5, .5, .5]), ids: Uint32Array.from([1, 2]), types: new Uint16Array(2) };
    await run('Isolated atoms have NaN orientational order', empty, { cutoff: .1 });
    await run('Dense GPU neighborhood uses complete CPU fallback', crystalFrame('sc', 1, 1), { cutoff: 3.5 }, { requireGpu: false });
    const outside = crystalFrame('fcc', 2, 3.52);
    outside.cell = createCell({ vectors: outside.cell.vectors, pbc: [false, true, true] }); outside.fractional[0] = -.1;
    await run('Unsupported GPU coordinates use CPU fallback', outside, { cutoff: 2.8 }, { requireGpu: false });
    // Other fixture frames may evict the original FCC upload. Prime the frame
    // again, then both queued requests must retain that resident allocation.
    await gpu.analyze(fcc, { kind: 'bondStatistics', cutoff: 2.8 });
    const queued = await Promise.all([gpu.analyze(fcc, { kind: 'bondStatistics', cutoff: 2.8 }), gpu.analyze(fcc, { kind: 'cna' })]);
    check(queued.every(result => result.backend === 'gpu' && result.inputReused && result.gpuInputReused),
      'Queued bond statistics and CNA must reuse the existing GPU worker/device/input uploads');
    check(queued[1].structures.every(value => value === 1), 'Queued CNA must still recognize FCC');
    rows.push({ label: 'Queued CNA shares bond-statistics GPU worker and frame', backend: queued[1].backend,
      engine: queued[1].engine, inputReused: queued[1].inputReused, gpuInputReused: queued[1].gpuInputReused });
  } finally { cpu.close(); gpu.close(); }
  return rows;
}
