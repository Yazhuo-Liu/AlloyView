# Validation record

Validation date: 2026-10-05 (UTC)

## Hybrid GPU DXA

DXA now runs tetrahedron alpha filtering and elastic-compatibility checks on
the existing WebGPU device, then continues interface construction and tracing
in its retained CPU/Wasm session. The final backend is reported as `hybrid`;
CPU local correspondence, crystal mapping, robust periodic Delaunay and line
tracing have not been replaced with GPU algorithms.

- The full Node suite passes **783 tests**. New cases cover the staged native
  session, exact CPU-region injection, export memory limits, temporary snapshot
  release, shared GPU routing, cancellation races, source ownership and fallback.
- Real Chromium/SwiftShader runs compare **480,890 tetrahedron region labels**
  against the native implementation, with no differences, across perfect FCC,
  BCC, HCP, cubic/hexagonal diamond, a strained translated triclinic frame and its vacancy,
  a rotated perfect control and the 8,640-atom FCC screw fixture.
- Actual compute shaders pass **813 binary64 quotient comparisons** including
  last-ULP thresholds, subnormals, overflow and special values, plus synthetic
  alpha, degenerate-neighbor, reverse-edge, Burgers and nonself Frank-rotation
  checks. The shader does not use a float32 approximation for classification.
- The screw returns one perfect segment with the CPU Burgers vector, periodic
  winding and 14.934458956039819 Å source length. Its immutable upload is
  10,498,560 bytes; the one final GPU region readback is 504,276 bytes. Alpha
  labels remain on GPU between passes. This hybrid path still uploads mapped
  CPU geometry and completes extraction on CPU.
- GPU alpha-batch cancellation rejects with `AbortError`, retains the same
  native kernel generation and both coordinator/device Workers, and permits
  a valid subsequent screw extraction. GPU failure, CPU/GPU toggles and a thin
  cell error also preserve the healthy backend. Overlapping direct native API
  calls are rejected while a GPU callback holds the session.
- Production browser checks pass hybrid extraction without isolation headers,
  independent atom coloring, line colors/visibility/radius, PNG output, recipe
  replay, physical replication, frame transitions and mobile layout. The
  isolated CPU parallel/reuse browser checks also pass.
- Deferred pipeline checks verify that ordinary GPU warmup can finish while
  DXA compiles in the background, a foreground DXA call shares that compilation,
  error scopes remain separate and a closed device cannot receive stale cache
  entries. Final production DXA also exercises this shared initialization path.
- The existing WebGPU regression suite passes 251 comparisons, together with
  native application integration and versioned production Worker checks.

Parallel Delaunay insertion can change which representative atom anchors a
circuit center. The upstream uses perturbed edge vectors with unperturbed
anchors, so periodic endpoint residuals are bounded by four times its
`epsilon = 1e-10 * |a+b+c|`, plus arithmetic rounding. Winding tests now check
all three components against the integer cell-vector winding with that derived
bound; Burgers vectors, connectivity and relative arc-length checks remain.
For the screw this bound is about 4.55e-8 Å, rather than an arbitrary 1e-8 Å.

Reproduce with `npm test`, `npm run test:browser:dxa-gpu`,
`npm run test:browser:dxa` and `npm run test:browser:dxa-parallel` after
`npm run build`. GPU checks use a software adapter by default; `-- --hardware`
requires a real hardware adapter. No physical-GPU speedup is established by
these correctness checks.

## Dynamic CPU prewarming and one DXA heap

The application now uses one active CPU budget of
`max(1, navigator.hardwareConcurrency - 2)` across ordinary analyses and DXA.
Actual parallelism also depends on atom count, analysis type and memory limits.
Idle prewarmed Workers hold no CPU permit. Ordinary heavy-analysis prewarming
includes the PTM module's initial 16 MiB heap in its memory estimate.

File indexing overlaps module initialization, then the parsed atom count grows
the existing pools. Physical replication validates its projected atom count
and starts additional prewarming during coordinate generation. Display copies
do not change the analysis pool target. Frame visits check actual pool health
so a previously terminated ordinary analysis Worker can be prepared again.

DXA creates one shared Wasm module even when only one computation thread is
needed on an isolated host. Higher thread counts asynchronously load additional
pthread Workers into that same module and shared memory; lower counts retain
the unused slots. Normal source changes and shared-memory cancellation keep
the heap. The host sets a shared cancellation word without a receive-side reset
that could erase a racing abort. The client retains its CPU lease until native
work acknowledges cancellation. PDEL insertion currently acknowledges only
after its current stage completes. Static hosts cannot interrupt synchronous
Wasm through a shared word, so running serial cancellation still terminates and
replaces its Worker. Asynchronous module prewarming is retained on both hosts.

- All 758 Node tests pass, covering the weighted global budget, foreground priority,
  cancelled reservations, coalesced prewarming, ready acknowledgements and
  real PTM reuse with zero new kernel initializations. Real DXA tests retain the
  same shared memory and kernel generation through 1→4→1, cancellation/recovery,
  perfect-crystal classification and screw-dislocation extraction.
- The real browser DXA check passes source reset, adjacent pool growth
  2→3→4→1 and cooperative cancellation/recovery without recreating a coordinator
  or discarding child Workers. Explicit close still removes all nested Workers.
  The original no-isolation fallback and scientific winding/Burgers checks pass.
- The production CPU prewarming check simulates browser reports of 8 and 16
  logical processors, giving limits of 6 and 14. Loading a 3,072-atom crystal
  warms one analysis Worker and one DXA module. Display Z×20 leaves the pools
  unchanged; real Z×20 (61,440 atoms) starts growth before expanded rendering and
  prepares 6/14 ordinary Workers plus 5/13 DXA children. DXA kernel generation
  and its 32 MiB shared heap remain unchanged during this preparation. Reloading
  preserves both pools, and a subsequent coordination calculation reuses them.
- The full standard browser smoke and production DXA checks pass, covering
  existing analyses, configuration replay, image export, trajectories and mobile
  controls. Chromium/SwiftShader verifies execution and rendering; these are
  not physical GPU performance measurements.

Reproduce with `npm test`, `npm run build`,
`npm run test:browser:cpu-warmup -- --software`,
`npm run test:browser:dxa-parallel -- --software`,
`npm run test:browser:dxa -- --software` and `npm run test:browser`.

## Shared-memory DXA

The CPU backend now has separate serial and pthread Wasm artifacts built with
Emscripten 3.1.69. Local structure identification, periodic PDEL tessellation,
ghost-cell classification and elastic/alpha tetrahedron tests share one heap.
A bounded adapter also caps Geogram's eight-task Hilbert groups to the requested
computation threads; it does not modify Geogram's robust predicates. Global
numbering, ideal-edge mapping and dislocation tracing retain their coordinator.

- All 736 Node tests pass, including six additional real threaded-kernel tests.
  Perfect FCC, BCC, HCP and both diamond phases have no false lines. Two- and
  four-thread screw extraction preserves every atom label, signed Burgers
  vectors, junctions and periodic winding within `1e-8 Å`. PDEL insertion order
  can change the estimated core polyline: arc curvature and the difference from
  serial arc length are bounded to 0.1% of the analytic winding, rather than
  equating a curved trace to a perfectly straight line. Additional direct Wasm
  checks passed with 2, 3, 4 and 6 threads, including thin-cell error propagation
  from a child and successful reuse of that same pool afterwards.
- The real Chromium parallel check passes both deployment cases: no COOP/COEP
  selects serial even when two threads are requested; an isolated host starts
  the coordinator and actual child Worker. Cancellation during the local
  identification phase of a 110,592-atom frame closes every nested Worker,
  leaves no pending job, and a fresh pool recomputes successfully. The phase
  includes serial neighbor-index preparation, so this test does not claim to
  observe the exact instruction executing on each pthread at cancellation.
- The production DXA browser check still passes without isolation headers,
  including WebGL lines, image export, configuration replay and mobile layout.

`npm run benchmark:dxa -- --workers 1` and the corresponding `--workers 4`
command analyze real Z×2 replication of NiGB: 259,808 atoms, 249,620 FCC and
10,188 Other, zero dislocation segments in both runs. Node v24.19.0 in this
cloud container reports five available processors with a four-CPU cgroup quota.
One cold and one warm extraction were measured per backend; parsing and real
replication are outside these timings. Cold includes Wasm/pool initialization;
warm reuses the module. These CPU observations are not a general scaling
guarantee or a physical GPU benchmark.

| Measurement | Serial | Four computation threads |
| --- | ---: | ---: |
| Cold whole extraction | 17.64 s | 8.05 s |
| Warm whole extraction | 15.06 s | 7.23 s |
| Warm local identification | 1.52 s | 0.40 s |
| Warm periodic tessellation | 6.43 s | 2.47 s |
| Warm interface construction | 4.84 s | 2.05 s |
| Process RSS after warm run | 701.9 MiB | 759.7 MiB |

The observed warm whole-frame speedup is about 2.08×. RSS includes Node,
input/replicated JS arrays and retained Wasm capacity; it is not a sampled peak
or an isolated kernel allocation measurement. Shared-memory execution requires
an isolated host; GitHub Pages without these headers uses the serial kernel.
These CPU measurements predate the hybrid classifier described above. The
[resident GPU design](DXA_REVIEW.md) records the remaining periodic geometry
and tracing work for a fully GPU extraction. WebGL2 drawing requires final
network transfer; changing the renderer is not a prerequisite for that work.

Reproduce with `npm test`, `npm run test:browser:dxa-parallel -- --software`,
`npm run test:browser:dxa -- --software` and the benchmark commands above.
Rebuild both artifacts with `npm run build:dxa` and
`npm run build:dxa:threaded` after numerical source changes.

## Initial CPU DXA

The initial DXA module ports the actual OVITO v3.9.4 numerical core with a
dedicated, non-shared CPU/Wasm Worker. The checked-in factory and binary build
with Emscripten 3.1.69 / LLVM 19; the build verifies 58 vendored/adapted source
files. The per-file MIT option, Geogram BSD notice and source pin are retained.
FCC/BCC/cubic-diamond preferred crystal orientations match the upstream defaults.
GPU-enabled requests explicitly use CPU for this version.

- The full Node suite passes 729 tests. Eight tests execute the real DXA Wasm
  core: perfect FCC, BCC, HCP, cubic/hexagonal diamond; an FCC screw line and
  its rotated perfect control; thin-cell rejection and recovery; and a strained,
  translated triclinic FCC cell with an isolated vacancy. Perfect crystals and
  the vacancy do not create false lines.
- The independent screw fixture has 8,640 atoms, free X/Y boundaries and
  periodic Z. OVITO 3.10.6.post2 extracts one perfect `1/2<110>` line with a
  spatial Burgers-vector magnitude of 2.4890158698 Å. The port returns the same
  line count, family, periodic winding and Burgers vector; its local vector
  `[0.5, 0, -0.5]` also matches the reference. Traced/coarsened arc length is
  compared within 0.001 Å for Float64 input rather than requiring an exactly
  straight curve. The XYZ browser fixture passes through the existing Float32
  parser and uses 0.002 Å arc-length tolerance. Replication checks periodic
  winding and Burgers vectors separately from the slightly curved arc length.
- The full standard browser smoke passes with Chromium 151. The additional
  production DXA check, without COOP/COEP, runs actual Wasm in a Worker and
  actual WebGL line shaders. It covers family color/radius/visibility without
  another calculation, lines with all atoms hidden, PNG line pixels, recipe
  export/import with recomputation, termination during a native analysis stage
  while retaining coordination, Worker recovery, display versus physical
  replication, source/frame cleanup and a 390px phone layout. No page exceptions
  or GL errors occur. SwiftShader validates drawing, not hardware GPU speed.
- NiGB's original 129,904-atom thin Z cell produces the expected upstream
  rejection. Physical Z×2 replication produces 259,808 atoms and completes
  through the new Wasm bridge in one measured Node call of about 14.94 seconds,
  with zero lines and volume 3,437,153.1739577614 Å³, matching the native OVITO
  result. This is a CPU/Wasm observation, not a browser/GPU speedup benchmark.

Reproduce with `npm test`, `npm run build`, `npm run test:browser` and
`npm run test:browser:dxa -- --software`. Rebuild the numerical artifact only
when needed with `npm run build:dxa`. The generated screw fixture is in
`tests/helpers/dislocations.js`; the optional native OVITO oracle remains
research tooling outside the application's dependencies.

This is initial validation, not broad parity across realistic networks. Edge
dislocations, partials, loops, junctions, complicated interfaces and newer HCP
low-c/a behavior still need independent fixtures. The source review and first
native NiGB record remain in [DXA review](DXA_REVIEW.md).

## GPU ideal lattice reference and the enabled default

The latest checks use Node.js v24.19.0 and Chromium 151 with Google SwiftShader.
These are real WebGPU shader executions on a software adapter; physical GPU
performance for the new ideal-strain stages remains unmeasured.

- The full Node suite passes 692 tests, and the final integration checks pass.
  The static build and full standard browser smoke pass, including the visible
  and accessible **Enable GPU acceleration** label, its enabled default,
  toggling, explicit saved off preferences and older configurations without a
  GPU preference. An explicit off value stays off; a missing value restores on.
  Existing CPU calculations, configuration, mobile gestures, selection,
  replication, exports and 204,800-atom rendering remain covered.
- The scientific GPU suite passes 251 comparisons: 248 execute GPU kernels and
  three deliberately unsupported inputs use CPU fallback. Twenty common
  pipelines are prepared. Twelve nearest-neighbor tables agree exactly with
  CPU, including indices, counts and Float64 image vectors. Forty-two cached
  and fresh ideal-strain cases cover six reference phases, rotations,
  mixed elements, independent hexagonal `a`/`c`, reference edits, invalid and
  mismatched fits and tiny genuine strain. Maximum strain-field difference is
  `1.776e-15`; ideal zeros, NaN masks and the `1e-12` numerical-zero threshold
  are retained. Subnormal input deliberately uses CPU fallback.
- Fresh ideal strain uses GPU nearest-neighbor preparation, CPU WebAssembly
  PTM correspondence fitting, then GPU element-reference conversion and all
  nine tensor/invariant fields. The reference shader selects element/phase,
  validates fits and restores absolute lattice scale; CPU upload preparation
  does not calculate per-atom reference factors. Standalone PTM keeps its CPU
  neighbor search and fitting path.
- Compatible reference edits retain acknowledged private fit inputs and
  resident GPU fit buffers. New fits, source/revision/type changes and frame
  eviction invalidate the appropriate data. Results and source arrays retain
  their precision and ownership.
- Twelve cancellation checks cover preparation and publication across the
  supported analyses, including fresh-strain GPU neighbors, CPU PTM fitting
  and GPU reference/tensor completion. Cancelled requests reject with AbortError,
  preserve source inputs and permit recovery through the same GPU Worker.
- Native GPU application checks pass the enabled/renamed startup preference,
  fresh strain, reference edits with both caches reused, CPU/GPU switches with
  the same scientific fit, legend selection and cancellation. Existing CNA,
  CSP, displacement, configuration and physical-replication checks also pass.
  The production build loads its GPU and CPU Workers from versioned assets:
  108 FCC atoms give exact zero for all nine fields, all five PTM arrays match
  CPU, and a reference edit reuses both fit caches without another upload.

GPU checks pass as separate kernel, native-application and production-build
scopes. Their commands are:

```bash
npm run test:gpu -- --kernels-only
npm run test:gpu -- --application-only
npm run test:gpu -- --built-only
```

Both Ni benchmarks use every atom in `examples/NiGB_minimized.cfg` (129,904).
Fresh calculation matches all five PTM arrays exactly on both calls. The nine
strain fields have matching 4,627-atom NaN masks and maximum absolute difference
`7.45e-9`, with no CPU neighbor corrections. The edited-reference run changes
Ni's `a` from 3.52 to 3.4 Å, retains the same NaN masks/error bound and uses no
CPU corrections. Both measured edited calls reuse private and GPU fit inputs;
the fit upload count remains one.

| Calculation | CPU first / subsequent (ms) | Software WebGPU first / subsequent (ms) |
| --- | --- | --- |
| Fresh ideal strain, complete hybrid pipeline | 2039.0 / 1640.9 | 54582.2 / 52781.0 |
| Edited reference with resident PTM fit | 279.0 / 253.2 | 62.0 / 52.1 |

Fresh GPU timing includes neighbors, CPU fitting, reference conversion, tensor
evaluation, transfers and assembly, using four CPU fitting Workers. The edited
row uses three CPU tensor Workers and starts with its fit already resident:
CPU PTM preparation takes 1704.9 ms separately, and initial GPU upload/reference/
tensor preparation takes 252.4 ms separately. Its first measured edit therefore
does not include initial device or fitting cost. Integer-emulated IEEE64
neighbor preparation makes the fresh software pipeline slower here; resident
GPU reference edits are faster in this software run. These timings do not
establish speedups on a physical GPU.

Reproduce these scopes with `npm run benchmark:gpu -- --software --kernel=strainFresh`
and `npm run benchmark:gpu -- --software --kernel=strainEdited`. The existing
`--kernel=strain` mode measures reference conversion and tensor evaluation from
a cached CPU PTM fit.

## Optional WebGPU analysis

The following sections preserve earlier validation snapshots. Their feature
scope and default-off checks describe the application at the time of each run.

Validated with Node.js v24.19.0 and Chromium 151 using the Google SwiftShader
software WebGPU adapter. These checks execute actual WGSL compute shaders;
they do not establish performance on a physical GPU.

- The full Node suite, static build and complete browser smoke pass. Browser
  checks cover the default-off header switch, configuration export/import,
  light/dark contrast, mobile layout and all existing analysis workflows.
- `npm run test:gpu` compares actual WebGPU and CPU results for FCC/BCC/HCP,
  triclinic and mixed-periodic cells, thin boxes and repeated/self images,
  RDF element filters, exact cutoff/bin boundaries, geometric distortions,
  nearest-neighbor selection ties and undefined geometric shear. Unsupported
  algorithms/inputs use CPU; cancellation during preparation and after a GPU
  dispatch rejects with AbortError, and subsequent GPU work succeeds.
- The dedicated GPU Worker reuses one device, pipelines and uploaded frame
  buffers across analyses. Cached inputs are bounded; closing/changing the
  source releases GPU resources. Source arrays remain intact. Continuous
  arithmetic uses f32; high/low coordinate components retain input precision,
  and ambiguous distance/selection decisions use bounded CPU correction.
- `npm run benchmark:gpu -- --software` loads all 129,904 atoms of
  `examples/NiGB_minimized.cfg` and bypasses application result caches. Both
  first and subsequent results are checked. Coordination and RDF counts agree
  exactly; local shear's maximum absolute difference is `2.081e-6`, its
  coordination counts agree exactly, and 10 atoms require moment correction.

Representative full-call wall times from this **software-adapter** run:

| Analysis and parameters | CPU first / subsequent (ms) | WebGPU first / subsequent (ms) |
| --- | --- | --- |
| Coordination, cutoff 3.1 Å | 193.8 / 108.0 | 870.6 / 520.7 |
| RDF, cutoff 2.48 Å, 100 bins | 480.4 / 312.9 | 686.5 / 545.7 |
| Local geometric shear, cutoff 3.1 Å | 691.9 / 756.5 | 1878.3 / 1467.7 |

Kernels run in the listed order through the same CPU/GPU pools. "First" means
the first call of that kernel; earlier calls can already have initialized the
device and Workers. Subsequent GPU calls reuse their uploaded input. Wall times
include preparation/upload, execution, corrections, readback and assembly.
CPU coordination uses three Workers; RDF and geometric shear use four on this
machine. RDF corrects 38,552 pairs near bin/cutoff boundaries. Its cutoff stays
below half the example's 4.97773 Å periodic Z face height.

Software WebGPU is slower here. Run `npm run benchmark:gpu -- --hardware` on a
machine with a physical adapter and inspect the reported adapter to assess
hardware acceleration; neither software timing nor atom count alone predicts
a GPU speedup.

### Linux NVIDIA hardware validation

Validated on 2026-10-04 with Node.js v26.10.0, Chrome 144.0.7559.109,
NVIDIA GeForce GTX 1080 Ti and driver 580.178.04. Chrome reports vendor
`nvidia`, architecture `pascal` and `isFallbackAdapter: false`.

The original hardware runner returned no adapter. Explicit Vulkan flags alone
still failed with the inherited SSH display `127.0.0.1:857.0`; Chrome logged
`DisplayVkXcb.cpp:62 (initialize): xcb_connect() failed, error 1` and EGL
initialization errors. Removing `DISPLAY` alone selected SwiftShader instead.
Enabling headless GPU/Vulkan and removing `DISPLAY` together selects NVIDIA.
The runner now applies this configuration automatically and rejects software
adapters in hardware mode, including Chrome initialization logs on failure.

- `npm test`, `npm run test:gpu -- --hardware` and
  `npm run test:gpu -- --software` passed. Both browser modes cover numerical
  agreement, expected CPU fallbacks, cancellation/recovery and the application
  GPU switch.
- `npm run benchmark:gpu -- --hardware` passed for all 129,904 atoms with
  `gpuActive: true` and no fallback for every kernel. Coordination and RDF
  counts agree exactly with CPU. Local shear's maximum absolute error is
  `2.147e-6`, below the `3e-5` tolerance, with 10 corrected atoms.

Representative full-call hardware wall times from one run:

| Analysis and parameters | CPU first / subsequent (ms) | GPU first / subsequent (ms) | Subsequent CPU / GPU ratio |
| --- | --- | --- | --- |
| Coordination, cutoff 3.1 Å | 272.3 / 222.9 | 669.4 / 46.7 | 4.77 |
| RDF, cutoff 2.48 Å, 100 bins | 492.6 / 382.4 | 251.6 / 97.5 | 3.92 |
| Local geometric shear, cutoff 3.1 Å | 953.4 / 961.1 | 494.7 / 154.3 | 6.23 |

The same run order and full-call timing scope described above apply. CPU
coordination uses three Workers; RDF and local shear use six. These ratios
describe this file, parameters and one workstation run. Coordination's first
GPU call includes initialization and takes longer than CPU.

### GPU preparation and trajectory caching

Validated on the same GTX 1080 Ti workstation with hardware and SwiftShader
WebGPU. Enabling GPU computing prepares a device and 10 common pipelines,
then uploads the displayed frame and fills either a complete trajectory cache
or the nearest frame window within an allocation budget.

- The Node suite passes, including GPU budget/allocation, source lifecycle,
  foreground priority and scheduler cancellation regressions. Scoped
  out-of-memory checks shrink residency and retry once; pure validation errors
  do not shrink the cache. Oversized frames fail before host buffer packing.
  Hardware starts with a 2 GiB ceiling independently of individual buffer
  limits. A scoped out-of-memory regression starts at that default, verifies
  that it is not reserved upfront, and reduces residency to the current frame
  and one neighbor on a simulated smaller GPU.
- `npm run test:gpu -- --hardware` and `--software` pass numerical and
  application checks. Four prepared frames remain resident, subsequent
  analyses avoid both input transfer and GPU upload, and a CPU-reparsed frame
  reuses its stable GPU identity. Restricting the budget gives a two-frame
  window containing the current frame and its neighbor.
- Closing/changing a source preserves the same Worker/device and compiled
  pipelines while releasing input/index buffers. The application uploads a
  six-frame XYZ trajectory without calculating analysis results, switches to
  three- and two-frame sources, and handles rapid GPU toggles without stale
  residency. Disabling GPU lets accepted calculations finish before teardown.
- `npm run benchmark:gpu -- --hardware --preload` checks all 129,904 atoms.
  Preparation took 413.9 ms in one run, separately from calculation. GPU
  first/subsequent wall times were 94.9/49.0 ms for coordination,
  184.6/121.4 ms for RDF and 201.7/143.7 ms for local shear. All kernels report
  GPU input reuse with no fallback; counts agree exactly and local shear's
  maximum absolute error remains `2.147e-6`.
- Repeating the hardware preload benchmark after raising the default reports
  a 2,147,483,648-byte budget and only 4,676,544 bytes resident for the one
  prepared frame. Coordination, RDF and local shear all execute on WebGPU,
  reuse their prepared input and report no CPU fallback. All 52 Node test
  files and the static build pass with this default.
- A clean headless Chrome 144.0.7559.109 probe on this Linux NVIDIA workstation,
  without the runner's unsafe-WebGPU or Vulkan overrides, has a secure context
  and `navigator.gpu` but returns no adapter. The desktop browser could not be
  checked through the SSH session. Hardware benchmark success with launch
  overrides therefore must not be treated as verification of ordinary browser
  support on GitHub Pages; see [deployment checks](DEPLOYMENT.md#webgpu-on-github-pages).

### GPU bonds and ideal lattice strain tensor

Additional real Chromium/SwiftShader checks execute the bond and ideal-strain
WGSL kernels. Software-adapter measurements below do not measure physical
GPU acceleration; the preceding GTX 1080 Ti results cover the earlier kernels.

- GPU bonds preserve periodic and self-image edges, triclinic geometry,
  element-pair cutoffs and exact cutoff decisions. On all 129,904 atoms in
  `NiGB_minimized.cfg`, the 774,528-edge graph and coordination arrays agree
  exactly with CPU for both first and subsequent calls. Bond-vector maximum
  absolute error is `2.384e-7` Å, with no CPU fallback.
- Cached and fresh ideal FCC strain produce exactly zero for all nine GPU
  fields. Editable reference `a`, combined finite shear/dilation and
  independent HCP `a`/`c` tests have maximum absolute errors `8.20e-8`,
  `7.82e-8` and `1.49e-8`, respectively. Reference mismatches remain NaN
  without warnings. Fresh strain identifies its CPU PTM and GPU tensor stages
  as `ptm-wasm-worker+webgpu-strain-tensor`.
- Cached PTM tensor evaluation on the complete Ni grain boundary matches all
  nine CPU fields within `2.239e-7`; the NaN mask also agrees. Small PTM
  off-diagonal noise remains a supported input rather than forcing fallback.
  The CPU PTM preparation took 2023.5 ms in this run and is excluded from both
  cached-tensor timings. This comparison measures tensor evaluation, including
  input preparation, upload, readback and assembly; it does not measure GPU
  PTM fitting.
- GPU tensor failure reuses the completed CPU fit. Cancellation rejects with
  `AbortError` and does not start CPU fallback. Private PTM transfers preserve
  source fit buffers, and existing warmup, trajectory preload and source reset
  behavior remains covered by the browser checks.

| Software-adapter calculation | CPU first / subsequent (ms) | WebGPU first / subsequent (ms) |
| --- | --- | --- |
| Bonds, cutoff 3.1 Å | 838.1 / 521.3 | 2772.3 / 2399.3 |
| Ideal strain tensor, cached PTM, Ni reference `a=3.52` Å | 244.9 / 195.8 | 289.1 / 88.0 |

These kernels were benchmarked separately with
`npm run benchmark:gpu -- --software --kernel=bonds` and
`npm run benchmark:gpu -- --software --kernel=strain`. Each command reports its
adapter and full-call timing scope. The strain report separately identifies
the CPU PTM preparation engine and elapsed time.

### GPU CNA and reference-frame strain

Validated on 2026-10-04 with Node.js v24.19.0 and Chromium 151 using the
Google SwiftShader software WebGPU adapter. These checks execute actual GPU
shaders; they do not measure performance on a physical GPU.

- The final Node suite passes 510 tests with no failures or skips.
- The final GPU suite passes 101 comparison/recovery cases: 99 execute GPU
  kernels and two explicitly unsupported open-coordinate cases use CPU.
  Seventeen common pipelines are prepared, and both CNA modes retain exact
  CPU crystal labels across crystal, triclinic, mixed-PBC, primitive-image,
  cutoff/tie and overflow cases. A 4,394-atom BCC case uses genuine GPU
  classification with no CPU corrections.
- Twenty-seven reference-strain fixtures compare all 18 fields, including
  reordered/missing IDs, affine deformation, rotations, primitive images,
  triclinic cells, singular neighborhoods and undefined fits. NaN masks and
  incomplete counts agree; maximum absolute error is `8.88e-15`.
  Undeformed structures and rigid rotations retain exact zero strain. Real
  `1e-8` strain remains positive, with relative error below `9e-7`.
  Shared compensated multiplication uses bit-truncated Dekker arithmetic;
  this avoids assuming WGSL `fma` supplies a fused product residual.
- CNA and reference-strain cancellation during preparation and after dispatch
  rejects with AbortError; subsequent work succeeds through the same GPU
  Worker. Current/reference uploads are reused and retained during fitting.
- Native application checks cover GPU/CPU recomputation, CNA legend counts,
  reference-frame changes, cache reuse, cancellation and physical replication
  from 32 to 64 atoms and back. Auto central symmetry remains CPU work and
  reuses compatible adaptive CNA labels. The full normal browser smoke also
  passes existing CPU, configuration, mobile and 204,800-atom rendering checks.

Full `examples/NiGB_minimized.cfg` runs use all 129,904 atoms. Fixed CNA uses
3.1 Å; adaptive CNA uses local shell scales. Reference strain uses 3.1 Å and
a controlled affine copy with
`F = [1.02, 0.12, 0.03; 0, 0.98, 0.05; 0, 0, 1.04]`, rather than a trajectory.
All three analyses execute genuine GPU kernels without fallback and agree
exactly with CPU, including all 18 reference-strain fields and zero incomplete
reference fits. Adaptive CNA returns 4,954 Other, 124,810 FCC and 140 BCC atoms.

| Analysis | CPU first / subsequent (ms) | Software WebGPU first / subsequent (ms) | Sparse CPU correction atoms |
| --- | --- | --- | --- |
| Fixed CNA | 791.8 / 435.0 | 1105.8 / 972.2 | 404 (0.3110%) |
| Adaptive CNA | 938.2 / 611.8 | 2606.4 / 2080.9 | 4,822 (3.7120%) |
| Reference-frame strain | 1765.7 / 1453.0 | 5323.5 / 4823.0 | 124 (0.0955%) |

Each row comes from a separate cold/subsequent benchmark using four CPU
Workers. Full-call time includes preparation/upload, shader execution,
corrections, readback and assembly. Subsequent calls reuse inputs. More than
96% of adaptive CNA atoms need no CPU classification; its correction limit is
16,384 atoms, after which the complete calculation uses CPU. These software
GPU timings are slower than CPU and do not establish hardware acceleration.

The shared arithmetic change also passes the cached PTM/ideal-strain tensor
regression on this file: maximum absolute error `7.45e-9` and 4,627 matching
NaN atoms. PTM preparation takes 2164 ms separately; tensor-only CPU first/
subsequent times are 248.9/215.2 ms, and software GPU times are 224.6/109.9 ms.

### GPU central symmetry and displacement

Validated on 2026-10-04 with Node.js v24.19.0 and Chromium 151 using the
Google SwiftShader software WebGPU adapter. The final Node suite passes
635 tests with no failures or skips; the full normal browser smoke also passes
CPU analysis, cancellation, configuration, mobile and large-structure checks.

- The real WebGPU suite passes 193 comparison/recovery cases: 191 execute GPU
  kernels and two explicitly unsupported inputs use CPU fallback. Eight
  displacement input-validation checks reject invalid IDs, populations,
  coordinates or options. Nineteen common pipelines are prepared.
- Manual CSP covers every even shell from 2 to 32, FCC/BCC/HCP and primitive
  images, defects, triclinic/mixed-PBC cells, nearly tied neighbors, radius
  expansion and insufficient or zero-length environments. Auto checks fresh
  and cached adaptive CNA, mixed-phase local settings, FCC/HCP voting,
  unresolved ties and ICO. Structure labels, shell counts, summaries, NaN
  masks and incomplete counts agree exactly with CPU; maximum scalar error is
  `5.96e-8`, with no direct CSP CPU corrections. The integer IEEE64 arithmetic
  helpers pass 61,719 exact comparisons across 8,817 operand pairs.
- Displacement checks stable integer/string IDs, reordered and missing atoms,
  generated row correspondence, wrapped/unwrapped positions, origin and cell
  changes, triclinic and mixed-PBC minimum images, half-cell ties and wide
  coordinates. Float32 components agree exactly with CPU. Ordinary magnitude
  cases differ by at most `3.11e-15` Å; a separate overflow-sized case retains a
  finite Float64 norm above the Float32 range. Genuine motion near `1e-8` Å
  remains positive, while self-displacements stay exactly zero, including a
  20,000-atom case spanning multiple dispatch batches.
- Nine cancellation checks cover ID matching and GPU preparation/dispatched
  analysis. Cancellation rejects with AbortError, preserves source inputs and
  permits subsequent work through the same GPU Worker. Resident adaptive CNA
  and current/reference Cartesian uploads are reused.
- Native application checks cover manual 8/12 and Auto CSP GPU/CPU switching,
  recognition reuse, legend quantities, displacement components/magnitude and
  Float32 arrows, accepted-result cancellation and enabled-GPU JSON replay.
  The versioned production build also executes manual 8/12, Auto and
  displacement GPU kernels against CPU outputs on 108 atoms.

The full 129,904-atom Ni grain boundary runs use genuine GPU CSP without
fallback or direct CPU pairing corrections. Manual 8-neighbor error is
`5.96e-8`; manual 12 and Auto errors are `2.98e-8`. Auto retains 124,810 FCC,
140 BCC and 4,954 Other labels; all Other sites inherit a supported shell,
and no environments remain unresolved. Its first call performs adaptive GPU
CNA with 4,822 sparse CNA corrections; the subsequent call reuses recognition
without repeating that classification.

| Analysis | CPU first / subsequent (ms) | Software WebGPU first / subsequent (ms) |
| --- | --- | --- |
| Manual CSP, 8 neighbors | 835.5 / 547.1 | 56275.5 / 50421.4 |
| Manual CSP, 12 neighbors | 821.5 / 536.9 | 58466.9 / 56233.2 |
| Auto CSP | 932.0 / 625.1 | 62303.1 / 53690.8 |
| Displacement, excluding ID preparation | 97.9 / 43.9 | 281.1 / 69.2 |

Each CSP row comes from a separate first/subsequent benchmark using four CPU
Workers and includes preparation/upload, shader execution, readback and
assembly. Strict ordering uses integer-emulated IEEE64 arithmetic on this
adapter, and software GPU CSP is substantially slower than CPU here. These
results verify execution and numerical agreement; they do not establish
performance on a physical GPU.

The displacement run uses a synthetic Cartesian translation
`[0.12, −0.08, 0.05]` Å with known same-row correspondence to the Ni reference,
rather than trajectory motion. All 129,904 atoms match, all 389,712 Float32
components agree exactly, and Float64 magnitude maximum absolute/relative
errors are `1.3878e-16` Å / `9.09e-16`. The GPU uses no CPU corrections or
fallback. Its CPU calculation uses three Workers; shared ID matching and
coordinate preparation take 53.3 ms separately and are excluded from the
table's displacement timings. The benchmark also reports workflow totals
including that preparation cost.

## Atom selection groups and physical replication

- The complete Node suite passes 431 tests. Numerical replication checks cover
  triclinic cell vectors, imported category/vector properties, stable copy IDs,
  continuous periodic trajectories, reference strain and count/memory limits.
  Float64 supercell fractions preserve sub-Float32 geometry and nonbinary
  repeat counts; only the rendering upload converts coordinates to Float32.
- Real Chromium pointer and phone-touch checks cover click and rectangle
  selection, Escape cancellation, group names/colors/visibility, member edits,
  deletion, missing/reordered frame IDs and JSON replay. Display copies share
  source IDs; physical copies can be selected independently.
- Physical replication defaults off. A primitive four-atom FCC frame retains
  coordination 3 in display-only mode; doubling its physical cell creates eight
  atoms and coordination 5. Restoring display mode recovers source geometry.
  Rapidly enabling and cancelling a 64 × 64 × 1 expansion leaves the original
  structure and enabled calculations usable. Non-periodic axes stay at one.
- Actual WebGPU preparation follows physical frames across a six-frame
  trajectory: 32 source atoms become 64 and return to 32 on disable, with GPU
  cache generations changing each time. Both GL coordinate buffers contain
  Float32 vertex attributes while analysis fractions remain Float64. All 39
  GPU differential cases and 13 warmed pipelines pass on SwiftShader.
- Recipe replay with unchanged analysis geometry preserves other cached
  reference frames; changed physical geometry invalidates CPU/GPU inputs and
  derived results. Both views inherit the displayed bond graph and vectors,
  including when the preferred calculation backend changes.

## Legend coloring quantity selector

- `npm test`: 280 tests passed, none failed/skipped. Build
  `25d067f19029b2fa` and the complete browser smoke with both screenshot flags
  passed with no page or GL errors.
- The legend and Display quantity selectors stay synchronized for imported
  scalars, entirely NaN fields, CNA/PTM/Auto symmetry, bond coordination, local
  shear and reference strain. Switching quantities starts no analysis jobs.
- Fixed bounds, palettes and Auto settings survive quantity changes and fresh
  or cached frame transitions. Pending enabled outputs stay selected until
  calculation completes. A manual choice during calculation is retained when
  an earlier analysis finishes; cancelling a displayed analysis removes its
  fields and falls back to atom types. JSON saves the selected quantity.
- Actual phone touch and keyboard selection preserve focus after legend
  redraw. Desktop and phone screenshots were inspected; the full-width dropdown
  fits above existing controls and the phone legend retains its collapse behavior.

## AtomEye analysis and viewer alignment

Validated on 2026-10-03 with Node.js v24.19.0 and Chromium software WebGL:

- `npm test`: 280 tests passed, none failed/skipped. New numerical checks cover
  element-pair bonds, distinct periodic/self images, triclinic geometry, RDF
  shell/population normalization, AtomEye geometric shear reductions and
  reference-frame strain under stretch, shear, rotation, reordered IDs and
  defects. Unmatched or underdetermined strain fits remain NaN without warnings.
- Real Worker tests cover disjoint ranges, shared/private typed inputs,
  cancellation between shear stages and independent concurrent analyses. CNA,
  PTM and the new analyses share the same capped six-Worker pool. Reference ID
  preparation yields and accepts cancellation before Worker dispatch; nested
  output buffers are counted once in the frame-cache budget.
- `npm run build` and
  `npm run test:browser -- --screenshots --structure-screenshot` passed for
  build `87509a867ba502e5`. Native Extended XYZ/PDB files exercise the parser
  Worker, trajectory navigation and new scalar/vector properties. A uniformly
  expanded second FCC frame has reference hydrostatic strain 0.0202 and zero
  shear within tolerance; the undeformed local geometric shear is near zero.
- Chromium verifies ID lookup/centering, distance/angle/dihedral picks,
  individual and element color/radius/visibility overrides, pair cutoff zero
  exclusions, RDF CSV and coordination charts. Both real GPU views show the
  same bonds/arrows without GL errors. Separate pixel checks validate cylinder
  and cone rendering, filtering, clipping and skew periodic self-image edges.
- JPG signatures, six-view PNG, visible IDs and selected-frame ZIP exports
  pass. Cancelling a ZIP creates no archive and restores the original frame
  and camera; a subsequent manual frame edit retains ownership. Recipe replay
  restores enabled analyses and appearance; importing disabled extensions
  clears derived fields/primitives on both current and cached frames.
- Actual phone screenshots were inspected. The viewport stays fixed above the
  scrolling tools, the comparison inset fits, and legends/views remain compact.
  All earlier browser regressions, including 204,800-atom clipping, still pass.

A separate Node run on 97,556 FCC atoms used six actual Workers throughout:
bonds took approximately 731 ms (585,336 edges), RDF 654 ms and local geometric
shear 1,033 ms. No additional Workers were created between these jobs; source
buffers stayed intact. Peak process RSS was about 330 MiB. These are local CPU
measurements, not browser/GPU timing guarantees.

## Scalar palettes and persistent Auto ranges

Validated with Node.js v24.19.0 and Chromium 151.0.7922.173:

- `npm test`: 197 tests passed, none failed/skipped. New checks cover Magma,
  Inferno, Cividis, Turbo and Spectral endpoints/interpolation, shared atom and
  legend stops, outlier clamping, NaN handling and JSON scheme compatibility.
  Large numeric edits keep ordered, representable bounds; overflow is rejected.
- `npm run build` and `npm run test:browser -- --screenshots --structure-screenshot`
  passed. A native three-frame LAMMPS source has distinct scalar ranges
  `[0, 3]`, `[-10, 20]` and `[100, 160]`. Highlighted Auto follows the current
  frame. Clicking it off, or editing either bound, freezes limits across both
  fresh and cached frame transitions. Blank/partial input turns Auto off while
  retaining the last valid limits, and constant data freezes to ordered bounds.
- Switching properties preserves independent ranges and maps. JSON replay
  restores fixed/Auto mode and new schemes. The narrow bounds
  `[100000000, 100000000.01]` survive palette/frame redraws and export without
  rounding into equal values or emitting an error.
- Real PNG exports produce distinct color bars for all five new palettes and
  retain selected range labels. Auto on/off text meets 4.5 contrast in both
  themes; Chromium phone emulation verifies actual taps on the toggle.
- The actual updated legend screenshot was inspected; existing analysis,
  slicing, configuration-race, phone and large-structure checks continue to pass.

Fixed ranges are represented by existing per-property recipe range entries;
absence of an entry means Auto on. The configuration schema remains version 1.

## Automatic local central symmetry

Validated with Node.js v24.19.0 and Chromium 151.0.7922.173:

- `npm test`: 191 tests passed, none failed/skipped. Auto recognizes ideal FCC,
  BCC and HCP including primitive periodic cells. Mixed phases select 12/8
  neighbors locally; vacancy environments retain elevated finite CSP through
  neighboring settings, and disjoint atom ranges reproduce the complete result.
- FCC and HCP votes both support 12 neighbors, while BCC supports 8. Ties or
  absent supported neighbors remain NaN. Raw Other labels remain Other after
  inference, and ideal HCP keeps its nonzero baseline. Unsupported ICO remains
  undefined in Auto; manual neighbor selection is available.
- Real Workers merge recognition arrays and summaries, reuse Workers already
  initialized for PTM, safely copy/share cached adaptive CNA inputs, report
  atom progress, and cancel Auto while an independent queued CNA completes.
- `npm run build` and `npm run test:browser -- --screenshots --structure-screenshot`
  passed. Native FCC/HCP/BCC and mixed-source files exercise recognition labels,
  per-atom settings, trajectory/cache restoration, Cancel cleanup and auxiliary
  color properties. Adaptive CNA results are reused; fixed CNA is not reused.
  JSON replay preserves Auto and restores older version 1 recipes as manual.
- Actual HCP and mixed-structure screenshots were inspected. Existing mobile,
  multi-slice, PNG, configuration-race and large-structure GPU checks still pass.

Auto selects local neighbor settings rather than geometrically segmenting a
structure. Local inference is a heuristic at defects/interfaces; CSP values
from different crystal phases should be interpreted within their own phase.

## Multiple tilted slices, processing recipes and PTM startup

Validated with Node.js v24.19.0 and Chromium 151.0.7922.173 using software WebGL:

- `npm test`: 177 tests passed, none failed/skipped. New tests cover normalized
  Cartesian slice normals, half-space intersection, skew-cell polygons,
  replicated/unwrapped atom visibility, arrow arcball and position geometry,
  strict configuration validation and unambiguous local-source matching.
- `npm run build` and `npm run test:browser -- --screenshots --structure-screenshot`:
  passed. Chromium edits, renames and deletes multiple slices, verifies their
  intersection, and dispatches actual pointer drags on the normal head and
  position handle. The auxiliary sphere appears, sidebar values follow and
  the camera stays unchanged. A GPU occlusion query and CPU pick verify an
  original image can be clipped while its visible replicated image remains.
- JSON export/import restores the saved frame, camera, theme, display and PNG
  flags, crystal filters, replication, named planes and enabled analyses.
  Same-source import replays immediately; import after closing the source waits
  for native selection of matching files. Invalid schema/frame recipes preserve
  settings. Held parser responses exercise importing an old-source recipe
  during a new load and changing sources during restoration's frame pre-read;
  neither stale operation can overwrite or discard the newly committed source.
  Actual text input interrupts a held restore without changing the user's
  values or frame; a rejected older pending restore cannot replace a newer
  recipe's waiting status or display a stale error toast.
- Successful tasks reuse bounded idle Workers and their PTM Wasm instances.
  Progress distinguishes queued/preparing/initializing/neighbor-indexing work
  and reports real atom counts during PTM/strain. Non-isolated inputs are copied
  in 4 MiB pieces and transferred without detaching original arrays. Tests
  confirm reused Workers do not retain old-frame coordinates, stale messages
  are ignored, real running cancellation stops computation, and closing during
  shared-buffer preparation releases the pool.
- A separate Node test run on 32,000 generated FCC atoms with six Workers took
  about 951 ms initially and 462 ms on the same Workers next time; the second
  job created no Workers or Wasm instances. The difference includes JIT warmup
  and is a local observation, not a browser/GPU speedup guarantee. Measured
  Wasm heap capacity was about 16.25 MiB per initialized Worker; at most six
  instances are retained, and source/neighbor contexts are released after jobs.

Recipe files contain file metadata and parameters, not coordinates or computed
result arrays. Browsers require the user to select local files again. Slice
editing graphics are an interactive overlay; exported PNGs contain the clipped
atom view and the independently selected legend/axis options.

## Closing sources and page-wide file drops

Validated with Node.js v24.9.0 and Google Chrome 144.0.7559.109 using
SwiftShader software WebGL:

- `npm test`: all 26 test files passed. New checks cover drag feedback across
  nested elements, normal text drags, independent numbered files in single-file
  mode, pending Worker cancellation, stale Worker messages and reopening a fresh
  source. Renderer cleanup releases coordinate/color/filter/radius/cell GPU
  buffers and source references while retaining the reusable viewport.
- `npm run build` and `npm run test:browser -- --screenshots`: passed. Chrome
  dispatches native file drags over the homepage description and header, with
  visible drag feedback. A single CFG opens directly; two numbered CFG files
  present a single-file chooser, and selecting one reports one frame.
- The filename's close button returns to the empty homepage, disables export,
  hides the legend/timeline, stops the source Worker and resumes BCC animation.
  The same file can be reopened. Closing during actual CNA Worker execution and
  trajectory playback leaves zero active/queued analysis jobs, null renderer
  frame, zero displayed atoms and a zero-byte position buffer.
- A held completed parser response and an example fetch that deliberately
  ignores its aborted signal cannot reopen the closed source. Source/frame
  generations and cancelled prefetching prevent late UI updates.
- Existing local-file/folder/example, analysis cancellation, PNG transparency,
  replication, phone gesture/layout and 204,800-atom clipping checks still pass.

## Large structures after zooming and switching to Ortho

Validated with Node.js v24.9.0 and Google Chrome 144.0.7559.109 using
SwiftShader software WebGL:

- Reproduced clipping with a `1144 × 183.04 × 11.44 Å` cell: retaining a
  perspective camera distance of `0.25 × modelRadius` in Ortho put four of its
  eight vertices outside the old near plane. This also clipped the box edges.
- Orthographic rendering now places its virtual eye ahead of all cell/atom
  bounds while retaining the zoom scale and saved perspective distance. Near
  and far planes follow cached display bounds plus the largest rendered atom
  radius. Coordinate/frame changes and replication refresh these bounds;
  orbiting uses their projected extrema without scanning all atoms per draw.
- `npm test`: all 25 test files passed. New regressions cover close zooms,
  all six standard views, orbit/pan, picking formerly clipped foreground atoms,
  growing unwrapped coordinates, negative replication vectors and enlarged
  sphere surfaces in both projection modes.
- `npm run build` and `npm run test:browser -- --clipping-screenshot`: passed.
  Chrome's native file input loads a generated 204,800-atom BCC thin-sheet CFG.
  After the close zoom and Ortho switch, all atom centers and cell vertices have
  normalized depths between `-0.9981` and `0.9981`. GPU occlusion queries confirm
  actual sample coverage for atom indices `0` and `204799`, and both can be
  picked. Every observed instanced draw submits all 204,800 atoms; WebGL reports
  no error. The screenshot shows the complete cell boundary.
- Existing PNG transparency, analyses, local files/examples, replication,
  themes, continuous homepage animation and mobile gestures still pass. The
  generated fixture verifies this failure mode; it is not the user's input file
  or a hardware GPU performance benchmark.

## Continuous BCC logo and mobile camera gestures

Validated with Node.js v24.9.0 and Google Chrome 144.0.7559.109 using
SwiftShader software WebGL:

- `npm test`: all 24 test files passed. The model checks establish eight
  unique cubic corners, one body center, eight equal body-diagonal bonds, and
  twelve cell edges with three incident edges at each corner.
- `npm run build` and `npm run test:browser -- --screenshots`: passed. The
  homepage uses a separate transparent WebGL 2 scene with sphere/cylinder
  geometry, depth testing and studio lighting. Two cropped browser screenshots
  600 ms apart differ while the canvas has no CSS transform.
- The model keeps rotating with the OS reduced-motion preference enabled;
  cropped screenshots 600 ms apart still differ and draw calls continue.
  A separate source-page check starts with reduced motion enabled and the same
  COOP/COEP headers as the localhost development server, confirming continuous
  rendering in that configuration. Loading a structure hides the homepage and
  stops its draw calls. Both theme screenshots use the live 3D model.
- Camera tests cover pinch opening/closing, screen-space translation, combined
  pinch/pan anchoring, finger-count transitions, tap selection, cancellation,
  lost pointer capture and desktop controls. Perspective and orthographic
  gestures preserve camera orientation; multi-touch never selects atoms.
- Chrome phone emulation at 390 × 844 dispatches actual two-touch events.
  Opening the span from 100 to 160 pixels changes camera distance or
  orthographic scale by `1 / 1.6`; closing restores it. Moving both fingers by
  `(24, 18)` pixels produces the expected pan with unchanged zoom and orbit.
  One-finger rotation and tap picking still work; page scrolling remains zero
  while the lower tools panel continues to scroll independently.
- Existing local-file, example, analysis, replication, phone-layout and PNG
  transparency checks continue to pass. These are correctness checks, not
  hardware GPU performance measurements.

## Display replication and responsive tools

Validated with Node.js v24.19.0 and Chromium 151.0.7922.173:

- `npm test`: 122 tests passed, none failed/skipped. Replication follows skew
  and rotated cell vectors, handles negative vector components and unwrapped
  coordinate bounds, disables non-periodic directions, validates counts and
  retains the source cell, atom buffers and property arrays. The expanded slice
  is shared by picking and selection restoration.
- `npm run build` and `npm run test:browser`: passed. A triclinic 16-atom source
  replicated `2 × 3 × 2` draws 192 atom instances while preserving the source
  coordinates and analysis arrays and scheduling zero additional analysis jobs.
  Copied atoms resolve to original IDs; category masks and PNG export include
  the copies. Reset and non-periodic controls are checked in the browser.
- Tool buttons show one configuration panel at a time. Switching panels retains
  concurrent analyses; closing an enabled analysis cancels it and clears results.
- Chromium phone emulation at 390 × 844 checks default collapsed View and
  Legend / atoms controls, expansion, crystal checkboxes and real touch scrolling
  in the lower sidebar. Canvas bounds stay fixed, page scroll remains zero and
  the document fits within the screen. A separate 844 × 390 check verifies the
  compact landscape header and independently scrolling tools. Desktop sidebar
  resizing and persistence continue to pass.
- Rendering and picking grow with displayed copies. These checks establish
  analysis isolation and behavior, not performance on a target phone GPU.

## Silent strain NaNs and analysis cancellation

Validated with Node.js v24.19.0 and Chromium 151.0.7922.173:

- `npm test`: 117 tests passed, none failed/skipped. New checks cover silent
  unmatched strain, gray coloring and a NaN legend for entirely undefined data,
  analysis-specific result cleanup, restoration of imported properties after
  repeated calculations, and accounting for retained source buffers.
- Cancellation releases running/queued tasks without starting an already-aborted
  queued Worker. The existing shared concurrency and range-merging tests pass.
- `npm run build` and `npm run test:browser`: passed. The browser confirms
  FCC-vacancy NaNs do not emit a toast, and entirely NaN strain completes without
  an error or fabricated finite values.
- Every Cancel button stops a real running Worker and restores **Not calculated**,
  start/cancel controls, metrics, coloring and the loading indicator. Cancelled
  results stay absent across cached trajectory frames and input edits; input
  reference parameters are preserved. A held completed response verifies a late
  result cannot undo cancellation. All five analyses can restart concurrently.
- Resetting completed strain preserves PTM/CNA/coordination results. Strain
  waiting on a cancelled PTM request computes its own fit; cancelling waiting
  strain leaves PTM running without scheduling a strain Worker or restoring
  removed properties. Existing PNG, theme, sidebar and deployment checks remain.

## PTM, atomic elastic strain and PNG arrows

Validated with Node.js v24.19.0 and Chromium 151.0.7922.173:

- `npm run build:ptm`: real MIT PTM library compiled with Emscripten 3.1.69 /
  LLVM 19. Browser-compatible ES modules contain no static Node imports. Vendored
  source checksums are verified; generated artifacts ship with license notices.
- `npm test`: 113 tests passed, none failed/skipped. Real Wasm tests identify
  ideal FCC/HCP/BCC/SC/cubic diamond/hexagonal diamond, primitive periodic cells,
  graphene and an icosahedral center. Mild perturbation, selectable templates,
  accepted/rejected RMSD and disabled cutoff are tested.
- Ideal-reference strain vanishes for all six supported 3D reference phases.
  A 5% uniform dilation gives hydrostatic strain 0.05125 and volume change
  0.157625; rigid rotation gives zero; finite simple shear matches the analytic
  Green–Lagrange invariants. Nonideal hexagonal `c/a`, axial stretch, edited
  lattice constants, per-species references, unmatched NaNs and cached ranges
  are checked against independent expected results.
- Real Node Workers merge parallel PTM and fresh strain including all nine
  deformation components, respect the shared concurrency cap, preserve input
  arrays and reuse shared cached fits. Adaptive cache accounting includes the
  PTM matrices without counting aliased scalar property buffers twice.
- `npm run build` and `npm run test:browser`: passed. The production build is
  served at `/AlloyView/` without isolation headers. Tests load the actual Wasm
  asset, run PTM/strain together, check Al/Fe reference presets, change `a` and
  verify the resulting physical volume change, reuse PTM, reject a mismatched
  reference, check all nine legend rows and visibility, and follow/cache BCC
  trajectory frames. Numeric types require explicit element selection; changing
  PTM's template mask keeps its classification separate from the templates
  required by strain. Existing regressions remain enabled.
- Actual PNG blobs verify optional XYZ arrows are off by default, independent
  of the screen axes toggle, limited to their overlay region and preserve
  transparent corners. Renderer tests verify rotated arrow directions. Existing
  transparent type/scalar legend pixel checks still pass.

These are deterministic scientific fixtures and browser correctness checks;
they do not establish recognition accuracy across all temperatures/materials,
million-atom performance or a target GPU's rendering speed. Atomic strain here
uses an ideal lattice reference, not OVITO/AtomEye's trajectory reference-frame
atomic-strain workflow.

## CNA and normalized central-symmetry update

Validated in the cloud environment with Node.js v24.19.0 and Chromium
151.0.7922.173, using the existing SwiftShader browser runner.

- `npm test`: 96 tests passed, none failed/skipped. Added ideal FCC/HCP/BCC,
  icosahedral center, vacancy, mild perturbation, mixed lattice scales, primitive
  periodic cells, rotated/scaled cells, skew/mixed-PBC brute-force neighbor
  comparisons, ranged kernels, palette/filter counts and real Worker tests.
- Real Node Workers verified range merging for CNA, central symmetry and
  coordination, the shared concurrency cap, shared/copied inputs, cancellation,
  pool shutdown and recovery from Worker startup/analysis errors.
- `npm run build`: passed. `npm run test:browser`: production assets without
  isolation headers tested CNA/CSP, concurrent coordination, FCC-vacancy counts
  (19 FCC / 12 Other), filtering and picking, fixed/adaptive method changes,
  BCC trajectory analysis, cached frames and superseded-result protection.
  The existing theme, contrast, scalar legend, PNG and layout assertions remain.
  Reload assertions now wait for the real page-load event and sidebar
  initialization instead of matching the previous/initial HTML state.

Representative compute measurements used a periodic 97,556-atom ideal FCC
fixture, with all CNA classifications checked against FCC and all normalized
central-symmetry results checked against zero. These are single measurements
of Node kernels / actual Node Worker execution, not browser rendering timings.
Pooled times include Worker startup, coordinate sharing and output merging.

| Analysis | Single kernel | 3 Workers, shared input |
| --- | ---: | ---: |
| Adaptive CNA | 1,996 ms | 860 ms |
| Normalized central symmetry, 12 neighbors | 1,974 ms | 821 ms |

The scheduler reserved a core from the runtime's reported four available cores.
These results establish working parallel computation for this representative
fixture. Million-atom performance and broad thermal recognition accuracy were
not validated by that update. PTM validation is recorded above.

## Browser and deployment regression update

The current fixes were validated with Node.js v24.9.0 and Google Chrome
144.0.7559.109 using SwiftShader software WebGL. The inherited remote `DISPLAY`
was removed for headless execution. This checks rendering and export correctness;
it does not establish hardware GPU performance.

Executed commands:

```bash
npm test
npm run build
npm run test:browser
```

All 16 unit-test files passed. New regressions cover the earlier `file` Worker
message and the current `files` message, single files and sequences, failed
cloning, transparent legends, and a build version that changes even when only
a Worker changes.

The browser test serves the production artifact at `/AlloyView/` without
COOP/COEP headers (`crossOriginIsolated === false`). It loaded a native local
CFG selection, the FCC and BCC examples, and all 40 NEB images, including the
last trajectory frames. It also calculated coordination, switched both themes
and their logos, checked saved theme preference and custom viewport colors,
and decoded actual PNG blobs for type and scalar legends.

For both legends with **Include background in PNG** unchecked, the exported
corner and empty legend padding had alpha **0**. With background enabled, the
same pixels had alpha **255**. Atoms and legend content remained in the exports.
The documentation screenshots were captured from these real browser views.

Follow-up UI checks drag the actual panel divider in both directions, verify
that the WebGL canvas resizes, reset the width, check persistence on reload,
and verify the stacked layout hides the divider below the desktop breakpoint.
Cutoff edits are tested without clicking Calculate. Delayed real analyses
exercise rapid edits, a single active Worker pool, skipping superseded requests,
and switching back to a cached cutoff without allowing an older result to
replace it. The browser also types a decimal legend limit one character at a
time and clears the field to verify immediate application and preservation of
the last valid range.

Homepage checks also load the supplied transparent crystal logo and capture
both themes. Browser contrast checks use computed text colors, composited
ancestor backgrounds and cumulative opacity, covering homepage copy, sidebar
labels, help text, source descriptions, and scalar legends at a minimum 7:1.
Controls, including disabled controls on the initial page, are checked at a
minimum 4.5:1 after theme transition animations finish.

The earlier environment, benchmark and validation details below remain as a
record of the original checks.

## Original validation environment

- Linux 6.8.0-134-generic x86_64
- Intel Xeon E5-2470 v2 @ 2.40 GHz, 10 cores / 20 hardware threads
- 31 GiB RAM
- NVIDIA GeForce GTX 980 Ti, driver 575.57.08 (verified outside the restricted
  command sandbox with `nvidia-smi`)
- Node.js v24.20.0
- Firefox 157.0 and geckodriver 0.37.1; no Chromium/Chrome executable or
  Emscripten compiler was available to the automated test session

The host GPU works, but the automated command sandbox did not expose an NVIDIA
device or a usable browser graphics context. Firefox was launched through
geckodriver in headless mode and loaded the application, but WebGL 2 creation
failed with `FEATURE_FAILURE_WEBGL_EXHAUSTED_DRIVERS`; the forwarded display was
not available to a non-headless process. Consequently, no GPU upload throughput,
rotation FPS, PNG pixel comparison, or browser heap figure is reported here. The
application includes live measurements for parse time,
synchronous GPU-buffer upload completion (`gl.finish()`), interaction FPS,
analysis time, and `performance.memory` when the browser exposes it. Those values
must be collected on an actual target workstation before making a rendering
performance claim.

## Executed correctness tests

Command:

```bash
npm test
```

Result: all 14 test files passed (parser, coordination and range partitioning,
Worker-count policy, cutoff recommendation, palette ranges, atomic radii,
file-sequence discovery, multi-file LAMMPS indexing, trajectory unwrapping,
adaptive frame-cache policy, renderer state, and suppression of blocking UI
progress for background frame prefetch, plus playback interval/wrapping),
with no failures. The cases executed were:

- extended CFG: 31 atoms, IDs, FCC cell, fractional/Cartesian coordinates,
  mass and `site_energy` property;
- basic CFG: `A` and `Transform` coordinate conversion, plus symmetric
  Lagrangian `eta` deformation;
- malformed/incomplete CFG rejection;
- a self-contained LAMMPS-generated CFG fixture verifies promotion of `id` and
  `ix/iy/iz`, unwrapped cell-vector translation, and removal of those semantic
  fields from generic scalar properties;
- out-of-cell CFG coordinates are wrapped while their original unwrapped view
  and inferred image flags are retained; `1e-6` boundary noise is canonicalized
  without inventing crossing history;
- restricted-triclinic LAMMPS bound correction and scaled coordinates;
- triclinic `ix/iy/iz` image translation, explicit `xu/yu/zu`, wrapping only
  along periodic axes, and partial-image-flag rejection;
- two-frame byte-offset indexing and frame-2 on-demand parsing;
- two numbered `.lmp` dump files containing two frames each: numeric file order,
  four-frame combined indexing, cross-file random frame access, and range-error
  reporting;
- explicit general-triclinic and non-numeric-property rejection;
- perfect 2×2×2 FCC coordination = 12 at 3.0 Å;
- perfect 2×2×2 BCC coordination = 8 at 3.0 Å;
- a pair across a periodic boundary is found, and is not found when that axis is
  changed to non-periodic;
- a skew restricted-triclinic periodic pair;
- a 3×3×3 FCC cell with one vacancy: exactly the 12 nearest sites change from
  coordination 12 to 11;
- LRU eviction, access-order refresh, and safe run-time cache-limit shrinking
  and growth;
- memory-policy selection of complete lazy caching for a small trajectory and a
  bounded adaptive window for a synthetic million-atom/500-frame case (policy
  test only; it does not allocate all 500 frames);
- cell-box visibility and wrapped/unwrapped display-buffer changes request
  redraws without replacing the analysis frame; transparent PNG export selects
  a transparent render, restores the opaque viewport afterward, and flips WebGL
  pixel rows into the PNG's top-to-bottom order. The canvas legend test verifies
  that a scalar PNG overlay receives the selected color-map stops and the active
  visible range.
- six standard camera presets choose the expected constrained orientation and
  orthographic projection; the coordinate tripod maps global Cartesian axes to
  screen directions;
- element-aware cutoff recommendation, periodic-table display radii with a
  generic fallback, numeric-type fallback, AtomEye-style beige/rainbow defaults,
  all selectable scalar color maps and their endpoints, custom scalar ranges
  including outlier clamping, and strict live bound coupling in both adjustment
  directions;
- per-atom visibility-mask upload for threshold filtering;
- coordination results from two independent atom-index ranges merge exactly to
  the single-range FCC result; the Worker-count policy selects one Worker for a
  small frame, two for 100k atoms on eight advertised cores, up to six for one
  million atoms, and reduces to one under an artificial clone-memory limit;
- synthetic ID-reordered periodic crossing plus all 40 files in
  `examples/fixed_end_climb`: 257 stable atoms per image, 32 non-zero inferred
  image-flag components in `replica.39.cfg`, maximum absolute flag 1, and maximum
  adjacent fractional step 0.001932 (well below the 0.5 ambiguity threshold).
- numbered CFG discovery with the varying digit run at an arbitrary filename
  position (including `replica.cfg.0`), content-based header recognition, fixed
  numeric fields, `.cfg`/`.dump` segment fallback hints, separate subdirectories,
  missing-index reporting, standalone LAMMPS files, and manual non-numbered CFG
  selection. Explicitly rejected log/text files remain excluded even when their
  filename extension might otherwise be used as a weak format hint.
- `_number.cfg` and `_number.lmp` sequence patterns plus `.lmp`, `.lammpstrj`,
  and `.lammpstraj` LAMMPS dump filename recognition.

The FCC/BCC coordination expectations are analytic reference results for a
cutoff between the first and second shells. A binary comparison against a built
upstream AtomEye executable was **not** executed, because its native dependency
stack was not built in this environment and its redistribution license remains
unclear. The independent results do exercise the same reduced-coordinate,
face-height-bin, PBC image invariants found in its source.

The optional C++ core was compiled as a native object with:

```bash
g++ -std=c++17 -O2 -Wall -Wextra -Wpedantic -c wasm/coordination.cpp
```

This checks the portable C++ source, not an Emscripten/Wasm artifact. The default
Worker JavaScript path is the runtime that was executed by the automated tests.

`npm run build` also completed successfully. The generated static site was
served locally and returned HTTP 200 for the document, the new coordination
module Worker, and `examples/fixed_end_climb/replica.39.cfg`. The observed MIME
types were `text/html`, `text/javascript`, and `text/plain`, and the server
emitted the documented COOP/COEP/CORP headers.

## 97,556-atom CPU benchmark

Command: `npm run benchmark`. Dataset: generated 29×29×29 conventional FCC
cells (97,556 atoms), 4.05 Å lattice constant, 3.0 Å cutoff, orthogonal PBC,
6.523 MiB LAMMPS text, single numeric scalar property.

| Stage | Measured result |
| --- | ---: |
| Generate benchmark text (not a product stage) | 185.14 ms |
| Parse LAMMPS frame | 323.94 ms |
| Coordination analysis | 297.24 ms |
| Candidate pairs tested | 1,905,076 |
| Result | all 97,556 atoms have coordination 12 |
| Process RSS after run | 169.97 MiB |
| Node heap used after run | 58.65 MiB |

These are one-run Node timings from the direct single-range kernel, not a browser
Worker-pool speedup measurement or browser performance guarantee. File index
time, GPU upload, and frame rate are separate stages and were not conflated with
the CPU numbers. The 1,000,000-atom path was not executed; it is explicitly
unverified.

## Behavioral checks still requiring a browser

- WebGL shader appearance, depth edges, cell line occlusion, and PNG output;
- pointer picking under perspective/orthographic cameras;
- manual feel/visual inspection of constrained Z-up orbiting, all six standard
  views, and the live coordinate tripod on the target desktop GPU;
- slice/selection/color state over manual rapid trajectory changes;
- measured GPU upload completion and sustained rotation FPS;
- confirmation from DevTools/network policy that no local file bytes leave the
  page (the code has no upload path, but this was not network-captured here);
- optional Emscripten build and result parity with the JavaScript kernel.
- visual/manual confirmation of the bottom discrete timeline, preset-adjacent
  segmented projection controls, background palette, continuously shaded 3D
  axis tripod, playback button, live legend controls, and final PNG legend
  appearance;
- end-to-end browser timing of the multi-Worker coordination pool with and
  without cross-origin-isolated shared coordinates. Unit tests cover its range
  merge and resource-selection policy, not browser scheduling speedup.
