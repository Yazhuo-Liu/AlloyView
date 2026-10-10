# Text labels

## Controls

Open **Visualization tools → Labels** and press **Add label**. Each label has a
text template, a position, offsets, a font size, a text color and an optional
box. Up to 16 labels can be shown at once; **Label** chooses the one being
edited and **Delete** removes it. **Show label** hides a label without deleting
it.

- **Text**: literal text and placeholders such as
  `Timestep [Timestep] · FCC [CNA.FCC.fraction:.1%]`. Line breaks start new
  lines. The line below the text box previews the label for the displayed
  frame.
- **Position**: top left, top, top right, left, center, right, bottom left,
  bottom or bottom right. The label keeps a margin of 12 pixels from the image
  edges.
- **Offset right** and **Offset down** move the label by a number of screen
  pixels (negative values move left or up).
- **Font size** is in screen pixels (6–144).
- **Text color**: **Theme** uses the legend's text color for the light or dark
  theme; **Custom** uses the chosen color.
- **Box**: **Theme panel** draws the legend's panel behind the text,
  **Custom color** an opaque box in the chosen color (with black or white text
  unless a custom text color is chosen), and **None** no box.

**Available attributes** lists every attribute of the displayed frame with its
value and whether it comes from the file or from an analysis. Click a name to
insert it at the cursor; the filter narrows the list. **Strain reference
frame** sets the frame against which `Strain.*` is measured (shared with
[Time series](time-series.md)).

Labels appear over the viewport as soon as they are added and update when the
frame changes or an analysis finishes. Problems in the selected label, such as
an unknown attribute, an invalid number format or an unclosed bracket, are
listed under the editor.

## Template syntax

| Text | Result |
| --- | --- |
| `[Name]` | the attribute's value; integers in full, other numbers to six significant digits |
| `[Name:format]` | the value in a number format (below) |
| `[[` and `]]` | literal `[` and `]` |
| `[?Name]` in the output | `Name` is unknown, or not available in this frame |

Formats follow printf and Python: an optional leading `%`, then optional flags
`+` (always show the sign), space (a space for positive numbers), `0` (pad with
zeros) and `,` (thousands separators), an optional width, an optional
`.precision`, and a type:

| Type | Meaning | Example | Output |
| --- | --- | --- | --- |
| `f` | fixed decimals (default 6) | `[Cell.a:.3f]` or `[Cell.a:%.3f]` | `10.560` |
| `e`, `E` | exponent | `[DXA.line_density:.2e]` | `2.10e-03` |
| `g`, `G` (default) | significant digits (default 6), trailing zeros removed | `[Cell.volume:.4g]` | `1178` |
| `d`, `i` | rounded integer | `[AtomCount:,d]` | `1,234,567` |
| `%` | value × 100 with a percent sign | `[CNA.FCC.fraction:.1%]` | `93.1%` |

Non-finite values print as `NaN`, `Infinity` and `-Infinity`. Names are matched
exactly, or ignoring case when that is unambiguous. Names may contain bracketed
indices, as in `[Mean.c_stress[1]:.3f]`. A placeholder cannot span lines.

Templates are data. They are split into text and placeholders by a small
parser, and each name is looked up in a table of attributes; no part of a
template is evaluated as JavaScript, and names such as `constructor` or
`__proto__` are simply unknown. A template is limited to 1,000 characters and
64 placeholders, and a rendered label to 4,000 characters.

## Global attributes

Attributes are per-frame scalar values with stable names. Where a value also
appears in the Statistics **Structure summary** CSV, it equals that row
exactly; the last column names the row as *analysis / metric / label*.

| Name | Unit | Source | Summary CSV row |
| --- | --- | --- | --- |
| `Frame` | | One-based frame number | `frame_number` column |
| `FrameCount` | | Frames in the source (so far, while indexing) | |
| `Timestep` | | Timestep stored in the file (absent for files without one) | `timestep` column |
| `AtomCount` | | Atoms in the analyzed frame | input / atom_count |
| `Cell.volume` | Å³ | Absolute determinant of the cell matrix h | input / cell_volume |
| `NumberDensity` | Å⁻³ | AtomCount / Cell.volume | input / number_density |
| `Cell.a`, `Cell.b`, `Cell.c` | Å | Lengths of the cell vectors | |
| `Cell.alpha`, `Cell.beta`, `Cell.gamma` | ° | ∠(b, c), ∠(a, c), ∠(a, b) | |
| `Strain.a`, `Strain.b`, `Strain.c` | | Engineering strain (L − L₀)/L₀ of each cell-vector length L | |
| `Strain.volumetric` | | (V − V₀)/V₀ | |
| `Strain.reference` | | One-based strain reference frame | |
| `Type.<element>.count`, `.fraction` | | Atoms of each type; fraction of all atoms | input / atomType.count, atomType.fraction |
| `CNA.<type>.count`, `.fraction` | | CNA structure types (Other, FCC, HCP, BCC, ICO) | cna / structureType.count, .fraction |
| `PTM.<type>.count`, `.fraction` | | PTM structure types | ptm / ptmStructureType.count, .fraction |
| `DXA.structure.<type>.count`, `.fraction` | | DXA crystal structure types | dxa / dxaStructureType.count, .fraction |
| `Symmetry.<type>…`, `IdealStrain.<type>…` | | Auto central-symmetry and ideal-strain structure types | as above |
| `<property>.<label>.count`, `.fraction` | | Any other categorical property, such as cluster or defect classes | as above |
| `Mean.<property>` | property unit | Mean of the finite values of a numeric property: file columns, external and computed properties, analysis outputs | *analysis* / *property*.mean |
| `DXA.total_length` | Å | Total dislocation line length | dxa / total_length |
| `DXA.line_density` | Å⁻² | Line length per cell volume | dxa / line_density |
| `DXA.segment_count` | | Dislocation segments | dxa / segment_count |
| `DXA.<family>.length`, `.count` | Å, — | Per Burgers-vector family, such as `DXA.shockley.length` | dxa / total_length, segment_count with the family |
| `Clusters.cluster_count`, `Clusters.largest_size`, `Clusters.percolating_count` | | Cluster analysis | clusters / … |
| `Grains.grain_count`, `Grains.mean_size`, `Grains.largest_size`, `Grains.unassigned_atoms`, `Grains.merge_threshold` | —, atoms, atoms, —, — or ° | Grain segmentation | grains / … |
| `WignerSeitz.vacancy_count`, `.interstitial_count`, `.antisite_count`, `.site_count` | | Wigner–Seitz defects | wignerSeitz / … |

Category labels become name segments with other characters replaced by an
underscore: `Hex. diamond` is `PTM.Hex_diamond.fraction`. Fractions are 0–1
and use all analyzed atoms as the denominator, as in the summary CSV; use the
`%` format to print a percentage.

Analysis attributes exist only once that analysis has finished for the
displayed frame; until then a label shows `[?Name]`. Strain needs the reference
frame's cell, which is read in the background when another frame is
displayed. Attributes describe the complete analyzed frame: hidden atoms,
slices and display copies do not change them, while **Replicate atoms**
enlarges the analyzed frame.

## Labels in images

Every image export draws the labels after the legend and XYZ arrows, with each
image's own values:

- **PNG** and **Export JPG** at the current viewport size draw labels at the
  device pixel ratio, matching the screen.
- At a **chosen resolution**, the font, margins, offsets and box scale with
  the image like the legend (the same annotation scale), so a label occupies
  the same fraction of a 4K image as of the viewport.
- A **Six-view PNG** stamps each label **once for the whole sheet**, at the
  scale of one view, positioned relative to the sheet. The six views
  themselves carry no labels.
- The **second view's PNG** stamps the labels of the current frame.
- **Frame images** resolve the labels again for every frame after its
  enabled analyses have finished, so each image in the ZIP shows its own
  timestep, strain or phase fractions.

Without **Include background in PNG**, a theme panel is left out and theme
text turns dark, as for the legend; custom boxes and colors are kept. With no
enabled label, exports are unchanged. The on-screen labels are not part of the
viewport's WebGL image and are never captured twice.

## Limitations

On screen, a label is positioned relative to the whole viewport and is not kept
clear of the viewport toolbars and other overlays, so it can overlap them; use
the offsets to move it. Exported images contain no toolbars.

## Configuration

Labels are saved in `settings.extensions.textLabels` as
`{ labels: [{ id, enabled, text, position, offset: [x, y], fontSize, color, box, boxColor }], selectedId }`.
`color` is `null` for the theme color or a six-digit hex color; `box` is
`theme`, `custom` or `none`. Import checks every field, the text length and
characters (line breaks are the only control characters allowed), and up to 16
labels before anything is applied; the text is parsed again by the template
parser when shown. The strain reference frame is saved in
`settings.extensions.globalAttributes.strainReferenceFrame` (zero-based). Both
are omitted when unused, so older recipes restore without labels.

## Implementation

[Template parser and formatter](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/text-labels.js), [attribute registry](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/global-attributes.js), [attribute source and strain reference](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/global-attribute-source.js), [label panel and overlay](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/text-label-controls.js), [image drawing](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/text-label-overlay.js).
