import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

const production = process.argv.includes('--production');
const report = await withWebGpuBrowser(async ({ evaluate, call, adapter }) => {
  if (production) {
    const origin = await evaluate('location.origin');
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    const deadline = Date.now() + 30_000;
    while (!await evaluate('document.readyState === "complete" && document.querySelector("[data-tool-button=coordination]")')) {
      if (Date.now() > deadline) throw new Error('Production startup timed out.');
      await delay(25);
    }
    await evaluate(`if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click()`);
  }
  return { adapter, ...await evaluate(`(${run.toString()})(${production})`, { timeoutMs: 360_000 }) };
}, { software: useSoftwareAdapter(true) });
console.log(JSON.stringify(report, null, 2));

async function run(production) {
  const base = production ? new URL('./', document.querySelector('script[type=module][src]').src) : new URL('/AlloyView/src/', location.href);
  const [{ GpuRuntime }, { SORT_NEIGHBORS_SHADER }, { analyzeGpuBonds }, { analyzeGpuBondStatistics },
    { calculateBonds }, { calculateBondStatistics }, { fractionalToCartesian }, { crystalFrame },
    { compareGpuBonds, compareGpuArrays, compareGpuFields, bondVectorTolerance },
    { analyzeGpuReferenceStrain }, { calculateReferenceStrain, REFERENCE_STRAIN_FIELDS },
    { analyzeGpuVoronoi }, { calculateVoronoi }] = await Promise.all([
    import(new URL('analysis/gpu/runtime.js', base)), import(new URL('analysis/gpu/neighbors.js', base)),
    import(new URL('analysis/gpu/bonds.js', base)), import(new URL('analysis/gpu/bond-statistics.js', base)),
    import(new URL('analysis/bonds.js', base)), import(new URL('analysis/bond-statistics.js', base)),
    import(new URL('data/model.js', base)), import('/AlloyView/tests/helpers/crystals.js'), import('/AlloyView/scripts/gpu-comparison.js'),
    import(new URL('analysis/gpu/reference-strain.js', base)), import(new URL('analysis/reference-strain.js', base)),
    import(new URL('analysis/gpu/voronoi.js', base)), import(new URL('analysis/voronoi.js', base)),
  ]);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  let seed = 9;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const shuffled = count => {
    const values = Array.from({ length: count }, (_, i) => i);
    for (let i = count - 1; i > 0; i--) { const j = random() % (i + 1); [values[i], values[j]] = [values[j], values[i]]; }
    return values;
  };
  const readIndex = async (runtime, context) => {
    const bins = context.dimensions.reduce((a, b) => a * b, 1);
    const heads = await runtime.read(context.headsBuffer, Int32Array, bins);
    const next = await runtime.read(context.nextBuffer, Int32Array, context.atomCount);
    const seen = new Uint8Array(context.atomCount);
    let members = 0;
    for (const head of heads) {
      let previous = context.atomCount;
      for (let atom = head; atom >= 0; atom = next[atom]) {
        check(atom < previous && !seen[atom], 'A bin is not in strict descending atom-index order or contains a cycle/duplicate');
        seen[atom] = 1; members++; previous = atom;
      }
    }
    check(members === context.atomCount, 'The index lost atoms');
    return { heads, next };
  };
  // Adversarial lists exercise odd runs, empty/single bins and merge widths
  // on either side of powers of two, independently of atomic scheduling.
  const sortRuntime = new GpuRuntime();
  let listLengths, sortFixtureMs;
  try {
    const context = await sortRuntime.prepareNeighbors(crystalFrame('fcc', 8), 3);
    const bins = context.dimensions.reduce((a, b) => a * b, 1), atoms = context.atomCount;
    listLengths = [0, 1, 2, 3, 7, 8, 9, 31, 32, 33, 127, 128, 129, 255, 256, 257];
    listLengths.push(atoms - listLengths.reduce((a, b) => a + b, 0));
    const heads = new Int32Array(bins).fill(-1), next = new Int32Array(atoms).fill(-1);
    const expectedHeads = heads.slice(), expectedNext = next.slice(), order = shuffled(atoms);
    let offset = 0;
    listLengths.forEach((length, bin) => {
      const members = order.slice(offset, offset += length), sorted = [...members].sort((a, b) => b - a);
      heads[bin] = members[0] ?? -1; expectedHeads[bin] = sorted[0] ?? -1;
      members.forEach((atom, index) => { next[atom] = members[index + 1] ?? -1; });
      sorted.forEach((atom, index) => { expectedNext[atom] = sorted[index + 1] ?? -1; });
    });
    const samples = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      sortRuntime.write(context.headsBuffer, heads); sortRuntime.write(context.nextBuffer, next);
      await sortRuntime.device.queue.onSubmittedWorkDone();
      const started = performance.now();
      await sortRuntime.run(SORT_NEIGHBORS_SHADER, sortRuntime.neighborBindings(context), bins,
        { batchSize: 0, updateRange: false, wait: false });
      await sortRuntime.device.queue.onSubmittedWorkDone();
      samples.push(performance.now() - started);
      const actual = await readIndex(sortRuntime, context);
      compareGpuArrays(actual.heads, expectedHeads, 0, 'Sorted bin heads');
      compareGpuArrays(actual.next, expectedNext, 0, 'Sorted bin membership');
    }
    sortFixtureMs = samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  } finally { sortRuntime.close(); }

  const rows = [];
  for (const distorted of [false, true]) {
    const frame = crystalFrame('fcc', distorted ? 5 : 8), original = frame.fractional.slice();
    const permutation = shuffled(frame.ids.length);
    frame.fractional = Float64Array.from(original, (_, i) => original[permutation[Math.floor(i / 3)] * 3 + i % 3]
      + (distorted ? (random() / 2 ** 32 - .5) * .001 : 0));
    frame.positions = fractionalToCartesian(frame.fractional, frame.cell);
    // Integer-degree bins send the perfect FCC angles through the atomic
    // correction queue, independently testing its deterministic CPU merge.
    const parameters = { cutoff: 3, lengthBins: 47, angleBins: distorted ? 73 : 180 };
    const expectedBonds = calculateBonds(frame, parameters), expectedStats = calculateBondStatistics(frame, parameters);
    const reference = { ...frame, fractional: Float64Array.from(original, (_, i) => original[permutation[Math.floor(i / 3)] * 3 + i % 3]) };
    reference.positions = fractionalToCartesian(reference.fractional, reference.cell);
    const strainParameters = { cutoff: 3, referenceFrame: reference, referenceFractional: reference.fractional,
      referenceCell: reference.cell, referenceMapping: Int32Array.from(frame.ids, (_, i) => i) };
    const expectedStrain = calculateReferenceStrain(frame, strainParameters);
    let baseline, baselineStatistics, maxBondError = 0, maxQ4Error = 0, maxQ6Error = 0, maxStrainError = 0, maxMomentError = 0, correctedPairs = 0;
    const indexBuildMs = [], sortMs = [];
    for (let lifetime = 0; lifetime < 2; lifetime++) {
      const runtime = new GpuRuntime();
      try {
        // Precompile the added index pipeline exactly as startup does, without
        // adding Voronoi work to the general warmup.
        await runtime.warmup();
        const originalRun = runtime.run.bind(runtime);
        runtime.run = async (source, bindings, invocations, options) => {
          if (source !== SORT_NEIGHBORS_SHADER) return originalRun(source, bindings, invocations, options);
          const started = performance.now();
          const value = await originalRun(source, bindings, invocations, options);
          await runtime.device.queue.onSubmittedWorkDone();
          sortMs.push(performance.now() - started);
          return value;
        };
        for (let repeat = 0; repeat < 3; repeat++) {
          runtime.clearIndexes();
          const started = performance.now(), context = await runtime.prepareNeighbors(frame, parameters.cutoff);
          indexBuildMs.push(performance.now() - started);
          const actualIndex = await readIndex(runtime, context), buildCount = runtime.neighborIndexBuildCount;
          const actualBonds = await analyzeGpuBonds(runtime, frame, parameters);
          const actualStats = await analyzeGpuBondStatistics(runtime, frame, parameters);
          check(runtime.neighborIndexBuildCount === buildCount, 'The analyses failed to reuse their resident sorted index');
          maxBondError = Math.max(maxBondError, compareGpuBonds(actualBonds, expectedBonds, bondVectorTolerance(frame)));
          for (const field of ['coordination', 'lengthCounts', 'angleCounts']) compareGpuArrays(actualStats[field], expectedStats[field], 0, field);
          maxQ4Error = Math.max(maxQ4Error, compareGpuArrays(actualStats.q4, expectedStats.q4, 5e-5, 'Q4').maxAbsoluteError);
          maxQ6Error = Math.max(maxQ6Error, compareGpuArrays(actualStats.q6, expectedStats.q6, 5e-5, 'Q6').maxAbsoluteError);
          correctedPairs = Math.max(correctedPairs, actualStats.correctedPairs);
          for (const field of ['length', 'angle', 'q4', 'q6']) {
            const actual = actualStats.statistics[field], expected = expectedStats.statistics[field];
            check(actual.count === expected.count, field + ' moment counts differ');
            maxMomentError = Math.max(maxMomentError, compareGpuArrays(
              ['min', 'max', 'mean', 'stddev'].map(key => actual[key]), ['min', 'max', 'mean', 'stddev'].map(key => expected[key]),
              field === 'angle' ? 5e-4 : 5e-5, field + ' moments').maxAbsoluteError);
          }
          if (!baselineStatistics) baselineStatistics = JSON.stringify(actualStats.statistics);
          else check(JSON.stringify(actualStats.statistics) === baselineStatistics, 'Correction record scheduling changed the aggregate moments');
          const actualStrain = await analyzeGpuReferenceStrain(runtime, frame, strainParameters);
          maxStrainError = Math.max(maxStrainError, compareGpuFields(actualStrain, expectedStrain, REFERENCE_STRAIN_FIELDS, 2e-6).maxAbsoluteError);
          const arrays = { ...actualIndex, indices: actualBonds.indices, shifts: actualBonds.shifts, vectors: actualBonds.vectors,
            q4: actualStats.q4, q6: actualStats.q6,
            ...Object.fromEntries(REFERENCE_STRAIN_FIELDS.map(field => [field, actualStrain[field]])) };
          if (!baseline) baseline = arrays;
          else for (const [field, values] of Object.entries(arrays)) {
            // Byte comparisons also catch differences in the last floating
            // point bits and signed zero across runtime/index lifetimes.
            compareGpuArrays(new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
              new Uint8Array(baseline[field].buffer, baseline[field].byteOffset, baseline[field].byteLength), 0, field + ' reproducibility');
          }
        }
      } finally { runtime.close(); }
    }
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    rows.push({ label: distorted ? 'Shuffled distorted FCC' : 'Shuffled FCC shell ties', atoms: frame.ids.length,
      bonds: expectedBonds.count, exactRepeatedRuns: 6, deviceLifetimes: 2, maxBondError, maxQ4Error, maxQ6Error, maxStrainError,
      correctedPairs, maxMomentError, statisticsReproduced: true,
      warmedIndexBuildMedianMs: median(indexBuildMs), warmedSortMedianMs: median(sortMs) });
  }

  // Voronoi remains explicitly requested. Its clipping order also consumes the
  // index; checking it here does not add Voronoi to automatic startup warmup.
  const voronoiFrame = crystalFrame('fcc', 2), coordinates = voronoiFrame.fractional.slice(), permutation = shuffled(voronoiFrame.ids.length);
  voronoiFrame.fractional = Float64Array.from(coordinates, (_, i) => coordinates[permutation[Math.floor(i / 3)] * 3 + i % 3]);
  voronoiFrame.positions = fractionalToCartesian(voronoiFrame.fractional, voronoiFrame.cell);
  const expectedVoronoi = await calculateVoronoi(voronoiFrame);
  let voronoiBaseline, maxVolumeError = 0, maxSurfaceError = 0;
  for (let lifetime = 0; lifetime < 2; lifetime++) {
    const runtime = new GpuRuntime();
    try {
      await runtime.warmup({ analysisKinds: ['voronoi'] });
      for (let repeat = 0; repeat < 2; repeat++) {
        runtime.clearIndexes();
        const result = await analyzeGpuVoronoi(runtime, voronoiFrame);
        maxVolumeError = Math.max(maxVolumeError, compareGpuArrays(result.atomicVolume, expectedVoronoi.atomicVolume, 5e-5, 'Voronoi volume').maxAbsoluteError);
        maxSurfaceError = Math.max(maxSurfaceError, compareGpuArrays(result.voronoiSurfaceArea, expectedVoronoi.voronoiSurfaceArea, 5e-5, 'Voronoi surface').maxAbsoluteError);
        compareGpuArrays(result.voronoiCoordination, expectedVoronoi.voronoiCoordination, 0, 'Voronoi coordination');
        const arrays = Object.fromEntries(Object.entries(result).filter(([, value]) => ArrayBuffer.isView(value)));
        if (!voronoiBaseline) voronoiBaseline = arrays;
        else for (const [field, values] of Object.entries(arrays)) compareGpuArrays(
          new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
          new Uint8Array(voronoiBaseline[field].buffer, voronoiBaseline[field].byteOffset, voronoiBaseline[field].byteLength), 0, 'Voronoi ' + field + ' reproducibility');
      }
    } finally { runtime.close(); }
  }
  return { production, adversarialListLengths: listLengths, adversarialSortMedianMs: sortFixtureMs, rows,
    explicitVoronoi: { atoms: voronoiFrame.ids.length, exactRepeatedRuns: 4, deviceLifetimes: 2, maxVolumeError, maxSurfaceError },
    timingNote: 'Wall-clock timings include command submission and completion; software adapters do not establish physical GPU performance.' };
}
