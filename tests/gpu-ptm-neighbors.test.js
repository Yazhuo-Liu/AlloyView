import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePtm, PTM_FIELDS, validatePreparedPtmNeighbors, validatePtmParameters } from '../src/analysis/ptm.js';
import { NeighborSearch } from '../src/analysis/neighbors.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';
import { analyzeGpuPtmNeighbors, preparePtmNeighborSettings, MAX_GPU_PTM_NEIGHBOR_BYTES,
  GPU_PTM_NEIGHBOR_BATCH_ATOMS } from '../src/analysis/gpu/ptm-neighbors.js';
import { PTM_NEIGHBORS_SHADER, PTM_NEIGHBOR_ROW_WORDS } from '../src/analysis/gpu/ptm-neighbors-shaders.js';
import { MAX_GPU_CNA_RADIUS_ATTEMPTS } from '../src/analysis/gpu/cna.js';

function tableFor(frame) {
  const search = new NeighborSearch(frame), count = search.count;
  const table = { counts: new Uint8Array(count), indices: new Uint32Array(count * 18), vectors: new Float64Array(count * 54),
    maxNeighbors: 18, sourceAtomCount: count, startAtom: 0, endAtom: count };
  for (let atom = 0; atom < count; atom++) {
    let neighbors = search.nearest(atom, 18);
    if (neighbors.some(neighbor => neighbor.distanceSquared < 1e-20)) neighbors = [];
    table.counts[atom] = neighbors.length;
    neighbors.forEach((neighbor, rank) => {
      const index = atom * 18 + rank;
      table.indices[index] = neighbor.atom; table.vectors.set([neighbor.x, neighbor.y, neighbor.z], index * 3);
    });
  }
  return table;
}

test('prepared nearest-18 tables reproduce every real PTM field without rebuilding or querying the CPU neighbor search', async () => {
  for (const kind of ['fcc', 'hcp', 'bcc', 'sc', 'diamond', 'hex-diamond']) {
    const frame = crystalFrame(kind, 2), preparedNeighbors = tableFor(frame);
    const expected = await calculatePtm(frame, { flags: 255 });
    const nearest = NeighborSearch.prototype.nearest;
    NeighborSearch.prototype.nearest = () => assert.fail('Prepared PTM must not perform CPU nearest-neighbor queries.');
    try {
      const actual = await calculatePtm(frame, { preparedNeighbors, flags: 255 });
      for (const field of Object.keys(PTM_FIELDS)) assert.deepEqual(actual[field], expected[field], `${kind}/${field}`);
      const split = Math.floor(frame.fractional.length / 6);
      const range = await calculatePtm(frame, { preparedNeighbors, flags: 255, startAtom: split });
      for (const [field, [, stride]] of Object.entries(PTM_FIELDS)) assert.deepEqual(range[field], expected[field].subarray(split * stride), `${kind}/range/${field}`);
    } finally { NeighborSearch.prototype.nearest = nearest; }
  }
});

test('ordinary PTM templates consume contiguous rows while diamond and graphene require full source coverage', async () => {
  const frame = crystalFrame('fcc', 3), full = tableFor(frame), startAtom = 31, endAtom = 67;
  const sliced = { ...full, startAtom, endAtom, counts: full.counts.subarray(startAtom, endAtom),
    indices: full.indices.subarray(startAtom * 18, endAtom * 18), vectors: full.vectors.subarray(startAtom * 54, endAtom * 54) };
  const actual = await calculatePtm(frame, { flags: 31, startAtom, endAtom, preparedNeighbors: sliced });
  const expected = await calculatePtm(frame, { flags: 31, startAtom, endAtom });
  for (const field of Object.keys(PTM_FIELDS)) assert.deepEqual(actual[field], expected[field]);
  assert.strictEqual(validatePreparedPtmNeighbors(frame, sliced, { flags: 31, startAtom, endAtom }), sliced);
  for (const flags of [32, 64, 128, 255]) await assert.rejects(calculatePtm(frame, { flags, startAtom, endAtom, preparedNeighbors: sliced }), /full source/);
  assert.throws(() => validatePreparedPtmNeighbors(frame, sliced), /complete typed nearest-18/);
});

test('prepared PTM handles isolated and coincident rows silently and rejects malformed scientific tables before Wasm fitting', async () => {
  const frame = { fractional: new Float64Array([0, 0, 0]), cell: createCell({ vectors: [8, 0, 0, 0, 8, 0, 0, 0, 8], pbc: [false, false, false] }) };
  const isolated = tableFor(frame), result = await calculatePtm(frame, { preparedNeighbors: isolated });
  assert.deepEqual([...result.structures], [0]); assert.ok(result.rmsd.every(Number.isNaN));
  const duplicate = crystalFrame('fcc', 1); duplicate.fractional.set(duplicate.fractional.subarray(0, 3), 3);
  const coincident = tableFor(duplicate);
  const expected = await calculatePtm(duplicate), actual = await calculatePtm(duplicate, { preparedNeighbors: coincident });
  for (const field of Object.keys(PTM_FIELDS)) assert.deepEqual(actual[field], expected[field]);
  const source = crystalFrame('fcc', 1), table = tableFor(source);
  const invalids = [
    { ...table, maxNeighbors: 17 }, { ...table, counts: new Uint16Array(table.counts) },
    { ...table, vectors: new Float32Array(table.vectors) }, { ...table, sourceAtomCount: 5 },
    { ...table, counts: Uint8Array.from([17, 18, 18, 18]) },
  ];
  for (const invalid of invalids) await assert.rejects(calculatePtm(source, { preparedNeighbors: invalid }), /prepared neighbors/);
  const badIds = { ...table, indices: table.indices.slice() }; badIds.indices[0] = 4;
  await assert.rejects(calculatePtm(source, { preparedNeighbors: badIds }), /indices.*outside/);
  const badVectors = { ...table, vectors: table.vectors.slice() }; badVectors.vectors[0] = NaN;
  await assert.rejects(calculatePtm(source, { preparedNeighbors: badVectors }), /finite Cartesian/);
  badVectors.vectors.set([0, 0, 0]);
  await assert.rejects(calculatePtm(source, { preparedNeighbors: badVectors }), /coincident/);
  assert.throws(() => validatePtmParameters({ flags: 0 }), /template/);
  assert.throws(() => validatePtmParameters({ rmsdCutoff: -1 }), /threshold/);
});

test('trusted-table preflight checks shape without scanning values and PTM workers retain full scientific validation', async () => {
  const frame = crystalFrame('fcc', 1), table = tableFor(frame);
  const unreadableFrame = { ...frame, fractional: { length: frame.fractional.length,
    [Symbol.iterator]() { assert.fail('Schema-only preflight must not scan source coordinates.'); } } };
  assert.strictEqual(validatePreparedPtmNeighbors(unreadableFrame, table, { validateValues: false }), table);
  assert.throws(() => validatePreparedPtmNeighbors(unreadableFrame, table), /must not scan/);
  assert.throws(() => validatePreparedPtmNeighbors(unreadableFrame,
    { ...table, vectors: new Float32Array(table.vectors.length) }, { validateValues: false }), /complete typed nearest-18/);
  const invalidIds = { ...table, indices: table.indices.slice() }; invalidIds.indices[0] = table.counts.length;
  assert.strictEqual(validatePreparedPtmNeighbors(frame, invalidIds, { validateValues: false }), invalidIds);
  assert.throws(() => validatePreparedPtmNeighbors(frame, invalidIds), /indices.*outside/);
  const invalidVectors = { ...table, vectors: table.vectors.slice() }; invalidVectors.vectors[0] = NaN;
  assert.strictEqual(validatePreparedPtmNeighbors(frame, invalidVectors, { validateValues: false }), invalidVectors);
  assert.throws(() => validatePreparedPtmNeighbors(frame, invalidVectors), /finite Cartesian/);
  await assert.rejects(calculatePtm(frame, { preparedNeighbors: invalidVectors, validateValues: false }), /finite Cartesian/);
  const sliced = { ...table, startAtom: 1, counts: table.counts.subarray(1),
    indices: table.indices.subarray(18), vectors: table.vectors.subarray(54) };
  assert.throws(() => validatePreparedPtmNeighbors(frame, sliced,
    { startAtom: 1, flags: 32, validateValues: false }), /full source/);
  assert.throws(() => validatePreparedPtmNeighbors(frame, table,
    { startAtom: 0, endAtom: table.counts.length + 1, validateValues: false }), /range/);
});

function fakeRuntime(frame, { table = tableFor(frame), unresolvedPasses = 0, neverResolve = false, flag = 0,
  failAllocation = false, failRead = false, controller } = {}) {
  const allocated = [], released = [], radii = [], sources = [], ranges = [];
  let releases = 0;
  const allocate = bytes => {
    if (failAllocation && allocated.length === 1) throw new Error('allocation failed');
    const buffer = { data: new Uint8Array(bytes) }; allocated.push(buffer); return buffer;
  };
  const runtime = {
    pinFrames() { return () => { releases++; }; },
    async prepareNeighbors(_frame, radius, { signal }) { signal?.throwIfAborted(); radii.push(radius); return { atomCount: frame.fractional.length / 3 }; },
    createBuffer: allocate,
    storageBuffer(values) { const buffer = allocate(values.byteLength); buffer.data.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)); return buffer; },
    write(buffer, values, offset = 0) { buffer.data.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), offset); },
    neighborBindings(_context, extra) { return extra; },
    async run(source, bindings, count, options) {
      sources.push(source); ranges.push([options.startAtom, options.endAtom, count]);
      const data = new Uint32Array(bindings[0].data.buffer), view = new DataView(data.buffer);
      for (let atom = options.startAtom; atom < options.endAtom; atom++) {
        const row = (atom - options.startAtom) * PTM_NEIGHBOR_ROW_WORDS;
        data[row] = table.counts[atom]; data[row + 1] = flag; data[row + 2] = !neverResolve && radii.length > unresolvedPasses ? 1 : 0;
        for (let neighbor = 0; neighbor < table.counts[atom]; neighbor++) {
          const source = atom * 18 + neighbor, target = row + 4 + neighbor * 7;
          data[target] = table.indices[source];
          for (let axis = 0; axis < 3; axis++) view.setFloat64((target + 1 + axis * 2) * 4, table.vectors[source * 3 + axis], true);
        }
      }
      controller?.abort();
    },
    async read(buffer, Type, length, { signal }) { signal?.throwIfAborted(); if (failRead) throw new Error('device lost'); return new Type(buffer.data.buffer.slice(0, length * Type.BYTES_PER_ELEMENT)); },
    disposeBuffers(buffers) { released.push(...buffers); },
  };
  return { runtime, allocated, released, radii, sources, ranges, get releases() { return releases; } };
}

test('GPU nearest-18 batches decode original Float64 vectors and preserve periodic image indices', async () => {
  const frame = crystalFrame('hcp', 1), setup = fakeRuntime(frame), expected = tableFor(frame), progress = [];
  const result = await analyzeGpuPtmNeighbors(setup.runtime, frame, {}, { onProgress: value => progress.push(value) });
  for (const field of ['counts', 'indices', 'vectors']) assert.deepEqual(result[field], expected[field]);
  assert.equal(result.maxNeighbors, 18); assert.equal(result.startAtom, 0); assert.equal(result.endAtom, 2);
  assert.equal(result.gpuCorrectionAtoms, 0); assert.equal(result.gpuArithmetic, 'ieee754-f64-ordering');
  assert.ok([...result.indices].filter(atom => atom === 0).length > 1, 'different periodic images retain repeated source indices');
  assert.equal(result.gpuRadiusAttempts, 1); assert.deepEqual(setup.sources, [PTM_NEIGHBORS_SHADER]);
  assert.deepEqual(setup.released, setup.allocated); assert.equal(setup.releases, 1);
  assert.equal(progress.at(-1).completedAtoms, 2);
  const settings = preparePtmNeighborSettings(frame, 18), view = new DataView(settings.buffer);
  assert.equal(view.getFloat64(88, true), 1e-20);
  for (let i = 0; i < 9; i++) assert.equal(view.getFloat64(16 + i * 8, true), frame.cell.vectors[i]);
});

test('GPU nearest-18 scratch buffers remain bounded across multiple source batches', async () => {
  const count = GPU_PTM_NEIGHBOR_BATCH_ATOMS + 3;
  const frame = { fractional: new Float32Array(count * 3), cell: createCell({ vectors: [10, 0, 0, 0, 10, 0, 0, 0, 10] }) };
  const table = { counts: new Uint8Array(count), indices: new Uint32Array(count * 18), vectors: new Float64Array(count * 54) };
  const setup = fakeRuntime(frame, { table });
  const result = await analyzeGpuPtmNeighbors(setup.runtime, frame);
  assert.equal(result.counts.length, count);
  assert.equal(setup.allocated[0].data.byteLength, GPU_PTM_NEIGHBOR_BATCH_ATOMS * PTM_NEIGHBOR_ROW_WORDS * 4);
  assert.deepEqual(setup.ranges, [[0, GPU_PTM_NEIGHBOR_BATCH_ATOMS, GPU_PTM_NEIGHBOR_BATCH_ATOMS], [GPU_PTM_NEIGHBOR_BATCH_ATOMS, count, 3]]);
  assert.deepEqual(setup.released, setup.allocated);
});

test('GPU nearest-18 unresolved shells expand without CPU correction and bounded failures release all allocations', async () => {
  const frame = crystalFrame('fcc', 1), setup = fakeRuntime(frame, { unresolvedPasses: 2 });
  const result = await analyzeGpuPtmNeighbors(setup.runtime, frame);
  assert.equal(result.gpuRadiusAttempts, 3);
  assert.deepEqual(setup.radii, [setup.radii[0], setup.radii[0] * 1.6, setup.radii[0] * 1.6 * 1.6]);
  for (const options of [{ flag: 1 }, { neverResolve: true }, { failRead: true }, { failAllocation: true }]) {
    const rejected = fakeRuntime(frame, options);
    await assert.rejects(analyzeGpuPtmNeighbors(rejected.runtime, frame));
    if (options.neverResolve) assert.equal(rejected.sources.length, MAX_GPU_CNA_RADIUS_ATTEMPTS);
    assert.deepEqual(rejected.released, rejected.allocated); assert.equal(rejected.releases, 1);
  }
});

test('GPU nearest-18 cancellation and host-table budget validation preserve original inputs', async () => {
  const frame = crystalFrame('fcc', 1), original = frame.fractional.slice(), controller = new AbortController();
  const setup = fakeRuntime(frame, { controller });
  await assert.rejects(analyzeGpuPtmNeighbors(setup.runtime, frame, {}, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(setup.released, setup.allocated); assert.equal(setup.releases, 1); assert.deepEqual(frame.fractional, original);
  const count = Math.floor(MAX_GPU_PTM_NEIGHBOR_BYTES / 505) + 1;
  const huge = { fractional: { length: count * 3, get 0() { assert.fail('Oversized tables must fail before reading source coordinates.'); } } };
  await assert.rejects(analyzeGpuPtmNeighbors(setup.runtime, huge), { name: 'GpuUnavailableError' });
  await assert.rejects(analyzeGpuPtmNeighbors(setup.runtime, frame, { startAtom: 1 }), /complete source frame/);
});
