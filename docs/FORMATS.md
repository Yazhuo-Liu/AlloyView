# File formats and data model

## Internal frame model

Each parsed frame contains:

- `Float64Array ids` and compact `Uint16Array types` plus type labels;
- canonical Cartesian `Float32Array positions` and fractional `Float32Array
  fractional`, wrapped only along axes marked periodic;
- optional `Float32Array unwrappedPositions` when the input provides enough
  information to reconstruct unwrapped coordinates;
- optional interleaved `Int32Array imageFlags` storing explicit or safely
  inferred `ix/iy/iz` values;
- a cell origin, three row vectors, and three PBC flags;
- named scalar per-atom typed arrays;
- optional timestep/source metadata.

Explicit atom identifiers are distinguished from generated row-order IDs.
Only explicit stable IDs establish cross-frame correspondence for reference
strain and for imported external properties: CFG `id`, native LAMMPS IDs
(the `id` column that every text dump must have, and the atom IDs of a data
file), Extended XYZ `id`, and PDB serial numbers.

Cell vectors follow the AtomEye CFG convention `x = origin + s * H`, where each
row of `H` is a cell edge. Canonical wrapped coordinates are used for slicing and
analysis. The renderer can independently upload `unwrappedPositions`; switching
the display mode does not mutate the analysis frame or rerun an analysis.

## AtomEye CFG

Supported:

- basic rows: `mass symbol sx sy sz [vx vy vz]`;
- extended CFG species/mass singleton blocks;
- `A`, all nine `H0(i,j)` entries, `.NO_VELOCITY.`, `entry_count`, and scalar
  `auxiliary[n]` fields;
- `Transform` or symmetric Lagrangian `eta` deformation;
- LAMMPS-generated extended CFG auxiliaries named `id`, `ix`, `iy`, and `iz`:
  `id` becomes the frame's unique identifier array and a complete image triplet
  is retained and used to reconstruct unwrapped coordinates;
- orthogonal and fully populated triclinic cells.

Rejected explicitly:

- incomplete/singular cells, incomplete atoms, mismatched `entry_count`, invalid
  or non-finite values;
- simultaneous non-identity `Transform` and non-zero `eta`. The reviewed
  AtomEye loader first computes `H0 * Transform` but its subsequent
  `pure_deform(H0, eta, H)` overwrites `H`; accepting both without a declared
  rule would risk silently displaying the wrong structure.

CFG has no portable per-axis boundary flag in this supported grammar, so all
three axes are treated as periodic. A complete `ix/iy/iz` auxiliary triplet is
interpreted using the [LAMMPS image-flag definition](https://docs.lammps.org/dump.html):
the integers multiply the three cell vectors, including for triclinic cells.
Partial triplets, non-integer flags, and duplicate/non-positive `id` values are
rejected. Fractional CFG coordinates are always canonicalized into the primary
cell. If a coordinate lies meaningfully outside `[0,1)` (beyond a `1e-5`
boundary tolerance), its integer part supplies an image flag and the original
coordinate is retained as an unwrapped view. Tiny negative values or values just
above 1 are treated as exporter round-off, not crossing history.

If all coordinates of a single CFG are already wrapped and no image flags exist,
historical crossings cannot be recovered uniquely from that frame. For NEB
output, users may select an ordered set of CFG files together. AlloyView sorts
numeric filenames such as `replica.2.cfg` before `replica.10.cfg`, matches atoms
by stable `id`, and accumulates the minimum-image fractional displacement between
successive images. This inference requires each atom to move less than half a
cell per adjacent NEB image along each periodic axis; otherwise the direction is
mathematically ambiguous. An explicit `id` auxiliary is required; row-order IDs,
changing IDs, and missing IDs are rejected explicitly.

## LAMMPS text dump

Supported:

- `ITEM: TIMESTEP`, `NUMBER OF ATOMS`, `BOX BOUNDS`, and named `ATOMS` blocks;
- positive safe-integer numeric `type`, unique integer `id`, optional consistent
  `element`;
- one complete coordinate set: `x/y/z`, `xs/ys/zs`, `xu/yu/zu`, or
  `xsu/ysu/zsu`;
- optional complete `ix/iy/iz` image flags;
- numeric scalar custom columns;
- `pp`, `ff`, `ss`, and `mm`-style per-axis boundary flags;
- orthogonal boxes and restricted triclinic `xy xz yz` boxes. Bound values are
  converted to the true origin and row-vector cell using LAMMPS's bound
  correction before coordinates are transformed.

Rejected explicitly:

- general triclinic `abc origin` output;
- missing/partial coordinate groups, partial `ix/iy/iz` image flags, missing
  ID/type, duplicate IDs/columns;
- string custom columns other than `element`;
- binary or non-`ITEM:` formats ([gzip-compressed](#gzip-compressed-files)
  text dumps are accepted). A LAMMPS data file named `.lmp`
  is recognized by its header and read by the [data-file parser](#lammps-data-file)
  instead.

The filename extension does not select the parser. Files named `.dump`, `.lmp`,
`.lammpstrj`, or `.lammpstraj` are recognized as LAMMPS trajectories only when
their content contains native `ITEM: TIMESTEP` dump blocks. One file may contain
one or many frames.

## LAMMPS data file

A data file written by `write_data`, Atomsk, Packmol and similar tools holds one
configuration. It is recognized by its header (an `N atoms` count and the
`xlo xhi` bounds after the free-text title line), whatever its name; `data.*`
and `*.data` names are also accepted.

- **Header:** `atoms`, `atom types`, `xlo xhi`, `ylo yhi`, `zlo zhi` and the
  optional `xy xz yz` tilt factors. Other counts (bonds, angles…) are ignored.
  The box becomes a restricted triclinic cell. Data files do not store boundary
  conditions, so every axis is periodic, as LAMMPS assumes until a `boundary`
  command says otherwise.
- **Atoms:** the style comment after the keyword (`Atoms # charge`), as
  `write_data` writes it, selects the columns. Supported styles are `atomic`,
  `charge`, `molecular`, `bond`, `angle`, `full`, `sphere` and `dipole`. Without
  a comment, 5 or 8 columns are read as `atomic`; any other width is rejected
  with a request to add the comment, because `charge` and `molecular` rows have
  the same width. Three trailing image flags, when present for every atom,
  unwrap the coordinates. Charge, molecule ID, diameter, density and dipole
  columns become atom properties.
- **Type names:** an `Atom Type Labels` section, or a single-word comment after
  a mass (`1 55.845 # Fe`), names the types; these names also select element
  colors and radii. Atoms rows may then use the labels instead of numbers.
  Without names, types are shown as `Type 1`, `Type 2`, ….
- **Other sections:** `Masses` becomes a `mass` property and `Velocities`
  becomes `vx`, `vy`, `vz`. Coefficient, bond, angle and other topology
  sections are skipped.

General triclinic boxes (`avec`, `bvec`, `cvec`, `abc origin`) and atom styles
not listed above are rejected with a specific message. Atom IDs must be unique
positive integers.

## VASP POSCAR and CONTCAR

A POSCAR or CONTCAR file holds one periodic configuration. It is recognized by
its layout and by the names `POSCAR*`, `CONTCAR*`, `*.vasp` and `*.poscar`.
Browsers may hide files without an extension in the file picker; choose
**All files** there, or select the containing folder.

- The scale factor multiplies the lattice and Cartesian coordinates. A negative
  value is the target cell volume in Å³, and three values scale the x, y and z
  components separately (VASP 6).
- VASP 5 files list the species above the counts; potential suffixes such as
  `Fe_pv` are reduced to the element. VASP 4 files without that line take the
  species from the comment line when it contains one element symbol per count,
  and otherwise show `Type 1`, `Type 2`, ….
- `Selective dynamics` flags become `selectiveDynamicsX`, `Y` and `Z`
  properties (1 for T). `Direct` and `Cartesian` (or `K`) coordinates are both
  supported; velocity and predictor blocks after the coordinates are ignored.

Atoms are numbered in file order. XDATCAR trajectories are not yet supported.

Without an `element` column, atom types and their legend entries use the original
numeric identifiers as `Type N` (for example, `Type 1`). AlloyView does not infer
elements from the filename or interpret type numbers as atomic numbers. An
explicit `element` column supplies element labels and must be consistent for
every atom of the same numeric type.

When wrapped columns are present, they define the canonical in-cell positions.
Otherwise, explicit unwrapped columns are wrapped only on periodic axes to build
the canonical positions. Unwrapped display coordinates come from explicit
`xu/yu/zu` or `xsu/ysu/zsu`, or are reconstructed from wrapped coordinates plus
complete `ix/iy/iz` flags. If none of those sources is present in a trajectory,
choosing Unwrapped infers display-only coordinates from consecutive frames
([Trajectory tools](features/trajectory-tools.md)); file data always takes
precedence, and analyses never use the inferred values.
For restricted triclinic cells, image flags translate along the three cell
vectors rather than the Cartesian axes.

The restricted-triclinic neighbor test does not assume that independent rounding
of all fractional differences always yields the shortest image. It enumerates
only translations whose face-height lower bounds can lie inside the cutoff.

Coordination uses minimum images only on axes whose boundary flag is `pp`;
`ff`, `ss`, `mm`, and mixed non-periodic styles use direct distances. It counts
unique atom IDs using the nearest qualifying periodic image.
If a periodic cell face height is smaller than twice the cutoff, the UI warns
that multiple images of the same atom are not counted repeatedly. This makes the
small-cell convention explicit instead of silently claiming an infinite-crystal
coordination.

## XYZ and Extended XYZ

Plain XYZ contains an atom-count line, a comment line (which may be empty),
and exactly that many `species x y z` rows in Cartesian coordinates. Repeating
these blocks produces a trajectory. Plain XYZ uses generated row-order IDs;
it does not provide reliable cross-frame identity for reference strain.

Extended XYZ recognizes comment-line metadata such as:

```text
Lattice="10 0 0 2 10 0 0 0 10" pbc="T T T" Properties=species:S:1:pos:R:3:id:I:1:force:R:3
```

`Lattice` contains the three cell vectors in row order. `Properties` specifies
field names, types (`S`, `R`, `I`, `L`) and component counts. Species (or atomic
number `Z`) and three-component positions are required. Numeric auxiliary
fields are retained; multicomponent fields become scalar properties such as
`force_0`, `force_1`, `force_2`, selectable in **Vector arrows**. Non-species
string fields are consumed but are not retained as colorable properties.
An explicit `id` field must contain unique positive safe integers.

With a lattice, PBC defaults to all three axes; an explicit `pbc` triplet can
override it. Without a lattice, the reader constructs a padded nonperiodic
bounding cell. A true periodic flag without an explicit lattice is rejected.
Meaningfully out-of-cell periodic coordinates retain an unwrapped view and
image flags. Already-wrapped XYZ trajectories do not infer historical crossings
between frames.
Missing rows, mismatched property schemas, invalid numeric values and singular
cells are rejected. Both `.xyz` and `.extxyz` are offered by the file picker;
the schema is determined from file contents.

## PDB

The reader supports fixed-width `ATOM` and `HETATM` records, decimal atom serial
IDs, optional explicit element fields, occupancy and B-factor scalar
properties. If the element field is absent, atom-name alignment supplies the
element. Alternate locations retain only the primary blank or `A` conformer.
Atom serials must be unique positive integers; hybrid-36 serial encoding is
not supported.

`CRYST1` cell lengths and angles define a triclinic periodic cell. Without
`CRYST1`, a padded nonperiodic bounding cell encloses the coordinates.
`MODEL`/`ENDMDL` blocks provide trajectory frames. Bonds are calculated from
the selected distance cutoffs rather than imported from `CONECT` records.
PDB chain/residue annotations are not currently exposed as atom properties.
Both `.pdb` and `.ent` are file-picker candidates.
Out-of-cell periodic coordinates retain an unwrapped view; crossings cannot
be inferred from an already-wrapped PDB trajectory.

Numbered XYZ and PDB sequences are sorted by their varying numeric filename
field. Every member can contain multiple frames; its indexed frames are
concatenated into the global trajectory. Sequences remain separated by format,
directory and filename pattern. NetCDF is not supported. LAMMPS data and
POSCAR files open one at a time, not as numbered sequences.

## gzip-compressed files

Every format above may also be gzip-compressed, for example `traj.dump.gz`,
`replica.0.cfg.gz` or `movie.xyz.gz`. A file counts as compressed when it
starts with the gzip signature bytes `1f 8b`, whatever its name, and format
detection reads the decompressed header, so a `.gz` name need not reveal the
inner format. The structure Worker decompresses with the browser's
`DecompressionStream` (Chrome and Edge 80, Firefox 113, Safari 16.4 or newer);
older browsers report that the file must be decompressed first.

- **Trajectories read in any order** (LAMMPS dumps, XYZ and PDB, including
  numbered sequences) are decompressed once when opened. The Worker copies the
  output into a `Blob` in 8 MiB parts, so its own memory holds one part at a
  time, then indexes and slices that Blob exactly like an uncompressed file.
  The Blob takes the decompressed size. Chromium-based browsers move large
  Blob data to disk; Firefox and Safari may keep it in memory, so there a
  trajectory whose decompressed size approaches the free memory of the device
  should be decompressed before opening. AlloyView does not write the
  decompressed copy to the origin private file system.
- **Single-frame files** (CFG, LAMMPS data and POSCAR), including every image
  of a CFG sequence, are decompressed each time they are read. Only the file
  being parsed is held in memory, as for uncompressed files; revisiting a
  frame decompresses its file again.

Numbered `.gz` files form sequences like uncompressed files, for example
`dump.{number}.gz` or `replica.{number}.cfg.gz`, and a sequence may mix
compressed and uncompressed members. A gzip file must contain a single gzip
stream. A file made by concatenating streams, for example by appending to an
existing `.gz` dump (LAMMPS `dump_modify append yes`) or by `bgzip`, is
rejected with a decompression error; decompress it and compress it again with
`gzip` to open it.

## Coordination cutoff suggestion

Coordination analysis always uses one explicit, user-editable global cutoff.
When all type labels are recognized metallic element symbols, the UI initializes
that cutoff from the largest tabulated metallic radius pair with 15% first-shell
padding, rounded to 0.05 Å. Unknown/numeric types use an explicit 3.00 Å
fallback. This is a convenience estimate, not phase recognition and not an
OVITO algorithm; users should verify it against the first minimum of the radial
distribution function. OVITO's own Coordination Analysis likewise accepts an
explicit uniform cutoff. OVITO's separate Create Bonds modifier is the feature
that provides element-aware radius and pair-wise cutoff modes.

Scalar properties offer AtomEye rainbow, Viridis, Plasma, Magma, Inferno,
Cividis, Turbo, Spectral, Cool–warm and Grayscale maps. Highlighted **Auto**
follows the current frame's data range. Editing a limit or turning Auto off
preserves that property's bounds across frames. Lower and upper legend
thresholds apply on every input event;
there is no separate Apply action. When one bound reaches the other, continuing
to move it pushes the opposite bound so the interval remains strictly ordered.
Values outside a custom interval are hidden by default. Clearing the checkbox
keeps those atoms visible and clamps their colors to the two ends of the map.
Map choice, limits, and visibility are stored by property name so active
analysis settings survive a trajectory-frame change. PNG export can include
the current legend independently of whether the viewport background is
included.

The separate bond graph accepts element-pair cutoff overrides, including zero
to disable a pair. Its graph may include multiple periodic images and self
images, unlike the distinct-ID convention of the coordination tool. Normalized
RDF also has a separate convention: no self pairs, a fully periodic cell, a
cutoff at most half the shortest cell face height, and finite-population
spherical-shell normalization.

## Trajectory memory behavior

The structure Worker scans the local `File` in bounded byte chunks for frame
boundaries. It records byte offsets but does not call `file.text()` for the
complete trajectory. Each complete frame becomes available before indexing
the remaining file finishes; the viewer's frame count grows as more complete
frames are found. A requested frame is read with `Blob.slice(start,
end).arrayBuffer()`, parsed, and transferred to the main thread.

A dedicated foreground parser handles requested frames. Up to four background
parsers can prepare nearby frames in parallel, within the shared logical-CPU
and memory budgets. Changing the requested frame cancels obsolete prefetch;
source generations prevent late results from reaching a different source.
Queued parsing is cancelled immediately. An active synchronous parse finishes
before its result is discarded and its Worker and CPU permit become available
again, preserving the pool instead of recreating Workers while scrubbing.
Malformed later frame boundaries are reported even if an earlier valid frame
has already been displayed. Configuration replay waits for indexing before
checking that its saved frame exists, and exports that cover the whole
trajectory wait for it too. gzip trajectories still require the
existing full decompression before random-access indexing.

The atom rows of LAMMPS dumps, CFG files and XYZ frames are converted directly
from these bytes instead of splitting decoded lines into strings. Every value
is exactly the number that `Number()` gives for the token (CFG and XYZ also
accept Fortran `d` exponents as before). A plain decimal token whose digits
form an integer below 2^53 and whose decimal exponent lies within ±22 is
converted with one correctly rounded multiplication or division; every other
token, such as `1e-30`, `0x10` or `nan`, is converted by `Number()` from its
text. A frame whose atom rows contain a non-ASCII byte, which might belong to a
Unicode space, or any malformed row is parsed again from its decoded text by
the line-based parser, so results and error messages do not depend on the
input path. PDB, LAMMPS data and POSCAR files are always parsed from decoded
text.

In Chrome on a 32-thread workstation, reading and parsing one frame in a
parser Worker takes 21 ms for the 28,800-atom HEA dump, 74 ms for the
60,229-atom Fe loop dump and 106 ms for the 129,904-atom Ni grain-boundary
CFG; line-based parsing took 54, 238 and 348 ms. See
[performance](features/performance.md#measured-effects) for parser scaling
with the number of Workers.

For a numbered set of LAMMPS dump files, files are naturally sorted by the
varying numeric filename field. Each file receives its own byte-offset index,
and the indexes are exposed as one global trajectory in file order and then
in-file timestep order. Files may each contain one or multiple frames. Only the
requested frame slice is parsed.

XYZ frame-count blocks and PDB model boundaries are likewise indexed in the
structure Worker, then requested frames are sliced and parsed. Numbered
homogeneous XYZ/PDB sequences concatenate those per-file indexes.

For a multi-file CFG sequence (including NEB image sets), raw frames can be
parsed in parallel. ID-based unwrapping retains ordered continuity states
(IDs plus wrapped/unwrapped fractional coordinates), so completion order does
not change the inferred images. Backward access resumes from bounded retained
checkpoints or replays from the first image when necessary.

After the first visible frame, the main thread estimates parsed bytes per frame
and selects a cache limit from the browser heap limit/device-memory hints when
available, with conservative fallbacks otherwise. If the complete trajectory
fits the budget, all remaining frames are parsed lazily during idle time. If it
does not, only an LRU window around the displayed frame is prefetched. Adding an
analysis array triggers another estimate and may shrink the cache. This policy
is a heuristic, because browsers do not expose a portable exact memory counter.
Playback prepares its next frame while the current one remains visible.
Physical replication runs in a reusable Worker; it retains the same atom IDs,
coordinates and properties as the direct implementation and supports cancellation.

The folder opener examines conventional `.cfg`, `.dump`, `.lmp`, `.lammpstrj`,
`.lammpstraj`, `.xyz`, `.extxyz`, `.pdb`, `.ent` and `.txt` paths, the same names
ending in `.gz`, any other `.gz` file and other filenames containing digits after the user grants read
access. It reads at most the first 64 KiB of each candidate, after decompression
for a gzip file, to identify the CFG
or LAMMPS/XYZ/PDB text header. An explicit structure filename segment is retained as
a fallback hint and the full parser remains authoritative. For CFG files, each
run of digits in the complete filename is considered as a possible frame index.
Files form a sequence only when their detected format, directory, prefix, and
suffix match and the candidate indices are unique. Separators are not special,
so `.0.cfg`, `_0.cfg`, `-0.cfg`, and `snapshot_0.lmp` are all handled. This also
supports names such as `replica.cfg.0`. For example, `run12/neb_4_replica.000.cfg` through
`replica.039.cfg` are recorded as `run12/neb_4_replica.{number}.cfg`; the fixed
`12` and `4` are not mistaken for frame indices. Index gaps are reported in the
source chooser rather than silently filled. Multiple detected CFG and LAMMPS
dump/XYZ/PDB sequences remain separate.

An ordinary file picker exposes only the files explicitly selected by the user,
so it cannot scan sibling files in the OVITO desktop style. AlloyView's single
**Open local** action requests a directory through a read-only `webkitdirectory`
input. The returned `FileList` includes relative paths and is presented in an
in-app, naturally sorted file/sequence chooser. Recognized standalone
structures are selectable, clicking any numbered structure-sequence member opens
its entire sequence, and unrecognized files such as LAMMPS `log.neb.*` remain
visible but disabled. Selected files are not uploaded.

A single parsed frame still has transient copies during Worker-to-main transfer
and GPU upload. A frame with explicit/reconstructable unwrapped coordinates
retains one additional three-component `Float32Array`. Coordination uses shared
coordinates on a cross-origin-isolated host; otherwise every parallel Worker
receives a bounded structured-clone copy inside the same client browser. No mode
sends coordinates to the static host for calculation. This is why one million
atoms remains a target to measure rather than a claimed supported size.
