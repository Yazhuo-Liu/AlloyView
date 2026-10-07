import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import createDxa from '../src/analysis/dxa-kernel.mjs';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';
import { fccScrewFrame } from './helpers/dislocations.js';

const modulePromise = createDxa({ wasmBinary: await readFile(new URL('../src/analysis/dxa-kernel.wasm', import.meta.url)) });

async function withFrame(frame, lattice, run, perfectOnly = 0) {
  const module = await modulePromise;
  module._alloy_dxa_reset_cancel();
  const positions = dxaCartesianCoordinates(frame);
  const count = positions.length / 3;
  const coordinates = module._malloc(positions.byteLength);
  const cellPointer = module._malloc(12 * 8);
  const allocated = [coordinates, cellPointer];
  assert.ok(coordinates && cellPointer);
  module.HEAPF64.set(positions, coordinates / 8);
  module.HEAPF64.set(frame.cell.vectors, cellPointer / 8);
  module.HEAPF64.set(frame.cell.origin, cellPointer / 8 + 9);
  const pbcBits = frame.cell.pbc.reduce((bits, periodic, axis) => bits | (periodic ? 1 << axis : 0), 0);
  const args = [coordinates, count, cellPointer, pbcBits, lattice, 14, 9, perfectOnly, 1, 2.5];
  const localArgs = [coordinates, count, cellPointer, pbcBits, lattice, perfectOnly];
  const error = () => module.UTF8ToString(module._alloy_dxa_last_error());
  const localError = () => module.UTF8ToString(module._alloy_dxa_local_error());
  const prepareLocal = () => assert.equal(module._alloy_dxa_local_prepare(...localArgs), 1, localError());
  const identify = (start, end) => {
    assert.equal(module._alloy_dxa_local_identify(start, end), 1, localError());
    const width = module._alloy_dxa_local_neighbor_width();
    const structuresPointer = module._alloy_dxa_local_structures_ptr();
    const neighborsPointer = module._alloy_dxa_local_neighbors_ptr();
    assert.ok(structuresPointer && neighborsPointer);
    return {
      structures: module.HEAP32.slice(structuresPointer / 4 + start, structuresPointer / 4 + end),
      neighbors: module.HEAP32.slice(neighborsPointer / 4 + start * width, neighborsPointer / 4 + end * width),
      width, maxDistance: module._alloy_dxa_local_max_distance(),
    };
  };
  const mergeRanges = (ranges) => {
    prepareLocal();
    const width = module._alloy_dxa_local_neighbor_width();
    const structures = new Int32Array(count), neighbors = new Int32Array(count * width);
    let maxDistance = 0;
    for (const [start, end] of ranges) {
      const result = identify(start, end);
      structures.set(result.structures, start);
      neighbors.set(result.neighbors, start * width);
      maxDistance = Math.max(maxDistance, result.maxDistance);
    }
    return { structures, neighbors, width, maxDistance };
  };
  const unevenRanges = () => {
    const a = 1, b = Math.floor(count / 3), c = Math.floor(count * 2 / 3) + 1;
    return [[b, c], [0, a], [c, count], [a, b]];
  };
  const readResult = pointer => {
    assert.ok(pointer, error());
    return JSON.parse(module.UTF8ToString(pointer));
  };
  const complete = () => readResult(module._alloy_dxa_analyze(...args));
  const allocateResults = result => {
    const structuresPointer = module._malloc(result.structures.byteLength);
    const neighborsPointer = module._malloc(result.neighbors.byteLength);
    allocated.push(structuresPointer, neighborsPointer);
    assert.ok(structuresPointer && neighborsPointer);
    module.HEAP32.set(result.structures, structuresPointer / 4);
    module.HEAP32.set(result.neighbors, neighborsPointer / 4);
    return [structuresPointer, neighborsPointer, count, result.width, result.maxDistance];
  };
  const imported = result => {
    const importArgs = allocateResults(result);
    assert.equal(module._alloy_dxa_prepare(...args), 1, error());
    assert.equal(module._alloy_dxa_import_local(...importArgs), 1, error());
    return readResult(module._alloy_dxa_finish());
  };
  try {
    await run({ module, count, args, localArgs, coordinates, cellPointer, prepareLocal, identify,
      mergeRanges, unevenRanges, complete, imported, allocateResults, error, localError });
  } finally {
    module._alloy_dxa_local_dispose();
    module._alloy_dxa_dispose();
    for (const pointer of allocated) module._free(pointer);
    module._alloy_dxa_reset_cancel();
  }
}

for (const [kind, lattice, width] of [['fcc', 1, 12], ['hcp', 2, 12], ['bcc', 3, 14],
  ['diamond', 4, 16], ['hex-diamond', 5, 16]]) {
  for (const perfectOnly of [0, 1]) {
    test(`original CPU ${kind} recognition preserves ordered local rows across uneven ranges (perfectOnly=${perfectOnly})`, async () => {
      await withFrame(crystalFrame(kind, 4), lattice, ({ count, prepareLocal, identify, mergeRanges, unevenRanges, complete, imported }) => {
        prepareLocal();
        const whole = identify(0, count);
        assert.equal(whole.width, width);
        assert.ok(whole.structures.every(type => type === lattice));
        assert.ok(whole.maxDistance > 0);
        const split = mergeRanges(unevenRanges());
        assert.deepEqual(split, whole);
        const repeated = identify(1, count - 1);
        assert.deepEqual(repeated.structures, whole.structures.slice(1, count - 1));
        assert.deepEqual(repeated.neighbors, whole.neighbors.slice(width, (count - 1) * width));
        assert.deepEqual(imported(split), complete());
      }, perfectOnly);
    });
  }
}

test('CPU range recognition retains native planar-defect acceptance for both crystal families', async () => {
  for (const [kind, lattice, counterpart] of [['hcp', 1, 2], ['fcc', 2, 1],
    ['hex-diamond', 4, 5], ['diamond', 5, 4]]) {
    for (const perfectOnly of [0, 1]) {
      await withFrame(crystalFrame(kind, 4), lattice, ({ count, prepareLocal, identify }) => {
        prepareLocal();
        const result = identify(0, count);
        assert.ok(result.structures.every(type => type === (perfectOnly ? 0 : counterpart)));
        if (perfectOnly) {
          assert.ok(result.neighbors.every(index => index === -1));
          assert.equal(result.maxDistance, 0);
        }
      }, perfectOnly);
    }
  }
});

test('merged original CPU local results preserve a periodic screw dislocation and its complete network', async () => {
  await withFrame(fccScrewFrame(), 1, ({ mergeRanges, unevenRanges, complete, imported }) => {
    const original = complete();
    assert.equal(original.segments.length, 1);
    const split = mergeRanges(unevenRanges());
    assert.deepEqual(Array.from(split.structures), original.atomStructureTypes);
    assert.deepEqual(imported(split), original);
  });
});

test('CPU local import preserves duplicate periodic-image IDs and the original small-cell tracing failure', async () => {
  await withFrame(crystalFrame('bcc', 2), 3, ({ module, args, mergeRanges, unevenRanges, allocateResults, error }) => {
    const split = mergeRanges(unevenRanges());
    assert.ok(split.structures.every(type => type === 3));
    assert.ok(Array.from({ length: split.structures.length }, (_, atom) => {
      const row = split.neighbors.slice(atom * split.width, (atom + 1) * split.width);
      return new Set(row).size < row.length;
    }).some(Boolean), 'distinct periodic images share atom IDs at the original half-cell boundary');
    // Native recognition permits this half-cell neighbor geometry. The later
    // probe sphere still cannot construct an interface in such a short cell.
    assert.equal(module._alloy_dxa_analyze(...args), 0);
    const originalError = error();
    assert.match(originalError, /Cannot construct manifold.*cell length is too small/);
    const importArgs = allocateResults(split);
    assert.equal(module._alloy_dxa_prepare(...args), 1, error());
    assert.equal(module._alloy_dxa_import_local(...importArgs), 1, error());
    assert.equal(module._alloy_dxa_finish(), 0);
    assert.equal(error(), originalError);
  });
});

test('translated triclinic geometry and vacancy rows survive segmented CPU recognition and import', async () => {
  const frame = crystalFrame('fcc', 4);
  frame.cell = createCell({ vectors: [16, 0, 0, 1.2, 16, 0, .6, .8, 16],
    origin: [100, -200, 300], triclinic: true });
  const vacancy = { ...frame, fractional: frame.fractional.slice(3), positions: frame.positions.slice(3),
    ids: frame.ids.slice(1), types: frame.types.slice(1) };
  await withFrame(vacancy, 1, ({ mergeRanges, unevenRanges, complete, imported }) => {
    const split = mergeRanges(unevenRanges());
    assert.ok(split.structures.includes(0));
    assert.ok(split.structures.includes(1));
    for (let atom = 0; atom < split.structures.length; atom++) {
      if (split.structures[atom] === 0)
        assert.ok(split.neighbors.slice(atom * split.width, (atom + 1) * split.width).every(index => index === -1));
    }
    assert.deepEqual(imported(split), complete());
  });
});

test('CPU local workspace rejects invalid ranges and canceled jobs and recovers with cached geometry', async () => {
  await withFrame(crystalFrame('bcc', 4), 3, ({ module, count, prepareLocal, identify, localError }) => {
    assert.equal(module._alloy_dxa_local_identify(0, count), 0);
    assert.match(localError(), /no prepared frame/);
    prepareLocal();
    assert.equal(module._alloy_dxa_local_structures_ptr(), 0);
    const original = identify(0, count);
    for (const [start, end] of [[-1, 2], [2, -1], [5, 4], [0, count + 1]]) {
      assert.equal(module._alloy_dxa_local_identify(start, end), 0);
      assert.match(localError(), /invalid.*range/i);
      assert.equal(module._alloy_dxa_local_structures_ptr(), 0);
      assert.equal(module._alloy_dxa_local_neighbors_ptr(), 0);
    }
    module.HEAP32[module._alloy_dxa_cancel_ptr() / 4] = 1;
    assert.equal(module._alloy_dxa_local_identify(0, count), 0);
    assert.match(localError(), /canceled/);
    assert.equal(module._alloy_dxa_local_structures_ptr(), 0);
    module._alloy_dxa_reset_cancel();
    assert.deepEqual(identify(0, count), original);
    const empty = identify(count, count);
    assert.equal(empty.structures.length, 0);
    assert.equal(empty.neighbors.length, 0);
    assert.equal(empty.maxDistance, 0);
    module._alloy_dxa_local_dispose();
    assert.equal(module._alloy_dxa_local_neighbor_width(), 0);
    assert.equal(module._alloy_dxa_local_structures_ptr(), 0);
  });
});

test('failed CPU local preparation clears previous geometry and permits corrected input', async () => {
  await withFrame(crystalFrame('fcc', 4), 1, ({ module, count, localArgs, coordinates, cellPointer, prepareLocal, identify, localError }) => {
    prepareLocal();
    identify(0, count);
    const firstCoordinate = module.HEAPF64[coordinates / 8];
    module.HEAPF64[coordinates / 8] = NaN;
    assert.equal(module._alloy_dxa_local_prepare(...localArgs), 0);
    assert.match(localError(), /coordinates must be finite/);
    assert.equal(module._alloy_dxa_local_neighbor_width(), 0);
    assert.equal(module._alloy_dxa_local_structures_ptr(), 0);
    module.HEAPF64[coordinates / 8] = firstCoordinate;
    const cell = module.HEAPF64.slice(cellPointer / 8, cellPointer / 8 + 12);
    module.HEAPF64.fill(0, cellPointer / 8, cellPointer / 8 + 9);
    assert.equal(module._alloy_dxa_local_prepare(...localArgs), 0);
    assert.match(localError(), /non-singular/);
    assert.equal(module._alloy_dxa_local_neighbor_width(), 0);
    module.HEAPF64.set(cell, cellPointer / 8);
    prepareLocal();
    assert.ok(identify(0, count).structures.every(type => type === 1));
  });
});

test('main CPU import rejects malformed local metadata and allows a fresh valid frame', async () => {
  await withFrame(crystalFrame('fcc', 4), 1, ({ module, count, args, mergeRanges, unevenRanges, allocateResults, error, imported }) => {
    const result = mergeRanges(unevenRanges());
    const importArgs = allocateResults(result);
    const invalid = [
      [...importArgs.slice(0, 2), count - 1, result.width, result.maxDistance],
      [...importArgs.slice(0, 3), result.width - 1, result.maxDistance],
      [...importArgs.slice(0, 4), NaN],
      [...importArgs.slice(0, 4), 0],
    ];
    for (const inputs of invalid) {
      assert.equal(module._alloy_dxa_prepare(...args), 1, error());
      assert.equal(module._alloy_dxa_import_local(...inputs), 0);
      assert.match(error(), /invalid|inconsistent/i);
    }
    const structuresOffset = importArgs[0] / 4, neighborsOffset = importArgs[1] / 4;
    for (const [offset, value, pattern] of [[structuresOffset, 3, /structure type/],
      [neighborsOffset, 0, /neighbor index/], [neighborsOffset, count, /neighbor index/]]) {
      const previous = module.HEAP32[offset];
      module.HEAP32[offset] = value;
      assert.equal(module._alloy_dxa_prepare(...args), 1, error());
      assert.equal(module._alloy_dxa_import_local(...importArgs), 0);
      assert.match(error(), pattern);
      module.HEAP32[offset] = previous;
    }
    module.HEAP32[structuresOffset] = 0;
    assert.equal(module._alloy_dxa_prepare(...args), 1, error());
    assert.equal(module._alloy_dxa_import_local(...importArgs), 0);
    assert.match(error(), /empty neighbor rows/);
    module.HEAP32[structuresOffset] = 1;
    assert.ok(imported(result).atomStructureTypes.every(type => type === 1));
  });
});
