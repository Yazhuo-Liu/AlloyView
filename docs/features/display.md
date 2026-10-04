# Display and image export

## Controls

Choose wrapped coordinates to place periodic atoms inside the simulation cell, or unwrapped coordinates to show the available trajectory positions. **Color by** selects atom types, imported scalar properties, or completed analysis fields. Scalar palettes, fixed ranges, automatic ranges and visibility filters also appear in the viewport legend.

Every categorical legend has a visibility checkbox for each class, including each element in **Atom type**. Element choices are stored by label and continue to apply after switching color quantities or trajectory frames. Other categorical filters belong to their own property, so hiding a CNA class does not hide a PTM class with the same numeric ID. These display filters intersect with appearance and scalar-range filters, synchronize to the second view, and are saved in configuration JSON.

Atom radius scales element defaults; element and per-atom overrides can set absolute radii. **Show cell box** controls the outline. Background and XYZ axes are independent display controls.

**Show a second view** creates another camera looking at the same data. Its own toolbar provides Top, Bottom, Front, Back, Left, Right, Perspective and Ortho. Choosing a standard direction highlights its button. Rotating away from it clears the highlight and changes the direction label to **Custom**; panning or zooming retains the current direction. **Fit** frames the structure while retaining a custom orientation.

Rotate, pan and zoom either viewport independently. The second view inherits the main view's atom-radius scale, element and per-atom radius/color overrides, scalar palettes and visibility filters immediately. Both also share coordinates, slices, replication, cell/background settings, bonds and vectors. Display edits and trajectory-frame changes preserve the second camera's orientation; exported configurations save and restore custom orientations as well.

## Rendering and camera logic

The renderer draws instanced sphere impostors: each GPU instance is a camera-facing quad whose fragment shader reconstructs a sphere surface and depth. Source atom buffers are reused for periodic copies. The camera's near/far range derives from complete scene bounds, including depth, instead of a fixed distance; this prevents large structures from being cut by the near plane when zooming or using Ortho.

Wrapped/unwrapped display and clipping do not rewrite analysis coordinates. Analyses retain the original frame and its periodic cell.

## Image and trajectory exports

PNG preserves alpha when **Include background in PNG** is unchecked. Legend and XYZ annotations are composited independently, so enabling a legend does not restore a solid canvas background. JPG uses an opaque background because the format has no alpha channel.

Six-view PNG combines the six Cartesian directions. Frame images export the requested first/last/step range in a ZIP archive; cancellation stops the export and the original frame is restored. Visible atom ID export uses current display visibility. EPS is unavailable because the previous output stored raster pixels rather than vector geometry.

## Implementation

[WebGL renderer](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/webgl-renderer.js), [camera interactions](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/camera-interactions.js), [display and export integration](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/atomeye-tools.js), [appearance overrides](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/appearance.js).
