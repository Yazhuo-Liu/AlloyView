import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { calculateAtomicStrain, referenceFactors, STRAIN_FIELDS } from '../src/analysis/atomic-strain.js';
import { calculatePtm } from '../src/analysis/ptm.js';
import { prepareGpuStrainInput, analyzeGpuAtomicStrain } from '../src/analysis/gpu/atomic-strain.js';
import { crystalFrame } from './helpers/crystals.js';

const reference = (structure, a = 4) => ({ structure, a, c: Math.sqrt(8 / 3) * a });
const references = [reference(1)];

test('GPU strain input retains Float64 PTM scale/deformation and editable reference factors', async () => {
  const frame = crystalFrame('hcp', 2);
  const ptmInput = await calculatePtm(frame, { flags: 255 });
  const references = [{ structure: 2, a: 4.125, c: 6.1 }];
  const input = await prepareGpuStrainInput(frame, { references, ptmInput });
  for (let atom = 0; atom < frame.types.length; atom += 1) {
    assert.equal(input.valid[atom], 1);
    const expected = referenceFactors(2, references[0], ptmInput.scales[atom]);
    assert.ok(Math.abs(input.factors[atom * 4] + input.factors[atom * 4 + 1] - expected[0]) < 1e-14);
    assert.ok(Math.abs(input.factors[atom * 4 + 2] + input.factors[atom * 4 + 3] - expected[2]) < 1e-14);
    for (let component = 0; component < 9; component += 1) {
      const offset = (atom * 9 + component) * 2;
      assert.ok(Math.abs(input.deformation[offset] + input.deformation[offset + 1] - ptmInput.deformation[atom * 9 + component]) < 1e-14);
    }
  }
});

test('GPU strain input leaves rejected fits, mismatched species, and nonfinite deformations undefined', async () => {
  const frame = crystalFrame('fcc', 2), ptmInput = await calculatePtm(frame);
  ptmInput.structures[0] = 0;
  ptmInput.scales[1] = NaN;
  ptmInput.deformation[2 * 9] = NaN;
  frame.types[3] = 1;
  const input = await prepareGpuStrainInput(frame, { references: [reference(1), reference(3)], ptmInput });
  assert.deepEqual([...input.valid.subarray(0, 5)], [0, 0, 0, 0, 1]);
  assert.ok(ptmInput.scales.byteLength > 0 && ptmInput.deformation.byteLength > 0);
});

test('GPU strain input rejects malformed caches and extreme factors instead of truncating or corrupting tensors', async () => {
  const frame = crystalFrame('fcc', 1), ptmInput = await calculatePtm(frame);
  await assert.rejects(prepareGpuStrainInput(frame, { references, ptmInput: { ...ptmInput, deformation: new Float64Array(9) } }), /complete cached PTM/);
  await assert.rejects(prepareGpuStrainInput(frame, { references: [reference(1, 1e-30)], ptmInput }), { name: 'GpuUnavailableError' });
  ptmInput.deformation[1] = 1e-25;
  const tinyOffDiagonal = await prepareGpuStrainInput(frame, { references, ptmInput });
  assert.equal(tinyOffDiagonal.valid[0], 1, 'PTM numerical noise below the strain zero floor is a supported input');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareGpuStrainInput(frame, { references, ptmInput }, { signal: controller.signal }), { name: 'AbortError' });
});

test('GPU strain outputs nine planar Float32 views, preserves NaN fields and disposes transient buffers', async () => {
  const frame = crystalFrame('fcc', 1), ptmInput = await calculatePtm(frame);
  ptmInput.structures[0] = 0;
  const expected = await calculateAtomicStrain(frame, { references, ptmInput });
  const flat = new Float32Array(frame.types.length * STRAIN_FIELDS.length);
  STRAIN_FIELDS.forEach((name, index) => flat.set(expected[name], frame.types.length * index));
  let disposed = [];
  const runtime = {
    async initialize() {}, storageBuffer(array) { return { array }; }, createBuffer(bytes) { return { bytes }; },
    async run() {}, async read(_buffer, Type) { return Type === Float32Array ? flat : new Uint32Array([expected.incomplete, 0]); },
    disposeBuffers(buffers) { disposed = buffers; },
  };
  const actual = await analyzeGpuAtomicStrain(runtime, frame, { references, ptmInput });
  for (const field of STRAIN_FIELDS) {
    assert.deepEqual(actual[field], expected[field]);
    assert.equal(actual[field].buffer, flat.buffer, 'one transfer buffer holds all tensor fields');
  }
  assert.equal(actual.warning, null);
  assert.equal(actual.incomplete, 1);
  assert.equal(disposed.length, 6);
});

test('fresh GPU strain fits PTM once on CPU and labels the GPU tensor stage accurately', async () => {
  const { pool, calls } = strainRoutingPool();
  pool.setGpuEnabled(true);
  const frame = crystalFrame('fcc', 1), progress = [];
  try {
    const actual = await pool.analyze(frame, { kind: 'strain', references }, { onProgress: update => progress.push(update) });
    assert.deepEqual(calls.cpu, ['ptm']);
    assert.equal(calls.gpu.length, 1);
    assert.ok(calls.gpu[0].ptmInput.scales.byteLength > 0);
    assert.equal(actual.engine, 'ptm-wasm-worker+webgpu-strain-tensor');
    assert.equal(actual.ptmBackend, 'cpu'); assert.equal(actual.tensorBackend, 'gpu');
    assert.equal(actual.warning, null);
    assert.ok(actual.structures.every(type => type === 1));
    assert.ok(actual.atomicShearStrain.every(value => value === 0));
    assert.deepEqual(progress.map(update => update.backend), ['cpu', 'gpu']);
    assert.equal(progress.at(-1).completedAtoms, frame.types.length * 2);
  } finally { pool.close(); }
});

test('cached PTM strain goes directly to GPU and preserves reference-mismatched NaN values', async () => {
  const { pool, calls } = strainRoutingPool(); pool.setGpuEnabled(true);
  const frame = crystalFrame('fcc', 1), ptmInput = await calculatePtm(frame);
  try {
    const actual = await pool.analyze(frame, { kind: 'strain', references: [reference(3)], ptmInput });
    assert.deepEqual(calls.cpu, []);
    assert.equal(calls.gpu[0].ptmInput, ptmInput);
    assert.ok(actual.atomicShearStrain.every(Number.isNaN));
    assert.equal(actual.warning, null);
    assert.equal('structures' in actual, false, 'cached results are not duplicated');
  } finally { pool.close(); }
});

test('GPU tensor failure falls back using the CPU fit already completed', async () => {
  const { pool, calls } = strainRoutingPool(new Error('GPU device lost')); pool.setGpuEnabled(true);
  try {
    const actual = await pool.analyze(crystalFrame('fcc', 1), { kind: 'strain', references });
    assert.deepEqual(calls.cpu, ['ptm', 'strain']);
    assert.equal(actual.backend, 'cpu'); assert.equal(actual.tensorBackend, 'cpu');
    assert.match(actual.fallbackReason, /device lost/);
    assert.equal(actual.engine, 'ptm-wasm-worker+js-worker');
    assert.ok(actual.structures.every(type => type === 1));
  } finally { pool.close(); }
});

test('GPU strain cancellation never retries the tensor on CPU and invalid references never trigger fitting', async () => {
  const { pool, calls } = strainRoutingPool(new DOMException('Cancelled.', 'AbortError')); pool.setGpuEnabled(true);
  try {
    await assert.rejects(pool.analyze(crystalFrame('fcc', 1), { kind: 'strain', references }), { name: 'AbortError' });
    assert.deepEqual(calls.cpu, ['ptm']);
    calls.cpu.length = 0;
    await assert.rejects(pool.analyze(crystalFrame('fcc', 1), { kind: 'strain', references: [reference(1, -1)] }), /positive reference/);
    assert.deepEqual(calls.cpu, []);
  } finally { pool.close(); }
});

function strainRoutingPool(error) {
  const calls = { cpu: [], gpu: [] };
  const gpuBackend = { supports: kind => kind === 'strain', close() {}, async analyze(frame, parameters, { onProgress }) {
    calls.gpu.push(parameters);
    if (error) throw error;
    const actual = await calculateAtomicStrain(frame, parameters);
    onProgress({ phase: 'complete', completedAtoms: frame.types.length, totalAtoms: frame.types.length });
    return { ...actual, engine: 'webgpu-strain-tensor', workerCount: 1 };
  } };
  const pool = new AnalysisPool({ gpuBackend });
  pool.analyzeCPU = async (frame, parameters, { onProgress }) => {
    calls.cpu.push(parameters.kind);
    const actual = parameters.kind === 'ptm' ? await calculatePtm(frame, parameters) : await calculateAtomicStrain(frame, parameters);
    onProgress({ phase: 'complete', completedAtoms: frame.types.length, totalAtoms: frame.types.length });
    return { ...actual, engine: parameters.kind === 'ptm' ? 'ptm-wasm-worker' : 'js-worker', workerCount: 1 };
  };
  return { pool, calls };
}
