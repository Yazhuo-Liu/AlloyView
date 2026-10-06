# External properties

## Import attributes

Open a structure, then choose **Modification tools → External properties** and **Import properties**. Select one or more local `.aux`, `.csv`, `.txt`, or `.tsv` files. Each file must provide exactly one numeric row per source atom. Imported properties become available for scalar coloring, atom details and [vector arrows](vectors.md).

The file list shows each filename, its property names, the mapping method and the frames to which its values apply. **Rename** changes an imported property's name. **Remove** removes one property; **Remove file** removes every property from that file. Source files remain unchanged.

## File formats

Plain `.aux` files contain whitespace-separated numeric columns. Without a header, their properties are named `aux_1`, `aux_2`, and so on. A whitespace header can name the columns, including a commented header:

```text
# columns: force_x force_y force_z
1.0 0.0 -0.5
0.0 2.0 0.0
-1.0 0.0 0.5
```

CSV files can contain a header, quoted column names, and units in square brackets. An `id`, `atom_id`, or `atomid` column identifies the corresponding structure atom:

```csv
id,force_x,force_y,force_z,energy [eV]
3,-1.0,0.0,0.5,-3.2
1,1.0,0.0,-0.5,-3.1
2,0.0,2.0,0.0,-3.3
```

Rows may be shuffled when an ID column is used. IDs must be unique non-negative safe integers and cover exactly the structure's atom IDs. Duplicate, missing and unknown IDs are rejected. `NaN` and empty CSV attribute cells represent missing values; infinite values and nonnumeric attributes are rejected. Quoted CSV fields must fit on one line.

## Atom mapping and trajectories

**Automatic** uses the ID column when present, otherwise the file's row order. **Atom ID** requires an ID header. **Row order** attaches the first row to the first source atom, and so on, anchoring that correspondence to the source IDs at the import frame.

When the structure has explicit stable IDs, values follow those IDs across trajectory frames, including when rows are reordered. Every mapped frame must contain the same atom IDs. Structures with generated row numbers have no reliable cross-frame correspondence, so their imported attributes apply only to the import frame. The file list states this restriction.

Display copies inherit their source atoms' attributes. Physical replication repeats each source attribute for its corresponding atom copies. Updating imported attributes leaves existing analysis results intact.

## Property names and coordinates

Names must be unique and must not overwrite existing input properties or reserved calculated fields such as `coordination` and `displacementX`. Force, velocity and custom vector component names, including `forceX`, `velocityX` and `vectorX`, can be imported when those names are not already present.

Coordinate columns such as `x`, `y` and `z` are imported as ordinary attributes. They do not move atoms or change the cell. To draw vectors, provide a complete three-component family or choose three imported properties in **Vectors → Custom XYZ**.

## Configuration files

Exported configurations record filenames, sizes, mapping methods, import frame numbers, renamed properties and removed columns. They contain no external attribute values. In a new session, reselect the matching external files in this tool to restore their values. Until then, the interface explicitly reports that the attributes have not been restored.

Files are matched by filename and size. Row-order imports restore against their original import frame so that a different trajectory row order cannot change the atom correspondence. Files already loaded in the current session are reused when their saved mappings match.

## Implementation

Parsing, ID mapping and physical-copy attribute expansion run in a persistent Worker. Parsed columns are reused across frames. Attribute buffer allocations are checked before creation, with a 512 MiB limit per mapped attribute set.

[Attribute parser and manifests](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/io/external-properties.js), [attribute controls](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/external-property-controls.js), [attribute Worker](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/workers/external-property-worker.js).
