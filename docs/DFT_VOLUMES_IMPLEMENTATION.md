# DFT volumes and crystallography implementation

## Scope and baseline

Started from `1f480d7` after fetching the latest remote. That version already
provided CIF/POSCAR structures and coordination polyhedra. This continuation
adds scalar-volume visualization, actual global space-group analysis and
anisotropic thermal ellipsoids. It does not claim full VESTA feature parity.

## Implementation choices

| Area | Delivered behavior | Calculation and reuse |
| --- | --- | --- |
| Volume import | CHGCAR/CHG, LOCPOT, ELFCAR, Gaussian Cube; multiple spin/orbital fields; gzip | Cooperative Float64 parsing in existing parser Workers; bounded samples and decoded text; scalar buffers transferred by ownership |
| Physical meaning | CHGCAR normalized to e/Å³ and electron integral; LOCPOT eV; dimensionless ELF; Cube unit remains explicit | VASP x-fastest and Cube z-fastest layouts converted to one grid convention; origin, skew vectors, periodic/open boundaries preserved |
| Isosurfaces | Consistent marching tetrahedra on CPU and WebGPU, signed isovalues, explicit output limits | Retained CPU Workers share CpuBudget; immutable private/shared snapshots; WebGPU pipelines/grid uploads reused; unsafe precision falls back to CPU |
| Numerical sections | Grid-axis section, interpolation, heatmap/probe and full-resolution CSV | Numerical values and Cartesian coordinates kept separate from bounded screen preview; CSV formatting in retained Worker |
| Volume rendering | Lit translucent surface; origin, replicas, slices, second view and PNG | Existing WebGL 2 renderer; reusable mesh buffers; no WebGPU rendering requirement |
| Real replication | Scalar periodic grids expand with physically replicated atoms | Intensive values and sample spacing unchanged; integrated quantities scale with the repeated volume; memory checked before allocation |
| CIF space groups | Declared settings resolved from all 530 Hall settings and 230 ordinary group types | Generated static database from pinned official moyo WASM; ambiguous settings are rejected instead of guessed |
| Global symmetry | Actual space group, Hall setting, Wyckoff letters and refined primitive/conventional cells | One retained double-precision moyo WASM Worker and shared CPU budget; no local-CNA approximation; separate exports preserve the original source |
| Thermal ellipsoids | CIF anisotropic U/B tensors, symmetry-rotated covariances, probability control and optional display | Parser Worker prepares eigensystems; instanced WebGL rendering reuses atom colors/visibility; exact ellipsoid picking and context restoration |

The library choice is `@spglib/moyo-wasm` **0.21.0** from the spglib organization,
licensed MIT OR Apache-2.0. Original notices, npm integrity, source commit and
vendored-file checksums are recorded in `third_party/moyo/`. Native source is not
downloaded or compiled when the viewer loads. Marching tetrahedra and ellipsoid
math are original implementations of published algorithms, not copied VESTA code.

## Scientific and lifecycle review

- File classification initially confused a numeric XYZ header with Cube. The
  Cube detector now requires consistent unit signs, a nonsingular voxel basis
  and a plausible atom row. A renamed oversized VASP grid must report a grid
  limit rather than silently load only its atoms.
- Grid replication was explicitly integrated with physical atom replication.
  Leaving the original grid attached to an expanded atom cell was rejected as
  an inconsistent scientific representation.
- CPU and GPU periodic terminal voxels use wrapped sample indices with
  continuous geometric coordinates. Open Cube boundaries never acquire an
  artificial periodic neighbor. Degenerate level ties and inadequate GPU
  scalar/geometric precision trigger explicit CPU recovery.
- A continuity audit found opposite edge interpolation directions could yield
  slightly different coordinates for the same crossing. Canonical endpoint
  ordering now makes shared vertices identical. CPU and actual GPU closed-sphere
  tests require two triangles per edge, outward normals and Euler characteristic
  two, including levels passing exactly through grid nodes.
- GPU-off waits for accepted work before releasing the volume device and
  uploads. Source clearing drops grid ownership while retaining reusable
  Workers and native modules. Cancellation waits for acknowledgement before
  releasing occupied CPU permits; no cancelled job restarts on CPU.
- Actual symmetry analysis accepts ordered fully occupied periodic structures.
  Refined output may move atoms within the specified tolerance and has newly
  generated IDs. It does not invent mappings for source ADPs or properties.
  Source and tolerance edits invalidate pending standardized-cell downloads.
- Synthetic examples identify their analytic origin. They are demonstrations,
  not fabricated DFT or experimental results.

## Validation

Scientific tests cover grid ordering and unit conversions, spin/augmentation
records, skew periodic seams, open boundaries, affine scalar fields, signed
levels, source-preserving transfers and replication, copied/shared parallel
workers, cancellation, output caps and device failure recovery. Symmetry tests
exercise every generated Hall setting and actual FCC/BCC/HCP/diamond/SC and
zincblende recognition, tolerance sensitivity and standardized-cell round trips.
Thermal tests cover tensor conversion, symmetry rotations, probability scaling,
eigengeometry, CIF round trips, visibility, exact picking and context recovery.

The real Chromium WebGPU test compares 12 CPU/GPU geometric cases, two required
precision fallbacks and the retained Worker route. The app test loads the
synthetic CHGCAR through the normal chooser: both backends produce 5,040
triangles; surface areas are 20.227943246948055 and 20.227942957485215 Å².
It checks actual pixels, style buffer reuse, a 1,024-row section CSV, second-view
PNG, negative Cube contours and source resets. This environment uses a software
GPU adapter; these checks establish correctness, not hardware speedup.

Reproducible commands are `npm test`, `npm run build`,
`npm run test:gpu:volumetric`, `npm run test:browser:volumetric`,
`npm run test:browser:crystal-symmetry`, `npm run test:browser:thermal`, and
the previous `npm run test:browser:crystal` regression.

Final verification on Node 24: **2,682 tests passed, 0 failed, skipped or
cancelled**. The static build, all three new production UI browser checks,
the actual WebGPU scientific/lifecycle checks and the previous Crystal browser
regression passed. A documentation link to a repository-only provenance file
was changed to its GitHub URL after the documentation checker caught the missing
published page. Vendored WASM, glue and database SHA256 checks all passed.

## Remaining scope

Arbitrary oblique volume sections, simultaneous multiple isosurfaces, grid
arithmetic, diffraction/morphology, XDATCAR and additional DFT file formats are
not part of this increment. Global symmetry remains CPU WASM; the new
coordination-polyhedron hull path also remains parallel CPU. WebGPU accelerates
the newly added isosurface extraction, while WebGL renders all new displays.

Powder X-ray diffraction was subsequently implemented; see the
[diffraction implementation record](DIFFRACTION_IMPLEMENTATION.md).

User documentation: [Volumetric data](features/volumetric.md),
[Crystal structures](features/crystal.md), [File formats](FORMATS.md).
