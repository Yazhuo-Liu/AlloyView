import { normalizeLocalFiles } from '../io/local-files.js';
import { cpuWorkerLimit } from '../analysis/cpu-budget.js';
import { SharedFrameRequests } from './shared-frame-requests.js';
import { ReplicationIdsReceiver } from './replication-ids.js';

const cancelled = () => new DOMException('Structure request cancelled.', 'AbortError');
const workerOwners = new WeakMap();

export class StructureWorkerClient {
  constructor(onProgress = () => {}, { cpuBudget, onSourceInfo = () => {}, startWorker = true } = {}) {
    this.onProgress = onProgress;
    this.onSourceInfo = onSourceInfo;
    this.cpuBudget = cpuBudget;
    this.cpuLeases = new Map();
    this.nextId = 1;
    this.pending = new Map();
    this.sourceInfo = null;
    this.loadId = null;
    this.sourceGeneration = 0;
    this.replicationIds = new ReplicationIdsReceiver();
    this.replicationControllers = new Set();
    this.replicationPreparations = new Map();
    this.frameRequests = new SharedFrameRequests();
    this.stagedSource = null;
    this.forwardTo = null;
    this.sourceUsed = false;
    this.standbyClient = null;
    this.closed = false;
    if (startWorker) this.createWorker();
  }

  attachWorker(worker) {
    workerOwners.set(worker, this);
    worker.addEventListener('message', (event) => {
      const owner = workerOwners.get(worker);
      if (worker === owner.worker || worker === owner.replicationWorker) owner.handleMessage(event.data, worker);
    });
    worker.addEventListener('error', (event) => {
      const owner = workerOwners.get(worker);
      if (worker !== owner.worker && worker !== owner.replicationWorker) return;
      // A failed preload must not leave a dead standby that accepts messages
      // forever. Terminate before releasing any outstanding CPU admissions.
      worker.terminate();
      for (const [id, pending] of owner.pending) {
        if (pending.worker !== worker) continue;
        owner.pending.delete(id);
        owner.cleanup(pending);
        pending.reject(new Error(event.message || 'The Worker failed.'));
      }
      if (worker === owner.worker) { owner.worker = null; owner.clearCpuLeases(); }
      else { owner.replicationWorker = null; owner.replicationIds.clear(); }
    });
  }

  createWorker() {
    this.worker = new Worker(new URL('../workers/structure-worker.js', import.meta.url), { type: 'module' });
    this.attachWorker(this.worker);
    // Warm one parser lane under the shared CPU quota. A source selected
    // before this completes joins the same lane instead of creating another.
    // This is a backend lifecycle event, not a source request. CPU admission
    // is tracked by cpuLeases even if ownership changes before its ACK.
    try { this.worker.postMessage({ type: 'warm', payload: { cpuBudget: Boolean(this.cpuBudget),
      parserConcurrency: Math.max(1, Math.min(4, (this.cpuBudget?.limit ?? cpuWorkerLimit()) - 1)) } }); }
    catch { /* A later source request reports transport failures to its caller. */ }
  }

  adoptBackend(candidate) {
    this.worker = candidate.worker;
    this.pending = candidate.pending;
    this.cpuLeases = candidate.cpuLeases;
    this.nextId = Math.max(this.nextId, candidate.nextId);
    this.loadId = candidate.loadId;
    this.sourceInfo = candidate.sourceInfo;
    this.sourceUsed = candidate.sourceUsed;
    if (this.worker) workerOwners.set(this.worker, this);
    candidate.worker = null;
    candidate.pending = new Map();
    candidate.cpuLeases = new Map();
  }

  ensureStandby() {
    if (!this.closed && !this.standbyClient) {
      // Prewarming is best effort. Failing to allocate an optional standby
      // must not undo a committed source or replace a candidate's own error.
      try { this.standbyClient = new StructureWorkerClient(() => {}, { cpuBudget: this.cpuBudget }); }
      catch { /* The next selection will create its candidate on demand. */ }
    }
  }

  request(type, payload, { reportProgress = true, background = false, signal, worker, onProgress, lease, onDispatch } = {}) {
    if (signal?.aborted) { lease?.release(); return Promise.reject(cancelled()); }
    if (!worker && !this.worker) this.createWorker();
    const target = worker ?? this.worker;
    const id = this.nextId++;
    if (type === 'load') this.loadId = id;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, reportProgress, background, signal, worker: target, onProgress, lease };
      pending.abort = () => {
        if (pending.aborted || !this.pending.has(id)) return;
        pending.aborted = true;
        pending.signal?.removeEventListener?.('abort', pending.abort);
        // Replication yields cooperatively. Keep its CPU permit until the
        // cancellation ACK; rejecting the caller does not stop the current
        // numeric chunk or source-ID validation loop immediately.
        if (!pending.lease) { this.pending.delete(id); this.cleanup(pending); }
        target.postMessage({ type: 'cancel-frame', payload: { id } });
        reject(cancelled());
      };
      this.pending.set(id, pending);
      signal?.addEventListener?.('abort', pending.abort, { once: true });
      try { onDispatch?.(id, pending); target.postMessage({ id, type, payload }); }
      catch (error) { this.pending.delete(id); this.cleanup(pending); reject(error); }
    });
  }

  load(input) {
    this.sourceUsed = true;
    this.sourceGeneration++;
    this.replicationIds.clear();
    this.frameRequests.clear();
    for (const controller of this.replicationControllers) controller.abort();
    const files = normalizeLocalFiles(input);
    this.sourceInfo = null;
    // Retain the single-file field for a previously cached Worker version.
    return this.request('load', { files, file: files.length === 1 ? files[0] : undefined,
      incremental: true, cpuBudget: Boolean(this.cpuBudget),
      parserConcurrency: Math.max(1, Math.min(4, (this.cpuBudget?.limit ?? cpuWorkerLimit()) - 1)) });
  }

  /** Parse a candidate beside the current source. The stable client object is
   * retained by trajectory tools; only a confirmed source's backend is swapped.
   * Candidate parser jobs use the same CPU budget, never a second thread quota.
   * Index notifications are private until commit, so a failed selection leaves
   * the old source, outstanding readers and its cached input arrays untouched.
   */
  async prepareSource(input, { signal } = {}) {
    if (signal?.aborted) throw cancelled();
    const files = normalizeLocalFiles(input);
    this.cancelSourceLoad();
    const staged = { signal, committed: false };
    let candidate = this.standbyClient;
    this.standbyClient = null;
    if (!candidate) {
      // The startup backend has no source to protect: use its already-loaded
      // modules as the first candidate, including its in-flight warmup lease.
      const startup = !this.sourceUsed && this.worker;
      candidate = new StructureWorkerClient(() => {}, { cpuBudget: this.cpuBudget, startWorker: !startup });
      if (startup) candidate.adoptBackend(this);
    }
    candidate.onProgress = progress => {
      if (this.stagedSource === staged && !signal?.aborted) this.onProgress(progress);
    };
    staged.candidate = candidate;
    staged.cancel = () => {
      signal?.removeEventListener?.('abort', staged.cancel);
      if (this.stagedSource === staged) this.stagedSource = null;
      if (!staged.committed) { candidate.close(); this.ensureStandby(); }
    };
    this.stagedSource = staged;
    signal?.addEventListener?.('abort', staged.cancel, { once: true });
    try {
      const result = await candidate.load(files);
      if (this.stagedSource !== staged || signal?.aborted) throw cancelled();
      return {
        result,
        get sourceInfo() { return candidate.forwardTo ? candidate.forwardTo.sourceInfo : candidate.sourceInfo; },
        cancel: staged.cancel,
        commit: () => {
          if (this.stagedSource !== staged || signal?.aborted) throw cancelled();
          if (!candidate.worker) throw new Error('The candidate structure Worker failed before the source was committed.');
          // Detach first: resetting the previous backend must not cancel its
          // already-confirmed replacement. It releases only the old leases.
          this.stagedSource = null;
          signal?.removeEventListener?.('abort', staged.cancel);
          this.reset({ keepStandby: true });
          staged.committed = true;
          this.adoptBackend(candidate);
          candidate.forwardTo = this;
          // Keep one ready replacement beside the active source. Old source
          // teardown still happens only after a successful candidate parse.
          this.ensureStandby();
          return result;
        },
      };
    } catch (error) {
      staged.cancel();
      throw error;
    }
  }

  cancelSourceLoad() { this.stagedSource?.cancel(); }

  frame(index, { reportProgress = true, background = !reportProgress, speculative = false, signal, trajectory = null } = {}) {
    // Normalize field order so equivalent trajectory processing options share
    // a request even when they were constructed by different consumers.
    const processing = trajectory ? Object.fromEntries(Object.entries(trajectory).sort(([first], [second]) => first.localeCompare(second))) : null;
    const key = JSON.stringify([this.sourceGeneration, index, processing]);
    return this.frameRequests.join(key, { signal, background, speculative }, entry => {
      entry.index = index;
      return this.request('frame', { index, background, ...(processing ? { trajectory: processing } : {}) }, {
        reportProgress, background, signal: entry.controller.signal,
        onDispatch: (id, pending) => {
          entry.promote = () => {
            pending.background = false; pending.reportProgress = true;
            pending.worker.postMessage({ type: 'promote-frame', payload: { id } });
          };
        },
      });
    });
  }

  promoteFrame(index, trajectory = null) {
    const processing = trajectory ? Object.fromEntries(Object.entries(trajectory).sort(([first], [second]) => first.localeCompare(second))) : null;
    const entry = this.frameRequests.entries.get(JSON.stringify([this.sourceGeneration, index, processing]));
    if (entry?.background) { entry.background = false; entry.promote?.(); }
  }

  /** Read indexed metadata in the same parser lanes and CPU budget, without
   * populating the atom-frame cache. Header and full-frame readers never
   * coalesce with one another; equivalent metadata readers still share work. */
  frameHeader(index, { background = true, signal } = {}) {
    const key = JSON.stringify([this.sourceGeneration, index, 'header']);
    return this.frameRequests.join(key, { signal, background, speculative: false }, entry => {
      entry.index = index;
      return this.request('frame-header', { index, background }, {
        reportProgress: false, background, signal: entry.controller.signal,
        onDispatch: (id, pending) => {
          entry.promote = () => {
            pending.background = false;
            pending.worker.postMessage({ type: 'promote-frame', payload: { id } });
          };
        },
      });
    });
  }

  /** Display-only unwrapped coordinates inferred for an already delivered frame. */
  trajectoryUnwrap(index, { smoothing = 0, infer = false, background = false, signal, onProgress } = {}) {
    return this.request('trajectory-unwrap', { index, smoothing, infer, background }, { reportProgress: false, background, signal, onProgress });
  }

  trajectoryLines(request, { signal, onProgress } = {}) {
    return this.request('trajectory-lines', request, { reportProgress: false, signal, onProgress });
  }

  waitForIndex({ signal } = {}) { return this.request('index-complete', {}, { reportProgress: false, signal }); }

  cancelPrefetch() {
    // Background analyses are consumers, not speculative prefetch. Their
    // requests must survive navigation and another consumer's cancellation.
    this.frameRequests.cancelSpeculative();
  }

  async replicate(frame, repetitions, { signal, onProgress, background = false } = {}) {
    const controller = new AbortController();
    const generation = this.sourceGeneration;
    this.replicationControllers.add(controller);
    this.replicationPreparations.set(controller, signal);
    const abort = () => controller.abort();
    signal?.addEventListener?.('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    let lease;
    try {
      lease = await this.cpuBudget?.acquire(1, { signal: controller.signal, priority: background ? -20 : 20 });
      if (controller.signal.aborted || signal?.aborted || generation !== this.sourceGeneration) throw cancelled();
      if (!this.replicationWorker) {
        this.replicationWorker = new Worker(new URL('../workers/replication-worker.js', import.meta.url), { type: 'module' });
        this.attachWorker(this.replicationWorker);
      }
      const ownedLease = lease;
      lease = null;
      const known = this.replicationIds.current;
      const result = await this.request('replicate', { frame, repetitions, sourceGeneration: generation,
        knownIdsToken: known?.token }, {
        worker: this.replicationWorker, signal: controller.signal, onProgress, background, reportProgress: false, lease: ownedLease,
      });
      if (signal?.aborted || controller.signal.aborted || generation !== this.sourceGeneration) throw cancelled();
      return this.replicationIds.restore(result, known);
    } finally {
      lease?.release();
      this.replicationControllers.delete(controller);
      this.replicationPreparations.delete(controller);
      signal?.removeEventListener?.('abort', abort);
    }
  }

  /** A foreground join may occur after parsing while physical copies are
   * waiting for CPU capacity. Promote that same dependency, without making
   * another expansion or replacing its retained replication Worker. */
  promoteReplication(signal) {
    for (const [controller, originalSignal] of this.replicationPreparations) {
      if (originalSignal === signal) this.cpuBudget?.promote(controller.signal, 20);
    }
  }

  coordination(frame, cutoff) {
    return this.request('analyze-coordination', { fractional: frame.fractional, cell: frame.cell, cutoff });
  }

  cleanup(pending) {
    pending.signal?.removeEventListener?.('abort', pending.abort);
    pending.lease?.release();
  }

  async acquireCpu(message, worker) {
    const controller = new AbortController();
    const request = { controller, lease: null };
    this.cpuLeases.set(message.leaseId, request);
    try {
      request.lease = await this.cpuBudget.acquire(1, { signal: controller.signal, priority: message.priority ?? (message.background ? -20 : 20) });
      const owner = workerOwners.get(worker);
      if (worker !== owner.worker || controller.signal.aborted) { request.lease.release(); return; }
      worker.postMessage({ type: 'cpu-granted', payload: { leaseId: message.leaseId } });
    } catch (error) {
      if (worker === workerOwners.get(worker)?.worker) worker.postMessage({ type: 'cpu-denied', payload: { leaseId: message.leaseId, error: error.message, name: error.name } });
    }
  }

  clearCpuLeases() {
    for (const request of this.cpuLeases.values()) { request.controller.abort(); request.lease?.release(); }
    this.cpuLeases.clear();
  }

  handleMessage(message, worker = this.worker) {
    if (message.event === 'cpu-promote') {
      const request = this.cpuLeases.get(message.leaseId);
      if (request) this.cpuBudget?.promote(request.controller.signal, message.priority ?? 20);
      return;
    }
    if (message.event === 'cpu-acquire') {
      if (this.cpuBudget) void this.acquireCpu(message, worker);
      return;
    }
    if (message.event === 'cpu-cancel' || message.event === 'cpu-release') {
      const request = this.cpuLeases.get(message.leaseId);
      if (request) { request.controller.abort(); request.lease?.release(); this.cpuLeases.delete(message.leaseId); }
      return;
    }
    if (message.event === 'source-info') {
      if (message.loadId !== this.loadId) return;
      this.sourceInfo = message.result;
      this.onSourceInfo(message.result);
      return;
    }
    const pending = this.pending.get(message.id);
    if (message.event === 'progress' || message.event === 'replication-progress') {
      if (pending?.aborted) return;
      if (pending?.onProgress) pending.onProgress(message);
      else if (pending?.reportProgress) this.onProgress(message);
      return;
    }
    if (!pending) return;
    this.pending.delete(message.id);
    this.cleanup(pending);
    if (pending.aborted) return;
    if (message.ok) pending.resolve(message.result);
    else pending.reject(Object.assign(new Error(message.error), { name: message.name ?? 'Error' }));
  }

  reset({ keepStandby = true } = {}) {
    this.cancelSourceLoad();
    this.sourceGeneration++;
    this.replicationIds.clear();
    this.frameRequests.clear();
    for (const controller of this.replicationControllers) controller.abort();
    this.replicationControllers.clear();
    this.replicationPreparations.clear();
    this.worker?.terminate();
    this.replicationWorker?.terminate();
    this.worker = null;
    this.replicationWorker = null;
    this.loadId = null;
    this.sourceInfo = null;
    this.sourceUsed = false;
    this.clearCpuLeases();
    for (const pending of this.pending.values()) { this.cleanup(pending); pending.reject(cancelled()); }
    this.pending.clear();
    if (!keepStandby) { this.standbyClient?.close(); this.standbyClient = null; }
  }

  close() { this.closed = true; this.reset({ keepStandby: false }); }
}
