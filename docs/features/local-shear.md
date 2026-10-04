# Local shear

## Controls

Set a positive geometric neighbor cutoff. Optionally subtract the mean geometric tensor before calculating the local shear. No reference trajectory frame or ideal lattice is needed.

## Algorithm

The calculation follows AtomEye geometric shear. A first pass obtains the modal coordination count. Each atom then uses at most that many closest neighbors and averages their symmetric Cartesian second-moment tensor `M = mean(r rᵀ)`.

The global normalization is the mean squared neighbor length divided by three, evaluated over complete modal-coordination neighborhoods. Divide `M` by that normalization. When enabled, mean subtraction removes the globally averaged normalized tensor.

For tensor components `(xx, xy, xz, yy, yz, zz)`, the reported invariant is

`0.5 × sqrt(xy² + xz² + yz² + ((xx − yy)² + (xx − zz)² + (yy − zz)²)/6)`.

This measures local neighbor anisotropy relative to a global geometric scale. It differs from strain derived from an ideal lattice or a previous frame. If no valid normalization exists, results are NaN. Surface neighborhoods and the chosen cutoff affect its interpretation.

## Implementation

[Coordination, second moments and shear invariant](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/local-shear.js).
