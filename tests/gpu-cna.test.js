import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCna, classify } from '../src/analysis/cna.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';
import { analyzeGpuCna, adaptiveCnaInitialRadius, correctGpuCnaAtom, MAX_GPU_CNA_CORRECTIONS, MAX_GPU_CNA_RADIUS_ATTEMPTS } from '../src/analysis/gpu/cna.js';
import { CNA_FIXED_SHADER, CNA_ADAPTIVE_SHADER, CNA_RESULT_WORDS, CNA_FLAG_PRECISION, CNA_FLAG_BUDGET } from '../src/analysis/gpu/cna-shaders.js';

test('sparse exact CNA corrections preserve fixed/adaptive FCC, HCP, BCC and primitive periodic images', () => {
  for (const [kind, cutoff] of [['fcc', 3.5], ['hcp', 4.8], ['bcc', 4.8]]) {
    for (const repeats of [1, 3]) {
      const frame = crystalFrame(kind, repeats), search = new NeighborSearch(frame);
      for (const mode of ['fixed', 'adaptive']) {
        const parameters = { mode, cutoff }, expected = calculateCna(frame, parameters).structures;
        const corrected = Uint8Array.from(expected, (_value, atom) => correctGpuCnaAtom(search, atom, parameters));
        assert.deepEqual(corrected, expected);
      }
    }
  }
});

test('initial adaptive GPU radius matches CPU nonperiodic spans and skew/periodic geometry without an index', () => {
  for (const frame of [crystalFrame('fcc', 1), crystalFrame('hcp', 3), {
    fractional: Float64Array.from([.05, .2, -.3, .99, .4, 1.7, -.2, .6, 2.1]),
    cell: createCell({ vectors: [5, 0, 0, 2.5, 4, 0, .3, .2, 9], pbc: [true, true, false], triclinic: true }),
  }]) assert.equal(adaptiveCnaInitialRadius(frame), new NeighborSearch(frame).initialRadius);
});

test('ideal BCC outer-shell ties cannot turn any twelve-neighbor trial into a close-packed structure', () => {
  const frame = crystalFrame('bcc', 1), shell = new NeighborSearch(frame).nearest(0, 14);
  assert.equal(calculateCna(frame).structures[0], 3);
  for (let firstExcluded = 8; firstExcluded < 14; firstExcluded++) {
    for (let secondExcluded = firstExcluded + 1; secondExcluded < 14; secondExcluded++) {
      const trial = shell.filter((_neighbor, index) => index !== firstExcluded && index !== secondExcluded);
      const radius = trial.reduce((sum, neighbor) => sum + Math.sqrt(neighbor.distanceSquared), 0) / 12 * (1 + Math.SQRT2) / 2;
      assert.equal(classify(trial, radius), 0);
    }
  }
});

function fakeRuntime(frame, { flags = CNA_FLAG_PRECISION, unresolvedPasses = 0, neverResolve = false,
  failRead = false, failAllocation = false, abortController } = {}) {
  const allocated = [], released = [], radii = [], calls = [];
  const allocate = bytes => {
    if (failAllocation && allocated.length === 1) throw new Error('allocation failed');
    const buffer = { data: new Uint8Array(bytes) }; allocated.push(buffer); return buffer;
  };
  let passes = 0;
  const runtime = {
    async prepareNeighbors(_frame, radius, { signal }) { signal?.throwIfAborted(); radii.push(radius); return { atomCount: frame.fractional.length / 3 }; },
    createBuffer: allocate,
    storageBuffer(values) { const buffer = allocate(values.byteLength); buffer.data.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)); return buffer; },
    neighborBindings(_context, extra) { return extra; },
    async run(source, bindings, _count, options) {
      calls.push(source); passes++;
      const results = new Uint32Array(bindings[0].data.buffer);
      for (let atom = options.startAtom; atom < options.endAtom; atom++) {
        const offset = atom * CNA_RESULT_WORDS;
        results[offset] = 4;
        results[offset + 1] = flags;
        results[offset + 2] = !neverResolve && passes > unresolvedPasses ? 1 : 0;
        results[offset + 3] = 14;
      }
      options.onProgress({ completedAtoms: options.endAtom, totalAtoms: options.endAtom });
      abortController?.abort();
    },
    async read(buffer, Type, length, { signal }) { signal?.throwIfAborted(); if (failRead) throw new Error('device lost'); return new Type(buffer.data.buffer.slice(0, length * Type.BYTES_PER_ELEMENT)); },
    disposeBuffers(buffers) { released.push(...buffers); },
  };
  return { runtime, allocated, released, radii, calls };
}

test('GPU fixed CNA corrects only flagged atoms, preserves ranges and releases all buffers', async () => {
  const frame = crystalFrame('fcc', 1), parameters = { mode: 'fixed', cutoff: 3.5, startAtom: 1, endAtom: 3 };
  const setup = fakeRuntime(frame), progress = [];
  const result = await analyzeGpuCna(setup.runtime, frame, parameters, { onProgress: value => progress.push(value) });
  assert.deepEqual(result.structures, calculateCna(frame, parameters).structures);
  assert.equal(result.startAtom, 1); assert.equal(result.endAtom, 3); assert.equal(result.gpuCorrectionAtoms, 2);
  assert.equal(result.gpuRadiusAttempts, 1);
  assert.deepEqual(setup.calls, [CNA_FIXED_SHADER]); assert.deepEqual(setup.radii, [3.5]);
  assert.ok(progress.some(value => value.phase === 'analyzing' && value.completedAtoms > 0));
  assert.deepEqual(setup.released, setup.allocated);
});

test('representable adaptive search with an overflowing graph radius uses exact sparse correction', async () => {
  const phi = (1 + Math.sqrt(5)) / 2, radius = 1.79e19, side = 3.1e19;
  const scale = radius / Math.hypot(1, phi), coordinates = [0, 0, 0];
  for (const a of [-1, 1]) for (const b of [-phi, phi]) {
    coordinates.push(0, a * scale, b * scale, a * scale, b * scale, 0, b * scale, 0, a * scale);
  }
  const extra = 1.795e19 / Math.sqrt(3);
  coordinates.push(extra, extra, extra, -extra, -extra, -extra);
  for (const corner of [[-.4, -.4, -.4], [-.4, -.4, .4], [-.4, .4, -.4], [.4, -.4, -.4], [.4, .4, -.4], [.4, .4, .4]]) {
    coordinates.push(...corner.map(value => value * side));
  }
  const frame = { fractional: Float64Array.from(coordinates, value => .5 + value / side),
    cell: createCell({ vectors: [side, 0, 0, 0, side, 0, 0, 0, side], pbc: [false, false, false] }) };
  const search = new NeighborSearch(frame), shell = search.nearest(0, 14);
  const graphRadius = shell.slice(0, 12).reduce((sum, neighbor) => sum + Math.sqrt(neighbor.distanceSquared), 0) / 12 * (1 + Math.SQRT2) / 2;
  assert.ok(frame.fractional.every(value => value >= 0 && value <= 1));
  assert.ok(Number.isFinite(Math.fround(search.initialRadius ** 2)));
  assert.equal(Math.fround(graphRadius ** 2), Infinity);
  const parameters = { startAtom: 0, endAtom: 1 }, setup = fakeRuntime(frame);
  const actual = await analyzeGpuCna(setup.runtime, frame, parameters);
  assert.deepEqual(actual.structures, calculateCna(frame, parameters).structures);
  assert.deepEqual([...actual.structures], [4]); assert.equal(actual.gpuCorrectionAtoms, 1);
  assert.deepEqual(setup.released, setup.allocated);
});

test('adaptive CNA expands unresolved spheres on GPU and does not invoke CPU corrections for confident results', async () => {
  const frame = crystalFrame('fcc', 1), setup = fakeRuntime(frame, { flags: 0, unresolvedPasses: 2 });
  const result = await analyzeGpuCna(setup.runtime, frame);
  assert.deepEqual([...result.structures], [4, 4, 4, 4]);
  assert.equal(result.gpuCorrectionAtoms, 0); assert.equal(result.gpuRadiusAttempts, 3);
  const initial = new NeighborSearch(frame).initialRadius;
  assert.deepEqual(setup.radii, [initial, initial * 1.6, initial * 1.6 * 1.6]);
  assert.ok(setup.calls.every(source => source === CNA_ADAPTIVE_SHADER)); assert.deepEqual(setup.released, setup.allocated);
});

test('CNA numerical/candidate/radius budgets reject explicitly rather than returning incomplete classifications', async () => {
  const frame = crystalFrame('fcc', 1);
  const candidates = fakeRuntime(frame, { flags: CNA_FLAG_BUDGET });
  await assert.rejects(analyzeGpuCna(candidates.runtime, frame), { name: 'GpuUnavailableError' });
  assert.deepEqual(candidates.released, candidates.allocated);
  const radius = fakeRuntime(frame, { flags: 0, neverResolve: true });
  await assert.rejects(analyzeGpuCna(radius.runtime, frame), { name: 'GpuUnavailableError' });
  assert.equal(radius.calls.length, MAX_GPU_CNA_RADIUS_ATTEMPTS); assert.deepEqual(radius.released, radius.allocated);
  const count = MAX_GPU_CNA_CORRECTIONS + 1;
  const dense = { fractional: new Float64Array(count * 3), cell: frame.cell };
  const correction = fakeRuntime(dense);
  await assert.rejects(analyzeGpuCna(correction.runtime, dense), { name: 'GpuUnavailableError' });
  assert.deepEqual(correction.released, correction.allocated);
});

test('GPU CNA cancellation, partial allocation and read failures clean temporary buffers', async () => {
  const frame = crystalFrame('fcc', 1);
  for (const mode of ['cancel', 'read', 'allocation']) {
    const controller = new AbortController();
    const setup = fakeRuntime(frame, { abortController: mode === 'cancel' ? controller : undefined,
      failRead: mode === 'read', failAllocation: mode === 'allocation' });
    await assert.rejects(analyzeGpuCna(setup.runtime, frame, {}, { signal: controller.signal }),
      mode === 'cancel' ? { name: 'AbortError' } : mode === 'read' ? /device lost/ : /allocation failed/);
    assert.deepEqual(setup.released, setup.allocated);
  }
});

test('GPU CNA rejects invalid modes/cutoffs/ranges before allocating', async () => {
  const frame = crystalFrame('fcc', 1), setup = fakeRuntime(frame);
  for (const parameters of [{ mode: 'ptm' }, { mode: 'fixed', cutoff: 0 }, { startAtom: -1 }]) {
    await assert.rejects(analyzeGpuCna(setup.runtime, frame, parameters));
  }
  assert.equal(setup.allocated.length, 0);
});
