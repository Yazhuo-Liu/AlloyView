# Statistics and radial distribution

## Coordination distribution

The coordination distribution bins completed coordination counts into a population histogram and reports their mean. When bonds are calculated it uses bond-cutoff coordination, including qualifying periodic images; otherwise it uses the original Coordination result. It reports original source atoms, including atoms hidden or sliced in the display. Run coordination or bonds first to obtain these values.

**Export statistics as CSV → Coordination distribution** exports the full distribution. The same export section provides a structure summary, scalar-property statistics, category populations and a table of atom IDs, types, coordinates and available properties. Scalar summaries report missing and finite values separately. These exports include the complete analyzed frame. RDF, [bond length/angle and Q4/Q6 statistics](bond-statistics.md), [Voronoi cells](voronoi.md) and dislocation results also have export buttons beside their results.

## Radial distribution g(r)

Choose the maximum distance, the number of bins and optional center/neighbor element selections. The calculation requires periodic boundaries along all three cell axes. The maximum distance must be at most half the shortest cell face height; 1–4,096 bins are supported.

For a radial bin with edges `r₀` and `r₁`, the shell volume is `4π(r₁³ − r₀³)/3`. The algorithm counts directed selected neighbor pairs, excludes self pairs, and reports the bin-center radius. Its normalization is

`g(r) = count × cell volume / (selected pair population × shell volume)`.

For all atoms the selected pair population is `N(N − 1)`. For partial selections it is `N(center) × N(target) − overlap`, removing atoms included in both populations from self-pair counts. This finite-population correction avoids a systematic small-system bias. The half-face-height limit prevents repeated atom images within the search radius.

Non-periodic cells require a surface correction that is not implemented, so the normalized RDF rejects those cells. Changing display visibility, slicing or replication does not alter the statistical input.

The plot spans `0` to the maximum distance, with a dashed line at `g(r) = 1`, the uncorrelated reference. Inspection starts at the highest peak. Hover or tap the plot, drag the **Inspect radius** slider, or focus the plot and press left/right, Home, or End to move the crosshair. The readout gives the bin-center radius, the bin edges, `g(r)` and the raw directed pair count. After a recalculation, the bin containing the previously inspected radius stays selected.

## Export CSV

The export section in Statistics provides a summary of the current frame, scalar property statistics, all categorical populations, all available coordination distributions, and a table of atom properties. The summary includes atom-type and crystal-structure populations, the mean and population standard deviation of scalar quantities, missing-value counts, selection-group membership, RDF normalization, completed bond statistics, Voronoi distributions, and DXA family lengths and line density. It also records the current color range separately from physical statistics.

Each table records the source filename, one-based frame number and simulation timestep when available. Units appear in the headings or a dedicated unit column. Numeric values preserve their full stored precision; nonfinite values are written as `NaN`, `Infinity` or `-Infinity`. Scalar means, extrema and population standard deviations use finite values only, and their counts are exported alongside the counts of missing and infinite values. Population fractions use the entire analyzed atom count, including unclassified atoms.

The RDF export includes bin edges, bin-center radius, `g(r)` and raw directed pair counts. Bond length and angle CSVs include all bins, their raw counts, probability and probability density. Q4/Q6 can be exported as summary statistics or individual atom values. The Voronoi tool exports per-atom volume, surface area, neighbor count and full Voronoi indices; its distribution table combines coordination, volume, neighbor-face area and index populations. An optional face table includes every stored face and its accepted/boundary flags. DXA has separate family-summary and dislocation-line tables, including crystal and spatial Burgers-vector components. [Spatial binning](binning.md) exports one row per bin with its bounds in reduced coordinates and Å, the binned value, atom count and skipped non-finite values.

Exports describe the complete analysis frame. Hidden atoms, slices, periodic display-origin shifts and display copies do not change the statistics. Enabling **Replicate atoms** creates a larger physical analysis frame; those additional atoms are included. Atom coordinates in CSV are source Cartesian coordinates rather than coordinates shifted for display. Selection groups report stored IDs, IDs matched in this frame and absent IDs.

CSV formatting and scans run in a reusable Worker using completed result arrays. Exporting does not run another neighbor search or repeat an analysis. Successive exports reuse the Worker snapshot; changing the frame or result releases that snapshot without replacing the Worker. Large atom and face tables are written in chunks. If the frame changes while a CSV is being prepared, its obsolete download is discarded. Files use UTF-8, quoted CSV fields and CRLF record endings.

## Implementation

[RDF counts and normalization](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/rdf.js), [statistics integration](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/atomeye-tools.js), [CSV table definitions](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/statistics-export.js), [persistent CSV Worker](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/workers/statistics-export-worker.js).
