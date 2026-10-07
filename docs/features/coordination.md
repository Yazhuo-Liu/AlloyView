# Coordination number

## Controls

Set a positive cutoff radius in Å. Editing the cutoff schedules a new calculation after a short typing pause; committing the field applies it immediately. The count becomes available for coloring, atom inspection and the coordination distribution. The distribution plot in Statistics supports **Count**/**Probability**, hover or tap inspection, an **Inspect bin** slider and left/right, Home and End keys; **View binned values** lists every coordination number. Cancel clears the result and disables automatic calculation on later frames.

The numeric field remains editable at the top. **Cutoff preset** lists
**Custom** first, followed by 35 common metals with their suggested radii.
Opening a file with a recognized element selects that element automatically.
For an alloy, the largest constituent preset supplies the initial global
cutoff and the help text lists the constituents. Only types present in that
frame are considered. Numeric types such as `Type 1`, unknown labels and
filenames are not interpreted as chemical elements.

Choosing an element applies its radius and starts the existing calculation
queue. Editing the radius switches the selector to **Custom**; selecting
**Custom** preserves the current value. Choices and custom values survive
frame changes and replication. Configuration JSON stores both the radius and
the preset. Legacy recipes and recipes with a superseded preset value restore
their exact numeric radius as Custom.

These are first-shell starting estimates: the existing 21 recommendations
retain their metallic-radius values, and 14 additional elements use the
reference lattice data already included for ideal strain. They include 15%
padding and are rounded to 0.05 Å. New BCC presets stay below the second shell;
HCP estimates cover both basal and interlayer neighbors. Check the actual
structure's first minimum of g(r), particularly for strained structures or
alloys; an element preset does not determine that minimum from the input.

## Algorithm

Atoms are indexed in fractional linked cells. Cell-face heights bound candidate bins, and the cutoff is checked using Cartesian distances in the full cell metric. Periodic axes search the necessary lattice translations; non-periodic axes do not wrap.

Accepted pairs increment both atoms' counts. This calculation counts the closest image of each unique neighboring atom ID, once per neighbor. For periodic cells shorter than twice the cutoff it does not count multiple images of the same ID; the viewer reports that convention explicitly. It differs from bond and local-geometry neighbor searches, where distinct images can be retained.

Coordination depends on the chosen cutoff and the physical length units of the input. Display replication, slicing and visibility filters do not alter the original calculation.

## Implementation

[Coordination and minimum-image distances](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/coordination.js), [cutoff presets](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/cutoff.js), [Worker scheduling](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/analysis-pool.js).
