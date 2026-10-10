# Atom selection groups

## Create and edit groups

Open **Selections** and click **Add group**, or select atoms to create the first group automatically. Choose **Click atoms** to pick individual atoms or **Drag a box** to select atom centers inside a rectangle. Changes apply immediately; no separate save step is needed. Each group has an editable name, color and **Show group atoms** checkbox.

After selecting atoms, click **Hide selected atoms** to hide the current group's atoms together with their attached bonds and arrows. The button changes to **Show selected atoms** to restore them. Hidden atoms continue to participate in analyses and remain in exported CSV data. Automatic scalar color limits exclude atoms hidden by a selection group; manually fixed limits remain unchanged. The button is available when the current group contains atoms present in the open frame.

Select a group in the list to edit it. **Add atoms** retains its existing members, **Remove atoms** subtracts the picked IDs, and **Replace atoms** replaces all members with the new selection. **Clear members** keeps an empty editable group; **Delete group** removes the group and its display overrides. Up to 64 groups and 1,000,000 stored member IDs are supported.

**Member IDs and manual edits** shows a preview of the group's IDs and accepts space- or comma-separated IDs. The selected Add, Remove or Replace operation also applies to these entries. This allows editing hidden atoms and IDs absent from the current frame. Alternatively, check **Show group atoms** before picking members again. Group counts distinguish IDs present in the current frame from absent IDs.

To select atoms by a condition such as `CSP > 8 && Type == 3`, or to invert a group or expand it by periodic neighbors, use **Modification tools → [Expressions](expressions.md)**. Its results are ordinary groups that this tool edits further.

## Viewport controls

Group picking is active while **Selections** is open. In Click mode, dragging still rotates the camera. In Box mode, dragging with the primary mouse button or one finger draws the selection rectangle; right-drag, the wheel or two fingers navigate the view. **Escape** cancels the rectangle. Switching tools or closing Selections restores normal picking and camera controls while keeping group colors and visibility.

A box selects projected atom centers throughout the viewing depth, including atoms behind the front layer. Visibility masks and clipping planes still apply. The selection operation yields during large scans and is cancelled if the source, frame, camera or selection mode changes before completion.

## IDs, display and persistence

Groups store stable atom IDs rather than row indices. They therefore follow reordered trajectory frames; IDs absent from a frame remain in the group for later frames. Display replicas refer to their source atom, so selecting several copies adds that ID once. With **Replicate atoms for analysis** enabled, physical copies have independent IDs and can belong to different groups.

An ID is identified by its text, so a stored number 7 and a stored text `7` name the same atom. Each new frame is matched without converting every ID to a string. A numeric ID is looked up by number, in a numeric set or by binary search in the frame's sorted ID array. Only an ID whose text is not the canonical text of a number, such as `07` or an integer too large to be stored exactly as a number, is compared as a string. The outcome equals comparing the text of every ID, including for `-0`, NaN, `1e21` and 64-bit integer IDs. With 1,000,000 atoms on a 32-thread workstation, applying a hidden group to a new frame takes 38 ms, the group summary 79 ms and an appearance lookup by ID 205 ms; string matching took 371, 443 and 609 ms. Cluster, binning and expression restrictions to a group use the same matching.

Group colors override the selected element/scalar/crystal palette. Later groups take color precedence when an atom belongs to several groups; a specific per-atom appearance override takes precedence over group color. Membership in any hidden group hides the atom, even if another group containing it is visible. Existing legend filters, individual visibility settings and clipping planes also apply. A group's color does not change the underlying analysis values or legend ranges. [Cluster analysis](clusters.md) can be restricted to one group: only its atoms are connected and measured, and editing the group recalculates the clusters. [Spatial binning](binning.md) can likewise count or reduce only one group's atoms in each bin.

JSON configuration export/import saves group names, colors, visibility, member IDs and the selected group. Click/Box mode and Add/Remove/Replace are temporary editing controls. A new source clears groups; importing its saved configuration restores them after the matching files are opened. Older configurations start with no groups.

## Implementation

[Selection data model](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/selection-groups.js), [atom ID matching](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/data/atom-ids.js), [group controls](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/selection-group-controls.js), [box projection](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/box-selection.js), [appearance precedence](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/appearance.js), [configuration](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/configuration.js).
