# Performance

## What the metrics show

The performance panel reports the current render/analysis timing and trajectory cache. Atom count, active overlays, number of displayed replicas, canvas resolution and the available GPU all affect interaction speed. Analysis timing includes different stages from drawing and should be interpreted separately.

## Workers and memory

The structure Worker coordinates indexing and a reusable parser pool. A
foreground parser is reserved for the requested frame; a bounded background
pool parses nearby frames in parallel. Complete frames become available while
the remaining trajectory is indexed. Parsers convert the atom rows of LAMMPS
dumps, CFG and XYZ files directly from their bytes, with the same values and error
messages as line-based parsing, and decompress gzip input; see
[supported formats](../FORMATS.md#trajectory-memory-behavior) for the exactness
rules and the memory used by `.gz` trajectories. Analyses share a bounded scheduler and
process independent central-atom ranges in module Workers. The shared CPU
budget follows the browser's reported logical processor count:
`max(1, floor(navigator.hardwareConcurrency) − 2)`. An eight-processor report
allows up to six computation threads; a sixteen-processor report allows up to
fourteen. This controls application concurrency rather than reserving OS cores.
Actual Worker counts adapt to atom count and memory estimates, which can reduce
parallelism below that maximum. Idle prewarmed Workers hold no computation
budget. Parsing, physical replication, ordinary analyses and DXA share the
budget, and foreground work takes priority over queued background preparation.
Cancelling a parser request rejects the caller and removes queued work
immediately. A parser already inside its synchronous numerical loop finishes
before its result is discarded and its CPU permit is released; its Worker is
reused for the next request. Physical replication yields between bounded
batches and can stop cooperatively without recreating its Worker.

Cross-origin isolation enables shared CPU coordinate snapshots and linked-cell
neighbor indices through `SharedArrayBuffer`. An analysis Worker builds the
index once; subsequent compatible analyses and chunks read the same arrays.
It requires the appropriate isolation response headers;
a secure context alone does not enable shared CPU memory. Without isolation,
each Worker keeps a bounded private coordinate copy and resident index.
Preparation yields to the UI thread, and resident snapshots avoid copying the
complete structure again for every atom chunk. Bounded chunks are claimed
dynamically. Scientific reductions retain their original logical atom partitions
and accumulation order. Coordinate, type or cell changes invalidate retained
inputs; closing the source releases them while preserving initialized modules.
Both paths calculate on this device. PTM and Voro++
Workers retain their own reusable WebAssembly kernel and memory.

An adaptive memory budget limits cached trajectory frames and results. Cancellation and source/frame/parameter ownership checks prevent late Worker messages from applying obsolete results. Closing the source stops playback and analysis, releases cached structure data, and restores the homepage. While GPU acceleration stays enabled, its device and compiled pipelines can be reused for the next source.

## Enable GPU acceleration

The **Enable GPU acceleration** switch beside **Light / Dark** is on by default and prefers WebGPU for supported analyses. Turn it off to use CPU Workers. The preference applies to the next calculation: completed results remain available, and clicking **Calculate** again uses the selected backend. JSON configuration export/import includes this preference; explicit saved off settings remain off, while configurations without a GPU preference use the enabled default.

| Analysis | GPU acceleration enabled |
| --- | --- |
| Coordination number | WebGPU linked-cell neighbor search and atom counts |
| Adaptive or fixed-cutoff CNA | WebGPU local neighbor graphs and crystal classification |
| Manual or Auto central symmetry | WebGPU nearest-neighbor selection and normalized greedy pairing; Auto uses local CNA labels |
| Displacement | WebGPU Cartesian differences, triclinic minimum images and vector magnitudes |
| Reference-frame strain | WebGPU reference-neighbor deformation fit, tensor and invariants |
| Total or element-pair RDF | WebGPU neighbor search and distance histogram |
| Local geometric shear | WebGPU neighbor geometry and per-atom shear |
| Bonds | WebGPU periodic neighbor counts and compact bond graph, including element-pair cutoffs |
| Bond distributions and Q4/Q6 | WebGPU bond lengths, angular histograms and local spherical-harmonic reductions |
| Voronoi | WebGPU convex-cell clipping (standard or radical planes) with complete periodic images; exact CPU recovery for uncertain geometry or resource limits |
| Ideal lattice strain | WebGPU neighbors, CPU PTM fit, then WebGPU ideal-reference conversion and tensor invariants; compatible PTM fits/uploads are reused |
| Standalone PTM | Existing CPU neighbor search and Wasm correspondence fit |
| DXA | Complete CPU Wasm extraction; shared-memory pthreads on isolated hosts, private CPU Workers for eligible local stages on nonisolated hosts |

Algorithms without a GPU version continue to use their CPU implementation. When WebGPU, a suitable adapter or the required device limits are unavailable, supported analyses also fall back to CPU. Cancelling a calculation stops the job and retains the usual cancellation behavior. WebGPU requires a secure browser context: HTTPS or localhost.

Ideal lattice strain reports GPU neighbor preparation, CPU PTM fitting and GPU reference/tensor evaluation as separate stages. If the GPU reference/tensor stage fails, CPU fallback reuses the completed fit instead of repeating PTM. GPU reference evaluation selects each atom's element and phase, applies the editable lattice parameters, restores absolute deformation and computes strain invariants. Only raw fit arrays and a small per-element reference table are prepared on CPU. [PTM](ptm.md), [CNA](cna.md), [central symmetry](centrosymmetry.md), [displacement](displacement.md), [reference-frame strain](reference-strain.md), [bonds](bonds.md) and [ideal lattice strain](ideal-strain.md) document their cutoff, precision and reference conventions.

## How the GPU backend works

GPU code lives in **`src/analysis/gpu/`**, separate from the CPU kernels. Both backends return the same analysis quantities to the scheduler, color legend and frame cache. Linked-cell search limits neighbor candidates; the implementation does not compare every atom with every other atom. This matters for large inputs such as the bundled 129,904-atom **Ni grain boundary** example, `examples/NiGB_minimized.cfg`.

A reusable GPU device and pipelines amortize initialization, while uploaded coordinate buffers can be reused across compatible analyses. GPU buffers are shared by GPU passes after an upload; JavaScript arrays and SharedArrayBuffer are not automatically the same memory as GPU buffers. Workgroup memory is local to a GPU workgroup. WebGPU is a cross-vendor API and does not require CUDA or an NVIDIA GPU.

Voronoi's CPU path shares the existing concurrency budget and dynamically
assigns bounded central-atom chunks. Each Worker retains one source snapshot,
its linked-cell index and its Wasm module/buffers; only the first chunk uploads
the structure. Exact coordinate comparisons invalidate mutated inputs. Native
convex-cell tests remove planes that cannot cut the cell before sorting, and
the final face-CSR merge and distributions run in a Worker. Voronoi's GPU path
constructs each cell through bisector clipping in a reusable batched workspace,
retaining polygon vertices on the device and reading back compact face measures.
See [Voronoi](voronoi.md) for numerical recovery and boundary conventions.

Reference-frame strain prepares both configurations and keeps their GPU buffers resident during the calculation. Atom-ID matching remains CPU work; the reference-neighbor search, deformation fit and output tensors run on GPU. Selecting another reference can reuse that frame's cached upload without changing the displayed frame's identity.

DXA computes the complete network on CPU in one Wasm heap. On isolated hosts,
a reusable pthread pool shares this global workspace and divides independent
atom/cell work; ordered topology and graph stages keep their required
coordination. On nonisolated hosts, eligible local crystal and tetrahedron
classification stages reuse the ordinary CPU Worker pool; one coordinator
retains the complete network and continues its global kernel with one thread.
The status reports both global threads and peak local-stage Workers. Private
snapshots, Wasm imports and Worker startup consume time and memory; small or
memory-limited jobs and failed stage tasks use native CPU stages.
Automatic private-stage selection uses at most four Workers and accounts for
the pool's retained Wasm heaps and Voronoi snapshots. A failed
isolated pthread startup retains the complete serial kernel. The GPU preference does not affect its backend or
completed results. See [DXA](dislocations.md) for settings, memory and scientific
limitations.

Displacement also retains current/reference inputs, caching anchored Cartesian high/low buffers separately for wrapped and unwrapped coordinates. Its vector differences, current-cell minimum images and magnitudes run on GPU after CPU atom matching. A Cartesian-only upload does not need the neighbor grid, so open coordinates outside the fractional unit box are supported. Auto central symmetry reuses compatible adaptive-CNA labels or runs GPU adaptive CNA before nearest-shell voting and greedy pairing.

Fresh ideal strain can prepare its PTM nearest-neighbor table on GPU, preserving exact ordering through shader-emulated IEEE64 arithmetic. Readback is batched to at most 16,384 atoms in two alternating row buffers, so the next batch runs while one is decoded, and a 256 MiB ceiling bounds the full 505-byte-per-atom host table. Central symmetry and this preparation share one exact binary64 coordinate encoding per frame input. Diamond and graphene fitting require that complete table; other templates can give CPU Workers only their own ranges. CPU fitting remains necessary, and standalone PTM retains its CPU path. Cached ideal-strain fits also keep their raw GPU PTM uploads, so a reference edit updates the small element table without repeating fitting or uploading every deformation matrix.

### Dispatch batching and readback

A neighbor index is cleared and filled with one dispatch each; its only round
trip is the occupancy check queued behind them. Kernels that visit central
atoms in ranges write each range into a small settings buffer before the
dispatch on the same queue, and keep up to three dispatches queued instead of
waiting for each one. Software adapters keep 16,384-atom ranges, as does the
light displacement kernel. Hardware adapters start other neighbor kernels at
65,536 atoms (16,384 for the emulated-IEEE64 central-symmetry pass) and adjust
each pipeline to its measured dispatch time, about 60 ms per dispatch: slow
dispatches shrink the range at once, to no fewer than 4,096 atoms, and later
runs of that pipeline start smaller; fast ones grow within the run up to
262,144 atoms. This keeps dispatches well below driver watchdog limits on
slower GPUs. Input uploads do not wait for queue completion; WebGPU orders them
before later dispatches, and error scopes still report allocation failures.

Results are copied into a reusable staging buffer, and the outputs of one
step share one mapping: coordination counts, candidates and the correction
header; shear coordination and cutoff flags; displacement vectors, magnitudes
and flags; or bond rows and records. Pooled staging buffers are bounded to
64 MiB (1/16 of a software budget) and are released before cached frames when
memory runs short. RDF reads back 32,768-atom ranges on hardware for large
frames, still within its 32-bit histogram bound, and two histogram buffers let
the next range run while the previous one is corrected. Bond distributions read
back up to 16,384 atoms at a time (formerly 2,048); their dispatches start at
2,048 atoms and follow the measured dispatch time, because angular enumeration
is quadratic in the neighbor count. A range whose exact-correction queue
overflows is split by the number of records it requested, and the next range
follows the observed correction density. Each range is read back completely,
including the expected correction records, before the next one starts; its CPU
merge and exact pair corrections then run while the GPU computes the next
range. Histograms, coordination and per-atom rows do not depend on range
boundaries; merging per-range moments in a different order can change only the
last bits of mean and standard deviation, whose merge order already varied
with the GPU's correction-record order.

The GPU Worker runs one task at a time. When the next analysis's frame (and
reference frame) is already resident, the client posts it while the current
task runs, so the Worker can start it without another main-thread round trip.
At most one task waits this way, cancellation still reaches it, and results
settle in posting order. The Worker keeps the inputs of every task it has
received until that task finishes, so an earlier task can evict their GPU
buffers and the later task uploads them again instead of failing.

Measured on a GTX 1080 Ti (Chrome/Vulkan hardware adapter) through the
persistent GPU Worker, as the median of 12 warm calls from three alternating
browser processes per build, for `NiGB_minimized.cfg` (129,904 atoms):

| Analysis | Before | After |
| --- | ---: | ---: |
| Coordination | 35 ms | 14 ms |
| RDF | 49 ms | 16 ms |
| Local shear | 73 ms | 31 ms |
| Fixed-cutoff CNA | 48 ms | 28 ms |
| Displacement | 46 ms | 31 ms |
| Bonds | 170 ms | 125 ms |
| PTM neighbor table | 852 ms | 477 ms |
| Bond distributions | 2,141 ms | 495 ms |
| Central symmetry (12 / Auto) | 402 / 450 ms | 358 / 401 ms |

Adaptive CNA and reference-frame strain were unchanged within noise; their time
is GPU arithmetic and sparse CPU correction. Bond distributions also gained
from an allocation-free exact pair correction, which this example needs for
2.2 million angle pairs on integer-degree bin edges. For a 1,000,188-atom FCC
crystal, coordination fell from 217 to 51 ms, local shear from 425 to 121 ms,
fixed CNA from 309 to 86 ms, adaptive CNA from 427 to 129 ms, RDF from 310 to
135 ms and 12-neighbor central symmetry from 1,294 to 963 ms. Deterministic
outputs were bit-identical to the previous build; bond edge order, Q4/Q6,
reference-frame strain and Voronoi values, which already varied between runs of
the previous build with the linked-cell insertion order, varied by the same
amounts.

### Preparation when a structure loads

Once the displayed frame is committed, CPU and enabled GPU preparation start
alongside rendering. Preparation does not enable Voronoi analysis or publish
atomic properties, histograms or cell meshes. Clicking **Calculate** runs the
analysis with the resources already available; a calculation need not wait
for unrelated background preparation.

CPU preparation initializes reusable Voro++ and PTM modules, snapshots the
current coordinates, and builds the resident Voronoi neighbor index and native
context in the selected Workers. Their number follows the atom count, logical
processor limit and memory budget described above. Shared snapshots require
cross-origin isolation; otherwise each Worker retains its private copy. DXA
module preparation follows the current-frame Voronoi input preparation. CPU
preparation also runs when GPU acceleration is off.

GPU preparation first compiles the four neighbor-index and Voronoi pipelines,
uploads the current frame's coordinates and types, and prepares its initial
neighbor index and reusable bounded clipping workspace. One discarded cell
dispatch warms the driver's execution path; it returns no scientific result
or display geometry. Compatible calculations reuse the device, pipelines,
uploaded inputs, neighbor index and workspace. Other shaders compile later in
the background. The renderer continues to use separate WebGL buffers.

Foreground analyses take priority over queued preparation. A changed frame or
source cancels obsolete preparation while reusable module and pipeline
resources survive. Physical replication starts adapting the Worker target to
the projected atom count and prepares the committed replicated coordinates;
display-only replicas leave analysis inputs unchanged. Changed coordinates,
cell geometry, or a different Voronoi input-type subset require compatible new
snapshots and indices. A changed search radius can require another GPU index.
Load-time preparation includes all atom types; a chosen Voronoi subset prepares
its compact input as needed.

The GPU cache estimates the resident frame size and reserves space for calculation buffers. If the complete sequence fits its conservative budget, all frames are uploaded in the background. Otherwise, it keeps a window around the current frame, preferring the next and previous frames. Adjacent frames receive coordinate uploads; Voronoi index and workspace preparation follows the displayed frame. Moving through the trajectory updates this window; foreground calculations take priority over background uploads. CPU and GPU caches have independent capacities, and reparsing a frame after CPU eviction still reuses its resident GPU data.

Standard WebGPU does not expose free VRAM. The cache starts with an allocation budget of 2 GiB for hardware or 128 MiB for a software adapter, including a calculation workspace reserve. This is a ceiling, not an upfront reservation: only the loaded frames and required calculation buffers consume memory. The cache checks individual buffer limits and, if an allocation runs out of memory, lowers its budget, evicts distant frames and retries once while protecting the current frame. Thus a GPU with less available memory can retain a smaller nearby-frame window. A frame that cannot be prepared safely uses the existing CPU fallback. Closing or changing the source clears structure buffers while retaining the GPU device and compiled pipelines; switching GPU acceleration off releases the GPU Worker after any accepted calculation finishes. A new cutoff can require a new neighbor index, and uncommon shader variants are still compiled on demand.

Most GPU kernels use 32-bit floating point. High and low input components retain coordinate and PTM fit precision; strain kernels use compensated matrix arithmetic and apply the CPU threshold for numerical zeros. Central symmetry and fresh-strain neighbor preparation additionally emulate IEEE 64-bit arithmetic in their shaders to preserve strict neighbor ordering and CSP pair choices; this does not rely on native GPU float64. Ambiguous neighbor cutoff or ordering decisions in other kernels receive sparse CPU corrections. Continuous values can still differ slightly between backends, including small strain residuals, and inputs outside the supported precision range use CPU. In particular, GPU neighbor searches fall back when their padded search radius exceeds 32 times the face height along a periodic axis; small nonperiodic face heights do not trigger this limit.

Uploads, shader compilation, reductions and result readback all contribute to elapsed time. Small structures may finish sooner on CPU, and enabling GPU acceleration does not guarantee a speedup. Compare the same file, cutoff and analysis parameters, reporting cold initialization separately from subsequent runs and distinguishing hardware adapters from software adapters. See [validation](../VALIDATION.md) for executed checks rather than treating software-adapter timing as a physical GPU benchmark.

## Analysis results and rendering

The current renderer uses WebGL2. WebGPU analysis writes results to GPU buffers, copies them to a reusable readable staging buffer, and returns typed arrays to the application. The color legend uses these scalar arrays, and vector display builds arrow data from the selected X, Y and Z fields. Drawing then uploads colors and vectors into separate WebGL buffers. Input uploads can be reused by subsequent WebGPU calculations, but the current rendering path still includes result readback and WebGL upload.

While dragging the legend's range slider, the renderer uploads normalized
scalar values once and maps colors and range visibility in WebGL shaders.
Further drag steps update uniforms instead of rescanning and uploading every
atom's colors. Both views share the prepared scalar values; selection colors
and other visibility filters still apply. The exact CPU palette and histogram
return when editing ends or an image is exported. This temporary rendering
preview does not alter scientific values or analysis backends.

Browsers provide no portable way to use a WebGPU `GPUBuffer` directly as a WebGL buffer. A future WebGPU renderer could draw from retained analysis buffers on the same `GPUDevice`, avoiding the full array round trip for supported displays. It would need to keep those buffers alive, map colors on GPU and write any CPU precision corrections back before drawing. The present analysis Worker owns its device and releases temporary output buffers after returning results, so this would require a change to device ownership and rendering. Legends, atom inspection and data export would still need summary statistics or selected values on the CPU.

## Compare CPU and GPU time

For load-time Voronoi preparation using the bundled 28,800-atom HEA screw
example, run the browser benchmark against the production build:

```bash
npm run build
node scripts/benchmark-voronoi-browser.mjs --output /tmp/alloyview-voronoi-hea.json
# Check scientific outputs against a previously saved report:
node scripts/benchmark-voronoi-browser.mjs --reference /tmp/alloyview-voronoi-hea.json --output /tmp/alloyview-voronoi-hea-next.json
```

It records source visibility and preparation readiness separately from the
first calculation's kernel-start and result latency. CPU runs cover isolated
shared snapshots and nonisolated private copies, reporting module
initializations, neighbor-index builds and uploads during the calculation.
The GPU row measures preparation with SwiftShader; it does not time a complete
GPU Voronoi analysis or establish a physical GPU speedup. Compare reports from
the same machine and parameters, and include preparation cost rather than
treating work moved to loading as eliminated work.

In one verified Chromium run with three CPU Workers, time from **Calculate**
to the first cell chunk fell from 29 to 5.7 ms with shared snapshots, and from
32.7 to 21 ms with private copies. Background preparation finished about
0.10–0.12 seconds after the structure became visible. Both modes reused all
three prepared Workers with zero new kernel initializations, index builds or
coordinate uploads, compared with three of each previously. All 13 scientific
output digests matched. The complete shared-memory calculation remained about
0.74 seconds, so these single-run measurements demonstrate reduced startup
latency rather than a general reduction in total calculation time.

In that run's SwiftShader probe, the four targeted pipelines, current-frame
upload and index, 512-cell workspace and discarded-cell dispatch were ready
18.0 seconds after loading began. The 23 common pipelines finished warming at
29.6 seconds; previously the first coordinate upload waited about 29.4 seconds
for that broader warmup. These are software-adapter preparation timings, with
no complete GPU Voronoi timing or physical GPU speed claim.

With Node.js 24 and Chrome/Chromium installed, run:

```bash
npm run test:gpu
npm run benchmark:gpu
# Select one calculation and save the report:
npm run benchmark:gpu -- --kernel=coordination --output=/tmp/alloyview-gpu.json
# Compare each CNA mode or reference-frame strain:
npm run benchmark:gpu -- --kernel=cnaFixed
npm run benchmark:gpu -- --kernel=cnaAdaptive
npm run benchmark:gpu -- --kernel=referenceStrain
# Compare manual/Auto symmetry or displacement:
npm run benchmark:gpu -- --kernel=csp8
npm run benchmark:gpu -- --kernel=csp12
npm run benchmark:gpu -- --kernel=cspAuto
npm run benchmark:gpu -- --kernel=displacement
# Ideal-reference conversion and tensors with a cached PTM fit:
npm run benchmark:gpu -- --kernel=strain
# Full fresh-strain pipeline or a resident-fit reference edit:
npm run benchmark:gpu -- --kernel=strainFresh
npm run benchmark:gpu -- --kernel=strainEdited
# Measure preparation separately, then calculate with preloaded inputs:
npm run benchmark:gpu -- --hardware --preload
# Explicit software execution checks when no physical adapter is available:
npm run benchmark:gpu -- --software
```

The benchmark loads `NiGB_minimized.cfg`, bypasses application result caches, checks CPU/GPU output agreement, and reports cold and warm wall times, adapter details and CPU fallback reasons. Fixed CNA uses a 3.1 Å cutoff; adaptive CNA uses its local shell scales. The reference-strain benchmark creates a controlled affine copy of the same atoms and cell, with known correspondence, and compares it against the original reference; it does not read a trajectory. Its row-major deformation gradient is `F = [1.02, 0.12, 0.03; 0, 0.98, 0.05; 0, 0, 1.04]`.

Central-symmetry benchmarks use either 8 or 12 neighbors or local Auto shells. The displacement benchmark creates a Cartesian copy translated by `[0.12, −0.08, 0.05]` Å, retaining known same-row correspondence to the source. It reports matching/preparation separately, compares all components and magnitudes, and does not infer trajectory motion from this single example.

`strain` measures GPU ideal-reference conversion and tensor evaluation from a cached CPU PTM fit, reporting its fitting preparation separately. `strainFresh` measures the complete GPU-neighbor → CPU PTM → GPU reference/tensor pipeline. `strainEdited` changes Ni's reference `a` from 3.52 to 3.4 Å after separately timed CPU fitting and GPU resident-input preparation; the measured edit reuses that fit and its upload. These modes retain the same nine strain fields and NaN conventions, and the report identifies preparation costs and cache reuse rather than treating an edited reference as a fresh fit.

With `--preload`, preparation time is reported separately; the first calculation then uses the prepared device, common pipelines and resident frame. Its RDF cutoff respects the example's thin periodic Z cell. `test:gpu` uses a software adapter by default; pass `--hardware` to test a physical GPU. `benchmark:gpu` requests a hardware adapter by default. Hardware mode rejects software adapters; use `--software` explicitly for software execution checks.

On Linux, the headless runner enables the Vulkan backend for hardware mode and removes the inherited `DISPLAY` from the Chrome subprocess environment. A forwarded SSH/X11 display can otherwise cause ANGLE initialization to fail even when `nvidia-smi` detects the GPU. WebGPU uses the graphics driver and Vulkan rather than CUDA, so `nvidia-smi` alone does not verify this path. Failed adapter checks include Chrome's GPU initialization log. Install Chrome/Chromium or set `CHROME_PATH`; additional flags can be supplied as a JSON array in `ALLOYVIEW_CHROME_ARGS`.

The runner also enables `--enable-unsafe-webgpu`. A successful hardware benchmark confirms this configured browser can execute the kernels; it does not guarantee WebGPU is enabled in an ordinary browser. On GitHub Pages, enabling GPU acceleration automatically starts the same preparation and caching without a command-line benchmark, provided the visitor's browser supplies an adapter. See [WebGPU on GitHub Pages](../DEPLOYMENT.md#webgpu-on-github-pages) for deployment checks.

See Chrome's [headless WebGPU setup](https://developer.chrome.com/blog/supercharge-web-ai-testing) for the Vulkan launch flags and driver checks.

## Implementation

[Analysis scheduler](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/analysis-pool.js), [GPU backend](https://github.com/Yazhuo-Liu/AlloyView/tree/main/src/analysis/gpu), [cache policy](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/data/cache-policy.js), [validation guide](../VALIDATION.md).
