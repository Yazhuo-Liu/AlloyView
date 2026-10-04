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

## GPU computing

**Enable GPU computing** is off by default. When enabled, ideal lattice strain uses the GPU for the tensor and invariant calculations. PTM correspondence fitting still runs in the CPU WebAssembly Workers. A fresh calculation fits PTM once, then evaluates the nine strain fields on GPU; a compatible cached PTM fit goes directly to that tensor stage. Editing the lattice reference can reuse its geometric fit.

The engine label identifies both stages, for example `ptm-wasm-worker+webgpu-strain-tensor`. The GPU retains high and low parts of the Float64 fit data and reference factors during matrix arithmetic, preserving the numerical-zero convention for ideal crystals. The returned fields remain Float32, and the editable element-specific `a` and hexagonal `c` parameters apply to both backends.

Atoms that do not match their reference remain NaN without an unmatched-atom warning. If WebGPU, memory or the supported precision range is unavailable, the tensor stage uses CPU Workers and reuses any completed PTM fit. Cancel ends the job without requesting CPU fallback. See [performance](performance.md) for initialization, caching and timing limits; moving the tensor stage does not make PTM fitting a GPU algorithm.

## Implementation

[Ideal lattice strain](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/atomic-strain.js), [GPU strain tensor](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/gpu/atomic-strain.js), [lattice presets](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/lattice.js), [analysis implementation guide](../STRUCTURE_ANALYSIS.md).
