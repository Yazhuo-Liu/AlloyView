# Atom selection groups

## Create and edit groups

Open **Selections** and click **Add group**, or select atoms to create the first group automatically. Choose **Click atoms** to pick individual atoms or **Drag a box** to select atom centers inside a rectangle. Changes apply immediately; no separate save step is needed. Each group has an editable name, color and **Show group atoms** checkbox.

Select a group in the list to edit it. **Add atoms** retains its existing members, **Remove atoms** subtracts the picked IDs, and **Replace atoms** replaces all members with the new selection. **Clear members** keeps an empty editable group; **Delete group** removes the group and its display overrides. Up to 64 groups and 1,000,000 stored member IDs are supported.

**Member IDs and manual edits** shows a preview of the group's IDs and accepts space- or comma-separated IDs. The selected Add, Remove or Replace operation also applies to these entries. This allows editing hidden atoms and IDs absent from the current frame. Alternatively, check **Show group atoms** before picking members again. Group counts distinguish IDs present in the current frame from absent IDs.

## Viewport controls

Group picking is active while **Selections** is open. In Click mode, dragging still rotates the camera. In Box mode, dragging with the primary mouse button or one finger draws the selection rectangle; right-drag, the wheel or two fingers navigate the view. **Escape** cancels the rectangle. Switching tools or closing Selections restores normal picking and camera controls while keeping group colors and visibility.

A box selects projected atom centers throughout the viewing depth, including atoms behind the front layer. Visibility masks and clipping planes still apply. The selection operation yields during large scans and is cancelled if the source, frame, camera or selection mode changes before completion.

## IDs, display and persistence

Groups store stable atom IDs rather than row indices. They therefore follow reordered trajectory frames; IDs absent from a frame remain in the group for later frames. Display replicas refer to their source atom, so selecting several copies adds that ID once. With **Replicate atoms for analysis** enabled, physical copies have independent IDs and can belong to different groups.

Group colors override the selected element/scalar/crystal palette. Later groups take color precedence when an atom belongs to several groups; a specific per-atom appearance override takes precedence over group color. Membership in any hidden group hides the atom, and existing legend filters, individual visibility settings and clipping planes also apply. A group's color does not change the underlying analysis values or legend ranges.

JSON configuration export/import saves group names, colors, visibility, member IDs and the selected group. Click/Box mode and Add/Remove/Replace are temporary editing controls. A new source clears groups; importing its saved configuration restores them after the matching files are opened. Older configurations start with no groups.

## Implementation

[Selection data model](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/selection-groups.js), [group controls](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/selection-group-controls.js), [box projection](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/box-selection.js), [appearance precedence](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/appearance.js), [configuration](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/configuration.js).
