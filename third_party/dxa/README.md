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
Static hosting without shared memory uses Worker termination for cancellation.

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
SharedArrayBuffer; static hosts without the required headers retain the complete
serial implementation. Build it with `bash wasm/build-dxa-threaded.sh`.

The initial backend is CPU/Wasm. GPU acceleration requests deliberately use this
complete CPU implementation until scientifically equivalent GPU stages exist.
It does not classify defective atoms and substitute their bonds for dislocation
lines. Defect surface output is not currently returned by the entry point.

`UPSTREAM_SHA256SUMS` records the original core files before the headless port.
`SHA256SUMS` verifies the vendored and adapted sources used by `wasm/build-dxa.sh`.
Rebuild with Emscripten by running `bash wasm/build-dxa.sh` from the repository.

This version predates OVITO 3.15's low-c/a HCP correction. HCP and diamond retain
the capabilities and limitations of the pinned release; new datasets require
comparison with an independent reference. Runtime settings use one input lattice
per analysis, matching the original algorithm.
