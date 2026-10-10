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
Line radius controls a connected tube surface, with shared rings and smooth
display interpolation at bends. Closed loops share their closing ring;
periodic joins use matching frames in the full triclinic cell. Display pieces
cut by periodic boundaries have filled end faces, so they appear as solid rods
from either end. These display
changes reuse the computed network and preserve its coordinates, measured
length, Burgers vectors and junction topology.
Extraction adds **Crystal structure (DXA)** to **Color by**, including when no
lines are found. Its crystal-class checkboxes control atom visibility; the
separate **Crystal visibility** selector also applies those labels while
coloring by CSP, strain or another quantity. Burgers-family controls affect
lines independently of these atom filters.
**Cancel** stops extraction and clears this tool's calculated network without
removing other analyses. Configuration export/import includes DXA processing
and display settings; restoring an enabled tool recomputes its network.

## Defect mesh

**Output defect mesh** adds OVITO's *defect mesh* to the extraction: the
closed surface around every region that is not the reference crystal and was
not resolved into a dislocation line. It shows grain boundaries, stacking
faults, precipitates of another structure and free surfaces. It is off by
default, so extractions run and time as before unless it is switched on.

The mesh is built from DXA's interface mesh after tracing: faces swept by
Burgers circuits are removed, the openings at dislocation ends are closed
with fans to the line ends, and the result is smoothed with **Mesh smoothing
level** iterations of the Taubin filter (default 8, as in OVITO; λ = 0.5,
pass-band 0.1) before the lines themselves are smoothed. The dislocation
network, Burgers vectors and atom labels are the same with and without the
mesh: with one thread they are bit-identical, on both kernels and through the
Worker. Generating it takes 5–14 ms for the 28,800-atom HEA example (4,384
triangles) and for the 60,229-atom Fe loop, within the run-to-run variation
of the extraction.

Switching the mesh on, or changing its smoothing level, starts a new
extraction; switching it off only hides it. **Show defect mesh**, the
**Crystal side**, **Defect side** and **Caps** colors, **Opacity** and **Cap
the defect regions at periodic cell faces** only change the display. As in
OVITO, the defect region is the solid side of the mesh: it is drawn and capped
like a [surface mesh](surface-mesh.md#display-and-periodic-caps), follows the
periodic display origin, crystal drag, display replication and slices, and
appears in the second view and image exports. The space outside a free
surface is a defect region too, so a free surface shows its defect side and,
because that region is unbounded in a cell with open boundaries, has no caps.
**Defect mesh STL** and **Defect mesh PLY** save the displayed mesh.

The panel reports the triangle count and surface area; the area is also the
`DXA.defect_mesh_area` global attribute and the `defect_mesh_area` row of the
statistics summary and the family statistics CSV. A frame whose defect
regions were all resolved into lines, such as the Fe loop example, has no
defect mesh. If the kernel cannot close the mesh, the panel says so and the
dislocation result is kept. The configuration stores the request and style in
`settings.extensions.dxa.defectMesh` (`enabled`, `smoothingLevel` 0–100,
`visible`, `caps`, `opacity`, `color`, `interiorColor`, `capColor`), written
only once the mesh has been used; older recipes leave it off.

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

## CPU execution and worker pools

DXA runs the complete extraction on CPU WebAssembly. The global GPU preference
controls other analyses and does not select a DXA backend, rerun DXA or remove
its completed result. The network is still drawn with the WebGL 2 renderer.

One dedicated WebAssembly Worker owns one Wasm module and heap containing the
complete structure, tessellation and network. On an isolated host, a pthread
pool shares that heap. Threads divide independent atom, cell and facet work;
they do not clone the complete DXA computation once per atom or extract
separate networks from arbitrary atom chunks. Cluster construction and ordered
graph/topology operations retain their required global coordination.

Local crystal identification, robust periodic Delaunay insertion, ghost-cell
and interface-cell classification, and bounded interface preparation can use
shared-memory threads. Final interface faces retain their original order.
Edge construction prepares immutable candidate masks in parallel and commits
deduplicated edges in the original cell/edge order. Edge-to-lattice mapping
uses a private path finder per thread and bounded result batches. Searches
requiring a new cluster-graph transition are deferred to the ordered commit,
so parallel workers never mutate the graph's transition cache. Cheap direct
neighbors within one crystal cluster bypass batch staging; small search tails
run serially to avoid scheduling overhead. The result's `parallelEdgePasses`
reports candidate cells, direct paths, searched edges, batches and deferred
searches. Temporary mapping storage is capped at 262,144 edges (about 3 MiB);
the reusable native heap
and pthread pool are retained.
Isolation does not make every extraction step parallel. With more than one
native thread, Delaunay construction uses Geogram's parallel **PDEL** engine;
one thread uses **BDEL**. The full tessellation still needs global coordination,
while cluster merging, ordered mesh connectivity, Burgers-circuit tracing and
line/junction processing retain serial work. The isolated route uses
pthreads directly and skips private local-stage snapshot offload.
The application limits active CPU concurrency to
`max(1, navigator.hardwareConcurrency - 2)`, shared with ordinary analyses.
DXA requests one native thread per 2,048 atoms within that limit; atom count and
memory limits can reduce the selected count. Reported logical
processors are not a guarantee of physical cores or reserved OS cores.

The runtime automatically selects the threaded kernel when cross-origin
isolation and SharedArrayBuffer are available. Without them, sufficiently large
jobs with at least **8,192 atoms** and capacity for two stage Workers can send
local crystal identification and tetrahedron classification to
the existing CPU analysis Worker pool. These tasks process ranges from the same
complete input and global tessellation, then return local results to the DXA
coordinator. The coordinator retains the full network and runs the ordered
global stages; independent Workers do not trace separate dislocation networks.
Local tasks use the same native crystal-correspondence implementation, including
the input lattice and perfect-only setting. Tetrahedron tasks apply the native
interface classifier to the complete packed periodic connectivity; coordinates
and crystal-frame transitions retain binary64 precision. They do not replace
DXA's local recognition with CNA or PTM labels.
It releases its CPU reservation while pool tasks run, then reserves one slot
before continuing native work, so both kinds of work share the same CPU budget.

Each selected private Worker receives one complete immutable input snapshot,
builds its local geometry/index or imports the packed tetrahedron tables, then
processes bounded disjoint output ranges. Further chunks reuse that resident
input. This duplicates stage inputs per Worker, not per atom, and does not
duplicate complete dislocation extraction. Private tasks need copied snapshots
and temporary result buffers, unlike pthreads sharing one heap.
The DXA Worker keeps each stage input: the coordinates, or the tetrahedron
tables packed in its native heap. The page sends it only the stage
dimensions and, for each selected Worker, one end of a new `MessageChannel`;
the DXA Worker answers that port with a transferred private copy. The page
thread therefore copies no stage input. ArrayBuffer transfer avoids an
additional message copy but moves ownership; packing the tables, copying them
once per Worker and importing them into worker-local Wasm still cost time and
memory. The original viewer coordinates remain attached. See [MDN transferable
objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects).
Small inputs, an explicit one-worker request, memory limits or unavailable
Workers retain the native CPU stages. Failed local-stage tasks fall back to the
corresponding native stage and report the reason; cancellation returns no
partial network.
Each private chunk has a **30 s** deadline. Constructor errors, malformed replies
or a Worker that never finishes its task cancel that stage's outstanding jobs
before native fallback. A later calculation retries healthy Workers rather than
permanently disabling independent-stage execution.
Automatic private-stage execution uses one Worker per 4,096 atoms, at most
**eight** for local crystal identification and **four** for tetrahedron
classification, further limited by CPU permits, work size and measured
retained heaps. A local-stage copy needs 24 bytes per atom plus the Worker's
own neighbor index; a tetrahedron-table copy needs about 850 bytes per atom
(23 MiB for the 28,800-atom HEA example). An explicit development
worker-count request applies to both stages and still respects concurrency
and memory limits; these caps do not limit the isolated pthread route.

Private inputs and lookup tables stay resident only while chunks of the same
stage need them. At the stage's end, its snapshots, native tables, session and
temporary output buffers are released; completed native extraction and
serialization buffers are also disposed after the result is copied out.
The returned JavaScript result remains available for rendering and export.
Workers, initialized Wasm modules and grown heap capacity stay reusable, rather
than retaining old-frame stage inputs. Freeing allocations makes space reusable
inside the heap; it does not shrink `WebAssembly.Memory`. Retaining the module
avoids another startup, while terminating its Worker trades that reuse for
release of the whole instance. See [MDN Memory.grow](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory/grow).
The analysis pool's separate Voronoi preparation deliberately retains current
source input for later analyses; it is not a retained DXA stage snapshot.

A threaded module or pthread-pool initialization failure on an isolated host
retains the complete one-thread CPU path and reports its reason. A pool failure
can retain an already initialized shared heap while running serially. The
status distinguishes global native threads from the peak number of local-stage
Workers; its tooltip shows individual stage counts, native timings and fallback
reasons. See [deployment](../DEPLOYMENT.md#cross-origin-isolation-and-cloudflare-pages)
for host headers and their effects.

File loading and physical replication prewarm and grow reusable CPU pools.
Display-only copies need no additional analysis threads. Repeated calculations
and ordinary source changes reuse the initialized Wasm module and its heap;
lowering the active thread count keeps initialized idle pthreads for reuse.
For structures of at least **8,192 atoms**, preparation then extracts one
built-in 2,560-atom FCC screw dislocation on at most two threads and discards
the result. Browsers compile WebAssembly functions lazily and optimize a
long-running function only for later calls, so without this step the first
extraction in a page took about 1.6 times as long as later ones: 930 versus
580 ms for the HEA example with eight threads on the reference machine,
in Chrome as in Node. The warm-up takes about 270 ms of background CPU time,
once per DXA Worker and thread mode (one or several threads), and holds only
the permits of the threads it uses. A foreground extraction preempts it;
without shared memory it first waits for the current half of the warm-up
(its native topology or interface part). A completed extraction also counts
as warm. The warm-up does not change any result.
Shared-memory cancellation is cooperative and preserves the pthread pool.
Private stage tasks follow the analysis pool's cancellation path. Without
shared control memory, cancelling synchronous native work terminates its
coordinator Worker. The interface clears cancelled results immediately; a
parallel native stage can need time to join its threads before the CPU
reservation is released.

## Benchmark and verification

`npm run benchmark:dxa -- --workers 1` measures cold and warm complete CPU
extraction on the NiGB example physically repeated twice along Z. Repeat with
`--workers 2` or `--workers 4`. The retained-heap benchmark
`npm run benchmark:dxa-cpu -- --dataset all --threads 1,2,4,1 --repetitions 2`
records native stage times and scientific label/topology checks while reusing
one heap across concurrency changes. Each result also lists `hostTimings`:
kernel and pool readiness, input conversion and upload, and result decoding.
[CPU profiles](../DXA_CPU_PROFILE.md) retain earlier measurements; they are
device-specific records.

`npm run test:browser:dxa-parallel -- --software` checks both isolated pthreads
and ordinary nonisolated CPU stage offload, including initialization failures, pool reuse,
cancellation and recovery. `npm run test:browser:dxa -- --software` checks the
production UI and private-stage execution; add `--isolated` for pthread hosting.
Neither CPU test requires a WebGPU adapter. Software graphics is used only for
rendering checks and is not a CPU performance claim.

`npm run test:browser:fe-loop -- --software --workers=2` compares cold and warm
global serial extraction with first and repeated private-stage runs on the
complete **60,229-atom Fe loop**. Use `--workers=auto` to measure the application's
automatic choice; add `--isolated` for pthread hosting. It records complete wall
time, per-stage timing, copied bytes and native initialization counts alongside
atom-label, Burgers-vector and closed-loop checks. Compare warmed total time as
well as the local stages: faster local work can be outweighed by startup,
copying or the remaining global extraction.

For an alternating CPU comparison with earlier binaries, use
`npm run benchmark:dxa-compare -- --baseline-ref d6f9010`. The script reads the
baseline into a temporary directory, retains each backend's heap and verifies
the physical output. Earlier DXA GPU experiments and their numerical records
remain historical in the [implementation review](../DXA_REVIEW.md); they are
not an available backend.

## Limitations

Both DXA kernels are compiled with WebAssembly SIMD and native WebAssembly
exceptions, so DXA needs Chrome 95, Firefox 100 or Safari 16.4 or newer (the
rest of AlloyView has no such requirement).

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
[CPU execution](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/dxa.js),
[private stage scheduling](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/dxa-cpu-pool.js),
[private native stage kernels](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/dxa-cpu-stages.js),
[line renderer](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/dislocation-layer.js),
[defect mesh display](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/surface-mesh-layer.js).
The [source review](../DXA_REVIEW.md) records the algorithm, pinned upstream
source, per-file MIT option and Geogram BSD license. Preserve all upstream
notices when rebuilding the numerical module.
