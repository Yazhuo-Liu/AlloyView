# AlloyView user and development guide

AlloyView is a browser-only atomistic structure viewer and analysis prototype for
metals and alloys. Local AtomEye CFG, LAMMPS text dump, XYZ and PDB files are parsed in a
Web Worker, rendered with WebGL 2 sphere impostors, and never uploaded by the
application.

The viewer supports this workflow:

1. open individual CFG/LAMMPS/XYZ/PDB files, a multi-file selection, or a detected
   numbered structure sequence from a local folder;
2. render atoms and the simulation cell on the GPU;
3. calculate coordination, crystal structure, bonds, strain and RDF off the UI thread;
4. color, slice, inspect, measure, change trajectory frames, and export figures
   or trajectory image sequences;
5. save the processing and view as a JSON configuration and restore it with the
   matching source files.

The single **Examples** button opens an in-app listing of the bundled
`examples/` files and the `fixed_end_climb/` sequence folder; examples are not
split into separate top-bar actions.

Drop a CFG, LAMMPS, XYZ or PDB file anywhere on the page, including the homepage, header
or controls panel, to open it directly. Dropping multiple files opens a chooser
for a single file; numbered names stay independent. Use **Open local → Choose
files…** or **Choose folder…** when you want to open a multi-file sequence.

Click **×** beside the filename to close the current structure or cancel an
ongoing load and return to the homepage. Closing stops trajectory playback,
prefetching and analyses, releases the source and its cached/GPU data, and
resumes the rotating BCC model. You can immediately open the same or another
file.

## Live controls and panel width

On desktop, drag the divider between the viewport and the right controls panel
to adjust its width. The browser saves the chosen width. Double-click the
divider or press Enter while it is focused to reset it; Left/Right arrow keys
also adjust it. Select a button under **Tools** to show that tool's settings.
Only one configuration panel is shown at a time. A dot marks an enabled
analysis; opening another tool keeps existing analyses running. Click the
current tool again or **Close / cancel** to cancel that analysis and clear its
results. **Cancel** clears the result while leaving the settings open to retry.

On phones, the viewport stays above an independently scrolling tools panel.
**View** and **Legend / atoms** start collapsed; tap to open camera controls or
the legend's atom filters. Collapsing a legend preserves its filters and the
separate PNG legend option. Drag one finger over the structure to rotate it;
spread or pinch two fingers to zoom in or out, and move both fingers together
to pan. These gestures work in both Perspective and Ortho. Tap an atom to open
its details in the tools panel.

Display options, color maps and legend limits apply as you edit them. Incomplete
or empty numeric input keeps the last valid result instead of becoming zero.
Editing the coordination cutoff starts or updates analysis automatically after
a short typing pause, or immediately on committing the field. Rapid edits keep
one analysis active and use the latest requested cutoff. The Calculate button
is available to run the suggested cutoff without editing it.

## Scalar color legends

Choose a scalar property under **Color by**, then select a palette in its
viewport legend. The ten maps are AtomEye rainbow, Viridis, Plasma, Magma,
Inferno, Cividis, Turbo, Spectral, Cool–warm and Grayscale. The selected colors
also appear in exported PNG legends.

The highlighted **Auto** button means automatic limits are on: the minimum and
maximum follow that property's data in the current frame. Click **Auto** to
turn it off and keep the displayed limits. Editing either limit also turns
Auto off. Those fixed limits survive frame changes, analysis-result reuse and
switching away from and back to that color property. Each scalar property keeps
its own range and Auto setting. Click **Auto** while it is off to fit the
current frame and resume automatic limits. Uniform-valued data gets a small
range padding so both limits remain editable.

**Hide outside range** uses the displayed limits; PNG output uses the same
limits and palette as the viewport. Range and palette changes apply immediately
without rerunning an analysis. Crystal-structure legends retain their separate
class visibility checkboxes.

## Display replication

Select **Replicate**, enter independent total copy counts along **a**, **b** and
**c**, then click **Apply**. Each count includes the original cell: `2 × 3 × 1`
displays six cells. Only periodic directions are editable. Copies follow the
actual cell vectors, including tilted or rotated vectors in a triclinic cell.
The outline and camera expand to enclose the displayed supercell. **Original
cell** or closing Replicate restores `1 × 1 × 1`.

Replication reuses the original GPU atom buffers and all calculated properties.
It does not add atoms to CNA, PTM, coordination or atomic-strain input, or rerun
those calculations. Coloring and atom visibility apply to every copy; clicking
an image shows the original atom's ID and properties. The structure summary and
crystal legend counts refer to source atoms. Cartesian slicing spans the
displayed copies, and PNG exports include the copies. Counts follow trajectory frames and reset
when a new source is opened. Up to 4,096 displayed cells are allowed; rendering
and picking cost increase with the number of copies even though analysis cost
does not.

## Arbitrary clipping planes

Open **Slice** and click **Add slice** to create a plane through the displayed
structure's center. Each plane appears in the list as **Slice 0**, **Slice 1**,
and so on. Select a list entry to edit it; change **Name** to rename it,
uncheck **Enable this slice** to keep its settings without clipping, or click
**Delete** to remove it. Up to 16 planes can exist, including disabled planes.

Set **Plane normal · Cartesian XYZ** to any finite, nonzero vector, or use the
**X**, **Y** and **Z** presets. The normal is normalized to unit length when
committed. **Plane position** is the signed distance `d` in Å from the global
Cartesian origin: points on the plane satisfy `n · r = d`. **Keep atoms on**
selects `n · r ≤ d` for the negative side or `n · r ≥ d` for the positive side.
All enabled planes apply together, so only atoms in the intersection of the
retained half-spaces remain visible and selectable.

Clipping uses the atom's actual displayed Cartesian position. Switching from
wrapped to unwrapped coordinates can therefore change which atoms a plane
keeps. Each replicated image is tested at its translated position along the
actual cell vectors; tilted cells and replicas use the same global plane.
Slicing and replication leave the original analysis input unchanged.

With the Slice settings open, a translucent plane and central normal arrow
show the selected slice in the viewport. Drag the arrowhead to adjust its
direction; a translucent guide sphere with orientation circles appears while
dragging. Rotation keeps the plane's editing center fixed, so its position
field can change together with its normal. Drag the arrow shaft or circular
position handle to move the plane along the normal. The toolbar's normal and
position update throughout either gesture. The separate position handle stays
usable even when the normal points toward the camera.

Uncheck **Show plane and editing arrow** to hide a plane's editing overlay.
Switching tools or closing Slice hides the editing controls while retaining
all enabled clipping planes. PNG export includes the sliced structure and
omits translucent editing planes, arrows and guide spheres.

## Save and restore a configuration

Select **Configuration → Export JSON** to save the current source file names,
sizes, available relative paths and saved trajectory frame, together with the
processing and view settings. The configuration includes enabled coordination,
CNA, central symmetry, PTM, ideal-lattice/reference-frame strain, local shear,
bonds and RDF analyses and their parameters, editable
lattice references, replication, all slices and their names, color maps,
per-property fixed ranges and Auto settings, visibility filters,
wrapped/unwrapped mode, atom radius, cell/axis/background
and PNG options, camera, selected atom, current tool and theme. Optional
settings also retain element/atom appearance overrides, vector components and
scale, measurement IDs and periodic-image mode, and the second view's enabled
state and direction. Bond visibility is saved independently from whether its
graph analysis is enabled. Older version 1 configurations leave these additions
disabled.

Click **Import JSON** and choose a saved configuration. If the matching source
is already open, the viewer returns to the saved frame, restores the settings
and recalculates enabled analyses. Otherwise the configuration remains pending
and the status lists the required files. Use **Open local** to select those
files or their folder; matching file names and byte sizes trigger restoration
automatically. Relative paths distinguish identically named files in different
folders when needed.

The JSON contains metadata and settings. Source atom data and calculated result
arrays are not packaged into it; analysis results are recreated from the source.
The browser cannot reopen disk files automatically, so selecting the matching
local source is required after starting a new session. Loading a different
source leaves the configuration pending for the requested files.

Editing values or pressing setting buttons in the tools, or choosing another
trajectory frame, interrupts an in-progress restore so those changes take
priority. Invalid configurations leave the current settings intact.

## Run locally

Development requires Node.js 20 or newer. End users only need a WebGL 2 capable
browser.

```bash
npm run dev
```

Open <http://localhost:5173>. The development server sends COOP/COEP headers so
that the coordination Worker pool can share one coordinate buffer when the
browser supports `SharedArrayBuffer`. Non-isolated deployments, including
GitHub Pages, use bounded private coordinate copies instead, prepared in chunks
and transferred to Workers while allowing the UI to update. Both modes parse
and calculate entirely on the user's device; the static host never receives
structure data or performs analysis.

Build and preview the static site:

```bash
npm run build
npm run preview
```

The deployable files are in `dist/`. Any static server can host them. No backend
API is used. A deployment only needs COOP/COEP headers if a future pthreads Wasm
build is enabled; see [docs/DEPLOYMENT.md](DEPLOYMENT.md).

## Deploy to GitHub Pages

The repository includes `.github/workflows/deploy-pages.yml`. Every push to
`main` runs the tests, builds the static site, uploads `dist/`, and deploys it
with the official GitHub Pages Actions. Relative asset URLs make the same build
work at both a user site and a repository subpath such as `/AlloyView/`.

In the GitHub repository, open **Settings → Pages** and set **Source** to
**GitHub Actions** once. Push to `main`, or start **Deploy AlloyView to GitHub
Pages** manually from the Actions tab. No repository secret is required.
After the first successful deployment, the project site is expected at
<https://yazhuo-liu.github.io/AlloyView/>.

## Crystal structure and atomic strain

Click **Identify structure** under **Common neighbor analysis** for automatic
local FCC/HCP/BCC/icosahedral classification. The crystal legend shows counts
and a visibility checkbox per class. **Fixed cutoff CNA** allows an explicit
radius; BCC requires its first two neighbor shells. **Central symmetry** offers
the dimensionless AtomEye normalized parameter and scalar coloring. Its default
**Auto** mode uses adaptive CNA to identify local FCC/HCP/BCC environments,
then applies 12 neighbors for FCC/HCP or 8 for BCC to each atom. The Auto option
and recognition summary show the resulting phases. Mixed structures use local
settings directly; no manual partitioning is required. Unclassified defect
atoms can inherit the locally dominant supported neighbor setting: FCC/HCP
neighbors vote together for 12, while BCC neighbors vote for 8. Ties and
unsupported neighborhoods remain NaN. You can select **12 · FCC / HCP** or
**8 · BCC** to apply a single neighbor count manually.

Ideal HCP is not centrosymmetric, so it has a finite central-symmetry value
even without defects. Its baseline is retained; compare defects against the
same phase rather than treating every nonzero value as a defect. Enabled
analyses follow trajectory frames and use a shared parallel Worker budget.
See [Structure analysis](STRUCTURE_ANALYSIS.md) for definitions, filtering
behavior and numerical limitations.

**Polyhedral template matching** uses the actual PTM library compiled to Wasm.
Select the crystal templates and an RMSD threshold (default 0.1; 0 disables
rejection), then click **Identify**. It adds SC, cubic/hexagonal diamond and
graphene identification to the CNA classes. All nine legend rows have counts,
colors and visibility checkboxes. Template checkboxes select what to analyze;
legend checkboxes control visibility without recalculating.

Analysis status distinguishes waiting for Workers, preparing input, initializing
PTM and building the neighbor search from the matching calculation itself.
PTM reports processed atom counts while partitions are still running, alongside
the number of completed Workers. Successful jobs return their Workers to the
shared pool, retaining the initialized PTM Wasm kernel for subsequent jobs;
input preparation yields between large chunks so the status and **Cancel**
controls can remain responsive.

**Ideal lattice reference** calculates per-atom Green–Lagrange elastic strain
from PTM correspondence. Recognized elements initialize editable phase and
lattice parameters from ASE reference-state data; hexagonal phases expose
both `a` and `c`. Numeric/unknown types require selecting an element or entering
a reference explicitly. **Element defaults** restores presets from the source
labels. Edit them for your alloy, temperature or model potential. Results include
shear strain, hydrostatic strain, volume change and six tensor components in the
local crystal frame. Undefined fits are NaN/gray. This measures strain relative
to an ideal lattice, not displacement relative to another trajectory frame.
Changing only the reference constants reuses PTM fits where possible.
Unmatched atoms, including an entirely NaN frame, do not trigger warnings.

## Reference-frame strain and local geometric shear

Select **Frame strain**, choose a **Reference frame** (numbered from 1 in the
interface), set the reference-neighbor cutoff, and calculate. The viewer
matches explicit atom IDs, selects neighbors in the reference configuration,
and fits a local deformation gradient to their current vectors. It returns
Green–Lagrange shear and hydrostatic strain, volume change, six strain-tensor
components and nine deformation-gradient components in Cartesian axes.
This compares trajectory configurations; **Ideal lattice reference** instead
uses PTM correspondence and editable perfect-lattice constants.

Cross-frame correspondence requires explicit stable IDs: LAMMPS dump IDs, CFG
`id` auxiliaries, Extended XYZ `id`, or PDB serial numbers. Generated row-order
IDs cannot establish which atom moved between frames. Reference and current
frames must use the same periodic axes. Missing atoms, insufficient independent
neighbor vectors and singular or inverted fits receive NaN without defect-count
warnings. Nearest-image correspondence cannot recover large relative motions
that are ambiguous from wrapped coordinates alone.

**Local shear** uses only the current frame and a neighbor cutoff. Its
AtomEye-style geometric metric uses the modal coordination shell, normalizes
neighbor second moments by the average squared bond length, and reduces the
result to a shear invariant. **Subtract the mean local tensor** removes the
frame's average tensor before calculating that invariant. This is a local
geometry/disorder indicator, not strain relative to a selected trajectory
frame or an ideal crystal template.

Both calculations partition atoms across the existing Worker pool. Local shear
uses parallel stages with global reductions for its modal coordination,
normalization and mean tensor. They retain per-frame results and support the
same cancellation/reset behavior as the other analyses.

## Bonds, vector arrows and structure statistics

Open **Bonds**, set **Default cutoff**, and optionally override individual
element-pair distances. A zero pair cutoff disables that pair. Click
**Calculate bonds** to construct the periodic neighbor graph. **Bond radius**
and **Show calculated bonds** change its appearance without calculating again.
Connections follow the actual cell vectors, including tilted cells, and
replication reuses the original connections. Bond coordination includes
qualifying periodic images, including self images; the original **Coordination**
tool retains its convention of counting distinct atom IDs at their nearest
qualifying image. Very large neighbor graphs fail explicitly rather than
silently truncating connections.

In **Vector arrows**, select X/Y/Z scalar properties, set **Length scale** and
**Arrow color**, then enable **Show arrows**. Components describe Cartesian
directions; the scale converts their values into arrow lengths in Å. Use force,
velocity or another vector field already present in the source. Rendering
settings reuse those values and do not run a neighbor analysis. Only one
vector field is displayed at a time.

**Statistics** shows the distribution and mean of calculated coordination
numbers, using bond-cutoff coordination when bonds are calculated, otherwise
the original global-cutoff coordination result. For **Radial distribution g(r)**, choose the maximum distance,
1–4,096 bins, and optional first/second element filters. **All types** produces
the total distribution; selecting elements produces partial distributions.
The Worker pool accumulates histograms and combines them using exact spherical
shell volumes and a finite-population correction. **Export CSV** saves the
distances, g(r) values and counts.

Normalized RDF requires periodic boundaries along all three axes and a cutoff
no greater than half the shortest cell face height. A nonperiodic structure
needs a separate surface correction, which is not implemented. RDF uses source
atoms before replication or display filtering. The graph and histogram use
the source structure, rather than treating replicated display cells as extra
samples.

## Measurements and appearance overrides

Open **Atom details** and use **Atom ID → Find** to select an atom by its
identifier. **Center** makes the selected atom the camera target. Enable
**Measure selected atoms** and select two atoms for a distance, three for a
bond angle, or four for a dihedral. **Use nearest periodic images** applies
the cell's PBC flags; turn it off to measure the source atoms' displayed
wrapped/unwrapped coordinates directly. Measurements track source atom IDs;
selecting different display replicas does not create separate measurement
points. **Clear measurements** clears that selection.

Under **Display → Element colors and radii**, change an element's appearance
or visibility. **Atom details → Selected atom appearance** overrides a
specific atom's color, radius or visibility; **Reset** returns it to element
settings. Overrides follow the original atom IDs across frames and displayed
replicas. Element colors apply to atom-type coloring, while single-atom colors
override the selected scalar/structure palette too. Radius values are in Å
before the overall radius scale.

## Multiple views and image exports

Enable **Display → Show a second view** and choose its direction to inspect
the same frame from another angle. Both views share calculated results;
camera movement does not launch another analysis. **Six-view PNG** exports
a contact sheet of the six standard directions.

**Export JPG** produces an opaque image. **Export EPS** embeds an opaque
raster screenshot in an Encapsulated PostScript file; it is not a vector
drawing of individual atoms. Both include the selected legend and XYZ-arrow
overlays. PNG retains the independent
background/legend/XYZ-arrow controls described above. **Visible atom IDs**
saves a list of source IDs that pass the current display filters, without
duplicating IDs for display replicas.

**Frame images** traverses the requested first/last frame and step, completes
the enabled processing for each frame, and packages the PNG images in a ZIP.
**Cancel frame export** stops traversal. This is image-sequence export;
movie encoding and a general command-script interpreter are not included.
Each archive is limited to 500 images and 256 MiB; the selected frame and
camera are restored when traversal ends.

## Cancel an analysis

Every analysis has a **Cancel** button next to its status. Use it to stop a
running calculation or reset a completed result to **Not calculated**. It clears
that analysis's properties, metrics and cached-frame results, and stops automatic
calculation on later frames. Input settings remain available for restarting with
**Calculate/Identify**. Other enabled analyses continue, including independent
PTM/strain requests. Cancelling the selected coloring result returns the view
to atom-type coloring; imported source properties are retained or restored.

## Tests and benchmark

```bash
npm test
npm run benchmark
# With Node.js 24 and Chrome/Chromium, after npm run build:
npm run test:browser
```

The test suite checks CFG and orthogonal/restricted-triclinic LAMMPS parsing,
coordinate conversion, malformed-input errors, PBC neighbors, FCC/BCC
coordination, and bounded LRU caching. The benchmark separates text generation,
parsing, and coordination analysis. Browser GPU upload/FPS/memory are measured in
the in-app performance panel on the target workstation. The browser smoke test
uses software WebGL to verify correctness, not to measure target GPU performance.

## Supported scope

- AtomEye CFG: basic and extended CFG, `H0`, `A`, `Transform`, `eta`, optional
  velocities, and scalar `auxiliary[]` columns. LAMMPS-written CFG auxiliaries
  `id` and complete `ix/iy/iz` image flags are recognized for stable atom IDs
  and unwrapped display. Meaningful out-of-cell fractional coordinates are
  wrapped while retaining the original unwrapped view. Multiple CFG files can
  be selected together and are continuously unwrapped by ID and adjacent
  minimum-image displacement. A non-identity `Transform`
  combined with non-zero `eta` is rejected because upstream AtomEye gives those
  fields ambiguous precedence.
- LAMMPS text dump: `id`, numeric `type`, common scalar columns, `x/y/z`,
  `xu/yu/zu`, `xs/ys/zs`, or `xsu/ysu/zsu`; orthogonal and restricted triclinic
  `xy/xz/yz` boxes; per-axis boundary flags; and optional `ix/iy/iz` image flags
  for unwrapped display. General triclinic `abc origin`, compressed/binary dumps,
  partial image flags, and non-numeric custom columns (except `element`) are
  rejected explicitly. Format recognition is content-based; conventional
  `.dump`, `.lmp`, `.lammpstrj`, and `.lammpstraj` names are shown as candidates.
  A `.lmp` containing a LAMMPS data/input file rather than `ITEM:` dump blocks
  is not silently treated as a trajectory and is not supported yet.
- XYZ: plain rows and Extended XYZ `Properties`, row-vector `Lattice`,
  per-axis `pbc`, and numeric auxiliary/vector columns. An explicit `id`
  property supplies stable correspondence. XYZ without a lattice uses a padded
  nonperiodic bounding cell.
- PDB: fixed-width `ATOM`/`HETATM`, decimal serial IDs, `CRYST1` lengths and
  angles, occupancy/temperature factors and multi-model trajectories.
  Structures without `CRYST1` use a padded nonperiodic bounding cell.
- Trajectories: LAMMPS byte offsets are indexed incrementally; requested frames
  are sliced and parsed on demand. A single dump file may contain multiple
  frames. Numbered LAMMPS dump files are naturally sorted, their internal frame
  indexes are combined, and frames remain on-demand. Multi-CFG sequences,
  including NEB image sets, are naturally sorted and parsed forward with one
  continuity state. **Open local → Choose folder** recursively scans a
  user-selected directory, verifies formats from their headers, and detects a
  varying run of digits anywhere in a structure filename, while keeping different
  folders, formats, and filename patterns separate. The in-browser chooser displays every
  file: selecting any detected sequence member opens the complete sequence,
  while non-structure files remain visible but disabled. After displaying the
  first frame, a memory-budgeted background prefetch caches the complete
  trajectory when practical, or a bounded window around the current frame for
  larger data. The viewer labels all such inputs generically as trajectory
  frames. The bottom timeline can play continuously at one frame per second and
  loops from the final frame to the first without queuing overlapping loads.
- Rendering: one instanced quad per atom with an analytic sphere/depth shader,
  optional wrapped/unwrapped trajectory coordinates, and an optional cell
  wireframe. Per-element radii are uploaded per atom; the slider covers
  20–200%, while direct numeric entry covers 5–500%. The camera uses a Z-up
  constrained orbit, six orthographic standard views, and explicit Perspective
  and Ortho buttons. Light and dark UI themes use the corresponding project
  logos; the choice
  persists in this browser. Changing the theme switches the default viewport
  between white and black until a custom background is selected. Background
  presets provide black, white, ivory, and
  pale-yellow choices before a custom color input. The optional, default-on
  Cartesian tripod uses camera-dependent depth ordering and shading. There is no
  per-atom mesh or draw call. Up to 16 Cartesian clipping planes use arbitrary
  normals and intersect their retained sides in both rendering and picking;
  interactive editing overlays are kept out of PNG exports.
- Analysis: cutoff-based coordination number using fractional-space linked cells,
  cell face heights, per-axis periodic bin wrapping, and a triclinic-safe image
  search. Large frames are partitioned across a memory-aware JavaScript Worker
  pool; small frames stay on one Worker to avoid parallel overhead. A recognized metal composition initializes an editable radius-based
  cutoff suggestion; unknown types fall back to 3.00 Å. Scalar properties can
  use AtomEye rainbow, Viridis, Plasma, Magma, Inferno, Cividis, Turbo, Spectral,
  Cool–warm or Grayscale maps. The chosen map persists per property. Highlighted
  Auto updates legend limits for the current frame; switching Auto off or
  editing a limit preserves that property's range across frames. Thresholds
  hide out-of-range atoms by default and push the opposite bound to remain
  strictly ordered. PNG export can independently include the background,
  current type/scalar legend and Cartesian XYZ arrows. The arrows default to off
  and follow the current camera independently of the screen axis toggle.
  Disabling the background also removes the legend panel
  fill, leaving transparent space around the labels and color keys. Active
  coordination analysis
  is recomputed automatically on a newly displayed frame. Display unwrapping
  never changes the coordinates used for analysis.

More detail is in [docs/FORMATS.md](FORMATS.md) and actual executed results
are in [docs/VALIDATION.md](VALIDATION.md).

## AtomEye relationship and licensing

The upstream review is pinned to
`jameskermode/AtomEye@c418eb2553f6793460d4a956236fc698c39fbe74` in
[docs/ATOMEYE_REVIEW.md](ATOMEYE_REVIEW.md). AtomEye's CFG conventions,
fractional-coordinate data model, and linked-cell neighbor-list design informed
the interfaces and tests here.

No AtomEye C source or asset is copied into this MIT-licensed repository. The
reviewed upstream snapshot has no repository-wide license file; its Python
bridge alone contains an explicit GPLv2 notice. Until the copyright holders
clarify terms, shipping modified upstream C/Wasm would be legally ambiguous.
The source evidence and reuse boundary are recorded in the review document.
This is a provenance and risk statement, not legal advice.

## Known limits and next steps

- WebGL 2 is required; WebGPU and fallback Canvas rendering are not implemented.
- The parser currently indexes a dump in one Worker and does not stream partial
  atom rows into the renderer.
- Very large text frames still require memory for the frame slice, parsed arrays,
  the main-thread copy, and GPU buffers. One million atoms is an exploration
  target, not a performance claim.
- Coordination retains a global cutoff; the separate bond graph provides
  element-pair cutoff overrides.
- Multi-CFG minimum-image unwrapping assumes adjacent images move by less than
  half a periodic cell per axis. A single already-wrapped CFG cannot reveal
  historical crossings without image flags or an adjacent reference frame.
- Browser file permissions do not allow a normal single-file picker to enumerate
  sibling files as a native desktop application can. **Open local** offers both a file picker and a folder picker. Choose a folder
  to detect sibling sequences automatically, or select several files together.
- NetCDF, Python/ASE integration, arbitrary command scripts, live monitoring
  of growing files, atom color/radius file imports, color tiling blocks and
  Voronoi polycrystal construction are not implemented. DXA and defect lines
  also remain separate future modules; they are not attributed to the reviewed
  AtomEye snapshot. See `docs/ATOMEYE_REVIEW.md`.
- CNA, normalized central symmetry and coordination use JavaScript Workers;
  PTM and its deformation fit use the included Wasm kernel. No Emscripten
  installation is needed unless rebuilding C++ with `npm run build:ptm`.

Recommended next work is to benchmark real 100k/1M trajectories on target GPUs,
then compile the isolated coordination ABI with Emscripten and compare it against
the existing reference tests before considering Wasm threads.
