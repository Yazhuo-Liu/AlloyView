# AlloyView documentation

AlloyView opens atomistic structures, renders them with WebGL 2, and performs local structural analyses in browser Workers. Files stay on your device. The documentation covers the controls, the numerical definitions of each result, and the code that implements them.

## Start with a structure

Open a CFG, LAMMPS text dump, XYZ or PDB file using **Open local**, or drop a file onto the viewer. Open a numbered sequence with **Choose files** or **Choose folder**. The **×** beside the structure name closes the source and returns to the homepage.

The [user guide](USER_GUIDE.md) describes the full workflow; [file formats](FORMATS.md) lists coordinate, cell and property conventions. Configuration import/export is always available directly below the structure summary.

## Explore a feature

Each detailed settings heading has a **?**: hover or focus it for a brief explanation, or click it to open the corresponding page. Feature pages contain controls, algorithms, practical interpretation and implementation links.

| Task | Documentation |
| --- | --- |
| Adjust the view or compare two cameras | [Display](features/display.md) |
| Show or analyze periodic copies, or clip the view | [Replicate](features/replicate.md), [Slices](features/slices.md) |
| Select, color or hide atom groups | [Atom selections](features/selection-groups.md) |
| Draw neighbor bonds or vectors | [Bonds](features/bonds.md), [Vector arrows](features/vectors.md) |
| Measure bond lengths, angles and local orientational order | [Bond distributions and Q4/Q6](features/bond-statistics.md) |
| Inspect atomic volumes and face geometry | [Voronoi analysis](features/voronoi.md) |
| Attach numeric data from separate atom files | [External properties](features/external-properties.md) |
| Measure motion against a trajectory frame | [Displacement](features/displacement.md) |
| Count and classify neighbor environments | [Coordination](features/coordination.md), [CNA](features/cna.md), [PTM](features/ptm.md) |
| Inspect disorder and deformation | [Central symmetry](features/centrosymmetry.md), [Ideal lattice strain](features/ideal-strain.md), [Reference frame strain](features/reference-strain.md), [Local shear](features/local-shear.md) |
| Extract and display dislocation networks | [Dislocation analysis (DXA)](features/dislocations.md) |
| Measure geometry and distributions | [Atom details](features/selection.md), [Statistics and RDF](features/statistics.md) |
| Save settings and export figures | [Configuration](features/configuration.md), [Display exports](features/display.md#image-and-trajectory-exports) |

## Understand and verify the implementation

[Analysis implementation](STRUCTURE_ANALYSIS.md) explains crystal classification, ideal lattice strain and the Worker scheduler. [Validation](VALIDATION.md) describes tests and comparisons. [Deployment](DEPLOYMENT.md) explains the static build, including these documentation pages.

[DXA implementation review](DXA_REVIEW.md) records the source, licensing and
CPU/Wasm and WebGPU design. The initial DXA tool uses the CPU/Wasm core; GPU
migration and broader scientific validation remain future work.

The source is available in the [GitHub repository](https://github.com/Yazhuo-Liu/AlloyView). AlloyView is inspired by [OVITO](https://www.ovito.org/) and [AtomEye](http://li.mit.edu/Archive/Graphics/A/).
