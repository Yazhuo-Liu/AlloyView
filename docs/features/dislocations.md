# Dislocation analysis (DXA)

## Controls

Open **DXA** in Tools, select the reference crystal and choose **Extract**.
The initial implementation supports FCC, BCC, HCP, cubic diamond and hexagonal
diamond through a headless port of OVITO's v3.9.4 extraction core. It assumes one
input crystal family; related stacking-fault and twin environments are handled
by that core's crystallographic transformations.

**Trial circuit length** defaults to 14 atom-to-atom steps and **Circuit
stretchability** to 9 additional steps. These are search limits, not distance
cutoffs. Increasing them can find more complex dislocations but increases work.
**Perfect dislocations only** excludes partial dislocations from extraction.
**Line smoothing** defaults to one iteration; **Point separation** defaults to
2.5 nearest-neighbor spacings and controls line coarsening.

Each Burgers-vector family has an independent visibility checkbox and color.
Line radius controls the drawn cylinders. These display changes reuse the
computed network. Atom coloring and visibility remain available independently.
**Cancel** stops extraction and clears this tool's calculated network without
removing other analyses. Configuration export/import includes DXA processing
and display settings; restoring an enabled tool recomputes its network.

## Algorithm

DXA identifies ordered local lattice environments and their crystal orientation
relationships. It constructs a periodic three-dimensional Delaunay tessellation,
maps its edges to vectors of the ideal lattice and builds an interface separating
consistent crystal regions from defect regions. Burgers circuits on that
interface detect lattice closure failures and trace curves through dislocation
cores, including junctions and periodic segments. The result includes line
geometry, Burgers vectors and connectivity rather than a per-atom defect label.

Total length and density use the complete analyzed network before display
clipping and replication. Density is line length divided by simulation-cell
volume, in inverse squared input length units. Hiding a family, slicing the
view or adding display copies does not change these source statistics.
Curves are split at periodic cell boundaries using the full triclinic cell and
clipped against enabled slices for drawing and image export.

## CPU and GPU

The numerical algorithm runs in a dedicated CPU WebAssembly Worker. On hosts
with cross-origin isolation and SharedArrayBuffer, large frames automatically
use shared-memory computation threads. The application concurrency limit is
`max(1, navigator.hardwareConcurrency - 2)`; the browser reports available
logical processors, which may differ from physical cores or the host total.
This limit does not pin or reserve particular OS cores. The actual thread count
depends on atom count and memory limits, and DXA shares the active concurrency
budget with ordinary CPU analyses. Local crystal identification, robust periodic Delaunay
tessellation and independent cell classification run in parallel in one heap.
Small structures and static hosts without the required headers use the complete
serial kernel.

The progress text and final status show the selected thread count. Hover over
the final status to see individual phase timings. File loading prewarms analysis
modules while the parser works, then grows the reusable pools to suit the parsed
atom count. Physical replication prewarms additional threads while generating
the larger structure; display-only replication adds no analysis threads.
Repeated calculations and ordinary source changes reuse the initialized pools
and Wasm memory. The shared-memory backend cancels cooperatively and retains its
threads; cancelling a running serial kernel requires terminating its Worker.
The interface clears a cancelled result immediately. Parallel Delaunay
insertion finishes its current stage before acknowledging cancellation, so the
CPU reservation remains held until its threads have joined safely.
For a controlled CPU timing comparison, run `npm run benchmark:dxa -- --workers
1` and repeat with `--workers 2` or `--workers 4`. This benchmark physically
replicates the NiGB example twice along Z and reports cold and warm phase times.

**Enable GPU acceleration** currently uses this CPU path for DXA. A complete
GPU extraction backend needs new robust geometry and graph kernels. Its large
intermediate arrays can remain on the GPU, with one final network readback for
the current WebGL2 renderer. The [GPU design](../DXA_REVIEW.md) describes the
resident pipeline and numerical requirements. WebGPU rendering is not required
for this analysis path.

## Limitations

DXA requires a three-dimensional cell and sufficient periodic thickness.
`NiGB_minimized.cfg` has a thin Z direction: enable **Replicate atoms for
analysis** and repeat Z twice before extraction. Display-only replication does
not change the analysis input. Other configurations may need different repeats.

This is an initial implementation awaiting broader validation with user
configurations. It uses the historical v3.9.4 core and does not include the
later HCP low-c/a correction. It is not a general classifier of unrelated
FCC/BCC phase interfaces. Species are ignored; a zero-line result does not
establish that the configuration has no defects. Large systems require memory
for tessellation and graph topology in addition to their atom coordinates.
Segment IDs are local to one extraction and do not track lines across frames.
The initial memory preflight estimates 32 MiB plus 3 KiB per atom against a
1.5 GiB job budget, independently of the renderer and GPU cache. This is a
conservative estimate, not a measured peak-memory guarantee; jobs exceeding it
are rejected before extraction rather than analyzed partially. Only the latest
DXA network is cached. Idle pools and Wasm heap capacity remain available for
reuse until backend shutdown or page closure.

## Implementation

[CPU kernel](https://github.com/Yazhuo-Liu/AlloyView/blob/main/wasm/dxa.cpp),
[Worker client](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/dxa-client.js),
[line renderer](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/dislocation-layer.js).
The [source review](../DXA_REVIEW.md) records the algorithm, pinned upstream
source, per-file MIT option and Geogram BSD license. Preserve all upstream
notices when rebuilding the numerical module.
