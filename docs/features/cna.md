# Common neighbor analysis

## Controls

Choose adaptive CNA or a fixed cutoff. The result classifies atoms as FCC, HCP, BCC, ICO or Other. Crystal legend checkboxes control display visibility; they do not change the classification calculation.

## Algorithm

CNA builds a local bond graph around each atom. Each center-neighbor pair receives a signature consisting of the common-neighbor count, number of bonds among those neighbors, and longest connected bond-chain size.

| Structure | Required local signatures |
| --- | --- |
| FCC | Twelve 421 pairs |
| HCP | Six 421 and six 422 pairs |
| BCC | Eight 666 and six 444 pairs |
| ICO | Twelve 555 pairs |

Fixed CNA requires exactly 12 or 14 neighbors inside the supplied cutoff. Adaptive CNA first tests the closest 12 atoms with cutoff `mean(r₁…r₁₂) × (1 + √2)/2`, then tests the 14-neighbor BCC environment with a shell-dependent scale. Neighbor-neighbor bonds use local displacement vectors without a second periodic wrapping step.

Other includes defective, surface, disordered or unsupported environments. CNA describes local geometry; it does not identify chemical ordering or uniquely determine crystal orientation.

## Implementation

[CNA signatures and adaptive shells](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/cna.js), [periodic neighbor search](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/neighbors.js). The [analysis implementation guide](../STRUCTURE_ANALYSIS.md) contains the full shell formulas and references.
