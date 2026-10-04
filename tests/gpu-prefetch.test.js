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
  assert.equal(pool.warmups, 1);
  assert.deepEqual(pool.uploads, []);
  assert.equal(statuses.at(-1).phase, 'ready');
  await scheduler.setFrame(source('A', 6, 2));
  assert.deepEqual(pool.uploads, [2, 3, 1, 4, 0, 5]);
  assert.deepEqual(reads, [3, 1, 4, 0, 5]);
  assert.equal(statuses.at(-1).phase, 'ready');
  assert.deepEqual(statuses.at(-1).cacheStatus.cachedFrameIndexes, [0, 1, 2, 3, 4, 5]);
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
  scheduler.setFrame(source('A', 5, 0));
  await scheduler.setEnabled(true);
  const uploadCount = pool.uploads.length, readCount = reads.length;
  await scheduler.setFrame(source('A', 5, 4));
  assert.equal(pool.uploads.length, uploadCount);
  assert.equal(reads.length, readCount);
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

function makeScheduler(pool, { reads = [], statuses = [] } = {}) {
  return new GpuPrefetchScheduler({ pool, onStatus: status => statuses.push(status),
    getFrame: async index => { reads.push(index); return { index }; }, yieldBackground: async () => {},
  });
}

function fakePool(capacity) {
  return {
    uploads: [], warmups: 0,
    gpuCacheStatus: { capacity: 1, frameCount: 0, cachedFrameIndexes: [] },
    async warmupGpu() { this.warmups += 1; return this.gpuCacheStatus; },
    async configureGpuCache({ frameCount, currentIndex }) {
      this.gpuCacheStatus = { ...this.gpuCacheStatus, frameCount, currentIndex };
      return this.gpuCacheStatus;
    },
    async prepareGpuFrame(frame, { frameIndex, signal }) {
      assert.equal(signal.aborted, false);
      assert.equal(frame.index, frameIndex);
      this.uploads.push(frameIndex);
      this.gpuCacheStatus = { ...this.gpuCacheStatus, capacity,
        fullTrajectory: capacity >= this.gpuCacheStatus.frameCount,
        cachedFrameIndexes: [...new Set([...this.gpuCacheStatus.cachedFrameIndexes, frameIndex])].sort((a, b) => a - b) };
      return this.gpuCacheStatus;
    },
    async clearGpuFrames() {
      this.gpuCacheStatus = { ...this.gpuCacheStatus, cachedFrameIndexes: [] };
      return this.gpuCacheStatus;
    },
  };
}
