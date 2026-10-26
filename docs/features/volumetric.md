# Volumetric data

Open a VASP **CHGCAR/CHG**, **LOCPOT**, **ELFCAR**, or Gaussian **Cube** file,
then choose **Visualization → Volume**. The atoms and the scalar grid are
loaded together. Gzip-compressed files work through the same file chooser.

## Isosurfaces

Choose a field, set its isovalue numerically or with the slider, and calculate.
An isosurface connects points with the same scalar value. Signed fields accept
negative levels. Color, opacity and visibility edits reuse the calculated mesh.
The surface follows periodic display origins, displayed replicas and slice
planes, and appears in the second view and PNG exports.

When GPU acceleration is enabled, extraction uses WebGPU. A missing device or
an unsupported numerical case falls back to the CPU Worker pool. The panel
reports the actual backend and fallback reason. Cancel stops the request and
prevents late geometry from appearing after another file is opened.

## Numerical sections

Enable the section, choose a grid axis and sample position, and inspect the
heatmap. These directions follow the grid basis, including tilted grids.
The two-dimensional image uses grid coordinates; it is not an orthogonal
Cartesian projection. Pointer inspection reports a sample's physical Cartesian
position and value. Fractional section positions interpolate between planes.
Palette and range controls affect the image only. **Export section CSV** keeps
every section value and its Cartesian coordinates, including values omitted
from the bounded screen preview. It does not export an atom-property table.

## Units and periodicity

- CHGCAR/CHG values are divided by the actual cell volume to obtain e/Å³.
  Their grid integral is in electrons. Magnetization channels retain their signs.
- LOCPOT values remain in eV; ELFCAR values are dimensionless.
- Cube identifies coordinate units, not the physical meaning of its scalar
  field. Coordinates are converted from bohr where required; scalar values
  remain in **file units**. Renaming a grid does not establish physical units.
- VASP grids are periodic. Their last voxel wraps to the first sample. Cube
  grids are open and have one fewer voxel than samples in each direction.
- Physical atom replication also tiles periodic grids. Density and potential
  values stay unchanged; the integrated quantity grows with the cell volume.

The bundled CHGCAR and Cube examples are analytic synthetic fields, not results
of a DFT calculation. They demonstrate a normalized periodic density and a
signed orbital-like shape.

## Implementation

`src/io/volumetric.js` parses Float64 samples cooperatively in parser Workers.
The shared grid convention is x-fastest and stores an independent origin and
three Cartesian step vectors. CPU and GPU extraction use a consistent six-
tetrahedron subdivision of each voxel. This is an original marching-tetrahedra
implementation, not a port of VESTA.

`VolumetricClient` retains Workers and immutable grids, shares the application's
CPU admission budget, and bounds private copies and output geometry. WebGPU
classifies tetrahedra and calculates crossings; bounded count readback and
prefix allocation prepare output ranges. The scalar encoding is normalized to
retain small differences around large offsets. Numerically unsafe cases request
CPU calculation rather than returning an unreliable topology. Grid uploads,
pipelines and device resources are reused between isovalue edits.

Rendering uses the existing WebGL 2 context. No WebGPU rendering support is
required. Large grid/output limits are checked explicitly; scientific data is
never silently downsampled to fit. This feature does not implement arbitrary
oblique volume sections, simultaneous multiple isosurfaces, field arithmetic,
or all VESTA input formats.
