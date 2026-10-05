# Dislocation extraction: implementation review

Research date: 2026-10-05 UTC. **DXA is not yet implemented in AlloyView.**
This review inspects OVITO's actual source and the existing AlloyView pipeline;
it separates reusable code, proposed implementation and executed experiments.

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

## CPU and GPU allocation

| Stage | Initial implementation | GPU migration opportunity |
| --- | --- | --- |
| Periodic neighbor search and local structure correspondence | CPU Wasm baseline | Strong candidate: independent central atoms; extend existing GPU CNA/nearest-shell kernels |
| Crystal clusters and inter-cluster transformations | CPU Wasm | Later graph algorithms with explicit synchronization and symmetry handling |
| Robust periodic Delaunay tetrahedra | CPU Wasm / Geogram | Substantial separate project; dynamic topology and robust geometric predicates |
| Ideal vectors for unique tessellation edges | CPU Wasm baseline | Bounded per-edge path search once cluster transforms and adjacency are fixed |
| Tetrahedron Burgers/Frank consistency and candidate faces | CPU baseline | Fixed-size independent tests, counting and compact output |
| Manifold mesh construction and repair | CPU Wasm | GPU face filtering can assist; preserve CPU topology construction initially |
| Adaptive Burgers circuits, curve tracing and junction merging | CPU Wasm | Shared ownership and irregular searches require a dedicated parallel design |
| Smoothing a fixed curve/mesh graph | CPU baseline | Independent vertices with ping-pong updates; junction constraints must remain fixed |
| Curve coarsening | CPU baseline | Possible later compaction with endpoint and topology invariants |

AlloyView's current GPU CNA returns structure labels. DXA additionally needs
ordered ideal bond vectors, local permutations, crystal frames and transitions
between clusters. Likewise, the current PTM API exports structures, RMSD,
scale, deformation and distance, but not the full DXA correspondence contract.
Reuse verified neighbor infrastructure and device resources; labels or strain
tensors alone cannot supply the required elastic mapping.

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
periodic cells can greatly increase ghost-image storage. The current full
GPU-produced nearest-18 host table alone uses another 505 bytes per atom, about
65.6 MB for NiGB. GPU scratch for this stage is separately batch-bounded; avoid
redundant complete-table readback and upload round trips.

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
4. Add GPU local structure/correspondence with exact CPU fallback and parity.
   Then migrate edge mapping, tetrahedron classification and fixed-network
   smoothing one stage at a time, measuring transfers and peak memory.
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

No upstream DXA source, binary or documentation is vendored by this research
change. No browser CPU DXA or WebGPU DXA benchmark has been completed yet.
