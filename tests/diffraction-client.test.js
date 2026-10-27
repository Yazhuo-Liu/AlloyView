import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, MessageChannel } from 'node:worker_threads';
import { DiffractionClient } from '../src/analysis/diffraction-client.js';
import { CpuBudget } from '../src/shared/cpu-budget.js';
import { calculateDiffraction } from '../src/analysis/diffraction.js';
import { crystalFrame } from './helpers/crystals.js';

const parameters = { maxAngle: 80, step: .2 };
function frame(repeat = 1) {
  const value = crystalFrame('fcc', repeat, 3.615); value.typeLabels = ['Cu'];
  value.properties.push({ name: 'occupancy', data: new Float64Array(value.types.length).fill(.8) });
  value.properties.push({ name: 'Biso', data: new Float64Array(value.types.length).fill(.2) });
  return value;
}
function setup(options = {}) {
  const created = [], messages = [], replies = [], environment = { navigator: { hardwareConcurrency: 6 }, crossOriginIsolated: options.shared ?? false };
  const cpuBudget = options.cpuBudget ?? new CpuBudget({ environment });
  const createWorker = () => {
    options.beforeCreate?.(created.length);
    const worker = new Worker(new URL('./helpers/node-diffraction-worker.mjs', import.meta.url));
    const index = created.length; created.push(worker);
    return {
      addEventListener(name, callback) {
        worker.on(name, data => {
          if (name === 'message') replies.push({ index, ...data });
          callback(name === 'message' ? { data } : data);
        });
      },
      postMessage(message, transfer) {
        messages.push({ index, ...message });
        worker.postMessage(message, transfer);
        options.onPost?.(message, index);
      },
      terminate() { return worker.terminate(); },
    };
  };
  const client = new DiffractionClient({ cpuBudget, environment, createWorker,
    createMessageChannel: () => new MessageChannel(), interactionsPerWorker: 1,
    chunkInteractions: 400, ...options });
  return { client, cpuBudget, created, messages, replies };
}
function sameScientific(actual, expected) {
  for (const key of ['parameters', 'atomCount', 'reflectionCount', 'extinctCount', 'peakCount', 'peaks', 'profile',
    'reflections', 'warnings', 'radiation', 'scatteringModel', 'scatteringUnits', 'intensityUnits', 'geometryCorrection']) {
    assert.deepEqual(actual[key], expected[key], key);
  }
}
const abort = error => error?.name === 'AbortError';

for (const shared of [false, true]) test(`real diffraction ranges match direct Float64 results with retained ${shared ? 'shared' : 'private'} inputs`, async t => {
  const state = setup({ shared }); t.after(() => state.client.dispose());
  const input = frame(2), original = input.fractional.slice();
  // Unrelated million-value data must never enter the diffraction Worker.
  input.properties.push({ name: 'unrelated_analysis', data: new Float64Array(1000000) });
  input.volume = { values: new Float32Array(1000000) };
  const result = await state.client.analyze(input, parameters);
  sameScientific(result, calculateDiffraction(input, parameters));
  assert.equal(result.workerCount, 4); assert.equal(result.sharedMemory, shared);
  assert.deepEqual(input.fractional, original); assert.equal(input.properties[0].data[0], .8);
  const source = state.messages.find(message => message.type === 'source').frame;
  assert.equal(source.positions, undefined); assert.equal(source.volume, undefined);
  assert.deepEqual(source.properties.map(property => property.name), ['occupancy', 'Biso']);
  assert.equal(source.fractional.byteLength, 0, 'only private snapshot is transferred');
  assert.equal(state.messages.filter(message => message.type === 'source').length, 1);
  assert.equal(state.messages.filter(message => message.type === 'receive').length, 3);
  assert.ok(state.messages.filter(message => message.type === 'range').length > 4);
  const repeat = await state.client.analyze(input, parameters);
  sameScientific(repeat, result); assert.equal(repeat.sourceUploaded, false);
  assert.equal(state.created.length, 4); assert.equal(state.messages.filter(message => message.type === 'receive').length, 3);
  const changed = await state.client.analyze(input, { ...parameters, wavelength: 1.2 });
  sameScientific(changed, calculateDiffraction(input, { ...parameters, wavelength: 1.2 }));
  assert.equal(state.messages.filter(message => message.type === 'source').length, 1);
  assert.equal(result.reflections.hkls.length, result.reflectionCount * 3, 'finalization cannot detach preceding cached scientific arrays');
  assert.equal(state.cpuBudget.active, 0); assert.equal(state.cpuBudget.queue.length, 0);
});

test('diffraction CSVs format every peak and profile row in the retained coordinator without detaching outputs', async t => {
  const state = setup(); t.after(() => state.client.dispose()); const input = frame();
  const result = await state.client.analyze(input, parameters);
  const profileCopy = result.profile.intensity.slice(), hklCopy = result.reflections.hkls.slice();
  const peaks = await state.client.export(result, 'peaks', { stem: 'Cu structure' });
  const profile = await state.client.export(result, 'profile', { stem: 'Cu structure' });
  assert.equal(peaks.filename, 'Cu_structure-xrd-peaks.csv');
  const peakText = await peaks.blob.text(), profileText = await profile.blob.text();
  assert.equal(peakText.trim().split('\r\n').length, result.peaks.length + 1);
  assert.equal(profileText.trim().split('\r\n').length, result.profile.twoTheta.length + 1);
  assert.ok(peakText.includes(String(result.peaks[0].intensity)));
  assert.deepEqual(result.profile.intensity, profileCopy); assert.deepEqual(result.reflections.hkls, hklCopy);
  const requests = state.messages.filter(message => message.type === 'csv');
  assert.equal(requests[0].result.reflections, undefined); assert.equal(requests[0].result.profile, undefined);
  assert.equal(requests[1].result.peaks, undefined);
  const again = await state.client.analyze(input, parameters); sameScientific(again, result);
});

test('cancelling running diffraction keeps CPU leases until ACK and then reuses all retained Workers', async t => {
  const controller = new AbortController(); let state, leaseAtCancel = 0, cancelled = false;
  state = setup({ onPost(message) {
    if (message.type === 'range' && !cancelled) {
      cancelled = true; leaseAtCancel = state.cpuBudget.active; controller.abort();
      assert.equal(state.cpuBudget.active, leaseAtCancel, 'posting cancel must not release an active range lease');
    }
  } });
  t.after(() => state.client.dispose()); const input = frame(3);
  const rejected = state.client.analyze(input, parameters, { signal: controller.signal });
  const next = state.client.analyze(input, parameters);
  await assert.rejects(rejected, abort); assert.ok(leaseAtCancel > 0);
  const result = await next; sameScientific(result, calculateDiffraction(input, parameters));
  assert.equal(state.created.length, 4); await state.client.whenIdle();
  assert.equal(state.cpuBudget.active, 0); assert.equal(state.cpuBudget.queue.length, 0);
  assert.ok(state.messages.some(message => message.type === 'cancel'));
});

test('shared CPU budget admits unrelated foreground work between bounded diffraction ranges', async t => {
  const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 4 } } });
  let state, independent, completedAtAdmission = null, requested = false, maxActive = 0;
  state = setup({ cpuBudget: budget, chunkInteractions: 32, onPost(message) {
    maxActive = Math.max(maxActive, budget.active);
    if (message.type === 'range' && !requested) {
      requested = true;
      independent = budget.acquire(1, { owner: 'other-analysis' }).then(lease => {
        completedAtAdmission = state.replies.filter(reply => reply.result?.intensity && Number.isInteger(reply.result.start)).length;
        lease.release();
      });
    }
  } });
  t.after(() => state.client.dispose());
  const result = await state.client.analyze(frame(2), parameters); await independent;
  assert.equal(result.workerCount, 2); assert.ok(maxActive <= budget.limit);
  assert.ok(completedAtAdmission < result.reflectionCount, 'ordinary analyses need not wait for the whole diffraction job');
  assert.equal(budget.active, 0); assert.equal(budget.queue.length, 0);
});

test('source clearing cancels old work, retains healthy Workers and removes cached source identities', async t => {
  const state = setup(); t.after(() => state.client.dispose()); const input = frame();
  await state.client.analyze(input, parameters); const count = state.created.length;
  await state.client.clear();
  const result = await state.client.analyze(input, parameters);
  assert.equal(result.sourceUploaded, true); assert.equal(state.created.length, count);
  input.cell.vectors[0] += .1;
  const changed = await state.client.analyze(input, parameters);
  assert.equal(changed.sourceUploaded, true); sameScientific(changed, calculateDiffraction(input, parameters));
  input.properties[0] = { name: 'occupancy', data: new Float64Array(input.types.length).fill(.4) };
  const occupied = await state.client.analyze(input, parameters);
  assert.equal(occupied.sourceUploaded, true); sameScientific(occupied, calculateDiffraction(input, parameters));
  assert.equal(state.cpuBudget.active, 0);
});

test('partial range Worker startup failure joins waiting ports and permits a clean retry', async t => {
  let fail = true;
  const state = setup({ beforeCreate(index) { if (index === 2 && fail) { fail = false; throw new Error('Worker startup denied'); } } });
  t.after(() => state.client.dispose());
  await assert.rejects(state.client.analyze(frame(), parameters), /startup denied/);
  await state.client.whenIdle(); assert.equal(state.cpuBudget.active, 0); assert.equal(state.cpuBudget.queue.length, 0);
  const input = frame(), result = await state.client.analyze(input, parameters);
  sameScientific(result, calculateDiffraction(input, parameters)); assert.equal(state.created.length, 4);
});

test('throwing progress consumers cancel sibling ranges without leaking permits or poisoning the pool', async t => {
  const state = setup(); t.after(() => state.client.dispose()); const input = frame(2);
  await assert.rejects(state.client.analyze(input, parameters, { onProgress(value) {
    if (value.phase === 'structure-factors') throw new Error('consumer failed');
  } }), /consumer failed/);
  await state.client.whenIdle(); assert.equal(state.cpuBudget.active, 0);
  const result = await state.client.analyze(input, parameters); sameScientific(result, calculateDiffraction(input, parameters));
  assert.equal(state.created.length, 4);
});

test('GPU unavailable fallback retains the complete CPU calculation and GPU release preserves CPU snapshots', async t => {
  const state = setup(); t.after(() => state.client.dispose()); const input = frame();
  const result = await state.client.analyze(input, parameters, { useGpu: true });
  sameScientific(result, calculateDiffraction(input, parameters)); assert.equal(result.backend, 'cpu');
  assert.ok(result.fallbackReason); await state.client.releaseGpuResources();
  const again = await state.client.analyze(input, parameters);
  sameScientific(again, result); assert.equal(again.sourceUploaded, false);
  assert.equal(state.messages.filter(message => message.type === 'source').length, 1);
});

test('already cancelled or queued requests never dispatch scientific work, and no-Worker mode remains exact', async t => {
  const state = setup(); t.after(() => state.client.dispose());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(state.client.analyze(frame(), parameters, { signal: controller.signal }), abort);
  assert.equal(state.created.length, 0);
  const direct = new DiffractionClient({ createWorker: null }); t.after(() => direct.dispose());
  const input = frame(), result = await direct.analyze(input, parameters, { useGpu: true });
  sameScientific(result, calculateDiffraction(input, parameters)); assert.equal(result.backend, 'cpu'); assert.ok(result.fallbackReason);
  const csv = await direct.export(result, 'peaks'); assert.match(await csv.blob.text(), /^two_theta_deg/);
});

test('property and type revision markers refresh in-place scientific source edits', async t => {
  const state = setup(); t.after(() => state.client.dispose()); const input = frame();
  input.typeLabels = ['Cu', 'Ni'];
  await state.client.analyze(input, parameters);
  input.properties[0].data[0] = .3; input.propertyRevision = 1;
  let result = await state.client.analyze(input, parameters);
  assert.equal(result.sourceUploaded, true); sameScientific(result, calculateDiffraction(input, parameters));
  input.types[0] = 1; input.typesRevision = 1;
  result = await state.client.analyze(input, parameters);
  assert.equal(result.sourceUploaded, true); sameScientific(result, calculateDiffraction(input, parameters));
});

test('aborting from GPU fallback progress never publishes ranges or starts CPU fallback work', async t => {
  const state = setup(); t.after(() => state.client.dispose()); const controller = new AbortController();
  await assert.rejects(state.client.analyze(frame(), parameters, { useGpu: true, signal: controller.signal,
    onProgress(value) { if (value.phase === 'cpu-fallback') controller.abort(); } }), abort);
  await state.client.whenIdle();
  assert.equal(state.messages.some(message => ['range', 'publish', 'receive'].includes(message.type)), false);
  assert.equal(state.cpuBudget.active, 0);
});

test('a new prepared source releases obsolete range snapshots while retaining the Worker modules', async t => {
  const state = setup(); t.after(() => state.client.dispose());
  await state.client.analyze(frame(2), parameters); const created = state.created.length;
  assert.equal(state.client.slots.filter(slot => slot.preparedKey !== null).length, 4);
  await state.client.prepare(frame());
  assert.equal(state.client.slots.filter(slot => slot.preparedKey !== null).length, 0);
  assert.equal(state.created.length, created);
});

function rpcSetup() {
  const listeners = new Map(), messages = [];
  const worker = { addEventListener(name, callback) { listeners.set(name, callback); },
    postMessage(message) { messages.push(message); }, terminate() {} };
  const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 3 } } });
  const client = new DiffractionClient({ cpuBudget: budget, createWorker: () => worker });
  const slot = client.slot(0);
  const emit = data => listeners.get('message')({ data });
  return { client, budget, slot, emit, messages };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('GPU host-stage RPC owns permits only for CPU work and cancellation retains active leases until ACK', async t => {
  const state = rpcSetup(); t.after(() => state.client.dispose()); const controller = new AbortController();
  const pending = state.client.request(state.slot, { type: 'gpu' }, { signal: controller.signal });
  const id = state.messages[0].id;
  assert.equal(state.budget.active, 0, 'pure GPU queue wait has no CPU lease');
  state.emit({ id, cpu: { action: 'acquire', token: 1 } }); await turn();
  assert.equal(state.budget.active, 1); assert.equal(state.messages.at(-1).type, 'cpu-permit');
  state.emit({ id, cpu: { action: 'release', token: 1 } });
  assert.equal(state.budget.active, 0, 'readback waits release CPU capacity');
  state.emit({ id, cpu: { action: 'acquire', token: 2 } }); await turn();
  controller.abort(); assert.equal(state.budget.active, 1, 'cancel cannot prematurely release active precision correction');
  const rejected = assert.rejects(pending, abort);
  state.emit({ id, ok: false, error: 'cancelled', name: 'AbortError' }); await rejected;
  assert.equal(state.budget.active, 0); assert.equal(state.budget.queue.length, 0);
});

test('cancelled GPU host admission leaves no budget waiter and late grants cannot start work', async t => {
  const state = rpcSetup(); t.after(() => state.client.dispose()); const controller = new AbortController();
  const independent = await state.budget.acquire(1, { owner: 'analysis' });
  const pending = state.client.request(state.slot, { type: 'gpu' }, { signal: controller.signal }); const id = state.messages[0].id;
  state.emit({ id, cpu: { action: 'acquire', token: 1 } }); assert.equal(state.budget.queue.length, 1);
  controller.abort(); await turn();
  assert.equal(state.budget.queue.length, 0); assert.equal(state.budget.active, 1);
  const rejected = assert.rejects(pending, abort); state.emit({ id, ok: false, error: 'cancelled', name: 'AbortError' }); await rejected;
  independent.release(); await turn(); assert.equal(state.budget.active, 0);
  assert.equal(state.messages.some(message => message.type === 'cpu-permit' && message.ok), false);
});

test('queued startup cancellation allocates no Worker and background warmup yields to foreground analyses', async t => {
  const budget = new CpuBudget({ environment: { navigator: { hardwareConcurrency: 3 } } });
  const state = setup({ cpuBudget: budget }); t.after(() => state.client.dispose());
  const lease = await budget.acquire(1, { owner: 'independent' });
  const warming = state.client.warm(); await turn();
  assert.equal(budget.queue.length, 1); assert.equal(state.created.length, 0);
  const controller = new AbortController();
  const pending = state.client.analyze(frame(), parameters, { signal: controller.signal });
  await assert.rejects(warming, abort); await turn();
  controller.abort(); await assert.rejects(pending, abort); await state.client.whenIdle();
  assert.equal(budget.queue.length, 0); assert.equal(state.created.length, 0);
  lease.release();
  const result = await state.client.analyze(frame(), parameters);
  assert.equal(result.workerCount, 1); assert.equal(state.created.length, 1); assert.equal(budget.active, 0);
});

const modelParameters = radiation => ({ ...parameters, radiation,
  ...(radiation === 'electron' ? { wavelength: .025, minAngle: .1, maxAngle: 2, step: .01, fwhm: .04 }
    : radiation === 'neutron' ? { wavelength: 1.8, maxAngle: 120 } : {}) });

for (const shared of [false, true]) test(`switching X-ray, signed neutron and electron models reuses the retained ${shared ? 'shared' : 'private'} source without stale factors`, async t => {
  const state = setup({ shared }); t.after(() => state.client.dispose()); const input = frame();
  input.typeLabels = ['H', 'Cu']; for (let atom = 0; atom < input.types.length; atom++) input.types[atom] = atom % 2;
  const sourcePositions = input.fractional.slice(), results = [];
  for (const radiation of ['xray', 'neutron', 'electron', 'xray']) {
    const settings = modelParameters(radiation), result = await state.client.analyze(input, settings);
    sameScientific(result, calculateDiffraction(input, settings));
    assert.equal(result.radiation, radiation); assert.equal(result.parameters.radiation, radiation);
    assert.ok(result.scatteringUnits); results.push(result);
    for (const kind of ['peaks', 'profile']) {
      const exported = await state.client.export(result, kind, { stem: 'H-Cu' }), csv = await exported.blob.text();
      assert.ok(csv.includes(radiation), 'CSV records the actual radiation model');
      assert.ok(csv.includes(result.scatteringModel), 'CSV retains the model provenance');
    }
  }
  assert.ok(results[1].reflections.real.some(value => value < -1e-6), 'negative coherent neutron lengths remain signed before squaring');
  assert.notDeepEqual(results[0].scatteringModel, results[1].scatteringModel);
  assert.notDeepEqual(results[0].scatteringModel, results[2].scatteringModel);
  sameScientific(results[0], results[3]);
  assert.equal(state.messages.filter(message => message.type === 'source').length, 1);
  assert.equal(state.created.length, 4); assert.deepEqual(input.fractional, sourcePositions);
  assert.equal(state.cpuBudget.active, 0);
});

test('GPU unavailability and cancellation preserve the requested radiation and later cache recovery', async t => {
  const state = setup(); t.after(() => state.client.dispose()); const input = frame();
  for (const radiation of ['neutron', 'electron']) {
    const settings = modelParameters(radiation), result = await state.client.analyze(input, settings, { useGpu: true });
    sameScientific(result, calculateDiffraction(input, settings));
    assert.equal(result.backend, 'cpu'); assert.ok(result.fallbackReason); assert.equal(result.radiation, radiation);
  }
  const controller = new AbortController(), before = state.messages.filter(message => message.type === 'range').length;
  await assert.rejects(state.client.analyze(input, modelParameters('neutron'), { useGpu: true, signal: controller.signal,
    onProgress(value) { if (value.phase === 'cpu-fallback') controller.abort(); } }), abort);
  await state.client.whenIdle();
  assert.equal(state.messages.filter(message => message.type === 'range').length, before, 'cancelled neutron GPU work cannot retry on CPU');
  const recovered = await state.client.analyze(input, modelParameters('electron'));
  sameScientific(recovered, calculateDiffraction(input, modelParameters('electron')));
  assert.equal(state.messages.filter(message => message.type === 'source').length, 1); assert.equal(state.cpuBudget.active, 0);
});

test('radiation and thermal cache choices are independent and invalid model settings preserve valid cached inputs', async t => {
  const state = setup({ shared: true }); t.after(() => state.client.dispose()); const input = frame();
  for (const radiation of ['xray', 'neutron', 'electron', 'neutron', 'xray']) for (const useThermal of [false, true]) {
    const settings = { ...modelParameters(radiation), useThermal }, result = await state.client.analyze(input, settings);
    sameScientific(result, calculateDiffraction(input, settings));
  }
  await assert.rejects(state.client.analyze(input, { ...parameters, radiation: 'unsupported' }), /radiation/i);
  const result = await state.client.analyze(input, modelParameters('xray'));
  sameScientific(result, calculateDiffraction(input, modelParameters('xray')));
  assert.equal(state.messages.filter(message => message.type === 'source').length, 1);
  assert.equal(state.cpuBudget.active, 0); assert.equal(state.cpuBudget.queue.length, 0);
});
