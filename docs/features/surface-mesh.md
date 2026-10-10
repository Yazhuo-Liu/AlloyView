# Surface mesh

## Controls

Open **Visualization tools → Surface**, set the **Probe sphere radius** and
press **Construct surface**. The tool builds the closed surface that separates
solid from empty space, draws it as a triangle mesh and reports its area, the
solid and empty volumes and every enclosed void. It finds free surfaces of
slabs and nanoparticles, internal voids, pores and crack faces.

- **Probe sphere radius** (Å) decides what counts as solid: space that a
  sphere of this radius cannot enter without touching an atom center is solid.
  A smaller radius resolves smaller openings; one that is too small falls
  between the atoms of the perfect crystal. **Use suggestion** fills in
  1.15 × the first-shell cutoff estimate of the frame's elements, about 1.3
  nearest-neighbor distances. A perfect FCC crystal is solid above 0.71 and
  BCC above 0.65 neighbor distances; at 1.3 a single vacancy stays filled and
  larger voids open. The suggestion is used until you edit the field.
- **Smoothing level** is the number of smoothing iterations applied to the
  mesh (default 8, as in OVITO; 0 keeps the vertices on the atom centers).
- **Atoms** restricts the input: **All atoms**, **Visible atoms** (atoms that
  the element, legend, crystal and selection filters leave visible; slices do
  not count), or a named selection group. Other atoms are ignored, as if they
  were not there.
- **Show surface**, the **Surface**, **Interior** and **Caps** colors,
  **Opacity** and **Cap the solid at periodic cell faces** change the display
  only and never recalculate.

The analysis repeats for every displayed frame while the tool is enabled, and
after a change of the radius, smoothing or atom restriction. With **Visible
atoms** it also repeats 0.6 s after the display filters last changed.
**Cancel** stops it and clears the mesh and its statistics while keeping the
settings. Results are cached per frame, so returning to a frame redraws its
surface without a new calculation.

## Method

The construction follows the alpha-shape method of OVITO 3.9.4's *Construct
surface mesh* modifier with *Identify volumetric regions* switched on.

1. **Delaunay tessellation.** The chosen atoms, wrapped into the cell, are
   tessellated together with their periodic images in a layer of 3.5 probe
   radii around the cell. Coordinates receive the same fixed random
   perturbation of 10⁻¹⁰ cell diagonals as in OVITO, which makes ideal
   lattices non-degenerate. Eight helper points far outside the cell make the
   finite tetrahedra cover the whole cell.
2. **Solid or empty.** A tetrahedron is solid if the radius of its
   circumsphere is smaller than the probe radius. A degenerate sliver whose
   circumsphere cannot be computed is solid only if all four neighbors are.
3. **Surface.** Every triangle between a solid and an empty tetrahedron
   becomes a mesh face, oriented outward, with atoms as vertices. Faces are
   linked around each edge within the solid wedge they bound, which gives a
   closed two-dimensional manifold; a vertex shared by two sheets is
   duplicated.
4. **Smoothing.** Each iteration applies the two-step Taubin filter (λ = 0.5,
   pass-band 0.1) to all vertices, with periodic minimum-image edges.
5. **Regions.** Solid tetrahedra connected through shared triangles form
   *solid regions*; empty ones form *empty regions*, also across periodic
   boundaries. An empty region that reaches an open (non-periodic) cell
   boundary is *exterior* space; every other empty region is a *void*.

In a fully periodic cell there is no exterior space: the gap between the
periodic images of a slab, or the space around a nanoparticle, is one void.
Use open boundaries in the file for directions with free surfaces if the gap
should count as exterior. Solid regions that touch only along an edge or at a
corner are separate, while empty regions that touch along an edge are one
region; this is the convention of the upstream construction.

## Results

The panel lists, for the analyzed frame:

- **Surface area**: the sum of the triangle areas of the *smoothed* mesh.
- **Solid volume**: the volume of the solid tetrahedra. **Empty volume**: the
  volume of the empty tetrahedra inside the cell, each clipped to the cell.
  **Void volume**: the part of the empty volume in voids. Volumes come from
  the tessellation, so they do not change with the smoothing level. The
  percentages refer to solid plus empty volume, which equals the cell volume
  unless atoms lie outside an open cell boundary.
- **Solid regions**, **Empty regions** with the number of voids, and
  **Surface components**, the number of connected sheets of the mesh.
- **Specific surface area**: area divided by solid plus empty volume.
- **Regions**: the largest solid regions, voids and exterior regions with
  their volume and the surface area that bounds them.

The same numbers are written to **Statistics → Structure summary** (analysis
`surfaceMesh`, including one volume and area row per region) and are available
as global attributes for [text labels](text-labels.md) and
[time series](time-series.md): `Surface.surface_area`, `Surface.filled_volume`,
`Surface.filled_fraction`, `Surface.empty_volume`, `Surface.empty_fraction`,
`Surface.void_volume`, `Surface.void_fraction`, `Surface.cell_volume`,
`Surface.specific_surface_area`, `Surface.filled_region_count`,
`Surface.empty_region_count`, `Surface.void_region_count` and
`Surface.surface_component_count`. The names follow OVITO's
`ConstructSurfaceMesh` attributes.

Because the surface passes through the centers of the outermost atoms, the
solid volume of a particle is smaller, and a void larger, than the shape that
was cut out of the crystal, by about half an atomic layer on each surface.

## Display and periodic caps

The mesh is drawn with smooth lighting. The side that faces empty space uses
the **Surface** color and the side that faces the solid the **Interior**
color, which is seen where a [slice](slices.md) or an uncapped cell face cuts
the solid open. With **Opacity** below 1 the far faces are blended first and
the near faces second.

Mesh vertices are atoms, so faces connect atoms across periodic boundaries.
For display the mesh is wrapped into the cell: faces that pass through a
periodic cell face are split there, and where the solid itself passes through
the face its cross section is closed with a **cap** in the **Caps** color.
The wrapped and capped mesh is a closed solid inside the cell; its volume
equals the solid volume when smoothing is 0. Turn the caps off to look into
the solid.

- The [periodic display origin](display.md) and
  [dragging the crystal](display.md) move the cut. While dragging, the
  committed pieces are shown translated and clipped to the cell without caps;
  releasing rebuilds the cut and its caps. In unwrapped display the mesh keeps
  the cut of the source cell and moves with the atoms.
- [Display replication](replicate.md) draws the mesh in every copy and caps
  only the outer faces of the replicated block.
- [Slices](slices.md) clip the mesh like atoms, without caps on the slice
  plane.
- The mesh appears in the second view and in PNG, JPG, chosen-resolution,
  six-view and frame-series exports. [Ambient occlusion](display.md) does not
  shade meshes.
- Atoms on the surface are mesh vertices and appear half embedded in it; hide
  atoms or lower the radius scale to see the mesh alone.

An atomic plane that lies exactly on a periodic cell face, as in ideal
lattices that start at the cell origin, is cut consistently: reduced
coordinates within 10⁻⁹ of a face are placed on it, a surface that lies in a
face is shown on the side of its solid, and other atoms on a face belong to
the lower side.

## Mesh export

**Mesh STL**, **Mesh PLY** and **Mesh OBJ** save the displayed surface: wrapped
into the cell at the current periodic origin, with caps if they are shown.
Coordinates are Cartesian ångströms in the frame of the structure.

- **STL** is binary, with one facet normal per triangle; zero-area triangles
  that arise where a cut passes exactly through an atom are left out.
- **PLY** is binary little-endian with double-precision positions, vertex
  normals and a `part` byte per face (0 surface, 1 cap).
- **OBJ** is text with vertex normals and the groups `surface` and `caps`.

Display replication and slices are not applied to exported meshes.

## Performance and determinism

The kernel is part of the DXA WebAssembly module and runs in the DXA Worker,
so it shares that module's prewarmed heap and thread pool and adds no second
copy of the tessellation code. A surface job and a dislocation extraction run
one after the other. On a cross-origin isolated host the tessellation and the
tetrahedron classification use the same threads as DXA (one per 2,048 atoms
within the CPU budget); without isolation the kernel runs on one thread.
**Cancel** is cooperative on isolated hosts and replaces the Worker elsewhere.

With one thread the result is deterministic: repeated runs, the Worker and a
direct call give bit-identical meshes and statistics. With several threads the
parallel tessellation orders tetrahedra differently from run to run; the set
of faces and the statistics agree to rounding, but vertex and face numbering
can differ.

Timing on the reference workstation (shared with other jobs), suggested radius
and smoothing 8, in Chrome:

| Structure | Atoms | 1 thread | Isolated host |
| --- | --- | --- | --- |
| HEA screw dislocation example (free in x, y) | 28,800 | 0.38–0.67 s | 0.27–0.33 s (15 threads) |
| Fe dislocation loop example (periodic) | 60,229 | 1.0–1.4 s | 0.50–0.64 s (30 threads) |

About three quarters of the time is the Delaunay tessellation. The surface
analysis and the DXA defect mesh add 53 KB to the DXA kernel for static hosts
(614 → 668 KB) and 57 KB to the threaded one (663 → 720 KB). Wrapping,
cutting and capping the HEA surface (4,384 triangles) for display takes
8–26 ms on the main thread; a porous test structure of 221,176 atoms with
124,352 surface triangles and caps on all six faces takes 0.12–0.19 s in
Node.js. The Fe loop is solid everywhere and has no surface.

## Limitations

- The probe radius must satisfy 3.5 × radius ≤ the cell thickness along every
  periodic direction; otherwise the analysis stops with an explanatory error.
  Use **Replicate atoms for analysis** for thin cells.
- Regions are identified from the unsmoothed tessellation. Region and vertex
  properties other than volume, area and the vertex-to-atom mapping are not
  transferred to the mesh, the mesh cannot be colored by an atom property and
  atoms are not assigned to regions.
- OVITO's Gaussian-density surface method and its distance-to-surface output
  are not implemented.
- In unwrapped display the mesh is still cut at the source cell faces.
- Caps close periodic cell faces only. Atoms outside an open boundary of a
  partly periodic cell can leave a cap incomplete, and a slice leaves the
  solid open.
- Wrapping, cutting and capping run on the main thread when a result arrives
  and when the periodic origin is committed.
- Memory follows DXA's estimate of 32 MiB plus 3 KiB per atom against a
  1.5 GiB budget; the display mesh needs about 60 bytes per triangle.

## Configuration

`settings.extensions.surfaceMesh` stores `enabled`, `radius` (Å, or `null` to
use the suggestion for the opened structure), `smoothingLevel` (0–100),
`atoms` (`all`, `visible` or `group`), `selectionGroupId`, `visible`, `caps`,
`opacity` (0–1) and the `color`, `interiorColor` and `capColor` hex colors. An
enabled recipe needs a radius, and a group restriction must name a saved
selection group. The entry is written once the tool has been used or changed;
recipes without it leave the tool off. The mesh and its statistics are
recalculated after import.

## Implementation

[Surface kernel](https://github.com/Yazhuo-Liu/AlloyView/blob/main/wasm/surface.cpp),
[kernel host and result checks](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/surface-mesh.js),
[Worker client](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/dxa-client.js),
[wrapping, cutting and caps](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/surface-mesh-geometry.js),
[mesh layer](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/surface-mesh-layer.js),
[panel](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/surface-tools.js),
[mesh files](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/io/mesh-export.js).

The tessellation, the manifold construction, `makeManifold()` and
`smoothMesh()` are the vendored OVITO 3.9.4 sources in `third_party/dxa`
(MIT option), which DXA also uses. Differences from OVITO:

- The mesh is one-sided, as OVITO builds it without region identification;
  regions are then identified on the tessellation with the same definitions.
  OVITO's two-sided mesh keeps a vertex whose solid sheets touch at an edge,
  where this mesh duplicates it.
- The volume of an empty tetrahedron inside the cell is computed by clipping
  it into tetrahedra, instead of building a convex hull of clipped edges.
  Region volumes are summed in tessellation order.
- Only the triangles of solid cells that face a periodic image are indexed to
  connect regions across the boundary, instead of every triangle of every
  solid cell.
- Caps are built from the edges that the cut leaves on each cell face and
  triangulated by ear clipping, instead of traced contours and the GLU
  tessellator. A face that no contour reaches is tested with lines through
  the cell rather than a point-location query, and facets that lie in a cell
  face are handled as described above.
