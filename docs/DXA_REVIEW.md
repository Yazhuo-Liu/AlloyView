# Dislocation extraction: implementation review

Research date: 2026-10-05 UTC. This document preserves source inspection,
feasibility findings and historical GPU experiments. As of 2026-10-07 the
production [Dislocation analysis](features/dislocations.md) is CPU/Wasm only,
with shared-memory pthreads or private local-stage CPU Workers around one
global serial kernel. GPU designs,
implementation descriptions, command names and numerical measurements below
refer to earlier revisions; they are not current supported execution paths.
Numerical records are preserved rather than reinterpreted as current results.

## Conclusion

A browser implementation is feasible. The recommended design is a complete
CPU WebAssembly DXA kernel in a dedicated Worker, with optional WebGPU
acceleration of independent stages. Both modes must produce the same physical
dislocation network and share a CPU reference implementation.

Official OVITO **v3.9.4**, commit
`939f5d909ea3b0fd0dd6695494da8f8d03821c2e`, contains the complete DXA source.
The checked DXA engine, tracer, elastic mapping, interface mesh, crystal path,
structure analysis and Burgers circuit files explicitly offer **GPLv3 or MIT**.
Its Geogram geometry library uses the **BSD 3-Clause license**. This provides a
practical route compatible with AlloyView's MIT distribution, retaining the
upstream notices and auditing every additional dependency before vendoring.

The current official source snapshot, commit
`81d76297a22ba00793b16487e821884e3c77028a`, retains DXA documentation, network
objects, rendering and export code but does not include the extraction engine.
Its repository-wide MIT option is therefore not evidence that a current DXA
kernel is available. Pin the complete historical version and record any later
changes independently; do not assume exact parity with every current feature.
For example, the current HCP **Low c/a ratio** treatment was introduced in
OVITO 3.15.0 and is absent from v3.9.4; adopting the historical core does not
provide that improvement without an additional implementation and validation.

## What DXA computes

The published algorithm converts atomic coordinates into curves representing
dislocations. Each curve has a Burgers vector, a crystal-cluster coordinate
frame, endpoints and junction connectivity. The principal reference is
[Stukowski, Bulatov and Arsenlis, 2012](https://doi.org/10.1088/0965-0393/20/8/085007);
the earlier method is described by
[Stukowski and Albe, 2010](https://doi.org/10.1088/0965-0393/18/8/085001).

The inspected engine performs these steps:

1. Identify local lattice environments and ordered ideal-neighbor
   correspondences; build crystal clusters and their orientation relationships.
2. Construct a periodic three-dimensional Delaunay tessellation. OVITO creates
   ghost images using the actual cell vectors and face geometry, and perturbs
   tessellation coordinates slightly with a reproducible seed to handle
   degenerate ideal-crystal configurations.
3. Build the tessellation edge graph, assign crystal frames to vertices, and
   map suitable edges to ideal lattice vectors. The native crystal-path search
   uses a maximum path length of four steps.
4. Test tetrahedra for consistent lattice mapping and form the interface mesh
   separating successfully mapped crystal from unmapped regions.
5. Search this interface for Burgers circuits. A circuit closed in real space
   can have a nonzero closure failure after its steps are transferred to the
   ideal reference lattice. That sum is the Burgers vector.
6. Advance and adapt the circuits along the core to extract curves, connect
   junctions, and finish periodic or closed segments. Construct the remaining
   defect mesh, then optionally smooth and coarsen the output.

The historical implementation supports FCC, BCC, HCP, cubic diamond and
hexagonal diamond. It selects one input crystal family, while accounting for
supported related structures such as HCP stacking-fault environments in FCC.
It ignores chemical species; selecting a sublattice restricts which atoms enter
the analysis without adding chemical interpretation.
It is not a general mixed-FCC/BCC interface classifier. A two-dimensional
simulation cell is unsupported, although a three-dimensional cell containing
straight periodic dislocations is a valid use case when large enough.

The default trial circuit limit is 14 atom-to-atom steps and stretchability is
9 additional steps. These control discovery and tracing; they are not an atom
distance cutoff. Partial dislocations, stacking faults, coherent twins and
junctions must retain their supported crystallographic transformations.

## Historical CPU/GPU allocation study

| Stage | Current implementation | Remaining GPU migration opportunity |
| --- | --- | --- |
| Periodic neighbor search and local structure correspondence | Optional WebGPU, with CPU Wasm reference/fallback | Implemented per central atom for all five supported crystals, including ordered bond-graph matching |
| Crystal clusters and inter-cluster transformations | CPU Wasm | Later graph algorithms with explicit synchronization and symmetry handling |
| Robust periodic Delaunay tetrahedra | CPU Wasm / Geogram | Substantial separate project; dynamic topology and robust geometric predicates |
| Ideal vectors for unique tessellation edges | CPU Wasm baseline | Bounded per-edge path search once cluster transforms and adjacency are fixed |
| Tetrahedron alpha and Burgers/Frank consistency | Optional WebGPU, with CPU reference/fallback | Implemented independent tests; alpha labels remain resident between passes |
| Manifold mesh construction and repair | CPU Wasm | GPU face filtering can assist; preserve CPU topology construction initially |
| Adaptive Burgers circuits, curve tracing and junction merging | CPU Wasm | Shared ownership and irregular searches require a dedicated parallel design |
| Smoothing a fixed curve/mesh graph | CPU baseline | Independent vertices with ping-pong updates; junction constraints must remain fixed |
| Curve coarsening | CPU baseline | Possible later compaction with endpoint and topology invariants |

AlloyView's ordinary GPU CNA returns structure labels. The dedicated DXA local
stage also reconstructs the neighbor bond graph and finds its first matching
ordered correspondence to the native ideal template. FCC/HCP use twelve
neighbors, BCC fourteen, and the two diamond structures sixteen including their
second shell. The cutoff arithmetic, bond signatures and graph constraints
follow the native algorithm using shader-emulated IEEE-754 binary64, including
square root and division. Crystal clusters and their inter-frame transitions
are then constructed by the retained CPU session. Ordinary CNA labels or PTM
strain tensors alone cannot supply this elastic mapping.

The full nearest-shell table remains on GPU between neighbor discovery and
local correspondence. Only one 80-byte local-result record per atom and a
16-byte completion record per shell-radius attempt are read back; the host
passes the smaller structure/ordered-index arrays into Wasm. This is a staged
hybrid pipeline: topology is subsequently exported for the existing GPU alpha
and elastic-compatibility passes. Both GPU stages can fall back independently
within the retained native session, and cancellation preserves the reusable
worker, heap and device whenever it occurs between native calls.

WebGPU does not provide portable native float64. The existing shader-emulated
IEEE64 machinery preserves nearest-neighbor ordering, but does not already
implement the robust orientation and in-sphere predicates required by a full
Delaunay builder. Arbitrary tolerance changes must not change network topology.

Any bounded GPU queue, image search, graph allocation or numeric-range failure
must fall back to the corresponding CPU stage with complete input. Never
silently truncate a neighbor list or Burgers circuit. Progress and result
metadata should identify which stages actually ran on GPU. Benchmark whole
DXA and its individual stages on physical hardware; accelerating only a small
local stage does not imply a comparable speedup of the entire algorithm.

## A GPU-resident DXA backend

A complete WebGPU extraction backend is technically possible, but it requires
new geometry and graph kernels. The current backend is the hybrid implementation
above: its local correspondence and tetrahedron classification run on WebGPU,
while crystal mapping, robust periodic geometry, interface construction and
tracing still run in CPU Wasm. This section proposes their migration into a
fully resident pipeline; it is not an implemented complete GPU backend or a
speedup claim. CPU Wasm remains the reference and fallback for unsupported inputs.

Here, GPU-resident extraction means uploading the source coordinates and cell
once, keeping all large intermediate arrays on one WebGPU device, and reading
back the final network once. JavaScript still submits command buffers and may
read small counts, overflow flags and convergence status between dispatches.
CPU orchestration does not require transferring the tetrahedralization or mesh
back to the CPU. A workgroup barrier synchronizes only that workgroup; global
graph updates need separate dispatches with explicit stage boundaries.

Use the existing dedicated GPU worker and `GpuRuntime` device, pipeline cache,
frame identity and cancellation conventions. GPU buffers belong to their
creating device: creating a second device for DXA would prevent direct reuse
of the existing resident position and neighbor-index buffers. DXA needs its
own workspace reservation; the current scalar-analysis memory estimate does
not account for tetrahedra, half-edges, periodic images or circuit queues.

### Resident data and dispatch sequence

Replace pointer-linked C++ objects with indexed, structure-of-arrays buffers.
Keep explicit image offsets for periodic vertices and edges, using the full
triclinic cell throughout. Storage limits apply to each buffer and binding,
not only to total VRAM: the current runtime requests at most 256 MiB per
storage-buffer binding. A large geometry workspace therefore needs a planned
segmented layout and must also fit the device's binding-count limits.

| Phase | Device-resident output | Parallel work and synchronization |
| --- | --- | --- |
| Local crystal correspondence | Ordered atom neighbors, ideal-vector indices, structure IDs and symmetry permutations | Central atoms are independent once the neighbor index is fixed; compact unresolved environments into another GPU pass |
| Crystal graph | Cluster membership, crystal-frame transformations and inter-cluster transitions | Build compatibility edges, then propagate labels and symmetry relationships over repeated dispatches; reduce orientation data per cluster |
| Periodic Delaunay | Primary/ghost vertices, tetrahedra and reciprocal cell adjacency | Generate ghost counts and prefix offsets; use a parallel insertion/repair algorithm with conflict ownership and certified geometric predicates |
| Unique edges and elastic mapping | Deduplicated edge keys, CSR adjacency, ideal vectors and transition indices | Sort/unique edge keys; bounded per-edge path searches after reference-frame transitions are resolved |
| Interface mesh | Tetrahedron labels, oriented faces, half-edge opposites and component IDs | Independent four-face consistency tests; count/scan/write candidate faces, then construct and validate manifold adjacency |
| Burgers circuits and tracing | Circuit queues, edge ownership, unwrapped curves and junction records | Search independent candidates/components in parallel; resolve overlapping ownership before committing updates, and merge junctions between rounds |
| Fixed-network processing | Smoothed/coarsened polylines, family IDs, lengths and density | Ping-pong vertex updates with fixed junction constraints; topology-aware compaction and reductions |

The crystal graph needs more than ordinary connected components: neighbor
compatibility includes symmetry permutations and changes of reference frame.
A label-propagation implementation must transport those relationships
consistently and detect conflicting cycles. Choosing cluster IDs in a different
order is acceptable; changing physical Burgers vectors or junctions is not.

For edge mapping, the current `CrystalPathFinder` contains mutable search
workspace, and `ClusterGraph::determineClusterTransition()` creates cached
transitions during lookup. A parallel implementation first resolves/freezes
the required transition graph, then gives each edge search independent scratch
space. Simply parallelizing the existing loop would introduce shared writes.
The CPU kernel has since adopted a variant of this for its pthread pool: each
thread searches with private path-finder scratch, and a search that needs a
transition not yet cached is deferred to the original ordered commit, so no
worker writes the graph. See [ordered edge passes](DXA_CPU_PROFILE.md#ordered-edge-passes-2026-10-08).

Circuit search has a similar constraint: the current tracer writes visited
vertices, claimed edges and shared junction rings. Starting a workgroup at
every mesh vertex without ownership rules can produce duplicate segments or
lose junctions. Component-level work is a useful first partition, but a single
connected grain-boundary interface can remain large. Within it, candidate
search needs conflict detection, a deterministic commit/retry policy and
explicit handling of circuits crossing any spatial partition boundary.

### Robust geometry is the main new numerical requirement

Perfect lattices contain many coplanar or cospherical tuples. The existing
CPU code applies tiny seeded perturbations and uses Geogram's robust
orientation and in-sphere tests. Rounding coordinates to f32 or increasing an
epsilon can change the tetrahedralization, the interface and ultimately the
dislocation network. The shader-emulated IEEE64 distance arithmetic already
used by other analyses does not supply these predicates or certify topology.

A GPU implementation needs either certified floating-point filters with a
GPU exact-predicate slow path, or exact predicates throughout. One possible
slow path evaluates determinant signs using multiword integer arithmetic on
the original finite IEEE coordinate bits. This requires explicit range and
capacity checks and reproducible degeneracy handling; it is a substantial
kernel rather than a cast to a larger shader type. WGSL has no portable native
f64. Test the numeric contract on different real adapters, including ideal
crystals, strained cells, extreme aspect ratios and near-degenerate tuples.

If any GPU workspace overflows, a convergence bound is reached, a predicate
cannot be certified, or the device is lost, discard the partial network and
restart the whole frame on CPU. This preserves a simple independent backend
contract and avoids introducing repeated GPU/CPU stage transfers. Report this
fallback accurately; a run with CPU geometry or CPU tracing is a hybrid run,
not a fully GPU extraction.

### Readback and rendering

Large intermediate meshes do not need host readback. Prefix-sum/compaction
passes can leave candidate counts and indirect dispatch arguments on the
device; where allocation or termination requires host information, copy only
small control records. Avoid reading every atom's full neighbor table just to
discover that another shell-search pass is needed. Per-atom labels are an
optional final output, separate from the compact dislocation network.

AlloyView currently renders atoms and dislocation cylinders with WebGL2.
WebGL2 cannot bind a WebGPU `GPUBuffer` as a vertex buffer. With this renderer,
a fully GPU extraction still needs one final network readback followed by a
WebGL upload. Color/visibility changes can use the cached final network and
do not require extraction again. Eliminating even this final transfer requires
a WebGPU rendering path on the same device, plus GPU periodic splitting and
slice/display-replication support. That is a separate renderer migration, not
a prerequisite for GPU-resident analysis.

### Order of work and evidence

First measure each existing CPU phase and restore safe per-atom parallelism
where the deployment permits shared-memory Wasm. The upstream local-structure
loop already has independent output slots and an atomic maximum-neighbor
distance; tessellation, cluster construction and tracing have global state.
Do not run several complete DXA copies and concatenate their results.

The local-correspondence contract is now implemented in the hybrid pipeline.
Further migration needs robust periodic geometry and its adjacency invariants
proved independently.
Only after these foundations pass should crystal-graph mapping, interface
construction and circuit tracing form one resident pipeline. A staged hybrid
prototype can validate kernels against CPU snapshots, but its measured
readback/upload costs must be included and its backend labeled honestly.

Validate the final GPU network against CPU Wasm and an independent OVITO
oracle using known perfect crystals, dislocations, partials, loops, junctions,
surfaces, triclinic PBC and the physically replicated NiGB example. Check
physical Burgers vectors, total source length, periodic winding and junction
conservation rather than requiring identical line IDs or vertex ordering.
Benchmark cold and warm whole-frame time, phase time, transfer bytes and peak
workspace on physical GPUs. Software adapters verify execution and output;
they cannot establish a GPU acceleration factor.

## AlloyView integration

### Whole-frame scheduler and memory

The existing [AnalysisPool](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/analysis-pool.js) partitions most
jobs by central-atom ranges and concatenates scalar results. DXA requires a
whole-frame coordinator because Delaunay cells, clusters, circuits and
junctions cross those ranges. Use one global headless Wasm kernel, sharing the
existing concurrency budget for local stages. Do not start six independent
full-frame DXA copies or assume overlapping subdomain results can be concatenated.

Extract the numerical C++ core and replace OVITO/Qt properties, tasks and mesh
wrappers with a small array/progress interface. The inspected source contains
roughly 7,300 lines of algorithm, cluster/network, tessellation-wrapper and
manifold support, including comments, plus about 40,700 lines in the standalone
Geogram pair. Existing Geogram CMake includes Emscripten branches; this supports
the porting approach but is not proof of a completed browser DXA build.

The official manual estimates approximately **1 kB of working memory per input
atom**. NiGB's 129,904 atoms therefore suggest roughly 130 MB of native working
memory; a million atoms suggests about 1 GB. These are upstream estimates, not
measured browser requirements. Include JS arrays, Wasm heap, periodic ghosts,
GPU graphs, staging and readback in a separate peak-memory reservation. Thin
periodic cells can greatly increase ghost-image storage. The DXA local nearest
table uses 456 device bytes per atom and is not copied to the host. Its local
result uses 80 bytes per atom, with another equally sized GPU staging buffer
for readback, plus source coordinates, settings and cached frame/index buffers.
This differs from PTM's 505-byte-per-atom nearest-18 host table. Check complete
workspace and individual storage-buffer limits before dispatch; batching
invocations alone does not reduce these full-frame table allocations.

Keep only the final network and requested atom fields in the frame cache.
Release tessellation, interface meshes and temporary graph arrays after
completion or cancellation. Reuse cache/pin primitives, but key intermediates
by coordinates, cell/PBC, selection, crystal family and perfect-only mode.
Changes to circuit parameters can reuse valid upstream geometry; changes to
display color or thickness should redraw without extraction.

On ordinary static hosting, a synchronous Wasm call cannot service Worker
cancel messages until it returns. Immediate cancellation therefore needs
Worker termination/recreation or explicitly resumable stages. Shared-memory
cancellation/pthreads can be an additional optimization on deployments with
COOP/COEP; default GitHub Pages operation must not depend on them.

### Network data and drawing

Use a network result separate from scalar atom properties, for example:

- Float64 source polyline vertices and Uint32 line offsets;
- per-line family, cluster and run-local IDs;
- Burgers vectors in ideal crystal coordinates and their world-space transforms;
- endpoint/junction connectivity, periodic image winding and source lengths;
- optional structure/cluster atom fields, statistics and actual backend metadata.

Retain the LH/SF line-sense convention. Reversing a curve also reverses its
Burgers vector. Line IDs are not automatically stable across trajectory frames.
Junction conservation tests must transform vectors into a compatible crystal
frame before summing them.

The current [atom primitive layer](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/atom-primitives.js) anchors
bonds and arrows to atom texture indices. DXA curves have independent vertices,
so add a separate line/cylinder layer that can reuse mesh and camera utilities.
Color and checkbox filters should apply to Burgers-vector families independently
of atom visibility. An FCC legend can include perfect `1/2<110>`, Shockley
`1/6<112>`, stair-rod `1/6<110>`, Hirth `1/3<100>`, Frank `1/3<111>` and Other.

Preserve unwrapped curves and junction/image information. Split drawing at
periodic boundaries using the full triclinic cell. Slice must clip intersecting
segments, rather than hiding the entire segment when an endpoint lies outside.
Display-only replicate draws cell offsets without increasing extraction cost;
physical replicate changes the analyzed cell and can help a cell too thin for
the upstream algorithm. Statistics use the analyzed source network before
display clipping/replication. Dislocation density is total source length divided
by the corresponding analyzed volume; selected-subvolume analysis needs an
explicit volume convention.

The new layer should participate in both viewports, picking and PNG/JPG export.
JSON configurations store processing parameters and visibility preferences;
CA/VTK or an explicitly versioned network export stores computed curves and
connectivity for reuse without another extraction.

## Implementation and validation sequence

1. Pin and audit the permissively licensed C++ dependencies. Build an independent
   native headless kernel before porting its platform boundary to Wasm.
2. Obtain CPU parity for perfect FCC/BCC, edge and screw dislocations, partials,
   loops, junctions, free surfaces, grain boundaries and triclinic/mixed PBC.
   Perfect strained crystals and isolated vacancies must not create false dislocation
   lines. Compare Burgers families, source length and connectivity; allow
   equivalent reversed line direction and reparameterized vertex sequences.
3. Integrate a CPU DXA tool, independent curve layer, family legend, cancellation,
   source/frame cleanup, settings replay and source-volume statistics.
4. GPU local structure/correspondence and tetrahedron classification now have
   independent CPU fallbacks. Continue migrating edge mapping, periodic
   geometry and fixed-network smoothing one stage at a time, measuring
   transfers and peak memory and validating the physical network.
5. Expand tested coverage to HCP and diamond families and any later algorithm
   improvements. Treat heterogeneous crystal interfaces and trajectory tracking
   as explicit additional work rather than extrapolating from local CSP Auto.

Use a pinned OVITO result as the scientific oracle, then keep CPU Wasm as the
GPU reference. The bundled NiGB is a useful large polycrystal stress test, but a
single grain-boundary configuration does not replace known dislocation fixtures.
Its very thin periodic Z direction needs explicit testing before treating its
result as a general DXA benchmark.

## Executed native CPU reference

The bundled `examples/NiGB_minimized.cfg` was processed with the official
**OVITO 3.10.6.post2** Python distribution (`ovito.version_string` is `3.10.6`),
Python 3.12.14, NumPy 1.26.4 and PySide6 6.6.3.1. The Linux x86_64 environment
reports AMD EPYC 9V74 and five visible logical CPUs; no thread count was forced.
This is a native CPU reference, separate from the inspected v3.9.4 source pin.
It does not measure browser Wasm or WebGPU performance.

| Input | Analyzed atoms | Result |
| --- | --- | --- |
| Original, fully periodic | 129,904 | Rejected: cell vector Z is only 4.97773 Å, too short for this DXA implementation |
| Physical replicate `1 × 1 × 2`, with expanded cell | 259,808 | Completes with Z = 9.95546 Å; 249,620 FCC atoms, 10,188 Other atoms, zero extracted segments |

The recorded repeated case takes **7.96 seconds**; other single-call trials
took 8.66 and 9.06 seconds, so these are observations rather than a stable
benchmark average.
The recorded process cumulative peak RSS is approximately **759 MiB**. This includes
Python/Qt, source/output storage, the preceding failed case and temporary native
allocations; it is not a measurement of DXA scratch alone or a browser memory
guarantee. Input parsing is recorded separately; the repeated-case timer
includes physical replication, DXA and result assembly. The final script exits
successfully. [The JSON record](benchmarks/ovito-dxa-nigb.json) includes exact
timings, package versions, source hash, cell, settings and memory definitions.

Zero segments is this algorithm's result on this configuration and settings.
It does not establish that all grain-boundary defects are absent. This validates
thin-cell behavior and an empty-network stress case, not positive line tracing,
Burgers-vector classification or junction connectivity. Independently specified
nonzero dislocation fixtures are still required before accepting a port.

The older v3.9.4 Python package produced matching atom counts and empty-network
results, but segfaulted during interpreter shutdown in this environment, even
in an import-only check. That run is not counted as a clean process validation;
the newer package provides a separately versioned, clean reference instead.

The optional [oracle script](https://github.com/Yazhuo-Liu/AlloyView/blob/main/scripts/research/ovito-dxa-oracle.py)
is research tooling, not a browser dependency. Reproduce on Linux with Python
3.12 and the native Qt runtime prerequisites:

```sh
python3.12 -m venv /tmp/ovito-dxa-venv
/tmp/ovito-dxa-venv/bin/pip install 'ovito==3.10.6.post2' 'PySide6==6.6.3.1' 'numpy==1.26.4'
QT_QPA_PLATFORM=minimal /tmp/ovito-dxa-venv/bin/python scripts/research/ovito-dxa-oracle.py --output /tmp/ovito-dxa.json
```

The script deliberately retains each case's success/error status and records
actual installed versions. A package crash must not be suppressed or mistaken
for a successful calculation.

## Source evidence

- [Official algorithm documentation](https://www.ovito.org/docs/current/reference/pipelines/modifiers/dislocation_analysis.html).
  The tracked [current manual source](https://gitlab.com/stuko/ovito/-/blob/81d76297a22ba00793b16487e821884e3c77028a/doc/manual/reference/pipelines/modifiers/dislocation_analysis.rst)
  was inspected directly when the documentation website was unavailable.
- [Pinned full engine and its per-file MIT option](https://gitlab.com/stuko/ovito/-/blob/939f5d909ea3b0fd0dd6695494da8f8d03821c2e/src/ovito/crystalanalysis/modifier/dxa/DislocationAnalysisEngine.cpp).
- [Structure correspondence](https://gitlab.com/stuko/ovito/-/blob/939f5d909ea3b0fd0dd6695494da8f8d03821c2e/src/ovito/crystalanalysis/modifier/dxa/StructureAnalysis.cpp),
  [elastic edge mapping](https://gitlab.com/stuko/ovito/-/blob/939f5d909ea3b0fd0dd6695494da8f8d03821c2e/src/ovito/crystalanalysis/modifier/dxa/ElasticMapping.cpp),
  [Burgers circuit tracer](https://gitlab.com/stuko/ovito/-/blob/939f5d909ea3b0fd0dd6695494da8f8d03821c2e/src/ovito/crystalanalysis/modifier/dxa/DislocationTracer.cpp).
- [Geogram BSD license](https://gitlab.com/stuko/ovito/-/blob/939f5d909ea3b0fd0dd6695494da8f8d03821c2e/src/3rdparty/geogram/LICENSE.txt)
  and [Emscripten build branches](https://gitlab.com/stuko/ovito/-/blob/939f5d909ea3b0fd0dd6695494da8f8d03821c2e/src/3rdparty/geogram/CMakeLists.txt).
- [Network rendering and periodic clipping](https://gitlab.com/stuko/ovito/-/blob/81d76297a22ba00793b16487e821884e3c77028a/src/ovito/crystalanalysis/objects/DislocationVis.cpp).

The initial research change vendored no upstream algorithm. The subsequent CPU
port includes pinned, adapted DXA and Geogram sources with their license notices
under `third_party/dxa/` and a prebuilt Wasm module. Current executed checks are
recorded in [Validation](VALIDATION.md). Earlier revisions accelerated local
crystal correspondence and tetrahedron classification through a staged
Wasm/WebGPU interface; production extraction is now CPU/Wasm only, as stated
at the top. Fully GPU-resident periodic geometry, mesh construction and tracing
remain unimplemented research. The current kernel build (link-time
optimization, SIMD, native exceptions, binary atom labels), thread-count rule,
first-extraction warm-up, nonisolated stage transfer and parallel edge passes
are measured in the [CPU profile](DXA_CPU_PROFILE.md).
