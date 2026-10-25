# Trajectory tools

**Modification tools → Trajectory** contains explicit Unwrap controls, coordinate
smoothing and atom-path lines. All are off by default. **File coordinates
(default)** displays the positions saved in the selected CFG, including positions
outside the primary cell, without adding image counts. Ordinary navigation reads
only the selected structure; even a jump to frame 165 of a 165-file folder does
not require parsing frames 1–164. Nearby frames can still be prefetched using
the existing cache and warmed Workers.

## Unwrap coordinates

Enable **Unwrap coordinates using this frame's data**, or choose **Display →
Coordinates → Unwrapped**. Unwrap and **Infer missing image counts from previous
frames** are separate switches, both off by default. Choosing Unwrapped alone
never requests a scan of preceding frames.

| Information saved in the frame | Unwrap behavior |
| --- | --- |
| Wrapped coordinates, cell and `ix/iy/iz` image counts | Add each count times its cell vector, using only this frame. |
| Continuous positions already saved outside the cell | Use the saved continuous positions, using only this frame. |
| Wrapped coordinates without image counts | Keep showing File coordinates unless the separate inference checkbox is enabled. |

A CFG's image counts remain metadata during ordinary display. The application
constructs the additional continuous-position array only when Unwrap or a
calculation explicitly needs it. The default File view preserves the source
position; **Wrapped into periodic cell** is available separately. The coordinate
selector and Trajectory status explain when the selected Unwrapped view has no
single-frame data and is temporarily showing File coordinates.

### Unwrapped coordinates from adjacent frames

For a trajectory without sufficient single-frame data, explicitly check **Infer
missing image counts from previous frames** and enable Unwrap. Only then are
crossings inferred:

1. Frame 1 defines image counts of zero for every atom.
2. For each later frame, in trajectory order, every atom's reduced (fractional)
   displacement since its previous observation is computed on each periodic
   axis. A jump larger than half a cell, `n = round(sᵢ − sᵢ₋₁)`, is a boundary
   crossing, and the atom's image count on that axis changes by `−n`.
3. The unwrapped position is the wrapped reduced coordinate plus the image
   count, converted with that frame's own cell.

Reduced coordinates support triclinic cells and cells that change between frames
(NPT, deformation). Open axes are never shifted. Atoms are matched by ID, so
frames may list atoms in any order; files without IDs are matched by row. An atom
missing from some frames is compared with its last observed position when it
returns, and an atom that first appears later starts at image zero. As with any
inference from snapshots, motion of more than half a reduced cell between saved
observations is ambiguous; such trajectories need image counts in the file.

Frames are integrated strictly in trajectory order even when the user jumps
arbitrarily. Selecting frame *k* first displays its File coordinates and starts
the enabled single-frame analyses. After those finish, requested inference
extends integration to frame *k* in the background. Navigation cancels obsolete
inference and does not wait for it. Frames before the integration frontier are
reused. Every crossing is logged (8 bytes each), so frames behind the frontier
are recovered by undoing later crossings. The log is limited to 256 MiB (about
32 million crossings); beyond that the oldest entries are dropped and an earlier
frame is recomputed from frame 1 when needed. Results do not depend on viewing,
prefetch or playback order. Turning inference off cancels outstanding work and
stops using cached inferred display coordinates; known single-frame file data
continues to work.

Unwrap display supplies Position X/Y/Z colors, atom details and the second view.
It does not change the canonical wrapped geometry used by ordinary single-frame
analyses. Total displacement resolves available file image counts on demand,
independently of the display mode. Reconstructing missing CFG crossing history
for total displacement requires the same explicit inference checkbox, including
for physical copies. With it off, calculations use the information supplied by
the selected frames and do not scan history automatically.

Display inference is unavailable while **Replicate atoms for analysis** is on;
display replication works normally. Image exports wait for any requested,
available Unwrapped view to finish, so its temporary File preview cannot enter
a PNG, JPG, movie or frame-series export. If no image data exists and inference
is off, the clearly indicated File fallback is the view that is exported.

## Jump to a frame

The time bar includes a **Frame** input and **Go** button. Frame numbers start at
1: enter a number and press **Enter** or **Go** to jump directly. The allowed
range follows the known frame count, including while progressive indexing finds
more frames. Invalid numbers leave the current structure unchanged.

Dragging the time slider previews the frame number and loads the selected frame
when the pointer is released. Keyboard changes use a short debounce. A new
navigation target cancels obsolete frame and inference requests; the latest
selection owns the visible result. Cached frames and incremental crossing history
are reused for large forward jumps, backward seeks and repeated frames.

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

Parsed coordinates of recently used frames are kept in the existing structure
Worker. The cache targets a 192 MiB baseline and grows with the actual coordinate
snapshot sizes to cover the smoothing window, one next frame and parser
read-ahead. The hard limit reserves half the existing CPU memory budget for
other source and native resources, and is always at most 768 MiB. Small device
or heap hints can lower it below the baseline. Matching, equally ordered atom IDs
share one private array; retained typed-array backing buffers count once.
Frames farthest from the current windows are evicted first. When a window
needs more than the limit, the status explains that frames may be reread;
the averaging order and numerical results are unchanged. This cache budget
excludes active parsers and averaging output buffers. Progress is shown while
averaging; changing the frame cancels the work. Warm parser Workers and the
shared CPU admission budget are reused.

## Trajectory lines

Choose the atoms (a [selection group](selection-groups.md) or a list of IDs),
the first and last frame and a step (**Every**), then **Generate lines**. The
Worker reads the sampled frames, matches the atoms by ID and builds one
polyline per atom. File image counts and saved continuous coordinates are used
directly. Without them, paths keep the saved positions and their periodic jumps
unless **Infer missing image counts from previous frames** is checked. With that
explicit consent, each step adds the minimum-image displacement since the atom's
previous sample. This reads only the chosen samples; it does not scan unselected
history. Choose a step small enough that atoms move less than half a cell between
samples. Changing the inference checkbox removes generated or pending paths;
generate them again using the new coordinate convention. Atoms found
in fewer than two sampled frames produce no line; missing IDs are listed.

Atoms created with **Replicate atoms for analysis** can also be traced, from
either an explicit ID list or a selection group. Each selected copy follows
its original atom's continuous path plus its copy offset along that sample's
cell vectors. Changing cell size, tilt and origin are therefore included.
The Worker reads each original sampled frame once, regardless of how many
copies are selected. Copy IDs are preserved in the paths and configuration.
Changing or resetting physical replication removes the old paths and cancels
pending generation; generate them again for the current atoms. Display-only
replication continues to repeat the existing lines without recalculating them.

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

## Limitations

- Explicitly enabled cross-frame inference integrates frames in order, so its
  first view of a late frame can read every earlier frame once. Single-frame
  image data never needs that scan; subsequent inferred views reuse the crossing
  log within its memory limit.
- The integration runs in the structure Worker and occupies it for about
  72 ms per 1,000,000-atom frame.

## Configuration

The timeline provides an editable **FPS** rate (0.1–60) and two playback modes.
**Complete results** displays each frame after its required visual results are
ready and actually drawn; unrelated background statistics do not hold the
display. Preparation time counts toward its frame interval. Slow calculations can reduce
the achieved rate. **Quick preview** follows the requested clock and replaces
obsolete frame requests, so it may skip frames. Interactive preview appearance
does not replace a frame's formal scientific values. Image, movie and data
exports continue to wait for the requested formal results.

`settings.extensions.playback` stores `fps` (default 1) and `mode`
(`complete`, the default, or `preview`). Restoring these settings does not start
playback; older recipes use the defaults.

`settings.display.coordinateMode` stores `file` (the default), `wrapped` or
`unwrapped`. `settings.extensions.trajectory.unwrap.inferFromFrames` stores the
separate inference checkbox and defaults to `false`; selecting Unwrapped in an
older configuration does not implicitly enable trajectory inference.

`settings.extensions.trajectory` also stores `smoothing.enabled`, `smoothing.window`
(1–50) and the line settings: `enabled`, `source` (`ids` or `group`),
`selectionGroupId`, `atomIds` (at most 100,000), `firstFrame`, `lastFrame`
(`null` means the last frame), `stride`, `visible`, `color`, `width` (0.5–16),
`colorByTime` and `colorScheme`. Smoothing is applied before the saved frame is
prepared; enabled lines are recalculated after import. Configurations without
the extension restore inference off, unsmoothed coordinates and no lines.

The smoothing setting always describes the displayed frame. A configuration
that is rejected or interrupted before its frame is shown leaves the setting
that produced the frame on screen, and analyses keep using those coordinates.
Selecting the displayed frame again while a smoothing change is still being
applied prepares that frame with the new setting instead of keeping the old
one.

## Implementation

[Unwrapping, smoothing and line construction](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/data/trajectory-tools.js),
[Worker processing and caching](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/workers/trajectory-processor.js),
[structure Worker requests](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/workers/structure-worker.js),
[line rendering](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/trajectory-line-layer.js),
[panel controls](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/ui/selection/trajectory-tool-controls.js).
The behavior follows OVITO's Unwrap trajectories, Smooth trajectory and
Generate trajectory lines modifiers; the code is an independent
implementation.
