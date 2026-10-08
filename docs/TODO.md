# Improvement backlog

Last updated: 2026-10-07 (phase 1 completed)

This backlog collects a performance and parallelism audit of AlloyView and a
feature comparison with OVITO and AtomEye. Work through it in phase order.
Within a phase, items are ordered by expected benefit per unit of effort.
Update an item's **Status** line, and add a dated entry to
[VALIDATION.md](VALIDATION.md), when you finish it.

## Rules for every change

- Keep results bit-identical unless an item says otherwise. Compare SHA-256
  hashes, or element-wise `Object.is`, against the previous build on real
  examples and synthetic crystals. State any intended numerical change and its
  tolerance.
- Keep the nonisolated path working. Production
  (<https://yazhuoliu.com/AlloyView/>) is cross-origin isolated, but the plain
  GitHub Pages address and other static hosts may not be; see
  [Deployment](DEPLOYMENT.md). Code must branch on `crossOriginIsolated` and
  `SharedArrayBuffer`, never on the host name.
- Keep background prewarming of Workers, Wasm modules and GPU preparation. It
  avoids cold starts and is a deliberate design choice, not waste.
- Update the feature page under `docs/features/`, the user guide and tests in
  the same change. Run `npm test` and the relevant `npm run test:browser:*`
  suites after `npm run build`.
- Never evaluate user-provided text as code. Configuration JSON is shared
  between users.

Measurement notes: the reference machine has 32 logical CPUs and a GTX 1080
Ti. Emscripten 3.1.69 is installed at `~/emsdk` (`source emsdk_env.sh`).
`scripts/webgpu-browser.mjs` drives headless Chrome; pass `isolated: true` for
COOP/COEP and `software: false` for the real GPU. GPU timings inflate when GPU
calls follow CPU calls in the same page, so compare GPU variants in separate
pages. Multithreaded DXA is nondeterministic run to run; compare hashes with
one thread.

Evidence tags: **[M]** measured in Node on the reference machine (median of
3–9 runs, machine under shared load, ±10% for multithreaded timings);
**[C]** confirmed by reading the code; **[E]** estimate.

Effort: **S** is a contained change to a few modules with no new tool panel;
**M** adds a panel, a parser family, a GPU/CPU pair or cross-module plumbing;
**L** changes an algorithm's structure.

## Phase 1: small changes

### P1. DXA Wasm build flags

**Status:** Done 2026-10-07. Both kernels rebuilt (plain 753 → 611 KB, threaded 791 → 654 KB). One-thread hashes of the complete normalized result were identical to the previous build for 14 cases on both kernels: the four examples (NiGB replicated 1×1×2), six NEB frames, synthetic FCC/BCC/HCP and HEA analyzed as HCP. Node wall time including JavaScript fell 5–19% [M]. **Effort:** S. **Deployments:** both.

`wasm/build-dxa.sh` builds with `-O3 -fexceptions` and
`-sDISABLE_EXCEPTION_CATCHING=0`, which routes C++ exceptions through
JavaScript `invoke_*` trampolines. It enables neither SIMD nor LTO [C].
Building with `-fwasm-exceptions -msimd128 -flto` gave, single-threaded,
HEA (28,800 atoms) 1113 → 952 ms and the Fe loop 2869 → 2490 ms; with 30
threads, 558 → 473 ms and 921 → 744 ms [M]. Atom-label and line hashes were
identical, and the binary shrank from 791 to 654 KB [M]. Native Wasm
exceptions need Chrome 95, Firefox 100 or Safari 15.2; SIMD needs Chrome 91,
Firefox 89 or Safari 16.4. PTM showed no gain from SIMD or LTO [M]; mimalloc
gave no single-thread gain and may change pointer ordering [M].

Acceptance: both kernels rebuilt; single-thread hashes of atom labels, segment
points, lengths and junctions identical on every example and test structure;
`npm test` and the DXA browser suites pass; browser minimums documented.

### P2. Binary DXA atom labels

**Status:** Done 2026-10-07. `alloy_dxa_binary_labels(1)` switches the kernel to a byte buffer read with `HEAPU8.slice`; headless callers keep the JSON array. Same 14-case hash check. **Effort:** S. **Deployments:** both.

The kernel returns per-atom structure labels inside the JSON result text
(`wasm/dxa.cpp` result serialization, parsed in `src/analysis/dxa.js`) [C].
Return them as a typed array and transfer it, so neither side formats or
parses one number per atom.

Acceptance: identical labels and network; Worker message transfers the buffer.

### P3. DXA thread count heuristic

**Status:** Done 2026-10-07. One thread per 2,048 atoms; the unit test expectation changed from 3 to 5 threads for 10,000 atoms. **Effort:** S. **Deployments:** isolated.

`dxaWorkerCount()` in `src/analysis/dxa.js` uses `ceil(count / 4096)` threads,
which is 8 for the 28,800-atom HEA example. Using 2048 (16 threads) took
555 → 516 ms in Node [M]. The shared CPU budget still caps the total.

Acceptance: thread-count unit tests updated; one-thread hashes unchanged.

### P4. Frame-commit overhead in the renderer

**Status:** Partly done 2026-10-07. Both `gl.finish()` calls are removed; **GPU upload** now reports submission time (user guide updated). The duplicate radius upload remains: avoiding it needs an O(N) comparison or a reordered frame commit, and the upload is only 4 bytes per atom. **Effort:** S. **Deployments:** both.

`src/render/webgl-renderer.js` calls `gl.finish()` twice per frame commit only
to time the upload for the Performance panel, which stalls the CPU until the
GPU drains [C]. Atom radii and the position texture are uploaded twice per
frame [C]. Remove the synchronous waits (report CPU-side upload time and say
so) and the duplicate uploads.

Acceptance: identical rendered pixels in the browser suites; Performance panel
text documents what the upload metric measures.

### P5. Vector-arrow index construction

**Status:** Done 2026-10-07, together with the same callback pattern in `translatePeriodicPoints()`. **Effort:** S. **Deployments:** both.

`src/render/atom-primitives.js` builds the arrow index with
`Uint32Array.from({ length }, callback)`: 18 ms at 130k atoms [M]. A plain loop
fills the same array in under 1 ms [E].

### P6. Selection-group ID matching on new frames

**Status:** Done 2026-10-07 in `src/data/atom-ids.js`. At 1M atoms: hidden-group mask 371 → 38 ms, group summary 443 → 79 ms (sorted typed-array search), appearance lookup 609 → 205 ms [M]. Tests compare every helper with `String(id)` matching, including `07`, `-0`, NaN, 1e21 and BigInt IDs. **Effort:** S. **Deployments:** both.

With a hidden group, `selectionGroupVisibility()` in `src/selection-groups.js`
converts every frame ID to a string and looks it up in a string set on each new
frame: 37 ms at 130k atoms, 412 ms at 1M [M]. Group summaries and appearance
lookups by ID repeat similar string work (55 ms and 60 ms at 130k) [M]. Match
numeric IDs against a numeric set. Keep string matching only for IDs whose
canonical string form differs from their number, so results are unchanged.

### P7. Legend recoloring on the main thread

**Status:** Done 2026-10-07 (exact part). Categories use 256-entry tables with a Map fallback for other values; color-map stops are flattened once. At 1M atoms: category colors 101 → 30 ms, category mask 145 → 19 ms, scalar colors about 51 → 37 ms; all outputs byte-identical across every color map and category edge case [M]. Caching data limits was not done: it saves under 10% and would rely on property arrays never changing in place. **Effort:** S (exact part). **Deployments:** both.

Each legend edit or slider tick (already coalesced to one animation frame)
recomputes every color, the data minimum/maximum, masks and the histogram, then
re-uploads whole buffers: 11 ms per tick at 130k atoms, 75–90 ms at 1M [M].
`colorsByCategory()` takes 11 ms and `visibilityByCategory()` 17 ms at 130k;
table-driven versions took 0.8 ms and 0.3 ms [M]. Cache data limits per data
array and visibility mask; use lookup tables for categories.

Acceptance: identical color and mask bytes; unit tests for categories with
NaN, hidden IDs and unknown IDs.

### P8. Parser tokenizing

**Status:** Done 2026-10-07 with typed arrays and loops; NiGB CFG about 460 → 410 ms, dumps unchanged within noise [M]. A manual tokenizer matching `\s` exactly was tried and dropped: it was 20% slower than the native split on two dumps. All 44 example files and six malformed variants give identical frames and errors. **Effort:** S. **Deployments:** both.

`src/io/cfg.js` and `src/io/lammps-dump.js` split every line with a regular
expression, grow plain arrays and copy them with `Float64Array.from` /
`Uint16Array.from` callbacks [C]. A manual whitespace tokenizer and preallocated
typed arrays took NiGB (CFG, 130k atoms) 449 → 380 ms with identical output
[M]. Keep every validation and error message; an earlier prototype dropped
element-symbol validation and must not be copied.

Acceptance: element-wise identical frames on all examples; existing parser
error tests unchanged.

### P9. Bond-statistics GPU correction buffer

**Status:** Done 2026-10-07; `zeroBuffer(buffer, offset, size)` clears only the 16-byte header. RDF had the same pattern and was changed too. **Effort:** S. **Deployments:** both, WebGPU only.

`src/analysis/gpu/bond-statistics.js` clears the whole 12.6 MB correction
buffer for every 2,048-atom batch [C]. Clear only the region the next batch
reads (its header), leaving results unchanged.

### O1. PTM orientation and chemical ordering outputs

**Status:** Done 2026-10-07. New properties `ptmOrderingType` and `ptmOrientationW/X/Y/Z`. The five existing PTM outputs are identical to the previous kernel on examples and synthetic crystals; L1₂, B2, pure and three-species fixtures give the expected classes. **Effort:** S. **Deployments:** both.

`wasm/ptm.cpp` exports type, RMSD, scale, interatomic distance and F only. The
vendored PTM library already computes the lattice orientation quaternion and
the binary ordering type (L1₂, L1₀, B2, …), but the orientation is discarded and
neighbor atom types are never supplied, so ordering cannot be found [C]. Export
both, using atom types as PTM's numbers, and publish them as per-atom
properties: four quaternion components and an ordering category. OVITO
reference: `particles/modifier/analysis/ptm/PolyhedralTemplateMatchingModifier.cpp`
(options `outputOrientation`, `outputOrderingTypes`; OVITO Basic, GPLv3/MIT).

Pitfalls: ordering is defined by PTM for binary chemistry, so multi-element
alloys mostly report "Other"; quaternions jump across fundamental-zone
boundaries; existing PTM outputs and ideal-lattice strain must stay identical.

### O2. D²min in reference-frame strain

**Status:** Done 2026-10-07 as `referenceD2min` (Å²), using the same expansion on CPU and GPU. Tests check zero for affine deformation and agreement with a direct per-neighbor sum. **Effort:** S. **Deployments:** both.

`docs/features/reference-strain.md` states that Frame strain does not report
non-affine D²min [C]. After fitting F, add
D²min = Σ |dᵢ − F·Dᵢ|² over the same neighbors (OVITO's definition, not divided
by the neighbor count; OVITO `particles/modifier/analysis/strain/AtomicStrainModifier.cpp`).
Compute it in both the CPU and WGSL paths and test CPU/GPU agreement.

### O3. LAMMPS data file import

**Status:** Done 2026-10-07 (`src/io/lammps-data.js`); styles atomic, charge, molecular, bond, angle, full, sphere and dipole; documented in [file formats](FORMATS.md#lammps-data-file). **Effort:** S. **Deployments:** both.

`docs/FORMATS.md` rejects LAMMPS data files, yet most metal simulations start
from `write_data` or Atomsk output. Parse the header (atom count, types, box with
tilt factors), `Masses` (with optional comment type names) and `Atoms` in the
common styles (`atomic`, `charge`, and the `# style` hint), plus optional image
flags and `Velocities`. OVITO reference:
`particles/import/lammps/LAMMPSDataImporter.cpp`.

### O4. VASP POSCAR/CONTCAR import

**Status:** Done 2026-10-07 (`src/io/poscar.js`); documented in [file formats](FORMATS.md#vasp-poscar-and-contcar). XDATCAR remains phase 2. **Effort:** S. **Deployments:** both.

DFT and SQS alloy cells usually come as POSCAR. Support VASP 5 species lines,
VASP 4 files without them, a negative scale factor (target volume), selective
dynamics, and Direct or Cartesian coordinates. XDATCAR trajectories belong to
phase 2. OVITO reference: `particles/import/vasp/POSCARImporter.cpp`.

### A1. Double-click an atom to make it the rotation center

**Status:** Done 2026-10-07 in the shared pick path, so mouse double-clicks and touch double-taps behave the same in both views. It is off while measuring or picking slice or group atoms, and a press anywhere else starts the sequence over. **Effort:** S. **Deployments:** both.

AtomEye makes a right-clicked atom the rotation and zoom anchor. AlloyView needs
the Center button inside the folded Details window
(`src/atomeye-tools.js`, `centerOnAtom`) [C]. Double-click or double-tap an atom
in `src/render/camera-interactions.js` to center the camera on the picked
replica without changing the selection mode.

Pitfalls: must not fire during box selection, slice picking or measurement
picking; the first click of the pair still selects as today.

### A2. Color-tiling tracer

**Status:** Done 2026-10-07 as **Displacement → Color tiles per cell vector**, publishing the categorical **Color tile** property; settings are saved in configuration JSON. **Effort:** S. **Deployments:** both.

AtomEye F2 paints an n₁×n₂×n₃ checkerboard in reduced coordinates and F3
re-applies those colors to later frames by atom (`A3/scratch.c`). AlloyView has
no equivalent (`docs/ATOMEYE_REVIEW.md`). Compute tile parity from the reduced
coordinates of a chosen frame, store it by stable atom ID, and publish it as a
categorical property, so slip steps and shear bands show in later frames.

### D1. Documentation corrections

**Status:** Done 2026-10-07. **Effort:** S.

- `docs/STRUCTURE_ANALYSIS.md` (around line 296) states "at most six Workers,
  `hardwareConcurrency − 1`". `cpuWorkerLimit()` in `src/analysis/cpu-budget.js`
  uses `hardwareConcurrency − 2` without a six-Worker cap.
- `docs/ATOMEYE_REVIEW.md` lists multiple vector overlays as a gap; vectors
  already support multiple fields (`docs/features/vectors.md`). Sixteen cutting
  planes and the periodic display origin are also implemented.

## Phase 2: medium changes

### P10. Shared neighbor index and dynamic chunks for CPU analyses

**Effort:** M. **Deployments:** mostly isolated.

Each analysis splits atoms into static equal ranges, every Worker rebuilds a
full-frame `NeighborSearch` per call, and on isolated hosts the main thread
copies inputs into a fresh SharedArrayBuffer per call
(`src/analysis/analysis-pool.js` ~518–578, `src/analysis/neighbors.js`) [C]. At
130k atoms the index build is about 45% of an adaptive-CNA range and 10% of a
PTM range; slowest/mean range time is 1.18 for PTM and 1.37 for CNA [M].
`chooseWorkerCount` charges 48 B/atom against 15% of the JS heap, so 1M-atom
PTM gets 7 of 30 Workers when isolated [M]. Build the cell list once into a
frame-keyed shared buffer (as the Voronoi snapshot does), hand out bounded
chunks dynamically, and keep one resident private index per Worker when
nonisolated. Expected: CNA/CSP/bonds −30–45%, PTM −15–25%, up to ~3× for 1M-atom
PTM [E].

### P11. WebGPU batch pipelining

**Effort:** S–M. Every 16,384-atom batch submits and then awaits
`onSubmittedWorkDone()` before the next (`src/analysis/gpu/runtime.js` ~701–715);
the neighbor-index build is batched the same way (62 round trips at 1M atoms)
[C]. Build the index in one dispatch, keep two or three batches in flight, and
use 64k+ batches on hardware adapters. Light kernels 2–5×, CNA/CSP 5–20% [E].
Watch driver watchdog limits.

### P12. WebGPU readbacks and task queueing

**Effort:** S–M. Each read creates a staging buffer and maps it in its own
`mapAsync` (coordination 3–4, local shear 5, bonds 3, RDF 2–3 per batch;
`runtime.js` ~721–732). Bond statistics uses 2,048-atom batches. The GPU client
keeps one task in flight (`src/analysis/gpu/client.js` ~180–196) [C]. Pool
staging buffers and map once per batch, use 16k+ bond-statistics batches, post
the next task as soon as its frame is resident, and share exact-f64 coordinates
between CSP and PTM. 5–50 ms per analysis, 2–5× for bond statistics [E].
Bond-statistics moments may change in the last bit; their merge order is
already nondeterministic.

### P13. Shader-side colormap while dragging legend limits

**Effort:** M. Upload one scalar per atom and map colors in the vertex shader
during a drag; recompute exact CPU colors when the drag ends. Removes the
75–90 ms per tick at 1M atoms [M].

### P14. Byte-level parsers

**Effort:** M. A prototype that parses the dump atom block from bytes matched
`Number()` on every value and took HEA 50 → 15 ms and Fe 250 → 50 ms [M]. Apply
to dump, CFG and XYZ with the same validation and error messages.

### P15. Parallel trajectory parsing and prefetch

**Effort:** M. One structure Worker parses frames serially, prefetch cannot be
cancelled (`src/worker-client.js`), the first frame waits for the whole file
index (`src/workers/structure-worker.js` ~78–82), playback is not double
buffered, and replication runs on the main thread (0.9 s at 1M atoms) [C/M].
Parsing with 1/2/4/8 Workers took HEA 71/36/18/13 and Fe 312/152/87/46 ms per
frame [M]. Add prefetch Workers with one reserved for the requested frame,
incremental indexing, and replication in a Worker.

### P16. Nonisolated DXA fallback

**Effort:** S–M. The tetrahedron snapshot is copied on the main thread once per
stage Worker (about 4 × 23 MiB for HEA) [M]. Send it from the DXA Worker to stage
Workers over a MessagePort and give each stage its own Worker cap. Tens of ms [E].

### P17. Browser versus Node DXA gap

**Effort:** S (investigation). Production reported 854 ms for HEA with 8 threads;
Node took 555–650 ms [M]. Profile the browser run (pool growth, snapshot copies,
JSON) before further DXA work.

### O5. Expressions: compute property and expression selection

**Effort:** M. Compute per-atom properties (for example von Mises stress from
per-atom stress divided by Voronoi volume) and select atoms by expressions such
as `CSP > 8 && Type == 3`, plus invert and expand-by-neighbors selection. Parse
expressions into a safe evaluator over typed arrays; never use `eval` or
`new Function`. OVITO references: `stdmod/modifiers/ComputePropertyModifier.cpp`,
`stdmod/modifiers/ExpressionSelectionModifier.cpp`,
`particles/modifier/selection/ExpandSelectionModifier.cpp`.

### O6. Cluster analysis

**Effort:** S–M. Union-find over cutoff neighbors or the bond graph, optionally
restricted to a selection; outputs cluster ID, size, unwrapped center of mass,
radius of gyration and a size table. OVITO:
`particles/modifier/analysis/cluster/ClusterAnalysisModifier.cpp`.

### O7. Wigner–Seitz defect analysis

**Effort:** M. Assign atoms to the nearest reference-frame site; report
vacancies, interstitials and antisites (per-type occupancy). Needs a rendered
point set for empty sites. OVITO:
`particles/modifier/analysis/wignerseitz/WignerSeitzAnalysisModifier.cpp`.

### O8. gzip input

**Effort:** M. Decompress with `DecompressionStream` in the parser Worker and
keep random access by indexing the decompressed stream, spilling to OPFS for
large trajectories. Also requested by AtomEye users.

### O9. Spatial binning profiles

**Effort:** M (new panel, chart and CSV). OVITO's binning is Pro-only; implement
independently. Bin in reduced coordinates for triclinic cells.

### O10. Smooth trajectory, trajectory lines and unwrapping

**Effort:** M. Time-averaged positions before CNA/PTM/DXA at high temperature;
lines for solute and vacancy paths; unwrap from adjacent frames. OVITO:
`SmoothTrajectoryModifier.cpp`, `GenerateTrajectoryLinesModifier.cpp`,
`UnwrapTrajectoriesModifier.cpp`.

### O11. Radical (radius-weighted) Voronoi

**Effort:** M. Voro++ supports it, but the WebGPU Voronoi path needs a matching
weighted kernel and CPU/GPU parity tests.

### O12. Text labels and time series

**Effort:** M. Stamp timestep, strain or phase fractions on PNG and frame-ZIP
exports, and plot per-frame values. OVITO's text label overlay is Basic; time
series is Pro-only and must be implemented independently.

### O13. Ambient occlusion

**Effort:** M. Per-atom brightness from offscreen passes (OVITO
`AmbientOcclusionModifier.cpp`); recompute on visibility, slice or frame changes.

### O14. Orientation coloring

**Effort:** M, after O1. Color by PTM orientation (inverse-pole-figure or
quaternion RGB) through a new legend kind.

### A3. Global keyboard commands

**Effort:** M. AtomEye drives navigation from the keyboard with a step-size
"gearbox" (0–9). AlloyView has no global shortcuts beyond Escape. Add a command
registry, a shortcut overlay and rebinding stored in localStorage; ignore keys
while inputs have focus.

### A4. Discrete legends for integer properties

**Effort:** S–M. Show integer properties with few values (coordination, cluster
or grain IDs) as categories with per-value hiding, and hide the clicked atom's
class with one gesture. Store hidden values, not indices.

### A5. Cutting-plane sweep

**Effort:** S–M. Step, flip and slab controls for slices, a Miller-index normal,
and the plane-cell outline (`planeCellPolygon` in `src/render/slicing.js`) drawn
persistently and optionally in exports.

### A6. Drag the crystal across periodic boundaries

**Effort:** M. Turn a screen drag into a periodic-origin shift, wrapping in the
vertex shader during the drag and rebuilding bonds, vectors, DXA lines and
Voronoi cells on release.

### A7. Export at a chosen resolution

**Effort:** M. Render to an offscreen antialiased framebuffer at the requested
size, tiling beyond GPU limits, and scale legends and axes. The current export
uses the canvas size with device pixel ratio capped at 2.

### A8. Follow a growing trajectory

**Effort:** M. Use File System Access handles to extend the byte index as a
running simulation appends frames (Chromium only).

## Phase 3: large changes

### P18. Parallel DXA edge building and edge mapping

**Effort:** L. With 8 threads, about 275 ms of the HEA run stays serial: edge
building 61, edge mapping 87, Burgers tracing 90, clusters 14, serialization
23 ms; Delaunay scales only 2.1× [M]. Collect edge candidates and path-finder
results in parallel, then commit in the original order. Burgers tracing and
junction merging need an algorithm redesign. Expected floor for HEA about 400 ms.

### O15. Grain segmentation

**Effort:** M–L, after O1. Port OVITO's
`crystalanalysis/modifier/grains/GrainSegmentationEngine.cpp` next to the PTM
kernel. Validate the automatic merge threshold against OVITO.

### O16. Surface mesh and DXA defect mesh

**Effort:** M–L. Alpha-shape surfaces for voids, nanoparticles and fracture,
reusing the vendored Geogram Delaunay; export the existing but unused
`InterfaceMesh::generateDefectMesh()` from the DXA port. Handle periodic capping.

### A9. Command scripts and movies

**Effort:** L. A strict command grammar over the A3 registry, camera keyframes,
and WebCodecs video encoding with a small vendored muxer.

## Deferred or rejected

- Skipping WebGPU Voronoi preparation when Voronoi is unused would save GPU work
  but contradicts the prewarming design; needs an explicit owner decision.
- PTM SIMD/LTO and mimalloc for DXA: no measured gain [M].
- OVITO elastic strain (duplicates ideal-lattice strain), Ackland–Jones and
  diamond identification (covered by CNA/PTM), Chill+, VoroTop, rings, bond
  order, Bader, structure factor, coordination polyhedra (Voronoi cells cover
  it), spatial correlation, combine datasets, affine transformation, freeze
  property, GSD/GROMACS/MOL2/CIF/Cube/VTK formats, NetCDF, Python modifiers,
  OSPRay/Tachyon rendering and other Pro-only features.
- OVITO's current tree no longer contains DXA; keep the v3.9.4 pin in
  `third_party/dxa`.
- AtomEye NetCDF, Python/Jupyter bridge (conflicts with browser-only, no-upload
  design), Voronoi polycrystal builder, EPS output, more native windows, MPI
  rendering and `.usr` color files.

## Sources

- OVITO GitLab master at commit `81d76297` (September 2026) and documentation
  version 3.16.1: <https://docs.ovito.org/reference/pipelines/modifiers/index.html>,
  <https://docs.ovito.org/reference/file_formats/file_formats_input.html>.
- AtomEye: <http://li.mit.edu/Archive/Graphics/A/>,
  <http://li.mit.edu/Archive/Graphics/A3/A3.html>,
  <https://github.com/jameskermode/AtomEye> at `c418eb2`.
- Measurements: performance-audit scripts run on 2026-10-07 against commit
  `cfa3338`.
