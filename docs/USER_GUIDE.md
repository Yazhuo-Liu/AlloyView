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

The single **Examples** button opens an in-app listing generated from supported
structure files and numbered sequence folders under `examples/`. Add a file or
sequence and rebuild to include it automatically; optional descriptions live in
`examples/metadata.json`. Development discovers additions when the chooser opens.
See [Deployment](DEPLOYMENT.md#bundled-examples) for discovery rules and metadata.

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
also adjust it. **Tools** has two tabs side by side: **Visualization tools**
contains Display, Slice, Vectors, selections and the analysis tools;
**Modification tools** contains Replicate and External properties.
Select a button in either category to show that tool's settings.
Only one configuration panel is shown at a time. A dot marks an enabled
analysis; opening another tool or category keeps existing analyses running.
Each category remembers its last open settings panel. Use Left/Right, Home or
End while a category tab has focus to switch categories. Click the
current tool again or **Close / cancel** to cancel that analysis and clear its
results. **Cancel** clears the result while leaving the settings open to retry.

On phones, the viewport stays above an independently scrolling tools panel.
**View**, **Legend / atoms** and **Atom details** start collapsed; tap to open
camera controls, the legend's atom filters or the inspection window.
Collapsing a legend preserves its filters and the
separate PNG legend option. Drag one finger over the structure to rotate it;
spread or pinch two fingers to zoom in or out, and move both fingers together
to pan. These gestures work in both Perspective and Ortho. Tap an atom to
update its details, then expand **Atom details** in the viewport to inspect
them. Selecting an atom preserves the current sidebar tool and window state.

Display options, color maps and legend limits apply as you edit them. Incomplete
or empty numeric input keeps the last valid result instead of becoming zero.
Editing the coordination cutoff starts or updates analysis automatically after
a short typing pause, or immediately on committing the field. Rapid edits keep
one analysis active and use the latest requested cutoff. The Calculate button
is available to run the suggested cutoff without editing it.

**Cutoff preset** places **Custom** first and lists 35 common metals. A file
with recognized chemical elements selects the corresponding preset; alloys
start with the largest constituent estimate and list the elements in the help
text. Numeric atom types keep Custom. Choosing a preset applies its radius;
editing the numeric field switches back to Custom. Frame changes and
replication preserve the chosen value. JSON recipes save the choice, while
older recipes restore their exact numeric cutoff as Custom. The presets are
starting estimates; check the structure's first minimum of g(r).

## Scalar color legends

Use **Color by** at the top of the viewport legend to switch between atom
types, input properties and completed analysis quantities. The same selector
under **Display** stays synchronized. Changing the quantity reuses existing
results; it does not start another calculation. The selector is also available
for crystal classifications and fields containing only NaN values. On phones,
expand **Legend / atoms** to access it.
Enabled analysis quantities remain selected while their results update for a
different frame.

Every categorical legend, including **Atom type**, has a visibility checkbox
and count for each class. Element choices follow element labels across frames
and also apply when coloring by a scalar property. Other category filters are
saved separately per property: hiding a CNA class does not change PTM
visibility. All filters synchronize to the second view and are saved in
configuration JSON.

After CNA, PTM, Auto central symmetry, ideal lattice strain or DXA identifies
crystal types, **Crystal visibility** lets you hide FCC, BCC, HCP and other
classes independently of **Color by**. For example, keep CSP colors and hide
bulk BCC atoms to inspect the defect core. When several classifiers are
available, choose which result supplies the visibility classes. Existing
classification arrays are reused; changing a checkbox starts no analysis.
If that result is still being calculated for a new frame, its filter waits for
the new labels. The source and its per-class choices are saved in configuration
JSON. Coloring by that same classification uses the categorical legend's
checkboxes, so there is one set of controls for its classes.

**Select all** and **Unselect all** change every class represented in the current
legend, including zero-count categories. They leave filters belonging to other
properties unchanged. Counts and percentages update with the displayed population.

For scalar properties, choose a palette below the quantity selector.
The ten maps are AtomEye rainbow, Viridis, Plasma, Magma,
Inferno, Cividis, Turbo, Spectral, Cool–warm and Grayscale. The selected colors
also appear in exported PNG legends.

The highlighted **Auto** button means automatic limits are on: the minimum and
maximum follow that property's data in the current frame. Click **Auto** to
turn it off and keep the displayed limits. Editing either limit also turns
Auto off. Those fixed limits survive frame changes, analysis-result reuse and
switching away from and back to that color property. Each scalar property keeps
its own palette, range and Auto setting. Configurations save the selected
quantity along with these settings. Cancelling an analysis removes its
quantities from both selectors; cancelling the displayed quantity returns to
atom-type colors. Click **Auto** while it is off to fit the
current frame and resume automatic limits. Uniform-valued data gets a small
range padding so both limits remain editable.

**Hide outside range** uses the displayed limits; PNG output uses the same
limits and palette as the viewport. Range and palette changes apply immediately
without rerunning an analysis. Categorical legends retain their separate
class visibility checkboxes.

## Periodic display origin

Expand **Visualization tools → Display → Periodic display origin** to shift
the wrapping boundary along the periodic cell vectors. The **a/b/c fraction**
fields take fractional offsets, including negative values; a value of `0.5`
shifts atoms by half that cell vector before wrapping. Nonperiodic directions
are disabled. Actual cell vectors determine the shift in triclinic cells.

Select an atom and press **Center selected atom** to place it at fractional
coordinate `0.5` in each periodic direction. This brings a defect split by
periodic boundaries into the center of the displayed cell. **Reset origin**
sets all offsets to zero. Wrapped mode shifts and rewraps the coordinates;
unwrapped mode applies the same translation without wrapping, preserving
continuous motion. Both views and their bonds,
vectors, slices, picking and image exports use the adjusted display.
Source coordinates, cell geometry and analysis results remain unchanged.
Configurations save the fractional origin.

## Display replication

Select **Modification tools → Replicate**, enter independent total copy counts along **a**, **b** and
**c**, then click **Apply**. Each count includes the original cell: `2 × 3 × 1`
displays six cells. Only periodic directions are editable. Copies follow the
actual cell vectors, including tilted or rotated vectors in a triclinic cell.
The outline and camera expand to enclose the displayed supercell. **Original
cell** or closing Replicate restores `1 × 1 × 1`.

With **Replicate atoms for analysis** off (the default), replication reuses
the original GPU atom buffers and all calculated properties.
It does not add atoms to CNA, PTM, coordination or atomic-strain input, or rerun
those calculations. Coloring and atom visibility apply to every copy; clicking
an image shows the original atom's ID and properties. The structure summary and
crystal legend counts refer to source atoms. Cartesian slicing spans the
displayed copies, and PNG exports include the copies. Counts follow trajectory frames and reset
when a new source is opened. Up to 4,096 displayed cells are allowed; rendering
and picking cost increase with the number of copies even though analysis cost
does not.

Enable **Replicate atoms for analysis** to enlarge the cell and create physical
copies with independent atom IDs. All enabled analyses recalculate using the
additional atoms and enlarged cell; this increases memory and calculation
work. Copies still follow the actual cell vectors for triclinic geometry.
The structure summary and crystal legend then report physical atom counts,
and selection groups can edit different copies independently. Turning the
checkbox off returns to analysis of the source atoms with display copies.
Counts and this mode are saved in JSON; older configurations default to display
replication. The original files remain unchanged.

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

Expand **Build a plane from atoms**, click **Pick atoms**, and select two or
three distinct atoms in order. **Between 2 atoms** creates their perpendicular
bisector and keeps the side containing the second atom. **Through 3 atoms**
creates their common plane; the pick order sets its right-hand normal.
**Move to atom** places the current slice through the last pick, preserving
its normal and retained side. With no slice picks, it uses the currently selected
atom. **Clear picks** starts a new selection; **Finish picking** restores
normal atom picking. Dragging the viewport still rotates it while picking.

Atom-defined planes use the atoms' displayed coordinates directly, without
nearest-periodic-image correction. Picking a display replica includes that
replica's cell translation. Adjust the periodic display origin or pick
neighboring replicas when the chosen atoms straddle a cell boundary.
Picks must have distinct atom IDs. Coincident or collinear picks show a geometry
error and keep the existing planes. Constructed planes keep their numerical
position across frames; use **Move to atom** to place one through an updated
atom position. See [Slices](features/slices.md#build-a-plane-from-atoms).

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

Use **Export JSON** directly below **Structure** to save the current source file names,
sizes, available relative paths and saved trajectory frame, together with the
processing and view settings. The configuration includes enabled coordination,
CNA, central symmetry, PTM, ideal-lattice/reference-frame strain, local shear,
bonds, bond distributions and Q4/Q6, Voronoi tessellation, displacement and RDF
analyses and their parameters, editable
lattice references, replication counts and physical/display mode, all slices
and their names, named atom selection groups and their member IDs, color maps,
per-property fixed ranges and Auto settings, visibility filters,
wrapped/unwrapped mode, atom radius, cell/axis/background
and PNG options, camera, selected atom, current tool and theme. Optional
settings also retain element/atom appearance overrides, the displacement reference
and minimum-image option, the vector display source,
component and length scales, anchoring, linked arrow dimensions and 2D/3D mode,
measurement IDs and periodic-image mode, and the second view's enabled
state and direction. Bond visibility is saved independently from whether its
graph analysis is enabled. Older version 1 configurations leave these additions
disabled. Older configurations with Displacement selected as a Vector source
migrate that calculation to the independent Displacement tool.

Bond statistics save their enabled state and histogram bin counts in
`settings.extensions.bondStatistics`. Their cutoff and element-pair overrides
come from `settings.extensions.bonds`, even when bond cylinders are disabled.
Voronoi saves its enabled state, histogram bins, absolute/relative face-area
thresholds and input type labels in `settings.extensions.voronoi`.
`selectedTypes: null` includes all atom types; a string list selects those
labels as tessellation sites. Restoring either enabled analysis
recalculates its arrays and distributions from the saved physical frame;
CSV files and computed arrays are not embedded in the recipe. Older recipes
without these extensions leave both analyses off.
Selected-cell visibility, all-cell visibility, color and opacity are saved
separately in `settings.extensions.voronoiDisplay`, without polygon arrays.
Both cell-display options default off; older recipes include all input types.

Click **Import JSON** and choose a saved configuration. If the matching source
is already open, the viewer returns to the saved frame, restores the settings
and recalculates enabled analyses. Otherwise the configuration remains pending
and the status lists the required files. Use **Open local** to select those
files or their folder; matching file names and byte sizes trigger restoration
automatically. Relative paths distinguish identically named files in different
folders when needed.

The JSON contains metadata and settings. Source atom data and calculated result
arrays are not packaged into it; analysis results are recreated from the source.
Selection groups contain IDs and display settings, without embedding positions.
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

## Extend the modification tools

[The tool registry](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/tool-registry.js)
stores each tool's stable ID, label, category and analysis flag. Modification
tools can also declare `changesStructure` or `changesProperties` metadata.
Future editors for adding, deleting or moving atoms selected by clicking or
box selection belong in the `modification` category.

Mount a future editor's button and settings panel through the object returned
by `initializeToolPanels()`:

```js
toolPanels.registerTool({
  id: 'moveAtoms',
  label: 'Move selected atoms',
  category: 'modification',
  changesStructure: true,
}, { button, panel });
```

Registration connects the button, panel visibility and category navigation.
`selectTool(id)` opens the tool's category; `getActiveCategory()` and
`setActiveCategory(category)` expose category state. Explicit closure calls
the host's `onDeactivateTool` callback. The editor controller supplies the atom
operations, selection handling and undo behavior, and coordinates source
changes with cached data and analysis recalculation. The current built-in
modification tools provide replication and external attribute attachment.

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

**Enable GPU acceleration** beside the Light/Dark buttons is on by default.
It prefers WebGPU for coordination, adaptive/fixed-cutoff CNA,
manual/Auto central symmetry, displacement, reference-frame strain, RDF,
local geometric shear, bonds, bond-length/angle distributions, local Q4/Q6,
PTM neighbor preparation and ideal lattice strain
neighbor/reference/tensor stages, and DXA nearest-neighbor search, local crystal correspondence and
tetrahedron geometry/elastic-compatibility classification.
DXA remains a hybrid CPU/GPU pipeline with CPU crystal mapping, periodic
tessellation, mesh construction and line tracing. PTM and fresh ideal strain
prepare neighbors on GPU when supported, then fit PTM correspondence with the
shared CPU Wasm Worker pool. Strain can reuse a compatible fit and its GPU upload;
editing lattice parameters updates the element-reference table without
repeating the geometric fit.
Other analyses keep their existing CPU implementation, and unavailable or
unsupported GPU execution falls back to CPU. The switch affects the next
calculation; completed results remain available. Click **Calculate** again
to rerun a supported analysis with the new preference. JSON configuration
export/import saves the preference. An explicit saved off preference stays off;
configurations without a GPU preference use the enabled default.
WebGPU requires HTTPS or localhost. GPU buffers and pipelines are reusable,
but JavaScript input arrays still need to be uploaded. GPU floating-point
arithmetic, transfer overhead and hardware all affect results and elapsed time;
enabling GPU acceleration does not guarantee a speedup. See
[Performance](features/performance.md) for algorithm choices and the backend
layout in `src/analysis/gpu/`.

Bond statistics and Voronoi have both CPU Worker and WebGPU paths. CPU Voronoi
distributes bounded atom batches dynamically and reuses its Voro++ Wasm memory,
coordinate snapshots and neighborhood indices. GPU Voronoi constructs cells
on the GPU and reuses its device, linked-cell inputs and workspace; numerical
or capacity limits recover through the exact CPU implementation.

Rendering currently uses WebGL2: calculated scalar and vector arrays return to
the application before colors and arrows are uploaded for drawing. Reusing
WebGPU analysis inputs reduces repeated computation transfers, but does not
remove this result readback. Direct rendering from analysis buffers would
require a WebGPU renderer sharing the same device; see
[analysis results and rendering](features/performance.md#analysis-results-and-rendering).

**Ideal lattice reference** calculates per-atom Green–Lagrange elastic strain
from PTM correspondence. Recognized elements initialize editable phase and
lattice parameters from ASE reference-state data; hexagonal phases expose
both `a` and `c`. For numeric or unknown types, **Estimate from structure** fills
missing reference values using matched crystal geometry. The first
**Calculate strain** also estimates missing values automatically. Numeric labels
stay **Type N**, with the element selector empty; geometry does not identify an
element. Existing element presets and manually entered values are kept.
**Element defaults** restores presets from the source labels.

Estimation uses robust bulk lattice lengths from the current frame. Cubic `a`
is volume-equivalent; hexagonal references have separate basal `a` and axial `c`.
Mixed phases without a clear majority or too few reliable crystal fits require a
reference entered manually. Estimates include the frame's bulk strain, so edit
them for a known stress-free lattice, alloy, temperature or model potential.
Estimated and manually entered references remain fixed across trajectory frames
and are saved and restored in configuration JSON. Results include
shear strain, hydrostatic strain, volume change and six tensor components in the
local crystal frame. Undefined fits are NaN/gray. This measures strain relative
to an ideal lattice, not displacement relative to another trajectory frame.
Changing only the reference constants reuses PTM fits where possible. A compatible
geometry fit produced by estimation is also reused for the strain calculation.
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
With GPU acceleration enabled, **Frame strain** can use WebGPU; it keeps the same
reference-frame neighbors, atom-ID correspondence and strain definitions.

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

## Dislocation analysis (DXA)

Open **DXA**, choose a reference crystal and click **Extract dislocations**.
This initial version uses the actual OVITO v3.9.4 dislocation extraction core in
a dedicated CPU/Wasm Worker. Its Burgers-family checkboxes and colors control
the extracted lines independently of atom colors. Line radius, family visibility
and slice/display replication redraw the network without recalculation.
Lines use connected tube surfaces with smooth display interpolation, including
closed loops and periodic joins. This drawing step preserves the computed
points, line lengths, Burgers vectors and junctions. Completed DXA also adds
**Crystal structure (DXA)** to **Color by** and to **Crystal visibility**;
these atom controls remain available when extraction finds no lines.
The summary reports source line count, length and length-per-cell-volume density.
**Cancel** stops extraction and clears this tool; other analyses remain available.
Configurations preserve parameters and line-display preferences and recompute
an enabled DXA tool when restored.

DXA requires sufficient periodic cell thickness. For `NiGB_minimized.cfg`,
repeat Z twice with **Replicate atoms for analysis** enabled; display copies
alone do not enlarge the analyzed cell. With GPU acceleration enabled, WebGPU
performs nearest-neighbor search, local common-neighbor analysis and ordered
ideal-crystal correspondence for FCC, BCC, HCP, cubic diamond and hexagonal
diamond, followed later by tetrahedron classification. CPU Wasm builds crystal
clusters, maps the lattice, constructs the periodic tessellation and interface,
and traces the dislocation lines. Each GPU stage can fall back to CPU without
restarting the complete analysis. This version awaits broader scientific
validation and does not include newer HCP low-c/a treatment.
See [DXA](features/dislocations.md) for
the algorithm, search settings and limitations.

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

Expand **Bond distributions and Q4/Q6** in Bonds to calculate
bond-length and bond-angle distributions and local Steinhardt **Q4/Q6**. This
uses the Default cutoff and element-pair overrides above; displaying cylinders
is optional. Choose 1–4,096 bins independently for lengths and angles, then
calculate. Lengths count unique undirected periodic edges, including valid
self-image edges. Angles count each unordered pair of qualifying neighbors
around a central atom once, over 0–180°. Q4/Q6 are dimensionless and invariant
under rigid rotation; they describe neighbor orientation rather than chemical
bond multiplicity. Atoms without qualifying neighbors receive `NaN`.

The charts show counts and normalized probabilities. CSVs retain the bin
edges, centers, raw counts, probabilities and probability densities; density
uses Å⁻¹ for length and °⁻¹ for angle. Q4/Q6 statistics and individual atom
values have separate CSV buttons. **Color by** can use Q4, Q6 or their neighbor
counts. While enabled, frame or cutoff changes recalculate the statistics.
**Cancel** clears these results independently of the bond cylinders. See
[Bonds](features/bonds.md) for the definitions and CPU/GPU paths.

**Voronoi**, in Visualization tools, partitions the physical simulation cell
into nearest-atom regions using actual periodic images and triclinic cell
geometry. Nonperiodic directions use the finite simulation-cell boundary.
Results include atomic volume, surface area, neighbor coordination and the
full Voronoi index `<n3,n4,n5,n6,…>`, which counts neighbor faces with each
number of edges. Boundary faces are recorded separately and do not contribute
to neighbor coordination or the index. This implementation is unweighted;
species-dependent radius weighting is not applied.

The **Element types** checkboxes choose the sites used to construct the
tessellation. Excluding a type removes its cells and bisector planes, so the
included sites divide the complete domain among themselves. This changes
volumes and neighbor topology independently of display hiding, while the
physical frame and other analyses keep all atoms. Excluded sites receive
`NaN` Voronoi properties; Voronoi statistics and detailed CSV rows include only
the selected input sites and retain original atom IDs.

The Voronoi tool provides summary cards and folded **Distributions** containing
leading topology populations and histograms of volume, coordination and
neighbor face area.
Expand the distributions to inspect bins by pointer, touch or keyboard and
switch between count and probability; the complete index table is paginated.
Quantity buttons apply atomic-volume, surface-area or coordination coloring.
Expand **Cell display**, enable **Show the selected atom's cell** and click an
included atom to see its transparent polyhedron and edges. Alternatively,
**Show all analyzed cells** builds geometry for all included input sites. Both
options default off; all-cell display needs additional memory and mesh
construction time. Color and opacity are adjustable. Cell geometry follows
display origin, periodic replication, visibility and slices, appears in PNG
exports and leaves the analyzed statistics unchanged.
Its optional absolute face-area
and relative surface-fraction thresholds remove small neighbor faces from
coordination and index statistics while preserving the tessellated volumes
and surface areas. Atomic volumes and other numeric outputs are available
for coloring. Export per-atom cells, distributions or individual faces as CSV;
face rows include accepted/boundary flags and neighbor atom IDs. The CPU/Wasm
Worker pool retains its kernel and memory between calculations. See
[Voronoi](features/voronoi.md) for interpretation and boundary conventions.

Open **Displacement** to enable calculation against a selected reference frame.
It uses stable atom IDs; equal-size frames without explicit IDs use row order
with a warning that atom ordering must stay unchanged. Mixed ID schemes and
unequal row counts are rejected. Minimum-image correction resolves periodic
crossings in the full cell metric. Without correction, available unwrapped
positions are used. The Cartesian current-minus-reference difference includes
affine cell deformation. Its physical X, Y and Z components and magnitude in Å
remain selectable in **Color by** independently of arrow drawing. While enabled,
frame and reference changes recalculate them. **Cancel** removes the fields from
current and cached frames and stops pending and subsequent calculations;
**Calculate displacement** restarts the analysis. See the
[displacement documentation](features/displacement.md) for the algorithm and
atom-correspondence limitations.

**Vector arrows** draws existing data without adding or modifying properties.
New sources default to **Custom XYZ**, with three scalar-property selectors
and signed component display scales. Force, Velocity and other named vector
families appear only when all components are present; Displacement appears
after its independent analysis has calculated results. Presets hide the custom
menus. **Length scale** converts values to arrow lengths in Å.

Calculated vector sources and Custom XYZ component choices persist while an
enabled analysis recomputes for another frame. Cancelling any calculation used
by an arrow component unchecks **Show arrows** and clears arrows in both views,
including when results are pending. Recalculating leaves arrows off until you
enable them again. Cancelling unrelated analyses leaves imported arrows enabled.

**Show arrows** controls glyph visibility independently of atom legend filters
and element or individual-atom visibility, so vectors can remain visible with
all atoms hidden. Slices still clip arrows, and both views draw the same vector
data. Choose Tail, Head or Center anchoring and 3D or camera-facing 2D glyphs.
Shaft radius, head radius and head length are linked in proportion by default;
disable the link to edit them separately. Up to 16 named fields can be displayed
together, with independent sources, colors, sizes and visibility. Fixed 2D
planes can use an editable up direction. See the
[vector documentation](features/vectors.md) for rendering details.

**Statistics** shows the distribution and mean of calculated coordination
numbers, using bond-cutoff coordination when bonds are calculated, otherwise
the original global-cutoff coordination result. For **Radial distribution g(r)**, choose the maximum distance,
1–4,096 bins, and optional first/second element filters. **All types** produces
the total distribution; selecting elements produces partial distributions.
The Worker pool accumulates histograms and combines them using exact spherical
shell volumes and a finite-population correction. **Export CSV** saves the
bin edges, distances, g(r) values and raw directed counts.

Normalized RDF requires periodic boundaries along all three axes and a cutoff
no greater than half the shortest cell face height. A nonperiodic structure
needs a separate surface correction, which is not implemented. RDF ignores
display filtering and display copies. With physical atom replication enabled,
it uses the enlarged cell and additional atoms as the analysis structure.

Expand the CSV section in Statistics to export the current frame's complete
summary, scalar-property statistics, populations from every available crystal
classifier and atom type, all coordination distributions, or individual atom
properties. The summary also includes selection-group matched/absent IDs,
RDF normalization, bond and Voronoi statistics, and DXA family lengths and
density when those results are available. DXA also provides separate family
and line tables with Burgers-vector components.

Every CSV records the source filename, one-based frame number and timestep
when available. Units appear in headings or dedicated columns. Numbers retain
their stored precision, including literal `NaN`; scalar statistics report
finite counts and missing/infinite counts separately and use population
standard deviation. Slicing, hidden atoms, display copies and periodic display
origin do not change exported populations. **Replicate atoms** includes the
additional physical atoms. Voronoi's input type selection determines its
tessellation population; its cell and face tables include only those input
sites, and its histogram fractions use the included population. A persistent
Worker formats existing results in
chunks, reusing snapshots and avoiding another analysis; if the frame changes
during formatting, the obsolete download is discarded. See
[Statistics](features/statistics.md) for table contents and CSV conventions.

## Named atom selection groups

Open **Selections** and click **Add group**, or click atoms to create the first
group. **Click atoms** picks individual atoms; **Drag a box** selects projected
atom centers throughout the viewing depth while respecting visibility and
slicing. **Add atoms** keeps existing members, **Remove atoms** subtracts picks,
and **Replace atoms** replaces the current group's membership.

Select a group to edit its name, color and **Show group atoms** checkbox.
**Clear members** keeps an empty group, and **Delete group** removes it.
**Member IDs and manual edits** accepts space- or comma-separated IDs with the
same Add/Remove/Replace operation, including hidden atoms and IDs absent from
the current frame. Counts show how many stored IDs are present in that frame.

In Box mode, one-finger or primary mouse dragging draws a rectangle; right-drag,
wheel and two-finger gestures navigate. **Escape** cancels the rectangle.
Switching tools or closing Selections ends group picking while keeping group
colors and visibility. Display copies share the original atom ID; physical
copies have independent IDs. Groups follow stable IDs across reordered frames
and are saved in JSON configuration exports. Later groups take color precedence
over earlier groups; per-atom color overrides take precedence over group color.
Any hidden group hides its members along with the other visibility filters.
See [Selections](features/selection-groups.md) for detailed controls and limits.

## Measurements and appearance overrides

The **Atom details** window floats over the viewport, opens by default on
desktop, and starts collapsed on phones. Its button expands or collapses it;
the window does not appear in PNG exports. Use **Atom ID → Find** to select an
atom by its identifier. **Center** makes the selected atom the camera target. Enable
**Measure selected atoms** and select two atoms for a distance and its
**Δx, Δy, Δz** components in Å, directed from the first pick to the second.
Three atoms add a bond angle; four add a dihedral. **Use nearest periodic images** applies
the cell's PBC flags; turn it off to measure the source atoms' displayed
wrapped/unwrapped coordinates directly. Measurements track source atom IDs;
selecting different display replicas does not create separate measurement
points. **Clear measurements** clears that selection.

Under **Display → Element colors and radii**, change an element's appearance
or visibility. **Atom details → Selected atom appearance** overrides a
specific atom's color, radius or visibility. This appearance section starts
collapsed; **Reset** returns the atom to element settings. Overrides follow
the original atom IDs across frames and displayed
replicas. Element colors apply to atom-type coloring, while single-atom colors
override the selected scalar/structure palette too. Radius values are in Å
before the overall radius scale.

## Multiple views and image exports

Enable **Display → Show a second view** to inspect the same frame from another
angle. Its own toolbar includes Top/Bottom/Front/Back/Left/Right and projection
controls. A selected direction is highlighted until you rotate away from it,
when the label becomes **Custom** and the direction highlight clears. Panning
and zooming keep the selected direction; **Fit** preserves a custom orientation.
The second view immediately inherits the main view's atom-radius scale,
element and atom color/radius overrides, scalar palette and visibility filters,
coordinates, slices, replication, bonds and vectors. Both views share calculated
results; their cameras move independently, including after display edits or
trajectory-frame changes. Configuration import restores custom camera angles.
Camera movement does not launch another analysis. **Six-view PNG** exports
a contact sheet of the six standard directions.

**Export JPG** produces an opaque image with the selected legend and XYZ-arrow
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

## Feature help and documentation

Hover or keyboard-focus the **?** beside a detailed settings heading to read a
brief explanation. Click it to open that feature's documentation in a new tab,
including its controls, algorithms, conventions and source links. Configuration
is always visible below Structure and is independent of the selected tool.

The top bar links to the GitHub repository and the [documentation website](INDEX.md).
`npm run dev` serves documentation at `/docs/`; `npm run build` renders the same
Markdown sources into a set of static pages in `dist/docs/` for deployment.

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
# Bond/Voronoi reference structures, CSV downloads and configuration replay:
npm run test:browser:topology-tools
# Voronoi GPU numerical parity and result/cell inspection UI:
npm run test:gpu:voronoi
npm run test:browser:voronoi
# WebGPU execution checks and CPU/GPU timing (Node.js 24 and Chrome/Chromium):
npm run test:gpu
npm run benchmark:gpu
```

The test suite checks CFG and orthogonal/restricted-triclinic LAMMPS parsing,
coordinate conversion, malformed-input errors, PBC neighbors, FCC/BCC
coordination, and bounded LRU caching. The benchmark separates text generation,
parsing, and coordination analysis. Browser GPU upload/FPS/memory are measured in
the in-app performance panel on the target workstation. The browser smoke test
uses software WebGL to verify correctness, not to measure target GPU performance.
The separate WebGPU checks exercise real compute shaders using a software
adapter by default. The GPU benchmark loads `examples/NiGB_minimized.cfg`,
checks result agreement, and reports full cold/warm analysis times and the
actual adapter. See [Performance](features/performance.md#compare-cpu-and-gpu-time)
for adapter options and timing interpretation.

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

- WebGL 2 is required for rendering. Optional WebGPU acceleration accelerates
  coordination, adaptive/fixed CNA, reference-frame strain, RDF, local geometric
  shear, manual/Auto central symmetry, displacement, bonds, bond statistics and ideal-strain
  reference/tensor evaluation and fresh-strain neighbor preparation; fallback Canvas rendering is
  not implemented.
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
  Voronoi polycrystal construction are not implemented. The initial DXA module
  comes from the separately reviewed OVITO core, not the reviewed AtomEye
  snapshot. See [DXA implementation review](DXA_REVIEW.md) for the source-backed
  CPU/Wasm and GPU plan, and `docs/ATOMEYE_REVIEW.md` for AtomEye.
- Coordination, adaptive/fixed CNA, manual/Auto central symmetry, displacement,
  reference-frame strain, RDF, local geometric shear, bonds, bond statistics, Voronoi and ideal-strain
  tensors can use optional WebGPU acceleration or Workers.
  PTM and its deformation fit, DXA and CPU Voronoi use included Wasm kernels. No Emscripten
  installation is needed unless rebuilding C++ with `npm run build:ptm`,
  `npm run build:dxa` or `npm run build:voronoi`. GPU-enabled DXA computes local crystal correspondence
  and classifies its mapped tetrahedra with WebGPU, completing extraction in
  the same CPU Wasm session.

The bundled `NiGB_minimized.cfg` contains 129,904 atoms and can be used to
compare CPU and GPU analysis with the same parameters. Measure cold and warm
runs separately on the target device, including upload and readback time;
software GPU adapters verify execution but do not establish hardware speedups.
