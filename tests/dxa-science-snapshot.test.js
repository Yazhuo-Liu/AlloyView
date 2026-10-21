import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { crystalFrame } from './helpers/crystals.js';
import { fccTwinsFrame } from './helpers/dxa-global-fixtures.js';

function checkGraph(snapshot, count) {
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.matrixLayout, 'row-major');
  assert.equal(snapshot.atomClusters.length, count);
  const clusters = new Map(snapshot.clusters.map(cluster => [cluster.id, cluster]));
  assert.equal(clusters.size, snapshot.clusters.length, 'Every cluster has one distinct ID.');
  assert.ok(clusters.has(0), 'The unassigned null cluster is explicit.');
  for (const id of snapshot.atomClusters) assert.ok(clusters.has(id), `Missing atom cluster ${id}`);
  const finiteMatrix = matrix => assert.ok(matrix.length === 9 && matrix.every(Number.isFinite));
  for (const cluster of clusters.values()) {
    finiteMatrix(cluster.orientation);
    assert.ok(Number.isInteger(cluster.structure));
    assert.ok(Number.isInteger(cluster.symmetryTransformation));
    assert.ok(cluster.centerOfMass.length === 3 && cluster.centerOfMass.every(Number.isFinite));
    if (cluster.id !== 0)
      assert.equal(snapshot.atomClusters.filter(id => id === cluster.id).length, cluster.atomCount);
    if (cluster.parentTransition) assert.equal(cluster.parentTransition.source, cluster.id);
  }
  for (const transition of snapshot.transitions) {
    assert.ok(clusters.has(transition.source) && clusters.has(transition.target));
    finiteMatrix(transition.matrix); finiteMatrix(transition.reverseMatrix);
    const reverse = snapshot.transitions.find(candidate => candidate.source === transition.target
      && candidate.target === transition.source && candidate.distance === transition.reverseDistance
      && candidate.area === transition.reverseArea
      && candidate.matrix.every((value, index) => Object.is(value, transition.reverseMatrix[index])));
    assert.ok(reverse, 'Every directed transition exports its reciprocal edge and transform.');
    for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
      const value = [0, 1, 2].reduce((sum, k) => sum
        + transition.matrix[row * 3 + k] * transition.reverseMatrix[k * 3 + column], 0);
      assert.ok(Math.abs(value - (row === column ? 1 : 0)) < 1e-9, 'Reciprocal matrices compose to identity.');
    }
  }
}

for (const suffix of ['', '-threaded']) for (const [name, fixture] of [
  ['perfect FCC', () => crystalFrame('fcc', 4)], ['FCC/HCP twins', fccTwinsFrame],
]) {
  test(`DXA${suffix} ${name} scientific readback is bounded, read-only and recoverable on the retained session`, async () => {
    const createDxa = (await import(`../src/analysis/dxa-kernel${suffix}.mjs`)).default;
    const kernel = await createDxa({
      wasmBinary: await readFile(new URL(`../src/analysis/dxa-kernel${suffix}.wasm`, import.meta.url)),
      dxaPoolSize: 0,
    });
    const frame = fixture(), xyz = dxaCartesianCoordinates(frame);
    const positions = kernel._malloc(xyz.byteLength), cell = kernel._malloc(96);
    assert.ok(positions && cell);
    kernel.HEAPF64.set(xyz, positions / 8); kernel.HEAPF64.set(frame.cell.vectors, cell / 8);
    kernel.HEAPF64.set(frame.cell.origin, cell / 8 + 9);
    const args = [positions, xyz.length / 3, cell, 7, 1, 14, 9, 0, 1, 2.5];
    const error = () => kernel.UTF8ToString(kernel._alloy_dxa_last_error());
    const read = (budget = 8 * 1024 ** 2) => {
      const pointer = kernel._alloy_dxa_science_snapshot(budget);
      assert.ok(pointer, error());
      return kernel.UTF8ToString(pointer);
    };
    try {
      kernel._alloy_dxa_reset_cancel(); kernel._alloy_dxa_set_threads(1);
      const ordinaryPointer = kernel._alloy_dxa_analyze(...args);
      assert.ok(ordinaryPointer, error());
      const ordinary = JSON.parse(kernel.UTF8ToString(ordinaryPointer));
      assert.equal(kernel._alloy_dxa_science_snapshot(1024), 0);
      assert.match(error(), /active mapped staged session/);
      assert.deepEqual(JSON.parse(kernel.UTF8ToString(ordinaryPointer)), ordinary,
        'A diagnostic error does not alter the existing scientific output.');
      assert.equal(kernel._alloy_dxa_begin(...args), 1, error());
      const transitionsBefore = kernel._alloy_dxa_worker_transition_count();
      const mappedText = read(), mapped = JSON.parse(mappedText);
      assert.equal(mapped.phase, 'mapped'); checkGraph(mapped, xyz.length / 3);
      if (name === 'FCC/HCP twins') {
        assert.ok(mapped.clusters.some(cluster => cluster.structure === 1));
        assert.ok(mapped.clusters.some(cluster => cluster.structure === 2));
        assert.ok(mapped.transitions.some(transition => !transition.self),
          'The complete twin graph exercises directed nonself transformations.');
      }
      assert.equal(kernel._alloy_dxa_worker_transition_count(), transitionsBefore,
        'Readback must not lazily create self or cached transitions.');
      assert.equal(read(mappedText.length + 1), mappedText, 'An exact-size output budget includes the NUL.');
      assert.equal(kernel._alloy_dxa_science_snapshot(mappedText.length), 0);
      assert.match(error(), /byte budget/);
      assert.equal(kernel._alloy_dxa_science_snapshot(0), 0);
      assert.match(error(), /positive output byte budget/);
      assert.ok(kernel._alloy_dxa_worker_tet_count() > 0, 'Budget failure retains the native topology.');
      kernel.HEAP32[kernel._alloy_dxa_cancel_ptr() / 4] = 1;
      assert.equal(kernel._alloy_dxa_science_snapshot(8 * 1024 ** 2), 0);
      assert.match(error(), /cancel/i);
      kernel._alloy_dxa_reset_cancel();
      assert.equal(read(), mappedText, 'Cancellation does not mutate or accumulate scientific state.');
      kernel._alloy_dxa_release_science_snapshot();
      assert.equal(read(), mappedText, 'Explicit release frees only optional readback storage.');
      const finishedPointer = kernel._alloy_dxa_finish();
      assert.ok(finishedPointer, error());
      assert.deepEqual(JSON.parse(kernel.UTF8ToString(finishedPointer)), ordinary);
      const finished = JSON.parse(read());
      assert.equal(finished.phase, 'finished'); checkGraph(finished, xyz.length / 3);
      assert.deepEqual(finished.atomClusters, mapped.atomClusters);
      assert.deepEqual(finished.clusters, mapped.clusters);
      assert.equal(kernel._alloy_dxa_science_snapshot(1), 0);
      assert.deepEqual(JSON.parse(kernel.UTF8ToString(finishedPointer)), ordinary,
        'Failed post-finish readback preserves the complete result string.');
      kernel._alloy_dxa_dispose();
      kernel._alloy_dxa_release_science_snapshot();
      assert.equal(kernel._alloy_dxa_science_snapshot(1024), 0);
      assert.equal(kernel._alloy_dxa_begin(...args), 1, error());
      assert.equal(read(), mappedText, 'A fresh session does not inherit a previous snapshot.');
    } finally {
      kernel._alloy_dxa_dispose(); kernel._alloy_dxa_reset_cancel();
      kernel._free(positions); kernel._free(cell); kernel.PThread?.terminateAllThreads();
    }
  });
}
