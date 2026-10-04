# Bonds

## Controls

Set a positive global cutoff and optional element-pair cutoffs. A pair cutoff of zero disables that pair. Bond visibility is independent of whether the bond graph has been calculated. Adjust the cylinder radius and color to change its appearance.

## Algorithm

A periodic neighbor search emits unique undirected edges. An edge starts at the first atom and ends at the indicated periodic image of the second atom. Distinct lattice images are retained, including self-image edges in small cells; only one orientation of each undirected edge is stored. Pair-specific cutoffs override the global value.

The renderer draws instanced cylinders from these geometric endpoints. Coloring, visibility, clipping and display replication follow the shared scene settings. Bonds are a distance-based graph and do not imply a chemical bond order.

The output is bounded to one million edges and the search bounds neighbors per atom. Excessive output produces an error instead of silently showing only part of the graph; reducing cutoffs lowers both memory and drawing cost.

## Implementation

[Periodic bond graph](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/bonds.js), [bond and arrow primitives](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/atom-primitives.js).
