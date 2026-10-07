import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import createDxa from '../src/analysis/dxa-kernel.mjs';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { createCell } from '../src/data/model.js';
import { crystalFrame } from './helpers/crystals.js';
import { fccScrewFrame } from './helpers/dislocations.js';

const modulePromise = createDxa({ wasmBinary: await readFile(new URL('../src/analysis/dxa-kernel.wasm', import.meta.url)) });

async function withFrame(frame, lattice, run) {
  const module = await modulePromise, allocated = [];
  module._alloy_dxa_reset_cancel();
  const allocate = bytes => { const pointer = module._malloc(bytes); assert.ok(pointer); allocated.push(pointer); return pointer; };
  const positions = dxaCartesianCoordinates(frame), coordinatePointer = allocate(positions.byteLength), cellPointer = allocate(96);
  module.HEAPF64.set(positions, coordinatePointer / 8);
  module.HEAPF64.set(frame.cell.vectors, cellPointer / 8);
  module.HEAPF64.set(frame.cell.origin, cellPointer / 8 + 9);
  const args = [coordinatePointer, positions.length / 3, cellPointer,
    frame.cell.pbc.reduce((bits, flag, axis) => bits | (flag ? 1 << axis : 0), 0), lattice, 14, 9, 0, 1, 2.5];
  const error = () => module.UTF8ToString(module._alloy_dxa_last_error());
  const begin = () => assert.equal(module._alloy_dxa_begin(...args), 1, error());
  const result = () => { const pointer = module._alloy_dxa_finish(); assert.ok(pointer, error()); return JSON.parse(module.UTF8ToString(pointer)); };
  const snapshot = () => {
    assert.equal(module._alloy_dxa_worker_snapshot(256 * 1024 ** 2), 1, error());
    return [module._alloy_dxa_worker_vertex_ptr(), module._alloy_dxa_worker_vertex_count(),
      module._alloy_dxa_worker_tet_ptr(), module._alloy_dxa_worker_tet_count(),
      module._alloy_dxa_worker_edge_ptr(), module._alloy_dxa_worker_edge_count(),
      module._alloy_dxa_worker_transition_ptr(), module._alloy_dxa_worker_transition_count(), module._alloy_dxa_worker_alpha()];
  };
  try { await run({ module, allocate, begin, result, snapshot, error }); }
  finally { module._alloy_dxa_dispose(); for(const pointer of allocated) module._free(pointer); module._alloy_dxa_reset_cancel(); }
}

for(const [kind, lattice] of [['fcc', 1], ['bcc', 3], ['hcp', 2], ['diamond', 4], ['hex-diamond', 5], ['screw', 1], ['vacancy', 1]]) {
  test(`private CPU tetrahedron ranges preserve native ${kind} labels and complete network`, async () => {
    let frame = kind === 'screw' ? fccScrewFrame() : crystalFrame(kind === 'vacancy' ? 'fcc' : kind, 4);
    if(kind === 'vacancy') {
      frame = { ...frame, fractional: frame.fractional.slice(3),
        cell: createCell({ vectors: [16,0,0,1.2,16,0,.6,.8,16], origin: [100,-200,300], triclinic: true }) };
    }
    await withFrame(frame, lattice, ({ module, allocate, begin, result, snapshot, error }) => {
      begin();
      const input = snapshot(), count = input[3], output = allocate(count * 4);
      assert.ok(count > 0);
      const boundaries = [0, 1, Math.floor(count / 3), Math.floor(count * 2 / 3), count];
      for(const range of [2, 0, 3, 1]) {
        const start = boundaries[range], end = boundaries[range + 1];
        assert.equal(module._alloy_dxa_classify_range(...input, start, end, output + start * 4), 1,
          module.UTF8ToString(module._alloy_dxa_classify_error()));
      }
      const classified = module.HEAP32.slice(output / 4, output / 4 + count);
      assert.ok(classified.every(value => value === -1 || value === 0));
      module._alloy_dxa_release_worker_snapshot();
      const original = result();
      const native = module._alloy_dxa_worker_regions_ptr();
      assert.ok(native, error());
      assert.deepEqual(classified, module.HEAP32.slice(native / 4, native / 4 + count), 'every alpha/sliver/Burgers/Frank decision matches native meshing');
      module._alloy_dxa_dispose();
      begin();
      assert.equal(module._alloy_dxa_worker_tet_count(), count);
      module.HEAP32.set(classified, output / 4);
      assert.equal(module._alloy_dxa_import_regions(output, count), 1, error());
      module._alloy_dxa_release_worker_snapshot();
      assert.deepEqual(result(), original, 'imported labels preserve original line topology, Burgers vectors, points and per-atom labels');
    });
  });
}

test('optional snapshot allocation rejection and malformed labels keep native serial recovery available', async () => {
  await withFrame(crystalFrame('bcc', 4), 3, ({ module, allocate, begin, result, error }) => {
    begin();
    assert.equal(module._alloy_dxa_worker_snapshot(1), 0);
    assert.match(error(), /memory budget/);
    assert.equal(module._alloy_dxa_worker_vertex_ptr(), 0);
    const count = module._alloy_dxa_worker_tet_count(), labels = allocate(count * 4);
    module.HEAP32.fill(-1, labels / 4, labels / 4 + count);
    module.HEAP32[labels / 4] = 2;
    assert.equal(module._alloy_dxa_import_regions(labels, count), 0);
    assert.match(error(), /invalid region labels/);
    const original = result();
    assert.equal(original.segments.length, 0);
    assert.ok(original.atomStructureTypes.every(type => type === 3));
  });
});

test('private CPU alpha classification retains strict radius boundary and reversed edge orientation', async () => {
  const module = await modulePromise, pointers = [];
  const put = (array, heap, divisor) => {
    const pointer = module._malloc(array.byteLength); pointers.push(pointer);
    module[heap].set(array, pointer / divisor); return pointer;
  };
  const vertices = new Float64Array([0,0,0,1,0,0,0,1,0,0,0,1]);
  const tetrahedra = new Uint32Array(16); tetrahedra.set([0,1,2,3]); tetrahedra.set([1,2,3,4,5,6], 8); tetrahedra[14] = 1;
  const edgeData = new Uint32Array(7 * 8), vectors = new Float64Array(edgeData.buffer);
  edgeData[6] = 0xffffffff;
  for(const [index, pair] of [[0,[0,1]],[1,[0,2]],[2,[0,3]],[3,[1,2]],[4,[1,3]],[5,[2,3]]]) {
    for(let axis = 0; axis < 3; axis++) vectors[(index + 1) * 4 + axis] = vertices[pair[1] * 3 + axis] - vertices[pair[0] * 3 + axis];
  }
  const transitions = new Float64Array(20); for(let axis = 0; axis < 3; axis++) { transitions[axis * 4] = 1; transitions[9 + axis * 4] = 1; } transitions[18] = 1;
  try {
    const inputs = [put(vertices,'HEAPF64',8),4,put(tetrahedra,'HEAPU32',4),1,put(edgeData,'HEAPU32',4),7,put(transitions,'HEAPF64',8),1];
    const output = module._malloc(4); pointers.push(output);
    const classify = alpha => { assert.equal(module._alloy_dxa_classify_range(...inputs, alpha, 0, 1, output), 1); return module.HEAP32[output / 4]; };
    assert.equal(classify(.75), -1);
    assert.equal(classify(.75 + Number.EPSILON), 0);
    // Stored edge0 points backward; its encoded orientation restores exactly
    // the same Burgers circuits rather than flipping a physical lattice vector.
    const edgePointer = inputs[4];
    for(let axis = 0; axis < 3; axis++) module.HEAPF64[edgePointer / 8 + 4 + axis] *= -1;
    module.HEAPU32[inputs[2] / 4 + 8] |= 0x80000000;
    assert.equal(classify(1), 0);
    module.HEAPU32[inputs[2] / 4 + 8] = 0x7fffffff;
    assert.equal(module._alloy_dxa_classify_range(...inputs, 1, 0, 1, output), 0);
    assert.match(module.UTF8ToString(module._alloy_dxa_classify_error()), /invalid edge/);
  } finally { for(const pointer of pointers) module._free(pointer); }
});
