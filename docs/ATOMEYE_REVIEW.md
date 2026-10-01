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
implements that ABI independently. The Web Worker first attempts the optional
Wasm module and otherwise executes the code-equivalent JavaScript kernel.

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
