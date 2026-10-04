# Configuration

## Controls

Configuration import/export is always available directly below the structure summary. **Export JSON** saves the current source metadata and settings. **Import JSON** reads a saved configuration; it does not occupy the Tools selector.

## Restore logic

The JSON stores file names, byte sizes, available relative paths, the frame index, and display/analysis parameters. It includes camera, theme, coloring, filters, appearance overrides, slices, replication, vector options, measurements, the second view and enabled analyses. It excludes original atom data and computed result arrays.

If the matching source is already open, restoration selects the saved frame, restores parameters and recalculates enabled analyses. Otherwise the configuration remains pending and lists the required source files. Reopening files with the matching names and sizes triggers restoration; relative paths distinguish identical names in different folders when available.

Import validates allowed fields, finite numeric ranges, source metadata and individual feature parameters before applying them. Invalid input preserves the current settings. A user edit or frame selection interrupts an in-progress restore so newer actions take priority. Older version 1 settings receive defaults for optional extensions.

The browser cannot reopen local disk files by path without a new selection. A saved JSON is therefore a reproducible settings recipe that still needs the original files, rather than a self-contained trajectory archive.

## Implementation

[Configuration schema and source matching](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/configuration.js), [restore sequencing](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/app.js), [extension settings](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/atomeye-tools.js).
