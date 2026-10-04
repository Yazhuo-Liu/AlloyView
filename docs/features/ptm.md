# Polyhedral template matching

## Controls

Select template candidates and set a nonnegative RMSD threshold. FCC, HCP, BCC, ICO and SC are enabled by default; diamond, hexagonal diamond and graphene require additional shells and are optional. A threshold of zero disables RMSD rejection.

## Algorithm

PTM compares local neighbor topology and geometry with ideal crystal templates. The compiled WebAssembly kernel searches candidate correspondences and determines a best fit while accounting for orientation and scale. AlloyView exposes the chosen structure, fit RMSD and nearest-neighbor distance. Fits above the threshold are classified as Other; diagnostic RMSD remains available while rejected deformation fits are undefined.

The geometric fit can be reused by ideal lattice strain when template candidates and RMSD parameters match. A strain-only fit does not enable PTM display properties. Cancellation of one analysis does not automatically cancel an independent consumer of the fit.

Identification depends on enabled templates, local disorder and RMSD tolerance. A recognized crystal template does not establish composition, chemical ordering or a stress-free reference lattice.

## Use in ideal lattice strain

Standalone PTM uses CPU neighbor search and WebAssembly fitting. With **Enable GPU acceleration** on, fresh [ideal lattice strain](ideal-strain.md) uses a hybrid fit: WebGPU prepares each atom's nearest 18 source indices and Float64 Cartesian image vectors, then the existing CPU WebAssembly kernel performs Voronoi ordering, topology and template correspondence fitting. The GPU neighbor shader preserves strict IEEE64 distance/vector ordering through integer arithmetic. It reuses resident frame coordinates and the linked-cell index; this accelerates neighbor preparation when the adapter and workload favor it, while fitting remains CPU work.

Neighbor results are read back in batches of at most 16,384 atoms. The complete host table uses 505 bytes per atom and is bounded to 256 MiB, roughly 531,000 atoms. Diamond and graphene templates require the complete table because fitting also queries neighboring atoms; ordinary templates can supply each CPU Worker with its own central range. Unsupported geometry, device limits or table size use the existing CPU neighbor search. Cancellation stops preparation and fitting without starting fallback work. See [performance](performance.md) for transfer costs and timing limits.

## Implementation

[PTM wrapper and template parameters](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/ptm.js), [GPU neighbor preparation](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/gpu/ptm-neighbors.js), [compiled kernel loader](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/ptm-kernel.mjs), [analysis implementation guide](../STRUCTURE_ANALYSIS.md).
