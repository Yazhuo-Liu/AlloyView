# Central symmetry

## Controls

Choose **Auto**, **12 · FCC/HCP**, or **8 · BCC**. Auto uses local adaptive CNA to select 12 neighbors for FCC/HCP and 8 for BCC. An Other atom can inherit 8 or 12 from a majority vote among its nearest supported neighbors; ties and unsupported environments remain undefined.

## Algorithm

Neighbor displacement vectors are processed in nearest-neighbor order. Each vector is paired once with the unused vector whose sum with it has the smallest squared length. The dimensionless output is

`C = Σ |rᵢ + rⱼ|² / (2 Σ |rᵢ|²)`.

This is AtomEye-style normalized greedy pairing. It differs from a conventional CSP in Å² and from minimum-weight matching. Ideal centrosymmetric environments approach zero; ideal HCP has a finite physical baseline that is retained. Values from different phases are therefore not interchangeable defect thresholds.

Auto also exposes local structure and selected neighbor count as color properties. Inferred defect sites retain their raw Other classification. Undefined values are NaN and appear gray.

## GPU computing

With **Enable GPU computing** on, manual and Auto calculations prefer WebGPU. Nearest-neighbor selection, local Auto shell voting and normalized greedy pairing run on GPU. Auto reuses a compatible complete adaptive-CNA classification or calculates it with the GPU CNA kernel first; fixed-cutoff CNA labels are not a substitute for this local shell classification.

Greedy pairing depends on the exact order of nearly equal neighbor distances and pair costs. The CSP shader emulates IEEE 64-bit arithmetic using integer words to retain the CPU distance/vector ordering and strict pairing comparisons, then returns the same Float32 scalar field. This does not require native GPU float64 support. Integer emulation can be expensive, particularly on a software adapter; compare timings on your device before assuming a speedup. The GPU kernel accepts all even manual counts from 2 to 32; the viewer exposes the usual 8- and 12-neighbor settings. Auto keeps the HCP baseline, raw structure labels, inferred neighbor counts, NaN values and recognition summary described above.

The bounded search allows 50,000 candidate images per atom and up to 24 radius expansions. Unsupported geometry, arithmetic, device or memory limits use the existing CPU calculation. CSP pairing does not substitute a CPU calculation for individual atoms; Auto's preceding CNA stage can apply its own sparse precision corrections. Cancellation stops the calculation instead of starting CPU fallback. See [performance](performance.md) for input reuse, result readback and timing costs.

## Implementation

[Central symmetry and Auto shell selection](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/centrosymmetry.js), [GPU central symmetry](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/gpu/centrosymmetry.js), [GPU pairing shader](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/gpu/centrosymmetry-shaders.js), [analysis implementation guide](../STRUCTURE_ANALYSIS.md).
