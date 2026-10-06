import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { calculateVoronoi, calculateVoronoiGeometry } from '../src/analysis/voronoi.js';
import { prepareVoronoiSelection, expandVoronoiResult, voronoiSelectionRange } from '../src/analysis/voronoi-selection.js';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

function checkerboard() {
  const points = [], types = [];
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) {
    points.push(x / 2, y / 2, z / 2); types.push((x + y + z) % 2);
  }
  return { fractional: Float64Array.from(points), types: Uint16Array.from(types), typeLabels: ['Ni', 'Cu'],
    ids: Uint32Array.from({ length: 8 }, (_, index) => index + 1),
    cell: createCell({ vectors: [4, 0, 0, 0, 4, 0, 0, 0, 4], pbc: [true, true, true] }) };
}

function pool(stats, cores = 4) {
  return new AnalysisPool({ environment: { navigator: { hardwareConcurrency: cores } }, workerFactory: () => {
    const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url)); stats.created++;
    return { addEventListener: (name, listener) => worker.on(name, data => listener(name === 'message' ? { data } : data)),
      postMessage: (data, transfers) => worker.postMessage(data, transfers), terminate: () => worker.terminate() };
  } });
}

test('element selection tessellates only the chosen sites and preserves full source indexing with excluded NaN rows', async () => {
  const frame = checkerboard(), original = frame.fractional.slice();
  const all = await calculateVoronoi(frame);
  assert.ok(all.atomicVolume.every(value => Math.abs(value - 8) < 1e-10));
  for (const label of ['Ni', 'Cu']) {
    const result = await calculateVoronoi(frame, { selectedTypes: [label] });
    const indices = Array.from(frame.types, (type, atom) => frame.typeLabels[type] === label ? atom : -1).filter(atom => atom >= 0);
    assert.deepEqual(Array.from(result.analyzedAtomIndices), indices);
    assert.deepEqual(result.selectedTypes, [label]);
    assert.equal(result.summary.atomCount, 4);
    assert.ok(Math.abs(result.summary.totalVolume - 64) < 1e-10);
    assert.ok(Math.abs(result.summary.volumeError) < 1e-12);
    assert.deepEqual(result.coordinationHistogram, [{ value: 12, count: 4, fraction: 1 }]);
    for (let atom = 0; atom < 8; atom++) {
      if (indices.includes(atom)) {
        assert.ok(Math.abs(result.atomicVolume[atom] - 16) < 1e-10);
        assert.equal(result.voronoiCoordination[atom], 12);
        assert.equal(result.voronoiIndices[atom], '<0,12,0,0>');
        assert.equal(result.faceOffsets[atom + 1] - result.faceOffsets[atom], 12);
      } else {
        for (const field of ['atomicVolume', 'voronoiSurfaceArea', 'voronoiCoordination', 'voronoiBoundaryFaces', 'voronoiMaxFaceOrder']) assert.ok(Number.isNaN(result[field][atom]), field);
        assert.equal(result.voronoiIndices[atom], '');
        assert.equal(result.faceOffsets[atom], result.faceOffsets[atom + 1]);
      }
    }
    assert.ok(result.faceNeighbors.every(atom => indices.includes(atom)));
  }
  assert.deepEqual(frame.fractional, original);
});

test('compact selection snapshots are stable across equivalent labels and refresh for coordinate/type/cell mutations', () => {
  const frame = checkerboard(), first = prepareVoronoiSelection(frame, ['Ni']);
  assert.equal(prepareVoronoiSelection(frame, ['Ni', 'Ni']).frame, first.frame);
  frame.fractional[0] += .01;
  const moved = prepareVoronoiSelection(frame, ['Ni']);
  assert.notEqual(moved.frame, first.frame);
  assert.equal(moved.frame.fractional[0], frame.fractional[0]);
  frame.types[0] = 1;
  const changedType = prepareVoronoiSelection(frame, ['Ni']);
  assert.deepEqual(Array.from(changedType.atomIndices), [3, 5, 6]);
  frame.cell.vectors[0] += 1;
  assert.notEqual(prepareVoronoiSelection(frame, ['Ni']).frame, changedType.frame);
  assert.deepEqual(prepareVoronoiSelection(frame, ['Ni', 'Cu']).selectedTypes, ['Cu', 'Ni']);
  for (const labels of [[], ['Fe'], [0], 'Ni']) assert.throws(() => prepareVoronoiSelection(frame, labels));
  frame.typeLabels.push('Zn');
  assert.throws(() => prepareVoronoiSelection(frame, ['Zn']), /no atoms/);
});

test('all-mode expansion preserves scientific arrays while subset central source ranges retain only their compact populations', async () => {
  const frame = checkerboard(), result = await calculateVoronoi(frame), allSelection = prepareVoronoiSelection(frame, null),
    all = expandVoronoiResult(result, allSelection);
  assert.equal(allSelection.frame, frame);
  for (const [name, value] of Object.entries(result)) if (ArrayBuffer.isView(value)) assert.equal(all[name], value);
  const explicitAll = await calculateVoronoi(frame, { selectedTypes: ['Ni', 'Cu'] });
  for (const [name, value] of Object.entries(result)) if (ArrayBuffer.isView(value)) assert.deepEqual(explicitAll[name], value);
  const selected = prepareVoronoiSelection(frame, ['Ni']);
  assert.deepEqual(voronoiSelectionRange(selected, { startAtom: 2, endAtom: 6 }), { startAtom: 1, endAtom: 3 });
  const partial = await calculateVoronoi(frame, { selectedTypes: ['Ni'], startAtom: 2, endAtom: 6 });
  assert.deepEqual(Array.from(partial.analyzedAtomIndices), [3, 5]);
  assert.equal(partial.summary.atomCount, 2);
  assert.equal(partial.summary.volumeError, null);
  assert.ok(Number.isNaN(partial.atomicVolume[0]), 'uncalculated selected rows also remain NaN');
  assert.throws(() => voronoiSelectionRange(selected, { startAtom: 1, endAtom: 2 }), /no selected atoms/);
});

test('excluded sites are absent neighbors even when their coordinates coincide, leave the open domain or are nonfinite', async () => {
  const frame = checkerboard();
  const reference = await calculateVoronoi(frame, { selectedTypes: ['Ni'] });
  frame.fractional.set(frame.fractional.subarray(0, 3), 3);
  frame.fractional[2 * 3] = NaN;
  frame.fractional[4 * 3 + 1] = Infinity;
  frame.fractional[7 * 3 + 2] = -5;
  const selected = await calculateVoronoi(frame, { selectedTypes: ['Ni'] });
  for (const name of ['atomicVolume', 'faceOffsets', 'faceAreas', 'faceNeighbors', 'voronoiIndices']) assert.deepEqual(selected[name], reference[name]);
  frame.cell.pbc = [false, false, false];
  const open = await calculateVoronoi(frame, { selectedTypes: ['Ni'] });
  assert.ok(Math.abs(open.summary.volumeError) < 1e-10);
});

test('selected cell and streamed CPU batch geometry retain source neighbors and share resident subset indices', async () => {
  const frame = checkerboard(), stats = { created: 0 }, analysis = pool(stats);
  try {
    const selected = await analysis.analyzeCPU(frame, { kind: 'voronoi', selectedTypes: ['Ni'] });
    const chunks = [];
    const batch = await analysis.analyzeCPU(frame, { kind: 'voronoiGeometryBatch', atomIndices: selected.analyzedAtomIndices,
      selectedTypes: selected.selectedTypes }, { retainCells: false, onGeometryChunk(cells) { chunks.push(...cells); } });
    assert.deepEqual(batch.cells, []);
    assert.equal(batch.indexBuilds, 0);
    assert.equal(batch.frameUploads, 0);
    assert.equal(batch.kernelInitializations, 0);
    assert.deepEqual(Array.from(batch.analyzedAtomIndices), [0, 3, 5, 6]);
    assert.deepEqual(chunks.map(cell => cell.atomIndex), [0, 3, 5, 6]);
    for (const cell of chunks) {
      const direct = await calculateVoronoiGeometry(frame, { atomIndex: cell.atomIndex, selectedTypes: ['Ni'] });
      for (const field of ['center', 'vertices', 'faceOffsets', 'faceVertices', 'faceNeighbors', 'faceBoundary']) assert.deepEqual(cell[field], direct[field], field);
      assert.ok(cell.faceNeighbors.every(atom => [0, 3, 5, 6].includes(atom)));
    }
    await assert.rejects(analysis.analyzeCPU(frame, { kind: 'voronoiGeometry', atomIndex: 1, selectedTypes: ['Ni'] }), /excluded/);
    assert.equal(stats.created, 1);
  } finally { analysis.close(); }
});

test('large geometry batches distribute bounded chunks, honor backpressure, cancel without rebuilding Workers and preserve atom order', async () => {
  const frame = crystalFrame('fcc', 6), stats = { created: 0 }, analysis = pool(stats), controller = new AbortController();
  let callbackCount = 0;
  try {
    await assert.rejects(analysis.analyzeCPU(frame, { kind: 'voronoiGeometryBatch' }, { signal: controller.signal, retainCells: false,
      async onGeometryChunk(cells) { callbackCount++; assert.ok(cells.length <= 128); controller.abort(); await Promise.resolve(); } }), { name: 'AbortError' });
    assert.ok(callbackCount >= 1);
    const created = stats.created;
    const batch = await analysis.analyzeCPU(frame, { kind: 'voronoiGeometryBatch' });
    assert.equal(batch.workerCount, 2);
    assert.ok(batch.chunkCount > batch.workerCount);
    assert.equal(batch.cells.length, frame.ids.length);
    assert.deepEqual(batch.cells.map(cell => cell.atomIndex), Array.from({ length: frame.ids.length }, (_, index) => index));
    assert.equal(stats.created, created, 'bounded cancelled chunks preserve the same native Worker slots');
    assert.equal(batch.kernelInitializations, 0);
    assert.equal(analysis.active.size, 0);
  } finally { analysis.close(); }
});
