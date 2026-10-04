# Replicate

## Controls

Set total copy counts along lattice vectors **a**, **b**, and **c**. Each count includes the original cell; `2 × 3 × 1` produces six cells. Non-periodic axes remain at one. **Apply** updates the counts and **Original cell** restores `1 × 1 × 1`. At most 4,096 cells can be requested.

**Replicate atoms for analysis** is off by default. Off creates display copies that reuse the original analysis. On enlarges the cell and creates physical atom copies for every analysis. It increases atom count, memory use and calculation work; enabled analyses recalculate for the enlarged structure. Counts and the mode are saved in JSON configurations, with display-only mode as the default for older configurations.

## Algorithm

For image indices `(i, j, k)`, the renderer translates source positions by `i a + j b + k c`. The actual cell vectors are used, so tilted and rotated triclinic cells remain geometrically correct. The cell outline and camera bounds expand to contain the resulting supercell.

In the default display mode, GPU atom buffers and property arrays are reused, analyses still use source atoms, and selecting a copy reports its original atom ID. Every copy inherits coloring and visibility; each copy is tested separately against Cartesian slicing planes. Exported figures include the displayed copies.

The structure summary and classification counts report source atoms in display mode. Rendering and picking work increase with the copy count even when analysis cost stays constant.

## Physical atom replication

When Replicate atoms is enabled, the new cell vectors are `nₐ a`, `nᵦ b` and `n𝚌 c`. A copy translated by `i a + j b + k c` has fractional coordinates `((sₐ + i) / nₐ, (sᵦ + j) / nᵦ, (s𝚌 + k) / n𝚌)` in that enlarged cell. This preserves Cartesian positions and triclinic geometry rather than repeating along fixed Cartesian axes.

Each copy has its own atom ID and copied source properties. The summary, crystal counts, coordination, RDF, strain and other analyses use the physical atom count and enlarged cell. Selection groups can therefore select and color physical copies independently. Turning the option off restores analysis of the source atoms, with the requested copies shown by the renderer. The original local files remain unchanged.

## Implementation

[Display replication geometry](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/replication.js), [physical atom replication](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/data/replicate.js), [instanced rendering](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/webgl-renderer.js).
