# Configuration

## Controls

Configuration import/export is always available directly below the structure summary. **Export JSON** saves the current source metadata and settings. **Import JSON** reads a saved configuration; it does not occupy the Tools selector.

## Restore logic

The JSON stores file names, byte sizes, available relative paths, the frame index, and display/analysis parameters. It includes camera position/direction, roll, projection and field of view, periodic display origin, cell outline colors, theme, coloring, filters, appearance overrides, slices, replication, all named vector fields, measurements, the second view, the active tool category and enabled analyses. It excludes original atom data and computed result arrays.

If the matching source is already open, restoration selects the saved frame, restores parameters and recalculates enabled analyses. Otherwise the configuration remains pending and lists the required source files. Reopening files with the matching names and sizes triggers restoration; relative paths distinguish identical names in different folders when available.

Import validates allowed fields, finite numeric ranges, source metadata and individual feature parameters before applying them. Invalid input preserves the current settings. A user edit or frame selection interrupts an in-progress restore so newer actions take priority. Older version 1 settings receive defaults for optional extensions.

External property files are recorded separately with their file metadata, ID or row-order mapping, import frame, and column names. Their numeric values are not embedded in the JSON. Files still loaded in the current session are reused. In a fresh session, reopen the source and select the requested property files under **Modification tools → External properties**. The panel shows which files are pending; colors and vector fields become available when their columns have been restored. Row-order imports use the original import frame to preserve the mapping when later frames reorder stable atom IDs.

Computed properties are recorded in `settings.extensions.expressions.properties` as a list of `{ name, unit, expression }` in evaluation order. The values are not stored. Import checks the names and parses each expression with the safe expression parser, rejecting syntax errors, self-references and references to later properties before any setting is applied; nothing in the file is executed as code. The values are recalculated once the source frame and enabled analyses are restored. See [Expressions](expressions.md).

Bond-length/angle distributions and Q4/Q6 are recorded in `settings.extensions.bondStatistics` with their enabled state and length/angle bin counts. The analysis shares `settings.extensions.bonds.cutoff` and its element-pair overrides; cylinder visibility and graph calculation remain independent of statistical analysis. An enabled bond-statistics recipe requires a valid saved bond cutoff even when cylinders are hidden. Voronoi parameters are recorded in `settings.extensions.voronoi`: enabled state, distribution bins, absolute face-area threshold and relative surface-fraction threshold. Older version 1 recipes without these optional extensions leave both analyses off.

Cluster analysis is recorded in `settings.extensions.clusters`: enabled state, `neighborMode` (`cutoff` or `bonds`), `cutoff`, `selectionGroupId` and `sortBySize`. An enabled recipe needs a saved cutoff in cutoff mode, or a saved Bonds cutoff in bond mode, and its selection group must be among the saved selection groups. Older recipes without the extension leave cluster analysis off.

Spatial binning is recorded in `settings.extensions.binning`: enabled state, `mode` (`1d` or `2d`), two `axes` (`a`, `b` or `c`; they must differ for a map), two `bins` counts (1–4,096 each, at most 1,048,576 in a map), `quantity` (`count`, `density` or `property`), `property` (a `property:` key or built-in position/speed key, required for `property`), `reduction` (`mean`, `sum`, `min`, `max` or `stddev`), `selectionGroupId` (a saved selection group), `averageFrames` and `colorScheme`. The property is resolved again by name in each frame, and no binned values are stored. Older recipes without the extension leave binning off.

Restoration recalculates enabled bond statistics through the saved CPU/GPU preference and Voronoi through CPU/Wasm, after restoring the physical structure and replication mode. Calculated arrays, histograms and exported CSV files are excluded from JSON. Once the analyses finish, the Statistics, Bonds, Voronoi and DXA CSV controls export the restored frame's results using the standard table schemas.

The browser cannot reopen local disk files by path without a new selection. A saved JSON is therefore a reproducible settings recipe that still needs the original files, rather than a self-contained trajectory archive.

## Implementation

[Configuration schema and source matching](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/configuration.js), [restore sequencing](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/app.js), [extension settings](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/atomeye-tools.js), [bond/Voronoi lifecycles](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/topology-tools.js).
