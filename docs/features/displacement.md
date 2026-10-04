# Displacement

## Enable and inspect the calculation

Open **Displacement** to enable its analysis for the loaded source. Choose a **Reference frame** and whether to use **Minimum image** correction. While enabled, the calculation updates when the trajectory frame, reference or correction changes. Opening a file or the Vector panel does not enable this calculation.

The result provides **Displacement X**, **Displacement Y**, **Displacement Z** and **Displacement magnitude** as per-atom scalar properties in Å. Select any of them in **Color by** to color atoms and use its scalar legend. Comparing a frame with itself gives four zero-valued fields. Calculating and coloring these properties is independent of drawing arrows: use [Vector arrows](vectors.md) when you also want the overlay.

**Cancel** disables the analysis and removes its properties from current and cached frames. Pending work cannot publish a late result, and subsequent frame changes do not restart it. If a removed field was selected for coloring, coloring returns to atom type. Cancelling unchecks **Show arrows** and clears both views when arrows use Displacement or any of its components through Custom XYZ. Unrelated imported arrows stay enabled. The Displacement source also disappears from Vector. **Calculate displacement** enables and starts the analysis again; arrow visibility stays off until you enable it.

## Match atoms between frames

When both frames contain explicit stable IDs, current atoms are matched to reference atoms by those IDs. Missing reference matches receive `NaN` components and magnitude, and are omitted from scalar ranges and arrows.

When both frames lack explicit IDs and have equal atom counts, correspondence falls back to row order and the panel displays a warning: the two frames must retain exactly the same atom order. Reordered atoms cannot be detected in this mode. Mixed explicit/generated IDs or unequal row-based populations are rejected. Comparing a frame with itself is valid and gives zero displacement.

## Cartesian displacement and periodic images

The displacement is the Cartesian difference `u = r(current) − r(reference)`, and its magnitude is `sqrt(ux² + uy² + uz²)`, evaluated with a stable hypotenuse operation. This is laboratory-frame motion, including changes from cell deformation or origin shifts; no affine cell mapping is applied.

With **Minimum image** enabled, periodic lattice translations in the current cell are searched to find the shortest Cartesian displacement. Fractional rounding supplies an initial candidate, then a search bounded by the cell face heights checks shorter images. The full triclinic metric is used rather than independently rounding Cartesian components. Non-periodic directions remain unwrapped. This resolves boundary crossings but cannot recover accumulated motion beyond the nearest periodic image from wrapped frames.

With correction disabled, the calculation uses available unwrapped positions and otherwise the coordinates supplied by the frame. Input that contains only wrapped coordinates cannot reconstruct missing image counts.

Analysis precedes display filtering, slicing and display-only replication. With **Replicate atoms for analysis** enabled, displacement uses the enlarged configurations and their stable copy IDs instead. Arrow length, axis scales and glyph sizes do not change the physical components or magnitude.

## GPU acceleration

With **Enable GPU acceleration** on, Cartesian subtraction, minimum-image selection and vector magnitudes prefer WebGPU. Stable-ID or row-order matching remains CPU work. The GPU kernel uses the selected Cartesian positions directly, including origin shifts, cell deformation and available unwrapped coordinates. It preserves the current cell's full triclinic metric and mixed periodic boundaries; open atoms outside the fractional unit box are supported because this calculation does not require a neighbor grid.

Cartesian inputs retain their Float32 or Float64 source precision through an anchored high/low upload. Wrapped and unwrapped uploads are cached separately for the current and reference frames and can be reused across compatible calculations. Output components are Float32, as used by vector drawing. Magnitudes are evaluated from those final rounded components with scaled, compensated arithmetic and returned as Float64, so a finite vector norm larger than the Float32 range can remain finite.

Ambiguous half-cell or tied-image choices receive exact CPU corrections. The GPU image search is bounded to 512 candidates per atom, and numerically ambiguous or over-budget image searches can correct up to 16,384 atoms before the whole calculation falls back to CPU Workers. Unsupported device, memory or precision limits also use CPU fallback. Unmatched atoms keep NaN components and magnitude, and cancellation stops either backend without retrying a cancelled GPU job on CPU. Coloring, arrow visibility, cached-frame invalidation and saved settings behave the same with either backend. See [performance](performance.md) for preparation, result readback and timing costs.

## Implementation and saved settings

Calculated fields are tagged with the displacement analysis and cached by source frame and calculation parameters. A source change, cancellation or newer request invalidates pending publication. Configuration JSON stores the independent analysis under `extensions.displacement`, including its enabled state, zero-based reference frame and minimum-image option. Older configurations that used Displacement as a Vector source migrate to the independent analysis, including when their arrows were hidden.

[Displacement calculation](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/displacement.js), [GPU displacement](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/gpu/displacement.js), [GPU displacement shader](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/gpu/displacement-shaders.js), [scalar property registration](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/vector-properties.js), [analysis lifecycle and controls](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/atomeye-tools.js).

OVITO's [Displacement vectors documentation](https://www.ovito.org/manual/reference/pipelines/modifiers/displacement_vectors.html) explains the reference-frame and atom-correspondence concepts. The calculation and limitations described above are AlloyView's implementation.
