# Crystal structures

Open **Visualization tools → Crystal** after loading CIF, POSCAR/CONTCAR or
another supported periodic structure. The panel shows the current cell lengths,
angles and volume. CIF symmetry labels describe the input declaration, not a
new symmetry analysis. Expanded-site counts and occupancy warnings accompany
CIF data.

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
positions in P1, retaining occupancies and Uiso/Biso where present. It does not
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

This is a crystal-structure workflow inspired by VESTA. It does not yet read
CHGCAR/LOCPOT/Cube volumetric fields, produce electronic-density isosurfaces or
infer crystallographic symmetry. See [File formats](../FORMATS.md) for exact
CIF/POSCAR parsing and occupancy limitations.

## References

- [VESTA](https://www.jp-minerals.org/vesta/en/): crystal and coordination-polyhedron viewing workflow.
- [IUCr CIF specification](https://www.iucr.org/resources/cif/spec/version1.1) and
  [core dictionary](https://www.iucr.org/resources/cif/dictionaries/cif_core).
- [VASP POSCAR format](https://www.vasp.at/wiki/POSCAR).
