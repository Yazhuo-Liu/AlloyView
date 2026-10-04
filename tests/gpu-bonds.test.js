import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBonds } from '../src/analysis/bonds.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { analyzeGpuBonds, prepareGpuBondParameters, correctGpuBondAtom } from '../src/analysis/gpu/bonds.js';
import { BONDS_COUNT_SHADER, BONDS_WRITE_SHADER, BOND_ATOM_WORDS, BOND_RECORD_WORDS } from '../src/analysis/gpu/bonds-shaders.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';

function correctedGraph(frame, parameters) {
  const prepared = prepareGpuBondParameters(frame, parameters), search = new NeighborSearch(frame);
  const indices = [], vectors = [], shifts = [], coordination = [];
  for (let atom = prepared.startAtom; atom < prepared.endAtom; atom++) {
    const corrected = correctGpuBondAtom(frame, prepared, atom, search);
    coordination.push(corrected.coordination);
    for (const edge of corrected.edges) { indices.push(atom, edge.atom); vectors.push(edge.x, edge.y, edge.z); shifts.push(edge.imageA, edge.imageB, edge.imageC); }
  }
  return { indices: Uint32Array.from(indices), vectors: Float32Array.from(vectors), shifts: Int32Array.from(shifts), coordination: Uint32Array.from(coordination) };
}

test('GPU bond corrections preserve primitive self images and repeated images with CPU shifts', () => {
  for (const parameters of [{ cutoff: 4.01 }, { cutoff: 8.01 }, { cutoff: 4 }]) {
    const frame = crystalFrame('sc', 1), expected = calculateBonds(frame, parameters), actual = correctedGraph(frame, parameters);
    for (const field of ['indices', 'vectors', 'shifts', 'coordination']) assert.deepEqual(actual[field], expected[field], field);
  }
});

test('GPU bond corrections preserve triclinic mixed-PBC geometry, range outputs and wrapped source coordinates', () => {
  const frame = { fractional: Float64Array.from([3.05, -.95, .2, -2.05, 4.95, .2, .2, .2, .2]), types: Uint16Array.from([0, 1, 0]),
    cell: createCell({ vectors: [10, 0, 0, 4, 8, 0, 0, 0, 10], triclinic: true, pbc: [true, true, false] }) };
  for (const parameters of [{ cutoff: 2 }, { cutoff: 4.2, startAtom: 1 }]) {
    const expected = calculateBonds(frame, parameters), actual = correctedGraph(frame, parameters);
    for (const field of ['indices', 'vectors', 'shifts', 'coordination']) assert.deepEqual(actual[field], expected[field], field);
  }
});

test('GPU bond corrections apply symmetric cutoff overrides and exclude coincident atom IDs', () => {
  const frame = { fractional: Float64Array.from([.1, .1, .1, .2, .1, .1, .3, .1, .1, .1, .1, .1]), types: Uint16Array.from([0, 1, 0, 0]),
    cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10], pbc: [false, false, false] }) };
  for (const parameters of [{ cutoff: 2.1, pairCutoffs: [{ first: 1, second: 0, cutoff: 0 }] },
    { cutoff: .5, pairCutoffs: [{ first: 1, second: 0, cutoff: 1 }, { first: 0, second: 0, cutoff: 2.1 }] }]) {
    const expected = calculateBonds(frame, parameters), actual = correctedGraph(frame, parameters);
    for (const field of ['indices', 'vectors', 'shifts', 'coordination']) assert.deepEqual(actual[field], expected[field], field);
  }
});

test('GPU bond parameter encodings reject duplicates and unsupported numeric types before upload', () => {
  const frame = crystalFrame('sc', 1);
  assert.throws(() => prepareGpuBondParameters(frame, { cutoff: 4, pairCutoffs: [
    { first: 0, second: 1, cutoff: 2 }, { first: 1, second: 0, cutoff: 3 }] }), /only one cutoff/);
  assert.throws(() => prepareGpuBondParameters(frame, { cutoff: 4, pairCutoffs: [{ first: 0, second: 1, cutoff: -1 }] }), /Invalid/);
  assert.throws(() => prepareGpuBondParameters(frame, { cutoff: 4, pairCutoffs: Array.from({ length: 257 }, (_, index) => ({ first: 0, second: index, cutoff: 1 })) }), { name: 'GpuUnavailableError' });
  frame.types = Float64Array.from([.5]);
  assert.equal(calculateBonds(frame, { cutoff: 4.01 }).count, 3);
  assert.throws(() => prepareGpuBondParameters(frame, { cutoff: 4 }), { name: 'GpuUnavailableError' });
});

function correctionRuntime(frame, { failRead = false, abortController, allocationFailure = false } = {}) {
  const allocated = [], released = [], sources = [];
  const allocate = bytes => { if (allocationFailure && allocated.length === 1) throw new Error('allocation failed'); const buffer = { data: new Uint8Array(bytes) }; allocated.push(buffer); return buffer; };
  const runtime = {
    async prepareNeighbors() { return { atomCount: frame.types.length }; },
    createBuffer: allocate,
    storageBuffer(values) { const buffer = allocate(values.byteLength); buffer.data.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)); return buffer; },
    neighborBindings(_context, extra) { return extra; },
    write(buffer, values) { buffer.data.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)); },
    async run(source, bindings) {
      sources.push(source);
      if (source === BONDS_COUNT_SHADER) {
        const atomData = new Uint32Array(bindings[1].data.buffer);
        for (let atom = 0; atom < frame.types.length; atom++) atomData[atom * BOND_ATOM_WORDS + 2] = 1;
      }
      abortController?.abort();
    },
    async read(buffer, Type, length, { signal }) { signal?.throwIfAborted(); if (failRead) throw new Error('device lost'); return new Type(buffer.data.buffer.slice(0, length * Type.BYTES_PER_ELEMENT)); },
    disposeBuffers(buffers) { released.push(...buffers); },
  };
  return { runtime, allocated, released, sources };
}

test('GPU bond prefix allocation incorporates exact corrections before compact output and includes histogram', async () => {
  const frame = crystalFrame('sc', 1), parameters = { cutoff: 4.01 }, expected = calculateBonds(frame, parameters);
  const { runtime, allocated, released, sources } = correctionRuntime(frame);
  const actual = await analyzeGpuBonds(runtime, frame, parameters);
  for (const field of ['indices', 'vectors', 'shifts', 'coordination', 'count']) assert.deepEqual(actual[field], expected[field], field);
  assert.deepEqual(actual.histogram, [{ coordination: 6, count: 1 }]); assert.equal(actual.meanCoordination, 6);
  assert.equal(actual.gpuCorrectionAtoms, 1);
  assert.deepEqual(sources, [BONDS_COUNT_SHADER, BONDS_WRITE_SHADER]);
  assert.ok(allocated.some(buffer => buffer.data.byteLength === actual.count * BOND_RECORD_WORDS * 4));
  assert.deepEqual(released, allocated);
});

test('GPU bond corrected output cap rejects before allocating edge buffers; disabled pairs yield an empty graph', async () => {
  const frame = crystalFrame('sc', 1);
  const capped = correctionRuntime(frame);
  await assert.rejects(analyzeGpuBonds(capped.runtime, frame, { cutoff: 4.01, maxBonds: 2 }), /exceeds 2 edges/);
  assert.equal(capped.allocated.length, 2); assert.deepEqual(capped.released, capped.allocated);
  const empty = correctionRuntime(frame);
  const actual = await analyzeGpuBonds(empty.runtime, frame, { cutoff: 4.01, pairCutoffs: [{ first: 0, second: 0, cutoff: 0 }] });
  assert.equal(actual.count, 0); assert.equal(actual.indices.length, 0); assert.deepEqual([...actual.coordination], [0]);
  assert.deepEqual(empty.sources, [BONDS_COUNT_SHADER]); assert.deepEqual(empty.released, empty.allocated);
});

test('GPU bond read failures, partial allocations and cancellation free temporary resources', async () => {
  const frame = crystalFrame('sc', 1);
  for (const mode of ['read', 'allocation', 'cancel']) {
    const controller = new AbortController();
    const setup = correctionRuntime(frame, { failRead: mode === 'read', allocationFailure: mode === 'allocation', abortController: mode === 'cancel' ? controller : undefined });
    await assert.rejects(analyzeGpuBonds(setup.runtime, frame, { cutoff: 4.01 }, { signal: controller.signal }),
      mode === 'cancel' ? { name: 'AbortError' } : mode === 'read' ? /device lost/ : /allocation failed/);
    assert.deepEqual(setup.released, setup.allocated);
  }
});
