# AtomEye source review

Review date: 2026-10-01  
Browser migration status updated: 2026-10-03
Upstream: <https://github.com/jameskermode/AtomEye>  
Pinned commit: `c418eb2553f6793460d4a956236fc698c39fbe74`

The AlloyView repository initially contained only an 86-byte README and an MIT
license. It did not contain AtomEye, build files, or application code, so the
upstream snapshot above was cloned to a temporary review directory and was not
vendored.

## Code map and evidence

| Concern | Upstream evidence | Finding |
| --- | --- | --- |
| Configuration data | `Atoms/Atoms.h` (`Aapp_Declare_Config`, `Neighborlist`) and `Atoms/Atoms.c` | Coordinates are primarily stored as reduced/fractional `s`; `H` maps row-vector coordinates using `x = s * H`. Chemical tables, masses, symbols, auxiliary arrays, and neighbor lists are global/macro-heavy rather than an isolated value type. |
| CFG parsing | `Atoms/Config.c:2386-2720` | `Config_load()` recognizes `Number of particles`, `A`, `H0`, `Transform`, `eta`, `.NO_VELOCITY.`, `entry_count`, and `auxiliary[]`. It supports basic rows and extended species/mass singleton blocks. |
| Other file I/O | `Atoms/Config.c`, `Atoms/VASP.c`, `Atoms/Dacapo.c`, optional `HAVE_LIBATOMS`/NetCDF paths | File access is based on `FILE*`, filename dispatch, global buffers, and optional native libraries. The reviewed source does not contain a LAMMPS text-dump parser. |
| Neighbor search | `Atoms/Neighborlist.c:53-411`, declarations and form in `Atoms/Atoms.h:1061-1194` | It constructs bin–bin, bin–atom, and compressed atom–atom lists in reduced coordinates. Bin counts use cell row thicknesses; bin neighborhoods wrap in PBC; pair distances use an image operation then `ds * H`. Reusable lists add anchor/tether maintenance. |
| Analysis | `A3/geo.c`, `A3/LeastSquareStrain.c`, `Atoms/LeastSquareStrain.c`, `Atoms/Voronoi.c`, `Atoms/Gr.c` | Coordination coloring, central symmetry, strain, Voronoi, and radial-distribution functionality are spread across the viewer and Atoms library. Several paths consume the global neighbor list directly. |
| Rendering | `AX/3D.c`, `AX/Scan3D.c`, `AX/pixel.c`, and `A3/A.c:52-140` | `paint_scene()` performs software ball/cylinder depth passes into AX pixel/Z buffers and draws cell/filter lines. AX is an X11/shared-memory graphics library, not a portable OpenGL/WebGL renderer. |
| Interaction | `A3/A.c:142-780` and `A3/A.c:782-936`; `A3/cui*.c` | X11 key/mouse events mutate the global `Navigator` state. `thread_start()` opens a window, blocks on its event queue, calls `paint_scene()`, and presents the AX buffer. |
| Native dependencies | `Makefile.atomeye`, `Makefile.config`, `A3/Makefile`, subdirectory Makefiles | Default links include X11/Xext/Xpm, png/jpeg/zlib, readline/history/ncurses, curl, NetCDF/HDF5 (configuration-dependent), LAPACK/BLAS, pthreads, and platform system libraries. The Python bridge also needs Python, NumPy, and libatoms/QUIP. |

## What can become Wasm

The numeric kernels are plausible Wasm candidates only after isolation:

- row-vector/cell math from `VecMat` and `VecMat3`;
- the disposable linked-cell portion of `Atoms/Neighborlist.c`;
- selected geometry analyses that accept plain arrays and return plain arrays;
- the pure parts of CFG parsing after replacing `FILE*`, fatal `pe()` exits,
  global configuration macros, and native compression/file helpers.

Compiling the complete tree unchanged is not credible. `AX` and the viewer event
loop require X11 and shared-memory window resources; file/terminal modules use
native process, terminal, and filesystem APIs; optional readers pull in NetCDF,
HDF5, QUIP/libatoms, curl, and Fortran/LAPACK pieces. Emscripten can emulate some
POSIX APIs, but that would preserve the wrong desktop boundary and add large,
unnecessary dependencies.

AlloyView therefore uses a narrow compute contract: typed arrays for fractional
coordinates and a 3×3 cell in, typed per-atom results out. `wasm/coordination.cpp`
implements that ABI independently. The interactive application currently uses
the range-partitionable JavaScript kernel so large frames can be split across a
Worker pool. The optional single-call Wasm ABI remains an experimental build
target; it needs a ranged entry point before it can replace pooled tasks without
silently returning to one core.

## Actual parallel mechanisms in this snapshot

The snapshot is not simply “single-threaded,” but its concurrency must be
described precisely:

- `A3/A.c` and `A/A.c` call `pthread_create()` when opening another view. Each
  `thread_start()` owns a window/event loop and calls the whole `paint_scene()`
  sequence. This is window-level concurrency; the code does not divide one
  WebGL/AX frame across pthread workers.
- `A3/A.c` defines a global mutex for the library build. This is synchronization,
  not evidence of parallel rendering.
- `A3/p3dp.c` and `A3/P3DCore.c` contain an MPI/P3D domain-decomposition path,
  including distributed neighbor construction and Z-buffer reduction. However,
  the P3D objects are commented out of the default `A3/Makefile` object list, so
  this is an optional/non-default build path in the reviewed commit.
- No OpenMP pragmas or `omp_*` calls were found in the application/analysis
  sources. A `-lgomp` occurrence in a special static macOS link recipe does not
  by itself make these C loops OpenMP-parallel.

The initial AlloyView release used one Web Worker. The current analysis modules
share a bounded Worker pool with independent atom ranges; PTM uses a separate
Wasm instance per Worker. Parsing and WebGL rendering remain distinct stages.
Wasm pthreads would require separate profiling and hosting changes.

## License and distribution finding

The upstream root has no `LICENSE`/`COPYING` file. Its README credits Ju Li and
James Kermode but does not grant general permission to modify or redistribute.
`Python/atomeyemodule.c:1-13` explicitly places only “these portions” under
GPLv2. Native dependencies have their own terms. Public download and free use do
not create a redistribution license.

Conclusion: the reviewed snapshot is useful as a behavioral and architectural
reference, but copying its C code into an MIT browser bundle is not justified by
the repository evidence. AlloyView retains attribution and the pinned review,
implements interoperable behavior independently, and leaves direct source reuse
blocked pending written license clarification. This is not legal advice.

## Reuse / adapt / replace decision

- **Reuse now:** file conventions, coordinate semantics, algorithmic invariants,
  sample-based comparisons, and citations—without copying implementation text.
- **Adapt through a narrow ABI after clearance:** disposable neighbor-list and
  selected defect-analysis kernels; remove global state, `FILE*`, and fatal exits.
- **Replace:** AX/X11 renderer with WebGL 2 instanced impostors; X11/CUI controls
  with DOM/pointer controls; native file I/O with `File`, `Blob.slice()`, and
  Workers; process/MPI orchestration with browser task boundaries.

## Analysis migration inventory

This list is limited to functionality evidenced in the pinned upstream commit.
It deliberately does not attribute CNA from unrelated AtomEye forks, nor DXA or
PTM, to this source tree.

| Upstream feature | Code evidence | Browser migration assessment |
| --- | --- | --- |
| Coordination number and histogram | `A3/geo.c` builds `coordination[]` from `N`; `A3/info.c` prints the histogram; `A3/utils.c` colors by coordination. | **Implemented independently.** Uniform-cutoff, triclinic-safe distinct-ID coordination runs in the Worker pool. The Statistics panel adds distribution and mean displays. |
| Central-symmetry parameter | `A3/geo.c:evaluate_central_symm()` creates a non-pairwise image list and pairs the nearest even number of displacement vectors in `compute_central_symm()`. | **Implemented independently.** Normalized results use manual 8/12 neighbors or adaptive-CNA Auto settings per atom for mixed FCC/HCP/BCC. Ideal HCP's finite baseline is retained. See [Structure analysis](STRUCTURE_ANALYSIS.md). |
| Local geometric shear measure | `A3/geo.c:evaluate_shear_strain()` selects the modal coordination shell, accumulates a local metric tensor, and reduces it to a Mises invariant, optionally subtracting the mean tensor. | **Implemented independently.** The separate Local shear tool partitions coordination, metric accumulation and final reduction across the shared pool, with global normalization and optional mean-tensor subtraction. It measures single-frame neighbor geometry. |
| Reference-frame least-squares deformation and strain | `Atoms/LeastSquareStrain.c:ComputeLeastSquareDeformationGradient()` and `A3/LeastSquareStrain.c:LeastSquareStrain_Append()` produce `eta_Mises`, `eta_hydro`, and nine `J` components from an imprinted isoatomic reference. | **Implemented independently.** A chosen trajectory frame and explicit stable IDs define PBC-aware correspondence. Parallel local least-squares fits return Green–Lagrange strain, volume change and all nine deformation-gradient components. Missing/singular/inverted fits become NaN without defect-count warnings. |
| Partial radial distribution functions, `g(r)` | `Atoms/Gr.c` owns species-pair cutoffs, meshes, accumulation, normalization, and save logic. | **Implemented independently.** Worker histograms combine into total or element-pair curves and CSV output. Normalization uses exact spherical shells and finite populations; it requires all three periodic axes and a cutoff no greater than half the shortest cell face height. This upstream evidence is in the numerical library, not necessarily a viewer panel. |
| Pair cutoffs, neighbor/bond graph, and coordination-based visibility | `Atoms/Neighborlist.c`, `A3/rcut_patch.c`, and `A3/utils.c` maintain species-pair cutoffs and bond/coordination display state. | **Implemented independently for bonds.** Worker-built graphs support element-pair cutoff overrides and periodic images; WebGL instanced cylinders reuse the source graph under display replication. The original coordination tool retains its separate uniform-cutoff, distinct-ID convention. |
| Auxiliary scalar coloring and thresholds | `A3/A.c` and `A3/utils.c` select auxiliary arrays, colormaps, saturation, and visibility thresholds. | **Implemented in browser form.** Numeric source/analysis properties share ten color maps, per-property Auto/fixed limits, and optional out-of-range hiding. |
| Distance, bond-angle, dihedral, and local atom inquiry | `doc/atomeye.html` and `A3/info.c` document last-2/3/4 atom geometric queries. | **Implemented independently.** Multi-picking measures distance, angle and dihedral with selectable periodic-image treatment. Atom ID lookup, camera centering and single-atom appearance overrides extend the existing inquiry panel. |
| Vector-field arrows | Upstream README documents `draw_arrows` for consecutive auxiliary triplets and overlays. | **Implemented independently for one field.** Displacement follows stable IDs and a chosen reference frame; force/velocity use imported vector families, and custom XYZ has per-axis scales. Arrows support anchoring, linked/independent dimensions and 3D or camera-facing 2D geometry. Multiple simultaneous overlays remain a gap. |
| Voronoi grain construction | `Atoms/Voronoi.c` rotates/cuts copies around seed sites to generate polycrystals and removes close GB atoms. | **Do not mislabel as Voronoi analysis.** It is a structure-construction tool, not per-atom Voronoi volume/index computation. It belongs in a future builder module, if at all. |

Normalized central symmetry, independently implemented adaptive/fixed CNA,
real PTM and ideal-reference atomic elastic strain now share the bounded analysis
scheduler with coordination. CNA and PTM are OVITO-style additions rather than
functionality found in this AtomEye snapshot. PTM's ideal-lattice strain includes
editable element defaults and absolute expansion; it does not implement
AtomEye's imprinted reference-frame calculation; the separate Frame strain
module now implements that workflow independently. Bonds, local geometric shear,
reference-frame strain and RDF use the existing shared Worker scheduler, rather
than creating separate analysis pools. Rendering-only operations and 2/3/4-atom
measurements reuse existing arrays and do not need parallel neighbor work.
Actual PTM library integration is
documented separately in [Structure analysis](STRUCTURE_ANALYSIS.md).

## Viewer workflow migration and remaining gaps

| Upstream workflow | Browser status |
| --- | --- |
| Extended XYZ and PDB input; optional NetCDF | Plain/Extended XYZ and fixed-width PDB, including indexed trajectories and numbered sequences, are implemented independently. NetCDF remains unsupported. |
| Element/single-atom colors, radii and hiding | Editable type and atom overrides are implemented and saved in recipes. External color/radius-file import and color tiling blocks remain unsupported. |
| Find an atom and anchor the camera | ID lookup and selected-atom camera centering are implemented. Crystal-origin manipulation and the native command interface are not reproduced. |
| Multiple viewports | An optional simultaneous second view shares frame/results with an independent camera, and six-view PNG contact sheets provide export. This is not the native arbitrary-window/thread model. |
| Screenshots and animation scripts | PNG/JPG and cancellable selected-frame PNG ZIP export are implemented. JSON recipes restore processing, but do not interpret arbitrary AtomEye commands or encode movies. |
| Save atom indices | Visible source-ID list export is implemented; display replicas do not duplicate IDs. |
| Python/ASE/Jupyter bridge and live reload of growing trajectories | Not implemented; selected browser File objects remain static local inputs. |
| Structure construction and native file tools | Voronoi polycrystal construction, full native format coverage, and processed-coordinate export remain future work. |

The browser's source-sized analyses always precede display replication. All
heavy additions use the bounded shared pool, retain frame results and expose
cancel/reset controls. This parallel design does not imply that very large
graphs or million-atom frames have been benchmarked on target devices.
