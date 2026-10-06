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

The result panel reports volume and coordination summaries, boundary-atom
counts, distributions of atomic volume and neighbor-face area, and index
frequencies. The relative volume error is
`(sum of atomic volumes − simulation-cell volume) / simulation-cell volume`.
For a complete, nondegenerate tessellation it should be close to floating-point
roundoff.

Export the per-atom table, distribution table, or complete face table as CSV.
The face table retains face area, edge count, neighboring atom, boundary flag,
and whether the chosen thresholds retained that face. Shared interior faces
appear once for each adjacent cell, so face-area distributions count directed
faces. Boundary faces are excluded from neighbor-face distributions. Filtering
atom visibility does not change these tables.

## Implementation

The cell kernel is the established **Voro++** C++ implementation, compiled to
WebAssembly. It runs in the existing parallel CPU Worker pool. Workers retain
their Wasm module, cell object and growing input/output buffers for subsequent
analyses. There is no OVITO runtime dependency. With GPU acceleration enabled,
Voronoi currently falls back to this CPU path; it does not claim a GPU topology
kernel.

AlloyView uses its fractional linked-cell search to enumerate periodic images
and Voro++ to clip the cell against their perpendicular bisectors. The search
expands until it covers twice the distance to the farthest remaining cell
vertex. Any farther atom has a bisector outside the current polyhedron, so
this termination condition preserves complete geometry without a user-chosen
neighbor cutoff. Nonperiodic faces use the reciprocal cell vectors, preserving
the correct tilted boundary planes.

For a fully periodic orthogonal cell containing one atom, the six axis-image
bisectors already define the exact rectangular Wigner–Seitz cell. This case
does not enumerate additional images, including in very thin cells. Other
geometries retain the complete adaptive search. Extremely skewed or thin
multisite cells can exceed the existing neighbor-image safety budget and are
rejected rather than producing a truncated tessellation.

This initial implementation is an **unweighted** tessellation. It does not
assign element-dependent radii or construct a radical/power diagram, and it
does not render polygonal cells in the viewport. Voronoi polycrystal
construction is a separate future structure-editing feature.

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
