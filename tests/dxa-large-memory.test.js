import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateDxa, releaseDxaKernels, runDxaKernelTask } from '../src/analysis/dxa.js';
import { calculateSurfaceMesh } from '../src/analysis/surface-mesh.js';
import { crystalFrame } from './helpers/crystals.js';
import { periodicDistance, subsetFrame } from './helpers/surfaces.js';

const HIGH_ADDRESS = 2 ** 31;
const frame = subsetFrame(crystalFrame('fcc', 6), point => periodicDistance(point, [12, 12, 12], 24) > 5.5);

for (const shared of [false, true]) {
  test(`${shared ? 'shared' : 'private'} DXA and surface read real allocations above 2 GiB`, async () => {
    await releaseDxaKernels();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer');
    let module, reservation = 0;
    const originals = new Map(), observed = new Set();
    try {
      // Exercise both shipped kernels through the production JavaScript API.
      if (!shared) Object.defineProperty(globalThis, 'SharedArrayBuffer', { ...descriptor, value: undefined });
      await runDxaKernelTask({ atomCount: frame.ids.length, workerCount: 1 }, async (kernel, state) => {
        module = kernel;
        assert.equal(state.metadata().sharedMemory, shared);
        // Reserve address space without touching its pages. Only the small
        // crystal and allocator metadata consume physical memory in this test.
        reservation = module._malloc(HIGH_ADDRESS) >>> 0;
        assert.ok(reservation, 'the shipped kernel must support growth above 2 GiB');
        assert.ok(module.HEAPU8.byteLength > HIGH_ADDRESS);
      });
      const pointerExports = ['_malloc', '_alloy_dxa_finish', '_alloy_dxa_result_labels_ptr',
        '_alloy_dxa_defect_vertices_ptr', '_alloy_dxa_defect_triangles_ptr',
        '_alloy_surface_construct', '_alloy_surface_vertices_ptr', '_alloy_surface_vertex_particles_ptr',
        '_alloy_surface_faces_ptr', '_alloy_surface_face_regions_ptr', '_alloy_surface_regions_ptr'];
      for (const name of pointerExports) {
        const original = module[name];
        originals.set(name, original);
        module[name] = (...args) => {
          const pointer = original(...args) >>> 0;
          assert.ok(pointer >= HIGH_ADDRESS, `${name} must exercise an actual address above 2 GiB`);
          observed.add(name);
          // Wasm i32 returns can be signed even when their C type is a pointer.
          return pointer | 0;
        };
      }
      const dxa = await calculateDxa(frame, {}, { workerCount: 1, defectMesh: { smoothingLevel: 0 } });
      assert.equal(dxa.atomStructureTypes.length, frame.ids.length);
      assert.ok(dxa.atomStructureTypes.includes(0) && dxa.atomStructureTypes.includes(1));
      assert.ok(dxa.defectMesh.vertexCount > 0 && dxa.defectMesh.triangleCount > 0);
      const surface = await calculateSurfaceMesh(frame, { radius: 3, smoothingLevel: 0 },
        { workerCount: 1, mask: new Uint8Array(frame.ids.length).fill(1) });
      assert.ok(surface.vertexCount > 0 && surface.faceCount > 0);
      assert.deepEqual(observed, new Set(pointerExports));

      for (const [name, original] of originals) module[name] = original;
      originals.clear();
      module._free(reservation);
      reservation = 0;
      // The same computations at ordinary addresses must preserve all binary
      // geometry and labels, including signed region/structure data.
      const ordinaryDxa = await calculateDxa(frame, {}, { workerCount: 1, defectMesh: { smoothingLevel: 0 } });
      assert.deepEqual(dxa.atomStructureTypes, ordinaryDxa.atomStructureTypes);
      assert.deepEqual(dxa.defectMesh.vertices, ordinaryDxa.defectMesh.vertices);
      assert.deepEqual(dxa.defectMesh.triangles, ordinaryDxa.defectMesh.triangles);
      assert.deepEqual(dxa.segments, ordinaryDxa.segments);
      const ordinarySurface = await calculateSurfaceMesh(frame, { radius: 3, smoothingLevel: 0 }, { workerCount: 1 });
      for (const name of ['vertices', 'vertexAtoms', 'triangles', 'faceRegions', 'regionVolumes', 'regionAreas']) {
        assert.deepEqual(surface[name], ordinarySurface[name], name);
      }
    } finally {
      for (const [name, original] of originals) module[name] = original;
      if (reservation) module._free(reservation);
      await releaseDxaKernels();
      if (descriptor) Object.defineProperty(globalThis, 'SharedArrayBuffer', descriptor);
    }
  });
}
