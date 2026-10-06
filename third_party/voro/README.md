# Voro++ cell kernel

The unmodified cell and common sources are from
[chr1shr/voro](https://github.com/chr1shr/voro), commit
`b0dac575a47af0f90b5b100e6dc199a493c7cb83`.
`SHA256SUMS` pins every upstream source and its license.

Voro++ is BSD licensed; retain [LICENSE](LICENSE). The same license is included
in the distributed site as [licenses/Voro-BSD.txt](../../licenses/Voro-BSD.txt).
No OVITO package or runtime is used.

AlloyView compiles only the independent convex-cell kernel, rather than a
Voro++ container. The existing fractional linked-cell search supplies periodic
images for arbitrary triclinic cells and mixed boundary conditions. Each Worker
keeps its Wasm module, cell object, and growing buffers for later analyses.
Run `bash wasm/build-voronoi.sh` to rebuild the committed browser module.
