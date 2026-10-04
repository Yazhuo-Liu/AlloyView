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

## GPU computing

With **Enable GPU computing** on, both adaptive and fixed-cutoff CNA can run through WebGPU. The chosen shell convention, crystal labels, colors and visibility controls are the same as on CPU. GPU computing is off by default; unavailable or unsupported GPU execution falls back to the CPU Worker implementation. Switching the preference preserves completed results; click **Identify structure** again to calculate with the new preference.

The GPU traverses linked-cell neighbors, keeps distinct periodic images and builds each atom's local common-neighbor graph. Fixed mode uses the supplied cutoff. Adaptive mode expands the search radius until its nearest-neighbor shell is complete, then evaluates the same twelve- and fourteen-neighbor shell formulas described above. Shell selection and graph classification run on the GPU; this includes adaptive CNA.

Near a floating-point boundary, a cutoff, shell membership or neighbor-neighbor bond can be ambiguous. Those individual environments receive an exact CPU correction so the discrete crystal labels retain the CPU convention. This correction is bounded to 16,384 atoms. The GPU search also limits each atom to 50,000 image candidates and adaptive search to 24 radius attempts. Exceeding these limits, the geometry limits or available device memory uses the complete CPU calculation instead of returning an approximate classification. See [performance](performance.md) for shared input caching and timing considerations.

## Implementation

[CNA signatures and adaptive shells](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/cna.js), [periodic neighbor search](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/neighbors.js), [GPU CNA](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/gpu/cna.js), [CNA compute shaders](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/gpu/cna-shaders.js). The [analysis implementation guide](../STRUCTURE_ANALYSIS.md) contains the full shell formulas and references.
