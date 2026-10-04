# Slices

## Controls

Add, select, rename, enable or delete clipping planes. Up to 16 planes can exist. Enter a finite nonzero Cartesian normal, choose an X/Y/Z preset, and set the signed plane position in Å. Choose the positive or negative retained side.

With this panel open, the selected plane and its editing arrow appear in the viewport. Drag the arrowhead to rotate the normal, or drag the shaft/position handle to move the plane along its normal. Switching tools hides editing overlays while preserving clipping.

## Algorithm

The committed normal `n` is normalized. Points on the plane satisfy `n · r = d`; the negative side retains `n · r ≤ d`, and the positive side retains `n · r ≥ d`, with a small numerical tolerance. Enabled planes apply together: visible atoms belong to the intersection of their retained half-spaces.

Clipping uses the atom center at its actual displayed Cartesian position. Replicas use their translated positions and unwrapped coordinates use their displayed positions. The source data and analysis input remain intact. Sliced-out atoms cannot be picked, and image exports include clipping while excluding editing overlays.

## Implementation

[Plane validation and visibility](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/slicing.js), [editing controls](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/slice-controls.js), [viewport gizmo](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/slice-gizmo.js).
