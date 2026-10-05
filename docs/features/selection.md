# Atom details and measurements

## Atom selection and appearance

Click or tap an atom, or find it by its source ID. The details include input properties and completed analysis quantities. Selecting a replicated image refers to the original atom. Element and per-atom overrides can change color, radius and visibility; per-atom overrides take precedence.

**Atom details** is a floating window in the viewport. It starts expanded on
desktop and collapsed on phones; its button toggles the window. Picking an
atom updates the contents while preserving the window state and current
sidebar tool. The window scrolls independently and is excluded from PNG
exports. **Selected atom appearance** remains collapsed until opened.

## Measurements

Enable measurement mode and pick up to four atoms. Two picks give distance
and its **Δx, Δy, Δz** components in Å, directed from the first selected atom
to the second. Three picks add an angle, and four add a signed dihedral.
Measurements retain IDs rather than display order so they follow trajectory
frames when those IDs remain present.

With minimum-image correction enabled, each consecutive bond is replaced by its shortest permitted periodic vector and the chain is unwrapped successively. The distance components use that same vector, including for a tilted cell. Without correction, components use the displayed wrapped/unwrapped coordinates. Distances are Euclidean lengths in Å. The angle uses the dot product of the two vectors meeting at the middle atom. The signed dihedral projects the outer bonds perpendicular to the central bond and evaluates their orientation using `atan2`.

Zero-length or collinear geometry can leave angles undefined. Minimum-image measurements describe the selected nearest periodic chain, which can differ from a chain of explicitly unwrapped coordinates. Display replication does not create new source IDs.

## Implementation

[Periodic measurements](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/measurements.js), [appearance precedence](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/appearance.js), [picking and inspection](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/atomeye-tools.js).
