# Coordination number

## Controls

Set a positive cutoff radius in Å. Editing the cutoff schedules a new calculation after a short typing pause; committing the field applies it immediately. The count becomes available for coloring, atom inspection and the coordination distribution. Cancel clears the result and disables automatic calculation on later frames.

## Algorithm

Atoms are indexed in fractional linked cells. Cell-face heights bound candidate bins, and the cutoff is checked using Cartesian distances in the full cell metric. Periodic axes search the necessary lattice translations; non-periodic axes do not wrap.

Accepted pairs increment both atoms' counts. This calculation counts the closest image of each unique neighboring atom ID, once per neighbor. For periodic cells shorter than twice the cutoff it does not count multiple images of the same ID; the viewer reports that convention explicitly. It differs from bond and local-geometry neighbor searches, where distinct images can be retained.

Coordination depends on the chosen cutoff and the physical length units of the input. Display replication, slicing and visibility filters do not alter the original calculation.

## Implementation

[Coordination and minimum-image distances](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/coordination.js), [Worker scheduling](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/analysis-pool.js).
