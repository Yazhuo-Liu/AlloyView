import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import createDxa from '../src/analysis/dxa-kernel.mjs';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { crystalFrame } from './helpers/crystals.js';
import { fccScrewFrame } from './helpers/dislocations.js';

const modulePromise = createDxa({ wasmBinary: await readFile(new URL('../src/analysis/dxa-kernel.wasm', import.meta.url)) });

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
  const readResult = pointer => {
    assert.ok(pointer, error());
    return JSON.parse(module.UTF8ToString(pointer));
  };
  const result = () => readResult(module._alloy_dxa_finish());
  const complete = () => readResult(module._alloy_dxa_analyze(...args));
  try { await run({ module, args, coordinates, cellPointer, begin, result, complete, error }); }
  finally {
    module._alloy_dxa_dispose();
    module._free(coordinates);
    module._free(cellPointer);
    module._alloy_dxa_reset_cancel();
  }
}

test('staged CPU DXA preserves the complete entry point’s screw-dislocation network', async () => {
  await withFrame(fccScrewFrame(), ({ module, begin, result, complete }) => {
    const original = complete();
    assert.equal(original.segments.length, 1);
    begin();
    const staged = result();
    assert.deepEqual(staged, original);
    module._alloy_dxa_dispose();
    // A fresh frame can reuse the same kernel after the staged workspace ends.
    begin();
    assert.deepEqual(result(), original);
  });
});

test('legacy CPU analyze releases its native session while its JSON remains readable until caller disposal', async () => {
  await withFrame(crystalFrame('bcc', 4), ({ module, args, begin, result, error }) => {
    const pointer = module._alloy_dxa_analyze(...args);
    assert.ok(pointer, error());
    // This getter observes session ownership without beginning another
    // calculation or invalidating the module-owned return string.
    assert.equal(module._alloy_dxa_worker_tet_count(), 0);
    const original = JSON.parse(module.UTF8ToString(pointer));
    assert.ok(original.atomStructureTypes.every(type => type === 3));
    module._alloy_dxa_dispose();
    module._alloy_dxa_dispose();
    assert.equal(module._alloy_dxa_worker_vertex_ptr(), 0);
    begin();
    assert.deepEqual(result(), original);
    module._alloy_dxa_dispose();
    const nextPointer = module._alloy_dxa_analyze(...args);
    assert.ok(nextPointer, error());
    assert.deepEqual(JSON.parse(module.UTF8ToString(nextPointer)), original);
  }, 3);
});

test('staged CPU workspace can be disposed before tracing and then reused', async () => {
  await withFrame(crystalFrame('bcc', 4), ({ module, begin, result, complete, error }) => {
    assert.equal(module._alloy_dxa_finish(), 0);
    assert.match(error(), /no active staged analysis/);
    begin();
    module._alloy_dxa_dispose();
    module._alloy_dxa_dispose();
    assert.equal(module._alloy_dxa_finish(), 0);
    assert.match(error(), /no active staged analysis/);
    begin();
    const output = result();
    assert.equal(output.segments.length, 0);
    assert.ok(output.atomStructureTypes.every(value => value === 3));
    assert.deepEqual(complete(), output);
  }, 3);
});

test('failed staged CPU input clears the old workspace and permits a corrected frame', async () => {
  await withFrame(crystalFrame('fcc', 4), ({ module, args, coordinates, cellPointer, begin, result, error }) => {
    begin();
    const originalPosition = module.HEAPF64[coordinates / 8];
    module.HEAPF64[coordinates / 8] = NaN;
    assert.equal(module._alloy_dxa_begin(...args), 0);
    assert.match(error(), /coordinates must be finite/);
    module.HEAPF64[coordinates / 8] = originalPosition;
    assert.equal(module._alloy_dxa_finish(), 0);
    assert.match(error(), /no active staged analysis/);
    const originalCell = module.HEAPF64.slice(cellPointer / 8, cellPointer / 8 + 12);
    module.HEAPF64.fill(0, cellPointer / 8, cellPointer / 8 + 9);
    assert.equal(module._alloy_dxa_begin(...args), 0);
    assert.match(error(), /non-singular/);
    module.HEAPF64.set(originalCell, cellPointer / 8);
    begin();
    assert.ok(result().atomStructureTypes.every(value => value === 1));
  });
});

test('cancellation between CPU stages releases the frame and recovers in the same Wasm kernel', async () => {
  await withFrame(crystalFrame('hcp', 4), ({ module, begin, result, error }) => {
    begin();
    module.HEAP32[module._alloy_dxa_cancel_ptr() / 4] = 1;
    assert.equal(module._alloy_dxa_finish(), 0);
    assert.match(error(), /canceled/);
    module._alloy_dxa_reset_cancel();
    assert.equal(module._alloy_dxa_finish(), 0);
    assert.match(error(), /no active staged analysis/);
    begin();
    assert.ok(result().atomStructureTypes.every(value => value === 2));
  }, 2);
});
