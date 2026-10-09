import test from 'node:test';
import assert from 'node:assert/strict';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';
import { calculateVoronoi } from '../src/analysis/voronoi.js';
import { analyzeGpuVoronoi, prepareGpuVoronoi, voronoiGpuWorkspaceBytes, voronoiGpuBatchSize,
  GPU_VORONOI_BATCH_ATOMS, GPU_VORONOI_SETTINGS_BYTES, GPU_VORONOI_MAX_RADIUS_SPREAD } from '../src/analysis/gpu/voronoi.js';
import { GPU_VORONOI_MAX_FACES, GPU_VORONOI_MAX_FACE_VERTICES, GPU_VORONOI_STATE_WORDS,
  VORONOI_INITIALIZE_SHADER, VORONOI_CLIP_SHADER, VORONOI_RADICAL_CLIP_SHADER, GPU_VORONOI_RADICAL_EMPTY_CODE } from '../src/analysis/gpu/voronoi-shaders.js';
import { radicalReach } from '../src/analysis/voronoi-radii.js';
import { GpuAnalysisClient } from '../src/analysis/gpu/client.js';
import { prepareVoronoiSelection, expandVoronoiResult } from '../src/analysis/voronoi-selection.js';

// These tests exercise host assembly/lifecycle, not numerical shader claims.
// scripts/browser-voronoi-gpu.mjs independently runs real WGSL and compares
// complete scalar, face/topology and geometric results against exact Wasm.
async function hostFixture(frame, { flags = 0, onRun, onRead, radii, rowState } = {}) {
  const expected = await calculateVoronoi(frame, radii ? { radii } : {}), scale = Math.cbrt(expected.cellVolume / expected.sourceAtomCount);
  const allocations = [], contexts = [], runs = []; let pendingSignal;
  const runtime = {
    adapterInfo: { isFallbackAdapter: true },
    async initialize(signal) { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); },
    reserveWorkspace(bytes) { assert.ok(Number.isInteger(bytes) && bytes > 0); },
    createBuffer(bytes) { const buffer = { bytes, values: new Uint8Array(bytes), destroyed: false }; allocations.push(buffer); return buffer; },
    disposeBuffers(buffers) { for (const buffer of buffers) buffer.destroyed = true; },
    write(buffer, values, byteOffset = 0) { buffer.values.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), byteOffset); },
    async prepareNeighbors(frame, cutoff) { const context = { cutoff, frame }; contexts.push(context); return context; },
    neighborBindings(context, extra) { return [context, null, null, null, null, ...extra]; },
    async run(source, bindings, count, options) {
      runs.push({ source, count, options }); pendingSignal = options.signal;
      const settings = new Uint32Array(bindings[5].values.buffer), begin = settings[26];
      const states = new Uint32Array(bindings[8].values.buffer), floats = new Float32Array(states.buffer);
      const descriptors = new Uint32Array(bindings[7].values.buffer), areas = new Float32Array(descriptors.buffer);
      for (let row = 0; row < count; row++) {
        const atom = begin + row, offset = row * GPU_VORONOI_STATE_WORDS;
        const first = expected.faceOffsets[atom], last = expected.faceOffsets[atom + 1];
        states[offset] = last - first; states[offset + 1] = flags; states[offset + 2] = 1;
        rowState?.({ atom, states, floats, offset, source, bindings });
        floats[offset + 4] = expected.atomicVolume[atom] / scale ** 3;
        floats[offset + 5] = expected.voronoiSurfaceArea[atom] / scale ** 2;
        for (let face = first; face < last; face++) {
          const base = (row * GPU_VORONOI_MAX_FACES + face - first) * 4;
          descriptors[base] = expected.faceOrders[face]; descriptors[base + 1] = expected.faceNeighbors[face];
          areas[base + 2] = expected.faceAreas[face] / scale ** 2;
        }
      }
      onRun?.({ source, count, options });
    },
    async read(buffer, Type, length, { signal } = {}) {
      assert.equal(signal, pendingSignal, 'readback retains the job cancellation signal');
      onRead?.({ buffer, length, signal });
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      return new Type(buffer.values.buffer.slice(0, length * Type.BYTES_PER_ELEMENT));
    },
  };
  return { runtime, expected, allocations, contexts, runs };
}

test('Voronoi is registered with the reusable GPU worker', () => {
  const client = new GpuAnalysisClient({ environment: {}, workerFactory: () => { throw new Error('Not needed'); } });
  assert.equal(client.supports('voronoi'), true); client.close();
});

test('GPU seeds handle periodic self-images, tilted mixed domains and nonzero fractional origins', () => {
  const periodic = prepareGpuVoronoi(crystalFrame('sc', 1, 2));
  assert.equal(periodic.exactSingleSite, true); assert.equal(periodic.cellVolume, 8);
  const mixed = crystalFrame('fcc', 2, 3.52);
  mixed.cell = createCell({ vectors: [7, .2, .1, .4, 7, 0, 0, .3, 7], pbc: [true, false, true] });
  const prepared = prepareGpuVoronoi(mixed, { startAtom: 3, endAtom: 8 });
  assert.equal(prepared.exactSingleSite, false); assert.equal(prepared.startAtom, 3); assert.equal(prepared.endAtom, 8);
  assert.equal(prepared.geometry.normals.length, 3); assert.ok(prepared.scale > 0);
});

test('invalid parameters and precision-singular seed geometry fail before GPU allocation', () => {
  const frame = crystalFrame('sc', 1, 2);
  assert.throws(() => prepareGpuVoronoi(frame, { bins: 0 }), /histogram/);
  assert.throws(() => prepareGpuVoronoi(frame, { relativeFaceAreaThreshold: 1.1 }), /between/);
  assert.throws(() => prepareGpuVoronoi(frame, { startAtom: 1 }), /atom range/);
  const skew = { ...frame, cell: createCell({ vectors: [1, 0, 0, 1, 1e-6, 0, 0, 0, 1] }) };
  assert.throws(() => prepareGpuVoronoi(skew), error => error.name === 'GpuUnavailableError' && /precision/.test(error.message));
  const open = { ...frame, cell: createCell({ vectors: frame.cell.vectors, pbc: [false, true, true] }), fractional: Float64Array.from([-.1, .5, .5]) };
  assert.throws(() => prepareGpuVoronoi(open), /inside the simulation cell/);
  assert.throws(() => prepareGpuVoronoi({ ...frame, fractional: Float64Array.from([NaN, .5, .5]) }), /non-finite/);
});

test('GPU workspace scales with the bounded batch, never with source-frame size', () => {
  assert.equal(GPU_VORONOI_BATCH_ATOMS, 512);
  assert.ok(voronoiGpuWorkspaceBytes() < 32 * 1024 ** 2);
  assert.ok(voronoiGpuWorkspaceBytes(1) > GPU_VORONOI_MAX_FACES * GPU_VORONOI_MAX_FACE_VERTICES * 16);
  assert.equal(voronoiGpuWorkspaceBytes(2) - GPU_VORONOI_SETTINGS_BYTES,
    2 * (voronoiGpuWorkspaceBytes(1) - GPU_VORONOI_SETTINGS_BYTES));
});

test('host assembles complete face CSR, exact topology and finite boundary statistics', async () => {
  const frame = crystalFrame('bcc', 2, 2.86), fixture = await hostFixture(frame);
  const output = await analyzeGpuVoronoi(fixture.runtime, frame, { bins: 7 });
  for (const name of ['faceOffsets', 'faceOrders', 'faceNeighbors', 'faceBoundary', 'faceAccepted',
    'voronoiCoordination', 'voronoiBoundaryFaces', 'voronoiMaxFaceOrder']) assert.deepEqual(output[name], fixture.expected[name]);
  assert.deepEqual(output.voronoiIndices, fixture.expected.voronoiIndices);
  assert.deepEqual(output.coordinationHistogram, fixture.expected.coordinationHistogram);
  assert.equal(output.summary.atomCount, frame.types.length);
  assert.equal(output.engine, 'webgpu-voronoi'); assert.equal(output.gpuCorrectionAtoms, 0);
  assert.equal(output.autoRangeRelativeTolerance.atomicVolume, 32 * 2 ** -23);
  assert.ok(Math.abs(output.summary.volumeError) < 1e-6);
  assert.ok(fixture.runs.some(run => run.source === VORONOI_CLIP_SHADER));
});

test('GPU readback respects central-atom ranges and original neighbor identities', async () => {
  const frame = crystalFrame('fcc', 2, 3.52), fixture = await hostFixture(frame);
  const output = await analyzeGpuVoronoi(fixture.runtime, frame, { startAtom: 5, endAtom: 9 });
  assert.equal(output.startAtom, 5); assert.equal(output.endAtom, 9); assert.equal(output.summary.atomCount, 4);
  assert.equal(output.summary.volumeError, null);
  assert.deepEqual(output.voronoiCoordination, fixture.expected.voronoiCoordination.slice(5, 9));
  assert.ok(output.faceNeighbors.some(neighbor => neighbor < 5 || neighbor >= 9), 'neighbors retain source-frame IDs');
});

test('extreme thin one-site cell uses its exact GPU seed without periodic image enumeration', async () => {
  const frame = { fractional: Float64Array.from([.2, .4, .8]), types: new Uint16Array(1),
    cell: createCell({ vectors: [6, 0, 0, 0, .08, 0, 0, 0, .05] }) };
  const fixture = await hostFixture(frame);
  const output = await analyzeGpuVoronoi(fixture.runtime, frame);
  assert.equal(output.voronoiCoordination[0], 6);
  assert.equal(fixture.runs.length, 1); assert.equal(fixture.runs[0].source, VORONOI_INITIALIZE_SHADER);
  assert.ok(fixture.contexts[0].cutoff < .05);
});

test('GPU convex geometry workspace and buffers are reused across analyses', async () => {
  const frame = crystalFrame('fcc', 2, 3.52), fixture = await hostFixture(frame);
  const first = await analyzeGpuVoronoi(fixture.runtime, frame), allocations = fixture.allocations.length;
  const second = await analyzeGpuVoronoi(fixture.runtime, frame, { bins: 19 });
  assert.equal(first.kernelReused, false); assert.equal(second.kernelReused, true);
  assert.equal(fixture.allocations.length, allocations); assert.ok(fixture.allocations.every(buffer => !buffer.destroyed));
});

for (const [flags, reason] of [[1, 'capacity'], [2, 'degenerate']]) {
  test(`GPU ${reason} diagnostic requests explicit exact CPU fallback instead of truncated results`, async () => {
    const frame = crystalFrame('fcc', 1, 3.52), fixture = await hostFixture(frame, { flags });
    await assert.rejects(analyzeGpuVoronoi(fixture.runtime, frame), error => error.name === 'GpuUnavailableError' && error.message.includes(reason));
  });
}

test('cancelled GPU work preserves its reusable workspace and rejects with AbortError', async () => {
  const frame = crystalFrame('fcc', 2, 3.52), controller = new AbortController();
  const fixture = await hostFixture(frame, { onRead: () => controller.abort() });
  await assert.rejects(analyzeGpuVoronoi(fixture.runtime, frame, {}, { signal: controller.signal }), { name: 'AbortError' });
  assert.ok(fixture.runtime.voronoiWorkspace); assert.ok(fixture.allocations.every(buffer => !buffer.destroyed));
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(analyzeGpuVoronoi({}, frame, {}, { signal: cancelled.signal }), { name: 'AbortError' });
});


test('GPU batches use hardware parallelism within complete workspace and buffer budgets', () => {
  const runtime = { device: { limits: { maxBufferSize: 256 * 1024 ** 2, maxStorageBufferBindingSize: 256 * 1024 ** 2 } },
    adapterInfo: { isFallbackAdapter: false }, budgetBytes: 512 * 1024 ** 2, allocatedBytes: 1024 };
  assert.equal(voronoiGpuBatchSize(runtime, 10000), 2048);
  runtime.adapterInfo.isFallbackAdapter = true;
  assert.equal(voronoiGpuBatchSize(runtime, 10000), 512);
  runtime.adapterInfo.isFallbackAdapter = false; runtime.budgetBytes = 8 * 1024 ** 2;
  const count = voronoiGpuBatchSize(runtime, 10000);
  assert.ok(count >= 32 && count < 512 && count % 32 === 0);
  assert.ok(voronoiGpuWorkspaceBytes(count) < runtime.budgetBytes);
  runtime.budgetBytes = 4;
  assert.throws(() => voronoiGpuBatchSize(runtime, 10000), /complete Voronoi/);
});

test('face threshold boundaries recover exact CPU acceptance decisions without changing raw geometry', async () => {
  const frame = crystalFrame('sc', 1, 2), fixture = await hostFixture(frame);
  for (const options of [{ faceAreaThreshold: 4 }, { relativeFaceAreaThreshold: 1 / 6 }]) {
    const result = await analyzeGpuVoronoi(fixture.runtime, frame, options);
    assert.equal(result.gpuCorrectionAtoms, 1); assert.equal(result.gpuCorrectionReasons.threshold, 1);
    assert.equal(result.voronoiCoordination[0], 0); assert.ok(result.faceAccepted.every(value => value === 0));
    assert.ok(Math.abs(result.atomicVolume[0] - 8) < 1e-12); assert.equal(result.engine, 'webgpu-voronoi+exact-cell-correction');
  }
});

test('precision recovery replaces whole flagged cells, retaining complete scalar arrays and face topology', async () => {
  const frame = crystalFrame('bcc', 1, 2.86), fixture = await hostFixture(frame, { flags: 4 });
  const output = await analyzeGpuVoronoi(fixture.runtime, frame);
  assert.equal(output.gpuCorrectionAtoms, frame.types.length);
  assert.equal(output.gpuCorrectionReasons.geometry, frame.types.length);
  for (const name of ['atomicVolume', 'voronoiSurfaceArea', 'voronoiCoordination', 'faceOffsets', 'faceOrders',
    'faceNeighbors', 'faceAreas', 'faceBoundary', 'faceAccepted']) assert.deepEqual(output[name], fixture.expected[name]);
  assert.deepEqual(output.voronoiIndices, fixture.expected.voronoiIndices);
  const context = fixture.runtime.voronoiCpuContext.context;
  await analyzeGpuVoronoi(fixture.runtime, frame);
  assert.equal(fixture.runtime.voronoiCpuContext.context, context, 'source neighbor index is reused by exact recovery');
});

test('excessive precision recovery explicitly falls back to the parallel CPU pool', async () => {
  const frame = crystalFrame('fcc', 3, 3.52), fixture = await hostFixture(frame, { flags: 4 });
  await assert.rejects(analyzeGpuVoronoi(fixture.runtime, frame), error => error.name === 'GpuUnavailableError' && /Too many/.test(error.message));
});

function checkerboardFrame() {
  const frame = crystalFrame('sc', 2, 2); frame.typeLabels = ['Ni', 'Cu'];
  for (let atom = 0; atom < frame.types.length; atom++) {
    const sum = frame.fractional[atom * 3] + frame.fractional[atom * 3 + 1] + frame.fractional[atom * 3 + 2];
    frame.types[atom] = Math.round(sum * 2) % 2;
  }
  return frame;
}

test('direct GPU subsets construct indices from included sites and scatter full-source results', async () => {
  const frame = checkerboardFrame(), selection = prepareVoronoiSelection(frame, ['Ni']),
    fixture = await hostFixture(selection.frame), expected = expandVoronoiResult(fixture.expected, selection);
  const result = await analyzeGpuVoronoi(fixture.runtime, frame, { selectedTypes: ['Ni'] });
  assert.ok(fixture.contexts.every(context => context.frame === selection.frame));
  assert.equal(selection.frame.fractional.length / 3, 4); assert.equal(result.sourceAtomCount, 8);
  assert.equal(result.summary.atomCount, 4); assert.equal(result.tessellationAtomCount, 4);
  assert.deepEqual(result.selectedTypes, ['Ni']); assert.deepEqual(result.analyzedAtomIndices, selection.atomIndices);
  for (const name of ['voronoiCoordination', 'faceOffsets', 'faceOrders', 'faceNeighbors', 'voronoiIndices']) assert.deepEqual(result[name], expected[name]);
  assert.ok(result.atomicVolume.some(Number.isNaN));
  assert.ok(Math.abs(result.summary.totalVolume - 64) < 1e-4, 'the included sites tessellate the complete original cell');
});

test('GPU exact-cell recovery uses only included sites, honoring original central ranges and neighbor IDs', async () => {
  const frame = checkerboardFrame(), selection = prepareVoronoiSelection(frame, ['Cu']), fixture = await hostFixture(selection.frame, { flags: 4 });
  const result = await analyzeGpuVoronoi(fixture.runtime, frame, { selectedTypes: ['Cu'], startAtom: 2, endAtom: 7 });
  const expected = await calculateVoronoi(frame, { selectedTypes: ['Cu'], startAtom: 2, endAtom: 7 });
  assert.equal(fixture.runtime.voronoiCpuContext.context.frame, selection.frame);
  assert.deepEqual(result.atomicVolume, expected.atomicVolume); assert.deepEqual(result.faceNeighbors, expected.faceNeighbors);
  assert.deepEqual(result.analyzedAtomIndices, expected.analyzedAtomIndices); assert.equal(result.gpuCorrectionAtoms, result.summary.atomCount);
});

test('GPU client transfers compact sites with an independent ID and restores source mappings', async () => {
  const frame = checkerboardFrame(), selection = prepareVoronoiSelection(frame, ['Ni']), compactResult = await calculateVoronoi(selection.frame),
    allResult = await calculateVoronoi(frame), messages = [], listeners = new Map(), resident = new Set();
  const worker = { addEventListener(type, callback) { listeners.set(type, callback); }, terminate() {},
    postMessage(data, transfer = []) {
      if (data.type !== 'analyze') return;
      const message = structuredClone(data, { transfer }); messages.push(message); resident.add(message.frameId);
      setTimeout(() => listeners.get('message')({ data: { id: message.id, ok: true,
        result: structuredClone(message.frameId === messages[0].frameId ? compactResult : allResult),
        cachedFrameIds: [...resident] } }), 0);
    } };
  const client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  try {
    const subset = await client.analyze(frame, { kind: 'voronoi', selectedTypes: ['Ni'] }, { frameIndex: 0 });
    await client.analyze(frame, { kind: 'voronoi' }, { frameIndex: 0 });
    const reused = await client.analyze(frame, { kind: 'voronoi', selectedTypes: ['Ni'] }, { frameIndex: 0 });
    assert.equal(messages[0].frame.fractional.length, 12); assert.deepEqual(messages[0].frame.typeLabels, ['Ni', 'Cu']);
    assert.equal(messages[0].parameters.selectedTypes, null); assert.equal(messages[1].frame.fractional.length, 24);
    assert.notEqual(messages[0].frameId, messages[1].frameId); assert.equal(messages[2].frameId, messages[0].frameId);
    assert.equal(messages[2].frame, undefined, 'unchanged subset reuses its acknowledged compact input');
    assert.deepEqual(subset.selectedTypes, ['Ni']); assert.deepEqual(reused.faceNeighbors, subset.faceNeighbors);
    assert.equal(frame.fractional.length, 24); assert.ok(subset.atomicVolume.some(Number.isNaN));
  } finally { client.close(); }
});

test('radical GPU host binds weights behind the unchanged settings header and recovers empty cells exactly', async () => {
  const frame = crystalFrame('bcc', 4, 3), radii = new Float64Array(frame.types.length).fill(1); radii[0] = 4;
  const reference = await calculateVoronoi(frame, { radii }), empty = [...reference.atomicVolume.keys()].filter(atom => reference.atomicVolume[atom] === 0);
  assert.ok(empty.length > 0 && empty.length <= 16, 'a few cells are empty');
  const fixture = await hostFixture(frame, { radii, rowState: ({ atom, states, offset }) => {
    // The radical kernel reports emptied cells for exact recovery.
    if (empty.includes(atom)) { states[offset + 1] = 4; states[offset + 15] = GPU_VORONOI_RADICAL_EMPTY_CODE; }
  } });
  const output = await analyzeGpuVoronoi(fixture.runtime, frame, { radii, bins: 11 });
  for (const name of ['faceOffsets', 'faceOrders', 'faceNeighbors', 'voronoiCoordination', 'voronoiIndices']) assert.deepEqual(output[name], reference[name], name);
  for (const atom of empty) { assert.equal(output.atomicVolume[atom], 0); assert.equal(output.voronoiCoordination[atom], 0); }
  assert.equal(output.tessellation, 'radical'); assert.equal(output.emptyCellCount, empty.length); assert.equal(output.summary.emptyCellCount, empty.length);
  assert.equal(output.gpuCorrectionReasons.emptyCell, empty.length); assert.deepEqual(output.gpuCorrectionPrecisionCodes, {});
  const clips = fixture.runs.filter(run => run.source !== VORONOI_INITIALIZE_SHADER);
  assert.ok(clips.length && clips.every(run => run.source === VORONOI_RADICAL_CLIP_SHADER));
  const settings = fixture.allocations.find(buffer => buffer.bytes === GPU_VORONOI_SETTINGS_BYTES + 8 * radii.length);
  assert.ok(settings?.destroyed, 'the per-analysis weight buffer is released');
  const scratch = fixture.allocations.find(buffer => buffer.bytes === GPU_VORONOI_SETTINGS_BYTES);
  const header = new Uint32Array(settings.values.buffer, 0, GPU_VORONOI_SETTINGS_BYTES / 4), standard = new Uint32Array(scratch.values.buffer);
  for (let word = 0; word < header.length; word++) if (word !== 29) assert.equal(header[word], standard[word], `header word ${word}`);
  const floats = new Float32Array(settings.values.buffer), scale = prepareGpuVoronoi(frame).scale;
  assert.ok(floats[29] >= 4 ** 2 / scale ** 2, 'maximum weight rounds upward');
  for (const atom of [0, 1, 77]) {
    const weight = floats[GPU_VORONOI_SETTINGS_BYTES / 4 + atom * 2] + floats[GPU_VORONOI_SETTINGS_BYTES / 4 + atom * 2 + 1];
    assert.ok(Math.abs(weight - radii[atom] ** 2 / scale ** 2) < 1e-12, `double-float weight ${atom}`);
  }
  const runs = fixture.runs.length, standardResult = await analyzeGpuVoronoi(fixture.runtime, frame);
  assert.equal(standardResult.tessellation, undefined); assert.equal(standardResult.gpuCorrectionReasons.emptyCell, undefined);
  assert.ok(fixture.runs.slice(runs).filter(run => run.source !== VORONOI_INITIALIZE_SHADER).every(run => run.source === VORONOI_CLIP_SHADER));
});

test('radical GPU coverage grows to R + √(R² + r_max² − rᵢ²) and wide radius spreads use the CPU', async () => {
  const frame = crystalFrame('fcc', 2, 3.52), radii = new Float64Array(frame.types.length).fill(1.2); radii[3] = 2;
  const scale = prepareGpuVoronoi(frame).scale;
  let clips = 0;
  const fixture = await hostFixture(frame, { radii, rowState: ({ states, floats, offset, source }) => {
    if (source === VORONOI_RADICAL_CLIP_SHADER && clips === 0) { states[offset + 2] = 0; floats[offset + 6] = 1; }
  }, onRun: ({ source }) => { if (source === VORONOI_RADICAL_CLIP_SHADER) clips++; } });
  await analyzeGpuVoronoi(fixture.runtime, frame, { radii });
  const first = fixture.contexts[0].cutoff, second = fixture.contexts.at(-1).cutoff;
  const reach = radicalReach(scale, 2 ** 2 - 1.2 ** 2);
  assert.ok(Math.abs(second - Math.min(first * 1.8, Math.max(first * (1 + 1e-4), reach * (1 + 1e-4)))) < 1e-9 * second,
    `coverage radius ${second} follows the radical reach ${reach}`);
  assert.ok(reach > 2 * scale);
  const wide = new Float64Array(frame.types.length).fill(0); wide[0] = GPU_VORONOI_MAX_RADIUS_SPREAD * scale * 1.01;
  await assert.rejects(analyzeGpuVoronoi(fixture.runtime, frame, { radii: wide }), error => error.name === 'GpuUnavailableError' && /radius spread/.test(error.message));
  await assert.rejects(analyzeGpuVoronoi(fixture.runtime, frame, { radii: wide.subarray(1) }), /one radius per analyzed atom/);
});

test('GPU subsets and the client compact radii with their sites', async () => {
  const frame = checkerboardFrame(), selection = prepareVoronoiSelection(frame, ['Cu']);
  const radii = Float64Array.from(frame.types, (type, atom) => type ? 1 + atom / 10 : NaN);
  const compact = Float64Array.from(selection.atomIndices, atom => radii[atom]);
  const fixture = await hostFixture(selection.frame, { radii: compact });
  const result = await analyzeGpuVoronoi(fixture.runtime, frame, { selectedTypes: ['Cu'], radii });
  const expected = await calculateVoronoi(frame, { selectedTypes: ['Cu'], radii });
  assert.deepEqual(result.faceNeighbors, expected.faceNeighbors); assert.equal(result.tessellation, 'radical');
  const messages = [], listeners = new Map();
  const worker = { addEventListener(type, callback) { listeners.set(type, callback); }, terminate() {},
    postMessage(data) {
      if (data.type !== 'analyze') return;
      messages.push(data);
      setTimeout(() => listeners.get('message')({ data: { id: data.id, ok: true, result: structuredClone(fixture.expected), cachedFrameIds: [] } }), 0);
    } };
  const client = new GpuAnalysisClient({ environment: { navigator: { gpu: {} } }, workerFactory: () => worker });
  try {
    await client.analyze(frame, { kind: 'voronoi', selectedTypes: ['Cu'], radii }, { frameIndex: 0 });
    assert.deepEqual(messages[0].parameters.radii, compact);
    await client.analyze(frame, { kind: 'voronoi', selectedTypes: ['Cu'] }, { frameIndex: 0 });
    assert.equal('radii' in messages[1].parameters, false, 'standard requests carry no radii');
  } finally { client.close(); }
});
