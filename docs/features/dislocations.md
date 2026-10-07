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
Isolation does not make every extraction step parallel. With more than one
native thread, Delaunay construction uses Geogram's parallel **PDEL** engine;
one thread uses **BDEL**. The full tessellation still needs global coordination,
while cluster merging, ordered mesh connectivity, Burgers-circuit tracing and
line/junction processing retain serial work. The isolated route uses
pthreads directly and skips private local-stage snapshot offload.
The application limits active CPU concurrency to
`max(1, navigator.hardwareConcurrency - 2)`, shared with ordinary analyses;
atom count and memory limits can reduce the selected count. Reported logical
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
ArrayBuffer transfer avoids an additional
message copy but moves ownership; preparing snapshots and importing them into
worker-local Wasm still costs time and memory. The original viewer coordinates
remain attached. See [MDN transferable
objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects).
Small inputs, an explicit one-worker request, memory limits or unavailable
Workers retain the native CPU stages. Failed local-stage tasks fall back to the
corresponding native stage and report the reason; cancellation returns no
partial network.
Each private chunk has a **30 s** deadline. Constructor errors, malformed replies
or a Worker that never finishes its task cancel that stage's outstanding jobs
before native fallback. A later calculation retries healthy Workers rather than
permanently disabling independent-stage execution.
Automatic private-stage execution uses at most **four Workers**, further
limited by CPU permits, work size and measured retained heaps. This leaves
room for the larger tetrahedron snapshots and avoids rebuilding the full local
neighbor index in too many private heaps. An explicit development worker-count
request still respects concurrency and memory limits; the four-Worker default
does not limit the isolated pthread route.

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
one heap across concurrency changes. [CPU profiles](../DXA_CPU_PROFILE.md)
retain earlier measurements; they are device-specific records.

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
[line renderer](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/dislocation-layer.js).
The [source review](../DXA_REVIEW.md) records the algorithm, pinned upstream
source, per-file MIT option and Geogram BSD license. Preserve all upstream
notices when rebuilding the numerical module.
