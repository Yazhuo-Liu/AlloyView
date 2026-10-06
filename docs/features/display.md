# Display and image export

## Controls

Choose wrapped coordinates to place periodic atoms inside the simulation cell, or unwrapped coordinates to show the available trajectory positions. **Color by** selects atom types, imported scalar properties, or completed analysis fields. Scalar palettes, fixed ranges, automatic ranges and visibility filters also appear in the viewport legend.

Every categorical legend has a visibility checkbox for each class, including each element in **Atom type**. Element choices are stored by label and continue to apply after switching color quantities or trajectory frames. Other categorical filters belong to their own property, so hiding a CNA class does not hide a PTM class with the same numeric ID. These display filters intersect with appearance and scalar-range filters, synchronize to the second view, and are saved in configuration JSON.

Atom radius scales element defaults; element and per-atom overrides can set absolute radii. **Show cell box** controls the outline. Background and XYZ axes are independent display controls.

**Show a second view** creates another camera looking at the same data. Its own toolbar provides Top, Bottom, Front, Back, Left, Right, Perspective and Ortho. Choosing a standard direction highlights its button. Rotating away from it clears the highlight and changes the direction label to **Custom**; panning or zooming retains the current direction. **Fit** frames the structure while retaining a custom orientation.

Rotate, pan and zoom either viewport independently. The second view inherits the main view's atom-radius scale, element and per-atom radius/color overrides, scalar palettes and visibility filters immediately. Both also share coordinates, slices, replication, cell/background settings, bonds and vectors. Display edits and trajectory-frame changes preserve the second camera's orientation; exported configurations save and restore custom orientations as well.

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

PNG preserves alpha when **Include background in PNG** is unchecked. Legend and XYZ annotations are composited independently, so enabling a legend does not restore a solid canvas background. JPG uses an opaque background because the format has no alpha channel.

Six-view PNG combines the six Cartesian directions. Frame images export the requested first/last/step range in a ZIP archive; cancellation stops the export and the original frame is restored. Visible atom ID export uses current display visibility. EPS is unavailable because the previous output stored raster pixels rather than vector geometry.

## Implementation

[WebGL renderer](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/webgl-renderer.js), [periodic display coordinates](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/periodic-origin.js), [camera interactions](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/camera-interactions.js), [display and export integration](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/atomeye-tools.js), [appearance overrides](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/appearance.js).
