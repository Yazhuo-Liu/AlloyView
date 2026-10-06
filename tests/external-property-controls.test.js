import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeExternalPropertyControls } from '../src/external-property-controls.js';
import { ExternalPropertyWorkerClient } from '../src/external-property-worker-client.js';

test('attribute controller uses the persistent Worker for import, replicas, rename and portable restore', async t => {
  const originalSelf = globalThis.self;
  let listener; const replies = [];
  globalThis.self = {
    addEventListener(type, callback) { assert.equal(type, 'message'); listener = callback; },
    postMessage(message) { replies.push(message); },
  };
  try {
    await import('../src/workers/external-property-worker.js');
    let id = 0;
    const requests = [];
    const client = {
      async request(type, payload) {
        const requestId = ++id; requests.push({ type, payload });
        await listener({ data: { id: requestId, type, payload } });
        const reply = replies.find(message => message.id === requestId);
        if (!reply.ok) throw new Error(reply.error);
        return reply.result;
      },
      reset() { void this.request('reset', {}); },
    };
    function frame(ids = [11, 22], frameIndex = 0) {
      return { ids: Float64Array.from(ids), idSource: 'explicit', frameIndex,
        properties: [{ name: 'mass', data: Float64Array.from(ids, () => 55.8) }, { name: 'coordination', analysisKind: 'coordination', data: Uint32Array.from(ids, () => 8) }] };
    }
    let current = frame();
    let sourceVersion = 1;
    const imported = [], removed = [];
    const controls = initializeExternalPropertyControls({ getFrame: () => current,
      getSourceVersion: () => sourceVersion, getFrameAtIndex: async index => frame([11, 22], index),
      onImported: event => imported.push(event), onRemoved: event => removed.push(event), workerClient: client });
    const csv = new File(['id,x,energy\n22,9,NaN\n11,8,-2\n'], 'attributes.csv');
    let manifest;
    await t.test('import and across-frame attributes preserve existing analysis objects', async () => {
      const analysis = current.properties[1];
      manifest = await controls.importFile(csv);
      assert.equal(current.properties[1], analysis);
      assert.deepEqual([...current.properties.find(property => property.name === 'x').data], [8, 9]);
      current = frame([22, 11], 3);
      await controls.applyToFrame(current);
      assert.deepEqual([...current.properties.find(property => property.name === 'x').data], [9, 8]);
      assert.equal(requests.filter(request => request.type === 'import').length, 1);
      assert.ok(Number.isNaN(current.properties.find(property => property.name === 'energy').data[0]));
    });
    await t.test('physical replicas repeat source attributes in copy-major order inside Worker', async () => {
      const target = frame([1, 2, 3, 4, 5, 6], 3);
      target.physicalReplication = { sourceAtomCount: 2 };
      await controls.applyToFrame(target, { sourceFrame: current });
      assert.deepEqual([...target.properties.find(property => property.name === 'x').data], [9, 8, 9, 8, 9, 8]);
      assert.equal(target.properties[1].analysisKind, 'coordination');
      await assert.rejects(controls.applyToFrame(frame([1, 2, 3, 4]), { sourceFrame: current }), /original source frame/);
    });
    await t.test('rename and remove leave a data-free reproducible recipe', async () => {
      await controls.rename(manifest.id, 'x', 'imported_x');
      await controls.remove(manifest.id, 'energy');
      assert.ok(!current.properties.some(property => property.name === 'x' || property.name === 'energy'));
      assert.deepEqual([...current.properties.find(property => property.name === 'imported_x').data], [9, 8]);
      const state = controls.getState();
      assert.equal(state.files[0].columns[1].enabled, false);
      assert.ok(!JSON.stringify(state).includes('data'));
      const count = requests.filter(request => request.type === 'import').length;
      controls.setState(state); await controls.applyToFrame(current);
      assert.equal(controls.getPendingFiles().length, 0);
      assert.equal(requests.filter(request => request.type === 'import').length, count);
      controls.reset(); controls.setState(state);
      assert.deepEqual(controls.getPendingFiles().map(file => file.name), ['attributes.csv']);
      await controls.applyToFrame(current);
      assert.deepEqual(current.properties.map(property => property.name), ['mass', 'coordination']);
      await controls.importFile(csv);
      assert.equal(controls.getPendingFiles().length, 0);
      assert.deepEqual(current.properties.map(property => property.name), ['mass', 'coordination', 'imported_x']);
      assert.ok(imported.some(event => event.reason === 'restore'));
      assert.deepEqual(removed[0].removedNames, ['energy']);
    });
    await t.test('row-order recipe restores against the original mapping frame', async () => {
      controls.reset(); current = frame([11, 22], 0);
      const aux = new File(['1\n2\n'], 'weights.aux');
      await controls.importFile(aux); const saved = controls.getState();
      controls.reset(); current = frame([22, 11], 3); controls.setState(saved);
      await controls.importFile(aux);
      assert.deepEqual([...current.properties.find(property => property.name === 'aux_1').data], [2, 1]);
    });
    await t.test('failed mismatched ID mapping is transactional', async () => {
      const before = current.properties;
      await assert.rejects(controls.importFile(new File(['id,new_value\n11,1\n44,2'], 'bad.csv')), /Unknown atom ID/);
      assert.equal(current.properties, before);
      assert.equal(controls.getState().files.length, 1);
      const previousVersion = sourceVersion;
      const slowClient = { async request() { sourceVersion++; return {}; }, reset() {} };
      const interrupted = initializeExternalPropertyControls({ getFrame: () => current, getSourceVersion: () => sourceVersion, workerClient: slowClient });
      await assert.rejects(interrupted.importFile(auxFile()), { name: 'AbortError' });
      assert.ok(sourceVersion > previousVersion);
    });
    controls.reset();
  } finally { if (originalSelf === undefined) delete globalThis.self; else globalThis.self = originalSelf; }
});

function auxFile() { return new File(['1\n2'], 'interrupted.aux'); }

test('attribute Worker client clones frame IDs and rejects obsolete requests on reset', async () => {
  const originalWorker = globalThis.Worker;
  class FakeWorker {
    constructor() { this.listeners = new Map(); this.messages = []; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    postMessage(...arguments_) { this.messages.push(arguments_); }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = FakeWorker;
  try {
    const client = new ExternalPropertyWorkerClient();
    const ids = new Float64Array([11, 22]);
    const pending = client.request('attach', { frame: { ids } });
    const worker = client.worker;
    assert.equal(worker.messages[0].length, 1, 'IDs are posted without a transfer list');
    assert.equal(ids.byteLength, 16);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    client.reset(); await rejected;
    assert.equal(worker.terminated, true);
    const next = client.request('reset', {});
    worker.listeners.get('message')({ data: { id: 2, ok: true, result: { obsolete: true } } });
    assert.equal(client.pending.size, 1);
    client.worker.listeners.get('message')({ data: { id: 2, ok: true, result: {} } });
    assert.deepEqual(await next, {});
    client.reset();
  } finally { globalThis.Worker = originalWorker; }
});
