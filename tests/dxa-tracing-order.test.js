import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { fccScrewFrame } from './helpers/dislocations.js';

// Recorded from adb0648's production kernels before caching immutable tracing
// state. Hash the complete native result, not just labels/line totals.
const expected = '9c26dd440ec0815c685bc4595fe6a13bc3dcf14218ee23d3ca485c76bf35cb59';
for (const suffix of ['', '-threaded']) {
  test(`DXA${suffix} preserves full tracing order at depth limits and reuses its heap after cancellation`, async () => {
    const { default: createDxa } = await import(`../src/analysis/dxa-kernel${suffix}.mjs`);
    let kernel, cancelTracing = false;
    kernel = await createDxa({ wasmBinary: await readFile(new URL(`../src/analysis/dxa-kernel${suffix}.wasm`, import.meta.url)),
      dxaPoolSize: 0, onDxaProgress(phase) {
        if (cancelTracing && phase === 'Trace Burgers circuits and dislocation lines') {
          Atomics.store(kernel.HEAP32, kernel._alloy_dxa_cancel_ptr() / 4, 1);
        }
      } });
    kernel._alloy_dxa_set_threads(1);
    const frame = fccScrewFrame({ nx: 16, ny: 14, nz: 6 }), xyz = dxaCartesianCoordinates(frame);
    const positions = kernel._malloc(xyz.byteLength), cell = kernel._malloc(96);
    kernel.HEAPF64.set(xyz, positions / 8); kernel.HEAPF64.set(frame.cell.vectors, cell / 8);
    kernel.HEAPF64.set(frame.cell.origin, cell / 8 + 9);
    const extract = circuit => {
      kernel._alloy_dxa_reset_cancel();
      return kernel._alloy_dxa_analyze(positions, xyz.length / 3, cell, 4, 1, circuit, 9, 0, 1, 2.5);
    };
    const check = pointer => {
      assert.ok(pointer, kernel.UTF8ToString(kernel._alloy_dxa_last_error()));
      const result = JSON.parse(kernel.UTF8ToString(pointer)); delete result.parallelEdgePasses;
      assert.equal(result.segments.length, 1);
      assert.equal(createHash('sha256').update(JSON.stringify(result)).digest('hex'), expected);
      kernel._alloy_dxa_dispose();
    };
    try {
      for (const circuit of [3, 7, 14]) check(extract(circuit));
      cancelTracing = true;
      assert.equal(extract(14), 0, 'cancellation still aborts the native tracer');
      assert.match(kernel.UTF8ToString(kernel._alloy_dxa_last_error()), /cancel/i);
      cancelTracing = false;
      check(extract(14));
    } finally {
      kernel._alloy_dxa_dispose(); kernel._free(positions); kernel._free(cell);
      kernel.PThread?.terminateAllThreads();
    }
  });
}
