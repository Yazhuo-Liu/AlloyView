# Display and image export

## Controls

The initial **Color by** list includes **Position X/Y/Z** without running an
analysis. These Cartesian values follow the Display wrapped/unwrapped setting;
moving the periodic display origin or adding display-only copies keeps each
source atom's physical color value. Physical replication uses the enlarged
frame's coordinates. Imported velocity components appear as **Velocity X/Y/Z**
with their original column names; a complete triplet also enables **Speed
magnitude**. Velocity units come from the imported fields. All these quantities
use the usual palettes, Auto/manual bounds, selection hiding, second view and
PNG legend, and their settings are saved in configuration JSON.

Choose wrapped coordinates to place periodic atoms inside the simulation cell, or unwrapped coordinates to show the available trajectory positions. **Color by** selects atom types, imported scalar properties, or completed analysis fields. Scalar palettes, fixed ranges, automatic ranges and visibility filters also appear in the viewport legend. Set the range by typing **Min** and **Max** or by dragging the two-thumb slider above them. The slider spans the data range, widened to include any typed limit outside it; its ends give the exact data minimum and maximum. As with the number fields, moving one limit past the other pushes the other one along. A faint histogram behind a scalar gradient divides the displayed range into 48 equal value bands (one band per value for small integer ranges) and shows how many finite values fall in each; square-root heights keep sparse bands visible. Hover or tap the gradient to read the value at that position and how many atoms lie between the limits of its band, for example *6 atoms between 9.92 and 10.26*. The gradient's tooltip explains the bands and counts values outside the range.

Every categorical legend has a visibility checkbox for each class, including each element in **Atom type**. Element choices are stored by label and continue to apply after switching color quantities or trajectory frames. Other categorical filters belong to their own property, so hiding a CNA class does not hide a PTM class with the same numeric ID. These display filters intersect with appearance and scalar-range filters, synchronize to the second view, and are saved in configuration JSON.

For a numeric property containing at most **32 distinct safe integer values**,
the legend also offers **Color scale → Discrete integer values**. Continuous
colors remain the default. Discrete colors show one counted row and visibility
checkbox per actual value, with an additional gray NaN row for undefined values.
Negative integers work too. Colors and hidden values stay attached to the
integer when values disappear, reappear or reorder between frames. If a later
frame contains noninteger values or more than 32 classes, it uses continuous
colors until the field becomes eligible again. Select an atom and use
**Details → Hide … atoms** to hide its current element or discrete class in one
click. These are display filters; analyses still use all atoms. Discrete scales,
hidden values and color settings survive configuration export/import and also
apply to the second view and image legend.

Completed PTM adds **PTM orientation · inverse pole figure** and
**PTM orientation · quaternion RGB** to Color by. The IPF legend selects a
sample X/Y/Z axis or an editable custom Cartesian vector, and displays the
appropriate cubic and/or hexagonal stereographic keys. See
[PTM orientation coloring](./ptm.md#orientation-colors) for the conventions,
supported structures and interpretation. IPF keys are included when exporting
an image with its legend enabled.

**Selections → Hide selected atoms** also hides their connected bonds and attached arrows. Hidden selection members are excluded from scalar **Auto** color limits. Showing the group again restores its values to the automatic range; fixed manual limits stay unchanged across hiding and frame changes. If every finite value is hidden, the legend reports **No visible finite values**. Calculations and statistical CSV exports still include the full analysis frame.

**Atom radius** scales element defaults; 100% uses their normal size. Drag its slider from 20% to 200%, or enter 5% to 500% numerically. The same control appears in **Voronoi → Cell display**, where reducing atom size reveals cell faces. Both copies stay synchronized and change one global radius percentage for both views. Element and per-atom overrides can set absolute radii before this overall scale. **Show cell box** controls the outline. Background and XYZ axes are independent display controls.

Dragging a scalar legend's range slider previews colors and range visibility
in the renderer, without recomputing all atom colors at each step. The main
and second views stay synchronized, including selection-color overrides,
bonds and Voronoi cells. The preview uses normalized floating-point scalars;
releasing the slider, cancelling the pointer or exporting an image restores
the exact CPU colors and histogram. Very narrow ranges that cannot be
represented safely use the exact path throughout.

## Floating second view

**Show a second view** opens a movable, resizable window looking at the same data. It starts on the left on desktop and on the right on phones, keeping the Details button accessible. Drag the window header to move it, or its resize corner to change its size. Focus either handle and use arrow keys for keyboard adjustment; Shift makes a larger step. Home restores the default layout, and Escape cancels an active drag or resize. Position and size remain bounded by the viewport.

Its own toolbar provides Top, Bottom, Front, Back, Left, Right, Perspective and Ortho. Choosing a standard direction highlights its button. Rotating away from it clears the highlight and changes the direction label to **Custom**; panning or zooming retains the current direction. **Fit** frames the structure while retaining a custom orientation. **Apply to main** copies the second camera's position, orientation, projection and zoom to the main view.

Rotate, pan and zoom inside either viewport independently. The second view inherits the main view's atom-radius scale, element and per-atom radius/color overrides, scalar palettes and visibility filters immediately. Both also share coordinates, slices, replication, cell/background settings, bonds, vectors and Voronoi cells. Display edits and trajectory-frame changes preserve the second camera's orientation.

The second view's PNG button exports that camera independently. It uses the shared PNG background, legend and XYZ-arrow settings. Window controls, toolbars and Details stay out of the image. Saving the second view does not replace the main camera.

Configuration JSON saves the second camera and its viewport-relative layout in `settings.extensions.comparison.layout`, with `left`, `top`, `width` and `height` fractions. Restoring the recipe on a different screen adapts the window to the current viewport.

## Periodic display origin

Expand **Display → Periodic display origin** to move the periodic wrapping boundary. Enter an offset as a fraction of each **a**, **b** or **c** cell vector. For example, `a = 0.5` shifts the displayed atoms by half the a vector before wrapping them back into the displayed cell. Negative values are allowed. Triclinic cells use their actual tilted vectors; nonperiodic directions are disabled.

Select an atom and click **Center selected atom** to place it at fractional coordinate `0.5` along every periodic direction. This can join a defect split across opposite cell boundaries into one visible region. **Reset origin** returns all offsets to zero. The operation adjusts periodic wrapping separately from camera centering.

For a periodic direction, wrapped mode displays a source fractional coordinate `f` as `f′ = (f − origin) mod 1`. Unwrapped mode applies the same translation without wrapping, so continuous trajectory positions and lines remain continuous. Nonperiodic coordinates stay unchanged. Both views, bonds, vectors, slicing, picking and exported images use the adjusted display. The source coordinates, scientific cell and analysis results remain unchanged. The fractional origin is saved in configuration JSON.

## Precise camera controls

Open **Adjust view** beside the viewport's download button. This panel starts collapsed on desktop and phones. Its values follow mouse and touch orbit, pan and zoom while it remains open.

Camera position and view direction use Cartesian XYZ coordinates. Changing position translates the camera without changing its direction. Changing direction rotates about the current camera position; directions are normalized automatically. The up vector is read only. Keep **Z pointing upward** checked for the usual orbit controls, or uncheck it to set a roll angle and rotate through the poles.

Drag the direction globe, use its arrow keys, or adjust the azimuth, elevation and roll sliders. Numeric fields provide finer control. Shift plus an arrow key makes a larger rotation; plus and minus zoom. Perspective uses a vertical view angle from 1° to 175°. Parallel projection uses a horizontal field width in structure coordinates; its zoom slider adjusts the same width.

**Cell outline** offers a single color, RGB edges parallel to the cell's three basis vectors, RGB origin edges, or RGB origin edges with black remaining edges. The Display tool's **Show cell box** switch still controls visibility. Camera and outline settings are saved in configuration JSON. The Adjust view panel is excluded from exported images.

## Rendering and camera logic

The renderer draws instanced sphere impostors: each GPU instance is a camera-facing quad whose fragment shader reconstructs a sphere surface and depth. Source atom buffers are reused for periodic copies. The camera's near/far range derives from complete scene bounds, including depth, instead of a fixed distance; this prevents large structures from being cut by the near plane when zooming or using Ortho.

Wrapped/unwrapped display and clipping do not rewrite analysis coordinates. Analyses retain the original frame and its periodic cell.

## Image and trajectory exports

Expand **Display → Export images and atom IDs → Image resolution** to choose
**Current viewport**, **Full HD (1920 × 1080)**, **4K (3840 × 2160)**, twice or
four times the current viewport, or a custom width and height. Current viewport
keeps the existing canvas capture, including its device pixel ratio. Other
choices render the scene at the requested size; enlarging an image therefore
adds rendered detail instead of resizing a screenshot. The camera's vertical
view angle or parallel scale stays fixed, and a changed image aspect ratio
changes the horizontal field of view. The interactive canvas, picking and
camera remain unchanged after export.

For custom images, **Keep aspect ratio** links the dimensions to the current
view's aspect ratio. Uncheck it to set width and height independently. A restored
recipe preserves its saved dimensions exactly until a new edit. Resolution
settings are shared by main PNG, JPG, the second view and every frame in a ZIP,
and saved as `settings.display.png.resolution` in configuration JSON. Older
recipes keep Current viewport.

A chosen resolution sets the **final image size** of a six-view contact sheet;
each camera renders into one of its six slots. Current viewport retains the
existing sheet of three full-width views by two full-height views, with captions.
Thus the 4K preset also produces a 3840 × 2160 six-view download rather than a
six-times-larger bitmap.

Chosen sizes must use whole pixels, at most 16,384 on either side and at most
32 million pixels in total. WebGL2 multisample render targets use up to four
samples where supported. Targets are tiled with overlapping boundaries when
they exceed the GPU's dimension limit or a bounded 128 MiB working budget;
tile pixels stream into the final image canvas. Legends, axes, cell boundaries,
Voronoi edges and slice outlines scale with the image. Export allocation
failures retry with smaller tiles; a lost graphics context or an unavailable
image canvas reports an export error and releases temporary targets.

PNG preserves alpha when **Include background in PNG** is unchecked. Legend and XYZ annotations are composited independently, so enabling a legend does not restore a solid canvas background. With a background, the legend panel uses the colors of the on-screen legend in the current light or dark theme. A scalar legend shows the quantity, color bar and limits; the color map's name is not written into the image. JPG uses an opaque background because the format has no alpha channel.

Six-view PNG combines the six Cartesian directions. Frame images export the requested first/last/step range in a ZIP archive; cancellation stops the export and the original frame is restored. Visible atom ID export uses current display visibility. EPS is unavailable because the previous output stored raster pixels rather than vector geometry.

## Implementation

[WebGL renderer](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/webgl-renderer.js), [periodic display coordinates](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/periodic-origin.js), [camera interactions](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/camera-interactions.js), [display and export integration](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/atomeye-tools.js), [appearance overrides](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/appearance.js).
