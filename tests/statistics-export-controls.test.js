import assert from 'node:assert/strict';
import test from 'node:test';
import { StatisticsExportClient } from '../src/statistics-export-client.js';
import { initializeStatisticsExports, STATISTICS_EXPORT_BUTTONS } from '../src/statistics-export-controls.js';
import { buildStatisticsTable, serializeCsv } from '../src/statistics-export.js';
import { createCell } from '../src/data/model.js';

test('persistent export Worker reuses snapshots, releases them without replacement and preserves source buffers', async t => {
  const originalSelf = globalThis.self;
  let messageHandler, activeWorker;
  globalThis.self = {
    addEventListener(type, callback) { assert.equal(type, 'message'); messageHandler = callback; },
    postMessage(data) { activeWorker.listeners.get('message')({ data: structuredClone(data) }); },
  };
  t.after(() => { if (originalSelf === undefined) delete globalThis.self; else globalThis.self = originalSelf; });
  await import('../src/workers/statistics-export-worker.js');
  let creations = 0;
  class Worker {
    constructor() { creations++; this.listeners = new Map(); this.messages = []; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    postMessage(...args) {
      this.messages.push(args);
      const message = structuredClone(args[0]);
      queueMicrotask(() => { activeWorker = this; messageHandler({ data: message }); });
    }
    terminate() { this.terminated = true; }
  }
  const client = new StatisticsExportClient({ workerFactory: () => new Worker() });
  const data = frameSnapshot(), key = {};
  const coordinatesBefore = [...data.frame.positions], energyBefore = [...data.frame.properties[0].data];
  const first = await client.export(data, key, 'summary');
  const second = await client.export(data, key, 'atoms');
  assert.equal(creations, 1);
  const requests = client.worker.messages;
  assert.ok(requests[0][0].payload.snapshot);
  assert.ok(!requests[1][0].payload.snapshot, 'the second export reuses the Worker snapshot');
  assert.ok(requests.every(args => args.length === 1), 'analysis arrays are never posted with a transfer list');
  assert.equal(first.blob.type, 'text/csv;charset=utf-8');
  assert.ok((await second.blob.text()).includes('11,0,Fe,1,2,3,-2'));
  assert.deepEqual([...data.frame.positions], coordinatesBefore);
  assert.deepEqual([...data.frame.properties[0].data], energyBefore);
  await client.clearSnapshot();
  assert.equal(creations, 1); assert.equal(client.snapshotKey, null);
  const third = await client.export(data, key, 'properties');
  assert.ok(third.blob.size > 0);
  assert.ok(client.worker.messages.at(-1)[0].payload.snapshot);
  await assert.rejects(client.export(data, key, 'rdf'), /Calculate RDF/);
  assert.equal(creations, 1);
  client.dispose();
});

class Element {
  constructor() { this.listeners = new Map(); this.disabled = false; this.textContent = ''; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  removeEventListener(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); }
}

function frameSnapshot() {
  return { fileName: 'Fe.dump', frameIndex: 0, frame: { ids: new Float64Array([11, 22]), types: new Uint16Array([0, 0]), typeLabels: ['Fe'],
    positions: new Float64Array([1, 2, 3, 4, 5, 6]), cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }),
    properties: [{ name: 'energy', unit: 'eV', data: new Float64Array([-2, NaN]) }] } };
}

function controlsFixture() {
  const elements = Object.fromEntries([...Object.keys(STATISTICS_EXPORT_BUTTONS), 'statistics-export-status'].map(id => [id, new Element()]));
  let current = frameSnapshot().frame, results = {}, exports = [], clears = 0, download = [];
  let nextOutput;
  const client = { async clearSnapshot() { clears++; }, async export(snapshot, key, kind) {
    exports.push({ snapshot, key, kind });
    if (nextOutput) return nextOutput;
    return { blob: new Blob(['test']), filename: 'file.csv', kind };
  }, dispose() { this.disposed = true; } };
  const controls = initializeStatisticsExports({ getFrame: () => current, getFileName: () => 'Fe.dump', getResults: () => results,
    documentRoot: { getElementById: id => elements[id] }, client, onDownload: (...args) => download.push(args) });
  return { elements, controls, exports, client, download, get clears() { return clears; },
    setFrame(frame) { current = frame; }, frame: () => current, setResults(value) { results = value; },
    delayExport() { let resolve; nextOutput = new Promise(done => { resolve = done; }); return resolve; } };
}

test('export availability follows completed CPU/GPU data, cancellation and all property references', async () => {
  const h = controlsFixture();
  assert.equal(h.elements['export-statistics-summary'].disabled, false);
  assert.equal(h.elements['export-property-statistics'].disabled, false);
  assert.equal(h.elements['export-bond-length-distribution'].disabled, true);
  h.setResults({ bondStatistics: { result: { q4: [1, NaN], q6: [2, NaN], engine: 'webgpu' } }, voronoi: { result: { atomicVolume: [500, 500] } } });
  h.controls.refresh();
  assert.equal(h.elements['export-bond-order-statistics'].disabled, false);
  assert.equal(h.elements['export-voronoi-csv'].disabled, false);
  await h.controls.exportTable('summary'); await h.controls.exportTable('properties');
  assert.equal(h.exports[0].key, h.exports[1].key);
  assert.equal(h.download.length, 2);
  const clears = h.clears;
  h.controls.refresh(); h.controls.refresh();
  assert.equal(h.clears, clears, 'ordinary refreshes neither clone arrays nor release a reusable snapshot');
  h.frame().properties[0] = { ...h.frame().properties[0], name: 'renamed_energy' };
  h.controls.refresh(); await h.controls.exportTable('properties');
  assert.notEqual(h.exports[1].key, h.exports[2].key);
  assert.equal(h.exports[2].snapshot.frame.properties[0].name, 'renamed_energy');
  h.setResults({}); h.controls.refresh();
  assert.equal(h.elements['export-bond-order-statistics'].disabled, true);
  h.controls.setEnabled(false);
  assert.equal(h.elements['export-statistics-summary'].disabled, true);
  assert.equal(await h.controls.exportTable('summary'), null);
  h.controls.dispose(); assert.equal(h.client.disposed, true);
  assert.equal(h.elements['export-statistics-summary'].listeners.size, 0);
});

test('frame changes during formatting discard the obsolete download and keep the new controls usable', async () => {
  const h = controlsFixture(), resolve = h.delayExport();
  const pending = h.controls.exportTable('atoms');
  assert.equal(h.elements['export-atom-properties'].disabled, true);
  h.setFrame({ ...h.frame(), frameIndex: 1 }); h.controls.refresh();
  resolve({ blob: new Blob(['obsolete']), filename: 'old.csv' });
  assert.equal(await pending, null);
  assert.equal(h.download.length, 0);
  assert.match(h.elements['statistics-export-status'].textContent, /frame changed/);
  assert.equal(h.elements['export-atom-properties'].disabled, false);
  h.controls.dispose();
});

test('distribution exports avoid copying unrelated atom arrays and face geometry', async () => {
  const h = controlsFixture();
  h.setResults({ voronoi: { result: { summary: { meanVolume: 500, volumeError: 0 },
    indexCounts: [{ index: '<0,6,0,0>', count: 2, fraction: 1 }], atomicVolume: [500, 500],
    faceOffsets: [0, 1, 2], faceAreas: [100, 100], faceOrders: [4, 4], faceNeighbors: [1, 0], faceBoundary: [0, 0], faceAccepted: [1, 1] } } });
  h.controls.refresh(); await h.controls.exportTable('summary'); await h.controls.exportTable('voronoi-distributions');
  const summary = h.exports[0].snapshot, distributions = h.exports[1].snapshot;
  assert.equal(summary.results.voronoi.faceAreas, undefined);
  assert.equal(summary.results.voronoi.atomicVolume, undefined);
  assert.equal(distributions.frame.ids, undefined);
  assert.equal(distributions.frame.positions, undefined);
  assert.equal(distributions.frame.atomCount, 2);
  assert.equal(distributions.results.voronoi.faceOffsets, undefined);
  assert.ok(serializeCsv(buildStatisticsTable(distributions, 'voronoi-distributions')).includes('"<0,6,0,0>",2,1'));
  assert.ok(serializeCsv(buildStatisticsTable(summary, 'summary')).includes('voronoi,meanVolume,,500,Å³'));
  await h.controls.exportTable('voronoi-faces');
  const faces = h.exports[2].snapshot;
  assert.equal(faces.frame.positions, undefined);
  assert.ok(faces.results.voronoi.faceOffsets);
  assert.ok(serializeCsv(buildStatisticsTable(faces, 'voronoi-faces')).includes('11,1,100,4,22,0,1'));
  h.controls.dispose();
});
