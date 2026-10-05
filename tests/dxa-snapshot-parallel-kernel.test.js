import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import createDxa from '../src/analysis/dxa-kernel-threaded.mjs';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { crystalFrame } from './helpers/crystals.js';
import { fccScrewFrame } from './helpers/dislocations.js';

const modulePromise = createDxa({ dxaPoolSize: 3,
  wasmBinary: await readFile(new URL('../src/analysis/dxa-kernel-threaded.wasm', import.meta.url)) });
const EXPORT_BUDGET = 256 * 1024 ** 2;
after(async () => (await modulePromise).PThread.terminateAllThreads());

async function withTopology(frame, lattice, run) {
  const module = await modulePromise;
  module._alloy_dxa_reset_cancel();
  module._alloy_dxa_set_threads(1);
  const positions = dxaCartesianCoordinates(frame);
  const coordinates = module._malloc(positions.byteLength), cellPointer = module._malloc(12 * 8);
  assert.ok(coordinates && cellPointer);
  module.HEAPF64.set(positions, coordinates / 8);
  module.HEAPF64.set(frame.cell.vectors, cellPointer / 8);
  module.HEAPF64.set(frame.cell.origin, cellPointer / 8 + 9);
  const error = () => module.UTF8ToString(module._alloy_dxa_last_error());
  const counts = () => [module._alloy_dxa_vertex_count(), module._alloy_dxa_tet_count(),
    module._alloy_dxa_edge_count(), module._alloy_dxa_transition_count()];
  try {
    assert.equal(module._alloy_dxa_begin(coordinates, positions.length / 3, cellPointer,
      frame.cell.pbc.reduce((bits, value, axis) => bits | (value ? 1 << axis : 0), 0),
      lattice, 14, 9, 0, 1, 2.5), 1, error());
    await run({ module, error, counts });
  } finally {
    module._alloy_dxa_dispose();
    module._free(coordinates);
    module._free(cellPointer);
    module._alloy_dxa_reset_cancel();
  }
}

function copySnapshot(module, counts) {
  // Compare packed bytes, including float signs and unmapped edge sentinels.
  // Every getter resolves against the current heap after possible growth.
  const pointers = [module._alloy_dxa_vertex_ptr(), module._alloy_dxa_tet_ptr(),
    module._alloy_dxa_edge_ptr(), module._alloy_dxa_transition_ptr()];
  assert.ok(pointers.every(Boolean));
  return pointers.map((pointer, index) => module.HEAPU8.slice(pointer,
    pointer + counts[index] * [24, 64, 32, 160][index]));
}

for (const [name, frame, lattice] of [
  ['FCC screw with free surfaces', fccScrewFrame(), 1],
  ['triclinic HCP', crystalFrame('hcp', 4), 2],
]) {
  test(`pthread DXA exports byte-identical immutable ${name} snapshots at 1, 2 and 4 threads`, async () => {
    await withTopology(frame, lattice, ({ module, error, counts }) => {
      const expectedCounts = counts();
      assert.ok(expectedCounts[1] >= 2048, 'exercise the parallel packing threshold');
      const controlPointer = module._alloy_dxa_cancel_ptr();
      let expected;
      for (const threads of [1, 2, 4, 1]) {
        module._alloy_dxa_set_threads(threads);
        assert.equal(module._alloy_dxa_export(EXPORT_BUDGET), 1, error());
        const snapshot = copySnapshot(module, expectedCounts);
        if (expected) assert.deepEqual(snapshot, expected);
        else expected = snapshot;
        assert.deepEqual(counts(), expectedCounts, 'export retains the original scientific topology');
        assert.equal(module._alloy_dxa_cancel_ptr(), controlPointer, 'reuse the same kernel and cancellation word');
        module._alloy_dxa_release_snapshot();
      }
      assert.equal(module._alloy_dxa_export(1), 0);
      assert.match(error(), /export memory budget/);
      assert.equal(module._alloy_dxa_vertex_ptr(), 0);
      assert.deepEqual(counts(), expectedCounts);
      module._alloy_dxa_set_threads(4);
      Atomics.store(module.HEAP32, controlPointer / 4, 1);
      assert.equal(module._alloy_dxa_export(EXPORT_BUDGET), 0);
      assert.match(error(), /canceled/);
      assert.equal(module._alloy_dxa_tet_ptr(), 0);
      assert.deepEqual(counts(), expectedCounts, 'canceled export keeps CPU fallback geometry');
      module._alloy_dxa_reset_cancel();
      assert.equal(module._alloy_dxa_export(EXPORT_BUDGET), 1, error());
      assert.deepEqual(copySnapshot(module, expectedCounts), expected, 'retry reuses the retained scientific session');
      const outputPointer = module._alloy_dxa_finish(0, 0);
      assert.ok(outputPointer, error());
      const result = JSON.parse(module.UTF8ToString(outputPointer));
      assert.equal(result.segments.length, name.startsWith('FCC') ? 1 : 0);
      assert.equal(module._alloy_dxa_tet_ptr(), 0, 'finishing releases snapshot duplicates');
    });
  });
}
