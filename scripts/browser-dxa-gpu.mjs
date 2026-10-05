import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// SwiftShader runs the real WGSL pipelines. These checks establish numerical
// behavior and resource ownership, not a physical-GPU performance result.
const report = await withWebGpuBrowser(async ({ evaluate, adapter }) => {
  await evaluate(`(async () => {
    const [{ calculateDxa, warmupDxa, releaseDxaKernels }, { DxaClient }, { GpuAnalysisClient },
      { GpuRuntime }, { analyzeGpuDxaClassification }, { crystalFrame },
      { fccScrewFrame }, { createCell, fractionalToCartesian }] = await Promise.all([
      import('./src/analysis/dxa.js'), import('./src/analysis/dxa-client.js'),
      import('./src/analysis/gpu/client.js'), import('./src/analysis/gpu/runtime.js'),
      import('./src/analysis/gpu/dxa.js'), import('./tests/helpers/crystals.js'),
      import('./tests/helpers/dislocations.js'), import('./src/data/model.js'),
    ]);
    const state = window.dxaGpuChecks = { calculateDxa, warmupDxa, releaseDxaKernels, DxaClient,
      GpuAnalysisClient, GpuRuntime, analyzeGpuDxaClassification, crystalFrame,
      fccScrewFrame, createCell, fractionalToCartesian, rows: [], workers: [] };
    state.check = (condition, message) => { if (!condition) throw new Error(message); };
    state.equal = (actual, expected, message) => {
      state.check(actual.length === expected.length, message + ': length differs');
      for (let index = 0; index < actual.length; index++) {
        state.check(actual[index] === expected[index], message + ': index ' + index
          + ', GPU ' + actual[index] + ', CPU ' + expected[index]);
      }
    };
    const trackWorker = (url, name) => {
      const worker = new Worker(url, { type: 'module', name });
      const row = { name, terminated: false }; state.workers.push(row);
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => { row.terminated = true; terminate(); };
      return worker;
    };
    state.gpu = new GpuAnalysisClient({ workerFactory: () =>
      trackWorker('/AlloyView/src/analysis/gpu/worker.js', 'DXA GPU validation') });
    state.runtime = new GpuRuntime();
    state.makeDxaClient = gpuBackend => new DxaClient({ gpuBackend, workerCount: 1,
      workerFactory: () => trackWorker('/AlloyView/src/workers/dxa-worker.js', 'DXA coordinator validation') });
    state.network = result => ({ backend: result.backend, engine: result.engine,
      gpuFallback: result.gpuFallback, fallbackReason: result.fallbackReason ?? null,
      kernelGeneration: result.kernelGeneration, poolSize: result.poolSize,
      elapsedMs: result.elapsedMs, gpuStages: result.gpuStages ?? [],
      segments: result.segments.length, totalLength: result.totalLength,
      workerCount: result.workerCount });
    state.run = async (label, frame, parameters = {}) => {
      const original = frame.fractional.slice();
      const expected = await calculateDxa(frame, parameters, { workerCount: 1 });
      let classified = 0, gpuDetails;
      const actual = await calculateDxa(frame, { ...parameters, gpuEnabled: true }, {
        workerCount: 1, verifyGpuClassification: true,
        classifyDxa: async (snapshot, { signal, onProgress, referenceRegions }) => {
          state.check(referenceRegions instanceof Int32Array, label + ': native reference regions missing');
          const result = await state.gpu.classifyDxa(snapshot, { signal, onProgress });
          state.equal(result.regions, referenceRegions, label + ': tetrahedron classification');
          classified = referenceRegions.length;
          gpuDetails = { arithmetic: result.arithmetic, gpuStages: result.gpuStages,
            uploadedBytes: result.uploadedBytes, readbackBytes: result.readbackBytes };
          return result;
        },
      });
      state.check(actual.backend === 'hybrid', label + ': no real GPU classification: ' + JSON.stringify(state.network(actual)));
      state.check(classified > 0, label + ': no tetrahedra compared');
      state.equal(actual.atomStructureTypes, expected.atomStructureTypes, label + ': atom structure labels');
      state.equal(frame.fractional, original, label + ': source coordinates changed or detached');
      state.check(actual.segments.length === expected.segments.length, label + ': network count differs');
      for (let index = 0; index < actual.segments.length; index++) {
        const a = actual.segments[index], b = expected.segments[index];
        for (const key of ['familyId', 'structureType', 'closed', 'isInfinite'])
          state.check(a[key] === b[key], label + ': segment ' + index + ' ' + key);
        state.equal(a.burgersVector, b.burgersVector, label + ': local Burgers vector');
        state.equal(a.spatialBurgersVector, b.spatialBurgersVector, label + ': world Burgers vector');
        state.check(JSON.stringify(a.junctions) === JSON.stringify(b.junctions), label + ': junctions differ');
      }
      state.check(Math.abs(actual.totalLength - expected.totalLength)
        <= Math.max(1e-8, expected.totalLength * 1e-3), label + ': line arc differs');
      if (frame.expected?.segments === 1) {
        const segment = actual.segments[0];
        state.check(segment.familyId === 'perfect' && segment.isInfinite, label + ': expected periodic perfect screw');
        // The native Delaunay backend perturbs points by 1e-10*|a+b+c|.
        // Circuit centers at the two ends may each inherit two perturbed
        // edges, giving a four-epsilon physical closure bound per component.
        const vectors = frame.cell.vectors;
        const closureTolerance = 4e-10 * Math.hypot(...[0, 1, 2].map(axis =>
          vectors[axis] + vectors[axis + 3] + vectors[axis + 6]))
          + 32 * Number.EPSILON * Math.hypot(...vectors);
        const direction = Math.sign(segment.points.at(-1) - segment.points[2]);
        for (let axis = 0; axis < 3; axis++) {
          const delta = segment.points[segment.points.length - 3 + axis] - segment.points[axis];
          state.check(Math.abs(delta - direction * vectors[6 + axis]) <= closureTolerance,
            label + ': periodic vector component ' + axis + ' differs');
        }
        state.check(Math.abs(Math.hypot(...segment.spatialBurgersVector)
          - frame.expected.burgersMagnitude) < 1e-8, label + ': Burgers magnitude differs');
      }
      const row = { label, atoms: frame.ids.length, comparedTetrahedra: classified,
        ...state.network(actual), ...gpuDetails };
      state.rows.push(row); return row;
    };
  })()`);

  if (process.argv.includes('--synthetic-only')) {
    const synthetic = await evaluate(`(${runSyntheticChecks.toString()})()`, { timeoutMs: 180_000 });
    await evaluate('dxaGpuChecks.runtime.device.destroy(); dxaGpuChecks.gpu.close()');
    return { adapter, softwareValidation: useSoftwareAdapter(true), synthetic };
  }
  if (process.argv.includes('--integration-only')) {
    const nativeLease = await evaluate(`(${runNativeLeaseChecks.toString()})()`, { timeoutMs: 180_000 });
    const integration = await evaluate(`(${runClientChecks.toString()})()`, { timeoutMs: 180_000 });
    await evaluate(`(async () => {
      dxaGpuChecks.client.close(); dxaGpuChecks.gpu.close(); await dxaGpuChecks.releaseDxaKernels();
    })()`);
    return { adapter, softwareValidation: useSoftwareAdapter(true), nativeLease, integration };
  }

  const fixtures = [
    ['fcc', 'fcc'], ['bcc', 'bcc'], ['hcp', 'hcp'],
    ['diamond', 'cubicDiamond'], ['hex-diamond', 'hexDiamond'],
  ];
  for (const [kind, lattice] of fixtures) {
    await evaluate(`dxaGpuChecks.run(${JSON.stringify(`Perfect ${kind}`)},
      dxaGpuChecks.crystalFrame(${JSON.stringify(kind)}, 4), { lattice: ${JSON.stringify(lattice)} })`);
  }
  await evaluate(`(async () => {
    const state = dxaGpuChecks, frame = state.crystalFrame('fcc', 4);
    frame.cell = state.createCell({ vectors: [16, 0, 0, 1.2, 16, 0, .6, .8, 16],
      origin: [100, -200, 300], triclinic: true });
    frame.positions = state.fractionalToCartesian(frame.fractional, frame.cell);
    await state.run('Translated strained triclinic FCC', frame);
    await state.run('Isolated vacancy in triclinic FCC', { ...frame,
      fractional: frame.fractional.slice(3), positions: frame.positions.slice(3),
      ids: frame.ids.slice(1), types: frame.types.slice(1) });
    await state.run('Rotated FCC control', state.fccScrewFrame({ screw: false }));
    await state.run('Periodic FCC screw', state.fccScrewFrame());
  })()`, { timeoutMs: 360_000 });

  const synthetic = await evaluate(`(${runSyntheticChecks.toString()})()`, { timeoutMs: 180_000 });
  const nativeLease = await evaluate(`(${runNativeLeaseChecks.toString()})()`, { timeoutMs: 180_000 });
  const integration = await evaluate(`(${runClientChecks.toString()})()`, { timeoutMs: 360_000 });
  // Aborted queued GPU work acknowledges asynchronously. Ensure coordinator
  // retirement before checking that normal cancellation kept its worker alive.
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await evaluate('dxaGpuChecks.client.current === null')) break;
    await delay(10);
  }
  assert.equal(await evaluate('dxaGpuChecks.client.current === null'), true, 'DXA cancellation acknowledgement');
  const rows = await evaluate('dxaGpuChecks.rows');
  await evaluate(`(async () => {
    dxaGpuChecks.client.close(); dxaGpuChecks.gpu.close();
    dxaGpuChecks.runtime.device?.destroy(); await dxaGpuChecks.releaseDxaKernels();
  })()`);
  return { adapter, softwareValidation: useSoftwareAdapter(true), rows, synthetic, nativeLease, integration };
}, { software: useSoftwareAdapter(true), isolated: true });
console.log(JSON.stringify(report, null, 2));

async function runSyntheticChecks() {
  const state = dxaGpuChecks, { runtime, analyzeGpuDxaClassification: classify, check, equal } = state;
  await runtime.initialize();
  const initialBytes = runtime.allocatedBytes;
  const [{ CSP_F64_WGSL }, { DXA_RATIO_WGSL }] = await Promise.all([
    import('/AlloyView/src/analysis/gpu/csp-f64.js'), import('/AlloyView/src/analysis/gpu/dxa-shaders.js'),
  ]);
  const edgePairs = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
  const rows = [];
  const nextUp = value => {
    if (value === Infinity) return Infinity;
    const array = new Float64Array([value]), words = new BigUint64Array(array.buffer);
    words[0]++; return array[0];
  };
  const nextDown = value => {
    if (value === 0) return -Number.MIN_VALUE;
    const array = new Float64Array([value]), words = new BigUint64Array(array.buffer);
    words[0]--; return array[0];
  };
  const ratioCases = [];
  function addRatio(numerator, denominator) {
    const quotient = numerator / denominator;
    for (const threshold of [quotient, nextUp(quotient), nextDown(quotient)])
      ratioCases.push({ numerator, denominator, threshold, expected: quotient < threshold });
  }
  for (const pair of [[1, 3], [1, 10], [Number.MIN_VALUE, 2],
    [Number.MIN_VALUE, Number.MIN_VALUE], [1, Number.MAX_VALUE], [Number.MAX_VALUE, .5],
    [Number.MAX_VALUE, 1.0000000000000002], [Number.MIN_VALUE * 17, 2],
    [2.225073858507201e-308, 2], [Infinity, 1], [1, Infinity], [Infinity, Infinity],
    [0, 0], [1, 0], [0, 1]]) addRatio(...pair);
  let randomState = 0x13579bdf;
  function random() {
    randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5;
    return (randomState >>> 0) / 2 ** 32;
  }
  for (let index = 0; index < 256; index++) {
    addRatio((1 + random()) * 2 ** Math.floor(random() * 1800 - 900),
      (1 + random()) * 2 ** Math.floor(random() * 1800 - 900));
  }
  const input = Float64Array.from(ratioCases.flatMap(row => [row.numerator, row.denominator, row.threshold]));
  const source = `${CSP_F64_WGSL}\n${DXA_RATIO_WGSL}\n
    @group(0) @binding(0) var<storage, read> input: array<vec2u>;
    @group(0) @binding(1) var<storage, read_write> output: array<u32>;
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
      let row = gid.x; if (row * 3u + 2u >= arrayLength(&input)) { return; }
      output[row] = select(0u, 1u, dxaPositiveRatioLess(input[row * 3u], input[row * 3u + 1u], input[row * 3u + 2u]));
    }`;
  const ratioBuffers = [];
  try {
    ratioBuffers.push(runtime.storageBuffer(input), runtime.createBuffer(ratioCases.length * 4));
    await runtime.run(source, ratioBuffers, ratioCases.length, { updateRange: false, batchSize: 0, workgroupSize: 64 });
    const actual = await runtime.read(ratioBuffers[1], Uint32Array, ratioCases.length);
    for (let index = 0; index < actual.length; index++) {
      const row = ratioCases[index];
      check(actual[index] === Number(row.expected), 'GPU binary64 division comparison ' + index
        + ': ' + JSON.stringify(row) + ', GPU ' + actual[index]);
    }
    rows.push({ label: 'Binary64 quotient midpoint, last-ULP, underflow and overflow', comparisons: ratioCases.length });
  } finally { runtime.disposeBuffers(ratioBuffers); }
  function snapshot({ alpha = 1, sliver = false, infiniteNeighbor = false, outsideNeighbor = false,
    reverseEdges = false, burgersError = 0, badTransition = false, nonSelfCompatible = false } = {}) {
    let vertices = Float64Array.from(sliver
      ? [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]
      : [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    if (outsideNeighbor) vertices = Float64Array.from([...vertices,
      0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]);
    const tetrahedra = new Uint32Array((infiniteNeighbor || outsideNeighbor ? 2 : 1) * 16);
    tetrahedra.set([0, 1, 2, 3, infiniteNeighbor || outsideNeighbor ? 1 : 0, 0, 0, 0]);
    if (outsideNeighbor) {
      tetrahedra.set([4, 5, 6, 7, 1, 1, 1, 1], 16);
      tetrahedra[30] = 1;
    }
    const edges = new Uint32Array(7 * 8);
    const transitions = new Float64Array((nonSelfCompatible ? 6 : 1) * 20);
    transitions.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    transitions.set([1, 0, 0, 0, 1, 0, 0, 0, 1], 9);
    transitions[18] = badTransition ? 0 : 1;
    // A non-self transition with a proper rotation but nontrivial accumulated
    // Frank rotation must reject the tetrahedron even with zero edge vectors.
    if (badTransition) {
      transitions.set([0, 1, 0, -1, 0, 0, 0, 0, 1]);
      transitions.set([0, -1, 0, 1, 0, 0, 0, 0, 1], 9);
    }
    edges[6] = 0xffffffff;
    const rotations = [
      [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 0, -1, 0, 0, 0, 0, 1],
      [-1, 0, 0, 0, -1, 0, 0, 0, 1], [0, -1, 0, 1, 0, 0, 0, 0, 1],
    ];
    const transpose = matrix => [matrix[0], matrix[3], matrix[6], matrix[1], matrix[4], matrix[7], matrix[2], matrix[5], matrix[8]];
    const multiply = (left, right) => Array.from({ length: 9 }, (_, index) => {
      const row = index % 3, column = Math.floor(index / 3);
      return [0, 1, 2].reduce((value, k) => value + left[k * 3 + row] * right[column * 3 + k], 0);
    });
    const transform = (matrix, vector) => Array.from({ length: 3 }, (_, row) =>
      [0, 1, 2].reduce((value, column) => value + matrix[column * 3 + row] * vector[column], 0));
    edgePairs.forEach(([from, to], index) => {
      const reverse = reverseEdges && (index & 1) !== 0;
      let vector = Float64Array.from([0, 1, 2], axis => badTransition ? 0
        : (vertices[to * 3 + axis] - vertices[from * 3 + axis]
          + (index === 0 && axis === 0 ? burgersError : 0)) * (reverse ? -1 : 1));
      if (nonSelfCompatible) {
        const first = reverse ? to : from, second = reverse ? from : to;
        vector = Float64Array.from(transform(rotations[first], vector));
        transitions.set(multiply(rotations[second], transpose(rotations[first])), index * 20);
        transitions.set(multiply(rotations[first], transpose(rotations[second])), index * 20 + 9);
        transitions[index * 20 + 18] = 0;
      }
      edges.set(new Uint32Array(vector.buffer), (index + 1) * 8);
      edges[(index + 1) * 8 + 6] = nonSelfCompatible ? index : 0;
      tetrahedra[8 + index] = ((index + 1) | (reverse ? 0x80000000 : 0)) >>> 0;
    });
    tetrahedra[14] = 1;
    return { vertices, tetrahedra, edges, transitions, alpha };
  }
  for (const [label, options, expected] of [
    ['Strict alpha equality rejects', { alpha: .75 }, [-1]],
    ['One ULP above alpha includes', { alpha: nextUp(.75) }, [0]],
    ['Reversed oriented edges preserve closure', { reverseEdges: true }, [0]],
    ['Non-self transitions preserve crystal-reference closure', { nonSelfCompatible: true }, [0]],
    ['Reversed non-self transitions preserve closure', { nonSelfCompatible: true, reverseEdges: true }, [0]],
    ['Sliver with filled-or-inconclusive neighbors includes', { sliver: true }, [0]],
    ['Sliver with infinite neighbor rejects', { sliver: true, infiniteNeighbor: true }, [-1, -1]],
    ['Sliver with outside finite neighbor rejects', { sliver: true, outsideNeighbor: true }, [-1, -1]],
    ['Burgers circuit incompatibility rejects', { burgersError: .002 }, [-1]],
    ['Non-self transition disclination rejects', { badTransition: true }, [-1]],
  ]) {
    const actual = await classify(runtime, snapshot(options));
    equal(actual.regions, expected, label);
    check(actual.arithmetic === 'ieee754-f64', label + ': arithmetic metadata');
    check(runtime.allocatedBytes === initialBytes, label + ': GPU workspace leak');
    rows.push({ label, regions: Array.from(actual.regions) });
  }
  return rows;
}

async function runClientChecks() {
  const state = dxaGpuChecks, { check, equal } = state;
  const frame = state.fccScrewFrame();
  state.client = state.makeDxaClient(state.gpu);
  const before = frame.fractional.slice();
  const cpu = await state.client.analyze(frame, { gpuEnabled: false });
  const accelerated = await state.client.analyze(frame, { gpuEnabled: true });
  check(accelerated.backend === 'hybrid', 'DxaClient must use shared GPU worker');
  check(cpu.kernelGeneration === accelerated.kernelGeneration, 'GPU toggle replaced the native heap');
  equal(cpu.atomStructureTypes, accelerated.atomStructureTypes, 'DxaClient structure labels');
  equal(frame.fractional, before, 'DxaClient source coordinates');
  let thinError;
  try { await state.client.analyze(state.crystalFrame('fcc', 1), { gpuEnabled: true }); }
  catch (error) { thinError = error.message; }
  check(/too short|too small|extend|replicat/i.test(thinError ?? ''), 'Thin cell must retain scientific rejection');
  const recovery = await state.client.analyze(state.crystalFrame('fcc', 4), { gpuEnabled: true });
  check(recovery.segments.length === 0 && recovery.backend === 'hybrid', 'Thin error poisoned GPU DXA');
  check(recovery.kernelGeneration === accelerated.kernelGeneration, 'Thin failure replaced the native heap');
  const originalClassify = state.gpu.classifyDxa.bind(state.gpu);
  const originalIdentify = state.gpu.identifyDxa.bind(state.gpu);
  state.gpu.classifyDxa = state.gpu.identifyDxa = () => {
    const error = new Error('GPU validation injected unavailable device.');
    error.name = 'GpuUnavailableError'; return Promise.reject(error);
  };
  let fallback;
  try { fallback = await state.client.analyze(frame, { gpuEnabled: true }); }
  finally { state.gpu.classifyDxa = originalClassify; state.gpu.identifyDxa = originalIdentify; }
  check(fallback.backend === 'cpu' && fallback.gpuFallback, 'Unavailable GPU must fall back to actual CPU DXA');
  check(fallback.segments.length === 1, 'Fallback lost the real dislocation');
  check(fallback.kernelGeneration === accelerated.kernelGeneration, 'Fallback replaced native heap');
  equal(fallback.segments[0].burgersVector, cpu.segments[0].burgersVector, 'Fallback Burgers vector');
  const workersBefore = state.workers.length;
  const controller = new AbortController();
  let cancellationStage;
  state.gpu.classifyDxa = (snapshot, options) => {
    return originalClassify(snapshot, { ...options, onProgress: progress => {
      options.onProgress?.(progress);
      if (progress.phase === 'dxa-alpha' && progress.completedTetrahedra > 0 && !cancellationStage) {
        cancellationStage = 'GPU alpha batch ' + progress.completedTetrahedra;
        controller.abort();
      }
    } });
  };
  let cancellationName;
  try { await state.client.analyze(frame, { gpuEnabled: true }, { signal: controller.signal }); }
  catch (error) { cancellationName = error.name; }
  finally { state.gpu.classifyDxa = originalClassify; }
  check(cancellationStage && cancellationName === 'AbortError', 'Cancellation after a submitted GPU batch did not abort');
  const resumed = await state.client.analyze(frame, { gpuEnabled: true });
  check(resumed.backend === 'hybrid' && resumed.segments.length === 1, 'Cancellation poisoned analysis');
  check(resumed.kernelGeneration === accelerated.kernelGeneration, 'GPU-stage cancellation replaced heap');
  check(state.workers.length === workersBefore, 'GPU-stage cancellation recreated a worker/device');
  check(state.workers.every(worker => !worker.terminated), 'Normal cancellation terminated a retained worker');
  equal(resumed.atomStructureTypes, cpu.atomStructureTypes, 'Recovery atom labels');
  equal(resumed.segments[0].burgersVector, cpu.segments[0].burgersVector, 'Recovery Burgers vector');
  return { cpu: state.network(cpu), accelerated: state.network(accelerated), thinError,
    recovered: state.network(recovery), fallback: state.network(fallback),
    cancellationName, cancellationStage, resumed: state.network(resumed),
    workersCreated: state.workers.length };
}

async function runNativeLeaseChecks() {
  const state = dxaGpuChecks, { check, calculateDxa, warmupDxa, releaseDxaKernels } = state;
  const frame = state.crystalFrame('fcc', 4);
  let entered, finish, classification;
  const ready = new Promise(resolve => { entered = resolve; });
  const pending = calculateDxa(frame, { gpuEnabled: true }, { classifyDxa: async (snapshot, options) => {
    classification = await state.gpu.classifyDxa(snapshot, options);
    entered(); return new Promise(resolve => { finish = resolve; });
  } });
  await Promise.race([ready, pending.then(() => { throw new Error('GPU callback did not pause the native session.'); })]);
  const rejectedOperations = [];
  for (const [label, operation] of [
    ['Overlapping calculation', () => calculateDxa(frame)],
    ['Overlapping warmup', () => warmupDxa({ atomCount: frame.ids.length })],
    ['Overlapping shutdown', () => releaseDxaKernels()],
  ]) {
    let message;
    try { await operation(); } catch (error) { message = error.message; }
    check(/native workspace/.test(message ?? ''), label + ': active native session was not protected');
    rejectedOperations.push(label);
  }
  finish(classification);
  const result = await pending;
  check(result.backend === 'hybrid' && result.segments.length === 0, 'Session did not finish after rejected overlaps');

  // Abort while classification has finished on the device but the public
  // asynchronous callback is still pending. Cleanup must release the native
  // session even when the external callback never finishes promptly.
  const controller = new AbortController();
  let abortEntered, abortFinish, abortClassification;
  const abortReady = new Promise(resolve => { abortEntered = resolve; });
  const abortPending = calculateDxa(frame, { gpuEnabled: true }, { signal: controller.signal,
    classifyDxa: async (snapshot, options) => {
      abortClassification = await state.gpu.classifyDxa(snapshot, options);
      abortEntered(); return new Promise(resolve => { abortFinish = resolve; });
    } });
  await Promise.race([abortReady, abortPending.then(() => { throw new Error('GPU callback did not pause the cancellation session.'); })]);
  controller.abort();
  let cancellationName;
  try { await abortPending; } catch (error) { cancellationName = error.name; }
  abortFinish(abortClassification);
  check(cancellationName === 'AbortError', 'Native callback wait ignored cancellation');
  const recovery = await calculateDxa(frame);
  check(recovery.segments.length === 0, 'Native callback abort poisoned the next calculation');
  check(recovery.kernelGeneration === result.kernelGeneration, 'Native callback abort replaced the heap');
  return { rejectedOperations, cancellationName, kernelGeneration: result.kernelGeneration,
    recoveredKernelGeneration: recovery.kernelGeneration };
}
