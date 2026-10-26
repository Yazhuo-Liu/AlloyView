# Crystal structures

Open **Visualization tools → Crystal** after loading CIF, POSCAR/CONTCAR or
another supported periodic structure. The panel shows the current cell lengths,
angles and volume. CIF symmetry labels describe the input declaration, not a
new symmetry analysis. Expanded-site counts and occupancy warnings accompany
CIF data.

## Space-group recognition and standardized cells

Open **Identify space group and standardize cell**, choose a distance tolerance
in Å, and run **Identify space group**. This analyzes the current lattice,
positions and species, independently of the original file's space-group label.
The result shows the international number and symbol, Hall setting, Pearson
symbol, operation count and Wyckoff letters. The effective search tolerance is
reported; tighter tolerances distinguish small distortions from ideal symmetry.

Recognition uses the official open-source [moyo](https://github.com/spglib/moyo)
0.21.0 WASM engine from the spglib organization, with double precision. This
global search runs in one retained CPU Worker sharing the application CPU budget;
it does not use local CNA classification or an approximate GPU space-group test.
The engine and memory are reused. Inputs require three periodic axes, at most
20,000 sites, and an ordered, fully occupied structure. Disordered and partial
occupancy models are rejected instead of silently assigning them full occupancy.

**Export primitive cell** and **Export conventional cell** create separate CIF or
POSCAR files. These are symmetry-refined cells, with lattice and atomic positions
adjusted within the tolerance. They never overwrite the loaded structure.
Source atom IDs, ADPs, velocities and other per-atom properties are omitted,
because a change of cell and site count does not provide a unique source mapping.
Changing the frame, source, geometry or tolerance invalidates the result and any
in-progress export.

CIF files without explicit symmetry operations can now use a pinned database of
all 530 Hall settings covering the 230 ordinary space groups. A Hall symbol or an
unambiguous Hermann–Mauguin symbol/setting resolves the operations. Origin and
axis choices are never guessed from an ambiguous group number: provide the Hall
symbol, `_space_group_IT_coordinate_system_code`, or explicit operations. Explicit
CIF operation lists remain authoritative. Magnetic space groups are not included.

The vendored runtime, license texts and reproducible database generation are
documented in [moyo provenance](https://github.com/Yazhuo-Liu/AlloyView/blob/main/third_party/moyo/README.md).

## Thermal ellipsoids

Open the folded **Thermal ellipsoids** section and enable their display. CIF
anisotropic U or B tensors describe a Gaussian atomic-displacement distribution;
the probability control sets the enclosed probability, not the atom radius.
For a 50% surface the principal standard deviations are scaled by approximately
1.538. Positive isotropic U/B values can supply spherical displacement surfaces
where anisotropic data is absent. Atoms without usable displacement data retain
their ordinary spheres. These inputs are not estimated from a single snapshot.

The parser converts crystallographic tensors to Cartesian covariances, applies
each symmetry rotation and prepares their eigensystems in its Worker. Invalid
anisotropic tensors are rejected; missing or invalid isotropic values retain
their raw properties and receive a source note. Colors, visibility, selection,
slices and periodic replicas follow the atom display. The second view, image
export and saved configurations preserve the optional display settings.

The illustrative `crystals/SrTiO3_thermal.cif` example contains synthetic ADPs,
not experimentally measured or DFT-predicted displacement parameters.

## Coordination polyhedra

Choose center elements and neighbor elements, set the cutoff in Å and press
**Calculate**. Each center's actual neighboring atomic positions define a convex
polyhedron. Periodic images are included, including several images of one source
atom in a primitive cell. Centers with fewer than four distinct noncoplanar
neighbor positions do not produce a solid hull. Coordination counts all selected
neighbors, even those inside the convex hull.

For the bundled **crystals/SrTiO3.cif** or **crystals/POSCAR-SrTiO3** example,
select Ti centers, O neighbors and a **2.2 Å** cutoff. The six O images form an
octahedron around Ti. Reduce atom radii in Display to expose its faces.

Faces are lit, edges are outlined, and picking a center highlights its polyhedron.
Visibility, face color, opacity and edges update without recomputing neighbors.
The independent layer follows display origins, replication, slices, center-atom
visibility, second views and image exports. Display hiding does not remove
neighbors from the calculation. Polyhedra can overlap; their volume sum is not
the occupied or simulation-cell volume. Voronoi remains a separate analysis.

## Implementation

The calculation and mesh packing run in the existing bounded CPU Worker pool,
sharing its hardware budget and resident neighbor indexes. The GPU acceleration
switch does not invent a GPU version of this algorithm; unsupported work uses
CPU Workers. No additional worker pool or WASM module is created per calculation.
Changing frames recalculates enabled polyhedra, while Cancel discards their
result. Settings can be saved/restored in configurations without geometry data.

## Export

**Export CIF** writes the complete current scientific cell and its expanded
positions in P1, retaining occupancies, Uiso/Biso and anisotropic tensors where present. It does not
write the original non-P1 operations a second time. CIF stores cell lengths and
angles, so its conventional Cartesian basis may differ from the source while
preserving the physical crystal. A left-handed source basis is converted without
reflecting the physical structure.

**Export POSCAR** groups atoms by element and preserves complete selective
dynamics flags. Partial or unknown occupancy and unresolved chemical types are
rejected: POSCAR cannot represent these as an ordered, chemically identified
crystal without additional modeling. Both formats require three periodic axes
and known elements. Cell origins are omitted; positions remain relative to the
cell. Display-only repetitions, slice cuts and hidden selections do not change
an export. Enabling **Replicate atoms** does change the scientific cell and is
included.

**Export statistics CSV** writes each constructed polyhedron's center ID,
element, coordination, volume, surface area and bond-length minimum, maximum and
mean. Scientific values retain precision rather than display rounding. These
exports use a persistent serializer Worker; cancellation and source changes
suppress obsolete downloads.

## Scope

This is a crystal-structure workflow inspired by VESTA. See
[File formats](../FORMATS.md) for exact CIF/POSCAR parsing and occupancy limitations.

## References

- [VESTA](https://www.jp-minerals.org/vesta/en/): crystal and coordination-polyhedron viewing workflow.
- [IUCr CIF specification](https://www.iucr.org/resources/cif/spec/version1.1) and
  [core dictionary](https://www.iucr.org/resources/cif/dictionaries/cif_core).
- [VASP POSCAR format](https://www.vasp.at/wiki/POSCAR).
