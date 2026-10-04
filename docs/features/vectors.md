# Vector arrows

## Choose existing vector data

Vector is a display tool. It draws existing per-atom data and does not calculate or add scalar properties. A newly opened source starts with **Custom XYZ**: choose three numeric properties and, when needed, a separate signed display scale for each Cartesian component.

**Force** and **Velocity** appear only when the source contains a complete imported component family. Other complete XYZ or indexed component families are offered by name; incomplete families are omitted. **Displacement** becomes available after the independent [Displacement analysis](displacement.md) has calculated its components.

Preset sources hide the custom component and axis-scale menus. Reference frame and minimum-image controls belong to the Displacement tool. Changing a vector source or display scale leaves the source properties unchanged.

A selected calculated source or Custom XYZ component keeps its selection while an enabled analysis recomputes for a different frame. Arrows wait until the required properties are ready. Cancelling a calculation used by any arrow component unchecks **Show arrows** and clears arrows in both views, including while its result is pending. Recalculating does not turn arrows on again. Cancelling an unrelated calculation leaves imported vector arrows enabled.

## Arrow visibility and scale

**Show arrows** controls the overlay independently of atom visibility. Atom legend checkboxes and element or individual-atom appearance controls can hide every atom while leaving vectors visible. World-space slices still clip arrows, and replication copies them into the selected periodic cells. The second view uses the same vector data with its own camera.

**Length scale** converts component values into displayed lengths in Å. For Custom XYZ, the signed component scales are applied before this shared factor. These controls change arrow geometry only. **Arrow color** controls the overlay color. Zero-length and non-finite vectors are omitted.

## Anchor and arrow geometry

**Tail** puts the starting point at the atom, **Head** puts the arrow tip at the atom, and **Center** puts the midpoint at the atom. The direction remains the selected vector for all three choices.

Shaft radius, head radius and head length are given in Å. The default linked proportions preserve their current ratios when any of these dimensions changes; turn off the link to edit sizes independently. Relinking preserves the new ratios you selected. Very short arrows reduce the head length to fit rather than extending beyond the vector.

**3D** draws a cylindrical shaft and conical head. **2D** draws a flat arrow facing the current camera; it retains the original world-space vector direction instead of discarding its Z component. Each viewport therefore orients its own flat arrow faces.

## Implementation and reference

[Vector families and linked dimensions](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/vector-settings.js), [arrow primitives](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/atom-primitives.js), [vector controls](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/atomeye-tools.js).

The display controls follow the concepts described in OVITO's [Vectors visual element](https://www.ovito.org/manual/reference/pipelines/visual_elements/vectors.html). The rendering behavior above describes AlloyView's implementation.
