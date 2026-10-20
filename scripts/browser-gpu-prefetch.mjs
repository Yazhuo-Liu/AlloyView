import assert from 'node:assert/strict';
import { withWebGpuBrowser, useSoftwareAdapter } from './webgpu-browser.mjs';

const report = await withWebGpuBrowser(async ({ evaluate, adapter }) => ({ adapter,
  ...await evaluate(`(${run.toString()})()`),
}), { software: useSoftwareAdapter(true) });
assert.deepEqual(report.initial.reads, [81, 79, 82, 78]);
assert.deepEqual(report.initial.indexes, [78, 79, 80, 81, 82]);
assert.equal(report.initial.hostFrames, 1);
assert.equal(report.restoredInput, true);
assert.equal(report.retainedUpload, true);
assert.equal(report.selectedHostPrewarmed, true);
assert.equal(report.exactCoordination, true);
assert.equal(report.exactDisplacements, true);
assert.equal(report.referenceReused, true);
assert.equal(report.cancelledReadDiscarded, true);
assert.equal(report.workerAndWarmupRetained, true);
assert.equal(report.sourceArraysUnchanged, true);
assert.equal(report.pendingAfterClear, 0);
console.log(JSON.stringify(report, null, 2));

async function run() {
  const [{ GpuAnalysisClient }, { GpuPrefetchScheduler }, { crystalFrame }, { fractionalToCartesian },
    { prepareDisplacements, computeDisplacements }] = await Promise.all([
    import('./src/analysis/gpu/client.js'), import('./src/data/gpu-prefetch.js'), import('./tests/helpers/crystals.js'),
    import('./src/data/model.js'), import('./src/analysis/displacement.js'),
  ]);
  const template = crystalFrame('fcc', 4), sourceKey = 'prefetch-browser-fixture', frameCount = 160;
  const makeFrame = index => {
    const fractional = Float64Array.from(template.fractional, (value, offset) => value + (offset % 3 === 0 ? index / 100_000 : 0));
    return { ...template, fractional, positions: fractionalToCartesian(fractional, template.cell), types: template.types.slice(),
      ids: template.ids.slice(), properties: [] };
  };
  const client = new GpuAnalysisClient(), reads = [], statuses = [];
  const pool = {
    get gpuCacheStatus() { return client.cacheStatus; },
    warmupGpu: options => client.warmup(options), configureGpuCache: options => client.configureCache(options),
    prepareGpuFrame: (frame, options) => client.prepareFrame(frame, options), clearGpuFrames: () => client.clearFrames(),
  };
  let holdIndex = null, releaseRead, enteredRead;
  const scheduler = new GpuPrefetchScheduler({ pool, onStatus: value => statuses.push(value), yieldBackground: async () => {},
    getFrame: async (index, { signal }) => {
      reads.push(index);
      if (index === holdIndex) {
        enteredRead();
        await new Promise(resolve => { releaseRead = resolve; });
        if (!signal.aborted) throw new Error('Replaced speculative read did not receive cancellation.');
      }
      return makeFrame(index);
    },
  });
  const setFrame = (index, frame = makeFrame(index)) => scheduler.setFrame({ sourceKey, frameCount, currentIndex: index, frame });
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const assertBounded = () => {
    const status = client.cacheStatus;
    check(status.cachedFrameIds.length <= 5, 'Idle GPU residency escaped the five-frame window.');
    check(status.hostFrameIds.length <= 2, 'Idle Worker retained unrelated CPU inputs.');
    check(status.allocatedBytes <= status.budgetBytes, 'GPU allocations exceeded their budget.');
  };
  try {
    await setFrame(80);
    await scheduler.setEnabled(true);
    const initial = { reads: [...reads], indexes: client.cacheStatus.cachedFrameIndexes,
      hostFrames: client.cacheStatus.hostFrameIds.length, hostInputBytes: client.cacheStatus.hostInputBytes,
      residentBytes: client.cacheStatus.residentBytes, budgetBytes: client.cacheStatus.budgetBytes };
    const worker = client.worker, pipelines = client.cacheStatus.pipelineCount;
    const moved = makeFrame(81), coordinates = moved.fractional.slice(), positions = moved.positions.slice(), types = moved.types.slice();
    const analyzed = await client.analyze(moved, { kind: 'coordination', cutoff: 3.1 }, { frameIndex: 81 });
    const restoredInput = analyzed.inputReused === false, retainedUpload = analyzed.gpuInputReused === true;
    const exactCoordination = analyzed.coordination.every(value => value === 12);
    await setFrame(81, moved);
    check(client.cacheStatus.cachedFrameIndexes.join() === '79,80,81,82,83', 'Moving current frame did not slide the window.');
    assertBounded();

    // Selecting a GPU-only frame prewarms its host correction input too, so
    // the subsequent foreground analysis needs neither transfer nor upload.
    const selected = makeFrame(82);
    await setFrame(82, selected);
    const selectedResult = await client.analyze(selected, { kind: 'coordination', cutoff: 3.1 }, { frameIndex: 82 });
    const selectedHostPrewarmed = selectedResult.inputReused && selectedResult.gpuInputReused;
    await setFrame(81, moved);

    // An out-of-window reference must remain pinned through both GPU kernels,
    // then the next analysis may reuse its CPU correction/Cartesian inputs.
    const reference = makeFrame(5), prepared = await prepareDisplacements(moved, reference);
    const parameters = { kind: 'displacement', ...prepared, referenceFrameIndex: 5 };
    const expected = await computeDisplacements(moved, reference);
    const first = await client.analyze(moved, parameters, { frameIndex: 81 });
    const repeated = await client.analyze(moved, parameters, { frameIndex: 81 });
    const exactDisplacements = first.vectors.every((value, index) => Object.is(value, expected.vectors[index]))
      && repeated.vectors.every((value, index) => Object.is(value, expected.vectors[index]));
    const referenceReused = repeated.inputReused && repeated.referenceInputReused && repeated.gpuInputReused;
    check(client.cacheStatus.hostFrameIds.length === 2, 'Current and reference inputs were not retained for reuse.');
    assertBounded();

    // Switch frames while a parser read is outstanding. The read completes,
    // but its old upload must never join the new source window.
    holdIndex = 121;
    const entered = new Promise(resolve => { enteredRead = resolve; });
    const old = setFrame(120);
    await entered;
    const replacement = setFrame(140);
    releaseRead();
    await Promise.all([old, replacement]);
    const cancelledReadDiscarded = !client.cacheStatus.cachedFrameIndexes.includes(121)
      && client.cacheStatus.cachedFrameIndexes.join() === '138,139,140,141,142';
    assertBounded();
    const sourceArraysUnchanged = moved.fractional.every((value, index) => Object.is(value, coordinates[index]))
      && moved.positions.every((value, index) => Object.is(value, positions[index]))
      && moved.types.every((value, index) => value === types[index]);
    await scheduler.clearSource();
    await scheduler.pending;
    check(client.cacheStatus.cachedFrameIds.length === 0 && client.cacheStatus.hostFrameIds.length === 0,
      'Source barrier did not release GPU and Worker input residency.');
    const workerAndWarmupRetained = client.worker === worker && client.warmedUp
      && client.cacheStatus.pipelineCount >= pipelines;
    check(!statuses.some(status => status?.phase === 'unavailable'), 'GPU preparation unexpectedly became unavailable.');
    return { atoms: template.types.length, frames: frameCount, initial, restoredInput, retainedUpload, selectedHostPrewarmed, exactCoordination,
      exactDisplacements, referenceReused, cancelledReadDiscarded, workerAndWarmupRetained, sourceArraysUnchanged,
      pendingAfterClear: client.pending.size, finalCacheStatus: client.cacheStatus,
      note: 'Real WebGPU verifies residency, precision, reference pins and source cancellation. SwiftShader timings do not measure physical GPU speed.' };
  } finally { scheduler.pause(); client.close(); }
}
