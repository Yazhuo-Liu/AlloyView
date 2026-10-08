# Spatial binning

## Controls

Open **Visualization tools → Binning**, choose the bins and the quantity, and
press **Calculate profile** (or **Calculate map**). The result is a chart in
the panel and a CSV table; atom colors and properties do not change.

- **Layout → Profile (1D)** divides the cell into equal slabs along one
  **Cell vector** (a, b or c). **Map (2D)** divides it into columns along two
  different vectors; the first is drawn horizontally and the second
  vertically. Each direction takes 1–4,096 bins, and a map at most 1,048,576.
- **Quantity**:
  - **Atom count**: atoms in each bin.
  - **Number density [Å⁻³]**: atom count divided by the bin volume.
  - Any numeric quantity from **Color by**: Position X/Y/Z, Speed magnitude,
    columns read from the file (for example velocity components or a
    per-atom energy), [external properties](external-properties.md),
    analysis outputs such as central symmetry or local shear, and
    [computed expression properties](expressions.md). Categorical fields such
    as crystal structure types are not offered; bin a 0/1 expression such as
    `Type == "Ni"` or `structureType == 2` (HCP atoms from CNA) with **Mean**
    to profile a concentration or a phase fraction.
- **In each bin** (for a property): **Mean**, **Sum**, **Minimum**,
  **Maximum** or **Standard deviation**.
- **Atoms** restricts the population to one named
  [selection](selection-groups.md). Groups match atoms by ID, so the
  restriction follows the same atoms through a trajectory; editing the group
  recalculates.
- **Average over all trajectory frames** appears for trajectories (see below).
- **Map colors** chooses one of the scalar color maps used for atoms; Viridis
  is the default.

Binning uses the complete analyzed frame, including hidden and sliced-out
atoms. Once calculated, the tool is enabled: changing a setting recalculates,
and every new frame is binned again with the same settings. When the chosen
property is not available in a frame yet, for example while an analysis is
still running, the panel shows **Waiting** and bins the frame as soon as the
property appears. **Cancel** clears the result and stops recalculation.

## Bins in reduced coordinates

Every atom's position r is expressed in reduced (fractional) coordinates of
the cell vectors, r = origin + s_a a + s_b b + s_c c. A profile along a with
n bins assigns an atom to bin k = ⌊s_a n⌋, so bin k covers
k/n ≤ s_a < (k + 1)/n:

- In an orthogonal cell this is an ordinary slab of constant x (or y, z).
- In a tilted (triclinic) cell the bins are slabs **parallel to the other two
  cell vectors** (b and c). They follow the crystal cell rather than a
  Cartesian axis, so a tilted cell is still divided into equal, complete
  slabs. The geometry note under the chart states the slab width along the
  vector, |a|/n, and, when the cell is tilted, the perpendicular slab
  thickness h_a/n, where h_a = V/|b × c| is the spacing of the cell faces.
- A map along a and b assigns bin (k, l) from s_a and s_b; each bin is a
  column parallel to c. The map is drawn in reduced coordinates as a
  rectangle; for a tilted cell the note states the angle between the two
  vectors.

Every bin has the same volume, the cell volume V = |det h| divided by the
number of bins (V/n for a profile, V/(n₁n₂) for a map). Number density is the
count divided by this volume, in atoms per Å³; summed over all bins, density
times bin volume recovers the binned atom count.

Positions on the chart and in the CSV are distances **along the cell vector
from the cell origin**, s × |a| in Å. For an orthogonal cell whose a vector
points along x, add the origin's x coordinate to obtain Position X.

### Periodic and open directions

Periodic directions wrap reduced coordinates into [0, 1) first, so atoms
written outside the cell are counted in their periodic image. A value that
rounds up to exactly 1 after wrapping belongs to the last bin.

Open (non-periodic) directions use the cell extent from the origin face
(s = 0) to the opposite face (s = 1); an atom exactly on the opposite face is
in the last bin. Atoms beyond the faces are not binned; the summary reports
how many were outside. Atoms with non-finite coordinates are reported
separately.

Physical **Replicate atoms** changes the analyzed cell and atoms, so it changes
the bins. Display-only replication, the periodic display origin and slices do
not.

## Reductions and missing values

For a property, values that are NaN or infinite are skipped and counted per
bin (`skipped_non_finite`). The remaining finite values give:

- **Mean**: their sum divided by their number.
- **Sum**: their sum; 0 for a bin without finite values.
- **Minimum**, **Maximum**.
- **Standard deviation**: the population standard deviation,
  sqrt(Σ(x − mean)² / N), computed in two passes for accuracy (the same
  definition as the Statistics CSV).

A bin without finite values reports NaN for the mean, minimum, maximum and
standard deviation; the profile line has a gap there and a map shows it gray.
Atom counts include atoms whose property value was skipped. Sums run over
atoms in row order, so results are reproducible.

## Trajectory averages

With **Average over all trajectory frames**, every frame is read in order and
binned with the same settings, and the frames are combined in that order:

- count and number density are averages of the per-frame values (each frame
  uses its own cell volume);
- **Sum** is the average per-frame sum;
- **Mean**, **Minimum**, **Maximum** and **Standard deviation** pool every
  finite sample of every frame (the pooled standard deviation combines the
  per-frame squared deviations with the update of Chan, Golub and LeVeque).

Bin positions use the average length of the binned vector. The result does
not depend on the displayed frame, so changing frames keeps it. Averages
support Atom count, Number density, positions, speed and columns read from
the file. Analysis outputs and computed expression properties exist only for
the displayed frame; choose them without averaging. Reading every frame takes
about as long as playing the trajectory once; a progress bar shows the frame
being read, and **Cancel** stops it.

## Chart, inspection and CSV

A profile is a step line, one step per bin, with the quantity on the vertical
axis; count-like quantities start at zero. A map shows one colored cell per
bin and a color bar with the value range. Hover or tap the chart, use the
**Inspect** sliders, or focus the chart and use the arrow keys to read a bin's
position range, value, atom count and skipped values. **View binned values**
lists a profile as a table. The chart follows the light and dark themes.

**Profile CSV** (or **Map CSV**) exports every bin through the statistics CSV
Worker. Columns are the source file, frame number and timestep, then for each
binned vector `a_bin` (1-based), `a_lower_fraction`, `a_upper_fraction`,
`a_lower [Å]`, `a_upper [Å]` and `a_center [Å]`, followed by the value (for
example `number_density [Å⁻³]` or `mean(c_atom_pe) [eV]`), `atom_count` and
`skipped_non_finite`. Map rows are ordered with the first vector's bin as the
outer loop. A trajectory average names the frame range (for example `1-20`)
instead of one frame, reports per-frame average counts and adds a
`frames_averaged` column. Values use JavaScript's shortest round-trip decimal
text; NaN is written as `NaN`. Charts have no separate image export.

## Performance and determinism

The kernel visits each atom once (twice for the standard deviation). Frames
with fewer than 250,000 atoms are binned on the main thread, which is faster
than copying them to a Worker; larger frames use a dedicated binning Worker
that keeps the last frame's reduced coordinates, so changing the quantity or
bins only sends the property values. The Worker is started when the panel is
first opened. Both paths run the same code on the same inputs in the same
order, and their results are identical bit for bit. A Worker calculation
holds one CPU permit from the shared analysis budget; **Cancel** terminates
it. The calculation needs neither shared memory nor cross-origin isolation.

In Node on the reference workstation, the Fe dislocation loop example
replicated 2 × 1 × 1 (120,458 atoms, triclinic) takes 2.6 ms for a 100-bin
number-density profile, 3.4 ms for the mean potential energy, 3.7–7 ms for its
standard deviation and 7.5 ms for a 200 × 200 map (medians). The Worker path
adds about 5 ms of messaging and copying. Binning has no GPU kernel; the GPU
preference does not affect it.

## Configuration

`settings.extensions.binning` stores `enabled`, `mode` (`1d` or `2d`),
`axes` (two of `a`, `b`, `c`; a profile uses the first), `bins` (two counts),
`quantity` (`count`, `density` or `property`), `property` (the Color by key,
such as `property:c_atom_pe` or `builtin:position:z`, when the quantity is a
property), `reduction` (`mean`, `sum`, `min`, `max` or `stddev`),
`selectionGroupId`, `averageFrames` and `colorScheme`. The selection group
must be saved in the same configuration. The property is looked up again by
name in every frame; no binned values are stored. Older configurations have
no binning entry and leave the tool off.

## Implementation

[Binning kernel](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/spatial-binning.js),
[panel](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/binning-tools.js),
[chart](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/binning-chart.js),
[Worker client](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/binning-client.js),
[CSV table](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/statistics-export.js).
OVITO's spatial binning modifier is part of OVITO Pro; this implementation is
independent.
