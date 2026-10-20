# Improvement backlog

Last updated: 2026-10-20 (UTC). Performance baseline: `adb0648`.

The [2026-10-19 follow-up review](REPOSITORY_REVIEW_2026-10-19.md) closes
B34, checks the historical movie-range suspicion, and records the newly
reproduced fixes. The performance items below were checked against current
source. Their older measurements and estimates have not been remeasured unless
a dated report explicitly says so. The [2026-10-20 performance report](PERFORMANCE_IMPROVEMENTS_2026-10-20.md)
completes S6, T7, T8, T10 and C10 with new measurements; completed entries
have moved to the feature documentation. The [T9/G3/G4 report](PERFORMANCE_T9_G3_G4.md)
records Worker PNG encoding, thin-cell GPU dispatch and bounded GPU prefetch
against baseline `c93a58f`; those completed items have also moved out of this backlog.
Remaining items are listed below.

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
| 1 | R7 | Validate conservative-depth acceleration on a supporting physical GPU | S–M |
| 2 | K1 | Further optimize the ordered grain merge | M |
| 3 | S4 | Enable the prepared immutable-asset rules on the production CDN | S |

C1–C9, R2–R6/R8, S1–S3/S5, T1–T6 and K2 have moved to the feature
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
rules remains below. The approved 2026-10-14 batch completed B23/B24/B25/B30,
T2, R2/R4/R5 and the fused-tail/same-order part of T4; coordinate-only
reads were completed in the following continuation, along with B32/B35/B36
and T6. G2 first gained cell/cutoff refusal memory. The next continuation
completed B38's explicit GPU revision/invalidation contract and R6's shared
second-view preparation, and corrected Surface cache accounting and revisions.
The current continuation adds G2 local measured routing, revision-scoped
content refusals and per-analysis batch choices, parallel Grains preparation,
and R7 guarded shader/safe replica ordering. R7 hardware verification and K1's
further ordered-merge work remain below.
Their contracts and validation are recorded in [VALIDATION.md](VALIDATION.md).

B34 is complete: GPU neighbor lists now have a canonical descending atom-index
order, with repeated real-WebGPU checks. See [performance](features/performance.md)
and the dated [validation record](VALIDATION.md). The movie range is reset on
source changes; existing lifecycle tests cover it. Neither remains an open defect.

Compound physical-copy IDs give NaN in the numeric expression variable `ID`, as
documented in [expressions](features/expressions.md). This is an input limitation,
not a newly reproduced regression. B35 trajectory paths resolve their encoded
source ID and offset directly. Extending numeric expressions to compound identity
requires an explicit representation decision.

## Part 2: performance, phase 1 (small changes)

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

### R7. Supporting-GPU depth validation

**Effort:** S–M. **Deployments:** browsers/drivers accepting the conservative-depth qualifier.

- **Completed:** compile/link capability probe per context, nearest-sphere raster
  depth with geometric and arithmetic guards, matching site-marker/AO paths,
  original-shader fallback and cached safe nearest-first opaque replicas.
  Float32 transform/depth-quantization ties preserve original copy order.
- **Current evidence:** the actual Chromium/SwiftShader driver rejects the
  extension. Pixel/PNG comparisons therefore validate fallback plus independently
  compiled guarded geometry; they do not demonstrate early-depth acceleration.
- **Remaining:** test a physical GPU whose WebGL compiler accepts the qualifier,
  verify exact images and early-depth timing gains across vendors. The original
  audit reported 11.1 → 5.9 ms (zoom 3×, 1M atoms) and 37.1 → 15.4 ms at DPR 2;
  these historical figures are not reproduced performance claims for this code.
- See [display](features/display.md) and [validation](VALIDATION.md).

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

### K1. Grain segmentation: further ordered-merge optimization

**Effort:** M. **Deployments:** all.

- **Completed:** bounded PTM neighbor retention avoids repeated fits. Large
  grain preparation splits neighbor-bond construction and disorientations over
  persistent Workers, with shared/private snapshots, memory admission and the
  shared CPU budget. Merges and coherent-interface decisions retain original
  order; threshold/size edits reuse the retained merge model.
- **Completed 2026-10-20:** reuse already-resolved union–find roots in MST
  merging and dendrogram sizing. A generation-stamp graph prototype was
  reverted because fewer adjacency visits did not produce a stable wall-time
  gain. Root reuse preserves the complete model and segmentation; further
  whole-stage speedups still require measurement.
- **Remaining:** profile and optimize the dependency-ordered graph/MST merge
  without changing orientation accumulation, stable tie order, thresholds or
  grain IDs. This serial stage releases the parallel CPU permits before it runs.
- See [grains](features/grains.md) and [validation](VALIDATION.md) for actual
  interleaved timings and exact-output comparisons.

### K3. Local shear: reduce fallback cost on misleading new frames

**Effort:** M. **Deployments:** all CPU paths.

- **Completed 2026-10-20:** a guarded single neighbor pass computes coordination
  and candidate moments together. The full histogram decides acceptance;
  low memory, rejected candidates and differing modes across migrating
  Worker chunks use the original exact metrics pass. Verified modes can be
  reused only for the same immutable search and cutoff.
- **Remaining:** a deliberately reordered new frame can mislead the pilot.
  The measured three-sample fresh-snapshot medians increased from 104.17 to
  145.69 ms privately and 68.26 to 80.88 ms in shared mode, with substantial
  sample variation. Repeated identical snapshots become faster after the
  exact mode is known; that does not remove this new-frame fallback cost.
  Ordinary mixed fresh snapshots were approximately unchanged. See the
  [performance report](PERFORMANCE_IMPROVEMENTS_2026-10-20.md) for raw samples
  and the larger gains on dominant FCC/BCC neighborhoods.

## Part 2: performance, phase 3 (large changes and decisions)

### K4. DXA: remaining serial stages

**Effort:** L. See [DXA CPU profile](DXA_CPU_PROFILE.md#prioritized-further-work).

- **Completed 2026-10-20:** retain immutable BFS vertex coordinates, matrix
  and depth once per vertex. Both production Wasm kernels were rebuilt;
  complete scientific outputs match the baseline. HEA tracing improves by
  11.7–11.9% and the replicated NiGB case by 3.4–3.6% in the measured
  one-thread comparisons. A frontier-pruning candidate was rejected after
  measurement. These are bounded tracing improvements, not completion of
  the remaining serial-stage work; see the
  [performance report](PERFORMANCE_IMPROVEMENTS_2026-10-20.md).
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
