# Central symmetry

## Controls

Choose **Auto**, **12 · FCC/HCP**, or **8 · BCC**. Auto uses local adaptive CNA to select 12 neighbors for FCC/HCP and 8 for BCC. An Other atom can inherit 8 or 12 from a majority vote among its nearest supported neighbors; ties and unsupported environments remain undefined.

## Algorithm

Neighbor displacement vectors are processed in nearest-neighbor order. Each vector is paired once with the unused vector whose sum with it has the smallest squared length. The dimensionless output is

`C = Σ |rᵢ + rⱼ|² / (2 Σ |rᵢ|²)`.

This is AtomEye-style normalized greedy pairing. It differs from a conventional CSP in Å² and from minimum-weight matching. Ideal centrosymmetric environments approach zero; ideal HCP has a finite physical baseline that is retained. Values from different phases are therefore not interchangeable defect thresholds.

Auto also exposes local structure and selected neighbor count as color properties. Inferred defect sites retain their raw Other classification. Undefined values are NaN and appear gray.

## Implementation

[Central symmetry and Auto shell selection](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/centrosymmetry.js), [analysis implementation guide](../STRUCTURE_ANALYSIS.md).
