# Slices

## Controls

Add, select, rename, enable or delete clipping planes. Up to 16 planes can exist. Enter a finite nonzero Cartesian normal, choose an X/Y/Z preset, and set the signed plane position in Å. Choose the positive or negative retained side.

With this panel open, the selected plane and its editing arrow appear in the viewport. Drag the arrowhead to rotate the normal, or drag the shaft/position handle to move the plane along its normal. Switching tools hides editing overlays while preserving clipping.

## Sweep a plane

Each plane has its own **step** in Å, 1 Å for a new plane. Under **Sweep along the normal**, **+** moves the plane by one step along `n` and **−** moves it back. A click or tap moves one step; holding the button moves one step at once, then repeats every 80 ms after a 0.4 s pause until release. With a button focused, Enter or Space moves one step. With the **Plane position** field focused, Arrow Up and Arrow Down also move one step. Stepping changes only the position: the normal, retained side, name and Miller indices stay. It updates the same plane uniforms as dragging the shaft, so no atom data are uploaded or recalculated.

**Flip** swaps the retained side between `n · r ≤ d` and `n · r ≥ d`. The normal, position and step stay, so **+** still moves along the same direction. Atoms within the numerical tolerance of the plane belong to both sides.

## Slabs

Check **Slab · keep |n · r − d| ≤ t/2** to keep atoms within half the thickness `t` of the plane on both sides. Set `t` in Å in the field beside the check box; a new plane uses 2 Å. In slab mode **Keep atoms on** and **Flip** are unavailable because a slab has no retained side, and the list shows the plane as **Slab**. The step and thickness are independent: a slab one interplanar spacing thick, swept by the same spacing, shows one atomic plane at a time. Turning slab mode off restores the saved side and keeps the thickness for later.

A slab is one slice. It combines with the other enabled slices exactly as a half-space does: an atom stays visible only when every enabled slice keeps it. Slabs can therefore be combined with half-spaces, or two slabs can be crossed to keep a column.

## Miller-index normals

Under **Normal from Miller indices (h k l)**, enter three integers that are not all zero. The line below previews the Cartesian unit normal and the interplanar spacing `d` in the current frame's cell. **Apply**, or Enter in one of the index fields:

- sets the normal to the (h k l) direction,
- moves the plane to the (h k l) lattice plane nearest its previous center (the point of the plane closest to the cell center), and
- sets both the step and the slab thickness to `d`.

The indices are relative to the **simulation cell** (`a`, `b`, `c` of the loaded file), not to a crystal unit cell. For a supercell of `N₁ × N₂ × N₃` conventional cells aligned with the cell vectors, the crystal plane (h k l) is (N₁h N₂k N₃l). For example, the FCC (111) planes of a 10 × 10 × 10 supercell are (10 10 10), with `d = a/√3`. Atomic planes can be closer than the lattice-plane spacing for a non-primitive cell: FCC (100) atomic planes are `a/2` apart, which is (2N 0 0) in an N × N × N supercell. Display replication does not change the indices.

Editing a normal component, pressing an X/Y/Z preset, rotating the normal in the viewport or building a plane from atoms clears the indices. Editing only the position keeps them. The stored normal is Cartesian: when a later trajectory frame has a different cell, the plane keeps its numerical normal and position, and the preview reports that the cell differs. **Apply** realigns it with the current frame's cell.

## Cut outlines

**Show cut outlines on the cell** draws, for every enabled slice, where its plane meets the displayed cell (both faces for a slab). Each outline is clipped to the region kept by the other enabled slices, so it marks the actual cut surfaces. Outlines remain visible after switching to another tool, appear in both views, and are drawn on top of atoms like the editing overlay. They use the interface accent cyan on dark backgrounds and a deeper teal on light backgrounds, distinct from the cell box. **Include outlines in exported images** controls whether PNG and JPG downloads, six-view images, frame image series and second-view PNGs include the outlines that are shown; it does not add outlines that are hidden. Editing planes, arrows and guide spheres are never exported.

## Build a plane from atoms

Open **Build a plane from atoms**, press **Pick atoms**, and click or tap up to three distinct atom IDs in order. Their IDs appear below the buttons. Dragging still rotates the view. **Finish picking** ends picking without clearing the IDs; picking also ends automatically after the third atom. **Clear picks** starts a new selection. Switching tools ends picking and keeps the existing clipping planes.

Every picked atom remains highlighted while its ID is retained, including after
the third pick and plane creation. Slice picks and measurement picks have
independent highlights; clearing slice picks leaves measurement selections
intact. The second view shows the same highlights.

- **Between 2 atoms** creates the perpendicular bisector of the first two picks. Its normal points from the first atom to the second, and its positive retained side contains the second atom.
- **Through 3 atoms** creates a plane through the first three picks. Their order sets the right-hand normal `(r₂ − r₁) × (r₃ − r₁)` and the positive retained side.
- **Move to atom** moves the selected plane through the last picked atom, preserving its normal, retained side, slab settings, step and Miller indices. With no slice picks, it uses the currently selected atom. This requires an existing selected plane. After **Apply**, **Move to atom** places an (h k l) plane through a chosen atom, so that stepping by `d` visits that atom's neighboring atomic planes.

These operations use the picked atoms' current displayed Cartesian coordinates, including wrapped/unwrapped mode and the periodic display origin. Picking a display replica includes that replica's cell translation in the plane geometry. They use direct displayed geometry without a nearest-periodic-image correction. To build a plane across a periodic boundary, first adjust **Display → Periodic display origin** so the atoms form a continuous region within the cell, or pick neighboring displayed replicas.

Coincident picks cannot define a bisector; three collinear picks cannot define a plane. The status explains the error and leaves existing planes intact. Newly constructed planes count toward the 16-plane limit. Once created, a plane retains its numerical position and normal across trajectory frames; **Move to atom** can place it through an atom's updated position.

## Algorithm

The committed normal `n` is normalized. Points on the plane satisfy `n · r = d`; the negative side retains `n · r ≤ d`, the positive side retains `n · r ≥ d`, and a slab of thickness `t` retains `|n · r − d| ≤ t/2`, each with a tolerance of 10⁻⁵ Å. Enabled slices apply together: visible atoms satisfy every enabled slice.

Shaders test half-spaces of the form `m · r ≤ w`. A negative side is `(n, d)`, a positive side is `(−n, −d)`, and a slab contributes two: `(n, d + t/2)` and `(−n, t/2 − d)`. Sixteen slices therefore need at most 32 half-spaces. Atoms, bonds, vectors, Voronoi cells, dislocation lines and Wigner–Seitz site markers use the same list, and picking applies the same rule in double precision.

**Miller normal and spacing.** Let the cell matrix `H` have rows `a₁`, `a₂`, `a₃` (Å). The reciprocal vectors `bᵢ`, defined by `bᵢ · aⱼ = δᵢⱼ` without a factor of 2π, are the columns of `H⁻¹`; this holds for orthogonal and triclinic cells. For integer indices,

- `G = h b₁ + k b₂ + l b₃` (Å⁻¹),
- the unit normal is `n = G / |G|`, and
- the interplanar spacing is `d_hkl = 1 / |G|` (Å).

The (h k l) lattice planes are `G · (r − o) = m` for integers `m`, where `o` is the cell origin, that is `n · r = n · o + m d_hkl`. **Apply** chooses the integer `m` nearest the previous plane center. Every lattice point `o + u a₁ + v a₂ + w a₃` lies on plane `m = hu + kv + lw`. For a cubic cell of edge `a` this gives `d = a / √(h² + k² + l²)`; for a hexagonal cell, `1/d² = 4(h² + hk + k²)/(3a²) + l²/c²`.

**Stepping** sets `d ← d + k s` for `k` whole steps of length `s`. Starting from a lattice plane with `s = d_hkl`, every step lands on the next lattice plane.

**Cut outlines** intersect each boundary plane with the twelve edges of the displayed cell, including display replication, and order the intersection points around their centroid. The resulting convex polygon is clipped by every other enabled half-space (Sutherland–Hodgman, with the 10⁻⁵ Å tolerance). Polygons are rebuilt only when the slices or the displayed cell change, and drawn as lines with depth testing off.

Clipping uses the atom center at its actual displayed Cartesian position. Replicas use their translated positions and unwrapped coordinates use their displayed positions. The source data and analysis input remain intact. Sliced-out atoms cannot be picked, and image exports include clipping while excluding editing overlays.

## Limitations

- A normal can be entered as Cartesian components or as Miller indices (h k l) of a plane. Lattice directions [u v w] are not accepted; enter the Cartesian vector `u a₁ + v a₂ + w a₃` instead.
- A slab keeps the atoms inside it. There is no mode that removes the slab and keeps the atoms outside; two half-space slices cannot express it either, because enabled slices always intersect.

## Configuration

Each item in `settings.slices.items` stores `id`, `name`, `normal` (unit Cartesian vector), `position` (Å), `enabled`, `side` (`negative` or `positive`) and `showGizmo`, and also:

| Field | Meaning | Default when absent |
| --- | --- | --- |
| `slab` | Keep a slab instead of one side | `false` |
| `thickness` | Slab thickness `t` in Å, 10⁻⁶ to 10¹⁵ | `2` |
| `step` | Sweep step in Å, 10⁻⁶ to 10¹⁵ | `1` |
| `miller` | Applied integer indices `[h, k, l]`, not all zero, each at most 10⁶ in magnitude, or `null` | `null` |

`settings.slices.showOutlines` (default `false`) and `settings.slices.exportOutlines` (default `true`) store the two outline choices. Configurations saved before these fields existed restore the same half-spaces with 1 Å steps and no outlines. Import rejects other types and out-of-range values before changing the view.

## Implementation

[Plane validation, visibility, slabs, Miller planes and outlines](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/slicing.js), [atom-defined geometry](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/slice-from-atoms.js), [editing controls](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/slice-controls.js), [viewport gizmo](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/slice-gizmo.js), [plane uniforms and outline drawing](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/webgl-renderer.js).
