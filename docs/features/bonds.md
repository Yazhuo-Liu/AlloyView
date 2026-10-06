# Bonds

## Controls

Set a positive global cutoff and optional element-pair cutoffs. A pair cutoff of zero disables that pair. Bond visibility is independent of whether the bond graph has been calculated. Adjust the cylinder radius and color to change its appearance.

Expand **Bond distributions and Q4/Q6** to calculate length and angle distributions together with local Steinhardt orientational order using the same cutoffs. This analysis has its own calculation and cancellation controls, and works without drawing bond cylinders. See [Bond statistics](bond-statistics.md) for definitions and CSV exports.

## Algorithm

A periodic neighbor search emits unique undirected edges. An edge starts at the first atom and ends at the indicated periodic image of the second atom. Distinct lattice images are retained, including self-image edges in small cells; only one orientation of each undirected edge is stored. Pair-specific cutoffs override the global value.

The renderer draws instanced cylinders from these geometric endpoints. Coloring, visibility, clipping and display replication follow the shared scene settings. Bonds are a distance-based graph and do not imply a chemical bond order.

The output is bounded to one million edges and the search bounds neighbors per atom. Excessive output produces an error instead of silently showing only part of the graph; reducing cutoffs lowers both memory and drawing cost.

## GPU acceleration

**Enable GPU acceleration** beside **Light / Dark** is on by default and uses the WebGPU bond algorithm when supported; turn it off to use CPU Workers for the next calculation. The GPU reuses resident frame coordinates and its periodic linked-cell index, counts each atom's edges, then writes a compact graph. Element-pair cutoffs, disabled pairs, triclinic cells, repeated images and self-image edges keep the CPU conventions.

Distance decisions close to a cutoff receive a sparse CPU correction before the graph is returned. The GPU implementation supports up to 256 pair overrides and 16,384 corrected atom environments; larger requests use CPU Workers. The one-million-edge output limit applies to both backends. Unavailable adapters, device limits and unsuitable precision also trigger CPU fallback. Cancel stops the calculation rather than starting a replacement CPU job.

GPU preparation and graph readback contribute to elapsed time, so speed depends on the structure and device. See [performance](performance.md) for the switch, frame cache and benchmark commands.

## Implementation

[Periodic bond graph](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/bonds.js), [GPU bond graph](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/gpu/bonds.js), [bond and arrow primitives](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/atom-primitives.js).
