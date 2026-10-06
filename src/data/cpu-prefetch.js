/** Prepare reusable modules and resident analysis inputs without publishing
 * analysis results. Physical replication grows the preparation target;
 * additional periodic images used for display do not.
 */
export class CpuPrefetchScheduler {
  constructor({ pool, dxaClient, onStatus = () => {},
    yieldBackground = () => new Promise(resolve => setTimeout(resolve, 40)) }) {
    this.pool = pool;
    this.dxaClient = dxaClient;
    this.onStatus = onStatus;
    this.yieldBackground = yieldBackground;
    this.generation = 0;
    this.controller = null;
    this.controllers = new Set();
    this.sourceKey = null;
    this.targetAtomCount = 0;
    this.preparedAtomCount = 0;
    this.pending = Promise.resolve();
    this.frameController = null;
    this.frameGeneration = 0;
    this.preparingFrame = null;
    this.framePending = Promise.resolve();
  }

  warmModules({ sourceKey } = {}) {
    return this.setAtomCount({ sourceKey, atomCount: 1 });
  }

  setFrame({ sourceKey, frame }) {
    if (!frame) return this.pending;
    if (sourceKey !== this.sourceKey) {
      this.cancel();
      this.sourceKey = sourceKey;
    }
    // Start the coordinate snapshot/index preparation before growing other
    // pools. DXA startup can reserve the entire shared thread budget, so let
    // the displayed frame obtain its resident Voronoi inputs first.
    const preparation = this.prepareFrame(frame);
    const resources = this.setAtomCount({ sourceKey,
      atomCount: frame.ids?.length ?? frame.fractional?.length / 3,
      checkResources: true, beforeDxa: preparation });
    return preparation ? Promise.all([resources, preparation]) : resources;
  }

  prepareFrame(frame) {
    if (typeof this.pool.prepareCpuFrame !== 'function') return null;
    if (this.preparingFrame === frame && this.frameController && !this.frameController.signal.aborted) return this.framePending;
    this.frameController?.abort();
    const controller = new AbortController();
    this.frameController = controller;
    this.preparingFrame = frame;
    const generation = ++this.frameGeneration;
    const current = () => generation === this.frameGeneration && !controller.signal.aborted;
    const report = progress => {
      if (current()) this.onStatus({ phase: 'preparing', backend: 'voronoi',
        atomCount: frame.ids?.length ?? frame.fractional?.length / 3, progress });
    };
    this.framePending = (async () => {
      try {
        while (current()) {
          try {
            const status = await this.pool.prepareCpuFrame(frame, { kind: 'voronoi',
              signal: controller.signal, onProgress: report });
            return { backend: 'voronoi', status };
          } catch (error) {
            if (error.name !== 'AbortError' || !current()) throw error;
            await this.yieldBackground();
          }
        }
        return { backend: 'voronoi' };
      } catch (error) {
        return { backend: 'voronoi', error };
      } finally {
        if (this.frameController === controller) this.frameController = null;
      }
    })();
    return this.framePending;
  }

  setAtomCount({ sourceKey = this.sourceKey, atomCount, signal, checkResources = false, beforeDxa = null }) {
    const count = Math.trunc(atomCount);
    if (!Number.isSafeInteger(count) || count < 1 || signal?.aborted) return this.pending;
    if (sourceKey !== this.sourceKey) {
      this.cancel();
      this.sourceKey = sourceKey;
    }
    // A smaller trajectory frame needs no additional threads. Leave a larger
    // preparation in progress rather than cancelling it on every frame visit.
    if (count <= this.targetAtomCount && this.controller && !this.controller.signal.aborted) return this.pending;
    // A foreground failure/cancel can remove an ordinary Worker after this
    // target was prepared. Frame visits cheaply check actual pool readiness.
    if (count <= this.preparedAtomCount && !checkResources && !this.controller?.signal.aborted) return this.pending;
    // Growing the target joins the backends' existing warmup sessions instead
    // of aborting module initialization and starting it again for replication.
    this.generation += 1;
    this.targetAtomCount = count;
    const controller = new AbortController();
    this.controller = controller;
    this.controllers.add(controller);
    const generation = this.generation;
    const abort = () => controller.abort();
    signal?.addEventListener?.('abort', abort, { once: true });
    const current = () => generation === this.generation && !controller.signal.aborted && !signal?.aborted;
    const report = (phase, extra = {}) => {
      if (current()) this.onStatus({ phase, atomCount: count, ...extra });
    };
    const prepare = async (backend, warmup) => {
      try {
        let status;
        while (current()) {
          try {
            status = await warmup({ atomCount: count, coordinateBytes: count * 24,
              signal: controller.signal, onProgress: progress => report('warming', { backend, progress }) });
            break;
          } catch (error) {
            if (error.name !== 'AbortError' || !current()) throw error;
            // A foreground calculation can preempt background preparation.
            // The initialized pool stays alive; retry after its work completes.
            await this.yieldBackground();
          }
        }
        return { backend, status };
      } catch (error) {
        return { backend, error };
      }
    };
    report('warming');
    this.pending = Promise.all([
      prepare('analysis', options => this.pool.warmupCpu({ ...options, modules: ['voronoi', 'ptm'] })),
      prepare('dxa', async options => {
        if (beforeDxa) await beforeDxa;
        if (!current()) throw new DOMException('CPU preparation cancelled.', 'AbortError');
        return this.dxaClient.warmup(options);
      }),
    ]).then(results => {
      if (!current()) return;
      const errors = results.filter(result => result.error);
      if (!errors.length) this.preparedAtomCount = Math.max(this.preparedAtomCount, count);
      report(errors.length ? 'unavailable' : 'ready', { results });
    }).finally(() => {
      signal?.removeEventListener?.('abort', abort);
      this.controllers.delete(controller);
      if (this.controller === controller) this.controller = null;
    });
    return this.pending;
  }

  cancel() {
    this.generation += 1;
    this.frameGeneration += 1;
    this.frameController?.abort();
    this.frameController = null;
    this.preparingFrame = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.controller = null;
    this.targetAtomCount = 0;
    // Cancellation invalidates preparation, not its Worker/Wasm resources.
    // A fresh source still checks the actual retained pools through warmup.
    this.preparedAtomCount = 0;
  }

  clearSource() {
    this.cancel();
    this.sourceKey = null;
    this.onStatus(null);
  }
}
