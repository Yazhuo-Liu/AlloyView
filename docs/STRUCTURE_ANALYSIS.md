# Crystal and defect analysis

## Using the analyses

Load a structure and open **Common neighbor analysis** in the right panel.
**Identify structure** runs adaptive CNA by default and selects **Crystal
structure (CNA)** in **Color by**. No element-specific cutoff is needed in
adaptive mode. **Fixed cutoff CNA** exposes a radius in angstroms: put it
between the first and second shells for FCC/HCP or between the second and
third shells for BCC.

The viewport legend lists every supported class, its atom count and fraction
of the complete input frame. Each checkbox immediately shows/hides that class.
Hidden atoms cannot be picked and are excluded from PNG drawing. Classification
still sees the complete structure: hiding a class, slicing, changing atom size
or moving the camera does not rerun or change the analysis. The filter applies
when coloring by crystal structure; switching to a different color property
temporarily suspends it. Checkbox preferences survive frame changes and
recalculation, and reset when a different source is opened. PNG legends include
counts and mark hidden classes.

Scalar analysis results use a separate legend with ten palettes: AtomEye
rainbow, Viridis, Plasma, Magma, Inferno, Cividis, Turbo, Spectral, Cool–warm
and Grayscale. Highlighted **Auto** fits the range to the current frame.
Turning Auto off freezes the displayed limits; editing either limit also turns
it off. Each property's fixed limits survive trajectory frame changes,
reused results and switching color properties. Clicking Auto again fits the
current frame and resumes automatic limits. Range, palette and outside-range
filter edits do not rerun analysis, and PNG output uses the same legend settings.
Processing configurations preserve the palettes and per-property range mode.

| ID | Class | Environment | Color (OVITO convention) |
| --- | --- | --- | --- |
| 0 | Other | Unrecognized, disordered or defective | White, RGB 242/242/242 |
| 1 | FCC | Face-centered cubic | Green, RGB 102/255/102 |
| 2 | HCP | Hexagonal close-packed | Red, RGB 255/102/102 |
| 3 | BCC | Body-centered cubic | Blue, RGB 102/102/255 |
| 4 | ICO | Icosahedral coordination | Yellow, RGB 242/204/51 |

**Polyhedral template matching** runs the actual PTM C++ library compiled to
WebAssembly inside module Workers. Click **Identify** to select **Crystal
structure (PTM)**. It uses the same legend/filter behavior and OVITO colors,
plus these PTM classes:

| ID | Class | Color |
| --- | --- | --- |
| 5 | SC | Purple, RGB 160/20/254 |
| 6 | Diamond | Blue, RGB 19/160/254 |
| 7 | Hex. diamond | Orange, RGB 254/137/0 |
| 8 | Graphene | Violet, RGB 160/120/254 |

The template checkboxes select candidates for identification. FCC/HCP/BCC/ICO/SC
are enabled by default; diamond/hexagonal diamond/graphene require additional
neighbor shells and are opt-in. The RMSD threshold defaults to 0.1; a best fit
above it is Other. Setting it to 0 disables rejection. PTM also exposes best-fit
RMSD and nearest-neighbor distance (Å) as scalar color properties. Rejected fits
retain diagnostic RMSD but have undefined deformation/distance. The number of
recognized atoms depends on the selected templates, threshold and local disorder.

## Atomic elastic strain

Under **Ideal lattice reference**, each input atom type has an element selector,
reference crystal and editable `a` in Å; HCP and hexagonal diamond also expose
`c`. Recognized source labels initialize presets for 37 elements, including
common FCC/BCC/HCP metals and diamond C/Si/Ge. Numeric types and unsupported
elements have an empty `a` until the user supplies a reference. No element is
inferred from a LAMMPS numeric type ID. **Element defaults** resets values from
the source's element labels. The approximate reference-state numbers are from
[ASE 3.26.0](https://gitlab.com/ase/ase/-/blob/3.26.0/ase/data/__init__.py);
hexagonal `c` is `a × (c/a)`. They are starting values, not stress-free lattice
predictions for an alloy, finite temperature or a particular potential.

**Calculate strain** fits PTM correspondence and computes local elastic strain
relative to that ideal lattice. The selected reference phase is automatically
included in the strain fit even if its PTM template checkbox is off. A previously
calculated PTM result is reused when the template mask and RMSD threshold match.
Editing only the lattice reference reuses its geometry fit. An explicitly
restricted PTM display keeps its own selected classification.

PTM removes scale during template fitting. AlloyView restores the absolute
reference lattice scale before calculating the deformation gradient `F`,
including independent hexagonal `a`/`c` scaling. Therefore uniform lattice
expansion is retained as strain. Results are dimensionless:

- Green–Lagrange tensor `E = (FᵀF − I) / 2`; six components use the local
  crystal reference axes, whose symmetry-equivalent orientation can vary by atom.
- Hydrostatic strain `tr(E) / 3`.
- Von Mises shear strain `sqrt((dev(E) : dev(E)) / 2)`, using the OVITO/AtomEye
  shear invariant convention.
- Physical volume change `det(F) − 1`.

The fit scale and deformation matrix retain double precision. Tensor components
and volume changes below `1e-12` in absolute magnitude are treated as numerical
zero, preventing roundoff from becoming a visible strain range in ideal crystals.

The default scalar view is shear strain; choose hydrostatic strain, volume
change or individual tensor components in **Color by**. Atoms whose best PTM
phase does not match their selected reference, whose fit exceeds the cutoff or
whose environment is invalid get NaN, shown gray, without an unmatched-atom
count or warning. An entirely NaN frame completes normally and uses a gray
NaN legend key. Strain is a least-squares local fit and includes thermal
displacements; it does not measure plastic displacement or non-affine `D²min`.
It does not use another trajectory frame as its reference. Graphene and ICO
identification are available, but these do not define a supported 3D strain
reference here.

**Central symmetry** calculates the AtomEye-style normalized parameter from
12 (FCC/HCP) or 8 (BCC) nearest-neighbor displacement vectors. The default
**Auto** setting first identifies each atom's local structure using adaptive
CNA, reusing a compatible cached classification when available. It applies
12 neighbors to FCC/HCP atoms and 8 to BCC atoms. Mixed FCC/HCP/BCC structures
therefore use different neighbor counts within one calculation, without
splitting the input or changing coordinates. The selected Auto option and
summary report the recognized phases.

Defect atoms classified as Other inherit a neighbor setting only when supported
atoms among their nearest 14 neighbors give one setting a local majority.
FCC/HCP votes are combined for 12 neighbors; BCC votes select 8. A tie between
8 and 12, an unrecognized neighborhood or an ICO environment remains NaN.
This permits FCC/HCP fault neighborhoods to retain the shared 12-neighbor
setting without requiring agreement on the phase label. Manual settings
**12 · FCC / HCP** and **8 · BCC** retain a single count for the complete frame;
Auto/manual mode is saved in processing configurations. Older version 1
configurations containing only a neighbor count restore the manual setting.

The result is scalar-colored with the existing editable legend. Each vector
is paired once, greedily choosing its most nearly opposite unused partner in
nearest-neighbor order. The sum of squared vector-pair sums is divided by twice
the sum of squared neighbor distances. This dimensionless value vanishes in
an ideal centrosymmetric environment. Ideal HCP is not centrosymmetric and
has a finite value even without defects; Auto retains that physical baseline
rather than subtracting it. Values from different phases are therefore not
equivalent defect thresholds. This is not the conventional CSP in Å² or
OVITO's minimum-weight matching CSP. Undefined Auto environments are NaN and
shown gray, including a completely unsupported frame. Manual calculations
with no valid neighbor environments retain the explicit failure status.

Auto also provides **Local structure (Auto symmetry)** and **Central symmetry
neighbor count** as color properties. The first retains raw CNA labels, so
inferred Other sites remain Other; the second shows their selected 8/12 setting
or 0 when no setting was selected.

All analyses automatically run on subsequent trajectory frames after first
being enabled. Per-frame results are reused only when their method/parameters
match. Changes to CNA method, fixed radius or central-symmetry mode/neighbor count
replace the affected result. Older requests cannot replace a newer parameter
choice or another source. Element reference edits persist by input type label
across frames and reset with a new source. PTM deformation arrays are counted in
the adaptive frame-cache memory budget. Results are available in **Atom details** and
**Current measurements**.

Each analysis has a **Cancel** button beside its status. It stops that analysis's
running/queued Workers and returns it to **Not calculated**. The button can also
reset a completed analysis. Its generated properties and per-frame results are
removed across the frame cache, metrics are cleared, and automatic analysis on
subsequent frames stops. When the removed property was selected for coloring,
the view returns to atom-type colors. Input parameters and reference constants
are retained so **Calculate/Identify** can restart it. Imported properties that
were overwritten by an analysis result are restored.

Other analyses continue independently. PTM and strain can share a geometry fit,
but cancelling one does not cancel the other. A strain request waiting for a
cancelled PTM job obtains its own fit; cancelled PTM display properties stay
removed. Strain's internal PTM fit alone does not enable the PTM display. Shared
fits are released when neither analysis needs them. Cancelled results cannot
reappear through a late response or a cached frame.

## Numerical implementation

`src/analysis/neighbors.js` implements fractional linked-cell search with
cell-face-height bounds. Nearest-neighbor queries inspect a complete search
sphere, expanding it until the requested neighbor count is available, before
sorting. Restricted triclinic geometry, mixed PBC, and non-periodic atoms outside
the nominal box are supported. Distinct periodic images, including self images,
are retained; this is essential for primitive and very small crystal cells.
Neighbor-neighbor bonds use the actual local displacement vectors without
wrapping them a second time. Extremely thin/skewed cells that would require
excessive lattice-image enumeration produce an explicit error.

CNA constructs a local neighbor bond graph and measures, for each center-neighbor
pair, the number of common neighbors, the number of bonds between them and the
largest connected bond-chain size. Its structure signatures are:

- FCC: twelve 421 pairs.
- HCP: six 421 and six 422 pairs.
- BCC: eight 666 and six 444 pairs (two shells, fourteen neighbors).
- ICO: twelve 555 pairs.

Adaptive CNA first tests the nearest twelve neighbors with radius
`mean(r₁…r₁₂) × (1 + √2) / 2`. It then tests the fourteen-neighbor BCC
environment with radius
`mean(2r₁/√3 … 2r₈/√3, r₉ … r₁₄) × (1 + √2) / 2`.
Fixed CNA requires exactly twelve or fourteen neighbors inside the supplied
radius. Other is a classification outcome, not a separate crystal phase;
surfaces, vacancies, strong thermal disorder, unsupported structures and poorly
chosen fixed cutoffs can all produce Other. The result is geometric and does
not distinguish chemical ordering or crystal orientation.

## Parallel execution

Successful Workers remain in a bounded idle pool, and PTM initializes its Wasm
kernel once per Worker. Cancellation and failures terminate the affected Worker;
later jobs create a replacement. Each task carries an ID, so late results or
progress cannot be applied to another job. Coordinates and neighbor contexts
are released after processing; only the reusable kernel remains.

Progress separates waiting for a slot, preparing inputs, initializing the
kernel, constructing the neighbor search and processing atoms. PTM and strain
report actual processed-atom counts, throttled to avoid flooding the UI.
Non-isolated deployments copy private input arrays in 4 MiB pieces with yields
to the main thread before transferring them. Shared-buffer preparation also
supports cancellation. This reduces repeated startup work and keeps controls
responsive during preparation; it does not remove neighbor-search or fitting
cost.

Coordination, CNA, central symmetry, PTM and atomic strain share `AnalysisPool`. Independent central
atom ranges execute in module Workers; the main thread uploads results and
updates controls. CNA/CSP/PTM/fresh strain use 4,096 atoms per target range;
cheaper coordination and cached-fit strain target 50,000 atoms. Each PTM Worker
has its own Wasm instance, avoiding pthread/shared-Wasm hosting requirements.
There is one total concurrency limit across
all analyses: at most six Workers and at most `hardwareConcurrency - 1`, with
at least one Worker on small/single-core systems. Copy and scratch-memory
estimates further reduce each job's range count. Different analyses may run
concurrently within that budget.

On isolated local development servers, inputs use SharedArrayBuffer when
available; ordinary hosting uses bounded coordinate copies. Float32/Float64
input precision is preserved. Partial structure/scalar outputs cover only
their own central range; coordination retains its symmetric pair reduction.
Source/frame/parameter changes terminate stale structure jobs and remove queued
tasks. Closing the pool settles every pending promise and releases its Workers.
The legacy coordination facade preserves its latest-request queue while using
the same global scheduler.

## Reference scan and further work

Reviewed snapshots (2026-10-02):

- [AtomEye](https://github.com/jameskermode/AtomEye/tree/c418eb2553f6793460d4a956236fc698c39fbe74),
  `A3/geo.c`, especially `compute_central_symm()`; see
  [the broader AtomEye inventory](ATOMEYE_REVIEW.md).
- [OVITO](https://gitlab.com/stuko/ovito/-/tree/81d76297a22ba00793b16487e821884e3c77028a),
  CNA documentation and `CommonNeighborAnalysisModifier.cpp`, predefined
  structure colors in `ParticleType.cpp`, PTM documentation and the separately
  MIT-licensed library in `src/3rdparty/ptm`.
- Honeycutt & Andersen, *J. Phys. Chem.* **91**, 4950 (1987),
  [doi:10.1021/j100303a014](https://doi.org/10.1021/j100303a014).
- Stukowski, *Modell. Simul. Mater. Sci. Eng.* **20**, 045021 (2012),
  [doi:10.1088/0965-0393/20/4/045021](https://doi.org/10.1088/0965-0393/20/4/045021).

The CNA/CSP browser kernels independently implement these algorithmic
definitions. No AtomEye or OVITO application source is bundled. AtomEye's
reviewed tree does not contain CNA or PTM; these are separate additions inspired
by OVITO's structure-identification workflow.

PTM uses the separately licensed library from the pinned OVITO snapshot,
vendored unchanged in `third_party/ptm/`. Its modified Voro++ cell code retains
the BSD notices. PTM, Voro++ and Emscripten runtime notices ship in `licenses/`
alongside each static build. The source pin and checksums are recorded in
`third_party/ptm/UPSTREAM.md` and `SHA256SUMS`. The library uses polyhedral
topology, Voronoi neighbor ordering and geometric least-squares template fits;
it is not a CNA alias or a distance-only heuristic. For scientific use cite
Larsen, Schmidt & Schiøtz, *Modell. Simul. Mater. Sci. Eng.* **24**, 055007 (2016),
[doi:10.1088/0965-0393/24/5/055007](https://doi.org/10.1088/0965-0393/24/5/055007).

`wasm/ptm.cpp` provides the integration ABI and neighbor callback. The generated
`src/analysis/ptm-kernel.mjs` / `.wasm` are included, so ordinary development,
tests and static-site builds do not require a compiler. After changing C++, run
`npm run build:ptm` with Emscripten (validated: Debian 3.1.69 / LLVM 19), then
`npm test`, `npm run build` and `npm run test:browser`. The prepared cloud
environment also provides an isolated compiler at `/workspace/.tools/wasm-sdk`,
which the build script detects. It verifies the vendored source checksums before
compiling. Browser Workers fetch the versioned `.wasm` asset with relative URLs;
Node scientific tests supply the same binary directly. No CDN or runtime package
download is required.

AtomEye reference-frame strain, its geometric local shear measure, partial radial
distribution functions and bond visualization remain separate follow-up features.
