import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { calculateVoronoi, mergeVoronoiPartials, VORONOI_FIELDS } from '../src/analysis/voronoi.js';
import { VoronoiIndexBuilder, materializeVoronoiIndices } from '../src/analysis/voronoi-indices.js';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

const fields = [...Object.keys(VORONOI_FIELDS), 'faceOffsets', 'faceAreas', 'faceOrders', 'faceNeighbors', 'faceBoundary', 'faceAccepted'];
const statistics = ['voronoiIndices', 'summary', 'coordinationHistogram', 'volumeHistogram', 'faceAreaHistogram', 'indexCounts'];
function compare(actual, expected) {
  for (const field of [...fields, ...statistics]) assert.deepEqual(actual[field], expected[field], field);
}

test('compact topology IDs retain distinct high orders, zeros and repeated labels', () => {
  const builder = new VoronoiIndexBuilder(5);
  for (const [atom, orders] of [[0, [4, 4]], [1, [8]], [2, []], [3, [4, 4]], [4, [16]]]) {
    builder.begin(); for (const order of orders) builder.add(order); builder.finish(atom);
  }
  assert.equal(builder.labels.length, 4);
  assert.equal(builder.ids[0], builder.ids[3]);
  const result = materializeVoronoiIndices({ voronoiIndexIds: builder.ids, voronoiIndexLabels: builder.labels });
  assert.deepEqual(result.voronoiIndices, ['<0,2,0,0>', '<0,0,0,0,0,1>', '<0,0,0,0>', '<0,2,0,0>', '<0,0,0,0,0,0,0,0,0,0,0,0,0,1>']);
  assert.deepEqual(Object.keys(result), ['voronoiIndices']);
});

test('compact and legacy partials merge identically without expanding intermediate strings', async () => {
  const frame = crystalFrame('bcc', 3), options = { relativeFaceAreaThreshold: .07 };
  const expected = await calculateVoronoi(frame, options);
  const first = await calculateVoronoi(frame, { ...options, startAtom: 0, endAtom: 27, compactIndices: true, skipStatistics: true });
  const second = await calculateVoronoi(frame, { ...options, startAtom: 27, endAtom: 54, skipStatistics: true });
  assert.equal(first.voronoiIndices, undefined);
  assert.equal(first.voronoiIndexLabels.length, 1);
  for (const field of fields.slice(5)) {
    assert.equal(first[field].buffer.byteLength, first[field].byteLength, `${field} has no unused capacity to transfer`);
  }
  const merged = mergeVoronoiPartials([second, first], 54, { compactIndices: true });
  assert.equal(merged.voronoiIndices, undefined);
  compare(materializeVoronoiIndices(merged), expected);
  compare(mergeVoronoiPartials([first, second], 54), expected);
  mergeVoronoiPartials([first, second], 54, { consumePartials: true, compactIndices: true });
  assert.equal(first.voronoiIndexIds, undefined);
  assert.equal(first.voronoiIndexLabels, undefined);
});

test('partial-local topology IDs remap correctly when label tables have different orders', () => {
  const labels = ['<0,6,0,8>', '<0,12,0,0>', '<0,2,4,2>'];
  // Repeated labels have different IDs in each partial, as happens when the
  // scheduler assigns different heterogeneous central-atom ranges to Workers.
  const makePartial = (startAtom, table, ids) => ({
    ...Object.fromEntries(Object.entries(VORONOI_FIELDS).map(([name, [Type]]) => [name, new Type(ids.length)])),
    faceOffsets: new Uint32Array(ids.length + 1), faceAreas: new Float64Array(), faceOrders: new Uint32Array(),
    faceNeighbors: new Int32Array(), faceBoundary: new Uint8Array(), faceAccepted: new Uint8Array(),
    voronoiIndexIds: Uint32Array.from(ids), voronoiIndexLabels: table,
    startAtom, endAtom: startAtom + ids.length, cellVolume: 1, candidateCount: 0,
  });
  const first = makePartial(0, [labels[2], labels[0]], [0, 1, 0]);
  const second = makePartial(3, [labels[0], labels[1], labels[2]], [0, 1, 2]);
  const result = mergeVoronoiPartials([second, first], 6, { compactIndices: true });
  assert.deepEqual(result.voronoiIndexLabels, [labels[2], labels[0], labels[1]]);
  assert.deepEqual(Array.from(result.voronoiIndexIds), [0, 1, 0, 1, 2, 0]);
  assert.deepEqual(materializeVoronoiIndices(result).voronoiIndices,
    [labels[2], labels[0], labels[2], labels[0], labels[1], labels[2]]);
});

// Exact pre-optimization scientific hashes from adb0648, including every
// face CSR, per-atom label, distribution and summary. Timing/cache metadata
// is deliberately excluded. Independent geometric tests cover the physics.
test('periodic, finite, tilted and empty radical cells retain baseline scientific bytes', async () => {
  const points = [.079, .184, .727, .342, .781, .091, .674, .382, .523,
    .928, .864, .217, .164, .538, .837, .743, .153, .952, .418, .427, .338];
  const tilted = periodic => ({ fractional: Float64Array.from(points),
    cell: createCell({ vectors: [1.9, .2, .1, .6, 1.4, .2, -.1, .3, 1.7], pbc: [true, periodic, true] }) });
  for (const [frame, options, expected] of [
    [crystalFrame('fcc', 4), {}, '04b46911052ada0025f6849c545b33ef5f4bee1c10013f1b1cb3452ce5a6815a'],
    [crystalFrame('bcc', 3), { relativeFaceAreaThreshold: .07 }, '3a66382c12204450f7a04e60fbbe60372ed850c35271d16cb61ddbdc7b3dd7eb'],
    [tilted(true), {}, '9fe363152a302f6b88e80a505ba517b511d33f6f06ae55594cd8cd64d69dbfc1'],
    [tilted(false), {}, '427884091fcff533eb4274e979108b5900014bae78a319a487663024221239e3'],
    [{ fractional: Float64Array.of(.25, .5, .5, .75, .5, .5),
      cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) },
    { radii: Float64Array.of(1, 10) }, 'a7d1cea77775cf08493fcff3085869cf97cc673f529cdbdc19ec0c3acf7fb0a1'],
  ]) {
    const output = await calculateVoronoi(frame, options), hash = createHash('sha256');
    for (const field of fields) hash.update(output[field]);
    for (const field of statistics) hash.update(JSON.stringify(output[field]));
    assert.equal(hash.digest('hex'), expected);
  }
});

for (const shared of [false, true]) test(`real ${shared ? 'shared' : 'private'} Workers transfer compact labels at every hop and preserve public results`, async () => {
  const messages = [], residentRequests = [], terminations = [], frame = crystalFrame('fcc', 6);
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: 4 }, crossOriginIsolated: shared },
    workerFactory: () => {
      const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url)), requests = new Map();
      return {
        addEventListener(name, listener) {
          worker.on(name, data => {
            if (name !== 'message') { listener(data); return; }
            if (data.ok && ['voronoi', 'voronoiFinalize'].includes(requests.get(data.id))) {
              const result = data.result;
              messages.push({ kind: requests.get(data.id), perAtomStrings: result.voronoiIndices,
                ids: result.voronoiIndexIds?.length, labels: result.voronoiIndexLabels?.length });
            }
            listener({ data });
          });
        },
        postMessage(data, transfers) {
          requests.set(data.id, data.kind);
          if (data.kind === 'voronoi' && data.fractional === undefined) {
            residentRequests.push(data.id);
            for (const field of ['cell', 'types', 'cpuNeighborIndex', 'cpuCoordinationIndex']) {
              assert.equal(data[field], undefined, `resident chunks omit ${field}`);
            }
          }
          if (data.kind === 'voronoiFinalize') for (const partial of data.partials) {
            assert.equal(partial.voronoiIndices, undefined);
            assert.ok(partial.voronoiIndexIds instanceof Uint32Array);
          }
          worker.postMessage(data, transfers);
        },
        terminate() { terminations.push(worker.terminate()); },
      };
    } });
  try {
    await pool.prepareCpuFrame(frame);
    const result = await pool.analyzeCPU(frame, { kind: 'voronoi' });
    compare(result, await calculateVoronoi(frame));
    assert.ok(messages.some(message => message.kind === 'voronoi'));
    assert.ok(messages.some(message => message.kind === 'voronoiFinalize'));
    assert.ok(residentRequests.length > 0, 'prepared Workers receive only resident frame keys');
    assert.ok(messages.every(message => message.perAtomStrings === undefined && message.ids > 0 && message.labels === 1));
    assert.equal(result.voronoiIndexIds, undefined);
    assert.equal(result.voronoiIndexLabels, undefined);
    assert.equal(result.kernelInitializations, 0);
    assert.equal(result.indexBuilds, 0);
  } finally { pool.close(); await Promise.allSettled(terminations); }
});
