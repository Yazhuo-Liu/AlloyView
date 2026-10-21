import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { dxaGlobalGeometryFixtures, dxaGlobalBoundaryFixtures, dxaGlobalTrajectoryFixtures } from './helpers/dxa-global-fixtures.js';
import { integerCoordinates, exactOrientation, exactInSphere, validateDxaGeometry } from './helpers/dxa-global-geometry.js';

const frozen = JSON.parse(await readFile(new URL('./fixtures/dxa-global-baseline.json', import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');
let kernel, cancelPhase = null, cancellationReached = false;
const ready = (async () => {
  const { default: createDxa } = await import('../src/analysis/dxa-kernel-threaded.mjs');
  kernel = await createDxa({ wasmBinary: await readFile(new URL('../src/analysis/dxa-kernel-threaded.wasm', import.meta.url)),
    dxaPoolSize: 3, onDxaProgress(phase) {
      if (phase === cancelPhase) {
        cancellationReached = true;
        Atomics.store(kernel.HEAP32, kernel._alloy_dxa_cancel_ptr() / 4, 1);
      }
    } });
  return kernel;
})();
after(async () => { (await ready).PThread?.terminateAllThreads(); });

async function extract(fixture, threads, { capture = true } = {}) {
  await ready;
  const xyz = dxaCartesianCoordinates(fixture.frame), positions = kernel._malloc(xyz.byteLength), cell = kernel._malloc(96);
  assert.ok(positions && cell);
  kernel.HEAPF64.set(xyz, positions / 8); kernel.HEAPF64.set(fixture.frame.cell.vectors, cell / 8);
  kernel.HEAPF64.set(fixture.frame.cell.origin, cell / 8 + 9);
  const pbc = fixture.frame.cell.pbc.reduce((bits, enabled, axis) => bits | (enabled ? 1 << axis : 0), 0);
  let snapshot;
  try {
    kernel._alloy_dxa_reset_cancel(); kernel._alloy_dxa_set_threads(threads);
    const begin = kernel._alloy_dxa_begin(positions, xyz.length / 3, cell, pbc, fixture.lattice, 14, 9, 0, 1, 2.5);
    if (!begin) return { error: kernel.UTF8ToString(kernel._alloy_dxa_last_error()) };
    assert.equal(kernel._alloy_dxa_thread_count(), threads, 'No callback forces serial Delaunay in this test.');
    if (capture) {
      assert.equal(kernel._alloy_dxa_worker_snapshot(128 * 1024 ** 2), 1, kernel.UTF8ToString(kernel._alloy_dxa_last_error()));
      const vertexOffset = kernel._alloy_dxa_worker_vertex_ptr() / 8, tetOffset = kernel._alloy_dxa_worker_tet_ptr() / 4;
      snapshot = { vertices: kernel.HEAPF64.slice(vertexOffset, vertexOffset + kernel._alloy_dxa_worker_vertex_count() * 3),
        tetrahedra: kernel.HEAPU32.slice(tetOffset, tetOffset + kernel._alloy_dxa_worker_tet_count() * 16) };
      kernel._alloy_dxa_release_worker_snapshot();
    }
    const snapshotHash = snapshot && hash(Buffer.concat([Buffer.from(snapshot.vertices.buffer), Buffer.from(snapshot.tetrahedra.buffer)]));
    const pointer = kernel._alloy_dxa_finish();
    if (!pointer) return { snapshot, snapshotHash, error: kernel.UTF8ToString(kernel._alloy_dxa_last_error()) };
    const result = JSON.parse(kernel.UTF8ToString(pointer)); delete result.parallelEdgePasses;
    const input = { atomCount: xyz.length / 3, cell: { vectors: Array.from(fixture.frame.cell.vectors),
      origin: Array.from(fixture.frame.cell.origin), pbc: Array.from(fixture.frame.cell.pbc) }, lattice: fixture.lattice,
    parameters: { trialCircuitLength: 14, circuitStretchability: 9, onlyPerfectDislocations: false,
      lineSmoothingIterations: 1, linePointInterval: 2.5 } };
    return { result, snapshot, scienceHash: hash(JSON.stringify(result)),
      scientificInputSha256: hash(Buffer.concat([Buffer.from(xyz.buffer, xyz.byteOffset, xyz.byteLength), Buffer.from(JSON.stringify(input))])),
      snapshotHash };
  } finally {
    kernel._alloy_dxa_dispose(); kernel._alloy_dxa_reset_cancel();
    kernel._free(positions); kernel._free(cell);
  }
}

test('exact binary64 geometry oracle distinguishes inside, outside, sphere ties and orientation', () => {
  const points = integerCoordinates(new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1,
    .25, .25, .25, 1, 1, 1, 2, 2, 2, 0, 0, Number.MIN_VALUE]));
  assert.equal(exactOrientation(points, [0, 1, 2, 3]), -1);
  assert.equal(exactOrientation(points, [1, 0, 2, 3]), 1);
  assert.equal(exactInSphere(points, [0, 1, 2, 3], 4), -1);
  assert.equal(exactInSphere(points, [0, 1, 2, 3], 5), 0);
  assert.equal(exactInSphere(points, [0, 1, 2, 3], 6), 1);
  assert.equal(exactOrientation(points, [0, 1, 2, 7]), -1, 'Subnormal-height tetrahedron is not rounded to zero.');
});

const geometryFixtures = [...dxaGlobalGeometryFixtures(), ...dxaGlobalBoundaryFixtures()];
for (const fixture of geometryFixtures) {
  test(`global BDEL/PDEL ${fixture.name} preserves baseline science and exact tetrahedron invariants`, async () => {
    const expected = frozen.fixtures[fixture.name];
    for (const threads of [1, 4]) {
      const output = await extract(fixture, threads);
      assert.ok(output.snapshot, output.error);
      const checks = validateDxaGeometry(output.snapshot);
      assert.equal(checks.exactEmptySpherePairs, checks.finiteNeighborPairs, 'Every finite adjacent pair gets the exact predicate.');
      assert.ok(checks.exactEmptySpherePairs > 0);
      if (threads === 1) assert.equal(output.snapshotHash, expected.snapshotHash,
        'Complete vertex and tetrahedron snapshot is frozen from d1bfe2f BDEL, including all oriented edge references.');
      if (expected.error) {
        assert.equal(output.error, expected.error);
        const recovered = await extract(geometryFixtures.find(item => item.name === 'fcc-pbc-7'), 1, { capture: false });
        assert.equal(recovered.scienceHash, frozen.fixtures['fcc-pbc-7'].scienceHash,
          'Rejected thin geometry leaves the retained heap ready for a correct full extraction.');
      } else {
        assert.equal(output.error, undefined);
        assert.equal(output.scientificInputSha256, expected.scientificInputSha256);
        assert.equal(output.scienceHash, expected.scienceHash, 'Full scientific JSON matches the archived baseline.');
      }
    }
  });
}

test('global geometry oracle rejects malformed adjacency, vertex ownership and non-Delaunay coordinates', async () => {
  const { snapshot } = await extract(geometryFixtures[0], 1);
  const finite = Array.from({ length: snapshot.tetrahedra.length / 16 }, (_, cell) => cell)
    .find(cell => snapshot.tetrahedra[cell * 16 + 14]);
  const badNeighbor = { vertices: snapshot.vertices, tetrahedra: snapshot.tetrahedra.slice() };
  badNeighbor.tetrahedra[finite * 16 + 4] = 0xffffffff;
  assert.throws(() => validateDxaGeometry(badNeighbor), /invalid neighbor/);
  const duplicateVertex = { vertices: snapshot.vertices, tetrahedra: snapshot.tetrahedra.slice() };
  duplicateVertex.tetrahedra[finite * 16 + 1] = duplicateVertex.tetrahedra[finite * 16];
  assert.throws(() => validateDxaGeometry(duplicateVertex), /repeats a vertex/);
  const duplicateNeighbor = { vertices: snapshot.vertices, tetrahedra: snapshot.tetrahedra.slice() };
  duplicateNeighbor.tetrahedra[finite * 16 + 5] = duplicateNeighbor.tetrahedra[finite * 16 + 4];
  assert.throws(() => validateDxaGeometry(duplicateNeighbor), /repeats a neighbor|not uniquely reciprocal/);
  const wrongFace = { vertices: snapshot.vertices, tetrahedra: snapshot.tetrahedra.slice() };
  [wrongFace.tetrahedra[finite * 16 + 4], wrongFace.tetrahedra[finite * 16 + 5]] =
    [wrongFace.tetrahedra[finite * 16 + 5], wrongFace.tetrahedra[finite * 16 + 4]];
  assert.throws(() => validateDxaGeometry(wrongFace), /shared face/);
  const invertedCell = { vertices: snapshot.vertices, tetrahedra: snapshot.tetrahedra.slice() };
  [invertedCell.tetrahedra[finite * 16], invertedCell.tetrahedra[finite * 16 + 1]] =
    [invertedCell.tetrahedra[finite * 16 + 1], invertedCell.tetrahedra[finite * 16]];
  [invertedCell.tetrahedra[finite * 16 + 4], invertedCell.tetrahedra[finite * 16 + 5]] =
    [invertedCell.tetrahedra[finite * 16 + 5], invertedCell.tetrahedra[finite * 16 + 4]];
  assert.throws(() => validateDxaGeometry(invertedCell), /orientation/);
  const changedGeometry = { vertices: snapshot.vertices.slice(), tetrahedra: snapshot.tetrahedra };
  const row = snapshot.tetrahedra.subarray(finite * 16, finite * 16 + 4);
  changedGeometry.vertices.set(changedGeometry.vertices.subarray(row[0] * 3, row[0] * 3 + 3), row[1] * 3);
  assert.throws(() => validateDxaGeometry(changedGeometry), /zero volume|orientation|empty-sphere/);
  const anisotropic = { vertices: snapshot.vertices.slice(), tetrahedra: snapshot.tetrahedra };
  for (let coordinate = 0; coordinate < anisotropic.vertices.length; coordinate += 3) anisotropic.vertices[coordinate] *= 8;
  assert.throws(() => validateDxaGeometry(anisotropic), /empty-sphere/,
    'An exact power-of-two affine stretch preserves orientation but can invalidate Euclidean Delaunay.');
  const overlap = { vertices: snapshot.vertices.slice(), tetrahedra: snapshot.tetrahedra };
  const face = [0, 1, 2, 3].find(index => {
    const neighbor = snapshot.tetrahedra[finite * 16 + 4 + index];
    return neighbor > finite && snapshot.tetrahedra[neighbor * 16 + 14];
  });
  const neighbor = snapshot.tetrahedra[finite * 16 + 4 + face];
  const opposite = Array.from(snapshot.tetrahedra.subarray(neighbor * 16 + 4, neighbor * 16 + 8)).indexOf(finite);
  const otherVertex = snapshot.tetrahedra[neighbor * 16 + opposite], currentVertex = row[face];
  overlap.vertices.set(snapshot.vertices.subarray(currentVertex * 3, currentVertex * 3 + 3), otherVertex * 3);
  assert.throws(() => validateDxaGeometry(overlap), /same side|zero volume|orientation|empty-sphere/);
  const cells = snapshot.tetrahedra.length / 16, duplicated = new Uint32Array(snapshot.tetrahedra.length * 2);
  duplicated.set(snapshot.tetrahedra); duplicated.set(snapshot.tetrahedra, snapshot.tetrahedra.length);
  for (let cell = cells; cell < cells * 2; cell++) for (let face = 0; face < 4; face++) duplicated[cell * 16 + 4 + face] += cells;
  assert.throws(() => validateDxaGeometry({ vertices: snapshot.vertices, tetrahedra: duplicated }, { maxEmptySpherePairs: 0 }), /duplicates an existing/,
    'A disconnected duplicate tessellation cannot pass only local adjacency predicates.');
});

test('true PDEL cancellation at existing stage boundaries recovers in the same heap', async () => {
  const fixture = geometryFixtures.find(item => item.name === 'fcc-pbc-7');
  await ready;
  const initialHeap = kernel.HEAPU8.buffer, cancelPointer = kernel._alloy_dxa_cancel_ptr();
  for (const phase of ['Periodic Delaunay tessellation', 'Construct crystal interface mesh', 'Trace Burgers circuits and dislocation lines']) {
    cancelPhase = phase; cancellationReached = false;
    try {
      const aborted = await extract(fixture, 4, { capture: false });
      assert.ok(cancellationReached, phase);
      assert.match(aborted.error, /cancel/i);
    } finally { cancelPhase = null; }
    const recovered = await extract(fixture, 1, { capture: false });
    assert.equal(recovered.scienceHash, frozen.fixtures[fixture.name].scienceHash);
    assert.equal(kernel._alloy_dxa_cancel_ptr(), cancelPointer);
    // The shared-memory object can grow, but this small fixture needs no new
    // capacity after the first run. No module/pool replacement occurs.
    assert.equal(kernel.HEAPU8.buffer, initialHeap);
  }
});

test('short trajectory recomputes translated, deformed, changed-cell and vacancy geometry in one retained kernel', async () => {
  const fixtures = dxaGlobalTrajectoryFixtures();
  let initial;
  for (const threads of [1, 4, 1]) {
    for (const fixture of fixtures) {
      const output = await extract(fixture, threads), expected = frozen.fixtures[fixture.name];
      assert.equal(output.error, undefined);
      assert.equal(output.scientificInputSha256, expected.scientificInputSha256);
      assert.equal(output.scienceHash, expected.scienceHash, 'Complete labels and network reflect this frame and its cell.');
      if (threads === 1) assert.equal(output.snapshotHash, expected.snapshotHash, 'Recompute complete old-BDEL geometry, including the vacancy event.');
      // Other small fixtures exhaustively check all exact spheres. Here retain
      // full adjacency/orientation checks and a bounded additional sphere audit.
      validateDxaGeometry(output.snapshot, { maxEmptySpherePairs: 32 });
      if (!initial) initial = output.scienceHash;
      if (fixture.name === 'trajectory-return') assert.equal(output.scienceHash, initial);
    }
  }
  assert.notEqual(frozen.fixtures['trajectory-initial'].snapshotHash, frozen.fixtures['trajectory-translated'].snapshotHash);
  assert.notEqual(frozen.fixtures['trajectory-perturbed'].snapshotHash, frozen.fixtures['trajectory-cell'].snapshotHash);
  assert.notEqual(frozen.fixtures['trajectory-cell'].scienceHash, frozen.fixtures['trajectory-vacancy'].scienceHash);
});
