# Grain segmentation

Grain segmentation divides a polycrystal into grains: connected regions of
one crystal lattice with nearly the same orientation. It works from the
structure type and lattice orientation that [PTM](ptm.md) finds for each
atom, and is a port of the grain segmentation modifier of OVITO 3.9.4.

## Controls

Open **Visualization tools → Grains** and press **Find grains**. The analysis
runs PTM with the templates and RMSD threshold set in the PTM panel, then
groups the atoms. It uses the complete analyzed frame, including hidden and
sliced-out atoms, and recalculates when the frame, a setting here or a PTM
setting changes. **Cancel** stops it and clears its results while keeping the
settings.

- **Algorithm**
  - **Graph clustering (automatic)** merges atoms into clusters in order of
    increasing merge distance and chooses the merge threshold from the data.
    This is the default.
  - **Graph clustering (manual)** uses the same merge sequence with the
    threshold you enter, as a log merge distance.
  - **Minimum spanning tree** joins two neighboring atoms whenever their
    disorientation is at most the threshold, in degrees. It needs a threshold
    and is sensitive to it: a low-angle boundary below the threshold does not
    separate grains.
- **Merge threshold**. For the automatic algorithm the field is read-only and
  shows the chosen value. Switching to manual starts from that value. The
  minimum spanning tree has its own threshold, 2° by default.
- **Minimum grain size**: clusters with fewer atoms are not grains. Their
  atoms get grain ID 0. The default is 100.
- **Adopt orphan atoms**: atoms left without a grain, mostly in grain
  boundaries, join the nearest grain. On by default.
- **Handle coherent interfaces and stacking faults**: HCP atoms of a stacking
  fault or twin boundary in an FCC crystal belong to the FCC grain around
  them instead of forming a separate HCP region. On by default.

The cell must be large enough that no atom neighbors two periodic images of
the same atom. A cell that is too thin stops the analysis with a message
naming the cell vector. Enable **Replicate atoms for analysis** in
[Replicate](replicate.md) along that vector first; the nickel grain-boundary
example needs 1 × 1 × 2.

## Algorithm

**1. Neighbor bonds.** PTM reports, for every atom it matches, the neighbors
of the matched template in template order: 12 for FCC, HCP and icosahedral,
14 for BCC, 6 for simple cubic, 16 for the diamond lattices and 9 for
graphene. For an atom without a match, or rejected by the RMSD threshold, the
list is its eight nearest neighbors. Atoms a < b are bonded when b is in the
list of a. A bond's length is the distance between the nearest periodic
images.

**2. Coherent interfaces.** When this handling is on, the more numerous of
FCC and HCP is the parent phase, and likewise for cubic and hexagonal
diamond; equal counts favor the cubic phase. A minority-phase atom bonded to
a parent-phase atom is compared with it through the two rotations that relate
the FCC and HCP templates across a close-packed plane. If their interfacial
disorientation is below 4°, the atom is relabeled as parent phase and takes
the equivalent parent-phase orientation. Conversion proceeds outward from the
parent phase, smallest interfacial disorientation first, so a whole stacking
fault or twin-boundary layer is converted.

**3. Disorientation.** The disorientation of a bond is the smallest rotation
angle between the two lattice orientations over all symmetry operations of
the lattice: the 24 proper rotations of the cubic group for FCC, BCC, simple
cubic and cubic diamond, and the 12 of the hexagonal group for HCP, hexagonal
diamond and graphene. Only bonds between atoms of the same structure type
have a disorientation. Bonds with an unmatched or icosahedral atom, and bonds
of 4° or more, never join atoms. As in OVITO, orientations are rounded to
single precision first, which limits a small disorientation to about 10⁻³°.

**4. Merge sequence.**

- *Graph clustering.* Each remaining bond becomes a graph edge of weight
  w = exp(−d²/3) for a disorientation of d degrees; below 10⁻⁵° the weight is
  exactly 1. Node pair sampling (Bonald et al., 2018) then merges clusters
  hierarchically. The weight of a cluster is the sum of the edge weights at
  its atoms, the weight between two clusters is the sum of the edge weights
  joining them, and their **merge distance** is

  `D(a, b) = w(a) w(b) / w(a, b)`.

  The two clusters with the smallest distance merge, found with
  nearest-neighbor chains. Distances grow with cluster size, and a merge
  across a grain boundary, which few and weak edges support, has a far larger
  distance than the merges inside either grain.
- *Minimum spanning tree.* Bonds are visited in order of increasing
  disorientation and join the clusters of their two atoms; the merge distance
  is the bond's disorientation.

**5. Threshold.** Merges up to the threshold are applied. The automatic
threshold comes from a robust straight-line fit of log merge distance against
log merge size, where the merge size is the harmonic mean of the two cluster
sizes and also weights the point. The fit minimizes absolute deviations by 100
rounds of iteratively reweighted least squares. A merge is an inlier when it
lies less than 1.5 median absolute residuals above the line. The threshold is
the largest log merge distance of an inlier, and never below zero. It is
therefore exactly the distance of one merge.

**6. Grains.** A cluster is a grain when it has at least the minimum number
of atoms. Unmatched atoms never form one. With a minimum size of 1, every
matched atom that merged with nothing is a grain of one atom, including
icosahedral atoms. The mean orientation of a grain is the normalized sum of
its atoms' orientation quaternions, each first replaced by its symmetry
equivalent closest to the running sum; it is defined up to a symmetry
operation of the lattice.

**7. Orphan adoption.** Starting from every bond between a grain atom and an
orphan, orphans are adopted in order of the summed bond length of the
shortest chain of bonds that connects them to a grain. Orphans not bonded to
any grain, directly or through other orphans, keep ID 0.

**8. Numbering.** Grains are numbered by atom count, largest first. Grains of
equal size are ordered by the row of the root atom of their merge tree, which
is the same on every run.

## Outputs

- **Grain ID** is a categorical per-atom property for **Color by**, atom
  details and CSV export: 1, 2, … for grains and 0 for atoms in no grain. The
  20 lowest IDs are listed in the color legend, each with its own color and
  visibility checkbox; **Other grains (N)** shows or hides the rest together.
  Colors cycle through 18 distinct hues, and **No grain** is gray.
- **Grain orientation · inverse pole figure** and **Grain orientation ·
  Rodrigues RGB** color every atom by the mean orientation of its grain, with
  the same keys, sample direction and color rules as the
  [PTM orientation colors](ptm.md#orientation-colors). A grain has one color;
  atoms in no grain are gray. The panel buttons **Orientation · IPF** and
  **Orientation · RGB** select them.
- The **merge plot** shows each merge of two clusters of at least 20 atoms:
  merge distance against the size of the smaller cluster, with the applied
  threshold as a vertical line. Merges at or below the threshold formed the
  grains; those beyond it would join different grains. Move the pointer or
  use the arrow keys to read single merges. For the manual algorithm and the
  minimum spanning tree, click the plot to set the threshold. Above 12,000
  points the plot draws a uniform sample plus the 2,000 largest distances.
  **Plot CSV** exports every point.
- The **grain table** lists ID and color, atom count, structure type and the
  mean orientation as a rotation angle about an axis. It starts with the first
  10 grains; **Show more** adds 100 rows at a time. **Table CSV** exports
  every grain with its atom fraction, orientation quaternion (w, x, y, z),
  Bunge Euler angles, axis and angle, and volume.
- **Global attributes** for [text labels](text-labels.md) and
  [time series](time-series.md): `Grains.grain_count`, `Grains.mean_size`,
  `Grains.largest_size`, `Grains.unassigned_atoms` and
  `Grains.merge_threshold`. The same values, with the settings, are rows of
  the Statistics summary CSV.

Orientations are PTM's: the quaternion rotates the ideal lattice into the
simulation frame. Cube axes of the ideal cubic lattices lie along x, y and z;
the hexagonal c axis lies along z and a₁ along x. The Euler angles are Bunge
angles (φ₁, Φ, φ₂), Z–X–Z, of the inverse rotation, which takes sample
coordinates to crystal coordinates, so the quaternion's rotation matrix is
Z(φ₁) X(Φ) Z(φ₂).

A grain's volume is the sum of the Voronoi atomic volumes of its atoms when a
[Voronoi analysis](voronoi.md) of all atoms was calculated before the grains.
Otherwise, in a fully periodic cell, it is the atom count times the mean
atomic volume of the cell. The CSV names the source. A cell with an open
direction has no volume estimate without Voronoi volumes.

## Differences from OVITO

The arithmetic follows OVITO 3.9.4 operation by operation. The differences
are:

- **Order where OVITO leaves it open.** OVITO collects bonds from parallel
  threads in the order the threads finish, sorts bonds and merges with an
  unstable sort, starts each nearest-neighbor chain at the first element of a
  hash set, and breaks ties in its priority queues arbitrarily. AlloyView
  lists bonds by atom row and list position, uses stable sorts, starts each
  chain at the lowest remaining atom row, and breaks queue ties by insertion
  order. Results are the same on every run and in every browser. Where
  disorientations or distances tie exactly, as in an ideal crystal, OVITO's
  own results vary from run to run (see below), and AlloyView returns one of
  the equally valid outcomes.
- **Numbering.** OVITO numbers grains by their size before orphan adoption,
  so its list can be slightly out of size order. AlloyView numbers by the
  final size.
- **Structure type of a grain.** OVITO lists the PTM type of the atom that
  happens to be the root of the grain's merge tree. With coherent interfaces
  handled, that atom can be an HCP atom of a stacking fault inside an FCC
  grain. AlloyView lists the lattice the grain was merged in, which is the
  one its orientation refers to.
- **Thin cells.** OVITO fails with "Graph has self loops" when an atom
  neighbors two images of one atom, and lets the minimum spanning tree run on
  such a cell. AlloyView stops both algorithms with a message naming the cell
  vector to replicate. It applies OVITO's other test, a neighbor more than
  half a cell vector away, unchanged.
- **Minimum spanning tree threshold.** OVITO has one threshold field, 0 by
  default, for both manual algorithms. AlloyView keeps a separate threshold
  in degrees for the minimum spanning tree, 2° by default.
- **Bond lengths** are recalculated from the coordinates with the nearest
  periodic image, instead of kept from the neighbor search. The values agree
  to rounding and only order orphan adoption.
- **A cluster graph that does not converge** raises an error instead of
  looping forever.
- OVITO's optional output of the neighbor bonds and its random grain colors
  are not provided; grain colors cycle through fixed distinct hues.

AlloyView stores coordinates in single precision. Its PTM orientations
therefore differ from OVITO's by up to about 10⁻⁴°, which can move the
automatic threshold to the distance of a different merge without changing
the grains.

## Validation against OVITO

The reference is the PyPI package `ovito==3.9.4`, with
`PolyhedralTemplateMatchingModifier(output_orientation=True)` for FCC, HCP and
BCC and an RMSD cutoff of 0.1, followed by `GrainSegmentationModifier`. Ten
structures were compared, each with seven settings: the defaults, without
orphan adoption, without coherent-interface handling, minimum size 10, manual
threshold 15 (21 for the nickel example), and the minimum spanning tree at 2°
with and without orphan adoption.

*The grain engine alone*, given OVITO's own PTM output (structure types,
single-precision orientations and template neighbor lists):

| Structure | Atoms | Grains | Automatic threshold, OVITO | AlloyView |
| --- | --- | --- | --- | --- |
| FCC, 4 grains | 12,665 | 4 | 12.726793122576979 | identical |
| BCC, 6 grains | 14,462 | 6 | 12.328640541240672 | identical |
| HCP, 5 grains | 9,436 | 5 | 11.669277640890405 | identical |
| FCC, BCC and HCP grains | 10,653 | 3 | 13.061870134575354 | identical |
| FCC, 8 grains | 41,582 | 8 | 13.392205917995952 | identical |
| FCC with a stacking fault and a twin | 6,720 | 2 | 13.001974236143742 | identical |
| HCP with an FCC slab | 6,496 | 1 | 13.161870660699792 | identical |
| FCC, 8 grains | 105,520 | 8 | 14.414265968638412 | identical |
| FCC, 8 grains, ideal positions | 17,344 | 8 | 11.728–11.836 over 6 runs | 11.773783248685020 |
| Nickel bicrystal example, 1 × 1 × 2 | 259,808 | 2 | 19.575–19.694 over 6 runs | 19.613435979821645 |

In all 70 comparisons the grain count is equal and every atom is in the same
grain (adjusted Rand index 1). Numbered as OVITO does, before orphan
adoption, the grain IDs are identical too. Grain sizes match, the structure
type OVITO lists matches the root atom's type, and mean orientations agree
within 4 × 10⁻⁶° up to lattice symmetry. For the eight structures with
thermal-like displacements of 0.03–0.06 Å, the automatic threshold is
identical to the last bit and every log merge distance agrees within
2 × 10⁻¹⁵. For the two structures with ideal or energy-minimized positions,
OVITO's threshold differs between runs of the same input; AlloyView's value
lies within that range.

*End to end*, with AlloyView reading the file and running its own PTM: all
structure types equal OVITO's for every atom, and orientations agree within
1.1 × 10⁻⁴°. The grain count is equal in all 70 comparisons and every atom is
in the same grain in 59. In the other 11, which belong to the stacking-fault
structure and the ideal polycrystal, atoms equally close to two grains go to
the other one (adjusted Rand index 0.9965–0.9975). The automatic threshold
differs from OVITO's by 7 × 10⁻⁷ to 0.29.

Two of the structures, with OVITO's output for five settings each, are stored
as fixtures and checked by the unit tests. To repeat the comparison:

```sh
python3 -m venv /tmp/ovito-grains-venv
/tmp/ovito-grains-venv/bin/pip install "ovito==3.9.4" "numpy<2"
node scripts/research/ovito-grains-compare.mjs structures /tmp/grains/structures
QT_QPA_PLATFORM=offscreen /tmp/ovito-grains-venv/bin/python -I scripts/research/ovito-grains-oracle.py \
  /tmp/grains/structures/fcc-8grain.dump /tmp/grains/reference/fcc-8grain
node scripts/research/ovito-grains-compare.mjs compare /tmp/grains/structures/fcc-8grain.dump /tmp/grains/reference/fcc-8grain
```

## Performance and determinism

PTM runs in the shared CPU Worker pool, with WebGPU neighbor preparation when
GPU acceleration is on. A PTM fit of the frame with the same templates and
RMSD threshold is reused when it carries neighbor lists. Fits made by the PTM
or Strain tools while Grains is on carry them, so one fit serves all three; a
fit made before Grains was turned on is repeated once.

The clustering runs in one dedicated Worker, started when the panel opens. It
keeps the merge sequence of the last structure, so a new threshold, minimum
grain size or orphan setting repeats only steps 5–8. The automatic and manual
algorithms share one merge sequence; the minimum spanning tree and each
coherent-interface setting have their own. Cancelling terminates the Worker
and starts a new one in the background. The Worker receives copies of the PTM
arrays and coordinates; it needs neither shared memory nor cross-origin
isolation, and results are identical with and without them.

In headless Chrome on the reference workstation (40 logical processors):

| Structure | PTM | Clustering | Steps 5–8 only |
| --- | --- | --- | --- |
| FCC polycrystal, 105,520 atoms | 0.7–0.8 s | 1.0–1.1 s | 0.14 s |
| Nickel bicrystal example, 1 × 1 × 2, 259,808 atoms | 1.6–2.0 s | 2.2–2.8 s | 0.13–0.15 s |

Times are the ranges of runs on a host without and with cross-origin
isolation; PTM used 10–32 Workers. In Node, one thread builds the merge
sequence of the 105,520-atom structure in 0.8 s. OVITO 3.9.4, which is
multithreaded native code, takes 0.9 s and 2.1 s for its grain modifier on
the same structures.

Memory: the neighbor lists add 65 bytes per atom to a PTM fit and the grain
IDs 4 bytes per atom. While it builds a merge sequence the Worker holds
roughly 0.7 kB per atom, an estimate from its array sizes; afterwards it
keeps about a third of that.

## Limitations

- Building the merge sequence runs on one thread in the grain Worker, while
  OVITO's engine is multithreaded. Only the preceding PTM fit uses the Worker
  pool.
- The browser tests run grain segmentation with GPU acceleration off. Grains
  from a PTM fit whose neighbors were prepared with WebGPU are not yet covered
  by a browser test.

## Configuration

`settings.extensions.grains` stores `enabled`, `algorithm` (`automatic`,
`manual` or `mst`), `mergeThreshold` (the manual log merge distance),
`mstThreshold` (degrees), `minGrainSize`, `adoptOrphans` and
`handleCoherentInterfaces`. The PTM templates and RMSD threshold are saved
under `settings.analyses.ptm` whether or not the PTM tool is on. The color
modes `builtin:grains:ipf` and `builtin:grains:quaternion` are saved as the
display color mode. Every field is validated on import; grains are
recalculated and no grain arrays are stored. Older recipes without the
extension leave the analysis off.

## Implementation

[Grain engine](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/grains.js),
[symmetry and disorientation](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/disorientation.js),
[PTM neighbor lists](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/ptm.js),
[Worker](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/workers/grains-worker.js) and
[its client](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/grains-client.js),
[panel, colors and table](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/grain-tools.js),
[merge plot](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/grain-merge-chart.js),
[orientation colors](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/orientation-colors.js).
The pinned OVITO sources the port was written from, with their license, are
in [third_party/grains](https://github.com/Yazhuo-Liu/AlloyView/tree/main/third_party/grains).
The PTM kernel exports the matched neighbors through `alloy_ptm_neighbors` in
[wasm/ptm.cpp](https://github.com/Yazhuo-Liu/AlloyView/blob/main/wasm/ptm.cpp).

References: P. M. Larsen, S. Schmidt and J. Schiøtz, *Robust structural
identification via polyhedral template matching*, Modelling Simul. Mater.
Sci. Eng. 24, 055007 (2016); T. Bonald, B. Charpentier, A. Galland and
A. Hollocou, *Hierarchical graph clustering using node pair sampling*,
arXiv:1806.01664 (2018).
