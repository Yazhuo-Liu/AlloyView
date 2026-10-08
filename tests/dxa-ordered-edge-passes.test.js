import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import createDxa from '../src/analysis/dxa-kernel-threaded.mjs';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { parseLammpsFrame } from '../src/io/lammps-dump.js';
import { fccScrewFrame } from './helpers/dislocations.js';
import { createCell } from '../src/data/model.js';

// Keep all Delaunay insertion and tracing serial in both runs. Only the two
// edge passes run concurrently, so complete exact equality is meaningful and
// does not admit the pre-existing parallel Delaunay representative changes.
let module, parallelEdges = false;
const ready = createDxa({
  wasmBinary: await readFile(new URL('../src/analysis/dxa-kernel-threaded.wasm', import.meta.url)),
  dxaPoolSize: 3,
  onDxaProgress(phase) {
    module._alloy_dxa_set_threads(parallelEdges &&
      (phase === 'Build tessellation edges' || phase === 'Map edges to the ideal lattice') ? 4 : 1);
  },
}).then(value => { module = value; return value; });
after(async () => { (await ready).PThread.terminateAllThreads(); });

async function extract(frame, lattice, parallel) {
  const kernel = await ready;
  parallelEdges = parallel;
  kernel._alloy_dxa_set_threads(1);
  kernel._alloy_dxa_reset_cancel();
  const xyz = dxaCartesianCoordinates(frame);
  const positions = kernel._malloc(xyz.byteLength), cell = kernel._malloc(12 * 8);
  assert.ok(positions && cell);
  kernel.HEAPF64.set(xyz, positions / 8);
  kernel.HEAPF64.set(frame.cell.vectors, cell / 8);
  kernel.HEAPF64.set(frame.cell.origin, cell / 8 + 9);
  try {
    const pointer = kernel._alloy_dxa_analyze(positions, xyz.length / 3, cell,
      frame.cell.pbc.reduce((bits, enabled, axis) => bits | (enabled ? 1 << axis : 0), 0),
      lattice, 14, 9, 0, 1, 2.5);
    assert.ok(pointer, kernel.UTF8ToString(kernel._alloy_dxa_last_error()));
    return JSON.parse(kernel.UTF8ToString(pointer));
  } finally {
    kernel._alloy_dxa_dispose();
    kernel._free(positions); kernel._free(cell);
  }
}

// Reversing ABC stacking creates FCC twins separated by HCP layers. Several
// reference frames exercise cluster transitions rather than only one bulk
// cluster, while remaining small enough for the regular unit suite.
function twinnedFrame() {
  const side = 16, layers = [0, 1, 2, 0, 1, 2, 0, 2, 1, 0, 2, 1];
  const a = 3.52, spacing = a / Math.SQRT2;
  const fractional = new Float64Array(side * side * layers.length * 3);
  let cursor = 0;
  for(let layer = 0; layer < layers.length; ++layer)
    for(let x = 0; x < side; ++x) for(let y = 0; y < side; ++y) {
      const shift = layers[layer] / 3;
      fractional[cursor++] = (x + shift) / side;
      fractional[cursor++] = (y + shift) / side;
      fractional[cursor++] = layer / layers.length;
    }
  return { fractional, cell: createCell({ vectors: [side * spacing, 0, 0,
    side * spacing / 2, side * spacing * Math.sqrt(3) / 2, 0,
    0, 0, layers.length * a / Math.sqrt(3)], pbc: [true, true, true] }) };
}

for (const [name, fixture, lattice] of [
  ['FCC twins', twinnedFrame, 1],
  ['FCC screw', () => fccScrewFrame(), 1],
  ['Fe loop', async () => parseLammpsFrame(await readFile(new URL('../examples/Fe_disloc_loop.dump', import.meta.url), 'utf8')), 3],
]) {
  test(`ordered parallel edge passes retain every ${name} vector, point, junction and atom label`, async () => {
    const frame = await fixture();
    const serial = await extract(frame, lattice, false);
    const parallel = await extract(frame, lattice, true);
    if(name === 'FCC twins') {
      assert.ok(serial.atomStructureTypes.includes(1), 'The twin grains remain FCC.');
      assert.ok(serial.atomStructureTypes.includes(2), 'Twin-boundary layers expose HCP reference frames.');
    }
    assert.ok(parallel.parallelEdgePasses.candidateCells > 2048);
    assert.ok(parallel.parallelEdgePasses.pathSearchEdges > 0);
    assert.ok(parallel.parallelEdgePasses.directPathEdges > 2048, 'Cheap direct bulk edges bypass staging.');
    if(name !== 'Fe loop') assert.ok(parallel.parallelEdgePasses.pathSearchEdges > 2048,
      'The defective/twinned fixture actually reaches the concurrent search threshold.');
    assert.ok(parallel.parallelEdgePasses.pathSearchBatches >= 1);
    assert.ok(parallel.parallelEdgePasses.deferredPathEdges <= parallel.parallelEdgePasses.pathSearchEdges);
    assert.equal(serial.parallelEdgePasses.pathSearchEdges, 0);
    const { parallelEdgePasses: beforeCounters, ...before } = serial;
    const { parallelEdgePasses: afterCounters, ...after } = parallel;
    assert.deepEqual(after, before, 'The complete network and labels are exact on the same serial topology.');
    const recovered = await extract(frame, lattice, false);
    assert.deepEqual(recovered, serial, 'Reusing scratch and heap does not leak parallel state into a later frame.');
  });
}
