import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisPool } from '../src/analysis/analysis-pool.js';
import { calculateAtomicStrain, STRAIN_FIELDS } from '../src/analysis/atomic-strain.js';
import { calculatePtm } from '../src/analysis/ptm.js';
import { prepareGpuStrainInput, prepareGpuPtmInput, prepareGpuReferenceTable, analyzeGpuAtomicStrain, PTM_SCALE_INVALID, PTM_DEFORMATION_INVALID, PTM_SCALE_ENCODING_UNSUPPORTED, PTM_DEFORMATION_ENCODING_UNSUPPORTED } from '../src/analysis/gpu/atomic-strain.js';
import { crystalFrame } from './helpers/crystals.js';

const reference = (structure, a = 4) => ({ structure, a, c: Math.sqrt(8 / 3) * a });
const references = [reference(1)];

test('GPU strain uploads raw PTM scale/deformation independently of edited element references', async () => {
  const frame = crystalFrame('hcp', 2);
  const ptmInput = await calculatePtm(frame, { flags: 255 });
  const references = [{ structure: 2, a: 4.125, c: 6.1 }];
  const input = await prepareGpuStrainInput(frame, { references, ptmInput });
  const edited = await prepareGpuStrainInput(frame, { references: [{ structure: 3, a: 3.1 }], ptmInput });
  assert.deepEqual(input.metadata, edited.metadata, 'reference-phase decisions happen in the GPU shader');
  assert.deepEqual(input.scales, edited.scales);
  assert.deepEqual(input.deformation, edited.deformation);
  assert.equal('valid' in input, false);
  assert.equal('factors' in input, false);
  assert.equal(input.bytes, frame.types.length * 92);
  for (let atom = 0; atom < frame.types.length; atom += 1) {
    assert.equal(input.metadata[atom * 2], 2);
    assert.equal(input.metadata[atom * 2 + 1], 0);
    assert.ok(Math.abs(input.scales[atom * 2] + input.scales[atom * 2 + 1] - ptmInput.scales[atom]) < 1e-14);
    for (let component = 0; component < 9; component += 1) {
      const offset = (atom * 9 + component) * 2;
      assert.ok(Math.abs(input.deformation[offset] + input.deformation[offset + 1] - ptmInput.deformation[atom * 9 + component]) < 1e-14);
    }
  }
});

test('raw fit flags retain mismatched phases and distinguish undefined fits from unsupported encodings', async () => {
  const frame = crystalFrame('fcc', 2), ptmInput = await calculatePtm(frame);
  ptmInput.structures[0] = 0;
  ptmInput.scales[1] = NaN;
  ptmInput.deformation[2 * 9] = NaN;
  frame.types[3] = 1;
  ptmInput.scales[4] = 1e-40;
  ptmInput.deformation[5 * 9] = 1e300;
  ptmInput.scales[6] = -0;
  const input = await prepareGpuStrainInput(frame, { references: [reference(1), reference(3)], ptmInput });
  assert.equal(input.metadata[0], 0, 'undefined PTM phase is preserved for GPU phase rejection');
  assert.equal(input.metadata[1 * 2 + 1], PTM_SCALE_INVALID);
  assert.equal(input.metadata[2 * 2 + 1], PTM_DEFORMATION_INVALID);
  assert.equal(input.metadata[3 * 2], 1, 'mismatched element reference does not erase raw PTM fits');
  assert.equal(input.types[3], 1);
  assert.equal(input.metadata[4 * 2 + 1], PTM_SCALE_ENCODING_UNSUPPORTED);
  assert.equal(input.metadata[5 * 2 + 1], PTM_DEFORMATION_ENCODING_UNSUPPORTED);
  assert.equal(input.metadata[6 * 2 + 1], 0);
  assert.ok(Object.is(input.scales[6 * 2], -0));
  assert.ok(ptmInput.scales.byteLength > 0 && ptmInput.deformation.byteLength > 0);
});

test('GPU reference table is per element, keeps Float64 a/c residuals and marks unsupported positive references', () => {
  const frame = crystalFrame('fcc', 1);
  frame.types.set([2, 0, 2, 0]);
  const refs = [reference(2, 4.125), undefined, { structure: 7, a: 2.000000000000001, c: 5.000000000000002 }];
  const table = prepareGpuReferenceTable(frame, refs), floats = new Float32Array(table.buffer);
  assert.equal(table.length, 16, 'table scales with element count rather than atom count');
  assert.deepEqual([table[0], table[1], table[8], table[9]], [0, 2, 2, 7]);
  assert.ok(Math.abs(floats[4] + floats[5] - refs[0].a) < 1e-14);
  assert.ok(Math.abs(floats[14] + floats[15] - refs[2].c) < 1e-14);
  refs[2].a = 1e-300;
  assert.equal(prepareGpuReferenceTable(frame, refs)[10], PTM_SCALE_ENCODING_UNSUPPORTED);
});

test('GPU strain validates caches/types, preserves negative finite scales, and supports tiny normal off-diagonals', async () => {
  const frame = crystalFrame('fcc', 1), ptmInput = await calculatePtm(frame);
  await assert.rejects(prepareGpuStrainInput(frame, { references, ptmInput: { ...ptmInput, deformation: new Float64Array(9) } }), /complete cached PTM/);
  ptmInput.deformation[1] = 1e-25;
  ptmInput.scales[0] = -1;
  const raw = await prepareGpuStrainInput(frame, { references, ptmInput });
  assert.equal(raw.metadata[1], 0, 'negative scales remain eligible for the GPU determinant test');
  assert.equal(raw.scales[0], -1);
  assert.ok(raw.deformation[2] !== 0, 'noise below strain zero floor remains representable');
  const originalTypes = frame.types;
  frame.types = new Float64Array([0, 0.5, 0, 0]);
  await assert.rejects(prepareGpuPtmInput(frame, ptmInput), { name: 'GpuUnavailableError' });
  frame.types = originalTypes;
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
  assert.equal(disposed.length, 8);
  assert.equal(actual.referenceBackend, 'gpu');
  assert.equal(actual.gpuPtmInputReused, false);
});

test('editing references reuses resident PTM uploads and only disposes transient reference/output buffers', async () => {
  const frame = crystalFrame('fcc', 1), ptmInput = await calculatePtm(frame), tables = [];
  let cached, encodes = 0;
  const disposed = [];
  const runtime = {
    async initialize() {}, storageBuffer(array) { return { array }; }, createBuffer(bytes) { return { bytes }; },
    async preparePtmBuffers(inputFrame, inputPtm, prepare, options) {
      if (cached) return { ...cached, reused: true };
      const raw = await prepare(inputFrame, inputPtm, options); encodes += 1;
      cached = { typesBuffer: { array: raw.types }, metadataBuffer: { array: raw.metadata }, scalesBuffer: { array: raw.scales }, deformationBuffer: { array: raw.deformation } };
      return { ...cached, reused: false };
    },
    async run(_source, bindings) { tables.push(bindings[5].array.slice()); },
    async read(buffer, Type, count) { return new Type(count); },
    disposeBuffers(buffers) { disposed.push(...buffers); },
  };
  const first = await analyzeGpuAtomicStrain(runtime, frame, { references, ptmInput });
  const second = await analyzeGpuAtomicStrain(runtime, frame, { references: [reference(1, 3.8)], ptmInput });
  assert.equal(first.gpuPtmInputReused, false);
  assert.equal(second.gpuPtmInputReused, true);
  assert.equal(encodes, 1);
  assert.notDeepEqual(tables[0], tables[1]);
  assert.equal(disposed.length, 8, 'four transient buffers per job; resident fit buffers survive reference edits');
  assert.ok(!disposed.includes(cached.deformationBuffer));
});

test('GPU reference conversion range failure and partial uploads clean up without hiding cancellation', async () => {
  const frame = crystalFrame('fcc', 1), ptmInput = await calculatePtm(frame), disposed = [];
  const runtime = { async initialize() {}, storageBuffer(array) { return { array }; }, createBuffer(bytes) { return { bytes }; },
    async run() {}, async read(_buffer, Type, count) { return Type === Uint32Array ? new Uint32Array([0, 1]) : new Type(count); },
    disposeBuffers(buffers) { disposed.push(...buffers); } };
  await assert.rejects(analyzeGpuAtomicStrain(runtime, frame, { references, ptmInput }), /ideal lattice reference/);
  assert.equal(disposed.length, 8);
  disposed.length = 0;
  let uploads = 0;
  runtime.storageBuffer = array => { if (++uploads === 3) throw new Error('allocation failed'); return { array }; };
  await assert.rejects(analyzeGpuAtomicStrain(runtime, frame, { references, ptmInput }), /allocation failed/);
  assert.equal(disposed.length, 2);
  assert.ok(ptmInput.scales.byteLength > 0);
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
