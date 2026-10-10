import assert from 'node:assert/strict';
import test from 'node:test';
import { GpuPrefetchScheduler, gpuPrefetchOrder } from '../src/data/gpu-prefetch.js';

test('GPU prefetch expands from the current frame and includes the full sequence when it fits', () => {
  assert.deepEqual(gpuPrefetchOrder(3, 7, 7), [3, 4, 2, 5, 1, 6, 0]);
  assert.deepEqual(gpuPrefetchOrder(3, 7, 4), [3, 4, 2, 5]);
  assert.deepEqual(gpuPrefetchOrder(0, 7, 3), [0, 1, 2]);
  assert.deepEqual(gpuPrefetchOrder(6, 7, 3), [6, 5, 4]);
  assert.deepEqual(gpuPrefetchOrder(0, 1, 0), [0]);
  assert.deepEqual(gpuPrefetchOrder(-1, 7, 3), []);
  assert.deepEqual(gpuPrefetchOrder(0, 0, 3), []);
});

test('GPU enable warms without a source; a displayed frame is uploaded before background reads', async () => {
  const pool = fakePool(6), reads = [], statuses = [];
  const scheduler = makeScheduler(pool, { reads, statuses });
  await scheduler.setEnabled(true);
  assert.deepEqual(pool.warmed, [[], undefined], 'the idle device compiles the general pipelines');
  assert.deepEqual(pool.uploads, []);
  assert.equal(statuses.at(-1).phase, 'ready');
  await scheduler.setFrame(source('A', 6, 2));
  assert.deepEqual(pool.uploads, [2, 3, 1, 4, 0, 5]);
  assert.deepEqual(reads, [3, 1, 4, 0, 5]);
  assert.equal(statuses.at(-1).phase, 'ready');
  assert.deepEqual(statuses.at(-1).cacheStatus.cachedFrameIndexes, [0, 1, 2, 3, 4, 5]);
});

test('prewarm follows the router: without the Voronoi kernel request it prepares uploads and general pipelines only', async () => {
  const pool = fakePool(3), calls = recordCalls(pool);
  const scheduler = makeScheduler(pool);
  scheduler.setFrame(source('HEA', 3, 1));
  await scheduler.setEnabled(true);
  assert.deepEqual(calls, [{ kind: 'warm', analyses: [] }, { kind: 'prepare', index: 1, analyses: undefined },
    { kind: 'prepare', index: 2, analyses: undefined }, { kind: 'prepare', index: 0, analyses: undefined },
    { kind: 'warm', analyses: undefined }]);
  assert.deepEqual(pool.preparations, [], 'no Voronoi index, workspace or kernel warmup');
  assert.deepEqual(pool.uploads, [1, 2, 0]);
  calls.length = 0;
  await scheduler.setFrame(source('HEA', 3, 1));
  assert.deepEqual(calls.filter(call => call.kind === 'prepare'), [], 'a resident frame is not uploaded again');
});

test('requesting the Voronoi kernel restarts preparation for it; radical radii add the radical clip kernel', async () => {
  const pool = fakePool(2), calls = recordCalls(pool);
  const scheduler = makeScheduler(pool);
  scheduler.setFrame(source('HEA', 2, 0));
  await scheduler.setEnabled(true);
  assert.deepEqual(pool.preparations, []);
  calls.length = 0;
  await scheduler.setAnalysisKinds(['voronoi']);
  assert.deepEqual(calls[0], { kind: 'warm', analyses: ['voronoi'] });
  assert.deepEqual(calls[1], { kind: 'prepare', index: 0, analyses: ['voronoi'] });
  assert.deepEqual(pool.preparations, [0]);
  assert.deepEqual(pool.uploads, [0, 1], 'resident coordinates are reused');
  const unchanged = scheduler.pending;
  assert.equal(scheduler.setAnalysisKinds(['voronoi']), unchanged, 'an unchanged request does not restart');
  calls.length = 0;
  await scheduler.setAnalysisKinds(['voronoi', 'voronoiRadical']);
  assert.deepEqual(calls[0], { kind: 'warm', analyses: ['voronoi', 'voronoiRadical'] });
  assert.deepEqual(calls.filter(call => call.kind === 'prepare'), [], 'the frame preparation is already resident');
  calls.length = 0;
  await scheduler.setAnalysisKinds([]);
  assert.deepEqual(calls.map(call => call.analyses), [[], undefined]);
  await scheduler.setFrame(source('HEA', 2, 1));
  assert.deepEqual(pool.preparations, [0], 'later frames are not prepared for Voronoi');
});

test('a disabled scheduler records the requested kinds without starting a device', async () => {
  const pool = fakePool(2), scheduler = makeScheduler(pool);
  await scheduler.setAnalysisKinds(['voronoi']);
  assert.deepEqual(pool.warmed, []);
  scheduler.setFrame(source('HEA', 1, 0));
  await scheduler.setEnabled(true);
  assert.deepEqual(pool.warmed, [['voronoi'], undefined]); assert.deepEqual(pool.preparations, [0]);
});

test('playback uploads each frame at once and builds Voronoi inputs only for a frame that stays displayed', async () => {
  const pool = fakePool(4), calls = recordCalls(pool), waits = [];
  const scheduler = new GpuPrefetchScheduler({ pool, getFrame: async index => ({ index }), yieldBackground: async () => {},
    settlePlayback: () => { const wait = deferred(); waits.push(wait); return wait.promise; } });
  await scheduler.setAnalysisKinds(['voronoi']);
  scheduler.setFrame({ ...source('traj', 4, 0), playing: true });
  const first = scheduler.setEnabled(true);
  await until(() => pool.uploads.length === 4);
  assert.equal(waits.length, 1); assert.deepEqual(pool.preparations, [], 'the Voronoi preparation waits');
  assert.deepEqual(calls.filter(call => call.kind === 'prepare')[0], { kind: 'prepare', index: 0, analyses: undefined });
  const second = scheduler.setFrame({ ...source('traj', 4, 1), playing: true });
  waits[0].resolve(); await first;
  assert.deepEqual(pool.preparations, [], 'a replaced frame is never prepared');
  await until(() => waits.length === 2);
  waits[1].resolve(); await second;
  assert.deepEqual(pool.preparations, [1], 'the frame that stays displayed is prepared');
  // A frame shown outside playback is prepared at once.
  await scheduler.setFrame(source('traj', 4, 2));
  assert.equal(waits.length, 2); assert.deepEqual(pool.preparations, [1, 2]);
  // The same frame becomes current again when playback stops on it.
  const playing = scheduler.setFrame({ ...source('traj', 4, 3), playing: true });
  await until(() => waits.length === 3);
  const stopped = scheduler.setFrame({ ...scheduler.source, playing: false });
  assert.notEqual(stopped, playing); await stopped;
  assert.deepEqual(pool.preparations, [1, 2, 3]);
});

test('playback without the Voronoi kernel request never waits', async () => {
  const pool = fakePool(2), waits = [];
  const scheduler = new GpuPrefetchScheduler({ pool, getFrame: async index => ({ index }), yieldBackground: async () => {},
    settlePlayback: () => { waits.push(1); return new Promise(() => {}); } });
  scheduler.setFrame({ ...source('traj', 2, 0), playing: true });
  await scheduler.setEnabled(true);
  assert.deepEqual(pool.uploads, [0, 1]); assert.equal(waits.length, 0);
});

test('capacity is chosen after the first upload and a bounded GPU window never reads the rest', async () => {
  const pool = fakePool(3), reads = [];
  const scheduler = makeScheduler(pool, { reads });
  scheduler.setFrame(source('A', 100, 50));
  await scheduler.setEnabled(true);
  assert.deepEqual(pool.uploads, [50, 51, 49]);
  assert.deepEqual(reads, [51, 49]);
});

test('already resident GPU frames do not need CPU reparse on later visits', async () => {
  const pool = fakePool(5), reads = [];
  const scheduler = makeScheduler(pool, { reads });
  scheduler.setAnalysisKinds(['voronoi']);
  scheduler.setFrame(source('A', 5, 0));
  await scheduler.setEnabled(true);
  const uploadCount = pool.uploads.length, readCount = reads.length;
  await scheduler.setFrame(source('A', 5, 4));
  assert.equal(pool.uploads.length, uploadCount);
  assert.equal(reads.length, readCount);
  assert.deepEqual(pool.preparations, [0, 4], 'visiting a coordinate-only cached frame still prepares its analysis inputs');
});

test('a requested Voronoi kernel is warmed first and reuses prepared indices, not just uploaded coordinates', async () => {
  const pool = fakePool(3), calls = recordCalls(pool);
  const scheduler = makeScheduler(pool);
  scheduler.setAnalysisKinds(['voronoi']);
  scheduler.setFrame(source('HEA', 3, 1));
  await scheduler.setEnabled(true);
  assert.deepEqual(calls[0], { kind: 'warm', analyses: ['voronoi'] });
  assert.deepEqual(calls[1], { kind: 'prepare', index: 1, analyses: ['voronoi'] });
  assert.deepEqual(pool.preparations, [1]);
  assert.equal(calls.at(-1).kind, 'warm');
  assert.equal(calls.at(-1).analyses, undefined, 'remaining analyses warm after the current-frame inputs');
  await scheduler.setFrame(source('HEA', 3, 1));
  assert.deepEqual(pool.preparations, [1], 'valid prepared analysis inputs are not rebuilt on repeat visits');
});

test('GPU-off structure loading does not start a device, pipeline, or frame upload', async () => {
  const pool = fakePool(3), scheduler = makeScheduler(pool);
  await scheduler.setFrame(source('HEA', 3, 0));
  assert.equal(pool.warmups, 0);
  assert.deepEqual(pool.uploads, []);
  assert.deepEqual(pool.preparations, []);
});

test('finishing a source load joins the same in-flight frame preparation instead of cancelling it', async () => {
  const pool = fakePool(3), started = deferred(), release = deferred();
  const prepare = pool.prepareGpuFrame.bind(pool);
  let preparationSignal;
  pool.prepareGpuFrame = async (frame, options) => {
    preparationSignal = options.signal; started.resolve(); await release.promise;
    return prepare(frame, options);
  };
  const scheduler = makeScheduler(pool), committed = source('HEA', 1, 0);
  scheduler.setFrame(committed);
  const pending = scheduler.setEnabled(true);
  await started.promise;
  assert.equal(scheduler.setFrame(committed), pending);
  assert.equal(preparationSignal.aborted, false);
  release.resolve(); await pending;
  assert.deepEqual(pool.preparations, []);
  assert.deepEqual(pool.uploads, [0]);
});

test('source preflight pauses background work while preserving resident frames for a rejected selection', async () => {
  const pool = fakePool(3), reads = [];
  let clears = 0;
  pool.clearGpuFrames = async () => { clears += 1; throw new Error('Preflight must retain the current source.'); };
  const scheduler = makeScheduler(pool, { reads });
  scheduler.setFrame(source('original', 3, 0));
  await scheduler.setEnabled(true);
  const resident = pool.gpuCacheStatus.cachedFrameIndexes;
  const warmups = pool.warmups, uploadCount = pool.uploads.length;
  scheduler.pause();
  await scheduler.setEnabled(true);
  assert.equal(clears, 0);
  assert.equal(pool.warmups, warmups);
  assert.deepEqual(pool.gpuCacheStatus.cachedFrameIndexes, resident);
  await scheduler.setFrame(source('original:next-selection-request', 3, 0));
  assert.equal(pool.uploads.length, uploadCount);
  assert.equal(clears, 0);
  assert.equal(scheduler.paused, false);
});

test('jump aborts old work and ignores a parser reply already in flight', async () => {
  const pool = fakePool(3), readStarted = deferred(), parsed = deferred();
  let oldSignal;
  const scheduler = new GpuPrefetchScheduler({ pool, yieldBackground: async () => {},
    getFrame: async (index, { signal }) => {
      if (index === 1) { oldSignal = signal; readStarted.resolve(); return parsed.promise; }
      return { index };
    },
  });
  scheduler.setFrame(source('A', 10, 0));
  const previous = scheduler.setEnabled(true);
  await readStarted.promise;
  await scheduler.setFrame(source('A', 10, 8));
  assert.equal(oldSignal.aborted, true);
  parsed.resolve({ index: 1 });
  await previous;
  assert.deepEqual(pool.uploads, [0, 8, 9, 7]);
});

test('source invalidation waits for device-retaining clear and ignores old replies', async () => {
  const pool = fakePool(3), readStarted = deferred(), parsed = deferred(), cleared = deferred();
  const statuses = [];
  pool.clearGpuFrames = async () => {
    await cleared.promise;
    pool.gpuCacheStatus = { capacity: 1, frameCount: 0, cachedFrameIndexes: [] };
    return pool.gpuCacheStatus;
  };
  const scheduler = new GpuPrefetchScheduler({ pool, onStatus: status => statuses.push(status), yieldBackground: async () => {},
    getFrame: async (index, { sourceKey }) => {
      if (sourceKey === 'A') { readStarted.resolve(); return parsed.promise; }
      return { index };
    },
  });
  scheduler.setFrame(source('A', 3, 0));
  const oldRun = scheduler.setEnabled(true);
  await readStarted.promise;
  const clearing = scheduler.clearSource();
  const newRun = scheduler.setFrame(source('B', 2, 1));
  await Promise.resolve();
  assert.deepEqual(pool.uploads, [0]);
  parsed.resolve({ index: 1 });
  await oldRun;
  cleared.resolve();
  await Promise.all([clearing, newRun]);
  assert.deepEqual(pool.uploads, [0, 1, 0]);
  assert.deepEqual(statuses.at(-1).cacheStatus.cachedFrameIndexes, [0, 1]);
});

test('rapid off/on toggles suppress old warmup replies and do not upload old frames', async () => {
  const pool = fakePool(2), warming = deferred(), warmed = deferred(), statuses = [];
  let warmups = 0;
  pool.warmupGpu = async () => {
    warmups += 1;
    if (warmups === 1) { warming.resolve(); await warmed.promise; }
    return pool.gpuCacheStatus;
  };
  const scheduler = makeScheduler(pool, { statuses });
  scheduler.setFrame(source('A', 4, 0));
  const obsolete = scheduler.setEnabled(true);
  await warming.promise;
  await scheduler.setEnabled(false);
  scheduler.setFrame(source('A', 4, 3));
  await scheduler.setEnabled(true);
  const statusCount = statuses.length;
  warmed.resolve();
  await obsolete;
  assert.equal(statuses.length, statusCount);
  assert.deepEqual(pool.uploads, [3, 2]);
});

test('foreground analysis preemption retries preparation after foreground work', async () => {
  const pool = fakePool(2), prepare = pool.prepareGpuFrame.bind(pool);
  let preempt = true, yields = 0;
  pool.prepareGpuFrame = async (...args) => {
    if (preempt) { preempt = false; throw new DOMException('Foreground analysis arrived.', 'AbortError'); }
    return prepare(...args);
  };
  const scheduler = new GpuPrefetchScheduler({ pool, getFrame: async index => ({ index }),
    yieldBackground: async () => { yields += 1; },
  });
  scheduler.setFrame(source('A', 2, 0));
  await scheduler.setEnabled(true);
  assert.deepEqual(pool.uploads, [0, 1]);
  assert.equal(yields, 2);
});

test('device failures settle in a visible unavailable state without generating results', async () => {
  const pool = fakePool(3), statuses = [];
  pool.warmupGpu = async () => { throw new Error('No WebGPU adapter.'); };
  const scheduler = makeScheduler(pool, { statuses });
  scheduler.setFrame(source('A', 3, 0));
  await scheduler.setEnabled(true);
  assert.deepEqual(statuses.at(-1), { phase: 'unavailable', error: 'No WebGPU adapter.' });
  assert.deepEqual(pool.uploads, []);
});

function source(sourceKey, frameCount, currentIndex) {
  return { sourceKey, frameCount, currentIndex, frame: { index: currentIndex } };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(test) {
  for (let attempt = 0; attempt < 200; attempt++) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 0)); }
  assert.fail('timed out');
}

function recordCalls(pool) {
  const calls = [], warmup = pool.warmupGpu.bind(pool), prepare = pool.prepareGpuFrame.bind(pool);
  pool.warmupGpu = async options => { calls.push({ kind: 'warm', analyses: options.analysisKinds }); return warmup(options); };
  pool.prepareGpuFrame = async (frame, options) => {
    calls.push({ kind: 'prepare', index: options.frameIndex, analyses: options.analysisKinds });
    return prepare(frame, options);
  };
  return calls;
}

function makeScheduler(pool, { reads = [], statuses = [] } = {}) {
  return new GpuPrefetchScheduler({ pool, onStatus: status => statuses.push(status),
    getFrame: async index => { reads.push(index); return { index }; }, yieldBackground: async () => {},
  });
}

function fakePool(capacity) {
  return {
    uploads: [], preparations: [], warmups: 0, warmed: [],
    gpuCacheStatus: { capacity: 1, frameCount: 0, cachedFrameIndexes: [] },
    async warmupGpu({ analysisKinds } = {}) { this.warmups += 1; this.warmed.push(analysisKinds); return this.gpuCacheStatus; },
    async configureGpuCache({ frameCount, currentIndex }) {
      this.gpuCacheStatus = { ...this.gpuCacheStatus, frameCount, currentIndex };
      return this.gpuCacheStatus;
    },
    async prepareGpuFrame(frame, { frameIndex, signal, analysisKinds }) {
      assert.equal(signal.aborted, false);
      assert.equal(frame.index, frameIndex);
      if (!this.gpuCacheStatus.cachedFrameIndexes.includes(frameIndex)) this.uploads.push(frameIndex);
      if (analysisKinds?.includes('voronoi')) this.preparations.push(frameIndex);
      this.gpuCacheStatus = { ...this.gpuCacheStatus, capacity,
        fullTrajectory: capacity >= this.gpuCacheStatus.frameCount,
        preparedVoronoiFrameIndexes: [...new Set([...(this.gpuCacheStatus.preparedVoronoiFrameIndexes ?? []),
          ...(analysisKinds?.includes('voronoi') ? [frameIndex] : [])])],
        cachedFrameIndexes: [...new Set([...this.gpuCacheStatus.cachedFrameIndexes, frameIndex])].sort((a, b) => a - b) };
      return this.gpuCacheStatus;
    },
    async clearGpuFrames() {
      this.gpuCacheStatus = { ...this.gpuCacheStatus, cachedFrameIndexes: [], preparedVoronoiFrameIndexes: [] };
      return this.gpuCacheStatus;
    },
  };
}
