# Cluster analysis

## Controls

Open **Visualization tools → Clusters** and press **Calculate clusters**. Two
atoms are neighbors when their distance is at most the cutoff; a cluster is a
set of atoms connected through a chain of neighbors. Every atom belongs to
exactly one cluster, and an atom without neighbors is a cluster of one.

- **Neighbors → Cutoff radius** uses the panel's own radius, in Å. When a
  structure opens, the radius starts from the same element estimate as
  [Coordination](coordination.md); edit it to match the first minimum of g(r)
  or the connectivity you want.
- **Neighbors → Bond cutoffs** uses the default cutoff and element-pair
  overrides from [Bonds](bonds.md), so clusters are the connected pieces of
  the bond network. Bonds do not need to be calculated or drawn. A pair
  cutoff of zero disconnects that element pair. Changing the Bonds cutoffs
  recalculates enabled clusters.
- **Atoms** restricts the analysis to one named [selection](selection-groups.md).
  Atoms outside the group get cluster ID 0, have no cluster size, and do not
  connect other atoms. Groups match atoms by ID, so the restriction follows
  the same atoms through a trajectory; editing the group recalculates.
- **Sort clusters by size** numbers clusters 1, 2, … from largest to smallest.
  Equal sizes are ordered by their lowest atom row in the file. With sorting
  off, clusters are numbered in the order of their lowest atom row.

The analysis uses the complete analyzed frame, including hidden and sliced-out
atoms, and recalculates when the frame changes. **Cancel** stops it and clears
its results while keeping the settings.

## Periodic boundaries

Periodic directions connect atoms across cell faces using the cell vectors,
including tilted (triclinic) cells. Every periodic image within the cutoff is
a neighbor; in a cell thinner than twice the cutoff, an atom can be connected
to several images of the same atom, or to its own image. Open (non-periodic)
directions use direct distances only.

**Replicate atoms for analysis** changes the analyzed structure, so its added
atoms take part in the clusters. Display-only replication and the periodic
display origin do not change the results.

## Outputs

Each atom receives two properties for **Color by**, atom details and CSV
export:

- **Cluster ID**: 1, 2, … for clusters and 0 for atoms outside the selected
  group. It is categorical. The 20 lowest IDs are listed in the color legend,
  each with its own color and visibility checkbox; **Other clusters (N)**
  shows or hides all remaining IDs together. Colors cycle through 18 distinct
  hues, so neighboring IDs always differ; ID 0 is gray and listed as
  **Not analyzed**.
- **Cluster size**: the number of atoms in the atom's cluster, or NaN outside
  the selected group, colored as a scalar.

The panel table lists, for each cluster, its ID and color, atom count, radius
of gyration and center of mass. It starts with the first 10 clusters; **Show
more** adds 100 rows at a time. **Table CSV** exports every cluster with its
total weight, center, radius of gyration, the six gyration tensor components,
the percolation flag and the ID of its lowest-row atom.

## Centers of mass and radius of gyration

Clusters that cross a periodic boundary are measured in unwrapped coordinates.
The lowest-row atom of each cluster stays at its position in the cell; every
other atom is shifted by the whole cell vectors that connect it to that atom
along the neighbor graph. The center of mass is

`R = Σ mᵢ rᵢ / Σ mᵢ`,

and the gyration tensor and radius of gyration are

`Gαβ = Σ mᵢ (rᵢ − R)α (rᵢ − R)β / Σ mᵢ`, `Rg = sqrt(Gxx + Gyy + Gzz)`.

Positions are Cartesian and include the cell origin, as in atom details. When
the frame has a `mass` property (CFG files and dumps with a `mass` column), it
weights every sum. Otherwise, or when an analyzed atom's mass is not finite
and positive, all atoms have equal weight; the summary states which weighting
was used. Total weight is in amu for masses and is the atom count otherwise.

## Clusters connected to their own images

A cluster can connect to one of its own periodic images: a crystal grain that
fills the cell, a layer spanning a periodic face, or an atom closer than the
cutoff to its own image. Such a cluster is infinite in the periodic system, so
no unwrapping places all its atoms consistently and its center of mass is
undefined. These clusters are marked **Periodic** in the table, have
`percolating = true` in the CSV, and report NaN centers, radii of gyration and
gyration tensors. Their size and total weight are still reported.

Detection is exact: while joining neighbor pairs, the analysis records the
image shift between connected atoms. A neighbor pair inside an already
connected cluster whose shift disagrees with the recorded one closes a loop
through a periodic boundary.

## Performance and determinism

Neighbor search runs in the shared CPU Worker pool: each Worker searches a
range of atoms and keeps only the edges that join new atoms or first close a
periodic loop. One Worker then joins these partial results and measures the
clusters. Omitted edges never change the clusters, unwrapped positions or
periodic flags, so IDs, sizes, centers and radii are identical to a
single-threaded calculation, for every Worker count, with and without shared
memory. Sums run over atoms in row order.

In Node on the reference workstation, the Fe dislocation loop example
replicated 2 × 1 × 1 (120,458 atoms) with a 2.85 Å cutoff takes 0.13–0.15 s
with 30 warm Workers (one periodic cluster, 825,524 neighbor pairs), and
0.06–0.08 s when restricted to its 940 highest-energy atoms; a single thread
takes about 0.6 s for the full structure. The first calculation on a frame
also builds each Worker's neighbor index. Cluster analysis has no GPU kernel;
the GPU preference does not affect it.

An atom may have at most 100,000 neighbors within the cutoff, as in Bonds.

## Limitations

- Per-atom outputs are the cluster ID and size. Unwrapped positions are used
  for the centers and gyration tensors only; OVITO's option to output
  unwrapped atom coordinates is not provided.
- Neighbors come from the general periodic neighbor search shared with the
  other analyses, not from a dedicated cutoff loop. That search accounts for
  most of the single-thread time.

## Configuration

`settings.extensions.clusters` stores `enabled`, `neighborMode` (`cutoff` or
`bonds`), `cutoff`, `selectionGroupId` and `sortBySize`. The selection group
must be saved in the same configuration. Bond mode uses
`settings.extensions.bonds.cutoff` and its pair cutoffs. Results are
recalculated after import; no cluster arrays are stored.

## Implementation

[Cluster kernel](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/clusters.js),
[panel, colors and table](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/cluster-tools.js),
[periodic neighbor search](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/neighbors.js),
[Worker scheduling](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/analysis-pool.js).
The connectivity and output definitions follow OVITO's cluster analysis
modifier; the implementation is independent.
