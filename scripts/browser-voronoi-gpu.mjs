import assert from 'node:assert/strict';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

const report = await withWebGpuBrowser(async ({ evaluate, adapter }) => {
  const checks = await evaluate(`(${runVoronoiChecks.toString()})()`, { timeoutMs: 360_000 });
  return { adapter, softwareValidation: useSoftwareAdapter(true), ...checks };
}, { software: useSoftwareAdapter(true) });
console.log(JSON.stringify(report, null, 2));
assert.ok(!report.error, report.error);

async function runVoronoiChecks() {
  const [{ AnalysisPool }, { crystalFrame }, { createCell }, { calculateVoronoi }] = await Promise.all([
    import('./src/analysis/analysis-pool.js'), import('./tests/helpers/crystals.js'), import('./src/data/model.js'), import('./src/analysis/voronoi.js'),
  ]);
  const cpu = new AnalysisPool(), gpu = new AnalysisPool(); cpu.setGpuEnabled(false); gpu.setGpuEnabled(true);
  const rows = [], preparations = [], check = (condition, message) => { if (!condition) throw new Error(message); };
  const compare = (actual, expected, tolerance, label) => {
    check(actual.length === expected.length, label + ' array length'); let error = 0;
    for (let index = 0; index < actual.length; index++) {
      if (!Number.isFinite(actual[index]) || !Number.isFinite(expected[index])) {
        check(Object.is(actual[index], expected[index]), label + ' excluded/nonfinite row ' + index); continue;
      }
      error = Math.max(error, Math.abs(actual[index] - expected[index]));
      check(Math.abs(actual[index] - expected[index]) <= tolerance * Math.max(1, Math.abs(expected[index])),
        label + ' atom ' + index + ': GPU ' + actual[index] + ', CPU ' + expected[index]);
    }
    return error;
  };
  const run = async (label, frame, options = {}, { requireGpu = true, allowPrecisionFallback = false } = {}) => {
    const parameters = { kind: 'voronoi', ...options }, source = frame.fractional.slice();
    const expected = options.startAtom !== undefined || options.endAtom !== undefined || options.selectedTypes != null
      ? await calculateVoronoi(frame, parameters) : await cpu.analyze(frame, parameters), progress = [];
    let actual;
    try {
      actual = await (options.startAtom !== undefined || options.endAtom !== undefined
        ? gpu.gpuBackend.analyze(frame, parameters, { onProgress: value => progress.push(value) })
        : gpu.analyze(frame, parameters, { onProgress: value => progress.push(value) }));
    } catch (error) {
      if (!allowPrecisionFallback || error.name !== 'GpuUnavailableError') throw error;
      rows.push({ label, atoms: frame.fractional.length / 3, analyzedAtoms: expected.atomicVolume.length,
        backend: 'explicit CPU fallback', fallbackReason: error.message });
      return null;
    }
    check(requireGpu ? actual.backend === 'gpu' : actual.backend === 'cpu' && actual.fallbackReason,
      label + ': backend ' + actual.backend + ', reason ' + actual.fallbackReason);
    check(actual.tessellation === expected.tessellation && actual.summary.emptyCellCount === expected.summary.emptyCellCount,
      label + ' tessellation kind and empty radical cells');
    compare(frame.fractional, source, 0, label + ' unchanged source');
    const errors = { volume: compare(actual.atomicVolume, expected.atomicVolume, 5e-5, label + ' volume'),
      surface: compare(actual.voronoiSurfaceArea, expected.voronoiSurfaceArea, 5e-5, label + ' surface') };
    for (const field of ['voronoiCoordination', 'voronoiBoundaryFaces', 'voronoiMaxFaceOrder', 'faceOffsets']) {
      compare(actual[field], expected[field], 0, label + ' ' + field);
    }
    for (let atom = 0; atom < actual.voronoiIndices.length; atom++) {
      check(actual.voronoiIndices[atom] === expected.voronoiIndices[atom], label + ' index at ' + atom + ': ' + actual.voronoiIndices[atom] + ' vs ' + expected.voronoiIndices[atom]);
      const faces = result => Array.from({ length: result.faceOffsets[atom + 1] - result.faceOffsets[atom] }, (_, index) => {
        const face = result.faceOffsets[atom] + index; return { neighbor: result.faceNeighbors[face], order: result.faceOrders[face],
          area: result.faceAreas[face], boundary: result.faceBoundary[face], accepted: result.faceAccepted[face] };
      }).sort((a, b) => a.neighbor - b.neighbor || a.order - b.order || a.area - b.area);
      const first = faces(actual), second = faces(expected);
      for (let face = 0; face < first.length; face++) {
        for (const field of ['neighbor', 'order', 'boundary', 'accepted']) check(first[face][field] === second[face][field], label + ' face ' + face + ' atom ' + atom + ' ' + field);
        check(Math.abs(first[face].area - second[face].area) <= 8e-5 * Math.max(1, second[face].area), label + ' face area');
      }
    }
    check(actual.summary.volumeError === null || Math.abs(actual.summary.volumeError) < 5e-5, label + ' volume conservation');
    if (options.selectedTypes != null) {
      check(JSON.stringify(actual.selectedTypes) === JSON.stringify(expected.selectedTypes), label + ' selected type metadata');
      compare(actual.analyzedAtomIndices, expected.analyzedAtomIndices, 0, label + ' original analyzed atom identities');
      check(actual.tessellationAtomCount === expected.tessellationAtomCount && actual.summary.atomCount === expected.summary.atomCount,
        label + ' subset-only population');
      check(actual.coordinationHistogram.reduce((sum, bin) => sum + bin.count, 0) === actual.summary.atomCount,
        label + ' histogram excludes omitted source atoms');
    }
    if (actual.backend === 'gpu') check(progress.some(value => value.phase === 'analyzing' && value.completedAtoms > 0), label + ' incremental progress');
    rows.push({ label, atoms: frame.fractional.length / 3, analyzedAtoms: actual.summary.atomCount, backend: actual.backend, engine: actual.engine, errors,
      cpuMs: expected.elapsedMs, gpuMs: actual.elapsedMs, gpuDispatches: actual.gpuDispatches,
      kernelReused: actual.kernelReused, inputReused: actual.inputReused, gpuInputReused: actual.gpuInputReused,
      correctionAtoms: actual.gpuCorrectionAtoms ?? 0, correctionReasons: actual.gpuCorrectionReasons,
      correctionPrecisionCodes: actual.gpuCorrectionPrecisionCodes, fallbackReason: actual.fallbackReason ?? null });
    return actual;
  };
  try {
    await run('SC self-image cube', crystalFrame('sc', 1, 2));
    // Included types are the tessellation's sites, not a mask applied after a
    // full-source calculation. Checkerboard SC splits into two FCC lattices.
    const binary = crystalFrame('sc', 2, 2); binary.typeLabels = ['Ni', 'Cu'];
    for (let atom = 0; atom < binary.types.length; atom++) {
      binary.types[atom] = Math.round(2 * (binary.fractional[atom * 3] + binary.fractional[atom * 3 + 1] + binary.fractional[atom * 3 + 2])) % 2;
    }
    const nickel = await run('Binary Ni subset genuinely tessellates FCC sites', binary, { selectedTypes: ['Ni'] });
    for (let atom = 0; atom < binary.types.length; atom++) {
      check(binary.types[atom] === 0 ? Math.abs(nickel.atomicVolume[atom] - 16) < 5e-5 && nickel.voronoiCoordination[atom] === 12
        : Number.isNaN(nickel.atomicVolume[atom]) && Number.isNaN(nickel.voronoiCoordination[atom]), 'Subset FCC analytic volume/CN and NaN exclusions');
    }
    check(nickel.faceNeighbors.some(atom => atom > 3) && nickel.faceNeighbors.every(atom => atom < 0 || binary.types[atom] === 0),
      'GPU compact neighbor IDs must map back to original selected source atoms');
    const binaryAll = await run('Switch subset to all restores SC sites', binary);
    check(binaryAll.voronoiCoordination.every(value => value === 6) && binaryAll.atomicVolume.every(value => Math.abs(value - 8) < 5e-5),
      'All-site SC analytic volume/CN');
    const nickelReused = await run('Switch all back to unchanged subset reuses compact GPU input', binary, { selectedTypes: ['Ni'] });
    check(nickelReused.inputReused && nickelReused.gpuInputReused && nickelReused.kernelReused, 'Subset/all caches remain distinct and reusable');
    await run('Binary Cu subset remaps complementary original atom IDs', binary, { selectedTypes: ['Cu'] });
    await run('Selected original center range keeps all included neighbors', binary, { selectedTypes: ['Cu'], startAtom: 2, endAtom: 7 });
    const ternary = { ...binary, fractional: Float64Array.from([...binary.fractional, ...binary.fractional.slice(0, 12)]),
      types: Uint16Array.from([...binary.types, 2, 2, 2, 2]), typeLabels: ['Ni', 'Cu', 'Zn'] };
    const multi = await run('Multiple included elements exclude coincident Zn sites from GPU indices', ternary, { selectedTypes: ['Cu', 'Ni'] });
    check(multi.selectedTypes.join(',') === 'Cu,Ni' && multi.tessellationAtomCount === 8, 'Multi-element selection canonical metadata');
    check(multi.atomicVolume.slice(8).every(Number.isNaN) && multi.faceNeighbors.every(atom => atom < 8), 'Excluded coincident atoms never become neighbors');
    const exactSubset = await run('Subset exact-threshold recovery retains source scattering', binary,
      { selectedTypes: ['Ni'], faceAreaThreshold: 2 * Math.SQRT2 });
    check(exactSubset.gpuCorrectionAtoms > 0, 'Selected exact face threshold must use exact recovery when ambiguous');
    const unknownLabels = { ...binary, typeLabels: ['Type 1', 'Type 2'] };
    await run('Numeric source type labels select GPU sites without inferred elements', unknownLabels, { selectedTypes: ['Type 2'] });
    const fcc = crystalFrame('fcc', 2, 3.52);
    const preparationProgress = [], preparationStarted = performance.now();
    const prepared = await gpu.prepareGpuFrame(fcc,{analysisKinds:['voronoi'],onProgress:value=>preparationProgress.push(value)});
    const preparedFrameId = gpu.gpuBackend.frameIds.get(fcc);
    check(prepared.preparedVoronoiFrameIds.includes(preparedFrameId) && prepared.voronoiWorkspaceAtoms >= fcc.types.length
      && prepared.neighborIndexCount > 0, 'Load-style preparation must retain actual source/index/scratch');
    check(prepared.atomicVolume === undefined && prepared.faceOffsets === undefined,
      'Preparation must not publish scientific results');
    check(preparationProgress.some(value=>value.phase==='warming-kernels'), 'One-cell driver warmup must run before readiness');
    const afterPreparation = await run('Periodic FCC', fcc);
    check(afterPreparation.kernelReused && afterPreparation.inputReused && afterPreparation.gpuInputReused,
      'The first prepared calculation must reuse workspace, source upload and device');
    const afterCalculation = gpu.gpuCacheStatus;
    check(afterCalculation.uploadCount === prepared.uploadCount && afterCalculation.neighborIndexBuildCount === prepared.neighborIndexBuildCount,
      'Prepared FCC first analysis must not upload input or rebuild its complete initial-radius index');
    const repeatedPreparation = await gpu.prepareGpuFrame(fcc,{analysisKinds:['voronoi']});
    check(repeatedPreparation.voronoiKernelWarmupCount === prepared.voronoiKernelWarmupCount
      && repeatedPreparation.uploadCount === prepared.uploadCount, 'Unchanged load preparation must reuse every completed stage');
    preparations.push({label:'Load-style FCC preparation and genuine warmed first-analysis parity',
      elapsedIncludingValidationMs:performance.now()-preparationStarted,neighborIndexBuildCount:prepared.neighborIndexBuildCount,
      voronoiKernelWarmupCount:prepared.voronoiKernelWarmupCount,workspaceAtoms:prepared.voronoiWorkspaceAtoms,
      inputReused:afterPreparation.inputReused,gpuInputReused:afterPreparation.gpuInputReused});
    const reused = await run('FCC device/frame/workspace reused', fcc, { bins: 37 });
    check(reused.kernelReused && reused.inputReused && reused.gpuInputReused, 'GPU resident inputs and convex-cell workspace must be reused');
    await run('Central-atom range retains original face neighbors', fcc, { startAtom: 5, endAtom: 17 });
    await run('Periodic BCC', crystalFrame('bcc', 2, 2.86));
    await run('Triclinic HCP', crystalFrame('hcp', 2, 2.5));
    const distorted = crystalFrame('fcc', 2, 3.52);
    distorted.cell = createCell({ vectors: [7.04, .17, -.09, .4, 7.12, .15, -.11, .04, 6.96], triclinic: true });
    for (let i = 0; i < distorted.fractional.length; i++) distorted.fractional[i] += .013 * Math.sin(i * 1.791);
    await run('Skew distorted crystal complete faces', distorted);
    const mixed = crystalFrame('fcc', 2, 3.52);
    mixed.cell = createCell({ vectors: mixed.cell.vectors, pbc: [true, false, true] });
    await run('Mixed PBC finite boundary faces', mixed);
    const open = { fractional: Float64Array.from([.15, .27, .31, .61, .32, .53, .36, .74, .83, .84, .86, .12]),
      types: new Uint16Array(4), cell: createCell({ vectors: [3, .2, 0, .4, 2.7, .1, .2, .3, 3.1], pbc: [false, false, false] }) };
    await run('Finite skew nonperiodic domain', open);
    await run('Neighbor face threshold', fcc, { faceAreaThreshold: .3, relativeFaceAreaThreshold: .01 });
    await run('Absolute face threshold exact boundary', crystalFrame('sc', 1, 2), { faceAreaThreshold: 4 });
    await run('Relative face threshold exact boundary', crystalFrame('sc', 1, 2), { relativeFaceAreaThreshold: 1 / 6 });
    const thin = { fractional: Float64Array.from([.3, .4, .5]), types: new Uint16Array(1),
      cell: createCell({ vectors: [6, 0, 0, 0, .08, 0, 0, 0, .05] }) };
    await run('Extreme thin orthogonal single-site exact GPU seed', thin);
    const cornerFixture = epsilon => {
      const points = [[5, 5, 5], [7, 5, 5], [3, 5, 5], [5, 7, 5], [5, 3, 5], [5, 5, 7], [5, 5, 3], [7 - epsilon, 7 - epsilon, 7 - epsilon]];
      return { fractional: Float64Array.from(points.flat(), value => value / 10), types: new Uint16Array(8),
        cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
    };
    await run('Exactly tangent plane keeps cubic topology on GPU', cornerFixture(0));
    await run('Resolved small triangular face', cornerFixture(.001));
    const corrected = await run('Tiny genuine face cannot disappear in f32 cleanup', cornerFixture(.000001));
    check(corrected.voronoiCoordination[0] === 7 && corrected.voronoiIndices[0] === '<1,3,3,0>', 'Certified GPU geometry or sparse recovery must retain tiny triangular cap');
    const barelySkew = { fractional: Float64Array.from([.2, .4, .8]), types: new Uint16Array(1),
      cell: createCell({ vectors: [1, 0, 0, .000001, 1, 0, 0, 0, 1] }) };
    await run('Near-orthogonal tiny faces use exact cell recovery', barelySkew);
    const polygon = [[.5, .5, .5], [.5, .5, .7], [.5, .5, .3]];
    for (let point = 0; point < 50; point++) polygon.push([.5 + .2 * Math.cos(point * 2 * Math.PI / 50), .5 + .2 * Math.sin(point * 2 * Math.PI / 50), .5]);
    const highOrder = { fractional: Float64Array.from(polygon.flat()), types: new Uint16Array(polygon.length),
      cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
    await run('Polygon capacity preserves complete topology through CPU fallback', highOrder, {}, { requireGpu: false });
    // Radical (radius-weighted) cells use the same tolerances and topology checks.
    const { voronoiRadiiForTypes } = await import('./src/analysis/voronoi-radii.js');
    const cscl = crystalFrame('bcc', 2, 4); cscl.typeLabels = ['Cs', 'Cl'];
    for (let atom = 0; atom < cscl.types.length; atom++) cscl.types[atom] = atom % 2;
    const csclResult = await run('Radical CsCl', cscl, { radii: Float64Array.from(cscl.types, type => type ? 1 : 1.6) });
    check(Math.abs(csclResult.atomicVolume[0] - 41.201816) < 5e-5 * 41.2 && csclResult.voronoiIndices.every(index => index === '<0,6,0,8>'), 'Radical CsCl analytic volume');
    const rock = crystalFrame('sc', 2, 2.82); rock.typeLabels = ['Na', 'Cl'];
    for (let atom = 0; atom < rock.types.length; atom++) rock.types[atom] = Math.round(2 * (rock.fractional[atom * 3] + rock.fractional[atom * 3 + 1] + rock.fractional[atom * 3 + 2])) % 2;
    await run('Radical rock salt', rock, { radii: voronoiRadiiForTypes(rock, [{ label: 'Na', radius: 1.02 }, { label: 'Cl', radius: 1.81 }]) });
    await run('Radical equal radii', crystalFrame('fcc', 2, 3.52), { radii: new Float64Array(32).fill(1.24) });
    await run('Radical skew distorted random radii', distorted, { radii: Float64Array.from({ length: 32 }, (_, atom) => 1.1 + .3 * Math.abs(Math.sin(atom * 2.3))) });
    await run('Radical mixed PBC random radii', mixed, { radii: Float64Array.from({ length: 32 }, (_, atom) => 1.1 + .3 * Math.abs(Math.sin(atom * 1.3))) });
    await run('Radical binary subset compacts radii', binary, { selectedTypes: ['Cu'], radii: Float64Array.from(binary.types, (type, atom) => type ? 1 + atom / 20 : NaN) });
    const crowded = crystalFrame('bcc', 2, 3), crowdedRadii = Float64Array.from({ length: 16 }, (_, atom) => atom % 2 ? 0 : 2.6);
    const emptied = await run('Radical empty cells use exact recovery', crowded, { radii: crowdedRadii });
    check(emptied.summary.emptyCellCount === 8 && emptied.gpuCorrectionReasons.emptyCell + emptied.gpuCorrectionReasons.geometry === 8, 'Empty radical cells recovered exactly');
    const spread = await run('Radical radius spread beyond the GPU bound', crystalFrame('fcc', 2, 3.52),
      { radii: Float64Array.from({ length: 32 }, (_, atom) => atom ? 0 : 11) }, { requireGpu: false });
    check(/radius spread/.test(spread.fallbackReason), 'Radius spread fallback reason');
    // Real source structures remain complete; only central output ranges are sampled.
    const [{ parseCfg }, { parseLammpsFrame }] = await Promise.all([import('./src/io/cfg.js'), import('./src/io/lammps-dump.js')]);
    const fe = parseLammpsFrame(await (await fetch('./examples/Fe_disloc_loop.dump')).text(), 'Fe_disloc_loop.dump');
    await run('Real Fe dislocation-loop full-source BCC sample', fe, { startAtom: 0, endAtom: 256 });
    await run('Real Fe dislocation-loop defect-core full-source sample', fe, { startAtom: 53344, endAtom: 53408 });
    await run('Radical real Fe loop per-atom radii', fe, { startAtom: 53344, endAtom: 53408,
      radii: Float64Array.from({ length: fe.ids.length }, (_, atom) => 1.26 * (1 + .04 * Math.sin(1.7 * atom))) });
    const hea = parseLammpsFrame(await (await fetch('./examples/hea-fcc-screw.dump')).text(), 'hea-fcc-screw.dump');
    await run('Radical real HEA element radii', hea, { startAtom: 14000, endAtom: 14064, radii: voronoiRadiiForTypes(hea, []) });
    const ni = parseCfg(await (await fetch('./examples/NiGB_minimized.cfg')).text(), 'NiGB_minimized.cfg');
    const exteriorFailure = await gpu.gpuBackend.analyze(ni, { kind: 'voronoi', startAtom: 0, endAtom: 128 })
      .then(() => null, error => error);
    check(exteriorFailure?.name === 'GpuUnavailableError' && /exact recovery|GPU/.test(exteriorFailure.message),
      'Extreme Ni vacuum-boundary coverage must request exact CPU fallback');
    rows.push({ label: 'Real Ni thin vacuum-boundary sample requests exact CPU fallback', atoms: ni.ids.length,
      backend: 'explicit CPU fallback', fallbackReason: exteriorFailure.message });
    const samples = [Math.floor(ni.ids.length / 3), Math.floor(ni.ids.length * 2 / 3)];
    for (const first of samples) await run('Real Ni grain/interior full-source sample ' + first, ni,
      { startAtom: first, endAtom: first + 64 }, { allowPrecisionFallback: true });
    await run('Real Ni interior full-source eight-cell precision sample', ni,
      { startAtom: samples[0], endAtom: samples[0] + 8 });
    await run('Radical real Ni interior per-atom radii', ni, { startAtom: samples[0], endAtom: samples[0] + 16,
      radii: Float64Array.from({ length: ni.ids.length }, (_, atom) => 1.24 * (1 + .03 * Math.cos(2.1 * atom))) }, { allowPrecisionFallback: true });
    // Cancellation must leave the resident worker usable for other analyses.
    const controller = new AbortController(); controller.abort();
    const cancelled = await gpu.analyze(fcc, { kind: 'voronoi' }, { signal: controller.signal }).then(() => false, error => error.name === 'AbortError');
    check(cancelled, 'Voronoi cancel must reject AbortError');
    const longFrame = crystalFrame('fcc', 8, 3.52), beforeCancellation = longFrame.fractional.slice(), inProgress = new AbortController();
    let partialProgress = false;
    const interrupted = await gpu.analyze(longFrame, { kind: 'voronoi' }, { signal: inProgress.signal,
      onProgress: value => {
        if (value.phase === 'analyzing' && value.completedAtoms > 0 && value.completedAtoms < longFrame.types.length) {
          partialProgress = true; inProgress.abort();
        }
      },
    }).then(() => false, error => error.name === 'AbortError');
    check(interrupted && partialProgress, 'Abort must interrupt a started multi-batch GPU analysis');
    compare(longFrame.fractional, beforeCancellation, 0, 'cancelled source coordinates');
    const resumed = await gpu.analyze(longFrame, { kind: 'voronoi' });
    check(resumed.backend === 'gpu' && resumed.kernelReused && resumed.gpuInputReused, 'Cancelled GPU job must retain device, frame buffer and cell workspace: ' + JSON.stringify({backend:resumed.backend,kernelReused:resumed.kernelReused,gpuInputReused:resumed.gpuInputReused,fallbackReason:resumed.fallbackReason}));
    check(resumed.voronoiCoordination.every(value => value === 12) && resumed.voronoiIndices.every(value => value === '<0,12,0,0>'),
      'Resumed 2048-atom FCC cells must retain exact complete topology');
    check(Math.abs(resumed.summary.volumeError) < 5e-5, 'Resumed 2048-atom FCC volume conservation');
    rows.push({ label: 'Cancel an active 2048-atom GPU job and reuse its inputs/workspace', backend: resumed.backend,
      atoms: longFrame.types.length, gpuMs: resumed.elapsedMs, gpuDispatches: resumed.gpuDispatches });
    await gpu.analyze(fcc, { kind: 'voronoi' });
    const queued = await Promise.all([gpu.analyze(fcc, { kind: 'voronoi' }), gpu.analyze(fcc, { kind: 'cna' })]);
    check(queued.every(result => result.backend === 'gpu' && result.inputReused && result.gpuInputReused), 'Voronoi and CNA share resident worker/device/frame');
    check(queued[1].structures.every(type => type === 1), 'Queued CNA still recognizes FCC');
    rows.push({ label: 'Cancellation and queued CNA reuse GPU worker', backend: 'gpu' });
    return { rows, preparations };
  } catch (error) { return { rows, preparations, error: error.stack || String(error) }; }
  finally { cpu.close(); gpu.close(); }
}
