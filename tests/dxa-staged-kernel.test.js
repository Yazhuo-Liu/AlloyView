import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import createDxa from '../src/analysis/dxa-kernel.mjs';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { crystalFrame } from './helpers/crystals.js';
import { fccScrewFrame } from './helpers/dislocations.js';

const modulePromise = createDxa({ wasmBinary: await readFile(new URL('../src/analysis/dxa-kernel.wasm', import.meta.url)) });
const EXPORT_BUDGET = 256 * 1024 ** 2;

async function withFrame(frame, run, lattice = 1) {
  const module = await modulePromise;
  module._alloy_dxa_reset_cancel();
  const positions = dxaCartesianCoordinates(frame);
  const coordinates = module._malloc(positions.byteLength), cellPointer = module._malloc(12 * 8);
  assert.ok(coordinates && cellPointer);
  module.HEAPF64.set(positions, coordinates / 8);
  module.HEAPF64.set(frame.cell.vectors, cellPointer / 8);
  module.HEAPF64.set(frame.cell.origin, cellPointer / 8 + 9);
  const args = [coordinates, positions.length / 3, cellPointer,
    frame.cell.pbc.reduce((bits, value, axis) => bits | (value ? 1 << axis : 0), 0),
    lattice, 14, 9, 0, 1, 2.5];
  const error = () => module.UTF8ToString(module._alloy_dxa_last_error());
  const begin = () => assert.equal(module._alloy_dxa_begin(...args), 1, error());
  const result = (regionsPointer = 0, count = 0) => {
    const pointer = module._alloy_dxa_finish(regionsPointer, count);
    assert.ok(pointer, error());
    return JSON.parse(module.UTF8ToString(pointer));
  };
  try { await run({ module, begin, result, error }); }
  finally {
    module._alloy_dxa_dispose();
    module._alloy_dxa_dispose();
    module._free(coordinates);
    module._free(cellPointer);
    module._alloy_dxa_reset_cancel();
  }
}

test('staged DXA rejects export before allocation and finishes the retained topology on CPU', async () => {
  await withFrame(crystalFrame('fcc', 4), ({ module, begin, result, error }) => {
    begin();
    const tets = module._alloy_dxa_tet_count();
    assert.ok(tets > 0);
    assert.ok(module._alloy_dxa_snapshot_bytes() > 0);
    assert.equal(module._alloy_dxa_vertex_ptr(), 0);
    assert.equal(module._alloy_dxa_export(1), 0);
    assert.match(error(), /export memory budget/);
    assert.equal(module._alloy_dxa_tet_count(), tets, 'failed export retains the prepared geometry');
    assert.equal(module._alloy_dxa_vertex_ptr(), 0, 'failed export retains no partially allocated snapshot');
    const output = result();
    assert.equal(output.segments.length, 0);
    assert.ok(output.atomStructureTypes.every(value => value === 1));
  });
});

test('staged region injection retains the exact original screw-dislocation network', async () => {
  await withFrame(fccScrewFrame(), ({ module, begin, result, error }) => {
    begin();
    const original = result();
    assert.equal(original.segments.length, 1);
    module._alloy_dxa_dispose();
    begin();
    const counts = [module._alloy_dxa_vertex_count(), module._alloy_dxa_tet_count(),
      module._alloy_dxa_edge_count(), module._alloy_dxa_transition_count()];
    assert.equal(module._alloy_dxa_export(EXPORT_BUDGET), 1, error());
    assert.deepEqual([module._alloy_dxa_vertex_count(), module._alloy_dxa_tet_count(),
      module._alloy_dxa_edge_count(), module._alloy_dxa_transition_count()], counts);
    const pointers = [module._alloy_dxa_vertex_ptr(), module._alloy_dxa_tet_ptr(),
      module._alloy_dxa_edge_ptr(), module._alloy_dxa_transition_ptr()];
    assert.ok(pointers.every(Boolean));
    assert.ok(module._alloy_dxa_alpha() > 0);
    assert.equal(module.HEAPU32[module._alloy_dxa_edge_ptr() / 4 + 6], 0xffffffff,
      'edge zero is the unmapped sentinel');
    assert.equal(module.HEAPF64[module._alloy_dxa_transition_ptr() / 8 + 18], 1,
      'the common identity transition preserves exact self bypass');
    const regions = module._alloy_dxa_cpu_regions_ptr();
    assert.ok(regions, error());
    assert.ok(module.HEAP32.subarray(regions / 4, regions / 4 + counts[1]).every(value => value === -1 || value === 0));
    // Native expected-region allocation can grow the heap; getters resolve the
    // current views, and unchanged snapshot pointers remain valid.
    assert.deepEqual([module._alloy_dxa_vertex_ptr(), module._alloy_dxa_tet_ptr(),
      module._alloy_dxa_edge_ptr(), module._alloy_dxa_transition_ptr()], pointers);
    module._alloy_dxa_release_snapshot();
    module._alloy_dxa_release_snapshot();
    assert.equal(module._alloy_dxa_vertex_ptr(), 0);
    assert.equal(module._alloy_dxa_tet_count(), counts[1], 'snapshot release retains the original geometry');
    assert.equal(module._alloy_dxa_cpu_regions_ptr(), regions, 'labels have independent lifetime');
    const injected = result(regions, counts[1]);
    assert.deepEqual(injected, original);
    assert.equal(module._alloy_dxa_vertex_ptr(), 0);
    module._alloy_dxa_dispose();
    assert.equal(module._alloy_dxa_tet_count(), 0);
    assert.equal(module._alloy_dxa_vertex_ptr(), 0);
  });
});

test('invalid staged region labels dispose only the frame workspace and allow kernel recovery', async () => {
  await withFrame(crystalFrame('bcc', 4), ({ module, begin, result, error }) => {
    begin();
    const count = module._alloy_dxa_tet_count(), labels = module._malloc(count * 4);
    try {
      module.HEAP32.fill(-1, labels / 4, labels / 4 + count);
      module.HEAP32[labels / 4] = 2;
      assert.equal(module._alloy_dxa_finish(labels, count), 0);
      assert.match(error(), /invalid region labels/);
      assert.equal(module._alloy_dxa_tet_count(), 0);
      begin();
      assert.ok(result().atomStructureTypes.every(value => value === 3));
    } finally { module._free(labels); }
  }, 3);
});

test('staged cancellation frees its retained frame and recovers without replacing Wasm', async () => {
  await withFrame(crystalFrame('hcp', 4), ({ module, begin, result, error }) => {
    begin();
    module.HEAP32[module._alloy_dxa_cancel_ptr() / 4] = 1;
    assert.equal(module._alloy_dxa_finish(0, 0), 0);
    assert.match(error(), /canceled/);
    assert.equal(module._alloy_dxa_tet_count(), 0);
    module._alloy_dxa_reset_cancel();
    begin();
    assert.ok(result().atomStructureTypes.every(value => value === 2));
  }, 2);
});
