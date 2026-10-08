# Expressions

Open a structure, then choose **Modification tools → Expressions**. The tool computes new per-atom properties from arithmetic expressions and selects atoms that satisfy a condition. Expressions are parsed by a small dedicated parser and interpreted over typed arrays; they are never run as JavaScript, so a shared configuration cannot execute code.

## Compute a property

Enter a **Property name**, an optional **Unit** and an **Expression**, then click **Compute property** (or press Ctrl/⌘+Enter in the expression box). The result is a per-atom scalar that appears wherever other derived scalars do:

- **Display → Color by**, with every scalar palette, Auto or manual range, the legend histogram and range filter, and PNG legends;
- atom **Details** and **Vectors → Custom XYZ** components;
- the **Statistics** CSV exports: *Scalar statistics* and *Structure summary* list it with the analysis `expression`, and *Atom properties CSV* adds a column with its name and unit.

The list below the form shows each property's name, unit, expression and state. **Color** shows it under Color by, **Edit** loads it into the form, and **Remove** deletes it. Saving with the name of an existing computed property, or after **Edit**, replaces that property explicitly; the button then reads **Update property**.

Names use letters, digits, underscores and dots and start with a letter or underscore, for example `vonMises` or `stress.vm`, so later expressions can use them without quotes. A name may not repeat a column of the current frame, another computed property, a built-in variable such as `Position.X`, `Type` or `CSP`, or a calculated field such as `coordination` or `atomicVolume` (comparison ignores capitalization).

Computed properties are evaluated in list order. A property may use computed properties listed above it; references to itself or to a later property are rejected. A property that another one uses cannot be removed or renamed until that dependent property is edited.

### Recalculation

Values are recalculated for every displayed trajectory frame, after physical replication, after external properties are imported, renamed or removed, and whenever an analysis that an expression reads finishes or is cancelled. Inputs are compared by identity, so revisiting a cached frame or refreshing colors reuses the existing values.

When a frame lacks an input, for example `CSP` before central symmetry finishes on a new frame, the property waits instead of failing: its list entry shows *Waiting* with the reason, and **Color by** keeps the choice as *(waiting for expression inputs…)* until the value is available. If a column of a frame already uses the property's name, the entry reports the conflict and the column is left unchanged.

### Example: von Mises stress

LAMMPS `compute stress/atom` writes six components as `c_s[1]` … `c_s[6]` in bar·Å³. Divided by the Voronoi atomic volume (calculate **Voronoi** first) and converted from bar to GPa:

```text
sqrt(0.5 * ((c_s[1] - c_s[2])^2 + (c_s[2] - c_s[3])^2 + (c_s[3] - c_s[1])^2)
     + 3 * (c_s[4]^2 + c_s[5]^2 + c_s[6]^2)) / atomicVolume / 1e4
```

Name it `vonMises` with unit `GPa`. Other examples: `sqrt(Position.X^2 + Position.Y^2)` (distance from the cell's *z* axis), `ReducedPosition.Z > 0.5 ? 1 : 0`, `Velocity.Magnitude^2 * 0.5 * 58.69 * 1.0364e-4` (kinetic energy in eV for Ni, velocity in Å/ps).

## Select by expression

Enter a **Condition**, choose a **Target group** and an **Operation**, then click **Select matching atoms**. An atom matches when the condition's value is nonzero and not NaN. The matching atom IDs are written to an ordinary [selection group](selection-groups.md), so they keep their color and visibility settings, follow the IDs across frames and are saved in configurations.

| Operation | Result |
| --- | --- |
| **New group** (target) | Creates a group named after the condition, containing the matches. |
| **Replace members** | The group contains exactly the matches. |
| **Add matches** | Matches are added to the existing members. |
| **Subtract matches** | Matches are removed from the group. |
| **Intersect** | Only members that also match remain. |

The status reports how many of the frame's atoms matched and how many group members are in the frame. The condition is evaluated on the current frame only; switching frames does not reselect atoms.

### Invert and expand

Open **Invert or expand the target group** below the button.

- **Invert within this frame** replaces the group with the frame's atoms that are not members. IDs that are absent from the current frame are dropped.
- **Expand group** adds neighbors of the group's atoms in the current frame. **Cutoff distance** adds every atom with any periodic image within the cutoff; **Nearest neighbors** adds the *N* nearest atoms (over periodic images) of each member, as in OVITO's Expand selection. **Iterations** repeats the expansion; each iteration starts from the atoms added by the previous one. Distances use the cell geometry, including triclinic tilt, with periodic images only along periodic axes.

Expansion includes hidden atoms, as analyses do. It runs in a background Worker that keeps the frame's neighbor index for later expansions and holds one CPU budget slot while working; **Cancel** stops it and leaves the group unchanged. If the frame changes before it finishes, the result is discarded.

## Expression language

| Element | Syntax |
| --- | --- |
| Numbers | `3`, `0.5`, `.5`, `2.`, `1.5e-3` |
| Arithmetic | `+ - * / %` and `^` (power, right-associative: `2^3^2` is 512) |
| Comparison | `< <= > >= == !=`; results are 1 (true) or 0 (false) |
| Logic | `&&` (and), the double vertical bar (or), unary `!` (not) |
| Conditional | `condition ? value : otherwise` |
| Grouping | parentheses |
| Functions | `abs sqrt exp log log10 sin cos tan asin acos atan atan2(y, x) min(a, b, …) max(a, b, …) pow(a, b) floor ceil round isnan` |
| Constants | `pi`, `inf` |

Precedence, from loosest to tightest: `?:`, `||`, `&&`, `== !=`, `< <= > >=`, `+ -`, `* / %`, unary `- + !`, `^`. Unary minus binds more loosely than power, so `-2^2` is −4. Comparisons cannot be chained: write `1 < x && x < 2`, not `1 < x < 2`. `log` is the natural logarithm; trigonometric functions use radians; `round` rounds halves away from zero. Whitespace and line breaks are ignored.

Arithmetic follows IEEE 754: division by zero gives ±infinity or NaN rather than an error, and NaN propagates through arithmetic and `min`/`max`. Every comparison involving NaN is false, including `!=`; use `isnan(x)` to find missing values. In conditions and logic, NaN counts as false.

### Variables

Names are case-insensitive. Unquoted names resolve in this order: built-in variables, then frame columns (an exact-capitalization match wins; otherwise a case-insensitive match must be unique), then the analysis aliases.

| Variable | Meaning |
| --- | --- |
| `Position.X`, `Position.Y`, `Position.Z` | Wrapped Cartesian coordinates in Å, independent of the display's unwrapped mode |
| `ReducedPosition.X`, `.Y`, `.Z` | Fractional coordinates along the cell vectors *a*, *b*, *c* |
| `Type` (`ParticleType`) | Atom type number: LAMMPS types keep their numbers (`Type 3` → 3); element types are numbered 1, 2, … in the order of the frame's type list |
| `Type == "Ni"` | Compares type labels, such as an element or `"Type 3"`; only `==` and `!=` with `Type` accept quoted text |
| `ID` (`ParticleIdentifier`) | Atom ID; non-numeric IDs, such as physical replica copies, read as NaN |
| `Index` (`ParticleIndex`) | Zero-based row in the current frame |
| `Velocity.X`, `.Y`, `.Z`, `Velocity.Magnitude` | Imported velocity components (`vx vy vz` and similar), when present |
| `N`, `CellVolume`, `CellLength.A`, `.B`, `.C`, `Timestep`, `Frame` | Atom count, cell volume in Å³, cell vector lengths in Å, the file's timestep (NaN without one) and the zero-based frame number |
| Any numeric column | Imported columns (`c_pe`, `vx`), external properties, analysis outputs and earlier computed properties, by name |
| `CSP`, `Centrosymmetry` | Aliases for `centralSymmetry`, used only when no column has that name |

Analysis outputs keep their internal names, for example `centralSymmetry`, `coordination`, `structureType` (CNA), `ptmStructureType`, `ptmRmsd`, `atomicShearStrain`, `atomicVolume` and `displacementMagnitude`. Classification outputs use their numeric codes: CNA and PTM use 0 Other, 1 FCC, 2 HCP, 3 BCC, 4 ICO. **Variables, operators and functions** in the panel lists the names available in the current frame; click one to insert it.

Write a column whose name is not a plain identifier between backquotes. Names such as `c_s[1]` need no quotes. Backquoted names always refer to columns, so the second term below reads a column named N rather than the atom count:

```text
`v_stress xx` / `N`
```

### Errors and limits

Errors name the problem and its column (and line, for multi-line text), and the panel highlights the offending text: unknown variables and functions list close matches, wrong argument counts state the expected number, and a missing velocity or analysis output says what to calculate. Expressions are limited to 4,096 characters, 64 nested levels of parentheses, function calls, unary operators, conditionals and powers, and 256 operations in any chain. Names never reach JavaScript objects, so `constructor` or `__proto__` are ordinary unknown names.

## Configuration files

Exported configurations record each computed property's name, unit and expression text in `settings.extensions.expressions.properties`, in evaluation order. They contain no computed values. Import validates the names and parses every expression with the same safe parser, rejecting syntax errors, cycles and forward references before anything is applied; values are recalculated after the source and its analyses are restored. Selections created by expressions are stored as ordinary selection groups. Loading a different source clears the computed properties, as it clears analyses and groups.

## Implementation

The tokenizer and recursive-descent parser produce a frozen syntax tree; binding resolves names through Maps for one frame, and evaluation interprets one operation at a time over `Float64Array` buffers, reusing temporaries in place. Constant subexpressions are folded once. Expansion uses the same binned periodic [neighbor search](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/neighbors.js) as the analyses and processes only the newly added atoms in each iteration.

[Expression language](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/expressions.js), [computed property recipes](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/computed-properties.js), [panel controller](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/expression-controls.js), [selection expansion](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/expand-selection.js) and its [Worker](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/workers/selection-worker.js).
