# Reference frame strain

## Controls

Choose a trajectory reference frame and a positive neighbor cutoff. The reference can be an arbitrary configuration with stable explicit atom IDs. Source formats that provide only row-number IDs cannot establish correspondence across different frames.

## Algorithm

Current and reference atoms are mapped by unique stable IDs. Neighbors and cutoff belong to the reference frame. For reference bond vectors `R` and corresponding current bond vectors `r`, the unweighted least-squares fit minimizes `Σ |r − F R|²`.

The solution is `F = (Σ r Rᵀ)(Σ R Rᵀ)⁻¹`. At least three independent directions and an invertible covariance are required. Unmatched centers, insufficient matched neighbors, singular neighborhoods and invalid/negative-volume fits remain NaN. The analysis computes Green–Lagrange tensor `E = (FᵀF − I)/2`, hydrostatic and shear invariants, `det(F) − 1`, and all nine components of `F`.

Periodic relative changes are resolved in the full triclinic metric while retaining the reference bond's lattice image, including distinct images in primitive cells. Reference and current frames must use the same periodic axes. A wrapped trajectory cannot resolve relative slips beyond the nearest reference image.

Reference-frame strain follows observed atom motion and has a different reference from ideal lattice strain. It does not perform a PTM phase classification or report non-affine D²min.

## GPU acceleration

With **Enable GPU acceleration** on, reference-frame strain can use WebGPU for its reference-neighbor search, local deformation fit, strain tensor and invariants. Stable atom IDs are matched on CPU before computation; both the current and reference coordinates are prepared and retained during the calculation. Compatible uploaded frames can be reused from the GPU cache. The neighbor cutoff still applies to the reference configuration, including distinct periodic and self images in primitive cells. Undefined fits remain NaN silently.

The GPU accumulates covariance matrices with compensated arithmetic, solves the three-by-three fit and returns the same 18 fields as CPU. High/low coordinate components retain input precision, and the output applies the CPU `1e-12` threshold for numerical zeros. Small floating-point residuals can still occur. Periodic relative changes use the full triclinic closest-image metric while retaining each reference bond's image; independent rounding along fractional axes is insufficient for a skewed cell.

Cutoff boundaries, ambiguous closest images and nearly singular fits receive exact CPU correction for the affected atoms, using one reusable reference-neighbor index. The closest-image GPU search has a 256-candidate bound per relative change; cases outside that bound also receive correction. Each atom can examine at most 50,000 reference image candidates and evaluate at most 50,000 current images on GPU. Corrections are limited to 16,384 atoms, after which the full analysis uses CPU. Unsupported geometry, precision or device-memory requirements likewise use CPU. Cancellation stops the job with the usual reset behavior and does not restart it through fallback.

GPU acceleration is on by default. Switching the preference keeps completed results; calculate again to use the selected backend. See [performance](performance.md) for preparation, caching and timing considerations.

## Implementation

[ID mapping, covariance fit and image handling](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/reference-strain.js), [GPU reference-frame strain](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/gpu/reference-strain.js), [reference-strain compute shaders](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/gpu/reference-strain-shaders.js).
