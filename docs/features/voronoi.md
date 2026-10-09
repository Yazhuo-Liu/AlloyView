# Voronoi analysis

Open **Visualization tools → Voronoi** and run the analysis. By default, each
atom owns the region closer to it than to any other atomic site or periodic
image. The analysis constructs the actual convex polyhedron, including its polygonal
faces; it does not estimate a volume from a nearest-neighbor sphere. The
optional [radical tessellation](#radical-radius-weighted-cells) weights each
site by an atomic radius instead.

## Choose input atom types

The **Element types** checkboxes select which atomic sites define the
tessellation. All types are included initially. For example, selecting Fe in
an Fe–Ni structure constructs cells using only Fe sites and their periodic
images. Ni sites contribute neither cells nor bisector planes, so the Fe cells
divide the complete simulation-cell domain among themselves. Volumes,
neighbors and face-order indices can therefore change when a type is excluded.

This selection controls the Voronoi input sites independently of display
visibility. Hidden atoms of an included type still participate. Displaying an
excluded type does not add it to the tessellation. The loaded physical frame
and other analyses retain their original atom population.

Analysis properties remain aligned with the original frame: excluded sites
have `NaN` numerical Voronoi values and no face rows. Summary cards, histogram
populations and Voronoi CSV tables cover only the included sites. Changing the
input types recalculates an enabled analysis.

## Radical (radius-weighted) cells

Expand **Cell weighting** and check **Radical (radius-weighted) Voronoi** to
construct the radical (power or Laguerre) tessellation. Space is divided by the
power distance `|x − pᵢ|² − rᵢ²` instead of the distance `|x − pᵢ|`, so the
face between atoms *i* and *j* lies on the plane where
`|x − pᵢ|² − rᵢ² = |x − pⱼ|² − rⱼ²`. Measured from atom *i* along the
separation `d` to *j*, that plane is at `(|d|² + rᵢ² − rⱼ²) / (2|d|)`: the
ordinary bisector shifted by `(rᵢ² − rⱼ²) / (2|d|)` away from the larger atom.
The faces remain planar and the cells convex, and the cells still fill the
domain exactly, so the volume check applies unchanged. Equal radii, of any
value, give the standard Voronoi tessellation; AlloyView then reproduces the
standard result bit for bit. Radical cells suit mixtures of differently sized
atoms, such as metallic glasses, interstitial solutes or ionic crystals, where
the bisector would assign the smaller atom too much space.

Choose the **Radius source**:

- **Radius per element type** lists every type label of the current structure.
  Each radius starts from the display's default atomic radius for that element
  (metallic radii for metals, covalent radii for light interstitials, 1.25 Å
  for unrecognized labels) and can be edited. Per-atom and per-element radius
  overrides from **Display** do not change these radii. **Reset to atomic
  radii** restores the defaults.
- **Per-atom property** uses a numeric per-atom column of the source file, an
  imported external attribute or a [computed property](expressions.md), in Å.
  Outputs of other analyses are not offered. A column named `radius` is chosen
  first when available.

Radii must be finite and at least 0 Å. An invalid table entry is rejected
before any calculation; an invalid property value reports the first atom ID.
Only atoms of the selected [input types](#choose-input-atom-types) need valid
radii, and excluded types contribute no radical planes.

A radical cell need not contain its own atom, and a small atom crowded by much
larger neighbors can lose its whole cell. Such an **empty cell** is reported
with zero volume and surface area, no faces, coordination 0 and the index
`<0,0,0,0>`; its neighbors have no face toward it. The summary line, an
**Empty radical cells** card and the statistics CSV (`emptyCellCount`) report
how many cells are empty, together with the radius range. Empty cells are part
of the analyzed population: they enter means and histograms with their zero
values. They have no polygons in the cell display. Voro++ can also retain a
degenerate cell of zero volume at an exact tie; AlloyView reports it as empty
as well.

Results and caches are keyed on the radii themselves, so radical and standard
results, or results for different radii, never replace each other. Editing a
radius, changing the source or switching the option recalculates an enabled
analysis. Radical cells change volumes, neighbors and indices by design; use
the standard tessellation for comparisons with tools that report unweighted
Voronoi cells.

## Per-atom quantities

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

Expand **Distributions** to see the six most common indices as population
bars, together with the histograms. **All face-order indices** opens the
complete table, with 50 rows per page; its contents are
built only when opened. An index describes topology and is not a unique
crystal identification.

**Distributions** is initially collapsed. Each histogram can switch between
**Count** and **Probability**. Hover or tap the plot, use the bin slider, or
focus the plot and press left/right, Home, or End to inspect a bin's range,
sample count and percentage. **View binned values** opens the corresponding
numerical table. Constant-valued populations retain their actual coordinate,
and neighbor-count distributions report integer coordination values.

Expand **Cell display** and enable **Show the selected atom's cell** to inspect
an atom picked in the viewport or by ID in Details. **Show all analyzed
cells** optionally draws the cells of every included input site. Both options
start off. Color and opacity are adjustable. All-cell display builds additional
polygonal geometry and uses more memory; the single-cell preview constructs
only the inspected cell.

The default cell color is blue (`#3b82f6`), with opacity 0.5. Outline color
follows the viewport background: dark edges on light backgrounds and pale
edges with a dark rim on dark backgrounds.

**All-cell view** chooses how the complete tessellation is drawn.
**See-through** (the default) draws every cell translucently and fades deeper
faces and edges, so the nearest cells remain legible. **Nearest surface** first
resolves the nearest cell faces into the depth buffer, so faces and edges
hidden behind nearer cells are not drawn; use a slice to look inside. In both views, edges only a few pixels long, from
distant cells or microscopic faces, fade out until you zoom in. **Cell scale**
(40–100%) shrinks each displayed cell toward its atom, separating neighboring
cells; it changes display only, not volumes or any other result. These options
add uniforms and one depth-only pass, but no geometry or memory. While all-cell
display is enabled, clicking an included atom highlights its associated cell,
even when **Show the selected atom's cell** is unchecked. Measurement picks
and slice-construction picks also highlight their associated cells. Highlighted
cells use amber faces with stronger opacity and pale yellow edges in both
single-cell and all-cell modes. Highlighting updates already constructed meshes
without recalculating statistics; a new single-cell preview builds only that
atom's geometry when it is not cached.

**Atom radius** in this section controls the same percentage as **Display →
Atom radius**. Its slider and numeric input synchronize in both directions and
affect atoms in both views. For example, reducing the value to 50% can reveal
faces otherwise covered by atom spheres. Radius edits leave the tessellation
and its statistics unchanged.

The relative volume error is
`(sum of atomic volumes − simulation-cell volume) / simulation-cell volume`.
For a complete, nondegenerate tessellation it should be close to floating-point
roundoff, for standard and radical cells alike. The overview states whether the relative difference is within 0.01%
and also displays the actual signed error. This is a domain-conservation check,
rather than an estimate of uncertainty in each individual cell.

Export the per-atom table, distribution table, or complete face table as CSV.
The face table retains face area, edge count, neighboring atom, boundary flag,
and whether the chosen thresholds retained that face. Shared interior faces
appear once for each adjacent cell, so face-area distributions count directed
faces. Boundary faces are excluded from neighbor-face distributions. Filtering
atom visibility does not change these tables. Type-selected exports contain
only included cells and their faces, using the original source atom IDs for
both central atoms and neighbors. The summary records the chosen type labels,
and the original frame atom count remains separately available in the complete
statistical summary.

Configuration export retains type labels in
`settings.extensions.voronoi.selectedTypes`: `null` means all types, and a
string list selects those labels. Older recipes without this field include all
types. Radical settings are stored beside them: `radical` (`true` or `false`),
`radiusSource` (`types` or `property`), `typeRadii` (a list of `{ label,
radius }` entries in Å, finite and nonnegative; omitted labels use the atomic
radii) and `radiusProperty` (a property name or `null`). Recipes without these
fields restore the standard tessellation, and recipes that never used radical
cells are exported without them. Radii are validated when a recipe is loaded;
property values are read again from the matching source. Selected-cell visibility, all-cell visibility, color, opacity, all-cell view
(`style`: `xray` or `surface`) and cell `scale` are stored in
`settings.extensions.voronoiDisplay`; polygon arrays are regenerated
when the corresponding display option is enabled. Atom radius remains one
global value at `settings.display.radiusPercent`, shared with the Display tool.

## Implementation

### Load-time preparation

Loading a structure starts preparing its current frame before Voronoi is
calculated. The CPU pool initializes reusable Voro++ modules and prepares a
coordinate snapshot, neighbor index and native context in an adaptive number
of Workers. Cross-origin isolation allows a shared snapshot; otherwise each
Worker retains a private copy. Enabled GPU acceleration prepares the device,
Voronoi pipelines, uploaded coordinates, initial neighbor index and bounded
clipping workspace. A single discarded GPU-cell dispatch warms driver
execution without publishing scientific results.

Preparation does not activate this tool, color the atoms, calculate whole-frame
statistics or build the optional display meshes. Foreground calculations have
priority, and compatible repeated calculations reuse these resources. Loading
prepares all atom types; analyzing a type subset prepares its corresponding
inputs as needed. Frame and structure changes replace obsolete preparation.
Physical replication increases the preparation target, while display-only
replication does not. See [Performance](performance.md#preparation-when-a-structure-loads)
for scheduling and memory limits.
The [HEA benchmark](performance.md#compare-cpu-and-gpu-time) reports preparation
and first-calculation latency separately and verifies unchanged scientific
outputs against a saved reference report.

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

Radical cells use the same kernel and search. Each plane passes Voro++ the
value `|d|² + rᵢ² − rⱼ²` in place of `|d|²`, exactly as Voro++'s polydisperse
`container_poly` does; equal radii pass the unchanged value. A site *j* can
cut the cell of *i* only if some vertex *v* satisfies
`v·d > (|d|² + rᵢ² − rⱼ²)/2`. With `|v| ≤ R`, the farthest-vertex distance,
and `rⱼ ≤ r_max`, that requires `|d| < R + √(R² + r_max² − rᵢ²)`, so the
search covers this radius instead of `2R` (the two agree for equal radii).
When every vertex lies beyond a plane, Voro++ deletes the cell and the atom is
reported as empty. The radii stay resident in each Worker with the coordinate
snapshot: repeated analyses and chunk messages with unchanged radii do not
copy them again.

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

Most geometry uses 32-bit floating-point arithmetic. Near-plane signs and
duplicate-vertex checks use higher-precision filtered predicates assembled
from paired 32-bit values, together with the three source planes defining each
vertex. This allows exactly coplanar FCC and HCP configurations to remain on the GPU while
detecting ambiguous tiny faces and face-area threshold decisions. Independently
different intersections inside the 32-bit uncertainty band require exact-cell
recovery instead of being merged into one vertex.

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

Relaxed configurations with many microscopic faces, extreme thin directions,
or large vacuum regions can exceed the bounded precision-recovery or neighbor
coverage budget. Such structures can use the parallel CPU path even with GPU
acceleration enabled. The bundled relaxed Ni grain-boundary example exercises
this conservative fallback; it is not evidence of GPU acceleration for that
structure.

Radical cells use a separate clipping kernel; the standard kernel is
unchanged. The cell initialization is shared, because an atom's periodic
self-images and the domain walls do not depend on radii. One buffer holds the
settings header followed by `r²/scale²` for every site as a pair of 32-bit
values, so each radical plane offset `(|d|² + rᵢ² − rⱼ²)/2` is assembled in the
same paired-precision arithmetic as the bisector. The relevance test uses the
radical plane distance, and a cell is complete once the GPU neighbor radius
covers `R + √(R² + r_max² − rᵢ²)`; incomplete cells grow the search radius as
in the standard kernel. A cell that becomes empty or degenerate is recovered by
the exact Voro++ CPU cell, which reports it as empty; these recoveries count
toward the same budget. If `√(r_max² − r_min²)` exceeds four mean atomic
spacings, every cell's search sphere would hold hundreds of sites, so the
analysis uses the CPU Workers directly; the Backend status reports the radius
spread. The GPU traversal limits on periodic images and precision also apply to
the larger radical search radius; exceeding them recovers the affected cells
exactly or falls back to the CPU Workers, as for standard cells.

The GPU suite compares radical cells with Voro++ using the standard tolerances:
relative volume and surface area within 5 × 10⁻⁵, face areas within
8 × 10⁻⁵, and exactly equal neighbor IDs, face orders, indices and empty cells.
Its cases include CsCl and rock-salt crystals, triclinic and mixed-boundary
cells with random radii, type subsets, empty cells, the radius-spread fallback,
and samples of the Fe loop, HEA and Ni grain-boundary examples.

The Auto color range treats volume and surface-area variations at GPU rounding
precision as uniform, so tiny numerical differences in an ideal crystal do not
become apparent defects. The actual range extrema, scientific arrays, CSV
values and manually chosen color ranges retain the calculated values.

### Cell display

The optional selected-cell mesh is constructed by one Voro++ Worker, regardless
of the backend used for whole-structure statistics. This constructs the
polygonal vertices only for the selected atom and reuses a small mesh cache.
It is a display inspection step, and does not rerun or modify the analyzed
structure's statistics. The preview is off by default. Its local vertices are
anchored at the atom's displayed position, so periodic-origin changes and
display replicas follow the same coordinates as the atom. Slices clip the
preview, and hiding the atom hides its cell. An enabled preview appears in PNG
exports with the chosen cell color and opacity.

All-cell display uses the resident parallel CPU pool to build meshes only for
the analyzed input sites. Color and opacity are shared with the selected-cell
preview. Completed meshes remain cached after the display is turned off, until
the source or analyzed result changes. Its display
geometry follows the same periodic-origin, replication, slice and atom
visibility rules. The scientific statistics remain cached while mesh
construction runs separately; changing cell appearance does not recalculate
the tessellation.

The all-cell mesh stores every shared face and edge once. A face between two
analyzed cells belongs to the lower-index cell, and an edge to the
lowest-index cell around it; faces on a nonperiodic wall or toward a cell's own
periodic image stay unique. A stored face records its neighbor, whose image
offset is twice the face's bisector distance along its normal; a radical face
is not midway between its atoms, so radical cell geometry carries the actual
image vector of each neighbor instead. A stored edge records its other cells and
their offsets. When cells are displayed side by
side at full **Cell scale**, the single copy serves all of them, including when
its owner atom is hidden. Whenever display positions change, AlloyView lists
the faces and edges whose cells are displayed in different periodic images and
draws only those again at the other cell, from one small shared buffer. A
reduced Cell scale shrinks every cell toward its own atom, so each shared face
and edge is then drawn once per cell, in the same number of draw calls. Compared
with storing each cell separately, this halves stored triangles, keeps a third
of the edges and halves the GPU buffer memory, without changing the image. A
selected cell is highlighted from its own faces plus those its neighbors store
for it.

The analysis uses the standard (unweighted) tessellation unless **Radical
(radius-weighted) Voronoi** is checked. Cell displays of a radical result use
the analyzed radii; empty cells have no polygons, and **Cell scale** shrinks a
radical cell toward its atom even when the atom lies outside the cell. Viewport
geometry is constructed only when a cell display option is enabled. Voronoi
polycrystal construction is a separate future structure-editing feature.

## Sources

- [Voro++ upstream repository and BSD license](https://github.com/chr1shr/voro)
  supplies the independent convex-cell algorithm. AlloyView vendors its cell
  core at commit `b0dac575a47af0f90b5b100e6dc199a493c7cb83` and pins source
  hashes in `third_party/voro/SHA256SUMS`.
- [Voro++ overview and cell-based statistics](https://github.com/chr1shr/voro/blob/b0dac575a47af0f90b5b100e6dc199a493c7cb83/README)
  explains the per-particle cell approach and its use for volume and face data.
- [OVITO Voronoi analysis reference](https://docs.ovito.org/reference/pipelines/modifiers/voronoi_analysis.html)
  describes the established atomic-analysis workflow, including its
  radius-weighted (polydisperse) option.
- [Voro++ `container_poly`](https://github.com/chr1shr/voro/blob/b0dac575a47af0f90b5b100e6dc199a493c7cb83/src/container.hh)
  computes radical cells with the same `|d|² + rᵢ² − rⱼ²` plane offset.
- B. J. Gellatly and J. L. Finney, "Characterisation of models of
  multicomponent amorphous metals: the radical alternative to the Voronoi
  polyhedron", *J. Non-Cryst. Solids* **50**, 313–329 (1982), introduced
  radical cells for atomic structures.
- [LAMMPS compute voronoi/atom](https://docs.lammps.org/compute_voronoi_atom.html)
  documents atomic volumes, neighbor faces, face-order histograms, area
  thresholds and face-table output.
