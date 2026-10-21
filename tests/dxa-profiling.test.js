import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { crystalFrame } from './helpers/crystals.js';
import { fccScrewFrame } from './helpers/dislocations.js';

function checkProfile(profile, { trial = 14, stretch = 9 } = {}) {
  assert.equal(profile.overflow, false, 'All admitted depth/worker diagnostics fit the bounded profile.');
  for (const [key, value] of Object.entries(profile.timingsMs))
    assert.ok(Number.isFinite(value) && value >= 0, `Nonnegative timing ${key}`);
  for (const [key, value] of Object.entries(profile.counters))
    assert.ok(Number.isFinite(value) && value >= 0, `Nonnegative counter ${key}`);
  const counters = profile.counters;
  assert.equal(counters['mesh.classification.workerOverflow'], 0);
  assert.equal(counters['mesh.classification.cells'], counters['delaunay.totalCells']);
  assert.equal(counters['mesh.classification.importedCells'], 0);
  assert.ok(counters['mesh.classification.finiteCells'] <= counters['mesh.classification.cells']);
  assert.ok(counters['mesh.alpha.calls'] >= counters['mesh.classification.finiteCells']);
  assert.ok(counters['mesh.alpha.inconclusive'] <= counters['mesh.alpha.calls']);
  assert.ok(counters['mesh.region.calls'] <= counters['mesh.classification.finiteCells']);
  assert.equal(counters['tracing.depthPasses'], trial + stretch - 2);
  assert.equal(counters['tracing.joinCalls'], counters['tracing.depthPasses']);
  const primaryMetrics = {
    primarySeeds: 'seeds', primaryRecords: 'records', primaryProcessedRecords: 'processedRecords',
    primaryExaminedEdges: 'examinedEdges', primaryBlockedEdges: 'blockedEdges',
    primaryStoppedSeeds: 'stoppedSeeds', primarySeedsWithSegment: 'seedsWithSegment',
    primaryExhaustedSeeds: 'exhaustedSeeds',
    primaryBlockedByCircuit: 'blockedByCircuit', primaryBlockedByFace: 'blockedByFace',
    primaryRevisitedNeighbors: 'revisitedNeighbors', primaryZeroBurgersRevisits: 'zeroBurgersRevisits',
    primaryFrankMismatchRevisits: 'frankMismatchRevisits', primaryDepthLimitedNeighbors: 'depthLimitedNeighbors',
    primaryCircuitAttempts: 'circuitAttempts',
  };
  for (const [perDepth, total] of Object.entries(primaryMetrics)) {
    let sum = 0;
    for (let depth = 3; depth <= trial; depth += 2) {
      const value = counters[`tracing.depth.${depth}.${perDepth}`];
      assert.ok(Number.isInteger(value) && value >= 0, `${depth}/${perDepth}`);
      sum += value;
    }
    assert.equal(sum, counters[`tracing.primary.${total}`], `${perDepth} conserves all depth work.`);
  }
  assert.equal(counters['tracing.primary.stoppedSeeds'] + counters['tracing.primary.exhaustedSeeds'],
    counters['tracing.primary.seeds']);
  assert.ok(counters['tracing.primary.seedsWithSegment'] <= counters['tracing.primary.stoppedSeeds']);
  assert.ok(counters['tracing.primary.processedRecords'] <= counters['tracing.primary.records']);
  assert.ok(counters['tracing.primary.blockedEdges'] <= counters['tracing.primary.examinedEdges']);
  assert.equal(counters['tracing.primary.blockedByCircuit'] + counters['tracing.primary.blockedByFace'],
    counters['tracing.primary.blockedEdges']);
  assert.equal(counters['tracing.primary.zeroBurgersRevisits'] + counters['tracing.primary.frankMismatchRevisits']
    + counters['tracing.primary.circuitAttempts'], counters['tracing.primary.revisitedNeighbors']);
  assert.equal(counters['tracing.primary.circuitAttempts'], counters['tracing.circuitAttempts']);
  assert.equal(counters['tracing.primary.blockedEdges'] + counters['tracing.primary.revisitedNeighbors']
    + counters['tracing.primary.records'] - counters['tracing.primary.seeds']
    + counters['tracing.primary.depthLimitedNeighbors'], counters['tracing.primary.examinedEdges'],
  'Each examined edge has exactly one blocked, revisited, enqueued, or depth-limited outcome.');
  const circuitRejections = ['zeroBurgers', 'periodicNonclosure', 'intersection']
    .reduce((sum, reason) => sum + counters[`tracing.circuitRejected.${reason}`], 0);
  assert.equal(circuitRejections, counters['tracing.discardedCircuitAttempts']);
  assert.equal(circuitRejections + counters['tracing.acceptedCircuitAttempts'], counters['tracing.circuitAttempts']);
  assert.ok(counters['tracing.circuitRejected.intersection'] <= counters['tracing.intersectingCircuitAttempts'],
    'First rejection and all intersecting discards intentionally have different semantics.');
  const secondaryRejections = ['singleCircuit', 'lengthLimit', 'zeroBurgers', 'periodicNonclosure', 'frankMismatch']
    .reduce((sum, reason) => sum + counters[`tracing.secondaryRejected.${reason}`], 0);
  assert.equal(secondaryRejections + counters['tracing.createdSecondarySegments'], counters['tracing.secondaryAttempts']);
  let junctions = 0;
  for (let depth = 3; depth <= trial + stretch; depth++) {
    assert.ok(Number.isInteger(counters[`tracing.depth.${depth}.extensionCalls`]));
    junctions += counters[`tracing.depth.${depth}.junctions`];
    for (const phase of ['extendExisting', 'joinSegments', 'createSecondarySegment', 'joinCleanup'])
      assert.ok(Object.hasOwn(profile.timingsMs, `tracing.depth.${depth}.${phase}`));
  }
  for (let depth = 3; depth <= trial; depth += 2)
    for (const phase of ['primarySearch', 'primaryCleanup'])
      assert.ok(Object.hasOwn(profile.timingsMs, `tracing.depth.${depth}.${phase}`));
  assert.equal(junctions, counters['tracing.junctions']);
  assert.equal(['skippedAlreadyJoined', 'skippedUnblocked', 'skippedSingleArm', 'skippedIncompleteRing']
    .reduce((sum, reason) => sum + counters[`tracing.join.${reason}`], 0)
    + counters['tracing.junctions'] + counters['tracing.closedTwoArmLoops'] + counters['tracing.mergedSegments'],
  counters['tracing.join.candidates'], 'Every merge candidate has one rejection or junction/loop/merge outcome.');
  let components = 0, componentVertices = 0;
  for (let bin = 0; bin < 32; bin++) {
    const count = counters[`mesh.staticComponents.bin.${bin}.count`];
    const vertices = counters[`mesh.staticComponents.bin.${bin}.vertices`];
    assert.ok(Number.isInteger(count) && count >= 0);
    assert.ok(Number.isInteger(vertices) && vertices >= count * 2 ** bin);
    if (bin < 31) assert.ok(vertices <= count * (2 ** (bin + 1) - 1));
    components += count; componentVertices += vertices;
  }
  assert.equal(components, counters['mesh.staticComponents.count']);
  assert.equal(componentVertices, counters['mesh.staticComponents.vertices']);
  assert.equal(counters['mesh.staticComponents.halfedges'], 3 * counters['mesh.interface-faces']);
  assert.ok(counters['mesh.staticComponents.largestVertices'] <= componentVertices);
  assert.ok(counters['mesh.staticComponents.largestHalfedges'] <= counters['mesh.staticComponents.halfedges']);
  assert.equal(components === 0, componentVertices === 0);
  if (components) assert.ok(counters['mesh.staticComponents.largestVertices'] >= componentVertices / components);
  const transition = name => counters[`transitions.${name}`] ?? 0;
  assert.equal(transition('queries'), ['selfQueries', 'directHits', 'isolatedSourceFailures', 'isolatedTargetFailures',
    'disconnectedCacheHits', 'searchSuccesses', 'searchFailures'].reduce((sum, name) => sum + transition(name), 0));
  assert.equal(transition('searches'), transition('searchSuccesses') + transition('searchFailures'));
  assert.equal(transition('cachedSearchTransitions'), transition('searchSuccesses'));
  assert.equal(transition('cachedDisconnectedPairs'), transition('searchFailures'));
  assert.ok(transition('cachedPathHits') <= transition('directHits'));
  for (const key of ['tracing.joinSegments', 'tracing.join.secondaryScan', 'tracing.join.blockedRings',
    'tracing.join.merge', 'tracing.join.cleanup', 'tracing.finishAndAlign',
    'mesh.alpha.cpuMs', 'mesh.region.cpuMs', 'mapping.contextConstructionCpuMs',
    'clusters.orderedBfs', 'clusters.reorientAtoms', 'mesh.staticComponents.census'])
    assert.ok(Object.hasOwn(profile.timingsMs, key), key);
}

function checkGeogramWork(counters, prefix) {
  const get = name => counters[`${prefix}.${name}`];
  for (const name of ['pointAttempts', 'insertedPoints', 'orientCalls', 'orientExactFallbacks',
    'inSphereCalls', 'inSphereExactFallbacks'])
    assert.ok(Number.isInteger(get(name)) && get(name) >= 0, `${prefix}.${name}`);
  assert.ok(get('insertedPoints') <= get('pointAttempts'));
  assert.ok(get('orientExactFallbacks') <= get('orientCalls'));
  assert.ok(get('inSphereExactFallbacks') <= get('inSphereCalls'));
}

for (const suffix of ['', '-threaded']) {
  test(`DXA${suffix} profiling is optional, preserves output and resets after cancellation`, async () => {
    const { default: createDxa } = await import(`../src/analysis/dxa-kernel${suffix}.mjs`);
    let kernel, cancelMesh = false;
    const snapshots = [];
    kernel = await createDxa({
      wasmBinary: await readFile(new URL(`../src/analysis/dxa-kernel${suffix}.wasm`, import.meta.url)),
      dxaPoolSize: 0, onDxaProgress(phase) {
        if (cancelMesh && phase === 'Construct crystal interface mesh')
          Atomics.store(kernel.HEAP32, kernel._alloy_dxa_cancel_ptr() / 4, 1);
      },
    });
    const frame = crystalFrame('fcc', 4), xyz = dxaCartesianCoordinates(frame);
    const positions = kernel._malloc(xyz.byteLength), cell = kernel._malloc(96);
    assert.ok(positions && cell);
    kernel.HEAPF64.set(xyz, positions / 8); kernel.HEAPF64.set(frame.cell.vectors, cell / 8);
    kernel.HEAPF64.set(frame.cell.origin, cell / 8 + 9);
    const run = (trial = 14, stretch = 9) => {
      kernel._alloy_dxa_reset_cancel(); kernel._alloy_dxa_set_threads(1);
      const pointer = kernel._alloy_dxa_analyze(positions, xyz.length / 3, cell, 7, 1, trial, stretch, 0, 1, 2.5);
      if (!pointer) return null;
      const result = JSON.parse(kernel.UTF8ToString(pointer));
      kernel._alloy_dxa_dispose();
      return result;
    };
    try {
      const ordinary = run();
      assert.ok(ordinary);
      kernel.onDxaProfile = value => snapshots.push(value);
      assert.deepEqual(run(), ordinary, 'Diagnostics do not add fields or alter scientific or existing work-counter output.');
      assert.equal(snapshots.length, 1);
      const first = snapshots[0];
      checkProfile(first);
      checkGeogramWork(first.counters, 'geogram.bdel.work');
      for (const key of ['geogram.sort.total', 'geogram.sort.initializeShuffle', 'geogram.sort.hilbert',
        'geogram.bdel.allocateInitialize', 'geogram.bdel.bootstrap', 'geogram.bdel.insertion',
        'geogram.bdel.compact', 'geogram.bdel.remapCompact'])
        assert.ok(Object.hasOwn(first.timingsMs, key), key);
      for (const key of ['delaunay.inputPoints', 'delaunay.ghostPoints', 'delaunay.construct', 'mesh.classification'])
        assert.ok(Number.isFinite(first.timingsMs[key]) && first.timingsMs[key] >= 0, key);
      assert.equal(first.counters['delaunay.primaryPoints'], xyz.length / 3);
      assert.ok(first.counters['delaunay.totalCells'] > 0);
      assert.ok(first.counters['edges.retained_bytes'] > 0);
      cancelMesh = true;
      assert.equal(run(), null);
      assert.match(kernel.UTF8ToString(kernel._alloy_dxa_last_error()), /cancel/i);
      assert.equal(snapshots.length, 1, 'A failed extraction does not publish a partial success profile.');
      cancelMesh = false;
      assert.deepEqual(run(), ordinary);
      assert.equal(snapshots.length, 2);
      assert.deepEqual(snapshots[1].counters, first.counters, 'The new session does not accumulate the canceled session counters.');
      assert.deepEqual(run(100, 100), ordinary, 'An empty perfect crystal is unchanged at maximum admitted search depth.');
      assert.equal(snapshots.length, 3);
      checkProfile(snapshots[2], { trial: 100, stretch: 100 });
      assert.ok(Object.hasOwn(snapshots[2].counters, 'tracing.depth.200.extensionCalls'));
      assert.deepEqual(run(), ordinary);
      assert.deepEqual(snapshots[3].counters, first.counters, 'Returning to defaults drops all high-depth counters.');
      kernel.onDxaProfile = null;
      assert.deepEqual(run(), ordinary);
      assert.equal(snapshots.length, 4, 'Removing the callback disables diagnostics on the retained module.');
    } finally {
      kernel._alloy_dxa_dispose(); kernel._free(positions); kernel._free(cell);
      kernel.PThread?.terminateAllThreads();
    }
  });
}


test('true PDEL diagnostics aggregate worker-local work and reset across 1/2/4/1 threads', async () => {
  const { default: createDxa } = await import('../src/analysis/dxa-kernel-threaded.mjs');
  const snapshots = [];
  const kernel = await createDxa({
    wasmBinary: await readFile(new URL('../src/analysis/dxa-kernel-threaded.wasm', import.meta.url)),
    dxaPoolSize: 3, onDxaProfile: value => snapshots.push(value),
  });
  const frame = fccScrewFrame(), xyz = dxaCartesianCoordinates(frame);
  const positions = kernel._malloc(xyz.byteLength), cell = kernel._malloc(96);
  assert.ok(positions && cell);
  kernel.HEAPF64.set(xyz, positions / 8);
  kernel.HEAPF64.set(frame.cell.vectors, cell / 8);
  kernel.HEAPF64.set(frame.cell.origin, cell / 8 + 9);
  let serial;
  try {
    for (const threads of [1, 2, 4, 1]) {
      kernel._alloy_dxa_reset_cancel(); kernel._alloy_dxa_set_threads(threads);
      const pointer = kernel._alloy_dxa_analyze(positions, xyz.length / 3, cell, 4, 1, 14, 9, 0, 1, 2.5);
      assert.ok(pointer, kernel.UTF8ToString(kernel._alloy_dxa_last_error()));
      const science = JSON.parse(kernel.UTF8ToString(pointer));
      const profile = snapshots.at(-1);
      checkProfile(profile);
      assert.ok(profile.counters['tracing.primary.seeds'] > 0, 'Exercise real searches rather than only empty bulk.');
      assert.ok(profile.counters['tracing.primary.seedsWithSegment'] > 0);
      assert.ok(profile.counters['mesh.staticComponents.count'] > 0);
      assert.ok(profile.counters['transitions.queries'] > 0);
      if (threads === 1) {
        checkGeogramWork(profile.counters, 'geogram.bdel.work');
        assert.ok(!Object.keys(profile.counters).some(key => key.startsWith('geogram.pdel.')));
        if (serial) {
          assert.deepEqual(science, serial, 'Returning to BDEL keeps the complete science and existing work counters.');
          assert.deepEqual(profile.counters, snapshots[0].counters, 'No previous PDEL worker/depth state survives.');
        } else serial = science;
      } else {
        const counters = profile.counters;
        assert.equal(counters['geogram.pdel.workerCount'], threads);
        assert.equal(counters['geogram.pdel.outputCells'], counters['delaunay.totalCells']);
        checkGeogramWork(counters, 'geogram.pdel.work');
        const additive = ['pointAttempts', 'insertedPoints', 'alreadyPresentPoints', 'createdTetrahedra',
          'conflictVisitedCells', 'locateExactSteps', 'locateInexactSteps', 'orientCalls', 'orientExactFallbacks',
          'inSphereCalls', 'inSphereExactFallbacks', 'rollbacks', 'failedLocate', 'waitCalls', 'poolExhaustions'];
        for (let worker = 0; worker < threads; worker++)
          checkGeogramWork(counters, `geogram.pdel.worker.${worker}`);
        for (const name of additive) {
          const sum = Array.from({ length: threads }, (_, worker) => counters[`geogram.pdel.worker.${worker}.${name}`])
            .reduce((total, value) => total + value, 0);
          assert.equal(sum, counters[`geogram.pdel.work.${name}`], `${name}: every worker contributes exactly once.`);
        }
        assert.ok(profile.timingsMs['geogram.sort.total'] >= 0);
        assert.ok(profile.timingsMs['geogram.pdel.work.run'] >= 0);
        // PDEL may choose a different legal core polyline; strict science and
        // periodic-network equivalence are covered by the dedicated P1 suite.
        assert.deepEqual(science.atomStructureTypes, serial.atomStructureTypes);
      }
      kernel._alloy_dxa_dispose();
    }
    assert.equal(snapshots.length, 4);
  } finally {
    kernel._alloy_dxa_dispose(); kernel._free(positions); kernel._free(cell);
    kernel.PThread?.terminateAllThreads();
  }
});
