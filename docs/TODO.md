# Improvement backlog

Last updated: 2026-10-11 (UTC). Audited commit: `dbe6055`.

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
| 1 | R1 | Frames with bonds 2.4–2.7× faster, pixels unchanged | S |
| 2 | C4, C5 | Less per-neighbor allocation and duplicate work in frame strain and displacement | S |
| 3 | T1 | Prefetch fills the cache and overlaps playback preparation | S |
| 4 | C9 | PTM, CNA, CSP and bonds about 2× faster on BCC, 1.1–1.4× on FCC | M |
| 5 | S1, S4 | Cold start transfers 0.9 MB instead of 11.5 MB; revisits skip 200 conditional requests | S |
| 6 | R2, R3, R4 | Orientation colors 9× faster; frame commit and picking 3–5× faster at 1M atoms | S |

C1–C3, S2/S3 and T5 have moved to the feature documentation and the dated
[validation record](VALIDATION.md). Remaining timing estimates above retain
the original audit's scope; they are not measurements of these completed fixes.

## Part 1: defects

Fix these before performance work. B1–B6 and B10, and G1, were completed
on 2026-10-10. B7, B11 and B12/T5, and C1–C3 and S2/S3, were completed
on 2026-10-11; B2 rollback was also rechecked. See the process and validation
record in [VALIDATION.md](VALIDATION.md). Completed labels are not reused.

### B8. Surface mesh caps are open or wrong when atoms lie exactly on a cell face

**Severity:** medium-high (wrong picture; exported STL is not closed).
**Effort:** M.

- **Where:** `src/render/surface-mesh-geometry.js` `buildSurfaceDisplayMesh`.
- **Evidence [M]:** `bugs/B-mesh-grains/k7-ideal-lattice-caps.mjs 0 40 1`: 11
  of 40 ideal FCC structures with voids have open edges or a wrong enclosed
  volume at display origin 0. In the app
  (`b13-ideal-lattice-caps-app.mjs`): 8 open edges and volume 11,861 against a
  solid volume of 17,834; at origin (0.013, 0.017, 0.019) the mesh is closed.
  Jittered atoms never fail. `k10-shared-edge-minimal.mjs`: two boxes sharing
  one edge, cut through that edge, give volume 57 instead of 72.
- **Cause:** vertices exactly on the cut plane are classified inconsistently,
  and edges shared by two sheets are paired wrongly when cap loops are built.
- **Fix:** classify on-plane vertices to one fixed side for every face (or
  choose a cut offset that avoids all vertex coordinates), and split
  non-manifold edge vertices per sheet before cutting.
- **Test:** k7, k4 and k10 as randomized unit tests: no open edge, and volume
  equal to the kernel's solid volume at origin 0 and at random origins.

### B9. Cancelling DXA kills a surface job, and its status stays "Calculating…"

**Severity:** medium-high. **Effort:** S–M.

- **Where:** `src/analysis/dxa-client.js` terminates the shared Worker and
  aborts every task; `src/surface-tools.js` returns on `AbortError` without
  updating its state.
- **Evidence [M]:** `bugs/B-mesh-grains/b1-dxa-cancel-kills-surface.mjs`: start
  Surface and DXA, cancel DXA. Surface still shows "Calculating… preparing"
  20 s later and `wait-analyses` never ends.
- **Fix:** when the Worker is terminated for one task, redispatch the other
  queued tasks on a new Worker; in the surface tool, tell a foreign abort from
  its own and requeue or reset.

### B13. Time series keep a stale last frame and lose settings in configurations

**Severity:** medium. **Effort:** S.

- **Stale range [M]:** `io/b-ranges.mjs`: on a 30-frame file whose index
  finishes after the first frame appears, **Last frame** stays "8 (max 8)" and
  **Read file values** reports "8 frames · every value collected".
  `updateSourceIndex` in `src/app.js` refreshes the trajectory and movie
  controls but not the time series, and `readRange()` runs before
  `ensureIndexed()` in `src/time-series-controls.js`.
- **Lost settings [M]:** `bugs/X-cross/roundtrip.mjs`: range, stride, x axis
  and "separate panels" are saved only if auto-collect is on or the attribute
  list differs from the default.
- **Fix:** refresh the time series when the frame count grows; read the range
  after indexing; compare the whole serialized state with the defaults.

### B14. The surface of "Visible atoms" is stale after a frame change

**Severity:** medium (frame series, scripts and movies can export it).
**Effort:** M.

- **Evidence [M]:** `bugs/B-mesh-grains/b2-visible-atoms-stale.mjs`: with a
  CNA legend filter hiding "Other", each new frame's surface is first computed
  from every atom, shows "Calculated", and is recomputed 0.6–1.8 s later from
  the filtered set. An export in between uses the wrong surface.
- **Fix:** when the restriction is "Visible atoms" and visibility depends on an
  analysis that has not finished for the frame, hold the surface in a waiting
  state.

### B15. Escape closes the movie progress window while the export continues

**Severity:** medium. **Effort:** S.

- **Evidence [M]:** `bugs/A-movies/b6-movie-cancel-escape.mjs`: after Escape
  the dialog is closed, the export keeps running, Cancel is unreachable, and
  the theme and frame can be changed mid-export.
- **Fix:** reopen the dialog or treat its `close` as Cancel; add
  `closedby="none"`; make the application root `inert` during an export.

### B16. Coordination with a cutoff far larger than the cell never finishes

**Severity:** medium (Cancel works; a configuration can carry the value).
**Effort:** S.

- **Where:** `src/analysis/coordination.js` `minimumImageDistanceSquared` loops
  over every periodic image within the cutoff for every pair; the input has no
  maximum and configurations accept up to 10¹⁵.
- **Evidence [M]:** `bugs/X-cross/repro-coordination-huge-cutoff.mjs` (500
  atoms, 18 Å cell): 100 Å takes 1.4 s, 300 Å is still running after 25 s.
  Other analyses reject the same value at once.
- **Fix:** bound the loop to the images that can be closest, or reject like the
  other analyses.

### B17. A binning profile in "Waiting" blocks scripts and movie export forever

**Severity:** medium. **Effort:** S.

- **Evidence [M]:** `bugs/A-movies/b7-waiting-hang.mjs`: binning waits for a
  quantity no enabled analysis will produce; `wait-analyses` and movie
  preparation count it as pending.
- **Fix:** use a distinct non-pending state when nothing will produce the
  quantity; name what is awaited and time out.

### B18. WebGL context loss is not handled in the main view

**Severity:** medium. **Effort:** M.

- **Evidence [M]:** `bugs/C-labels-ao-export/t6-context-loss.mjs`
  (`WEBGL_lose_context`): no notice is shown; the event is not
  default-prevented, so the context cannot be restored; a PNG at the current
  size downloads as a fully transparent image with no error; later frame
  changes fail with shader errors.
- **Fix:** prevent the default on loss, show a banner, stop rendering and
  refuse exports with one message; on restore, rebuild programs and buffers
  from the retained frame.

### B19. A second configuration import during a restore can leave it unfinished

**Severity:** medium, intermittent (5 of 8 runs). **Effort:** S–M.

- **Evidence [M]:** `bugs/X-cross/import-concurrency.mjs double <gapMs>` on a
  cold page: the status stays "Restoring configuration…" although every
  analysis is calculated, and Color by ends as "type". The root cause was not
  isolated.
- **Fix:** serialize restores, and always write a final status in `finally`.

### B20. A file that fails to open leaves the previous trajectory displayed but dead

**Severity:** medium. **Effort:** S (minimal) or M.

- **Where:** `src/app.js` `loadFiles`: the old structure Worker is reset and
  the file name changed before the new file is known to parse.
- **Evidence [M]:** `bugs/X-cross/repro-bad-second-file.mjs` and
  `shell/bugs2.mjs`: the header shows the broken file's name over the old
  atoms, and frame navigation fails with "Open a structure or trajectory file
  first."
- **Fix:** load the new source in a second Worker and swap on the first frame
  (this also gives S6); minimal: close the source cleanly on failure.

### B21. Export JSON fails after opening a shorter trajectory

**Severity:** medium. **Effort:** S.

- **Evidence [M]:** `bugs/X-cross/repro-export-after-shorter-file.mjs`: a
  strain reference frame or time-series first frame of 5, then a 3-frame file;
  **Export JSON** fails validation and nothing downloads.
- **Fix:** reset or clamp both in `loadFiles` and `closeSource`, and clamp
  again in `captureConfiguration`.

### B22. Voronoi cell opacity is applied twice on multisampled canvases

**Severity:** medium (wrong opacity; images depend on the device).
**Effort:** S.

- **Where:** `src/render/voronoi-cell-layer.js` enables blending for faces and
  outlines while `SAMPLE_ALPHA_TO_COVERAGE` is enabled globally in
  `src/render/webgl-renderer.js`. The surface mesh layer already disables it.
- **Evidence [M]:** `render/m4.mjs --only=a2c`: one white cell on black. With
  4× multisampling the center pixels read 21, 75 and 150 at opacity 0.25, 0.5
  and 0.75; with coverage disabled, or without multisampling, they read 83,
  150 and 200. The ratio is exactly the opacity.
- **Fix:** disable alpha-to-coverage around the Voronoi face and outline
  passes and restore it afterwards; check the cell and slice-outline lines
  (alpha 0.92 with blending) the same way.
- **Intended visual change:** on multisampled canvases Voronoi faces and
  outlines become as opaque as the slider says and lose the dither pattern.
  Exports follow the screen.

### Lower-severity defects

| ID | Problem | Evidence | Fix | Effort |
| --- | --- | --- | --- | --- |
| B23 | Camera-path preview does not return to its starting frame when frames load slowly | `bugs/A-movies/b8-preview-restore.mjs`, 4 of 4 [M] | On stop, show the starting frame whenever a load is pending | S |
| B24 | Radical Voronoi with radii from an expression of an analysis output fails on every frame change | `bugs/D-kernels-inputs/b09-radical-radius-expression-frame-change.mjs` [M] | Wait while the radius property has a pending dependency; rerun when computed properties refresh | S–M |
| B25 | Transparent PNG at "Current viewport" has edge fringes (1,927 of 290,700 pixels, up to 53 levels) | `bugs/C-labels-ao-export/t5-transparent-matte.mjs` [M] | Use the offscreen black/white matte for this path too; this changes that export's pixels | S |
| B26 | Importing a configuration while a script runs is cut short by the script's next command | `bugs/A-movies/b4-import-during-script.mjs` [M] | Refuse the import while the automation lock is held | S |
| B27 | Bonds on a large frame run to the end and then fail at the 1,000,000-edge cap | 964k atoms [M] | Sum counts as chunks finish and stop early | S |
| B28 | With the Voronoi WebGPU kernel turned on, a failed GPU Voronoi preparation cancels all other GPU prewarming, and the status wrongly says "unavailable" (the default CPU routing no longer reaches this) | `gpu/prefetch-memory.mjs --scenario=slab`: 4 of 24 pipelines [M] | Catch the Voronoi-specific failure, continue the general warm-up, report status per kernel | S |
| B29 | Device loss or any uncaptured GPU error disables WebGPU for the session | `src/analysis/gpu/runtime.js` [C] | Re-create the Worker once on the next request; treat validation errors as failed tasks | S–M |
| B30 | Every refresh rebuilds the legend and drops keyboard focus; the legend cannot be edited during playback | `shell/bugs2.mjs` [M] | Update the legend in place when its kind, property and items are unchanged | M |
| B31 | LAMMPS dumps with `ITEM: UNITS`/`ITEM: TIME`, or without a `type` column, are rejected; rows beyond NUMBER OF ATOMS are dropped silently | `io/bench-smooth-robust.mjs` [M] | Accept the optional blocks; default the type; raise an error on extra rows | S |
| B32 | Small touch targets on phones (text buttons 28×11 px, help links 19×19) | `shell/mobile.mjs` [M] | 32–44 px hit areas under the mobile media query | S |
| B33 | The Movie panel's image-size mirror keeps its old value after an import | `bugs/X-cross/roundtrip.mjs` [M] | Refresh it with the export-resolution control | S |
| B34 | GPU results that depend on neighbor order are not reproducible between runs: frame strain on 6,912 and 60,229 atoms differs in 7–11 of 1,144,351 values (at most 1.5×10⁻⁸), HEA bonds and Q4/Q6 differ between two pools, and GPU Voronoi digests differ between page loads | Found while fixing B1 and B5; the GPU neighbor grid is filled with `atomicExchange`, so the order of each cell's list varies [M] | Sort each cell's list, or accumulate in an order-independent way; decide first whether run-to-run identity is required on the GPU | M |
| B36 | `npm run test:gpu:voronoi` on the software adapter takes 285–320 s on the reference machine against a 360 s evaluate timeout, so a loaded machine can fail it without a defect | Measured on 2026-10-10 [M] | Split the page evaluation into two calls, or raise the timeout for this suite | S |
| B35 | Trajectory lines for a selection group of physical copies find no atoms ("IDs not found (@AlloyView:copy…)"); lines work for source IDs | Seen while fixing B1 [M] | Map copy IDs to their source atom and add the copy's cell offset, or state the restriction in the panel | S–M |

Suspected but not reproduced: the movie frame range persists across files
beyond the new frame count. The expression variable `ID` is NaN for physical
copies (may be by design; B35 is its visible consequence).

## Part 2: performance, phase 1 (small changes)

### C4. Reference-frame strain: remove per-neighbor allocation

**Effort:** S. **Deployments:** hosts without WebGPU and CPU fallback.

- **Where:** `src/analysis/reference-strain.js` `minimumImageChange` and the
  loops around it.
- **Evidence [M]:** `minimumImageChange` is 62% of self time; the kernel costs
  60.7 µs per atom against 5.4 µs for local-shear metrics on the same
  neighbors.
- **Change (verified):** the same arithmetic in scalars, in the same order.
- **Gain:** kernel 60.7 → 7.2 µs per atom; pool 120k 607 → 158 ms and 1M
  4,743 → 848 ms; all 19 output fields hash-identical.
- **Also:** each Worker keeps a private wrapped copy of the current
  coordinates that the memory budget does not count (about 720 MB across 30
  Workers at 1M); share it when isolated.

### C5. Light kernels: scalar loops and cheaper transport

**Effort:** S (kernels), M (transport). **Deployments:** all CPU paths.

- **Displacement [M]:** per-atom `map`, `subarray`, `every` and spread
  `Math.hypot`. Verified prototype: 1.74 → 0.17 µs per atom; pool 120k
  169 → 62 ms, 1M 443 → 184 ms.
- **Ideal-strain tensor from a stored PTM fit [M]:** 5.3 µs per atom for a 3×3
  product (`atomic-strain.js`); not prototyped, at least 10× expected [E].
- **Local-shear finalize [M]:** a third pool pass takes 142 ms at 1M for 70 ms
  of single-thread arithmetic; nonisolated Workers each receive the whole
  metrics array.
- **Change:** scalar kernels. For kernels under about 0.3 µs per atom, use one
  chunk per Worker and fewer Workers, and send only the chunk's rows.

### C6. Coordination kernel and Worker target

**Effort:** S. **Deployments:** hosts without WebGPU; runs at load and on
every cutoff edit.

- **Evidence [M]:** 54% of kernel time is outside the distance test: each atom
  rebuilds its 27 neighbor bins with a pairwise duplicate scan. Only 3 Workers
  run at 120k (50,000-atom target). The cutoff index build is serial, 193 ms at
  1M. Shared-memory reads are not the cause of "shared slower than copied".
- **Change (kernel verified):** scan for duplicate bins only when a periodic
  axis has fewer than 3 bins, rebuild the bin list only when the atom's bin
  changes, inline the minimum-image test; lower the target to 8,192–16,384
  atoms per Worker using the completed C2 memory admission.
- **Gain:** kernel 3.91 → 2.26 µs per atom; pool 120k 180 → 112 ms, about
  40–50 ms with 12 or more Workers [E].

### C7. Main-thread post-processing

**Effort:** S. **Deployments:** all.

- **Expressions [M]:** `Float64Array.from(types, callback)` takes 149 ms
  against 7 ms for a loop at 1M; the first use of `ID` costs 294 ms. This is
  most of the "0.5 s at 1M" noted in the expressions page.
- **Statistics [M]:** `coordinationStatistics` uses a `Map` keyed by number
  (35 ms against 8 ms for a count table, plus 15 yields).
- **Wigner–Seitz summary [M]:** 64 ms synchronous at 1M; move it into the
  Worker as cluster labeling already is.

### C8. Match atom IDs with typed tables, off the string path

**Effort:** S–M. **Deployments:** all, including WebGPU (matching precedes the
GPU kernels).

- **Where:** `reference-strain.js` `createReferenceMappingAsync`, used by
  displacement and frame strain.
- **Evidence [M]:** `cpu/main-thread.mjs`, 1M numeric IDs: 1,578 ms in 31 slices
  of about 51 ms, longer than the displacement analysis itself (443 ms). A
  dense table takes 55 ms and returns the same mapping. The reference-side map
  is rebuilt for every current frame.
- **Change:** for numeric typed IDs, a dense `Int32Array` table when the ID
  range is at most 4N + 1024, otherwise a numeric `Map`; keep the string path
  for other IDs; cache the reference-side table per reference ID array; slice
  by time or move the match to the structure Worker.
- **Verify:** equality with the current mapping on shuffled, missing,
  duplicate and string IDs, including the same error messages.

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
- **Note:** these are pre-fix audit CPU timings. C3 is complete, and C4–C6
  and C9 remain; re-measure before fixing thresholds.

### T1. Restart frame prefetch when indexing completes

**Effort:** S. **Deployments:** all.

- **Where:** `src/app.js` `updateSourceIndex` calls `scheduleFramePrefetch`
  only inside `if (previousCount !== state.frameCount)`;
  `src/workers/indexed-trajectory.js` publishes completion with an unchanged
  count.
- **Evidence [M]:** `io/b-fill.mjs`: the cache stays at 10 of 50 frames (60k
  atoms), 8 of 30 (120k) and 4 of 10 (1M) for at least 12–60 s after load.
  Small test fixtures finish indexing before the first frame and hide it.
- **Change:** reschedule when `indexComplete` flips, and when new frames
  appear while the lanes are idle.
- **Gain (prototype):** 50 of 50 frames cached 1.7 s after the drop at 60k.

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

### T3. Frame-ZIP: faster CRC

**Effort:** S. **Deployments:** all.

- **Evidence [M]:** `crc32` in `src/export-archive.js` iterates a `Uint8Array`
  with `for…of`: 97.4 ms per 4 MiB against 11.7 ms with an indexed loop and
  the same result. It runs in one synchronous block at the end: 445 ms for 24
  frames, about 6 s at the 256 MiB cap.
- **Change:** indexed loop, computed per frame. See T9 for PNG encoding.

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

### R1. Bonds: indexed geometry without hidden caps

**Effort:** S. **Deployments:** every GPU.

- **Where:** `src/render/atom-primitives.js` `createPrimitiveMesh` and
  `drawMesh`.
- **Evidence [M]:** a bond is a 10-sided cylinder stored as 120 non-indexed
  vertices with two caps, and every vertex repeats 6–10 texel fetches. 60,229
  atoms with 421,315 bonds issue 50.8 million vertex invocations per frame:
  11.4–19.8 ms against 1.0 ms without bonds. 481,832 atoms with 3.37 million
  bond instances take 131–135 ms per frame (about 7.5 FPS on a GTX 1080 Ti).
- **Change (verified, no differing pixel in 4 scenes):** indexed cylinder and
  cone drawn with `drawElementsInstanced`, and a capless cylinder whenever the
  smallest drawn atom radius is at least the bond radius (the caps then sit
  inside the atom spheres). Track the minimum radius next to
  `maximumAtomRadius` for that guard.
- **Gain:** 60k atoms with bonds 19.7 → 14.0 (indexed) → 8.3 ms (no caps);
  482k atoms with bonds 135 → 95 → 50 ms. Vertices per bond 120 → 46 → 22.
- **Verify:** `render/m2.mjs`, `render/m7.mjs`; the bonds row of
  `scripts/browser-crystal-drag.mjs --performance`.

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

### R3. Scene bounds and radius loops at frame commit

**Effort:** S. **Deployments:** all.

- **Where:** `src/render/webgl-renderer.js` `updateSceneBounds`, called by
  `setFrame`, `setDisplayPositions` and nine other setters (always by
  `setSurfaceMesh` and `setTrajectoryLines`, even with nothing to show);
  `atomRadii.reduce` and the `setAtomRadii` validation.
- **Evidence [M]:** at 963,664 atoms `updateSceneBounds` takes 60–87 ms, the
  radius maximum 19.6 ms and the radius validation 21 of `setAtomRadii`'s
  24 ms. The uploads are cheap: 29 MB in about 10 ms. `setFrame` costs
  113–133 ms of JavaScript in total. With the second view open, every sync
  triggers one more full bounds scan.
- **Change:** compute atom bounds in one indexed pass, cached by the display
  position array and invalidated when display coordinates change; combine it
  with the cell, replica offsets and layer extensions; cache arrow bounds per
  field; indexed loops for the radius maximum and validation; skip the bounds
  update when nothing changed.
- **Gain:** the scan drops from 60.1 to 12.9 ms with identical bounds
  (prototype) and to about zero when cached; `setFrame` about 35–45 ms [E].

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

### S1. Shrink the logo assets

**Effort:** S. **Deployments:** all; phones most.

- **Where:** `src/asserts/logo/`, `index.html`, `src/theme.js`.
- **Evidence [M]:** `AlloyView_logo_only.png` is 2400×2400 and 4.4 MB; it is
  the favicon and the empty-state fallback image, fetched even when hidden.
  Each wordmark SVG is 4.4 MB and embeds the same 2048×2048 PNG twice for a
  190 px mark; light-theme users download both. A cold start transfers
  11.46 MB, of which code, CSS and HTML are 0.86 MB. The main thread spends
  127 ms parsing the SVG and 113 ms decoding images.
- **Change:** a 32–180 px favicon; a ≤264 px fallback inserted only when WebGL
  fails; one small SVG whose lettering follows the theme; a build check that
  rejects assets over 200 KB.
- **Gain (prototype):** transfer 11,460 → 901 KB; about 40 MB less decoded
  bitmap memory [E].

### S4. Cache content-hashed assets as immutable

**Effort:** S (deployment configuration). **Deployments:** production.

- **Evidence [M]:** production serves hashed JS and CSS with
  `max-age=14400` and HTML and Wasm with `max-age=600`; Wasm is not cached at
  the edge. After expiry a revisit sends 204–206 conditional requests through
  the same waterfall: ready in 570 ms against 302 ms.
- **Change:** for `/AlloyView/assets/*`, a Cloudflare cache rule and
  `Cache-Control: public, max-age=31536000, immutable`; the same line in
  `_headers`; keep `index.html` short-lived; document it in DEPLOYMENT.md.

## Part 2: performance, phase 2 (medium changes)

### C9. Neighbor queries without per-neighbor allocation

**Effort:** M. **Deployments:** all CPU paths, CPU fallback and exact
corrections. **The largest CPU gain.**

- **Where:** `src/analysis/neighbors.js` (`within`, `nearest`) and every
  caller: CNA, CSP, PTM preparation, bonds, bond statistics, local shear, RDF,
  clusters.
- **Evidence [M]:** `within()` allocates an object with four boxed doubles per
  neighbor. For k = 18 the first search radius is 1.408 a, just inside the BCC
  third shell at 1.414 a, so BCC needs 1.9–2.0 passes and 113–126 candidates
  per atom against 18–23 in FCC. PTM on BCC spends about 59% of its CPU in
  JavaScript neighbor preparation. CNA spends 33% in `classify`, in a string
  `Map` and a new array per atom. A slab with two-thirds vacuum doubles the
  candidate count.
- **Change (verified, `cpu/proto-changed/`):** `collect()` fills typed scratch
  arrays in the same order; `nearestInto()` keeps the k best by bounded
  insertion with the existing comparator; the start radius is learned from
  the last k-th neighbor distance with the original ladder as fallback; CNA
  uses integer counters; pair keys are numeric.
- **Exactness:** 159,696 queries over 17 frames and 845 kernel checks match
  with `Object.is`; pool hashes are identical for 13 analyses at 120k in both
  deployments and 10 at 1M.
- **Gain, single thread on the Fe loop:** PTM 82.7 → 39.6 µs per atom, CNA
  adaptive 12.9 → 5.8, CSP auto 14.0 → 6.7, bonds 5.4 → 2.3; FCC gains are
  1.1–1.4× except bonds (2.4×). Pool with 30 Workers: 120k CNA 117 → 59 ms and
  PTM 496 → 251 ms; 1M CNA 761 → 313 ms and PTM 4,737 → 2,936 ms.
- **Risks:** scratch arrays are reused, so nested queries must copy first; the
  numeric pair key needs type IDs below 2²⁶; in thin cells the smaller sphere
  may succeed where the current code reports "cell is too thin".

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
  after the completed S2/S3 batching and combine with remaining R3 work.

### S5. Bundle the page and each Worker entry

**Effort:** M. **Deployments:** all.

- **Evidence [M]:** the build only copies `src/`: 158 static modules from
  `app.js` in a five-level waterfall, 187 requests, and each analysis Worker
  reloads 25 modules. Cold start at 20 Mbit/s and 40 ms round trip; every row
  includes S1 except the HTTP/1.1 "Current" row:

| Build | Protocol, CPU | Requests | Ready |
| --- | --- | --- | --- |
| Current | HTTP/2, 1× | 187 | 1,052 ms |
| Bundled | HTTP/2, 1× | 14 | 619 ms |
| Current | HTTP/2, 4× slower CPU | 187 | 1,870 ms |
| Bundled | HTTP/2, 4× slower CPU | 14 | 1,678 ms |
| Current | HTTP/1.1, 4× slower CPU | 187 | 3,280 ms |
| Bundled | HTTP/1.1, 4× slower CPU | 14 | 1,841 ms |

- **Also [M]:** sixteen analysis Workers start in 318–323 ms from a warm HTTP
  cache, and in 61–69 ms when bundled.
- **Change (prototype, `shell/bundle/build.mjs`):** esbuild as a development
  dependency, one bundle per entry (the page and 11 Worker entries) written to
  its original path, with a plugin that keeps `new URL(…, import.meta.url)`
  and the Emscripten glue pointing at the original kernel and Wasm files.
  `npm run dev` and the Node tests keep using `src/`.
- **Risks:** URL relocation broke PTM Wasm loading in the first prototype;
  add a browser test that every Worker and kernel loads from the bundled tree.
- **Not worth doing [M]:** `modulepreload` for all modules (no gain, slower
  first paint), lazy-loading rarely used panels (15% of the code), and
  minification as a requirement (no ready-time gain).

### S6. Keep a standby structure Worker

**Effort:** S. **Deployments:** all.

- **Evidence [M]:** the structure Worker created at startup is terminated on
  the first open, and its parser pool is closed on each load; a 60k file has
  about 80–120 ms of unexplained overhead per open.
- **Change:** let the Worker's own load handler replace the source, or keep
  one standby Worker with a prewarmed parser and swap it in. Combine with B20.

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

### R8. Bond and arrow layer: update lazily, and store visibility separately

**Effort:** S–M. **Deployments:** all.

- **Where:** `src/render/atom-primitives.js` mirrors every position, color and
  visibility update into textures, and packs visibility into the 16-byte
  position texel. The layer is created on the first bonds or arrows and never
  destroyed.
- **Evidence [M]:** with the layer present at 963,664 atoms, `setVisibility`
  goes from 0.3 to 28.6 ms and from 0.9 to 15.6 MB uploaded; `setFrame` from
  113 to 236 ms and from 29.4 to 62.5 MB. This is paid even when no bond or
  arrow is drawn. The audit's repeated-refresh cost is reduced by completed
  S2 batching, but the per-upload texture cost remains.
- **Change:** setters only mark data dirty; the layer flushes when it is about
  to draw visible bonds or arrows; allocate CPU mirrors lazily; move
  visibility into its own one-byte texture.

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

### K2. Surface mesh: move wrap, cut and cap off the main thread

**Effort:** M. **Deployments:** all.

- **Evidence [M]:** the display build runs on the main thread: 8–26 ms for the
  HEA mesh and 0.12–0.19 s for 124,352 faces. About three quarters of the
  surface analysis is the Delaunay tessellation, and a surface job and a DXA
  run execute one after the other in the shared Worker.
- **Change:** build the display mesh in the Worker that already holds the
  surface. Fix B8 first.

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
