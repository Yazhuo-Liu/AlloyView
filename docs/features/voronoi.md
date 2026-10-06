# Voronoi analysis

Open **Visualization tools → Voronoi** and run the analysis. Each atom owns the
region closer to it than to any other atomic site or periodic image. The
analysis constructs the actual convex polyhedron, including its polygonal
faces; it does not estimate a volume from a nearest-neighbor sphere.

The resulting quantities can be selected in **Color by**:

- **Atomic volume**, in Å³, measures the space assigned to an atom.
- **Voronoi surface area**, in Å², is the sum of all cell-face areas.
- **Voronoi coordination** counts the retained faces shared with atomic
  neighbors. This is a geometric coordination number and differs from a
  distance-cutoff coordination number.
- **Boundary faces** counts faces introduced by nonperiodic simulation-cell
  boundaries. A nonzero value identifies a cell affected by the finite domain.
- **Maximum face order** is the largest number of edges on a retained neighbor
  face.

The results also include a **Voronoi index** `<n3,n4,n5,n6,…>`, where `nk` counts
retained neighbor faces with `k` edges. Ideal simple cubic, FCC and BCC cells
have indices `<0,6,0,0>`, `<0,12,0,0>` and `<0,6,0,8>`, respectively. An index
describes local topology; it is not a unique crystal-structure label. For
example, FCC and ideal HCP can share an index. Use [CNA](cna.md) or
[PTM](ptm.md) for crystal identification.

**Minimum face area** and **Minimum relative face area** suppress very small
neighbor faces in coordination and index statistics. The relative value is
the face area divided by the full cell surface area. A face must exceed both
thresholds to count. These filters leave the physical volume, surface area and
complete face table intact.

## Periodic and open boundaries

Orthogonal and triclinic cells support any combination of periodic axes.
Periodic neighbors include separate images of the same atom, including the
central atom itself. This preserves the correct tessellation in thin or
single-atom periodic cells.

Along nonperiodic axes, cells are clipped to the **finite simulation cell**.
Their volumes sum to that domain's volume, and boundary faces are reported
separately. Boundary faces contribute to surface area but do not count as
atomic-neighbor faces in coordination or indices. Atoms outside a nonperiodic
simulation-cell boundary must be corrected before this analysis. Large vacuum
regions can produce large boundary-cell volumes; those volumes describe the
chosen domain, rather than a material density corrected for a free surface.

**Display-only replicate** and **Periodic display origin** do not change the
tessellation. Enabling physical replication changes the analyzed structure
and domain, as it does for other analyses.

## Statistics and CSV

The result panel opens with compact cards for mean and range of atomic volume,
mean and range of neighbor count, mean surface area, the most common topology,
boundary-atom population, and the complete-domain volume check. Color shortcuts
select volume, neighbors, surface area, maximum face order, or boundary faces
directly in the viewport's **Color by** legend.

The six most common indices appear as population bars. **All face-order
indices** opens the complete table, with 50 rows per page; its contents are
built only when opened. An index describes topology and is not a unique
crystal identification.

**Distributions** is initially collapsed. Each histogram can switch between
**Count** and **Probability**. Hover or tap the plot, use the bin slider, or
focus the plot and press left/right, Home, or End to inspect a bin's range,
sample count and percentage. **View binned values** opens the corresponding
numerical table. Constant-valued populations retain their actual coordinate,
and neighbor-count distributions report integer coordination values.

**Inspect a selected cell** controls the optional cell display. Enable it and
select an atom in the viewport, or by ID in Atom details, to examine that cell's
faces. Color and opacity are adjustable. This preview draws one selected cell,
so inspecting a large structure does not build geometry for every atom.

The relative volume error is
`(sum of atomic volumes − simulation-cell volume) / simulation-cell volume`.
For a complete, nondegenerate tessellation it should be close to floating-point
roundoff. The overview states whether the relative difference is within 0.01%
and also displays the actual signed error. This is a domain-conservation check,
rather than an estimate of uncertainty in each individual cell.

Export the per-atom table, distribution table, or complete face table as CSV.
The face table retains face area, edge count, neighboring atom, boundary flag,
and whether the chosen thresholds retained that face. Shared interior faces
appear once for each adjacent cell, so face-area distributions count directed
faces. Boundary faces are excluded from neighbor-face distributions. Filtering
atom visibility does not change these tables.

## Implementation

### CPU Workers

The cell kernel is the established **Voro++** C++ implementation, compiled to
WebAssembly. The CPU path uses the existing shared Worker pool and CPU budget,
distributing bounded chunks of central atoms rather than assigning a single
large fixed range to each Worker. This lets available Workers share difficult
regions of an inhomogeneous structure. Workers retain their coordinate
snapshot, linked-cell index, Wasm module, cell object and growing input/output
buffers for subsequent chunks and analyses. Changes to the structure invalidate
the cached coordinates and index. Final face-table merging and statistics run
in a Worker, keeping that work off the UI thread. Partial results are consumed
field by field during merging to reduce temporary memory. Cancellation
preserves the resident Worker and Wasm instances. There is no OVITO runtime
dependency.

AlloyView uses its fractional linked-cell search to enumerate periodic images
and Voro++ to clip the cell against their perpendicular bisectors. The search
expands until it covers twice the distance to the farthest remaining cell
vertex. Any farther atom has a bisector outside the current polyhedron, so
this termination condition preserves complete geometry without a user-chosen
neighbor cutoff. Nonperiodic faces use the reciprocal cell vectors, preserving
the correct tilted boundary planes.

The native kernel conservatively discards candidate planes that cannot cut the
current cell before sorting the remaining planes. This avoids repeated large
sorts next to vacuum regions while retaining the same complete-neighbor
termination condition.

For a fully periodic orthogonal cell containing one atom, the six axis-image
bisectors already define the exact rectangular Wigner–Seitz cell. This case
does not enumerate additional images, including in very thin cells. Other
geometries retain the complete adaptive search. Extremely skewed or thin
multisite cells can exceed the existing neighbor-image safety budget and are
rejected rather than producing a truncated tessellation.

### WebGPU acceleration

With **Enable GPU acceleration** enabled, Voronoi can construct the cells on
WebGPU. Each GPU invocation incrementally clips one convex polyhedron against
atomic bisector planes. Neighbor lookup uses the existing resident GPU
linked-cell index, and the search expands until it covers twice the farthest
remaining cell vertex. The expensive neighbor search and polygon clipping run
on the GPU; complete face descriptors and per-atom quantities return to the
analysis Worker for statistical aggregation and CSV output.

This path supports orthogonal and triclinic cells, periodic images including
self-images, and finite boundaries along nonperiodic axes. The shared GPU
device, compiled pipelines, neighbor buffers and bounded geometry workspace
are reused. Geometry scratch memory depends on the batch size, rather than
allocating a full mesh for every atom in the structure. Hardware adapters can
process up to 2,048 cells per batch, and software adapters up to 512; device
buffer limits and the shared memory budget can reduce these capacities.

Most geometry uses 32-bit floating-point arithmetic. Near contacts and short
edges use higher-precision filtered predicates assembled from paired 32-bit
values, together with the three source planes defining each vertex. This
allows exactly coplanar FCC and HCP configurations to remain on the GPU while
detecting ambiguous tiny faces and face-area threshold decisions.

An isolated ambiguous cell is recalculated by Voro++ inside the existing GPU
Worker. That recovery reuses one Wasm kernel and a complete-source CPU neighbor
context; it does not create a new Worker or rerun the whole frame. Its complete
scientific face data and quantities replace only the affected cell's output.
The Backend label reports the number of cells receiving exact recovery. The
recovery budget is `min(2048, max(16, floor(0.1 × analyzed atom count)))`.

Capacity and coverage guards also protect the topology: the GPU stores at most
64 faces per cell, 32 vertices per face and 512 relevant source planes per
cell. These are resource bounds, not coordination cutoffs. If these bounds,
the sparse recovery budget, or the verified precision and neighbor coverage
cannot be satisfied, the whole analysis automatically uses the parallel
Voro++ CPU path. The Backend status identifies that fallback. Cells are never
silently truncated to fit the GPU buffers. Disabling GPU acceleration always
selects the CPU implementation.

The Auto color range treats volume and surface-area variations at GPU rounding
precision as uniform, so tiny numerical differences in an ideal crystal do not
become apparent defects. The actual range extrema, scientific arrays, CSV
values and manually chosen color ranges retain the calculated values.

### Selected-cell display

The optional selected-cell mesh is constructed by one Voro++ Worker, regardless
of the backend used for whole-structure statistics. This constructs the
polygonal vertices only for the selected atom and reuses a small mesh cache.
It is a display inspection step, and does not rerun or modify the analyzed
structure's statistics. The preview is off by default. Its local vertices are
anchored at the atom's displayed position, so periodic-origin changes and
display replicas follow the same coordinates as the atom. Slices clip the
preview, and hiding the atom hides its cell. An enabled preview appears in PNG
exports with the chosen cell color and opacity.

This analysis uses an **unweighted** tessellation. It does not
assign element-dependent radii or construct a radical/power diagram, and it
constructs viewport geometry only for the selected cell when requested.
Voronoi polycrystal construction is a separate future structure-editing feature.

## Sources

- [Voro++ upstream repository and BSD license](https://github.com/chr1shr/voro)
  supplies the independent convex-cell algorithm. AlloyView vendors its cell
  core at commit `b0dac575a47af0f90b5b100e6dc199a493c7cb83` and pins source
  hashes in `third_party/voro/SHA256SUMS`.
- [Voro++ overview and cell-based statistics](https://github.com/chr1shr/voro/blob/b0dac575a47af0f90b5b100e6dc199a493c7cb83/README)
  explains the per-particle cell approach and its use for volume and face data.
- [OVITO Voronoi analysis reference](https://docs.ovito.org/reference/pipelines/modifiers/voronoi_analysis.html)
  describes the established atomic-analysis workflow.
- [LAMMPS compute voronoi/atom](https://docs.lammps.org/compute_voronoi_atom.html)
  documents atomic volumes, neighbor faces, face-order histograms, area
  thresholds and face-table output.
