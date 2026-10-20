import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { after } from 'node:test';
import { dxaCartesianCoordinates } from '../src/analysis/dxa.js';
import { createCell } from '../src/data/model.js';
import { fccScrewFrame } from './helpers/dislocations.js';
import { fccBlock, periodicDistance, subsetFrame, withCell } from './helpers/surfaces.js';

// Recorded from ea9245d's production binaries before K4's edge/workspace/mesh
// changes. Both binaries and four-thread downstream stages produced these same
// hashes. Delaunay stays serial so its pre-existing parallel tie choices cannot
// hide changed edge orientation, cluster transitions, mesh IDs or line order.
const expected = {
  screw: {
    snapshot: 'c3a35faa43b42ac4752cb9bff6e239f0e6380a120445bfc48fd420c27265faa8',
    network: '66defc89243418d1343a79e83fcfbf14c974b2739494929566d52f92b34f4354',
    counts: [6482, 39049, 18660, 1], segments: 1,
  },
  largeScrew: {
    snapshot: '1847257c3f4a134904525336faf15d2800c9a40508d18cafe68282a1b8330b24',
    network: 'ea69a5d403d85235f3525c49e19331b97c526378a48c0fc729cb3a46cfc7199c',
    counts: [7430, 44765, 42655, 1], segments: 1,
  },
  twins: {
    snapshot: '889cf1f4b0e87d5530bf4082a3b902a2f2208cba8e5b44542f10bd9f8c6eba94',
    network: '9e4876ab150fee8e6876033f27dc5a0f962a0fd803fd25f78b1d051aa9dfa781',
    counts: [15191, 90993, 21505, 9], segments: 0,
  },
  triclinicVoid: {
    snapshot: '2eb14fc4fbf8438bfb9213065f8ed1413ed80889ff165bb1326ba2b1d0936b1c',
    network: '3e613e232c3411e0ecbcf07646e8c65f3d957706361d9abf6ea60e4014b5f839',
    surface: 'fb36c550bfd5436e2ef8d855ba42dbb9861f5513b9351bcc0fc9789d385b2394',
    counts: [9401, 56713, 13966, 1], segments: 0,
  },
};

function twins() {
  const side = 16, layers = [0, 1, 2, 0, 1, 2, 0, 2, 1, 0, 2, 1];
  const a = 3.52, spacing = a / Math.SQRT2;
  const fractional = new Float64Array(side * side * layers.length * 3);
  let cursor = 0;
  for (let layer = 0; layer < layers.length; layer++)
    for (let x = 0; x < side; x++) for (let y = 0; y < side; y++) {
      const shift = layers[layer] / 3;
      fractional[cursor++] = (x + shift) / side;
      fractional[cursor++] = (y + shift) / side;
      fractional[cursor++] = layer / layers.length;
    }
  return { fractional, cell: createCell({ vectors: [side * spacing, 0, 0,
    side * spacing / 2, side * spacing * Math.sqrt(3) / 2, 0,
    0, 0, layers.length * a / Math.sqrt(3)], pbc: [true, true, true] }) };
}

function triclinicVoid() {
  const side = 8 * 3.52;
  const frame = subsetFrame(fccBlock(8, 3.52), point => periodicDistance(point, [0, 0, 0], side) > 5.5);
  return withCell(frame, [side, 0, 0, side * .05, side, 0, side * .03, side * .02, side], { origin: [-3, 5, 7] });
}

function hash(parts) {
  const digest = createHash('sha256');
  for (const part of parts) {
    const bytes = typeof part === 'string' ? Buffer.from(part) : part;
    digest.update(String(bytes.byteLength)); digest.update(':'); digest.update(bytes);
  }
  return digest.digest('hex');
}

const fixtures = [['screw', () => fccScrewFrame({ nx: 16, ny: 14, nz: 6 })],
  // This narrow, long sample has 31,806 filled cells and 2,584 surface faces.
  // Exercise the larger mesh through serial/parallel classification and back
  // to serial extraction in the same retained heap.
  ['largeScrew', () => fccScrewFrame({ nx: 8, ny: 10, nz: 38 })],
  ['twins', twins], ['triclinicVoid', triclinicVoid]];
const parallelPhases = ['Build tessellation edges', 'Map edges to the ideal lattice', 'Construct crystal interface mesh'];

for (const suffix of ['', '-threaded']) {
  let kernel, parallel = false, meshOnly = false, cancelPhase = null, cancellationReached = false;
  const ready = (async () => {
    const createDxa = (await import(`../src/analysis/dxa-kernel${suffix}.mjs`)).default;
    kernel = await createDxa({
      wasmBinary: await readFile(new URL(`../src/analysis/dxa-kernel${suffix}.wasm`, import.meta.url)),
      dxaPoolSize: suffix ? 3 : 0,
      onDxaProgress(phase) {
        const concurrent = meshOnly ? phase === 'Construct crystal interface mesh' : parallelPhases.includes(phase);
        kernel._alloy_dxa_set_threads(parallel && concurrent ? 4 : 1);
        if (phase === cancelPhase) {
          cancellationReached = true;
          kernel.HEAP32[kernel._alloy_dxa_cancel_ptr() / 4] = 1;
        }
      },
      onSurfaceProgress(phase) {
        kernel._alloy_dxa_set_threads(parallel && phase === 'Classify tetrahedra and build the surface' ? 4 : 1);
      },
    });
    return kernel;
  })();
  after(async () => { (await ready).PThread?.terminateAllThreads(); });

  for (const [name, fixture] of fixtures) {
    test(`K4 DXA${suffix} keeps baseline ${name} snapshots, scientific output and mesh order`, async () => {
      await ready;
      const frame = fixture(), xyz = dxaCartesianCoordinates(frame);
      const positions = kernel._malloc(xyz.byteLength), cell = kernel._malloc(96);
      assert.ok(positions && cell);
      kernel.HEAPF64.set(xyz, positions / 8); kernel.HEAPF64.set(frame.cell.vectors, cell / 8);
      kernel.HEAPF64.set(frame.cell.origin, cell / 8 + 9);
      const pbc = frame.cell.pbc.reduce((bits, enabled, axis) => bits | (enabled ? 1 << axis : 0), 0);
      const args = [positions, xyz.length / 3, cell, pbc, 1, 14, 9, 0, 1, 2.5];
      const bytes = (pointer, size) => kernel.HEAPU8.slice(pointer, pointer + size);
      const error = () => kernel.UTF8ToString(kernel._alloy_dxa_last_error());
      const begin = () => {
        kernel._alloy_dxa_reset_cancel(); kernel._alloy_dxa_set_threads(1);
        kernel._alloy_dxa_defect_mesh(1, 0);
        assert.equal(kernel._alloy_dxa_begin(...args), 1, error());
      };
      const finish = () => {
        const pointer = kernel._alloy_dxa_finish();
        assert.ok(pointer, error());
        const raw = JSON.parse(kernel.UTF8ToString(pointer));
        delete raw.parallelEdgePasses;
        assert.equal(raw.segments.length, expected[name].segments);
        assert.equal(hash([JSON.stringify(raw),
          bytes(kernel._alloy_dxa_defect_vertices_ptr(), kernel._alloy_dxa_defect_vertex_count() * 24),
          bytes(kernel._alloy_dxa_defect_triangles_ptr(), kernel._alloy_dxa_defect_triangle_count() * 12)]),
        expected[name].network, 'Full network, labels, junctions, defect coordinates and triangle IDs match the archived baseline.');
        if (name === 'twins') {
          assert.ok(raw.atomStructureTypes.includes(1) && raw.atomStructureTypes.includes(2),
            'The fixture exercises distinct FCC/HCP reference frames.');
        }
      };
      try {
        meshOnly = name === 'largeScrew';
        // The final serial pass also detects stale classification or topology
        // state retained across analyses in the same native heap.
        const modes = suffix ? (meshOnly ? [false, true, false] : [false, true]) : [false];
        for (parallel of modes) {
          begin();
          assert.equal(kernel._alloy_dxa_worker_snapshot(128 * 1024 ** 2), 1, error());
          const counts = [kernel._alloy_dxa_worker_vertex_count(), kernel._alloy_dxa_worker_tet_count(),
            kernel._alloy_dxa_worker_edge_count(), kernel._alloy_dxa_worker_transition_count()];
          assert.deepEqual(counts, expected[name].counts);
          assert.equal(hash([JSON.stringify([...counts, kernel._alloy_dxa_worker_alpha()]),
            bytes(kernel._alloy_dxa_worker_vertex_ptr(), counts[0] * 24),
            bytes(kernel._alloy_dxa_worker_tet_ptr(), counts[1] * 64),
            bytes(kernel._alloy_dxa_worker_edge_ptr(), counts[2] * 32),
            bytes(kernel._alloy_dxa_worker_transition_ptr(), counts[3] * 160)]),
          expected[name].snapshot, 'All snapshot rows retain their original edge directions and transition/vertex/tetrahedron order.');
          kernel._alloy_dxa_release_worker_snapshot();
          finish();
          kernel._alloy_dxa_dispose();

          if (name === 'screw') {
            // Abort after the primary interface and line network exist, then
            // rebuild the same frame in the retained heap and scratch state.
            begin(); cancelPhase = 'Generate defect mesh'; cancellationReached = false;
            assert.equal(kernel._alloy_dxa_finish(), 0);
            assert.ok(cancellationReached);
            assert.match(error(), /cancel/i);
            cancelPhase = null;
            begin(); finish(); kernel._alloy_dxa_dispose();
          }
          if (name === 'triclinicVoid') {
            // Surface shares the changed manifold builder with DXA. Check its
            // complete raw arrays, including atom mapping and region numbering.
            kernel._alloy_dxa_reset_cancel(); kernel._alloy_dxa_set_threads(1);
            const pointer = kernel._alloy_surface_construct(positions, xyz.length / 3, cell, pbc, 0, 3.2, 2);
            assert.ok(pointer, kernel.UTF8ToString(kernel._alloy_surface_last_error()));
            const summary = JSON.parse(kernel.UTF8ToString(pointer));
            const vertices = kernel._alloy_surface_vertex_count(), faces = kernel._alloy_surface_face_count();
            const regions = kernel._alloy_surface_region_count();
            assert.deepEqual([vertices, faces, regions], [32, 60, 2]);
            assert.equal(hash([JSON.stringify(summary),
              bytes(kernel._alloy_surface_vertices_ptr(), vertices * 24),
              bytes(kernel._alloy_surface_vertex_particles_ptr(), vertices * 4),
              bytes(kernel._alloy_surface_faces_ptr(), faces * 12),
              bytes(kernel._alloy_surface_face_regions_ptr(), faces * 8),
              bytes(kernel._alloy_surface_regions_ptr(), regions * 32)]), expected[name].surface);
            kernel._alloy_surface_dispose();
          }
        }
      } finally {
        cancelPhase = null; parallel = false; meshOnly = false;
        kernel._alloy_dxa_dispose(); kernel._alloy_surface_dispose();
        kernel._alloy_dxa_defect_mesh(0, 0); kernel._alloy_dxa_reset_cancel();
        kernel._free(positions); kernel._free(cell);
      }
    });
  }
}
