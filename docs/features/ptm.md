# Polyhedral template matching

## Controls

Select template candidates and set a nonnegative RMSD threshold. FCC, HCP, BCC, ICO and SC are enabled by default; diamond, hexagonal diamond and graphene require additional shells and are optional. A threshold of zero disables RMSD rejection.

## Algorithm

PTM compares local neighbor topology and geometry with ideal crystal templates. The compiled WebAssembly kernel searches candidate correspondences and determines a best fit while accounting for orientation and scale. AlloyView exposes the chosen structure, fit RMSD and nearest-neighbor distance. Fits above the threshold are classified as Other; diagnostic RMSD remains available while rejected deformation fits are undefined.

The geometric fit can be reused by ideal lattice strain when template candidates and RMSD parameters match. A strain-only fit does not enable PTM display properties. Cancellation of one analysis does not automatically cancel an independent consumer of the fit.

Identification depends on enabled templates, local disorder and RMSD tolerance. A recognized crystal template does not establish composition, chemical ordering or a stress-free reference lattice.

## Implementation

[PTM wrapper and template parameters](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/ptm.js), [compiled kernel loader](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/ptm-kernel.mjs), [analysis implementation guide](../STRUCTURE_ANALYSIS.md).
