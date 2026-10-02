# AtomEye source review

Review date: 2026-10-01  
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

The first AlloyView release deliberately uses one Web Worker. Worker pools or
Wasm pthreads should be added only after browser profiling shows that analysis,
rather than text parsing, transfer, or rendering, is the limiting stage.

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
| Coordination number and histogram | `A3/geo.c` builds `coordination[]` from `N`; `A3/info.c` prints the histogram; `A3/utils.c` colors by coordination. | **Implemented independently.** AlloyView uses the same neighbor-list invariant with an explicit uniform cutoff, triclinic minimum images, a Worker pool, scalar coloring, and live range filtering. A histogram UI remains small follow-up work. |
| Central-symmetry parameter | `A3/geo.c:evaluate_central_symm()` creates a non-pairwise image list and pairs the nearest even number of displacement vectors in `compute_central_symm()`. | **Good next candidate.** It can reuse AlloyView's neighbor search, but the UI must expose the even neighbor count and document AtomEye's normalized result rather than silently calling it the conventional unnormalized CSP. |
| Local geometric shear measure | `A3/geo.c:evaluate_shear_strain()` selects the modal coordination shell, accumulates a local metric tensor, and reduces it to a Mises invariant, optionally subtracting the mean tensor. | **Migratable with care.** It is a single-frame geometric disorder/shear measure, not the same calculation as reference-frame atomic strain. It needs a separately named module and validation fixtures. |
| Reference-frame least-squares deformation and strain | `Atoms/LeastSquareStrain.c:ComputeLeastSquareDeformationGradient()` and `A3/LeastSquareStrain.c:LeastSquareStrain_Append()` produce `eta_Mises`, `eta_hydro`, and nine `J` components from an imprinted isoatomic reference. | **High-value sequence feature.** Stable IDs, a chosen reference frame, PBC-aware neighbor correspondence, and singular-fit reporting are required. AlloyView's trajectory-level analysis state is now designed to hold such a reference. |
| Partial radial distribution functions, `g(r)` | `Atoms/Gr.c` owns species-pair cutoffs, meshes, accumulation, normalization, and save logic. | **Straightforward global analysis.** Implement a Worker histogram returning species-pair curves; replace `FILE*`/Matlab output with typed arrays and a browser plot/export. It is global rather than per-atom coloring. |
| Pair cutoffs, neighbor/bond graph, and coordination-based visibility | `Atoms/Neighborlist.c`, `A3/rcut_patch.c`, and `A3/utils.c` maintain species-pair cutoffs and bond/coordination display state. | **Useful shared infrastructure.** Generalize the current single-cutoff neighbor interface to a pair matrix, then reuse it for bonds, coordination, CSP, and strain. Rendering bonds should remain a WebGL concern. |
| Auxiliary scalar coloring and thresholds | `A3/A.c` and `A3/utils.c` select auxiliary arrays, colormaps, saturation, and visibility thresholds. | **Implemented in browser form.** CFG/dump scalar properties share a jet map, persistent live limits, and optional out-of-range hiding. |
| Distance, bond-angle, and local atom inquiry | `doc/atomeye.html` and the A3 interaction paths expose atom/bond information and geometric queries. | **Easy UI addition.** Picking already preserves atom IDs across frames; multi-selection and a small measurement overlay are needed. |
| Vector-field arrows | Upstream README documents `draw_arrows` for consecutive auxiliary triplets and overlays. | **Rendering feature, not an analysis kernel.** Suitable after vector-property parsing is made explicit. |
| Voronoi grain construction | `Atoms/Voronoi.c` rotates/cuts copies around seed sites to generate polycrystals and removes close GB atoms. | **Do not mislabel as Voronoi analysis.** It is a structure-construction tool, not per-atom Voronoi volume/index computation. It belongs in a future builder module, if at all. |

Recommended order is: shared pair-cutoff neighbor graph → coordination histogram
and bonds → normalized central symmetry → reference-frame least-squares strain →
partial `g(r)`. The first three reuse the current frame-local data contract;
least-squares strain is the first feature that needs persistent cross-frame
reference state.
