# Wigner–Seitz defects

## Controls

Open **Visualization tools → Wigner–Seitz**, choose a **Reference frame** and
press **Calculate defects**. The reference frame supplies the lattice sites,
usually the perfect crystal at the start of a trajectory. Every atom of the
displayed frame is assigned to its nearest reference site; a site's
*occupancy* is the number of atoms assigned to it. The Wigner–Seitz cell of a
site is the region closer to it than to any other site, so the assignment is
equivalent to asking which cell each atom lies in.

- **Reference frame** is a 1-based frame number of the loaded source. The
  current and reference frames may have different numbers of atoms, and atom
  IDs are not used, so atoms that leave the source or are inserted (for
  example by deposition or a cascade simulation in another run) are counted
  correctly. Comparing a frame with itself gives a perfect occupancy of 1.
- **Affine mapping** maps the current cell onto the reference cell before the
  assignment (see below). Use it when the cell deforms between the frames.
- **Site markers** chooses which reference sites are drawn: **Vacant sites**,
  **Defect sites** (vacant, multiply occupied and antisite sites) or **All
  sites**, colored by their class. **Marker radius** sets their size in Å, and
  **Show site markers** hides or shows them without recalculating.

The analysis uses the complete frame, including hidden and sliced-out atoms,
and recalculates whenever the displayed frame, the reference frame or the
mapping changes. **Cancel** stops it and clears its results and markers while
keeping the settings. Results are cached per frame, so returning to a frame
redraws them without a new calculation.

## Definitions

- **Occupancy** of a site: the number of current atoms whose nearest reference
  site it is. Occupancies always sum to the current atom count.
- **Vacancy**: a site with occupancy 0.
- **Interstitials**: the excess atoms, Σ (occupancy − 1) over sites with
  occupancy 2 or more. A dumbbell interstitial is one site with occupancy 2.
- **Antisite**: a site with occupancy 1 whose atom is of a different element
  than the site. Elements are compared by their type labels, so the two frames
  may number their types differently. A multiply occupied site is counted as
  an interstitial site, never as an antisite.

The counts satisfy *atoms − sites = interstitials − vacancies*. These are the
definitions of OVITO's Wigner–Seitz analysis; the antisite rule is the one in
OVITO's documented per-type occupancy example.

## Nearest-site assignment

Distances are Cartesian distances to the nearest periodic image of a site in
the **reference** cell. Periodic directions use the reference cell vectors,
including tilted (triclinic) cells; open directions use direct distances, and
atoms beyond a free surface are assigned to the closest surface site. The
current and reference frames must use the same periodic axes.

Sites are sorted into linked cells in reduced coordinates. A query visits
cells nested along the three cell vectors, with open directions outermost.
Each level's contribution to the squared distance is bounded below through
the Cholesky factor of the cell metric,
`|H Δ|² = (R₀₀Δ₀ + R₀₁Δ₁ + R₀₂Δ₂)² + (R₁₁Δ₁ + R₁₂Δ₂)² + (R₂₂Δ₂)²`,
so only cells that can hold a closer site are examined, even in strongly
tilted cells. The search radius starts near the site spacing (and the
distance to the site region for atoms outside an open boundary) and grows
until a site within it is found; every site within the final radius is
checked. The result is exact, not approximate.

**Ties**: when two sites are at exactly the same computed squared distance,
the atom is assigned to the site with the lower index (row in the reference
frame). The result does not depend on the search order or on how atoms are
divided between Workers.

## Affine mapping

Without affine mapping, an atom's Cartesian position `x` is expressed in the
reference cell, `q = H_ref⁻¹ (x − o_ref)`, and compared with the sites there.
This is right when the cell does not change. If the cell is strained, atoms
far from the origin drift relative to the reference sites and are counted as
spurious defects.

With **Affine mapping** on, the atom's reduced coordinates in the current
cell, `f = H_cur⁻¹ (x − o_cur)`, are used directly as reduced coordinates in
the reference cell, `q = f`. This maps the current cell onto the reference
cell by the homogeneous deformation `H_ref H_cur⁻¹` (and the origin shift),
so a uniformly strained crystal has no defects. Distances, the **WS distance
to site** output and the tie rule are then evaluated in the reference cell.
When the two cells are identical, both modes use `q = f`.

Site markers are drawn where the sites are in the current frame: with affine
mapping at `o_cur + H_cur s` for a site's reduced reference coordinates `s`;
without it at the site's reference Cartesian position. Markers are wrapped
into the displayed cell with its periodic display origin.

## Outputs

Each atom receives five properties for **Color by**, atom details, binning,
expressions and CSV export:

- **WS site occupancy**: the occupancy of the atom's site (1 for a regular
  atom, 2 or more for atoms sharing a site).
- **WS defect class** (categorical): **Regular** (alone on a site of its own
  element), **Interstitial** (on a site with two or more atoms; every atom of
  a dumbbell is marked, as in OVITO's atom output) and **Antisite** (alone on
  a site of another element). Hiding **Regular** in the legend leaves only the
  defects and the site markers visible.
- **WS site type** (categorical): the element of the atom's reference site.
- **WS site index**: the zero-based row of the atom's site in the reference
  frame.
- **WS distance to site**: the distance used for the assignment, in Å.

OVITO's two output modes map onto this as follows: the per-atom properties
correspond to its *atoms* mode, and **All sites** markers colored by site
class correspond to its *sites* mode. Marker colors: vacancies magenta,
regular sites gray, sites with two or more atoms amber, antisites cyan.

The panel summarizes vacancies, interstitials and antisites and lists, for
each element, its reference sites, current atoms, vacant sites, antisites
(sites of that element holding one atom of another element) and atoms on
shared sites. **Defect sites CSV** exports every vacant, multiply occupied or
antisite site with its index, reference atom ID, element, class, total
occupancy, occupancy by current element (one column per element), reference
position and position in the current frame. The statistics summary CSV
includes the counts. Markers are part of PNG exports and the second view.

## Performance and determinism

Assignment runs in the shared CPU Worker pool. Each Worker builds the site
index once per calculation and assigns ranges of current atoms; occupancies,
classes and counts are then accumulated in atom order on the main thread.
Assignments do not depend on the partition, so every array is identical to a
single-threaded calculation for any Worker count, with and without shared
memory. The calculation has no GPU kernel; the GPU preference does not affect
it.

Timing on the reference workstation, while it was shared with other jobs:
the Fe dislocation loop example replicated 2 × 1 × 1 (120,458 sites), with
every atom randomly displaced by up to 0.3 Å per axis as the current frame.
Single-threaded, the assignment takes 0.07–0.11 s in Node and about 0.2 s in
Chrome, and the occupancy summary about 0.01 s. In Chrome with 8 Workers, the
first calculation takes about 0.35–0.5 s while each Worker compiles the kernel
and builds its site index; repeated calculations (for example while stepping
through frames) take 0.07–0.19 s. The results were identical to the
single-threaded calculation with and without shared memory.

## Limitations

- The reference must be a frame of the loaded source; a separate reference
  file is not supported. With **Replicate atoms for analysis**, both frames
  are the replicated structures.
- Both frames must have the same periodic axes. Without affine mapping, a
  changed cell is not compensated, as described above.
- One atom's search may visit at most 20 million cells, which only extremely
  thin cells reach; the calculation then stops with an explanatory error.
- Site markers are drawn wrapped into the displayed cell, also in the
  unwrapped coordinate view. They cannot be picked: identify sites through
  **WS site index**, atom details and the defect-site CSV.
- Occupancies and classes are summarized on the main thread after the
  Workers finish (about 0.01 s per 100,000 atoms).
- Every Worker builds its own index of the reference sites for each
  calculation; the index is not shared between Workers, also with shared
  memory.

## Configuration

`settings.extensions.wignerSeitz` stores `enabled`, the zero-based
`referenceFrame`, `affineMapping`, `markers` (`vacancies`, `defects` or
`all`), `showMarkers` and `markerRadius` (Å, 0.01–100). An enabled reference
frame must be smaller than the source's frame count. Results are recalculated
after import; no occupancies are stored.

## Implementation

[Wigner–Seitz kernel](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/wigner-seitz.js),
[panel, outputs and markers](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/wigner-seitz-tools.js),
[site marker layer](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/site-marker-layer.js),
[Worker scheduling](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/analysis-pool.js).
The definitions follow OVITO's Wigner–Seitz analysis modifier; the
implementation is independent.
