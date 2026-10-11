import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { calculateAtomicStrain, STRAIN_FIELDS } from '../src/analysis/atomic-strain.js';
import { calculatePreparedDisplacements, minimumImageDisplacement } from '../src/analysis/displacement.js';
import { calculatePtm } from '../src/analysis/ptm.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

function realPool(sharedMemory, cores, observe = () => {}) {
  const stats = { created: 0, terminated: 0, bytes: 0, messages: [] };
  const pool = new AnalysisPool({ environment: { navigator: { hardwareConcurrency: cores }, crossOriginIsolated: sharedMemory },
    workerFactory() {
      const worker = new Worker(new URL('./helpers/node-analysis-worker.mjs', import.meta.url)); stats.created++;
      return {
        addEventListener(name, listener) { worker.on(name, data => listener(name === 'message' ? { data } : data)); },
        postMessage(data, transfers = []) {
          stats.bytes += transfers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
          stats.messages.push({ kind: data.kind, range: data.sourceRange, frameKey: data.cpuFrameKey,
            fractional: data.fractional !== undefined });
          observe(data); worker.postMessage(data, transfers);
        },
        terminate() { stats.terminated++; worker.terminate(); },
      };
    } });
  return { pool, stats };
}

function largeFrame(count = 100_003) {
  return { fractional: new Float64Array(count * 3), types: Uint16Array.from({ length: count }, (_, i) => i % 2),
    cell: createCell({ vectors: [10, 0, 0, 9, 1, 0, .7, -.8, 10] }) };
}

function cachedFits(frame) {
  const count = frame.types.length;
  const ptmInput = { structures: Uint8Array.from(frame.types, type => type ? 2 : 1),
    scales: Float64Array.from({ length: count }, (_, atom) => (atom % 29 ? 1 : -1) * .3),
    deformation: new Float64Array(count * 9), rmsd: new Float32Array(count), distances: new Float32Array(count) };
  for (let atom = 0; atom < count; atom++) {
    const sign = ptmInput.scales[atom] < 0 ? -1 : 1;
    ptmInput.deformation.set([sign, .01 * (atom % 3), -0, 0, sign * 1.1, .02, -.03, 0, sign * .9], atom * 9);
  }
  ptmInput.scales[17] = NaN; ptmInput.structures[4097] = 0; ptmInput.deformation[8193 * 9] = NaN;
  ptmInput.deformation[61 * 9 + 8] *= -1;
  return ptmInput;
}

for (const shared of [false, true]) for (const cores of [3, 4, 5]) {
  test(`cached strain owned rows preserve every tensor field and source across ${cores - 2} Workers (${shared ? 'shared' : 'copied'})`, async () => {
    const frame = largeFrame(), ptmInput = cachedFits(frame);
    const parameters = { kind: 'strain', ptmInput, references: [{ structure: 1, a: 4.1 }, { structure: 2, a: 3.2, c: 5.3 }] };
    const expected = await calculateAtomicStrain(frame, parameters);
    const original = ptmInput.deformation.slice();
    const { pool, stats } = realPool(shared, cores, data => {
      if (data.kind !== 'strain' || shared) return;
      const { startAtom, endAtom, totalAtoms } = data.sourceRange, rows = endAtom - startAtom;
      assert.equal(totalAtoms, frame.types.length); assert.equal(data.cpuFrameKey, undefined); assert.equal(data.fractional, undefined);
      assert.equal(data.types.length, rows);
      assert.deepEqual(Object.keys(data.ptmInput).sort(), ['deformation', 'scales', 'structures']);
      assert.equal(data.ptmInput.deformation.length, rows * 9);
      assert.deepEqual(data.ptmInput.scales, ptmInput.scales.subarray(startAtom, endAtom));
    });
    try {
      const result = await pool.analyzeCPU(frame, parameters);
      assert.equal(result.workerCount, cores - 2);
      for (const name of STRAIN_FIELDS) assert.deepEqual(result[name], expected[name], name);
      assert.equal(result.incomplete, expected.incomplete);
      assert.equal(result.frameUploads, shared ? cores - 2 : 0);
      if (!shared) assert.equal(stats.bytes, frame.types.length * (1 + 8 + 72 + 2));
      else assert.equal(stats.bytes, 0);
      assert.ok(result.memoryEstimateBytes <= result.memoryBudgetBytes);
      assert.deepEqual(ptmInput.deformation, original);
      const bytes = stats.bytes;
      ptmInput.scales[100] *= 1.1;
      const edited = { ...parameters, references: [{ structure: 1, a: 4.2 }, parameters.references[1]] };
      const expectedEdited = await calculateAtomicStrain(frame, edited);
      const repeated = await pool.analyzeCPU(frame, edited);
      for (const name of STRAIN_FIELDS) assert.deepEqual(repeated[name], expectedEdited[name], name);
      assert.equal(stats.created, cores - 2); assert.equal(stats.terminated, 0);
      if (!shared) assert.equal(stats.bytes - bytes, frame.types.length * 83);
      assert.equal(pool.active.size, 0); assert.equal(pool.queue.length, 0);
    } finally { pool.close(); }
  });

  test(`displacement gathered reference rows preserve IDs, NaNs and rounded magnitudes across ${cores - 2} Workers (${shared ? 'shared' : 'copied'})`, async () => {
    const frame = largeFrame(), count = frame.types.length, referenceCount = count + 37;
    const parameters = { kind: 'displacement', minimumImage: false, mappingMode: 'id',
      referenceMapping: Int32Array.from({ length: count }, (_, i) => (count - 1 - i) % referenceCount),
      currentPositions: Float64Array.from({ length: count * 3 }, (_, i) => i % 701 / 13),
      referencePositions: Float64Array.from({ length: referenceCount * 3 }, (_, i) => i % 47 / 17) };
    parameters.referenceMapping[3] = -1; parameters.currentPositions[9] = NaN;
    parameters.currentPositions[0] = -0; parameters.referencePositions[(count - 1) * 3] = 0;
    parameters.currentPositions[57] = 3e38; parameters.currentPositions[58] = 3e38; parameters.currentPositions[59] = 3e38;
    const expected = calculatePreparedDisplacements(frame, parameters), original = parameters.currentPositions.slice();
    const { pool, stats } = realPool(shared, cores, data => {
      if (data.kind !== 'displacement' || shared) return;
      const { startAtom, endAtom, totalAtoms, referenceCount: suppliedReferenceCount } = data.sourceRange;
      assert.equal(totalAtoms, count); assert.equal(suppliedReferenceCount, referenceCount);
      assert.equal(data.cpuFrameKey, undefined); assert.equal(data.fractional, undefined); assert.equal(data.types, undefined);
      assert.equal(data.currentPositions.length, (endAtom - startAtom) * 3);
      assert.equal(data.referencePositions.length, (endAtom - startAtom) * 3);
      for (let row = 0; row < data.referenceMapping.length; row++) {
        const atom = data.referenceMapping[row];
        assert.equal(atom, parameters.referenceMapping[startAtom + row]);
        for (let axis = 0; axis < 3; axis++) assert.ok(Object.is(data.referencePositions[row * 3 + axis], atom < 0 ? NaN : parameters.referencePositions[atom * 3 + axis]));
      }
    });
    try {
      const result = await pool.analyzeCPU(frame, parameters);
      assert.equal(result.workerCount, cores - 2); assert.deepEqual(result.vectors, expected.vectors);
      assert.deepEqual(result.magnitudes, expected.magnitudes); assert.ok(Object.is(result.vectors[0], -0));
      assert.ok(result.magnitudes[19] > 3.4e38 && Number.isFinite(result.magnitudes[19]));
      assert.strictEqual(result.referenceMapping, parameters.referenceMapping);
      assert.equal(result.matched, count - 1); assert.equal(result.frameUploads, shared ? cores - 2 : 0);
      assert.equal(stats.bytes, shared ? 0 : count * 52);
      assert.deepEqual(parameters.currentPositions, original); assert.ok(parameters.referencePositions.byteLength > 0);
      assert.equal(stats.created, cores - 2); assert.equal(stats.terminated, 0);
      assert.equal(pool.active.size, 0);
    } finally { pool.close(); }
  });
}

test('owned cached strain and displacement preserve the previously warmed PTM heap and resident frame ACK', async () => {
  const frame = crystalFrame('fcc', 2), ptmInput = await calculatePtm(frame);
  const { pool, stats } = realPool(false, 3);
  try {
    const first = await pool.analyzeCPU(frame, { kind: 'ptm' });
    const slot = [...pool.slots][0], keys = [...slot.cpuFrameKeys], heap = slot.moduleHeapBytes.ptm;
    await pool.analyzeCPU(frame, { kind: 'strain', ptmInput, references: [{ structure: 1, a: 4.1 }] });
    await pool.analyzeCPU(frame, { kind: 'displacement', referenceMapping: Int32Array.from(frame.ids, (_, i) => i),
      currentPositions: frame.positions, referencePositions: frame.positions, mappingMode: 'id', minimumImage: false });
    assert.deepEqual([...slot.cpuFrameKeys], keys); assert.equal(slot.moduleHeapBytes.ptm, heap);
    const next = await pool.analyzeCPU(frame, { kind: 'ptm' });
    assert.equal(next.frameUploads, 0); assert.equal(next.kernelInitializations, 0);
    assert.deepEqual(next.deformation, first.deformation); assert.equal(stats.created, 1); assert.equal(stats.terminated, 0);
  } finally { pool.close(); }
});

test('cancelling an owned cached tensor range retains its Worker lease until ACK and preserves warm PTM resources', async () => {
  const frame = largeFrame(), small = crystalFrame('fcc', 2), ptmInput = cachedFits(frame);
  const { pool, stats } = realPool(false, 3);
  const controller = new AbortController();
  let checkpoint = false;
  try {
    const first = await pool.analyzeCPU(small, { kind: 'ptm' });
    const interrupted = pool.analyzeCPU(frame, { kind: 'strain', ptmInput,
      references: [{ structure: 1, a: 4 }, { structure: 2, a: 3, c: 5 }] }, {
      signal: controller.signal, onProgress(update) {
        if (update.phase === 'analyzing' && update.completedAtoms > 0 && update.completedAtoms < frame.types.length) {
          checkpoint = true; controller.abort();
        }
      },
    });
    const rejected = assert.rejects(interrupted, { name: 'AbortError' });
    const following = pool.analyzeCPU(small, { kind: 'ptm' });
    await rejected;
    const result = await following;
    assert.equal(checkpoint, true); assert.deepEqual(result.deformation, first.deformation);
    assert.equal(result.kernelInitializations, 0); assert.equal(stats.created, 1); assert.equal(stats.terminated, 0);
    assert.equal(pool.active.size, 0); assert.equal(pool.queue.length, 0);
    assert.ok(ptmInput.scales.byteLength > 0 && frame.fractional.byteLength > 0);
  } finally { pool.close(); }
});

test('compact source row validation rejects bad offsets, matrix strides and out-of-range mapping before calculations', async () => {
  const frame = largeFrame(10), ptmInput = cachedFits(frame), sourceRange = { startAtom: 3, endAtom: 7, totalAtoms: 10 };
  const header = { cell: frame.cell, types: frame.types.subarray(3, 7) };
  await assert.rejects(calculateAtomicStrain(header, { references: [{ structure: 1, a: 4 }, { structure: 2, a: 3, c: 5 }],
    ptmInput: { structures: ptmInput.structures.subarray(3, 7), scales: ptmInput.scales.subarray(3, 7), deformation: new Float64Array(35) }, sourceRange }), /source rows/);
  assert.throws(() => calculatePreparedDisplacements({ cell: frame.cell }, { sourceRange: { ...sourceRange, referenceCount: 10 },
    referenceMapping: Int32Array.of(0, 1, 2, 10), currentPositions: new Float64Array(12), referencePositions: new Float64Array(12) }), /outside the reference/);
  assert.throws(() => calculatePreparedDisplacements({ cell: frame.cell }, { sourceRange: { ...sourceRange, referenceCount: 10 },
    startAtom: 2, referenceMapping: new Int32Array(4), currentPositions: new Float64Array(12), referencePositions: new Float64Array(12) }), /range is invalid/);
  const { pool, stats } = realPool(false, 3);
  try {
    await assert.rejects(pool.analyzeCPU(frame, { kind: 'strain', ptmInput: { ...ptmInput, deformation: new Float64Array(89) }, references: [{ structure: 1, a: 4 }] }), /complete row/);
    assert.equal(stats.created, 0);
  } finally { pool.close(); }
});

test('unsafe skew periodic-image indices reject promptly in a real Worker and retain its warm resources for recovery', { timeout: 10_000 }, async () => {
  const frame = largeFrame(1), parameters = { kind: 'displacement', minimumImage: true, mappingMode: 'id',
    referenceMapping: Int32Array.of(0), currentPositions: Float64Array.of(3e38, 3e38, 3e38), referencePositions: new Float64Array(3) };
  assert.throws(() => minimumImageDisplacement([3e38, 3e38, 3e38], frame.cell), /safe integer/);
  assert.deepEqual([...minimumImageDisplacement([3e38, 3e38, 3e38], createCell({ vectors: frame.cell.vectors, pbc: [false, false, false] }))], [3e38, 3e38, 3e38]);
  assert.ok([...minimumImageDisplacement([3e38, 3e38, 3e38], createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }))].every(Number.isFinite));
  for (const shared of [false, true]) {
    const { pool, stats } = realPool(shared, 3);
    try {
      await assert.rejects(pool.analyzeCPU(frame, parameters), /safe integer/);
      const controller = new AbortController();
      await assert.rejects(pool.analyzeCPU(frame, parameters, { signal: controller.signal,
        onProgress(update) { if (update.phase === 'analyzing') controller.abort(); } }), { name: 'AbortError' });
      const result = await pool.analyzeCPU(frame, { ...parameters, currentPositions: Float64Array.of(.1, .2, .3) });
      assert.deepEqual(result.vectors, calculatePreparedDisplacements(frame, { ...parameters, currentPositions: Float64Array.of(.1, .2, .3) }).vectors);
      assert.equal(stats.created, 1); assert.equal(stats.terminated, 0); assert.equal(pool.active.size, 0);
    } finally { pool.close(); }
  }
});
