import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import createDxa from '../src/analysis/dxa-kernel.mjs';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';
import { fccScrewFrame } from './helpers/dislocations.js';

const modulePromise = createDxa({ wasmBinary: await readFile(new URL('../src/analysis/dxa-kernel.wasm', import.meta.url)) });

async function withLocalFrame(frame, lattice, run, perfectOnly = false) {
  const module = await modulePromise;
  module._alloy_dxa_reset_cancel();
  const positions = dxaCartesianCoordinates(frame), count = positions.length / 3;
  const coordinates = module._malloc(positions.byteLength), cellPointer = module._malloc(12 * 8);
  assert.ok(coordinates && cellPointer);
  module.HEAPF64.set(positions, coordinates / 8);
  module.HEAPF64.set(frame.cell.vectors, cellPointer / 8);
  module.HEAPF64.set(frame.cell.origin, cellPointer / 8 + 9);
  const args = [coordinates, count, cellPointer,
    frame.cell.pbc.reduce((bits, periodic, axis) => bits | (periodic ? 1 << axis : 0), 0),
    lattice, 14, 9, Number(perfectOnly), 1, 2.5];
  const error = () => module.UTF8ToString(module._alloy_dxa_last_error());
  const prepare = () => assert.equal(module._alloy_dxa_prepare(...args), 1, error());
  const identify = () => {
    assert.equal(module._alloy_dxa_identify_local_cpu(), 1, error());
    const width = module._alloy_dxa_local_neighbor_width();
    const typesPointer = module._alloy_dxa_local_types_ptr(), neighborsPointer = module._alloy_dxa_local_neighbors_ptr();
    assert.ok(typesPointer && neighborsPointer);
    return {
      types: module.HEAP32.slice(typesPointer / 4, typesPointer / 4 + count),
      neighbors: module.HEAP32.slice(neighborsPointer / 4, neighborsPointer / 4 + count * width),
      width, maximumDistance: module._alloy_dxa_local_max_distance(),
    };
  };
  const finish = () => {
    const pointer = module._alloy_dxa_finish(0, 0);
    assert.ok(pointer, error());
    return JSON.parse(module.UTF8ToString(pointer));
  };
  const importLocal = output => {
    const types = module._malloc(output.types.byteLength), neighbors = module._malloc(output.neighbors.byteLength);
    assert.ok(types && neighbors);
    try {
      module.HEAP32.set(output.types, types / 4);
      module.HEAP32.set(output.neighbors, neighbors / 4);
      return module._alloy_dxa_build_mapping(types, neighbors, output.width, output.maximumDistance);
    } finally { module._free(types); module._free(neighbors); }
  };
  try { await run({ module, positions, count, error, prepare, identify, importLocal, finish }); }
  finally {
    module._alloy_dxa_dispose();
    module._free(coordinates);
    module._free(cellPointer);
    module._alloy_dxa_reset_cancel();
  }
}

test('native local preparation exports the exact ideal template graphs and retains no geometry', async () => {
  await withLocalFrame(crystalFrame('fcc', 4), 1, ({ module, prepare }) => {
    assert.equal(module._alloy_dxa_local_templates_ptr(), 0);
    prepare();
    assert.deepEqual([module._alloy_dxa_vertex_count(), module._alloy_dxa_tet_count(),
      module._alloy_dxa_edge_count(), module._alloy_dxa_transition_count()], [0, 0, 0, 0]);
    assert.equal(module._alloy_dxa_snapshot_bytes(), 0);
    assert.equal(module._alloy_dxa_alpha(), 0);
    assert.equal(module._alloy_dxa_local_types_ptr(), 0);
    assert.equal(module._alloy_dxa_local_neighbor_width(), 12);
    const pointer = module._alloy_dxa_local_templates_ptr();
    assert.ok(pointer);
    const templates = module.HEAPU32.slice(pointer / 4, pointer / 4 + 165);
    const expectedCounts = [12, 12, 14, 16, 16];
    const expectedSignatures = [[12, 0, 0], [6, 6, 0], [8, 6, 0], [4, 12, 0], [4, 6, 6]];
    for (let type = 0; type < 5; type++) {
      const record = templates.subarray(type * 33, (type + 1) * 33), count = expectedCounts[type];
      assert.equal(record[0], count);
      const signatures = record.subarray(1, 1 + count), masks = record.subarray(17, 17 + count);
      assert.deepEqual([0, 1, 2].map(signature => signatures.filter(value => value === signature).length), expectedSignatures[type]);
      for (let first = 0; first < count; first++) {
        assert.equal(masks[first] & (1 << first), 0);
        assert.equal(masks[first] >>> count, 0);
        for (let second = 0; second < count; second++)
          assert.equal(Boolean(masks[first] & (1 << second)), Boolean(masks[second] & (1 << first)));
      }
    }
  });
});

test('native local position export mirrors the nearest finder Cartesian boundary wrapping', async () => {
  const frame = crystalFrame('fcc', 4);
  frame.cell = createCell({ vectors: [16, 0, 0, 1.2, 16, 0, .6, .8, 16], origin: [100, -200, 300], triclinic: true });
  await withLocalFrame(frame, 1, ({ module, positions, prepare }) => {
    prepare();
    const pointer = module._alloy_dxa_local_positions_ptr(), inversePointer = module._alloy_dxa_local_inverse_ptr();
    assert.ok(pointer && inversePointer);
    const inverse = module.HEAPF64.slice(inversePointer / 8, inversePointer / 8 + 9);
    const actual = module.HEAPF64.slice(pointer / 8, pointer / 8 + positions.length), expected = positions.slice();
    // AffineTransformation::inverse computes inv * (-origin); nearest prepare
    // first computes the entire reduced point, then subtracts each cell shift.
    const translation = [0, 1, 2].map(axis => inverse[axis] * -frame.cell.origin[0]
      + inverse[3 + axis] * -frame.cell.origin[1] + inverse[6 + axis] * -frame.cell.origin[2]);
    for (let atom = 0; atom < positions.length / 3; atom++) {
      const start = atom * 3, point = Array.from(positions.subarray(start, start + 3));
      const reduced = [0, 1, 2].map(axis => inverse[axis] * point[0]
        + inverse[3 + axis] * point[1] + inverse[6 + axis] * point[2] + translation[axis]);
      for (let axis = 0; axis < 3; axis++) {
        const shift = Math.floor(reduced[axis]);
        if (shift) for (let component = 0; component < 3; component++)
          expected[start + component] -= shift * frame.cell.vectors[axis * 3 + component];
      }
    }
    assert.deepEqual(actual, expected);
    module._alloy_dxa_release_local_input();
    module._alloy_dxa_release_local_input();
    const reexported = module._alloy_dxa_local_positions_ptr();
    assert.deepEqual(module.HEAPF64.slice(reexported / 8, reexported / 8 + positions.length), expected);
  });
});

for (const [kind, lattice, type, width] of [
  ['fcc', 1, 1, 12], ['hcp', 2, 2, 12], ['bcc', 3, 3, 14],
  ['diamond', 4, 4, 16], ['hex-diamond', 5, 5, 16],
]) {
  test(`native ${kind} local injection preserves the complete scientific pipeline`, async () => {
    await withLocalFrame(crystalFrame(kind, 4), lattice, ({ module, prepare, identify, importLocal, finish, error }) => {
      prepare();
      const local = identify();
      assert.equal(local.width, width);
      assert.ok(local.types.every(value => value === type));
      assert.equal(module._alloy_dxa_build_mapping(0, 0, 0, 0), 1, error());
      const original = finish();
      prepare();
      assert.equal(importLocal(local), 1, error());
      assert.equal(module._alloy_dxa_local_neighbors_ptr(), 0, 'mapping releases only the native neighbor workspace');
      assert.deepEqual(finish(), original);
    });
  });
}

test('native ideal correspondence injection preserves a nonzero screw-dislocation network', async () => {
  await withLocalFrame(fccScrewFrame(), 1, ({ module, prepare, identify, importLocal, finish, error }) => {
    prepare();
    const local = identify();
    assert.ok(local.types.includes(0));
    assert.ok(local.types.includes(1));
    assert.equal(module._alloy_dxa_build_mapping(0, 0, 0, 0), 1, error());
    const original = finish();
    assert.equal(original.segments.length, 1);
    prepare();
    identify(); // Optional scientific verification may identify on CPU first.
    assert.equal(importLocal(local), 1, error());
    assert.deepEqual(finish(), original);
  });
});

test('native local import rejects malformed correspondence and retains input for CPU fallback', async () => {
  await withLocalFrame(crystalFrame('fcc', 4), 1, ({ module, count, prepare, identify, importLocal, finish, error }) => {
    prepare();
    const reference = identify();
    const variants = [
      [output => { output.width = 14; }, /dimensions/],
      [output => { output.maximumDistance = NaN; }, /cutoff/],
      [output => { output.maximumDistance = 0; }, /cutoff/],
      [output => { output.types[count - 1] = 3; }, /crystal type/],
      [output => { output.neighbors[(count - 1) * 12] = count; }, /neighbor index/],
      [output => { output.neighbors[(count - 1) * 12] = count - 1; }, /neighbor index/],
      [output => { output.neighbors[(count - 1) * 12 + 1] = output.neighbors[(count - 1) * 12]; }, /duplicate/],
      [output => { output.types[count - 1] = 0; }, /empty neighbor/],
    ];
    for (const [modify, expected] of variants) {
      prepare();
      const output = { ...reference, types: reference.types.slice(), neighbors: reference.neighbors.slice() };
      modify(output);
      assert.equal(importLocal(output), 0);
      assert.match(error(), expected);
      assert.equal(module._alloy_dxa_local_neighbor_width(), 12, 'rejected import retains its original source');
      assert.equal(module._alloy_dxa_local_types_ptr(), 0, 'rejected import commits no partially valid rows');
      assert.equal(module._alloy_dxa_build_mapping(0, 0, 0, 0), 1, error());
      assert.equal(finish().segments.length, 0);
    }
  });
});

test('native prepared-input cancellation recovers in the same Wasm module', async () => {
  await withLocalFrame(crystalFrame('bcc', 4), 3, ({ module, prepare, finish, error }) => {
    prepare();
    module.HEAP32[module._alloy_dxa_cancel_ptr() / 4] = 1;
    assert.equal(module._alloy_dxa_build_mapping(0, 0, 0, 0), 0);
    assert.match(error(), /canceled/);
    assert.equal(module._alloy_dxa_local_neighbor_width(), 0);
    module._alloy_dxa_reset_cancel();
    prepare();
    assert.equal(module._alloy_dxa_build_mapping(0, 0, 0, 0), 1, error());
    assert.ok(finish().atomStructureTypes.every(value => value === 3));
  });
});

test('native local import preserves the perfect-only planar-defect restriction', async () => {
  const frame = crystalFrame('hcp', 4);
  let planarDefect;
  await withLocalFrame(frame, 1, ({ prepare, identify }) => {
    prepare();
    planarDefect = identify();
    assert.ok(planarDefect.types.every(value => value === 2));
  });
  await withLocalFrame(frame, 1, ({ module, prepare, importLocal, error }) => {
    prepare();
    assert.equal(importLocal(planarDefect), 0);
    assert.match(error(), /invalid crystal type/);
    assert.equal(module._alloy_dxa_local_neighbor_width(), 12);
  }, true);
});
