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

`compat/` replaces OVITO's Qt/property/task glue with a headless sequential task
and typed property storage. Upstream double-precision mathematical and nearest
neighbor routines are kept where possible. `geometry/` contains the periodic
Delaunay/Geogram and half-edge mesh functionality required by DXA. The browser
entry point is `wasm/dxa.cpp`, executed in a dedicated Worker. Cancellation
terminates that Worker, so static hosting does not require shared Wasm memory.

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
