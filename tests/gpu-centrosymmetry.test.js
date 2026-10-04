import test from 'node:test';
import assert from 'node:assert/strict';
import { createCell } from '../src/data/model.js';
import { calculateCentrosymmetry, normalizedCentrosymmetry } from '../src/analysis/centrosymmetry.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { crystalFrame } from './helpers/crystals.js';
import { analyzeGpuCentrosymmetry, prepareCspCoordinates, prepareCspSettings } from '../src/analysis/gpu/centrosymmetry.js';
import { CSP_SHADER, CSP_RESULT_WORDS } from '../src/analysis/gpu/centrosymmetry-shaders.js';
import { MAX_GPU_CNA_RADIUS_ATTEMPTS } from '../src/analysis/gpu/cna.js';
import { CNA_ADAPTIVE_SHADER, CNA_RESULT_WORDS } from '../src/analysis/gpu/cna-shaders.js';

test('CSP exact input preparation preserves original CPU wrapping and f64 cell bits', async () => {
  const frame = { fractional: Float64Array.from([3.05, -.95, .2, -2.05, 4.95, .2]),
    cell: createCell({ vectors: [1435.51, 0, 0, 3.3, 240.509, 0, 0, 0, 4.97773], pbc: [true, true, false] }) };
  const source = await prepareCspCoordinates(frame), view = new DataView(source.buffer);
  for (let index = 0; index < frame.fractional.length; index++) {
    const original = frame.fractional[index], expected = frame.cell.pbc[index % 3] ? original - Math.floor(original) : original;
    assert.equal(view.getFloat64(index * 8, true), expected);
  }
  const settings = prepareCspSettings(frame, { required: 14, neighbors: 12, mode: 'auto' });
  assert.deepEqual([...settings.subarray(0, 4)], [14, 12, 1, 0x7fc00000]);
  const cellView = new DataView(settings.buffer);
  for (let component = 0; component < 9; component++) assert.equal(cellView.getFloat64(16 + component * 8, true), frame.cell.vectors[component]);
  assert.equal(source.byteLength, frame.fractional.length * 8);
});

test('normalized local CSP helper preserves greedy disjoint pairing and the finite HCP baseline', () => {
  for (const [kind, neighbors] of [['fcc', 12], ['bcc', 8], ['hcp', 12]]) {
    const frame = crystalFrame(kind, 4), search = new NeighborSearch(frame);
    const expected = calculateCentrosymmetry(frame, { neighbors }).centrosymmetry;
    for (let atom = 0; atom < frame.fractional.length / 3; atom++) {
      assert.equal(Math.fround(normalizedCentrosymmetry(search.nearest(atom, neighbors))), expected[atom]);
    }
    if (kind === 'hcp') assert.ok(expected.every(value => Number.isFinite(value) && value > 0));
    else assert.ok(expected.every(value => value === 0));
  }
});

function fakeRuntime(frame, { records, unresolvedPasses = 0, neverResolve = false, flag = 0,
  failRead = false, failAllocation = false, abortController, classifications } = {}) {
  const allocated = [], released = [], radii = [], sources = [], labels = [];
  const allocate = bytes => {
    if (failAllocation && allocated.length === 1) throw new Error('allocation failed');
    const buffer = { data: new Uint8Array(bytes) }; allocated.push(buffer); return buffer;
  };
  let passes = 0, cachedTypes = classifications;
  const runtime = {
    getAdaptiveCna() { return cachedTypes; },
    cacheAdaptiveCna(_frame, types) { cachedTypes = types.slice(); },
    async prepareNeighbors(_frame, radius, { signal }) { signal?.throwIfAborted(); radii.push(radius); return { atomCount: frame.fractional.length / 3 }; },
    createBuffer: allocate,
    storageBuffer(values) { const buffer = allocate(values.byteLength); buffer.data.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)); return buffer; },
    neighborBindings(_context, extra) { return extra; },
    async run(source, bindings, _count, options) {
      sources.push(source);
      if (source === CNA_ADAPTIVE_SHADER) {
        const data = new Uint32Array(bindings[0].data.buffer);
        for (let atom = options.startAtom; atom < options.endAtom; atom++) {
          const base = atom * CNA_RESULT_WORDS; data[base] = 1; data[base + 2] = 1;
        }
        return;
      }
      passes++;
      labels.push(new Uint32Array(bindings[3].data.buffer).slice());
      const data = new Uint32Array(bindings[0].data.buffer), values = new Float32Array(data.buffer);
      for (let atom = options.startAtom; atom < options.endAtom; atom++) {
        const base = atom * CSP_RESULT_WORDS, record = records?.[atom] ?? {};
        values[base] = record.value ?? 0;
        data[base + 1] = flag; data[base + 2] = !neverResolve && passes > unresolvedPasses ? 1 : 0;
        data[base + 3] = 14; data[base + 4] = record.type ?? 0; data[base + 5] = record.neighbors ?? 12;
        data[base + 6] = record.inferred ?? 0; data[base + 7] = record.incomplete ?? 0;
      }
      options.onProgress({ completedAtoms: options.endAtom, totalAtoms: options.endAtom });
      abortController?.abort();
    },
    async read(buffer, Type, length, { signal }) { signal?.throwIfAborted(); if (failRead) throw new Error('device lost'); return new Type(buffer.data.buffer.slice(0, length * Type.BYTES_PER_ELEMENT)); },
    disposeBuffers(buffers) { released.push(...buffers); },
  };
  return { runtime, allocated, released, radii, sources, labels };
}

test('GPU CSP packs ranged manual results without CPU correction and releases private original-coordinate buffers', async () => {
  const frame = crystalFrame('fcc', 1), setup = fakeRuntime(frame, { records: [{ value: .5 }, { value: .25 }, { value: 0 }, { value: .75 }] });
  const progress = [], result = await analyzeGpuCentrosymmetry(setup.runtime, frame, { neighbors: 8, startAtom: 1, endAtom: 3 }, { onProgress: value => progress.push(value) });
  assert.deepEqual([...result.centrosymmetry], [.25, 0]); assert.equal(result.incomplete, 0);
  assert.equal(result.startAtom, 1); assert.equal(result.endAtom, 3); assert.equal(result.gpuCorrectionAtoms, 0);
  assert.equal(result.warning, null);
  assert.equal(result.gpuArithmetic, 'ieee754-f64-ordering'); assert.equal(result.gpuRadiusAttempts, 1);
  assert.deepEqual(setup.sources, [CSP_SHADER]); assert.deepEqual(setup.released, setup.allocated);
  assert.ok(progress.some(value => value.phase === 'analyzing' && value.completedAtoms > 0));
});

test('Auto CSP reuses complete supplied/cached CNA labels and preserves inference, ICO, unresolved and incomplete summaries', async () => {
  const frame = { fractional: Float64Array.from({ length: 21 }, (_value, index) => .1 + index / 100),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }) };
  const labels = Uint8Array.from([1, 2, 3, 0, 0, 4, 1]);
  const records = [
    { type: 1, neighbors: 12, value: 0 }, { type: 2, neighbors: 12, value: .194444 },
    { type: 3, neighbors: 8, value: 0 }, { type: 0, neighbors: 12, inferred: 1, value: .1 },
    { type: 0, neighbors: 0, value: NaN }, { type: 4, neighbors: 0, value: NaN },
    { type: 1, neighbors: 12, value: NaN, incomplete: 1 },
  ];
  for (const provided of [true, false]) {
    const setup = fakeRuntime(frame, { records, classifications: provided ? undefined : labels });
    const result = await analyzeGpuCentrosymmetry(setup.runtime, frame, { mode: 'auto', ...(provided ? { structureInput: labels } : {}) });
    assert.deepEqual(result.cspStructureTypes, labels); assert.deepEqual([...result.cspNeighborCounts], [12, 12, 8, 12, 0, 0, 12]);
    assert.deepEqual(result.cspSummary, { fcc: 2, hcp: 1, bcc: 1, other: 2, ico: 1, inferred: 1, unresolved: 3 });
    assert.equal(result.incomplete, 1); assert.equal(result.gpuCnaReused, true); assert.equal(result.gpuCnaCorrectionAtoms, 0);
    assert.match(result.warning, /^1 atoms have insufficient neighbors or zero-length environments/);
    assert.ok(Number.isNaN(result.centrosymmetry[4])); assert.ok(Number.isNaN(result.centrosymmetry[5]));
    assert.deepEqual([...setup.labels[0]], [...labels]); assert.deepEqual(setup.released, setup.allocated);
    assert.equal(labels.byteLength, 7);
  }
});

test('fresh Auto CSP computes adaptive CNA on GPU once and reuses its resident-frame label cache', async () => {
  const frame = crystalFrame('fcc', 1), setup = fakeRuntime(frame, {
    records: Array.from({ length: 4 }, () => ({ type: 1, neighbors: 12, value: 0 })),
  });
  const first = await analyzeGpuCentrosymmetry(setup.runtime, frame, { mode: 'auto' });
  assert.equal(first.gpuCnaReused, false); assert.equal(first.gpuCnaCorrectionAtoms, 0);
  assert.deepEqual(setup.sources, [CNA_ADAPTIVE_SHADER, CSP_SHADER]);
  assert.deepEqual([...setup.labels[0]], [1, 1, 1, 1]);
  assert.deepEqual([...first.cspStructureTypes], [1, 1, 1, 1]);
  const second = await analyzeGpuCentrosymmetry(setup.runtime, frame, { mode: 'auto' });
  assert.equal(second.gpuCnaReused, true);
  assert.deepEqual(setup.sources, [CNA_ADAPTIVE_SHADER, CSP_SHADER, CSP_SHADER]);
  assert.deepEqual(second.cspSummary, { fcc: 4, hcp: 0, bcc: 0, other: 0, ico: 0, inferred: 0, unresolved: 0 });
  assert.deepEqual(setup.released, setup.allocated);
});

test('CSP unresolved nearest shells grow on GPU, and candidate/radius arithmetic budgets reject explicitly', async () => {
  const frame = crystalFrame('fcc', 1), setup = fakeRuntime(frame, { unresolvedPasses: 2 });
  const result = await analyzeGpuCentrosymmetry(setup.runtime, frame);
  assert.equal(result.gpuRadiusAttempts, 3); assert.equal(result.gpuCorrectionAtoms, 0);
  assert.deepEqual(setup.radii, [setup.radii[0], setup.radii[0] * 1.6, setup.radii[0] * 1.6 * 1.6]);
  assert.deepEqual(setup.released, setup.allocated);
  for (const options of [{ flag: 1 }, { flag: 2 }, { neverResolve: true }]) {
    const rejected = fakeRuntime(frame, options);
    await assert.rejects(analyzeGpuCentrosymmetry(rejected.runtime, frame), { name: 'GpuUnavailableError' });
    if (options.neverResolve) assert.equal(rejected.sources.length, MAX_GPU_CNA_RADIUS_ATTEMPTS);
    assert.deepEqual(rejected.released, rejected.allocated);
  }
});

test('GPU CSP cancellation/read/partial-allocation failures free buffers and retain original source arrays', async () => {
  const frame = crystalFrame('fcc', 1), original = frame.fractional.slice();
  for (const mode of ['cancel', 'read', 'allocation']) {
    const controller = new AbortController(), setup = fakeRuntime(frame, { abortController: mode === 'cancel' ? controller : undefined,
      failRead: mode === 'read', failAllocation: mode === 'allocation' });
    await assert.rejects(analyzeGpuCentrosymmetry(setup.runtime, frame, {}, { signal: controller.signal }),
      mode === 'cancel' ? { name: 'AbortError' } : mode === 'read' ? /device lost/ : /allocation failed/);
    assert.deepEqual(setup.released, setup.allocated); assert.deepEqual(frame.fractional, original);
  }
});

test('GPU CSP validates the full manual even-count API and Auto structure inputs before allocation', async () => {
  const frame = crystalFrame('fcc', 1), setup = fakeRuntime(frame);
  for (const parameters of [{ mode: 'invalid' }, { neighbors: 1 }, { neighbors: 33 }, { neighbors: 3 }, { startAtom: -1 },
    { mode: 'auto', structureInput: new Uint16Array(4) }, { mode: 'auto', structureInput: Uint8Array.from([0, 1, 2, 5]) }]) {
    await assert.rejects(analyzeGpuCentrosymmetry(setup.runtime, frame, parameters));
  }
  assert.equal(setup.allocated.length, 0);
  for (let neighbors = 2; neighbors <= 32; neighbors += 2) await analyzeGpuCentrosymmetry(setup.runtime, frame, { neighbors });
  assert.equal(setup.sources.length, 16); assert.deepEqual(setup.released, setup.allocated);
});
