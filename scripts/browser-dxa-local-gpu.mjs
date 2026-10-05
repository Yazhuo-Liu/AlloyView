import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// Real WGSL, including software binary64 operations, is executed here. A
// SwiftShader result establishes scientific parity, not hardware speed.
const report = await withWebGpuBrowser(async ({ evaluate, adapter }) => {
  await evaluate(`(${initializeChecks.toString()})(${JSON.stringify({ localOnly: process.argv.includes('--local-only') })})`);
  await evaluate(`window.makeStackingFaultFrame = ${makeStackingFaultFrame.toString()}`);
  const requested = process.argv.find(argument => argument.startsWith('--only='))?.slice(7);
  const runSection = section => !requested || requested === section;
  const fixtureRows = [];
  for (const [kind, lattice] of runSection('fixtures') ? [['fcc', 'fcc'], ['bcc', 'bcc'], ['hcp', 'hcp'],
    ['diamond', 'cubicDiamond'], ['hex-diamond', 'hexDiamond']] : []) {
    fixtureRows.push(await evaluate(`dxaLocalChecks.run(${JSON.stringify(`Perfect ${kind}`)},
      dxaLocalChecks.crystalFrame(${JSON.stringify(kind)}, 4), { lattice: ${JSON.stringify(lattice)} })`,
    { timeoutMs: 360_000 }));
    if (kind === 'hcp' || kind === 'hex-diamond') {
      fixtureRows.push(await evaluate(`dxaLocalChecks.run(${JSON.stringify(`Perfect ${kind}, perfect-dislocation selection`)},
        dxaLocalChecks.crystalFrame(${JSON.stringify(kind)}, 4), { lattice: ${JSON.stringify(lattice)}, onlyPerfectDislocations: true })`,
      { timeoutMs: 360_000 }));
    }
  }
  const defects = runSection('defects') ? await evaluate(`(${runDefectChecks.toString()})()`, { timeoutMs: 360_000 }) : [];
  const edgeCases = runSection('edges') ? await evaluate(`(${runLocalEdgeChecks.toString()})()`, { timeoutMs: 180_000 }) : [];
  const integration = runSection('integration') ? await evaluate(`(${runClientChecks.toString()})()`, { timeoutMs: 360_000 }) : null;
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await evaluate('dxaLocalChecks.client.current === null && dxaLocalChecks.gpu.current === null')) break;
    await delay(10);
  }
  assert.equal(await evaluate('dxaLocalChecks.client.current === null && dxaLocalChecks.gpu.current === null'), true,
    'Cancelled DXA and GPU requests must acknowledge before cleanup');
  await evaluate(`(async () => {
    dxaLocalChecks.client.close(); dxaLocalChecks.gpu.close();
    await dxaLocalChecks.releaseDxaKernels();
  })()`);
  return { adapter, softwareValidation: useSoftwareAdapter(true), fixtureRows, defects, edgeCases, integration };
}, { software: useSoftwareAdapter(true), isolated: !process.argv.includes('--no-isolation') });
console.log(JSON.stringify(report, null, 2));

async function initializeChecks({ localOnly = false } = {}) {
  const [{ calculateDxa, releaseDxaKernels }, { DxaClient }, { GpuAnalysisClient },
    { crystalFrame }, { fccScrewFrame }, { createCell, fractionalToCartesian }, { default: createDxa }] = await Promise.all([
    import('./src/analysis/dxa.js'), import('./src/analysis/dxa-client.js'), import('./src/analysis/gpu/client.js'),
    import('./tests/helpers/crystals.js'), import('./tests/helpers/dislocations.js'),
    import('./src/data/model.js'), import('./src/analysis/dxa-kernel.mjs'),
  ]);
  const state = window.dxaLocalChecks = { calculateDxa, releaseDxaKernels, DxaClient, GpuAnalysisClient,
    crystalFrame, fccScrewFrame, createCell, fractionalToCartesian, createDxa, workers: [],
    localOnly,
    localStages: ['local-neighbors', 'local-structures', 'local-correspondence'] };
  state.check = (condition, message) => { if (!condition) throw new Error(message); };
  state.equal = (actual, expected, message) => {
    state.check(actual?.length === expected?.length, message + ': lengths differ');
    for (let index = 0; index < actual.length; index++) state.check(actual[index] === expected[index],
      message + ': index ' + index + ', GPU ' + actual[index] + ', CPU ' + expected[index]);
  };
  const trackWorker = (url, name) => {
    const worker = new Worker(url, { type: 'module', name });
    const row = { name, terminated: false }; state.workers.push(row);
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { row.terminated = true; terminate(); }; return worker;
  };
  state.gpu = new GpuAnalysisClient({ workerFactory: () => trackWorker(
    '/AlloyView/src/analysis/gpu/worker.js', 'GPU local DXA scientific validation') });
  state.client = new DxaClient({ gpuBackend: state.gpu, workerCount: 1, workerFactory: () => trackWorker(
    '/AlloyView/src/workers/dxa-worker.js', 'Native DXA local validation coordinator') });
  state.summary = result => ({ backend: result.backend, gpuStages: result.gpuStages ?? [],
    fallbackReason: result.fallbackReason ?? null, kernelGeneration: result.kernelGeneration,
    atoms: result.atomStructureTypes.length, structureCounts: result.structureCounts,
    segments: result.segments.length, totalLength: result.totalLength,
    elapsedMs: result.elapsedMs,
    uploadedBytes: result.gpuUploadedBytes, readbackBytes: result.gpuReadbackBytes });
  state.compareLocal = (input, actual, expected, label) => {
    const { check, equal } = state;
    const width = actual.neighborWidth ?? actual.width;
    equal(actual.structures, expected.structures, label + ': local crystal types');
    check(width === expected.width, label + ': local neighbor stride');
    check(Number.isFinite(actual.maxNeighborDistance), label + ': nonfinite maximum neighbor cutoff');
    check(Math.abs(actual.maxNeighborDistance - expected.maxNeighborDistance)
      <= 8 * Number.EPSILON * Math.max(1, expected.maxNeighborDistance), label + ': maximum neighbor cutoff differs: GPU '
        + actual.maxNeighborDistance + ', CPU ' + expected.maxNeighborDistance);
    let accepted = 0;
    // Matching is allowed to choose another crystal symmetry. It must preserve
    // every CNA signature and every ideal-template bond after that permutation.
    for (let atom = 0; atom < actual.structures.length; atom++) {
      const structure = actual.structures[atom];
      if (!structure) continue;
      accepted++;
      const template = input.templates.subarray((structure - 1) * 33, structure * 33);
      const count = template[0], permutation = [], offset = atom * width;
      const native = Array.from(expected.neighbors.subarray(offset, offset + count));
      const gpu = Array.from(actual.neighbors.subarray(offset, offset + count));
      check(new Set(native).size === count && new Set(gpu).size === count,
        label + ': duplicate local neighbors at atom ' + atom);
      for (let slot = 0; slot < count; slot++) {
        const other = native.indexOf(gpu[slot]);
        check(other >= 0, label + ': different accepted shell at atom ' + atom + ', slot ' + slot);
        permutation[slot] = other;
        check(template[1 + slot] === template[1 + other], label + ': CNA correspondence at atom ' + atom);
      }
      for (let slot = 0; slot < count; slot++) for (let other = 0; other < count; other++) {
        check(((template[17 + slot] >>> other) & 1)
          === ((template[17 + permutation[slot]] >>> permutation[other]) & 1),
        label + ': ideal-template bond mapping at atom ' + atom + ', pair ' + slot + '/' + other);
      }
    }
    return { acceptedAtoms: accepted, width, maxNeighborDistance: actual.maxNeighborDistance,
      arithmetic: actual.arithmetic, uploadedBytes: actual.uploadedBytes, readbackBytes: actual.readbackBytes };
  };
  state.compareNetwork = (actual, expected, frame, label) => {
    const { check, equal } = state;
    equal(actual.atomStructureTypes, expected.atomStructureTypes, label + ': final atom types');
    check(actual.segments.length === expected.segments.length, label + ': segment count');
    // Segment numbering and crystal-local components can change under valid
    // symmetry choices. Compare physical Burgers vectors up to line reversal.
    const unused = new Set(expected.segments.map((_, index) => index));
    for (const segment of actual.segments) {
      const matching = [...unused].find(index => {
        const candidate = expected.segments[index];
        return candidate.familyId === segment.familyId && candidate.structureType === segment.structureType
          && candidate.closed === segment.closed && candidate.isInfinite === segment.isInfinite
          && [1, -1].some(sign => segment.spatialBurgersVector.every((value, axis) =>
            Math.abs(value - sign * candidate.spatialBurgersVector[axis]) < 1e-8));
      });
      check(matching !== undefined, label + ': unmatched physical Burgers vector/family');
      const candidate = expected.segments[matching]; unused.delete(matching);
      check(Math.abs(Math.hypot(...segment.burgersVector) - Math.hypot(...candidate.burgersVector)) < 1e-8,
        label + ': crystal-local Burgers magnitude');
      check(Math.abs(segment.length - candidate.length) <= Math.max(1e-8, candidate.length * .002),
        label + ': segment arc length');
      equal((segment.junctions ?? []).map(arms => arms.length).sort((a, b) => a - b),
        (candidate.junctions ?? []).map(arms => arms.length).sort((a, b) => a - b), label + ': junction endpoint degrees');
      for (const arms of segment.junctions ?? []) for (const arm of arms) {
        check(actual.segments.some(other => other.id === arm.segmentId) && [0, 1].includes(arm.end),
          label + ': dangling junction arm');
      }
    }
    check(Math.abs(actual.totalLength - expected.totalLength) <= Math.max(1e-8, expected.totalLength * .002),
      label + ': total line length');
    if (frame.expected?.segments === 1) {
      const segment = actual.segments[0], vectors = frame.cell.vectors;
      check(segment.familyId === 'perfect' && segment.isInfinite, label + ': missing periodic screw');
      check(Math.abs(Math.hypot(...segment.spatialBurgersVector) - frame.expected.burgersMagnitude) < 1e-8,
        label + ': screw Burgers magnitude');
      const direction = Math.sign(segment.points.at(-1) - segment.points[2]);
      const tolerance = 4e-10 * Math.hypot(...[0, 1, 2].map(axis => vectors[axis] + vectors[axis + 3] + vectors[axis + 6]))
        + 32 * Number.EPSILON * Math.hypot(...vectors);
      for (let axis = 0; axis < 3; axis++) check(Math.abs(segment.points[segment.points.length - 3 + axis]
        - segment.points[axis] - direction * vectors[6 + axis]) <= tolerance, label + ': periodic screw closure');
    }
  };
  state.run = async (label, frame, parameters = {}) => {
    const before = frame.fractional.slice(), expected = await calculateDxa(frame, parameters, { workerCount: 1 });
    if (label.startsWith('Perfect ')) {
      const type = { fcc: 1, hcp: 2, bcc: 3, cubicDiamond: 4, hexDiamond: 5 }[parameters.lattice ?? 'fcc'];
      state.check(expected.atomStructureTypes.every(value => value === type), label + ': native perfect-crystal oracle failed');
    }
    let local, comparedTetrahedra = 0;
    const actual = await calculateDxa(frame, { ...parameters, gpuEnabled: true }, {
      workerCount: 1, verifyGpuLocalStructures: true, verifyGpuClassification: !state.localOnly,
      identifyDxa: async (input, { signal, onProgress, referenceStructures, referenceNeighbors,
        referenceMaxNeighborDistance, referenceWidth }) => {
        const templates = input.templates.slice();
        const result = await state.gpu.identifyDxa(frame, input, { signal, onProgress });
        local = state.compareLocal({ templates }, result, { structures: referenceStructures,
          neighbors: referenceNeighbors, maxNeighborDistance: referenceMaxNeighborDistance,
          width: referenceWidth ?? result.neighborWidth ?? result.width }, label);
        return result;
      },
      classifyDxa: state.localOnly ? undefined : async (snapshot, { signal, onProgress, referenceRegions }) => {
        const result = await state.gpu.classifyDxa(snapshot, { signal, onProgress });
        state.equal(result.regions, referenceRegions, label + ': GPU tetrahedron regions');
        comparedTetrahedra = referenceRegions.length; return result;
      },
    });
    state.check(local && local.acceptedAtoms > 0, label + ': missing real local GPU dispatch/recognized atoms: '
      + JSON.stringify(state.summary(actual)));
    state.check(state.localStages.every(stage => actual.gpuStages?.includes(stage)), label + ': local GPU stages missing');
    state.check(state.localOnly || (actual.gpuStages?.includes('tetrahedron-alpha') && actual.gpuStages?.includes('elastic-compatibility')),
      label + ': existing GPU classification regressed');
    state.equal(frame.fractional, before, label + ': source coordinates changed/detached');
    state.compareNetwork(actual, expected, frame, label);
    return { label, ...state.summary(actual), local, comparedTetrahedra };
  };
}

async function runDefectChecks() {
  const state = dxaLocalChecks, rows = [], frame = state.crystalFrame('fcc', 4);
  frame.cell = state.createCell({ vectors: [16, 0, 0, 1.2, 16, 0, .6, .8, 16],
    origin: [100, -200, 300], triclinic: true });
  frame.positions = state.fractionalToCartesian(frame.fractional, frame.cell);
  rows.push(await state.run('Translated strained triclinic FCC', frame));
  const unwrapped = { ...frame, fractional: Float64Array.from(frame.fractional,
    (value, index) => value + [2, -3, 1][index % 3]) };
  unwrapped.positions = state.fractionalToCartesian(unwrapped.fractional, unwrapped.cell);
  rows.push(await state.run('Explicit periodic images in translated triclinic FCC', unwrapped));
  rows.push(await state.run('Isolated vacancy in triclinic FCC', { ...frame,
    fractional: frame.fractional.slice(3), positions: frame.positions.slice(3),
    ids: frame.ids.slice(1), types: frame.types.slice(1) }));
  const surface = state.crystalFrame('fcc', 4);
  surface.cell = state.createCell({ vectors: surface.cell.vectors, pbc: [false, true, true] });
  const surfaceRow = await state.run('FCC free surface', surface);
  state.check(surfaceRow.structureCounts[0] > 0 && surfaceRow.structureCounts[1] > 0,
    'The free-surface fixture must contain crystal atoms and noncrystalline surface atoms');
  rows.push(surfaceRow);
  const stacking = makeStackingFaultFrame();
  const stackingRow = await state.run('FCC/HCP close-packed stacking faults', stacking);
  state.check(stackingRow.structureCounts[1] > 0 && stackingRow.structureCounts[2] > 0,
    'The stacking fault fixture must contain both identified FCC and HCP atoms');
  rows.push(stackingRow);
  const perfectOnly = await state.run('FCC stacking faults with perfect-dislocation selection', stacking,
    { onlyPerfectDislocations: true });
  state.check(!perfectOnly.structureCounts[2] && perfectOnly.structureCounts[1] > 0,
    'Perfect-dislocation selection must retain the native planar-defect classification setting');
  rows.push(perfectOnly);
  rows.push(await state.run('Rotated FCC control', state.fccScrewFrame({ screw: false })));
  rows.push(await state.run('Periodic FCC screw', state.fccScrewFrame()));
  return rows;
}

function makeStackingFaultFrame() {
  const state = dxaLocalChecks, a = 4 / Math.sqrt(2), repeat = 6;
  const stacking = [0, 1, 2, 0, 1, 2, 0, 1, 0, 2, 1, 2];
  const shifts = [[0, 0], [2 / 3, 1 / 3], [1 / 3, 2 / 3]], fractional = [];
  for (let layer = 0; layer < stacking.length; layer++) {
    const shift = shifts[stacking[layer]];
    for (let i = 0; i < repeat; i++) for (let j = 0; j < repeat; j++) {
      fractional.push((i + shift[0]) / repeat, (j + shift[1]) / repeat, layer / stacking.length);
    }
  }
  const coordinates = Float64Array.from(fractional), count = coordinates.length / 3;
  const cell = state.createCell({ vectors: [repeat * a, 0, 0, -repeat * a / 2, repeat * Math.sqrt(3) * a / 2,
    0, 0, 0, stacking.length * Math.sqrt(2 / 3) * a], triclinic: true });
  return { fractional: coordinates, cell, positions: state.fractionalToCartesian(coordinates, cell),
    ids: Uint32Array.from({ length: count }, (_, index) => index + 1), types: new Uint16Array(count),
    typeLabels: ['Ni'], properties: [] };
}

async function runLocalEdgeChecks() {
  const state = dxaLocalChecks, native = await state.createDxa({ dxaPoolSize: 0 });
  const rows = [];
  const [{ dxaCartesianCoordinates }] = await Promise.all([import('./src/analysis/dxa.js')]);
  async function run(label, frame, expectUnavailable = false) {
    native._alloy_dxa_reset_cancel();
    const coords = dxaCartesianCoordinates(frame), count = coords.length / 3;
    const cp = native._malloc(coords.byteLength), cell = native._malloc(96);
    try {
      native.HEAPF64.set(coords, cp / 8); native.HEAPF64.set(frame.cell.vectors, cell / 8);
      native.HEAPF64.set(frame.cell.origin, cell / 8 + 9);
      const error = () => native.UTF8ToString(native._alloy_dxa_last_error());
      state.check(native._alloy_dxa_prepare(cp, count, cell,
        frame.cell.pbc.reduce((bits, value, axis) => bits | (value ? 1 << axis : 0), 0), 1, 14, 9, 0, 1, 2.5), label + ': ' + error());
      const positionPtr = native._alloy_dxa_local_positions_ptr(), inversePtr = native._alloy_dxa_local_inverse_ptr();
      const templatePtr = native._alloy_dxa_local_templates_ptr(), width = native._alloy_dxa_local_neighbor_width();
      const input = { coordinates: native.HEAPF64.slice(positionPtr / 8, positionPtr / 8 + count * 3),
        inverse: native.HEAPF64.slice(inversePtr / 8, inversePtr / 8 + 9),
        templates: native.HEAPU32.slice(templatePtr / 4, templatePtr / 4 + 5 * 33),
        lattice: 1, identifyPlanarDefects: true };
      const templates = input.templates.slice();
      state.check(native._alloy_dxa_identify_local_cpu(), label + ': ' + error());
      const expected = { structures: native.HEAP32.slice(native._alloy_dxa_local_types_ptr() / 4,
        native._alloy_dxa_local_types_ptr() / 4 + count),
      neighbors: native.HEAP32.slice(native._alloy_dxa_local_neighbors_ptr() / 4,
        native._alloy_dxa_local_neighbors_ptr() / 4 + count * width), width,
      maxNeighborDistance: native._alloy_dxa_local_max_distance() };
      if (expectUnavailable) {
        let unavailable;
        try { await state.gpu.identifyDxa(frame, input); } catch (error) { unavailable = error; }
        state.check(unavailable?.name === 'GpuUnavailableError' && /origin.*precision/i.test(unavailable.message),
          label + ': unsupported precision must request CPU fallback');
        rows.push({ label, atoms: count, fallback: unavailable.message });
      } else {
        const actual = await state.gpu.identifyDxa(frame, input);
        rows.push({ label, atoms: count, ...state.compareLocal({ templates }, actual, expected, label) });
      }
    } finally { native._alloy_dxa_dispose(); native._free(cp); native._free(cell); }
  }
  // Native nearest-neighbor search excludes exactly coincident positions, not
  // all distances below an arbitrary epsilon. Test both sides explicitly.
  for (const separation of [0, 1e-12]) {
    const frame = state.crystalFrame('fcc', 4), originalCount = frame.ids.length;
    frame.fractional = Float64Array.from([...frame.fractional, separation / frame.cell.vectors[0], 0, 0]);
    frame.positions = state.fractionalToCartesian(frame.fractional, frame.cell);
    frame.ids = Uint32Array.from({ length: originalCount + 1 }, (_, index) => index + 1);
    frame.types = new Uint16Array(originalCount + 1);
    await run(separation ? 'Nonzero near-coincident atom' : 'Exactly coincident atom', frame);
  }
  const largeOrigin = state.crystalFrame('fcc', 4);
  largeOrigin.cell = state.createCell({ vectors: [16, 0, 0, 1.2, 16, 0, .6, .8, 16],
    origin: [1e12, -2e12, 3e12], triclinic: true });
  largeOrigin.positions = state.fractionalToCartesian(largeOrigin.fractional, largeOrigin.cell);
  await run('Large Cartesian origin precision fallback', largeOrigin, true);
  return rows;
}

async function runClientChecks() {
  const state = dxaLocalChecks, { check, equal, client, gpu } = state;
  // Keep more than one 4096-atom nearest-shell batch while avoiding repeated
  // full-size positive fixtures in fallback/cancellation lifecycle checks.
  const frame = state.fccScrewFrame({ nx: 20, ny: 18, nz: 6 }), before = frame.fractional.slice();
  const cpu = await client.analyze(frame), progress = [];
  const accelerated = await client.analyze(frame, { gpuEnabled: true }, { onProgress: row => progress.push(row) });
  check(state.localStages.every(stage => accelerated.gpuStages?.includes(stage)), 'DxaClient omitted local GPU stages');
  check(!progress.some(row => row.phase === 'Identify local crystal structures' && row.backend === 'cpu'),
    'Production GPU analysis still ran the CPU local classification');
  state.compareNetwork(accelerated, cpu, frame, 'DxaClient'); equal(frame.fractional, before, 'DxaClient source frame');
  let thinError;
  try { await client.analyze(state.crystalFrame('fcc', 1), { gpuEnabled: true }); } catch (error) { thinError = error.message; }
  check(/too short|too small|extend|replicat/i.test(thinError ?? ''), 'Thin periodic cell scientific rejection disappeared');
  const recovery = await client.analyze(state.crystalFrame('fcc', 4), { gpuEnabled: true });
  check(recovery.kernelGeneration === accelerated.kernelGeneration && recovery.segments.length === 0,
    'Thin-cell rejection replaced or poisoned retained native heap');
  const identify = gpu.identifyDxa.bind(gpu), classify = gpu.classifyDxa.bind(gpu), fallbacks = [];
  function unavailable() { const error = new Error('Injected unavailable GPU stage.'); error.name = 'GpuUnavailableError'; return Promise.reject(error); }
  for (const method of ['identifyDxa', 'classifyDxa']) {
    gpu[method] = unavailable;
    let result;
    try { result = await client.analyze(frame, { gpuEnabled: true }); }
    finally { gpu.identifyDxa = identify; gpu.classifyDxa = classify; }
    state.compareNetwork(result, cpu, frame, 'Partial fallback ' + method);
    check(result.backend === 'hybrid', 'Other supported GPU stages were discarded after ' + method + ' failure');
    check(method === 'identifyDxa' ? result.gpuStages?.includes('tetrahedron-alpha')
      : state.localStages.every(stage => result.gpuStages?.includes(stage)), 'Partial GPU fallback stage list is wrong');
    check(result.kernelGeneration === accelerated.kernelGeneration, 'Partial fallback replaced native heap');
    fallbacks.push({ failedMethod: method, ...state.summary(result) });
  }
  const cancellation = [], workersBefore = state.workers.length;
  for (const phase of ['dxa-local-neighbors', 'dxa-local-structures']) {
    const controller = new AbortController(); let cancelledAt;
    gpu.identifyDxa = (source, input, options) => identify(source, input, { ...options, onProgress: row => {
      options.onProgress?.(row);
      const processed = row.processedAtoms ?? row.submittedAtoms ?? row.completedAtoms;
      if (row.phase === phase && processed > 0 && !cancelledAt) {
        cancelledAt = processed; controller.abort();
      }
    } });
    let name;
    try { await client.analyze(frame, { gpuEnabled: true }, { signal: controller.signal }); }
    catch (error) { name = error.name; }
    finally { gpu.identifyDxa = identify; }
    check(cancelledAt > 0 && name === 'AbortError', 'No cancellation inside actual GPU batch: ' + phase);
    const resumed = await client.analyze(frame, { gpuEnabled: true });
    state.compareNetwork(resumed, cpu, frame, 'Resume ' + phase);
    check(resumed.kernelGeneration === accelerated.kernelGeneration, 'Local-stage cancellation replaced native heap');
    check(state.workers.length === workersBefore && state.workers.every(worker => !worker.terminated),
      'Local-stage cancellation replaced retained worker/device');
    cancellation.push({ phase, cancelledAt, error: name, resumed: state.summary(resumed) });
  }
  return { cpu: state.summary(cpu), accelerated: state.summary(accelerated), thinError,
    recovery: state.summary(recovery), fallbacks, cancellation, workersCreated: state.workers.length };
}
