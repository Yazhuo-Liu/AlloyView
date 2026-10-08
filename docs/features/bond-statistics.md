# Bond distributions and Q4/Q6

## Controls

Open **Visualization tools → Bonds → Bond distributions and Q4/Q6**. Set the default bond cutoff and any element-pair overrides in the main Bonds settings, choose **Length bins** and **Angle bins**, then press **Calculate distributions and Q4/Q6**. A pair cutoff of zero excludes that element pair. One calculation produces both distributions, local Q4/Q6 values and summary statistics; drawing bond cylinders is optional.

Lengths span zero to the largest configured default or element-pair cutoff. Angles span 0–180°. Each distribution supports 1–4,096 equal-width bins. The panel shows progress and the backend used. **Cancel** stops this statistics calculation and clears its results while keeping the input settings.

Statistics use the complete analyzed frame, including hidden and sliced-out atoms. Display origin changes and display-only replication preserve the statistical input. **Replicate atoms for analysis** changes the actual analyzed structure, so its added atoms participate in these results.

## Bond lengths

Lengths are Cartesian distances along the same cutoff-defined periodic edges as Bonds. Each undirected edge is counted once. Different periodic images of an atom are distinct neighbors; a self-image edge contributes once for each pair of opposite translations. Open cell directions use direct distances, while periodic directions follow their cell vectors, including triclinic tilts.

The length histogram therefore describes the selected geometric neighbor graph. Cutoff choices define that graph and should reflect the intended neighbor shells.

## Bond angles

For each central atom, the calculation forms every unordered pair of its qualifying neighbor vectors. The angle is `acos((u · v) / (|u| |v|))`, in degrees. An atom with `N` neighbors contributes `N(N − 1)/2` angles. Different periodic images remain separate neighbors even when they have the same source atom ID.

Every angle belongs to its central atom's environment. A triangle can contribute angles at multiple centers. Changing the cutoff or element-pair exclusions can change both the angle population and its distribution.

## Local Steinhardt Q4/Q6

For neighbor directions `r̂ⱼ`, the local coefficients are the mean spherical harmonics `qₗₘ = (1/N) Σⱼ Yₗₘ(r̂ⱼ)`. The rotationally invariant quantity is

`Qₗ = sqrt((4π / (2l + 1)) Σₘ |qₗₘ|²)`, for `l = 4, 6`.

The implementation evaluates the equivalent spherical-harmonic addition theorem using Legendre polynomials. Each qualifying neighbor direction has equal weight. These dimensionless values describe local bond-orientational order; they are different from an electronic or chemical bond order. Interpretation depends on the neighbor shell and cutoff, and a single value does not by itself identify a crystal phase.

Q4/Q6 become atom properties for **Color by**, atom details and CSV export. Atoms without any qualifying neighbors have NaN Q4/Q6 values. Summaries exclude NaN values and report the finite count, minimum, maximum, mean and population standard deviation.

## Normalization and CSV exports

The length and angle plots use the same inspection as the Voronoi histograms: switch between **Count** and **Probability**, hover or tap a bin, drag **Inspect bin**, or focus the plot and press left/right, Home, or End. **View binned values** opens the numerical table. Every histogram reports bin edges and centers, raw counts, probability and density. A nonempty distribution has `probability = count / total`; density is probability divided by bin width. Probabilities sum to one and density integrates to one in Å for lengths or degrees for angles. Empty populations have zero histogram counts and probabilities. Bins are half-open, with the upper endpoint included in the final bin.

**Length CSV** and **Angle CSV** export the complete binned distributions. **Q4/Q6 stats CSV** exports their scalar summaries; **Atom Q4/Q6 CSV** exports per-atom values and neighbor counts with atom identifiers. **Statistics → Export statistics as CSV** also provides summaries and all available atom properties. Exports preserve the analysis population rather than applying display visibility filters.

## CPU and GPU calculation

The global **Enable GPU acceleration** preference chooses WebGPU when supported. GPU work calculates neighbor environments, angular pairs and local Q values in parallel, with sparse precision correction for decisions near cutoffs or bin boundaries. Unsupported environments or device limits use the resident CPU Worker pool. With GPU acceleration off, independent atom ranges run in CPU Workers; histograms and stable moment accumulators are merged into one result.

Both backends use the same edge ownership, angle counting, cutoffs and normalization. Their elapsed time includes preparation and result transfer. Small floating-point differences in Q values and summaries can remain. Cancellation ends the active job rather than starting a fallback calculation.

GPU results are read back for up to 16,384 central atoms at a time; dispatches start at 2,048 atoms and grow only while they finish quickly, because angular work is quadratic in the neighbor count. Near-perfect crystals with integer-degree angle bins place many pairs on bin edges; their exact CPU corrections run while the GPU computes the next range, and a range whose correction queue overflows is split by the number of records it requested. Histograms, coordination and per-atom Q values do not depend on these boundaries. The order in which per-range length, angle and Q moments are merged can change only the last bits of their mean and standard deviation, as the GPU's correction-record order already does.

Angular enumeration grows quadratically with the number of neighbors. The calculation supports at most 1,024 qualifying neighbors per atom and reports an error if the limit is exceeded. It retains complete populations instead of sampling angles; reduce cutoffs for unusually dense environments.

## Implementation

[CPU definitions and reductions](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/bond-statistics.js), [GPU calculation and precision corrections](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/gpu/bond-statistics.js), [periodic neighbor search](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/neighbors.js), [Worker scheduling](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/analysis-pool.js).
