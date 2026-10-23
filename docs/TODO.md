# Open work

Reviewed against `70f6ed5` on 2026-10-22. This is the single backlog for repository
reviews and performance work. Entries below describe remaining work, not promises
of a speedup. The cleanup checked current source and regression coverage; it did
not repeat historical benchmarks or verify external deployment settings.

Completed findings have been removed. Durable behavior belongs in the feature
pages; executed checks and historical measurements belong in [Validation](VALIDATION.md).
The old review reports and bug-reproduction scripts are recoverable from Git history.
Do not create another dated backlog: update or remove the relevant entry here.

## Priorities and status

| Item | Status | Next step |
| --- | --- | --- |
| K4 validation | Open scientific validation gap | Explain full-result PDEL/reference differences before accepting larger DXA changes. |
| R9 | Optional performance work | Measure GPU AO counting against exact CPU counts and total latency. |
| R10 | Optional performance work | Merge completed Voronoi display buffers while preserving translucent order. |
| K1 | Optional performance work | Profile the remaining serial grain merge; keep only measured improvements. |
| K3 | Optional performance work | Reduce misleading-pilot cost on fresh local-shear frames. |
| K4 P2–P5 | Conditional algorithm work | Choose one candidate using current diagnostics and the acceptance gate below. |
| R7 / S4 | External validation/configuration | Check supporting physical GPUs and production cache headers respectively. |
| R1 / C11 / G5–G6 / R11 | Deferred decisions/research | Reopen only when their stated trigger is met. |

The 2026-10-16/19 reviews' 29 functional findings and two test findings have
corresponding fixes and regression coverage. No finding from those reports was
retained as an unpatched defect in this source review. The DXA comparisons below
remain inconclusive or different; passing invariant tests does not close them.

## Work supported by current code

### K4. DXA scientific validation

**Priority:** before larger DXA algorithm changes. **Effort:** M–L.

P0/P1 diagnostics and complete scientific readback are implemented. The stored
real-input and generated-fixture matrices still have false strict comparison
pass flags. True parallel Delaunay (PDEL) runs differ in complete polylines/meshes;
some partial Burgers vectors differ in their last bits, including repeated
baseline runs. This is an unresolved validation gap, not evidence that the
latest changes introduced every difference.

- Explain and classify the PDEL baseline/repeat differences using complete
  scientific outputs. Separate valid triangulation degeneracy from a changed
  physical network. Keep unexplained results inconclusive; do not silently
  widen tolerances or accept matching summary totals as equivalence.
- Resolve the full-network OVITO reference differences under the same contract.
  Add physically relaxed junction/reaction cases, nonzero HCP/diamond networks,
  near-coplanar full point sets and infinite-cell hull geometry coverage.
- Add real 8/16-core threaded samples; simulated browser CPU budgets validate
  scheduling, not physical scaling.
- Evidence and reproducible commands: [DXA implementation and validation](DXA.md),
  `docs/benchmarks/dxa-p0p1-global.json`, `dxa-p0p1-fixtures.json`,
  `tests/dxa-global-geometry.test.js`, `tests/dxa-global-network.test.js`,
  and `scripts/lib/dxa-science-compare.mjs`.

### R9. Ambient-occlusion counting on the GPU

**Effort:** M. `src/render/ambient-occlusion.js` still reads an ID image for each
direction and counts IDs on the CPU (`accumulateVisiblePixels`).

Prototype a float count texture that accumulates all directions before one
readback. Require exact counts while representable in Float32 and retain the
current path when float blending is unavailable. Measure render, transfer,
counting and total background time; preserve visibility masks and cancellation.
The 2026-10-10 prototype gains were measured outside this checkout and need a
fresh reproducible baseline before implementation is justified.

### R10. Merge completed Voronoi display buffers

**Effort:** M. `src/render/voronoi-cell-layer.js` retains one buffer/VAO per
streamed chunk and loops over `this.chunks` during drawing.

After streaming completes, combine chunks into a bounded number of buffers in
original chunk/triangle order. Preserve translucent compositing, periodic
copies, highlights and progressive display; measure the consolidation allocation
peak as well as draw calls. Verify images, picking and context restoration with
the existing Voronoi browser suites.

### K1. Further ordered grain-merge optimization

**Effort:** M. `src/analysis/grains.js` already reuses union–find roots through
`mergeRoots`; parallel preparation and retained merge models also exist. The
graph/MST merge remains dependency ordered.

Profile this remaining stage before choosing a change. Preserve orientation
accumulation, equal-weight edge order, thresholds, complete models and grain IDs.
The earlier generation-stamp adjacency prototype did not give a stable total
speedup and should not be reintroduced without new evidence. Use
`npm run benchmark:grains` and `npm run benchmark:grains-shear`; retained raw
samples are in `docs/benchmarks/grains-shear-2026-10-20.json`.

### K3. Local-shear fallback cost on fresh frames

**Effort:** M. `src/analysis/local-shear.js` uses a sampled candidate mode,
guarded fused moments and the full coordination histogram. Misleading samples
or differing modes across Worker partitions still require exact recomputation.

Reduce wasted candidate work on deliberately reordered **new** frames without
changing the full-histogram definition, reduction order or low-memory fallback.
Measure ordinary mixed and adversarial fresh snapshots separately from repeated
immutable frames. The 2026-10-20 three-sample fresh-frame medians regressed
104.17 → 145.69 ms privately and 68.26 → 80.88 ms shared, with substantial
variation; they are historical evidence requiring remeasurement, not current
machine timings. Use `npm run benchmark:grains-shear` and the raw record above.

### K4. DXA performance candidates, P2–P5

**Effort:** L. Current algorithm, source entrypoints and diagnostic commands are
in [DXA](DXA.md). Compact edge rows, reusable search storage, ordered ghost-face
lookup and P0/P1 are complete; do not schedule them again.

| Stage | Remaining candidate | Constraint / trigger |
| --- | --- | --- |
| P2 | Geogram point location, conflict traversal and stable compaction | Select the actual hot substage using diagnostics; preserve predicates and traversal effects. |
| P3 | Bounded PDEL workspace and pool sizing | HEA diagnostics show pool exhaustion/serial recovery; Fe/NiGB do not. Include allocation, reset, peak memory and recovery in the comparison. |
| P4 | Classification access, ordered half-edge construction, duplicate InterfaceMesh topology storage | Preserve commit order and every Surface consumer. Include packing/transfer cost for nonisolated local-stage offload. |
| P5 | Reuse bounded search context across batches; optimize transitions only if measured hot | Preserve circuit/visited state, edge order, periodic shifts, junctions and transition fallback. Prove independence before parallelizing searches/components. |

An empty final network does not permit skipping tracing: the NiGB diagnostic
still visits 69,396 seeds and about 15.61 million edges. The parallel face-payload
preparation and frontier-pruning candidates were rejected; revive them only with
new measurements showing that their original failure has been addressed.

**P6 is the acceptance gate for every candidate:**

- Compatibility changes preserve input/periodic-image order, seeds, perturbation
  sequence and robust predicates. Every new cache needs an owner, a retained
  memory budget and explicit invalidation for frame/coordinate revision, cell,
  PBC, selection, lattice and search parameters; it must not grow with frames.
- Compare complete structure/cluster arrays, Burgers vectors, ordered polylines,
  junction incidence, transitions and both defect/Surface mesh consumers.
  Keep the zero-tolerance default; document any justified comparator rule
  separately before accepting results that previously failed it.
- Rebuild and validate both serial and threaded Wasm artifacts. Retain real
  Worker/Wasm prewarming, shared CPU admission, cancellation, same-heap reuse,
  startup failure and allocation-failure recovery.
- Run diagnostics separately from formal timings. Include cold/warm end-to-end
  latency, preparation/readback and peak memory, not just the kernel substage.
  Use at least seven interleaved baseline/candidate samples and an independent
  confirmation. A proposed gain should exceed noise (target at least 5%);
  a reproducible total regression over 5% blocks adoption.
- Keep generated fixtures and real HEA/Fe/NiGB inputs. A fixed-Delaunay comparison
  isolates downstream changes but does not validate genuine PDEL equivalence.

## External checks

### R7. Conservative depth on a supporting physical GPU

The compile/link probe, guarded sphere depth, safe replica order and fallback
are implemented in `src/render/conservative-depth.js` and their callers.
The recorded Chromium/SwiftShader driver rejects the qualifier, so those checks
prove fallback behavior only. Test a physical GPU whose compiler accepts it,
then compare exact screen/export images and early-depth timings across relevant
vendors. No further shader rewrite is justified solely by the old speed estimates.

### S4. Production immutable-asset cache policy

The build already emits exact-hash `_headers` rules and preview validates the
manifest before caching assets. Production CDN activation was not verified in
the previous review or this local cleanup. Inspect the live response headers
first; configure the external CDN only if needed, following
[Deployment](DEPLOYMENT.md#cache-content-addressed-assets). Cache successful
exact-hash assets only; missing versions must not receive long-lived 404 caches.

## Deferred decisions, not required fixes

| Item | Why it is deferred | Reopen when |
| --- | --- | --- |
| R1: MSAA capless bonds | There is a real differing-pixel counterexample. `src/render/atom-primitives.js` intentionally retains caps for MSAA/exports/uncertain coverage. | A new coverage proof passes strict pixel comparisons, including the counterexample, without an expensive per-camera bond scan. |
| C11: Worker-count-independent bond moments | `src/analysis/analysis-pool.js` preserves logical partition order; changing to fixed Welford blocks changes numerical last bits. | An explicit numerical reproducibility policy justifies the behavior change. |
| G5/G6: double-float/Voronoi kernel redesign | Precision guards are required. GPU Voronoi is opt-in; past hardware results did not justify a rewrite. | A faster target adapter and end-to-end profile justify a compact workspace/plane-order prototype with exact recovery. |
| R11: non-instanced software renderer | The current instanced path works; this targets SwiftShader/CI performance more than users. | Software-rendering latency becomes a concrete priority and an exact-image benchmark reproduces the expected benefit. |
| DXA R1/R2: periodic representation or cross-frame topology | Triclinic periodic images and topology validity are global contracts; native Geogram periodic support is not a drop-in replacement. | There is a proof for the supported cells/updates and a full-pipeline benchmark meeting the K4 gate. |
| Full GPU DXA | Existing local GPU research does not implement complete global topology and tracing. | A complete algorithm and exact validation plan justify a separate research effort. |

Compound replicated IDs intentionally yield NaN in the numeric `ID` expression;
see [Expressions](features/expressions.md). Movie ranges already reset on source
changes. Neither is an open regression. Unsupported formats, builders and native
integration are product limits documented in the feature pages, not implicit
implementation commitments.

## Constraints for future changes

Preserve scientific results and exact screen-sized exports unless a numerical
change is explicitly agreed. Keep nonisolated hosting, bounded memory, background
prewarm/prefetch and cancellation. Validate configuration/script input as data.
Update the affected feature page and meaningful regressions; run `npm test`,
`npm run build` and the relevant browser suites. Remove completed entries here
instead of appending another list of closed findings.
