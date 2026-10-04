# Ideal lattice strain

## Controls

For each atom type, choose the element and reference crystal, then set the ideal lattice parameter `a` in Å. Hexagonal references also require `c`. Element presets are editable starting values; numeric LAMMPS type labels do not imply an element.

## Algorithm

The analysis uses PTM neighbor correspondence and restores the absolute ideal lattice scale that the template fit normalizes away. Independent hexagonal `a` and `c` scaling is preserved. The resulting deformation gradient `F` gives

- Green–Lagrange strain: `E = (FᵀF − I)/2`.
- Hydrostatic strain: `tr(E)/3`.
- Shear strain: `sqrt(dev(E) : dev(E)/2)`.
- Physical volume change: `det(F) − 1`.

Tensor components are expressed in the local crystal reference axes, whose symmetry-equivalent orientation can vary between atoms. Uniform lattice expansion is retained. Absolute values below `10⁻¹²` are treated as numerical zero.

The phase must match its selected reference and pass the fit tolerance. Unsupported or invalid fits remain NaN. This measures local elastic deformation relative to an ideal lattice, including thermal displacements. It does not use another trajectory frame or calculate non-affine D²min.

## Implementation

[Ideal lattice strain](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/atomic-strain.js), [lattice presets](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/lattice.js), [analysis implementation guide](../STRUCTURE_ANALYSIS.md).
