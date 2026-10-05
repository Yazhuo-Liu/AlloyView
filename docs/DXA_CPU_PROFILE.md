# CPU DXA profile

The current whole-frame CPU path already uses Wasm pthreads for local crystal
identification, Delaunay construction, ghost-cell classification, and interface
tetrahedron classification. On the actual Fe and NiGB examples, six computation
threads provide about twice the throughput of one thread. These numbers are
measurements in this cloud machine, not a browser or physical-core guarantee.

Run the retained-heap benchmark with:

```sh
node scripts/benchmark-dxa-cpu.mjs --dataset all --threads 1,6,1 --repetitions 2
```

The benchmark initializes workers before timing analysis, retains one shared
kernel/heap across concurrency changes, records each native stage, and checks
every atom label across runs. It records the Fe loop's family, closure,
junctions and length. NiGB uses the existing real `[1,1,2]` replication because
its unreplicated periodic cell is too thin for this DXA configuration.
Without an explicit thread sequence, the script leaves two available logical
CPUs for the host and compares one thread against the remaining CPU budget.
Explicit sequences accept 1–64 requested threads; the runtime can clamp that
request for smaller frames. The historical six-thread run above is a diagnostic
oversubscription on this machine.

## Current Wasm measurements

Baseline: revision `5335a35`, Node 24.19.0, 2026-10-05. Node reports four
available logical CPUs in this environment; six threads is an explicit
diagnostic oversubscription. Browser defaults use their exposed concurrency
and leave two logical CPUs available, so a browser exposing four uses at most
two computation threads. The complete measurements
are in [dxa-cpu-node-baseline.json](benchmarks/dxa-cpu-node-baseline.json).
The following table uses the last warm run at each concurrency; all values are
milliseconds.

| Stage | Fe, 1 thread | Fe, 6 threads | NiGB, 1 thread | NiGB, 6 threads |
| --- | ---: | ---: | ---: | ---: |
| Whole pipeline | 2,238 | 983 | 15,433 | 7,657 |
| Identify local crystal structures | 406 | 127 | 1,520 | 454 |
| Build crystal clusters | 27 | 26 | 126 | 91 |
| Connect crystal reference frames | 2 | 2 | 8 | 11 |
| Periodic Delaunay tessellation | 903 | 315 | 6,395 | 2,439 |
| Build tessellation edges | 112 | 115 | 662 | 773 |
| Assign crystal clusters | 0.3 | 0.3 | 2 | 2 |
| Map edges to the ideal lattice | 60 | 63 | 484 | 586 |
| Construct crystal interface mesh | 697 | 303 | 5,185 | 2,303 |
| Trace Burgers circuits and lines | 0.2 | 0.1 | 903 | 868 |
| Serialize network and atom labels | 25 | 25 | 118 | 108 |
| Uninstrumented pipeline overhead | 6 | 6 | 30 | 21 |

Uninstrumented overhead includes JavaScript validation, coordinate conversion,
heap upload, decoding and result normalization, plus native input preparation
and session disposal. It is not a separate measurement of pure JavaScript work.
The JSON stage serializes every atom label as text even for empty networks.

A separate thread sweep on this four-CPU machine measured Fe at 2.37, 1.39
and 1.15 seconds with one, two and four threads, and NiGB at 15.05, 10.97 and
7.30 seconds. Every atom label matched throughout. This supports honoring the
exposed CPU budget rather than assuming six processors are available. Raw
measurements are in
[dxa-cpu-node-thread-sweep.json](benchmarks/dxa-cpu-node-thread-sweep.json).

Growing from one to six computation threads created five pthread workers in
60 ms for Fe and 82 ms for NiGB. Returning to one thread took less than 0.1 ms
and retained those idle workers. The same kernel generation and heap remained
throughout: 93,716,480 bytes for Fe and 478,871,552 bytes for NiGB. Idle workers
do not hold permits in the application's shared CPU budget. The coordinator
participates in computation, so a request for six uses five nested workers.

Fe has 60,229 atoms. All runs classified the same atoms and produced one closed
`1/2 <111>` BCC loop with the same junction topology. Serial runs measured
103.96182 Å; parallel runs measured 103.94723 and 104.34064 Å. Parallel Delaunay
can choose different valid triangulations of nearly degenerate sites, so its
smoothed polyline is not bitwise identical. The benchmark retains the existing
physical 100–108 Å loop expectation and reports the observed lengths. NiGB has
129,904 source atoms and 259,808 replicated atoms; all concurrency settings
produced the same atom labels and zero dislocation segments.

## Which further parallel loops matter

A separate native Linux executable was compiled from temporary instrumented
copies of the same headless C++ sources. It uses native pthreads, not Wasm, so
its absolute timings cannot be substituted for the table above. Its mesh
substeps identify where work remains:

| Mesh substep | Fe, 1 thread | Fe, 6 threads | NiGB, 1 thread | NiGB, 6 threads |
| --- | ---: | ---: | ---: | ---: |
| Alpha and elastic classification | 459 | 97 | 3,104 | 860 |
| Ordered cell numbering/reduction | 3.5 | 2.1 | 14.8 | 14.6 |
| Create interface facets | 42.5 | 45.9 | 264 | 282 |
| Link halfedges | 0.85 | 0.88 | 24.3 | 24.5 |
| Split shared manifold vertices | 0.02 | 0.02 | 1.44 | 1.57 |
| Copy mesh payload/pointers | 0.012 | 0.013 | 0.52 | 0.67 |

The mesh payload loops are safe candidates for independent writes, but their
measured cost is negligible. Classification is already parallel and remains
the largest mesh cost. Facet creation scans all filled local tetrahedra, checks
wrapped vectors, assigns mesh IDs in cell order, and mutates shared vertex/face
lists. Halfedge linking writes both sides of each pair. A direct parallel-for
around either mutation loop would introduce races or change topology ordering.

The remaining edge-construction loop repeatedly searches short linked lists
to deduplicate the six edges of each local tetrahedron. A future replacement
could collect immutable edge candidates in parallel, then deduplicate and
commit them in the original cell/edge order. It must retain first-seen edge
orientation, linked-list order, and reference-frame mapping; a shared mutable
unordered map is not a safe drop-in change.

Ideal-vector mapping uses a mutable crystal path-finder scratch pool and may
cache new transitions in the cluster graph. Atom-cluster construction is an
ordered graph traversal that propagates symmetry permutations and accumulates
orientation matrices. Dislocation tracing also mutates search state, circuits
and shared lines. These stages need an explicit algorithm redesign before
parallel execution; independent frame fragments would change global DXA
topology. NiGB makes the serial tracer's cost visible even though it produces
no final segments.

## Alpha-cache experiment

A temporary native experiment cached each finite tetrahedron's tri-state
alpha test once and read that immutable result during the original sliver
neighbor checks. Each dataset/thread-count combination built its topology
once and alternated original/cached extraction three times. At one, two and
four threads, all 36 extractions preserved the exact complete network JSON
and every tetrahedron region on the retained topology. Fe had 760,983
tetrahedra and no inconclusive alpha tests; NiGB had about 5.16 million
tetrahedra and about 7,700 inconclusive tests. Memory cost was one byte per
tetrahedron; the GPU-preclassified path bypassed allocation.

The measured gain was inconsistent, including regressions at one and two
threads. Median native finish time changed by +2.3%, -5.9% and +12.5% for Fe
at one, two and four threads, and -7.5%, -7.3% and +3.8% for NiGB. Positive
values mean faster; these timings had some CPU contention. This experiment
does not justify a production change. It also confirms that repeated
sliver-neighbor alpha tests are too uncommon in these examples to explain
most classification cost. The next meaningful candidate is accelerating
immutable edge lookups while preserving the existing edge construction.
Exact checks and individual native timings are retained in
[dxa-cpu-native-alpha-experiment.json](benchmarks/dxa-cpu-native-alpha-experiment.json).

## Immutable edge-index experiment

A second temporary native prototype retained the original edge construction,
orientation and linked lists. After construction it built sorted neighbor
rows containing pointers to those same edge records. Counting rows and filling
and sorting their disjoint storage used the existing bounded parallel loop;
lookup used binary search only after construction completed. The original
linked-list lookup remained available during construction. Alpha caching was
disabled for this experiment.

All 36 same-topology extractions at one, two and four threads preserved exact
complete network JSON and every tetrahedron region. A separate one-million
query benchmark measured 3.6–5.2 times faster lookup. It verified matching hit
counts and aggregate pointer-sum checksums, rather than asserting each queried
pointer separately. The complete timings are in
[dxa-cpu-native-edge-index-experiment.json](benchmarks/dxa-cpu-native-edge-index-experiment.json).

Single-frame performance must include constructing the index. The following
table shows medians of three extractions, in milliseconds. Finish includes
mesh construction, tracing, line processing and serialization. Mapping remains
unchanged and is excluded from these finish times.

| Case | Original finish | Index build | Indexed finish | Finish gain including build |
| --- | ---: | ---: | ---: | ---: |
| Fe, 1 thread | 428 | 45 | 345 | 8.9% |
| Fe, 2 threads | 246 | 32 | 209 | 1.7% |
| Fe, 4 threads | 161 | 18 | 146 | -2.0% |
| NiGB, 1 thread | 4,501 | 245 | 3,460 | 17.7% |
| NiGB, 2 threads | 2,579 | 134 | 2,314 | 5.1% |
| NiGB, 4 threads | 1,957 | 98 | 1,723 | 6.9% |

Including the measured unchanged mapping stage, estimated whole-pipeline gains
were only 2.7%, 0.4% and -0.5% for Fe, and 7.6%, 2.0% and 2.4% for NiGB at
one, two and four threads. These estimates sum stage measurements; they are
not additional independent end-to-end runs.

The native index added 13,973,136 bytes for Fe's 421,603 unique edges and
60,328,648 bytes for NiGB's 1,820,318 unique edges. Wasm32's narrower keys and
pointers would halve that index storage: 6,986,568 and 30,164,324 bytes. Those
are layout estimates, not measured Wasm allocations. Existing edges and linked
lists remain allocated alongside the index.

The current parallel default does not get a consistent material gain across
both datasets, so this prototype was not adopted. Neither experiment changed
production C++, checksum manifests or Wasm binaries. The GPU snapshot exporter
uses a separate unordered map of edge keys; this CSR index does not accelerate
its six lookups per tetrahedron.

## Prioritized further work

1. Profile global periodic Delaunay construction and elastic classification
   first. They dominate both real examples after the existing safe parallelism.
   Improve data access within their current floating-point and robust-predicate
   rules; measure whole-frame gains at the available CPU budget.
2. Consider replacing the existing pointer-heavy edge representation with a
   compact immutable representation, rather than allocating a second full
   index. Preserve first-seen edge orientation, graph transitions and ordered
   edge construction. The lookup experiment demonstrates a locality benefit,
   while also showing why an additional index does not justify its cost here.
3. Separate immutable boundary-facet detection and wrapped-vector validation
   from ordered topology creation. A parallel prepass could collect candidate
   cells and retain their original cell/face order. Every filled local cell
   must still receive the current wrapped-vector validation, including interior
   cells; skipping that validation would change thin-cell error behavior.
4. Investigate the serial circuit search on the NiGB grain-boundary mesh.
   Its empty final network still costs about 0.9 seconds in Wasm. Any pruning
   or component-based concurrency must preserve visited state, junctions,
   periodic connectivity and the circuit search order that determines output.
   A previously empty network is insufficient reason to skip tracing.

Coordinate conversion, input copies, JSON decoding and atom-label serialization
are lower-priority targets for these frames. They should be revisited only
after the dominant topology work improves, or if a different frame shows them
dominating. Splitting independent spatial atom blocks does not preserve the
global periodic dislocation network.
