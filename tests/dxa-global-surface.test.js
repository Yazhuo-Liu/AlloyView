import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { fccCornerVoidFrame } from './helpers/dxa-global-fixtures.js';

const baseline = JSON.parse(await readFile(new URL('./fixtures/dxa-global-baseline.json', import.meta.url))).surfaceVoid;
const digest = parts => {
  const hash = createHash('sha256');
  for (const bytes of parts) { hash.update(String(bytes.byteLength)); hash.update(':'); hash.update(bytes); }
  return hash.digest('hex');
};
const roundoff = (actual, expected, operations) => {
  const gamma = operations * Number.EPSILON / (1 - operations * Number.EPSILON);
  assert.ok(Number.isFinite(actual));
  assert.ok(Math.abs(actual - expected) <= gamma * Math.max(1, Math.abs(expected)),
    `${actual} versus ${expected}: roundoff bound for ${operations} floating-point operations`);
};

function canonicalFaces(mesh) {
  const faces = [], directedEdges = new Set();
  for (let face = 0; face < mesh.faces.length / 3; face++) {
    const vertices = mesh.faces.slice(face * 3, face * 3 + 3);
    assert.equal(new Set(vertices).size, 3);
    for (const vertex of vertices) assert.ok(Number.isSafeInteger(vertex) && vertex >= 0 && vertex < mesh.particles.length);
    for (let corner = 0; corner < 3; corner++) {
      const edge = `${vertices[corner]}:${vertices[(corner + 1) % 3]}`;
      assert.ok(!directedEdges.has(edge), 'A closed oriented manifold uses each directed edge once.');
      directedEdges.add(edge);
    }
    const atoms = vertices.map(vertex => mesh.particles[vertex]), first = atoms.indexOf(Math.min(...atoms));
    faces.push([...atoms.slice(first), ...atoms.slice(0, first), ...mesh.faceRegions.slice(face * 2, face * 2 + 2)].join(','));
  }
  for (const edge of directedEdges) assert.ok(directedEdges.has(edge.split(':').reverse().join(':')), 'Every surface edge has one opposite face.');
  assert.equal(mesh.particles.length - directedEdges.size / 2 + mesh.faces.length / 3, 2, 'This single closed cavity has sphere topology.');
  return faces.sort();
}

// Surface adds eight far auxiliary points to the same native tessellation.
// Keep all four threads enabled during tessellation and manifold construction;
// no progress callback switches its geometry stage back to BDEL.
test('Surface retains complete periodic cavity geometry through real PDEL and 1/4/1 reuse', async () => {
  const { default: createDxa } = await import('../src/analysis/dxa-kernel-threaded.mjs');
  const kernel = await createDxa({ wasmBinary: await readFile(new URL('../src/analysis/dxa-kernel-threaded.wasm', import.meta.url)), dxaPoolSize: 3 });
  const frame = fccCornerVoidFrame(), xyz = dxaCartesianCoordinates(frame);
  const input = { atomCount: xyz.length / 3, cell: { vectors: Array.from(frame.cell.vectors), origin: Array.from(frame.cell.origin),
    pbc: Array.from(frame.cell.pbc) }, parameters: { radius: 3.2, smoothingLevel: 2, selection: null } };
  assert.equal(createHash('sha256').update(Buffer.from(xyz.buffer, xyz.byteOffset, xyz.byteLength))
    .update(JSON.stringify(input)).digest('hex'), baseline.scientificInputSha256);
  const positions = kernel._malloc(xyz.byteLength), cell = kernel._malloc(96);
  kernel.HEAPF64.set(xyz, positions / 8); kernel.HEAPF64.set(frame.cell.vectors, cell / 8); kernel.HEAPF64.set(frame.cell.origin, cell / 8 + 9);
  const expectedFaces = canonicalFaces(baseline), expectedByAtom = new Map(baseline.particles.map((atom, vertex) => [atom, baseline.vertices.slice(vertex * 3, vertex * 3 + 3)]));
  try {
    for (const threads of [1, 4, 1]) {
      kernel._alloy_dxa_reset_cancel(); kernel._alloy_dxa_set_threads(threads);
      const pointer = kernel._alloy_surface_construct(positions, xyz.length / 3, cell, 7, 0, 3.2, 2);
      assert.ok(pointer, kernel.UTF8ToString(kernel._alloy_surface_last_error()));
      assert.equal(kernel._alloy_dxa_thread_count(), threads);
      const summary = JSON.parse(kernel.UTF8ToString(pointer));
      const vertices = kernel._alloy_surface_vertex_count(), faces = kernel._alloy_surface_face_count(), regions = kernel._alloy_surface_region_count();
      const copy = (heap, pointer, count, bytes) => Array.from(heap.slice(pointer / bytes, pointer / bytes + count));
      const mesh = {
        vertices: copy(kernel.HEAPF64, kernel._alloy_surface_vertices_ptr(), vertices * 3, 8),
        particles: copy(kernel.HEAPU32, kernel._alloy_surface_vertex_particles_ptr(), vertices, 4),
        faces: copy(kernel.HEAPU32, kernel._alloy_surface_faces_ptr(), faces * 3, 4),
        faceRegions: copy(kernel.HEAP32, kernel._alloy_surface_face_regions_ptr(), faces * 2, 4),
        regions: copy(kernel.HEAPF64, kernel._alloy_surface_regions_ptr(), regions * 4, 8),
      };
      assert.deepEqual([vertices, faces, regions], baseline.counts);
      assert.deepEqual(canonicalFaces(mesh), expectedFaces, 'Every oriented facet and adjacent region matches after atom-based ID remapping.');
      assert.deepEqual(mesh.particles.toSorted((a, b) => a - b), baseline.particles.toSorted((a, b) => a - b));
      for (let vertex = 0; vertex < vertices; vertex++) {
        const expected = expectedByAtom.get(mesh.particles[vertex]);
        for (let axis = 0; axis < 3; axis++) roundoff(mesh.vertices[vertex * 3 + axis], expected[axis], 64);
      }
      const scalarMeasurements = new Set(['surfaceArea', 'filledVolume', 'emptyVolume', 'voidVolume']);
      for (const key of Object.keys(baseline.summary)) {
        if (scalarMeasurements.has(key)) roundoff(summary[key], baseline.summary[key], summary.tetrahedronCount * 16);
        else assert.equal(summary[key], baseline.summary[key], key);
      }
      for (let value = 0; value < mesh.regions.length; value++) {
        if (value % 4 < 2) roundoff(mesh.regions[value], baseline.regions[value], summary.tetrahedronCount * 16);
        else assert.equal(mesh.regions[value], baseline.regions[value], 'Filled/exterior region identity remains exact.');
      }
      roundoff(summary.filledVolume + summary.emptyVolume, summary.cellVolume, summary.tetrahedronCount * 16);
      if (threads === 1) {
        const bytes = (pointer, size) => kernel.HEAPU8.slice(pointer, pointer + size);
        assert.equal(digest([Buffer.from(JSON.stringify(summary)), bytes(kernel._alloy_surface_vertices_ptr(), vertices * 24),
          bytes(kernel._alloy_surface_vertex_particles_ptr(), vertices * 4), bytes(kernel._alloy_surface_faces_ptr(), faces * 12),
          bytes(kernel._alloy_surface_face_regions_ptr(), faces * 8), bytes(kernel._alloy_surface_regions_ptr(), regions * 32)]), baseline.hash,
        'All original BDEL buffers and summary are byte-exact, also after PDEL reuse.');
      }
      kernel._alloy_surface_dispose();
    }
  } finally {
    kernel._alloy_surface_dispose(); kernel._free(positions); kernel._free(cell); kernel.PThread?.terminateAllThreads();
  }
});
