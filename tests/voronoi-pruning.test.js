import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import createVoronoi from '../src/analysis/voronoi-kernel.mjs';

// Exercise the actual native prefilter against the same unfiltered Voro++
// planes. Near-coplanar planes may leave volume unchanged while reassigning a
// face's atom neighbor, so retain and compare the complete polygon topology.
let kernelPromise;
async function kernel() {
  kernelPromise ??= (async () => {
    const module = await createVoronoi({ wasmBinary: await readFile(new URL('../src/analysis/voronoi-kernel.wasm', import.meta.url)) });
    const allocation = Object.fromEntries(Object.entries({ planes: 24 * 8, ids: 24, keep: 1,
      summary: 16, areas: 128 * 8, orders: 128 * 4, neighbors: 128 * 4,
      sizes: 12, vertices: 512 * 3 * 8, offsets: 129 * 4, references: 1024 * 4,
      geometryNeighbors: 128 * 4 }).map(([name, bytes]) => [name, module._malloc(bytes)]));
    return { module, ...allocation };
  })();
  return kernelPromise;
}

function initializeCube(k) {
  const { module: m } = k;
  m._alloy_voronoi_init(2);
  m.HEAPF64.set([1, 0, 0, 2, -1, 0, 0, 2, 0, 1, 0, 2, 0, -1, 0, 2, 0, 0, 1, 2, 0, 0, -1, 2], k.planes >> 3);
  m.HEAP32.set([11, 12, 13, 14, 15, 16], k.ids >> 2);
  assert.equal(m._alloy_voronoi_clip(k.planes, k.ids, 6), 1);
}

function readCell(k) {
  const { module: m } = k;
  const faces = m._alloy_voronoi_summary(k.summary);
  assert.equal(m._alloy_voronoi_faces(k.areas, k.orders, k.neighbors, 128), faces);
  const volume = m.HEAPF64[k.summary >> 3], surface = m.HEAPF64[(k.summary >> 3) + 1],
    faceAreas = m.HEAPF64.slice(k.areas >> 3, (k.areas >> 3) + faces),
    faceOrders = m.HEAPU32.slice(k.orders >> 2, (k.orders >> 2) + faces),
    faceNeighbors = m.HEAP32.slice(k.neighbors >> 2, (k.neighbors >> 2) + faces);
  assert.equal(m._alloy_voronoi_geometry_sizes(k.sizes), faces);
  const vertices = m.HEAPU32[k.sizes >> 2], references = m.HEAPU32[(k.sizes >> 2) + 2];
  assert.equal(m._alloy_voronoi_geometry(k.vertices, k.offsets, k.references, k.geometryNeighbors,
    512, 128, 1024), faces);
  return { volume, surface, faceAreas, faceOrders, faceNeighbors,
    vertices: m.HEAPF64.slice(k.vertices >> 3, (k.vertices >> 3) + vertices * 3),
    faceOffsets: m.HEAPU32.slice(k.offsets >> 2, (k.offsets >> 2) + faces + 1),
    faceVertices: m.HEAPU32.slice(k.references >> 2, (k.references >> 2) + references),
    polygonNeighbors: m.HEAP32.slice(k.geometryNeighbors >> 2, (k.geometryNeighbors >> 2) + faces) };
}

function applyPlane(k, plane, filter) {
  const { module: m } = k;
  m.HEAPF64.set(plane, k.planes >> 3); m.HEAP32[k.ids >> 2] = 99;
  m._alloy_voronoi_filter_planes(k.planes, k.keep, 1);
  const keep = Boolean(m.HEAPU8[k.keep]);
  if (!filter || keep) assert.equal(m._alloy_voronoi_clip(k.planes, k.ids, 1), 1);
  return keep;
}

test('native Voronoi pruning preserves near-coplanar neighbor ownership and the complete polygon CSR throughout the marginal band', async () => {
  const k = await kernel();
  // The retained Voro++ cell defaults to max_len_sq=1000²; its inside/on-plane
  // classification tolerance is 10*epsilon*max_len_sq, with a 20× search band.
  const tolerance = 10 * Number.EPSILON * 1_000 ** 2;
  for (const delta of [-1.5, -.5, 0, .5, .9, 1.5, 19].map(factor => factor * tolerance)) {
    const plane = [1, 0, 0, 2 + delta];
    initializeCube(k); applyPlane(k, plane, false); const reference = readCell(k);
    initializeCube(k); const keep = applyPlane(k, plane, true), filtered = readCell(k);
    assert.equal(keep, true, `retain the complete native marginal/search band at ${delta}`);
    assert.deepEqual(filtered, reference, `every topology and geometric field at ${delta}`);
    if (Math.abs(delta) < tolerance) {
      assert.ok(reference.faceNeighbors.includes(99), 'Voro++ reassigns a coplanar face to the candidate atom');
      assert.equal(reference.volume, 8, 'equal volume does not imply equal atomic face ownership');
    }
  }
});

test('native Voronoi pruning preserves tangent-corner topology while still rejecting safely interior distant planes', async () => {
  const k = await kernel(), tolerance = 10 * Number.EPSILON * 1_000 ** 2;
  for (const delta of [-.5, 0, .5, 19].map(factor => factor * tolerance)) {
    const plane = [1, 1, 1, 6 + delta];
    initializeCube(k); applyPlane(k, plane, false); const reference = readCell(k);
    initializeCube(k); assert.equal(applyPlane(k, plane, true), true);
    assert.deepEqual(readCell(k), reference);
  }
  initializeCube(k); const initial = readCell(k);
  assert.equal(applyPlane(k, [1, 0, 0, 2.001], true), false, 'a separated redundant plane remains prunable');
  assert.deepEqual(readCell(k), initial);
  initializeCube(k); applyPlane(k, [1, 0, 0, 2.001], false);
  assert.deepEqual(readCell(k), initial, 'the rejected plane is also a no-op in the unfiltered native reference');
});
