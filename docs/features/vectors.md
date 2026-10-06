# Vector arrows

## Multiple fields

Use **Add field** to overlay another vector family. Choose the field to edit, give it a name, and toggle **Show this field** independently. Each field keeps its own source, Cartesian component scales, length scale, color, arrow sizes, anchor and geometry. **Delete field** removes the selected layer. Settings files preserve all fields and the selected editor; older single-vector settings still restore as one field.

## Choose existing vector data

Vector is a display tool. It draws existing per-atom data and does not calculate or add scalar properties. A newly opened source starts with **Custom XYZ**: choose three numeric properties and, when needed, a separate signed display scale for each Cartesian component.

**Force** and **Velocity** appear only when the source contains a complete imported component family. Other complete XYZ or indexed component families are offered by name; incomplete families are omitted. **Displacement** becomes available after the independent [Displacement analysis](displacement.md) has calculated its components.

Preset sources hide the custom component and axis-scale menus. Reference frame and minimum-image controls belong to the Displacement tool. Changing a vector source or display scale leaves the source properties unchanged.

A selected source or Custom XYZ component keeps its selection across frame changes. Arrows wait until the required properties are ready. Cancelling a calculation hides only fields that depend on it in both views, including while its result is pending. Recalculating does not turn those fields on again. Other vector fields remain visible.

## Arrow visibility and scale

**Show this field** controls each overlay independently of atom visibility. Atom legend checkboxes and element or individual-atom appearance controls can hide every atom while leaving vectors visible. World-space slices still clip arrows, and replication copies them into the selected periodic cells. Periodic display-origin changes move all arrow anchors with their atoms. The second view and image exports use every visible field.

**Length scale** converts component values into displayed lengths in Å. For Custom XYZ, the signed component scales are applied before this shared factor. These controls change arrow geometry only. **Arrow color** controls the overlay color. Zero-length and non-finite vectors are omitted.

## Anchor and arrow geometry

**Tail** puts the starting point at the atom, **Head** puts the arrow tip at the atom, and **Center** puts the midpoint at the atom. The direction remains the selected vector for all three choices.

Shaft radius, head radius and head length are given in Å. The default linked proportions preserve their current ratios when any of these dimensions changes; turn off the link to edit sizes independently. Relinking preserves the new ratios you selected. Very short arrows reduce the head length to fit rather than extending beyond the vector.

**3D** draws a cylindrical shaft and conical head. **2D** retains the original world-space vector direction instead of discarding its Z component. Its plane can face the current camera, so each viewport orients its own flat faces, or use a fixed up direction shared by both views. The fixed plane spans the vector and its width direction, defined by their cross product with the chosen up vector. Parallel directions use a stable fallback.

## Implementation and reference

[Vector families and linked dimensions](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/vector-settings.js), [arrow primitives](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/atom-primitives.js), [vector controls](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/atomeye-tools.js).

The display controls follow the concepts described in OVITO's [Vectors visual element](https://www.ovito.org/manual/reference/pipelines/visual_elements/vectors.html). The rendering behavior above describes AlloyView's implementation.
