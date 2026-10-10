# Validation record

Latest validation: 2026-10-10 (America/New_York, EDT). Earlier entries retain their own dates.

## Defect fixes B1–B6 and B10, and Voronoi routing G1 (2026-10-10)

Reference: `dbe6055`. Seven defects from the audit of 2026-10-10 are fixed and
removed from the [backlog](TODO.md). The audit's reproduction scripts are in
`../AlloyView-audit-2026-10-10/bugs/` on the reference machine; the longer
reports of this work are in `../AlloyView-audit-2026-10-10/fixes/`.

- **B1, physical copies of a wrapped trajectory.** Copies built from a source
  without image flags or unwrapped coordinates repeat every wrap of their
  source atom, which is a jump of one source cell vector, not of the enlarged
  cell. Displacement and frame strain now resolve periodic images against the
  source lattice for such frames, on CPU Workers and in both WebGPU kernels
  (`physicalReplication.wrappedSource`, `wrappedSourceRepetitions`,
  `imageLatticeCell`). On the audit's wrapped dump with 2 × 1 × 1 copies,
  displacement is 0.1 Å for every atom (before: up to 14.3 Å) and shear strain
  is 0 with no non-finite value (before: up to 23.09, 64 non-finite). On the
  60,229-atom Fe loop with wrapped copies, the largest displacement is 0.59 Å
  instead of 90 Å, and frame strain has no NaN instead of 1,518.
- **B1, unchanged results.** Frames that are not replicated, copies built from
  image flags or unwrapped columns, and 1 × 1 × 1 are element-wise identical
  (`Object.is`) on CPU: 13 cases, 21.4 million values. On the software GPU
  adapter, 72 of 75 analyses have identical SHA-256 hashes; the other three
  (frame strain on 6,912 and 60,229 atoms) already differ between two runs of
  the previous build, by at most 1.5×10⁻⁸ in 7–11 of 1,144,351 values
  (backlog B34).
- **B2, rejected configuration.** A configuration that is rejected or
  interrupted after its smoothing setting was applied now leaves the setting
  that produced the displayed frame. Selecting the displayed frame again while
  a smoothing change is pending prepares it with the new setting. The audit
  script shows the panel, the exported recipe and the displayed position hash
  in agreement (`324:ffb539a0`, smoothing on).
- **B3, loading indicator.** The indicator has an owner: a frame request that
  is superseded hides the indicator it showed, structure Worker progress only
  updates the text of a wait that some caller announced, and a configuration
  import shows and hides its own wait for the saved frame. Reference frames
  read by tools no longer show it. The audit scripts pass for superseded
  navigation on a 53 MB trajectory and for six smoothing triggers (import,
  Wigner–Seitz, displacement, reference strain, time-series visit, trajectory
  lines): the indicator is hidden in every sample, `wait-analyses` finishes
  and the movie export saves.
- **B4, script IDs.** Only `script-` followed by 1–9 digits advances the
  script counter, so a saved ID at or above 2⁵³ cannot stall **New**. Saved
  IDs are otherwise kept as they are.
- **B5, double-float arithmetic.** The rounded values of every error-free
  transform (`dsAdd`, `dsMultiply`, `ddAdd`, `ddMul`, `deltaResidual`) are
  multiplied by a runtime 1.0 that the shader compiler cannot fold. Each
  device runs a self-test of 96 fixed operand pairs at initialization; if it
  fails, Voronoi, ideal strain, frame strain and displacement raise
  `GpuUnavailableError` and run on CPU Workers, while other kernels stay on the
  GPU and remain prewarmed. On the GTX 1080 Ti the helpers are exact for
  65,536 of 65,536 pairs (before: 38% for additions, 0% for products).
  HEA Voronoi (28,800 atoms) on the GPU needs 8–11 exact recoveries instead of
  258–286 and has no topology mismatch (before: 8–12 wrong Voronoi indices).
- **B5, intended numerical changes.** On affected hardware, results of the
  pair kernels move toward the CPU reference (frame strain error 3.8×10⁻⁵ →
  ≤ 7.5×10⁻⁹). On the software adapter, frame strain, displacement and ideal
  strain are element-wise identical (950,400 values), and every Voronoi suite
  row keeps its backend and recovery count. The guard in `deltaResidual` also
  removes a cancellation that the software adapter's compiler performed, so
  GPU bond vectors, Q4 and local shear change there by at most 2.5×10⁻⁷,
  toward the CPU values.
- **B5, cost on the GTX 1080 Ti.** Cold compilation of each Voronoi clip
  pipeline takes 17–20 s instead of 6–7 s (warm: 0.13–0.17 s), Voronoi GPU time
  is 16–24% higher, and device initialization takes 0.10–0.19 s instead of
  0.04–0.05 s. Other warm kernel times are unchanged within noise. The fix was
  withdrawn once for this cost and applied again together with G1, which
  keeps Voronoi off the GPU unless the user asks for it.
- **B6, displacement near the Float32 maximum.** The GPU magnitude was NaN on
  the GTX 1080 Ti for components near 3×10³⁸, because the driver divides
  through a reciprocal that underflows. The kernel now sends an atom whose
  normalized root is not at least 0.5 (it is at least 1 in exact arithmetic)
  to the exact CPU correction. On the software adapter the fixture stays on
  the GPU as before. The Voronoi cancellation check now sizes its crystal from
  the reported batch capacity (2,916 atoms on hardware, 2,048 on software).
- **G1, Voronoi backend.** With GPU acceleration on, Voronoi analysis and cell
  geometry now run on CPU Workers; the WebGPU kernel is used only with
  **Voronoi → Calculation backend → Use the WebGPU kernel**
  (`settings.extensions.voronoi.gpuKernel`, off by default and when absent).
  GPU prewarming follows the choice: without the option it prepares the
  device, frame uploads and 21 general pipelines; with it, the Voronoi
  pipelines, index and workspace as before, and the radical clip pipeline only
  while radical cells are selected. CPU prewarming is unchanged: the Workers
  hold the frame before the first click, and the first job reports no kernel
  initialization, index build or upload.
- **G1, measured on the GTX 1080 Ti** (application, GPU acceleration on, 6
  Workers, click to "Calculated"): HEA 0.42–0.60 s instead of 5.4–6.0 s, Fe
  loop 0.73–0.94 s instead of 10.0–10.3 s, NiGB 11.4–11.7 s instead of
  25.8–26.0 s. On a cold shader cache all pipelines are ready after 7.3–7.4 s
  instead of 42–45 s, and GPU memory for HEA is 1.0 MiB instead of 99.3 MiB.
  With the option on, a frame whose first batch already exceeds the recovery
  limit goes to the CPU after 0.13–0.21 s instead of about 15 s (NiGB), and
  playback prepares GPU Voronoi inputs only after a frame has been shown for
  1.25 s or playback stops.
- **G1, identical results.** SHA-256 digests of every Voronoi result array,
  the index list and the statistics are equal between the new default route
  (GPU acceleration on) and the previous build with GPU acceleration off, for
  HEA, the Fe loop and NiGB, isolated and non-isolated. The GPU kernel's
  shaders are unchanged; the previous and new drivers, run alternately on one
  device and one uploaded frame, give equal digests for HEA and the Fe loop.
- **B10, LAMMPS dump IDs.** Dump frames are marked as having explicit IDs, as
  the other formats are, so imported external properties follow atoms across
  frames ("Values follow stable atom IDs across frames") instead of applying
  to the import frame only.
- All **1,723 Node tests** pass (1,668 before); the production build succeeds.
  New test files: `tests/replicated-trajectory.test.js`,
  `tests/gpu-exact-pairs.test.js` and `tests/gpu-exact-pairs-fallback.test.js`;
  additions cover dump IDs, script IDs, replication, GPU fixtures, Voronoi
  routing and its option, prewarm targets, the fail-fast rule and the
  configuration round trip.
- All **37 browser and GPU suites** pass on Chromium with the software
  adapter. `browser-trajectory-tools` gained checks for superseded navigation,
  rejected recipes in both directions, a recipe that turns smoothing on and a
  smoothed reference-frame read; they fail on the previous build and pass
  isolated and non-isolated. `browser-advanced-tools` gained wrapped physical
  copies, the GPU suite ten replicated fixtures, and the Voronoi suites the
  routed run, the option and its prewarm targets.
- **Hardware (GTX 1080 Ti).** `npm run test:gpu -- --hardware` and
  `npm run test:gpu:voronoi -- --hardware` both pass unmodified (261 kernel
  rows; 45 Voronoi rows). Before this work the first stopped at the exact-zero
  HCP ideal-strain check and the second at "Periodic FCC".

## Move crystal reset (2026-10-09)

Reference: `c993ad6`, synchronized from `origin/main`. Move crystal now exposes
a desktop circular-arrow reset button and a matching **Reset crystal** action
in Display. Both restore the source origin to `(0, 0, 0)` through the existing
origin-commit path; camera, coordinate mode, replication and analyses are kept.

- All **1,529 Node tests** pass; the production build succeeds.
- Two added regression tests cover wrapped/unwrapped resets, repeated resets,
  disabled loading state, source/camera/replication preservation, and resetting
  active mouse/touch drags followed by late movement or release.
- The production crystal-drag browser suite passes on Chromium with a software
  graphics adapter. The new toolbar action restores the original coordinate,
  fractional-coordinate and bond-image hashes. Active reset clears the preview
  and prevents later pointer events from shifting the crystal again. The second
  view and all-cell Voronoi display follow the reset; bond-analysis data remain.
  Existing checks also restore the 60,229-atom Fe loop's DXA geometry through the
  Display action. Phone touch resets preserve the camera and toolbar footprint.
  At 1366 px, the reset control stays clear of the standard-view controls.
- Valid origin writeback clears stale input validation errors, including after
  restoring the original position.

## Grain segmentation, surface meshes, scripts and movies (2026-10-09)

Backlog items O15, O16 and A9 were merged together, which completes phase 3.

- **Tests:** all 1,668 Node tests pass and the build succeeds. New tests: 58
  for grains, 38 for meshes, 43 for scripts and movies.
- **Browser and GPU suites:** all 37 pass after the merge, including the new
  grains, surface-mesh and movies suites.
- **Rebuilt Wasm is reproducible:** the PTM kernel and both DXA kernels were
  rebuilt from the merged source in a different directory with emsdk 3.1.69.
  All six `.wasm`/`.mjs` files are byte-identical to the merged ones. The
  build scripts now pass `-ffile-prefix-map`, so binaries no longer embed the
  checkout path.
- **Existing results unchanged against `5157918`:**
  - CPU pool analyses match with `Object.is` on HEA, the Fe loop and NiGB, with
    copied and shared memory: coordination, both CNA modes, both CSP modes,
    PTM, bonds, local shear and RDF.
  - Single-thread DXA scientific output is identical on 11 cases for the plain
    and threaded kernels. The defect-mesh option leaves the lines identical,
    whether it is off or on.
  - The agent's PTM check found 0 differences in 245 arrays (11.9M elements)
    over 35 cases.
- **Grain segmentation against `ovito==3.9.4`** (10 structures × 7 settings):
  - **On OVITO's own PTM output:**
    - the partition is identical in 70/70 (ARI 1);
    - mean orientations agree within 4×10⁻⁶°;
    - the automatic threshold is bit-equal on the 8 noisy structures;
    - on the two ideal structures OVITO itself varies run to run, and the
      result lies inside its range.
  - **End to end with AlloyView's PTM:**
    - grain counts are equal in 70/70 and partitions identical in 59/70;
    - the other 11 have ARI ≥ 0.9965, where atoms equidistant between two
      grains go to the other one.
- **Surface mesh:**
  - Periodic fcc, bcc and hcp crystals give no surface.
  - A cube and a periodic or triclinic slab give exact areas and volumes
    (10⁻⁹–10⁻¹⁰ relative).
  - Sphere and void volumes lie within their analytic brackets.
  - Capped display meshes are closed, and their volume equals the solid volume
    to 10⁻⁹ at smoothing 0.
  - Offscreen exports equal the screen, with a maximum difference of 0.
- **Scripts and movies:**
  - The script sources contain no `eval`, `Function` or dynamic import.
  - A tampered recipe script neither moves the camera nor downloads until Run
    is pressed.
  - All six video formats were re-read by an independent parser, decoded with
    `VideoDecoder` and a `<video>` element, and checked with ffprobe.
  - Movie frames match the PNG export of the same pose (mean difference
    1.1–1.5 of 255) and carry each frame's own label values.

## Text labels, time series, ambient occlusion and crystal drag (2026-10-09)

Backlog items O12, O13 and A6 were merged together, which completes phase 2.
A8 (following a growing trajectory) was dropped.

- **Tests:** all 1,527 Node tests pass and the build succeeds. New tests: 18
  for labels and time series, 15 for ambient occlusion, 15 for crystal drag,
  and 1 for the shortcut-precedence fix.
- **Browser and GPU suites:** after the merge all 34 pass:
  - new: ambient occlusion, crystal drag and text labels;
  - every earlier browser suite, from smoke through trajectory tools;
  - GPU, GPU bond statistics and GPU Voronoi.
- **Crystal drag and AO merge:** A6 and O13 edit the same bond vertex shader.
  The drag replica correction runs first and the occlusion factor second;
  bonds whose endpoint leaves the display are still hidden.
- **Text labels and time series:**
  - Every attribute that also appears in the summary CSV matches its row; a
    test checks more than 60 attributes.
  - Templates are only split and looked up, never evaluated; `constructor`
    and `__proto__` are unknown names.
  - With no labels enabled, export pixels are unchanged.
  - Labels appear in PNG, 1080p, six-view (once per sheet), the second view
    and every ZIP image, each with its own frame's text.
  - Background reading of file values never changes the displayed frame.
- **Ambient occlusion:**
  - With AO off, images match the previous build in 26 of 26 SHA-256
    hashes on SwiftShader and on the GTX 1080 Ti.
  - Intensity 0 equals Off. An export at the canvas size equals the screen
    with AO on, and a transparent export over white is within 1 level.
  - Buried atoms are darker than face atoms, which are darker than corner
    atoms; the result is deterministic.
  - On the GTX 1080 Ti, 40 directions at 1024² take 0.64 s for 60k atoms and
    0.89 s for 964k.
- **Crystal drag:**
  - During a drag nothing is uploaded; every GL upload call is instrumented.
  - After release, positions, fractions and bond shifts hash-match a typed
    origin, and the Fe-loop DXA lines hash-match too.
  - With 482k displayed atoms, frames take 3.0 ms (GPU finish) and pointer
    drags hold vsync.
- **Shortcut precedence:** saved shortcuts now win over defaults added later.
  A new command whose default is taken keeps only its untaken defaults, or
  stays unassigned, instead of discarding all custom bindings. Mutually
  conflicting saved data still falls back to the defaults.

## Radical Voronoi (2026-10-08)

This is backlog item O11, merged after O7 and O10.

- **Plane offset:** the CPU path passes |d|²/s + (wᵢ − wⱼ), with w = r²/s, as
  the Voro++ `nplane` offset. This is Voro++'s `container_poly` rule, so the
  committed Voronoi Wasm is unchanged. The GPU radical clip shader applies the
  same shift.
- **Unweighted results unchanged:**
  - **CPU:** SHA-256 of all 24 output fields and the cell-geometry arrays is
    identical to `HEAD`. This covers HEA, the Fe loop, NiGB, and synthetic
    FCC, BCC, HCP, triclinic and mixed-PBC crystals. Pool output equals
    direct.
  - **GPU:** real-GPU output already varies between runs on `HEAD`, because the
    linked-cell build uses `atomicExchange`. Identity was therefore shown on
    what the GPU receives:
    - the standard shader sources (SHA-256);
    - the complete host command stream and outputs against a deterministic
      fake runtime;
    - unchanged hardware timings.
- **Radical parity:** `test:gpu:voronoi` on SwiftShader compares GPU against
  Voro++. Cases:
  - CsCl against its analytic volume, rock salt, and equal radii;
  - triclinic and mixed-PBC cells with random radii, and a type subset;
  - empty cells recovered exactly, and the spread fallback;
  - Fe loop, HEA and NiGB samples.

  The maximum volume error is 2.6×10⁻⁵ Å³ with no topology mismatches. On the
  GTX 1080 Ti the Fe loop has 0 mismatches and HEA 9 of 28,800, within the
  unweighted kernel's own mismatch rate on that card.
- **Node tests:** all 1,478 pass and the build succeeds.
- **Browser and GPU suites:** after merging O7, O10 and O11, every suite
  passes, 31 in all:
  - **New:** radical Voronoi, Wigner–Seitz, trajectory tools.
  - **Voronoi and topology:** Voronoi, view/Voronoi, topology, coordination
    presets.
  - **Display and export:** smoke, export resolution, keyboard, orientation
    and discrete colors, legend preview, initial colors, atom details,
    selection/hide, slice sweep.
  - **Tools:** advanced tools, clusters, binning, expressions.
  - **Trajectory and warm-up:** trajectory Workers, CPU warm-up.
  - **Fe fixtures:** Fe input, Fe loop, Fe lattice GPU.
  - **DXA:** DXA, DXA visual, DXA parallel.
  - **GPU:** GPU, GPU bond statistics, GPU Voronoi.
- **CPU timing (pool, 7 Workers, unweighted → radical):** HEA 265 → 323 ms,
  Fe loop 513 → 580 ms.
- **Known before O11:** `test:gpu:voronoi -- --hardware` fails its unweighted
  "Periodic FCC" check identically on `HEAD`. Perfect crystals exceed the
  exact-recovery budget on that card and fall back to the CPU.

## Wigner–Seitz defects and trajectory tools (2026-10-08)

These are backlog items O7 and O10, merged together.

- **Node tests:** all 1,463 pass, including 20 Wigner–Seitz and 24 trajectory
  tests, and the build succeeds.
- **Wigner–Seitz** (13 kernel and 7 panel tests):
  - Covered cases: a perfect crystal, a removed atom, an added atom, swapped
    types, periodic wrap, triclinic and mixed boundaries, affine-mapped strain,
    ties and different atom counts.
  - The invariant atoms − sites = interstitials − vacancies holds.
  - Assignments matched exhaustive brute force on 24,000 random queries.
  - Pool equals direct (`Object.is`) with private and shared memory.
- **Trajectory tools** (24 tests):
  - Unwrapping: crossings in both directions, repeated crossings, triclinic
    and changing cells, open axes, missing and new atoms, and text, sparse
    and huge IDs. Out-of-order and truncated-log replays equal in-order
    integration.
  - Smoothing: window truncation, averaging across a boundary, ID reordering,
    and w = 0 returning the raw arrays.
  - Lines: stride, continuity and limits.
- **Browser suites:** all pass after the merge: Wigner–Seitz, trajectory tools,
  smoke, trajectory Workers, view/Voronoi, export resolution, orientation and
  discrete colors, keyboard, advanced tools, DXA, Fe loop, slice sweep,
  clusters, binning, expressions, initial colors, atom details and
  selection/hide.
  - **Wigner–Seitz** (both isolation modes), on a B2 FeNi fixture:
    - 1 vacancy, 2 interstitials and 2 antisites, with the marker at the
      removed site;
    - 0 defects for a 15% stretched frame with affine mapping, 16/16 without;
    - markers in PNG and in the second view.
  - **Trajectory tools** (both isolation modes):
    - inferred unwrapped positions within 6×10⁻⁷ Å of the true path when
      frames are visited out of order;
    - raw CNA 119/256 FCC against 256/256 smoothed;
    - continuous lines, which scale in 2× exports.
- **Timing (Node unless noted):**
  - Wigner–Seitz on 120,458 atoms: 0.10–0.15 s on one thread, 0.05–0.13 s
    with 8 warm Workers.
  - A 108k-atom × 24-frame dump: unwrapping takes 9.4 ms per frame and w = 2
    smoothing 63 ms per frame.
  - Inferred image flags on `fixed_end_climb` equal the existing CFG-sequence
    inference.

## Keyboard focus, export matting and orientation colors (2026-10-08)

These are follow-ups to the A3/A7/O14 review.

- **Scrolling keys** (arrows, Page Up/Down, Home, End, Space) drive the camera
  and trajectory only while focus is on the page or inside the 3D view. Focus
  in the sidebar or a panel, or in a scrollable overlay along the key's
  direction, keeps normal browser scrolling. Letter shortcuts stay global.
  - A browser check focuses a sidebar button and presses ↓ and Page Down: the
    sidebar scrolls and the camera does not move. Clicking the view returns the
    arrows to the camera.
  - Two keyboard-suite checks that depended on timing were made robust: the
    gear indicator is now checked before the next key, and scrolling is
    awaited.
- **Exports now match the view.** Chosen-size images use the view's own
  pipeline (no blending).
  - An export at the canvas size now equals the Current viewport image pixel
    for pixel (maximum difference 0) in perspective and parallel projections.
    Before, 0.20% of pixels differed, by up to 61 levels.
  - Transparent images are matted from black and white renders per tile:
    α = 1 − mean(w − k), color = k/α. Over white, a transparent export matches
    the white render within 1 level.
  - Tiled-versus-single comparisons and the 6000×4000 export are unchanged.
- **IPF coverage:** simple cubic and cubic diamond use the cubic key;
  hexagonal diamond and graphene use the hexagonal key. The PTM templates put
  cube axes along x/y/z, and for the hexagonal types c along z and a₁ along x.
  Only Other and icosahedral atoms stay gray.
- **Rodrigues RGB** replaces raw quaternion RGB under the same configuration
  ID.
  - Orientations are reduced to the m−3m (24) or 6/mmm (12) fundamental zone:
    the q ⊗ g with the largest |w| is kept, with w ≥ 0, which is PTM's rule.
    The Rodrigues components are then scaled by the zone half-widths.
  - Tests check invariance under all 24 cubic and 12 hexagonal operators and
    under q → −q, and saturation at the zone faces.
  - The reduction leaves compiled PTM output unchanged on rotated FCC and HCP
    crystals, because PTM already outputs fundamental-zone quaternions. The
    old documentation implied otherwise.
  - Round-off near the ideal orientation no longer produces 127/128 speckles.
- **Tests:** all 1,419 Node tests and the build pass. These browser suites pass:
  orientation and discrete colors, keyboard, export resolution, legend
  preview, smoke, view/Voronoi, DXA visual and slice sweep.

## Review of A3, A4, A7 and O14 (2026-10-08)

This is an independent review of `01e88f8`. The commit as delivered passes all
1,412 Node tests and the build. These suites also pass: keyboard, orientation
and discrete colors, export resolution, smoke, binning, expressions, clusters,
slice sweep, view/Voronoi, Voronoi, legend preview, initial colors, atom
details, advanced tools, topology, selection/hide, coordination presets,
trajectory Workers, CPU warm-up, Fe input, Fe loop, Fe lattice GPU, DXA, DXA
visual, DXA parallel, GPU, GPU bond statistics and GPU Voronoi.

- **IPF math:** checked by hand. PTM numbering and template axes match
  `third_party/ptm`: FCC=1, HCP=2, BCC=3; the HCP basal neighbors lie along
  ±x, so a₁ = [2−1−10] and c = z.
  - `R(q)ᵀ` matches the active template-to-sample rotation.
  - The cubic sector 0 ≤ y ≤ x ≤ z and the 6/mmm wedge are correct, and their
    weights equal 1 at the corners.
  - The stereographic key reproduces the corners [101] at u = √2 − 1 and
    [111] at u = v = 1/(√3 + 1).
- **Tiled exports:** in the forced 35-tile comparisons, 0.03–0.06% of pixels
  differ by more than 5 levels, with no seam excess (0.04% at seams).
  - The "Current view" path is unchanged.
  - A 6000×4000 export takes 2.7 s in 12 tiles.
- **Fixed — discrete legend colors:** colors came from hashed hues and were
  often indistinguishable. Values 1–6 had a minimum CIE76 ΔE of 8.0, 0–12 had
  3.6, and 0–31 had 0.7. Discrete values now use color number (value mod 18)
  from the cluster palette, now `DISTINCT_CATEGORY_COLORS` in `palette.js`,
  whose minimum ΔE is 25.6. Colors still depend only on the value. Any 18
  consecutive integers are distinct, which the tests check.
- **Fixed — orientation custom vector:** shared configuration JSON could
  supply an array-like `custom` such as `{ "length": 4294967295 }`. Copying it
  without a length check froze the page: 3×10⁷ already took 2.2 s. The length
  is now checked first, and a test covers this.
- After both fixes, all 1,414 Node tests and the build pass. These suites also
  pass: orientation and discrete colors, clusters, legend preview, initial
  colors and binning.

## Phase 2 completion and CI recovery (2026-10-08)

Reference: `a07793e`, synchronized from `origin/main`. The unfinished batch
recorded in the handoff was A3, A4, O14 and A7. Previously merged O5, O6, A5
and O9 were reviewed rather than reimplemented; the O9 backlog status is now
recorded as complete. These checks use Node.js 24.19 and Chromium in the cloud
environment, with a software graphics adapter where applicable.

- **Full validation:** all **1,412 Node tests** pass and the production build
  succeeds. Fifteen browser suites pass: keyboard, orientation/discrete colors,
  chosen-resolution exports, smoke, atom details, advanced tools, scalar legend
  preview, initial colors, floating view/Voronoi, slice sweep, DXA visual,
  clusters, spatial binning, expressions and selection hiding. The merged
  cluster/binning browser checks also cover private and shared-memory Workers;
  real Fe-frame binned values and CSV match the direct kernel.
- **A3 keyboard:** real key events verify the camera gearbox, screen-space pan,
  both projections, trajectory and slice actions, binding conflicts, local
  persistence, input/modal protection and PNG capture. Rolling from the Bottom
  preset now preserves the existing free-camera roll before applying the
  requested increment. Ctrl/Command/Alt retain their browser behavior during
  binding capture. At 390 px and 320 px, the expanded toolbar, Details and View
  controls remain inside the viewport without overlap.
- **A4 integer legends:** tests cover signed safe integers, stable colors and
  hidden values across reordered frames, undefined values, continuous fallback
  above 32 classes, and configuration replay. Browser checks exercise per-value
  hiding, the selected-atom shortcut, second-view synchronization, and scrolling
  a 32-class legend in a short desktop viewport. Image legends retain every
  class, including NaN, when more rows require multiple columns.
- **O14 orientation:** actual compiled PTM fixtures verify the inverse
  template-to-sample rotation on rotated FCC, BCC and HCP. IPF atom colors and
  stereographic keys share one formula; quaternion RGB treats opposite signs
  identically. A completed strain-only fit supports IPF and configuration replay
  with PTM disabled, while estimation-only caches remain unavailable. RGB modes
  are excluded from scalar binning; quaternion components remain eligible.
  Browser checks preserve scientific arrays and second-view colors. The
  exported IPF legend contains both symmetry keys and all three corner colors.
- **A7 images:** PNG, opaque JPG, independent second view, frame ZIP, six-view
  contact sheets and configuration replay use the selected dimensions. Tests
  cover current-size compatibility, custom aspect edits, invalid-input recovery
  and the 32-megapixel limit. Composite scenes include atoms, bonds, vectors,
  DXA, Voronoi, slices and annotations in both projections. Full versus tiled
  rendering differs by more than 5/255 in only 0.03–0.06% of pixels; tile-boundary
  differences stay below 0.04%. An independent simpler fixture matches byte for
  byte across 35 tiles. Transparent edges composited on white differ by at most
  2/255. A 6000 × 4000 PNG succeeds using 12 bounded tiles. Successful captures
  and injected failures restore camera, canvas and GL state and free temporary
  render targets. These are correctness checks, not physical-GPU benchmarks.
- **Merged-batch review:** computed speed cache invalidation now follows all
  three velocity component arrays. Selection expansion checks cancellation
  after CPU-budget admission and before allocating a Worker, including empty
  or already-complete selections. Regression tests cover both fixes.
- **GitHub Actions failure:** the supplied Node.js 24.21 log identifies
  `spatial-binning.test.js`'s real-Worker cancellation assertion: after
  `setImmediate`, a warm Worker could already have completed, so pending size
  was zero rather than one. An explicit dispatch handshake now aborts before
  another message callback can settle the request, retaining the scientific
  parity and recovery assertions. A forced parent-thread scheduling delay
  reproduces the old failure and passes after the fix. The workflow retains
  the existing action/runtime versions, preserves the test exit status through
  `tee`, publishes a bounded assertion summary, and retains failed logs for
  seven days. Five tests verify the summary formatter.

## Expressions, clusters and cutting-plane sweep (2026-10-08)

These are backlog items O5, O6 and A5, merged together with the P10 review fixes
below.

- **Node tests:** all 1,350 pass and the build succeeds. New coverage:
  - **Expressions (23 tests):** precedence, associativity and IEEE/NaN
    behavior; error positions; length and depth limits; prototype names such
    as `constructor` and `__proto__` resolve as unknown names; recalculation
    across frames and replicas; recipe validation; all selection operations;
    expansion compared against brute force in orthogonal, triclinic and
    partially periodic cells.
  - **Clusters (19 tests):** periodic chains with unwrapped centers; triclinic
    and open cells; selection restriction; sorting and tie rules; percolation;
    mass weighting. Pool results equal direct results (`Object.is`) for
    private and shared memory, different range splits and reversed merge
    order.
  - **Slices (14 tests):** Miller normals and d for cubic, supercell,
    hexagonal and triclinic cells; step and flip; slab half-space encoding
    against the CPU visibility test; outline edge cases; configuration
    round trip and loading of older files.
- **Browser suites:** all pass after merging: slice sweep, smoke, view/Voronoi,
  Voronoi, DXA visual, DXA, advanced tools, atom details, clusters,
  expressions, initial colors, legend preview, selection/hide, topology,
  coordination presets, trajectory Workers, CPU warm-up, Fe input and Fe loop.
  The expressions suite also checks that a hostile recipe is rejected without
  running anything, and that a 375 px phone layout has no horizontal overflow.
- **Clusters, 120,458-atom Fe loop (2.85 Å, Node):** one thread takes
  0.56–0.61 s; 30 warm Workers take 0.13–0.17 s; a first run, which starts
  the Workers and builds the index, takes 0.41–0.51 s. The single-thread cost
  is dominated by `NeighborSearch.within`.

## Review of P10 CPU reuse and merge yields (2026-10-08)

An independent review compared `cda3c41` with the P10/P13/P15/P18 commits on
the local machine (32 threads, Node.js 26.10).

- **Exactness:** the HEA screw, Fe loop and NiGB structures were compared
  with `Object.is` across coordination, adaptive and fixed CNA, manual and Auto
  CSP, PTM, bonds, local shear and RDF. The comparison covered copied and
  shared-memory pools, the results matched, and a repeated call on a resident
  frame also matched. The rebuilt plain and threaded DXA Wasm match the
  committed binaries' serial scientific output in all 11 cases. Hashes differ
  because Emscripten embeds absolute source paths. Main and 8-thread DXA show
  the same PDEL variation as `cda3c41`.
- **Regression found and fixed:** each chunk ended with a main-thread yield.
  Without `scheduler.yield` (Firefox, Safari, Node) a yield is a clamped
  `setTimeout`, so 112 chunks added up to about 0.45 s. One loop did nothing
  but yield. The bond merge now yields by copied volume (every 262,144 bonds)
  and the empty loop is gone. Compact coordination chunks measured every pair
  from both sides; pairs inside a chunk are measured once again, and only pairs
  that cross a chunk boundary are counted from each side.
- **Median of 7 runs, 120,458-atom Fe loop (2×1×1), 14 Workers:**

  | Analysis | `cda3c41` copied / shared | After review copied / shared |
  |---|---|---|
  | Coordination | 188 / 195 ms | 194 / 262 ms |
  | Adaptive CNA | 191 / 153 ms | 152 / 151 ms |
  | Fixed CNA | 118 / 94 ms | 89 / 91 ms |
  | CSP (12) | 110 / 90 ms | 86 / 84 ms |
  | PTM | 1,239 / 1,105 ms | 1,809 / 884 ms |
  | Bonds | 199 / 185 ms | 119 / 121 ms |
  | Local shear | 280 / 208 ms | 243 / 167 ms |

  Before the fix, bonds took 410/389 ms and local shear 535/450 ms. Without
  `performance.memory`, copied PTM now uses 6 Workers instead of 9. Each
  private Worker can retain two resident frames, so the copy budget counts
  two. Shared-memory PTM is faster. Shared-memory coordination traces vary
  between 171 and 262 ms.
- All 1,294 Node tests and the build pass. Before the fix, every browser
  suite passed on main: initial colors, smoke, atom details, view/Voronoi,
  selection/hide, topology, advanced tools, CPU warm-up, DXA, DXA parallel,
  GPU and GPU bond statistics. After the fix, smoke, advanced tools,
  topology, CPU warm-up and legend preview pass.
- **Browser harness:** both Chrome launchers now pass
  `--password-store=basic`. Without it, Chrome 154 on Linux asks the desktop
  keyring over D-Bus before its first HTTP request. With a stuck keyring, every
  `http://127.0.0.1` navigation hung: sockets opened but no request was sent,
  and `Page.navigate` timed out.

## Initial coordinate and velocity colors (2026-10-08)

**Position X/Y/Z** uses Cartesian wrapped/unwrapped coordinates without an
analysis. Existing CFG, dump/data and Extended XYZ velocity columns keep their
original keys and are labeled **Velocity X/Y/Z**. A complete triplet enables
**Speed magnitude**. Virtual fields leave source properties unchanged, retain
only the selected derived array and distinguish their legend keys from
identically named imported columns.

- All **1,294 Node tests** and the production build pass. New cases cover
  Cartesian/image coordinates, lazy reuse, absent/partial velocity data, units,
  NaNs, physical replication, name collisions, hidden-atom Auto bounds and
  configuration validation/round trips.
- `test:browser:initial-colors` checks all six coordinate/velocity components
  against independent expected palettes in the real renderer, with no WebGL
  errors. A two-frame triclinic dump verifies wrapped/unwrapped bounds, fixed
  limits across frames, speed magnitudes, configuration export/replay and a
  PNG containing the speed legend. A plain XYZ has no velocity choices. No
  vector tool is enabled and the imported scalar arrays remain unchanged.
- `test:browser:legend-preview` also passes for the existing scalar preview,
  exact commit/export, both views and Voronoi range filtering.

## P10, P13, P15 and P18 integration (2026-10-08)

Reference: `cda3c41`. The checks below use Node.js 24.19 and headless Chromium
in the cloud environment; they do not measure a physical GPU.

- **P10 CPU reuse:** independent comparisons cover 164 scientific cases on
  copied and shared-memory Workers, including fixed/adaptive CNA, manual/Auto
  CSP, PTM and ordering, coordination, bonds/distributions, RDF, local shear,
  reference strain, cached/fresh ideal strain and displacement. All arrays and
  statistics match the reference with `Object.is`, including NaNs. Fixtures
  include HEA, the Fe loop, FCC/BCC/HCP, mixed phases, thin periodic cells and
  open/triclinic boundaries. Tests also cover mutations, concurrent resident
  frames, canonical reductions, source cleanup, memory accounting and
  foreground admission during background preparation. Another 56 paired PTM
  Worker cases exercise prepared-neighbor tables, L1₂/B2 ordering, pure and
  multi-species types, in-place type changes, repeated fits and dynamic slicing;
  all seven PTM output fields remain identical.
- **P13 rendering:** the 20,000-atom browser fixture has no repeated scalar,
  color, mask or texture uploads, CPU color commits or scalar-array scans on
  nine drag ticks after preparation. Preview pixels differ by at most one RGB
  byte; committed pixels are byte-identical. Tests cover bond endpoints,
  selection overrides, Voronoi faces/edges, both views, immediate PNG capture
  before the next animation frame, keyboard/pointer cancellation, frame
  changes and extreme-value CPU fallback. Closing the source clears all eight
  atom buffers and shrinks the scalar texture while retaining reusable GL
  objects. The view/Voronoi browser suite also passes on desktop and mobile,
  including all 28,800 HEA cells and selected-cell highlights.
- **P15 parsing:** 83 independent comparisons preserve every parsed field,
  ID and property across all 44 examples, gzip inputs, late headers, malformed
  trajectories and random/backward CFG checkpoints. Five physical replication
  Worker fixtures match direct replication exactly, including triclinic cells,
  escaped IDs and imported string/vector/category properties. The real-browser
  test observes three concurrent parsers within a three-permit CPU budget,
  foreground seeks during prefetch, buffered playback and pause, cancellation,
  replicated next frames and source restoration. No permits remain after
  close. Load/replication prewarm checks preserve Workers and native heaps.
- **P18 DXA:** both rebuilt Wasm artifacts preserve the reference's normalized
  complete-result SHA-256 in 12 serial comparisons covering perfect FCC/BCC/HCP,
  a periodic screw, HEA and the real Fe loop. Native regression tests hold
  serial Delaunay geometry fixed while comparing one versus three edge-pass
  threads, including planar faults and a dislocation. They compare atom labels,
  full line coordinates, Burgers vectors, lengths, junctions and diagnostic
  regions. Parallel workers use private path scratch and defer graph-cache
  writes to the original ordered commit. Measurements of candidate/path stages
  fix Delaunay geometry to avoid attributing existing PDEL tie variation to
  these changes; see [the CPU profile](DXA_CPU_PROFILE.md).

The final build and all **1,286 Node tests** pass. Targeted browser checks pass
for scalar legend preview, trajectory Workers, view/Voronoi and CPU prewarm.
The last integration review also fixed cancellation during imported-property
attachment and cancellation of an image-series export while awaiting its index.
The complete browser smoke passes, including real Worker cancellation/source
close, physically replicated trajectories, mobile input, immediate ZIP export
cancellation, configuration replay and PNG output.
Both DXA browser suites pass: complete extraction and 14 isolated/nonisolated
parallel-stage checks covering pool reuse, cancellation/retry, exact private
stage parity and initialization/protocol/stalled-Worker fallback. The rebuilt
source checksum manifest matches the vendored files.

Warm CPU timings below are medians of three alternating reference/current
runs using **six Workers** and resident inputs. Worker count was explicitly
configured for this comparison; these timings are not portable speedup claims.
Updated warm calls report zero coordinate uploads and index builds.

| Case | Private copies, before → after | Shared index, before → after |
| --- | ---: | ---: |
| HEA adaptive CNA | 65 → 60 ms | 69 → 62 ms |
| HEA CSP (12 neighbors) | 58 → 40 ms | 47 → 35 ms |
| Fe Auto CSP | 136 → 146 ms | 169 → 121 ms |
| NiGB PTM | 869 → 784 ms | 839 → 730 ms |

The private Fe Auto CSP measurement is slower. Initialization/preparation and
these warm calculations have different costs; reuse does not guarantee every
analysis is faster on every host. DXA stage measurements and exact-network
checks are recorded separately in [the CPU profile](DXA_CPU_PROFILE.md).

## Backlog phase 1: performance and feature additions (2026-10-07)

The small items of the [improvement backlog](TODO.md) were implemented and
checked as follows.

- **DXA kernels** were rebuilt with native Wasm exceptions, SIMD and LTO and
  return per-atom labels as bytes. Single-thread SHA-256 hashes of the complete
  normalized result match the previous build for 14 cases on both the plain and
  the threaded kernel: the four examples (NiGB replicated 1×1×2), six NEB
  frames, synthetic FCC/BCC/HCP and the HEA example analyzed as HCP. The DXA
  browser suite and the isolated/nonisolated parallel suite pass.
- **PTM** was rebuilt with orientation and ordering outputs. Structure type,
  RMSD, scale, deformation and distance are identical to the previous kernel on
  the HEA, Fe-loop and NEB examples and on synthetic crystals; L1₂, B2, pure and
  three-species fixtures give the expected ordering classes.
- **Main-thread kernels:** category colors and masks, flattened scalar color
  maps, numeric atom-ID matching and the CFG parser changes are byte- or
  element-identical to the previous code on randomized data, edge-case IDs and
  all 44 example files, including six malformed CFG variants with identical
  error messages.
- **D²min** is zero for affine fixtures and matches a direct per-neighbor sum;
  the WebGPU suite (SwiftShader adapter) compares every reference-strain field,
  including D²min, with the CPU result.
- **LAMMPS data and POSCAR** parsers have unit tests for every supported layout
  and error. A real browser opened an 864-atom L1₂ data file (types named from
  Masses comments) and a POSCAR, and PTM reported 648 A-site and 216 B-site
  atoms.
- **Color tiles** follow atoms across a two-frame slip trajectory, keep the
  selection while the next frame computes, and are saved in configuration JSON.
- **Double-click anchoring** is limited to ordinary picking: presses elsewhere
  and measurement, slice or group picking reset or suppress it. The first
  browser run caught a spurious anchor between two separate clicks, which this
  rule fixed.
- All **1,198 Node tests** pass. Browser suites: smoke, atom details,
  view/Voronoi, selection hide, advanced tools, topology tools, DXA, DXA
  parallel, WebGPU and GPU bond statistics.
- The smoke test's shared-pool check assumed at most six analysis Workers, a
  rule the scheduler no longer has. The unchanged previous commit also created
  9 Workers in one of two runs, so the check now uses the real
  `hardwareConcurrency − 2` limit; two consecutive smoke runs pass.

## DXA lifetime cleanup and isolated routing (2026-10-07)

DXA private-stage input is retained between chunks of the same stage, then
disposed when that stage ends. Worker objects and initialized Wasm heap
capacity remain reusable. The displayed JavaScript network and the analysis
pool's deliberate current-source Voronoi preparation have separate lifetimes.
The main native kernel now also releases its serialized JSON storage after the
caller copies out the result. The complete C entry point keeps its returned
JSON readable until explicit disposal or the next calculation, while releasing
the native extraction session immediately.

- Both serial and pthread Wasm artifacts were rebuilt. All **1,178 Node tests**
  pass, including the complete-entry-point output lifetime, idempotent disposal
  and subsequent staged/complete reuse. Log:
  `/tmp/alloyview-dxa-cache-node-final.log`.
- The real 60,229-atom Fe browser check passes two automatic nonisolated calls:
  four local Workers and three, then two, tetrahedron Workers around one native
  thread. The complete network and atom labels agree exactly with the serial
  reference. Every DXA resident key and reservation is cleared at completion;
  CPU leases and active jobs are zero. The helper modules remain initialized.
  Log: `/tmp/alloyview-dxa-cache-private-browser.log`.
- The isolated browser selects **15 native threads**, skips private stage
  offload entirely and passes two Fe runs with no fallback. Atom labels,
  closed-loop topology and physical Burgers vectors agree with the serial
  reference; CPU leases and jobs return to zero. Shared heap capacity stays at
  **162,004,992 bytes** on both runs. This uses a local server supplying the
  deployment headers; no remote Cloudflare deployment was performed. Log:
  `/tmp/alloyview-dxa-cache-isolated-final.log`.
- The isolated Fe check now uses the existing CPU benchmark's **1%** length
  tolerance for native parallel PDEL insertion. The old **0.2%** threshold
  originated in the removed GPU comparison and incorrectly failed a valid
  native result at **0.226%** deviation. Final parallel lengths are
  **104.11750** and **104.23133 Å**, versus serial **103.96182 Å**: deviations
  **0.150%** and **0.259%**. All other scientific checks remain in place, and
  nonisolated private execution still requires exact equality. No numerical
  extraction or tessellation algorithm changed for this lifetime cleanup.

## DXA private CPU stage execution (2026-10-07)

Nonisolated hosts now reuse the existing analysis Worker pool for eligible
local crystal recognition and interface tetrahedron classification. One
single-threaded coordinator retains the complete global extraction. Automatic
private stages use at most **four Workers**, with actual retained-heap and
snapshot budgets reducing the count. Isolated hosts retain the shared-memory
pthread route, including Geogram PDEL when multiple native threads are selected.
Ordered cluster/mesh/tracing work still includes serial dependencies.

- All **1,177 Node tests** pass. New coverage includes the complete private
  local/tetrahedron interface, all five input lattices and perfect-only settings,
  exact exported cell labels and complete networks, CPU-lease release/reacquire,
  bounded Worker affinity under contention, measured retained heaps,
  timeout/cancellation and fatal coordinator cleanup before queued frames.
  Both serial and threaded Wasm builds pass; **26 native parity tests** cover
  17 local-recognition cases and nine tetrahedron cases.
  Log: `/tmp/alloyview-dxa-private-node-final.log`.
- The real browser source suite passes ordinary nonisolated extraction with
  two private Workers and exact serial network/atom parity; isolated pthread
  growth **2 → 3 → 4 → 1**, cancellation and reuse; threaded-module denial,
  pthread constructor denial, stalled startup and early startup abort; and
  all **eight** local/tetrahedron constructor, stalled-task, malformed-reply
  and active cancellation/recovery cases. Private failures complete the native
  CPU stage with exact output, preserve source buffers, release every CPU
  lease/job and close all Workers. A later healthy job retries both stages.
  The stalled-task fixture injects a **150 ms** deadline without changing
  the production **30 s** chunk deadline. Log:
  `/tmp/alloyview-dxa-private-parallel-final.log`.
- Production bundle **d9199f837826d74b** passes the full DXA UI checks on
  ordinary static hosting (**global one CPU thread, three private Workers**)
  and isolated hosting (**three native pthreads, no private stage offload**).
  Changing the GPU preference causes **zero** DXA reruns and preserves the
  result object. Family styling, lines with all atoms hidden, PNG export,
  configuration replay, physical/display replication, trajectory updates and
  phone layout pass. Cancellation during a native global stage preserves an
  unrelated coordination result; nonisolated extraction terminates its
  coordinator, while isolated extraction retains its shared coordinator.
  Logs: `/tmp/alloyview-dxa-private-ui-static-final.log` and
  `/tmp/alloyview-dxa-private-ui-isolated-final.log`.
- The remaining GPU regression passes **251 scientific comparisons**:
  **248 GPU paths** and **three expected CPU fallbacks**, plus **12**
  cancellation cases, **eight** displacement input validations and **61,719**
  exact arithmetic comparisons across **8,817** input pairs. Its **19**
  application checks pass preference routing, configuration replay, dependent
  arrow cancellation, trajectory residency, replication and source changes.
  This verifies compatibility of the shared analysis pool and Worker memory
  telemetry with the other GPU algorithms. Chromium software graphics verifies
  execution, not physical GPU performance. Log:
  `/tmp/alloyview-dxa-private-other-gpu-final.log`.
- The complete real Fe input contains **60,229 atoms**, **60,007 BCC** and
  **222 Other**. Nonisolated private execution preserves every segment point,
  length, crystal/spatial Burgers vector, junction, atom label and source
  statistic exactly against the serial reference. The closed **½⟨111⟩** loop
  retains **23 points** and length **103.961820921 Å**.
- A controlled two-Worker profile records warm serial total **3,130.7 ms**,
  first private run **2,854.5 ms**, and repeat **2,644.4 ms**. Repetition
  reduces total time by about **15.5%** in that run, with zero new stage
  kernels and zero stage fallbacks. Log:
  `/tmp/alloyview-dxa-private-fe-controlled.log`.
- The automatic profile mirrors application preparation: **18** resident
  Voronoi Workers, **15** warmed PTM Workers and one prepared DXA coordinator.
  The browser reports **40 logical processors**; these are individual browser
  runs rather than reserved CPU cores or a general speed guarantee. A first
  profile records **3,087.9 → 2,522.3 ms** warm serial/repeated total time
  (**18.3%** lower), with four local Workers, three tetrahedron Workers on the
  first call and two on repetition. Preparation takes **1,150.4 ms**, recorded
  separately. Log: `/tmp/alloyview-dxa-private-fe-auto-final.log`.
- Six further consecutive automatic calls preserve exact Fe output and
  keep both private stages active: **local 4 / tetrahedra 3** initially, then
  **local 4 / tetrahedra 2** on all five repeats, with zero fallbacks. Warm
  serial time is **3,041.7 ms**; the first call takes **2,620.2 ms**, and repeats
  take **2,365.8–2,471.9 ms** (mean **2,406.0 ms**, about **21%** lower).
  Four actual DXA stage heaps stabilize at **65.375 MiB** each after the second
  call and remain fixed through the sixth. Aggregate pool module capacities
  stay at **795.5 MiB**, plus **42.305 MiB** resident Voronoi inputs; these are
  reported buffer capacities, not process RSS. No private snapshot reservations
  remain after completion. Log:
  `/tmp/alloyview-dxa-private-fe-auto-stability.log`.
- The packed Fe tetrahedron snapshot is **65,226,416 bytes** (**62.2 MiB**).
  First automatic classification copies it to three Workers (**186.6 MiB**);
  repetitions copy it to two (**124.4 MiB**). Four local Workers copy
  **5,782,368 bytes** of geometry/cell input. These copies occur per selected
  Worker, never once per atom, and are included in measured complete run time.

Reproduce the automatic memory/reuse profile with
`npm run test:browser:fe-loop -- --software --workers=auto --repetitions=6`.
These tests require no GPU adapter for computation; Chromium software graphics
does not establish physical GPU performance. Private-stage improvements vary
with input geometry, available CPU capacity, retained memory and initialization.

## CPU-only DXA baseline before private-stage offload (2026-10-07)

The baseline revision performed complete extraction on CPU Wasm. Isolated hosts
used one shared heap and a reusable pthread pool; ordinary static hosts and
threaded initialization failures used the complete serial CPU path. The GPU
preference controlled other analyses and left DXA results intact. These records
precede private local-stage Worker offload. Verification commands were
`npm run test:browser:dxa`,
`npm run test:browser:dxa -- --isolated` and
`npm run test:browser:dxa-parallel`, after `npm run build`.

- All **1,128 Node tests** pass. Coverage includes the complete CPU interface,
  shared-pool reuse, partial/failed startup cleanup, timeout and cancellation,
  fallback diagnostics and retained serial capabilities after later errors.
  Log: `/tmp/alloyview-dxa-cpu-node-final.log`.
- The real browser pthread regression passes nonisolated serial extraction and
  isolated shared-heap extraction, pool growth **2 → 3 → 4 → 1**, source changes,
  cancellation, recovery and shutdown. Injected threaded-module fetch denial,
  pthread constructor denial and an actual child that never acknowledges
  startup all fall back successfully without repeated attempts or orphan
  Workers. The stalled-child test shortens the default **15 s** watchdog timer
  to **1.5 s** in its test shim; it does not change the production deadline.
- Early cancellation during real pthread startup acknowledges in about **11 ms**
  in this run, clears `client.current`, releases its CPU lease, retains the
  coordinator and shared control pointer, and allows a following two-thread
  extraction in the same kernel. This is a functional observation, not a
  latency guarantee. Log: `/tmp/alloyview-cpu-dxa-parallel.log`.
- Production bundle **4a0bea33ea0cdb2d** passes the DXA UI browser checks both
  without isolation (**one CPU thread**) and with isolation (**three CPU
  threads**). GPU preference changes cause **zero** DXA reruns and preserve the
  result object. Family styling, lines with all atoms hidden, PNG export,
  configuration replay, physical/display replication, trajectory updates and
  phone layout pass. Cancellation preserves an unrelated coordination result;
  serial extraction replaces its terminated Worker, while shared extraction
  retains its coordinator and kernel generation. Logs:
  `/tmp/alloyview-cpu-dxa-ui-static.log` and
  `/tmp/alloyview-cpu-dxa-ui-isolated.log`.
- The adapted real Fe-loop browser check includes all **60,229 atoms**:
  **60,007 BCC** and **222 Other**, one closed finite **½⟨111⟩** loop with
  **23 points**, length **103.961820921 Å**, and reciprocal endpoint
  self-junctions. Cold/warm atom labels match; line-length and physical Burgers
  differences are **zero**, and both runs retain kernel generation **1** and
  its heap. Log: `/tmp/alloyview-cpu-dxa-fe-loop.log`.
- `npm run test:gpu -- --software` passes **251 scientific comparisons** for
  the remaining analysis algorithms: **248 GPU paths** and **three expected
  CPU fallbacks**, plus **12 cancellation cases**, **eight displacement input
  validations** and **61,719 exact arithmetic comparisons**. Application
  checks pass CPU/GPU preference routing, configuration replay, dependent-arrow
  cancellation, trajectory residency, physical replication and source changes.
  This confirms that removing the DXA GPU routes preserves other GPU features.
  Log: `/tmp/alloyview-dxa-cpu-other-gpu.log`.

These browser runs use Chromium with software graphics where needed. They
verify execution and scientific invariants, not physical GPU performance or a
general CPU speedup. Cloudflare `_headers` are copied exactly into the build;
the deployment tests verify their global COOP/COEP/CORP rule.

Earlier DXA GPU results below are retained as historical measurements against
the revisions then tested. Their retired `dxa-gpu`, `dxa-local-gpu` and `dxa-f64`
commands are not current regression commands. These records do not imply a
currently available GPU DXA backend or change other analyses' GPU validation.
Commands shown with earlier DXA GPU records require the revision then tested.

## Voronoi edges, selection and load-time preparation

- All **1,140 Node tests** pass (`npm test`). Coverage includes single-cell
  amber highlighting, portable CSS-width edge ribbons, module-aware warmup,
  shared/private resident input preparation, retained native memory,
  foreground priority, cancellation, source invalidation and GPU workspace
  budgets. Log: `/tmp/alloyview-voronoi-warmup-node-final.log`.
- Two browser-scheduler regressions reproduce Worker-message starvation when
  background retries use boosted `scheduler.yield()` continuations. Both fail
  against the previous loop and pass with ordinary timer waits. Bounded
  coordinate copying retains its responsive yielding behavior.
- `npm run build` passes. Production bundle **4f6ae728e29e10c0** was used for
  the HEA browser benchmark, with Chromium 151, SwiftShader graphics, a
  browser-reported five logical processors and **three analysis Workers**.
  The host has a four-CPU quota; these are individual runs, not a general
  performance guarantee.
- The complete **28,800-atom** `examples/hea-fcc-screw.dump` result matches
  the previous bundle bit-for-bit in both isolated/shared and nonisolated/
  private CPU modes. SHA-256 checks cover **13 scientific fields**: all
  per-atom numerical arrays, complete face CSR and per-atom Voronoi indices.
  First calculations after preparation report **zero** native initializations,
  index builds and frame uploads, compared with three of each previously.

| HEA CPU mode | First kernel begins, before → prepared | First complete analysis, before → prepared |
| --- | ---: | ---: |
| Private coordinates | 32.7 → 21.0 ms | 817.5 → 661.3 ms |
| Shared coordinates | 29.0 → 5.7 ms | 738.5 → 740.4 ms |

- The prepared CPU source becomes visible in **258 / 289 ms** for private/
  shared modes; module and frame readiness follow at **382 / 388 ms** from
  load start. Preparation moves initialization ahead of the click; the shared
  case's unchanged total time illustrates that tessellation remains the
  dominant work.
- The software-GPU probe makes current-frame Voronoi resources available in
  **18.044 s** with four pipelines, one coordinate upload, one neighbor index,
  a bounded 512-cell workspace and one discarded driver-warmup cell. Previously
  even the coordinate upload waited for all 23 pipelines and began at
  **29.439 s**. Remaining general pipeline preparation still finishes at
  **29.628 s**. These are software-driver preparation measurements, not
  full GPU-analysis timings or evidence of physical GPU speedup.
- Reproduce with `npm run benchmark:voronoi:browser -- --output report.json`.
  `--cpu-only` omits the software-GPU probe; `--reference before.json` verifies
  scientific digests against a previous CPU capture. Executed reports:
  `/tmp/alloyview-voronoi-hea-before.json`,
  `/tmp/alloyview-voronoi-hea-before-digest.json` and
  `/tmp/alloyview-voronoi-hea-after.json`.
- `npm run test:browser:view-voronoi` passes on the same production bundle.
  The real HEA selected-only preview uses an actual pointer-picked core atom,
  amber facets and **4,678** pale-edge pixels on both white and dark
  backgrounds. A **390 × 640** phone at device-pixel ratio two retains
  **6,469** pale-edge pixels. Changing the selection updates the highlighted
  cell; hiding it removes both faces and edges. Periodic Z replication, the
  floating second view and both real PNG exports preserve scientific arrays.
  Existing all-cell highlights, slices, camera/layout recipes and phone
  interactions also pass. Report/screenshots:
  `/tmp/alloyview-floating-voronoi/report.json`; log:
  `/tmp/alloyview-view-voronoi-browser.log`.
- `npm run test:gpu:voronoi` passes **34 actual WGSL checks**: 30 GPU paths,
  one automatic CPU fallback and three explicit precision-limit fallbacks.
  A genuinely prepared first FCC calculation matches CPU topology and reuses
  its uploaded source, neighbor index and scratch; repeated preparation does
  not dispatch another warmup cell. Maximum scalar differences remain
  **3.59 × 10⁻⁵ Å³** for volume and **2.00 × 10⁻⁵ Å²** for surface area.
  Active 2,048-atom cancellation/resume and queued CNA device reuse pass.
  Log: `/tmp/alloyview-gpu-voronoi-preparation-scientific-final.log`.
- `npm run test:browser:voronoi` passes real CPU/GPU parity, element subsets,
  full-cell geometry, CSVs, PNG, masks/slices/replicas/comparison, configuration
  replay, source/frame invalidation, cancellation and phone controls. Its
  maximum CPU/GPU volume difference is **2.26 × 10⁻⁶ Å³**. Report:
  `/tmp/alloyview-voronoi-tools/report.json`; log:
  `/tmp/alloyview-voronoi-browser-final.log`.

## Floating views and Voronoi display

- All **1,114 Node tests** pass (`npm test`). New checks cover bounded
  pointer/keyboard window movement and resizing, portable layouts, camera
  transfer between different viewport aspects and across free-orbit poles,
  all-cell highlight draw ranges, independent slice/measurement selections,
  and retaining a closed second view's imported layout and camera until opened.
  Log: `/tmp/alloyview-view-voronoi-node.log`.
- `npm run build` passes. `npm run test:browser:advanced-tools` passes on
  production bundle **b51a0eed885997c1**,
  including real two/three-atom slice picks, camera controls, independent
  second-view gestures, configuration restore and responsive tools. Report:
  `/tmp/alloyview-advanced-tools/report.json`.
- `npm run test:browser:view-voronoi` passes on production bundle
  **eaeae767f7593015**, using a real 32-atom CPU Voronoi calculation and
  SwiftShader graphics. It verifies blue lit faces, contrasting selected-cell
  pixels with the single-cell preview off, synchronized radius controls,
  replicas, hidden selections and slices, and unchanged scientific arrays.
- Real pointer gestures move/resize the window and independently orbit, pan
  and zoom its camera. PNG exports use the comparison renderer's actual
  camera and the chosen background/legend/XYZ options, excluding DOM controls.
  Perspective and parallel camera transfer retain position, direction, roll,
  distance and field width. Enabled and closed-window recipes restore camera
  and layout, including export before reopening the closed window.
- **390 × 640** phone touch movement, resizing, PNG and camera application
  pass. **320 × 640** defaults stay bounded, avoid the folded Atom details
  toggle, and leave PNG/Apply controls reachable. Two/three-atom Slice picks
  retain visible amber selection rings after automatic picking completion
  and after measurement selections are cleared. Clearing slice picks leaves
  measurement selections intact.
- PNG comparisons use the actual export canvas and a bounded pixel tolerance:
  a standalone 2D-canvas check reproduced one-level RGB readback differences
  in this Chromium environment. The final export comparison differs in
  **601 channels by at most 1/255**; camera, renderer, options and dimensions
  are checked independently. These checks do not measure GPU performance.
  Log: `/tmp/alloyview-view-voronoi-browser.log`; report and screenshots:
  `/tmp/alloyview-floating-voronoi/report.json`.

## Voronoi element subsets and full-cell display

- All **1,102 Node tests** pass. Coverage includes true CPU/GPU input
  compaction, source-index result mapping, immutable/mutated input snapshots,
  parallel geometry streaming, cancellation, retained Worker/Wasm instances,
  bounded mesh uploads, CSV and optional recipe settings.
- Independent analytical checks use an eight-site Ni/Cu periodic checkerboard.
  All sites form SC cells with **8 Å³ / coordination 6**; either four-site
  element subset forms FCC cells with **16 Å³ / coordination 12**. Neighbor
  faces have the expected area **2√2 Å²**, and both subsets conserve the full
  **64 Å³** domain. Omitted types are absent as neighbors, with NaN scalar
  rows and empty face CSR in the full-source result. Reordered type indices
  follow their element labels, and explicitly including all types preserves
  every scientific array from the default analysis.
- `npm run test:gpu:voronoi` passes **34 actual WebGPU browser checks**, including
  all prior geometry/fallback cases and eight new subset cases. Real GPU
  kernels agree with CPU volumes, surfaces, complete face topology and original
  source-neighbor mappings; excluded coincident sites do not enter the GPU
  index. New subset fixtures have maximum absolute volume/surface differences
  of **1.91 × 10⁻⁶ Å³ / 5.19 × 10⁻⁷ Å²**. Subset/all cache switching and
  exact-threshold recovery pass. SwiftShader validates correctness only;
  these timings do not measure hardware acceleration.
- `npm run test:browser:voronoi` passes on the production build with real CPU
  and GPU Workers. It checks actual 8-cell/full and 4-cell/subset viewport
  meshes, PNG pixels, picking, replicas, comparison, hidden atoms and slices.
  Switching type selections replaces old geometry; cancelling a pending batch
  prevents late publication. Empty selections release old results, and recipe
  replay restores type labels and both independent display switches.
- The Element types and Distributions disclosures start closed. Common
  face-order bars are inside Distributions. All-cell rendering starts off;
  a **390 × 640** phone check also verifies touch toggles and these choices.
  Existing selected-cell, finite-boundary, camera-bounds and configuration
  regressions pass.
- Optional display geometry uses native CPU Workers for both statistics
  backends. One dynamically scheduled batch request reuses resident indices
  and Wasm memory, awaits consumer backpressure and streams at most **128 cells**
  per work chunk. WebGL buffers are appended per bounded group, with shared
  source-position/visibility textures and no per-cell draw calls. All cells
  are retained without truncation; complete display still requires memory
  proportional to the included mesh and is deliberately disabled by default.
- Cell and face CSV emit only participating original atom IDs, retain original
  neighbor IDs and include the type selection in metadata. Coordination
  summaries exclude NaN placeholders. All-type CSV remains byte-for-byte
  compatible with the previous format.

## Parallel Voronoi and selected-cell geometry

- All **1,080 Node tests** pass, including CPU scheduling/cache lifecycle,
  GPU host assembly and resource guards, scientific invariants, interactive
  result summaries and optional preview configuration.
- `npm run test:gpu:voronoi` passes **26 actual WGSL browser checks**: 22 GPU
  paths, one complete CPU fallback and three explicit precision/coverage
  rejections. Complete face neighbors, orders, areas, acceptance flags and
  indices are checked against Voro++, alongside volume and surface area.
  Maximum absolute volume and surface-area differences in these fixtures are
  **3.59 × 10⁻⁵ Å³** and **2.00 × 10⁻⁵ Å²**. SwiftShader checks correctness;
  these runs do not measure hardware GPU speed.
- The complete Fe source supplies both a 256-atom bulk sample and a 64-atom
  actual loop-core sample at source indices **[53344, 53408)**. The latter
  contains 13 non-BCC atoms and five defect Voronoi indices. Both samples
  match CPU face topology with **zero CPU corrections**. After cancellation,
  a 2,048-atom FCC job resumes using the resident device, inputs and workspace,
  retains coordination 12 and `<0,12,0,0>`, and conserves domain volume;
  a queued CNA job reuses the same GPU Worker.
- The NiGB example's thin periodic direction, large vacuum regions and
  nearly degenerate interfaces can exceed verified GPU precision/coverage
  bounds. Sampled exterior/interior ranges explicitly request CPU fallback;
  a bounded eight-cell recovery replaces all eight cells with exact native
  outputs and reports that count. No NiGB GPU speedup is claimed.
- `npm run test:browser:voronoi` passes on the production bundle with real
  CPU and GPU Workers. Summary cards, coloring shortcuts, interactive
  distributions, CSV and selected-cell face/edge pixels are checked. Origin,
  replicas, comparison view, hiding, slicing and PNG exports remain consistent.
  Cancelled/late replies, source/frame transitions, finite boundaries and
  **390 × 640** phone controls pass. Recipe import rebuilds fresh statistics
  and the selected mesh, restoring its atom ID, visibility, color and opacity.
  Ideal FCC GPU volumes use one Auto color; the distorted UI fixture's maximum
  CPU/GPU volume difference is **2.26 × 10⁻⁶ Å³**.
- Existing `npm run test:browser:topology-tools` and the full production
  `npm run test:browser` regression also pass with the new result interface,
  including bond/CSV behavior, trajectories, configuration, selections,
  mobile gestures, and 204,800-atom rendering/clipping/picking.
- CPU Voronoi uses dynamically scheduled bounded chunks and resident source
  snapshots, linked indices and Voro++ Wasm modules. Scientific arrays are
  bitwise identical to the pre-change implementation on both bundled examples.
  Repeated calculations initialize/upload/index zero times; cancellation and
  source release preserve Worker and Wasm instances.
- Native plane pruning retains Voro++'s complete marginal/search tolerance
  band. Adversarial near-coplanar checks compare neighbor ownership, areas,
  orders, vertices and polygon CSR with unfiltered native clipping; checking
  volume alone would miss an ownership change. After this correction, the
  complete NiGB and Fe scientific hashes still match all 11 typed arrays and
  Voronoi index strings recorded before the correction.
- Independent checks verify reciprocal face areas/orders, rotation and origin
  invariance, dimensional scaling, finite/triclinic boundaries, closed-cell
  Euler topology, two-face edge incidence, outward rendering triangles
  (including atoms exactly on nonperiodic walls) and
  mesh volume/surface agreement. A nearly tangent neighbor retains its genuine
  triangular face down to **1.95 × 10⁻¹² Å²**. Selected-cell camera bounds
  include periodic polyhedra extending outside the simulation cell.
- CPU timings below were measured with Node.js 24 and a **4-core cloud CPU
  quota**. Development activity and garbage collection affect elapsed time;
  these are example-specific measurements, not a universal speedup claim.

| Example | Atoms | Old 4 Workers | New cold / reused 4 Workers |
| --- | ---: | ---: | ---: |
| `NiGB_minimized.cfg` | 129,904 | 60.84 s | 17.83 / 14.67 s |
| `Fe_disloc_loop.dump` | 60,229 | 1.12 s | 0.934 / 0.630 s |

- The repeated NiGB run uses **508** chunks, and Fe uses **236**. Fe's reused
  1/2/4-Worker timings are **2.02 / 1.19 / 0.630 s**, with identical scientific
  hashes. Reproduce with `npm run benchmark:voronoi:cpu -- --dataset fe` or
  `--dataset nigb`; the script records actual workers, initialization/index/
  upload counts, full scientific hashes and CPU quota. Large vacuum-slab
  candidate lists still create substantial temporary CPU memory pressure.

## Hidden selections and automatic color ranges

- All **1,043 Node tests** pass. Focused regressions cover immutable ID masks,
  overlapping groups, independent physical replica IDs, hide/show controls,
  masked scalar extrema, fixed manual ranges, full-hidden/NaN cases, actual
  primitive texture uploads and empty-range PNG legends.
- `npm run test:browser:selection-hide` passes on the production build with
  real desktop and phone input. Hiding a selected outlier changes Auto limits
  from **[0, 1000]** to **[0, 2]**. A fixed **[-5, 50]** range stays unchanged
  through hide/show and frame changes; after row reordering, Auto excludes the
  same atom ID and reports **[10, 12]**.
- Display edits preserve source arrays, calculated properties, analysis caches,
  bond arrays and vector arrays. New CPU and actual WebGPU coordination jobs
  with a hidden atom both return **[2, 2, 2, 2]**, including its contributions
  to neighbors. Scientific CSV still contains all four atoms and the hidden
  value **1000**.
- Selected hidden atoms and their bonds/arrows disappear from both viewports
  and real PNG exports. With all atoms hidden, transparent captures have
  **zero nontransparent pixels** and Auto reports **No visible finite values**.
  Normal atom-type filtering continues to leave independent arrows visible.
  Overlap precedence, showing/deleting groups, JSON replay, missing IDs and a
  **390 × 844** phone touch check with a fixed viewport all pass.

## Bond statistics, Voronoi analysis and CSV exports

- All **1,025 Node tests** pass, and the production static build passes. The
  added checks cover scientific reference values, complete periodic images,
  triclinic and open boundaries, CPU/GPU dispatch, Worker/Wasm reuse, histogram
  reductions, cancellation, configuration validation and CSV formatting.
- Local Steinhardt Q4/Q6 agree with analytical SC, FCC, HCP and both BCC
  neighbor-shell references. CPU Workers count unique geometric bonds and
  every unordered pair of neighbor directions. Empty environments retain NaN
  order parameters, and complete histogram reductions preserve counts beyond
  the unsigned 32-bit range.
- `npm run test:gpu:bond-statistics` passes **15 real-browser cases**: 13 WebGPU
  computations and two explicit CPU fallbacks. Actual WGSL execution covers
  thin periodic cells and self-images, mixed-periodicity triclinic cells,
  element-pair exclusions, exact cutoffs/bin boundaries and a queued CNA job
  reusing the device/Worker. Histograms match CPU counts exactly; maximum Q4
  and Q6 differences in these fixtures are **4.66 × 10⁻⁷** and
  **4.18 × 10⁻⁷**, respectively. SwiftShader validates correctness, rather
  than hardware GPU performance.
- The independent **BSD-licensed Voro++** Wasm kernel passes periodic SC/FCC/BCC
  volumes and indices, a twelve-pentagonal-face icosahedral shell, finite-domain
  and mixed periodic boundaries, extreme thin single-site cells and
  unimodular changes of a cubic basis. Irregular structures conserve cell
  volume and reciprocal atomic interfaces have equal areas. Physical
  replication preserves local geometry; face thresholds change topology
  counts without changing physical volume or surface area. Initialized Worker
  cancellation recovers with the retained Wasm module. These original checks
  used CPU Workers; the added WebGPU checks cover the new backend.
- `npm run test:browser:topology-tools` passes the production UI using real
  CPU Workers. Known right-angle and SC/FCC/BCC fixtures verify distributions,
  Q4/Q6, Voronoi indices, color properties, physical/display replication and
  configuration replay. Graph cancellation preserves enabled bond statistics;
  graph-disabled frame changes retain their custom cutoff. Late replies after
  cancellation cannot republish properties.
- Actual CSV button downloads preserve source filenames, frame numbers,
  timesteps, units, full numeric precision and NaN. Checks cover bond
  distributions/order, Voronoi atoms/distributions/faces, general summaries,
  scalar/category/atom tables, RDF and a completed DXA frame with zero lines.
  Export formatting starts no new analysis. A **390 × 640** phone touch check
  keeps the viewport fixed while accessing Voronoi face exports.
- Auto scalar coloring keeps double-precision roundoff in otherwise uniform
  FCC Voronoi volumes from producing an artificial full color range. This
  display guard preserves the exact data, reported extrema and CSV values;
  explicit manual ranges still resolve those differences, and genuinely
  small relative physical variations remain distinguishable.
- `npm run test:browser:advanced-tools` passes again with these integrations,
  including ordinary atom selection after slice picks, origin, vectors,
  property import, precise camera edits, PNG exclusion and compact phones.
- The full `npm run test:browser` production regression also passes, including
  prior analyses, configuration migration, selections, trajectory playback,
  mobile gestures, multiview PNG exports and the **204,800-atom** rendering,
  clipping and picking case.

## Advanced display, property import and tool categories

- All **944 Node tests** pass. New regressions cover periodic image geometry,
  picked replica coordinates, invalid plane construction, camera roll and pole
  crossings, screen-aligned free orbit, narrow parallel zoom, independent vector
  buffers and dependencies, external ID mapping, and recipe validation. The
  production static build passes.
- `npm run test:browser:advanced-tools` uses the production page, real Chromium
  pointer/touch events, local files and CPU analysis Workers. Its six-atom
  trajectory and mixed-periodicity tilted-cell fixture verify source coordinate
  bytes and coordination results remain unchanged during display origin edits.
  Two- and three-atom slices use the clicked periodic copy, preserve existing
  planes on invalid input, and synchronize their numeric controls.
- Multiple vector fields retain independent names, colors, dimensions and
  visibility through replay and frame changes. Cancelling displacement removes
  only its dependent arrows. Physical replication increases the rendered field
  population from 6 to 12 without an upload-count mismatch. Fixed 2D planes
  render without GL errors, including a source parallel to the specified up.
- External CSV values map shuffled rows by atom ID, follow reordered trajectory
  frames, preserve NaN, and expand consistently for physical replicas. Rename
  and removal update the property selectors. A fresh recipe shows pending local
  files rather than inventing numeric values; reselecting the file restores its
  renamed/removed column settings and the selected color quantity.
- Camera XYZ/direction edits, sliders, the direction globe, roll at 90 degrees,
  viewport orbit/pan and perspective/parallel wheel zoom synchronize correctly.
  A committed focused input updates with the camera; an uncommitted draft is
  preserved. RGB cell directions submit distinct basis colors. PNG exports with
  the camera panel open and closed have **zero changed RGBA pixels**.
- Visualization/Modification category changes preserve an in-flight CPU result
  and completed properties. Actual phone touch scrolling at **390 × 640**,
  **320 × 568** and **640 × 400** keeps the viewport and camera fixed, with the
  camera panel folded. Desktop and compact-phone screenshots were inspected.
- Browser rendering uses Chromium's SwiftShader software graphics in this cloud
  environment. These are functional checks, not hardware GPU speed measurements.

The earlier validation sections below retain their original test totals.

## Viewport atom details and measurement vectors

- All **872 Node tests** pass, including signed distance components,
  triclinic minimum images, mixed/non-periodic directions, displayed coordinate
  overrides and old Atom details recipe migration. The static production build
  passes. Distance vectors reuse the same shortest-image calculation as the
  existing distance, angle and dihedral.
- Atom details is a viewport window with no sidebar tool button or panel.
  Desktop starts expanded; phones start collapsed and inert. Picking atoms,
  finding by ID, frame changes and completed analyses preserve the current
  sidebar tool and window expansion choice. Selected atom appearance remains
  initially collapsed. Closing a source restores the device default for the
  next source; legacy `activeTool: "selection"` restores Display while retaining
  selected IDs, appearance and measurement settings.
- Real production Chromium pointer checks on a 108-atom FCC trajectory cover
  all **23 imported** and **29 combined imported/calculated** property rows,
  including category names and NaN fields. Coordination remains 12 and CNA
  remains FCC; every displayed value updates on the next frame without losing
  the selected atom ID. Clearing inspection and clearing measurements affect
  their respective selections independently.
- A four-atom periodic fixture displays first-to-second components
  **[1, −2, 3] Å**, distance **√14 Å**. Disabling periodic image correction gives
  **[−9, −2, 3] Å**, distance **√94 Å**; reversing picks gives **[−1, 2, −3] Å**.
  Both direction and distance use the same coordinate/image convention.
- Actual **390 × 844** phone touch checks pass default collapse, keyboard
  exclusion, View/Legend/details switching, Escape focus return and independent
  window scrolling. Camera, fixed viewport bounds and page scroll stay exactly
  unchanged. The window leaves the Legend entry reachable, including with
  trajectory controls visible. Desktop and phone screenshots were inspected.
- Compact **390 × 640**, **320 × 568** and landscape **640 × 400** touch
  checks also pass. Their windows retain respectively **123, 82 and 41 px**
  of visible content with independent scrolling and reachable View/Legend
  buttons. Short screens let the expanded window occupy trajectory space;
  collapsing it restores the normal layout. Camera and viewport remain fixed.
- Actual **1,090 × 928 PNG** exports with the same selection, camera and
  measurement state are pixel-identical with the window expanded or collapsed:
  **zero changed RGBA pixels**. The existing exporter captures WebGL pixels and
  explicit legend/axes, so inspection controls are omitted.
- The full production browser smoke passes, including ID lookup, measurements,
  appearance edits, two-view camera controls, analysis/legend interactions,
  configuration replay, phone gestures and 204,800-atom rendering/picking.

Reproduce with `npm test`, `npm run build`,
`npm run test:browser:atom-details` and `npm run test:browser`.

## Parallel DXA preparation and coordination cutoff presets

- Both serial and threaded DXA Wasm kernels were rebuilt with Emscripten
  3.1.69, and the pinned native source checksums pass. All **871 Node tests**
  pass, including real shared-kernel snapshot parity, tilted geometry,
  workspace budgets, cancellation/retry and retained CPU fallback topology.
- The interface optimization records boundary bits and wrapped-cell errors
  in parallel, then commits topology in its original order. Native retained-
  topology probes pass **54 exact network/region comparisons** and **18
  invalid-interior-cell checks**. Parallel snapshot packing preserves all four
  arrays byte-for-byte in **36 exports** and recovers from cancellation during
  packing. The existing thread pool and Wasm memory are reused.
- An isolated, alternating old/new Wasm comparison covers the 60,229-atom Fe
  loop and physically replicated 259,808-atom NiGB, with 1/2/4 threads and three
  timed repetitions. All 48 warm/measured analyses preserve atom labels,
  Burgers family and network connectivity. Threaded interface-stage median
  time falls **17–29%**; four-thread whole-analysis medians change
  **1,118 → 861 ms** for Fe and **7,772 → 7,259 ms** for NiGB. Unchanged stages
  also fluctuate, so whole-frame gains are measurements of this cloud run,
  not isolated attribution or physical-GPU performance claims. Serial whole-
  frame gains are not consistent. Protocol, stage timings, hashes and raw
  results are retained in the [CPU profile](DXA_CPU_PROFILE.md).
- The cutoff list covers **35 metal elements**, retains Custom as its first
  option and keeps the numeric input above it. Automatic selection uses only
  element labels actually present in the loaded frame. Mixed known elements
  use the largest constituent preset with an explicit explanation; numeric
  or unknown labels retain Custom and the 3.00 Å fallback. Existing element
  defaults are unchanged, and all values remain editable starting estimates.
  Recipe checks preserve exact saved numeric values, including older presets
  and recipes made before presets existed.
- Final production Chromium checks pass **18 CPU Worker/JavaScript cutoff
  parity cases**, seven source imports, unused type metadata, manual element
  selection, incomplete numeric typing, legacy/custom/preset recipes,
  trajectory and replication persistence, cancellation, and the 390-pixel
  phone layout. Opening a source suggests a radius without starting analysis;
  selecting Custom alone also leaves analysis unchanged.
- The production Fe visual regression with the rebuilt native kernels retains
  **60,007 BCC / 222 Other**, one closed finite BCC **½⟨111⟩** loop of
  **104.166673865 Å**, reciprocal junctions and unchanged source coordinates.
  The display remains a connected tube with 88 rings and a shared closing
  seam. Crystal/scalar filters, independent line visibility and PNG export
  pass on the real dump.
- The full production browser smoke passes, including configuration replay,
  manual/automatic legends, Auto CSP, strain, selections, physical replication,
  trajectories, phone gestures, PNG and the 204,800-atom rendering/picking case.
  Its selection-group setup now dispatches the numeric input event before
  Calculate, exercising the same Custom transition as a real radius edit.
- The real Chromium/SwiftShader GPU integration passes all five DXA stages:
  CPU and hybrid extraction retain the same FCC screw labels, Burgers vector
  and **14.934458956 Å** line. Thin-cell failure, unavailable-device CPU
  fallback, cancellation after a submitted alpha batch, native workspace
  overlap rejection and asynchronous-callback abort all recover on kernel
  generation 1 with the retained workers. This validates GPU correctness,
  not hardware GPU speed.
- Actual browser pthread checks pass serial fallback without COOP/COEP and
  parallel extraction with isolation. Pool growth **2 → 3 → 4 → 1**, then a
  new source at two threads, retains generation 1, the grown three-worker pool
  and the 33,554,432-byte heap. Cooperative cancellation keeps the coordinator
  and pool alive; recovery restores the correct winding and network, and
  explicit shutdown closes every worker.

Reproduce with `npm test`, `npm run build`, `npm run test:browser`,
`npm run test:browser:coordination-presets`,
`npm run test:browser:dxa-visual -- --software`,
`npm run test:browser:dxa-gpu -- --software --integration-only` and
`npm run test:browser:dxa-parallel -- --software`.

## Continuous DXA tubes and independent crystal visibility

- All **862 Node tests** pass. The new checks cover shared-ring closed tubes,
  transported frames, triclinic periodic winding, open junctions, slice and
  radius buffer reuse, render-only endpoint snapping, classifier-specific
  category IDs, pending frames, cancellation and recipe compatibility.
- The production Chromium check uses the actual 60,229-atom Fe dump with CPU
  computing and SwiftShader WebGL rendering. It identifies **60,007 BCC** and
  **222 Other** atoms and one closed finite BCC **½⟨111⟩** loop. The final run's
  parallel native length is **104.293802536 Å**, within 1% of the retained
  serial reference; parallel Delaunay tie ordering can change its smoothed
  representative. The new tube has 88 shared rings, 1,056 vertices and 6,336
  indices, a shared closing seam, no end caps and one connected surface.
  Source coordinates, Burgers vectors, lengths and junction topology remain
  unchanged by rendering. Native endpoints differing by about 10⁻⁸ Å close
  correctly in the drawing copy. Actual PNG exports were inspected alongside
  the old cylinder renderer using the same native result, view and radius.
- DXA colors and counts remain available for perfect crystals with zero lines.
  With CSP scalar colors, hiding BCC leaves exactly 222 Other atoms. A live
  custom scalar upper limit then combines with this filter to leave 112 atoms;
  changing crystal checkboxes never restores atoms excluded by the scalar
  range. Switching between PTM and CNA filters on a nonconstant input scalar
  preserves the selected quantity and range, with visible counts 65 → 0 → 65.
  These edits trigger no analysis calls. Hiding all atoms leaves the complete
  line network visible, and Burgers-family toggles affect only its lines.
- JSON replay restores the independent classifier source, per-class choices,
  CSP range and line settings. DXA cancellation removes only its classification
  and network while retaining completed CNA/PTM results; a color choice made
  during extraction survives its reply. Explicit cancellation removes obsolete
  classifier options while normal frame changes retain pending filter choices.
- The complete production browser smoke passes, including Auto CSP mixed
  phases, strain, trajectory caches, comparison views, selections, physical
  replication, PNG transparency and phone interaction. The existing DXA browser
  check also passes without isolation headers: serial Worker extraction,
  periodic screw lines, slicing, line styles, PNG and recipe replay, cooperative
  cancellation/recovery, physical replication and trajectory updates.
- The [CPU profile](DXA_CPU_PROFILE.md) records retained-heap Wasm stage timings
  on Fe and physically replicated NiGB, a 1/2/4-thread sweep, and temporary
  native optimization experiments. This environment exposes four logical CPUs;
  six-thread diagnostic runs oversubscribe it. Existing native parallelism and
  scientific kernels remain unchanged in this update.

Run `npm run test:browser:dxa-visual -- --software`; add `--capture-baseline`
before committing to compare with the renderer at the current Git HEAD.

## Fe dump, geometry references and automatic examples

The new `examples/Fe_disloc_loop.dump` is a supported LAMMPS text dump with
60,229 atoms, unsorted stable IDs, triclinic periodic geometry, image flags,
and 14 scalar properties. It has no element column: input and legend retain
`Type 1` rather than inferring Fe from a filename. Numeric type identifiers
also retain safe integers beyond the signed 32-bit range.

- All **842 Node tests** pass, including the actual dump/native DXA fixture,
  robust PTM reference estimation, public hybrid PTM routing, and automatic
  example/build/development discovery. The catalog includes five options and
  all 40 NEB sequence frames, encodes asset paths, ignores unsupported and
  symlink entries, and participates in content-versioned build hashing.
- Actual adaptive CNA finds 60,019 BCC atoms and 210 Other atoms. PTM finds
  60,033 BCC atoms and 196 Other atoms. Geometry references infer
  **a = 2.8365753478 Å**, leave the element unknown, and preserve existing
  reference values. This measures current bulk geometry, including bulk strain.
  Real PTM tests cover all six supported reference phases, rotations, unequal
  hexagonal stretches, shear, separate types, phase ambiguity and defects.
- Native DXA extracts one closed finite BCC **½⟨111⟩** loop, 23 smoothed points,
  length **103.961820921 Å**, with reciprocal endpoint connectivity. A real
  Chromium/SwiftShader run executes all five GPU stages without fallback:
  all 60,229 local/final crystal types and **760,983 tetrahedron labels** match
  native results. The physical Burgers vector, line length and connectivity
  also match exactly. This full-stage correctness check uses an explicit
  512 MiB GPU test budget; production memory limits may select CPU fallback.
- Production browser checks open the discovered Fe example, verify numeric
  labels, infer references explicitly and automatically, calculate finite
  strain for 60,033 bulk atoms, and reuse the same PTM fit. Saved JSON contains
  reference values rather than estimator diagnostics and replays those values
  exactly. Manual values survive estimation; partial HCP references stay missing
  until estimated. Cancellation and reference/source edits reject late fits,
  including results arriving during the next source's download. Standalone PTM
  reruns on CPU/GPU preference changes and retains accurate fallback/timing details.
- A versioned production GPU check with the default 128 MiB budget prepares
  Fe neighbors on GPU and fits PTM in two shared Wasm Workers. All five complete
  PTM arrays match the native CPU oracle exactly, including NaN masks, and the
  same lattice estimate is recovered. Cached GPU strain and an edited reference
  match all nine CPU fields within **7.451e-9**, with the same NaN mask. The check
  records one neighbor preparation, one fit and two tensor evaluations; editing
  the reference retains private CPU and resident GPU fits without another upload.
- The complete production smoke test passes examples, existing analysis tools,
  recipes, trajectories, PNG, mobile controls and the 204,800-atom render/pick
  check. Its first run hit a CDP timeout during concurrent CPU-heavy validation;
  an isolated rerun passed without a timeout or product change.

Reproduce with `npm test`, `npm run build`, `npm run test:browser`,
`npm run test:browser:fe-input`, `npm run test:browser:fe-loop` and
`npm run test:browser:fe-lattice-gpu`.
GPU results here use a software adapter and do not establish hardware speed.

## Historical GPU local DXA correspondence

The next DXA stage runs nearest-shell search, local CNA and ordered ideal-bond
graph matching on the existing WebGPU device. Neighbor vectors remain resident
between kernels. Structure types and ordered neighbor indices return to the
retained native session; cluster construction, periodic Delaunay, mapping,
interface construction and line tracing still run on CPU/Wasm.

- All **810 Node tests** pass. New cases cover all five native lattice imports,
  complete screw extraction after injection, retained-session recovery,
  independent local/tetrahedron fallback, source ownership, periodic image
  aliases, workspace preflight, all allocation/read failure points and
  cancellation cleanup. Serial and threaded Wasm modules were rebuilt, and
  the vendored source checksum manifest passes.
- Actual Chromium/SwiftShader checks validate seven perfect-crystal cases:
  FCC, BCC, HCP, cubic diamond and hexagonal diamond, with additional
  perfect-dislocation-only HCP/hexagonal-diamond cases. Local types, neighbor
  sets, template signatures and every ideal-template bond agree with native
  results. Symmetry-equivalent neighbor permutations are accepted. Cutoff
  comparisons use a rounding bound; the FCC cutoff is bitwise equal after
  preserving the native binary32 constant before binary64 arithmetic.
- Eight defect/geometry cases cover a translated triclinic cell and unwrapped
  images, a vacancy, free surfaces, FCC/HCP stacking faults with and without
  perfect-only selection, and rotated perfect/screw controls. The 8,640-atom
  screw returns one perfect periodic line of **14.934458956039819 Å**, with
  matching physical Burgers vector, winding and junction connectivity.
- Exact and near-coincident coordinates are distinguished: the 257-atom
  fixtures recognize 245 and 243 crystalline atoms respectively. An unsupported
  large Cartesian origin requests CPU fallback rather than losing candidates.
- Standalone resident-neighbor checks compare **10,908** ordered indices and
  all three binary64 vector components against Cartesian brute force across
  five lattices, translated triclinic origins and unwrapped source coordinates.
  Radius expansion retains the same neighbor table and reads only a 16-byte
  completion record per attempt. The final local result reads 80 bytes per atom;
  common linked-cell indexing also reads its small occupancy control record.
- Real WGSL square-root/division checks pass **29,472** binary64 comparisons,
  including subnormals, last-ULP rounding, underflow/overflow and special values.
  Local lattice decisions use these integer-based operations without native
  GPU float64 or CPU per-atom fitting.
- End-to-end checks execute all five GPU stages on positive screw networks.
  The production local path skips CPU identification. Independent stage failure,
  thin-cell rejection and cancellation after submitted neighbor/classification
  batches recover with the same kernel generation and coordinator/device
  Workers. Existing tetrahedron cancellation and full CPU fallback checks pass.
  These checks pass both with cross-origin isolation and in an ordinary static
  browser context without SharedArrayBuffer, including serial heap reuse after
  cancelling neighbor batch 4,096 and local-correspondence batch 2,048.
- Seven full hybrid perfect-crystal runs additionally compare **260,522**
  tetrahedron region labels against the native oracle after importing GPU
  correspondence, with no differences. The production application passes
  extraction, line/atom coloring, PNG, recipe replay, physical replication,
  frame changes and mobile layout. CPU parallel/pool-reuse checks also pass.
- Versioned production ideal-strain GPU checks continue to pass after the
  shared runtime adds the two optional local DXA pipelines. Ordinary analyses
  become ready before optional DXA compilation completes.

Reproduce with `npm test`, `npm run test:browser:dxa-local-gpu`,
`npm run test:browser:dxa-f64` and `npm run test:browser:dxa-gpu`.
These are software-adapter correctness checks, not hardware speed measurements.
Cold compilation and execution on the software adapter can exceed
the production smoke test's initial 60-second extraction timeout. The test now
allows 180 seconds for extraction and passed on a separate run; this changes
the validation deadline, not product behavior.

## Historical hybrid GPU DXA

The preceding migration ran tetrahedron alpha filtering and elastic-compatibility checks on
the existing WebGPU device, then continues interface construction and tracing
in its retained CPU/Wasm session. The final backend is reported as `hybrid`;
CPU local correspondence, crystal mapping, robust periodic Delaunay and line
tracing were retained in that stage; local correspondence has since migrated
as described above.

- The full Node suite passes **783 tests**. New cases cover the staged native
  session, exact CPU-region injection, export memory limits, temporary snapshot
  release, shared GPU routing, cancellation races, source ownership and fallback.
- Real Chromium/SwiftShader runs compare **480,890 tetrahedron region labels**
  against the native implementation, with no differences, across perfect FCC,
  BCC, HCP, cubic/hexagonal diamond, a strained translated triclinic frame and its vacancy,
  a rotated perfect control and the 8,640-atom FCC screw fixture.
- Actual compute shaders pass **813 binary64 quotient comparisons** including
  last-ULP thresholds, subnormals, overflow and special values, plus synthetic
  alpha, degenerate-neighbor, reverse-edge, Burgers and nonself Frank-rotation
  checks. The shader does not use a float32 approximation for classification.
- The screw returns one perfect segment with the CPU Burgers vector, periodic
  winding and 14.934458956039819 Å source length. Its immutable upload is
  10,498,560 bytes; the one final GPU region readback is 504,276 bytes. Alpha
  labels remain on GPU between passes. This hybrid path still uploads mapped
  CPU geometry and completes extraction on CPU.
- GPU alpha-batch cancellation rejects with `AbortError`, retains the same
  native kernel generation and both coordinator/device Workers, and permits
  a valid subsequent screw extraction. GPU failure, CPU/GPU toggles and a thin
  cell error also preserve the healthy backend. Overlapping direct native API
  calls are rejected while a GPU callback holds the session.
- Production browser checks pass hybrid extraction without isolation headers,
  independent atom coloring, line colors/visibility/radius, PNG output, recipe
  replay, physical replication, frame transitions and mobile layout. The
  isolated CPU parallel/reuse browser checks also pass.
- Deferred pipeline checks verify that ordinary GPU warmup can finish while
  DXA compiles in the background, a foreground DXA call shares that compilation,
  error scopes remain separate and a closed device cannot receive stale cache
  entries. Final production DXA also exercises this shared initialization path.
- The existing WebGPU regression suite passes 251 comparisons, together with
  native application integration and versioned production Worker checks.

Parallel Delaunay insertion can change which representative atom anchors a
circuit center. The upstream uses perturbed edge vectors with unperturbed
anchors, so periodic endpoint residuals are bounded by four times its
`epsilon = 1e-10 * |a+b+c|`, plus arithmetic rounding. Winding tests now check
all three components against the integer cell-vector winding with that derived
bound; Burgers vectors, connectivity and relative arc-length checks remain.
For the screw this bound is about 4.55e-8 Å, rather than an arbitrary 1e-8 Å.

Reproduce with `npm test`, `npm run test:browser:dxa-gpu`,
`npm run test:browser:dxa` and `npm run test:browser:dxa-parallel` after
`npm run build`. GPU checks use a software adapter by default; `-- --hardware`
requires a real hardware adapter. No physical-GPU speedup is established by
these correctness checks.

## Dynamic CPU prewarming and one DXA heap

The application now uses one active CPU budget of
`max(1, navigator.hardwareConcurrency - 2)` across ordinary analyses and DXA.
Actual parallelism also depends on atom count, analysis type and memory limits.
Idle prewarmed Workers hold no CPU permit. Ordinary heavy-analysis prewarming
includes the PTM module's initial 16 MiB heap in its memory estimate.

File indexing overlaps module initialization, then the parsed atom count grows
the existing pools. Physical replication validates its projected atom count
and starts additional prewarming during coordinate generation. Display copies
do not change the analysis pool target. Frame visits check actual pool health
so a previously terminated ordinary analysis Worker can be prepared again.

DXA creates one shared Wasm module even when only one computation thread is
needed on an isolated host. Higher thread counts asynchronously load additional
pthread Workers into that same module and shared memory; lower counts retain
the unused slots. Normal source changes and shared-memory cancellation keep
the heap. The host sets a shared cancellation word without a receive-side reset
that could erase a racing abort. The client retains its CPU lease until native
work acknowledges cancellation. PDEL insertion currently acknowledges only
after its current stage completes. Static hosts cannot interrupt synchronous
Wasm through a shared word, so running serial cancellation still terminates and
replaces its Worker. Asynchronous module prewarming is retained on both hosts.

- All 758 Node tests pass, covering the weighted global budget, foreground priority,
  cancelled reservations, coalesced prewarming, ready acknowledgements and
  real PTM reuse with zero new kernel initializations. Real DXA tests retain the
  same shared memory and kernel generation through 1→4→1, cancellation/recovery,
  perfect-crystal classification and screw-dislocation extraction.
- The real browser DXA check passes source reset, adjacent pool growth
  2→3→4→1 and cooperative cancellation/recovery without recreating a coordinator
  or discarding child Workers. Explicit close still removes all nested Workers.
  The original no-isolation fallback and scientific winding/Burgers checks pass.
- The production CPU prewarming check simulates browser reports of 8 and 16
  logical processors, giving limits of 6 and 14. Loading a 3,072-atom crystal
  warms one analysis Worker and one DXA module. Display Z×20 leaves the pools
  unchanged; real Z×20 (61,440 atoms) starts growth before expanded rendering and
  prepares 6/14 ordinary Workers plus 5/13 DXA children. DXA kernel generation
  and its 32 MiB shared heap remain unchanged during this preparation. Reloading
  preserves both pools, and a subsequent coordination calculation reuses them.
- The full standard browser smoke and production DXA checks pass, covering
  existing analyses, configuration replay, image export, trajectories and mobile
  controls. Chromium/SwiftShader verifies execution and rendering; these are
  not physical GPU performance measurements.

Reproduce with `npm test`, `npm run build`,
`npm run test:browser:cpu-warmup -- --software`,
`npm run test:browser:dxa-parallel -- --software`,
`npm run test:browser:dxa -- --software` and `npm run test:browser`.

## Shared-memory DXA

The CPU backend now has separate serial and pthread Wasm artifacts built with
Emscripten 3.1.69. Local structure identification, periodic PDEL tessellation,
ghost-cell classification and elastic/alpha tetrahedron tests share one heap.
A bounded adapter also caps Geogram's eight-task Hilbert groups to the requested
computation threads; it does not modify Geogram's robust predicates. Global
numbering, ideal-edge mapping and dislocation tracing retain their coordinator.

- All 736 Node tests pass, including six additional real threaded-kernel tests.
  Perfect FCC, BCC, HCP and both diamond phases have no false lines. Two- and
  four-thread screw extraction preserves every atom label, signed Burgers
  vectors, junctions and periodic winding within `1e-8 Å`. PDEL insertion order
  can change the estimated core polyline: arc curvature and the difference from
  serial arc length are bounded to 0.1% of the analytic winding, rather than
  equating a curved trace to a perfectly straight line. Additional direct Wasm
  checks passed with 2, 3, 4 and 6 threads, including thin-cell error propagation
  from a child and successful reuse of that same pool afterwards.
- The real Chromium parallel check passes both deployment cases: no COOP/COEP
  selects serial even when two threads are requested; an isolated host starts
  the coordinator and actual child Worker. Cancellation during the local
  identification phase of a 110,592-atom frame closes every nested Worker,
  leaves no pending job, and a fresh pool recomputes successfully. The phase
  includes serial neighbor-index preparation, so this test does not claim to
  observe the exact instruction executing on each pthread at cancellation.
- The production DXA browser check still passes without isolation headers,
  including WebGL lines, image export, configuration replay and mobile layout.

`npm run benchmark:dxa -- --workers 1` and the corresponding `--workers 4`
command analyze real Z×2 replication of NiGB: 259,808 atoms, 249,620 FCC and
10,188 Other, zero dislocation segments in both runs. Node v24.19.0 in this
cloud container reports five available processors with a four-CPU cgroup quota.
One cold and one warm extraction were measured per backend; parsing and real
replication are outside these timings. Cold includes Wasm/pool initialization;
warm reuses the module. These CPU observations are not a general scaling
guarantee or a physical GPU benchmark.

| Measurement | Serial | Four computation threads |
| --- | ---: | ---: |
| Cold whole extraction | 17.64 s | 8.05 s |
| Warm whole extraction | 15.06 s | 7.23 s |
| Warm local identification | 1.52 s | 0.40 s |
| Warm periodic tessellation | 6.43 s | 2.47 s |
| Warm interface construction | 4.84 s | 2.05 s |
| Process RSS after warm run | 701.9 MiB | 759.7 MiB |

The observed warm whole-frame speedup is about 2.08×. RSS includes Node,
input/replicated JS arrays and retained Wasm capacity; it is not a sampled peak
or an isolated kernel allocation measurement. Shared-memory execution requires
an isolated host; GitHub Pages without these headers uses the serial kernel.
These CPU measurements predate the hybrid classifier described above. The
[resident GPU design](DXA_REVIEW.md) records the remaining periodic geometry
and tracing work for a fully GPU extraction. WebGL2 drawing requires final
network transfer; changing the renderer is not a prerequisite for that work.

Reproduce with `npm test`, `npm run test:browser:dxa-parallel -- --software`,
`npm run test:browser:dxa -- --software` and the benchmark commands above.
Rebuild both artifacts with `npm run build:dxa` and
`npm run build:dxa:threaded` after numerical source changes.

## Initial CPU DXA

The initial DXA module ports the actual OVITO v3.9.4 numerical core with a
dedicated, non-shared CPU/Wasm Worker. The checked-in factory and binary build
with Emscripten 3.1.69 / LLVM 19; the build verifies 58 vendored/adapted source
files. The per-file MIT option, Geogram BSD notice and source pin are retained.
FCC/BCC/cubic-diamond preferred crystal orientations match the upstream defaults.
GPU-enabled requests explicitly use CPU for this version.

- The full Node suite passes 729 tests. Eight tests execute the real DXA Wasm
  core: perfect FCC, BCC, HCP, cubic/hexagonal diamond; an FCC screw line and
  its rotated perfect control; thin-cell rejection and recovery; and a strained,
  translated triclinic FCC cell with an isolated vacancy. Perfect crystals and
  the vacancy do not create false lines.
- The independent screw fixture has 8,640 atoms, free X/Y boundaries and
  periodic Z. OVITO 3.10.6.post2 extracts one perfect `1/2<110>` line with a
  spatial Burgers-vector magnitude of 2.4890158698 Å. The port returns the same
  line count, family, periodic winding and Burgers vector; its local vector
  `[0.5, 0, -0.5]` also matches the reference. Traced/coarsened arc length is
  compared within 0.001 Å for Float64 input rather than requiring an exactly
  straight curve. The XYZ browser fixture passes through the existing Float32
  parser and uses 0.002 Å arc-length tolerance. Replication checks periodic
  winding and Burgers vectors separately from the slightly curved arc length.
- The full standard browser smoke passes with Chromium 151. The additional
  production DXA check, without COOP/COEP, runs actual Wasm in a Worker and
  actual WebGL line shaders. It covers family color/radius/visibility without
  another calculation, lines with all atoms hidden, PNG line pixels, recipe
  export/import with recomputation, termination during a native analysis stage
  while retaining coordination, Worker recovery, display versus physical
  replication, source/frame cleanup and a 390px phone layout. No page exceptions
  or GL errors occur. SwiftShader validates drawing, not hardware GPU speed.
- NiGB's original 129,904-atom thin Z cell produces the expected upstream
  rejection. Physical Z×2 replication produces 259,808 atoms and completes
  through the new Wasm bridge in one measured Node call of about 14.94 seconds,
  with zero lines and volume 3,437,153.1739577614 Å³, matching the native OVITO
  result. This is a CPU/Wasm observation, not a browser/GPU speedup benchmark.

Reproduce with `npm test`, `npm run build`, `npm run test:browser` and
`npm run test:browser:dxa -- --software`. Rebuild the numerical artifact only
when needed with `npm run build:dxa`. The generated screw fixture is in
`tests/helpers/dislocations.js`; the optional native OVITO oracle remains
research tooling outside the application's dependencies.

This is initial validation, not broad parity across realistic networks. Edge
dislocations, partials, loops, junctions, complicated interfaces and newer HCP
low-c/a behavior still need independent fixtures. The source review and first
native NiGB record remain in [DXA review](DXA_REVIEW.md).

## GPU ideal lattice reference and the enabled default

The latest checks use Node.js v24.19.0 and Chromium 151 with Google SwiftShader.
These are real WebGPU shader executions on a software adapter; physical GPU
performance for the new ideal-strain stages remains unmeasured.

- The full Node suite passes 692 tests, and the final integration checks pass.
  The static build and full standard browser smoke pass, including the visible
  and accessible **Enable GPU acceleration** label, its enabled default,
  toggling, explicit saved off preferences and older configurations without a
  GPU preference. An explicit off value stays off; a missing value restores on.
  Existing CPU calculations, configuration, mobile gestures, selection,
  replication, exports and 204,800-atom rendering remain covered.
- The scientific GPU suite passes 251 comparisons: 248 execute GPU kernels and
  three deliberately unsupported inputs use CPU fallback. Twenty common
  pipelines are prepared. Twelve nearest-neighbor tables agree exactly with
  CPU, including indices, counts and Float64 image vectors. Forty-two cached
  and fresh ideal-strain cases cover six reference phases, rotations,
  mixed elements, independent hexagonal `a`/`c`, reference edits, invalid and
  mismatched fits and tiny genuine strain. Maximum strain-field difference is
  `1.776e-15`; ideal zeros, NaN masks and the `1e-12` numerical-zero threshold
  are retained. Subnormal input deliberately uses CPU fallback.
- Fresh ideal strain uses GPU nearest-neighbor preparation, CPU WebAssembly
  PTM correspondence fitting, then GPU element-reference conversion and all
  nine tensor/invariant fields. The reference shader selects element/phase,
  validates fits and restores absolute lattice scale; CPU upload preparation
  does not calculate per-atom reference factors. Standalone PTM keeps its CPU
  neighbor search and fitting path.
- Compatible reference edits retain acknowledged private fit inputs and
  resident GPU fit buffers. New fits, source/revision/type changes and frame
  eviction invalidate the appropriate data. Results and source arrays retain
  their precision and ownership.
- Twelve cancellation checks cover preparation and publication across the
  supported analyses, including fresh-strain GPU neighbors, CPU PTM fitting
  and GPU reference/tensor completion. Cancelled requests reject with AbortError,
  preserve source inputs and permit recovery through the same GPU Worker.
- Native GPU application checks pass the enabled/renamed startup preference,
  fresh strain, reference edits with both caches reused, CPU/GPU switches with
  the same scientific fit, legend selection and cancellation. Existing CNA,
  CSP, displacement, configuration and physical-replication checks also pass.
  The production build loads its GPU and CPU Workers from versioned assets:
  108 FCC atoms give exact zero for all nine fields, all five PTM arrays match
  CPU, and a reference edit reuses both fit caches without another upload.

GPU checks pass as separate kernel, native-application and production-build
scopes. Their commands are:

```bash
npm run test:gpu -- --kernels-only
npm run test:gpu -- --application-only
npm run test:gpu -- --built-only
```

Both Ni benchmarks use every atom in `examples/NiGB_minimized.cfg` (129,904).
Fresh calculation matches all five PTM arrays exactly on both calls. The nine
strain fields have matching 4,627-atom NaN masks and maximum absolute difference
`7.45e-9`, with no CPU neighbor corrections. The edited-reference run changes
Ni's `a` from 3.52 to 3.4 Å, retains the same NaN masks/error bound and uses no
CPU corrections. Both measured edited calls reuse private and GPU fit inputs;
the fit upload count remains one.

| Calculation | CPU first / subsequent (ms) | Software WebGPU first / subsequent (ms) |
| --- | --- | --- |
| Fresh ideal strain, complete hybrid pipeline | 2039.0 / 1640.9 | 54582.2 / 52781.0 |
| Edited reference with resident PTM fit | 279.0 / 253.2 | 62.0 / 52.1 |

Fresh GPU timing includes neighbors, CPU fitting, reference conversion, tensor
evaluation, transfers and assembly, using four CPU fitting Workers. The edited
row uses three CPU tensor Workers and starts with its fit already resident:
CPU PTM preparation takes 1704.9 ms separately, and initial GPU upload/reference/
tensor preparation takes 252.4 ms separately. Its first measured edit therefore
does not include initial device or fitting cost. Integer-emulated IEEE64
neighbor preparation makes the fresh software pipeline slower here; resident
GPU reference edits are faster in this software run. These timings do not
establish speedups on a physical GPU.

Reproduce these scopes with `npm run benchmark:gpu -- --software --kernel=strainFresh`
and `npm run benchmark:gpu -- --software --kernel=strainEdited`. The existing
`--kernel=strain` mode measures reference conversion and tensor evaluation from
a cached CPU PTM fit.

## Optional WebGPU analysis

The following sections preserve earlier validation snapshots. Their feature
scope and default-off checks describe the application at the time of each run.

Validated with Node.js v24.19.0 and Chromium 151 using the Google SwiftShader
software WebGPU adapter. These checks execute actual WGSL compute shaders;
they do not establish performance on a physical GPU.

- The full Node suite, static build and complete browser smoke pass. Browser
  checks cover the default-off header switch, configuration export/import,
  light/dark contrast, mobile layout and all existing analysis workflows.
- `npm run test:gpu` compares actual WebGPU and CPU results for FCC/BCC/HCP,
  triclinic and mixed-periodic cells, thin boxes and repeated/self images,
  RDF element filters, exact cutoff/bin boundaries, geometric distortions,
  nearest-neighbor selection ties and undefined geometric shear. Unsupported
  algorithms/inputs use CPU; cancellation during preparation and after a GPU
  dispatch rejects with AbortError, and subsequent GPU work succeeds.
- The dedicated GPU Worker reuses one device, pipelines and uploaded frame
  buffers across analyses. Cached inputs are bounded; closing/changing the
  source releases GPU resources. Source arrays remain intact. Continuous
  arithmetic uses f32; high/low coordinate components retain input precision,
  and ambiguous distance/selection decisions use bounded CPU correction.
- `npm run benchmark:gpu -- --software` loads all 129,904 atoms of
  `examples/NiGB_minimized.cfg` and bypasses application result caches. Both
  first and subsequent results are checked. Coordination and RDF counts agree
  exactly; local shear's maximum absolute difference is `2.081e-6`, its
  coordination counts agree exactly, and 10 atoms require moment correction.

Representative full-call wall times from this **software-adapter** run:

| Analysis and parameters | CPU first / subsequent (ms) | WebGPU first / subsequent (ms) |
| --- | --- | --- |
| Coordination, cutoff 3.1 Å | 193.8 / 108.0 | 870.6 / 520.7 |
| RDF, cutoff 2.48 Å, 100 bins | 480.4 / 312.9 | 686.5 / 545.7 |
| Local geometric shear, cutoff 3.1 Å | 691.9 / 756.5 | 1878.3 / 1467.7 |

Kernels run in the listed order through the same CPU/GPU pools. "First" means
the first call of that kernel; earlier calls can already have initialized the
device and Workers. Subsequent GPU calls reuse their uploaded input. Wall times
include preparation/upload, execution, corrections, readback and assembly.
CPU coordination uses three Workers; RDF and geometric shear use four on this
machine. RDF corrects 38,552 pairs near bin/cutoff boundaries. Its cutoff stays
below half the example's 4.97773 Å periodic Z face height.

Software WebGPU is slower here. Run `npm run benchmark:gpu -- --hardware` on a
machine with a physical adapter and inspect the reported adapter to assess
hardware acceleration; neither software timing nor atom count alone predicts
a GPU speedup.

### Linux NVIDIA hardware validation

Validated on 2026-10-04 with Node.js v26.10.0, Chrome 144.0.7559.109,
NVIDIA GeForce GTX 1080 Ti and driver 580.178.04. Chrome reports vendor
`nvidia`, architecture `pascal` and `isFallbackAdapter: false`.

The original hardware runner returned no adapter. Explicit Vulkan flags alone
still failed with the inherited SSH display `127.0.0.1:857.0`; Chrome logged
`DisplayVkXcb.cpp:62 (initialize): xcb_connect() failed, error 1` and EGL
initialization errors. Removing `DISPLAY` alone selected SwiftShader instead.
Enabling headless GPU/Vulkan and removing `DISPLAY` together selects NVIDIA.
The runner now applies this configuration automatically and rejects software
adapters in hardware mode, including Chrome initialization logs on failure.

- `npm test`, `npm run test:gpu -- --hardware` and
  `npm run test:gpu -- --software` passed. Both browser modes cover numerical
  agreement, expected CPU fallbacks, cancellation/recovery and the application
  GPU switch.
- `npm run benchmark:gpu -- --hardware` passed for all 129,904 atoms with
  `gpuActive: true` and no fallback for every kernel. Coordination and RDF
  counts agree exactly with CPU. Local shear's maximum absolute error is
  `2.147e-6`, below the `3e-5` tolerance, with 10 corrected atoms.

Representative full-call hardware wall times from one run:

| Analysis and parameters | CPU first / subsequent (ms) | GPU first / subsequent (ms) | Subsequent CPU / GPU ratio |
| --- | --- | --- | --- |
| Coordination, cutoff 3.1 Å | 272.3 / 222.9 | 669.4 / 46.7 | 4.77 |
| RDF, cutoff 2.48 Å, 100 bins | 492.6 / 382.4 | 251.6 / 97.5 | 3.92 |
| Local geometric shear, cutoff 3.1 Å | 953.4 / 961.1 | 494.7 / 154.3 | 6.23 |

The same run order and full-call timing scope described above apply. CPU
coordination uses three Workers; RDF and local shear use six. These ratios
describe this file, parameters and one workstation run. Coordination's first
GPU call includes initialization and takes longer than CPU.

### GPU preparation and trajectory caching

Validated on the same GTX 1080 Ti workstation with hardware and SwiftShader
WebGPU. Enabling GPU computing prepares a device and 10 common pipelines,
then uploads the displayed frame and fills either a complete trajectory cache
or the nearest frame window within an allocation budget.

- The Node suite passes, including GPU budget/allocation, source lifecycle,
  foreground priority and scheduler cancellation regressions. Scoped
  out-of-memory checks shrink residency and retry once; pure validation errors
  do not shrink the cache. Oversized frames fail before host buffer packing.
  Hardware starts with a 2 GiB ceiling independently of individual buffer
  limits. A scoped out-of-memory regression starts at that default, verifies
  that it is not reserved upfront, and reduces residency to the current frame
  and one neighbor on a simulated smaller GPU.
- `npm run test:gpu -- --hardware` and `--software` pass numerical and
  application checks. Four prepared frames remain resident, subsequent
  analyses avoid both input transfer and GPU upload, and a CPU-reparsed frame
  reuses its stable GPU identity. Restricting the budget gives a two-frame
  window containing the current frame and its neighbor.
- Closing/changing a source preserves the same Worker/device and compiled
  pipelines while releasing input/index buffers. The application uploads a
  six-frame XYZ trajectory without calculating analysis results, switches to
  three- and two-frame sources, and handles rapid GPU toggles without stale
  residency. Disabling GPU lets accepted calculations finish before teardown.
- `npm run benchmark:gpu -- --hardware --preload` checks all 129,904 atoms.
  Preparation took 413.9 ms in one run, separately from calculation. GPU
  first/subsequent wall times were 94.9/49.0 ms for coordination,
  184.6/121.4 ms for RDF and 201.7/143.7 ms for local shear. All kernels report
  GPU input reuse with no fallback; counts agree exactly and local shear's
  maximum absolute error remains `2.147e-6`.
- Repeating the hardware preload benchmark after raising the default reports
  a 2,147,483,648-byte budget and only 4,676,544 bytes resident for the one
  prepared frame. Coordination, RDF and local shear all execute on WebGPU,
  reuse their prepared input and report no CPU fallback. All 52 Node test
  files and the static build pass with this default.
- A clean headless Chrome 144.0.7559.109 probe on this Linux NVIDIA workstation,
  without the runner's unsafe-WebGPU or Vulkan overrides, has a secure context
  and `navigator.gpu` but returns no adapter. The desktop browser could not be
  checked through the SSH session. Hardware benchmark success with launch
  overrides therefore must not be treated as verification of ordinary browser
  support on GitHub Pages; see [deployment checks](DEPLOYMENT.md#webgpu-on-github-pages).

### GPU bonds and ideal lattice strain tensor

Additional real Chromium/SwiftShader checks execute the bond and ideal-strain
WGSL kernels. Software-adapter measurements below do not measure physical
GPU acceleration; the preceding GTX 1080 Ti results cover the earlier kernels.

- GPU bonds preserve periodic and self-image edges, triclinic geometry,
  element-pair cutoffs and exact cutoff decisions. On all 129,904 atoms in
  `NiGB_minimized.cfg`, the 774,528-edge graph and coordination arrays agree
  exactly with CPU for both first and subsequent calls. Bond-vector maximum
  absolute error is `2.384e-7` Å, with no CPU fallback.
- Cached and fresh ideal FCC strain produce exactly zero for all nine GPU
  fields. Editable reference `a`, combined finite shear/dilation and
  independent HCP `a`/`c` tests have maximum absolute errors `8.20e-8`,
  `7.82e-8` and `1.49e-8`, respectively. Reference mismatches remain NaN
  without warnings. Fresh strain identifies its CPU PTM and GPU tensor stages
  as `ptm-wasm-worker+webgpu-strain-tensor`.
- Cached PTM tensor evaluation on the complete Ni grain boundary matches all
  nine CPU fields within `2.239e-7`; the NaN mask also agrees. Small PTM
  off-diagonal noise remains a supported input rather than forcing fallback.
  The CPU PTM preparation took 2023.5 ms in this run and is excluded from both
  cached-tensor timings. This comparison measures tensor evaluation, including
  input preparation, upload, readback and assembly; it does not measure GPU
  PTM fitting.
- GPU tensor failure reuses the completed CPU fit. Cancellation rejects with
  `AbortError` and does not start CPU fallback. Private PTM transfers preserve
  source fit buffers, and existing warmup, trajectory preload and source reset
  behavior remains covered by the browser checks.

| Software-adapter calculation | CPU first / subsequent (ms) | WebGPU first / subsequent (ms) |
| --- | --- | --- |
| Bonds, cutoff 3.1 Å | 838.1 / 521.3 | 2772.3 / 2399.3 |
| Ideal strain tensor, cached PTM, Ni reference `a=3.52` Å | 244.9 / 195.8 | 289.1 / 88.0 |

These kernels were benchmarked separately with
`npm run benchmark:gpu -- --software --kernel=bonds` and
`npm run benchmark:gpu -- --software --kernel=strain`. Each command reports its
adapter and full-call timing scope. The strain report separately identifies
the CPU PTM preparation engine and elapsed time.

### GPU CNA and reference-frame strain

Validated on 2026-10-04 with Node.js v24.19.0 and Chromium 151 using the
Google SwiftShader software WebGPU adapter. These checks execute actual GPU
shaders; they do not measure performance on a physical GPU.

- The final Node suite passes 510 tests with no failures or skips.
- The final GPU suite passes 101 comparison/recovery cases: 99 execute GPU
  kernels and two explicitly unsupported open-coordinate cases use CPU.
  Seventeen common pipelines are prepared, and both CNA modes retain exact
  CPU crystal labels across crystal, triclinic, mixed-PBC, primitive-image,
  cutoff/tie and overflow cases. A 4,394-atom BCC case uses genuine GPU
  classification with no CPU corrections.
- Twenty-seven reference-strain fixtures compare all 18 fields, including
  reordered/missing IDs, affine deformation, rotations, primitive images,
  triclinic cells, singular neighborhoods and undefined fits. NaN masks and
  incomplete counts agree; maximum absolute error is `8.88e-15`.
  Undeformed structures and rigid rotations retain exact zero strain. Real
  `1e-8` strain remains positive, with relative error below `9e-7`.
  Shared compensated multiplication uses bit-truncated Dekker arithmetic;
  this avoids assuming WGSL `fma` supplies a fused product residual.
- CNA and reference-strain cancellation during preparation and after dispatch
  rejects with AbortError; subsequent work succeeds through the same GPU
  Worker. Current/reference uploads are reused and retained during fitting.
- Native application checks cover GPU/CPU recomputation, CNA legend counts,
  reference-frame changes, cache reuse, cancellation and physical replication
  from 32 to 64 atoms and back. Auto central symmetry remains CPU work and
  reuses compatible adaptive CNA labels. The full normal browser smoke also
  passes existing CPU, configuration, mobile and 204,800-atom rendering checks.

Full `examples/NiGB_minimized.cfg` runs use all 129,904 atoms. Fixed CNA uses
3.1 Å; adaptive CNA uses local shell scales. Reference strain uses 3.1 Å and
a controlled affine copy with
`F = [1.02, 0.12, 0.03; 0, 0.98, 0.05; 0, 0, 1.04]`, rather than a trajectory.
All three analyses execute genuine GPU kernels without fallback and agree
exactly with CPU, including all 18 reference-strain fields and zero incomplete
reference fits. Adaptive CNA returns 4,954 Other, 124,810 FCC and 140 BCC atoms.

| Analysis | CPU first / subsequent (ms) | Software WebGPU first / subsequent (ms) | Sparse CPU correction atoms |
| --- | --- | --- | --- |
| Fixed CNA | 791.8 / 435.0 | 1105.8 / 972.2 | 404 (0.3110%) |
| Adaptive CNA | 938.2 / 611.8 | 2606.4 / 2080.9 | 4,822 (3.7120%) |
| Reference-frame strain | 1765.7 / 1453.0 | 5323.5 / 4823.0 | 124 (0.0955%) |

Each row comes from a separate cold/subsequent benchmark using four CPU
Workers. Full-call time includes preparation/upload, shader execution,
corrections, readback and assembly. Subsequent calls reuse inputs. More than
96% of adaptive CNA atoms need no CPU classification; its correction limit is
16,384 atoms, after which the complete calculation uses CPU. These software
GPU timings are slower than CPU and do not establish hardware acceleration.

The shared arithmetic change also passes the cached PTM/ideal-strain tensor
regression on this file: maximum absolute error `7.45e-9` and 4,627 matching
NaN atoms. PTM preparation takes 2164 ms separately; tensor-only CPU first/
subsequent times are 248.9/215.2 ms, and software GPU times are 224.6/109.9 ms.

### GPU central symmetry and displacement

Validated on 2026-10-04 with Node.js v24.19.0 and Chromium 151 using the
Google SwiftShader software WebGPU adapter. The final Node suite passes
635 tests with no failures or skips; the full normal browser smoke also passes
CPU analysis, cancellation, configuration, mobile and large-structure checks.

- The real WebGPU suite passes 193 comparison/recovery cases: 191 execute GPU
  kernels and two explicitly unsupported inputs use CPU fallback. Eight
  displacement input-validation checks reject invalid IDs, populations,
  coordinates or options. Nineteen common pipelines are prepared.
- Manual CSP covers every even shell from 2 to 32, FCC/BCC/HCP and primitive
  images, defects, triclinic/mixed-PBC cells, nearly tied neighbors, radius
  expansion and insufficient or zero-length environments. Auto checks fresh
  and cached adaptive CNA, mixed-phase local settings, FCC/HCP voting,
  unresolved ties and ICO. Structure labels, shell counts, summaries, NaN
  masks and incomplete counts agree exactly with CPU; maximum scalar error is
  `5.96e-8`, with no direct CSP CPU corrections. The integer IEEE64 arithmetic
  helpers pass 61,719 exact comparisons across 8,817 operand pairs.
- Displacement checks stable integer/string IDs, reordered and missing atoms,
  generated row correspondence, wrapped/unwrapped positions, origin and cell
  changes, triclinic and mixed-PBC minimum images, half-cell ties and wide
  coordinates. Float32 components agree exactly with CPU. Ordinary magnitude
  cases differ by at most `3.11e-15` Å; a separate overflow-sized case retains a
  finite Float64 norm above the Float32 range. Genuine motion near `1e-8` Å
  remains positive, while self-displacements stay exactly zero, including a
  20,000-atom case spanning multiple dispatch batches.
- Nine cancellation checks cover ID matching and GPU preparation/dispatched
  analysis. Cancellation rejects with AbortError, preserves source inputs and
  permits subsequent work through the same GPU Worker. Resident adaptive CNA
  and current/reference Cartesian uploads are reused.
- Native application checks cover manual 8/12 and Auto CSP GPU/CPU switching,
  recognition reuse, legend quantities, displacement components/magnitude and
  Float32 arrows, accepted-result cancellation and enabled-GPU JSON replay.
  The versioned production build also executes manual 8/12, Auto and
  displacement GPU kernels against CPU outputs on 108 atoms.

The full 129,904-atom Ni grain boundary runs use genuine GPU CSP without
fallback or direct CPU pairing corrections. Manual 8-neighbor error is
`5.96e-8`; manual 12 and Auto errors are `2.98e-8`. Auto retains 124,810 FCC,
140 BCC and 4,954 Other labels; all Other sites inherit a supported shell,
and no environments remain unresolved. Its first call performs adaptive GPU
CNA with 4,822 sparse CNA corrections; the subsequent call reuses recognition
without repeating that classification.

| Analysis | CPU first / subsequent (ms) | Software WebGPU first / subsequent (ms) |
| --- | --- | --- |
| Manual CSP, 8 neighbors | 835.5 / 547.1 | 56275.5 / 50421.4 |
| Manual CSP, 12 neighbors | 821.5 / 536.9 | 58466.9 / 56233.2 |
| Auto CSP | 932.0 / 625.1 | 62303.1 / 53690.8 |
| Displacement, excluding ID preparation | 97.9 / 43.9 | 281.1 / 69.2 |

Each CSP row comes from a separate first/subsequent benchmark using four CPU
Workers and includes preparation/upload, shader execution, readback and
assembly. Strict ordering uses integer-emulated IEEE64 arithmetic on this
adapter, and software GPU CSP is substantially slower than CPU here. These
results verify execution and numerical agreement; they do not establish
performance on a physical GPU.

The displacement run uses a synthetic Cartesian translation
`[0.12, −0.08, 0.05]` Å with known same-row correspondence to the Ni reference,
rather than trajectory motion. All 129,904 atoms match, all 389,712 Float32
components agree exactly, and Float64 magnitude maximum absolute/relative
errors are `1.3878e-16` Å / `9.09e-16`. The GPU uses no CPU corrections or
fallback. Its CPU calculation uses three Workers; shared ID matching and
coordinate preparation take 53.3 ms separately and are excluded from the
table's displacement timings. The benchmark also reports workflow totals
including that preparation cost.

## Atom selection groups and physical replication

- The complete Node suite passes 431 tests. Numerical replication checks cover
  triclinic cell vectors, imported category/vector properties, stable copy IDs,
  continuous periodic trajectories, reference strain and count/memory limits.
  Float64 supercell fractions preserve sub-Float32 geometry and nonbinary
  repeat counts; only the rendering upload converts coordinates to Float32.
- Real Chromium pointer and phone-touch checks cover click and rectangle
  selection, Escape cancellation, group names/colors/visibility, member edits,
  deletion, missing/reordered frame IDs and JSON replay. Display copies share
  source IDs; physical copies can be selected independently.
- Physical replication defaults off. A primitive four-atom FCC frame retains
  coordination 3 in display-only mode; doubling its physical cell creates eight
  atoms and coordination 5. Restoring display mode recovers source geometry.
  Rapidly enabling and cancelling a 64 × 64 × 1 expansion leaves the original
  structure and enabled calculations usable. Non-periodic axes stay at one.
- Actual WebGPU preparation follows physical frames across a six-frame
  trajectory: 32 source atoms become 64 and return to 32 on disable, with GPU
  cache generations changing each time. Both GL coordinate buffers contain
  Float32 vertex attributes while analysis fractions remain Float64. All 39
  GPU differential cases and 13 warmed pipelines pass on SwiftShader.
- Recipe replay with unchanged analysis geometry preserves other cached
  reference frames; changed physical geometry invalidates CPU/GPU inputs and
  derived results. Both views inherit the displayed bond graph and vectors,
  including when the preferred calculation backend changes.

## Legend coloring quantity selector

- `npm test`: 280 tests passed, none failed/skipped. Build
  `25d067f19029b2fa` and the complete browser smoke with both screenshot flags
  passed with no page or GL errors.
- The legend and Display quantity selectors stay synchronized for imported
  scalars, entirely NaN fields, CNA/PTM/Auto symmetry, bond coordination, local
  shear and reference strain. Switching quantities starts no analysis jobs.
- Fixed bounds, palettes and Auto settings survive quantity changes and fresh
  or cached frame transitions. Pending enabled outputs stay selected until
  calculation completes. A manual choice during calculation is retained when
  an earlier analysis finishes; cancelling a displayed analysis removes its
  fields and falls back to atom types. JSON saves the selected quantity.
- Actual phone touch and keyboard selection preserve focus after legend
  redraw. Desktop and phone screenshots were inspected; the full-width dropdown
  fits above existing controls and the phone legend retains its collapse behavior.

## AtomEye analysis and viewer alignment

Validated on 2026-10-03 with Node.js v24.19.0 and Chromium software WebGL:

- `npm test`: 280 tests passed, none failed/skipped. New numerical checks cover
  element-pair bonds, distinct periodic/self images, triclinic geometry, RDF
  shell/population normalization, AtomEye geometric shear reductions and
  reference-frame strain under stretch, shear, rotation, reordered IDs and
  defects. Unmatched or underdetermined strain fits remain NaN without warnings.
- Real Worker tests cover disjoint ranges, shared/private typed inputs,
  cancellation between shear stages and independent concurrent analyses. CNA,
  PTM and the new analyses share the same capped six-Worker pool. Reference ID
  preparation yields and accepts cancellation before Worker dispatch; nested
  output buffers are counted once in the frame-cache budget.
- `npm run build` and
  `npm run test:browser -- --screenshots --structure-screenshot` passed for
  build `87509a867ba502e5`. Native Extended XYZ/PDB files exercise the parser
  Worker, trajectory navigation and new scalar/vector properties. A uniformly
  expanded second FCC frame has reference hydrostatic strain 0.0202 and zero
  shear within tolerance; the undeformed local geometric shear is near zero.
- Chromium verifies ID lookup/centering, distance/angle/dihedral picks,
  individual and element color/radius/visibility overrides, pair cutoff zero
  exclusions, RDF CSV and coordination charts. Both real GPU views show the
  same bonds/arrows without GL errors. Separate pixel checks validate cylinder
  and cone rendering, filtering, clipping and skew periodic self-image edges.
- JPG signatures, six-view PNG, visible IDs and selected-frame ZIP exports
  pass. Cancelling a ZIP creates no archive and restores the original frame
  and camera; a subsequent manual frame edit retains ownership. Recipe replay
  restores enabled analyses and appearance; importing disabled extensions
  clears derived fields/primitives on both current and cached frames.
- Actual phone screenshots were inspected. The viewport stays fixed above the
  scrolling tools, the comparison inset fits, and legends/views remain compact.
  All earlier browser regressions, including 204,800-atom clipping, still pass.

A separate Node run on 97,556 FCC atoms used six actual Workers throughout:
bonds took approximately 731 ms (585,336 edges), RDF 654 ms and local geometric
shear 1,033 ms. No additional Workers were created between these jobs; source
buffers stayed intact. Peak process RSS was about 330 MiB. These are local CPU
measurements, not browser/GPU timing guarantees.

## Scalar palettes and persistent Auto ranges

Validated with Node.js v24.19.0 and Chromium 151.0.7922.173:

- `npm test`: 197 tests passed, none failed/skipped. New checks cover Magma,
  Inferno, Cividis, Turbo and Spectral endpoints/interpolation, shared atom and
  legend stops, outlier clamping, NaN handling and JSON scheme compatibility.
  Large numeric edits keep ordered, representable bounds; overflow is rejected.
- `npm run build` and `npm run test:browser -- --screenshots --structure-screenshot`
  passed. A native three-frame LAMMPS source has distinct scalar ranges
  `[0, 3]`, `[-10, 20]` and `[100, 160]`. Highlighted Auto follows the current
  frame. Clicking it off, or editing either bound, freezes limits across both
  fresh and cached frame transitions. Blank/partial input turns Auto off while
  retaining the last valid limits, and constant data freezes to ordered bounds.
- Switching properties preserves independent ranges and maps. JSON replay
  restores fixed/Auto mode and new schemes. The narrow bounds
  `[100000000, 100000000.01]` survive palette/frame redraws and export without
  rounding into equal values or emitting an error.
- Real PNG exports produce distinct color bars for all five new palettes and
  retain selected range labels. Auto on/off text meets 4.5 contrast in both
  themes; Chromium phone emulation verifies actual taps on the toggle.
- The actual updated legend screenshot was inspected; existing analysis,
  slicing, configuration-race, phone and large-structure checks continue to pass.

Fixed ranges are represented by existing per-property recipe range entries;
absence of an entry means Auto on. The configuration schema remains version 1.

## Automatic local central symmetry

Validated with Node.js v24.19.0 and Chromium 151.0.7922.173:

- `npm test`: 191 tests passed, none failed/skipped. Auto recognizes ideal FCC,
  BCC and HCP including primitive periodic cells. Mixed phases select 12/8
  neighbors locally; vacancy environments retain elevated finite CSP through
  neighboring settings, and disjoint atom ranges reproduce the complete result.
- FCC and HCP votes both support 12 neighbors, while BCC supports 8. Ties or
  absent supported neighbors remain NaN. Raw Other labels remain Other after
  inference, and ideal HCP keeps its nonzero baseline. Unsupported ICO remains
  undefined in Auto; manual neighbor selection is available.
- Real Workers merge recognition arrays and summaries, reuse Workers already
  initialized for PTM, safely copy/share cached adaptive CNA inputs, report
  atom progress, and cancel Auto while an independent queued CNA completes.
- `npm run build` and `npm run test:browser -- --screenshots --structure-screenshot`
  passed. Native FCC/HCP/BCC and mixed-source files exercise recognition labels,
  per-atom settings, trajectory/cache restoration, Cancel cleanup and auxiliary
  color properties. Adaptive CNA results are reused; fixed CNA is not reused.
  JSON replay preserves Auto and restores older version 1 recipes as manual.
- Actual HCP and mixed-structure screenshots were inspected. Existing mobile,
  multi-slice, PNG, configuration-race and large-structure GPU checks still pass.

Auto selects local neighbor settings rather than geometrically segmenting a
structure. Local inference is a heuristic at defects/interfaces; CSP values
from different crystal phases should be interpreted within their own phase.

## Multiple tilted slices, processing recipes and PTM startup

Validated with Node.js v24.19.0 and Chromium 151.0.7922.173 using software WebGL:

- `npm test`: 177 tests passed, none failed/skipped. New tests cover normalized
  Cartesian slice normals, half-space intersection, skew-cell polygons,
  replicated/unwrapped atom visibility, arrow arcball and position geometry,
  strict configuration validation and unambiguous local-source matching.
- `npm run build` and `npm run test:browser -- --screenshots --structure-screenshot`:
  passed. Chromium edits, renames and deletes multiple slices, verifies their
  intersection, and dispatches actual pointer drags on the normal head and
  position handle. The auxiliary sphere appears, sidebar values follow and
  the camera stays unchanged. A GPU occlusion query and CPU pick verify an
  original image can be clipped while its visible replicated image remains.
- JSON export/import restores the saved frame, camera, theme, display and PNG
  flags, crystal filters, replication, named planes and enabled analyses.
  Same-source import replays immediately; import after closing the source waits
  for native selection of matching files. Invalid schema/frame recipes preserve
  settings. Held parser responses exercise importing an old-source recipe
  during a new load and changing sources during restoration's frame pre-read;
  neither stale operation can overwrite or discard the newly committed source.
  Actual text input interrupts a held restore without changing the user's
  values or frame; a rejected older pending restore cannot replace a newer
  recipe's waiting status or display a stale error toast.
- Successful tasks reuse bounded idle Workers and their PTM Wasm instances.
  Progress distinguishes queued/preparing/initializing/neighbor-indexing work
  and reports real atom counts during PTM/strain. Non-isolated inputs are copied
  in 4 MiB pieces and transferred without detaching original arrays. Tests
  confirm reused Workers do not retain old-frame coordinates, stale messages
  are ignored, real running cancellation stops computation, and closing during
  shared-buffer preparation releases the pool.
- A separate Node test run on 32,000 generated FCC atoms with six Workers took
  about 951 ms initially and 462 ms on the same Workers next time; the second
  job created no Workers or Wasm instances. The difference includes JIT warmup
  and is a local observation, not a browser/GPU speedup guarantee. Measured
  Wasm heap capacity was about 16.25 MiB per initialized Worker; at most six
  instances are retained, and source/neighbor contexts are released after jobs.

Recipe files contain file metadata and parameters, not coordinates or computed
result arrays. Browsers require the user to select local files again. Slice
editing graphics are an interactive overlay; exported PNGs contain the clipped
atom view and the independently selected legend/axis options.

## Closing sources and page-wide file drops

Validated with Node.js v24.9.0 and Google Chrome 144.0.7559.109 using
SwiftShader software WebGL:

- `npm test`: all 26 test files passed. New checks cover drag feedback across
  nested elements, normal text drags, independent numbered files in single-file
  mode, pending Worker cancellation, stale Worker messages and reopening a fresh
  source. Renderer cleanup releases coordinate/color/filter/radius/cell GPU
  buffers and source references while retaining the reusable viewport.
- `npm run build` and `npm run test:browser -- --screenshots`: passed. Chrome
  dispatches native file drags over the homepage description and header, with
  visible drag feedback. A single CFG opens directly; two numbered CFG files
  present a single-file chooser, and selecting one reports one frame.
- The filename's close button returns to the empty homepage, disables export,
  hides the legend/timeline, stops the source Worker and resumes BCC animation.
  The same file can be reopened. Closing during actual CNA Worker execution and
  trajectory playback leaves zero active/queued analysis jobs, null renderer
  frame, zero displayed atoms and a zero-byte position buffer.
- A held completed parser response and an example fetch that deliberately
  ignores its aborted signal cannot reopen the closed source. Source/frame
  generations and cancelled prefetching prevent late UI updates.
- Existing local-file/folder/example, analysis cancellation, PNG transparency,
  replication, phone gesture/layout and 204,800-atom clipping checks still pass.

## Large structures after zooming and switching to Ortho

Validated with Node.js v24.9.0 and Google Chrome 144.0.7559.109 using
SwiftShader software WebGL:

- Reproduced clipping with a `1144 × 183.04 × 11.44 Å` cell: retaining a
  perspective camera distance of `0.25 × modelRadius` in Ortho put four of its
  eight vertices outside the old near plane. This also clipped the box edges.
- Orthographic rendering now places its virtual eye ahead of all cell/atom
  bounds while retaining the zoom scale and saved perspective distance. Near
  and far planes follow cached display bounds plus the largest rendered atom
  radius. Coordinate/frame changes and replication refresh these bounds;
  orbiting uses their projected extrema without scanning all atoms per draw.
- `npm test`: all 25 test files passed. New regressions cover close zooms,
  all six standard views, orbit/pan, picking formerly clipped foreground atoms,
  growing unwrapped coordinates, negative replication vectors and enlarged
  sphere surfaces in both projection modes.
- `npm run build` and `npm run test:browser -- --clipping-screenshot`: passed.
  Chrome's native file input loads a generated 204,800-atom BCC thin-sheet CFG.
  After the close zoom and Ortho switch, all atom centers and cell vertices have
  normalized depths between `-0.9981` and `0.9981`. GPU occlusion queries confirm
  actual sample coverage for atom indices `0` and `204799`, and both can be
  picked. Every observed instanced draw submits all 204,800 atoms; WebGL reports
  no error. The screenshot shows the complete cell boundary.
- Existing PNG transparency, analyses, local files/examples, replication,
  themes, continuous homepage animation and mobile gestures still pass. The
  generated fixture verifies this failure mode; it is not the user's input file
  or a hardware GPU performance benchmark.

## Continuous BCC logo and mobile camera gestures

Validated with Node.js v24.9.0 and Google Chrome 144.0.7559.109 using
SwiftShader software WebGL:

- `npm test`: all 24 test files passed. The model checks establish eight
  unique cubic corners, one body center, eight equal body-diagonal bonds, and
  twelve cell edges with three incident edges at each corner.
- `npm run build` and `npm run test:browser -- --screenshots`: passed. The
  homepage uses a separate transparent WebGL 2 scene with sphere/cylinder
  geometry, depth testing and studio lighting. Two cropped browser screenshots
  600 ms apart differ while the canvas has no CSS transform.
- The model keeps rotating with the OS reduced-motion preference enabled;
  cropped screenshots 600 ms apart still differ and draw calls continue.
  A separate source-page check starts with reduced motion enabled and the same
  COOP/COEP headers as the localhost development server, confirming continuous
  rendering in that configuration. Loading a structure hides the homepage and
  stops its draw calls. Both theme screenshots use the live 3D model.
- Camera tests cover pinch opening/closing, screen-space translation, combined
  pinch/pan anchoring, finger-count transitions, tap selection, cancellation,
  lost pointer capture and desktop controls. Perspective and orthographic
  gestures preserve camera orientation; multi-touch never selects atoms.
- Chrome phone emulation at 390 × 844 dispatches actual two-touch events.
  Opening the span from 100 to 160 pixels changes camera distance or
  orthographic scale by `1 / 1.6`; closing restores it. Moving both fingers by
  `(24, 18)` pixels produces the expected pan with unchanged zoom and orbit.
  One-finger rotation and tap picking still work; page scrolling remains zero
  while the lower tools panel continues to scroll independently.
- Existing local-file, example, analysis, replication, phone-layout and PNG
  transparency checks continue to pass. These are correctness checks, not
  hardware GPU performance measurements.

## Display replication and responsive tools

Validated with Node.js v24.19.0 and Chromium 151.0.7922.173:

- `npm test`: 122 tests passed, none failed/skipped. Replication follows skew
  and rotated cell vectors, handles negative vector components and unwrapped
  coordinate bounds, disables non-periodic directions, validates counts and
  retains the source cell, atom buffers and property arrays. The expanded slice
  is shared by picking and selection restoration.
- `npm run build` and `npm run test:browser`: passed. A triclinic 16-atom source
  replicated `2 × 3 × 2` draws 192 atom instances while preserving the source
  coordinates and analysis arrays and scheduling zero additional analysis jobs.
  Copied atoms resolve to original IDs; category masks and PNG export include
  the copies. Reset and non-periodic controls are checked in the browser.
- Tool buttons show one configuration panel at a time. Switching panels retains
  concurrent analyses; closing an enabled analysis cancels it and clears results.
- Chromium phone emulation at 390 × 844 checks default collapsed View and
  Legend / atoms controls, expansion, crystal checkboxes and real touch scrolling
  in the lower sidebar. Canvas bounds stay fixed, page scroll remains zero and
  the document fits within the screen. A separate 844 × 390 check verifies the
  compact landscape header and independently scrolling tools. Desktop sidebar
  resizing and persistence continue to pass.
- Rendering and picking grow with displayed copies. These checks establish
  analysis isolation and behavior, not performance on a target phone GPU.

## Silent strain NaNs and analysis cancellation

Validated with Node.js v24.19.0 and Chromium 151.0.7922.173:

- `npm test`: 117 tests passed, none failed/skipped. New checks cover silent
  unmatched strain, gray coloring and a NaN legend for entirely undefined data,
  analysis-specific result cleanup, restoration of imported properties after
  repeated calculations, and accounting for retained source buffers.
- Cancellation releases running/queued tasks without starting an already-aborted
  queued Worker. The existing shared concurrency and range-merging tests pass.
- `npm run build` and `npm run test:browser`: passed. The browser confirms
  FCC-vacancy NaNs do not emit a toast, and entirely NaN strain completes without
  an error or fabricated finite values.
- Every Cancel button stops a real running Worker and restores **Not calculated**,
  start/cancel controls, metrics, coloring and the loading indicator. Cancelled
  results stay absent across cached trajectory frames and input edits; input
  reference parameters are preserved. A held completed response verifies a late
  result cannot undo cancellation. All five analyses can restart concurrently.
- Resetting completed strain preserves PTM/CNA/coordination results. Strain
  waiting on a cancelled PTM request computes its own fit; cancelling waiting
  strain leaves PTM running without scheduling a strain Worker or restoring
  removed properties. Existing PNG, theme, sidebar and deployment checks remain.

## PTM, atomic elastic strain and PNG arrows

Validated with Node.js v24.19.0 and Chromium 151.0.7922.173:

- `npm run build:ptm`: real MIT PTM library compiled with Emscripten 3.1.69 /
  LLVM 19. Browser-compatible ES modules contain no static Node imports. Vendored
  source checksums are verified; generated artifacts ship with license notices.
- `npm test`: 113 tests passed, none failed/skipped. Real Wasm tests identify
  ideal FCC/HCP/BCC/SC/cubic diamond/hexagonal diamond, primitive periodic cells,
  graphene and an icosahedral center. Mild perturbation, selectable templates,
  accepted/rejected RMSD and disabled cutoff are tested.
- Ideal-reference strain vanishes for all six supported 3D reference phases.
  A 5% uniform dilation gives hydrostatic strain 0.05125 and volume change
  0.157625; rigid rotation gives zero; finite simple shear matches the analytic
  Green–Lagrange invariants. Nonideal hexagonal `c/a`, axial stretch, edited
  lattice constants, per-species references, unmatched NaNs and cached ranges
  are checked against independent expected results.
- Real Node Workers merge parallel PTM and fresh strain including all nine
  deformation components, respect the shared concurrency cap, preserve input
  arrays and reuse shared cached fits. Adaptive cache accounting includes the
  PTM matrices without counting aliased scalar property buffers twice.
- `npm run build` and `npm run test:browser`: passed. The production build is
  served at `/AlloyView/` without isolation headers. Tests load the actual Wasm
  asset, run PTM/strain together, check Al/Fe reference presets, change `a` and
  verify the resulting physical volume change, reuse PTM, reject a mismatched
  reference, check all nine legend rows and visibility, and follow/cache BCC
  trajectory frames. Numeric types require explicit element selection; changing
  PTM's template mask keeps its classification separate from the templates
  required by strain. Existing regressions remain enabled.
- Actual PNG blobs verify optional XYZ arrows are off by default, independent
  of the screen axes toggle, limited to their overlay region and preserve
  transparent corners. Renderer tests verify rotated arrow directions. Existing
  transparent type/scalar legend pixel checks still pass.

These are deterministic scientific fixtures and browser correctness checks;
they do not establish recognition accuracy across all temperatures/materials,
million-atom performance or a target GPU's rendering speed. Atomic strain here
uses an ideal lattice reference, not OVITO/AtomEye's trajectory reference-frame
atomic-strain workflow.

## CNA and normalized central-symmetry update

Validated in the cloud environment with Node.js v24.19.0 and Chromium
151.0.7922.173, using the existing SwiftShader browser runner.

- `npm test`: 96 tests passed, none failed/skipped. Added ideal FCC/HCP/BCC,
  icosahedral center, vacancy, mild perturbation, mixed lattice scales, primitive
  periodic cells, rotated/scaled cells, skew/mixed-PBC brute-force neighbor
  comparisons, ranged kernels, palette/filter counts and real Worker tests.
- Real Node Workers verified range merging for CNA, central symmetry and
  coordination, the shared concurrency cap, shared/copied inputs, cancellation,
  pool shutdown and recovery from Worker startup/analysis errors.
- `npm run build`: passed. `npm run test:browser`: production assets without
  isolation headers tested CNA/CSP, concurrent coordination, FCC-vacancy counts
  (19 FCC / 12 Other), filtering and picking, fixed/adaptive method changes,
  BCC trajectory analysis, cached frames and superseded-result protection.
  The existing theme, contrast, scalar legend, PNG and layout assertions remain.
  Reload assertions now wait for the real page-load event and sidebar
  initialization instead of matching the previous/initial HTML state.

Representative compute measurements used a periodic 97,556-atom ideal FCC
fixture, with all CNA classifications checked against FCC and all normalized
central-symmetry results checked against zero. These are single measurements
of Node kernels / actual Node Worker execution, not browser rendering timings.
Pooled times include Worker startup, coordinate sharing and output merging.

| Analysis | Single kernel | 3 Workers, shared input |
| --- | ---: | ---: |
| Adaptive CNA | 1,996 ms | 860 ms |
| Normalized central symmetry, 12 neighbors | 1,974 ms | 821 ms |

The scheduler reserved a core from the runtime's reported four available cores.
These results establish working parallel computation for this representative
fixture. Million-atom performance and broad thermal recognition accuracy were
not validated by that update. PTM validation is recorded above.

## Browser and deployment regression update

The current fixes were validated with Node.js v24.9.0 and Google Chrome
144.0.7559.109 using SwiftShader software WebGL. The inherited remote `DISPLAY`
was removed for headless execution. This checks rendering and export correctness;
it does not establish hardware GPU performance.

Executed commands:

```bash
npm test
npm run build
npm run test:browser
```

All 16 unit-test files passed. New regressions cover the earlier `file` Worker
message and the current `files` message, single files and sequences, failed
cloning, transparent legends, and a build version that changes even when only
a Worker changes.

The browser test serves the production artifact at `/AlloyView/` without
COOP/COEP headers (`crossOriginIsolated === false`). It loaded a native local
CFG selection, the FCC and BCC examples, and all 40 NEB images, including the
last trajectory frames. It also calculated coordination, switched both themes
and their logos, checked saved theme preference and custom viewport colors,
and decoded actual PNG blobs for type and scalar legends.

For both legends with **Include background in PNG** unchecked, the exported
corner and empty legend padding had alpha **0**. With background enabled, the
same pixels had alpha **255**. Atoms and legend content remained in the exports.
The documentation screenshots were captured from these real browser views.

Follow-up UI checks drag the actual panel divider in both directions, verify
that the WebGL canvas resizes, reset the width, check persistence on reload,
and verify the stacked layout hides the divider below the desktop breakpoint.
Cutoff edits are tested without clicking Calculate. Delayed real analyses
exercise rapid edits, a single active Worker pool, skipping superseded requests,
and switching back to a cached cutoff without allowing an older result to
replace it. The browser also types a decimal legend limit one character at a
time and clears the field to verify immediate application and preservation of
the last valid range.

Homepage checks also load the supplied transparent crystal logo and capture
both themes. Browser contrast checks use computed text colors, composited
ancestor backgrounds and cumulative opacity, covering homepage copy, sidebar
labels, help text, source descriptions, and scalar legends at a minimum 7:1.
Controls, including disabled controls on the initial page, are checked at a
minimum 4.5:1 after theme transition animations finish.

The earlier environment, benchmark and validation details below remain as a
record of the original checks.

## Original validation environment

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
