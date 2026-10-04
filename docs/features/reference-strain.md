# Reference frame strain

## Controls

Choose a trajectory reference frame and a positive neighbor cutoff. The reference can be an arbitrary configuration with stable explicit atom IDs. Source formats that provide only row-number IDs cannot establish correspondence across different frames.

## Algorithm

Current and reference atoms are mapped by unique integer IDs. Neighbors and cutoff belong to the reference frame. For reference bond vectors `R` and corresponding current bond vectors `r`, the unweighted least-squares fit minimizes `Σ |r − F R|²`.

The solution is `F = (Σ r Rᵀ)(Σ R Rᵀ)⁻¹`. At least three independent directions and an invertible covariance are required. Missing atoms, singular neighborhoods and invalid/negative-volume fits remain NaN. The analysis computes Green–Lagrange tensor `E = (FᵀF − I)/2`, hydrostatic and shear invariants, `det(F) − 1`, and all nine components of `F`.

Periodic relative changes are resolved in the full triclinic metric while retaining the reference bond's lattice image, including distinct images in primitive cells. Reference and current frames must use the same periodic axes. A wrapped trajectory cannot resolve relative slips beyond the nearest reference image.

Reference-frame strain follows observed atom motion and has a different reference from ideal lattice strain. It does not perform a PTM phase classification or report non-affine D²min.

## Implementation

[ID mapping, covariance fit and image handling](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/reference-strain.js).
