# Improvement backlog

Last updated: 2026-10-11 (America/New_York). Audited commit: `dbe6055`.

The feature plan is complete, so this backlog now tracks defects and
performance work only. Earlier backlog items (P1–P18, O1–O16, A1–A9,
D1) are described in the feature pages, [performance](features/performance.md),
[analysis implementation](STRUCTURE_ANALYSIS.md) and the
[DXA CPU profile](DXA_CPU_PROFILE.md); [VALIDATION.md](VALIDATION.md) keeps
their dated records under those labels. The labels are retired and are not
reused here.

This backlog comes from a whole-project audit on 2026-10-10: six read-only
audits (CPU analyses, WebGPU compute, rendering, file and trajectory flow,
application shell, feature interactions) with measurements and prototypes. It lists
defects first, then performance work in three phases. Within a part, items are
ordered by expected benefit per unit of effort. When you finish an item, move
its durable description into the relevant document, add a dated entry to
VALIDATION.md and delete the item here.

## Rules for every change

- Keep results bit-identical unless an item says otherwise. Compare SHA-256
  hashes, or element-wise `Object.is`, against the previous build on real
  examples and synthetic crystals. State any intended numerical change and its
  tolerance.
- Keep the nonisolated path working. Production
  (<https://yazhuoliu.com/AlloyView/>) is cross-origin isolated, but other
  static hosts may not be; see [Deployment](DEPLOYMENT.md). Code must branch on
  `crossOriginIsolated` and `SharedArrayBuffer`, never on the host name.
- Keep background prewarming and prefetching of Workers, Wasm modules, frames
  and GPU preparation. They are a deliberate design choice. Items below make
  them cheaper or better targeted; none removes them.
- A canvas-size image export must stay pixel-identical to the screen.
- Update the feature page, the user guide and tests in the same change. Run
  `npm test` and the relevant `npm run test:browser:*` suites after
  `npm run build`.
- Never evaluate user-provided text as code. Configuration JSON and scripts
  are shared between users: validate before use, and check lengths before
  copying array-like values.

## How to read the evidence

Measurements were taken on the reference machine: 40 logical CPUs, one GTX
1080 Ti, headless Chrome 154, Node.js 26. The machine is shared, so timings are
medians of interleaved runs and counts are preferred over wall time.

Structures: HEA 28,800 atoms (`examples/hea-fcc-screw.dump`), Fe loop 60,229
(`examples/Fe_disloc_loop.dump`), NiGB 129,904 (`examples/NiGB_minimized.cfg`),
and the Fe loop replicated to 120,458 ("120k") and 963,664 ("1M") atoms.
"6w" and "14w" mean CPU pools of 6 and 14 Workers.

Evidence tags: **[M]** measured or reproduced by a script; **[C]** confirmed by
reading the code; **[E]** estimate. Effort: **S** touches a few modules, **M**
adds cross-module plumbing or a protocol change, **L** changes an algorithm's
structure.

The audit's reproduction scripts and prototypes are not part of the
repository. On the reference machine they are archived beside it, in
`../AlloyView-audit-2026-10-10/` (`cpu/`, `gpu/`, `render/`, `io/`, `shell/`,
`bugs/`, and
one `REPORT-*.md` per audit). Items name the script that reproduces them.
Prototype gains quoted as "verified" had outputs equal to the current code.

## Suggested order

The items with the best return, drawn from all parts below:

| Order | Item | What it gives | Effort |
| --- | --- | --- | --- |
| 1 | B23, B24, B30 | Preview restoration, radical-radius dependencies and stable legend focus | S–M |
| 2 | R1 | MSAA cap removal still needs a coverage proof; single-sample guard is complete | M |
| 3 | T2, T4 | Bound smoothing buffers and fuse dump coordinate/type passes | S–M |
| 4 | S4 | Enable the prepared immutable-asset rules on the production CDN | S |
| 5 | R2, R4 | Remaining orientation-color and picking loops | S |

C1–C9, R3/R8, S1–S3/S5, T1/T3/T5 and K2 have moved to the feature
documentation and dated [validation record](VALIDATION.md). R1 retains its MSAA
restriction below; measurements are scoped to the tested deployment and hardware.

## Part 1: defects

Fix these before performance work. B1–B6 and B10, and G1, were completed
on 2026-10-10. B7, B11 and B12/T5, and C1–C3 and S2/S3, were completed
on 2026-10-11; B2 rollback was also rechecked. See the process and validation
record in [VALIDATION.md](VALIDATION.md). B31, B8, B9, B14, B17, B18 and B20
were completed in the next 2026-10-11 batch. B13/T1, B16/B37 and B28/B29
were completed in the following batch, along with C5/C6/C9, S5 and K2.
R1 gained a single-sample capless guard; MSAA remains capped. Completed labels
are not reused. The following batch completed B15/B19/B21/B22/B26/B27/B33
and C7/C8. S4's build/preview policy is complete; enabling the external CDN
rules remains below.

### Lower-severity defects

| ID | Problem | Evidence | Fix | Effort |
| --- | --- | --- | --- | --- |
| B23 | Camera-path preview does not return to its starting frame when frames load slowly | `bugs/A-movies/b8-preview-restore.mjs`, 4 of 4 [M] | On stop, show the starting frame whenever a load is pending | S |
| B24 | Radical Voronoi with radii from an expression of an analysis output fails on every frame change | `bugs/D-kernels-inputs/b09-radical-radius-expression-frame-change.mjs` [M] | Wait while the radius property has a pending dependency; rerun when computed properties refresh | S–M |
| B25 | Transparent PNG at "Current viewport" has edge fringes (1,927 of 290,700 pixels, up to 53 levels) | `bugs/C-labels-ao-export/t5-transparent-matte.mjs` [M] | Use the offscreen black/white matte for this path too; this changes that export's pixels | S |
| B30 | Every refresh rebuilds the legend and drops keyboard focus; the legend cannot be edited during playback | `shell/bugs2.mjs` [M] | Update the legend in place when its kind, property and items are unchanged | M |
| B32 | Small touch targets on phones (text buttons 28×11 px, help links 19×19) | `shell/mobile.mjs` [M] | 32–44 px hit areas under the mobile media query | S |
| B34 | GPU results that depend on neighbor order are not reproducible between runs: frame strain on 6,912 and 60,229 atoms differs in 7–11 of 1,144,351 values (at most 1.5×10⁻⁸), HEA bonds and Q4/Q6 differ between two pools, and GPU Voronoi digests differ between page loads | Found while fixing B1 and B5; the GPU neighbor grid is filled with `atomicExchange`, so the order of each cell's list varies [M] | Sort each cell's list, or accumulate in an order-independent way; decide first whether run-to-run identity is required on the GPU | M |
| B36 | `npm run test:gpu:voronoi` on the software adapter takes 285–320 s on the reference machine against a 360 s evaluate timeout, so a loaded machine can fail it without a defect | Measured on 2026-10-10 [M] | Split the page evaluation into two calls, or raise the timeout for this suite | S |
| B35 | Trajectory lines for a selection group of physical copies find no atoms ("IDs not found (@AlloyView:copy…)"); lines work for source IDs | Seen while fixing B1 [M] | Map copy IDs to their source atom and add the copy's cell offset, or state the restriction in the panel | S–M |

Suspected but not reproduced: the movie frame range persists across files
beyond the new frame count. The expression variable `ID` is NaN for physical
copies (may be by design; B35 is its visible consequence).

## Part 2: performance, phase 1 (small changes)

### G2. A routing table, and a memory of fallbacks

**Effort:** S (static table), M (measured model). **Deployments:** WebGPU on.

- **Evidence [M]:** warm medians in ms, GPU / CPU 6w / CPU 14w:

| Kernel | 28.8k | 60k | 130k | 1M | Verdict |
| --- | --- | --- | --- | --- | --- |
| Coordination | 11 / 142 / 206 | 11 / 203 / 242 | 11–15 / 181 / 286 | 52 / 911 / 481 | GPU |
| CNA fixed | 11 / 36 / 35 | 16 / 93 / 51 | 25–30 / 115 / 81 | 178 / 1482 / 639 | GPU |
| CNA adaptive | 39 / 60 / 60 | 30 / 134 / 78 | 128–136 / 203 / 120 | 347 / 2153 / 851 | GPU; tie with 14w at 130k |
| Central symmetry, 12 | 58 / 39 / 41 | 57 / 72 / 41 | 134–146 / 150 / 93 | 714–1594 / 1276 / 472 | CPU with 14w |
| Central symmetry, Auto | 78 / 57 / 84 | 82 / 109 / 61 | 166 / 227 / 139 | 811–1659 / 1889 / 848 | Tie |
| Bonds | 50 / 48 / 48 | 83 / 109 / 80 | 127–149 / 170 / 117 | not run | Tie |
| Bond distributions | 67 / 71 / 84 | 124 / 190 / 132 | 442–499 / 280 / 183 | 1531 / 3588 / 1828 | CPU at 130k |
| RDF | not periodic | 25 / 182 / 106 | 86 / 58 / 57 | 842 / 3854 / 1629 | GPU unless it falls back |
| Local shear | 11 / 62 / 67 | 15 / 131 / 106 | 49–52 / 151 / 138 | 380 / 1962 / 981 | GPU |
| Displacement | 8 / 33 / 37 | 13 / 64 / 62 | 22–24 / 57 / 70 | 109 / 653 / 372 | GPU |
| Reference strain | 21 / 245 / 192 | 47 / 568 / 335 | 229 / 1000 / 741 | 1650 / 9874 / 4670 | GPU |
| Ideal strain tensor | 17 / 119 / 106 | 15 / 179 / 198 | 25–30 / 315 / 356 | 245 / 2518 / 2176 | GPU |
| Voronoi | 2560–4700 / 230–350 / 240–260 | 5700–8900 / 500–660 / 480–600 | 25,600 / 11,000 / – | not run | CPU (done: Voronoi runs on the CPU unless its WebGPU kernel is turned on) |

- **Also [M]:** every call retries a GPU path that failed before. RDF on NiGB
  costs 86 ms instead of 57; on NiGB 2×2×2 adaptive CNA costs 3.6 s instead of
  2.5 s.
- **Change:** start with a static table (bond distributions to
  CPU from 100k atoms with 6 or more Workers; central symmetry to CPU with 12
  or more Workers), then a per-kernel cost model corrected by measured times.
  Remember a `GpuUnavailableError` per source revision, kernel and parameters
  and go straight to the CPU until they change. Pin the backend within one
  batch or time series, because backends agree only within documented
  tolerances.
- **Note:** these are pre-fix audit CPU timings. C3/C4 and the C5 scalar kernels are complete; the following C5/C6/C9 completion batch measured whole-pool effects separately.
  See VALIDATION.md for its CPU-quota and cold-start limitations.

### T2. Smoothing: size the coordinate store to the window

**Effort:** S. **Deployments:** all.

- **Where:** `src/workers/trajectory-processor.js` (192 MiB LRU store).
- **Evidence [M]:** at 1M atoms the store holds 10.4 snapshots, so each
  consecutive smoothed frame re-reads 1 frame at w = 3, 4 at w = 5 and the
  whole window of 20 at w = 10; one read is a 390 ms parse.
- **Change:** budget = max(192 MiB, (2w + 2 + read-ahead) snapshots) with a
  hard cap and a status note; share one ID array between snapshots with equal
  IDs; evict by distance from the current window. A sliding sum was rejected
  because it changes the summation order.

### T4. Dump parser: fused tail pass and coordinate-only reads

**Effort:** S. **Deployments:** all.

- **Evidence [M]:** `finishDumpFrame` spends 59 ms in a `Set` and per-atom
  `Map.get` for types and 42 ms in three coordinate passes, of about 395 ms
  for a 1M frame.
- **Change (verified, `io/proto/lammps-dump-opt.js`):** a dense type table and
  one fused pass with the same rounding points; identical arrays on 8 files.
  Parse 387 → 323 ms at 1M and 22.5 → 17.5 ms at 60k. A coordinate-only
  projection (IDs and wrapped coordinates) is 1.39–1.6× faster than a full
  parse; use it for unwrap integration, smoothing neighbors and trajectory
  lines. Add a same-order fast path to `unwrapSequenceFrame`, which builds a
  130k-entry `Map` per CFG frame.

### R1. MSAA capless-bond coverage

**Effort:** M. **Deployments:** multisampled WebGL.

Indexed primitives and the conservative single-sample bond guard are complete.
Safe single-sample bonds use 60 rather than 120 indices; hidden or undersized
endpoints, slices, uncertain bounds and all offscreen exports keep caps. Camera
moves use a constant-size projection/depth check, without scanning every bond.

- **Remaining:** prove cap coverage under MSAA before removing those caps.
  A real-browser negative control produced one differing pixel (three RGB
  bytes, maximum difference 12) even when analytic geometry put the cap behind
  an endpoint sphere. This is an observed difference, not a demonstrated
  driver mechanism. Default antialiasing therefore retains capped geometry.
  Further isolation places the differing pixel inside the sphere's opaque
  projected disc (normalized radius squared 0.000505); widening only the
  edge margin does not explain or eliminate this counterexample.
- **Verify:** strict pixel equality for current and exported views, periodic
  shifts, per-atom radii, hiding, slices and context restoration. Avoid an
  O(bond-count) coverage scan on every camera move without measuring its cost.
- See [performance](features/performance.md) and [validation](VALIDATION.md).

### R2. Orientation colors: scalar per-atom loop

**Effort:** S. **Deployments:** all.

- **Where:** `src/render/orientation-colors.js`, the resolver loop and its
  helpers.
- **Evidence [M]:** at 963,664 atoms the inverse-pole-figure colors take
  2,206 ms on the main thread and Rodrigues colors 3,107 ms: about ten
  short-lived arrays per atom, plus 24 symmetry candidates in Rodrigues mode.
- **Change:** normalize in locals, sort three values with compare-swaps and
  write bytes straight into the color array; flatten the symmetry table.
  Keep `Math.hypot` and the operation order so bytes stay identical, and keep
  the exported helpers as the reference for a byte-comparison test.
- **Gain (verified for IPF):** 2,206 → 236 ms with no differing byte;
  Rodrigues 5–10× expected [E].

### R4. Picking: tighten the per-atom loop

**Effort:** S. **Deployments:** all.

- **Evidence [M]:** a click costs 62.9–77.5 ms at 963,664 atoms and 89 ms with
  a plane slice (`pick()` in `src/render/webgl-renderer.js`): every atom gets
  the full projection, the edge projection and the radius arithmetic.
- **Change:** hoist state into locals, skip atoms not nearer than the current
  hit, reject by a screen-distance bound before the exact radius, and run the
  slice test only on survivors. Acceptance rules stay as they are.
- **Gain (prototype):** 62.9 → 11.5 ms, same atom at 12 of 12 probe points.
  Add a randomized comparison with the current function as a unit test.

### R5. Transparent export: shortcut empty and opaque pixels in the matte

**Effort:** S. **Deployments:** all.

- **Evidence [M]:** a transparent 4K export of 963,664 atoms takes 396 ms
  against 159 ms opaque; `solveMatte` in `src/render/offscreen-export.js`
  takes 182 ms for 8.09 million pixels although 78% are empty and 21.5%
  opaque.
- **Change:** compare 32-bit views. Equal color on black and white is opaque;
  black 0 with white 0xFFFFFF is empty; otherwise use the existing formula.
  Both shortcuts equal the formula exactly.
- **Gain (verified, no differing byte):** 182 → 63 ms.

### R6. Second view: reuse processed arrays and display meshes

**Effort:** S. **Deployments:** all.

- **Evidence:** enabling the second view at 60k atoms with bonds takes 173 ms
  and uploads 16.8 MB [M]; each surface mesh is wrapped, cut and capped again
  for it, and display coordinates and scene bounds are recomputed [C].
- **Change:** cache the display mesh on the mesh object by cell, origin and
  caps; let the second renderer adopt the main renderer's processed display
  arrays, atom bounds and bond shifts (treated as immutable).

### S4. Enable production CDN rules for content-hashed assets

**Effort:** S (deployment configuration). **Deployments:** production.

- **Evidence [M]:** production serves hashed JS and CSS with
  `max-age=14400` and HTML and Wasm with `max-age=600`; Wasm is not cached at
  the edge. After expiry a revisit sends 204–206 conditional requests through
  the same waterfall: ready in 570 ms against 302 ms.
- **Completed:** the build generates exact-hash immutable rules in `_headers`;
  the preview server verifies the build manifest before caching hashed
  assets. Real Chromium revisits reuse JS, Worker, Wasm and CSS without
  network transfer, while new build hashes retrieve new bytes. HTML and
  compatibility/source paths keep their update policy.
- **Remaining:** enable the documented Cloudflare cache and response-header
  rules on production if that host does not apply `_headers`. Cache only
  successful exact-hash assets; never long-cache a missing version's 404.
  Production HTTP inspection was blocked by the execution proxy, so this
  batch does not claim that the external rules are active. See
  [Deployment](DEPLOYMENT.md#cache-content-addressed-assets).

## Part 2: performance, phase 2 (medium changes)

### C10. CPU Voronoi: JavaScript overhead and index labels

**Effort:** M. **Deployments:** all hosts: Voronoi runs on CPU Workers unless
its WebGPU kernel is turned on.

- **Evidence [M]:** of 51.9 µs per atom, `initialCell` is 16%, `within` 11%,
  the clip and core loops 15%, `indexLabel` 7%; Wasm is about 28%. In a fully
  periodic cell `initialCell` returns the same planes for every atom. One
  index string per atom crosses three message hops: `structuredClone` of 1M
  strings takes 214 ms per hop, against 1.3 ms for interned IDs plus a label
  table.
- **Change:** cache the initial planes per context; use `collect()` (C9);
  write faces into growable typed buffers; return index IDs plus a table of
  unique labels and expand lazily.
- **Gain [E]:** 30–35% of kernel CPU and 0.2–0.4 s of main-thread time at 1M.

### T6. Header-only frame reads for time series

**Effort:** M. **Deployments:** all.

- **Evidence [M]:** the default attribute `Cell.volume` costs a full parse per
  frame, serially: 23 parses in 1.70 s at 120k and about 0.5 s per frame at 1M.
  A header parse from a 2 KB slice takes 0.35–0.52 ms at any size and returns
  the same timestep, atom count and cell.
- **Change:** a structure-Worker request `frame-header(index)` for dump, XYZ,
  PDB and CFG. Use it when every requested attribute is header-derived (Frame,
  Timestep, AtomCount, `Cell.*`, NumberDensity, `Strain.*`); otherwise use the
  coordinate projection of T4 on idle lanes. Smoothing forces the full path
  because it averages the cell.
- **Gain:** 50–800×; a 10,000-frame trajectory takes about 5 s [E].

### T7. Replicated frames: reuse the ID array

**Effort:** S (estimate cache), S–M (reuse), L (typed IDs).
**Deployments:** all.

- **Where:** `src/data/replicate.js`, `src/workers/replication-worker.js`,
  `src/worker-client.js`, `src/data/cache-policy.js`.
- **Evidence [M]:** physical replication gives every copy a string ID. For
  120,458 × 2×2×2 atoms, 380 ms of the 723 ms replication is ID validation and
  string building, and posting the result takes 471 ms because 843,206 strings
  are cloned. Receiving a 1M-entry ID array costs 243–382 ms on the main
  thread per frame, including background prefetch arrivals.
  `estimateFrameBytes` loops over every ID: 20–95 ms per frame change at 1M,
  after every analysis completion. IDs are identical between consecutive
  frames of an ID-stable trajectory.
- **Change:** cache the byte estimate per ID array. When the source ID sequence
  and repetitions match the previous frame, skip the ID work and send a token;
  the page reuses the previous array by reference. Longer term: a typed source
  ID plus a copy index, formatting strings only at the UI and configuration
  boundary.
- **Gain [E]:** about 0.85 s of 1.2 s per replicated frame after the first,
  and about 60 MB per cached frame.

### T8. gzip trajectories: index while decompressing

**Effort:** M. **Deployments:** all.

- **Evidence [M]:** a 57 MB gzip trajectory shows its first frame after
  1,040 ms against 303 ms uncompressed, and this grows with file size. A
  streaming scan parses frame 0 after 2.4 MB of decompressed data, with an
  identical result.
- **Change:** scan each decompressed chunk for frame markers while staging the
  parts, and publish each descriptor with a Blob composed of slices of the
  parts already built. Memory limits are unchanged; no OPFS.

### T9. Frame-ZIP: encode PNGs in a Worker

**Effort:** M. **Deployments:** all.

- **Evidence [M]:** 147 ms per frame at 60k atoms and 1050×928, of which
  `toBlob` is 62 ms on the main thread.
- **Change:** hand each frame as an `ImageBitmap` to a Worker
  (`OffscreenCanvas.convertToBlob` plus CRC) with a queue of 2 and a
  main-thread fallback. About 70–80 ms per frame [E]. ZIP bytes must stay
  identical.

### T10. Per-frame summary from the parser

**Effort:** M. **Deployments:** all.

- **Evidence [M]:** at 1M atoms a cached frame change costs 290–530 ms on the
  main thread: `updateSceneBounds` 92 ms, `colorsByType` 50 ms, radii 74 ms,
  type controls 30 ms. Types are counted three separate times, and nonisolated
  Workers each get their own coordinate copy (`copyCoordinates`, 511 ms over 4
  steps).
- **Change:** compute type counts and the position bounds in the parser's row
  loop and ship them with the frame; bounds, legend and type controls read the
  summary; copy coordinates once per frame for nonisolated Workers. Recompute
  after smoothing and replication.
- **Gain [E]:** 150–250 ms per frame at 1M in the original audit. Re-measure
  after the completed S2/S3 batching and R3 bounds/radius work.

### S6. Keep a standby structure Worker

**Effort:** S. **Deployments:** all.

- **Evidence [M]:** the structure Worker created at startup is terminated on
  the first open, and its parser pool is closed on each load; a 60k file has
  about 80–120 ms of unexplained overhead per open.
- **Change:** let the Worker's own load handler replace the source, or keep
  one standby Worker with a prewarmed parser and swap it in. B20 now uses
  candidate-source commit to preserve the old source on failure; keep that
  transaction and shared CPU admission when reusing a standby parser.

### G3. Keep thin cells and slabs on the GPU

**Effort:** S–M. **Deployments:** WebGPU.

- **Where:** `src/analysis/gpu/runtime.js`: an axis whose height is between
  one and two search radii gets one long bin, and the occupancy limit is a
  hard failure.
- **Evidence [M]:** NiGB 2×2×2 (9.96 Å thick) fails for adaptive CNA, central
  symmetry and RDF and falls back to the CPU; a vacuum slab fails for the
  Voronoi radius.
- **Change:** turn the limit into an input to the initial batch size (batches
  already adapt to dispatch time) and fail only at a much higher bound.

### G4. Bound GPU trajectory prefetch

**Effort:** S–M. **Deployments:** WebGPU.

- **Evidence [M]:** a 160-frame, 130k-atom trajectory fills 812 MiB of GPU
  memory and 278 MiB in the GPU Worker, with 159 background frame reads; the
  budget is a fixed 2 GiB, and the Worker keeps the CPU-side input of every
  resident frame.
- **Change:** a window of a few frames around the current one; a budget from
  the adapter limits and `navigator.deviceMemory`; drop the Worker's CPU copy
  for frames that are not current or pinned.

### R7. Early depth rejection for atom impostors

**Effort:** S–M. **Deployments:** largest on HiDPI, integrated and mobile
GPUs; none where `EXT_conservative_depth` is missing.

- **Where:** the sphere shaders in `src/render/webgl-renderer.js` write
  `gl_FragDepth`, which disables early depth testing; the same pattern is in
  `site-marker-layer.js` and the ambient-occlusion ID pass.
- **Evidence [M]:** at 963,664 atoms a frame takes 4.4 ms at the default zoom
  (vertex-bound), 11–13 ms zoomed in, and 37–50 ms at device pixel ratio 2. A
  flat-color fragment shader changes nothing; removing the depth write halves
  the time; turning multisampling off saves at most 30%.
- **Change:** with the extension, declare
  `layout(depth_greater) out highp float gl_FragDepth` and rasterize the
  billboard at the depth of the sphere's nearest point (with a 0.1% margin,
  only when the center is inside the clip range). Keep the current shader as
  the fallback. Draw display replicas nearest-first.
- **Gain (interleaved A/B, no differing pixel in 7 scenes):** zoom 3× at 1M
  atoms 11.1 → 5.9 ms, and 37.1 → 15.4 ms at pixel ratio 2; nearest-first
  replicas take zoom 10× from 10.0 to 6.1 ms.
- **Risk:** a fragment depth below the rasterized depth is undefined; recheck
  pixel identity on other GPU vendors.

### R9. Ambient occlusion: count on the GPU

**Effort:** M. **Deployments:** desktop and integrated GPUs; the current path
stays as the fallback where float blending is missing.

- **Where:** `src/render/ambient-occlusion.js` reads back a 4–16 MB ID image
  and counts it on the CPU for every direction.
- **Evidence [M]:** per direction at 1M instances and 1024²: 8.8 ms render
  with readback and 3.5 ms counting; 47.4 ms in total at 2048². Forty
  directions take 0.7–1.3 s in the background.
- **Change:** render IDs to a texture, then draw one point per texel that
  adds 1 to its instance's texel in a float count texture; accumulate all
  directions on the GPU and read the counts back once. Use it only while
  counts stay exact in single precision.
- **Gain (prototype, counts equal for all 963,664 instances):** per direction
  12.3 → 5.1 ms at 1024² and 47.4 → 12.3 ms at 2048²; about 0.1–0.2 s of GPU
  time for 40 directions [E].

### R10. All-cell Voronoi display: merge chunk buffers

**Effort:** M. **Deployments:** all.

- **Evidence [M]:** 60,229 displayed cells arrive in 471 chunks, each with its
  own vertex array; a frame makes 1,419 draws and about 10,000 GL calls and
  takes 22.1 ms against 2.7 ms without cells.
- **Change:** when the geometry is complete, merge the chunk buffers into a
  few large ones in chunk order (faces are translucent, so triangle order must
  be preserved) and draw three times per replica.

### K1. Grain segmentation: reuse the PTM fit and speed up clustering

**Effort:** S (reuse), M (clustering). **Deployments:** all.

- **Evidence:** when PTM ran before Grains was enabled, the whole PTM fit is
  repeated to get neighbor lists [C]. Clustering is single-threaded
  JavaScript: 1.0–1.1 s for 105,520 atoms and 2.2–2.8 s for 259,808 [M].
- **Change:** request neighbor lists whenever memory allows (65 B per atom);
  profile the clustering before choosing between typed-array tuning and a Wasm
  port.

### K3. Local shear: one neighbor pass

**Effort:** M. **Deployments:** all CPU paths.

- **Evidence [M]:** the coordination pass (466 ms) and the metrics pass
  (774 ms at 1M, 12 Workers) search the same neighbors. A sampled mode guess
  with a fallback could remove one pass with identical results [E]; not
  prototyped.

## Part 2: performance, phase 3 (large changes and decisions)

### K4. DXA: remaining serial stages

**Effort:** L. See [DXA CPU profile](DXA_CPU_PROFILE.md#prioritized-further-work).

- **Evidence [M]:** Burgers circuit tracing, cluster traversal, junction
  merging and the ordered graph and mesh commits are serial; the estimated
  floor for HEA is about 400 ms. The global Delaunay tessellation scales 2.1×
  with threads. Without isolation, tetrahedron-classification offload is about
  break-even because of table packing (63–98 ms on HEA).
- **Change:** profile the periodic Delaunay construction and elastic
  classification first; consider a compact immutable edge representation;
  investigate the serial circuit search on the NiGB mesh (0.9 s for an empty
  network). Any change must preserve visited state, junctions and search
  order.

### G5. Double-float guard cost

**Effort:** M.

- **Measured [M]** on the GTX 1080 Ti after the guards were added (2026-10-10):
  the cold compile of each Voronoi clip pipeline is 17–20 s instead of 6–7 s
  (warm: 0.13–0.17 s instead of 0.09–0.12 s), and Voronoi GPU time is 16–24%
  higher. The strain kernels pay little: reference strain compiles in
  0.8–0.9 s instead of 0.5 s, and warm kernel times on 129,904 atoms are
  unchanged within noise.
- The cost is the pair arithmetic itself, which the driver's compiler used to
  delete. Removing the product guard, or supplying the runtime 1.0 through a
  private variable, changes nothing measurable.
- Since GPU Voronoi is now an explicit option, only users who turn it on pay
  this. If the GPU kernel is redesigned (G6), look for a cheaper formulation
  of the clip kernel's pair products.

### G6. GPU Voronoi kernel redesign

**Effort:** L. **Do not schedule unless a faster adapter class changes the
picture.**

- **Evidence [M]:** dispatch time barely depends on batch size (512 cells
  125–140 ms, 8,192 cells 216 ms), so 2,048-cell batches leave the GPU mostly
  idle; the GPU clips 44.5 planes per cell against 18.1 in Voro++.
- **Change:** a compact workspace so 8,192–32,768 cells fit one dispatch, and a
  nearest-shell pass first. Estimated 0.7 s for HEA, still 2× slower than 6
  CPU Workers.

### R11. A non-instanced draw path for software rendering

**Effort:** M–L. **Deployments:** SwiftShader only (virtual machines, CI and
this project's browser suites). Low priority for users.

- **Evidence [M]:** SwiftShader pays 16–20 µs per instance: 60,229 atoms take
  about 1 s per frame. The same quads drawn without instancing, fetching
  per-atom data by vertex index, take 16.9 ms with no differing pixel
  (`render/m6.mjs`).

### C11. Bond-statistics moments independent of the Worker count

**Effort:** M. **Needs an owner decision: it changes the last bits.**

- Fixed-size Welford blocks would make the moments independent of the Worker
  count and remove the ordered-reduction serialization. Rejected by the audit
  as a silent change; listed for a decision.

## Deferred or rejected

- Removing or delaying prewarm and prefetch. Measured: opening a 130k-atom
  file reaches its first frame in 519 ms with prewarm and 484 ms with it
  deferred (overlapping ranges), and a first analysis clicked 100 ms after
  load is faster with prewarm (259–359 ms against 379–399 ms) [M].
- `modulepreload` for all modules, lazy-loading rarely used panels, required
  minification, a single file with inlined Workers, and a service worker for
  caching (S4 gives the revisit gain without the lifecycle risk) [M].
- Caching the legend histogram, discrete values or data limits per property
  array: it depends on arrays never changing in place.
- Larger pool chunks: after C1 the per-chunk cost is small, and larger chunks
  lengthen cancellation (a 4,096-atom PTM chunk already takes about 0.35 s).
- Moving the k-nearest search into the PTM Wasm kernel: after C9 the
  JavaScript share is about 10% in FCC.
- Raising the GPU Voronoi recovery budget: recovery is not the cost.
- Sharing the CPU `SharedArrayBuffer` snapshot with the GPU Worker: the copy
  is 1–20 ms.
- Predictive trajectory indexing (not exact), sliding-sum smoothing (changes
  the summation order), parallel segment unwrapping (serial append is under
  20% of the cost), and an OPFS spill for gzip.
- Rendering: skipping bonds hidden inside atoms (they still change pixels),
  occlusion queries or run-length counting for ambient occlusion, deriving
  fractional coordinates in the shader (rounding risk at slice boundaries),
  one WebGL context for both views, GPU ID-buffer picking (different
  semantics) and dropping multisampling while interacting [M].
- PTM SIMD/LTO and mimalloc for DXA: no measured gain [M].
- OVITO features outside the project's scope (elastic strain duplicate,
  Ackland–Jones, Chill+, VoroTop, rings, bond order, Bader, structure factor,
  spatial correlation, combine datasets, affine transformation, freeze
  property, GSD/GROMACS/MOL2/CIF/Cube/VTK/NetCDF formats, Python modifiers,
  OSPRay/Tachyon rendering and other Pro-only features); AtomEye NetCDF, a
  Python/Jupyter bridge, a polycrystal builder, EPS output and `.usr` color
  files; following a growing trajectory.
- OVITO's current tree no longer contains DXA; keep the v3.9.4 pin in
  `third_party/dxa`.

Feature-level limitations that are not performance work (for example OBJ
export for the defect mesh, [u v w] slice input, recording the second view)
are listed in the "Limitations" section of each feature page.

## Sources

- Audit of 2026-10-10 against commit `dbe6055`; reports in
  `../AlloyView-audit-2026-10-10/REPORT-*.md` on the reference machine.
- OVITO v3.9.4 (`939f5d9`) and documentation 3.16.1; AtomEye
  <http://li.mit.edu/Archive/Graphics/A/> and
  <https://github.com/jameskermode/AtomEye> at `c418eb2`.
