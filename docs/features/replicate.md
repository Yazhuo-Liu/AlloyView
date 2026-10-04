# Replicate

## Controls

Set total copy counts along lattice vectors **a**, **b**, and **c**. Each count includes the original cell; `2 × 3 × 1` shows six cells. Non-periodic axes remain at one. **Original cell** resets the display. At most 4,096 cells can be shown.

## Algorithm

For image indices `(i, j, k)`, the renderer translates source positions by `i a + j b + k c`. The actual cell vectors are used, so tilted and rotated triclinic cells remain geometrically correct. The cell outline and camera bounds expand to contain the resulting supercell.

Replication is a display operation. GPU atom buffers and property arrays are reused, analyses still use source atoms, and selecting a copy reports its original atom ID. Every copy inherits coloring and visibility; each copy is tested separately against Cartesian slicing planes. Exported figures include the displayed copies.

The structure summary and classification counts report source atoms rather than the larger displayed count. Rendering and picking work increase with the copy count even when analysis cost stays constant.

## Implementation

[Replication geometry](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/replication.js), [instanced rendering](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/webgl-renderer.js).
