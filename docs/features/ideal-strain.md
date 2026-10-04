# Ideal lattice strain

## Controls

For each atom type, choose the element and reference crystal, then set the ideal lattice parameter `a` in Å. Hexagonal references also require `c`. Element presets are editable starting values; numeric LAMMPS type labels do not imply an element.

## Algorithm

The analysis uses PTM neighbor correspondence and restores the absolute ideal lattice scale that the template fit normalizes away. Independent hexagonal `a` and `c` scaling is preserved. The resulting deformation gradient `F` gives

- Green–Lagrange strain: `E = (FᵀF − I)/2`.
- Hydrostatic strain: `tr(E)/3`.
- Shear strain: `sqrt(dev(E) : dev(E)/2)`.
- Physical volume change: `det(F) − 1`.

Tensor components are expressed in the local crystal reference axes, whose symmetry-equivalent orientation can vary between atoms. Uniform lattice expansion is retained. Tensor components and volume changes below `10⁻¹²` in absolute magnitude are treated as numerical zero.

The phase must match its selected reference and pass the fit tolerance. Unsupported or invalid fits remain NaN. This measures local elastic deformation relative to an ideal lattice, including thermal displacements. It does not use another trajectory frame or calculate non-affine D²min.

## GPU acceleration

**Enable GPU acceleration** is on by default. A fresh ideal-strain calculation prepares nearest-neighbor inputs on GPU, fits PTM correspondence in CPU WebAssembly Workers, then applies the ideal lattice reference and evaluates the nine strain fields on GPU. A compatible cached PTM fit skips neighbor preparation and fitting. Editing only the element reference, `a` or hexagonal `c` can reuse that geometric fit and its resident GPU upload.

The reference shader selects each atom's element and crystal reference, checks its PTM phase and fit, restores absolute lattice scale with independent hexagonal `a`/`c`, then constructs `F` and the tensor invariants. CPU input preparation packs the original PTM structures, Float64 scales and deformation arrays; it no longer calculates per-atom reference factors or phase decisions. High/low fit and reference components retain precision during compensated matrix arithmetic and preserve the numerical-zero convention for ideal crystals. The returned fields remain Float32.

Atoms that do not match their reference remain NaN without an unmatched-atom warning. The status identifies GPU neighbor preparation, CPU PTM fitting and GPU reference/tensor evaluation. If WebGPU, memory or the supported precision range is unavailable, the affected stage uses CPU Workers and reuses any completed PTM fit. Cancel ends the job without requesting CPU fallback. See [PTM](ptm.md) for neighbor-table limits and [performance](performance.md) for initialization, caching and timing costs.

## Implementation

[Ideal lattice strain](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/atomic-strain.js), [GPU strain tensor](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/gpu/atomic-strain.js), [lattice presets](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/lattice.js), [analysis implementation guide](../STRUCTURE_ANALYSIS.md).
