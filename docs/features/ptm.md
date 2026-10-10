# Polyhedral template matching

## Controls

Select template candidates and set a nonnegative RMSD threshold. FCC, HCP, BCC, ICO and SC are enabled by default; diamond, hexagonal diamond and graphene require additional shells and are optional. A threshold of zero disables RMSD rejection.

## Algorithm

PTM compares local neighbor topology and geometry with ideal crystal templates. The compiled WebAssembly kernel searches candidate correspondences and determines a best fit while accounting for orientation and scale. AlloyView exposes the chosen structure, fit RMSD and nearest-neighbor distance. Fits above the threshold are classified as Other; diagnostic RMSD remains available while rejected deformation fits are undefined.

The geometric fit can be reused by ideal lattice strain when template candidates and RMSD parameters match. A strain-only fit does not enable PTM display properties. Cancellation of one analysis does not automatically cancel an independent consumer of the fit.

Identification depends on enabled templates, local disorder and RMSD tolerance. A recognized crystal template does not establish composition or a stress-free reference lattice.

[Grain segmentation](grains.md) uses the same templates and RMSD threshold. While it is on, a fit also returns each atom's neighbor list: the neighbors of the matched template in template order, or the eight nearest neighbors of an unmatched atom. The seven ordinary outputs are identical with and without these lists, and one fit serves both tools.

## Orientation and chemical ordering

Every matched atom also receives its lattice orientation as a unit quaternion, **PTM orientation qw, qx, qy, qz**, rotated into the fundamental zone nearest the identity. An axis-aligned crystal has qw = ±1. Unmatched atoms have no orientation (NaN). The components are ordinary scalar properties for Color by, Details and CSV export; adjacent grains differ in at least one component.

## Orientation colors

After PTM completes, **Color by → PTM orientation · inverse pole figure**
maps a selected **sample direction** into each atom's crystal frame. Choose
sample X, Y or Z in the legend, or enter any nonzero custom Cartesian vector;
the vector is normalized before use. The default is sample Z. The settings
follow trajectory frames and are included in configuration JSON.
Completed ideal-lattice strain also enables these orientation views by reusing
its PTM fit, even when a separate PTM analysis is disabled. A lattice-estimation
cache alone does not publish orientation colors.

PTM's quaternion is an **active template-to-sample rotation**, ordered
`(w, x, y, z)`. The IPF therefore uses `R(q)ᵀ · sampleDirection`, rather than
the forward rotation. This convention follows `calc_rmsd` in the bundled
`third_party/ptm/ptm_structure_matcher.cpp`, which fits `rot · ideal_points`
to measured neighbors, and is tested with the actual compiled PTM kernel on
rotated FCC, BCC and HCP crystals.

For FCC, BCC, simple cubic and cubic diamond, full **m−3m cubic symmetry**
reduces the absolute direction components to `0 ≤ y ≤ x ≤ z`. Diamond uses its
Laue class, as is usual for orientation maps, although the local environment
of one atom is tetrahedral. The key corners are **[001] red**, **[101]
green** and **[111] blue**. The RGB weights are `z−x`, `√2(x−y)` and `√3y`,
normalized by their maximum and square-root corrected for brightness.

For HCP, hexagonal diamond and graphene, **6/mmm hexagonal symmetry** reduces
the direction to the hemisphere and a 0–30° basal wedge. PTM aligns each of
these templates with c along z and a₁ along x; for graphene, c is the sheet
normal. The corners are **[0001] red**, **[10−10] green** and
**[2−1−10] blue**. PTM's Cartesian basal x axis is `a₁ = [2−1−10]`; `[10−10]`
is 30° away with `a₂=(-1/2, √3/2, 0)` and `a₃=−a₁−a₂`. The red weight is
the absolute c-axis component; the two basal weights split the in-plane
magnitude in proportion to the reduced azimuth. The same brightness correction
is applied. Symmetry-equivalent directions, including opposite poles, receive
the same color.

The live and exported keys show the **stereographic fundamental sectors**,
including their curved boundary. Every key pixel uses the same direction-to-RGB
formula as the atoms. A frame with both cubic and hexagonal structures shows
both keys. Other (unmatched) atoms and icosahedral environments, which have no
lattice orientation, are neutral gray. IPF colors
represent orientation relative to the chosen sample direction; they do not
independently identify crystal structures or uniquely distinguish every grain.

**PTM orientation · Rodrigues RGB** is a supplementary view that does not
depend on a sample direction.
- Each orientation is reduced to the crystal's fundamental zone with the
  proper rotations of its Laue group: 24 for cubic structures, 12 for
  hexagonal ones. The equivalent quaternion q ⊗ g closest to the identity
  (largest |w|) is kept with w ≥ 0, the same rule PTM applies to its own
  output.
- Red, green and blue then encode the Rodrigues vector r = (x, y, z)/w. Each
  component is scaled by the zone's half-width: tan(π/8) for cubic axes, and
  for hexagonal crystals tan(π/12) along c and 1 in the basal plane. The
  result maps from −1…1 onto 0…255.
- Symmetry-equivalent orientations and q/−q therefore share a color, and the
  ideal orientation is mid-gray (128, 128, 128).
- Orientations on a zone boundary can still jump between opposite faces, as
  in any fundamental-zone color map; use IPF colors for smooth grain contrast.
- The configuration value keeps its earlier ID, `builtin:ptm:quaternion`.

**PTM chemical ordering** compares the element types of an atom and its matched neighbors, as PTM defines for binary chemistry:

| Ordering | Meaning |
| --- | --- |
| Pure | All neighbors share the central atom's type |
| L1₀ | CuAu-type tetragonal order on an FCC lattice |
| L1₂ (A-site) | Cu₃Au order, central atom on a majority (Cu) site |
| L1₂ (B-site) | Cu₃Au order, central atom on a minority (Au) site |
| B2 | CsCl order on a BCC lattice |
| Zincblende | SiC order on a cubic or hexagonal diamond lattice |
| Hex. BN | Boron-nitride order on graphene |
| Other | Unmatched atoms, and environments with three or more types or no listed order |

Ordering uses the source atom types exactly as loaded, so it detects B2 or L1₂ domains in binary alloys and in binary sub-lattices of a larger alloy only where an environment contains exactly two types. Multi-principal-element neighborhoods report Other. The legend checkboxes hide ordering classes like any other category. These outputs follow OVITO's `outputOrientation` and `outputOrderingTypes` options.

## Use in ideal lattice strain

Standalone PTM uses CPU neighbor search and WebAssembly fitting. With **Enable GPU acceleration** on, fresh [ideal lattice strain](ideal-strain.md) uses a hybrid fit: WebGPU prepares each atom's nearest 18 source indices and Float64 Cartesian image vectors, then the existing CPU WebAssembly kernel performs Voronoi ordering, topology and template correspondence fitting. The GPU neighbor shader preserves strict IEEE64 distance/vector ordering through integer arithmetic. It reuses resident frame coordinates and the linked-cell index; this accelerates neighbor preparation when the adapter and workload favor it, while fitting remains CPU work.

Neighbor results are read back in batches of at most 16,384 atoms; the next batch runs on the GPU while one is decoded. The complete host table uses 505 bytes per atom and is bounded to 256 MiB, roughly 531,000 atoms. Diamond and graphene templates require the complete table because fitting also queries neighboring atoms; ordinary templates can supply each CPU Worker with its own central range. Unsupported geometry, device limits or table size use the existing CPU neighbor search. Cancellation stops preparation and fitting without starting fallback work. See [performance](performance.md) for transfer costs and timing limits.

## Implementation

[PTM wrapper and template parameters](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/ptm.js), [GPU neighbor preparation](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/gpu/ptm-neighbors.js), [compiled kernel loader](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/ptm-kernel.mjs), [analysis implementation guide](../STRUCTURE_ANALYSIS.md).
