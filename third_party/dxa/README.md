# OVITO DXA headless port

The dislocation extraction algorithm is derived from **OVITO v3.9.4**, official
repository `https://gitlab.com/stuko/ovito.git`, commit
`939f5d909ea3b0fd0dd6695494da8f8d03821c2e`.

The OVITO files retain their original copyright and dual GPLv3-or-MIT notices.
AlloyView uses the **MIT option**, with the complete license included in
`LICENSE.MIT.txt`. `LICENSE.GPL.txt` is retained for recipients choosing that
option. Geogram has its separate BSD license and original source notices.

`upstream/` contains the complete numerical DXA implementation: local crystal
identification, symmetry permutations and neighbor correspondence, crystal
clusters and transition matrices, ideal elastic mapping, interface construction,
adaptive Burgers circuits, dislocation tracing and junctions, and line smoothing
and coarsening. The Qt pipeline engine and modifier are replaced by tiny include
compatibility headers; their GUI and dataset lifecycle are not part of the port.

`compat/` replaces OVITO's Qt/property/task glue with headless tasks and typed
property storage. Upstream double-precision mathematical and nearest
neighbor routines are kept where possible. `geometry/` contains the periodic
Delaunay/Geogram and half-edge mesh functionality required by DXA. The browser
entry point is `wasm/dxa.cpp`, executed in a dedicated Worker. Isolated hosts
cancel through a shared atomic word, retaining the kernel and pthread pool.
Static hosting without shared memory cancels global synchronous work by Worker
termination; asynchronous private CPU stages can cancel and retain the coordinator.

The optional `dxa-kernel-threaded` binary restores shared-memory parallel loops
through a bounded `std::thread` adapter. Independent atoms use dynamically
scheduled chunks; the coordinator also computes, all workers are joined before
returning, and the first original exception is rethrown on the coordinator.
Task cancellation and progress counters are atomic. Small loops remain serial.
The geometry adapter selects Geogram's robust parallel PDEL tessellator and
provides a bounded thread manager: large sorting groups reuse the same slots,
and nested groups remain serial. Ghost-cell and interface-cell classifications
also run in parallel, with shared topology/index updates reduced sequentially.
The module factory starts one shared heap even for one-thread calculations.
Prewarming asynchronously adds Workers to this same module, loading its existing
compiled Wasm module and memory into each new slot before numerical work begins.
Changing active thread counts never creates another kernel or heap. The pool
grows to the needed capacity and reuses its idle Workers on subsequent analyses.
The browser reserves two reported logical processors, and the client additionally
limits activity according to structure size and the global CPU/memory budget.
This backend requires cross-origin isolation and
SharedArrayBuffer. Static hosts retain one global serial kernel, with optional
private CPU stage Workers for independent local recognition and tetrahedron
classification. Build pthread support with `bash wasm/build-dxa-threaded.sh`.

DXA uses only CPU/Wasm. The staged C ABI retains one complete scientific
pipeline in its heap: `alloy_dxa_begin` validates input and runs crystal
identification, cluster construction, Delaunay tessellation and elastic mapping;
`alloy_dxa_finish` runs native tetrahedron classification, constructs the
interface mesh, traces the dislocation network and serializes it. The optional
private CPU path uses `alloy_dxa_prepare` and `alloy_dxa_import_local` to merge
complete ordered neighbor rows from the unchanged `StructureAnalysis` range
routine. Read-only binary64 geometry/edge/transition tables let CPU Workers run
the native alpha, sliver, Burgers and Frank predicates in `wasm/dxa-classify.cpp`.
Validated, session-owned labels skip only that independent classification loop;
mesh numbering, connectivity and tracing keep their original order. Export
budget or stage failures preserve native CPU fallback. Coordinate/snapshot copies
and private worker heaps are bounded separately from the global topology heap.
Cancellation and session disposal retain warmed modules where possible.

It does not classify defective atoms and substitute their bonds for dislocation
lines. On request (`alloy_dxa_defect_mesh`), `alloy_dxa_finish` also returns
upstream's defect mesh: `InterfaceMesh::generateDefectMesh()` after tracing,
then `SurfaceMeshBuilder::smoothMesh()`, before the lines are smoothed. The
request is off by default and only reads the traced network.

Two adaptations support it. `geometry/SurfaceMeshBuilder` restores upstream's
`smoothMesh()` (Taubin smoothing, from
`src/ovito/mesh/surface/SurfaceMeshBuilder.cpp`) and `edgeVector()` (from
`SurfaceMeshReadAccess.h`) on the headless mesh storage. In
`InterfaceMesh.cpp`, the `OVITO_ASSERT(false)` for a defect mesh that cannot
be closed is replaced by an `Exception`: assertions are live in the Wasm build
and would abort the module, whereas the entry point reports the open mesh and
keeps the dislocation lines. The file is otherwise identical to upstream.

`wasm/surface.cpp` reuses `geometry/` for AlloyView's alpha-shape surface
analysis (after upstream's `ConstructSurfaceModifier` alpha-shape engine):
`DelaunayTessellation`, the one-sided `ManifoldConstructionHelper`,
`makeManifold()` and `smoothMesh()`. Its filled and empty regions follow the
definitions of upstream's `formFilledRegions()` and `formEmptyRegions()` with
AlloyView's own bookkeeping; see `docs/features/surface-mesh.md`. It is
compiled into both DXA binaries and does not change the DXA code path.

`UPSTREAM_SHA256SUMS` records the original core files before the headless port.
`SHA256SUMS` verifies the vendored and adapted sources used by `wasm/build-dxa.sh`.
Rebuild with Emscripten by running `bash wasm/build-dxa.sh` from the repository.
The build maps the checkout directory to `.` in embedded source paths
(`-ffile-prefix-map`), so the binaries do not depend on where it is checked out.

This version predates OVITO 3.15's low-c/a HCP correction. HCP and diamond retain
the capabilities and limitations of the pinned release; new datasets require
comparison with an independent reference. Runtime settings use one input lattice
per analysis, matching the original algorithm.
