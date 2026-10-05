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
**Cancel** stops the Worker and clears this tool's calculated network without
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

This first version runs the full numerical algorithm in one dedicated CPU
WebAssembly Worker. The interface remains responsive and cancellation terminates
that Worker. It works on static hosts without shared-memory headers.
**Enable GPU acceleration** currently uses this CPU path for DXA. There is no
DXA GPU speedup claim; local correspondence, edge tests and smoothing remain
future GPU migration stages.

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
DXA network is cached. Cancel and source reset release its Worker and Wasm heap.

## Implementation

[CPU kernel](https://github.com/Yazhuo-Liu/AlloyView/blob/main/wasm/dxa.cpp),
[Worker client](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/dxa-client.js),
[line renderer](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/dislocation-layer.js).
The [source review](../DXA_REVIEW.md) records the algorithm, pinned upstream
source, per-file MIT option and Geogram BSD license. Preserve all upstream
notices when rebuilding the numerical module.
