# DXA implementation and scientific validation

Checked against the repository on 2026-10-22. This is the maintained developer
reference for the CPU/Wasm implementation, diagnostics and comparison protocol.
User controls and execution behavior are in [Dislocations](features/dislocations.md).
Outstanding work is maintained only in [TODO](TODO.md).

## Source and algorithm

The numerical core is pinned to OVITO **v3.9.4**, commit
`939f5d909ea3b0fd0dd6695494da8f8d03821c2e`. AlloyView uses the upstream files'
MIT option; Geogram retains its separate BSD license. Preserve all notices and
both source manifests when adapting or rebuilding the core. The source layout,
port adaptations and licenses are documented in
[`third_party/dxa/README.md`](https://github.com/Yazhuo-Liu/AlloyView/blob/main/third_party/dxa/README.md).

The core identifies ordered local crystal environments, builds crystal clusters
and their transformations, constructs a periodic Delaunay tessellation, maps
its edges to ideal lattice vectors, forms the crystal/defect interface, and
traces Burgers circuits into curves and junctions. Optional line processing and
defect-mesh construction follow tracing. Ordinary CNA labels alone do not supply
the ordered neighbor correspondence and crystal-frame mapping required here.

The pinned release supports FCC, BCC, HCP, cubic diamond and hexagonal diamond,
with one input lattice per analysis. It predates the later low-c/a HCP correction;
it is not a general classifier of unrelated mixed crystal families. Line IDs are
run-local. Reversing line sense reverses the Burgers vector; junction conservation
requires vectors in compatible crystal frames.

Production DXA uses CPU/Wasm. One global native session owns the periodic
geometry, crystal graph and network. Isolated hosts can use a shared-memory
pthread pool; ordinary hosts can offload independent local stages to private
CPU Workers. Native and private stages share the application CPU budget and
retain warmed resources where cancellation permits. Splitting atoms spatially
and concatenating independent DXA outputs does not preserve this global network.

`DelaunayTessellation.cpp` selects BDEL with one native thread and PDEL with
multiple threads. PDEL means **ParallelDelaunay3d**, not a native periodic-cell
representation: the adapter still explicitly constructs periodic images using
the full cell. The bundled `PeriodicDelaunay3d` uses cubic-domain assumptions
and is not a substitute for general triclinic or mixed-PBC geometry.

Current layouts retain first-seen edge orientation and leaving/arriving neighbor
order. Parallel edge searches have private scratch; unknown cluster transitions
are deferred to ordered serial work. Tracing uses stable 1,024-record pages,
retaining at most 1 MiB of complete pages between seeds without limiting a
single search. Contiguous ghost-face lookup preserves the first-created face;
vertex/face creation and half-edge commits remain ordered. The manifold helper
also serves Surface, so geometry changes must validate both analyses.

## Diagnostic interfaces

`Module.onDxaProfile` is the opt-in switch. Formal timings disable it; collect
profiles in separate complete extractions. Disabled diagnostics do not read
clocks or run diagnostic topology traversals, but some conditional branches and
session storage remain. This is not a claim of mathematically zero overhead.

| Area | Available diagnostics |
| --- | --- |
| Geometry | Periodic preparation; BRIO/Hilbert ordering; allocation, bootstrap, insertion, compaction and remapping |
| PDEL | Worker-private insertion, location, conflict, rollback, wait, pool exhaustion and serial-tail counts |
| Predicates | Orientation/in-sphere calls and exact fallbacks for the active unweighted path |
| Tracing | Search and extension by depth, actual junction merging, secondary segments, cleanup and rejection reasons |
| Mesh and crystals | Classification, ordered face/half-edge construction, static components, cluster traversal, mapping contexts and transition queries |

Worker counters are accumulated privately and published after joining. Fixed
capacity is 2,048 timing entries and 4,096 counter entries; overflow is explicit
and makes the benchmark fail. Nested scopes overlap. Worker elapsed-time sums
include scheduling/waiting and cannot be added to wall time or called CPU
utilization. Buffer capacities and pool slots are not process peak memory;
Wasm heap size describes retained capacity, not RSS.

The public progress label **Connect dislocation junctions** calls
`finishDislocationSegments()`. Actual `joinSegments()` runs inside tracing and
has its own timer. A short finalization stage does not mean junction merging is
cheap. Static interface components do not prove independent tracing components.

Cancellation follows existing safe boundaries. Geogram insertion and its serial
tail have no new internal cancellation checks; cooperative cancellation may
wait for the next boundary. Nonshared synchronous work may require Worker
termination and rebuilding. Tests of recovery do not establish immediate
insertion-time cancellation.

`_alloy_dxa_science_snapshot(budgetBytes)` exports complete internal state from
a retained staged session after `begin` or `finish`, before `dispose`. It adds
atom-to-cluster assignments, cluster metadata and all cached directed
transitions to the usual network/mesh outputs. Matrices are row-major; reads
never create transitions. The output budget includes its NUL terminator and
does not bound total analysis memory.

`_alloy_dxa_release_science_snapshot()` releases that output. Another read,
release, finish, prepare or dispose invalidates its pointer. Cancellation,
budget exhaustion or serialization failure leaves a valid native session
available. Full `_analyze` releases the session and cannot be followed by this
internal readback.

## Scientific comparison contract

Use [`scripts/lib/dxa-science-compare.mjs`](https://github.com/Yazhuo-Liu/AlloyView/blob/main/scripts/lib/dxa-science-compare.mjs)
to validate completeness before judging equivalence. Compare every atom label,
cluster membership/metadata and transition, complete curves and Burgers vectors,
reciprocal junction incidence, periodic winding and the full requested mesh.
Line counts, total length and degree histograms alone are insufficient.

| Status | Meaning |
| --- | --- |
| `exact` | Complete normalized data match with the required coverage present |
| `equivalent` | A supported representation difference is proved equivalent under tolerances declared before execution |
| `different` | A confirmed scientific difference or invalid output |
| `inconclusive` | Missing coverage, exhausted matching budget or differences the comparator cannot prove equivalent |

Compatibility changes require exact full outputs for fixed single-thread
geometry, including existing frozen mesh/snapshot hashes. Actual PDEL scheduling
can produce different core paths, including repeated executions of the same
binary. Compare the same backend/thread count, retain that baseline variation,
and separately check geometry and physical invariants. Existing nondeterminism
does not justify accepting every new difference or widening tolerances afterward.

The geometry checks use exact dyadic-integer predicates on exported binary64
coordinates for finite cells, shared faces and local empty-sphere conditions,
plus reciprocal adjacency checks. Infinite-cell vertices are not fully exported:
the result explicitly reports `infiniteFaceGeometry: 'not-exported'`. These tests
do not establish complete convex-hull geometry.

The pinned independent OVITO 3.9.4 references include full curves, labels,
available crystal state, meshes and CA junction rings. Their manifests preserve
input/output hashes and external API/decimal precision limits. See
[`dxa-ovito394-manifest.json`](https://github.com/Yazhuo-Liu/AlloyView/blob/main/tests/fixtures/dxa-ovito394-manifest.json) and
the [oracle exporter](https://github.com/Yazhuo-Liu/AlloyView/blob/main/scripts/research/ovito-dxa-oracle.py).
Analytical screw, crossing and Shockley-partial fixtures are unrelaxed elastic
stress cases, not equilibrated junctions or real MD trajectories.

The 2026-10-21 records distinguish successful coverage from strict acceptance:

| Comparison | Exact | Equivalent | Different | Inconclusive | Strict gates |
| --- | ---: | ---: | ---: | ---: | --- |
| [Real-data matrix](benchmarks/dxa-p0p1-global.json) | 331 | 0 | 0 | 89 | Both false |
| [Generated fixtures](benchmarks/dxa-p0p1-fixtures.json) | 882 | 0 | 9 | 69 | Both false |

Both matrices completed with full internal coverage; all single-thread
comparisons were exact. `allComparisonsPassed` and `fullScienceAuditPassed`
remain false. The nine `different` results concern multithreaded partial
Burgers matching, including same-version repeats. Full external comparisons
also remain unproved: screw-pair core geometry is `inconclusive`; crossing and
partial cases are `different` at strict zero tolerance because of Burgers
last-bit differences. Independent labels, ideal lattice Burgers, incidence,
conservation, winding and stacking-fault checks pass within their own stated
contracts. Those checks do not replace full scientific equivalence.

## Benchmark and build protocol

Build both kernels with `npm run build:dxa` and `npm run build:dxa:threaded`.
The build uses Emscripten 3.1.69, LTO, SIMD and native Wasm exceptions. Record
toolchain, actual JS/Wasm hashes, parameters, input hashes and CPU quota.
Keep ordinary application prewarming enabled when measuring user experience.

| Entry point | Scope |
| --- | --- |
| `npm run benchmark:dxa` | Cold/warm complete CPU path and Worker behavior |
| `npm run benchmark:dxa-cpu` | Retained-heap stage and thread sweeps |
| `npm run benchmark:dxa-k4` | Fixed single-thread geometry; downstream thread/layout comparison |
| `npm run benchmark:dxa-global` | True full-pipeline BDEL/PDEL with requested threads retained throughout |

The K4 four-thread protocol deliberately keeps Delaunay single-threaded. Its
results cannot establish four-thread PDEL scaling. Global formal timing covers
complete native `_analyze`, including session release, excluding module startup,
upload, JSON decoding, comparison and archival. Defect-mesh generation is off
for formal timing; separate untimed staged audits enable mesh and diagnostics.
Report user waiting time separately from native timing and diagnostic scopes.

An older baseline without scientific readback requires two builds: the original
binary for timing and a readback-only patched reference for untimed audits.
The [readback patch](benchmarks/dxa-p0p1-baseline-readback.patch.gz) applies to
baseline `d1bfe2f4f810c4c204bc0ddad417332fafbd7368`; build both variants in that
separate checkout and pass its analysis directory to the benchmark:

```bash
npm run benchmark:dxa-global -- \
  --baseline-ref d1bfe2f \
  --baseline-science-dir /tmp/alloyview-baseline-readback/src/analysis \
  --dataset all --kernel both --threads 1,2,4,1 \
  --repetitions 3 --audit-repetitions 2 \
  --geometry-tolerance 0 --burgers-tolerance 0 --cluster-tolerance 0 \
  --output /tmp/dxa-global.json
```

Default `--require-equivalence yes` exits with code 2 on any unproved comparison.
The historical matrices explicitly used `no` to record existing PDEL variation;
their exit code 0 establishes completion only. Read all four report fields:
`complete`, `fullScienceCoverageAvailable`, `fullScienceAuditPassed` and
`allComparisonsPassed`. `--dataset fixtures` selects generated cases;
`--snapshot yes` records geometry buffer hashes, not a geometry proof.

Use alternating baseline/current measurements on retained modules after
warmup, without concurrent builds or benchmarks. Candidate screening needs
at least three samples; adoption needs at least seven on principal cases and
an independent repeat, with exceptions/uncertainty recorded for costly cases.
Never report oversubscribed threads as physical-core scaling. Rebuild both
kernels, validate source manifests and cover both isolated/nonisolated browser
execution, Surface, cancellation, failure recovery and shared CPU-budget use.

## Retained evidence

Raw measurements remain available without retaining duplicate implementation
reports. They describe their recorded revisions and hardware, not fresh claims:

- [K4 final one-thread](benchmarks/dxa-k4-adopted-one-thread.json) and
  [fixed-topology four-thread](benchmarks/dxa-k4-adopted-four-thread.json): final
  compact-edge, scratch and ghost-face layouts, complete outputs and capacity data.
- [Ordered edge passes](benchmarks/dxa-p18-ordered-edges.json) and
  [immutable tracing state](benchmarks/dxa-tracing-2026-10-20.json): bounded
  implementation changes with complete-result comparisons.
- [P0/P1 browser record](benchmarks/dxa-p0p1-browser.json): integration and recovery
  checks; SwiftShader rendering does not demonstrate physical-GPU performance.
- [Rejected face preparation](benchmarks/dxa-k4-face-preparation.json) and
  [frontier pruning](benchmarks/dxa-tracing-frontier-rejected-2026-10-20.json):
  no demonstrated benefit; neither is an outstanding implementation commitment.
- [Original NiGB oracle](benchmarks/ovito-dxa-nigb.json): explicitly versioned
  OVITO 3.10.6 CPU record, separate from the pinned 3.9.4 references. Its thin
  original cell is rejected; physical 1×1×2 replication returns an empty network.
  This is a geometry/search stress case, not proof that all defects are absent.
