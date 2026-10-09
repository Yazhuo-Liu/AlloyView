# Trajectory tools

**Modification tools → Trajectory** collects three operations that need more
than one frame: unwrapped coordinates inferred from consecutive frames, a
moving average of the coordinates (smoothing), and lines that trace chosen
atoms through the trajectory. All three are off by default. With them off,
frames, analyses and exports are exactly as before.

## Unwrapped coordinates from adjacent frames

**Display → Coordinates → Unwrapped** shows atoms at continuous positions
instead of folding them back into the cell. Sources with image flags
(`ix iy iz`), unwrapped columns (`xu yu zu`, `xsu ysu zsu`), out-of-cell CFG
coordinates or a numbered CFG sequence already provide these coordinates, and
they always take precedence. For any other trajectory with more than one
frame, choosing Unwrapped infers them:

1. Frame 1 defines image counts of zero for every atom.
2. For each later frame, in trajectory order, every atom's reduced (fractional)
   displacement since its previous observation is computed on each periodic
   axis. A jump larger than half a cell, `n = round(sᵢ − sᵢ₋₁)`, is a boundary
   crossing, and the atom's image count on that axis changes by `−n`.
3. The unwrapped position is the wrapped reduced coordinate plus the image
   count, converted with that frame's own cell.

Reduced coordinates make the test exact for triclinic cells and cells that
change between frames (NPT, deformation). Open axes are never shifted.
Atoms are matched by ID, so frames may list atoms in any order; files without
IDs are matched by row. An atom missing from some frames is compared with its
last observed position when it returns, and an atom that first appears later
starts at image zero. As with any inference from snapshots, an atom that moves
more than half a cell between two stored frames cannot be followed; such
trajectories need image flags in the file.

Frames are integrated strictly in order, once. Showing frame *k* extends the
integration to frame *k*; frames before it are never reprocessed. Every
crossing is logged (8 bytes each), so frames behind the integration frontier
are recovered by undoing the later crossings. The log is limited to 256 MiB
(about 32 million crossings); beyond that the oldest entries are dropped and
an earlier frame is recomputed from frame 1 when needed. Results do not depend
on the order in which frames were viewed, prefetched or played.

Inferred coordinates are used for display, Position X/Y/Z colors (unwrapped),
atom details (shown as *inferred*) and the second view. They are not passed to
analyses: displacement, clusters and every other tool keep using the
coordinates in the file, so their results never depend on whether a frame was
viewed in Unwrapped mode. Inference is unavailable while **Replicate atoms for
analysis** is on, because physical copies are placed from image flags; display
replication works normally.

## Smooth trajectory

**Replace coordinates by a moving average** substitutes each frame's
coordinates by the average over the frames from *k − w* to *k + w*, where *w*
is **Frames on each side** (1–50). Near the first and last frames the window is
truncated to the frames that exist, so it is not symmetric there and contains
fewer frames.

The average is minimum-image consistent: for every atom, the reduced
displacement from frame *k* to each other frame in the window is taken with the
minimum image on the periodic axes of frame *k*, and the mean displacement is
added to the atom's position in frame *k*. An atom vibrating across a boundary
therefore averages to a point beside the boundary, not to the middle of the
cell. The result is wrapped back into the cell (or keeps the frame's own
unwrapped image convention), and image flags and unwrapped columns move with it.
Atoms are matched by ID across frames; an atom missing from some frames is
averaged over the frames that contain it. Frames without explicit IDs must have
equal atom counts.

The cell vectors and origin are averaged with equal weights, and the averaged
reduced coordinates are placed in the averaged cell. For a fixed cell this is
the cell itself. Under pressure control the instantaneous cell fluctuates with
the same thermal noise as the positions; using the central frame's cell would
re-introduce that noise into every Cartesian distance, while the averaged cell
matches the averaged reduced coordinates.

Smoothing is a frame-processing stage, like physical replication: frames are
averaged in the structure Worker before they reach the page, and **every
analysis** (coordination, CNA, PTM, central symmetry, strain, DXA, Voronoi,
bonds, clusters, binning, displacement and frame strain) uses the smoothed
coordinates. Turning it on or changing *w* discards all cached frames and
results, recalculates enabled analyses for the displayed frame and prefetches
neighbors in the background as usual; cached raw and smoothed results never mix.
Reference frames for displacement and frame strain are smoothed too. Atom
types and other per-atom columns are those of frame *k*.

Parsed coordinates of recently used frames are kept in the Worker (up to
192 MiB) so stepping to the next frame reads only one new frame. Progress is
shown while averaging; changing the frame cancels the work.

## Trajectory lines

Choose the atoms (a [selection group](selection-groups.md) or a list of IDs),
the first and last frame and a step (**Every**), then **Generate lines**. The
Worker reads the sampled frames, matches the atoms by ID and builds one
polyline per atom. Lines do not break at periodic boundaries: where a frame
provides unwrapped coordinates they are used directly, otherwise each step adds
the minimum-image displacement since the atom's previous sample. Choose a step
small enough that atoms move less than half a cell between samples. Atoms found
in fewer than two sampled frames produce no line; missing IDs are listed.

Lines follow the file coordinates, not smoothed ones, and do not change when
the displayed frame changes. They are drawn as screen-space ribbons with the
chosen width in pixels, either in one color or colored by time along each path
with any scalar color map (start of the range at the low end of the map). They
are clipped by slices, repeated with display replication, move with the
periodic display origin, appear in the second view and are included in PNG,
JPG, six-view and frame-series exports. Exports scale the width with the image
size, as for cell outlines, so a line keeps its proportion at any resolution.
**Show lines** hides them without recalculation; **Remove lines** discards them.

At most 2,000,000 points (atoms × sampled frames) can be generated. Each point
uses 16 bytes in the result and the same in the GPU buffer, so the limit bounds
each copy to 32 MiB; the request is rejected before any frame is read when it
would exceed it.

## Configuration

`settings.extensions.trajectory` stores `smoothing.enabled`, `smoothing.window`
(1–50) and the line settings: `enabled`, `source` (`ids` or `group`),
`selectionGroupId`, `atomIds` (at most 100,000), `firstFrame`, `lastFrame`
(`null` means the last frame), `stride`, `visible`, `color`, `width` (0.5–16),
`colorByTime` and `colorScheme`. Smoothing is applied before the saved frame is
prepared; enabled lines are recalculated after import. Configurations without
the extension restore unsmoothed coordinates and no lines.

## Implementation

[Unwrapping, smoothing and line construction](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/data/trajectory-tools.js),
[Worker processing and caching](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/workers/trajectory-processor.js),
[structure Worker requests](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/workers/structure-worker.js),
[line rendering](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/trajectory-line-layer.js),
[panel controls](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/trajectory-tool-controls.js).
The behavior follows OVITO's Unwrap trajectories, Smooth trajectory and
Generate trajectory lines modifiers; the code is an independent
implementation.
