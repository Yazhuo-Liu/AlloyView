/** Keep the displayed frame first, then expand into adjacent trajectory frames. */
export function gpuPrefetchOrder(currentIndex, frameCount, capacity) {
  const count = Math.max(0, Math.trunc(frameCount));
  if (!count || !Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= count) return [];
  const limit = Math.min(count, Math.max(1, Math.trunc(capacity) || 1));
  const indices = [currentIndex];
  for (let distance = 1; indices.length < limit; distance += 1) {
    if (currentIndex + distance < count) indices.push(currentIndex + distance);
    if (indices.length >= limit) break;
    if (currentIndex - distance >= 0) indices.push(currentIndex - distance);
  }
  return indices;
}

/** Preparation never computes analysis results and never owns the CPU cache.
 * One frame read/upload at a time limits temporary host memory. Cancellation
 * invalidates reads which the parser must finish for trajectory continuity.
 */
export class GpuPrefetchScheduler {
  constructor({ pool, getFrame, onStatus = () => {}, yieldBackground = () => new Promise(resolve => setTimeout(resolve, 40)) }) {
    this.pool = pool;
    this.getFrame = getFrame;
    this.onStatus = onStatus;
    this.yieldBackground = yieldBackground;
    this.enabled = false;
    this.paused = false;
    this.source = null;
    this.generation = 0;
    this.controller = null;
    this.running = false;
    this.clearBarrier = Promise.resolve();
    this.pending = Promise.resolve();
  }

  setEnabled(enabled) {
    if (this.enabled === Boolean(enabled)) return this.pending;
    this.enabled = Boolean(enabled);
    return this.restart();
  }

  setFrame({ sourceKey, frameCount, currentIndex, frame }) {
    if (this.enabled && !this.paused && this.running && this.source?.sourceKey === sourceKey
        && this.source.frameCount === frameCount && this.source.currentIndex === currentIndex
        && this.source.frame === frame) return this.pending;
    this.paused = false;
    this.source = { sourceKey, frameCount, currentIndex, frame };
    return this.restart();
  }

  cancel() {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.running = false;
  }

  pause() {
    this.paused = true;
    this.cancel();
  }

  clearSource() {
    this.cancel();
    this.source = null;
    this.paused = false;
    this.onStatus(null);
    // Clear is enqueued immediately. Subsequent source preparation waits for
    // its reply, so a late upload from the previous source cannot survive.
    this.clearBarrier = this.pool.clearGpuFrames().catch(() => null);
    // Continue device preparation while the next source is being indexed.
    // Source changes retain device/pipeline resources, so this is often free.
    if (this.enabled) this.restart();
    return this.clearBarrier;
  }

  restart() {
    this.cancel();
    if (!this.enabled) {
      this.onStatus(null);
      this.pending = Promise.resolve();
      return this.pending;
    }
    if (this.paused) {
      this.pending = Promise.resolve();
      return this.pending;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.running = true;
    const generation = this.generation;
    const source = this.source;
    const current = () => this.enabled && generation === this.generation && !controller.signal.aborted;
    const report = (phase, cacheStatus) => {
      if (current()) this.onStatus({ phase, cacheStatus });
    };
    this.pending = this.run(source, controller.signal, current, report).catch(error => {
      if (current() && error.name !== 'AbortError') this.onStatus({ phase: 'unavailable', error: error.message });
    }).finally(() => {
      if (this.controller === controller) {
        this.controller = null;
        this.running = false;
      }
    });
    return this.pending;
  }

  async run(source, signal, current, report) {
    report('warming');
    await this.clearBarrier;
    if (!current()) return;
    // Prepare the next expensive analysis before compiling every unrelated
    // pipeline. Source changes can interrupt the later general warmup.
    let status = await this.retryPreparation(() => this.pool.warmupGpu({ signal, analysisKinds: ['voronoi'] }), current);
    if (!current()) return;
    if (!source || !source.frameCount || !source.frame) {
      report('ready', status);
      return;
    }
    status = await this.pool.configureGpuCache({ frameCount: source.frameCount, currentIndex: source.currentIndex });
    if (!current()) return;
    report('preparing', status);
    // Uploaded coordinates alone do not establish a resident neighbour index
    // or Voronoi workspace. Prepare those even for a prefetched trajectory
    // frame, unless the runtime confirms they still survive cache eviction.
    if (!status?.preparedVoronoiFrameIndexes?.includes(source.currentIndex)) {
      status = await this.retryPreparation(() => this.pool.prepareGpuFrame(source.frame,
        { frameIndex: source.currentIndex, signal, analysisKinds: ['voronoi'] }), current);
      if (!current()) return;
      report('preparing', status);
    }
    const targets = gpuPrefetchOrder(source.currentIndex, source.frameCount, status?.capacity);
    for (const index of targets.slice(1)) {
      if (!current()) return;
      status = this.pool.gpuCacheStatus ?? status;
      if (!gpuPrefetchOrder(source.currentIndex, source.frameCount, status?.capacity).includes(index)) break;
      if (status?.cachedFrameIndexes?.includes(index)) continue;
      await this.yieldBackground();
      if (!current()) return;
      const frame = await this.getFrame(index, { signal, sourceKey: source.sourceKey });
      if (!current() || !frame) return;
      status = await this.retryPreparation(() => this.pool.prepareGpuFrame(frame, { frameIndex: index, signal }), current);
      if (!current()) return;
      report('preparing', status);
      // Variable atom counts or allocation pressure can reduce capacity after
      // another upload. Leave only the nearest surviving window to prepare.
      if (!gpuPrefetchOrder(source.currentIndex, source.frameCount, status?.capacity).includes(index)) break;
    }
    if (current()) report('ready', status);
    if (!current()) return;
    // Remaining analyses also benefit from reuse. This job stays background
    // priority and yields its queue immediately to foreground calculations.
    await this.retryPreparation(() => this.pool.warmupGpu({ signal }), current);
  }

  async retryPreparation(prepare, current) {
    while (current()) {
      try { return await prepare(); }
      catch (error) {
        if (error.name !== 'AbortError' || !current()) throw error;
        // Foreground analysis can preempt preparation without invalidating
        // this source. Requeue after it, preserving the selected frame order.
        await this.yieldBackground();
      }
    }
    return null;
  }
}
