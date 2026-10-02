# Validation record

Validation date: 2026-10-02 (America/New_York)

## Environment

- Linux 6.8.0-134-generic x86_64
- Intel Xeon E5-2470 v2 @ 2.40 GHz, 10 cores / 20 hardware threads
- 31 GiB RAM
- NVIDIA GeForce GTX 980 Ti, driver 575.57.08 (verified outside the restricted
  command sandbox with `nvidia-smi`)
- Node.js v24.20.0
- Firefox 157.0 and geckodriver 0.37.1; no Chromium/Chrome executable or
  Emscripten compiler was available to the automated test session

The host GPU works, but the automated command sandbox did not expose an NVIDIA
device or a usable browser graphics context. Firefox was launched through
geckodriver in headless mode and loaded the application, but WebGL 2 creation
failed with `FEATURE_FAILURE_WEBGL_EXHAUSTED_DRIVERS`; the forwarded display was
not available to a non-headless process. Consequently, no GPU upload throughput,
rotation FPS, PNG pixel comparison, or browser heap figure is reported here. The
application includes live measurements for parse time,
synchronous GPU-buffer upload completion (`gl.finish()`), interaction FPS,
analysis time, and `performance.memory` when the browser exposes it. Those values
must be collected on an actual target workstation before making a rendering
performance claim.

## Executed correctness tests

Command:

```bash
npm test
```

Result: all 14 test files passed (parser, coordination and range partitioning,
Worker-count policy, cutoff recommendation, palette ranges, atomic radii,
file-sequence discovery, multi-file LAMMPS indexing, trajectory unwrapping,
adaptive frame-cache policy, renderer state, and suppression of blocking UI
progress for background frame prefetch, plus playback interval/wrapping),
with no failures. The cases executed were:

- extended CFG: 31 atoms, IDs, FCC cell, fractional/Cartesian coordinates,
  mass and `site_energy` property;
- basic CFG: `A` and `Transform` coordinate conversion, plus symmetric
  Lagrangian `eta` deformation;
- malformed/incomplete CFG rejection;
- a self-contained LAMMPS-generated CFG fixture verifies promotion of `id` and
  `ix/iy/iz`, unwrapped cell-vector translation, and removal of those semantic
  fields from generic scalar properties;
- out-of-cell CFG coordinates are wrapped while their original unwrapped view
  and inferred image flags are retained; `1e-6` boundary noise is canonicalized
  without inventing crossing history;
- restricted-triclinic LAMMPS bound correction and scaled coordinates;
- triclinic `ix/iy/iz` image translation, explicit `xu/yu/zu`, wrapping only
  along periodic axes, and partial-image-flag rejection;
- two-frame byte-offset indexing and frame-2 on-demand parsing;
- two numbered `.lmp` dump files containing two frames each: numeric file order,
  four-frame combined indexing, cross-file random frame access, and range-error
  reporting;
- explicit general-triclinic and non-numeric-property rejection;
- perfect 2×2×2 FCC coordination = 12 at 3.0 Å;
- perfect 2×2×2 BCC coordination = 8 at 3.0 Å;
- a pair across a periodic boundary is found, and is not found when that axis is
  changed to non-periodic;
- a skew restricted-triclinic periodic pair;
- a 3×3×3 FCC cell with one vacancy: exactly the 12 nearest sites change from
  coordination 12 to 11;
- LRU eviction, access-order refresh, and safe run-time cache-limit shrinking
  and growth;
- memory-policy selection of complete lazy caching for a small trajectory and a
  bounded adaptive window for a synthetic million-atom/500-frame case (policy
  test only; it does not allocate all 500 frames);
- cell-box visibility and wrapped/unwrapped display-buffer changes request
  redraws without replacing the analysis frame; transparent PNG export selects
  a transparent render, restores the opaque viewport afterward, and flips WebGL
  pixel rows into the PNG's top-to-bottom order. The canvas legend test verifies
  that a scalar PNG overlay receives the selected color-map stops and the active
  visible range.
- six standard camera presets choose the expected constrained orientation and
  orthographic projection; the coordinate tripod maps global Cartesian axes to
  screen directions;
- element-aware cutoff recommendation, periodic-table display radii with a
  generic fallback, numeric-type fallback, AtomEye-style beige/rainbow defaults,
  all selectable scalar color maps and their endpoints, custom scalar ranges
  including outlier clamping, and strict live bound coupling in both adjustment
  directions;
- per-atom visibility-mask upload for threshold filtering;
- coordination results from two independent atom-index ranges merge exactly to
  the single-range FCC result; the Worker-count policy selects one Worker for a
  small frame, two for 100k atoms on eight advertised cores, up to six for one
  million atoms, and reduces to one under an artificial clone-memory limit;
- synthetic ID-reordered periodic crossing plus all 40 files in
  `examples/fixed_end_climb`: 257 stable atoms per image, 32 non-zero inferred
  image-flag components in `replica.39.cfg`, maximum absolute flag 1, and maximum
  adjacent fractional step 0.001932 (well below the 0.5 ambiguity threshold).
- numbered CFG discovery with the varying digit run at an arbitrary filename
  position (including `replica.cfg.0`), content-based header recognition, fixed
  numeric fields, `.cfg`/`.dump` segment fallback hints, separate subdirectories,
  missing-index reporting, standalone LAMMPS files, and manual non-numbered CFG
  selection. Explicitly rejected log/text files remain excluded even when their
  filename extension might otherwise be used as a weak format hint.
- `_number.cfg` and `_number.lmp` sequence patterns plus `.lmp`, `.lammpstrj`,
  and `.lammpstraj` LAMMPS dump filename recognition.

The FCC/BCC coordination expectations are analytic reference results for a
cutoff between the first and second shells. A binary comparison against a built
upstream AtomEye executable was **not** executed, because its native dependency
stack was not built in this environment and its redistribution license remains
unclear. The independent results do exercise the same reduced-coordinate,
face-height-bin, PBC image invariants found in its source.

The optional C++ core was compiled as a native object with:

```bash
g++ -std=c++17 -O2 -Wall -Wextra -Wpedantic -c wasm/coordination.cpp
```

This checks the portable C++ source, not an Emscripten/Wasm artifact. The default
Worker JavaScript path is the runtime that was executed by the automated tests.

`npm run build` also completed successfully. The generated static site was
served locally and returned HTTP 200 for the document, the new coordination
module Worker, and `examples/fixed_end_climb/replica.39.cfg`. The observed MIME
types were `text/html`, `text/javascript`, and `text/plain`, and the server
emitted the documented COOP/COEP/CORP headers.

## 97,556-atom CPU benchmark

Command: `npm run benchmark`. Dataset: generated 29×29×29 conventional FCC
cells (97,556 atoms), 4.05 Å lattice constant, 3.0 Å cutoff, orthogonal PBC,
6.523 MiB LAMMPS text, single numeric scalar property.

| Stage | Measured result |
| --- | ---: |
| Generate benchmark text (not a product stage) | 185.14 ms |
| Parse LAMMPS frame | 323.94 ms |
| Coordination analysis | 297.24 ms |
| Candidate pairs tested | 1,905,076 |
| Result | all 97,556 atoms have coordination 12 |
| Process RSS after run | 169.97 MiB |
| Node heap used after run | 58.65 MiB |

These are one-run Node timings from the direct single-range kernel, not a browser
Worker-pool speedup measurement or browser performance guarantee. File index
time, GPU upload, and frame rate are separate stages and were not conflated with
the CPU numbers. The 1,000,000-atom path was not executed; it is explicitly
unverified.

## Behavioral checks still requiring a browser

- WebGL shader appearance, depth edges, cell line occlusion, and PNG output;
- pointer picking under perspective/orthographic cameras;
- manual feel/visual inspection of constrained Z-up orbiting, all six standard
  views, and the live coordinate tripod on the target desktop GPU;
- slice/selection/color state over manual rapid trajectory changes;
- measured GPU upload completion and sustained rotation FPS;
- confirmation from DevTools/network policy that no local file bytes leave the
  page (the code has no upload path, but this was not network-captured here);
- optional Emscripten build and result parity with the JavaScript kernel.
- visual/manual confirmation of the bottom discrete timeline, preset-adjacent
  segmented projection controls, background palette, continuously shaded 3D
  axis tripod, playback button, live legend controls, and final PNG legend
  appearance;
- end-to-end browser timing of the multi-Worker coordination pool with and
  without cross-origin-isolated shared coordinates. Unit tests cover its range
  merge and resource-selection policy, not browser scheduling speedup.
