# File formats and data model

## Internal frame model

Each parsed frame contains:

- `Float64Array ids` and compact `Uint16Array types` plus type labels;
- canonical Cartesian `Float32Array positions` and fractional `Float32Array
  fractional`, wrapped only along axes marked periodic;
- optional `Float32Array unwrappedPositions` when the input provides enough
  information to reconstruct unwrapped coordinates;
- a cell origin, three row vectors, and three PBC flags;
- named scalar per-atom typed arrays;
- optional timestep/source metadata.

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
- orthogonal and fully populated triclinic cells.

Rejected explicitly:

- incomplete/singular cells, incomplete atoms, mismatched `entry_count`, invalid
  or non-finite values;
- simultaneous non-identity `Transform` and non-zero `eta`. The reviewed
  AtomEye loader first computes `H0 * Transform` but its subsequent
  `pure_deform(H0, eta, H)` overwrites `H`; accepting both without a declared
  rule would risk silently displaying the wrong structure.

CFG has no portable per-axis boundary flag in this supported grammar, so all
three axes are treated as periodic. CFG also has no supported image flags or
trajectory-continuity metadata, so the unwrapped display option is unavailable.

## LAMMPS text dump

Supported:

- `ITEM: TIMESTEP`, `NUMBER OF ATOMS`, `BOX BOUNDS`, and named `ATOMS` blocks;
- positive numeric `type`, unique integer `id`, optional consistent `element`;
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
- binary, compressed, or non-`ITEM:` formats.

When wrapped columns are present, they define the canonical in-cell positions.
Otherwise, explicit unwrapped columns are wrapped only on periodic axes to build
the canonical positions. Unwrapped display coordinates come from explicit
`xu/yu/zu` or `xsu/ysu/zsu`, or are reconstructed from wrapped coordinates plus
complete `ix/iy/iz` flags. If none of those sources is present, the UI disables
unwrapped display; it does not infer boundary crossings from adjacent frames.
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

## Trajectory memory behavior

The Worker scans the local `File` in 4 MiB byte chunks for line-start
`ITEM: TIMESTEP` markers. It records byte offsets but does not call `file.text()`
for the complete trajectory. A requested frame is read with `Blob.slice(start,
end).text()`, parsed, and transferred to the main thread. `FrameCache` is a
three-entry LRU; tests verify eviction order.

A single parsed frame still has transient copies during Worker-to-main structured
clone/transfer and GPU upload. A frame with explicit/reconstructable unwrapped
coordinates retains one additional three-component `Float32Array`; the
three-frame LRU bound still applies. This is why one million atoms remains a
target to measure rather than a claimed supported size.
