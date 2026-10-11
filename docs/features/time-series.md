# Time series

## Controls

Open **Visualization tools → Time series**. Type an attribute name in
**Attribute**, or pick one from its list, and press **Add**; up to eight
attributes can be plotted. The names are the [global attributes](text-labels.md#global-attributes)
used by text labels, for example `Cell.volume`, `Strain.a`, `Mean.c_pe`,
`Type.Ni.fraction`, `CNA.FCC.fraction`, `DXA.line_density` or
`WignerSeitz.vacancy_count`. Each entry shows whether its values come from the
**file** or from an **analysis**; **Remove** drops it.

- **First frame**, **Last frame** and **Step** choose the frames (one-based).
- **Horizontal axis**: the frame number, or the timestep when every frame in
  the range has one.
- **Strain reference frame** is the frame against which `Strain.*` is
  measured (shared with the Labels panel).
- **One panel per attribute** draws every attribute in its own panel.
- **Read file values** reads the frames in the background and fills every
  file attribute.
- **Visit frames** displays each frame that still lacks an analysis value and
  then returns to the frame you started from.
- **Cancel** stops reading or visiting; values already collected are kept.
- **Series CSV** downloads the table; **Clear collected values** empties it.

The state shows **Not collected**, **Reading…**, **Visiting…**, **Partial**
(some frames lack a value) or **Complete**. The status line names each
attribute that has missing frames and how many.

## Where values come from

**File attributes** (frame number, timestep, atom count, cell volume, lengths,
angles and strain, atom-type fractions, and means of columns read from the
file or imported as [external properties](external-properties.md)) depend
only on the frame as read. **Read file values** requests the frames through
the structure Worker in the background, in order, without caching them and
without displaying them: the viewport, its analyses and the selected frame do
not change. Frames whose values are already known, including the displayed
frame and frames seen earlier, are not read again. Progress is shown and the
reading can be cancelled at any time.

Stepping to another frame does not cancel this collection. Readers of the
same frame share its in-flight parse, but each reader can cancel independently;
only departure of the last reader cancels the underlying work. Changing the
source or processing settings still invalidates incompatible reads.

**Analysis attributes** (CNA, PTM and DXA structure fractions, DXA line
length and density, cluster and Wigner–Seitz counts, means of analysis outputs
and of computed expression properties) are recorded from the displayed frame
whenever its attributes change: when you step through or play the trajectory,
when an enabled analysis finishes, and during **Frame images** export. They
are therefore exactly the values the viewer, the labels and the Statistics
summary CSV report for that frame, computed by the same code with the same
settings. **Visit frames** fills the remaining frames by displaying them one
after another; each step waits for the enabled analyses to finish, as frame
image export does, and the original frame is shown again at the end. Changing
the displayed frame yourself stops the visit.

Analyses are not repeated invisibly in the background. Every analysis has its
own parameters, prerequisites and Worker or GPU scheduling tied to the
displayed frame; running them again for hidden frames would compete with the
displayed frame for the same analysis pool and could produce numbers that
differ from what is shown. Recording finished results keeps the plot
consistent with the viewer and costs nothing extra.

Each value is stored with the settings that produced it: an analysis's
parameter key, an expression's text and upstream input identities, or the strain reference frame. When an
attribute arrives with different settings (for example after changing the CNA
mode or the strain reference), its older points are discarded, so a curve
never mixes settings; a new import of an external property counts as new
settings. Opening another source, changing trajectory smoothing or switching
**Replicate atoms** clears all values.

This also applies to coordination cutoffs, bond cutoffs, local shear and
displacement settings. Expressions depending on those outputs inherit their
parameter identity. An analysis output without a nonempty parameter key is
shown as waiting for recalculation in global attributes and cannot enter the
series; it remains available for ordinary atom coloring. Same settings across
frames retain their previously collected points.

## Chart and table

Attributes with the same unit share a panel with one y axis; attributes with
different units are drawn in separate panels that share the horizontal axis
and the crosshair, so no panel has two y scales. Each attribute keeps its line
color while others are added or removed; the legend lists the unit and how
many frames have a value. Missing frames break the line, and isolated values
are drawn as points. Hover or tap a panel, drag **Inspect frame**, or focus a
panel and press left/right, Home or End to move the crosshair; the readout
lists every attribute at that frame, with **missing** where a value is not
known yet. Colors follow the light or dark theme.

**Series CSV** writes `source_file`, `frame_number`, `timestep`, then one
column per attribute with its unit in brackets, one row per frame in the
range. Missing values are empty cells. Numbers use the shortest round-trip
decimal representation, as in the Statistics CSV files.

## Performance

On the bundled 40-frame `fixed_end_climb` CFG sequence (257 atoms), reading
`AtomCount`, `Cell.volume` and `Strain.volumetric` for all frames took
0.05–0.14 s, and visiting all frames with adaptive CNA enabled 2.0–2.8 s
(four runs), in headless Chrome with software rendering on the reference
machine. Visiting is dominated by displaying each frame and its analyses. Reading time
grows with frame size and count, since each frame is parsed again; frames
already in the trajectory cache are reused.

## Limitations

- Analysis values exist only for frames that have been displayed with the
  analysis enabled; **Visit frames** is the way to fill the rest.
- The chart has no image export. Use **Series CSV** to plot the values
  elsewhere.

## Configuration

`settings.extensions.timeSeries` stores `attributes` (up to 8 names of at most
256 characters), zero-based `firstFrame`, `lastFrame` (`null` for the last
frame), `stride`, `xAxis` (`frame` or `timestep`), `separatePanels` and
`autoCollect`. Values are never stored. When `autoCollect` is true (the series
had been collected), restoring the recipe reads the file values again;
analysis values reappear as frames are analyzed. Frames must lie within the
saved source's frame count. The strain reference is stored in
`settings.extensions.globalAttributes`. Both are omitted when the panel is
unused, so older recipes are unchanged.

## Implementation

[Collection, store and CSV table](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/time-series.js), [panel and frame visits](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/time-series-controls.js), [chart](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/time-series-chart.js), [attribute registry](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/global-attributes.js).
