/** Prepare reusable CPU analysis resources without copying or analyzing frames.
 * Loaded geometry and physical replication share this scheduler; displaying
 * additional periodic images never changes its target atom count.
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
  }

  warmModules({ sourceKey } = {}) {
    return this.setAtomCount({ sourceKey, atomCount: 1 });
  }

  setFrame({ sourceKey, frame }) {
    if (!frame) return this.pending;
    return this.setAtomCount({ sourceKey, atomCount: frame.ids?.length ?? frame.fractional?.length / 3, checkResources: true });
  }

  setAtomCount({ sourceKey = this.sourceKey, atomCount, signal, checkResources = false }) {
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
      prepare('analysis', options => this.pool.warmupCpu(options)),
      prepare('dxa', options => this.dxaClient.warmup(options)),
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
