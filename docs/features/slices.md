# Slices

## Controls

Add, select, rename, enable or delete clipping planes. Up to 16 planes can exist. Enter a finite nonzero Cartesian normal, choose an X/Y/Z preset, and set the signed plane position in Å. Choose the positive or negative retained side.

With this panel open, the selected plane and its editing arrow appear in the viewport. Drag the arrowhead to rotate the normal, or drag the shaft/position handle to move the plane along its normal. Switching tools hides editing overlays while preserving clipping.

## Build a plane from atoms

Open **Build a plane from atoms**, press **Pick atoms**, and click or tap up to three distinct atom IDs in order. Their IDs appear below the buttons. Dragging still rotates the view. **Finish picking** ends picking without clearing the IDs; picking also ends automatically after the third atom. **Clear picks** starts a new selection. Switching tools ends picking and keeps the existing clipping planes.

Every picked atom remains highlighted while its ID is retained, including after
the third pick and plane creation. Slice picks and measurement picks have
independent highlights; clearing slice picks leaves measurement selections
intact. The second view shows the same highlights.

- **Between 2 atoms** creates the perpendicular bisector of the first two picks. Its normal points from the first atom to the second, and its positive retained side contains the second atom.
- **Through 3 atoms** creates a plane through the first three picks. Their order sets the right-hand normal `(r₂ − r₁) × (r₃ − r₁)` and the positive retained side.
- **Move to atom** moves the selected plane through the last picked atom, preserving its normal and retained side. With no slice picks, it uses the currently selected atom. This requires an existing selected plane.

These operations use the picked atoms' current displayed Cartesian coordinates, including wrapped/unwrapped mode and the periodic display origin. Picking a display replica includes that replica's cell translation in the plane geometry. They use direct displayed geometry without a nearest-periodic-image correction. To build a plane across a periodic boundary, first adjust **Display → Periodic display origin** so the atoms form a continuous region within the cell, or pick neighboring displayed replicas.

Coincident picks cannot define a bisector; three collinear picks cannot define a plane. The status explains the error and leaves existing planes intact. Newly constructed planes count toward the 16-plane limit. Once created, a plane retains its numerical position and normal across trajectory frames; **Move to atom** can place it through an atom's updated position.

## Algorithm

The committed normal `n` is normalized. Points on the plane satisfy `n · r = d`; the negative side retains `n · r ≤ d`, and the positive side retains `n · r ≥ d`, with a small numerical tolerance. Enabled planes apply together: visible atoms belong to the intersection of their retained half-spaces.

Clipping uses the atom center at its actual displayed Cartesian position. Replicas use their translated positions and unwrapped coordinates use their displayed positions. The source data and analysis input remain intact. Sliced-out atoms cannot be picked, and image exports include clipping while excluding editing overlays.

## Implementation

[Plane validation and visibility](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/slicing.js), [atom-defined geometry](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/slice-from-atoms.js), [editing controls](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/slice-controls.js), [viewport gizmo](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/slice-gizmo.js).
