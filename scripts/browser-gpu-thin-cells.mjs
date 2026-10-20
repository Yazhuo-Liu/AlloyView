import { writeFile } from 'node:fs/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// Exercise the real kernels directly: an occupancy refusal cannot disappear
// behind AnalysisPool's correct CPU fallback. SwiftShader is a correctness
// target, never evidence of physical GPU acceleration.
const report = await withWebGpuBrowser(async ({ evaluate, adapter }) => {
  await evaluate(`globalThis.thinCellChecks = (${checks.toString()})(${process.argv.includes('--expect-legacy')}); undefined`);
  const stages = [];
  try {
    for (let index = 0; index < 20; index++) {
      const started = performance.now();
      const step = await evaluate('globalThis.thinCellChecks.next()', { timeoutMs: 300_000 });
      if (step.done) return { adapter, physicalGpuPerformanceMeasured: false,
        timingScope: 'Diagnostic wall times, including direct runtime upload, dispatch, readback and bounded exact corrections; no speedup claim.',
        ...step.value, stages };
      stages.push({ label: step.value, elapsedMs: performance.now() - started });
      console.error(`Thin cells: ${step.value}`);
    }
    throw new Error('Thin-cell validation exceeded its bounded stage count.');
  } finally {
    await evaluate('globalThis.closeThinCellChecks?.(); undefined', { timeoutMs: 10_000 });
  }
}, { software: useSoftwareAdapter(true) });
const output = process.argv.find(value => value.startsWith('--output='))?.slice(9);
if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));

async function* checks(legacy) {
  const [runtimeModule, { parseCfg }, { replicateFrame }, { crystalFrame }, model,
    gpuCna, cpuCna, gpuCsp, cpuCsp, gpuRdf, cpuRdf, gpuVoronoi, cpuVoronoi, comparisons] = await Promise.all([
    import('./src/analysis/gpu/runtime.js'), import('./src/io/cfg.js'), import('./src/data/replicate.js'),
    import('./tests/helpers/crystals.js'), import('./src/data/model.js'),
    import('./src/analysis/gpu/cna.js'), import('./src/analysis/cna.js'),
    import('./src/analysis/gpu/centrosymmetry.js'), import('./src/analysis/centrosymmetry.js'),
    import('./src/analysis/gpu/rdf.js'), import('./src/analysis/rdf.js'),
    import('./src/analysis/gpu/voronoi.js'), import('./src/analysis/voronoi.js'), import('./scripts/gpu-comparison.js'),
  ]);
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  let runtime = new runtimeModule.GpuRuntime();
  // The million-atom input plus analysis reserve exceeds the intentionally
  // small default software-adapter budget. Isolate occupancy policy with an
  // explicit validation budget; production still applies its adapter budget.
  runtime.configureCache({ budgetBytes: 512 * 1024 ** 2 });
  globalThis.closeThinCellChecks = () => runtime.close();
  const rows = [], indices = [], observed = new WeakSet();
  const instrument = () => {
    if (legacy) return;
    const prepare = runtime.prepareNeighbors.bind(runtime);
    runtime.prepareNeighbors = async (frame, cutoff, options) => {
      const context = await prepare(frame, cutoff, options);
      if (!observed.has(context)) {
        observed.add(context);
        const dimensions = context.dimensions, bins = new Uint32Array(dimensions.reduce((a, b) => a * b, 1));
        let peak = 0;
        for (let atom = 0; atom < frame.types.length; atom++) {
          const location = [0, 1, 2].map(axis => {
            let value = frame.fractional[atom * 3 + axis];
            if (frame.cell.pbc[axis]) value -= Math.floor(value);
            value = Math.fround(value);
            return Math.min(dimensions[axis] - 1, Math.floor(Math.max(0, Math.min(1, value)) * dimensions[axis]));
          });
          const bin = (location[0] * dimensions[1] + location[1]) * dimensions[2] + location[2];
          peak = Math.max(peak, ++bins[bin]);
        }
        const queryRadius = Math.sqrt(Math.fround(Math.fround(cutoff * cutoff) + context.distanceTolerance));
        const imageBudget = context.faceHeights.reduce((product, height, axis) => product
          * (frame.cell.pbc[axis] ? 2 * Math.ceil(queryRadius / height) + 3 : 1), 1);
        const stencilBins = dimensions.reduce((product, dimension) => product * Math.min(3, dimension), 1);
        const legacyLimit = Math.max(32, Math.floor(50_000 / stencilBins / imageBudget));
        check(context.neighborDispatch.maximumOccupancy === peak, 'GPU peak occupancy differs from independent bin membership.');
        indices.push({ label: frame.validationLabel, atoms: frame.types.length, cutoff, dimensions, peakOccupancy: peak,
          legacyOccupancyLimit: legacyLimit, legacyWouldRefuse: peak > legacyLimit,
          neighborDispatch: context.neighborDispatch });
      }
      return context;
    };
  };
  instrument();
  const compare = (actual, expected, field, tolerance = 0) => comparisons.compareGpuArrays(actual[field], expected[field], tolerance, field);
  try {
    const response = await fetch('./examples/NiGB_minimized.cfg');
    check(response.ok, 'Actual Ni grain-boundary fixture unavailable.');
    const original = parseCfg(await response.text(), 'NiGB_minimized.cfg');
    const ni = await replicateFrame(original, [2, 2, 2]);
    ni.validationLabel = 'Actual NiGB 2×2×2';
    ni.gpuFrameId = 1001;
    check(ni.types.length === 1_039_232 && Math.abs(ni.cell.vectors[8] - 9.95546) < 1e-8, 'Actual replicated source changed.');
    const radius = gpuCna.adaptiveCnaInitialRadius(ni), started = performance.now();
    if (legacy) {
      await runtime.prepareNeighbors(ni, radius);
      let refusal;
      try { await runtime.prepareNeighbors(ni, radius * 1.6); } catch (error) { refusal = error; }
      check(refusal?.name === 'GpuUnavailableError' && /densely occupied/.test(refusal.message),
        'The archived runtime must refuse the real expanded NiGB neighbor radius.');
      return { legacy: true, atoms: ni.types.length, initialRadius: radius, refusedRadius: radius * 1.6,
        refusal: refusal.message, explicitValidationBudgetBytes: runtime.budgetBytes };
    }
    await runtime.prepareNeighbors(ni, radius);
    rows.push({ label: 'Actual NiGB complete resident neighbor index', atoms: ni.types.length,
      gpuWallMs: performance.now() - started, radius, explicitValidationBudgetBytes: runtime.budgetBytes });
    yield 'full 1,039,232-atom NiGB index remains on GPU';

    // Full input and complete neighbor sets, with bounded central-atom ranges
    // across both source and replicated images. This avoids disguising a crop
    // as a validation of the million-atom structure.
    for (const startAtom of [0, 519_616]) {
      const range = { startAtom, endAtom: startAtom + 64 };
      let expected = cpuCna.calculateCna(ni, { mode: 'adaptive', ...range });
      let begin = performance.now();
      let actual = await gpuCna.analyzeGpuCna(runtime, ni, { mode: 'adaptive', ...range });
      rows.push({ label: 'Actual NiGB adaptive CNA', atoms: ni.types.length, ...range,
        gpuWallMs: performance.now() - begin, comparison: compare(actual, expected, 'structures'),
        correctedAtoms: actual.gpuCorrectionAtoms, radiusAttempts: actual.gpuRadiusAttempts });
      check(actual.gpuRadiusAttempts > 1 && indices.some(index => index.label === ni.validationLabel && index.legacyWouldRefuse),
        'NiGB adaptive expansion must reproduce the former occupancy refusal.');
      yield `NiGB adaptive CNA central atoms ${range.startAtom}–${range.endAtom}`;
      expected = cpuCsp.calculateCentrosymmetry(ni, { mode: 'manual', neighbors: 14, ...range });
      begin = performance.now();
      actual = await gpuCsp.analyzeGpuCentrosymmetry(runtime, ni, { mode: 'manual', neighbors: 14, ...range });
      rows.push({ label: 'Actual NiGB central symmetry', atoms: ni.types.length, ...range,
        neighbors: 14, gpuWallMs: performance.now() - begin, comparison: comparisons.compareGpuCentrosymmetry(actual, expected, 2e-6),
        correctedAtoms: actual.gpuCorrectionAtoms, radiusAttempts: actual.gpuRadiusAttempts });
      yield `NiGB central symmetry central atoms ${range.startAtom}–${range.endAtom}`;
    }
    runtime.close(); runtime = new runtimeModule.GpuRuntime(); instrument();

    const thin = await replicateFrame(crystalFrame('fcc', 3, 3.52), [4, 4, 1]);
    thin.validationLabel = 'Thin FCC RDF at half-face radius'; thin.gpuFrameId = 1002;
    const rdfParameters = { cutoff: thin.cell.vectors[8] / 2, bins: 67 };
    const rdfExpected = cpuRdf.calculateRdf(thin, rdfParameters), rdfStarted = performance.now();
    const rdfActual = await gpuRdf.analyzeGpuRdf(runtime, thin, rdfParameters);
    check(indices.at(-1).legacyWouldRefuse, 'Half-face RDF must reproduce the former long-bin occupancy refusal.');
    rows.push({ label: thin.validationLabel, atoms: thin.types.length, gpuWallMs: performance.now() - rdfStarted,
      counts: compare(rdfActual, rdfExpected, 'counts'), values: compare(rdfActual, rdfExpected, 'values', 1e-8),
      correctedPairs: rdfActual.correctedPairs });
    yield 'full thin-cell RDF preserves exact counts and unique periodic pairs';

    const slab = crystalFrame('fcc', 8, 3.52), width = slab.cell.vectors[0];
    slab.cell = model.createCell({ vectors: [width, 0, 0, 0, width, 0, 0, 0, 4 * width], pbc: [true, true, false] });
    for (let index = 2; index < slab.fractional.length; index += 3) slab.fractional[index] = .5 + (slab.fractional[index] - .5) / 4;
    slab.positions = model.fractionalToCartesian(slab.fractional, slab.cell);
    slab.validationLabel = 'Open vacuum slab'; slab.gpuFrameId = 1003;
    const slabRadius = gpuVoronoi.voronoiGpuInitialRadius(gpuVoronoi.prepareGpuVoronoi(slab));
    await runtime.prepareNeighbors(slab, slabRadius);
    check(indices.at(-1).legacyWouldRefuse, 'Vacuum slab must reproduce the former initial-radius occupancy refusal.');
    const parameters = { startAtom: 0, endAtom: 16 };
    const voronoiExpected = await cpuVoronoi.calculateVoronoi(slab, parameters), voronoiStarted = performance.now();
    const voronoiActual = await gpuVoronoi.analyzeGpuVoronoi(runtime, slab, parameters);
    const fields = Object.fromEntries(['atomicVolume', 'voronoiSurfaceArea', 'voronoiCoordination',
      'voronoiBoundaryFaces', 'voronoiMaxFaceOrder', 'faceOffsets'].map(field => [field,
      compare(voronoiActual, voronoiExpected, field, ['atomicVolume', 'voronoiSurfaceArea'].includes(field) ? 5e-3 : 0)]));
    check(JSON.stringify(voronoiActual.voronoiIndices) === JSON.stringify(voronoiExpected.voronoiIndices), 'Vacuum slab Voronoi topology differs.');
    const faces = (result, atom) => Array.from({ length: result.faceOffsets[atom + 1] - result.faceOffsets[atom] }, (_, index) => {
      const face = result.faceOffsets[atom] + index;
      return { neighbor: result.faceNeighbors[face], order: result.faceOrders[face], area: result.faceAreas[face],
        boundary: result.faceBoundary[face], accepted: result.faceAccepted[face] };
    }).sort((a, b) => a.neighbor - b.neighbor || a.order - b.order || a.area - b.area);
    for (let atom = 0; atom < parameters.endAtom; atom++) {
      const actual = faces(voronoiActual, atom), expected = faces(voronoiExpected, atom);
      check(actual.length === expected.length, 'Vacuum slab face count differs.');
      for (let face = 0; face < actual.length; face++) {
        for (const field of ['neighbor', 'order', 'boundary', 'accepted']) check(actual[face][field] === expected[face][field],
          `Vacuum slab ${field} differs at atom ${atom}, face ${face}.`);
        check(Math.abs(actual[face].area - expected[face].area) <= 8e-5 * Math.max(1, expected[face].area), 'Vacuum slab face area differs.');
      }
    }
    rows.push({ label: slab.validationLabel, atoms: slab.types.length, ...parameters,
      gpuWallMs: performance.now() - voronoiStarted, fields,
      correctedAtoms: voronoiActual.gpuCorrectionAtoms, correctionReasons: voronoiActual.gpuCorrectionReasons });
    yield 'vacuum-slab Voronoi surface cells retain CPU topology and geometry';

    const maximum = runtimeModule.GPU_MAX_BIN_OCCUPANCY;
    const dense = { fractional: new Float64Array(maximum * 3), types: new Uint16Array(maximum),
      cell: model.createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }),
      gpuFrameId: 1004, validationLabel: 'Maximum admitted single-bin occupancy' };
    for (let atom = 0; atom < maximum; atom++) dense.fractional.set([.05 + atom / maximum * .01, .05, .05], atom * 3);
    const context = await runtime.prepareNeighbors(dense, 2);
    const [heads, next] = await runtime.readMany([{ buffer: context.headsBuffer, Type: Int32Array,
      length: context.dimensions.reduce((a, b) => a * b, 1) }, { buffer: context.nextBuffer, Type: Int32Array, length: maximum }]);
    const occupied = [...heads].filter(head => head >= 0);
    check(occupied.length === 1 && occupied[0] === maximum - 1, 'Dense-bin canonical head differs.');
    for (let atom = maximum - 1; atom >= 0; atom--) check(next[atom] === atom - 1, 'Dense-bin merge sort lost or reordered an atom.');
    const refused = { ...dense, fractional: new Float64Array((maximum + 1) * 3), types: new Uint16Array(maximum + 1), gpuFrameId: 1005 };
    refused.fractional.set(dense.fractional); refused.fractional.set([.05, .05, .05], maximum * 3);
    let refusal;
    try { await runtime.prepareNeighbors(refused, 2); } catch (error) { refusal = error; }
    check(refusal?.name === 'GpuUnavailableError', 'Over-limit single-bin occupancy must retain CPU fallback.');
    rows.push({ label: dense.validationLabel, atoms: maximum, canonicalSortedLinks: maximum, refusedAtoms: maximum + 1,
      refusal: refusal.message });
    yield 'maximum admitted bin sorts exactly; next occupancy safely refuses';
    return { rows, indices, scope: 'Full million-atom NiGB neighbor indexing; 128 NiGB central atoms for CNA/CSP (14 neighbors) with all neighbors; full 1,728-atom thin RDF; 16 vacuum-slab Voronoi centers with all 2,048 sites; canonical links at maximum bin occupancy and safe refusal above it.' };
  } finally { runtime.close(); }
}
