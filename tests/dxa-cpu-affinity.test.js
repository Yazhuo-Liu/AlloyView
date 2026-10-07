import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';

const environment = { navigator: { hardwareConcurrency: 8 }, performance: {} };
const cell = { vectors: [16, 0, 0, 0, 16, 0, 0, 0, 16], origin: [0, 0, 0], pbc: [true, true, true] };
const input = () => ({ atomCount: 8788, coordinates: new Float64Array(8788 * 3), cell, lattice: 1, perfectOnly: false });

class ManualWorker {
  constructor(index) { this.index = index; this.messages = []; this.listeners = new Map(); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  postMessage(message) {
    this.messages.push(message);
    if (message.id !== undefined) this.inflight = message;
  }
  complete(result = {}) {
    const request = this.inflight;
    assert.ok(request, 'the controlled Worker must have an active request');
    this.inflight = undefined;
    this.listeners.get('message')({ data: { id: request.id, ok: true, result } });
  }
  terminate() { this.terminated = true; this.inflight = undefined; }
}

async function until(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 4));
  }
}

function harness() {
  const workers = [], ordinaryJobs = [];
  const pool = new AnalysisPool({ environment, workerFactory: () => {
    const worker = new ManualWorker(workers.length); workers.push(worker); return worker;
  } });
  // Existing PTM/Voronoi warmups can leave every application slot resident.
  for (let index = 0; index < 6; index++) pool.idle.push(pool.createWorker());
  const active = kind => workers.filter(worker => !worker.terminated && worker.inflight?.kind === kind);
  const uploaded = () => workers.filter(worker => worker.messages.some(message => message.kind === 'dxaLocal' && message.dxaStageInput));
  const ordinary = () => {
    const controller = new AbortController();
    const job = pool.runTask({ kind: 'coordination', fractional: new Float64Array(3), cell,
      startAtom: 0, endAtom: 1 }, controller.signal, controller.signal);
    job.catch(() => {}); ordinaryJobs.push(job); return job;
  };
  const completeDxa = worker => {
    const request = worker.inflight;
    assert.equal(request?.kind, 'dxaLocal');
    const length = request.endAtom - request.startAtom;
    const neighbors = new Int32Array(length * 12);
    for (let atom = 0; atom < length; atom++) neighbors.fill((request.startAtom + atom + 1) % 8788, atom * 12, (atom + 1) * 12);
    worker.complete({ startAtom: request.startAtom, endAtom: request.endAtom,
      structures: new Int32Array(length).fill(1), neighbors, neighborWidth: 12,
      maxNeighborDistance: 4, frameUploaded: Boolean(request.dxaStageInput), kernelReused: true,
      wasmMemoryBytes: 32 * 1024 ** 2 });
  };
  const finishOrdinary = async () => {
    await until(() => active('coordination').length > 0 || pool.active.size === 0, 'ordinary work never resumed');
    while (pool.active.size) {
      for (const worker of active('coordination')) worker.complete();
      await new Promise(resolve => setTimeout(resolve, 4));
    }
    await Promise.all(ordinaryJobs);
  };
  return { pool, workers, active, uploaded, ordinary, completeDxa, finishOrdinary, ordinaryJobs };
}

test('two CPU DXA runners retain two input copies while queued analyses compete between chunks', async () => {
  const h = harness(), controller = new AbortController();
  const stage = h.pool.analyzeDxaLocal(input(), { workerCount: 2, signal: controller.signal });
  stage.catch(() => {});
  let stageComplete = false;
  stage.then(() => { stageComplete = true; }, () => {});
  try {
    await until(() => h.active('dxaLocal').length === 2, 'both private DXA Workers did not start');
    const stageWorkers = h.active('dxaLocal');
    const stageKey = stageWorkers[0].inflight.dxaResidentKey;
    for (let index = 0; index < 4; index++) h.ordinary();
    await until(() => h.active('coordination').length === 4, 'ordinary work did not fill the unreserved slots');
    const queued = h.ordinary();
    await new Promise(resolve => setTimeout(resolve, 12));
    assert.equal(h.pool.cpuBudget.active, 6);
    assert.equal(h.pool.cpuBudget.queue.length, 0, 'a job without an eligible slot must not enter the CPU permit queue');

    const first = stageWorkers[0], firstRequest = first.inflight.id;
    h.completeDxa(first);
    await until(() => first.inflight && first.inflight.id !== firstRequest, 'the reserved DXA Worker did not take its next chunk');
    assert.equal(first.inflight.kind, 'dxaLocal', 'queued ordinary work must not displace a DXA resident between chunks');
    assert.equal(first.inflight.dxaStageInput, undefined, 'the second chunk reuses the original binary64 geometry');

    // This release previously admitted the next DXA chunk to a third slot,
    // because queued ordinary work had stolen the completed DXA resident.
    const other = h.active('coordination')[0], previous = other.inflight.id;
    other.complete();
    await until(() => other.inflight && other.inflight.id !== previous, 'the queued ordinary job did not use its eligible slot');
    assert.equal(other.inflight.kind, 'coordination');
    assert.equal(h.uploaded().length, 2);

    while (!stageComplete) {
      for (const worker of h.active('dxaLocal')) h.completeDxa(worker);
      await new Promise(resolve => setTimeout(resolve, 4));
    }
    const result = await stage;
    assert.equal(result.workerCount, 2);
    assert.equal(result.copiedBytes, result.inputBytes * 2);
    assert.equal(h.uploaded().length, 2, 'resident inputs remain capped for the whole stage');
    assert.equal(h.pool.dxaStages.size, 0);
    assert.ok([...h.pool.slots].every(slot => !slot.dxaReservedKey && !slot.dxaResidentKey));
    assert.equal(h.workers.filter(worker => worker.messages.some(message => message.kind === 'dxaRelease' && message.dxaResidentKey === stageKey)).length, 2);
    await h.finishOrdinary(); await queued;
    assert.equal(h.pool.cpuBudget.active, 0);
    assert.equal(h.pool.cpuBudget.queue.length, 0);
  } finally {
    controller.abort(); h.pool.close(); await stage.catch(() => {});
    await Promise.allSettled(h.ordinaryJobs);
  }
});

test('canceling a private CPU stage unlocks its slots and admits queued ordinary work without leaked permits', async () => {
  const h = harness(), controller = new AbortController();
  const stage = h.pool.analyzeDxaLocal(input(), { workerCount: 2, signal: controller.signal });
  const rejection = assert.rejects(stage, { name: 'AbortError' });
  try {
    await until(() => h.active('dxaLocal').length === 2, 'both private DXA Workers did not start');
    const stageWorkers = h.active('dxaLocal');
    const first = stageWorkers[0], firstRequest = first.inflight.id;
    h.completeDxa(first);
    await until(() => first.inflight && first.inflight.id !== firstRequest, 'the private Worker did not retain its next chunk');
    for (let index = 0; index < 4; index++) h.ordinary();
    await until(() => h.active('coordination').length === 4, 'ordinary tasks did not fill the unreserved slots');
    h.ordinary(); h.ordinary();
    await new Promise(resolve => setTimeout(resolve, 12));
    assert.equal(h.pool.cpuBudget.active, 6);
    assert.equal(h.pool.cpuBudget.queue.length, 0, 'the two waiting ordinary jobs hold no permits');
    assert.equal(h.pool.dxaStages.size, 1);
    controller.abort();
    await rejection;
    await until(() => h.active('coordination').length === 6, 'queued ordinary work did not resume after stage cancellation');
    assert.equal(h.pool.dxaStages.size, 0);
    assert.ok([...h.pool.slots].every(slot => !slot.dxaReservedKey && !slot.dxaResidentKey));
    assert.ok(stageWorkers.every(worker => worker.terminated), 'cancellation stops the synchronous native private jobs');
    assert.equal(h.pool.cpuBudget.active, 6, 'all remaining permits belong to ordinary tasks');
    await h.finishOrdinary();
    assert.equal(h.pool.cpuBudget.active, 0);
    assert.equal(h.pool.cpuBudget.queue.length, 0);
    assert.equal(h.pool.active.size, 0);
  } finally {
    controller.abort(); h.pool.close(); await rejection;
    await Promise.allSettled(h.ordinaryJobs);
  }
});
