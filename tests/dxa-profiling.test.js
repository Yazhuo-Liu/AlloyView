import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { crystalFrame } from './helpers/crystals.js';

for (const suffix of ['', '-threaded']) {
  test(`DXA${suffix} profiling is optional, preserves output and resets after cancellation`, async () => {
    const { default: createDxa } = await import(`../src/analysis/dxa-kernel${suffix}.mjs`);
    let kernel, cancelMesh = false;
    const snapshots = [];
    kernel = await createDxa({
      wasmBinary: await readFile(new URL(`../src/analysis/dxa-kernel${suffix}.wasm`, import.meta.url)),
      dxaPoolSize: 0, onDxaProgress(phase) {
        if (cancelMesh && phase === 'Construct crystal interface mesh')
          Atomics.store(kernel.HEAP32, kernel._alloy_dxa_cancel_ptr() / 4, 1);
      },
    });
    const frame = crystalFrame('fcc', 4), xyz = dxaCartesianCoordinates(frame);
    const positions = kernel._malloc(xyz.byteLength), cell = kernel._malloc(96);
    assert.ok(positions && cell);
    kernel.HEAPF64.set(xyz, positions / 8); kernel.HEAPF64.set(frame.cell.vectors, cell / 8);
    kernel.HEAPF64.set(frame.cell.origin, cell / 8 + 9);
    const run = () => {
      kernel._alloy_dxa_reset_cancel(); kernel._alloy_dxa_set_threads(1);
      const pointer = kernel._alloy_dxa_analyze(positions, xyz.length / 3, cell, 7, 1, 14, 9, 0, 1, 2.5);
      if (!pointer) return null;
      const result = JSON.parse(kernel.UTF8ToString(pointer));
      kernel._alloy_dxa_dispose();
      return result;
    };
    try {
      const ordinary = run();
      assert.ok(ordinary);
      kernel.onDxaProfile = value => snapshots.push(value);
      assert.deepEqual(run(), ordinary, 'Diagnostics do not add fields or alter scientific or existing work-counter output.');
      assert.equal(snapshots.length, 1);
      const first = snapshots[0];
      assert.equal(first.overflow, false);
      for (const key of ['delaunay.inputPoints', 'delaunay.ghostPoints', 'delaunay.construct', 'mesh.classification'])
        assert.ok(Number.isFinite(first.timingsMs[key]) && first.timingsMs[key] >= 0, key);
      assert.equal(first.counters['delaunay.primaryPoints'], xyz.length / 3);
      assert.ok(first.counters['delaunay.totalCells'] > 0);
      assert.ok(first.counters['edges.retained_bytes'] > 0);
      cancelMesh = true;
      assert.equal(run(), null);
      assert.match(kernel.UTF8ToString(kernel._alloy_dxa_last_error()), /cancel/i);
      assert.equal(snapshots.length, 1, 'A failed extraction does not publish a partial success profile.');
      cancelMesh = false;
      assert.deepEqual(run(), ordinary);
      assert.equal(snapshots.length, 2);
      assert.deepEqual(snapshots[1].counters, first.counters, 'The new session does not accumulate the canceled session counters.');
      kernel.onDxaProfile = null;
      assert.deepEqual(run(), ordinary);
      assert.equal(snapshots.length, 2, 'Removing the callback disables diagnostics on the retained module.');
    } finally {
      kernel._alloy_dxa_dispose(); kernel._free(positions); kernel._free(cell);
      kernel.PThread?.terminateAllThreads();
    }
  });
}
