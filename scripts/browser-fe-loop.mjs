import assert from 'node:assert/strict';
import { withWebGpuBrowser, useSoftwareAdapter } from './webgpu-browser.mjs';

// Real user-provided BCC loop, real WGSL, and a native numerical reference.
// SwiftShader validates arithmetic and topology; its timings are not hardware performance.
// The explicit test budget accommodates the whole 60,229-atom tessellation.
const budgetArgument = process.argv.find(argument => argument.startsWith('--gpu-budget-mib='));
const gpuBudgetMiB = budgetArgument ? Number(budgetArgument.split('=')[1]) : 512;
assert.ok(Number.isFinite(gpuBudgetMiB) && gpuBudgetMiB > 0, 'GPU test budget must be positive.');
const software = useSoftwareAdapter(true);
const report = await withWebGpuBrowser(async ({ evaluate, adapter }) => {
  await evaluate(`(${initialize.toString()})(${gpuBudgetMiB * 1024 ** 2})`, { timeoutMs: 120_000 });
  const cpu = await evaluate('feLoopChecks.runCpu()', { timeoutMs: 120_000 });
  console.log(JSON.stringify({ phase: 'CPU scientific reference', ...cpu }));
  const startedAt = performance.now();
  const progressTimer = setInterval(() => {
    void evaluate('feLoopChecks.progress', { timeoutMs: 10_000 }).then(progress => {
      console.log(JSON.stringify({ phase: 'GPU scientific validation', elapsedMs: performance.now() - startedAt, progress }));
    }).catch(() => {});
  }, 30_000);
  let gpu;
  try { gpu = await evaluate('feLoopChecks.runGpu()', { timeoutMs: 1_800_000 }); }
  finally { clearInterval(progressTimer); }
  await evaluate('feLoopChecks.close()');
  return { fixture: 'examples/Fe_disloc_loop.dump', adapter, softwareValidation: software,
    hardwarePerformanceMeasured: false, gpuBudgetMiB, cpu, gpu };
}, { software, isolated: false });
console.log(JSON.stringify(report, null, 2));

async function initialize(gpuBudgetBytes) {
  const [{ parseLammpsFrame }, { calculateDxa, releaseDxaKernels }, { GpuAnalysisClient }] = await Promise.all([
    import('./src/io/lammps-dump.js'), import('./src/analysis/dxa.js'), import('./src/analysis/gpu/client.js'),
  ]);
  const response = await fetch('./examples/Fe_disloc_loop.dump');
  if (!response.ok) throw new Error('The Fe loop dump did not load.');
  const frame = parseLammpsFrame(await response.text(), 'Fe_disloc_loop.dump');
  const gpu = new GpuAnalysisClient();
  await gpu.configureCache({ budgetBytes: gpuBudgetBytes });
  const state = window.feLoopChecks = { frame, gpu, cpu: null };
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const equal = (actual, expected, label) => {
    check(actual.length === expected.length, label + ': different sizes');
    for (let i = 0; i < actual.length; i++) check(actual[i] === expected[i],
      label + ': index ' + i + ', GPU=' + actual[i] + ', CPU=' + expected[i]);
  };
  const summarize = result => ({ atoms: result.atomStructureTypes.length, backend: result.backend,
    gpuStages: result.gpuStages, stageFallbacks: result.stageFallbacks, structureCounts: result.structureCounts,
    totalLength: result.totalLength, density: result.density, elapsedMs: result.elapsedMs,
    gpuElapsedMs: result.gpuElapsedMs, gpuUploadedBytes: result.gpuUploadedBytes,
    gpuReadbackBytes: result.gpuReadbackBytes, stageTimings: result.stageTimings,
    segments: result.segments.map(segment => ({ id: segment.id, family: segment.familyId,
      closed: segment.closed, isInfinite: segment.isInfinite, length: segment.length,
      burgersVector: segment.burgersVector, spatialBurgersVector: segment.spatialBurgersVector,
      pointCount: segment.points.length / 3, junctions: segment.junctions })) });
  const checkLoop = result => {
    check(result.atomStructureTypes.length === 60229, 'All source atoms must participate in DXA.');
    check(result.structureCounts[3] > 60000, 'The actual fixture must remain predominantly BCC.');
    check(result.segments.length === 1, 'The actual fixture must contain exactly one dislocation loop.');
    const segment = result.segments[0];
    check(segment.familyId === 'half111' && segment.structureType === 3, 'The loop must have BCC 1/2<111> Burgers family.');
    check(segment.closed && !segment.isInfinite, 'The loop must close without winding through PBC.');
    check(Math.abs(Math.hypot(...segment.burgersVector) - Math.sqrt(3) / 2) < 1e-10,
      'Crystal-local Burgers magnitude must be sqrt(3)/2.');
    check(Math.hypot(...segment.spatialBurgersVector) > 2.4 && Math.hypot(...segment.spatialBurgersVector) < 2.5,
      'Physical Burgers magnitude must agree with the Fe nearest-neighbor distance.');
    check(segment.length > 100 && segment.length < 108, 'The closed loop must retain its physical length.');
    check(segment.points.length >= 12 && segment.points.every(Number.isFinite), 'The loop must have finite line geometry.');
    for (let axis = 0; axis < 3; axis++) check(Math.abs(segment.points[axis]
      - segment.points[segment.points.length - 3 + axis]) < 1e-6, 'The finite loop endpoints must coincide.');
    check(segment.junctions.length === 2, 'Closed loop endpoint connectivity is missing.');
    for (let end = 0; end < 2; end++) check(segment.junctions[end].length === 1
      && segment.junctions[end][0].segmentId === segment.id && segment.junctions[end][0].end === 1 - end,
    'The loop must have reciprocal self-junctions.');
  };
  state.runCpu = async () => {
    state.cpu = await calculateDxa(frame, { lattice: 'bcc' }, { workerCount: 1 });
    checkLoop(state.cpu);
    return summarize(state.cpu);
  };
  state.runGpu = async () => {
    const before = frame.fractional.slice();
    let local = null, tetrahedra = 0;
    const actual = await calculateDxa(frame, { lattice: 'bcc', gpuEnabled: true }, {
      workerCount: 1, verifyGpuLocalStructures: true, verifyGpuClassification: true,
      onProgress: update => { state.progress = update; },
      identifyDxa: async (input, { signal, onProgress, referenceStructures, referenceNeighbors }) => {
        const result = await gpu.identifyDxa(frame, input, { signal, onProgress });
        equal(result.structures, referenceStructures, 'Local crystal structures');
        // The native validation hook checks CNA signatures and ideal-template
        // bonds after any valid symmetry permutation of the neighbor rows.
        local = { atomCount: result.structures.length, neighborCount: result.neighbors.length,
          referenceNeighborCount: referenceNeighbors.length, maxNeighborDistance: result.maxNeighborDistance,
          arithmetic: result.arithmetic, elapsedMs: result.elapsedMs,
          uploadedBytes: result.uploadedBytes, readbackBytes: result.readbackBytes };
        return result;
      },
      classifyDxa: async (snapshot, { signal, onProgress, referenceRegions }) => {
        const result = await gpu.classifyDxa(snapshot, { signal, onProgress });
        equal(result.regions, referenceRegions, 'Tetrahedron regions');
        tetrahedra = result.regions.length;
        return result;
      },
    });
    checkLoop(actual);
    equal(frame.fractional, before, 'Source coordinates');
    equal(actual.atomStructureTypes, state.cpu.atomStructureTypes, 'Final atom crystal structures');
    check(actual.backend === 'hybrid' && actual.stageFallbacks.length === 0,
      'Five GPU stages must complete: ' + JSON.stringify(summarize(actual)));
    const stages = ['local-neighbors', 'local-structures', 'local-correspondence', 'tetrahedron-alpha', 'elastic-compatibility'];
    equal(actual.gpuStages, stages, 'GPU stages');
    check(local && tetrahedra > 0, 'Both real GPU dispatches must execute.');
    const segment = actual.segments[0], expected = state.cpu.segments[0];
    const physicalDifference = Math.min(...[1, -1].map(sign => Math.hypot(...segment.spatialBurgersVector.map(
      (value, axis) => value - sign * expected.spatialBurgersVector[axis]))));
    check(physicalDifference <= Math.hypot(...expected.spatialBurgersVector) * .002,
      'Physical Burgers vector must agree up to reversal and crystal symmetry.');
    const relativeLengthDifference = Math.abs(actual.totalLength - state.cpu.totalLength) / state.cpu.totalLength;
    check(relativeLengthDifference <= .002, 'GPU/native polyline length differs by more than 0.2%.');
    return { ...summarize(actual), local, tetrahedra, relativeLengthDifference,
      physicalBurgersDifference: physicalDifference, cache: gpu.cacheStatus };
  };
  state.close = async () => { gpu.close(); await releaseDxaKernels(); };
}
