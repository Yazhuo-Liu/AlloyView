# CIF/POSCAR crystal viewing implementation — 2026-10-25

## Scope and baseline

Synchronized `origin/main` at `aa48224` before implementation. The user clarified
that VESTA was the reference application and CIF/POSCAR crystal structures were
the priority. Existing POSCAR, periodic display, bonds, slices, second views,
Worker pools and export infrastructure were retained and extended. This change
does not implement electronic-density/LOCPOT/Cube isosurfaces or full VESTA parity.

## Changes and rationale

| Area | Implementation | Scientific/performance constraints |
| --- | --- | --- |
| CIF import | Core CIF tokens, cell parameters, fractional/Cartesian sites, explicit symmetry expansion and special-position deduplication | Float64 coordinates; independent disordered sites remain distinct; no `eval`; bounded expansion; cooperative parser cancellation |
| Symmetry | File-supplied operations, P1/P−1 fallback, source metadata in Crystal panel | Nontrivial groups without operations fail explicitly; no guessed space-group setting/origin; ambiguous multi-crystal files need a single block |
| Occupancy | Numeric occupancy/Uiso/Biso properties and source warnings | Missing occupancy remains NaN; existing analyses count sites rather than weighted occupations |
| POSCAR | Double-precision normalization, inline comments, D exponents, safe counts, existing scale/selective semantics preserved | VASP4 unidentified species remain generic; malformed geometry fails before allocation |
| Crystal UI | Current cell metrics, source symmetry, center/neighbor element choices, cutoff and independent polyhedron styling | Optional by default; current-frame result only; configuration stores settings, never geometry; result memory charged to adaptive cache |
| Coordination hulls | Actual neighbor positions, periodic images, convex polygon hulls and volume/area/bond-length statistics | Not Voronoi cells; overlapping volumes are not domain volume; bounded neighbor/output work; degenerate environments never produce plausible solid volumes |
| CPU integration | Existing AnalysisPool, resident neighbor index, shared/private snapshots and CPU budget; bounded center chunks | No repeated Worker/WASM creation; convex hull and render packing execute in Workers; GPU preference falls back explicitly because this new hull algorithm has no GPU kernel |
| Rendering | Independent hull layer using reusable polygon shaders | Faces/edges, selection highlight, slicing, display replication/origin, hidden centers, second view, PNG and context restoration; style edits reuse geometry/buffers |
| Export | CIF P1, POSCAR and per-polyhedron CSV through one retained serializer Worker | Private minimal snapshots; shared CPU admission; cancellation keeps lease until ACK; source/frame changes cancel obsolete downloads and clear data while retaining Worker |
| Examples | Ideal cubic SrTiO3 in symmetry-bearing CIF and POSCAR | Synthetic demonstration, not a claimed DFT result; Ti centers/O neighbors at 2.2 Å give six-ligand octahedra |

Exports use the scientific cell, including physical replication. Display-only
repeats, hiding, slices and periodic display shifts do not change the exported
structure. CIF writes the fully expanded cell in P1 to prevent repeated symmetry
expansion on reimport. Unknown chemistry and partial/unknown occupancy cannot
silently become an ordered POSCAR. Converting left-handed cells to conventional
CIF axes also changes the fractional basis, preserving physical chirality.

## Review and validation

Separate reviews covered parser correctness, convex-hull geometry and renderer
lifecycle. Scientific tests include full 192-operation NaCl symmetry, special
positions, inversion/screw operations, mixed occupancy, skew cells, POSCAR scale
modes, primitive periodic images, tetrahedra/cubes/octahedra, rigid transforms and
CIF/POSCAR round trips. An independent development probe compared 350 ordinary
random convex shells against SciPy volume and area. Near-planar numerical cases
now explicitly reject unreliable finite volumes; truly planar environments remain
skipped. Candidate/image work is bounded before querying, and Worker-side mesh
packing rejects values outside the Float32 rendering range. Recovery tests confirm
that these failures preserve the reusable Worker.

The real Worker tests cover copied/shared inputs, warm index reuse, parallel
merging, output caps, cancellation, source barriers and CPU leases. Export tests
include a 200,000-atom cancellation and ensure input buffers remain attached.

The production Chromium test (`npm run test:browser:crystal`) opens the bundled
CIF through the file chooser and verifies 3 asymmetric sites → 5 atoms, 48 symmetry
operations and the TiO6 octahedron volume `3.905³/6 = 9.924573770833332 Å³`.
It verifies style/selection buffer reuse, actual rendered faces and edges, the
second view, PNG, CSV/CIF/POSCAR exports and CIF reimport. The test writes its
report and screenshots to `/tmp/alloyview-crystal-tools/`.

The first full Node test run found a missing required Implementation heading on
the new feature documentation page; the page was corrected and documentation
checks passed. Final integration verification:

- `npm test`: **2,602 passed; 0 failed, skipped or cancelled** (Node 24).
- `npm run build`: passed, including generated examples, Worker bundles and docs.
- `npm run test:browser:crystal`: passed against the final production code,
  including real Worker calculation, WebGL rendering and all new export routes.
- `git diff --check`: clean.

Browser checks use Chromium with software rendering in this environment. They
validate behavior and image output; they do not establish a physical-GPU speedup.
The new hull calculation is deliberately a parallel CPU path.

## Remaining scope

No general space-group database, symmetry inference, anisotropic displacement
ellipsoids, CIF2 collection syntax, mmCIF macromolecule dictionary, XDATCAR
trajectory or volumetric electronic data is added in this change. These are
separate extensions, not hidden approximations in the structure reader.

User documentation: [Crystal structures](features/crystal.md) and
[File formats](FORMATS.md).
